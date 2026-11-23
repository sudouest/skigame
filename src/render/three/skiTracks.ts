import * as THREE from 'three';
import { clamp } from '../../core/math';
import type { ReadonlySimState } from '../../sim/contracts';
import type { GraphicsUtils } from './graphicsUtils';

const TRACK_HALF_STANCE = 0.22;
const SKI_TRACK_HALF_WIDTH = 0.085;
const TRACK_NORMAL_OFFSET = 0.025;
const MAX_SAMPLE_GAP_SQ = 36; // > 6m gap breaks track continuity (recovery/rebase safe)
const TRACK_MAX_AGE_SEC = 4.5;

const _baseColor = new THREE.Color('#6b95c4');
const _fadeColor = new THREE.Color('#dbeafe');
const _tmpColor = new THREE.Color();

/**
 * Pooled twin-ski ribbon mesh reading `SkiTrackPoolView`'s ring buffer (`head`, `count`, `capacity`).
 * Emits collapsed zero-area triangles across airborne gaps (`grounded === 0`) and large teleports,
 * fading vertices smoothly with `ageSec` with zero per-frame heap allocations.
 */
export class SkiTracks {
  readonly mesh: THREE.Mesh;
  private readonly maxSamples: number;
  private readonly positions: Float32Array;
  private readonly colors: Float32Array;
  private readonly posAttr: THREE.BufferAttribute;
  private readonly colAttr: THREE.BufferAttribute;
  private readonly geometry: THREE.BufferGeometry;

