# Echotect

Echotect is a browser-based tool for designing musical echoes with real-world
map geometry. A Source, Listener, and Reflectors define travel distances that
are converted into propagation times and audible delay taps.

The application is designed to run as a static GitHub Pages site. It will
support immediate Web Audio preview with a built-in handclap-like sound and
local import of a user's own audio file. Max for Live integration uses a
versioned JSON Space file and is optional for browser use.

## Planned stack

- HTML and CSS
- native JavaScript ES modules
- MapLibre GL JS
- OpenStreetMap-compatible map tiles
- Web Audio API
- File API for local audio import
- versioned JSON Space import and export

No backend, database, account system, or secret client-side API key is required
for the MVP. All deployable application files belong in this repository.

## Development

The initial application should remain directly publishable as static files.
Because JavaScript modules and browser file/audio APIs are restricted under
`file://`, serve the directory with a small local static server while developing.

GitHub Pages must be tested using a repository subpath, so application asset
references should be relative rather than rooted at `/`.

## Status

Project foundation and design phase. The browser application has not yet been
implemented.
