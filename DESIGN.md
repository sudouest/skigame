# Project Architecture & Design Specification (`skigame`)

> **Status:** Living Architectural Source of Truth  
> **Target Stack:** TypeScript · Vite · Three.js (`WebGLRenderer` / WebGL 2) · Vitest · Capacitor (iOS & Android)  
> **Perspective & Core Concept:** Behind-the-skier (3rd-person chase) endless cartoon downhill skiing game with present pickup/delivery, weather and terrain hazards, and mountain creatures.

---

## 1. Overview

`skigame` is an endless cartoon skiing game where the player carves down procedurally generated mountain trails, collects wrapped presents, and earns combo points by delivering them to waiting children along the route—while navigating boulders, dense pine groves, falling snow blizzards, steep Black Diamond chutes, and mountain creatures (bears, ogres, yetis).

The project ships **web-first** as a lean static Vite + TypeScript bundle and is architected from day one for offline **Capacitor** packaging to the Apple App Store and Google Play Store.

### Core Architectural Pillars

1. **Strict Headless Simulation Separation:** All skiing physics, track spline math, procedural generation, AI, scoring, and chase-camera pose computation live in `src/sim/` with **zero Three.js imports, zero DOM imports, and zero global singletons**. The entire game can be simulated and soak-tested headlessly in Node/Vitest.
2. **Freely Mixable 3D & 2.5D Cartoon Rendering:** Every entity visual is declared via a tagged union (`VisualSpec`), allowing low-poly cel-shaded 3D `.glb` meshes, procedural 3D primitives, and 2.5D illustrated cylindrical billboards to coexist seamlessly within a single unified cartoon lighting and fog model.
3. **Split Coordinate Strategy (World-Space Runtime + Track-Space Generation):** Active entities simulate, steer, and collide in plain Euclidean **World Space `(X, Y, Z)`**—eliminating cross-seam coordinate conversions, curvature hitbox distortion, and fork handoff snaps—while **Track Space `(segmentId, s, x)`** is used purely for terrain/fork generation, procedural layout authoring, and fast \(O(1)\) warm-started surface queries (`sampleSurface`).
4. **Zero-Allocation Runtime & Tracked GPU Pooling:** Mobile WebViews (`WKWebView` / Android WebView) aggressively terminate processes on memory churn or GPU leaks. Every hot-path simulation structure, ribbon chunk mesh, prop `InstancedMesh`, and visual effect is pooled and reference-counted.

---

## 2. Module Architecture & Boundaries

Rather than maintaining a fragile file-by-file manifest before implementation stabilizes, the codebase is organized around strict top-level module boundaries and one-way dependency rules:

```text
skigame/
├── index.html             # Primary web game entry point
├── stage-designer.html    # Standalone Vite dev page: free-fly stage/biome inspector
├── asset-inspector.html   # Standalone Vite dev page: GLB/sprite & collider verifier
├── DESIGN.md              # This architectural specification (living document)
├── public/assets/         # Baked .glb models, 2.5D sprite atlases, audio SFX/music
└── src/
    ├── core/              # Game-agnostic plumbing (fixed loop, input, event bus, audio,
    │                      # spatial hash & SpatialGridPair, object pool, PRNG, profiler)
    ├── sim/               # Headless skiing simulation (ZERO Three.js / DOM / singletons):
    │                      # trail window & splines, sampleSurface, world-space ski physics,
    │                      # camera rig, pooled entity state, PCG layout & pacing,
    │                      # dual-radius Poisson scenery, creature AI, DebugDrawBuffer
    ├── render/three/      # SOLE layer allowed to import 'three': GraphicsTracker/Utils,
    │                      # chunked ribbon pool, instanced 3D & 2.5D billboard pools,
    │                      # smooth-normal outlines, contact shadows, backpack stack,
    │                      # snow VFX, stack animation player, time-budgeted chunk streamer
    ├── content/           # Pure declarative data & typed registries (characters, stages,
    │                      # hazards, creatures, presents, delivery zones, patterns, chunks)
    ├── ui/                # HTML/CSS overlay (HUD, menus, safe-area insets, touch drag,
    │                      # lazy onboarding hints)
    └── tools/             # Dev-only controllers for stage-designer & asset-inspector
```

### Dependency Rules
* `src/core/` and `src/content/` have **no** dependency on `src/sim/`, `src/render/three/`, or `src/ui/` (beyond shared type contracts).
* `src/sim/` depends only on `src/core/` and `src/content/`. It **must never** import `three` or browser DOM APIs.
* `src/render/three/` reads `Readonly<SimState>` and subscribes to typed `EventBus` events; it never mutates gameplay state.
* A lightweight composition root at app startup wires `core`, `sim`, `render/three`, `content`, and `ui` together via dependency injection.

---

## 3. Key Engineering Conventions & Non-Negotiable Rules

### Rule 1: Three.js Resource Tracking & Zero-Allocation Pooling (CRITICAL)

Every GPU resource (`THREE.BufferGeometry`, `THREE.Material`, `THREE.Texture`) must be reference-counted through the **Graphics Tracker** and **Graphics Utils**. Untracked allocations cause silent VRAM leaks and iOS `WKWebView` Jetsam termination.

- **NEVER** instantiate `new THREE.Mesh`, `new THREE.InstancedMesh`, `new THREE.Line`, or call `.clone()` / `.dispose()` directly in gameplay or rendering code.
- **NEVER** create a fresh `MeshToonMaterial` or `DataTexture` per terrain chunk, and **NEVER** clone materials per collected present just to animate opacity.
- **ALWAYS** share the global 3-step toon `gradientMap`, terrain material, and instanced prop materials; express per-instance variation through vertex colors, instance color attributes, or pooled transform/scale animations.
- **ALWAYS** set `frustumCulled = false` on streaming `InstancedMesh` pools and pack active instances contiguously from index `0` to `.count - 1` (because Three.js frustum-culls an `InstancedMesh` by its base geometry bounding sphere at local `(0, 0, 0)`, not by its live instance matrices).

```typescript
// DO THIS:
const mesh = GraphicsUtils.createMesh(geometry, material, 'SkierRig');
const pool = GraphicsUtils.createInstancedMesh(pineGeo, sharedToonMat, 256, 'PinePool');
pool.frustumCulled = false;

GraphicsUtils.assignMaterial(mesh, sharedAlternateMat);
GraphicsUtils.markAsCache(cachedAssetRoot);
GraphicsUtils.disposeObject(temporaryPreview);

// NOT THIS:
const mesh = new THREE.Mesh(geometry, material);            // Untracked GPU leak risk!
const clonedMat = sharedMat.clone();                        // Per-instance shader/material bloat!
mesh.material = newMat;                                     // Old material ref-count never released!
```

