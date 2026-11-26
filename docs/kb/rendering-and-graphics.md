---
title: Rendering Pipeline, CDLOD Clipmap Streaming & GPU Resource Tracking
scope: ThreeRenderer, ClipmapDataStore, TerrainClipmap, SceneryCellStreamer, GraphicsTracker/Utils, toon/outline/billboard shaders, InstancePools, LandmarkStreamer, VFX
tags: [rendering, threejs, cdlod, clipmap, lod, shaders, toon, outlines, billboards, graphics-tracker, scenery, vfx]
source_files:
  - src/render/three/renderer.ts
  - src/render/three/graphicsTracker.ts
  - src/render/three/graphicsUtils.ts
  - src/render/three/clipmapDataStore.ts
  - src/render/three/terrainClipmap.ts
  - src/render/three/sceneryCellStreamer.ts
  - src/render/three/scenerySelector.ts
  - src/render/three/toonMaterials.ts
  - src/render/three/outlineShader.ts
  - src/render/three/smoothNormals.ts
  - src/render/three/billboardMaterial.ts
  - src/render/three/spriteAtlas.ts
  - src/render/three/instancePools.ts
  - src/render/three/landmarkStreamer.ts
  - src/render/three/skierRig.ts
  - src/render/three/backpackStack.ts
  - src/render/three/tossedPresents.ts
  - src/render/three/contactShadows.ts
  - src/render/three/skiTracks.ts
  - src/render/three/carveSprayVfx.ts
  - src/render/three/skyDome.ts
  - src/render/three/snowVfx.ts
  - src/render/three/cameraSync.ts
  - src/render/three/debugOverlay.ts
  - src/render/three/meshFactory.ts
last_verified: 2026-11-25
---

# Rendering Pipeline, Terrain Streaming & GPU Tracking

`src/render/three/` is the **sole layer allowed to import `'three'`**. It consumes `ReadonlySimState` and `EventBus<SimEvents>` read-only, never mutates simulation state, and supports `headless: true` construction in Node/Vitest tests (`renderer.ts:129-154`).

## 1. `ThreeRenderer` Configuration & Sync Pipeline (`src/render/three/renderer.ts`)

