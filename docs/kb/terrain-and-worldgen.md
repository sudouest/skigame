---
title: Terrain Generation, Trail Topology & MountainField Heightfield
scope: TrailSpine, TrailSegment, TrailWindow (4-slot + horizon + horizon2 + ghosts), MountainField (Model 3), TerrainFieldView, MountainSurfaceSampler, precision & caching
tags: [terrain, worldgen, splines, trail-window, forks, mountain-field, heightfield, surface-sampler, model3]
source_files:
  - src/core/noise.ts
  - src/sim/trailSpine.ts
  - src/sim/trailSegment.ts
  - src/sim/trailWindow.ts
  - src/sim/mountainField.ts
  - src/sim/surfaceSampler.ts
  - src/sim/layoutEngine.ts
  - src/sim/contracts.ts
last_verified: 2026-11-25
---

# Terrain Generation, Trail Topology & `MountainField` (Model 3)

## 1. End-to-End Terrain Architecture

```text
TrailWindow (src/sim/trailWindow.ts)
 ├── 4 Active Gameplay Slots:  [prev] ─► [curr] ─┬─► [nextLeft]  (TrailSegment = TrailSpine + safeX + patches + landmarks)
 │                                               └─► [nextRight]
 ├── 4 Tier-1 Lookahead:       [horizonLL, horizonLR, horizonRL, horizonRR] (TrailSpine only, ~500-600m ahead)
 ├── 8 Tier-2 Lookahead:       [horizon2LLL .. horizon2RRR] (TrailSpine only, ~800-900m ahead; 8-rib umbrella fan)
 └── ≤44 Ghost History:        [ghostSpines] (TrailSpine only + unchosen horizon/horizon2, pruned > 960m AABB dist)
        │
        ▼ (rebuildElevationSpines() BEFORE onSegmentCreated; topology listeners notified)
MountainField (src/sim/mountainField.ts — Model 3, implements TerrainFieldView)
 ├── Pass 1: Inverse-Barrier Piste Stamp (interior-core lock + rational C^1/C^2 shoulder blend, K = 0.31)
 ├── Pass 2A: Dual-Order Inverse-Distance Macro Sheet (16m macroNodes + 224m open-leaf ext + far-field [130, 190]m)
 └── Pass 2B: Medial-Safe Curvature-Clamped Corridor Capsules (12m chains, (1-q)³ kernels) + C^2 Alpine Undulation + Outer Rim (110..200m)
        │
        ├──► MountainSurfaceSampler (src/sim/surfaceSampler.ts) ──► SkiPhysics, CameraRig, CreatureSystem, LayoutEngine
        └──► TerrainFieldView.sampleColumnGrid(...) / ClipmapDataStore + SceneryCellStreamer (src/render/three/) ──► 1-draw-call CDLOD terrain + scenery
```

---

## 2. `TrailSpine` (`src/sim/trailSpine.ts`)

Pure geometry and piste evaluator (zero gameplay entities), shared by active `TrailSegment`s, `horizonSpines`, `horizon2Spines`, and `ghostSpines`.

