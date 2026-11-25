import * as THREE from 'three';
import {
  CLIPMAP_GUARD_HALF,
  CLIPMAP_LAYERS,
  CLIPMAP_PATCH_QUADS,
  CLIPMAP_SPACINGS_M,
  CLIPMAP_TEX_MASK,
  CLIPMAP_TEX_SIZE,
  type ClipmapDataStore,
} from './clipmapDataStore';
import type { GraphicsUtils } from './graphicsUtils';
import { positiveMod, type ClipmapShaderUniforms } from './toonMaterials';

export const MAX_CLIPMAP_PATCHES = 512;
export const CLIPMAP_PATCH_VERT_SPAN = CLIPMAP_PATCH_QUADS + 1; // 17
export const CLIPMAP_PATCH_VERTEX_COUNT = CLIPMAP_PATCH_VERT_SPAN * CLIPMAP_PATCH_VERT_SPAN; // 289
export const CLIPMAP_PATCH_TRIANGLE_COUNT = CLIPMAP_PATCH_QUADS * CLIPMAP_PATCH_QUADS * 2; // 512

/**
 * Exact horizontal `distXZ` CDLOD ranges per tier (meters), paired with non-overlapping
 * `CLIPMAP_MORPH_STARTS_M` satisfying BOTH:
 * 1. Strugar non-overlap invariant: `morphStart[L+1] >= lodRange[L] + 32 * spacing[L] * sqrt(2)`
 *    so every shared `L <-> L+1` border vertex has `m_L == 1.0` AND `m_{L+1} == 0.0` (zero cracks!).
 * 2. Toroidal wrap-overflow invariant (`T = 256`, `240x240` committed -> `>= 55.5 m` radius on L0):
 *    - L0 (`0.5 m`, parent `16 m`, diag `22.63 m`): `24 + 22.63 = 46.63 m <= 47.0 m = morphStart[1]` & `<= 52 m`
 *    - L1 (`1.0 m`, parent `32 m`, diag `45.25 m`): `56 + 45.25 = 101.25 m <= 102.0 m = morphStart[2]`
 *    - L2 (`2.0 m`, parent `64 m`, diag `90.51 m`): `116 + 90.51 = 206.51 m <= 208.0 m = morphStart[3]`
 *    - L3 (`4.0 m`, parent `128 m`, diag `181.02 m`): `240 + 181.02 = 421.02 m <= 640.0 m = morphStart[4]`
 *    - L4 (`8.0 m`, root `128 m`, diag `181.02 m`): `640 + 181.02 = 821.02 m <= 832 m`
 */
export const CLIPMAP_LOD_RANGES_M: readonly [number, number, number, number, number] = [
  24, 56, 116, 240, 640,
];

export const CLIPMAP_MORPH_STARTS_M: readonly [number, number, number, number, number] = [
  16.8, 47.0, 102.0, 208.0, 640.0,
];

const ALWAYS_KEEP_NEAR_DIST_M = 24;
const FRUSTUM_Y_PAD_M = 36;
const MORPH_NON_OVERLAP_EPS_M = 0.05;

const _identityMat4 = new THREE.Matrix4();
const _projScreenMat = new THREE.Matrix4();
const _frustum = new THREE.Frustum();
const _nodeBox = new THREE.Box3();

function aabbMinDistXZ(
  px: number,
  pz: number,
  minX: number,
  maxX: number,
  minZ: number,
  maxZ: number,
): number {
  const dx = px < minX ? minX - px : px > maxX ? px - maxX : 0;
  const dz = pz < minZ ? minZ - pz : pz > maxZ ? pz - maxZ : 0;
  return Math.hypot(dx, dz);
}

/**
 * Builds the single static `16 x 16`-quad base CDLOD patch geometry (`289` verts, `512` tris)
 * with integer grid positions `(gx, 0, gz)` and uniform `v00 -> v11` +Y CCW diagonals.
 */
