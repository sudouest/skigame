import * as THREE from 'three';
import { getCreatureDef } from '../../content/creatures';
import { getDeliveryZoneDef } from '../../content/deliveryZones';
import { getHazardDef } from '../../content/hazards';
import { clamp, lerp } from '../../core/math';
import {
  createMountainSampleOut,
  type MountainFieldView,
  type ReadonlySimState,
} from '../../sim/contracts';
import { CHILD_SHADOW_RADIUS_M } from './characterSpriteAtlas';
import type { GraphicsUtils } from './graphicsUtils';
import {
  computeDeliveryChildPosition,
  createBillboardAnimPose,
  evaluateChildAnimPose,
  resolveChildVisualScale,
} from './spriteAnimation';

const MAX_SHADOWS = 512;
const SHADOW_TEX_SIZE = 64;

const _mat4 = new THREE.Matrix4();
const _pos = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _scale = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _normal = new THREE.Vector3();
const _mountainScratch = createMountainSampleOut();
const _childPosScratch = { x: 0, y: 0, z: 0 };
const _childPoseScratch = createBillboardAnimPose('child_idle_0');

function createShadowBlobTexture(gfx: GraphicsUtils): THREE.DataTexture {
  const size = SHADOW_TEX_SIZE;
  const data = new Uint8Array(size * size * 4);
  const half = (size - 1) * 0.5;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x - half) / half;
      const dy = (y - half) / half;
      const r = Math.hypot(dx, dy);
      // Soft-edged cartoon dark-blue shadow blob
      const falloff = clamp(1 - r, 0, 1);
      const alpha = Math.round(falloff * falloff * (3 - 2 * falloff) * 235);
      const idx = (y * size + x) * 4;
      data[idx] = 24;
      data[idx + 1] = 48;
      data[idx + 2] = 96;
      data[idx + 3] = alpha;
    }
  }

  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.name = 'ContactShadowBlobTex';
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  gfx.markAsCache(tex, 'ContactShadowBlobTex');
  return tex;
}

/**
 * Renders terrain-normal-aligned dark-blue cartoon contact shadows via a single `InstancedMesh`
 * (`polygonOffset`, `depthWrite: false`, `frustumCulled = false`).
 * Radius shrinks and alpha fades proportionally to airborne clearance `posY - groundY`.
 */
export class ContactShadows {
  readonly instancedMesh: THREE.InstancedMesh;
  readonly shadowTexture: THREE.DataTexture;
  private readonly shadowAlphas: Float32Array;
  private readonly shadowAlphaAttr: THREE.InstancedBufferAttribute;
  private readonly presentCacheValid = new Uint8Array(MAX_SHADOWS);
  private readonly presentCacheX = new Float32Array(MAX_SHADOWS);
  private readonly presentCacheZ = new Float32Array(MAX_SHADOWS);
  private readonly presentCacheNx = new Float32Array(MAX_SHADOWS);
  private readonly presentCacheNy = new Float32Array(MAX_SHADOWS);
  private readonly presentCacheNz = new Float32Array(MAX_SHADOWS);
  private lastMountainField: MountainFieldView | null = null;
  private activeCount = 0;

