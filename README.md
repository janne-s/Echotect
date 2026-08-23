# Echotect

Echotect turns real-world map geometry into musical delay structures. A Source,
Listener, and Reflectors define propagation paths that can be auditioned in the
browser, saved as an editable project, exported as audio, or opened in the
optional Max for Live device.

![Echotect interface](assets/screenshot.jpg)

## Audio conventions

- Geometry is two-dimensional and distances are measured in metres. Propagation
  time uses an explicit speed of sound of 343 metres per second.
- Direct arrival is calculated from Source to Listener. Reflections use the
  complete Source → Reflector path(s) → Listener distance.
- Source onset, propagated direct arrival, early reflections, and late field are
  separate events.
- Listener heading uses compass degrees with north at 0°. Direct arrives from
  the Source direction; each reflection arrives from its final Reflector.
- Canonical spatial stereo uses deterministic equal-power panning. The optional
  browser HRTF mode is monitor-only and does not alter project or WAV exports.
- Late responses are deterministic and derive their timing, attenuation, and
  stereo energy from the active geometry.

The project manifest identifies itself as `echotect-project` schema `1.0.0`.
Geometry and settings are authoritative; exported path times, levels, and
azimuths form a reproducible snapshot for other tools.

WAV exports are stereo, 48 kHz, 32-bit IEEE floating point. Echotect does not
normalize, limit, quantize, clip, truncate, or shift them silently. Convolution
and rendered FDN IRs contain early and late reflections without direct arrival.
Wet contains direct, early, and late. Direct, early, and late stems share the
same start and duration.

## Max for Live

[Echotect Field](max-for-live/README.md) imports the project manifest as a
real-time spatial multi-tap delay. Heading rotates the listener, Scale changes
propagation times continuously, Width transforms relative azimuths, and Paths
sets the deterministic share of early paths processed by the device.

Stereo uses Main 1/2. Quad uses Front 3/4 and Rear 5/6, with an optional stereo
monitor on Main 1/2. IR and WAV exports remain ordinary portable files and do
not require Max for Live or Ableton Live.

## Data attribution

Map and building layers retain their required attribution in the application.
OpenStreetMap data is © OpenStreetMap contributors. Overture Maps building data
is licensed under ODbL.
