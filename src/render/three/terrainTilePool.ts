import * as THREE from 'three';
import { getStageDef, STAGE_SUNNY_BLUE } from '../../content/stages';
import type { StagePalette } from '../../content/types';
import { clamp, lerp, smoothstep } from '../../core/math';
import {
  createMountainColumnOut,
  type MountainColumnOut,
  type MountainFieldView,
  type SpineView,
} from '../../sim/contracts';
import type { GraphicsUtils } from './graphicsUtils';

export type TerrainLodTier = 0 | 1;

export const INNER_TILE_SIZE_M = 32;
export const INNER_TILE_QUADS = 16;
export const INNER_TILE_SPACING_M = 2;
export const INNER_TILE_VERT_SPAN = INNER_TILE_QUADS + 1; // 17
export const INNER_TILE_SKIRT_DEPTH_M = 4.0;
export const INNER_TILE_POOL_CAPACITY = 48;

export const OUTER_TILE_SIZE_M = 64;
export const OUTER_TILE_QUADS = 8;
export const OUTER_TILE_SPACING_M = 8;
export const OUTER_TILE_VERT_SPAN = OUTER_TILE_QUADS + 1; // 9
export const OUTER_TILE_SKIRT_DEPTH_M = 12.0;
export const OUTER_TILE_POOL_CAPACITY = 96;

const SPINE_BOUNDS_PAD_M = 310;

export interface TerrainLodSpec {
  readonly lod: TerrainLodTier;
  readonly tileSize: number;
  readonly quads: number;
  readonly spacing: number;
  readonly vertSpan: number;
  readonly haloSpan: number;
  readonly skirtDepth: number;
  readonly topVertexCount: number;
  readonly totalVertexCount: number;
  readonly topIndexCount: number;
  readonly totalIndexCount: number;
}

function makeLodSpec(
  lod: TerrainLodTier,
  tileSize: number,
  quads: number,
  spacing: number,
  skirtDepth: number,
): TerrainLodSpec {
  const vertSpan = quads + 1;
  const haloSpan = quads + 3;
  const topVertexCount = vertSpan * vertSpan;
  const totalVertexCount = topVertexCount + 4 * vertSpan;
  const topIndexCount = quads * quads * 6;
  const totalIndexCount = topIndexCount + 4 * quads * 6;
  return {
    lod,
    tileSize,
    quads,
    spacing,
    vertSpan,
    haloSpan,
    skirtDepth,
    topVertexCount,
    totalVertexCount,
    topIndexCount,
    totalIndexCount,
  };
}

export const TERRAIN_LOD_SPECS: readonly [TerrainLodSpec, TerrainLodSpec] = [
  makeLodSpec(
    0,
    INNER_TILE_SIZE_M,
    INNER_TILE_QUADS,
    INNER_TILE_SPACING_M,
    INNER_TILE_SKIRT_DEPTH_M,
  ),
  makeLodSpec(
    1,
    OUTER_TILE_SIZE_M,
    OUTER_TILE_QUADS,
    OUTER_TILE_SPACING_M,
    OUTER_TILE_SKIRT_DEPTH_M,
  ),
];

export interface TerrainTileSlot {
  readonly index: number;
  readonly lod: TerrainLodTier;
  readonly spec: TerrainLodSpec;
  readonly container: THREE.Group;
  readonly mesh: THREE.Mesh;
  readonly geometry: THREE.BufferGeometry;
  readonly positions: Float32Array;
  readonly normals: Float32Array;
  readonly colors: Float32Array;
  readonly posAttr: THREE.BufferAttribute;
  readonly normAttr: THREE.BufferAttribute;
  readonly colAttr: THREE.BufferAttribute;
  readonly relHeights: Float32Array;
  readonly baseColors: Float32Array;
  readonly cliffColors: Float32Array;
  readonly isPisteMask: Uint8Array;
  readonly isChasmMask: Uint8Array;
  readonly candidateSpines: SpineView[];
  inUse: boolean;
  ready: boolean;
  absTileX: number;
  absTileZ: number;
  originX: number;
  originY: number;
  originZ: number;
  positionUploadCount: number;
}

export interface TerrainTilePoolOptions {
  readonly innerCapacity?: number;
  readonly outerCapacity?: number;
}