  constructor(gfx: GraphicsUtils) {
    this.shadowTexture = createShadowBlobTexture(gfx);

    const planeGeo = new THREE.PlaneGeometry(2, 2);
    planeGeo.rotateX(-Math.PI * 0.5);
    planeGeo.name = 'ContactShadowPlaneGeo';

    this.shadowAlphas = new Float32Array(MAX_SHADOWS);
    this.shadowAlphaAttr = new THREE.InstancedBufferAttribute(this.shadowAlphas, 1);
    this.shadowAlphaAttr.setUsage(THREE.DynamicDrawUsage);
    planeGeo.setAttribute('aShadowAlpha', this.shadowAlphaAttr);
    gfx.markAsCache(planeGeo, 'ContactShadowPlaneGeo');

    const mat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      map: this.shadowTexture,
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
      fog: true,
    });
    mat.name = 'ContactShadowMaterial';
    mat.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          `#include <common>
attribute float aShadowAlpha;
varying float vShadowAlpha;`,
        )
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
vShadowAlpha = aShadowAlpha;`,
        );
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
varying float vShadowAlpha;`,
        )
        .replace(
          '#include <map_fragment>',
          `#include <map_fragment>
diffuseColor.a *= vShadowAlpha;`,
        );
    };
    mat.customProgramCacheKey = () => 'contact-shadow-alpha-v1';
    gfx.markAsCache(mat, 'ContactShadowMaterial');

    this.instancedMesh = gfx.createInstancedMesh(
      planeGeo,
      mat,
      MAX_SHADOWS,
      'ContactShadowsPool',
    );
    this.instancedMesh.frustumCulled = false;
    this.instancedMesh.count = 0;
  }

  private pushShadow(
    x: number,
    groundY: number,
    z: number,
    nx: number,
    ny: number,
    nz: number,
    baseRadius: number,
    clearance: number,
    baseAlpha: number,
  ): void {
    if (this.activeCount >= MAX_SHADOWS) return;
    const safeClearance = Math.max(0, clearance);
    const scaleFactor = clamp(1 - safeClearance * 0.12, 0.28, 1.0);
    const fadeAlpha = clamp(baseAlpha * (1 - safeClearance * 0.14), 0.08, baseAlpha);

    _normal.set(nx, ny, nz);
    const lenSq = _normal.lengthSq();
    if (lenSq > 1e-6) {
      _normal.multiplyScalar(1 / Math.sqrt(lenSq));
    } else {
      _normal.set(0, 1, 0);
    }
    if (_normal.y < -0.999) {
      _quat.set(1, 0, 0, 0);
    } else {
      _quat.setFromUnitVectors(_up, _normal);
    }

    _pos.set(
      x + _normal.x * 0.035,
      groundY + _normal.y * 0.035,
      z + _normal.z * 0.035,
    );
    const r = baseRadius * scaleFactor;
    _scale.set(r, 1, r);
    _mat4.compose(_pos, _quat, _scale);

    this.instancedMesh.setMatrixAt(this.activeCount, _mat4);
    this.shadowAlphas[this.activeCount] = fadeAlpha;
    this.activeCount++;
  }

  sync(simState: ReadonlySimState, alpha: number): void {
    const t = clamp(alpha, 0, 1);
    this.activeCount = 0;

    // 1. Skier shadow (toned down to complement directional shadow as airborne height cue)
    const prevS = simState.prevSkier;
    const currS = simState.currSkier;
    const skX = lerp(prevS.posX, currS.posX, t);
    const skY = lerp(prevS.posY, currS.posY, t);
    const skZ = lerp(prevS.posZ, currS.posZ, t);
    const skGroundY = lerp(prevS.groundY, currS.groundY, t);
    this.pushShadow(
      skX,
      skGroundY,
      skZ,
      currS.normalX,
      currS.normalY,
      currS.normalZ,
      0.95,
      skY - skGroundY,
      0.32,
    );

    // 2. Hazards (normal-aligned from HazardPoolView)
    const hazards = simState.entities.hazards;
    for (let i = 0; i < hazards.count; i++) {
      if (this.activeCount >= MAX_SHADOWS) break;
      const def = getHazardDef(hazards.defIds[i]!);
      const r = hazards.radius[i]! > 0 ? hazards.radius[i]! : (def?.collider.radius ?? 1);
      const mult = hazards.defIds[i] === 'pine_tree' ? 2.1 : 1.15;
      this.pushShadow(
        hazards.posX[i]!,
        hazards.posY[i]!,
        hazards.posZ[i]!,
        hazards.normalX[i]!,
        hazards.normalY[i]!,
        hazards.normalZ[i]!,
        r * mult,
        0,
        0.52,
      );
    }

    // 3. Creatures (interpolated pos + terrain normal + airborne clearance)
    const creatures = simState.entities.creatures;
    for (let i = 0; i < creatures.count; i++) {
      if (this.activeCount >= MAX_SHADOWS) break;
      const def = getCreatureDef(creatures.defIds[i]!);
      const cx = lerp(creatures.prevPosX[i]!, creatures.posX[i]!, t);
      const cy = lerp(creatures.prevPosY[i]!, creatures.posY[i]!, t);
      const cz = lerp(creatures.prevPosZ[i]!, creatures.posZ[i]!, t);
      const r = creatures.radius[i]! > 0 ? creatures.radius[i]! : (def?.collider.radius ?? 1.2);
      this.pushShadow(
        cx,
        creatures.groundY[i]!,
        cz,
        creatures.normalX[i]!,
        creatures.normalY[i]!,
        creatures.normalZ[i]!,
        r * 1.15,
        cy - creatures.groundY[i]!,
        0.58,
      );
    }

    const mountainField = simState.mountainField;

    // 4. DeliveryZone Children (prioritized before static presents; terrain-normal aligned + jump fade)
    const zones = simState.entities.deliveryZones;
    for (let i = 0; i < zones.count; i++) {
      if (this.activeCount >= MAX_SHADOWS) break;
      const zoneDef = getDeliveryZoneDef(zones.defIds[i]!);
      const childCount = zoneDef ? zoneDef.childVisuals.length : 1;
      const yaw = zones.yawRad[i]!;
      const celebTimer = zones.celebratingTimer[i]!;

      for (let c = 0; c < childCount; c++) {
        if (this.activeCount >= MAX_SHADOWS) break;
        computeDeliveryChildPosition(
          zones.posX[i]!,
          zones.posY[i]!,
          zones.posZ[i]!,
          yaw,
          c,
          childCount,
          mountainField,
          _childPosScratch,
        );
        evaluateChildAnimPose(simState.elapsedSec, celebTimer, c, _childPoseScratch);

        let nx = 0;
        let ny = 1;
        let nz = 0;
        if (mountainField) {
          mountainField.evaluate(_childPosScratch.x, _childPosScratch.z, _mountainScratch);
          nx = _mountainScratch.normalX;
          ny = _mountainScratch.normalY;
          nz = _mountainScratch.normalZ;
        }

        const childScale = resolveChildVisualScale(zoneDef, c);

        this.pushShadow(
          _childPosScratch.x,
          _childPosScratch.y,
          _childPosScratch.z,
          nx,
          ny,
          nz,
          CHILD_SHADOW_RADIUS_M * childScale,
          _childPoseScratch.offsetY * 2.2,
          0.52,
        );
      }
    }

    // 5. Uncollected presents (terrain-normal aligned)
    if (this.lastMountainField !== mountainField) {
      this.presentCacheValid.fill(0);
      this.lastMountainField = mountainField;
    }
    const presents = simState.entities.presents;
    for (let i = 0; i < presents.count; i++) {
      if (this.activeCount >= MAX_SHADOWS) break;
      if (presents.collected[i]! !== 0) continue;
      const px = presents.posX[i]!;
      const py = presents.posY[i]!;
      const pz = presents.posZ[i]!;
      let nx = 0;
      let ny = 1;
      let nz = 0;
      if (
        i < MAX_SHADOWS &&
        this.presentCacheValid[i] === 1 &&
        this.presentCacheX[i] === px &&
        this.presentCacheZ[i] === pz
      ) {
        nx = this.presentCacheNx[i]!;
        ny = this.presentCacheNy[i]!;
        nz = this.presentCacheNz[i]!;
      } else if (mountainField) {
        mountainField.evaluate(px, pz, _mountainScratch);
        nx = _mountainScratch.normalX;
        ny = _mountainScratch.normalY;
        nz = _mountainScratch.normalZ;
        if (i < MAX_SHADOWS) {
          this.presentCacheValid[i] = 1;
          this.presentCacheX[i] = px;
          this.presentCacheZ[i] = pz;
          this.presentCacheNx[i] = nx;
          this.presentCacheNy[i] = ny;
          this.presentCacheNz[i] = nz;
        }
      }
      this.pushShadow(
        px,
        py,
        pz,
        nx,
        ny,
        nz,
        presents.defIds[i] === 'gift_golden' ? 0.78 : 0.65,
        0.35,
        0.44,
      );
    }

    this.instancedMesh.count = this.activeCount;
    if (this.activeCount > 0) {
      this.instancedMesh.instanceMatrix.needsUpdate = true;
      this.shadowAlphaAttr.needsUpdate = true;
    }
  }
}