### Precomputed Tables (`Float64Array` positions for 50 km rebase precision)
- **Spine LUT (`SPINE_LUT_STEP_M = 1.0`, `:23, 304-314`):** Midpoint-integrated `(posX, posY, posZ, yawRad, pitchRad, bankRad, curvature, halfWidth, dividerHalfWidth)` every `1 m`.
- **Centerline Polyline (`POLYLINE_SPACING_M = 3.0`, `:22, 973-987`):** Derived directly from the 1 m LUT (zero trig) for fast `projectXZ` projection.
- **Macro Nodes (`MACRO_NODE_STEP_M = 16`, `MACRO_LEAF_EXTENSION_M = 224`, `:24-25, 1022-1157`):** Midpoint-spaced `16 m` nodes (`posX/Y/Z`, `fwdX/Y/Z`, `halfWidth`) **plus** straight tangent-projected open-leaf extensions `224 m` upstream (when `!hasUpstreamParent`) and downstream (controlled by `setHasDownstreamChildren(!hasChildren)`).
- **Corridor Side Chains (`CORRIDOR_NODE_STEP_M = 12`, `CORRIDOR_MAX_AMP_TO_RADIUS = 0.70`, `:26-27, 1159-1361`):** Left/right `12 m` capsule chains (`posX/Z`, `radius`, `invRadiusSq`, `kernelWeight`, `ampMag`) with medial-safe inner-turn clamping `dEff <= 0.70 * cos(pitch) / |k(s)|`, concave inner-turn amplitude attenuation (`normalY >= 0.38`), and bounded chasm far-rim nodes (`farAmp = 18`, `farR = 36`, faded on tight inner turns).
- **2D AABB (`:954-958`):** `boundsMin/MaxX/Z` padded by `maxHalfWidth + skirtWidth + 2`.

### Up-Locked Yaw-Pitch-Bank Frame & Model 3 Guardrails (G1 / G2 / G3)
Never uses Frenet-Serret (which flips 180° at S-curve inflections):
- `forward = (-cos(pitch)*sin(yaw), sin(pitch), -cos(pitch)*cos(yaw))`
- `R0 = (cos(yaw), 0, -sin(yaw))`, `U0 = (-sin(pitch)*sin(yaw), cos(pitch), -sin(pitch)*cos(yaw))`
- `bank = clamp(bankingFactor * k * 18.0, -0.28, 0.28)` smoothed via EMA (`:895-899`); `right = cos(bank)*R0 + sin(bank)*U0`.
- **Curvature & Downhill Cone (`evalCurvature`, `:699-832`):** Sums 3 Gaussian S-curve lobes + fork separation (`s < 72`), tapers to `k = 0, bank = 0` at `s = 0` and `s = length`, enforces the **broad downhill fall-line cone** (`|yaw| <= 60°`, fork seams `<= 48°`, `:39-48`), and strictly clamps `|k| <= SAFE_CURVATURE_RATIO (0.395) / max(1, hw + skirtWidth)` (`:31, 830-831`).
- **G1 (Delayed Fork Pitch Divergence, `:840-848`):** Child spines lock pitch to `startPitchRad` over `smootherstep(18, 72, s)` and apply neighbor `pitchBiasRad` strictly after `s > 18 m`, ensuring smooth V-wedge slopes.
- **G2 (Fork Divergence Floor & `avoidSpines` Repulsion, `:341-420, 620-687, 739-778, 871-880`):** Enforces a signed lateral divergence floor over `s >= 25`, deterministic `avoidSpines` lateral repulsion (AABB pre-filtered, cached entry side-sign, per-shell directional push caps, PD angular-rate damping, and 6 m-step EMA smoothing so `k(s)` and `bank(s)` stay $C^1$), paired with `TrailWindow`'s center-outward 8-rib umbrella fan (`T1 = 0, Twin = 0` overlaps).
- **G3 (Flattened `IslandDivider`, `:264-272`):** `maxHeight = 1.35 m`, `maxHalfWidth ∈ [3.0, 3.8] m` (keeping transverse divider slope `<= 42°`, `normalY >= 0.74`).