**Hot-Loop Allocation Ban:**
- Inside the `60 Hz` simulation step and `requestAnimationFrame` render loop, **zero heap allocations** are permitted (`new THREE.Vector3()`, `new THREE.Matrix4()`, `new THREE.Color()`, temporary array/object literals).
- Pre-allocate module-private scratch objects (e.g., `_scratchVec3A`, `_scratchMat4`, `_scratchColor`) and reuse pooled typed arrays.
- **Periodic Leak Verification:** In dev builds, `GraphicsTracker.checkLeaks(20, true, scene)` runs on an interval to flag both uncollected detached resources and untracked objects added directly to the scene graph.

### Rule 2: Dependency Injection & Headless Simulation (No Singletons)

- **ZERO Singletons:** `getInstance()` globals are forbidden. Simulation state, trail windows, event buses, audio managers, and renderers are constructed explicitly at the composition root (or in test harnesses) and passed via constructors or typed context objects.
- **Read-Only State Exposure (No Per-Frame Cloning):** `src/sim/` must **never** construct a fresh DTO snapshot every `60 Hz` tick. Instead, `SimState` exposes a `Readonly<SimState>` view over its pooled typed buffers and fixed slots, which the renderer and UI read directly (interpolating poses with `alpha`).
- **Built-In Simulation Debug Surface:** `SimState` populates a lightweight, pre-allocated `DebugDrawBuffer` (toggleable in dev mode) exposing `safeX(s)` splines, obstacle cylinders/heights, Delivery Zone radii, chunk boundaries, and fork split lines so gameplay math can be inspected visually without importing Three.js into `src/sim/`.

### Rule 3: TypeScript & Code Standards

- Strict TypeScript (`strict: true`, `noUncheckedIndexedAccess: true`).
- Avoid `any` except where explicitly justified at low-level Three.js shader/uniform boundaries.
- Preserve existing explanatory comments and docstrings; document mathematical invariants (frame conventions, curvature limits, fork seam guarantees) inline.
- Every change must pass `npx tsc --noEmit` and the headless Vitest suite (`npm run test:run`).

---

## 4. Coordinate Systems, Track Space & Ski Physics

### 4.1 Coordinate Strategy (World-Space Runtime vs. Track-Space Generation)

| Role | Coordinate Space | Stored State / Usage | Key Advantage |
| :--- | :--- | :--- | :--- |
| **Authoritative Runtime (`src/sim/` & Three.js)** | **World Space `(X, Y, Z)`** (Right-handed, `+Y` up) | `(posX, posY, posZ)`, `(velX, velY, velZ)`, world yaw `heading`, `(prevPosX, prevPosY, prevPosZ)` | 1:1 with Three.js; zero cross-seam transforms, zero curvature distortion, natural 3D physics & AI |
| **Terrain Generation & Queries Only** | **Track Space `(segmentId, s, x)`** (`s` along spine, `x` lateral) | Builds snow ribbons, forks, `safeX(s)`, layout patterns, chunk templates; static placements bake once to `(X, Y, Z)` via `trackToWorld(s, x)` (keeping `segmentId` only for pruning) | Clean procedural authoring & continuous trail geometry |

Grounded actors (skier, patrolling/chasing creatures) store a **non-authoritative search cache hint** `(hintSegmentId, hintS)` purely to accelerate local surface lookups—never as their positional state.

### 4.2 Up-Locked Yaw-Pitch-Bank Spine Frame & Ribbon Curvature Safety

We **never** use a Frenet-Serret frame along the trail spine, because Frenet normals flip \(180^\circ\) at S-curve inflection points (\(\kappa = 0\)). Instead, each trail segment evaluates an **up-locked Yaw-Pitch-Bank frame** at any arc length `s`:

1. Spine centerline \(\mathbf{P}(s) = (X(s), Y(s), Z(s))\) with horizontal yaw heading \(\psi(s)\), downhill slope pitch \(\theta(s) < 0\), and subtle turn banking angle \(\beta(s)\).
2. Forward unit tangent \(\mathbf{T}(s)\) points along \(\frac{d\mathbf{P}}{ds}\).
3. Horizontal unbanked right vector \(\mathbf{R}_0(s) = \text{normalize}(\mathbf{T}(s) \times (0, 1, 0))\).
4. Banked lateral vector \(\mathbf{R}(s)\) rotates \(\mathbf{R}_0(s)\) around \(\mathbf{T}(s)\) by \(\beta(s)\).

Generated snow surface position at `(segmentId, s, x)` is:

$$
\mathbf{W}(s, x) = \mathbf{P}(s) + x\,\mathbf{R}(s) + h_{\text{local}}(s, x)\,(0, 1, 0)
$$

Local relief \(h_{\text{local}}(s, x)\) (snowbanks, moguls, rollers, ramps) displaces along world vertical `(0, 1, 0)` while trees, children, and 2.5D billboards remain plumb to world up.

**Ribbon Non-Self-Intersection Clamp (Enforced at Segment Generation):**
Even though runtime physics run in World Space, generated 3D snow ribbons still sweep laterally out to \(W_{\text{half}}(s) + W_{\text{skirt}}\). Every segment spine therefore enforces:

$$
|\kappa(s)| \cdot \bigl(W_{\text{half}}(s) + W_{\text{skirt}}\bigr) \le 0.4
$$

This guarantees \(1 - \kappa x \ge 0.6 > 0\) everywhere on the mesh, preventing inner-turn triangle foldover, flipped normals, and Z-fighting.

### 4.3 Warm-Started \(O(1)\) Surface Query (`sampleSurface`)

Once per physics tick per grounded actor, `sampleSurface(posX, posZ, hintSegmentId, hintS)` maps world position onto the active trail:

1. Each active segment caches a lightweight centerline polyline sampled every ~2–4m.
2. Starting from `(hintSegmentId, hintS)`, `sampleSurface` inspects only ~3–5 adjacent polyline segments (plus connected child segments `nextLeft` / `nextRight` when near `s ≈ length`) with **zero heap allocations**.
3. **Unambiguous Fork Resolution:** Once past a fork's seam plane, `sampleSurface` evaluates both branches and picks the branch with smaller lateral distance `|x|`. Because both branches start flush with identical elevation and \(\kappa = 0, \beta = 0\) at the seam, `groundY` and `surfaceNormal` remain completely continuous.
4. Returns `{ segmentId, s, x, groundY, surfaceNormal, downhillTangent, halfWidth, surfaceType }` and updates the actor's `(hintSegmentId, hintS)` cache.

### 4.4 World-Space Arcade Ski Physics & Collisions

Running at a fixed `60 Hz` step (`FIXED_DT = 1/60`):
- **True 3D Slope & Airborne Ballistics:**
  - World gravity `(0, -g, 0)` projected onto `surfaceNormal` naturally accelerates the skier down steep Black Diamond runs and nudges gently inward on banked turns.
  - **Grounded (`posY <= groundY + ε` and vertical speed tracks slope):** The skier follows `groundY`. When cresting a steep roller or launching off a ski ramp lip, downward terrain drop exceeds gravity and `posY > groundY` decouples seamlessly into **true 3D ballistic airtime** (`velY -= g * dt; posY += velY * dt`).
- **Carving & Surface Traction:** Horizontal velocity decomposes into forward-along-skis (low drag) and lateral-across-skis (carve edge-grip force opposing sideslip, scaled by `packed = 1.0`, `powder = 0.72` with extra drag, `ice = 0.25`, plus character perks). Holding brake applies progressive snowplow drag.
- **Downhill Heading Clamp:** To prevent skiing uphill back into pruned chunks, steering `heading` clamps smoothly within `±80°` of the local `downhillTangent` (allowing sharp cross-slope carving to scrub speed without reversing uphill).
- **Soft Snowbank Containment:** Beyond `|x| > halfWidth`, raised snowbank normals and progressive deep-powder drag naturally steer the skier back onto the trail instead of bouncing off invisible walls.
- **Plain Euclidean Collisions:** Obstacles, presents, Delivery Zones, creatures, and projectiles collide directly in a world `(X, Z)` spatial hash:
  $$
  (X_a - X_b)^2 + (Z_a - Z_b)^2 \le (r_a + r_b)^2 \quad\text{and}\quad (\text{posY} - \text{groundY}) \le \text{collider.height}
  $$
  There is zero curvature distortion and zero special-casing across segment seams or forks.

### 4.5 Translation-Only World Floating Origin (Zero Buffer Re-Uploads)

To ski infinitely without floating-point vertex jitter:
- **Do NOT** subtract `player.s` to pin the skier at `Z = 0`, and **do NOT** rotate the world around turns (which spins directional sun shadows, sky gradients, and wind-blown snow unnaturally).
- **Instead**, maintain a **translation-only `worldOriginOffset`** `(Ox, Oy, Oz)`. Whenever rendered world coordinates exceed `256m` from `(0, 0, 0)`, subtract `delta` from active entity `(pos, prevPos)` arrays, active segment polyline anchors, camera state, particle buffers, and chunk container `position`s, adding `delta` to `worldOriginOffset`.
- **Zero Mesh Re-Uploads:** Static ribbon chunk meshes and chunk-local instanced scenery matrices are generated relative to their chunk root's local origin, so rebasing translates only chunk container transforms—requiring **zero vertex buffer or static instance matrix re-uploads**.

---

## 5. Game Loop & Frame-Budgeted Streaming

The simulation loop drives a 4-phase frame pipeline tuned for both 120/144 Hz desktop monitors and 60 Hz mobile WebViews:

1. **Input Phase:** Snapshots keyboard actions, mobile thumb-drag delta, jump/brake triggers, and pause state at the start of the frame.
2. **Fixed-Timestep Simulation Phase (`60 Hz`, `MAX_FRAME_TIME = 0.25s`):**
   ```text
   accumulator += min(rawDt, 0.25)
   while accumulator >= FIXED_DT:
     sim.savePreviousPoses()      // Captures prevPosX, prevPosY, prevPosZ, prevHeading, prevCamPose
     sim.step(FIXED_DT, intent)   // Advances physics, AI, pickups/deliveries, camera rig
     accumulator -= FIXED_DT
   alpha = accumulator / FIXED_DT
   ```
3. **Interpolated Visual Sync Phase (`render(alpha, dt)`):**
   - Interpolates dynamic entity and camera poses using `alpha` for stutter-free 120/144 Hz rendering.
   - Updates contact shadows, backpack stack, snow VFX, animations, and HUD.
4. **Time-Budgeted Chunk Streaming Phase:**
   - Remaining frame budget: `budgetMs = Math.max(14 - frameElapsedMs, 1)`.
   - Terrain chunk mesh generation, Poisson scenery placement, and entity spawning execute inside resumable ES generators (`Generator<void | Promise<void>>`) that `yield` every few rows/items.
   - **Async Asset Gatekeeper:** When a chunk needs a lazy-loaded `.glb` or sprite atlas not yet cached, its generator yields the asset load `Promise`, pausing *only that chunk* until resolved without dropping a frame.

---

## 6. Mixed Low-Poly 3D & 2.5D Cartoon Rendering Pipeline

### 6.1 Unified `VisualSpec` Abstraction

Content definitions never reference Three.js classes directly. `VisualSpec` lets any character, obstacle, or creature choose its art style independently:

```typescript
export type VisualSpec =
  | {
      kind: 'mesh';
      modelId: string;
      scale?: number;
      yawOffset?: number;
      outline?: boolean;       // Uses smooth-normal inverted hull if true
    }
  | {
      kind: 'billboard';
      atlasId: string;
      frame: string;
      width: number;
      height: number;
      outlineTint?: string;
    }
  | {
      kind: 'procedural';
      preset: 'pine' | 'boulder' | 'present' | 'ramp' | 'arch' | 'lantern';
      palette: string[];
      outline?: boolean;
    };
```

### 6.2 Renderer Configuration & Toon Palette

- **Backend:** `THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' })` (WebGL 2).
- **Pixel Ratio:** `renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))` (caps 3x mobile Retina fill-rate burn).
- **Color & Tone Mapping:** `renderer.outputColorSpace = THREE.SRGBColorSpace`; `renderer.toneMapping = THREE.NoToneMapping` (or `NeutralToneMapping`)—**never** `ACESFilmicToneMapping`, which desaturates bright snow and cartoon primary colors.
- **Shared Toon Gradient Map:** One cached `3x1` `THREE.DataTexture` (`[95, 185, 255]` grayscale bands) configured with `NearestFilter`, `generateMipmaps = false`, and `colorSpace = THREE.NoColorSpace` (while albedo/sprite textures use `THREE.SRGBColorSpace`).