interface ParsedStageColors {
  readonly snow: THREE.Color;
  readonly shadowSnow: THREE.Color;
  readonly bank: THREE.Color;
  readonly ice: THREE.Color;
  readonly powder: THREE.Color;
  readonly cliff: THREE.Color;
  readonly chasmFloor: THREE.Color;
}

const _scratchCol: MountainColumnOut = createMountainColumnOut();
const _scratchColorA = new THREE.Color();
const _scratchColorB = new THREE.Color();
const _scratchCliffColor = new THREE.Color();
const _scratchDividerTint = new THREE.Color('#dbeafe');

function buildPaletteColors(palette: StagePalette): ParsedStageColors {
  return {
    snow: new THREE.Color(palette.snowColor),
    shadowSnow: new THREE.Color(palette.shadowSnowTint),
    bank: new THREE.Color(palette.bankTint),
    ice: new THREE.Color(palette.iceTint),
    powder: new THREE.Color(palette.powderTint),
    cliff: new THREE.Color(palette.cliffColor),
    chasmFloor: new THREE.Color(palette.chasmFloorColor ?? palette.cliffColor),
  };
}

function buildSharedIndexAttribute(spec: TerrainLodSpec): THREE.BufferAttribute {
  const indices = new Uint16Array(spec.totalIndexCount);
  const { quads, vertSpan, topVertexCount } = spec;
  let ptr = 0;

  // Top surface grid: col along +X, row along +Z, right-handed +Y upward CCW winding
  for (let row = 0; row < quads; row++) {
    const row0 = row * vertSpan;
    const row1 = (row + 1) * vertSpan;
    for (let col = 0; col < quads; col++) {
      const v00 = row0 + col;
      const v01 = row0 + col + 1;
      const v10 = row1 + col;
      const v11 = row1 + col + 1;
      indices[ptr++] = v00;
      indices[ptr++] = v10;
      indices[ptr++] = v11;
      indices[ptr++] = v00;
      indices[ptr++] = v11;
      indices[ptr++] = v01;
    }
  }

  // Perimeter skirts (outward-facing CCW triangles dropping -skirtDepth below border edges)
  const northStart = topVertexCount;
  const southStart = topVertexCount + vertSpan;
  const westStart = topVertexCount + vertSpan * 2;
  const eastStart = topVertexCount + vertSpan * 3;

  // North edge (row = 0, outward -Z)
  for (let col = 0; col < quads; col++) {
    const t0 = col;
    const t1 = col + 1;
    const b0 = northStart + col;
    const b1 = northStart + col + 1;
    indices[ptr++] = t0;
    indices[ptr++] = t1;
    indices[ptr++] = b1;
    indices[ptr++] = t0;
    indices[ptr++] = b1;
    indices[ptr++] = b0;
  }

  // South edge (row = quads, outward +Z)
  const southRow = quads * vertSpan;
  for (let col = 0; col < quads; col++) {
    const t0 = southRow + col;
    const t1 = southRow + col + 1;
    const b0 = southStart + col;
    const b1 = southStart + col + 1;
    indices[ptr++] = t0;
    indices[ptr++] = b0;
    indices[ptr++] = b1;
    indices[ptr++] = t0;
    indices[ptr++] = b1;
    indices[ptr++] = t1;
  }

  // West edge (col = 0, outward -X)
  for (let row = 0; row < quads; row++) {
    const t0 = row * vertSpan;
    const t1 = (row + 1) * vertSpan;
    const b0 = westStart + row;
    const b1 = westStart + row + 1;
    indices[ptr++] = t0;
    indices[ptr++] = b0;
    indices[ptr++] = b1;
    indices[ptr++] = t0;
    indices[ptr++] = b1;
    indices[ptr++] = t1;
  }

  // East edge (col = quads, outward +X)
  for (let row = 0; row < quads; row++) {
    const t0 = row * vertSpan + quads;
    const t1 = (row + 1) * vertSpan + quads;
    const b0 = eastStart + row;
    const b1 = eastStart + row + 1;
    indices[ptr++] = t0;
    indices[ptr++] = t1;
    indices[ptr++] = b1;
    indices[ptr++] = t0;
    indices[ptr++] = b1;
    indices[ptr++] = b0;
  }

  return new THREE.BufferAttribute(indices, 1);
}