- **WebGL Setup:** `WebGLRenderer({ antialias: true, powerPreference: 'high-performance' })`, `pixelRatio = min(dpr, 2)`, `outputColorSpace = THREE.SRGBColorSpace`, `toneMapping = THREE.NoToneMapping` (preserves crisp cartoon colors/snow), `shadowMap.enabled = true`, `shadowMap.type = THREE.BasicShadowMap` (1-tap shadow lookup avoiding the 17-tap `PCFShadowMap` mobile bottleneck in `three@0.181.0`). Handles `webglcontextlost` (`preventDefault`, sets `contextLost = true`) and `webglcontextrestored` (re-flags `shadowMap.needsUpdate`, `skyDome.material.needsUpdate`, `contactShadows.shadowTexture.needsUpdate`, `carveSprayVfx.puffTexture.needsUpdate`, shared materials/textures, and invokes `clipmapStore.handleContextRestored(renderer)` to restore all 4 `DataArrayTexture`s instantaneously from CPU mirrors with zero terrain re-evaluations).
- **Camera (`cameraSync.ts`, `renderer.ts:42-43`):** `PerspectiveCamera(vfov, aspect, CAMERA_NEAR_M = 0.25, CAMERA_FAR_M = 750)` (bumped from `480 m` in M4). `computeVerticalFovDeg()` derives vertical FOV from `minHorizontalFovDeg (66° default + speedFovBoostDeg)` clamped to `[30°, 118°]` (floor `52° + boost*0.6`) so 9:16 portrait phones never crop trail edges.
- **Lighting, Shadow Map & `SkyDome` (`renderer.ts`, `skyDome.ts`):**
  - 1 `HemisphereLight('#bce0fd', '#72a3d4', 0.85)` + 1 `DirectionalLight('#fff6d6', 1.15)` (`castShadow = true`, `intensity = 0.72`, `bias = -0.0008`, `normalBias = 0.08`, `dirLight.target` attached to scene).
  - **Texel-Snapped `1024×1024` Follow-Frustum (`BasicShadowMap`):** Ortho frustum (`±48 m × ±56 m`, `+28 m` forward bias, `-6 m` vertical bias, `near = 10`, `far = 260`) snapped in absolute light-space texel increments (`96/1024`, `112/1024`) to prevent shadow shimmer/crawl across skier motion and `128 m` rebases (`dirLight.shadow.dispose()` on teardown).
  - **Shadow Caster / Receiver Policy:** `TerrainClipmap` **receives only** (`receiveShadow = true, castShadow = false`); 3D skier (`SkierRig` body/skis/arms), `BackpackStack`, 3D instanced props (boulders, presents, ramps), and 3D landmarks (`LandmarkStreamer`) **cast only** (`castShadow = true`); outline hulls, beacon glow meshes, `DynamicBillboardPool`/`StaticSceneryBillboardPool`, `SkyDome`, `CarveSprayVfx`, `SnowVfx`, `SkiTracks`, and `ContactShadows` strictly keep `castShadow = false`.
  - **`SkyDome` (`src/render/three/skyDome.ts`):** Camera-centered sphere (`SKY_DOME_RADIUS_M = 200`, `renderOrder = -1000`, `frustumCulled = false`, `depthWrite = false`, `depthTest = false`, created via `GraphicsUtils.createMesh` with cached geometry/material = 0 GPU leaks) smoothly blending `fogColor` → `StagePalette.skyBottom` → `StagePalette.skyTop` with a warm sun halo + disc aligned to `dirLight`, dimmed by `uBlizzardDim`, and matched in sRGB via `#include <colorspace_fragment>`.
- **`sync(simState, alpha, frameDtSec, budgetMs?)` Order (`renderer.ts:375-528`):**
  1. Rebase/reset reconciliation (handles `sim.reset()` via `tickCount < lastTickCount` / `rebaseCount < lastRebaseCount`, calling `clipmapStore.reset()`, `sceneryStreamer.clearAll()`, `landmarkStreamer.clearAll()`, `carveSprayVfx.reset()`; on `WORLD_REBASED`, `clipmapStore` needs **zero work/uploads**, while `syncNoiseOriginUniforms()` updates modulo `1024`, and `sceneryStreamer`, `landmarkStreamer`, `snowVfx`, `carveSprayVfx`, and `dirLight` shift origins).
  2. `syncPerspectiveCamera` (interpolated `prevCamera -> currCamera` by `alpha`) + `updateDirectionalShadowFrustum(...)`.
  3. `skierRig`, `backpackStack`, `tossedPresents`, `contactShadows`, `skiTracks`, `snowVfx`, `skyDome.sync`, `carveSprayVfx.update`, `debugOverlay`.
  4. `landmarkStreamer.sync(simState.trailWindow)`.
  5. `clipmapStore.update(simState.mountainField, currSkier.posX/Y/Z, this.contextLost ? null : this.renderer, clipBudgetMs)` (`totalBudgetMs = max(DEFAULT_TERRAIN_STREAM_BUDGET_MS (5) - elapsed, 1)`, `DEFAULT_CLIPMAP_STREAM_BUDGET_MS = 4.0`).
  6. `terrainClipmap.update(clipmapStore, interpSkierX, interpSkierZ, originOffsetX, originOffsetY, originOffsetZ, camera)` rebuilds the 1-draw-call CDLOD quadtree patch list and clipmap uniforms.
  7. `sceneryStreamer.step(trailWindow, mountainField, currSkier.posX, currSkier.posZ, camFwdX, camFwdZ, sceneryBudgetMs)` streams decoupled `32 m` scenery cells using remaining budget (`max(0.5, totalBudgetMs - clipElapsedMs)`).
  8. `instancePools.sync(simState, alpha, sceneryStreamer)` (packs dynamic props + decoupled static scenery) → `renderer.render(scene, camera)` + updates `Profiler` counters (`drawCalls`, `triangles`, `activeChunks: terrainClipmap.patchCount`, `trackedObjects`).

