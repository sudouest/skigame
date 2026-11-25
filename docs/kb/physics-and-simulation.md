---
title: Physics, Simulation, Camera, Creatures & Layout Engine
scope: SkiSimulation, SkiPhysics, CameraRig, CreatureSystem, LayoutEngine, PacingDirector, EntityPools, coordinate conventions
tags: [physics, simulation, ski-physics, camera, creatures, layout, pacing, collisions, pools]
source_files:
  - src/sim/contracts.ts
  - src/sim/skiSimulation.ts
  - src/sim/skiPhysics.ts
  - src/sim/cameraRig.ts
  - src/sim/creatureSystem.ts
  - src/sim/layoutEngine.ts
  - src/sim/entityPools.ts
  - src/sim/surfaceSampler.ts
  - src/sim/physics/worldContactSolver.ts
  - src/sim/physics/joltRuntime.ts
  - src/sim/physics/joltContactSolver.ts
last_verified: 2026-11-25
---

# Physics, Simulation, Camera, Creatures & Layout Engine

## 1. Coordinate & Angle Conventions (`src/sim/contracts.ts:10-20`)

- **World Space `(X, Y, Z)`:** Right-handed, `+Y` up. Authoritative state for all entities, camera, and collisions (1:1 with Three.js).
- **Heading / Yaw (`yawRad`, `headingRad`):** `0` faces `-Z`; positive `+yaw` rotates **CCW around `+Y`** (matches `THREE.Object3D.rotation.y`):
  - `forwardXZ = (-sin(yaw), 0, -cos(yaw))`
  - `rightXZ   = ( cos(yaw), 0, -sin(yaw))`
  - Note: Steering left (`steer < 0`) **increases** `headingRad` (`headingRad -= steerInput * turnRate * dt`, `skiPhysics.ts:154`).
- **Pitch (`pitchRad`):** Euler `'YXZ'` local `+X` rotation; **`pitchRad < 0` points downhill** (`forwardY = sin(pitchRad) < 0`).
- **Bank (`bankRad`):** Lateral terrain roll around forward tangent `T(s)`.

---

## 2. `SkiSimulation` Step Order & State Machine (`src/sim/skiSimulation.ts`)

`SkiSimulation.step(fixedDt, intent)` (`:578-755`) clamps `dt` to `[0, 0.05]` and executes 8 deterministic stages:

1. **Timers (`:586-595`):** Decay `invulnerableTimerSec` and `comboTimerSec` (`COMBO_DURATION_SEC = 8.0`; resets `comboCount = 0, comboMultiplier = 1` at `0`).
2. **Skier Physics / Wipeout State Machine (`:607-666`):**
   - `'skiing'` or `'recovering'`: runs `SkiPhysics.stepSkiing(...)` (`:608`). Transitions `'recovering' -> 'skiing'` when `invulnerableTimerSec <= 1.2`. Evaluates physical outcomes (`wall_crash` / `wall_scrape` / `hard_landing_wipeout` / `hard_landing_stumble`, `:613-630`). Checks relative-relief chasm fall (bypasses invulnerability!): triggers `'chasm_fall'` (`safeX`, drops 2 presents, `speedRetention = 0`) if `surf.inChasmZone && surf.chasmWipeoutDepth > 0` and either `surf.macroY - curr.posY >= surf.chasmWipeoutDepth` OR stuck slow (`speed < 2.5`) past `chasmTrapTimerSec >= 1.0 s` (`:634-657`).
   - `'wipeout'`: runs solid 3D tumble `SkiPhysics.stepWipeout(...)` through Jolt (`:658-666`; 3D tangential gravity + `μ = 0.65` tumble friction + obstacle/wall deflection, `0.82` bounce bleed) and calls `recoverFromWipeout()` when `wipeoutTimerSec <= 0`.
