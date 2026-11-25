---
title: Battle-Tested Architectural Decisions & Red-Teamed Tradeoffs (Issues #1–#3)
scope: Converged architecture, red-team showstoppers, performance baselines, and unified Sim ↔ Render terrain contract
tags: [architecture, decisions, physics, jolt, rapier, terrain, model-5, rendering, cdlod, webgl2, threejs, contract]
source_files:
  - src/sim/skiPhysics.ts
  - src/sim/skiSimulation.ts
  - src/sim/creatureSystem.ts
  - src/sim/mountainField.ts
  - src/sim/trailSpine.ts
  - src/sim/trailWindow.ts
  - src/sim/layoutEngine.ts
  - src/sim/contracts.ts
  - src/content/types.ts
  - src/render/three/meshFactory.ts
  - src/render/three/terrainTilePool.ts
  - src/render/three/terrainStreamer.ts
  - src/render/three/toonMaterials.ts
  - src/render/three/renderer.ts
  - src/render/three/skiTracks.ts
  - src/render/three/contactShadows.ts
  - src/render/three/scenerySelector.ts
  - src/sim/__tests__/soak50km.test.ts
last_verified: 2026-11-25
---

# Architectural Decisions & Red-Teamed Tradeoffs (Issues #1–#3)

Synthesis of Wave 2 architecture proposals (`#16`, `#17`), Wave 3 antagonistic red-team audits (`#21`, `#22`, `#23`), and Wave 4 live Node 24 physics benchmarks & Model 5 terrain refinement/red-team audits (`#29`, `#30`, `#33`, `#34`), verified against the live codebase, `node_modules/three` (`0.181.0`), `jolt-physics@1.1.2`, `@dimforge/rapier3d-deterministic@0.21.0`, calculus checks, and empirical profiling of `soak50km.test.ts`.

## Recommended Staged Execution Order

1. **Stage 0 — Immediate Free Soak Headroom:** Gate `CreatureSystem.step` behind `distToPlayer <= 85 m` + single-sample reuse (`src/sim/creatureSystem.ts:104-158`) → cuts **`~4.5 s` (`~35%`)** off `soak50km.test.ts` immediately.
2. **Stage 1 — Continuous Terrain Foundation (Issue #2):** Land **Model 3** (lowest complexity, `0 MB` RAM, zero cache-invalidation risk) — or **Fixed Model 5** *only* with all 5 mandatory `#34` fixes (never `#30` as written) — plus `TrailWindow` `rebuildElevationSpines()` ordering fix, `LayoutEngine` height parity, `G1`/`G2`/`G3` spine guardrails (`IslandDivider <= 40°`), unified `TerrainFieldView` contract, and 2D continuity tests. *(Must land BEFORE physics substepping so terrain is fast and cliff-free.)*
3. **Stage 2 — Phase 1 Visual Fidelity (Issue #3, Zero Terrain Rewrite):** Ship snow-toon hybrid shader + rebase-invariant micro-detail, `SkyDome`, `CarveSprayVfx`, `SkiTracks` `rightY` fix + grooved ribbon, prop-only shadow map, and scenery/shadow parity fixes.
4. **Stage 3 — True-3D Ski Physics (Issue #1):** Build 100%-shared **Layer A (`SkiDynamics`, `~350–420 LOC`)** behind a `WorldContactSolver` interface (with all `#23` S1–S5 & M1–M4 fixes baked in), backed by **Jolt WASM (`JoltContactSolver`)** for lower long-term maintenance on 3D variety/solid wipeouts/projectiles OR **Revised Custom 3D (`CustomContactSolver`)** if obstacles stay strictly cylinders + 1 ramp and `0 KB` / cross-arch bit-determinism are hard gates.
5. **Stage 4 — Phase 2 High-Res Terrain Geometry (Issue #3 — LOCKED):** Ship **De-Risked Synchronous Option 3A** (1-draw-call Instanced CDLOD Clipmap) against the unified `TerrainFieldView` contract.

---

## 1. Issue #1 — Ski Physics Realism & 3D Engine Tradeoff

### Decision Boundary: Revised Custom 3D vs. Jolt WASM vs. Rapier 3D (Wave 4 Live Node 24 Benchmarks, `#29` & `#33`)

All options require **100% custom Layer A (`SkiDynamics`, `~350–420 LOC`)** — anisotropic edge carving, edge-bite saturation, `packed`/`powder`/`ice`/`rock` friction, snowplow braking, air control, ramp/jump tuning, landing severity, **and custom crest-detachment (`v·n_next > v_detach`) + `0.06–0.08 s` airborne hysteresis** (needed in Jolt and Rapier too!). Structure Layer A cleanly behind a **`WorldContactSolver` interface** so `JoltContactSolver` vs `CustomContactSolver` is swappable without rewriting ski feel.

| Engine / Solver | Status / Best Fit | Realistic LOC (A + B) | Bundle / Mobile RSS | `soak50km` (Vitest, `20 s` limit) | Determinism | Key Tradeoffs |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **Jolt Physics WASM** (`jolt-physics@1.1.2/wasm`, `JoltContactSolver`) | **Lower long-term maintenance** if *any* 3D shape variety (`fallen_log` OBB, `ogreThrower` projectiles, arches), solid wipeout tumbles, non-warped 3D ramps, or ragdolls are planned | **`~900–1,120`** (`350–420` A + `550–700` B) | **`2.93 MiB`** raw / **`862 KB`** gz; **`~20–35 MiB`** real dirty RSS (`128 MiB` is VA reservation) | **`~7.5–10.5 s`** (`12.5–22.6 µs/tick` — passes cleanly) | Local-only in npm (`CROSS_PLATFORM_DETERMINISTIC=OFF`; needs custom C++ build for x86↔ARM) | Exact **`0 B` leak** verified (`DisposableScope` + `sGetFreeMemory()` CI gate); 45-line DI `JoltRuntime` isolates `Factory::sInstance`; implicit C++ ownership traps must be quarantined in **ONE** adapter file. |
| **Revised Custom 3D** (Option 1A, `CustomContactSolver`) | Wins **ONLY** if obstacles stay permanently simple (**cylinders + 1 ramp archetype**, no solid wipeout-vs-obstacle / projectiles / overhead geometry) and **`0 KB` / cross-arch bit-determinism** are hard gates | **`~1,100–1,500`** (`350–420` A + **`750–1,100`** B — *NOT* `#29`'s `350–450`) | **`0 KB`** / **`0 MiB`** | **`~5.0–6.0 s`** | **Bit-exact `float64`** cross-arch | Unquantized `float64` queries, zero WASM lifecycle/Jetsam risk — but hits a nonlinear `N×M` sweep maintenance cliff (`~90–150+ hrs` Year-1 on modest growth vs Jolt's `~65–95 hrs`). *(Optional Option 1C-ii: lazy-load Jolt in render layer only for cosmetic wipeout ragdolls.)* |
| **Rapier 3D** (`@dimforge/rapier3d-deterministic@0.21.0`) | **EMPIRICALLY DISQUALIFIED** (`#33`) | `~750–940` | **`~3.5 MiB`** raw / **`~1.22 MiB`** gz (`+38%` heavier than Jolt; `-compat` `4.27 MiB` / `1.62 MiB` gz); `~30 MiB` RSS | **`~30–90+ s`** (`140–598 µs/tick` — **FAILS `20 s` timeout!**) | **Bit-exact IEEE 754** out of box | `HeightFieldFlags.FIX_INTERNAL_EDGES` **works (`0` snags)** & `setShape` is fast (`73–100 µs`), *but* KCC + heightfield is **`14×–26×` slower than Jolt**, bundle is heavier, and `enableSnapToGround` still glues crests. |

*(Still unanimously rejected: `cannon-es` — weak CCD/GC at `36 m/s`; `ammo.js` / `physx-js-webidl` — legacy/heavy/non-deterministic.)*

#### Verified Wave 4 Empirical Ground Truth (`#29` & `#33`)
- **Why Custom Layer B is `~750–1,100 LOC` (Not `350–450 LOC`) & Hits an Early Maintenance Cliff:** Today's *broken 2D* physics (`skiPhysics.ts` `509 LOC` + `skiSimulation.ts` `~110 LOC`) is already `620 LOC`. Even over smooth `<= 60°` terrain, hardened Custom Layer B must handle multi-probe curved-trough `ClipVelocity` near-parallel plane degeneracies, 3D capsule-vs-wedge ramp edge cases (airborne mid-ramp landings, sharp corners, backward hits), and solid multi-contact during `0.55–1.5 s` invuln / `1.2 s` wipeout tumbles. Crucially, **`DESIGN.md:450` and `src/content/types.ts:234, 266-276` already define `fallen_log` OBBs (`collider.shape: 'box'`) and `ogreThrower` projectiles**, and **`src/render/three/meshFactory.ts:253-289` renders flat rigid unbanked ramps while `skiPhysics.ts:503` models parabolic terrain-conforming offsets** — meaning Jolt's declarative shape advantage starts immediately on already-scoped content.
- **Jolt Physics WASM (`jolt-physics@1.1.2/wasm`) Verified Runtime Characteristics:**
  - **Rolling Heightfield (`HeightFieldShape::SetHeights`):** Bound in `JoltJS.idl:1225` (allocate via `Jolt._webidl_malloc` / `_webidl_free`, *not* `_malloc`/`_free`, followed by `NotifyShapeChanged`). Full `64×64 @ 0.5 m` (`31.5 m` bubble, recentered every `8 m`) updates in **`185.8 µs`** (`64×4` strip `22.4 µs`, `32×32` `47.6 µs`). Anchoring at `patchCenterY` with `mMinHeightValue = -128, mMaxHeightValue = +128` yields **`1.67 mm` max quantization error** (`<= 2.5 mm` on `33°` slopes) over 50 km with zero rebuilds; rebase via `SetPosition(..., EActivation_DontActivate)` (never `MoveKinematic`).
  - **Zero-Leak & Zero-Singleton Lifecycle:** `#29`'s `3,824 B` leak was a benchmark bug — a **15-line `DisposableScope` + `JoltInterface.prototype.sGetFreeMemory()` CI gate** verified **exact `0 B` leak** across 6 full create/simulate/destroy cycles and 15 `reset()` cycles. A **45-line DI-injected `JoltRuntime`** (passed via `SkiSimulationOptions`, zero `getInstance()` singletons → `architecture.test.ts` passes untouched) handles global `Factory::sInstance` / `UnregisterTypes()` by partitioning `ObjectLayerPairFilterTable` into isolated world slots.
  - **Real Traps That Stand:** (1) `CharacterVirtual::ExtendedUpdate` (`CharacterVirtual.cpp:1824-1830`) fires `StickToFloor` whenever `velY <= 1e-6` (every downhill tick!), so custom Layer A crest detachment + hysteresis must toggle `mStickToFloorStepDown`. (2) Implicit C++ ownership rules (e.g., `~JoltInterface()` deleting layer tables, `RefConst` shape ownership) crash with un-symbolicated `RuntimeError` traps on mistakes — **quarantine all raw Jolt calls inside ONE adapter file**. (3) `128 MiB` linear memory (`ALLOW_MEMORY_GROWTH=OFF`, `2048` pages) is VA reservation (`~20–35 MiB` real dirty RSS when tuned to `mMaxBodies=512–1024, mTempAllocatorSize=2 MiB`), though Emscripten dlmalloc never `madvise`s dirty pages back. (4) `CROSS_PLATFORM_DETERMINISTIC=OFF` in npm `1.1.2`.
- **Rapier 3D (`@dimforge/rapier3d-deterministic@0.21.0`) Live Disqualification:** Busts earlier diagonal-snag myths (`HeightFieldFlags.FIX_INTERNAL_EDGES = 1` achieved `0` bounces vs `17` / `+3.691 m/s` without flags on a `28 m/s` sphere and `0` snags / `0.00°` normal error on `36 m/s` KCC), *but* `64×64 @ 0.5 m` KCC runs **`319–598 µs/tick`** (`+48–58 µs` step) and `32×32 @ 1.0 m` runs **`140.5 µs/tick`** (`+40 µs` step) — **`14×–26×` slower than Jolt**, blowing `soak50km`'s `20 s` timeout (`30–90+ s`), while soft-body bloat expanded `0.21.0` to `~3.5 MiB` raw / `~1.22 MiB` gz (`+38%` heavier than Jolt).

### Red-Team Showstoppers in Initial Option 1A (`#23` S1–S5) & Mandatory Fixes

| ID | Showstopper Found | Mandatory Fix |
| :--- | :--- | :--- |
| **S1** | **Dimensional bug in forward wall probe:** Testing `(x_next + 0.45*dir)` against `|v_t|*dt*tan(52°) + 0.10` omitted the `0.45 m` probe offset, causing **false wall crashes on gentle `16°–29°` skiable slopes** and sticky `t* = 0` binary-search locks. | Budget rise over full `dist_prev_to_probe * tan(52°) + margin` (or signed plane clearance `(p_probe - p_surf)·n_probe`), plus lateral `±R*right` capsule flank probes. |
| **S2** | **Fixed `0.08 m` crest margin breaks under adaptive substeps:** `0.5*(κ*v² - g)*dt²` shrinks `16×` at `substeps = 4`, gluing skiers to `10°→48°` drops; naive physical unweighting flickers `grounded` on moguls/`IslandDivider`s, shredding `SkiTracks`, `SkierRig`, braking, and turn rate. | Use **dt-invariant normal-away velocity separation** (`v · n_next > v_detach ≈ 1.2–1.8 m/s`, or `n_y < 0.6157`) + **`0.06–0.08 s` airborne hysteresis** before breaking tracks, stance, and ground turn rate on `< 0.12 m` micro-hops. |
| **S3** | **On-piste `IslandDivider` violates `52°` wall gate:** `trailSpine.ts:217-218, 842-847` (`maxHeight = 2.4 m`, `maxHalfWidth = 2.4–3.4 m`) hits **`53.7°–58.3°`** (`n_y = 0.526–0.592 < 0.6157`) across real seeds, turning the center snow berm into an impassable crash wall. | Lower `IslandDivider.maxHeight` to `1.4–1.5 m` (or widen `maxHalfWidth >= 3.6 m`) so divider slopes stay `<= 40°` (`n_y >= 0.76`). |
| **S4** | **Landing thresholds (`22 / 30 m/s`) punish intended `icy-black` ramp jumps:** Jumping off 5 of 8 real `icy-black` ramps hits **`22.7–39.9 m/s`** (instant stumble/wipeout), while `11 m` drops onto flat rock pass at `22.0 m/s` unscathed; removing the `14 m/s` floor makes slow ramp exits feel like curbs. | Smoothly **saturate combined ramp-lip + jump impulse** at high speed (`v > 24 m/s`), preserve minimum ramp pop feel, and split landing tolerance by surface (`on-piste snow` `27/36 m/s` vs `rock/flat off-piste` `16/24 m/s`). |
| **S5** | **`soak50km.test.ts` 20 s timeout breach:** Real baseline is **`12.6–13.7 s`** in Vitest (`5.94 s` raw Node across `127,674` ticks — NOT `< 2 s`). Naive `1.43–2.0×` substepping + multi-probe sweeps adds `+6–9 s` → **`18.5–23.0 s` TIMEOUT**. | Land **Stage 0 (`CreatureSystem` sleep gate)** + **Stage 1 fast terrain** *strictly before* substepped physics. |

### Additional Mandatory Physics Fixes (`#23` M1–M4)
- **Continuous Steering Torque (Replaces Union Clamp Snaps):** Hard boolean `[trailYaw ± 80°] ∪ [fallLineYaw ± 60°]` caused **`75°–100°` single-frame heading teleports** on piste boundaries and forced skiers into chasms via `fallLineYaw` weathervaning. Use a continuous angular restoring torque (`smoothstep(80°, 115°, |Δyaw|)`) weighted off near safe local fall-line, and **disable weathervaning when `inChasmZone` or `|steerInput| > 0.2`**.
- **Scale `velY` in `SkiSimulation.triggerImpact` (`skiSimulation.ts:941-942`):** Currently scales only `velX`/`velZ`; under persistent 3D velocity, unscaled downward `velY` slams the skier into the slope on the tick after a stumble.
- **Wall-Impact & Friction Tuning:** Raise wall scrape/crash penalties from `8/14 m/s` to **`13/20 m/s`** (glancing `< 13 m/s` = physical deflect + speed bleed, gated by `invulnerableTimerSec`); lower snow Coulomb `μ_k` so `9°` `powder-bowl` carves don't dead-stop; gate/attenuate jumping on `rock` or `> 38°` walls (prevents `48°` bunny-hop climb exploit); latch ramp deck membership on clean entry; preserve coyote-time jump vertical base; unify terrain + hazard + relative-velocity bear + ramp sweeps inside the substep loop.

### Empirical `soak50km.test.ts` CPU Profile (`#23` Verified Baseline)
Measured on `127,674` ticks (`50.5 km`, `179` forks, `355` rebases; `~6.07 s` instrumented Node → `~12.6–13.7 s` Vitest):
1. **`CreatureSystem.step`: `38.2%`** (`~4.8 s` Vitest) — **#1 hotspot!** Attacking bears call `sampleSurface` **2×/tick** (`creatureSystem.ts:108, 141`) forever even 200 m behind the skier (`~277k` of `402k` total `sampleSurface` calls).
2. **`CameraRig.update`: `28.0%`** (`~3.5 s` Vitest) — `4` `evaluateHeight` calls/tick (`cameraRig.ts:152, 188, 198, 223`).
3. **`SkiPhysics.stepSkiing`: `23.9%`** (`~3.0 s` Vitest) — `1` `sampleSurface`/tick today.
4. **Non-`MountainField` overhead (`TrailWindow`, `LayoutEngine`, `SpatialGrid`, pools): `20.3%`** (`~2.6 s` Vitest).

---

## 2. Issue #2 — Continuous Terrain Geometry Architecture

### Why Rigid Constant-Slope Mountain-First (`19.5°` Sheet, `|δ| <= 8 m`) Failed Calculus (`#22` S1–S5)

| ID | Mathematical Failure |
| :--- | :--- |
| **S1 (Slope-Budget Impossibility)** | Holding `icy-black` (`24°–33°`, mean `28.5°`) on a `19.5°` sheet burns `0.189 m/m`, exhausting `|δ| <= 8 m` in **`48 m` (16% of a `300 m` run; `+49.8 m` deficit)** and flattening the remaining 84% to `19.5°`. Consecutive steep runs (`mountainField.test.ts:579-610`) accumulate a `481 m` deficit. |
| **S2 (Gentle Oblique Traverse Paradox)** | Lowering `19.5°` to `powder-bowl` (`9°–14°`) requires `±63°–70°` yaw (breaking `|yaw| <= 60°`) and induces a **`14°–20°` cross-slope** (`9–14.5 m` across `2*hw`), forcing either `55°–64°` rock bench-cut cliffs along beginner shoulders OR lateral gravity steeper than downhill gravity. |
| **S3 (Shoulder Cliffs)** | Quintic `smootherstep` peak derivative `1.875 / W_blend` over `W_blend = 8–10 m` with `|δ| = 8 m` creates **`56°–71°` cliffs (`ny = 0.32–0.54`)**, triggering Option 1A's own `52°` wall-crash gate on groomed piste edges. |
| **S4 (Inner-Turn Capsule Inversion)** | With `R_min = 36.7–57.8 m`, offsetting `chasm` (`d_off = 42.5 m`), `alpineBowl` (`57.5 m`), and `farWall` (`109.5 m`) inward places capsules at **negative radii `r = -4.6 m` to `-72.8 m`** past the center of curvature — intruding into the inner piste and creating **`74°–80°` cliffs**. |
| **S5 (Fork V-Wedge Burial & `> 75°` Cliffs)** | Fork branch separation at `s = 60 m` is only `52–60 m`, smaller than capsule reach (`67–145 m`), burying sibling pistes under `-34 m` chasms (`82.8°` causeways); opposing `ΔH_+ + ΔH_- + M` sums to **`76°–77°`**. Also `W_piste` `w_i²` weighting doubled overlap slopes to `79.9°` and pulled full pistes by `20%`, while `K_wide,200m` added `+5..+34 m` inside chasms. |

### Codebase Ordering Trap (`#22` S6 — CRITICAL!)
In `src/sim/trailWindow.ts:137, 165-167, 484-496`, both `reset()` and `updateProgression()` fire `onSegmentCreated` (which runs `LayoutEngine.bakeSegment`) **BEFORE** `this.rebuildElevationSpines()`. Any `LayoutEngine` fix that queries `MountainField.evaluate()` inside `onSegmentCreated` will hit `populateEmptyFallback()` (`+40 m` outer funnel) and bake initial props/landmarks 40 m in the sky unless **`rebuildElevationSpines()` is moved BEFORE `onSegmentCreated`**.

### Model 3 (Analytic Baseline): Hybrid Stage-Coherent Spine Elevation + Inverse-Barrier Macro Sheet + Medial-Safe Clamped Corridor Kernels

*(Proved viable because MVT slope between `9°` and `33°` fork children is only `17°–24°` once `s > 35 m`, `#22` U1. Total scope: **`~750–1,000 LOC`**, **`0 MB` tile pool RAM**, zero cache-invalidation or mixed-revision seam classes.)*

1. **Keep Authentic Per-Stage Pitch (`9°–33°`) with Geometric Guardrails (`G1`–`G3`):**
   - **Delayed Fork Pitch Divergence (`G1`):** Ramp child pitch from `startPitchRad` to stage target over `smootherstep(18, 72, s)` (synchronized with V-wedge opening) so cross-wedge slope stays `<= 21°` from `s = 0` to `320 m`.
   - **Sibling/Cousin Lateral Repulsion (`G2`):** Enforce horizontal clearance `>= hw_1 + hw_2 + 48–55 m` between sibling/cousin spines during deterministic integration so branches never reconverge or cross over 50 km.
   - **Flattened `IslandDivider` (`G3`):** Lower `maxHeight` from `2.4 m` → `1.25–1.5 m` and widen `maxHalfWidth >= 3.0–3.6 m` so combined slope stays `<= 40°–42°` (`n_y >= 0.74`).
2. **Inverse-Barrier Partition-of-Unity Macro Sheet (Deletes `dominantCandIdx` & `σ=85m` Gaussian Pull):**
   - Replace `dominantCandIdx` with smooth barrier weights `φ_i = w_i / (1 - w_i + ε)` on piste (with exact `w_i === 1` lock) and inverse-distance macro weights `W_i = 1 / (d_edge,i² + r_0²)` (`r_0 ≈ 16–18 m`, windowed past `180–320 m`) off-piste: full interior piste (`w_1 = 1`) has **0 m** foreign pull with **zero C0 switch**, while diverging forks interpolate linearly across the full valley gap.
   - Replace `C⁰` `ridgedNoise2D` (`src/core/noise.ts:113`) with **`C²` smooth ridge** `r_smooth(n) = (1 - sqrt(n² + ε²) + ε)²` (`ε = 0.08`) and add zero-mean `C²` world-space mountain undulation `U(X_abs, Z_abs)` faded out on piste via `(1 - W_piste)`.
3. **Medial-Safe Clamped Corridor Kernels & Bounded Wall Slopes:**
   - **No curve inversion:** Clamp capsule offsets to `min(d_off, 0.70 * cos(pitch) / |k(s)|)` AND prune/attenuate any capsule closer than `hw_other + R_cap + 6 m` to any spine centerline (eliminates inner-turn & V-wedge intrusion).
   - **Drop `farWall` capsules & `K_wide,200m`:** Use a flat-topped smooth valley rim `smootherstep(110, 200, d_smooth_corridor)` (strictly `0` inside `110 m`) and bounded `smoothstep` chasm far rims over `75..110 m`.
   - **Bound slopes (`<= 62°–64°`):** Combine opposing positive/negative off-piste relief via normalized signed blend `ΔH = (D_+ A_+ + D_- A_-) / max(1, D_+ + D_-)` with `|A| / R <= 0.85`.
4. **Relative-Relief Chasm Wipeout (`skiSimulation.ts:535-540`):** Trigger chasm wipeouts on **`inChasmZone && (macroY - posY) >= chasmWipeoutDepth`** (or `ΔH_chasm(p) < -chasmWipeoutDepth && !onPiste`) instead of raw `posY < nearestSpineY - 22` (immune to cross-slope elevation shifts).
5. **Rebase Synchronization:** Bump `GHOST_SPINE_PRUNE_DISTANCE_M` from `600 m` to **`>= 850–960 m`** (covers `L4` vistas without horizon pops) and propagate `originOffsetY` cleanly on rebase.

*(Alternative if a pure spine-independent Mountain-First `M(X,Z)` is ever mandated: use a **Variable-Slope Banded Macro Mountain** spanning `10°–30°` benches/headwalls, have `TrailWindow` pick fork stages matching actual flank slopes ahead, and widen `W_blend` to `18–22 m`.)*

### Model 5 (`2 m` 2D-Relaxed Macro Grid) Refinement & Red-Team Audit (`#30`, `#34`)

`#30` proposed a 2-scale `64 m × 64 m` (`2 m` cell, `35×35` stored knots = `29.4 KB/tile`) path-stamped macro grid with a shrinking-pyramid `K = 12` 9-point Mehrstellen + `54°` thermal-erosion PDE on a `G = 59` padded grid (`0.0` ULP tile-seam bit-identity), 16-tap cubic B-spline + analytical fine piste/micro-relief (`~121–250 ns` queries, `0 ms` rebase). **Live Node V8 simulation against real `TrailWindow` seeds (`123` spines / `17,916` quads, `179` segment advances) in `#34` proved `#30` is NOT shippable as written:**

| ID | Verified Failure in `#30` As Written (`#34`) | Root Mechanism & Measured Impact |
| :--- | :--- | :--- |
| **S1** | **`+23–24 m` inner-turn chasm pillars & `-21 m` canyon sinkholes** | Fading `a_{k,σ}` to `0` across `[0.78·d_reach, d_reach]` opens a `31.6 m`-diameter `0 m` disk at the center of curvature (`80.5°–84.2°` raw cliff). After `K = 12`: **`+23.4–24.2 m` mesas** inside `icy-black`/`blizzard-ridge` chasms (`62.1°–63.2°`), **`-17.8 to -21.1 m` canyon sinkholes**, and a `16 m`-diameter `inChasmZone = false` safe island. **Mathematically unfixable by increasing `K`**: `54°` thermal erosion halts once cone slope hits `54°` (`15.8·tan 54° = 21.75 m`; even `K = 48` leaves `+19–21.5 m`). |
| **S2** | **`cos(pitch)` bowtie quads, `4.62%` concave quads (`22.4%` dropped cells), `68.9°` inflection cliffs** | True XZ curvature radius is `R_xz = cos(pitch)/|k|`; on `33°` `icy-black`, **`cos 33° = 0.8387 < 0.85`** produces **`6` self-intersecting bowtie quads** (`100%` dropped cells). Rapid `|dd_reach/ds|` (up to `20.21 m/m` near S-curve inflections) turns **`4.62%` (`827/17,916`) of real quads concave**, dropping **`22.4%` (`6,140/27,391`)** of polygon cells into `0 m` notches and creating **`68.9°` (`n_y = 0.360`)** transverse cliffs (plus `14 m` outer fan-out and fork `±28 m` extension misalignment). |
| **S3** | **`142–167`-tile invalidation storms (`115–300 ms` freezes) & `2.5–155 m` horizon pops** | New `horizonSpines` spawn `375–466 m` ahead; expanding by `R_inf = 352 m` (`320 + 32 m` coarse apron — `4 m` larger than `#30`'s `348 m`, `U2`) reaches back to `27 m` from the skier, dirtying **`142–167` tiles (`~45%` of the 384-tile pool)** every `~7–8 s` → **`115–300 ms` desktop (`500+ ms` mobile) freeze** OR `2.4–2.8 s` of mixed-revision C0 tile seams if throttled to `<= 1` tile/f. `Y_sheet` pops **`2.5–2.6 m` at `220 m`** (inside `280 m` sunny fog), **`26–155 m` at `460–540 m`**, and **`-15.9 m`** behind `s = 0` on advance #1 when the root tail drops. |
| **M1** | **`83–135 mm` (`7.2°`) banked-piste `clamp` crease** | Hard `clamp(signedX, -hw, hw) * rightY` creates a `C^0` slope corner at `|x| = hw`; cubic B-spline rounds it by **`83–135 mm`** (`12×–20×` `#30`'s `6.7 mm` claim) with **`6.5°–7.2°` edge slope error**. |
| **M2** | **`800×` `mountainField.test.ts:961` fail & missing metadata** | Barrier `φ_k = w_k/(1-w_k+1e-3)` leaks **`-39.88 mm`** on `deepForeignSpine` vs `0.05 mm` test tolerance (`800×` fail). `MacroTile` omits `nearestSegmentId`/`nearestSpineY`/`nearestS`/`nearestSignedX`/`nearestHalfWidth` required off-piste. |
| **M3** | **`39.9°–43.9°` bilinear `pisteMask` normal jump & channel bugs** | `C^0` bilinear `pisteMask` feeding `offMask * ΔH_micro` jumps `∇pisteMask` across `2 m` grid lines → **`39.9°–43.9°` shoulder normal discontinuity/bias**. Bilinear `chasmWipeoutDepth` causes premature `-3 m` wipeouts; discrete 3-stage indices pixelate `2 m` blocks inside `0.5 m` `L0` CDLOD. *(Also `U1`: `aoCavity` ping-pong knot `0`/`34` differs by `5` U8 levels; `U2`: `Int8` `flowXZ` needs post-bilinear normalization.)* |
| **M4** | **Realistic `1.8–2.1 ms/tile` 12-spine bake (`2.2–2.6×` `#30`'s `0.81 ms`)** | Substep 2A alone takes `0.834 ms` with 12 realistic active spines (`288` nodes × `289` coarse cells); `soak50km` inflates to **`2,705` bakes** (`+812` dirty-rect rebakes) = **`~9.9–12.6 s` Vitest** without Stage 0 (vs `#30`'s `5.9–6.6 s`). |

- **Complexity Reality Check:** `#30` had to build **~80% of Model 3** (`G1`–`G3` guardrails, absolute `Float64` LUTs, barrier partition-of-unity, inverse-distance `1/(r²+r_0²)^{3/2}` macro sheet, `twEff` slope-budgeted archetypes, `M_clear` masking, `C^2` smooth ridge, normalized `numDH/max(1,denDH)`) *plus* **`~1,000+ LOC`** of `384`-slot intrusive-LRU `MacroTilePool`, `330 KB` pooled scratch, `dirtyRect` invalidation, coarse subgrid, polyline/quad rasterizers, and shrinking-pyramid PDE solver — totaling **`~1,800–2,400 LOC`** vs. **Model 3's `~750–1,000 LOC`**, **`0 MB` RAM**, and **zero** cache-invalidation or tile-seam bug classes.

#### Terrain Verdict: Model 3 vs. Fixed Model 5
- **Choose Model 3 (`#22` §4 + Stage 0 `CreatureSystem` sleep gate)** if **long-term maintainability & zero cache-coherence complexity** matter most (`~750–1,000 LOC`, `0 MB` tile pool, `0` invalidation storms, `0` mixed-revision seams, `~1.5 ms/frame` sync CDLOD — optionally caching *only* a tiny `8 m` coarse `Y_sheet` grid if ever needed).
- **Choose Fixed Model 5** (**NEVER `#30` as written**) *only* if you specifically want the **thermal-erosion hard safety net (`<= 60°` guaranteed regardless of future content tweaks)** AND ultra-cheap `~250 ns` queries for both `0.5 m` CDLOD and a Jolt rolling heightfield — gated on **all 5 mandatory fixes**:
  1. **Kill the Quad Rasterizer & Inner-Turn Fade (`S1` & `S2`):** Drop Substep 2C's `4 m` convex quads + `d_reach` fade-to-0; replace with either **true signed-distance side-band evaluation** inside `d_reach_xz = 0.78 * cos(pitch) / |k|` **without** fading `a_{k,σ}` to `0` (clamping `u` smoothly at `R_xz - hw` and filling the inner center-of-curvature disk with constant full-depth `u_cap`) **OR** stamping **Model 3's medial-safe clamped capsules** onto the `2 m` grid.
  2. **Shrink `R_macro` to `180–200 m` + Add `horizon2` Lookahead Tier (`S3` & `M4`):** Cuts `R_inf` to `~212–232 m` (`~2.5×` faster Substep 2A and keeps `466 m` horizons out of `L0..L2`), adds 1 deeper math-only lookahead tier (`horizon2`, 8 lightweight `TrailSpine`s at `~720–950 m`, `~160 KB`), and keeps open-leaf tails **permanently on any childless spine** (including ghosts and root `id === 1`) → `0` tiles invalidated in `L0..L3`, `< 10` in far `L4` behind fog, `0.0 m` visible pop.
  3. **Hermite Bank Taper (`M1`):** Taper `bankRightY` smoothly to `0` across `|x| ∈ [hw, hw + 4]` via cubic Hermite `x_eff` (`C^1` continuous at `|x| = hw`) instead of hard `clamp(signedX, -hw, hw)` → B-spline residual drops from `135 mm` to `< 5 mm`.
  4. **Exact `w_k === 1` Lock & Off-Piste Metadata (`M2`):** Lock `H_pin` exclusively to `w_k === 1` spines whenever any spine has `w_k === 1.0` (or `eps = 1e-7`) → passes `mountainField.test.ts:961` to `< 0.004 mm`; store `nearestSegmentId` and `nearestSpineY` (or `macroY` where tests allow) for off-piste `MountainColumnOut` parity.
  5. **Smooth `offMask` + Max-of-4 `chasmWipeoutDepth` + 5-Stage Weights (`M3`, `U1`, `U2`):** Sample `pisteMask` with the 16-tap B-spline (or compute `offMask` analytically from `tile.pisteSpines`), use **max-of-4-corners** (never bilinear) for `chasmWipeoutDepth`, store continuous per-stage `Uint8` weights (`5` stages = `+3.7 KB/tile`), compute `aoCavity` strictly on `[1..33]` (or expand `G = 61`), and re-normalize bilinear `flowXZ`.

---

## 3. Issue #3 — High-Res Terrain & Graphics Fidelity

### Phase 1 Immediate Visual Wins (Locked — Ship First, Zero Terrain Rewrite)
- **Stylized Alpine Snow-Toon Hybrid Shader (`toonMaterials.ts`):** Chromatic soft-knee terminator tinted toward `StagePalette.shadowSnowTint`, sunlit shading gradient + crest Fresnel sheen, rebase-invariant world-space micro-detail (`p = vWorldXZ + mod(originOffsetXZ, 1024.0)` in `float64`) for flow-aligned corduroy (`18–55 m` fade), off-piste sastrugi, snow sparkle, glossy specular ice patches, stratified granite cliffs (replacing low-poly `dFdx × dFdy`), and fixing the `toonMaterials.ts:103` LOD rock-mask crease.
- **Atmosphere & VFX:** Gradient `SkyDome` finally using `StagePalette.skyTop` + sun halo; pooled `CarveSprayVfx` (`384` quads, rebase-safe); `SkiTracks` **`rightY` cross-slope projection fix (`src/sim/skiPhysics.ts:386-388`)** + recessed carved groove shader.
- **Entity Parity & Safe Shadows:** `LayoutEngine` height bake fix (after `TrailWindow` `S6` fix); present `ContactShadows` terrain normals (`contactShadows.ts:241-243`); `SkierRig` cross-slope banking; `scenerySelector.ts` pine slope-sinking; small `512²–1024²` texel-snapped directional shadow map for **skier + 3D props + landmarks ONLY** using `BasicShadowMap` (1 tap) or custom 4-tap PCF (keep `StaticSceneryBillboardPool` off `castShadow`, replace terrain self-shadows with CPU-baked ridge/canyon AO).

### Verified `three@0.181.0` & Mobile WebGL2 Landmines (`#21` S1–S5)

| Landmine | Verified Source (`node_modules/three` `0.181.0`) | Failure & Safe Rule |
| :--- | :--- | :--- |
| **`initTexture` `version === 0` No-Op** | `three.module.js:10877, 18441, 11458`; `three.core.js:7230` | `new DataArrayTexture()` starts at `version = 0`; `initTexture()` skips allocation and `addLayerUpdate(L)` no-ops unless `needsUpdate = true` is set first → `GL_INVALID_OPERATION`. |
| **`copyTextureToTexture` FBO Poisoning & Driver Stalls** | `three.module.js:18253-18257, 18294` | If a CPU strip `DataTexture` is ever bound/tracked as a GPU texture, `properties.has(src)` permanently flips to GPU FBO copy → `GL_INVALID_FRAMEBUFFER_OPERATION` on `R32F`. Also runs 5 `gl.getParameter()` calls per invocation (80–200/frame on wrap splits). **Use raw `gl.texSubImage3D` directly.** |
| **`customDepthMaterial` 3-Way Break** | `three.module.js:478, 562, 8596, 8603, 8884`; `three.core.js:40388`; `renderer.ts:161` | (1) `WebGLShadowMap` unconditionally overwrites `customDepthMaterial.side = BackSide` unless `material.shadowSide = FrontSide` (open heightfields cast 0 shadows!). (2) `shadowNormalBias` uses flat `(0,1,0)` base normal before `<begin_vertex>`. (3) Sun at `(35,65,40)` is behind-right of camera → frustum-culled terrain pops shadows in/out; `MeshDepthMaterial` defaults to `BasicDepthPacking`, not `RGBADepthPacking`. **Drop terrain self-shadow depth pass; use CPU-baked AO.** |
| **`PCFShadowMap` 17-Tap Mobile Bomb** | `three.module.js:474` | `THREE.PCFShadowMap` executes **17 RGBA-unpack fetches/pixel** (*more* than `PCFSoftShadowMap`'s 16!). Combined with array taps + AO + MSAA, mobile GPU hits `12–22 ms` (`< 45 FPS`). **Use `BasicShadowMap` (1 tap) or custom 4-tap PCF on mobile.** |
| **CDLOD `lodRange` Wrap Overflow & Cross-Layer Skew** | `#17:54-60, 68, 80, 85` | On `T = 256` (`64 m` half-span, `~48–52 m` safe committed radius), `lodRange[0] = 44 m` + `22.6 m` parent diagonal = **`66.6 m > 64 m`** → wraps modulo `256` into `60 m` cliff spikes (`T = 128` is mathematically impossible with `16×16` patches). Safe `lodRange[0] <= 28 m` (parent-atomic) or `<= 36 m` (partial sub-quads), using exact `distXZ`. Async per-layer `fieldRevision` or per-layer `ringAnchorAbsY[L]` tears `L ↔ L+1` seams. Also `uAlbedoTex` (`SRGBColorSpace`) double-decodes linear bytes unless explicitly `linearToSRGB`-encoded. |

### Phase 2 Terrain Geometry — Locked Choice: De-Risked Synchronous Option 3A

**LOCKED RENDERING CHOICE:** **De-Risked Synchronous Option 3A** (1-draw-call Instanced CDLOD Clipmap) paired with **Phase 1 snow/lighting/VFX**.

| Option | Status | Strengths | Mandatory Hardening / Notes |
| :--- | :--- | :--- | :--- |
| **De-Risked Synchronous Option 3A** (`1`-draw-call Instanced CDLOD Clipmap + `R32F` `NearestFilter`/`texelFetch` + `RGBA8` `LinearFilter` `DataArrayTexture`s) | **LOCKED** | **`1` draw call**, `16×` near-field density (`0.5 m` `L0`), continuous geomorphing (zero pops), per-texel bilinear masks, `~1 km+` vista, `0` WebGL2 float-filter extensions. | **Drop Web Worker initially** (sync main-thread strip fill `< 1–1.5 ms` over Stage 1 field eliminates Worker skew/bundling); use **raw `gl.texSubImage3D`** + `needsUpdate = true` before `initTexture()`; use **one global `clipmapAnchorAbsY`**; clamp `lodRange[0] <= 28–36 m` (`T = 256`); provide analytic normals from Stage 1 field (avoids 3× finite-diff cost on `L1..L4`); encode `uAlbedoTex` as sRGB; handle `L ↔ L+1` normal seams; replace terrain self-shadow pass with CPU-baked AO; update `terrainAndRenderer.test.ts` tile tests. |
| **Option 3C-Lite** (4-tier stitched `TerrainTilePool`, `16m@0.5m`..`128m@4m`) | *Not Selected (Fallback)* | Zero VTF/toroidal/WebGL2 traps, preserves `TerrainStreamer` & existing tile tests. | ~50–60 draw calls, discrete outer interior vertex LOD pops, vertex-interpolated outer masks. |

> **Unanimous Rejection:** **Option 3B (Pure GPU GLSL Heightfield)** is rejected (untestable JS↔GLSL physics parity drift, `16 KB` UBO ceiling, `20–60 ms` mobile ALU burn), and **SkiPhysics MUST NEVER read an async GPU clipmap cache** (keep deterministic TS `TerrainField` as the sole SSOT).

---

## 4. Unified Sim ↔ Render Terrain Contract (`TerrainFieldView`)

Reconciles all 10 mismatches between `#16` and `#17` (pure headless TS in `src/sim/contracts.ts`, zero Three.js/DOM, zero hot-loop allocs):

```typescript
export interface TerrainDirtyRect {
  readonly minAbsX: number;
  readonly maxAbsX: number;
  readonly minAbsZ: number;
  readonly maxAbsZ: number;
}

/**
 * Unpacked, LinearFilter-safe continuous arrays for GPU textures + CPU scenery.
 * NEVER bit-pack discrete IDs/flags into hardware LinearFilter texture channels!
 */
export interface TerrainGridSampleOut {
  readonly heights: Float32Array;             // [cols * rows] absHeightY - blockOriginY (R32F; <0.12mm ULP at 50km)
  readonly macroY: Float32Array;              // [cols * rows] absMacroY - blockOriginY (strata & chasm mist)
  readonly normals: Float32Array;             // [cols * rows * 3] canonical ~1.0m or analytic unit normals [nx, ny, nz]
  readonly pisteWeight: Float32Array;         // [cols * rows] [0, 1] continuous groomed piste mask
  readonly iceWeight: Float32Array;           // [cols * rows] [0, 1] continuous ice patch weight
  readonly powderWeight: Float32Array;        // [cols * rows] [0, 1] continuous powder weight
  readonly dividerMask: Float32Array;         // [cols * rows] [0, 1] continuous island-divider mask
  readonly flowXZ: Float32Array;              // [cols * rows * 2] unit downhill/grooming flow [tx, tz] for corduroy
  readonly offPisteDist: Float32Array;        // [cols * rows] lateral distance beyond halfWidth (for scenery)
  readonly primaryStageIdx: Uint8Array;       // [cols * rows] index into stageIdTable
  readonly secondaryStageIdx: Uint8Array;     // [cols * rows] secondary blended stage index
  readonly secondaryStageWeightU8: Uint8Array;// [cols * rows] 0..255 blend weight
  readonly flags: Uint8Array;                 // [cols * rows] CPU-only bitflags: bit0=onPiste, bit1=inDivider, bit2=inChasm
}

export interface TerrainFieldView {
  readonly worldSeed: number;
  readonly originOffsetX: number;
  readonly originOffsetY: number;             // NEW: required for rebase-invariant absY = heightY + originOffsetY
  readonly originOffsetZ: number;
  readonly fieldRevision: number;             // Monotonic bump on horizon spawn, ghost prune, or reset
  readonly dirtyRects: readonly TerrainDirtyRect[]; // Accumulated dirty bounds since last consumer ack/revision
  readonly stageIdTable: readonly string[];

  evaluateHeight(wx: number, wz: number): number;
  evaluateSample(wx: number, wz: number, out: MountainSampleOut): MountainSampleOut;

  // Vectorized strip/block evaluator (feeds 3C-Lite tiles, 3A clipmaps, or future Jolt SetHeights)
  sampleColumnGrid(
    originAbsX: number,
    originAbsZ: number,
    cols: number,
    rows: number,
    stepM: number,
    blockOriginY: number,                     // Global clipmapAnchorAbsY or tile originY (prevents rebase races!)
    out: TerrainGridSampleOut,
  ): void;

  // Optional structured-cloneable flat TypedArray descriptor if Web Workers are later enabled
  exportSnapshot?(out?: TerrainFieldSnapshot): TerrainFieldSnapshot;
}
```

### Contract Invariants
1. **Rebase Immunity:** `sampleColumnGrid` accepts integer-snapped absolute `(originAbsX, originAbsZ)` and an explicit `float64` `blockOriginY` (eliminating fractional `WORLD_REBASED` drift and stale-`originOffsetY` Worker races).
2. **Horizon & Ghost Invalidation:** Pair `fieldRevision` + `dirtyRects` with `GHOST_SPINE_PRUNE_DISTANCE_M >= 850 m` so neither newly spawned `horizonSpines` (`~460–750 m`) nor pruned `ghostSpines` can pop inside a `704 m` vista.
3. **GraphicsTracker Compliance:** Any GPU `DataArrayTexture`s must be marked `gfx.markAsCache(...)` and registered in `material.userData.trackedTextures` (`src/render/three/graphicsTracker.ts:137`); raw CPU scratch buffers uploaded via `gl.texSubImage3D` must NOT be registered as GPU `THREE.Texture`s.
