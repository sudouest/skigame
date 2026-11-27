import * as THREE from 'three';
import {
  CHARACTER_SCALE_TUNING,
  resolveSkierVisualScale,
  type CharacterScaleTuning,
} from '../../content/visibilityTuning';
import { clamp } from '../../core/math';
import type { SkierPose, SurfaceType } from '../../sim/contracts';
import type { GraphicsUtils } from './graphicsUtils';

export const MAX_CARVE_SPRAY_PARTICLES = 384;

const PUFF_TEX_SIZE = 32;

const _mat4 = new THREE.Matrix4();
const _pos = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _rollQuat = new THREE.Quaternion();
const _scale = new THREE.Vector3();
const _color = new THREE.Color();
const _zAxis = new THREE.Vector3(0, 0, 1);
const _lookMat = new THREE.Matrix4();
const _originVec = new THREE.Vector3(0, 0, 0);
const _targetVec = new THREE.Vector3();
const _upVec = new THREE.Vector3(0, 1, 0);
const _surfaceStyle = {
  r: 1,
  g: 1,
  b: 1,
  sizeMin: 0.22,
  sizeMax: 0.46,
  aspect: 1.0,
  lifeMin: 0.28,
  lifeMax: 0.52,
  drag: 3.0,
  gravScale: 0.75,
  loftMin: 1.8,
  loftMax: 4.0,
  rateMult: 1.0,
};

function createPuffTexture(gfx: GraphicsUtils): THREE.DataTexture {
  const size = PUFF_TEX_SIZE;
  const data = new Uint8Array(size * size * 4);
  const half = (size - 1) * 0.5;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x - half) / half;
      const dy = (y - half) / half;
      // Stylized lumpy cartoon puff silhouette (slightly squashed circle with crisp-soft edge)
      const r = Math.hypot(dx, dy);
      const falloff = clamp(1 - r, 0, 1);
      const celSoft = falloff * falloff * (3 - 2 * falloff);
      const alpha = Math.round(clamp(celSoft * 1.15, 0, 1) * 255);
      const idx = (y * size + x) * 4;
      data[idx] = 255;
      data[idx + 1] = 255;
      data[idx + 2] = 255;
      data[idx + 3] = alpha;
    }
  }

  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.name = 'CarveSprayPuffTex';
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  gfx.markAsCache(tex, 'CarveSprayPuffTex');
  return tex;
}

/**
 * Pooled instanced carve-spray & touchdown snow-puff particle system (384 quads).
 * Emits surface-tinted particles off the outside ski edge proportional to
 * `speed * (|carveAngleRad| + (braking ? 0.8 : 0))` plus landing bursts,
 * with zero per-frame heap allocations and seamless floating-origin rebase support.
 */
export class CarveSprayVfx {
  readonly instancedMesh: THREE.InstancedMesh;
  readonly puffTexture: THREE.DataTexture;

  private readonly gfx: GraphicsUtils;
  private readonly px = new Float32Array(MAX_CARVE_SPRAY_PARTICLES);
  private readonly py = new Float32Array(MAX_CARVE_SPRAY_PARTICLES);
  private readonly pz = new Float32Array(MAX_CARVE_SPRAY_PARTICLES);
  private readonly vx = new Float32Array(MAX_CARVE_SPRAY_PARTICLES);
  private readonly vy = new Float32Array(MAX_CARVE_SPRAY_PARTICLES);
  private readonly vz = new Float32Array(MAX_CARVE_SPRAY_PARTICLES);
  private readonly age = new Float32Array(MAX_CARVE_SPRAY_PARTICLES);
  private readonly life = new Float32Array(MAX_CARVE_SPRAY_PARTICLES);
  private readonly baseSize = new Float32Array(MAX_CARVE_SPRAY_PARTICLES);
  private readonly aspect = new Float32Array(MAX_CARVE_SPRAY_PARTICLES);
  private readonly dragRate = new Float32Array(MAX_CARVE_SPRAY_PARTICLES);
  private readonly gravityScale = new Float32Array(MAX_CARVE_SPRAY_PARTICLES);
  private readonly rot = new Float32Array(MAX_CARVE_SPRAY_PARTICLES);
  private readonly spin = new Float32Array(MAX_CARVE_SPRAY_PARTICLES);
  private readonly cr = new Float32Array(MAX_CARVE_SPRAY_PARTICLES);
  private readonly cg = new Float32Array(MAX_CARVE_SPRAY_PARTICLES);
  private readonly cb = new Float32Array(MAX_CARVE_SPRAY_PARTICLES);

