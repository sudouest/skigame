import * as THREE from 'three';
import { getStageDef, STAGE_SUNNY_BLUE } from '../../content/stages';
import { clamp } from '../../core/math';
import { SeededRng } from '../../core/rng';
import type { ReadonlySimState } from '../../sim/contracts';
import type { GraphicsUtils } from './graphicsUtils';
import type { SharedLightingUniforms } from './toonMaterials';

export const MAX_SNOW_PARTICLES = 250;
const BOX_W = 36;
const BOX_H = 18;
const BOX_D = 36;
const MIN_FOG_DISTANCE_M = 65;

const _mat4 = new THREE.Matrix4();
const _pos = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _scale = new THREE.Vector3();
const _upAxis = new THREE.Vector3(0, 1, 0);
const _streakUp = new THREE.Vector3();
const _camForward = new THREE.Vector3();
const _stageFog = new THREE.Color();
const _stageSky = new THREE.Color();
const _stageSkyTop = new THREE.Color();
const _stageShadowSnow = new THREE.Color();
const _stageCliff = new THREE.Color();
const _stageSun = new THREE.Color();
const _stageAmbient = new THREE.Color();
const _stormFogTint = new THREE.Color('#9db4c8');
const _stormSkyTint = new THREE.Color('#647b94');
const _stormSkyTopTint = new THREE.Color('#354861');
const _stormShadowSnowTint = new THREE.Color('#7a95b3');
const _biomeTarget = new THREE.Color();

function wrapModulo(val: number, span: number): number {
  const half = span * 0.5;
  return ((((val + half) % span) + span) % span) - half;
}

/**
 * Camera-local wrapping snow-streak volume (~250 instanced elongated quads) paired with
 * `FogExp2` (clamped >= 65m) and shared `uBiomeTint` / `uBlizzardDim` atmospheric sync.
 * Zero per-frame heap allocations inside `sync()`.
 */
export class SnowVfx {
  readonly instancedMesh: THREE.InstancedMesh;
  readonly fog: THREE.FogExp2;
  readonly skyBottomColor: THREE.Color;
  readonly skyTopColor: THREE.Color;

  private readonly px = new Float32Array(MAX_SNOW_PARTICLES);
  private readonly py = new Float32Array(MAX_SNOW_PARTICLES);
  private readonly pz = new Float32Array(MAX_SNOW_PARTICLES);
  private readonly fallSpeed = new Float32Array(MAX_SNOW_PARTICLES);
  private readonly sizeScale = new Float32Array(MAX_SNOW_PARTICLES);

  private readonly sharedUniforms: SharedLightingUniforms;
  private readonly scene: THREE.Scene;
  private readonly dirLight: THREE.DirectionalLight;
  private readonly hemiLight: THREE.HemisphereLight;
  private readonly backgroundColor: THREE.Color;