/**
 * Pre-allocates two world-grid LOD tiers (`32m` inner @ `2m` spacing, `64m` outer @ `8m` spacing)
 * of reusable terrain tiles sharing `terrainMaterial`.
 * Vertices store local heights relative to each tile's `originY` so `WORLD_REBASED` translates
 * only tile container transforms with ZERO vertex buffer re-uploads and zero mid-stream tearing.
 */
export class TerrainTilePool {
  readonly rootGroup: THREE.Group;

  private readonly slotsByLod: [TerrainTileSlot[], TerrainTileSlot[]] = [[], []];
  private readonly freeIndicesByLod: [number[], number[]] = [[], []];
  private readonly sharedIndexByLod: readonly [THREE.BufferAttribute, THREE.BufferAttribute];
  private readonly stageColorCache = new Map<string, ParsedStageColors>();
  private readonly defaultColors: ParsedStageColors;

  constructor(
    gfx: GraphicsUtils,
    terrainMaterial: THREE.Material,
    options: TerrainTilePoolOptions = {},
  ) {
    this.rootGroup = new THREE.Group();
    this.rootGroup.name = 'TerrainTilePoolRoot';
    this.defaultColors = buildPaletteColors(STAGE_SUNNY_BLUE.palette);

    this.sharedIndexByLod = [
      buildSharedIndexAttribute(TERRAIN_LOD_SPECS[0]),
      buildSharedIndexAttribute(TERRAIN_LOD_SPECS[1]),
    ];

    const capacities: readonly [number, number] = [
      Math.max(1, options.innerCapacity ?? INNER_TILE_POOL_CAPACITY),
      Math.max(1, options.outerCapacity ?? OUTER_TILE_POOL_CAPACITY),
    ];

    for (let lodIdx = 0; lodIdx < 2; lodIdx++) {
      const lod = lodIdx as TerrainLodTier;
      const spec = TERRAIN_LOD_SPECS[lod];
      const cap = capacities[lod];
      const sharedIndex = this.sharedIndexByLod[lod];
      const slots = this.slotsByLod[lod];
      const freeList = this.freeIndicesByLod[lod];
      const haloCount = spec.haloSpan * spec.haloSpan;

      for (let i = 0; i < cap; i++) {
        const positions = new Float32Array(spec.totalVertexCount * 3);
        const normals = new Float32Array(spec.totalVertexCount * 3);
        const colors = new Float32Array(spec.totalVertexCount * 3);

        const posAttr = new THREE.BufferAttribute(positions, 3);
        posAttr.setUsage(THREE.DynamicDrawUsage);
        const normAttr = new THREE.BufferAttribute(normals, 3);
        normAttr.setUsage(THREE.DynamicDrawUsage);
        const colAttr = new THREE.BufferAttribute(colors, 3);
        colAttr.setUsage(THREE.DynamicDrawUsage);

        const geometry = new THREE.BufferGeometry();
        geometry.name = `TerrainTileGeo_L${lod}_${i}`;
        geometry.setAttribute('position', posAttr);
        geometry.setAttribute('normal', normAttr);
        geometry.setAttribute('color', colAttr);
        geometry.setIndex(sharedIndex);

        const container = new THREE.Group();
        container.name = `TerrainTileContainer_L${lod}_${i}`;
        container.visible = false;

        const mesh = gfx.createMesh(geometry, terrainMaterial, `TerrainTileMesh_L${lod}_${i}`);
        mesh.receiveShadow = false;
        mesh.castShadow = false;
        gfx.markAsCache(mesh, mesh.name);
        container.add(mesh);
        this.rootGroup.add(container);

        slots.push({
          index: i,
          lod,
          spec,
          container,
          mesh,
          geometry,
          positions,
          normals,
          colors,
          posAttr,
          normAttr,
          colAttr,
          relHeights: new Float32Array(haloCount),
          baseColors: new Float32Array(haloCount * 3),
          cliffColors: new Float32Array(haloCount * 3),
          isPisteMask: new Uint8Array(haloCount),
          isChasmMask: new Uint8Array(haloCount),
          candidateSpines: [],
          inUse: false,
          ready: false,
          absTileX: 0,
          absTileZ: 0,
          originX: 0,
          originY: 0,
          originZ: 0,
          positionUploadCount: 0,
        });
      }

      for (let i = cap - 1; i >= 0; i--) {
        freeList.push(i);
      }
    }
  }