---

## 2. `GraphicsTracker` & `GraphicsUtils` (Mandatory GPU Discipline)

All renderable objects and GPU resources must flow through `GraphicsUtils` (`src/render/three/graphicsUtils.ts`):
- **Factories:** `createMesh`, `createInstancedMesh` (auto-sets `frustumCulled = false`), `createLine`, `createPoints`, `cloneObject` (clones hierarchy without cloning geometries/materials), `assignMaterial`, `assignGeometry`, `disposeObject`.
- **Reference Counting (`graphicsTracker.ts`):** Ref-counts `BufferGeometry`, `Material`, and all texture slots on materials (including `material.userData.trackedTextures`, which tracks all 4 `ClipmapDataStore` `DataArrayTexture`s bound via `bindClipmapStoreToMaterial`). When ref-count hits `0`, uncached resources are automatically `.dispose()`d. Shared static resources (toon gradient map, shared materials, procedural mesh assets, sprite atlas, clipmap base patch geometry & `DataArrayTexture`s) are protected via `gfx.markAsCache(...)` until `tracker.disposeAll()`.
- **Leak Verification:** `renderer.runLeakCheck(20, true)` (`renderer.ts:530`, run every 20 s in dev/telemetry builds) flags detached objects older than `minAgeSec`, uncollected resources, and rogue untracked `Object3D`s added directly to `scene`.
- **Static Guardrail:** `graphicsTracker.test.ts:165-180` fails CI if any file in `src/render/three/` (besides `graphicsUtils.ts`) calls `new THREE.Mesh|InstancedMesh|Line|LineSegments|LineLoop|Points`.

---

## 3. Instanced CDLOD Clipmap & Decoupled Scenery (M4)

> **Legacy Removal Note (M4):** Legacy `src/render/three/terrainStreamer.ts` and `src/render/three/terrainTilePool.ts` (2-tier `32 m`/`64 m` CPU tiles with skirts) were **removed in M4** and replaced by `ClipmapDataStore`, `TerrainClipmap`, and `SceneryCellStreamer`.

### 3.1 `ClipmapDataStore` (`src/render/three/clipmapDataStore.ts`)
- **Toroidal 5-Layer `256 × 256 × 5` `DataArrayTexture` Store (`5.00 MiB` VRAM, `generateMipmaps = false`, `unpackAlignment = 1`) + CPU Mirrors:**
  - `CLIPMAP_LAYERS = 5`, `CLIPMAP_SPACINGS_M = [0.5, 1.0, 2.0, 4.0, 8.0]`, `CLIPMAP_TEX_SIZE = 256`, `CLIPMAP_COMMITTED_SIZE = 240`, `CLIPMAP_GUARD_HALF = 8` texels/side.
  - `heightTex` (`RedFormat` / `FloatType` `R32F`, `NearestFilter`, `ClampToEdgeWrapping`, `NoColorSpace`): `absHeight - clipmapAnchorAbsY`.
  - `normalMaskTex` (`RGBAFormat` / `UnsignedByteType` `RGBA8`, `LinearFilter`, `RepeatWrapping`, `NoColorSpace`): `[nx * 0.5 + 0.5, nz * 0.5 + 0.5, pisteWeight, iceWeight]`.
  - `albedoTex` (`RGBAFormat` / `UnsignedByteType` `SRGB8_ALPHA8`, `THREE.SRGBColorSpace`, `LinearFilter`, `RepeatWrapping`): explicit `linearToSRGBChannel` RGB transfer before Uint8 quantization (preventing hardware sRGB decode double-gamma dark snow) + linear `powderWeight` (`max(powderWeight, dividerMask)`).
  - `flowElevTex` (`RGBAFormat` / `UnsignedByteType` `RGBA8`, `LinearFilter`, `RepeatWrapping`, `NoColorSpace`): `[flowX * 0.5 + 0.5, flowZ * 0.5 + 0.5, norm((h - macroY + 40) / 80), aoCavity]` with CPU-baked 4-neighbor Laplacian + chasm cavity AO (`recomputeLaplacianAoRect`).
