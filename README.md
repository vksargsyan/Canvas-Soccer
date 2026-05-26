# Canvas Soccer

A low-poly browser soccer game built with [three.js](https://threejs.org/). One HTML file, no build step.

## Play

Either:

- Open `index.html` directly in a modern browser, or
- Serve the directory and visit it locally:

  ```sh
  python3 -m http.server 8000
  # then open http://localhost:8000
  ```

## Controls

- **WASD** or **Arrow keys** — move your player
- **Space** — kick the ball in the direction you're facing
- **R** — reset positions and score

## How it works

- Single `index.html` loads three.js from a CDN via an importmap.
- All geometry is built from primitive polygons (icosahedrons, cylinders, boxes) with `flatShading` for the chunky low-poly look.
- Custom mini-physics for the ball (gravity, friction, bounce, post collisions).
- A simple AI that chases the ball and tries to kick it toward your goal.