### Projection & Piste Height Methods
- **`projectXZ(wx, wz, out)` (`:1554-1713`):** Coarse scan (`COARSE_STRIDE = 8`, `24 m` chords) → fine segment check → 1 damped Newton step via direct LUT interpolation (zero trig churn) → outputs `{ s, signedX, longExt, distSq, spineX/Y/Z, forward*, right*, pitchRad, halfWidth, dividerHalfWidth }`.
- **`evaluatePisteHeight(s, x, out)` (`:1719-1745`):** Direct LUT interpolation used by `MountainField`. Returns `posY + x * rightY + computePisteCoreHeight(...)` (`:1800-1829`), which adds moguls (`mogulAmplitude * sin(0.31*s + phaseA) * cos(0.42*x + phaseB) * corridorFade * seamEnv`) and optional **Model B `IslandDivider`** (`maxHeight = 1.35 m`, cubic Hermite ridge with independent `leftLaneSurface` / `rightLaneSurface`). **Omits the legacy outer snowbank wall.**
- **`evaluateSurfaceAtX(s, x, out)` (`:1786-1865`):** Legacy helper calling `computeLocalHeight()` (`:1831-1865`), which adds the `3.6 m` outer snowbank wall for `|x| > hw`. No longer used by `LayoutEngine` (`layoutEngine.ts:413-450` now evaluates `MountainField.evaluate(wx, wz)` directly).

---

## 3. `TrailSegment` (`src/sim/trailSegment.ts`)

Composes a `TrailSpine` (adopting an existing `horizonSpine` with **0-delta geometry** via `config.existingSpine`) and adds gameplay metadata seeded deterministically via `new SeededRng(seed).fork('gameplay')` (`:160`):
- **`crestBrows` (`:163-165, 365-373`):** Convex pitch drop-offs; `isNearCrestPocket(s)` flags `[brow, brow + 26]` to keep lethal obstacles out of post-brow blind zones.
- **`patches` (`:168-195`):** Elliptical `ice` / `powder` patches every `~28 m` (`radiusS ∈ [7.5, 13.5]`, `radiusX ∈ [3.2, min(7.5, hw*0.55)]`), queried by `evaluatePisteSurface(s, x)` (`:415-440`).
- **`safeX(s)` (`:198-246, 442-451`):** `SAFE_PATH_STEP_M = 2.0` m LUT steering smoothly between 4 random target nodes (`|svx| <= 0.32`), routing cleanly around `IslandDivider`s (`|sx| >= divHw + 2.6`) and approaching fork branches smoothly.
- **Twin Split-Seam Fork Gates (`:249-283`):** When `hasFork`, emits two `forkArch` `SegmentLandmarkRequirement`s directly at `s = length` centered at `x = ±0.5 * endPose.halfWidth` with `FORK_RUNWAY_OBSTACLE_FREE_M = 50` (`:40`).

---

## 4. `TrailWindow` (`src/sim/trailWindow.ts`)

Manages the bounded world topology and exposes `elevationSpines` to `MountainField`:

- **4 Active Slots (`prev`, `curr`, `nextLeft`, `nextRight`):** At a fork (`ensureLookaheadBranches`, `:610-699`), `curr` widens toward `endHalfWidth = W_L + W_R` with `k = 0, bank = 0`, and child branches spawn flush at `endPose.pos ± (0.5 * endPose.halfWidth) * r0` with `startHalfWidth = 0.5 * endPose.halfWidth`, `INNER_WALL_RAMP_LENGTH_M = 25`, and `SEAM_NOSE_RADIUS_M = 1.5`.
- **Stage Fork Pairing:** Dynamically selects distinct left/right targets from `curr.stage.forkTargets` (preferring breather vs intense pairing when available) via `stageResolver`.
- **Tier-1 & Tier-2 Horizon Lookahead (`horizonSpines` + `horizon2Spines`, `:58-76, 610-998`):**
  - **Tier 1 (`horizonLL/LR/RL/RR`, 4 spines):** Math-only `TrailSpine`s 1 stage beyond `nextLeft`/`nextRight` (~500–600 m ahead) without firing `onSegmentCreated`.
  - **Tier 2 (`horizon2LLL..horizon2RRR`, 8 spines):** Math-only `TrailSpine`s 1 stage deeper (~800–900 m ahead), generated in a symmetric **center-outward 8-rib umbrella fan** (`LRR → RLL → LRL → RLR → LLR → RRL → LLL → RRR`, `:957-978`) with per-shell directional push caps.
  - On fork advance (`advanceFork`, `:522-607`), the chosen branch's Tier-1 spines promote with **0-delta geometry** into `nextLeft`/`nextRight` `TrailSegment`s, and its Tier-2 `horizon2` spines promote into `horizonLL..RR` (while unchosen `horizon` and `horizon2` spines move into `_ghostSpines`).
