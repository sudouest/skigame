---
title: Architecture, Layer Boundaries & Core Plumbing
scope: Module layering, dependency rules, composition root, fixed loop, EventBus, floating-origin rebase, build/deploy
tags: [architecture, boundaries, core, main, fixed-loop, event-bus, rebase, deploy]
source_files:
  - src/main.ts
  - src/core/architecture.test.ts
  - src/core/fixedLoop.ts
  - src/core/eventBus.ts
  - src/core/spatialGrid.ts
  - src/core/pool.ts
  - src/core/profiler.ts
  - src/core/noise.ts
  - src/core/rng.ts
  - src/core/math.ts
  - src/sim/contracts.ts
  - src/sim/physics/joltRuntime.ts
  - src/test/joltSetup.ts
  - vite.config.ts
  - tsconfig.json
  - package.json
  - .github/workflows/deploy.yml
last_verified: 2026-11-25
---

# Architecture, Layer Boundaries & Core Plumbing

## 1. Module Layering & Dependency Rules

The repository (~26.8k LOC TypeScript across `src/`) enforces a strict acyclic layered architecture with explicit dependency injection and **zero singletons**.

```text
                    ┌──────────────────┐
                    │   src/main.ts    │  Composition Root (mountSkiGame)
                    └────────┬─────────┘
         ┌───────────┬───────┴────────┬───────────┐
         ▼           ▼                ▼           ▼
    ┌─────────┐ ┌─────────┐    ┌────────────┐ ┌────────┐
    │ src/ui/ │ │ src/sim/│    │src/render/ │ │src/core│
    │ (HTML)  │ │(Headless│    │  three/    │ │(Plumb.)│
    └────┬────┘ └────┬────┘    │ (SOLE 3D)  │ └────────┘
         │           │         └─────┬──────┘      ▲
         │     (contracts only)      │             │
         ├───────────┴───────────────┼─────────────┤
         ▼                           ▼             │
    ┌──────────────┐            ┌─────────┐        │
    │ src/content/ │───────────▶│  none   │        │
    │ (Pure Data)  │            └─────────┘        │
    └──────────────┘                               │
         └─────────────────────────────────────────┘
              (sim, render, ui all use core & content)
```

### Automated Boundary Enforcement

Three test suites parse TypeScript AST / source text to guarantee boundaries never erode:

| Test Gate | File & Lines | Rule Enforced |
| :--- | :--- | :--- |
| Core isolation | `src/core/architecture.test.ts:146-164` | `src/core/` cannot import `three` or `sim`, `render`, `ui`, `content`, `tools`. |
| Content purity | `src/core/architecture.test.ts:166-187` | `src/content/` cannot import `three`, `sim`, `render`, `ui`, `tools`, or reference DOM globals. |
| Sim headlessness | `src/core/architecture.test.ts:189-210` | `src/sim/` cannot import `three`, `render`, `ui`, `tools`, or reference DOM globals (`window`, `document`, `HTMLElement`, `requestAnimationFrame`, `cancelAnimationFrame` — including via `globalThis`/`self`). |
| Zero singletons | `src/core/architecture.test.ts:212-220` | No file anywhere in `src/` may declare a `getInstance` method/function/property/variable. |
| UI isolation | `src/ui/__tests__/uiFormatting.test.ts:302-328` | `src/ui/` (production files) cannot import `three`, `/render/`, or any `/sim/` file other than `../sim/contracts`. |
| GPU factory mandate | `src/render/three/__tests__/graphicsTracker.test.ts:161-176` | No production file in `src/render/three/` (except `graphicsUtils.ts`) may call `new THREE.Mesh/InstancedMesh/Line/LineSegments/LineLoop/Points(...)`. |

> **Important:** `src/sim/contracts.ts` is the sole interface seam shared across `sim`, `render/three`, and `ui`. It exports read-only views (`ReadonlySimState`, `ReadonlyNumericBuffer`, `MountainFieldView`, `TrailWindowView`, `EntityPoolViews`, `DebugDrawView`) and `SimEventMap` so consumers read pooled typed arrays directly without per-frame DTO copying.

