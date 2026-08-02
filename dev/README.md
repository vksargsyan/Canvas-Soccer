# Development tools

Not part of the game. Serve the repo root and open these directly.

## `lineup.html`

Renders the character roster side by side — portraits, hands, kits — without booting the match
scene. The full capture harness takes minutes per pass because it bakes every stadium and turf
texture; this loads only `entities/player.js` and `entities/player-textures.js`, so a character
change can be judged in seconds.

```sh
python3 -m http.server 8000
# then open http://localhost:8000/dev/lineup.html
```
