import * as THREE from 'three';
import { clamp } from '../../core/math';
import type { ReadonlySimState } from '../../sim/contracts';
import type { GraphicsUtils } from './graphicsUtils';

const TRACK_HALF_STANCE = 0.22;
const SKI_TRACK_HALF_WIDTH = 0.095;
const TRACK_NORMAL_OFFSET = 0.025;
const MAX_SAMPLE_GAP_SQ = 36; // > 6m gap breaks track continuity (recovery/rebase safe)
const TRACK_MAX_AGE_SEC = 4.5;

/**
 * Pooled twin-ski ribbon mesh reading `SkiTrackPoolView`'s ring buffer (`head`, `count`, `capacity`).
 * Renders recessed carved-groove shading (cool shadowed inner trough, bright sunlit displaced snow
 * lip, carve/brake width & intensity modulation, and smooth feathered fade) with zero per-frame
 * heap allocations. Emits collapsed zero-area triangles across airborne gaps and teleports.
 */
export class SkiTracks {
  readonly mesh: THREE.Mesh;
  private readonly maxSamples: number;
  private readonly positions: Float32Array;
  private readonly trackData: Float32Array;
  private readonly posAttr: THREE.BufferAttribute;
  private readonly trackDataAttr: THREE.BufferAttribute;
  private readonly geometry: THREE.BufferGeometry;

  constructor(gfx: GraphicsUtils, maxCapacity = 512) {
    this.maxSamples = Math.max(2, maxCapacity);
    // Two tracks (left + right), 2 edge vertices per sample per track = 4 verts/sample
    const vertCount = this.maxSamples * 4;
    // (maxSamples - 1) quads per track * 2 tracks * 6 indices = (maxSamples - 1) * 12
    const indexCount = (this.maxSamples - 1) * 12;

    this.positions = new Float32Array(vertCount * 3);
    this.trackData = new Float32Array(vertCount * 2);
    const uvs = new Float32Array(vertCount * 2);
    const indices = new Uint16Array(indexCount);

    for (let s = 0; s < this.maxSamples; s++) {
      const uvBase = s * 8;
      // Left track across [0, 1], v = 0
      uvs[uvBase] = 0;
      uvs[uvBase + 1] = 0;
      uvs[uvBase + 2] = 1;
      uvs[uvBase + 3] = 0;
      // Right track across [0, 1], v = 1
      uvs[uvBase + 4] = 0;
      uvs[uvBase + 5] = 1;
      uvs[uvBase + 6] = 1;
      uvs[uvBase + 7] = 1;
    }

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

    this.posAttr = new THREE.BufferAttribute(this.positions, 3);
    this.posAttr.setUsage(THREE.DynamicDrawUsage);
    this.trackDataAttr = new THREE.BufferAttribute(this.trackData, 2);
    this.trackDataAttr.setUsage(THREE.DynamicDrawUsage);

    this.geometry = new THREE.BufferGeometry();
    this.geometry.name = 'SkiTracksGeo';
    this.geometry.setAttribute('position', this.posAttr);
    this.geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    this.geometry.setAttribute('aTrackData', this.trackDataAttr);
    this.geometry.setIndex(new THREE.BufferAttribute(indices, 1));
    this.geometry.setDrawRange(0, 0);

    const material = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
      side: THREE.DoubleSide,
      fog: true,
    });
    material.name = 'SkiTracksMaterial';
    material.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          `#include <common>
attribute vec2 aTrackData;
varying vec2 vTrackUv;
varying vec2 vTrackData;`,
        )
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
vTrackUv = uv;
vTrackData = aTrackData;`,
        );

      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
varying vec2 vTrackUv;
varying vec2 vTrackData;`,
        )
        .replace(
          '#include <color_fragment>',
          `#include <color_fragment>
float across = vTrackUv.x * 2.0 - 1.0;
float absAcross = abs(across);
float freshness = clamp(vTrackData.x, 0.0, 1.0);
float carve = clamp(vTrackData.y, 0.0, 1.0);
float feather = 1.0 - smoothstep(0.68, 1.0, absAcross);
float trough = 1.0 - smoothstep(0.08, 0.62, absAcross);
float lip = smoothstep(0.36, 0.64, absAcross) * (1.0 - smoothstep(0.68, 0.96, absAcross));
float sunBias = 0.86 + 0.28 * across;
vec3 troughCol = vec3(0.34, 0.52, 0.75);
vec3 lipCol = vec3(0.97, 0.99, 1.0);
float lipMix = lip / max(0.001, trough + lip);
diffuseColor.rgb = mix(troughCol, lipCol * sunBias, clamp(lipMix, 0.0, 1.0));
float ageFade = freshness * freshness * (3.0 - 2.0 * freshness);
float intensity = mix(0.75, 1.18, carve);
diffuseColor.a = ageFade * feather * clamp((trough * 0.54 + lip * 0.38) * intensity, 0.0, 0.78);`,
        );
    };
    material.customProgramCacheKey = () => 'ski-tracks-carved-groove-v1';
    gfx.markAsCache(material, 'SkiTracksMaterial');

    this.mesh = gfx.createMesh(this.geometry, material, 'SkiTracksMesh');
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
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
    const liveCarve = clamp(
      Math.abs(simState.currSkier.carveAngleRad) * 1.4 + (simState.currSkier.braking ? 0.6 : 0),
      0,
      1,
    );

    let prevX = 0;
    let prevY = 0;
    let prevZ = 0;
    let prevRx = 1;
    let prevRz = 0;
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
      let turnIntensity = 0;
      if (k > 0 && validEdge) {
        const dx = px - prevX;
        const dy = py - prevY;
        const dz = pz - prevZ;
        if (prevGrounded === 0 || dx * dx + dy * dy + dz * dz > MAX_SAMPLE_GAP_SQ) {
          validEdge = false;
        } else {
          turnIntensity = clamp(Math.hypot(rx - prevRx, rz - prevRz) * 5.0, 0, 1);
        }
      }
      if (k >= count - 2) {
        turnIntensity = Math.max(turnIntensity, liveCarve);
      }

      const halfW = validEdge ? SKI_TRACK_HALF_WIDTH * (1 + turnIntensity * 0.55) : 0;
      const ox = px + nx * TRACK_NORMAL_OFFSET;
      const oy = py + ny * TRACK_NORMAL_OFFSET;
      const oz = pz + nz * TRACK_NORMAL_OFFSET;

      const freshness = validEdge ? 1 - clamp(age / TRACK_MAX_AGE_SEC, 0, 1) : 0;

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

      const dBase = k * 8; // 4 verts * 2 floats
      for (let c = 0; c < 4; c++) {
        this.trackData[dBase + c * 2] = freshness;
        this.trackData[dBase + c * 2 + 1] = turnIntensity;
      }

      prevX = px;
      prevY = py;
      prevZ = pz;
      prevRx = rx;
      prevRz = rz;
      prevGrounded = grounded;
    }

    this.posAttr.needsUpdate = true;
    this.trackDataAttr.needsUpdate = true;
    this.geometry.setDrawRange(0, (count - 1) * 12);
  }
}
