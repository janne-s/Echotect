# Echotect Field for Max for Live

Echotect Field is the optional real-time delay companion for Echotect. It reads
an `echotect-project` JSON manifest at schema version `1.0.0` and maps its direct
arrival and early reflection paths to a spatial multi-tap delay. Every arrival
level, time, and azimuth is read from the manifest; the device derives none of
them again. The browser application and its JSON/WAV exports remain fully
usable without Max for Live.

## Contents

- `Echotect Field.maxpat` — canonical, hand-edited device and UI
- `Echotect Field.maxproj` — Max development project
- `echotect_voice.maxpat` — delay-tap voice
- `echotect_controller.js` — import and device controller
- `echotect_model.js` — deterministic manifest and spatial model
- `echotect_field.js` — field visualization
- `test/model.test.js` — deterministic model tests

The canonical `Echotect Field.maxpat` is maintained by hand. Build scripts and
generated templates must not overwrite it or replace its Presentation layout.
Inspect the current patch and preserve unrelated UI edits before every change.

## Development and packaging

Add this directory to **Max → Settings → File Preferences** with subfolder
search enabled. Open `Echotect Field.maxproj`, then open the canonical patch.
When copying the patch into a Max Audio Effect editor, confirm that Max Console
shows:

```text
Echotect controller loaded
Echotect field UI loaded
```

Choose **Freeze Device** before saving the distributable AMXD. The frozen
device must collect the controller, model, field UI, and voice patcher. AMXD
binaries are release artifacts and are not committed here during development.

## Audio and routing

- `Dry` is the undelayed stereo input.
- `Direct` is the propagated direct arrival.
- `Reflections` contains the selected early paths in manifest order.
- `Paths` selects a deterministic 0–100% share of imported early paths; voices
  above the active count are DSP-muted.
- `Scale` continuously multiplies propagation time and intentionally retains
  moving-delay/Doppler behaviour.
- `Heading` rotates the listener against absolute arrival azimuths.
- `Width` contracts or expands relative azimuths.
- Dry/Wet uses an equal-power crossfade.
- Quad panning uses equal-power interpolation between FL, FR, RL, and RR.

Output layouts:

- Stereo: Main 1/2; Front 3/4 and Rear 5/6 are silent.
- Quad: Front 3/4 and Rear 5/6.
- Quad Monitor optionally folds the quad result into Main 1/2 and is off by
  default to prevent duplication.

## Verification

Run the model tests from this directory:

```sh
node --test test/model.test.js
```

In Live, verify JSON import, reported path count, Paths CPU scaling, Heading,
continuous Scale, Direct and Reflections controls, Dry/Wet, Stereo Main 1/2,
Quad Front 3/4, Quad Rear 5/6, and the optional Quad Monitor.
