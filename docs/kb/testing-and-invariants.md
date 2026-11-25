---
title: Testing Strategy, Invariants, Coverage Blind Spots & Debug Tooling
scope: Full 23-file Vitest map, contract gates, 50 km soak test, Jolt WASM leak gate, known blind spots, Profiler & debug overlays
tags: [testing, vitest, invariants, soak, jolt, coverage-gaps, profiler, debug-draw]
source_files:
  - vite.config.ts
  - src/test/joltSetup.ts
  - src/core/architecture.test.ts
  - src/sim/__tests__/soak50km.test.ts
  - src/sim/__tests__/joltPhysics.test.ts
  - src/sim/__tests__/mountainField.test.ts
  - src/sim/__tests__/physicsAndWorld.test.ts
  - src/sim/__tests__/trailSpline.test.ts
  - src/sim/__tests__/creatureSystem.test.ts
  - src/render/three/__tests__/graphicsTracker.test.ts
  - src/render/three/__tests__/terrainAndRenderer.test.ts
  - src/ui/__tests__/uiFormatting.test.ts
  - src/ui/__tests__/gameUi.test.ts
  - src/content/content.test.ts
  - src/sim/debugDrawBuffer.ts
  - src/render/three/debugOverlay.ts
last_verified: 2026-11-25
---

# Testing, Invariants, Coverage Blind Spots & Debug Tooling

## 1. Running Verification

All tests run headlessly in Node via Vitest (`vite.config.ts:8-12`: `environment: 'node'`, `include: ['src/**/*.test.ts']`, `setupFiles: ['./src/test/joltSetup.ts']`). `joltSetup.ts` boots Jolt WASM once per Vitest worker and registers a default `JoltRuntime`. No browser or WebGL context is needed.

```bash
npm run typecheck   # tsc --noEmit (strict + noUncheckedIndexedAccess; 0 errors)
npm run build       # Vite production bundle -> dist/ (~5.8 s)
npm run test:run    # Runs all 23 test files (112/112 tests; ~18.15–18.48 s post-M4)
```

> **Final Post-M4 Baseline Timing & Invariant Gate (verified `2026-11-25`):** `npm run typecheck` (`0` errors), `npm run build` (`5.83 s`, `dist/assets/index-DIijoASO.js 1,908.70 kB` + `jolt-physics.wasm 2,027.83 kB`), and `npm run test:run` (`23/23` files, **`112/112` tests**, **`~18.15–18.48 s`**) all pass cleanly with **`0` GPU leaks**, **`0 B` Jolt WASM memory leaks**, and **`0` CDLOD border cracks / T-junctions**. `soak50km.test.ts` runs in **`~15.27–15.99 s` under full 23-file parallel load** (`~4.0–4.7 s` below its `20 s` timeout). Any test instantiating `SkiSimulation` MUST call `sim.dispose()` so its Jolt world slot (`maxWorldSlots = 32`) is released cleanly.

---

## 2. Complete Test Suite Map (23 Files)

### Core & Architectural Contracts (10 files)
| Test File | What It Guarantees |
| :--- | :--- |
| `src/core/architecture.test.ts` | AST enforcement: `core`/`content`/`sim` never import `three` or higher layers; `content`/`sim` never touch DOM globals (even via `globalThis`/`self`); zero `getInstance()` singletons anywhere in `src/`. |
| `src/core/fixedLoop.test.ts` | Deterministic 60 Hz steps, `alpha` interpolation, `MAX_FRAME_TIME = 0.25` clamp, pause accumulator freeze, injectable `FrameScheduler`. |
| `src/core/eventBus.test.ts` | Typed pub/sub, `once`/`off`/unsubscribe/`clear`, safe subscribe/unsubscribe during `emit()`. |
| `src/core/input.test.ts` | Keyboard steer/jump/brake/toggles, repeat guard, blur reset, injectable DOM attach, horizontal drag, tap jump, 2-finger brake. |
| `src/core/spatialGrid.test.ts` | Multi-cell deduplication, radii, zero-alloc queries, exact lookup invariance across `shiftOrigin()`, `SpatialGridPair` deduplication. |
| `src/core/noise.test.ts` | Determinism, strict output bounds, continuity across ± integer cell boundaries, stability at large negative coords, invalid arg sanitization, plus $C^1/C^2$ ridge-crest smoothness & `[0, 1]` bounds for `smoothRidgedNoise2D`. |
| `src/core/rng.test.ts` | Mulberry32 determinism, `nextRange`/`nextInt`/`pickWeighted`, state save/restore, independent `.fork()`. |
| `src/core/math.test.ts` | `clamp`, `lerp`, `smoothstep`/`smootherstep`, `damp`, angle wrapping/clamping across `±PI`. |
| `src/core/pool.test.ts` | `ObjectPool` prewarm, reuse, `reset` hooks. |
| `src/core/profiler.test.ts` | Frame/sim/render/stream EMA timings and counters without allocations. |