### 6.3 Selective Smooth-Normal Inverted-Hull Outlines

We reject fullscreen post-processing passes (`EffectComposer` + Sobel edge shaders, which hurt mobile fill-rate and muddy snow particles) and reject Three.js's `OutlineEffect` (incompatible with `InstancedMesh`).

Instead, outlines use a **selective GPU inverted-hull `InstancedMesh` pass**:
- **Hard-Edge Crack Fix:** Flat-shaded low-poly `.glb` meshes split vertices across sharp corners, tearing gaps if extruded along face normals. On asset load, the **Visual Factory** computes **averaged/smoothed vertex normals** across coincident positions and bakes them into a secondary vertex attribute `aSmoothNormal` (`vec3`), leaving standard `normal` untouched for crisp cel shading.
- **Distance-Clamped Extrusion:** A custom `ShaderMaterial` (`side: THREE.BackSide`) extrudes along `aSmoothNormal` clamped in clip space so outlines stay crisp up close and don't bloat into dark blobs in the distance.
- **Selective Scope:** Applied only to gameplay-relevant silhouettes (skier, creatures, boulders, presents, children, foreground trunks)—never on terrain ribbons or distant scenery.

### 6.4 GPU-Instanced 2.5D Cylindrical Billboards

We reject native `THREE.Sprite` (which tilts spherically toward the elevated chase camera, clipping awkwardly into steep downhill slopes) and raw `ShaderMaterial` (which silently ignores `fog: true` unless Three.js fog chunks are manually duplicated).

Instead, 2.5D cartoon elements use **GPU-instanced Y-axis cylindrical billboard planes**:
- Built by patching `THREE.MeshBasicMaterial` via `onBeforeCompile` (preserving built-in scene fog automatically).
- Vertex shader rotates each quad around world `+Y` only to face the camera horizontally while staying upright against steep slopes.
- **Sorting & Transparency Safety:** Because `InstancedMesh` does not depth-sort individual instances, cutout 2.5D sprites use `alphaTest: 0.5, transparent: false, depthWrite: true`, RGB-dilated texture edges (preventing dark mipmap halos), and `alphaToCoverage: true` **only when** `gl.getContextAttributes()?.antialias === true`.
- **2.5D / 3D Lighting Cohesion:** Patched uniforms `uBiomeTint` and `uBlizzardDim` modulate 2.5D brightness dynamically alongside 3D `MeshToonMaterial` sun/ambient shifts so mixed assets belong to the same world during storms and sunsets.

### 6.5 Depth Perception, Tracks & Weather VFX

- **Terrain-Aligned Contact Shadows:** Every dynamic actor and obstacle renders a dark-blue cartoon shadow blob (`depthWrite: false`, `polygonOffset: true`, `polygonOffsetFactor: -1`) oriented to the local terrain `surfaceNormal`. Shadow radius shrinks and opacity fades proportionally to airborne clearance `posY - groundY`.
- **Ski Tracks:** A pooled triangle-strip ribbon trails behind each ski edge while grounded, fading behind the camera.
- **Blizzard Snow Volume:** A camera-local wrapping box of ~250 instanced elongated snow-streak quads drifting with wind velocity, paired with `THREE.FogExp2` clamped to **\(\ge 65\text{–}80\text{ m}\)** (~2.5s reaction time at peak speed). Warm glowing beacons on Delivery Zones and presents cut cleanly through blizzard fog.

---

## 7. Endless Mountain Terrain & Trail Splitting

### 7.1 Four-Slot Sliding Segment Window (`Trail Window`)

World topology is managed as a strictly bounded **4-slot sliding window**:

```text
[ prev ] ──► [ curr ] ──┬──► [ nextLeft ]   (e.g., Blue Pine Run)
                        └──► [ nextRight ]  (e.g., Black Diamond Chute)
```

- When linear (`curr` does not fork), `nextRight` is `null`.
- All entities live in World Space `(X, Y, Z)`—so the sliding window is needed **only** for ribbon streaming, warm-started `sampleSurface` lookups near seams, and \(O(1)\) cleanup.
- **\(O(1)\) Memory Guarantee:** Once the skier advances ~40m past a fork onto the chosen branch, the unchosen branch and old `prev` segment are pruned and their pooled ribbon chunks / static entity slots are reclaimed.

### 7.2 Model A: Major Stage / Biome Forks

Major trail forks occur every ~45–90 seconds, letting the player steer their own route between biomes and difficulty tiers:

```text
   s = L - 80m                          s = L (Fork Seam: κ=0, β=0)
  ═════════════════════════════════════╤═══════════════════════════════
    Approach Segment                   │ [Blue Gate]  ◄── nextLeft (Curves Left)
    Trail widens smoothly              │  /   inner snowbank ramps 0→full over 25m
    Final 50m: Obstacle-Free           │ ●  Soft-bumper V-wedge nose (r=1.5m)
                                       │  \   inner snowbank ramps 0→full over 25m
  ═════════════════════════════════════╧ [Black Gate] ◄── nextRight (Curves Right, steeper)
```

**Mandatory Fork Seam Invariants:**
1. **Split-Seam Gates & Runway:** Two individual iconographic path gates (Green Circle, Blue Square, Black Diamond—readable without tiny text) stand directly at the split seam `s = L`, one centered over each branch opening (`x = ±0.5 * W_end`). The final **50m** before `s = L` are kept obstacle-free (and off-trail trees are cleared near the seam) while `halfWidth` widens smoothly to `W_L + W_R`, giving a clean sightline directly to both gates with no separate HUD warning banner needed.
2. **Flat Tangent & Zero Banking at Seam:** Entering `s = L`, curvature \(\kappa \to 0\) and banking \(\beta \to 0\) are strictly enforced so `nextLeft` and `nextRight` attach flush at identical world elevation and heading—zero vertical mesh tears.
3. **Suppressed Inner Walls + Soft V-Wedge Bumper:** At `s = 0` of both child branches, the inner snowbank wall height starts at `0` and ramps up to full bank height over the first `25m` behind a **rounded soft-bumper V-wedge nose (`r = 1.5m`)**.
4. **Zero-Handoff Seam Crossing (Airborne & Straddling Safe):** Because the skier moves in authoritative World Space `(X, Y, Z)`, crossing `s = L` (grounded, straddling `x ≈ 0`, or airborne) requires **zero position, velocity, or heading transformations**. The soft nose gently deflects a dead-center skier onto one side, and `sampleSurface` continuously tracks whichever branch is closer past the seam plane.