  get innerCapacity(): number {
    return this.slotsByLod[0].length;
  }

  get outerCapacity(): number {
    return this.slotsByLod[1].length;
  }

  get innerActiveCount(): number {
    return this.slotsByLod[0].length - this.freeIndicesByLod[0].length;
  }

  get outerActiveCount(): number {
    return this.slotsByLod[1].length - this.freeIndicesByLod[1].length;
  }

  get activeCount(): number {
    return this.innerActiveCount + this.outerActiveCount;
  }

  getSlot(lod: TerrainLodTier, index: number): TerrainTileSlot | undefined {
    return this.slotsByLod[lod][index];
  }

  acquireSlot(
    lod: TerrainLodTier,
    absTileX: number,
    absTileZ: number,
    mountainField: MountainFieldView,
  ): TerrainTileSlot | null {
    const idx = this.freeIndicesByLod[lod].pop();
    if (idx === undefined) return null;

    const slot = this.slotsByLod[lod][idx]!;
    this.beginTile(slot, absTileX, absTileZ, mountainField);
    return slot;
  }

  beginTile(
    slot: TerrainTileSlot,
    absTileX: number,
    absTileZ: number,
    mountainField: MountainFieldView,
  ): void {
    const spec = slot.spec;
    slot.inUse = true;
    slot.ready = false;
    slot.absTileX = absTileX;
    slot.absTileZ = absTileZ;
    slot.originX = absTileX * spec.tileSize - mountainField.originOffsetX;
    slot.originZ = absTileZ * spec.tileSize - mountainField.originOffsetZ;

    mountainField.collectSpinesInBounds(
      slot.originX - spec.spacing,
      slot.originX + spec.tileSize + spec.spacing,
      slot.originZ - spec.spacing,
      slot.originZ + spec.tileSize + spec.spacing,
      SPINE_BOUNDS_PAD_M,
      slot.candidateSpines,
    );

    slot.originY = mountainField.evaluateHeight(
      slot.originX,
      slot.originZ,
      slot.candidateSpines,
    );
    slot.container.position.set(slot.originX, slot.originY, slot.originZ);
    slot.container.visible = false;
  }

  /**
   * Evaluates one halo-padded row (`gridRow` in `[0, quads + 2]`, mapping `gz = gridRow - 1`),
   * storing rebase-invariant `relY = heightY - slot.originY` and base vertex colors.
   */
  writeBorderRow(
    slot: TerrainTileSlot,
    mountainField: MountainFieldView,
    gridRow: number,
  ): void {
    const spec = slot.spec;
    const gz = gridRow - 1;
    const originX = slot.absTileX * spec.tileSize - mountainField.originOffsetX;
    const originZ = slot.absTileZ * spec.tileSize - mountainField.originOffsetZ;
    const wz = originZ + gz * spec.spacing;
    const rowOffset = gridRow * spec.haloSpan;

    for (let col = 0; col < spec.haloSpan; col++) {
      const gx = col - 1;
      const wx = originX + gx * spec.spacing;
      const haloIdx = rowOffset + col;

      if (gx < 0 || gx > spec.quads || gz < 0 || gz > spec.quads) {
        const h = mountainField.evaluateHeight(wx, wz, slot.candidateSpines);
        slot.relHeights[haloIdx] = h - slot.originY;
        continue;
      }

      mountainField.evaluateColumn(wx, wz, _scratchCol, slot.candidateSpines);
      slot.relHeights[haloIdx] = _scratchCol.heightY - slot.originY;

      const isPiste = _scratchCol.onPiste || _scratchCol.pisteWeight >= 0.5;
      slot.isPisteMask[haloIdx] = isPiste ? 1 : 0;
      slot.isChasmMask[haloIdx] = _scratchCol.inChasmZone ? 1 : 0;

      const primaryColors = this.getStageColors(_scratchCol.nearestStageId);
      this.computeBaseVertexColor(primaryColors, _scratchCol, isPiste, _scratchColorA);
      _scratchCliffColor.copy(primaryColors.cliff);

      if (_scratchCol.secondaryStageId !== null && _scratchCol.secondaryStageWeight > 1e-4) {
        const secColors = this.getStageColors(_scratchCol.secondaryStageId);
        this.computeBaseVertexColor(secColors, _scratchCol, isPiste, _scratchColorB);
        const wSec = clamp(_scratchCol.secondaryStageWeight, 0, 1);
        _scratchColorA.lerp(_scratchColorB, wSec);
        _scratchCliffColor.lerp(secColors.cliff, wSec);
      }

      const idx3 = haloIdx * 3;
      slot.baseColors[idx3] = _scratchColorA.r;
      slot.baseColors[idx3 + 1] = _scratchColorA.g;
      slot.baseColors[idx3 + 2] = _scratchColorA.b;

      slot.cliffColors[idx3] = _scratchCliffColor.r;
      slot.cliffColors[idx3 + 1] = _scratchCliffColor.g;
      slot.cliffColors[idx3 + 2] = _scratchCliffColor.b;
    }
  }