### Content Validation (1 file)
| Test File | What It Guarantees |
| :--- | :--- |
| `src/content/content.test.ts` | All 5 forkable stages cover every landscape archetype, badge, and weather profile; valid hex colors, probabilities, scenery rules, `|k|*(hw+skirt) <= 0.4`, fog floor `>= 65 m`, and complete MVP registries. |

### Headless Simulation (6 files)
| Test File | What It Guarantees |
| :--- | :--- |
| `src/sim/__tests__/trailSpline.test.ts` | Up-locked Yaw-Pitch-Bank frames, `|k|*(hw+skirt) <= 0.4`, Model A fork seam invariants (`k=0, β=0`, twin split-seam gates, 25 m inner wall ramp, 1.5 m nose), continuous `MountainSurfaceSampler` across forks + 40 m prune, Model B `IslandDivider`, 50 m fork runway, post-brow clearance, 75% bag delivery acceleration. |
| `src/sim/__tests__/mountainField.test.ts` | `19` tests: `|yaw| <= 60°` (`<= 48°` at seams); Tier-1 & Tier-2 `horizon2Spines` (8 spines) 0-delta promotion; 2D V-wedge/radial continuity (`normalY >= 0.38`) & zero 280 m advance pop (`< 0.05 m`); `MAX_GHOST_SPINES = 44` / `960 m` prune invariance; 128 m rebase invariance; `LayoutEngine` height parity + S6 `rebuildElevationSpines` ordering; `TerrainFieldView.sampleColumnGrid` + `WORLD_REBASED` + `dirtyRects`; G1/G2/G3 (`T1=0, Twin=0` across 50 fork advances, flattened divider `normalY >= 0.74`); 5-advance tile-bounds parity (`< 1e-6`); `macroNodes` fallback parity & foreign-corridor sinkhole prevention. |
| `src/sim/__tests__/joltPhysics.test.ts` | `6` tests (M3): **`0 B` `sGetFreeMemory()` leak** across 6 full create/simulate/reset/simulate/`dispose()` cycles; `> 52°` off-grid (`65°`) & diagonal cliff rejection + energy conservation + `wall_scrape`/`wall_crash` gates; `<= 5 cm` Jolt heightfield parity across `powder-bowl`, `icy-black`, `blizzard-ridge`, and `IslandDivider`; energy-conserving carving, zero uphill poling, high rock drag, and `48°` rock hop block; 3D `ConvexHullShape` ramp wedge (launch, mid-ramp landing, side/back deflection, safe high-speed `icy-black` jump); slow-speed (`< 13 m/s`) convex crest detachment & solid 3D wipeout tumble deflection off boulders. |
| `src/sim/__tests__/physicsAndWorld.test.ts` | Carving, continuous downhill restoring torque (`<= 115°` without snap teleports), `iceGrip` perk, V-wedge nose deflection, `scoreAttack` lives & game over, jump clearing `boulder_small` (`> 0.8 m`) & breaking ski tracks, ramp launch (`> 2.2 m`), pickups/delivery combos/wipeout-recover, Bear telegraph & world-space patrol, 128 m rebase continuity, `CameraRig` FOV & front-facing terrain clearance (`>= 1.9 m`), `> 35 m` off-piste carving & fork switching, `chasm_fall` bypassing invulnerability, canyon wall braking & `fallLine` stall pivot, and local off-piste recovery. |
| `src/sim/__tests__/creatureSystem.test.ts` | `4` tests: `> 85 m` sleep gate (including diagonal distance), full `IDLE -> TELEGRAPH -> ATTACK -> RECOVER -> ATTACK` lifecycle with `<= 1` `sampleSurface`/tick at 60 Hz + slope `groundY` accuracy, `85 m` wake/sleep boundary, and `> 0.25 m` step re-sampling. |
| `src/sim/__tests__/soak50km.test.ts` | **50 km PCG & Stability Gate (20 s timeout, <= 180,000 ticks, `~15.4 s` parallel):** `distanceM >= 50000`, `forkCount >= 100`, `rebaseCount > 200`, `seenSegments > 150`, all 5 stages visited, O(1) pool counts `< capacity`, zero lethal hazards within `2.5 m` of `safeX` or inside 50 m fork runway, delivery cadence strictly `[70, 250] m`, all skier/camera/ground values `Number.isFinite`, plus M3 physics sanity guards (`maxAbsVelY < 40`, `maxUpwardVelY < 20`, `maxSpeed3d < 48`) and `sim.dispose()`. |