- **Global Vertical Re-Anchor (`clipmapAnchorAbsY`):** Enforces ONE shared global vertical origin across all 5 layers simultaneously (`reanchorAllLayers` when `|absFocusY - clipmapAnchorAbsY| > CLIPMAP_ANCHOR_RECENTER_THRESHOLD_M (2048 m)`).
- **`three@0.181.0` & WebGL2 Upload Safety (`ensureGpuTexturesInitialized`, `uploadToroidalRect`):**
  - Sets `tex.needsUpdate = true` **before** `renderer.initTexture(tex)` (`#21` S1 guard) on cold boot and `webglcontextrestored`.
  - Incremental strips upload via raw WebGL2 `gl.texSubImage3D` (never `copyTextureToTexture` or scratch `THREE.Texture`s), with zero-alloc `255 → 0` toroidal wrap splitting, zero-copy fast path whenever `w === 256` (`modX = 0, w1 = 256, w2 = 0`), full `UNPACK_*` hygiene (`UNPACK_ALIGNMENT = 1`, `UNPACK_IMAGE_HEIGHT = 0`, `UNPACK_FLIP_Y_WEBGL = 0`, `UNPACK_PREMULTIPLY_ALPHA_WEBGL = 0`, `UNPACK_ROW_LENGTH/SKIP_* = 0`), and `TEXTURE_BINDING_2D_ARRAY` restore without desyncing `WebGLState`.
  - `ThreeRenderer.sync()` passes `this.contextLost ? null : this.renderer` into `clipmapStore.update(...)`.
- **Cold Boot, Scroll Streaming, Bitmask Refinement & Invalidation:**
  - Cold boot evaluates a `17 × 17` coarse grid across `L0..L4` + an exact `48 × 48` (`24 m × 24 m`) `L0` core around the skier (`< 1 cm` parity with `MountainField` on Frame 0).
  - Incremental scrolling uses `MAX_SCROLL_STRIP_STEP = 1`, `REFINE_ROWS_PER_STEP = 1`, and `MAX_DIRTY_TEXELS_PER_STEP = 256`. A 256-bit toroidal `refinedRowMask` (`Uint32Array(5 * 8)`) + `unrefinedRowCount` scanned center-outward via `REFINEMENT_ROW_ORDER` ensures scrolling mid-refinement never skips coarse-seeded rows.
  - Subscribes to `TerrainFieldView.fieldRevision` / `dirtyRects` / `ackDirtyRects?.()` (preserving un-booted layer dirty rects on partial teleports), performs **zero texel evaluations and zero GPU uploads** across fractional `WORLD_REBASED`, and recovers instantaneously on `webglcontextrestored` from CPU mirrors with zero terrain re-evaluations.