---

## 2. Composition Root (`src/main.ts`) & Frame Pipeline

`bootPhysicsRuntime()` (`src/main.ts:38-43`) asynchronously loads Jolt WASM using a Vite `?url` asset import (`import joltWasmUrl from 'jolt-physics/jolt-physics.wasm.wasm?url'`, passed to `initJolt({ locateFile: () => joltWasmUrl })` so paths resolve safely under both `base: '/skigame/'` and Capacitor `WKWebView`) and constructs a DI `JoltRuntime`.

`mountSkiGame(viewportEl, hudRootEl, physicsRuntime?)` (`src/main.ts:49-369`) wires all instances explicitly (injecting `physicsRuntime` into `new SkiSimulation(...)`) and starts paused on the Start / Skier Select overlay (`overlayMode = 'start'`) while rendering/streaming the live 3D mountain behind it. Auto-mounts on `#viewport` and `#hud-root` (`index.html:55-58`, `src/main.ts:371-387`) after `bootPhysicsRuntime()` resolves, calling `app.dispose()` (`sim.dispose()` + renderer/UI/input teardown) and `physicsRuntime.dispose()` on `pagehide`.

### 4-Phase Frame Loop (`src/core/fixedLoop.ts`, `src/main.ts:221-301`)

```text
requestAnimationFrame(ts)
  └─► FixedLoop.stepFrame(rawDtSec)                // clamps rawDtSec to MAX_FRAME_TIME = 0.25s
        1. onBeforeFrame(clampedDt)                // src/main.ts:224-263
             • input.sampleFrameInto(inputFrame)   // zero-alloc frame snapshot
             • process toggles (B/G/P/Esc) even while paused
             • accumulate jumpPressed & pointerSteerDelta * 3.2 (survives 0-step 120/144 Hz frames!)
        2. while (!paused && accum >= 1/60 && steps < maxSubSteps [17]):
             • onCapturePreviousPose()  ──► sim.savePreviousPoses()
             • onFixedStep(1/60)        ──► sim.step(dt, intent); clears jumpPressed & pointerSteerDelta
           alpha = clamp(accum / FIXED_DT, 0, 1)
        3. onRender(alpha, frameDtSec)             // src/main.ts:273-300
             • renderer.sync(simState, alpha, frameDtSec)  // includes budgeted ClipmapDataStore + TerrainClipmap + SceneryCellStreamer + LandmarkStreamer
             • dev/telemetry leak check every 20.0s (LEAK_CHECK_INTERVAL_SEC)
             • telemetry stats refresh every 0.2s (TELEMETRY_SAMPLE_INTERVAL_SEC)
             • ui.update(uiUpdateData, frameDtSec)
        4. (optional onAfterRender hook in FixedLoop — unused by main.ts; streaming runs inside renderer.sync)
```

Key `FixedLoop` constants (`src/core/fixedLoop.ts:3-4, 83`):
- `FIXED_DT = 1 / 60` (`16.667 ms`)
- `MAX_FRAME_TIME = 0.25` s (prevents spiral of death on tab switches)
- `maxSubSteps = Math.ceil(maxFrameTime / fixedDt) + 2` (`17` by default); excess accumulator wraps via `% fixedDt` (`:151-153`).
- Window `blur` and `document.visibilitychange` (`hidden`) automatically reset held inputs and pause active play (`src/main.ts:315-331`).

---

## 3. Typed `EventBus<SimEventMap>` (`src/core/eventBus.ts`, `src/sim/contracts.ts:806-866`)

`EventBus` is zero-allocation per `emit()` and re-entrancy safe (`emitDepth` defers `splice` compaction to `sweepInactive()` when listeners unsubscribe during dispatch, `src/core/eventBus.ts:52-74, 156-168`). **All payloads emitted by `SkiSimulation` and `CreatureSystem` are reused scratch objects (`skiSimulation.ts:153-214`, `creatureSystem.ts:23-41`) — listeners MUST NOT retain references to event payload objects across ticks.**