3. **Subsystems (`:671-682`):** `CreatureSystem.step`, `tossedPresents.step`, `skiTracks.stepAges`, `deliveryZones.stepTimers`.
4. **Pickups, Deliveries & Collisions (`:685-691`, skipped during `'wipeout'`):**
   - **Presents (`:265-297, 844-854`):** `presentGrid` query radius `3.2 * magnet`; exact check `distXZ <= pickupRadius * magnet && |skier.posY - py| <= 3.0`. Awards `pickupPoints`, pushes into `carriedPresentDefIds` up to `maxCarryCapacity` (`<= 16`).
   - **Delivery Zones (`:856-952`):** Scans active zones; triggers when skier is inside local XZ OBB (`localLat <= radius && localLong <= max(radius, lengthM * 0.5)` — **no Y check!**). Spawns staggered parabolic `tossedPresents` arcs (`kind = 0`), updates `comboMultiplier = 1.0 + floor(comboCount * 0.5) * 0.5 + deliverCount * def.comboBonusPerGift`, awards `round(baseSum * comboMultiplier * stage.scoreMultiplier)`.
   - **Hazards & Creatures (`:245-263, 954-1037`, skipped if `invulnerableTimerSec > 0`):** Prefers swept Jolt `CharacterVirtual` contacts (`hitHazardIndex` / `hitCreatureIndex`, anti-tunneling at `36 m/s`), falling back to `hazardGrid` / creature overlap checks for direct test teleports.
     - `triggerImpact` (`:1039-1118`): scales **all three** 3D velocity components `(velX, velY, velZ) *= speedRetention` and syncs `contactSolver.teleportCharacter(...)`.
     - `'stumble'` (`boulder_small`, `wall_scrape`, `hard_landing` stumble): retains `58%–60%` 3D speed, drops `1` present, grants `0.55s` invulnerability.
     - `'wipeout'` (`boulder_large`, `pine_tree`, `bear_patrol`, `chasm_fall`, `wall_crash`, `hard_landing` wipeout): resets combo, scatters dropped presents (`kind = 1`), decrements `livesRemaining` in `'scoreAttack'` mode (`gameOver = true` at `0`), enters `'wipeout'` for `wipeoutRecoverySec` (`1.2s` / `1.1s`).
5. **Trail Window Progression (`:694-731`):** `trailWindow.updateProgression(...)`; emits `FORK_ENTERED`, prunes entity pools & `LayoutEngine` state for dropped segments, rebuilds spatial grids, notifies `contactSolver.onPoolsPruned()`, re-samples surface, and calls `physics.invalidateSurfaceCache()`.
6. **Weather (`:734, 1300-1311`):** Exponentially damps `snowParticleCount`, `windLateral`, `fogDistanceM` (clamped `>= 65 m`), and `blizzardDim` toward `WEATHER_BLIZZARD` (if toggled) or active stage weather.
7. **Chase Camera (`:737`):** `CameraRig.update(...)`.
8. **128 m Floating-Origin Rebase & Debug Buffer (`:740-754`):** Rebase if any `|posX/Y/Z| >= 128` (shifts `contactSolver.shiftOrigin` + `physics.shiftOrigin`), then update `DebugDrawBuffer` if enabled.

### Wipeout Recovery (`recoverFromWipeout`, `skiSimulation.ts:1140-1235`)

- **SafeX teleport** if `wipeoutRecoveryMode === 'safeX' || surface.onPiste || surface.inChasmZone || surface.normalY < 0.72` (rock): snaps onto `curr` (or active non-`prev`) segment's `safeX(s)`.
- **Local in-place recovery** otherwise (skiable off-piste snow): recovers at current `(posX, posZ, groundY)`.
- Resets skier velocity to `10.0 m/s` along `surface.tangent`, sets `invulnerableTimerSec = invulnerableSec` (`1.5s`), resets `SkiPhysics`, syncs Jolt (`syncWorld` + `teleportCharacter` + `physics.syncSolverPose`), and resets `prevSkier` + `CameraRig` if recovery jump distance `> 18 m` (prevents camera/skier interpolation ghosting).