  /**
   * Computes grid-neighbor normals from `relHeights`, applies cliff rock tinting, writes
   * top surface + perimeter skirt buffers, and marks `slot.ready = true` while keeping
   * `container.visible` controlled by `TerrainStreamer` for atomic LOD swaps.
   */
  finishSlot(slot: TerrainTileSlot): void {
    const spec = slot.spec;
    const { quads, spacing, vertSpan, haloSpan, skirtDepth, topVertexCount } = spec;
    const invTwoSpacing = 1 / (2 * spacing);

    for (let gz = 0; gz < vertSpan; gz++) {
      const hz = gz + 1;
      for (let gx = 0; gx < vertSpan; gx++) {
        const hx = gx + 1;
        const haloIdx = hz * haloSpan + hx;

        const hL = slot.relHeights[haloIdx - 1]!;
        const hR = slot.relHeights[haloIdx + 1]!;
        const hD = slot.relHeights[haloIdx - haloSpan]!;
        const hU = slot.relHeights[haloIdx + haloSpan]!;

        const dHx = (hR - hL) * invTwoSpacing;
        const dHz = (hU - hD) * invTwoSpacing;
        const invLen = 1 / Math.hypot(-dHx, 1, -dHz);
        const nx = -dHx * invLen;
        const ny = invLen;
        const nz = -dHz * invLen;

        const topIdx = gz * vertSpan + gx;
        const v3 = topIdx * 3;
        slot.positions[v3] = gx * spacing;
        slot.positions[v3 + 1] = slot.relHeights[haloIdx]!;
        slot.positions[v3 + 2] = gz * spacing;

        slot.normals[v3] = nx;
        slot.normals[v3 + 1] = ny;
        slot.normals[v3 + 2] = nz;

        const h3 = haloIdx * 3;
        let r = slot.baseColors[h3]!;
        let g = slot.baseColors[h3 + 1]!;
        let b = slot.baseColors[h3 + 2]!;

        if (slot.isPisteMask[haloIdx] === 0) {
          const cliffBlend = smoothstep(0.80, 0.70, ny);
          if (cliffBlend > 0) {
            r = lerp(r, slot.cliffColors[h3]!, cliffBlend);
            g = lerp(g, slot.cliffColors[h3 + 1]!, cliffBlend);
            b = lerp(b, slot.cliffColors[h3 + 2]!, cliffBlend);
          }
        }

        slot.colors[v3] = r;
        slot.colors[v3 + 1] = g;
        slot.colors[v3 + 2] = b;
      }
    }

    // Write perimeter skirt vertices directly beneath the 4 border edges by -skirtDepth
    const northStart = topVertexCount;
    const southStart = topVertexCount + vertSpan;
    const westStart = topVertexCount + vertSpan * 2;
    const eastStart = topVertexCount + vertSpan * 3;

    for (let gx = 0; gx < vertSpan; gx++) {
      this.copySkirtVertex(slot, gx, northStart + gx, skirtDepth);
      this.copySkirtVertex(slot, quads * vertSpan + gx, southStart + gx, skirtDepth);
    }
    for (let gz = 0; gz < vertSpan; gz++) {
      this.copySkirtVertex(slot, gz * vertSpan, westStart + gz, skirtDepth);
      this.copySkirtVertex(slot, gz * vertSpan + quads, eastStart + gz, skirtDepth);
    }

    slot.posAttr.needsUpdate = true;
    slot.normAttr.needsUpdate = true;
    slot.colAttr.needsUpdate = true;
    slot.positionUploadCount++;
    slot.geometry.computeBoundingSphere();
    slot.geometry.computeBoundingBox();
    slot.ready = true;
  }