| Event Name | Emitter (`file:line`) | Subscribers | Payload Highlights |
| :--- | :--- | :--- | :--- |
| `PRESENT_PICKED_UP` | `SkiSimulation.visitPresentPickup` (`skiSimulation.ts:270`) | `ThreeRenderer` (`renderer.ts:245`, backpack pop), `GameUI` (`gameUi.ts:619`, pickup chip) | `presentDefId`, `worldX/Y/Z`, `pickupPoints`, `carriedCount`, `maxCapacity` |
| `PRESENT_DELIVERED` | `SkiSimulation.checkDeliveryZones` (`skiSimulation.ts:846`) | `GameUI` (`gameUi.ts:622`, broadcast ribbon) | `deliveryZoneId`, `countDelivered`, `pointsAwarded`, `comboMultiplier`, `totalScore`, `worldX/Y/Z` |
| `PLAYER_WIPEOUT` | `SkiSimulation.triggerImpact` (`skiSimulation.ts:954, 980`) | `GameUI` (`gameUi.ts:632`, stumble chip + flash) | `hazardId`, `effect` (`'wipeout' \| 'stumble'`), `presentsDropped`, `worldX/Y/Z`, `recoverySec` |
| `PLAYER_RECOVERED` | `SkiSimulation.recoverFromWipeout` (`skiSimulation.ts:1077`) | *(Available for audio/VFX)* | `worldX/Y/Z`, `invulnerableSec` |
| `FORK_ENTERED` | `SkiSimulation.step` (`skiSimulation.ts:617`) | `GameUI` (`gameUi.ts:625`, stage pill pulse) | `chosenSide`, `newSegmentId`, `newStageId`, `previousStageId` |
| `WORLD_REBASED` | `SkiSimulation.performOriginRebase` (`skiSimulation.ts:1122`) | `ThreeRenderer` (`renderer.ts:231`, terrain/landmark/snow shift) | `rebaseCount`, `deltaX/Y/Z`, `totalOffsetX/Y/Z` |
| `CREATURE_TELEGRAPH` | `CreatureSystem.step` (`creatureSystem.ts:93`) | `GameUI` (`gameUi.ts:629`, edge beacons / ribbon) | `creatureDefId`, `soundId`, `worldX/Y/Z`, `distanceToPlayerM`, `showEdgeIndicator`, `edgeSide` |

---

## 4. Translation-Only 128 m Floating-Origin Rebasing

Triggered at the end of `SkiSimulation.step()` (`src/sim/skiSimulation.ts:47, 740-746`) whenever `Math.abs(curr.posX|Y|Z) >= WORLD_REBASE_THRESHOLD_M (128)`.

`performOriginRebase(dx, dy, dz)` (`src/sim/skiSimulation.ts:1237-1287`) subtracts `(dx, dy, dz)` from:
1. `currSkier` and `prevSkier` (`posX/Y/Z`, `groundY`) — **both** prev and curr shift together so `alpha` interpolation never glitches.
2. `trailWindow.rebaseOrigin(dx, dy, dz)` — shifts all 4 active segments (`TrailSpine` `Float64Array` tables + landmarks), all 4 `horizonSpines`, and all `ghostSpines` (`src/sim/trailWindow.ts:209-221`).
3. `pools.shiftOrigin(dx, dy, dz)` — shifts all entity pool coordinates (hazards, presents, tossed presents prev+curr, delivery zones, creatures prev+curr, ski tracks, ramps).
4. `hazardGrid`, `presentGrid`, `deliveryGrid` via `SpatialGrid.shiftOrigin(dx, dz)` — O(1) origin-offset shift with zero re-hashing (`src/core/spatialGrid.ts:53-56`).
5. `cameraRig.shiftOrigin(dx, dy, dz)` — shifts both `prevCamera` and `currCamera`.
6. `surfaceSample.{groundY, macroY, nearestSpineY}` + `contactSolver.shiftOrigin(dx, dy, dz)` (`SetPosition`-only on Jolt `CharacterVirtual`, rolling heightfield body, and active bubble bodies) + `physics.shiftOrigin(dx, dy, dz)` + `physics.invalidateSurfaceCache()`.
7. Accumulates `state.rebase.offsetX/Y/Z`, updates `mountainField.setOriginOffset(offsetX, offsetZ, offsetY)` so noise coordinates `absX = wx + offsetX` remain bit-invariant, and emits `WORLD_REBASED`.
8. `ThreeRenderer` (`renderer.ts:308-331, 385-417`) performs **zero work/uploads** on `ClipmapDataStore` across fractional `WORLD_REBASED` and shifts `SceneryCellStreamer` cell origins, `LandmarkStreamer`, `SnowVfx`, `CarveSprayVfx`, and `dirLight` transforms, with a polling fallback in `sync()` in case rebases happen before listener attachment or across `sim.reset()`.

