# Echotect: Turn your hood into a delay

Echotect turns real-world map geometry into musical delay structures. A Source,
Listener, and Reflectors define propagation paths, while the Echo field derives
additional Reflectors from nearby surfaces within the same model. The result can
be auditioned in the browser, saved as an editable project, or exported as audio
and portable project data for other applications.

See it live: [**https://janne-s.github.io/Echotect/**](https://janne-s.github.io/Echotect/)

![Echotect interface](assets/screenshot.jpg)

## How it works

Place a Source and Listener, then add Reflectors directly or derive them from
nearby surfaces with the Echo field. All Reflectors participate in the same path
model, including reflections between surfaces. Longer paths arrive later and
lose more level and high-frequency energy; materials shape their absorption,
and the selected spatial mode controls how the result is heard in the browser.
Projects remain editable, and audio can be exported as impulse responses, a wet
render, or aligned stems.

Use **Save** to store the editable project as a separate file and **Open** to
restore its map geometry, reflection field, materials, and listening settings.
Audio and project manifest exports remain available through **Export**.

Use **Image** to replace the map with a PNG, JPEG, or WebP sketch. Calibrate its
scale from a known distance in the image, rotate it as needed, and place Source,
Listener, and Point Reflectors on top. The image is included in the saved project.

Structures are editable polygons available in both Map and Image modes. Their
edges provide reflective surfaces to the Echo field and remain editable in saved
projects.

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
- **Echo field surfaces** — Limits how many nearby building surfaces are used.
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
is licensed under ODbL.

## Support Echotect

If you find Echotect useful, you can support its continued development:

- **GitHub Sponsors** — support the open-source work, updates, and future
  improvements directly.
  [Become a GitHub Sponsor](https://github.com/sponsors/janne-s)
- **Ko-fi** — make a one-off contribution to support the project.
  [Support on Ko-fi](https://ko-fi.com/jannesarkela)

Thank you for supporting independent open-source audio tools.

See [**Sanara Creations**](https://www.sanaracreations.fi/) for my
multidisciplinary work, both independently and in collaboration with others.
