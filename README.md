# Echotect

Echotect turns real-world map geometry into musical delay structures. A Source,
Listener, and Reflectors define propagation paths that can be auditioned in the
browser, saved as an editable project, exported as audio, or opened in the
optional Max for Live device.

![Echotect interface](assets/screenshot.jpg)

## How it works

Place a Source, Listener, and Reflectors on the map. Echotect uses the resulting
distances to time the direct sound and reflections. Longer paths arrive later
and lose more level and high-frequency energy. Reflector materials affect which
frequencies are absorbed, while the selected spatial mode controls how the
result is heard in the browser.

Point Reflectors create distinct echoes and can reflect sound between one
another. The Echo field uses nearby building surfaces to create a denser late
response. Projects remain editable, and audio can be exported as impulse
responses, a wet render, or aligned stems.

## Echo field settings

- **Point reflections** — Chooses between a longer, more diffuse point-reflection
  response and stricter geometric decay.
- **Point persistence** — Sets how strongly sound continues between Point
  Reflectors in Persistent mode.
- **Point bounces** — Limits how many times a point-reflection path can bounce.
- **Point path limit** — Limits the number of point-reflection paths used.
- **Atmosphere** — Uses standard air conditions, custom conditions, or disables
  air absorption.
- **Temperature** — Sets the air temperature for Custom atmosphere mode.
- **Relative humidity** — Sets the humidity for Custom atmosphere mode.
- **Air pressure** — Sets the air pressure for Custom atmosphere mode.
- **Air attenuation scale** — Adjusts the strength of air absorption; `1.00× ISO`
  is the normal model and `0.00×` disables its effect.
- **Geometric spreading** — Controls level loss over distance; `1/r` is the
  natural setting and Off removes this loss.
- **Material absorption scale** — Adjusts how strongly reflector materials color
  and absorb the sound; `1.00×` uses the normal material presets.
- **Late field** — Selects the sampled Convolution response or the Feedback
  network reverb.
- **Response duration** — Sets the maximum Convolution response length.
- **Echo field surfaces** — Limits how many nearby building surfaces are used.
- **Late path samples** — Sets how many sampled paths form the Convolution tail.
- **Late field bounces** — Limits the number of surface bounces in the late
  field.
- **Cutoff level** — Stops paths after they have become quieter than this level.
- **Tail persistence** — Controls how readily Convolution paths continue after
  each bounce.
- **Tail length** — Sets the Feedback network reverb time.
- **Density** — Controls how closely packed the Feedback network echoes are.
- **Damping** — Controls how quickly high frequencies fade from the Feedback
  network tail.
- **Geometry influence** — Controls how strongly the map geometry shapes the
  Feedback network.

## Max for Live

[Echotect Field](max-for-live/README.md) imports the project manifest as a
real-time spatial multi-tap delay. Heading rotates the listener, Scale changes
propagation times continuously, Width transforms relative azimuths, and Paths
sets the deterministic share of early paths processed by the device.

Stereo uses Main 1/2. Quad uses Front 3/4 and Rear 5/6, with an optional stereo
monitor on Main 1/2. IR and WAV exports remain ordinary portable files and do
not require Max for Live or Ableton Live.

Max4Live device is rather rudimentary at the moment, but functional.

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