### Pooled Entity Capacities (`src/sim/entityPools.ts:12-18`)

| Pool | Capacity | Spatial Grid Cell | Rebase Shift | Notes |
| :--- | :---: | :---: | :---: | :--- |
| `hazards` | `256` | `16 m` (`hazardGrid`) | Yes | Swap-remove by `segmentId` |
| `presents` | `256` | `16 m` (`presentGrid`) | Yes | Swap-remove by `segmentId` |
| `tossedPresents` | `48` | — | Yes (prev+curr) | Parabolic arc (`kind=0` delivery, `1` scatter) |
| `deliveryZones` | `24` | `24 m` (`deliveryGrid`) | Yes | `deliveryGrid` is maintained, though `checkDeliveryZones` loops all `<= 24` slots directly |
| `creatures` | `24` | — | Yes (prev+curr) | Stores `hintSegId`/`hintS` + `patrolDir` |
| `skiTracks` | `256` | — | Yes | Ring buffer (`head`, `count`, `capacity`) |
| `ramps` | `32` | — | Yes | OBB ramp surface + lip boost |

---

## 3. M3 True-3D Ski Physics Stack (Layer A `SkiDynamics` + Layer B Jolt WASM)

The M3 physics stack splits cleanly into **Layer A (`SkiPhysics` / `SkiDynamics`, `src/sim/skiPhysics.ts`)** and **Layer B (quarantined Jolt Physics WASM behind `WorldContactSolver`)**:

### Layer A: `SkiPhysics` / `SkiDynamics` (`src/sim/skiPhysics.ts`)

| Constant | Value | Line |
| :--- | :--- | :--- |
| `SKI_GRAVITY` | `22.0 m/s²` | `skiPhysics.ts:31` |
| `POINTER_STEER_GAIN` | `8.0` (applied after `POINTER_DRAG_STEER_SCALE = 3.2` in `main.ts:30`) | `skiPhysics.ts:32` |
| `MAX_CARVE_ANGLE_RAD` | `0.55 rad` (~31.5°) | `skiPhysics.ts:33` |
| `SKI_TRACK_SAMPLE_DIST_M` | `0.85 m` | `skiPhysics.ts:34` |
| `RESTORE_TORQUE_START_RAD` / `_FULL_RAD` | `80°` / `115°` (max `5.8 rad/s`) | `skiPhysics.ts:36-38` |
| `AIRBORNE_HYSTERESIS_SEC` / `_MICROHOP_CLEARANCE_M` | `0.07 s` / `0.12 m` | `skiPhysics.ts:45-46` |
| `CREST_LOOKAHEAD_SEC` / `CREST_DETACH_MIN_SPEED_MPS` | `0.08 s` / `1.4 m/s` | `skiPhysics.ts:47-48` |
| `STICK_TO_FLOOR_STEP_DOWN_M` / `FLOOR_SEAT_BIAS_MPS` | `0.35 m` / `0.65 m/s` | `skiPhysics.ts:49-50` |
| `WALL_SCRAPE_SPEED_MPS` / `WALL_CRASH_SPEED_MPS` | `13.0 m/s` / `20.0 m/s` | `skiPhysics.ts:52-53` |
| `LANDING_PISTE_STUMBLE_MPS` / `_WIPEOUT_MPS` | `27.0 m/s` / `36.0 m/s` | `skiPhysics.ts:54-55` |
| `LANDING_HARD_STUMBLE_MPS` / `_WIPEOUT_MPS` | `16.0 m/s` / `24.0 m/s` | `skiPhysics.ts:56-57` |
| `WIPEOUT_TUMBLE_MU` | `0.65` | `skiPhysics.ts:58` |
| Coyote time | `0.10 s` | `skiPhysics.ts:439` |

#### Surface Dynamics Table (`computeSurfaceDynamics`, `skiPhysics.ts:1066-1117`)