- **Ghost Spine History (`:23-24, 554-571, 1256-1315`):** Pruned `prev`, unchosen fork branches, and unchosen `horizon` + `horizon2` spines keep their lightweight `TrailSpine` in `_ghostSpines` (`MAX_GHOST_SPINES = 44`, `GHOST_SPINE_PRUNE_DISTANCE_M = 960 m`). Whenever pruning removes the last surviving child of a ghost spine, `pruneGhostSpines` restores `g.setHasDownstreamChildren(false)` (`:1292-1314`) so no ghost becomes a truncated uphill macro stub inside the 280 m fog radius.
- **S6 Ordering Fix (`reset`, `:204-211`; `advanceFork`, `:599-605`):** Always calls `rebuildElevationSpines()` and `notifyTopologyChanged()` **before** firing `onSegmentCreated`, so `LayoutEngine.bakeSegment` evaluates against the complete post-advance `MountainField` topology.
- **Progression & Pruning (`updateProgression`, `:395-505`):** Promotes `curr` once the skier crosses the fork seam plane (works on-piste and off-piste) and prunes the unchosen branch + old `prev` once `s >= DEFAULT_FORK_PRUNE_DISTANCE_M (40 m)` into the chosen child.

---

## 5. Unified Heightfield: `MountainField` (`src/sim/mountainField.ts`) & `TerrainFieldView` (`src/sim/contracts.ts`)

Evaluates continuous Model 3 `H(wx, wz)` in absolute noise coordinates `(absX = wx + originOffsetX, absZ = wz + originOffsetZ)` with zero hot-loop heap allocations.

### Key Constants (`mountainField.ts:33-59`)

| Constant | Value | Role |
| :--- | :--- | :--- |
| `PISTE_LONG_HANDOFF_M` | `14 m` | Longitudinal piste stamp fade past `s = 0` or `s = length` |
| `PISTE_AABB_PAD_M` / `blendW` | `64 m` / `14.5 m` | Pass 1 candidate AABB filter & lateral shoulder blend width |
| `MACRO_R0_SQ` / `MACRO_LOCAL_R0_SQ` | `8.5²` / `36²` | Dual-order inverse-distance macro sheet kernels |
| `MACRO_DOWN_EXT_R0_SQ` | `48²` | Soft-core kernel for open-leaf downstream extensions (`downExtClear`-masked) |
| `MACRO_WIN_IN_M` / `OUT_M` | `120 m` / `240 m` | Compact support window for near macro nodes |
| `MACRO_FAR_BLEND_START_M` / `END_M` | `130 m` / `190 m` | Relative-window far-field handoff over unclipped `allSpines` |
| `ALPINE_UNDULATION_AMP_M` / `FREQ` | `3.2 m` / `0.0085` | Subtle zero-mean $C^2$ off-piste `fbm2D` undulation (faded to 0 on piste) |
| `OUTER_RIM_START_M` / `END_M` | `110 m` / `200 m` | Flat-topped outer alpine valley walls (`+38..+52 m` via `smoothRidgedNoise2D`) |
| `NORMAL_SAMPLE_EPS_M` | `0.5 m` | Central finite-diff half-span (`1.0 m` total span) |
| `ROCK_SLOPE_NORMAL_Y_THRESHOLD` | `0.72` (~43.9°) | Off-piste `normalY < 0.72` classifies as `'rock'` |

### Evaluation Pipeline (`evaluateColumnCore`, `mountainField.ts:765-1850`)

