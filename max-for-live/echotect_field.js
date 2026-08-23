autowatch = 1;
inlets = 1;
outlets = 2;

post("Echotect field UI loaded\n");

var paths = [];
var headingDegrees = 0;
var widthPercent = 100;
var projectName = "Drop Echotect JSON";
var dragging = false;

function clear() { paths = []; mgraphics.redraw(); }
function path(index, kind, azimuth, delaySeconds, levelDb) {
    paths[Number(index)] = { kind: String(kind), azimuth: Number(azimuth), delay: Number(delaySeconds), levelDb: Number(levelDb) };
    mgraphics.redraw();
}
function heading(value) { headingDegrees = Number(value); mgraphics.redraw(); }
function width(value) { widthPercent = Number(value); mgraphics.redraw(); }
function project() { projectName = arrayfromargs(arguments).join(" "); mgraphics.redraw(); }

function displayRadians(azimuth) {
    var relative = ((azimuth - headingDegrees + 540) % 360) - 180;
    var displayed = headingDegrees + relative * widthPercent / 100;
    return displayed * Math.PI / 180 - Math.PI / 2;
}

function paint() {
    var mg = mgraphics;
    var size = box.rect[2] - box.rect[0];
    var height = box.rect[3] - box.rect[1];
    var cx = size * 0.5;
    var cy = height * 0.52;
    var radius = Math.min(size, height) * 0.39;
    var maxDelay = 0.001;
    var i;
    for (i = 0; i < paths.length; i++) if (paths[i] && paths[i].delay > maxDelay) maxDelay = paths[i].delay;

    mg.set_source_rgba(0.12, 0.12, 0.13, 1);
    mg.rectangle(0, 0, size, height);
    mg.fill();
    mg.set_source_rgba(0.55, 0.55, 0.57, 0.45);
    mg.set_line_width(1);
    mg.ellipse(cx - radius, cy - radius, radius * 2, radius * 2);
    mg.stroke();

    for (i = 0; i < paths.length; i++) {
        var item = paths[i];
        if (!item) continue;
        var angle = displayRadians(item.azimuth);
        var normalized = 0.25 + 0.75 * Math.sqrt(Math.max(0, item.delay / maxDelay));
        var length = radius * normalized;
        var alpha = Math.max(0.16, Math.min(0.9, (item.levelDb + 90) / 90));
        if (item.kind === "direct") mg.set_source_rgba(0.96, 0.55, 0.67, Math.max(alpha, 0.55));
        else mg.set_source_rgba(0.72, 0.70, 0.72, alpha);
        mg.set_line_width(item.kind === "direct" ? 2.2 : 1.1);
        mg.move_to(cx, cy);
        mg.line_to(cx + Math.cos(angle) * length, cy + Math.sin(angle) * length);
        mg.stroke();
    }

    mg.set_source_rgba(0.96, 0.55, 0.67, 1);
    mg.ellipse(cx - 5, cy - 5, 10, 10);
    mg.fill();
    var headingRadians = headingDegrees * Math.PI / 180 - Math.PI / 2;
    var hx = cx + Math.cos(headingRadians) * radius * 0.32;
    var hy = cy + Math.sin(headingRadians) * radius * 0.32;
    mg.set_line_width(2);
    mg.move_to(cx, cy);
    mg.line_to(hx, hy);
    mg.stroke();
    mg.move_to(hx, hy);
    mg.line_to(hx + Math.cos(headingRadians + 2.55) * 9, hy + Math.sin(headingRadians + 2.55) * 9);
    mg.move_to(hx, hy);
    mg.line_to(hx + Math.cos(headingRadians - 2.55) * 9, hy + Math.sin(headingRadians - 2.55) * 9);
    mg.stroke();

    mg.select_font_face("Ableton Sans Medium Regular");
    mg.set_font_size(10);
    mg.set_source_rgba(0.82, 0.82, 0.84, 0.8);
    mg.move_to(8, 15);
    mg.show_text(projectName);
}

function onclick(x, y) { dragging = true; updateHeading(x, y); }
function ondrag(x, y, button) { if (!button) dragging = false; if (dragging) updateHeading(x, y); }
function updateHeading(x, y) {
    var width = box.rect[2] - box.rect[0];
    var height = box.rect[3] - box.rect[1];
    var angle = Math.atan2(x - width * 0.5, -(y - height * 0.52)) * 180 / Math.PI;
    if (angle < 0) angle += 360;
    headingDegrees = angle;
    outlet(0, ["heading", angle]);
    outlet(1, angle);
    mgraphics.redraw();
}

mgraphics.init();
mgraphics.relative_coords = 0;
mgraphics.autofill = 0;