### 3.2 `TerrainClipmap` (`src/render/three/terrainClipmap.ts`)
- **1-Draw-Call `InstancedMesh`:** Created via `GraphicsUtils.createInstancedMesh` (`MAX_CLIPMAP_PATCHES = 512`, `frustumCulled = false`, `receiveShadow = true`, `castShadow = false`, static identity instance matrices) over a single static `16 × 16`-quad base patch (`289` verts, `512` tris, uniform `v00 → v11` +Y CCW diagonals, `0` skirts).
- **Non-Overlapping CDLOD Quadtree & Top-Down Sync:**
  - 5-tier power-of-2 horizontal `distXZ` quadtree (`L0 = 0.5 m` .. `L4 = 8.0 m`) with `CLIPMAP_LOD_RANGES_M = [24, 56, 116, 240, 640]` and `CLIPMAP_MORPH_STARTS_M = [16.8, 47.0, 102.0, 208.0, 640.0]` (`L0 farCorner = 46.63 m <= 52 m`, satisfying `morphStart[L+1] >= lodRange[L] + 32 * spacing[L] * sqrt(2)`).
  - Computes `effectiveRanges` and `effectiveMorphStarts` top-down (`L = 4..0`) from `store`'s live committed bounds and syncs them identically to both CPU `selectNode` subdivision and GPU `uMorphEnds` / `aPatchTex.w` (plus hard `isRectCommitted` root failsafe and `float64`-modulo `uLayerOriginModXZ[5]` sync) — guaranteeing **0 cracked vertices (`dXZ < 1e-4, dY < 1e-4`), 0 uncollapsed odd T-junctions, and 0 `lodJump > 1`** in steady-state and under forced scroll lag.
  - Typical active geometry: **`210` frustum-culled patches (`107,520` tris)** (`<= 292–299` patches full 360° unculled vs `512` capacity), `0.5 m` near-field `L0` (`16×` denser than legacy `2 m`), `camera.far = 750 m`.

### 3.3 Decoupled Off-Piste Scenery (`src/render/three/sceneryCellStreamer.ts`, `scenerySelector.ts`)
- **Deterministic `32 m × 32 m` World Grid (`SceneryCellStreamer`):** Implements `SceneryProvider` (`SCENERY_CELL_SIZE_M = 32`, `9 × 9 = 81` cells / `288 m × 288 m`, `+48 m` forward bias, `0.2` hysteresis, `hashCoords2DU32`), querying authoritative `TerrainFieldView` directly (`sampleColumnGrid` / `evaluateColumn` / `evaluate`) — **completely decoupled from CDLOD terrain meshes so off-piste trees/shrubs/rocks never pop during LOD morphing**.
- **Placement & Rebase Rules:** Excludes `onPiste`, `pisteWeight > 0.15`, `inChasmZone`, `normalY < 0.72`, and `TrailWindow` landmark clearance radii; preserves cross-fork per-sample `nearestStageId` biome fidelity, spatial density thinning, dual-radius understory tucking (`groundGridScratch` + `canopyGridScratch`), `computeScenerySlopeSinkY` (`alpine_rock`/`rock_crag` `* 0.45`, `pine_green`/`pine_frosted` `* 0.25`), and translation-only `WORLD_REBASED` (`handleWorldRebased` shifts cell origins with zero heightfield re-evaluations).

---

## 4. Materials, Shaders & Sprite Atlas