---

## 5. Core Plumbing Summary (`src/core/`)

| Module | Key Exports | Notes / Contracts |
| :--- | :--- | :--- |
| `math.ts` | `clamp`, `lerp`, `inverseLerp`, `smoothstep`, `smootherstep`, `damp`, `wrapAngle`, `angleDelta`, `lerpAngle`, `clampAngleAround`, `degToRad`, `radToDeg` | `damp()` is framerate-independent `lerp(cur, tgt, 1 - exp(-lambda * dt))`. `wrapAngle` wraps to `[-PI, PI)`. |
| `rng.ts` | `SeededRng` (Mulberry32), `hashString` (FNV-1a), `hashCoords2DU32`, `hashCoords2D`, `normalizeSeedUint` | Zero-alloc PRNG; `.fork(salt)` derives an independent child stream without mutating parent state. |
| `noise.ts` | `gradientNoise2D` (`[-1, 1]`), `fbm2D` (`[-1, 1]`), `ridgedNoise2D` (`[0, 1]`) | 16 unit 2D gradients, quintic `C^2` fade, `Math.SQRT2` amplitude scaling, 32-bit `fx0 \| 0` lattice hash (safe past 50 km). |
| `spatialGrid.ts` | `SpatialGrid<T>`, `SpatialGridPair<A, B>` | Integer-packed cell keys (`CELL_OFFSET = 0x2000000`), query-stamp deduplication (non-reentrant per instance), pooled buckets, O(1) `shiftOrigin()`. |
| `pool.ts` | `ObjectPool<T>` | Pre-warmable free-list pool with optional `reset` hook and `maxCapacity`. |
| `profiler.ts` | `Profiler`, `ProfilerSnapshot` | EMA (`alpha = 0.1`) timings (`frameMs`, `simMs`, `renderMs`, `streamMs`, peaks, `fps`) + arbitrary named counters (`drawCalls`, `triangles`, `activeChunks`, `trackedObjects`). |
| `input.ts` | `InputManager`, `createInputFrameState` | Headless-capable keyboard/pointer/touch manager (details in [gameplay-content-and-ui.md](./gameplay-content-and-ui.md)). |

---

## 6. Build, Config & Deployment

- **TypeScript (`tsconfig.json`):** `target: "ES2022"`, `module: "ESNext"`, `moduleResolution: "bundler"`, `strict: true`, `noUncheckedIndexedAccess: true`, `noEmit: true`. Note: `noUncheckedIndexedAccess` is ON, so typed-array/array indexing often requires `!` or bounds checks.
- **Vite & Vitest (`vite.config.ts`):**
  - `base: '/skigame/'` (important for static and `?url` `.wasm` asset resolution!).
  - `optimizeDeps: { exclude: ['jolt-physics'] }` prevents Vite pre-bundling from breaking Jolt's `.wasm` resolution in dev.
  - `test.environment: 'node'`, `test.include: ['src/**/*.test.ts']`, `test.setupFiles: ['./src/test/joltSetup.ts']` (worker-once async Jolt WASM initialization calling `setDefaultPhysicsRuntime(new JoltRuntime(jolt))`). No Vite plugins installed.