### Rendering & Graphics (4 files)
| Test File | What It Guarantees |
| :--- | :--- |
| `src/render/three/__tests__/graphicsTracker.test.ts` | `6` tests: Ref-counting across `Mesh`/`InstancedMesh`/`Line`/`Points`, `cloneObject`/`assignMaterial`/`markAsCache`, `SkyDome` + `ClipmapDataStore` (4 `DataArrayTexture`s) + `TerrainClipmap` (`InstancedMesh`) tracking & 0-leak disposal across reset/restore/dispose, detached & untracked leak detection, **static ban on raw `new THREE.Mesh/...` in `src/render/three/`**. |
| `src/render/three/__tests__/smoothNormals.test.ts` | Hard face normals preserved while `aSmoothNormal` averages coincident corners unbiased on indexed & non-indexed meshes. |
| `src/render/three/__tests__/cameraAndAtlas.test.ts` | Portrait-preserving horizontal FOV, camera `alpha` interpolation, RGB edge dilation (`alpha === 0` preserved), `3×1 NearestFilter NoColorSpace` toon gradient map & headless atlas safety. |
| `src/render/three/__tests__/terrainAndRenderer.test.ts` | `9` tests (M4 integration suite): 1-draw-call `16×16` CDLOD `InstancedMesh` (`+Y` CCW diagonals, `camera.far = 750`, 0 leaks); 5-tier quadtree `lodRange` non-overflow bounds across worst-case snap offsets; exact vertex-shader morph simulation confirming **0 cracked vertices (`dXZ < 1e-4, dY < 1e-4`) & 0 uncollapsed odd T-junctions** across shared `L↔L`/`L↔L+1` borders (steady-state, `24 m` & `44 m` forced lag); `needsUpdate`-before-`initTexture` + raw `gl.texSubImage3D` wrap splitting & zero-copy full-width uploads + `UNPACK_IMAGE_HEIGHT = 0` + zero-upload fractional `WORLD_REBASED` + global `clipmapAnchorAbsY` re-anchor + `fieldRevision`/`dirtyRects` (including partial-teleport preservation) + 256-bit `refinedRowMask` mid-scroll completeness + instant `webglcontextrestored`; `uAlbedoTex` sRGB encoding & `< 1 cm` L0 parity + CPU cavity AO vs real `MountainField`; `LandmarkStreamer` async `assetWaiter`/O(1) prune/reset; decoupled `32 m` `SceneryCellStreamer` determinism/exclusions/LOD-invariance/rebase; `SceneryTierRule` slope gates & cross-fork biome fidelity; `terrain-cdlod-snow-toon-v3` GLSL expansion vs `three@0.181.0` `ShaderLib.toon` + `SkyDome` + shadows + `CarveSprayVfx`. |

### UI & HUD (2 files)
| Test File | What It Guarantees |
| :--- | :--- |
| `src/ui/__tests__/uiFormatting.test.ts` | Pure HUD formatters, badge/skier/event descriptors, **static ban on `src/ui/` importing `three`, `/render/`, or non-contract `/sim/` modules**. |
| `src/ui/__tests__/gameUi.test.ts` | Zero per-frame DOM node creation, coalesced pickup chip, single-slot delivery ribbon, creature left/right edge beacons vs center ribbon, inline `FORK_ENTERED` pill pulse, stumble flash, `resetRunState()`, clean `dispose()`. |