  constructor(
    gfx: GraphicsUtils,
    scene: THREE.Scene,
    dirLight: THREE.DirectionalLight,
    hemiLight: THREE.HemisphereLight,
    sharedUniforms: SharedLightingUniforms,
  ) {
    this.scene = scene;
    this.dirLight = dirLight;
    this.hemiLight = hemiLight;
    this.sharedUniforms = sharedUniforms;

    this.backgroundColor = new THREE.Color(STAGE_SUNNY_BLUE.palette.skyBottom);
    this.skyBottomColor = this.backgroundColor;
    this.skyTopColor = this.sharedUniforms.uSkyTopColor.value;
    this.scene.background = this.backgroundColor;

    this.fog = new THREE.FogExp2(STAGE_SUNNY_BLUE.palette.fogColor, 0.006);
    this.scene.fog = this.fog;

    const quadGeo = new THREE.PlaneGeometry(0.08, 0.42);
    quadGeo.name = 'SnowStreakQuadGeo';
    gfx.markAsCache(quadGeo, 'SnowStreakQuadGeo');

    const snowMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.78,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: false,
    });
    snowMat.name = 'SnowStreakMaterial';
    gfx.markAsCache(snowMat, 'SnowStreakMaterial');

    this.instancedMesh = gfx.createInstancedMesh(
      quadGeo,
      snowMat,
      MAX_SNOW_PARTICLES,
      'SnowVfxStreaks',
    );
    this.instancedMesh.frustumCulled = false;
    this.instancedMesh.count = 0;
    this.scene.add(this.instancedMesh);

    const rng = new SeededRng(42019);
    for (let i = 0; i < MAX_SNOW_PARTICLES; i++) {
      this.px[i] = rng.nextRange(-BOX_W * 0.5, BOX_W * 0.5);
      this.py[i] = rng.nextRange(-BOX_H * 0.5, BOX_H * 0.5);
      this.pz[i] = rng.nextRange(-BOX_D * 0.5, BOX_D * 0.5);
      this.fallSpeed[i] = rng.nextRange(5.5, 10.5);
      this.sizeScale[i] = rng.nextRange(0.7, 1.4);
    }
  }

  /**
   * Keeps camera-local snow particle offsets continuous on floating-origin rebases.
   */
  handleWorldRebased(_deltaX: number, _deltaY: number, _deltaZ: number): void {
    // Particles are stored in camera-relative offsets, so rebasing camera.position is seamless.
  }

  sync(
    simState: ReadonlySimState,
    camera: THREE.Camera,
    frameDtSec: number,
  ): void {
    const weather = simState.activeWeather;
    const stageDef = getStageDef(simState.activeStageId) ?? STAGE_SUNNY_BLUE;
    const palette = stageDef.palette;
    const blizzardDim = clamp(weather.blizzardDim, 0, 1);

    // 1. Update shared biome + blizzard dimming uniforms & FogExp2 (clamped >= 65m)
    _biomeTarget.set(palette.biomeTint);
    this.sharedUniforms.uBiomeTint.value.lerp(_biomeTarget, 0.15);
    this.sharedUniforms.uBlizzardDim.value = blizzardDim;

    const clampedFogDist = Math.max(MIN_FOG_DISTANCE_M, weather.fogDistanceM);
    // density = 1.6 / d yields ~92% fog at d meters while preserving 25m+ crisp hazard silhouettes
    const targetDensity = 1.6 / clampedFogDist;
    this.fog.density += (targetDensity - this.fog.density) * Math.min(1, Math.max(0.08, frameDtSec * 6));

    _stageFog.set(palette.fogColor).lerp(_stormFogTint, blizzardDim * 0.65);
    _stageSky.set(palette.skyBottom).lerp(_stormSkyTint, blizzardDim * 0.7);
    _stageSkyTop.set(palette.skyTop).lerp(_stormSkyTopTint, blizzardDim * 0.72);
    _stageShadowSnow.set(palette.shadowSnowTint).lerp(_stormShadowSnowTint, blizzardDim * 0.45);
    _stageCliff.set(palette.cliffColor);
    this.fog.color.lerp(_stageFog, 0.15);
    this.backgroundColor.lerp(_stageSky, 0.15);
    this.sharedUniforms.uSkyTopColor.value.lerp(_stageSkyTop, 0.15);
    this.sharedUniforms.uShadowSnowTint.value.lerp(_stageShadowSnow, 0.15);
    this.sharedUniforms.uCliffColor.value.lerp(_stageCliff, 0.15);

    _stageSun.set(palette.sunColor);
    _stageAmbient.set(palette.ambientColor);
    this.dirLight.color.lerp(_stageSun, 0.15);
    this.dirLight.intensity = 1.15 * (1 - blizzardDim * 0.32);
    this.hemiLight.color.lerp(_stageSky, 0.15);
    this.hemiLight.groundColor.lerp(_stageAmbient, 0.15);
    this.hemiLight.intensity = 0.85 * (1 - blizzardDim * 0.25);

    // 2. Update camera-local snow-streak particles
    const targetCount = Math.min(
      MAX_SNOW_PARTICLES,
      Math.max(0, Math.round(weather.snowParticleCount)),
    );
    if (targetCount <= 0) {
      this.instancedMesh.count = 0;
      return;
    }

    const dt = Math.min(0.1, Math.max(0, frameDtSec));
    const windX = weather.windLateral;
    camera.updateMatrixWorld();
    camera.getWorldDirection(_camForward);
    const camX = camera.position.x + _camForward.x * 11;
    const camY = camera.position.y + _camForward.y * 11;
    const camZ = camera.position.z + _camForward.z * 11;

    const stretch = 1 + clamp(Math.abs(windX) * 0.12 + blizzardDim * 0.8, 0, 1.8);
    _streakUp.set(windX * 0.08, -1, 0).normalize();
    _quat.setFromUnitVectors(_upAxis, _streakUp);

    for (let i = 0; i < targetCount; i++) {
      let lx = this.px[i]! + windX * dt;
      let ly = this.py[i]! - this.fallSpeed[i]! * dt;
      let lz = this.pz[i]!;

      lx = wrapModulo(lx, BOX_W);
      ly = wrapModulo(ly, BOX_H);
      lz = wrapModulo(lz, BOX_D);

      this.px[i] = lx;
      this.py[i] = ly;
      this.pz[i] = lz;

      _pos.set(camX + lx, camY + ly, camZ + lz);
      const s = this.sizeScale[i]!;
      _scale.set(s, s * stretch, 1);
      _mat4.compose(_pos, _quat, _scale);
      this.instancedMesh.setMatrixAt(i, _mat4);
    }

    this.instancedMesh.count = targetCount;
    this.instancedMesh.instanceMatrix.needsUpdate = true;
  }
}