- **Dependencies (`package.json`):** Runtime dependencies: `jolt-physics` (`^1.1.2`, resolved to `1.1.2`) and `three` (`^0.181.0`). Dev dependencies: `@types/node`, `@types/three`, `typescript`, `vite`, `vitest`.
- **Browser WASM Boot (`src/main.ts`):** `bootPhysicsRuntime()` awaits `initJolt({ locateFile: () => joltWasmUrl })` using `import joltWasmUrl from 'jolt-physics/jolt-physics.wasm.wasm?url'`, then passes the `JoltRuntime` into `mountSkiGame(...)` → `new SkiSimulation({ ..., physicsRuntime })`. Raw Jolt ownership/APIs remain quarantined in `src/sim/physics/` (`worldContactSolver.ts`, `joltRuntime.ts`, `joltContactSolver.ts`).
- **CI / Deploy (`.github/workflows/deploy.yml`):** Push to `main` builds with Node 22 (`npm ci && npm run build`) and deploys `./dist` to GitHub Pages. *(Note: CI deploy workflow currently runs `npm run build` only — run `npm run typecheck && npm run test:run` locally before pushing.)*

---

## 7. Implemented Code vs. `DESIGN.md` Aspirational Delta

`DESIGN.md` serves as the long-term architectural vision (Phases 1–3). Do **not** assume these `DESIGN.md` items exist yet:

| Feature in `DESIGN.md` | Current Status in Repo |
| :--- | :--- |
| `stage-designer.html`, `asset-inspector.html`, `src/tools/` | **Not implemented** (only `index.html` and `src/main.ts` exist). |
| `public/assets/`, `.glb` mesh loading, `THREE.AnimationMixer` | **Not implemented** (all 3D meshes are procedural in `src/render/three/meshFactory.ts` & `skierRig.ts`; 2.5D sprites are canvas-drawn in `spriteAtlas.ts`; `LandmarkStreamer` has an `assetWaiter` hook ready). |
| Audio manager / SFX / music | **Not implemented** (`soundId` exists on `CreatureDef` / `CREATURE_TELEGRAPH` payload only). |
| Ogre (`ogreThrower`) & Yeti (`yetiFlankAmbush`) creatures | **Types only** (`src/content/types.ts:258-276`); only `bear_patrol` is implemented in `src/content/creatures.ts` and `src/sim/creatureSystem.ts`. |
| Capacitor iOS/Android wrappers, haptics, Game Center | **Not implemented** (Phase 3; viewport meta/CSS safe-area & `webglcontextlost` recovery are already in place). |

---

## 8. Gotchas / Don't Break

- **Always call `sim.dispose()` (and `physicsRuntime.dispose()` on app shutdown):** `JoltContactSolver` acquires one of `JoltRuntime`'s 32 world slots and allocates WASM memory via `DisposableScope`. Missing `sim.dispose()` in tests or hosts leaks WASM heap and exhausts `JoltRuntime.acquireWorldSlot()`.
- **Never keep a reference to an `EventBus` payload** — `SkiSimulation` and `CreatureSystem` mutate and reuse the same scratch objects on subsequent emits.
- **Never skip `savePreviousPoses()` before `step()`** — `ThreeRenderer` interpolates `prev -> curr` by `alpha`; skipping it causes 120/144 Hz stutter or stale transforms after teleports/rebases.
- **Remember `base: '/skigame/'`** — Hardcoded root-relative asset paths (`/assets/...`) will break on GitHub Pages deployment.
- **Keep `new SkiSimulation()` synchronous** — `src/main.ts:62` passes pre-booted `physicsRuntime` via DI, and ~25 test sites instantiate `SkiSimulation` synchronously via `src/test/joltSetup.ts`'s `setDefaultPhysicsRuntime(...)` without `await`.
