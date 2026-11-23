# Ski Game

An endless 3rd-person downhill skiing game built with **TypeScript**, **Three.js**, and **Vite**. Ski down procedurally generated mountain trails, pick up presents, deliver them to waiting children for combo multipliers, and dodge boulders, trees, blizzards, and patrolling bears.

## Features

- **Endless Procedural Mountain Trails:** Up-locked Yaw-Pitch-Bank spline segments with rollers, icy Black Diamond chutes, and branching Model A trail forks (`Sunny Blue Run`, `Icy Black Diamond`).
- **Headless World-Space Simulation (`src/sim/`):** Fixed-timestep 60 Hz physics, `O(1)` warm-started surface sampling, 4-slot sliding `TrailWindow`, and 128 m floating-origin rebasing—completely decoupled from Three.js and DOM globals.
- **Pooled Cartoon Renderer (`src/render/three/`):** Mixed 3D cel-shaded toon meshes with smooth-normal inverted-hull outlines, 2.5D cylindrical billboards, time-budgeted chunk streaming, and zero-allocation GPU pooling tracked via `GraphicsTracker`.
- **Responsive HUD & Controls (`src/ui/`):** Keyboard (`A`/`D` or `←`/`→` to carve, `Space` to jump, `S`/`↓` to brake, `B` blizzard, `G` debug draw, `P` telemetry, `Esc` pause) and touch/pointer drag controls.

## Getting Started

```bash
npm install
npm run dev
```

### Scripts

- `npm run dev` — Start the Vite development server
- `npm run build` — Build for production (`dist/`)
- `npm run typecheck` — Run TypeScript typechecking (`tsc --noEmit`)
- `npm run test:run` — Run the Vitest suite

## Architecture

See [DESIGN.md](./DESIGN.md) for the full architecture specification, coordinate systems, rendering pipeline, and invariants.
