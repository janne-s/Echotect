autowatch = 1;
inlets = 1;
outlets = 4;

post("Echotect controller loaded\n");

include("echotect_model.js");

var manifest = null;
var paths = [];
var omittedPathCount = 0;
var VOICES_PER_BANK = 1023;
var BANK_COUNT = Math.ceil(EchotectModel.MAX_VOICES / VOICES_PER_BANK);
// Scale reaches 4x, so a delay line must hold four times its propagation time plus a margin.
var MAXIMUM_SCALE = 4;
var DELAY_CAPACITY_MARGIN_MS = 100;
var controls = {
    headingDegrees: 0,
    scale: 1,
    widthPercent: 100,
    directEnabled: true,
    reflectionsEnabled: true,
    directLevelDb: 0,
    reflectionsLevelDb: 0,
    reflectionCount: 0
};

function cleanPath(value) {
    var result = String(value);
    if (result.charAt(0) === '"' && result.charAt(result.length - 1) === '"') result = result.slice(1, -1);
    return result;
}

function read() {
    var filePath = cleanPath(arrayfromargs(arguments).join(" "));
    post("Echotect: reading " + filePath + "\n");
    try {
        var dictionary = new Dict();
        dictionary.import_json(filePath);
        var candidate = JSON.parse(dictionary.stringify());
        var errors = EchotectModel.validate(candidate);
        if (errors.length) {
            post("Echotect import error: " + errors.join(" | ") + "\n");
            outlet(0, ["error", errors.join(" | ")]);
            return;
        }
        manifest = candidate;
        var importedPaths = EchotectModel.pathsFromManifest(manifest);
        paths = importedPaths.slice(0, EchotectModel.MAX_VOICES);
        omittedPathCount = importedPaths.length - paths.length;
        controls.reflectionCount = paths.length - 1;
        controls.headingDegrees = manifest.geometry.listener.headingDegrees;
        outlet(3, ["heading", controls.headingDegrees]);
        outlet(3, ["project", manifest.project.name]);
        outlet(3, ["paths_value", paths.length > 1 ? controls.reflectionCount / (paths.length - 1) : 0]);
        outlet(3, ["paths_label", controls.reflectionCount, "/", paths.length - 1]);
        emitAll(true, true);
        if (omittedPathCount > 0) {
            var importedEarlyCount = manifest.derived.earlyPaths.length;
            var supportedEarlyCount = EchotectModel.MAX_VOICES - 1;
            var capacityMessage = "Early paths: " + importedEarlyCount + " | supported: " + supportedEarlyCount + " | using: " + supportedEarlyCount;
            post("Echotect warning: " + capacityMessage + "\n");
            outlet(0, ["warning", capacityMessage]);
        } else {
            post("Echotect: loaded " + manifest.project.name + " with " + (paths.length - 1) + " reflections\n");
            outlet(0, ["loaded", manifest.project.name, paths.length - 1]);
        }
    } catch (error) {
        post("Echotect import error: " + error.message + "\n");
        outlet(0, ["error", "Could not read manifest: " + error.message]);
    }
}

function emitAll(resizeDelayMemory, updateMuteState) {
    if (!manifest) return;
    if (resizeDelayMemory) {
        for (var bankIndex = 0; bankIndex < BANK_COUNT; bankIndex++) {
            var remaining = paths.length - bankIndex * VOICES_PER_BANK;
            var bankVoices = Math.max(1, Math.min(VOICES_PER_BANK, remaining));
            outlet(1, ["bank", bankIndex + 1, "voices", bankVoices]);
        }
    }
    outlet(2, ["clear"]);
    for (var i = 0; i < paths.length; i++) {
        var config = EchotectModel.renderConfig(paths[i], controls);
        var bank = Math.floor(i / VOICES_PER_BANK) + 1;
        var localVoice = i % VOICES_PER_BANK + 1;
        var active = paths[i].kind === "direct" || i <= controls.reflectionCount;
        if (updateMuteState) outlet(1, ["bank", bank, "mute", localVoice, active ? 0 : 1]);
        if (!active) continue;
        outlet(1, ["bank", bank, "target", localVoice]);
        if (resizeDelayMemory) outlet(1, ["bank", bank, "capacity", DELAY_CAPACITY_MARGIN_MS + paths[i].propagationSeconds * 1000 * MAXIMUM_SCALE]);
        outlet(1, ["bank", bank, "config", config.delayMilliseconds].concat(config.outputGains));
        outlet(2, ["path", i, paths[i].kind, paths[i].arrivalAzimuthDegrees, paths[i].propagationSeconds * controls.scale, paths[i].levelDb]);
    }
    outlet(2, ["heading", controls.headingDegrees]);
    outlet(2, ["width", controls.widthPercent]);
}

function setControl(name, value) {
    controls[name] = value;
    emitAll(false, false);
}

function heading(value) { setControl("headingDegrees", Number(value)); }
function scale(value) { setControl("scale", Math.max(0.01, Math.min(MAXIMUM_SCALE, Number(value)))); }
function width(value) { setControl("widthPercent", Math.max(0, Math.min(200, Number(value)))); }
function direct_enable(value) { setControl("directEnabled", Number(value) !== 0); }
function reflections_enable(value) { setControl("reflectionsEnabled", Number(value) !== 0); }
function direct_level(value) { setControl("directLevelDb", Number(value)); }
function reflections_level(value) { setControl("reflectionsLevelDb", Number(value)); }
function reflection_density(value) {
    if (!manifest) return;
    var normalized = Math.max(0, Math.min(1, Number(value)));
    controls.reflectionCount = Math.round((paths.length - 1) * normalized);
    outlet(3, ["paths_value", normalized]);
    outlet(3, ["paths_label", controls.reflectionCount, "/", paths.length - 1]);
    emitAll(false, true);
}
function bang() { emitAll(false, false); }