1. **Pass 1 — Inverse-Barrier Piste Blending (`:786-932`):**
   - Filters spines by `PISTE_AABB_PAD_M = 64 m`, `|longExt| < 15 m`, and `|signedX| < hw + 14.5 + 1.0`.
   - Accumulates `coreW = (1 - smootherstep(0.25*hw, hw + blendW, |signedX|)) * longMask` and inverse-barrier weights `phi = pisteW / (1 - coreW + PISTE_BARRIER_EPS)` (`1e-6`), locking inner cores (`|x| <= 0.25*hw`) so overlapping foreign corridor edges never pull an active centerline.
   - Tracks decoupled `reliefW` (`reliefBlendW = clamp(sideSpec.transitionWidth * 0.72, 9.5, 11.0)`).
   - **Rational $C^1/C^2$ shoulder blend (`:1754-1760`):** `heightBlendW = (0.31 * totalPisteW) / (1 - 0.69 * totalPisteW)`. Both `onPiste = heightBlendW >= 0.5` and `pisteWeight = heightBlendW` use this consistent curve.
   - **Fast paths (`:313-330, 890-932`):** `evaluateHeight()` (`includeMetadata = false`) returns immediately on full piste; `evaluate()` (`skipMacroOnFullPiste = true`) skips Pass 2 on full piste (setting `macroY = nearestSpineY`) and uses `interiorSinglePisteSpine` for direct 4-point LUT central-difference normals (`:313-330`); `evaluateColumn()` and `sampleColumnGrid()` run Pass 2 for full blended `macroY` and multi-stage metadata.
2. **Pass 2A — Dual-Order Inverse-Distance Macro Sheet (`:934-1557`):**
   - Over coarse `16 m` `macroNodes` + `224 m` open-leaf extensions (with `downExtClear` masking on `useDownstreamExt` so ghost extensions never form floating pillars beside neighboring lower spines):
     - `wBlend = win / (smoothEdge² + 8.5²)` for linear inter-spine valley blending;
     - `wLocal = wBlend / (smoothEdge² + 36²)` for localized curved-spine elevation (`downExt` uses `1 / (rSq + 48²)`).
   - **Far-field handoff (`:1211-1555`):** Beyond `MACRO_FAR_BLEND_START_M = 130 m` (up to `190 m`), smoothly blends over `allSpines` (ignoring tile `candidateSpines` crop for zero tile-bounds disparity) using a relative window `[trueMinDist + 60, trueMinDist + 200]`.
3. **Pass 2B — Curvature-Clamped Corridor Capsules & Outer Rim (`:1559-1748`):**
   - Evaluates `corridorLeft`/`corridorRight` `(1 - q)³` polynomial kernels (zero `sqrt`/`exp`) modulated by `fbm2D` (`rollingHills`, `alpineBowl`) and $C^2$ `smoothRidgedNoise2D` (`canyonWalls`, `chasm`, `eps = 0.08` in `src/core/noise.ts:98-131`), scaled by cached cross-spine clearance `clearScaleCache` (`applyOtherSpineClearance`, `:723-763`, incrementally maintained on topology changes).
   - Smooth $C^\infty$ normalized opposing-relief blend bounds worst-case off-piste slope (`normalY >= 0.38`), multiplied by quadratic `reliefFade = reliefOffMask²` over `9.5–11.0 m` plus `ALPINE_UNDULATION_AMP_M` (`3.2 m`) and `evaluateOuterValleyRim` (`110..200 m`).
   - **Final Height (`:1760`):** `heightY = lerp(macroY, pisteTargetH, heightBlendW) + offPisteRelief`.