### 7.3 Model B: Mid-Stage Local Island Dividers

For tactical 100–250m splits inside a single stage (e.g., *narrow icy high-reward chute with golden presents* vs. *safe wide curve around a boulder field*), a segment supports an inline `IslandDivider`:
- Smoothly widens `halfWidth(s)` and raises an interior `dividerSpan(s)` (`[-d(s), +d(s)]`) populated with snowbanks and trees down the center.
- Left and right lanes can carry independent surface modifiers (`packed` vs. `ice`) and reward lines, then smoothly merge back as `d(s) \to 0`.

### 7.4 Chunked Ribbon Mesh Pool & Terrain Definition

The **Ribbon Pool** pre-allocates **~16 reusable fixed-length (25–50m) ribbon chunk meshes** sharing a single vertex-colored `MeshToonMaterial` (positioned at each chunk's local origin for zero-upload floating-origin rebasing and native per-chunk frustum culling).

- **Non-Linear Cross-Trail Vertex Distribution:** Normalized transverse coordinate \(u \in [-1, 1]\) maps to lateral distance via:
  $$
  x(u) = \frac{W_{\text{total}}}{4}\, u\,(1 + u^2)
  $$
  This concentrates triangles densely across the skiable corridor and bank transitions (crisp rollers, jump lips, moguls) while keeping outer scenic mountain skirts coarse and mobile-GPU friendly.
- **Additive Micro-Terrain `surfaceHeight(s, x)`:** Combines stage rollers/moguls, explicit authored **ski ramps**, soft side snowbanks outside `±halfWidth`, and elliptical **surface patches** (`packed | powder | ice`).

```typescript
export interface StageTerrainProfile {
  pitchDeg: [min: number, max: number];      // e.g., Meadow [8, 12], Black Diamond [24, 34]
  curveStrength: [min: number, max: number]; // Clamped by ribbon curvature invariant <= 0.4
  halfWidth: [min: number, max: number];     // Playable corridor half-width (meters)
  bankingFactor: number;                     // Subtle terrain lean into turns
  mogulDensity: number;                      // 0..1 bumpiness amplitude
  icePatchChance: number;                    // Probability of low-grip ice overlays
}
```

### 7.5 Chase Camera Rig & Crest Sightlines

Computed headlessly in `src/sim/` in World Space `(X, Y, Z)`:
- **Base Pose:** Spring-damped trailing distance (`~9–12m`), elevated `~3.2–4.0m`, looking ~18m ahead of the skier so the skier's torso never hides obstacles directly in front. Dynamic subtle **carve roll** and **speed FOV widening** reinforce downhill velocity.
- **25m Look-Ahead Crest Probe:** Queries terrain height ~25m ahead along the active trail polyline / heading. When approaching a steep convex crest (e.g., Black Diamond drop-off), the camera smoothly **rises higher and pitches down** ahead of the brow to preserve sightlines into the landing pocket (paired with a PCG rule forbidding lethal static obstacles in the immediate post-brow blind zone).
- **Horizontal-Preserving Responsive FOV:** Three.js locks *vertical* FOV by default, cropping trail edges and forks on 9:16 portrait phones. The camera rig computes vertical FOV dynamically from a target minimum horizontal FOV so mobile portrait and desktop widescreen show the full trail width.

---

## 8. Core Gameplay Loop, Rewards, Hazards & Controls

### 8.1 Endless Cartoon Wipeout-and-Recover Contract

To satisfy both *"trails go on for as long as the user wishes to play"* and *"wiping out / crashing into trees"* without frustrating instant-death restarts:
- **Loop:** Collect presents along the trail → build a carrying stack → pass through waiting **Delivery Zones** to bank points with an escalating **stack combo multiplier**.
- **Wipeout & Recover:** Colliding with a tree, tall boulder, or creature triggers a comical cartoon snow-tumble (`~1.2s` stun), scatters a portion of **undelivered carried presents** into the snow (resetting the active carry combo), and cleanly places the skier back upright onto the nearest `safeX` world point with brief post-recovery invulnerability (`~1.5s`)—allowing uninterrupted endless play while making risky Black Diamond runs with a full stack genuinely tense. *(An optional 3-lives Score Attack mode can toggle off endless recovery using the same state machine.)*

### 8.2 Diegetic Present Stack & Auto-Toss Delivery Zones

- **Diegetic Carry Stack:** Collected presents visually stack onto a stylized rack/backpack on the skier's back using **pooled instance slots** (zero material cloning, animated scale/pop via deterministic ease curves). Losing presents on wipeout visibly flings them outward; delivering launches them in glowing arcs.
- **Auto-Toss Delivery Zones:** At 25–35 m/s, threading a tiny child hitbox feels finicky and looks wrong. Each `DeliveryZone` places cheering children beside a **warm glowing lantern/cabin landmark** visible 70m+ ahead (cutting through falling snow) surrounded by a generous **auto-delivery radius (~7m × 16m)**. Carving anywhere through the zone triggers rapid sequential **3D parabolic present tosses** from the skier's backpack to the children with confetti bursts and ascending musical chimes.

```typescript
export interface PresentDef {
  id: string;                  // 'gift_standard' | 'gift_jumbo' | 'gift_golden'
  visual: VisualSpec;
  basePoints: number;          // Points awarded upon delivery
  pickupPoints: number;        // Small immediate grab feedback
  bagWeight: number;           // Slots occupied on backpack stack
  pickupRadius: number;        // Generous magnetic grab radius (~2.2m)
  glowColor: string;           // Fog-piercing ribbon/aura tint
}

export interface DeliveryZoneDef {
  id: string;                  // 'child_solo' | 'sled_duo' | 'village_plaza'
  maxAcceptCount: number | 'all';
  deliveryRadius: number;      // Generous auto-toss trigger radius (~7m)
  comboBonusPerGift: number;   // Multiplier bonus for larger simultaneous deliveries
  childVisuals: VisualSpec[];
  landmarkVisual: VisualSpec;  // Cozy cabin / warm glowing lantern arch
  requiredSceneryId?: string;  // Handed to SpatialGrid requirements map
}
```

### 8.3 Hazards & Weather Profiles

```typescript
export interface HazardDef {
  id: string;                  // 'boulder_small' | 'boulder_large' | 'pine_tree' | 'fallen_log'
  visual: VisualSpec;
  collider: {
    shape: 'cylinder' | 'box';
    radius: number;
    height: number;            // Skier clears cleanly when (posY - groundY) > height
  };
  impact: {
    effect: 'wipeout' | 'stumble' | 'slow' | 'launch';
    presentsDropped: number;
    speedRetention: number;    // e.g., 0.0 tree wipeout, 0.65 log clip
  };
}

export interface WeatherProfile {
  snowParticleCount: number;   // Scales camera-local snow-streak pool (0..250)
  windLateral: number;
  fogMinDist: number;          // Clamped >= 65-80m (~2.5s reaction window)
  fogMaxDist: number;
  blizzardDim: number;         // Shared tint uniform dimming 3D & 2.5D together
  durationRangeSec: [number, number];
}
```

### 8.4 Controls & Non-Intrusive Onboarding

- **Desktop:** `A`/`D` or `Left`/`Right` to carve, `Space` or `Up`/`W` to jump, `S`/`Down` to snowplow brake, `P`/`Esc` to pause.
- **Mobile Touch:** **Relative horizontal thumb-drag anywhere on screen** (primary control—no tiny on-screen buttons and no fragile tilt permission walls), tap or quick swipe-up to jump, hold second finger or swipe-down to brake. Optional tilt steering can be enabled as a settings toggle later.
- **Lazy Onboarding Hints:** Avoid upfront text walls. Only display a compact control overlay if the player hasn't steered after ~8 seconds of play, and briefly trigger a gentle `timeScale` slow-down card the very first time a new stage biome or fork mechanic is encountered.

---

## 9. Multi-Track Declarative Layout System & Pacing Director

Rather than scattering random obstacles across a chunk (which causes impossible walls or dry stretches with no children), the **Layout Engine** authors placements in Track Space `(segmentId, s, x)` and bakes them once to World Space `(X, Y, Z)` at spawn:

### 9.1 Pass 1: Guaranteed Reachable `safeX(s)` Path

- Before any obstacle is placed on a segment, the Layout Engine generates a smooth meandering **`safeX(s)` spline** whose lateral curvature respects the skier's realistic carve rate at that stage's peak speed.
- **Hard Clearance Invariants:**
  - No lethal static obstacle (`wipeout`) may spawn within `±2.5m` of `safeX(s)`.
  - No lethal static obstacle may spawn inside the immediate post-brow pocket behind steep convex pitch crests.
  - The final `50m` approaching any Model A fork seam is obstacle-free.

### 9.2 Pass 2: Parallel Independent Tracks & World Bake

Each `StageDef` defines independent parallel **Tracks** (`obstacles`, `presents`, `delivery_zones`, `creatures`). Each track selects progress-ranged `Stages` → weighted `Scenes` → composable **Patterns × Placement Bands** + `explicitPlacements` + authored `ChunkTemplate`s (`sOffset`, `xNorm ∈ [-1, 1]`):

- **Patterns:** `scatter`, `sequence`, `staggered`, `gate` (narrowing risk/reward chokepoints), `cluster`.
- **Placement Bands (relative to `safeX(s)` and `halfWidth(s)`):** `onPath`, `slalom`, `nearEdge`, `middle` / `offPiste`.
- **Spawn Bake:** Once resolved in `(segmentId, s, x)`, every static hazard, present, Delivery Zone, and creature spawn point converts once via `segment.trackToWorld(s, x)` into authoritative **World Space `(X, Y, Z)`** (retaining `segmentId` solely as an ownership tag for pruning).

### 9.3 Scenery `requirements` Handoff & `SpatialGridPair`

- When a gameplay landmark (such as a `DeliveryZone` cabin/arch or fork signpost) spawns, its world `(X, Z)` footprint is inserted into the segment's **`SpatialGrid`** and any required visual landmark is appended to the chunk's `requirements` map.
- Off-trail scenery checks **`SpatialGridPair(chunkGrid, stageLayoutGrid)`**, guaranteeing decorative pines never spawn on top of waiting children, presents, or `safeX(s)`.

### 9.4 Pacing Director & Shuffled Biome Deck

- **Delivery Cadence Guarantee:** Tracks distance since the last `DeliveryZone`. Forces a child delivery plaza every **150–250m**—and accelerates the next spawn if the player's carried present stack exceeds 75% capacity.
- **Shuffled Biome Deck:** Interleaves specialized stages (Black Diamond, Blizzard Ridge, Forest Slalom, Yeti Hollow) with calmer breather stages (Sunny Meadow, Alpine Village) so intensity rises and falls rhythmically.
- **Hazard Stacking Budget:** Prevents combining heavy blizzard fog + high-speed Yeti ambush + tight boulder gate at the exact same meter unless the player intentionally chose a high-multiplier Black Diamond fork.

---

## 10. Procedural Off-Trail Scenery (Dual-Radius Poisson Disk Sampling)

Off-trail mountain flanks (`halfWidth` out to visual horizon skirts) are populated per chunk using **dual-radius Bridson Poisson disk sampling**:

- **Separate `groundRadius` & `canopyRadius`:** Every scenery rule defines both a trunk/ground footprint and an overhead canopy radius. Small rocks, snowdrifts, and shrubs check only `groundRadius` (so they tuck naturally beneath pine boughs), while large pines check `canopyRadius` against neighboring trees to prevent overlapping crowns.
- **Environmental Signals & `TierRule` Competition:** Placement fitness is driven by pure functions of `(elevation, slopeDeg, distFromTrail, worldNoise)`. Grouping species inside a `TierRule` selects a single local winner by highest fitness score.
- **Ridge Visibility Thinning:** A lightweight ray check from the trail centerline out toward candidate off-trail props skips instantiating scenery occluded behind raised mountain ridges, saving mobile GPU triangles and draw calls.

---

## 11. Creature Behavior & Animation Scripting

### 11.1 Three-Tier Creature Architecture (World-Space Native)

Because all creatures operate directly in **World Space `(X, Y, Z)`** (querying `sampleSurface` only when grounded to read trail edges and `groundY`), movement, line-of-sight, and steering across segment seams are trivial:

1. **Tier 1 — `CreatureBehavior` (Orchestrator):** Steps the creature's logic stack, advances world `(posX, posY, posZ)` and `heading`, and emits typed `EventBus` cues (e.g., `CREATURE_TELEGRAPH`, `CREATURE_LUNGE`) for audio and VFX.
2. **Tier 2 — `CreatureLogic` (Goal State Machine):** Defines high-level phases (`IdleOnEdge` → `Telegraph` → `ActiveAttack` → `Recover/Retreat`), returning `{ finish: true, result }` to advance declarative script combinators (`sequence([...])`, `until(result, ...)`, `random([...])`).
3. **Tier 3 — `CreaturePathStrategy` (Steering Math):** Computes desired world target `(targetX, targetZ)` and speed (`LateralCrossStrategy`, `FlankSkierStrategy`, `EdgeTrackStrategy`, `ThrowArcStrategy`).

### 11.2 Stack-Based Animation Player

For rigged 3D `.glb` characters and creatures, the **Animation Player** manages procedural clip sequences (`sequence`, `random` with weights) driven by `THREE.AnimationMixer` `'finished'` events—allowing seamless transitions (`idle_sniff` → `roar_telegraph` → `lunge` → `walk_away`) without manual timer spaghetti. For 2.5D billboard sprites, the same phase events drive atlas frame sets.

### 11.3 Third-Person Fairness & Readability Rules

```typescript
export type CreatureBehaviorConfig =
  | { type: 'bearPatrol'; crossSpeed: number; lungeRadius: number; telegraphSec: number }
  | { type: 'ogreThrower'; projectileSpeed: number; throwCooldownSec: number; minLeadDist: number }
  | { type: 'yetiFlankAmbush'; triggerDist: number; flankOffsetX: number; speedMatchFactor: number };

export interface CreatureDef extends HazardDef {
  behavior: CreatureBehaviorConfig;
  telegraph: {
    soundId: string;
    warningRange: number;
    glowEyeColor?: string;
    showEdgeIndicator?: boolean; // Bottom-left/right HUD danger warning for flanking Yetis
  };
}
```

- **Bear (`bearPatrol`):** Walks straight or crosses laterally in world space with a **telegraphed paw/roar warning** and lane timing rules so a crossing bear never silently seals `safeX` without an advance visual cue or jumpable/carvable gap.
- **Ogre (`ogreThrower`):** Stands along elevated trailside banks and lobs snowballs/boulders in true **3D parabolic world-space arcs** (`pos += vel * dt; velY -= g * dt`), projecting a **high-contrast red/dark-blue landing ring reticle** onto the snow at the predicted impact `groundY(X, Z)`.
- **Yeti (`yetiFlankAmbush`):** Chases and flanks directly along `skier.pos - yeti.pos` seamlessly across segment seams without coordinate transforms. Never attacks invisibly from dead-behind the camera: either ambushes visibly ahead from the treeline with glowing eyes/roar cue, or **flanks into the lower-left / lower-right peripheral camera frame** paired with heavy footstep audio and a pulsing bottom-edge HUD warning indicator.

---

## 12. Extensibility Guides (Adding New Content)

### 12.1 Adding a New Skier Character

1. **Create Visual Asset:** Add a cel-shaded `.glb` mesh or 2.5D sprite atlas to `public/assets/` and declare a `VisualSpec` entry.
2. **Define `SkierDef` in `src/content/characters/`:**
   ```typescript
   export interface SkierDef {
     id: string;
     name: string;
     visual: VisualSpec;
     stats: {
       maxSpeed: number;
       carveGrip: number;
       jumpImpulse: number;
       presentCapacity: number;
       wipeoutRecoverySec: number;
     };
     perk?: { type: 'pickupMagnet' | 'iceGrip' | 'yetiRepellent'; value: number };
   }
   ```
3. **Register & Verify:** Add to the character registry in `src/content/characters/`, preview in `asset-inspector.html`, and verify jump/carve bounds in headless physics tests.

### 12.2 Adding a New Stage / Biome

1. **Define `StageDef` in `src/content/stages/`:** Specify `id`, badge icon (for fork arches), `StageTerrainProfile` (pitch, curve strength clamped \(\le 0.4\), width, banking, moguls, ice ratio), `WeatherProfile`, sky/snow/fog palette, and surface patch weights.
2. **Configure Layout Tracks:** Define `TrackConfig[]` combining `Patterns` (`scatter`, `sequence`, `staggered`, `gate`, `cluster`), `Placements` (`onPath`, `slalom`, `nearEdge`, `middle`), `explicitPlacements`, and any `ChunkTemplate` set-pieces.
3. **Configure Off-Trail Scenery:** Add `TierRule` / `DecorationRule` entries using environmental signals (`elevation`, `slope`, `distFromTrail`) and dual `groundRadius`/`canopyRadius`.
4. **Register in Pacing Director:** Add the stage ID to the stage registry and shuffled deck weights (`breather` vs. `intense`).
5. **Verify:** Inspect lighting, fog, density, and `safeX(s)` clearance in `stage-designer.html`, then run the 50 km headless PCG soak test.

### 12.3 Adding a New Hazard or Creature

1. **Author Asset & `VisualSpec`:** Add the `.glb` or 2.5D billboard sprite to `public/assets/` and verify scale, orientation (facing `-Z` forward), and collider cylinder/height in `asset-inspector.html`.
2. **Register Archetype:** Add a `HazardDef` in `src/content/hazards/` or `CreatureDef` in `src/content/creatures/` (specifying `collider.radius`, jumpable `collider.height`, `impact`, and `telegraph`).
3. **Bind Behavior (Creatures Only):** Combine existing `CreatureLogic` + `CreaturePathStrategy` modules via `CreatureBehaviorConfig`, or add a pure world-space logic/strategy module under `src/sim/` with unit tests.
4. **Add to Stage Tracks:** Reference the new hazard/creature placement rule inside the target `StageDef` tracks.

---

## 13. Developer Tooling, Testing & Verification

### 13.1 Standalone Vite Dev Tools

- **`stage-designer.html`:**
  - Free-fly `MapControls` camera decoupled from the skier.
  - Stage/Biome selector dropdown, hot-reload regeneration button, weather/blizzard intensity slider, time-of-day slider.
  - Click-to-teleport skier, simulation speed slider, **`DebugDrawBuffer` toggle** (renders `safeX(s)` spline, obstacle collider cylinders & jump heights, Delivery Zone radii, fork seam boundaries), and live prop/entity count table.
- **`asset-inspector.html`:**
  - Preview any 3D `.glb` model or 2.5D billboard sprite under toon lighting + smooth-normal outline pass.
  - Scrub GLTF animation clips, inspect wireframe collider cylinder/height overlays, and export/verify collider metadata.

### 13.2 Runtime Telemetry (`Profiler` + `GraphicsTracker`)

Dev overlay displays real-time `dt`, simulation step time, `DrawCalls`, `Triangles`, `Geometries`, `Textures`, `Tracked Resources`, and `Cached vs. Active Primitives` to catch draw-call or allocation regressions early.

### 13.3 Automated Verification Gates

Before considering any feature complete:
1. **Type Check:** `npx tsc --noEmit` must pass with zero errors.
2. **Headless Simulation Unit & Soak Tests (`npm run test:run` via Vitest):**
   - *Spline & Curvature Tests:* Verify up-locked frames, ribbon curvature invariant \(|\kappa|(W_{\text{half}} + W_{\text{skirt}}) \le 0.4\), and fork seam continuity (`κ=0, β=0`, continuous `sampleSurface` elevation/normal across splits).
   - *World-Space Ski Physics & Floating-Origin Tests:* Verify slope acceleration, carving friction, ice drift, 3D ballistic crest launches, jump height clearance, wipeout recovery, and zero-artifact 256m floating-origin rebasing.
   - *50 km PCG Soak Tests:* Simulate **50 km+** of procedural generation across all stages and fork combinations in milliseconds, asserting zero lethal obstacles inside `safeX(s)`, zero post-brow blind traps, guaranteed Delivery Zone cadence (150–250m), and zero NaN/out-of-bounds entities.

---

## 14. Web → Mobile Packaging (Capacitor) & Phased Roadmap

### 14.1 Capacitor iOS & Android Hardening (Phase 3)

Because Capacitor runs the static Vite bundle inside `WKWebView` (iOS) and Android WebView, the following hardening measures are mandatory for 60 fps stability and passing App Store review:

1. **100% Local Offline Bundle:** Package all HTML, JS, CSS, `.glb`, atlases, and audio inside the native app bundle (never point `server.url` at a remote domain—a common cause of Apple Guideline 4.2 rejections).
2. **WebGL Context Loss & App Lifecycle Recovery:**
   - Listen to `webglcontextlost` (`e.preventDefault()`) and `webglcontextrestored` on the canvas to rebuild shared GPU textures/buffers gracefully.
   - Hook `@capacitor/app` `appStateChange` to pause the `requestAnimationFrame` loop on backgrounding and cleanly resume `AudioContext` on foreground return.
3. **Native iOS Audio & Gesture Lock:**
   - Configure `AVAudioSession` in iOS `AppDelegate.swift` with `.ambient` category so the hardware silent switch works properly and players can listen to their own music.
   - Disable `WKWebView` edge-swipe back navigation (`allowsBackForwardNavigationGestures = false`), CSS rubber-band scrolling, and text selection (`touch-action: none; user-select: none; -webkit-touch-callout: none;`), and honor `env(safe-area-inset-*)` for notches and Dynamic Island.
4. **VRAM Ceiling Protection (iOS Jetsam):** Cap textures at 512–1024px (or KTX2 compressed textures), limit active draw calls via `InstancedMesh`, and maintain strict zero-allocation pooling.
5. **Native App Store Value (Guideline 4.2 Compliance):**
   - Wire `@capacitor/haptics` for tactile feedback on present pickups, delivery tosses, big jumps, and wipeouts.
   - Build a **thin custom Swift/Kotlin plugin** (~150 lines) for **Apple Game Center** and **Google Play Games Services** leaderboards/achievements rather than relying on fragile third-party Capacitor plugins.

### 14.2 Phased Implementation Roadmap

- **Phase 1 — Playable Web Vertical Slice (Proof of Feel):**
  - Core loop + fixed `60 Hz` accumulator with `alpha` interpolation (`src/core/`).
  - Track-space trail spline + `sampleSurface` queries, World-Space `(X, Y, Z)` carving/jumping/wipeout-recover physics, 25m crest look-ahead camera rig, and Model B local island splits (`src/sim/`).
  - Shared-material chunked ribbon pool, instanced procedural cartoon props, normal-aligned contact shadows, diegetic backpack present stack, camera-local snow-streak blizzard toggle, and `DebugDrawBuffer` (`src/render/three/`).
  - Core gameplay loop: presents, auto-toss child Delivery Zones, boulders/trees, one world-space patrolling creature (Bear), HTML/CSS HUD + desktop/mobile drag controls, and headless Vitest tests.
- **Phase 2 — Full Mountain & Content Ecosystem:**
  - Model A 4-slot segment forks with 150–200m iconographic arches and soft V-wedge bumpers.
  - Full stage/biome roster (Sunny Meadow, Pine Forest, Blizzard Ridge, Black Diamond Chute, Yeti Peak) with Pacing Director shuffled deck and dual-radius Poisson scenery.
  - Smooth-normal `.glb` + 2.5D cylindrical billboard pipeline, full creature roster (Bear, Ogre, Yeti), character roster with perks, and `stage-designer.html` + `asset-inspector.html`.
- **Phase 3 — Capacitor Mobile Packaging & Store Release:**
  - iOS & Android Capacitor wrappers, lifecycle/WebGL/audio recovery, safe-area polish, `@capacitor/haptics`, thin native Game Center / Play Games bridge, and store QA.

---

### Living Document Maintenance Rule

`DESIGN.md` intentionally documents **architecture, mathematical invariants, dependency boundaries, and declarative schemas** rather than speculative file listings (an exact module/file map should only be added once core subsystems stabilize). Before implementing new subsystems or refactoring existing boundaries:
1. Verify alignment with **Section 3** (tracked GPU resources, zero singletons, zero hot-loop allocations) and **Section 4** (World-Space `(X, Y, Z)` runtime, Track-Space generation, ribbon curvature clamp, `sampleSurface`).
2. Update `DESIGN.md` whenever module boundaries, schemas, or rendering conventions evolve so documentation never drifts from code.