- **Shared Toon Materials (`toonMaterials.ts`):**
  - Single `3×1` `NearestFilter` `NoColorSpace` `DataTexture` (`[95, 185, 255]`).
  - Shared lighting uniforms `uBiomeTint`, `uBlizzardDim`, `uSkyTopColor`, `uShadowSnowTint`, `uCliffColor`, and `uNoiseOriginModXZ` / `uNoiseOriginModY` (`NOISE_ORIGIN_MOD_PERIOD = 1024`) patched via `onBeforeCompile` on `propToonMaterial` (`'toon-biome-blizzard-v1'`) and `terrainMaterial` (`'terrain-cdlod-snow-toon-v3'`).
  - **`terrain-cdlod-snow-toon-v3` CDLOD Snow-Toon Hybrid Shader:**
    - **Vertex (`<beginnormal_vertex>`, `<begin_vertex>`, `<project_vertex>`):** `texelFetch(uHeightTex, ...)` Strugar geomorphing (`ivec2(round(aPatchTex.xy))`, `int(round(aPatchTex.z))`, `mix(h0, h1, m)`), vertex `uNormalMaskTex` reconstruction into `objectNormal` **before** `<defaultnormal_vertex>` (so `BasicShadowMap` `shadowNormalBias` uses true terrain normals instead of flat `(0, 1, 0)`), and outputs `vTerrainWorldPos`, `vTerrainWorldNormal`, `vMorph`, `vLodLayer`.
    - **Fragment (`<color_fragment>`, `<normal_fragment_begin>`, `<lights_toon_pars_fragment>`, `<opaque_fragment>`):** Morph-band seam blending (`vMorph > 0.001 && fragLod < 4`) across `uNormalMaskTex`, `uAlbedoTex`, and `uFlowElevTex` using exact texel-center `(localXZ + uLayerOriginModXZ[L]) * uLayerInvSpan[L] + vec2(0.5 / 256.0)` UVs, combined with M2 chromatic alpine snow shading (`uShadowSnowTint` terminator, `0.84 + 0.16 * saturate(ndl)` sunlit gradient, crest Fresnel `uSkyTopColor`, CPU Laplacian + chasm AO).
    - **Rebase-Invariant World-Space Micro-Detail (`NOISE_ORIGIN_MOD_PERIOD = 1024`):** Uses `p = vTerrainWorldPos.xz + uNoiseOriginModXZ` with period-64 / rational `k/16` frequencies and zero `pow(0, y)` NaN hazards: `C¹` `32 m`-tiled flow-aligned **corduroy** (`18–55 m` fade + `fwidth` AA), off-piste **wind sastrugi**, grazing **snow sparkle** (`ndl > 0.45 && dist < 45 m && blizzardDim < 0.5`), glossy **specular cyan ice patches** (`outgoingLight += reflectedLight.directSpecular`), and **stratified granite cliffs** with analytical world-space granite normal perturbation (zero `dFdx × dFdy` triangle faceting).
  - `bindClipmapStoreToMaterial` attaches all 4 `DataArrayTexture`s to `terrainMaterial.userData.trackedTextures` for `GraphicsTracker` ref-counting.
  - `beaconGlowMaterial`: `MeshBasicMaterial` with `fog: false` (`castShadow = false`) so delivery beacons & golden accents pierce blizzard fog.
- **Selective Smooth-Normal Inverted-Hull Outlines (`outlineShader.ts`, `smoothNormals.ts`):**
  - `computeSmoothNormals()` averages normals across coincident quantized positions (`POS_QUANT = 10000`) weighted by triangle interior angles into `aSmoothNormal`, leaving hard `normal` untouched for cel shading.
  - `createSmoothOutlineMaterial()` (`side: THREE.BackSide`, `fog: true`, supports `USE_INSTANCING`) extrudes along `aSmoothNormal` clamped in clip space (`minClipOffset = 0.0025`, `maxClipOffset = 0.016`). Applied to boulders, presents, ramps, and skier body/skis (not landmarks, skier arms, or terrain); outline hulls strictly keep `castShadow = false`.
- **2.5D Cylindrical Billboards (`billboardMaterial.ts`, `spriteAtlas.ts`):**
  - Ground-pivoted `1×1` quad (`y ∈ [0, 1]`). Patches `MeshBasicMaterial` (`alphaTest: 0.5`, `transparent: false`, `depthWrite: true`, `fog: true`, `alphaToCoverage = antialiasEnabled`) to rotate around world `+Y` only, look up per-instance `aUvRect`, and apply `uBiomeTint` / `uBlizzardDim`. Billboards strictly keep `castShadow = false`.
  - `spriteAtlas.ts` builds a `2048×1024` (`8×4` `256 px` grid, `8 px` padding) canvas atlas: `10` procedural sprites (pines, children, bears, shrubs, alpine rocks, rock crags) in rows `0–1`, plus `8` artwork tree sprites loaded asynchronously from `src/render/three/assets/treeSprites.png` (`2048×512`) into rows `2–3` with aspect-preserving UVs, immediate procedural pine fallback silhouettes, and post-load `dilateAtlasEdges()` RGB border dilation to prevent dark mipmap fringes.

---

## 5. Entity Pools, Landmarks & VFX Subsystems