  constructor(gfx: GraphicsUtils, maxCapacity = 512) {
    this.maxSamples = Math.max(2, maxCapacity);
    // Two tracks (left + right), 2 edge vertices per sample per track = 4 verts/sample
    const vertCount = this.maxSamples * 4;
    // (maxSamples - 1) quads per track * 2 tracks * 6 indices = (maxSamples - 1) * 12
    const indexCount = (this.maxSamples - 1) * 12;

    this.positions = new Float32Array(vertCount * 3);
    this.colors = new Float32Array(vertCount * 3);
    const indices = new Uint16Array(indexCount);

    let ptr = 0;
    for (let s = 0; s < this.maxSamples - 1; s++) {
      // Left track quad
      const l0 = s * 4;
      const l1 = (s + 1) * 4;
      indices[ptr++] = l0;
      indices[ptr++] = l0 + 1;
      indices[ptr++] = l1 + 1;
      indices[ptr++] = l0;
      indices[ptr++] = l1 + 1;
      indices[ptr++] = l1;

      // Right track quad
      const r0 = l0 + 2;
      const r1 = l1 + 2;
      indices[ptr++] = r0;
      indices[ptr++] = r0 + 1;
      indices[ptr++] = r1 + 1;
      indices[ptr++] = r0;
      indices[ptr++] = r1 + 1;
      indices[ptr++] = r1;
    }

    this.posAttr = new THREE.Float32BufferAttribute(this.positions, 3);
    this.posAttr.setUsage(THREE.DynamicDrawUsage);
    this.colAttr = new THREE.Float32BufferAttribute(this.colors, 3);
    this.colAttr.setUsage(THREE.DynamicDrawUsage);

    this.geometry = new THREE.BufferGeometry();
    this.geometry.name = 'SkiTracksGeo';
    this.geometry.setAttribute('position', this.posAttr);
    this.geometry.setAttribute('color', this.colAttr);
    this.geometry.setIndex(new THREE.Uint16BufferAttribute(indices, 1));
    this.geometry.setDrawRange(0, 0);

    const material = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      vertexColors: true,
      transparent: true,
      opacity: 0.45,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
      side: THREE.DoubleSide,
    });
    material.name = 'SkiTracksMaterial';
    gfx.markAsCache(material, 'SkiTracksMaterial');

    this.mesh = gfx.createMesh(this.geometry, material, 'SkiTracksMesh');
    this.mesh.frustumCulled = false;
    gfx.markAsCache(this.mesh, 'SkiTracksMesh');
  }

  sync(simState: ReadonlySimState): void {
    const tracks = simState.entities.skiTracks;
    const count = Math.min(tracks.count, this.maxSamples, tracks.capacity);
    if (count < 2) {
      this.geometry.setDrawRange(0, 0);
      return;
    }

    const cap = tracks.capacity;
    const oldest = (((tracks.head - count) % cap) + cap) % cap;

    let prevX = 0;
    let prevY = 0;
    let prevZ = 0;
    let prevGrounded = 0;

    for (let k = 0; k < count; k++) {
      const idx = (oldest + k) % cap;
      const px = tracks.posX[idx]!;
      const py = tracks.posY[idx]!;
      const pz = tracks.posZ[idx]!;
      const nx = tracks.normalX[idx]!;
      const ny = tracks.normalY[idx]!;
      const nz = tracks.normalZ[idx]!;
      const rx = tracks.rightX[idx]!;
      const ry = tracks.rightY[idx]!;
      const rz = tracks.rightZ[idx]!;
      const grounded = tracks.grounded[idx]!;
      const age = tracks.ageSec[idx]!;

      let validEdge = grounded !== 0;
      if (k > 0 && validEdge) {
        const dx = px - prevX;
        const dy = py - prevY;
        const dz = pz - prevZ;
        if (prevGrounded === 0 || dx * dx + dy * dy + dz * dz > MAX_SAMPLE_GAP_SQ) {
          validEdge = false;
        }
      }

      const halfW = validEdge ? SKI_TRACK_HALF_WIDTH : 0;
      const ox = px + nx * TRACK_NORMAL_OFFSET;
      const oy = py + ny * TRACK_NORMAL_OFFSET;
      const oz = pz + nz * TRACK_NORMAL_OFFSET;

      const fade = clamp(age / TRACK_MAX_AGE_SEC, 0, 1);
      _tmpColor.copy(_baseColor).lerp(_fadeColor, fade);

      const lCenterX = ox - rx * TRACK_HALF_STANCE;
      const lCenterY = oy - ry * TRACK_HALF_STANCE;
      const lCenterZ = oz - rz * TRACK_HALF_STANCE;

      const rCenterX = ox + rx * TRACK_HALF_STANCE;
      const rCenterY = oy + ry * TRACK_HALF_STANCE;
      const rCenterZ = oz + rz * TRACK_HALF_STANCE;

      const vBase = k * 12; // 4 verts * 3 floats

      // Left ski inner/outer edges
      this.positions[vBase] = lCenterX - rx * halfW;
      this.positions[vBase + 1] = lCenterY - ry * halfW;
      this.positions[vBase + 2] = lCenterZ - rz * halfW;

      this.positions[vBase + 3] = lCenterX + rx * halfW;
      this.positions[vBase + 4] = lCenterY + ry * halfW;
      this.positions[vBase + 5] = lCenterZ + rz * halfW;

      // Right ski inner/outer edges
      this.positions[vBase + 6] = rCenterX - rx * halfW;
      this.positions[vBase + 7] = rCenterY - ry * halfW;
      this.positions[vBase + 8] = rCenterZ - rz * halfW;

      this.positions[vBase + 9] = rCenterX + rx * halfW;
      this.positions[vBase + 10] = rCenterY + ry * halfW;
      this.positions[vBase + 11] = rCenterZ + rz * halfW;

      for (let c = 0; c < 4; c++) {
        this.colors[vBase + c * 3] = _tmpColor.r;
        this.colors[vBase + c * 3 + 1] = _tmpColor.g;
        this.colors[vBase + c * 3 + 2] = _tmpColor.b;
      }

      prevX = px;
      prevY = py;
      prevZ = pz;
      prevGrounded = grounded;
    }

    this.posAttr.needsUpdate = true;
    this.colAttr.needsUpdate = true;
    this.geometry.setDrawRange(0, (count - 1) * 12);
  }
}
