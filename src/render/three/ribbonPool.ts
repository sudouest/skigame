import * as THREE from 'three';
import { getStageDef, STAGE_SUNNY_BLUE } from '../../content/stages';
import type { StagePalette } from '../../content/types';
import { clamp } from '../../core/math';
import {
  createRibbonPointOut,
  createSpineFrameOut,
  type TerrainSegmentView,
} from '../../sim/contracts';
import type { GraphicsUtils } from './graphicsUtils';

export const RIBBON_POOL_CAPACITY = 48;
export const RIBBON_ROWS = 18;
export const RIBBON_COLS = 20;
export const RIBBON_VERT_ROWS = RIBBON_ROWS + 1;
export const RIBBON_VERT_COLS = RIBBON_COLS + 1;
const VERTS_PER_CHUNK = RIBBON_VERT_ROWS * RIBBON_VERT_COLS;
const INDICES_PER_CHUNK = RIBBON_ROWS * RIBBON_COLS * 6;

export interface RibbonChunkSlot {
  readonly index: number;
  readonly container: THREE.Group;
  readonly mesh: THREE.Mesh;
  readonly geometry: THREE.BufferGeometry;
  readonly positions: Float32Array;
  readonly normals: Float32Array;
  readonly colors: Float32Array;
  readonly posAttr: THREE.BufferAttribute;
  readonly normAttr: THREE.BufferAttribute;
  readonly colAttr: THREE.BufferAttribute;
  inUse: boolean;
  ready: boolean;
  segmentId: number;
  chunkIndex: number;
  startS: number;
  endS: number;
  originX: number;
  originY: number;
  originZ: number;
  positionUploadCount: number;
}

interface ParsedStageColors {
  readonly snow: THREE.Color;
  readonly shadowSnow: THREE.Color;
  readonly bank: THREE.Color;
  readonly ice: THREE.Color;
  readonly powder: THREE.Color;
}

const _scratchSpine = createSpineFrameOut();
const _scratchRibbon = createRibbonPointOut();
const _scratchColor = new THREE.Color();
const _scratchDividerTint = new THREE.Color('#dbeafe');

function buildPaletteColors(palette: StagePalette): ParsedStageColors {
  return {
    snow: new THREE.Color(palette.snowColor),
    shadowSnow: new THREE.Color(palette.shadowSnowTint),
    bank: new THREE.Color(palette.bankTint),
    ice: new THREE.Color(palette.iceTint),
    powder: new THREE.Color(palette.powderTint),
  };
}

/**
 * Pre-allocates 32 reusable 35m ribbon chunk meshes sharing a single vertex-colored MeshToonMaterial.
 * All vertices are authored relative to each chunk's local origin (`container.position`) so
 * `WORLD_REBASED` translates only chunk container transforms with ZERO vertex buffer re-uploads.
 */
export class RibbonPool {
  readonly rootGroup: THREE.Group;
  private readonly slots: RibbonChunkSlot[] = [];
  private readonly freeIndices: number[] = [];
  private readonly stageColorCache = new Map<string, ParsedStageColors>();
  private readonly defaultColors: ParsedStageColors;
  private readonly sharedIndexAttr: THREE.Uint16BufferAttribute;

