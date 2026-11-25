---
title: Known Issues, Root-Cause Registry & 3D Physics Engine Evaluation
scope: Resolved root-cause registry for Issues #1–#3 (ski physics realism, terrain discontinuities/cliffs, CDLOD terrain resolution & visual fidelity) and 3D physics dependency assessment
tags: [known-issues, bugs, root-cause, resolved, physics, terrain, rendering, cdlod, evaluation, rapier, jolt]
source_files:
  - src/sim/skiPhysics.ts
  - src/sim/physics/worldContactSolver.ts
  - src/sim/physics/joltRuntime.ts
  - src/sim/physics/joltContactSolver.ts
  - src/sim/mountainField.ts
  - src/sim/trailSpine.ts
  - src/sim/layoutEngine.ts
  - src/render/three/clipmapDataStore.ts
  - src/render/three/terrainClipmap.ts
  - src/render/three/sceneryCellStreamer.ts
  - src/render/three/toonMaterials.ts
  - src/render/three/skyDome.ts
  - src/render/three/carveSprayVfx.ts
  - src/render/three/renderer.ts
last_verified: 2026-11-25
---

# Known Issues, Root-Cause Registry & Physics Dependency Evaluation

This document indexes the root causes discovered during the Wave 1 engineering audit (**Issues #1, #2, and #3 Phase 1 & Phase 2 — ALL RESOLVED across Milestones M1–M4**) plus the 3D physics library evaluation.

---

## 1. Issue #1 — Ski Physics Realism / "Skiing Up Walls" — RESOLVED (M3)

All five ski-physics realism and wall-climbing root causes (**P1–P5**) were **resolved in M3** via the two-layer True-3D Ski Physics stack: **Layer A `SkiDynamics`** (`src/sim/skiPhysics.ts`) paired with **Layer B quarantined Jolt Physics WASM** (`src/sim/physics/worldContactSolver.ts`, `joltRuntime.ts`, `joltContactSolver.ts`).

| # | Status | Root Cause | M3 Resolution |
| :--- | :--- | :--- | :--- |
| **P1** | **RESOLVED (M3)** | **2D `velXZ` persistence + `velY = slopeVelY` overwrite** | Replaced with true 3D orthonormal tangent-plane basis $(\hat{\mathbf{f}}, \hat{\mathbf{r}} \perp \hat{\mathbf{n}})$, exact 3D tangential gravity $(-g\hat{f}_y, -g\hat{r}_y)$, energy-conserving concave/landing velocity projection ($\|\mathbf{v}^+\| \le \|\mathbf{v}^-\|$), and `cliffImmediatelyAhead` crease guard (`skiPhysics.ts:409-546, 715-749`). Zero `velY = slopeVelY` overwrites remain. |
| **P2** | **RESOLVED (M3)** | **Trail-spine tangent used as local fall-line** | Added true local steepest-descent `SurfaceSample.fallLine{X,Y,Z}` (`-∇H` tangent projection, `surfaceSampler.ts:144-161`), replaced hard `±80°` trail-tangent snap clamp with continuous angular restoring torque (`smoothstep(80°, 115°)`) suppressed when aligned with safe off-piste `fallLine`, and updated stall pivot to align with `fallLineYaw` (`skiPhysics.ts:375-397, 549-556`). |
| **P3** | **RESOLVED (M3)** | **Unbounded ground-snap & airborne wall-stick** | Replaced manual height snap with Jolt `CharacterVirtual` (`mMaxSlopeAngle = 52°`), hard `52°` climbability gate (`COS_MAX_CLIMBABLE_SLOPE`), dt-invariant normal-away convex crest detachment toggling `StickToFloor` + `0.07 s` hysteresis, wall deflection + speed bleed + `13 / 20 m/s` `wall_scrape`/`wall_crash`, surface-split landing severity (`27/36 m/s` on-piste snow vs `16/24 m/s` rock/off-piste), and solid 3D wipeout tumble (`stepWipeout`). |
| **P4** | **RESOLVED (M3)** | **`'rock'` has the lowest drag in the game** | Set high rock friction/drag (`muK = 0.40`, `cAero = 0.012`, `cPlough = 0.20`, `carveEfficiency = 0`) with no off-piste skip (`skiPhysics.ts:1102-1110`), plus attenuated rock/steep-slope jump impulse (`computeJumpScale`). |
| **P5** | **RESOLVED (M3)** | **Non-physical boosts & ramp shortcuts** | Enforced energy-conserving carve redirection (`vFwd = sqrt(vFwd² + carveEfficiency * latEnergyRemoved)` gated on `fHatY <= 0.02`), zero-uphill poling start assist (`fHatY < 0.02`), rigid 3D `ConvexHullShape` ramp wedges with directional lip-launch gating (`vAlong >= 3.0`) and high-speed jump/lip saturation (`> 24 m/s`), and 3D `(velX, velY, velZ)` scaling in `triggerImpact`. |

---

## 2. Issue #2 — Terrain Discontinuities, Sheer Cliffs & High-Speed Air Launches — RESOLVED (M1)

All heightfield discontinuity, `LayoutEngine` snowbank parity, and S6 topology-ordering root causes (**T1–T5, T7**) were **resolved in M1** via the Model 3 Continuous Terrain Foundation (`smoothRidgedNoise2D`, G1/G2/G3 spine guardrails, `horizon2` Tier-2 lookahead + `MAX_GHOST_SPINES = 44` / `960 m` w/ `setHasDownstreamChildren(false)` restoration, inverse-barrier piste blending + dual-order macro sheet + curvature-clamped corridor capsules, `LayoutEngine` `mountainField.evaluate` parity, and `rebuildElevationSpines()` S6 ordering). Renderer-side cache invalidation & seamless CDLOD geometry (**T6**) were **resolved in M4**.

| # | Status | Root Cause | M1 Resolution |
| :--- | :--- | :--- | :--- |
| **T1** | **RESOLVED (M1)** | **50–62 m centerline cliffs on asymmetric stages & fork V-wedges** | Replaced centerline-flipping `sideBlend` with curvature-clamped `(1 - q)³` 2D corridor capsule chains (`corridorLeft`/`corridorRight`), quadratic `reliefFade`, and G1 delayed fork pitch (`smootherstep(18, 72, s)`). |
| **T2** | **RESOLVED (M1)** | **C0 vertical step from `dominantCandIdx` switching** | Replaced `dominantCandIdx`/`domLock` with smooth inverse-barrier partition-of-unity piste blending (`coreW` interior-core lock) and rational $C^1/C^2$ shoulder blend (`heightBlendW`, `K = 0.31`). |
| **T3** | **RESOLVED (M1)** | **Unsmoothed `evaluateSpineLandscape` & inner-turn curve caustics** | Eliminated unsmoothed `projectXZ` landscape projection; clamped corridor chains inside medial axis (`0.70 * cos(pitch)/|k(s)|`, `|A|/R <= 0.70` w/ concave attenuation) and switched to $C^2$ `smoothRidgedNoise2D` (`minNormalY >= 0.38`). |
| **T4** | **RESOLVED (M1)** | **`evaluateSmoothMacroSpineY` `deltaSq <= 0` flat plateau** | Replaced `evaluateSmoothMacroSpineY` with dual-order inverse-distance macro sheet over `16 m` `macroNodes` + `224 m` open-leaf tangent extensions and continuous `[130, 190] m` far-field handoff. |
| **T5** | **RESOLVED (M1)** | **Ghost-spine interference & `300 m`/`310 m` fallback mismatch** | Added 8-spine `horizon2` Tier-2 lookahead, bumped `MAX_GHOST_SPINES = 44` / `960 m`, kept unchosen `horizon2` in `_ghostSpines` w/ leaf restoration, added `downExtClear` + `applyOtherSpineClearance`, and evaluated far-field over unclipped `allSpines` (`maxPop280 <= 0.000014 m`, tile parity `0.000e+0 m`). |
| **T6** | **RESOLVED (M4)** | **Stale `TerrainStreamer` tile cache & shallow `4 m` inner skirts** | Legacy `terrainStreamer.ts`/`terrainTilePool.ts` removed in M4. `ClipmapDataStore` consumes `TerrainFieldView.fieldRevision`, `dirtyRects`, and `ackDirtyRects?()` (preserving un-booted layers on partial teleports) over zero-skirt CDLOD geomorphing (`TerrainClipmap`). |
| **T7** | **RESOLVED (M1)** | **Prop/landmark placement uses legacy `3.6 m` snowbank wall & S6 ordering** | `LayoutEngine.samplePlacementSurface` now queries `MountainField.evaluate(wx, wz)` directly (`3.7e-4 m` parity), and `TrailWindow` calls `rebuildElevationSpines()` before `onSegmentCreated`. |

> **ALL 3 ORIGINAL ISSUES RESOLVED (M1–M4):** Issue #2 terrain discontinuities resolved in M1; Issue #3 Phase 1 visual fidelity & contact parity resolved in M2; Issue #1 True-3D Ski Physics & Jolt WASM resolved in M3; Issue #3 Phase 2 & T6 (`0.5 m` 1-draw-call CDLOD Clipmap + `SceneryCellStreamer` + `fieldRevision`/`dirtyRects` invalidation) resolved in M4.

---

## 3. Issue #3 — Terrain Resolution, LOD Seams & Graphics Fidelity — RESOLVED (M2 + M4)

### Phase 1: Visual Fidelity & Contact Parity — RESOLVED (M2)
All Phase 1 visual readability, lighting, shadow, VFX, and grounded contact-parity items were **resolved in M2**:
- **Snow-Toon Hybrid Shader (`toonMaterials.ts`):** Upgraded `terrainMaterial` (originally `terrain-snow-toon-hybrid-v2`, carried forward into `terrain-cdlod-snow-toon-v3`) with chromatic `uShadowSnowTint` terminator, continuous sunlit slope gradient, crest Fresnel sky-rim via `uSkyTopColor`, CPU-baked Laplacian + chasm AO, rebase-invariant `NOISE_ORIGIN_MOD_PERIOD = 1024` corduroy/sastrugi/sparkle/ice specular/stratified granite cliffs, and analytical world-space granite normal perturbation (eliminating `dFdx × dFdy` triangle faceting).
- **Gradient Sky & Texel-Snapped Shadows (`skyDome.ts`, `renderer.ts`, `snowVfx.ts`):** Added camera-centered `SkyDome` (`fogColor` → `StagePalette.skyBottom` → `StagePalette.skyTop` + sun halo) and `THREE.BasicShadowMap` (`1024×1024` ortho follow-frustum snapped in light-space texel increments) with strict caster/receiver separation (terrain receives only; 3D skier/props/landmarks cast only; billboards/outlines/glows/VFX `castShadow = false`).
- **Carve Spray, Grooved Tracks & Contact Parity (`carveSprayVfx.ts`, `skiTracks.ts`, `skiPhysics.ts`, `skierRig.ts`, `contactShadows.ts`, `scenerySelector.ts`):** Added `384`-quad pooled `CarveSprayVfx`, `SkiTracks` tangent-plane `rightY` projection + recessed carved-groove shader, `SkierRig` cross-slope ski banking, `ContactShadows` (`MAX_SHADOWS = 512`, `0.32` skier alpha, `mountainField.evaluate` present normals), and `scenerySelector.ts` pine slope-sinking (`* 0.25`).

### Phase 2: CDLOD Geometry, Mesh Density & Cache Invalidation — RESOLVED (M4)
All Phase 2 geometry density, T-junction, sagitta, scenery-pop, and stale-cache items were **resolved in M4** (removing `terrainStreamer.ts` & `terrainTilePool.ts`):
- **`ClipmapDataStore` (`src/render/three/clipmapDataStore.ts`):** 5-layer toroidal `256 × 256 × 5` `DataArrayTexture` store (`5.00 MiB` VRAM, `R32F` `NearestFilter` heights + `RGBA8` `LinearFilter` normals/masks/`SRGB8_ALPHA8` sRGB albedo/flow+elev+CPU-baked Laplacian AO), global `clipmapAnchorAbsY` (`> 2048 m` re-anchor), `needsUpdate = true` before `renderer.initTexture(tex)`, raw `gl.texSubImage3D` zero-copy full-width row uploads (`MAX_SCROLL_STRIP_STEP = 1`, `REFINE_ROWS_PER_STEP = 1`, 256-bit `refinedRowMask`, full `UNPACK_*` resets), zero-upload fractional `WORLD_REBASED`, `fieldRevision`/`dirtyRects` invalidation, `< 1 cm` L0 parity (`48 × 48` cold-boot core), and instant `webglcontextrestored` CPU-mirror recovery.
- **`TerrainClipmap` (`src/render/three/terrainClipmap.ts`):** **1-draw-call `InstancedMesh`** (`16 × 16` base patch, capacity `512`, `0` skirts, `107,520` frustum-culled tris across `~210` patches), `0.5 m` near-field L0 (`16×` denser than legacy `2 m`), `camera.far = 750 m`, non-overlapping `CLIPMAP_LOD_RANGES_M = [24, 56, 116, 240, 640]` / `CLIPMAP_MORPH_STARTS_M = [16.8, 47.0, 102.0, 208.0, 640.0]` + top-down `effectiveRanges` sync confirming **0 cracked vertices (`dXZ < 1e-4, dY < 1e-4`) and 0 uncollapsed odd T-junctions**.
- **`terrain-cdlod-snow-toon-v3` (`toonMaterials.ts`) & `SceneryCellStreamer` (`sceneryCellStreamer.ts`):** Vertex `texelFetch` Strugar geomorphing + `objectNormal` reconstruction before `<defaultnormal_vertex>` + fragment morph-band blending, paired with deterministic `32 m × 32 m` scenery cells querying authoritative `TerrainFieldView` directly (**0 LOD-morph prop pops**).

---

## 4. 3D Physics Engine Dependency Evaluation Summary

Evaluated against `skigame`'s constraints (updated with Wave 4 live Node 24 benchmarks in `#29` & `#33`): strict headless `src/sim/`, synchronous `new SkiSimulation()`, Vitest Node `127k–180k`-tick `soak50km` (`< 20 s`), `128 m` floating-origin rebase, zero-alloc mobile `WKWebView`, and continuous terrain queries.

| Engine | Runtime / Measured Size | License | Determinism | Heightfield & Character Contact | Vite / Node / Rebase Fit | Memory / GC |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **Jolt Physics** (`jolt-physics@1.1.2/wasm`) | C++→WASM: **`2.93 MiB` raw / `862 KB` gz** (`1,980 KB` `.wasm` + `947 KB` `.js`); **`12.5–22.6 µs/tick`** (`~7.5–10.5 s` Vitest `soak50km`) | MIT | **`CROSS_PLATFORM_DETERMINISTIC=OFF`** in npm build (local-only; cross-arch x86↔ARM needs custom C++ build) | `HeightFieldShape::SetHeights` bound (`185.8 µs` full `64×64 @ 0.5 m`, `1.67 mm` max quantization error via patch-relative `[-128, +128]`); `CharacterVirtual::ExtendedUpdate` fires `StickToFloor` when `velY <= 1e-6` (still needs custom Layer A crest detachment) | Async `init()` once via Vitest `setupFiles`; **45-line DI `JoltRuntime`** handles global `Factory::sInstance` (zero `getInstance()`); `SetPosition` rebase (no `SetHeights` churn) | Fixed `128 MiB` linear memory is **VA reservation** (`~20–35 MiB` real dirty RSS); exact **`0 B` leak** verified w/ 15-line `DisposableScope` + `sGetFreeMemory()` CI gate; quarantine implicit C++ ownership traps in **1 adapter file** |
| **Rapier 3D** (`@dimforge/rapier3d-deterministic@0.21.0`) — **DISQUALIFIED** | Rust→WASM: **`~3.5 MiB` raw / `~1.22 MiB` gz** (`+38%` heavier than Jolt; `-compat` `4.27 MiB` / `1.62 MiB` gz); **`140–598 µs/tick`** (**`14×–26×` slower than Jolt → `30–90+ s` `soak50km`, fails `20 s` timeout!**) | Apache-2.0 | **Bit-exact IEEE 754** cross-platform out of box | `HeightFieldFlags.FIX_INTERNAL_EDGES` **works (`0` snags)** & fast `setShape` swaps (`73–100 µs`), *but* KCC + heightfield perf disqualifies it and `enableSnapToGround` still glues crests | Async `init()`, zero global singleton (`5×5` concurrent worlds verified) | `~30 MiB` RSS; manual `.free()` + scratch `target` discipline |
| **cannon-es** — **REJECTED** | Pure JS/TS (~30–40 KB min+gz) | MIT | Same-JS-engine only | `Heightfield` + static `Trimesh` | Sync ESM, zero config | Weak CCD/tunneling at `36 m/s`, slow & GC-heavy at 180k ticks |
| **Ammo.js / PhysX** — **REJECTED** | Heavy Emscripten WASM (~750 KB–1.2 MB+ gz) | zlib / BSD-3 | Ammo: non-deterministic; PhysX: build-local | `btHeightfieldTerrainShape` / `PxHeightField` | Heavy glue, async init, legacy (`ammo.js`) | Strict manual heap management |

### Evaluation Takeaway (Implemented in M3, Verified Post-M4)
- **Implemented Stack (M3 + M4):** **Jolt WASM (`jolt-physics@1.1.2/wasm`, `JoltContactSolver` + `JoltRuntime` + `SkiPhysics`)** is implemented and verified behind `WorldContactSolver` (`src/sim/physics/`). Final post-M4 verification: **`npm run typecheck` (`0` errors)**, **`npm run build` (`5.83 s`)**, **`npm run test:run` (`23/23` files, `112/112` tests, `18.15 s`)**, `joltPhysics.test.ts` `6/6` with exact **`0 B` `sGetFreeMemory()` leak**, `graphicsTracker.test.ts` `6/6` with **`0` GPU leaks**, `terrainAndRenderer.test.ts` `9/9` with **`0` CDLOD border cracks / T-junctions**, and `soak50km.test.ts` in **`~15.27–15.99 s` parallel** (`< 20 s` gate).
- **Disqualified / Rejected:** **Rapier 3D** (`140–598 µs/tick` fails `soak50km`'s `20 s` timeout by `1.5×–4.5×` and `+38%` bundle size), `ammo.js`, `physx-js-webidl`, and `cannon-es`.

---

## 5. Architectural Decisions Log

Finalized, red-teamed architectural synthesis for Issues #1, #2, and #3 — including Wave 4 live Node 24 Jolt/Rapier benchmarks, the Model 3 vs. Fixed Model 5 terrain audit, the locked De-Risked Synchronous Option 3A CDLOD renderer, all verified `three@0.181.0`/WebGL2 landmines, the empirical `soak50km` CPU breakdown (`CreatureSystem` `38.2%` hotspot), and the unified `TerrainFieldView` contract — is documented in **[architectural-decisions.md](./architectural-decisions.md)**.