| Subsystem (`src/render/three/`) | Key Capacities / Behavior |
| :--- | :--- |
| `InstancePools` (`instancePools.ts`) | 3D instanced pools + outline companions (`castShadow = true` on 3D meshes, `false` on outlines/billboards): `boulderSmall (128)`, `boulderLarge (96)`, `presentStd (192)`, `presentGold (96)`, `ramp (48)`. 2.5D billboards (`castShadow = false`): `dynamicBillboards (256)` (pine hazards, bears, cheering children), `staticBillboards (4096)` (decoupled `SceneryCellStreamer` cells, repacked only when `sceneryRevision` changes, near-field cells packed first). |
| `LandmarkStreamer` (`landmarkStreamer.ts`) | Reconciles `forkArch`, `delivery_cabin`, `delivery_arch`, `delivery_lantern` (`MAX_ACTIVE_LANDMARKS = 48`) directly from 4-slot `TrailWindowView` (decoupled from terrain tiles). 3D landmark meshes cast shadows (`castShadow = true`, glow accents `false`); supports async `assetWaiter` hook and O(1) pool reuse. |
| `SkierRig` + `BackpackStack` (`skierRig.ts`, `backpackStack.ts`) | Low-poly hierarchical skier (`'YXZ'` Euler, snowplow ski wedge, carve lean, smoothed cross-slope terrain banking on grounded `leftSkiGroup`/`rightSkiGroup`, wipeout tumble, invulnerability blink; `castShadow = true` on skis/body/arms, `false` on outlines) + diegetic `BackpackStack` (`24` slots, 2-column stacking above 6 gifts, pickup pop ease, `castShadow = true`). |
| `TossedPresents` (`tossedPresents.ts`) | `64` std + `64` gold instanced slots rendering `alpha`-interpolated delivery/scatter arcs. |
| `ContactShadows` (`contactShadows.ts`) | `MAX_SHADOWS = 512` (bumped from `384`), `64×64` radial dark-blue `DataTexture`, `polygonOffset: -1`, `depthWrite: false`, terrain-normal aligned (`+0.035 m` along normal), shrinks/fades with airborne clearance. Skier alpha lowered to `0.32` (layers cleanly with directional shadows), and uncollected present shadows align to `mountainField.evaluate` terrain normals (cached per `(posX, posZ)`). |
| `SkiTracks` (`skiTracks.ts`, `skiPhysics.ts`) | `512`-sample twin-ski dynamic ribbon (`opacity: 0.45`, `4.5 s` fade, `polygonOffset: -2`, `+0.025 m` normal offset); `skiPhysics.ts` projects `rightY` onto the terrain tangent plane (`-(rightX * nx + rightZ * nz) / Math.max(0.35, ny)` + normalize), and `SkiTracks` renders a recessed carved-groove shader (cross-track UV shading with shadowed inner trough, sunlit snow lip, carve/brake width & intensity modulation, feathered age fade); collapses zero-area triangles on `!grounded` or `> 6 m` gaps. |
| `CarveSprayVfx` (`carveSprayVfx.ts`) | `MAX_CARVE_SPRAY_PARTICLES = 384` pooled instanced quads (`GraphicsUtils.createInstancedMesh`, `frustumCulled = false`, `castShadow = false`, `receiveShadow = false`, cached `32×32` `DataTexture`/geo/mat), zero hot-loop allocations (`Float32Array` state + module scratches); emits outside-ski carve/brake spray tinted by `powder`/`packed`/`ice`/`rock` + airborne→grounded touchdown burst, supporting `shiftOrigin(dx, dy, dz)`, `reset()`, and `dispose()`. |
| `SnowVfx` (`snowVfx.ts`) | `MAX_SNOW_PARTICLES = 250` camera-local wrapping box (`36×18×36 m`) of wind-tilted streaks; manages `FogExp2` (`density = 1.6 / max(65, fogDist)`), exposes `skyBottomColor`/`skyTopColor`, smoothly lerps `uSkyTopColor` and `uShadowSnowTint` from `StagePalette` with blizzard dimming, and updates `uBiomeTint`/`uBlizzardDim`. |
| `DebugOverlay3D` (`debugOverlay.ts`) | Renders `DebugDrawView` (`G` key): `safeX` green line, collider wireframes (amber stumble, red lethal, magenta creature), yellow delivery rings, orange fork V-wedges, cyan chunk lines, skier normal/downhill/velocity vectors (`MAX_LINE_VERTICES = 4096`, `MAX_COLLIDERS = 160`). |

