# Echotect export format 1.0.0

Every export is generated locally in the browser. One selected file downloads
directly; multiple selected files use an uncompressed ZIP container so packaging
does not alter the payloads.

Audio filenames use the project name followed by their export family:
`project-ir-convolution.wav`, `project-ir-rendered-fdn.wav`,
`project-stem-direct.wav`, `project-stem-early.wav`, `project-stem-late.wav`, and
`project-wet.wav`.

The JSON project manifest uses `format: "echotect-project"` and
`schemaVersion: "1.0.0"`. Geometry is authoritative. The `derived` section is a
reproducible export snapshot. Coordinates are WGS84 decimal degrees, distances
are metres, times are seconds, levels are dBFS, and angles are compass degrees.
This version has no legacy readers or migrations.

All WAV files are stereo, 48,000 Hz, 32-bit IEEE floating point. Samples are
written unchanged: there is no normalization, limiter, integer quantization, or
clipping. Values outside `[-1, 1]` therefore remain present in the float file.
All rendered files start at sample zero and no latency compensation is inserted.
Browser preview plays these same rendered sample buffers without preview-only
filtering, normalization, or level changes.
The optional `HRTF · live only` monitor replaces direct and early panning during
browser playback only. WAV files always retain canonical spatial stereo.

- Convolution IR lasts at least **Response duration** seconds. It extends to the
  final early arrival when needed, so geometry is never truncated. It contains
  discrete early reflections and the convolution late field at gain `0.7`, but
  no direct impulse.
- Rendered FDN IR lasts at least `Tail length × 1.25` seconds and contains the
  same early reflections as Convolution IR plus the FDN response at gain `0.65`.
  With fewer than two reflectors its late portion is explicitly silent.
- Wet render contains the propagated direct arrival, early reflections, and the
  selected late-field method. It does not include the preview-only source-onset
  trigger. Convolution late gain is `0.7`; FDN late gain is `0.65`.
- Direct, early, and late stems have the same sample count and start time. The
  direct stem contains the centred source-onset trigger at sample zero and the
  geographically delayed, spatial direct arrival when Source and Listener are
  distinct. A co-located Source and Listener produces one event at sample zero.
  Wet contains the direct arrival plus early and late, but excludes the trigger.
- Render and stem duration includes the input plus the longer exported IR tail
  and any later direct arrival. No arrival or tail is truncated silently.
