# Vendored dependencies

## three.js r160

`three/` contains an unmodified copy of [three.js](https://github.com/mrdoob/three.js) r160 —
the core module build plus the post-processing, shader and geometry-utility addons the
game uses (`examples/jsm/postprocessing/`, `examples/jsm/shaders/`,
`examples/jsm/utils/BufferGeometryUtils.js`).

It is vendored rather than loaded from a CDN so the game runs deterministically and without
network access. Licensed under the MIT License; see `three/LICENSE`.

To update, replace the files from the matching tag at
`https://raw.githubusercontent.com/mrdoob/three.js/<tag>/` and update the version here.