  private readonly alphas = new Float32Array(MAX_CARVE_SPRAY_PARTICLES);
  private readonly alphaAttr: THREE.InstancedBufferAttribute;
  private readonly scaleTuning: CharacterScaleTuning;

  private activeCount = 0;
  private emitAccum = 0;
  private wasGrounded = true;
  private hasPrevPose = false;
  private rngState = 0x9e3779b9;

  constructor(
    gfx: GraphicsUtils,
    scene: THREE.Scene,
    scaleTuning: CharacterScaleTuning = CHARACTER_SCALE_TUNING,
  ) {
    this.gfx = gfx;
    this.scaleTuning = scaleTuning;
    this.puffTexture = createPuffTexture(gfx);

    const quadGeo = new THREE.PlaneGeometry(1, 1);
    quadGeo.name = 'CarveSprayQuadGeo';
    this.alphaAttr = new THREE.InstancedBufferAttribute(this.alphas, 1);
    this.alphaAttr.setUsage(THREE.DynamicDrawUsage);
    quadGeo.setAttribute('aParticleAlpha', this.alphaAttr);
    gfx.markAsCache(quadGeo, 'CarveSprayQuadGeo');

    const mat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      map: this.puffTexture,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: true,
    });
    mat.name = 'CarveSprayMaterial';
    mat.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          `#include <common>
attribute float aParticleAlpha;
varying float vParticleAlpha;`,
        )
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
vParticleAlpha = aParticleAlpha;`,
        );
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
varying float vParticleAlpha;`,
        )
        .replace(
          '#include <map_fragment>',
          `#include <map_fragment>
diffuseColor.a *= vParticleAlpha;`,
        );
    };
    mat.customProgramCacheKey = () => 'carve-spray-particle-v1';
    gfx.markAsCache(mat, 'CarveSprayMaterial');

    this.instancedMesh = gfx.createInstancedMesh(
      quadGeo,
      mat,
      MAX_CARVE_SPRAY_PARTICLES,
      'CarveSprayPool',
    );
    this.instancedMesh.frustumCulled = false;
    this.instancedMesh.castShadow = false;
    this.instancedMesh.receiveShadow = false;
    this.instancedMesh.count = 0;

    // Pre-allocate instanceColor buffer in constructor so hot loop performs zero allocations.
    _color.setRGB(1, 1, 1);
    for (let i = 0; i < MAX_CARVE_SPRAY_PARTICLES; i++) {
      this.instancedMesh.setColorAt(i, _color);
    }
    if (this.instancedMesh.instanceColor) {
      this.instancedMesh.instanceColor.needsUpdate = true;
    }

    scene.add(this.instancedMesh);
  }

  private nextRand01(): number {
    let x = this.rngState | 0;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.rngState = x;
    return (x >>> 0) / 4294967296;
  }

  private nextRange(min: number, max: number): number {
    return min + (max - min) * this.nextRand01();
  }

  private spawnParticle(
    x: number,
    y: number,
    z: number,
    vx: number,
    vy: number,
    vz: number,
    lifeSec: number,
    size: number,
    aspectRatio: number,
    drag: number,
    gravScale: number,
    r: number,
    g: number,
    b: number,
  ): void {
    let idx: number;
    if (this.activeCount < MAX_CARVE_SPRAY_PARTICLES) {
      idx = this.activeCount++;
    } else {
      // Overwrite oldest-feeling slot (index 0) when pool is saturated
      idx = 0;
    }

    this.px[idx] = x;
    this.py[idx] = y;
    this.pz[idx] = z;
    this.vx[idx] = vx;
    this.vy[idx] = vy;
    this.vz[idx] = vz;
    this.age[idx] = 0;
    this.life[idx] = lifeSec;
    this.baseSize[idx] = size;
    this.aspect[idx] = aspectRatio;
    this.dragRate[idx] = drag;
    this.gravityScale[idx] = gravScale;
    this.rot[idx] = this.nextRange(0, Math.PI * 2);
    this.spin[idx] = this.nextRange(-7.5, 7.5);
    this.cr[idx] = r;
    this.cg[idx] = g;
    this.cb[idx] = b;
  }

  private fillSurfaceStyle(surfaceType: SurfaceType, dimFactor: number): void {
    const jitter = this.nextRange(0.92, 1.0);
    const out = _surfaceStyle;
    switch (surfaceType) {
      case 'powder': {
        const c = dimFactor * jitter;
        out.r = 0.98 * c;
        out.g = 0.99 * c;
        out.b = 1.0 * c;
        out.sizeMin = 0.34;
        out.sizeMax = 0.68;
        out.aspect = 1.0;
        out.lifeMin = 0.42;
        out.lifeMax = 0.72;
        out.drag = 2.8;
        out.gravScale = 0.45;
        out.loftMin = 2.2;
        out.loftMax = 4.8;
        out.rateMult = 1.35;
        break;
      }
      case 'ice': {
        const spark = this.nextRand01() > 0.35 ? 1.0 : 0.85;
        const c = dimFactor * spark;
        out.r = 0.48 * c;
        out.g = 0.92 * c;
        out.b = 1.0 * c;
        out.sizeMin = 0.14;
        out.sizeMax = 0.28;
        out.aspect = 1.65;
        out.lifeMin = 0.22;
        out.lifeMax = 0.42;
        out.drag = 1.8;
        out.gravScale = 1.15;
        out.loftMin = 2.4;
        out.loftMax = 5.2;
        out.rateMult = 0.95;
        break;
      }
      case 'rock': {
        const warm = this.nextRange(0.75, 1.0);
        const c = dimFactor * warm;
        out.r = 0.62 * c;
        out.g = 0.6 * c;
        out.b = 0.58 * c;
        out.sizeMin = 0.2;
        out.sizeMax = 0.42;
        out.aspect = 1.1;
        out.lifeMin = 0.26;
        out.lifeMax = 0.46;
        out.drag = 3.4;
        out.gravScale = 0.95;
        out.loftMin = 1.6;
        out.loftMax = 3.6;
        out.rateMult = 0.85;
        break;
      }
      case 'packed':
      default: {
        const tint = jitter * dimFactor;
        out.r = 0.92 * tint;
        out.g = 0.97 * tint;
        out.b = 1.0 * tint;
        out.sizeMin = 0.22;
        out.sizeMax = 0.46;
        out.aspect = 1.05;
        out.lifeMin = 0.28;
        out.lifeMax = 0.52;
        out.drag = 3.0;
        out.gravScale = 0.75;
        out.loftMin = 1.8;
        out.loftMax = 4.0;
        out.rateMult = 1.0;
        break;
      }
    }
  }

  update(
    dt: number,
    skierPose: SkierPose,
    surfaceType: SurfaceType,
    blizzardDim = 0,
    camera?: THREE.Camera,
    skierVisualScale?: number,
  ): void {
    const safeDt = Math.min(0.1, Math.max(0, dt));
    const dim = 1 - clamp(blizzardDim, 0, 1) * 0.35;
    const scale =
      skierVisualScale !== undefined && Number.isFinite(skierVisualScale) && skierVisualScale > 0
        ? skierVisualScale
        : resolveSkierVisualScale(1.0, this.scaleTuning);

    const fwdX = -Math.sin(skierPose.headingRad);
    const fwdZ = -Math.cos(skierPose.headingRad);
    const rawRx = Math.cos(skierPose.headingRad);
    const rawRz = -Math.sin(skierPose.headingRad);

    const nx = skierPose.normalX;
    const ny = skierPose.normalY;
    const nz = skierPose.normalZ;
    const invNy = 1 / Math.max(0.35, ny);
    const rawRy = -(rawRx * nx + rawRz * nz) * invNy;
    const rLen = Math.hypot(rawRx, rawRy, rawRz) || 1;
    const rx = rawRx / rLen;
    const ry = rawRy / rLen;
    const rz = rawRz / rLen;

    const style = _surfaceStyle;

    // 1. Touchdown burst when transitioning airborne -> grounded
    if (this.hasPrevPose && !this.wasGrounded && skierPose.grounded) {
      const impactBoost = clamp(skierPose.speed / 18, 0.55, 1.45);
      const burstCount = Math.round(14 * impactBoost);
      for (let i = 0; i < burstCount; i++) {
        const angle = (i / burstCount) * Math.PI * 2 + this.nextRange(-0.2, 0.2);
        const sideCos = Math.cos(angle);
        const fwdSin = Math.sin(angle);
        const latSpeed = this.nextRange(2.4, 5.4) * impactBoost;
        this.fillSurfaceStyle(surfaceType, dim);
        const edgeSide = (sideCos >= 0 ? 0.24 : -0.24) * scale;
        const fwdOffset = fwdSin * 0.25 * scale;

        this.spawnParticle(
          skierPose.posX + rx * edgeSide + fwdX * fwdOffset,
          skierPose.posY + 0.12 + ry * edgeSide,
          skierPose.posZ + rz * edgeSide + fwdZ * fwdOffset,
          skierPose.velX * 0.2 + rx * sideCos * latSpeed + fwdX * fwdSin * latSpeed * 0.6,
          skierPose.velY * 0.1 + ny * this.nextRange(1.8, 4.0) * impactBoost,
          skierPose.velZ * 0.2 + rz * sideCos * latSpeed + fwdZ * fwdSin * latSpeed * 0.6,
          this.nextRange(style.lifeMin, style.lifeMax) * 1.1,
          this.nextRange(style.sizeMin, style.sizeMax) * 1.15,
          style.aspect,
          style.drag,
          style.gravScale,
          style.r,
          style.g,
          style.b,
        );
      }
    }
    this.wasGrounded = skierPose.grounded;
    this.hasPrevPose = true;

    // 2. Continuous outside-ski carve & snowplow spray while grounded (suppressed while walking)
    if (skierPose.grounded && !skierPose.walking && skierPose.speed > 2.2 && safeDt > 0) {
      const absCarve = Math.abs(skierPose.carveAngleRad);
      const brakeTerm = skierPose.braking ? 0.8 : 0;
      const intensity = skierPose.speed * (absCarve + brakeTerm);

      if (intensity > 0.6) {
        this.fillSurfaceStyle(surfaceType, dim);
        this.emitAccum += intensity * 8.5 * style.rateMult * safeDt;
        const toSpawn = Math.min(24, Math.floor(this.emitAccum));
        this.emitAccum -= toSpawn;

        for (let i = 0; i < toSpawn; i++) {
          this.fillSurfaceStyle(surfaceType, dim);
          let outSign: number;
          if (skierPose.braking && absCarve < 0.12) {
            outSign = (i & 1) === 0 ? -1 : 1;
          } else {
            // Positive carveAngleRad turns right (+right center), spraying snow outward (-right)
            outSign = skierPose.carveAngleRad >= 0 ? -1 : 1;
          }

          const skiOffset = outSign * (0.24 + this.nextRange(0.0, 0.14)) * scale;
          const tailOffset = this.nextRange(-0.15, 0.55) * scale;
          const outwardSpeed =
            (2.2 + clamp(intensity * 0.14, 0, 6.0)) * this.nextRange(0.75, 1.25);
          const loftSpeed =
            this.nextRange(style.loftMin, style.loftMax) * clamp(0.65 + intensity * 0.03, 0.65, 1.5);
          const trailBack = this.nextRange(0.8, 2.4);

          this.spawnParticle(
            skierPose.posX + rx * skiOffset - fwdX * tailOffset,
            skierPose.posY + 0.08 + ry * skiOffset + ny * 0.06,
            skierPose.posZ + rz * skiOffset - fwdZ * tailOffset,
            skierPose.velX * 0.25 + rx * outSign * outwardSpeed - fwdX * trailBack,
            skierPose.velY * 0.15 + ry * outSign * outwardSpeed + ny * loftSpeed,
            skierPose.velZ * 0.25 + rz * outSign * outwardSpeed - fwdZ * trailBack,
            this.nextRange(style.lifeMin, style.lifeMax),
            this.nextRange(style.sizeMin, style.sizeMax),
            style.aspect,
            style.drag,
            style.gravScale,
            style.r,
            style.g,
            style.b,
          );
        }
      } else {
        this.emitAccum = 0;
      }
    } else {
      this.emitAccum = 0;
    }

    // 3. Integrate active particles & pack [0, activeCount) contiguously
    if (this.activeCount === 0) {
      this.instancedMesh.count = 0;
      return;
    }

    if (camera) {
      _quat.copy(camera.quaternion);
    } else {
      // Default chase-camera-facing orientation (behind skier looking downhill-forward)
      _targetVec.set(-fwdX, 0.42, -fwdZ).normalize();
      _lookMat.lookAt(_targetVec, _originVec, _upVec);
      _quat.setFromRotationMatrix(_lookMat);
    }

    let i = 0;
    while (i < this.activeCount) {
      const nextAge = this.age[i]! + safeDt;
      const lifeSec = this.life[i]!;
      if (nextAge >= lifeSec) {
        const last = --this.activeCount;
        if (i !== last) {
          this.px[i] = this.px[last]!;
          this.py[i] = this.py[last]!;
          this.pz[i] = this.pz[last]!;
          this.vx[i] = this.vx[last]!;
          this.vy[i] = this.vy[last]!;
          this.vz[i] = this.vz[last]!;
          this.age[i] = this.age[last]!;
          this.life[i] = this.life[last]!;
          this.baseSize[i] = this.baseSize[last]!;
          this.aspect[i] = this.aspect[last]!;
          this.dragRate[i] = this.dragRate[last]!;
          this.gravityScale[i] = this.gravityScale[last]!;
          this.rot[i] = this.rot[last]!;
          this.spin[i] = this.spin[last]!;
          this.cr[i] = this.cr[last]!;
          this.cg[i] = this.cg[last]!;
          this.cb[i] = this.cb[last]!;
        }
        continue;
      }

      this.age[i] = nextAge;
      const damp = Math.exp(-this.dragRate[i]! * safeDt);
      const vx = this.vx[i]! * damp;
      const vy = (this.vy[i]! - 14.0 * this.gravityScale[i]! * safeDt) * damp;
      const vz = this.vz[i]! * damp;

      this.vx[i] = vx;
      this.vy[i] = vy;
      this.vz[i] = vz;
      this.px[i] = this.px[i]! + vx * safeDt;
      this.py[i] = this.py[i]! + vy * safeDt;
      this.pz[i] = this.pz[i]! + vz * safeDt;
      this.rot[i] = this.rot[i]! + this.spin[i]! * safeDt;

      const t = clamp(nextAge / lifeSec, 0, 1);
      // Pop-in then billow then shrink cleanly
      const popIn = t < 0.15 ? t / 0.15 : 1;
      const sizeCurve = popIn * (1.0 - t * t * 0.72);
      const s = this.baseSize[i]! * sizeCurve;
      const alpha = (1 - t) * (1 - t * 0.45) * 0.9;

      _pos.set(this.px[i]!, this.py[i]!, this.pz[i]!);
      _rollQuat.setFromAxisAngle(_zAxis, this.rot[i]!);
      _rollQuat.premultiply(_quat);
      _scale.set(s, s * this.aspect[i]!, 1);
      _mat4.compose(_pos, _rollQuat, _scale);

      this.instancedMesh.setMatrixAt(i, _mat4);
      _color.setRGB(this.cr[i]!, this.cg[i]!, this.cb[i]!);
      this.instancedMesh.setColorAt(i, _color);
      this.alphas[i] = alpha;

      i++;
    }

    this.instancedMesh.count = this.activeCount;
    if (this.activeCount > 0) {
      this.instancedMesh.instanceMatrix.needsUpdate = true;
      if (this.instancedMesh.instanceColor) {
        this.instancedMesh.instanceColor.needsUpdate = true;
      }
      this.alphaAttr.needsUpdate = true;
    }
  }

  shiftOrigin(dx: number, dy: number, dz: number): void {
    for (let i = 0; i < this.activeCount; i++) {
      this.px[i] = this.px[i]! - dx;
      this.py[i] = this.py[i]! - dy;
      this.pz[i] = this.pz[i]! - dz;
    }
  }

  reset(): void {
    this.activeCount = 0;
    this.emitAccum = 0;
    this.wasGrounded = true;
    this.hasPrevPose = false;
    this.instancedMesh.count = 0;
  }

  dispose(): void {
    this.reset();
    this.gfx.disposeObject(this.instancedMesh);
  }
}
