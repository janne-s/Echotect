/* Echotect manifest 2.0.0 delay-field model. ES5 for Max js. */
(function (root) {
    "use strict";

    var FORMAT = "echotect-project";
    var VERSION = "2.0.0";
    // Echotect allows 4096 early paths plus the direct arrival.
    // Max poly~ banks are split below their per-instance 1023 voice limit.
    var MAX_VOICES = 4097;

    function finite(value) {
        return typeof value === "number" && isFinite(value);
    }

    // Max Dict stores JSON true as 1 and has no null, so a manifest read through it carries neither.
    function occluded(direct) {
        return direct.occluded === true || direct.occluded === 1;
    }

    function wrapSigned(degrees) {
        var value = (degrees + 180) % 360;
        if (value < 0) value += 360;
        return value - 180;
    }

    function dbToGain(db) {
        return Math.pow(10, db / 20);
    }

    function quadGains(absoluteAzimuthDegrees, headingDegrees, widthPercent) {
        var relative = wrapSigned(absoluteAzimuthDegrees - headingDegrees);
        var angle = ((relative * widthPercent / 100) % 360 + 360) % 360;
        var speakerAngles = [315, 45, 135, 225]; // FL, FR, RR, RL clockwise
        var clockwise = (angle + 45) % 360;
        var sector = Math.floor(clockwise / 90);
        var fraction = (clockwise % 90) / 90;
        var a = Math.cos(fraction * Math.PI / 2);
        var b = Math.sin(fraction * Math.PI / 2);
        var gainsClockwise = [0, 0, 0, 0];
        gainsClockwise[sector] = a;
        gainsClockwise[(sector + 1) % 4] = b;
        // Convert FL, FR, RR, RL to plugout order FL, FR, RL, RR.
        return [gainsClockwise[0], gainsClockwise[1], gainsClockwise[3], gainsClockwise[2]];
    }

    function requireFinite(errors, value, name) {
        if (!finite(value)) errors.push(name + " must be a finite number");
    }

    function validate(manifest) {
        var errors = [];
        if (!manifest || manifest.format !== FORMAT) errors.push("format must be " + FORMAT);
        if (!manifest || manifest.schemaVersion !== VERSION) errors.push("schemaVersion must be " + VERSION);
        if (!manifest || !manifest.project || typeof manifest.project.name !== "string" || !manifest.project.name.length) errors.push("project.name is required");
        if (!manifest || !manifest.geometry || !manifest.geometry.listener) errors.push("geometry.listener is required");
        if (!manifest || !manifest.derived || !manifest.derived.direct) errors.push("derived.direct is required");
        if (!manifest || !manifest.derived || !(manifest.derived.earlyPaths instanceof Array)) errors.push("derived.earlyPaths must be an array");
        if (errors.length) return errors;

        requireFinite(errors, manifest.geometry.listener.headingDegrees, "geometry.listener.headingDegrees");
        requireFinite(errors, manifest.derived.direct.propagationSeconds, "derived.direct.propagationSeconds");
        requireFinite(errors, manifest.derived.direct.pathMetres, "derived.direct.pathMetres");
        if (occluded(manifest.derived.direct)) {
            if (finite(manifest.derived.direct.levelDb)) errors.push("an occluded derived.direct has no level");
        } else requireFinite(errors, manifest.derived.direct.levelDb, "derived.direct.levelDb");
        requireFinite(errors, manifest.derived.direct.arrivalAzimuthDegrees, "derived.direct.arrivalAzimuthDegrees");

        for (var i = 0; i < manifest.derived.earlyPaths.length; i++) {
            var path = manifest.derived.earlyPaths[i];
            requireFinite(errors, path.propagationSeconds, "derived.earlyPaths[" + i + "].propagationSeconds");
            requireFinite(errors, path.levelDb, "derived.earlyPaths[" + i + "].levelDb");
            requireFinite(errors, path.arrivalAzimuthDegrees, "derived.earlyPaths[" + i + "].arrivalAzimuthDegrees");
            if (typeof path.finalReflectorId !== "string" || !path.finalReflectorId.length) errors.push("derived.earlyPaths[" + i + "].finalReflectorId is required");
        }
        return errors;
    }

    function pathsFromManifest(manifest) {
        var direct = manifest.derived.direct;
        // Terrain between Source and Listener blocks the direct path; it has no voice.
        var paths = occluded(direct) ? [] : [{
            id: "direct",
            kind: "direct",
            propagationSeconds: direct.propagationSeconds,
            levelDb: direct.levelDb,
            arrivalAzimuthDegrees: direct.arrivalAzimuthDegrees,
            pathMetres: direct.pathMetres
        }];
        for (var i = 0; i < manifest.derived.earlyPaths.length; i++) {
            var source = manifest.derived.earlyPaths[i];
            paths.push({
                id: source.reflectorIds.join(">"),
                kind: "reflection",
                propagationSeconds: source.propagationSeconds,
                levelDb: source.levelDb,
                arrivalAzimuthDegrees: source.arrivalAzimuthDegrees,
                pathMetres: source.pathMetres,
                finalReflectorId: source.finalReflectorId,
                reflectorIds: source.reflectorIds.slice(0)
            });
        }
        return paths;
    }

    function reflectionNormalizationDb(paths) {
        var loudest = -Infinity;
        for (var i = 0; i < paths.length; i++) {
            if (paths[i].kind === "reflection" && paths[i].levelDb > loudest) loudest = paths[i].levelDb;
        }
        return loudest > -Infinity ? -loudest : 0;
    }

    function effectiveLevelDb(path, controls) {
        if (path.kind === "direct" || !controls.normalizeReflections) return path.levelDb;
        return path.levelDb + controls.reflectionNormalizationDb;
    }

    function renderConfig(path, controls) {
        var enabled = path.kind === "direct" ? controls.directEnabled : controls.reflectionsEnabled;
        var trimDb = path.kind === "direct" ? controls.directLevelDb : controls.reflectionsLevelDb;
        var spatial = quadGains(path.arrivalAzimuthDegrees, controls.headingDegrees, controls.widthPercent);
        var gain = enabled ? dbToGain(effectiveLevelDb(path, controls) + trimDb) : 0;
        return {
            delayMilliseconds: Math.max(0, path.propagationSeconds * 1000 * controls.scale),
            outputGains: [spatial[0] * gain, spatial[1] * gain, spatial[2] * gain, spatial[3] * gain]
        };
    }

    var api = {
        FORMAT: FORMAT,
        VERSION: VERSION,
        MAX_VOICES: MAX_VOICES,
        validate: validate,
        pathsFromManifest: pathsFromManifest,
        reflectionNormalizationDb: reflectionNormalizationDb,
        effectiveLevelDb: effectiveLevelDb,
        quadGains: quadGains,
        renderConfig: renderConfig,
        wrapSigned: wrapSigned
    };
    root.EchotectModel = api;
    if (typeof module !== "undefined" && module.exports) module.exports = api;
}(this));