---

## 3. Critical Coverage Blind Spots & Resolved Legacy Quirks

Know these BEFORE editing physics, terrain, or rendering so you neither break real invariants nor trust false green passes:

### Legacy Quirk Tests (Resolved in M3)
- *(Resolved in M3)* `src/sim/__tests__/physicsAndWorld.test.ts:8-38, 783-880` previously asserted the legacy `±80°` trail-tangent clamp and trail-tangent canyon stall pivot. Both were updated in M3 to assert continuous angular restoring torque (`<= 115°` with zero snap teleports) and convergence toward true local `surface.fallLine`.
- *(Note: `mountainField.test.ts` inner-turn chasm continuity was tightened from `normalY > 0.03` to `normalY >= 0.38` in M1.)*

### Coverage Status (All Milestones M1–M4 Complete)
- *(Resolved in M1)* Asymmetric fork V-wedge cliffs, 2D `w0 ≈ w1` continuity sweeps, `LayoutEngine` vs `MountainField` height parity, and `rebuildElevationSpines` S6 ordering are covered in `mountainField.test.ts` (`19/19`).
- *(Resolved in M2)* Snow-toon hybrid shader visuals, modulo-1024 rebase noise wrapping, texel-snapped `BasicShadowMap` caster/receiver policy, `SkyDome`, and `CarveSprayVfx` are covered in `graphicsTracker.test.ts` and `terrainAndRenderer.test.ts`.
- *(Resolved in M3)* Off-piste cliffs (`> 52°` off-grid & diagonal), `velY`/energy conservation, ramp wedges, slow crest detachment, solid 3D wipeout tumbles, and **`0 B` Jolt WASM memory leaks** are covered in `joltPhysics.test.ts` (`6/6`), and `soak50km.test.ts` enforces `maxAbsVelY < 40`, `maxUpwardVelY < 20`, and `maxSpeed3d < 48` alongside `safeX` autopilot stability.
- *(Resolved in M4)* 1-draw-call CDLOD `TerrainClipmap` (`0` cracked vertices / `0` T-junctions across steady-state & forced scroll lag), `ClipmapDataStore` (`fieldRevision`/`dirtyRects` invalidation, raw `gl.texSubImage3D` wrap splitting & zero-copy full-width uploads, `needsUpdate`-before-`initTexture`, `refinedRowMask`, `webglcontextrestored`, `< 1 cm` L0 parity), decoupled `32 m` `SceneryCellStreamer`, `terrain-cdlod-snow-toon-v3` GLSL expansion, and **`0` GPU leaks** are covered in `graphicsTracker.test.ts` (`6/6`) and `terrainAndRenderer.test.ts` (`9/9`).

---

## 4. Profiling & Runtime Debug Overlays

- **3D Debug Draw (`G` key or `Debug [G]` button):** Enables `DebugDrawBuffer` (`src/sim/debugDrawBuffer.ts`, zero-alloc flat typed arrays updated inside `SkiSimulation.step`) rendered by `DebugOverlay3D` (`src/render/three/debugOverlay.ts`):
  - Green polyline: `safeX(s)` (`10 m` step)
  - Wireframe cylinders: Amber = stumble hazard, Red = lethal hazard, Magenta = creature
  - Yellow ground rings: active Delivery Zones
  - Orange V-lines & rings: Model A fork nose + left/right 25 m targets
  - Cyan cross-lines: 35 m chunk boundaries
  - Skier vectors: Green = surface normal, Blue = downhill tangent, Yellow = velocity
- **Telemetry & Leak HUD (`P` key or `Stats [P]` button):** Samples `Profiler` (`frameMs`, `simMs`, `renderMs`, `streamMs`, `fps`), `ThreeRenderer.getStats()` (`drawCalls`, `triangles`, `activeChunks`/`queuedChunks`, `geometries`, `textures`, tracked objects/resources), `rebaseCount`, and `GraphicsTracker.checkLeaks(20, true, scene)` (runs every 20 s automatically in dev builds or while telemetry is visible, `src/main.ts:27, 277-291`).