  releaseSlot(slot: TerrainTileSlot): void {
    if (!slot.inUse) return;
    slot.inUse = false;
    slot.ready = false;
    slot.absTileX = 0;
    slot.absTileZ = 0;
    slot.candidateSpines.length = 0;
    slot.container.visible = false;
    this.freeIndicesByLod[slot.lod].push(slot.index);
  }

  /**
   * Translation-only floating-origin rebase handler:
   * shifts tile origins and Three.js containers with ZERO vertex buffer re-uploads.
   */
  shiftAllOrigins(deltaX: number, deltaY: number, deltaZ: number): void {
    for (let lodIdx = 0; lodIdx < 2; lodIdx++) {
      const slots = this.slotsByLod[lodIdx as TerrainLodTier];
      for (let i = 0; i < slots.length; i++) {
        const slot = slots[i]!;
        if (!slot.inUse) continue;
        slot.originX -= deltaX;
        slot.originY -= deltaY;
        slot.originZ -= deltaZ;
        slot.container.position.set(slot.originX, slot.originY, slot.originZ);
      }
    }
  }

  private copySkirtVertex(
    slot: TerrainTileSlot,
    srcTopIdx: number,
    dstVertIdx: number,
    skirtDepth: number,
  ): void {
    const s3 = srcTopIdx * 3;
    const d3 = dstVertIdx * 3;
    slot.positions[d3] = slot.positions[s3]!;
    slot.positions[d3 + 1] = slot.positions[s3 + 1]! - skirtDepth;
    slot.positions[d3 + 2] = slot.positions[s3 + 2]!;

    slot.normals[d3] = slot.normals[s3]!;
    slot.normals[d3 + 1] = slot.normals[s3 + 1]!;
    slot.normals[d3 + 2] = slot.normals[s3 + 2]!;

    slot.colors[d3] = slot.colors[s3]!;
    slot.colors[d3 + 1] = slot.colors[s3 + 1]!;
    slot.colors[d3 + 2] = slot.colors[s3 + 2]!;
  }

  private computeBaseVertexColor(
    colors: ParsedStageColors,
    col: MountainColumnOut,
    isPiste: boolean,
    outColor: THREE.Color,
  ): void {
    if (isPiste) {
      if (col.inDivider) {
        outColor.copy(colors.bank).lerp(_scratchDividerTint, 0.35);
        return;
      }
      switch (col.pisteSurfaceType) {
        case 'ice':
          outColor.copy(colors.ice);
          break;
        case 'powder':
          outColor.copy(colors.powder);
          break;
        case 'packed': {
          const edgeFade = clamp(
            Math.abs(col.nearestSignedX) / Math.max(1, col.nearestHalfWidth),
            0,
            1,
          );
          outColor.copy(colors.snow).lerp(colors.shadowSnow, edgeFade * 0.14);
          break;
        }
        default: {
          const _exhaustive: never = col.pisteSurfaceType;
          throw new Error(`Unhandled surface type: ${String(_exhaustive)}`);
        }
      }
      return;
    }

    const offPisteDist = Math.max(0, Math.abs(col.nearestSignedX) - col.nearestHalfWidth);
    const bankRatio = clamp(offPisteDist / 28, 0, 1);
    outColor.copy(colors.bank).lerp(colors.shadowSnow, bankRatio * 0.55);

    if (col.inChasmZone) {
      const chasmT = clamp(col.chasmDepthBelowSpine / 32, 0, 1);
      outColor.lerp(colors.chasmFloor, chasmT);
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