| Surface Type | `muK` (+ off-piste) | `cAero` | `cPlough` (+ off-piste) | `grip` (× `carveGrip`) | `maxLatEdgeAccel` | `carveEfficiency` |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `packed` | `0.03 + 0.045 * offPiste` | `0.0055` | `0.018 + 0.045 * offPiste` | `1.00` | `34.0 * grip` | `clamp(0.45 * grip, 0, 0.55)` |
| `powder` | `0.048 + 0.04 * offPiste` | `0.0072` | `0.055 + 0.04 * offPiste` | `0.72` | `24.0 * grip` | `clamp(0.35 * grip, 0, 0.45)` |
| `ice` | `0.018 + 0.04 * offPiste` | `0.0046` | `0.008 + 0.03 * offPiste` | `0.25` (× `iceGrip`) | `14.0 * grip` | `clamp(0.25 * grip, 0, 0.40)` |
| `rock` (`normalY < 0.72`) | `0.40` (no off-piste skip) | `0.012` | `0.20` (no off-piste skip) | `0.15` | `10.0 * grip` | `0` |

#### Exact Per-Tick Solver (`stepSkiing`, `skiPhysics.ts:260-898`)

1. **Surface & World Sync (`:300-362`):** Samples `MountainSurfaceSampler` (`surfaceSampler.ts:44-164`, which caches `collectSpinesInBounds(..., 330)` across `±10 m` keyed by `fieldRevision` + `originOffset` and computes local steepest-descent `fallLine{X,Y,Z}` = `-∇H` tangent projection while keeping `tangent` as trail direction). Calls `contactSolver.syncWorld(...)`, uses Jolt's supporting triangle normal when grounded, and enforces the **hard `52°` climbability gate** (`grounded = false` whenever `ny < COS_MAX_CLIMBABLE_SLOPE` and off-ramp).
2. **Continuous Steering & Restoring Torque (`:365-405`):** Replaces hard `±80°` clamp snaps with continuous angular restoring torque (`smoothstep(80°, 115°)` up to `5.8 rad/s`) relative to `trailYaw`, suppressed smoothly (`smoothstep(45°, 80°)`) when aligned with safe off-piste `fallLineYaw` outside chasms (`!surface.inChasmZone`).
3. **3D Tangent-Plane Forces (`:438-566`):**
   - Builds true 3D orthonormal tangent-plane basis $(\hat{\mathbf{f}}, \hat{\mathbf{r}} \perp \hat{\mathbf{n}})$, projects 3D velocity onto $(\hat{\mathbf{f}}, \hat{\mathbf{r}})$ (zero `velY = slopeVelY` overwrite!), and applies exact 3D tangential gravity (`-g * fHatY`, `-g * rHatY`).
   - **Zero-uphill poling start assist (`:468-471`):** `0.0` whenever `fHatY >= 0.02` or on `rock`.
   - **Anisotropic edge-bite saturation & energy-conserving carve redirection (`:475-491`):** Clamps lateral impulse by `maxLatEdgeAccel * (0.45 + 0.55 * ny) * dt`; converts `carveEfficiency * latEnergyRemoved` into `vFwd = sqrt(vFwd² + ...)` only when `vFwd >= 0 && !braking && fHatY <= 0.02` ($v_{fwd}^2 + v_{lat}^2$ strictly non-increasing).
   - **Braking & Drag (`:494-528`):** Snowplow brake (`18.0 m/s²` toward `4.5` downhill or `0` uphill/slow), signed Coulomb + viscous plough + aero drag, and soft `maxSpeed` governor.
   - **Cliff-crease guard & `fallLine` stall pivot (`:409-429, 535-556`):** Probes `samplePatchNormal` ahead so cliff-crease normals never inject upward `velY` into a `> 52°` wall; when stalling nose-up (`vFwd < 1.5 && fHatY > 0.05`) outside chasms and without active steering (`|steerInput| <= 0.2`), smoothly pivots `headingRad` toward `fallLineYaw`.
   - **Ballistic Airtime (`:558-565`):** `velY -= 22.0 * dt` with physical quadratic aero drag `(0.04 + 0.0055 * airSpd)`.