  constructor(
    gfx: GraphicsUtils,
    terrainMaterial: THREE.Material,
    capacity = RIBBON_POOL_CAPACITY,
  ) {
    this.rootGroup = new THREE.Group();
    this.rootGroup.name = 'RibbonPoolRoot';
    this.defaultColors = buildPaletteColors(STAGE_SUNNY_BLUE.palette);

    const indexArray = new Uint16Array(INDICES_PER_CHUNK);
    let ptr = 0;
    for (let r = 0; r < RIBBON_ROWS; r++) {
      const row0 = r * RIBBON_VERT_COLS;
      const row1 = (r + 1) * RIBBON_VERT_COLS;
      for (let c = 0; c < RIBBON_COLS; c++) {
        const v00 = row0 + c;
        const v01 = row0 + c + 1;
        const v10 = row1 + c;
        const v11 = row1 + c + 1;
        // Right-handed +Y upward CCW winding: (u increases right +X, s increases forward -Z)
        indexArray[ptr++] = v00;
        indexArray[ptr++] = v01;
        indexArray[ptr++] = v11;
        indexArray[ptr++] = v00;
        indexArray[ptr++] = v11;
        indexArray[ptr++] = v10;
      }
    }
    this.sharedIndexAttr = new THREE.Uint16BufferAttribute(indexArray, 1);

    for (let i = 0; i < capacity; i++) {
      const positions = new Float32Array(VERTS_PER_CHUNK * 3);
      const normals = new Float32Array(VERTS_PER_CHUNK * 3);
      const colors = new Float32Array(VERTS_PER_CHUNK * 3);

      const posAttr = new THREE.Float32BufferAttribute(positions, 3);
      const normAttr = new THREE.Float32BufferAttribute(normals, 3);
      const colAttr = new THREE.Float32BufferAttribute(colors, 3);

      const geometry = new THREE.BufferGeometry();
      geometry.name = `RibbonChunkGeo_${i}`;
      geometry.setAttribute('position', posAttr);
      geometry.setAttribute('normal', normAttr);
      geometry.setAttribute('color', colAttr);
      geometry.setIndex(this.sharedIndexAttr);

      const container = new THREE.Group();
      container.name = `RibbonChunkContainer_${i}`;
      container.visible = false;

      const mesh = gfx.createMesh(geometry, terrainMaterial, `RibbonChunkMesh_${i}`);
      mesh.receiveShadow = false;
      mesh.castShadow = false;
      gfx.markAsCache(mesh, `RibbonChunkMesh_${i}`);
      container.add(mesh);
      this.rootGroup.add(container);

      this.slots.push({
        index: i,
        container,
        mesh,
        geometry,
        positions,
        normals,
        colors,
        posAttr,
        normAttr,
        colAttr,
        inUse: false,
        ready: false,
        segmentId: -1,
        chunkIndex: -1,
        startS: 0,
        endS: 0,
        originX: 0,
        originY: 0,
        originZ: 0,
        positionUploadCount: 0,
      });
    }

    for (let i = capacity - 1; i >= 0; i--) {
      this.freeIndices.push(i);
    }
  }

  get capacity(): number {
    return this.slots.length;
  }

  get activeCount(): number {
    return this.slots.length - this.freeIndices.length;
  }

  getSlot(index: number): RibbonChunkSlot | undefined {
    return this.slots[index];
  }

  acquireSlot(
    segment: TerrainSegmentView,
    chunkIndex: number,
    startS: number,
    endS: number,
  ): RibbonChunkSlot | null {
    const idx = this.freeIndices.pop();
    if (idx === undefined) return null;

    const slot = this.slots[idx]!;
    segment.sampleSpineFrame(startS, _scratchSpine);

    slot.inUse = true;
    slot.ready = false;
    slot.segmentId = segment.id;
    slot.chunkIndex = chunkIndex;
    slot.startS = startS;
    slot.endS = endS;
    slot.originX = _scratchSpine.posX;
    slot.originY = _scratchSpine.posY;
    slot.originZ = _scratchSpine.posZ;
    slot.container.position.set(slot.originX, slot.originY, slot.originZ);
    slot.container.visible = false;
    return slot;
  }

