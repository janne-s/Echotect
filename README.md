# Echotect: Turn your hood into a delay

Echotect turns real-world map geometry into musical delay structures. Place a
Source and Listener, then add Reflectors directly or derive them from nearby
surfaces with the Echo field. Audition the result in the browser, save it as an
editable project, or export it as audio and portable project data.

See it live: [**https://janne-s.github.io/Echotect/**](https://janne-s.github.io/Echotect/)

![Echotect interface](assets/screenshot.jpg)

## How it works

All Reflectors participate in the same path model, including reflections between
surfaces. Longer paths arrive later and lose more level and high-frequency
energy; materials shape their absorption, and the spatial mode controls how the
result is heard. Audio can be exported as impulse responses, a wet render, or
aligned stems.

Use **Save** and **Open** for editable project files. Use **Export** for audio
and project manifests.

Use **Image** to replace the map with a PNG, JPEG, or WebP sketch. Calibrate its
scale from a known distance in the image, rotate it as needed, and place Source,
Listener, and Point Reflectors on top. The image is included in the saved project.

Structures are editable polygons in Map and Image modes. Their edges provide
reflective surfaces to the Echo field.

Use **Terrain** to build the echo field from real elevation data. Drag a
rectangle on the map; its terrain is loaded, drawn as a hillshade, and becomes
the reflecting space, with paths running in three dimensions through the air.
Drag the rectangle to capture another place, or reshape it from its corners.
Press **Terrain** again to return to the map space; press it once more to reopen
the saved terrain without drawing it again. Use the **+** beside Terrain to draw
a replacement elsewhere; the saved terrain remains until the new one loads.
Map, Canyon, and Chamber each
remember their own Source and Listener placement. Delete the capture explicitly
from the Terrain settings when it is no longer needed. While a terrain is active
it is the only acoustic space: buildings, structures, and manual reflectors do
not take part. The mountain button beside the map zoom controls switches between
the street map and shaded relief in every mode.

The space panel shows a 3D view or a section through the Source and Listener and
can open in its own window. Reflections light up in the 3D view during playback.

- **Canyon / Chamber** — Canyon hears the air above the terrain: canyons,
  valley sides, and mountain flanks reflect. Chamber is creative geometry: the
  terrain's shape as a hollow above a flat floor, narrowing upward as the relief
  does.
- **Floor** — Sets the Chamber floor. Raising it narrows the cavity and splits
  it under separate summits.
- **Scale** — Uniformly scales the fixed acoustic space from 1:100 to 10:1,
  including the terrain, Source, Listener, and reflection paths. Their map
  positions and relative 3D geometry stay unchanged; distances and delays
  follow the scaled space.
- **Listener height** / **Source height** — Height above the ground, or above
  the floor in a Chamber, where it is limited by the ceiling overhead.
  Canyon and Chamber remember their own heights and map positions when you
  switch between them.

The Terrain tab in the settings holds the surface:

- **Material** — Sets the absorption of the whole terrain. Natural ground
  materials use absorption computed from measured flow resistivity.
- **Scattering** — Splits reflected energy between discrete specular echoes and
  diffuse scattering.
- **Ground reflection** — Adjusts the ground under the Source and Listener;
  0 dB is the physical level and Off removes it.

## Echo field settings

- **Playback mode** — Plays directly in Live mode or prepares a reusable browser
  render when Rendered is selected.
- **Block reflections through buildings** — Prevents Echo field surfaces from
  reflecting sound to each other through intervening buildings.
- **Point reflections** — Chooses between a longer, more diffuse point-reflection
  response and stricter geometric decay.
- **Point persistence** — Sets how strongly sound continues between Point
  Reflectors in Persistent mode.
- **Point bounces** — Limits how many times a point-reflection path can bounce.
- **Point path limit** — Limits the number of point-reflection paths used.
- **Atmosphere** — Uses standard air conditions, custom conditions, or disables
  atmospheric timing and absorption adjustments.
- **Temperature** — Sets the air temperature for Custom atmosphere mode and
  changes the speed of sound used for every propagation time.
- **Relative humidity** — Sets the humidity for Custom atmosphere mode, including
  its smaller contribution to the speed of sound.
- **Air pressure** — Sets the air pressure for Custom atmosphere mode.
- **Air attenuation scale** — Adjusts the strength of air absorption; `1.00× ISO`
  is the normal model and `0.00×` disables its effect.
- **Geometric spreading** — Controls level loss over distance; `1/r` is the
  natural setting and Off removes this loss.
- **Material absorption scale** — Adjusts how strongly reflector materials color
  and absorb the sound; `1.00×` uses the normal material presets.
- **Late field** — Selects the Sampled paths response or the Feedback network.
- **Late field level** — Adjusts the level of the late response in decibels.
- **Response duration** — Sets the maximum Sampled paths response length.
- **Echo field surfaces** — Limits how many nearby building or terrain surfaces
  are used.
- **Late path samples** — Sets how many sampled paths form the late response.
- **Late field bounces** — Limits the number of surface bounces in the late
  field.
- **Cutoff level** — Stops paths after they have become quieter than this level.
- **Tail persistence** — Controls how readily sampled paths continue after
  each bounce.
- **Tail length** — Sets the Feedback network reverb time.
- **Density** — Controls how closely packed the Feedback network echoes are.
- **Damping** — Controls how quickly high frequencies fade from the Feedback
  network tail.
- **Geometry influence** — Controls how strongly the map geometry shapes the
  Feedback network.

## Max for Live

[Echotect Field](max-for-live/README.md) is one consumer of Echotect's JSON
project manifest. It brings the geometry into Ableton Live to recreate its
direct sound and reflection delays, with real-time controls for timing,
direction, width, path count, and the balance between the input and reflected
sound.

The Max for Live device is functional, but still rudimentary and under
development.

## Data attribution

Map and building layers retain their required attribution in the application.
OpenStreetMap data is © OpenStreetMap contributors. Overture Maps building data
is licensed under ODbL. The optional relief map uses OpenStreetMap data and
SRTM/Sonny elevation with the OpenTopoMap style under CC BY-SA. Terrain capture
elevation comes from
[Terrain Tiles](https://registry.opendata.aws/terrain-tiles/) on AWS Open Data,
compiled by Mapzen from SRTM, GMTED2010, NED, ETOPO1, and national datasets; see
their [attribution list](https://github.com/tilezen/joerd/blob/master/docs/attribution.md).

## Support Echotect

Support development through [GitHub Sponsors](https://github.com/sponsors/janne-s)
or [Ko-fi](https://ko-fi.com/jannesarkela). See
[Sanara Creations](https://www.sanaracreations.fi/) for related work.