4. **Attenuated Jump & Saturated High-Speed Ramp+Jump (`:569-605, 1119-1126`):** Attenuates jump impulse on `rock` (`0.25 * (1 - smoothstep(36°, 46°))`) and `> 38°` snow slopes (`lerp(1.0, 0.2, smoothstep(38°, 50°))`); saturates high-speed ramp+jump impulse above `24 m/s` (`maxUpBoost = lerp(11.5, 7.5, smoothstep(24, 34, preSpeed3d))`).
5. **dt-Invariant Crest Detachment & Layer B Step (`:607-679`):** Checks `samplePatchNormal` at `0.08 s` lookahead; sets `stickToFloorStepDownM = 0` when `ahead.normalY < cos(52°)` or `v·n_ahead > max(1.4, g * max(0.45, ahead.ny) * 0.08)`, or when exiting a ramp lip (`isExitingRampLip`). Otherwise passes `stickToFloorStepDownM = 0.35` and `seatBiasMps = 0.65` into `contactSolver.stepCharacter(...)`.
6. **Wall Deflection, Energy Conservation, Directional Ramp Lip Launch & Landing Severity (`:689-826, 1147-1202`):**
   - `res.wallHit`: clamps `velY <= max(0, preStepVelY)`, bleeds speed (`clamp(1 - 0.025 * wallImpactSpeed, 0.45, 0.995)` for impacts `> 0.25 m/s`), and emits `wall_scrape` (`>= 13 m/s`) / `wall_crash` (`>= 20 m/s`).
   - Concave / landing transitions: scales velocity so `||v+|| <= ||v-||`.
   - Ramp lip launch (`tryApplyRampLipLaunch`): requires riding forward (`vAlong >= 3.0`) off the front lip, smoothly saturating `lipPitchBoostDeg` above `24 m/s` (`lerp(rawBoostDeg, min(rawBoostDeg, 12.0), smoothstep(24, 34, speed3d))`).
   - Surface-split landing severity (after `airborneTimeSec >= 0.1`): `27 / 36 m/s` (stumble/wipeout) on-piste snow/ramps vs `16 / 24 m/s` on rock/off-piste.
   - `0.07 s` airborne hysteresis (`< 0.12 m` micro-hop clearance) prevents stance/track flicker; preserves M2 `SkiTracks` `rightY` cross-slope tangent projection (`:852-897`).

### Layer B: Quarantined Jolt Physics WASM (`src/sim/physics/`)

