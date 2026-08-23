# Echotect

Echotect is a browser-based tool for designing musical echoes with real-world
map geometry. A Source, Listener, and Reflectors define travel distances that
are converted into propagation times and audible delay taps.

The application is designed to run as a static GitHub Pages site. It will
support immediate Web Audio preview with a built-in recorded handclap and
local import of a user's own audio file. Max for Live integration uses a
versioned JSON Space file and is optional for browser use.

## Planned stack

- HTML and CSS
- native JavaScript ES modules
- MapLibre GL JS
- OpenStreetMap-compatible map tiles
- optional Overture Maps building geometry delivered as PMTiles
- Web Audio API
- File API for local audio import
- versioned JSON Space import and export

No backend, database, account system, or secret client-side API key is required
for the current version. All deployable application files belong here.
The built-in default sound is `assets/handclap.wav` (48 kHz, 24-bit stereo PCM).

## Development

The initial application should remain directly publishable as static files.
Because JavaScript modules and browser file/audio APIs are restricted under
`file://`, serve the directory with a small local static server while developing.

GitHub Pages must be tested using a repository subpath, so application asset
references should be relative rather than rooted at `/`.

## Status

The first complete browser version provides the map workspace, place and pasted
coordinate search, editable Source/Listener/Reflector points, distance and
propagation-time display, and Web Audio preview. One reflector produces one
reflected impulse. Multiple reflectors form an interacting echo field through
paths such as Source → R1 → R2 → Listener. Consecutive self-reflection is
excluded and paths below −90 dB are omitted. Browser preview renders up to two
bounces as discrete early reflections and synthesizes later randomized geometry
walks into a deterministic ten-second stereo impulse response processed by a
native Web Audio ConvolverNode. A global reflection-level control
shifts all reflector levels together, while every reflector can also be adjusted
individually. Deterministic equal-power stereo places direct sound in the Source
direction and every reflection path in the direction of its final Reflector.
Listener heading is adjustable in compass degrees, with north as the 0°
reference. Preview and WAV export use the same rendered sample buffers.
The Panning selector can instead enable **HRTF · live only** for native browser
headphone monitoring; this monitor spatialization intentionally does not alter
the deterministic stereo WAV exports.
**Recover audio** closes the active AudioContext and stops its pending audio so
playback can recover without a page reload.

Building geometry is an optional layer and is not requested on application
load. Select **Buildings** to load Overture Maps building footprints for the
current viewport, then use **Add reflector** on a building to snap the reflector
to its nearest facade segment. When `facade_material` is available it becomes
that reflector's material; otherwise the global material is inherited. The
compact selector beside **Reflection field** sets the global material, and each
reflector header can override it. Material attenuation is added to the editable
reflection level when the echo field is rendered.

After Buildings has loaded, **Echo area** creates an automatic reflection field
around the Listener. Drag the pink handle on the circle to set its radius. The
circle follows the Listener, and moving the Source or Listener recalculates the
available specular reflection points on nearby facade segments. By default, up
to 48 distance- and reflection-type-ranked surfaces become active audio reflectors.
Visible front-facing walls that
do not receive an exact specular hit are included as diffuse reflections with
an additional −9 dB attenuation. Source-to-wall and wall-to-Listener paths are
checked against the loaded building edges, while back-facing walls are rejected.
A `+` in the button count means
the area contained additional candidates. The gear beside **Echo area** opens
advanced field settings for response duration, active surfaces, early paths,
late path samples, maximum bounces, cutoff level, and Tail persistence. The Late
field selector can replace convolution with a musical Feedback Delay Network.
Its Tail length, Density, Damping, and Geometry influence controls tune the
network while retaining the mapped environment as its delay source. Both modes
are rendered through the same offline path for preview and export. In
Convolution mode, higher Tail persistence values create
longer reverb tails. Defaults are
512 early paths, 8,192 bounded late geometry walks, 32 bounces, and a −90 dB
cutoff.
Manual reflectors remain available alongside the automatic field.

The current reflection field and listening settings are stored locally in the
browser and restored after a reload. This includes Source, Listener,
Reflectors, point linking, reflection levels, materials, listener heading,
Arrivals only monitoring, and Panning mode. Imported audio files require a new user
selection after reload, and the optional Buildings layer is never restored
automatically.

The single **Export** action opens a compact selection dialog with browser-side
size estimates. It exports a versioned Echotect project manifest, stereo
Convolution IR, rendered FDN IR, wet render, and sample-aligned direct, early,
and late stems. A single file downloads directly; multiple files are packaged
as an uncompressed ZIP in the browser. WAV exports are explicitly stereo,
48 kHz, 32-bit IEEE float, with no normalization, limiter, clipping, or hidden
timing offset. See [the export format](Doc/export-format.md).

Ableton Extension and Max for Live support remain future optional integrations.
All JSON and WAV exports work without Ableton.

## Building data

Building footprints currently come from the public Overture Open Buildings
PMTiles archive hosted by Source Cooperative. Overture building data is
licensed under ODbL; attribution is displayed by the map. Because facade
material is optional source metadata, Echotect always retains a manual material
choice and a neutral Generic fallback.