  /**
   * Populates a single longitudinal row of vertices using `TerrainSegmentView.evaluateRibbonPoint(s, u, out)`
   * relative to the chunk's local origin, with zero heap allocations.
   */
  writeRow(slot: RibbonChunkSlot, segment: TerrainSegmentView, row: number): void {
    const tS = row / RIBBON_ROWS;
    const s = slot.startS + (slot.endS - slot.startS) * tS;
    const colors = this.getStageColors(segment.stageId);
    const rowBase = row * RIBBON_VERT_COLS;

    for (let col = 0; col < RIBBON_VERT_COLS; col++) {
      // Normalized transverse u in [-1, 1]; segment.evaluateRibbonPoint applies non-linear spacing.
      const u = -1 + (2 * col) / RIBBON_COLS;
      segment.evaluateRibbonPoint(s, u, _scratchRibbon);

      const vIdx3 = (rowBase + col) * 3;
      slot.positions[vIdx3] = _scratchRibbon.posX - slot.originX;
      slot.positions[vIdx3 + 1] = _scratchRibbon.posY - slot.originY;
      slot.positions[vIdx3 + 2] = _scratchRibbon.posZ - slot.originZ;

      // Normalize normal defensively
      const nx = _scratchRibbon.normalX;
      const ny = _scratchRibbon.normalY;
      const nz = _scratchRibbon.normalZ;
      const nLen = Math.hypot(nx, ny, nz) || 1;
      slot.normals[vIdx3] = nx / nLen;
      slot.normals[vIdx3 + 1] = ny / nLen;
      slot.normals[vIdx3 + 2] = nz / nLen;

      // Surface & corridor vertex coloring
      if (_scratchRibbon.inDivider) {
        _scratchColor.copy(colors.bank).lerp(_scratchDividerTint, 0.35);
      } else if (!_scratchRibbon.inPlayableCorridor) {
        const edgeRatio = clamp(
          (Math.abs(_scratchRibbon.lateralX) - _scratchRibbon.halfWidth) /
            Math.max(1, _scratchRibbon.skirtWidth),
          0,
          1,
        );
        _scratchColor.copy(colors.bank).lerp(colors.shadowSnow, edgeRatio * 0.55);
      } else if (_scratchRibbon.surfaceType === 'ice') {
        _scratchColor.copy(colors.ice);
      } else if (_scratchRibbon.surfaceType === 'powder') {
        _scratchColor.copy(colors.powder);
      } else {
        // Subtle groomed corduroy/edge depth shading across the playable corridor
        const edgeFade = clamp(Math.abs(_scratchRibbon.lateralX) / Math.max(1, _scratchRibbon.halfWidth), 0, 1);
        _scratchColor.copy(colors.snow).lerp(colors.shadowSnow, edgeFade * 0.14);
      }

      if (_scratchRibbon.isInnerForkSlope) {
        _scratchColor.lerp(colors.snow, 0.5);
      }

      slot.colors[vIdx3] = _scratchColor.r;
      slot.colors[vIdx3 + 1] = _scratchColor.g;
      slot.colors[vIdx3 + 2] = _scratchColor.b;
    }
  }

  finishSlot(slot: RibbonChunkSlot): void {
    slot.posAttr.needsUpdate = true;
    slot.normAttr.needsUpdate = true;
    slot.colAttr.needsUpdate = true;
    slot.positionUploadCount++;
    slot.geometry.computeBoundingSphere();
    slot.geometry.computeBoundingBox();
    slot.ready = true;
    slot.container.visible = true;
  }

  releaseSlot(slot: RibbonChunkSlot): void {
    if (!slot.inUse) return;
    slot.inUse = false;
    slot.ready = false;
    slot.segmentId = -1;
    slot.chunkIndex = -1;
    slot.container.visible = false;
    this.freeIndices.push(slot.index);
  }

  /**
   * Translation-only floating-origin rebase handler:
   * Translates ONLY chunk container transforms with ZERO vertex buffer re-uploads.
   */
  shiftAllOrigins(deltaX: number, deltaY: number, deltaZ: number): void {
    for (let i = 0; i < this.slots.length; i++) {
      const slot = this.slots[i]!;
      if (!slot.inUse) continue;
      slot.originX -= deltaX;
      slot.originY -= deltaY;
      slot.originZ -= deltaZ;
      slot.container.position.set(slot.originX, slot.originY, slot.originZ);
    }
  }

  private getStageColors(stageId: string): ParsedStageColors {
    let cached = this.stageColorCache.get(stageId);
    if (!cached) {
      const stage = getStageDef(stageId);
      cached = stage ? buildPaletteColors(stage.palette) : this.defaultColors;
      this.stageColorCache.set(stageId, cached);
    }
    return cached;
  }
}