All Jolt WASM calls, `RefTarget` lifecycles, and `_webidl_malloc` buffers are strictly quarantined inside `src/sim/physics/`:
- **`worldContactSolver.ts`:** Pure headless, zero-alloc Layer B interface (`WorldContactSolver`, `WorldMoveRequest`, `WorldMoveResult`, `ContactEvent`, `samplePatchNormal`).
- **`joltRuntime.ts`:**
  - `DisposableScope`: deterministic LIFO owner tracking `Jolt.destroy`, `Release()`, `_webidl_free`, and teardown hooks.
  - DI `JoltRuntime`: owns one shared `JoltInterface` (`mMaxBodies = 1024`, `maxWorldSlots = 32`) partitioned into isolated `ObjectLayerPairFilterTable` slots, a persistent `terrainBodyId` per slot (avoiding Jolt's 4 B/unique-BodyID `NotifyShapeChanged` growth), `getFreeMemory()`/`getUsedMemory()` diagnostics, and plain `setDefaultPhysicsRuntime` / `resolveDefaultPhysicsRuntime` helpers (zero `getInstance` singletons).
- **`joltContactSolver.ts`:**
  - **Rolling `64×64 @ 0.5 m` `HeightFieldShape` (`31.5 m × 31.5 m`, `mBlockSize = 2`, `mBitsPerSample = 8`, `[-128, +128]`):** Centered on `patchCenterY`; recenters via `HF_RECENTER_DIST_M = 5.5 m` with `HF_FORWARD_LEAD_M = 2.0 m`. Uses curvature-driven 2-level adaptive `[16..48]` quadtree (`0.22 m` 2m→1m and `0.18 m` 1m→0.5m thresholds inside `7.3 m` isotropic radius + `±5.5 m` corridor, C0-clamped outer border, `STEEP_GRAD_SQ_05M` 2D gradient scan) and rolling sub-rect `SetHeights(16, 16, 34, 34)` (`1,156` samples).
  - **`CharacterVirtual` (`mMaxSlopeAngle = 52°`):** Steps via `Update()` + conditional `StickToFloor()`; `seatBiasMps` seats gentle convex snow on pass 1 and is restored post-step. `CharacterContactListenerJS` reads `HEAPU32`/`HEAPF32` directly (negating `OnContactAdded`/`OnContactPersisted` normals per `JoltJS.h:690` vs positive `OnContactSolve` normals).
  - **Active `50–60 m` Local Body Bubble:** `CylinderShape`/`BoxShape` hazards, flat-decked rigid 3D `ConvexHullShape` ramp wedges (matching `meshFactory.ts:253-289`), kinematic `CapsuleShape` bears, and fork V-wedge nose cylinder.
  - **`SetPosition`-Only Rebase:** `shiftOrigin(dx, dy, dz)` translates `CharacterVirtual`, `hfBodyId`, and active bubble bodies in place (plus periodic `OptimizeBroadPhase()` every 64 refreshes).

---

## 4. `CameraRig` (`src/sim/cameraRig.ts`)

Computes world-space `prevCamera` / `currCamera` headlessly with zero allocations:
- **Chase Yaw (`:138-142`):** Blends `downhillYaw` and `skier.headingRad` (`headingWeight = lerp(0.55, 0.35, pisteWeight)` — follows skier more closely off-piste), damped at `lambda = 5.5`.
- **25 m Look-Ahead Crest Probe (`:148-170`):** Queries `MountainField.evaluateHeight` 25 m ahead along velocity/heading. When convex brow drop `crestDrop > 0.35 m`, raises camera up to `+3.2 m` (`crestLiftM`) and pitches look-at down up to `-2.4 m` (`crestLookDropM`).
- **Position & Safety Floors (`:172-217`):** Trails `9.4–11.4 m` behind, `3.4–4.0 m + slopeRise + crestLiftM` above; hard-clamps `posY >= actualCamGroundY + 2.0` (`:202`) and front-face plane `computeMinFrontFaceY` when `surface.normalY >= 0.20` (`:74, 207, 276-290`).
- **Look-At, Roll & FOV (`:220-252`):** Looks `18 m` ahead, carve roll `-carveAngleRad * 0.14`, `minHorizontalFovDeg = 72`, `speedFovBoostDeg` up to `+14°` over `12..36 m/s`.

---

## 5. `CreatureSystem` (`src/sim/creatureSystem.ts`)

Currently implements `bearPatrol` (`bear_patrol`) using a 4-phase state machine (`contracts.ts:696-699` / `creatureSystem.ts:60-185`):
- **85 m Sleep Gate (`CREATURE_ACTIVE_RANGE_SQ = 85 * 85`, `:16-17, 68-71`):** Skips AI, state updates, and `sampleSurface` queries for distant creatures (`distSqToPlayer > 85²`, safely beyond `warningRange = 48 m`).
- `IDLE (0)` → enters `TELEGRAPH (1)` when `distToPlayer <= warningRange (48 m)`, emits one-shot `CREATURE_TELEGRAPH` with `edgeSide` (`'left'` / `'right'` / `'center'` at `±1.5 m` lateral threshold).
- `TELEGRAPH (1)` → ramps `telegraphProgress` `0 -> 1` over `telegraphSec (0.75 s)`, then enters `ATTACK (2)`.
- `ATTACK (2)` → crosses laterally at `crossSpeed (4.2 m/s)` between `±max(4.0, halfWidth * 0.78)` with `1.25 m/s` downhill creep (`:125-145`), snaps `posY` via single-sample reuse (`:150-167`): reuses the tick's initial `sampleSurface` by projecting `groundY` along the sampled surface plane (`-(nx*dx + nz*dz)/max(0.35, ny)`) whenever single-step displacement `<= 0.25 m` (`CREATURE_RESAMPLE_DIST_SQ = 0.25²`), re-sampling at the destination only when `> 0.25 m` (keeps `<= 1` `sampleSurface`/tick at 60 Hz with zero hot-loop heap allocations). Transitions to `RECOVER (3)` after `5.0 s`.
- `RECOVER (3)` → cools down `0.8 s`, then loops back to `ATTACK (2)`.

---

## 6. `LayoutEngine` & `PacingDirector` (`src/sim/layoutEngine.ts`)

Called via `TrailWindow`'s `onSegmentCreated` callback (`skiSimulation.ts:294-296, 666-705`) to bake placements once from Track Space `(s, x)` to World Space `(X, Y, Z)`:

1. **Delivery Zones (`PacingDirector.planDeliveryPositions`, `:59-123`):** Guarantees `150–220 m` spacing across segment/fork boundaries (`endDeliveryGapBySegment`), accelerating to `~95–135 m` when backpack fill `>= 75%`. Places zone at `safeX ± 4.2 m` (keeping `safeX` inside the `7.5–9.0 m` delivery radius) and attaches a `deliveryLandmark` `SegmentLandmarkRequirement` `3 m` further out (up to `±(hw + 2)`).
2. **Playable Ski Ramps (`:194-232`):** Evaluated every `75 m` slot against `stage.terrain.rampChance`, near `safeX ± 3.2 m` outside dividers; registers a `[s - 4, s + 28]` ramp clearance window.
3. **Static Hazards (`:235-262, 447-563`):** Supports patterns `scatter`, `sequence`, `staggered`, `gate`, `cluster` across bands `onPath`, `slalom`, `nearEdge`, `middle`, `offPiste`. Enforces three hard invariants for `lethal` hazards (`boulder_large`, `pine_tree`):
   - `|x - safeX| >= max(2.5, rule.minSafeClearanceM) + collider.radius`
   - Outside post-brow crest pockets (`[brow, brow + 26]`, `trailSegment.ts:365-373`) and ramp windows
   - Before `fork.obstacleFreeStartS` (final `50 m` ahead of a fork seam)
4. **Presents (`:265-319`):** Baked at `posY + 0.65 m` avoiding `segmentOccupationGrid` overlaps (`2.6 m`).
5. **Creatures (`:322-373`):** Up to `maxPerSegment` bears spawned at `±0.55 * halfWidth` facing inward.

---

## 7. Gotchas / Don't Break

- **Always call `sim.dispose()` (`skiSimulation.ts:419-425`):** Releases the simulation's `JoltContactSolver` `DisposableScope` and `JoltRuntime` world slot (`maxWorldSlots = 32` by default). Leaving un-disposed `SkiSimulation` instances will exhaust Jolt world slots or leak WASM memory.
- **Surface cache invalidation (`skiPhysics.ts:230-234`):** Any code that teleports the skier, prunes segments, or shifts origin MUST call `physics.invalidateSurfaceCache()` or `physics.reset()`, otherwise the next tick reuses stale `surface` normals/heights.
- **`LayoutEngine` height parity (`layoutEngine.ts:413-450`):** `samplePlacementSurface` now queries `mountainField.evaluate(wx, wz)` directly (falling back to `segment.evaluatePisteHeight` in standalone tests without `MountainField`), eliminating the legacy `3.6 m` snowbank prop drift (resolved in M1; `TrailWindow` also runs `rebuildElevationSpines()` before `onSegmentCreated`).
- **Delivery zone Y check missing (`skiSimulation.ts:883`):** Airborne skiers flying high over a delivery zone still auto-toss presents.