export function buildClipmapPatchBaseGeometry(): THREE.BufferGeometry {
  const positions = new Float32Array(CLIPMAP_PATCH_VERTEX_COUNT * 3);
  const normals = new Float32Array(CLIPMAP_PATCH_VERTEX_COUNT * 3);
  const indices = new Uint16Array(CLIPMAP_PATCH_TRIANGLE_COUNT * 3);

  let vPtr = 0;
  for (let gz = 0; gz < CLIPMAP_PATCH_VERT_SPAN; gz++) {
    for (let gx = 0; gx < CLIPMAP_PATCH_VERT_SPAN; gx++) {
      positions[vPtr] = gx;
      positions[vPtr + 1] = 0;
      positions[vPtr + 2] = gz;
      normals[vPtr] = 0;
      normals[vPtr + 1] = 1;
      normals[vPtr + 2] = 0;
      vPtr += 3;
    }
  }

  let iPtr = 0;
  for (let row = 0; row < CLIPMAP_PATCH_QUADS; row++) {
    const row0 = row * CLIPMAP_PATCH_VERT_SPAN;
    const row1 = (row + 1) * CLIPMAP_PATCH_VERT_SPAN;
    for (let col = 0; col < CLIPMAP_PATCH_QUADS; col++) {
      const v00 = row0 + col;
      const v01 = row0 + col + 1;
      const v10 = row1 + col;
      const v11 = row1 + col + 1;
      // Uniform v00 -> v11 diagonal with right-handed +Y upward CCW winding
      indices[iPtr++] = v00;
      indices[iPtr++] = v10;
      indices[iPtr++] = v11;
      indices[iPtr++] = v00;
      indices[iPtr++] = v11;
      indices[iPtr++] = v01;
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.name = 'TerrainClipmapPatchGeo';
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  return geometry;
}

/**
 * 1-draw-call Instanced CDLOD Terrain Clipmap (`THREE.InstancedMesh` capacity `512`, `16 x 16` base patch)
 * driven by a 5-tier power-of-2 horizontal `distXZ` quadtree (`0.5 m` -> `8.0 m`) with uniform
 * top-down committed-radius & morph-band shrinking (guaranteeing zero T-junctions, zero morph-overlap
 * cracks, zero wrap spikes even under scroll lag) and zero per-frame heap allocations.
 */
export class TerrainClipmap {
  readonly mesh: THREE.InstancedMesh;
  readonly geometry: THREE.BufferGeometry;
  readonly patchWorldArray: Float32Array;
  readonly patchTexArray: Float32Array;
  readonly patchWorldAttr: THREE.InstancedBufferAttribute;
  readonly patchTexAttr: THREE.InstancedBufferAttribute;
  readonly patchCountsByLod = new Int32Array(CLIPMAP_LAYERS);
  readonly effectiveRanges = new Float64Array(CLIPMAP_LAYERS);
  readonly effectiveMorphStarts = new Float64Array(CLIPMAP_LAYERS);

  private readonly gfx: GraphicsUtils;
  private readonly clipmapUniforms: ClipmapShaderUniforms;
  private activePatchCount = 0;

  // Per-frame quadtree traversal context (avoids closures/allocations)
  private curStore!: ClipmapDataStore;
  private curAbsFocusX = 0;
  private curAbsFocusZ = 0;
  private curOriginOffsetX = 0;
  private curOriginOffsetY = 0;
  private curOriginOffsetZ = 0;
  private curRingYOffset = 0;
  private curUseFrustum = false;

  constructor(
    gfx: GraphicsUtils,
    terrainMaterial: THREE.Material,
    clipmapUniforms: ClipmapShaderUniforms,
  ) {
    this.gfx = gfx;
    this.clipmapUniforms = clipmapUniforms;

    this.geometry = buildClipmapPatchBaseGeometry();
    this.patchWorldArray = new Float32Array(MAX_CLIPMAP_PATCHES * 4);
    this.patchTexArray = new Float32Array(MAX_CLIPMAP_PATCHES * 4);

    this.patchWorldAttr = new THREE.InstancedBufferAttribute(this.patchWorldArray, 4);
    this.patchWorldAttr.setUsage(THREE.DynamicDrawUsage);
    this.patchTexAttr = new THREE.InstancedBufferAttribute(this.patchTexArray, 4);
    this.patchTexAttr.setUsage(THREE.DynamicDrawUsage);

    this.geometry.setAttribute('aPatchWorld', this.patchWorldAttr);
    this.geometry.setAttribute('aPatchTex', this.patchTexAttr);
    gfx.markAsCache(this.geometry, 'TerrainClipmapPatchGeo');

    this.mesh = gfx.createInstancedMesh(
      this.geometry,
      terrainMaterial,
      MAX_CLIPMAP_PATCHES,
      'TerrainClipmapMesh',
    );
    this.mesh.frustumCulled = false;
    this.mesh.receiveShadow = true;
    this.mesh.castShadow = false;
    this.mesh.count = 0;

    // Initialize all instance matrices to identity once so built-in Three.js USE_INSTANCING
    // transforms (<defaultnormal_vertex>, <project_vertex>, <worldpos_vertex>) are exact no-ops.
    _identityMat4.identity();
    for (let i = 0; i < MAX_CLIPMAP_PATCHES; i++) {
      this.mesh.setMatrixAt(i, _identityMat4);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  get patchCount(): number {
    return this.activePatchCount;
  }

  get activeTriangleCount(): number {
    return this.activePatchCount * CLIPMAP_PATCH_TRIANGLE_COUNT;
  }

  /**
   * Rebuilds the visible 5-tier CDLOD quadtree patch list around `(focusX, focusZ)` in render space,
   * computes uniform top-down `effectiveRanges` & `effectiveMorphStarts` from `store`'s live committed
   * bounds, updates per-instance attributes (`aPatchWorld`, `aPatchTex`), and syncs shader uniforms.
   * Zero heap allocations.
   */
  update(
    store: ClipmapDataStore,
    focusX: number,
    focusZ: number,
    originOffsetX: number,
    originOffsetY: number,
    originOffsetZ: number,
    camera?: THREE.Camera | null,
  ): void {
    this.curStore = store;
    this.curOriginOffsetX = originOffsetX;
    this.curOriginOffsetY = originOffsetY;
    this.curOriginOffsetZ = originOffsetZ;
    this.curAbsFocusX = focusX + originOffsetX;
    this.curAbsFocusZ = focusZ + originOffsetZ;
    this.curRingYOffset = store.clipmapAnchorAbsY - originOffsetY;

    // Compute uniform per-layer effectiveRanges & effectiveMorphStarts top-down (L = 4..0)
    // so BOTH CPU subdivision AND GPU vertex morphing shrink identically under scroll lag:
    // - Zero per-node fallback rejections -> zero uncollapsed T-junctions
    // - Strict morphStart[L+1] >= effectiveRange[L] + parentDiag[L] -> zero morph-band overlap cracks
    const rootLevel = CLIPMAP_LAYERS - 1;
    const rootSpacing = CLIPMAP_SPACINGS_M[rootLevel]!;
    const rootSizeM = CLIPMAP_PATCH_QUADS * rootSpacing; // 128 m
    const avail4 = this.computeAvailableCommittedRadiusM(store, rootLevel);
    const effRange4 = Math.max(
      0,
      Math.min(CLIPMAP_LOD_RANGES_M[rootLevel]!, avail4 - rootSizeM - rootSpacing),
    );
    this.effectiveRanges[rootLevel] = effRange4;
    this.effectiveMorphStarts[rootLevel] = effRange4;

    for (let L = rootLevel - 1; L >= 0; L--) {
      const s = CLIPMAP_SPACINGS_M[L]!;
      const parentSide = CLIPMAP_PATCH_QUADS * 2 * s; // 32 * s
      const parentDiag = parentSide * Math.SQRT2;
      const avail = this.computeAvailableCommittedRadiusM(store, L);

      const maxByCommitted = avail - parentSide - s;
      const maxByParentMorph = this.effectiveMorphStarts[L + 1]! - parentDiag - MORPH_NON_OVERLAP_EPS_M;
      const effRange = Math.max(
        0,
        Math.min(CLIPMAP_LOD_RANGES_M[L]!, maxByCommitted, maxByParentMorph),
      );

      if (effRange < 2 * s) {
        this.effectiveRanges[L] = 0;
        this.effectiveMorphStarts[L] = 0;
      } else {
        this.effectiveRanges[L] = effRange;
        const baseRange = CLIPMAP_LOD_RANGES_M[L]!;
        const baseStart = CLIPMAP_MORPH_STARTS_M[L]!;
        const scaledStart = baseStart * (effRange / baseRange);
        this.effectiveMorphStarts[L] = Math.max(
          0,
          Math.min(baseStart, scaledStart, effRange - 2 * s),
        );
      }
    }

    // Sync clipmap uniforms (rebase-invariant exact float64 modulo per layer + live effectiveRanges)
    this.clipmapUniforms.uFocusLocalXZ.value.set(focusX, focusZ);
    const layerModArr = this.clipmapUniforms.uLayerOriginModXZ.value;
    const layerInvSpanArr = this.clipmapUniforms.uLayerInvSpan.value;
    const morphEndArr = this.clipmapUniforms.uMorphEnds.value;
    for (let L = 0; L < CLIPMAP_LAYERS; L++) {
      const spanM = CLIPMAP_TEX_SIZE * CLIPMAP_SPACINGS_M[L]!;
      layerModArr[L]!.set(
        positiveMod(originOffsetX, spanM),
        positiveMod(originOffsetZ, spanM),
      );
      layerInvSpanArr[L] = 1 / spanM;
      morphEndArr[L] = this.effectiveRanges[L]!;
    }

    if (camera) {
      camera.updateMatrixWorld();
      _projScreenMat.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
      _frustum.setFromProjectionMatrix(_projScreenMat);
      this.curUseFrustum = true;
    } else {
      this.curUseFrustum = false;
    }

    this.activePatchCount = 0;
    this.patchCountsByLod.fill(0);

    if (effRange4 <= 0) {
      this.mesh.count = 0;
      return;
    }

    // Traverse L4 root grid (128 m cells = 16 L4 texels) covering exact distXZ <= effRange4
    const rootMinX = Math.floor((this.curAbsFocusX - effRange4) / rootSizeM);
    const rootMaxX = Math.floor((this.curAbsFocusX + effRange4) / rootSizeM);
    const rootMinZ = Math.floor((this.curAbsFocusZ - effRange4) / rootSizeM);
    const rootMaxZ = Math.floor((this.curAbsFocusZ + effRange4) / rootSizeM);

    for (let rz = rootMinZ; rz <= rootMaxZ; rz++) {
      const minAbsZ = rz * rootSizeM;
      const maxAbsZ = minAbsZ + rootSizeM;
      for (let rx = rootMinX; rx <= rootMaxX; rx++) {
        const minAbsX = rx * rootSizeM;
        const maxAbsX = minAbsX + rootSizeM;
        const minDistXZ = aabbMinDistXZ(
          this.curAbsFocusX,
          this.curAbsFocusZ,
          minAbsX,
          maxAbsX,
          minAbsZ,
          maxAbsZ,
        );
        if (minDistXZ > effRange4) continue;

        const tx0 = rx * CLIPMAP_PATCH_QUADS;
        const tz0 = rz * CLIPMAP_PATCH_QUADS;
        if (
          !store.isRectCommitted(
            rootLevel,
            tx0,
            tx0 + CLIPMAP_PATCH_QUADS,
            tz0,
            tz0 + CLIPMAP_PATCH_QUADS,
          )
        ) {
          continue;
        }

        this.selectNode(rootLevel, rx, rz, minAbsX, maxAbsX, minAbsZ, maxAbsZ, minDistXZ);
      }
    }

    this.mesh.count = this.activePatchCount;
    this.patchWorldAttr.needsUpdate = true;
    this.patchTexAttr.needsUpdate = true;
  }

  dispose(): void {
    this.gfx.disposeObject(this.mesh);
  }

  /**
   * Computes the minimum horizontal distance (meters) from `(curAbsFocusX, curAbsFocusZ)`
   * to any of the 4 borders of layer `L`'s currently committed toroidal window.
   */
  private computeAvailableCommittedRadiusM(store: ClipmapDataStore, layer: number): number {
    if (!store.isLayerInitialized(layer)) return 0;
    const s = CLIPMAP_SPACINGS_M[layer]!;
    const minTx = store.getLoadedMinTexelX(layer) + CLIPMAP_GUARD_HALF;
    const maxTx = store.getLoadedMinTexelX(layer) + CLIPMAP_TEX_SIZE - CLIPMAP_GUARD_HALF - 1;
    const minTz = store.getLoadedMinTexelZ(layer) + CLIPMAP_GUARD_HALF;
    const maxTz = store.getLoadedMinTexelZ(layer) + CLIPMAP_TEX_SIZE - CLIPMAP_GUARD_HALF - 1;

    const availX = Math.min(this.curAbsFocusX - minTx * s, maxTx * s - this.curAbsFocusX);
    const availZ = Math.min(this.curAbsFocusZ - minTz * s, maxTz * s - this.curAbsFocusZ);
    return Math.max(0, Math.min(availX, availZ));
  }

  private selectNode(
    level: number,
    gridX: number,
    gridZ: number,
    minAbsX: number,
    maxAbsX: number,
    minAbsZ: number,
    maxAbsZ: number,
    minDistXZ: number,
  ): void {
    if (this.activePatchCount >= MAX_CLIPMAP_PATCHES) return;

    if (this.curUseFrustum && minDistXZ > ALWAYS_KEEP_NEAR_DIST_M) {
      const minLocalY = this.curRingYOffset + this.curStore.getLayerMinRelY(level) - FRUSTUM_Y_PAD_M;
      const maxLocalY = this.curRingYOffset + this.curStore.getLayerMaxRelY(level) + FRUSTUM_Y_PAD_M;
      _nodeBox.min.set(
        minAbsX - this.curOriginOffsetX,
        minLocalY,
        minAbsZ - this.curOriginOffsetZ,
      );
      _nodeBox.max.set(
        maxAbsX - this.curOriginOffsetX,
        maxLocalY,
        maxAbsZ - this.curOriginOffsetZ,
      );
      if (!_frustum.intersectsBox(_nodeBox)) {
        return;
      }
    }

    if (level > 0) {
      const childLevel = level - 1;
      const childRange = this.effectiveRanges[childLevel]!;
      // Uniform top-down effectiveRanges guarantees every node with minDistXZ < childRange fits
      // strictly inside store's committed child window without per-node rejections or T-junctions.
      if (childRange > 0 && minDistXZ < childRange) {
        const midAbsX = (minAbsX + maxAbsX) * 0.5;
        const midAbsZ = (minAbsZ + maxAbsZ) * 0.5;
        const cGridX = gridX * 2;
        const cGridZ = gridZ * 2;

        for (let cz = 0; cz < 2; cz++) {
          const cMinZ = cz === 0 ? minAbsZ : midAbsZ;
          const cMaxZ = cz === 0 ? midAbsZ : maxAbsZ;
          for (let cx = 0; cx < 2; cx++) {
            const cMinX = cx === 0 ? minAbsX : midAbsX;
            const cMaxX = cx === 0 ? midAbsX : maxAbsX;
            const cDist = aabbMinDistXZ(
              this.curAbsFocusX,
              this.curAbsFocusZ,
              cMinX,
              cMaxX,
              cMinZ,
              cMaxZ,
            );
            this.selectNode(
              childLevel,
              cGridX + cx,
              cGridZ + cz,
              cMinX,
              cMaxX,
              cMinZ,
              cMaxZ,
              cDist,
            );
          }
        }
        return;
      }
    }

    // Emit leaf patch at `level`
    const idx = this.activePatchCount++;
    const o4 = idx * 4;
    const spacing = CLIPMAP_SPACINGS_M[level]!;
    const absTexelX = gridX * CLIPMAP_PATCH_QUADS;
    const absTexelZ = gridZ * CLIPMAP_PATCH_QUADS;

    this.patchWorldArray[o4] = minAbsX - this.curOriginOffsetX;
    this.patchWorldArray[o4 + 1] = this.curRingYOffset;
    this.patchWorldArray[o4 + 2] = minAbsZ - this.curOriginOffsetZ;
    this.patchWorldArray[o4 + 3] = spacing;

    this.patchTexArray[o4] = (absTexelX | 0) & CLIPMAP_TEX_MASK;
    this.patchTexArray[o4 + 1] = (absTexelZ | 0) & CLIPMAP_TEX_MASK;
    this.patchTexArray[o4 + 2] = level;
    this.patchTexArray[o4 + 3] = this.effectiveMorphStarts[level]!;

    this.patchCountsByLod[level] = this.patchCountsByLod[level]! + 1;
  }
}