---

## 6. Visual-vs-Physics Parity & Fidelity Gaps (Summary)

Full details in [known-issues-and-evaluation.md](./known-issues-and-evaluation.md):
- **Phase 1 Visual Fidelity & Contact Parity — RESOLVED (M2):** Snow-toon hybrid shader, `SkyDome`, `1024×1024` texel-snapped `BasicShadowMap`, `CarveSprayVfx`, `SkiTracks` `rightY` projection + groove shader, `SkierRig` cross-slope banking, `ContactShadows` (`512` cap, `0.32` skier alpha, present normals), and `scenerySelector.ts` pine slope-sinking.
- **Phase 2 CDLOD Geometry, Mesh Density & Cache Invalidation — RESOLVED (M4):** 1-draw-call `0.5 m` instanced `TerrainClipmap` (`107,520` frustum-culled tris, `0` skirts, `camera.far = 750 m`) + `ClipmapDataStore` (`5.00 MiB` `256×256×5` toroidal `DataArrayTexture`s, `fieldRevision`/`dirtyRects` invalidation, `< 1 cm` L0 parity) + `terrain-cdlod-snow-toon-v3` vertex geomorphing & `objectNormal` alignment (`0` cracked vertices, `0` uncollapsed odd T-junctions) + decoupled `32 m` `SceneryCellStreamer` (`0` LOD-morph prop pops).

---

## 7. Gotchas / Don't Break

- **Never add world-space procedural shader detail without passing `uNoiseOriginModXZ/Y` (`NOISE_ORIGIN_MOD_PERIOD = 1024`, rational `k/16` frequencies)** — otherwise textures/noise visibly swim every `128 m` rebase or `1024 m` wrap!
- **Never omit `tex.needsUpdate = true` before `renderer.initTexture(tex)` or use `copyTextureToTexture` on `DataArrayTexture`s** — `three@0.181.0` leaves GPU storage unallocated or skips updates; keep raw `gl.texSubImage3D` + full `UNPACK_*` resets and `linearToSRGBChannel` encoding for `albedoTex`.
- **Never desync `TerrainClipmap` `effectiveRanges` / `effectiveMorphStarts` between CPU quadtree and GPU `uMorphEnds` / `aPatchTex.w` or overlap `CLIPMAP_MORPH_STARTS_M`** — cracks or T-junctions will open across `L ↔ L+1` borders under scroll lag.
- **Never couple `SceneryCellStreamer` to terrain LOD rings** — always query `TerrainFieldView` directly so off-piste props remain LOD-morph invariant.
- **Never bypass `GraphicsUtils` or forget `markAsCache()` / `userData.trackedTextures`** — `graphicsTracker.test.ts` and the 20 s runtime leak detector will flag it.
- **Never enable `frustumCulled = true` on `InstancedMesh` pools, `TerrainClipmap`, `SkyDome`, or `CarveSprayVfx`** — entities vanish unpredictably as the camera moves away from `(0, 0, 0)`.
- **Never set `castShadow = true` on billboards, outline hulls, glow meshes, or terrain** — billboards cast flat card shadows, outlines self-shadow faces, and terrain self-shadowing triggers `BasicShadowMap` acne.
- **Keep `ThreeRenderer` Node-safe (`headless: true`)** — `terrainAndRenderer.test.ts` runs the full renderer pipeline without a WebGL context.
