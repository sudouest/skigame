# Ski Game

An endless 3rd-person downhill skiing game built with **TypeScript**, **Three.js**, and **Vite**. Ski down procedurally generated mountain trails, pick up presents, deliver them to waiting children for combo multipliers, and dodge boulders, trees, blizzards, and patrolling bears.

## Features

- **Endless Procedural Mountain Trails:** Up-locked Yaw-Pitch-Bank spline segments with rollers, icy Black Diamond chutes, and branching Model A trail forks (`Sunny Blue Run`, `Icy Black Diamond`).
- **Headless World-Space Simulation (`src/sim/`):** Fixed-timestep 60 Hz physics, `O(1)` warm-started surface sampling, 4-slot sliding `TrailWindow`, and 128 m floating-origin rebasing—completely decoupled from Three.js and DOM globals.
- **Pooled Cartoon Renderer (`src/render/three/`):** Mixed 3D cel-shaded toon meshes with smooth-normal inverted-hull outlines, 2.5D cylindrical billboards, time-budgeted chunk streaming, and zero-allocation GPU pooling tracked via `GraphicsTracker`.
- **Responsive HUD & Controls (`src/ui/`):** Keyboard (`A`/`D` or `←`/`→` to carve, `Space` to jump, `S`/`↓` to brake, `B` blizzard, `G` debug draw, `P` telemetry, `Esc` pause), touch/pointer drag controls, and mobile accelerometer/tilt steering (iOS/iPadOS Safari permission flow + Android orientation/motion sensors).

## Getting Started

```bash
npm install
npm run dev
```

### HTTPS & Testing on Mobile Devices (iPhone, iPad, Android)

Mobile browsers restrict `DeviceOrientationEvent` and `DeviceMotionEvent` sensors to **HTTPS secure contexts**.

- **`npm run dev`** and **`npm run preview`** automatically serve over **HTTPS** (`host: true`) so you can open the printed LAN URL (`https://<your-lan-ip>:5173/skigame/`) directly from an iPhone, iPad, or Android device on the same Wi-Fi network.
- On first run, `scripts/httpsCert.ts` generates a 90-day self-signed ECDSA certificate cached in `.certs/` (gitignored) with SANs for `localhost`, `127.0.0.1`, `::1`, and your active LAN IPv4 addresses. Accept the browser's local certificate warning to proceed, or supply a locally trusted cert (e.g., via `mkcert`) using `HTTPS_KEY` and `HTTPS_CERT`.
- Set `DISABLE_HTTPS=1` if you explicitly need plain HTTP locally. Production deployments on GitHub Pages are served over HTTPS automatically.

### Scripts

- `npm run dev` — Start the Vite development server
- `npm run build` — Build for production (`dist/`)
- `npm run typecheck` — Run TypeScript typechecking (`tsc --noEmit`)
- `npm run test:run` — Run the Vitest suite

## Architecture

See [DESIGN.md](./DESIGN.md) for the full architecture specification, coordinate systems, rendering pipeline, and invariants.