### Live `TerrainFieldView` & `sampleColumnGrid` Contract (`contracts.ts:520-627`, `mountainField.ts:128-301`)
- Tracks `originOffsetY`, monotonic `fieldRevision`, `dirtyRects` (`TerrainDirtyRect[]` + `ackDirtyRects?()`), and `stageIdTable` (`Uint8Array` stage ID interning).
- `sampleColumnGrid(originAbsX, originAbsZ, cols, rows, stepM, blockOriginY, out)` evaluates rebase-invariant column grids into unpacked, `LinearFilter`-safe `TerrainGridSampleOut` typed arrays: `heights`, `macroY`, `normals`, `pisteWeight`, `iceWeight`, `powderWeight`, `dividerMask`, `flowXZ`, `offPisteDist`, `primaryStageIdx`, `secondaryStageIdx`, `secondaryStageWeightU8`, and bitmask `flags` (`TERRAIN_FLAG_ON_PISTE`, `TERRAIN_FLAG_IN_DIVIDER`, `TERRAIN_FLAG_IN_CHASM`).

---

## 6. `MountainSurfaceSampler` (`src/sim/surfaceSampler.ts`) & `LayoutEngine` Parity

- **`MountainSurfaceSampler` (`:33-101`):** Zero-allocation bridge combining `TrailWindow.projectActiveWindow` (`segmentId, s, x, halfWidth, activeTrack.tangent`) with `MountainField.evaluate` (`groundY`, `macroY`, `normal`, `surfaceType`, `pisteWeight`, `inDivider`, `inChasmZone`, `chasmWipeoutDepth`, `chasmRelief`, `nearestSpineY`, `downhill`). Blends `out.tangent` from `activeTrack.tangent` toward `m.downhill` by `clamp(1 - m.pisteWeight, 0, 1)`.
- **Relative-Relief Chasm Wipeout (`skiSimulation.ts:533-541`):** Triggers `'chasm_fall'` when `surf.inChasmZone && surf.chasmWipeoutDepth > 0 && surf.macroY - curr.posY >= surf.chasmWipeoutDepth` (using blended `macroY` rather than `nearestSpineY`).
- **`LayoutEngine` Height Parity (`layoutEngine.ts:413-450`):** `samplePlacementSurface` queries `mountainField.evaluate(wx, wz)` directly across hazards, presents, ramps, creatures, delivery zones, and landmarks (with `evaluatePisteHeight` fallback if invoked standalone without `MountainField`), eliminating the legacy `3.6 m` snowbank drift.

---

## 7. Precision, Caching & Status Summary

- **50 km Precision:** `TrailSpine` tables use `Float64Array`; 32-bit `fx0 | 0` lattice hashing in `noise.ts:33-34` is safe past `absX/Z ~ 5e4` (`~7e-12 m` double precision); `TerrainFieldView` exposes `originOffsetY` and `sampleColumnGrid` outputs `Float32Array` heights relative to `blockOriginY` (`~1e-5 m`).
- **M1–M4 Resolution Status:** All heightfield discontinuity issues (T1–T5) and `LayoutEngine` / S6 ordering bugs (T7) were **RESOLVED** in M1 by Model 3 (`maxPop280 <= 0.000014 m`, tile-bounds parity `0.000e+0 m`, `LayoutEngine` parity `3.7e-4 m`, `minNormalY >= 0.38`), and renderer-side `fieldRevision`/`dirtyRects` cache invalidation + zero-skirt CDLOD rendering (T6) were **RESOLVED** in M4 by `ClipmapDataStore` + `TerrainClipmap` ([known-issues-and-evaluation.md](./known-issues-and-evaluation.md)).

---

## 8. Gotchas / Don't Break

- **Never omit `horizonSpines` or `ghostSpines` from `elevationSpines`:** Removing them causes visible macro elevation pops inside the 280 m fog radius (`mountainField.test.ts:97-152, 319-406`).
- **Keep `TrailSegment` gameplay RNG isolated via `.fork('gameplay')` (`trailSegment.ts:160`):** Ensures adopting a precomputed `horizonSpine` produces bit-identical geometry.
- **Keep `originOffsetX/Z` synchronized with `MountainField`:** Any rebase must call `mountainField.setOriginOffset()` immediately so noise coordinates never jump (`mountainField.test.ts:408-476`).
