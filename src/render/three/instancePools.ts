import * as THREE from 'three';
import { getCreatureDef } from '../../content/creatures';
import { getDeliveryZoneDef } from '../../content/deliveryZones';
import { getHazardDef, getRampDef } from '../../content/hazards';
import { getStageDef } from '../../content/stages';
import {
  CHARACTER_SCALE_TUNING,
  resolveChildScaleMultiplier,
  resolveChildSlotSpreadMultiplier,
  resolveCreatureScaleMultiplier,
  type CharacterScaleTuning,
} from '../../content/visibilityTuning';
import { FIXED_DT } from '../../core/fixedLoop';
import { clamp, lerp, lerpAngle } from '../../core/math';
import { hashCoords2DU32 } from '../../core/rng';
import type { ReadonlySimState } from '../../sim/contracts';
import {
  CHARACTER_ATLAS_FRAMES,
  CHILD_SPRITE_BASE_HEIGHT_M,
  CHILD_SPRITE_BASE_WIDTH_M,
} from './characterSpriteAtlas';
import type { GraphicsUtils } from './graphicsUtils';
import type { ProceduralMeshAssets } from './meshFactory';
import {
  CHILD_SLOT_SPREAD_M,
  computeDeliveryChildPosition,
  computeDeliveryZoneHash,
  createBillboardAnimPose,
  evaluateChildAnimPose,
  evaluateCreatureAnimEntry,
  resolveChildVariant,
  resolveChildVisualScale,
  type CreatureAnimMetrics,
} from './spriteAnimation';
import {
  ATLAS_FRAMES,
  FROSTED_TREE_FRAMES,
  GREEN_TREE_FRAMES,
  TREE_FRAME_PROPORTIONS,
  type AtlasFrameRect,
  type BillboardFrameName,
} from './spriteAtlas';
import type { SceneryProvider } from './sceneryCellStreamer';
import type { SharedToonMaterials } from './toonMaterials';

const MAX_BOULDERS_SMALL = 128;
const MAX_BOULDERS_LARGE = 96;
const MAX_PRESENTS_STD = 192;
const MAX_PRESENTS_GOLD = 96;
const MAX_RAMPS = 48;
const MAX_DYNAMIC_BILLBOARDS = 256;
export const MAX_CHARACTER_BILLBOARDS = 128;
export const MAX_STATIC_BILLBOARDS = 4096;

const _mat4 = new THREE.Matrix4();
const _pos = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _euler = new THREE.Euler(0, 0, 0, 'YXZ');
const _scale = new THREE.Vector3();
const _childPosScratch = { x: 0, y: 0, z: 0 };
const _childPoseScratch = createBillboardAnimPose('child_idle_0');
const _creaturePoseScratch = createBillboardAnimPose('bear_walk');
const _creatureMetricsScratch: CreatureAnimMetrics = {
  baseWidthM: 2.55,
  baseHeightM: 2.75,
  flipX: false,
};

interface BillboardMeshWrapper {
  readonly mesh: THREE.InstancedMesh;
  readonly uvRectArray: Float32Array;
  readonly uvRectAttr: THREE.InstancedBufferAttribute;
  readonly tiltArray: Float32Array;
  readonly tiltAttr: THREE.InstancedBufferAttribute;
  readonly capacity: number;
}

function createBillboardPoolMesh(
  gfx: GraphicsUtils,
  quadGeo: THREE.BufferGeometry,
  billboardMat: THREE.Material,
  capacity: number,
  label: string,
): BillboardMeshWrapper {
  const instGeo = new THREE.BufferGeometry();
  instGeo.name = `${label}_InstGeo`;
  instGeo.index = quadGeo.index;
  instGeo.setAttribute('position', quadGeo.attributes.position!);
  instGeo.setAttribute('normal', quadGeo.attributes.normal!);
  instGeo.setAttribute('uv', quadGeo.attributes.uv!);

  const uvRectArray = new Float32Array(capacity * 4);
  const uvRectAttr = new THREE.InstancedBufferAttribute(uvRectArray, 4);
  uvRectAttr.setUsage(THREE.DynamicDrawUsage);
  instGeo.setAttribute('aUvRect', uvRectAttr);

  const tiltArray = new Float32Array(capacity);
  const tiltAttr = new THREE.InstancedBufferAttribute(tiltArray, 1);
  tiltAttr.setUsage(THREE.DynamicDrawUsage);
  instGeo.setAttribute('aTilt', tiltAttr);

  gfx.markAsCache(instGeo, instGeo.name);

  const mesh = gfx.createInstancedMesh(instGeo, billboardMat, capacity, label);
  mesh.frustumCulled = false;
  mesh.count = 0;

  return { mesh, uvRectArray, uvRectAttr, tiltArray, tiltAttr, capacity };
}

function writeUvRect(
  uvRectArray: Float32Array,
  index: number,
  rect: AtlasFrameRect,
  flipX: boolean,
): void {
  const base = index * 4;
  if (flipX) {
    uvRectArray[base] = rect.uOffset + rect.uScale;
    uvRectArray[base + 1] = rect.vOffset;
    uvRectArray[base + 2] = -rect.uScale;
    uvRectArray[base + 3] = rect.vScale;
  } else {
    uvRectArray[base] = rect.uOffset;
    uvRectArray[base + 1] = rect.vOffset;
    uvRectArray[base + 2] = rect.uScale;
    uvRectArray[base + 3] = rect.vScale;
  }
}

/**
 * Contiguously packed GPU InstancedMesh pools (`frustumCulled = false`) for 3D props,
 * selective smooth-normal inverted-hull outlines, and 2.5D cylindrical billboards.
 * Zero per-frame heap allocations inside `sync()`.
 */
export class InstancePools {
  readonly rootGroup: THREE.Group;

  private readonly boulderSmall: THREE.InstancedMesh;
  private readonly boulderSmallOutline: THREE.InstancedMesh;
  private readonly boulderLarge: THREE.InstancedMesh;
  private readonly boulderLargeOutline: THREE.InstancedMesh;
  private readonly presentStd: THREE.InstancedMesh;
  private readonly presentStdOutline: THREE.InstancedMesh;
  private readonly presentGold: THREE.InstancedMesh;
  private readonly presentGoldOutline: THREE.InstancedMesh;
  private readonly rampMesh: THREE.InstancedMesh;
  private readonly rampOutlineMesh: THREE.InstancedMesh;

  private readonly dynamicBillboards: BillboardMeshWrapper;
  private readonly characterBillboards: BillboardMeshWrapper;
  private readonly staticBillboards: BillboardMeshWrapper;
  private readonly scaleTuning: CharacterScaleTuning;
  private staticPackCount = 0;
  private lastSceneryRevision = -1;

  private readonly packStaticSceneryVisitor = (
    ox: number,
    oy: number,
    oz: number,
    item: { localX: number; localY: number; localZ: number; width: number; height: number; frame: BillboardFrameName; flipX: boolean },
  ): boolean => {
    if (this.staticPackCount >= this.staticBillboards.capacity) return false;
    _pos.set(ox + item.localX, oy + item.localY, oz + item.localZ);
    _quat.identity();
    _scale.set(item.width, item.height, 1);
    _mat4.compose(_pos, _quat, _scale);

    this.staticBillboards.mesh.setMatrixAt(this.staticPackCount, _mat4);
    this.staticBillboards.tiltArray[this.staticPackCount] = 0;
    writeUvRect(
      this.staticBillboards.uvRectArray,
      this.staticPackCount,
      ATLAS_FRAMES[item.frame],
      item.flipX,
    );
    this.staticPackCount++;
    return true;
  };

  constructor(
    gfx: GraphicsUtils,
    materials: SharedToonMaterials,
    outlineMat: THREE.Material,
    billboardMat: THREE.Material,
    billboardQuadGeo: THREE.BufferGeometry,
    assets: ProceduralMeshAssets,
    characterBillboardMat?: THREE.Material,
    scaleTuning: CharacterScaleTuning = CHARACTER_SCALE_TUNING,
  ) {
    this.scaleTuning = scaleTuning;
    this.rootGroup = new THREE.Group();
    this.rootGroup.name = 'InstancePoolsRoot';

    const makeOutlinedPair = (
      geo: THREE.BufferGeometry,
      cap: number,
      name: string,
    ): [THREE.InstancedMesh, THREE.InstancedMesh] => {
      const main = gfx.createInstancedMesh(geo, materials.propToonMaterial, cap, name);
      main.frustumCulled = false;
      main.castShadow = true;
      main.count = 0;
      const outline = gfx.createInstancedMesh(geo, outlineMat, cap, `${name}_Outline`);
      outline.frustumCulled = false;
      outline.castShadow = false;
      outline.count = 0;
      this.rootGroup.add(main, outline);
      return [main, outline];
    };

    [this.boulderSmall, this.boulderSmallOutline] = makeOutlinedPair(
      assets.boulderSmallGeo,
      MAX_BOULDERS_SMALL,
      'BoulderSmallPool',
    );
    [this.boulderLarge, this.boulderLargeOutline] = makeOutlinedPair(
      assets.boulderLargeGeo,
      MAX_BOULDERS_LARGE,
      'BoulderLargePool',
    );
    [this.presentStd, this.presentStdOutline] = makeOutlinedPair(
      assets.presentStdGeo,
      MAX_PRESENTS_STD,
      'PresentStdPool',
    );
    [this.presentGold, this.presentGoldOutline] = makeOutlinedPair(
      assets.presentGoldGeo,
      MAX_PRESENTS_GOLD,
      'PresentGoldPool',
    );
    [this.rampMesh, this.rampOutlineMesh] = makeOutlinedPair(
      assets.rampGeo,
      MAX_RAMPS,
      'RampPool',
    );

    this.dynamicBillboards = createBillboardPoolMesh(
      gfx,
      billboardQuadGeo,
      billboardMat,
      MAX_DYNAMIC_BILLBOARDS,
      'DynamicBillboardPool',
    );
    this.dynamicBillboards.mesh.castShadow = false;
    this.characterBillboards = createBillboardPoolMesh(
      gfx,
      billboardQuadGeo,
      characterBillboardMat ?? billboardMat,
      MAX_CHARACTER_BILLBOARDS,
      'CharacterBillboardPool',
    );
    this.characterBillboards.mesh.castShadow = false;
    this.staticBillboards = createBillboardPoolMesh(
      gfx,
      billboardQuadGeo,
      billboardMat,
      MAX_STATIC_BILLBOARDS,
      'StaticSceneryBillboardPool',
    );
    this.staticBillboards.mesh.castShadow = false;
    this.rootGroup.add(
      this.dynamicBillboards.mesh,
      this.characterBillboards.mesh,
      this.staticBillboards.mesh,
    );
  }

  sync(simState: ReadonlySimState, alpha: number, sceneryProvider: SceneryProvider): void {
    const t = clamp(alpha, 0, 1);
    const elapsed = simState.elapsedSec;
    const frostedChance =
      getStageDef(simState.activeStageId)?.layout.scenery.frostedPineChance ?? 0.2;

    let bSmallCount = 0;
    let bLargeCount = 0;
    let dynBbCount = 0;

    // 1. Hazards (boulder_small, boulder_large, pine_tree)
    const hazards = simState.entities.hazards;
    for (let i = 0; i < hazards.count; i++) {
      const defId = hazards.defIds[i]!;
      const def = getHazardDef(defId);
      const px = hazards.posX[i]!;
      const py = hazards.posY[i]!;
      const pz = hazards.posZ[i]!;
      const yaw = hazards.yawRad[i]!;
      const triggered = hazards.triggered[i]! !== 0;

      if (defId === 'pine_tree' || def?.visual.kind === 'billboard') {
        if (dynBbCount >= this.dynamicBillboards.capacity) continue;
        const hScale = hazards.scale[i] || 1;
        const tilt = triggered ? 0.55 : 1.0;
        const absQx = Math.round((px + simState.rebase.offsetX) * 4);
        const absQz = Math.round((pz + simState.rebase.offsetZ) * 4);
        const hHash = hashCoords2DU32(absQx, absQz, ((hazards.segmentIds[i] ?? 0) ^ 0x7f4a7c15) >>> 0);
        const useFrosted = (hHash & 0xffff) / 65536 < frostedChance;
        const pool = useFrosted ? FROSTED_TREE_FRAMES : GREEN_TREE_FRAMES;
        const frame = pool[(hHash >>> 16) % pool.length]!;
        const flipX = ((hHash >>> 24) & 1) === 1;
        const prop = TREE_FRAME_PROPORTIONS[frame];
        let w: number;
        let h: number;
        if (prop) {
          const baseH = 6.8 * hScale * prop.heightScale;
          w = baseH * prop.aspect;
          h = baseH * tilt;
        } else {
          w = 4.6 * hScale;
          h = 6.8 * hScale * tilt;
        }
        _pos.set(px, py, pz);
        _quat.identity();
        _scale.set(w, h, 1);
        _mat4.compose(_pos, _quat, _scale);
        this.dynamicBillboards.mesh.setMatrixAt(dynBbCount, _mat4);
        this.dynamicBillboards.tiltArray[dynBbCount] = 0;
        writeUvRect(
          this.dynamicBillboards.uvRectArray,
          dynBbCount,
          ATLAS_FRAMES[frame],
          flipX,
        );
        dynBbCount++;
        continue;
      }

      const r = hazards.radius[i]! > 0 ? hazards.radius[i]! : (def?.collider.radius ?? 1);
      const h = hazards.height[i]! > 0 ? hazards.height[i]! : (def?.collider.height ?? 1);
      const shrink = triggered ? 0.65 : 1.0;

      _pos.set(px, py, pz);
      _euler.set(triggered ? 0.35 : 0, yaw, 0, 'YXZ');
      _quat.setFromEuler(_euler);
      _scale.set(r * shrink, h * shrink, r * shrink);
      _mat4.compose(_pos, _quat, _scale);

      if (defId === 'boulder_small') {
        if (bSmallCount < MAX_BOULDERS_SMALL) {
          this.boulderSmall.setMatrixAt(bSmallCount, _mat4);
          this.boulderSmallOutline.setMatrixAt(bSmallCount, _mat4);
          bSmallCount++;
        }
      } else if (bLargeCount < MAX_BOULDERS_LARGE) {
        this.boulderLarge.setMatrixAt(bLargeCount, _mat4);
        this.boulderLargeOutline.setMatrixAt(bLargeCount, _mat4);
        bLargeCount++;
      }
    }

    this.boulderSmall.count = bSmallCount;
    this.boulderSmallOutline.count = bSmallCount;
    if (bSmallCount > 0) {
      this.boulderSmall.instanceMatrix.needsUpdate = true;
      this.boulderSmallOutline.instanceMatrix.needsUpdate = true;
    }

    this.boulderLarge.count = bLargeCount;
    this.boulderLargeOutline.count = bLargeCount;
    if (bLargeCount > 0) {
      this.boulderLarge.instanceMatrix.needsUpdate = true;
      this.boulderLargeOutline.instanceMatrix.needsUpdate = true;
    }

    // 2. Presents (gift_standard, gift_golden)
    const presents = simState.entities.presents;
    let pStdCount = 0;
    let pGoldCount = 0;
    for (let i = 0; i < presents.count; i++) {
      if (presents.collected[i]! !== 0) continue;
      const defId = presents.defIds[i]!;
      const phase = presents.bobPhase[i]!;
      const bobY = 0.28 + Math.sin(elapsed * 3.2 + phase) * 0.16;
      const spinY = elapsed * 1.9 + phase;

      _pos.set(presents.posX[i]!, presents.posY[i]! + bobY, presents.posZ[i]!);
      _euler.set(0, spinY, 0, 'YXZ');
      _quat.setFromEuler(_euler);

      if (defId === 'gift_golden') {
        if (pGoldCount < MAX_PRESENTS_GOLD) {
          _scale.setScalar(1.22);
          _mat4.compose(_pos, _quat, _scale);
          this.presentGold.setMatrixAt(pGoldCount, _mat4);
          this.presentGoldOutline.setMatrixAt(pGoldCount, _mat4);
          pGoldCount++;
        }
      } else if (pStdCount < MAX_PRESENTS_STD) {
        _scale.setScalar(1.0);
        _mat4.compose(_pos, _quat, _scale);
        this.presentStd.setMatrixAt(pStdCount, _mat4);
        this.presentStdOutline.setMatrixAt(pStdCount, _mat4);
        pStdCount++;
      }
    }

    this.presentStd.count = pStdCount;
    this.presentStdOutline.count = pStdCount;
    if (pStdCount > 0) {
      this.presentStd.instanceMatrix.needsUpdate = true;
      this.presentStdOutline.instanceMatrix.needsUpdate = true;
    }

    this.presentGold.count = pGoldCount;
    this.presentGoldOutline.count = pGoldCount;
    if (pGoldCount > 0) {
      this.presentGold.instanceMatrix.needsUpdate = true;
      this.presentGoldOutline.instanceMatrix.needsUpdate = true;
    }

    // 3. Ski Ramps (pitched by RampPoolView.pitchRad in Euler 'YXZ')
    const ramps = simState.entities.ramps;
    let rampCount = 0;
    for (let i = 0; i < ramps.count && rampCount < MAX_RAMPS; i++) {
      const def = getRampDef(ramps.defIds[i]!);
      const w = ramps.width[i]! > 0 ? ramps.width[i]! : (def?.width ?? 4.2);
      const h = ramps.height[i]! > 0 ? ramps.height[i]! : (def?.height ?? 1.35);
      const l = ramps.length[i]! > 0 ? ramps.length[i]! : (def?.length ?? 6.5);

      _pos.set(ramps.posX[i]!, ramps.posY[i]!, ramps.posZ[i]!);
      _euler.set(ramps.pitchRad[i]!, ramps.yawRad[i]!, 0, 'YXZ');
      _quat.setFromEuler(_euler);
      _scale.set(w, h, l);
      _mat4.compose(_pos, _quat, _scale);

      this.rampMesh.setMatrixAt(rampCount, _mat4);
      this.rampOutlineMesh.setMatrixAt(rampCount, _mat4);
      rampCount++;
    }
    this.rampMesh.count = rampCount;
    this.rampOutlineMesh.count = rampCount;
    if (rampCount > 0) {
      this.rampMesh.instanceMatrix.needsUpdate = true;
      this.rampOutlineMesh.instanceMatrix.needsUpdate = true;
    }

    this.dynamicBillboards.mesh.count = dynBbCount;
    if (dynBbCount > 0) {
      this.dynamicBillboards.mesh.instanceMatrix.needsUpdate = true;
      this.dynamicBillboards.uvRectAttr.needsUpdate = true;
      this.dynamicBillboards.tiltAttr.needsUpdate = true;
    }

    // 4. Waiting / Cheering Children at DeliveryZones (dedicated CharacterBillboardPool)
    const camPosX = lerp(simState.prevCamera.posX, simState.currCamera.posX, t);
    const camPosZ = lerp(simState.prevCamera.posZ, simState.currCamera.posZ, t);
    const camLookX = lerp(simState.prevCamera.lookAtX, simState.currCamera.lookAtX, t);
    const camLookZ = lerp(simState.prevCamera.lookAtZ, simState.currCamera.lookAtZ, t);
    const camDx = camLookX - camPosX;
    const camDz = camLookZ - camPosZ;
    const camLen = Math.hypot(camDx, camDz);
    const camFwdX = camLen > 1e-4 ? camDx / camLen : 0;
    const camFwdZ = camLen > 1e-4 ? camDz / camLen : -1;
    const camRightX = -camFwdZ;
    const camRightZ = camFwdX;

    const childScaleMult = resolveChildScaleMultiplier(this.scaleTuning);
    const childSpreadM = CHILD_SLOT_SPREAD_M * resolveChildSlotSpreadMultiplier(this.scaleTuning);
    const creatureScaleMult = resolveCreatureScaleMultiplier(this.scaleTuning);

    let charBbCount = 0;
    const zones = simState.entities.deliveryZones;
    for (let i = 0; i < zones.count; i++) {
      const zoneDef = getDeliveryZoneDef(zones.defIds[i]!);
      const childCount = zoneDef ? zoneDef.childVisuals.length : 1;
      const yaw = zones.yawRad[i]!;
      const celebTimer = zones.celebratingTimer[i]!;
      const zoneHash = computeDeliveryZoneHash(
        zones.posX[i]!,
        zones.posZ[i]!,
        simState.rebase.offsetX,
        simState.rebase.offsetZ,
        zones.segmentIds[i] ?? 0,
      );

      for (let c = 0; c < childCount; c++) {
        if (charBbCount >= this.characterBillboards.capacity) break;
        computeDeliveryChildPosition(
          zones.posX[i]!,
          zones.posY[i]!,
          zones.posZ[i]!,
          yaw,
          c,
          childCount,
          simState.mountainField,
          _childPosScratch,
          childSpreadM,
        );
        const childScale = resolveChildVisualScale(zoneDef, c);
        const variant = resolveChildVariant(zoneDef, c, zoneHash);
        const flipX = c % 2 === 1;
        evaluateChildAnimPose(elapsed, celebTimer, c, _childPoseScratch, flipX, variant);

        const finalChildScale = childScale * childScaleMult;

        _pos.set(
          _childPosScratch.x,
          _childPosScratch.y + _childPoseScratch.offsetY * childScaleMult,
          _childPosScratch.z,
        );
        _quat.identity();
        _scale.set(
          CHILD_SPRITE_BASE_WIDTH_M * finalChildScale * _childPoseScratch.scaleX,
          CHILD_SPRITE_BASE_HEIGHT_M * finalChildScale * _childPoseScratch.scaleY,
          1,
        );
        _mat4.compose(_pos, _quat, _scale);

        this.characterBillboards.mesh.setMatrixAt(charBbCount, _mat4);
        this.characterBillboards.tiltArray[charBbCount] = _childPoseScratch.tiltRad;
        writeUvRect(
          this.characterBillboards.uvRectArray,
          charBbCount,
          CHARACTER_ATLAS_FRAMES[_childPoseScratch.frame],
          flipX,
        );
        charBbCount++;
      }
    }

    // 5. World-Space Creatures (interpolated prev -> curr with alpha, dispatched by CreatureDef)
    const creatures = simState.entities.creatures;
    for (let i = 0; i < creatures.count; i++) {
      if (charBbCount >= this.characterBillboards.capacity) break;
      const defId = creatures.defIds[i]!;
      const def = getCreatureDef(defId);
      const cx = lerp(creatures.prevPosX[i]!, creatures.posX[i]!, t);
      const cy = lerp(creatures.prevPosY[i]!, creatures.posY[i]!, t);
      const cz = lerp(creatures.prevPosZ[i]!, creatures.posZ[i]!, t);
      const clearanceM = Math.max(0, cy - creatures.groundY[i]!);
      const velY = (creatures.posY[i]! - creatures.prevPosY[i]!) / FIXED_DT;
      const heading = lerpAngle(creatures.prevHeadingRad[i]!, creatures.headingRad[i]!, t);

      if (
        !evaluateCreatureAnimEntry(
          defId,
          def?.visual,
          elapsed,
          creatures.stateCode[i]!,
          creatures.telegraphProgress[i]!,
          clearanceM,
          velY,
          heading,
          camRightX,
          camRightZ,
          i,
          _creaturePoseScratch,
          _creatureMetricsScratch,
        )
      ) {
        continue;
      }

      _pos.set(cx, cy + _creaturePoseScratch.offsetY * creatureScaleMult, cz);
      _quat.identity();
      _scale.set(
        _creatureMetricsScratch.baseWidthM * creatureScaleMult * _creaturePoseScratch.scaleX,
        _creatureMetricsScratch.baseHeightM * creatureScaleMult * _creaturePoseScratch.scaleY,
        1,
      );
      _mat4.compose(_pos, _quat, _scale);

      this.characterBillboards.mesh.setMatrixAt(charBbCount, _mat4);
      this.characterBillboards.tiltArray[charBbCount] = _creaturePoseScratch.tiltRad;
      writeUvRect(
        this.characterBillboards.uvRectArray,
        charBbCount,
        CHARACTER_ATLAS_FRAMES[_creaturePoseScratch.frame],
        _creatureMetricsScratch.flipX,
      );
      charBbCount++;
    }

    this.characterBillboards.mesh.count = charBbCount;
    if (charBbCount > 0) {
      this.characterBillboards.mesh.instanceMatrix.needsUpdate = true;
      this.characterBillboards.uvRectAttr.needsUpdate = true;
      this.characterBillboards.tiltAttr.needsUpdate = true;
    }

    // 6. Static Off-Trail Scenery (repacked ONLY when sceneryRevision changes!)
    if (sceneryProvider.sceneryRevision !== this.lastSceneryRevision) {
      this.lastSceneryRevision = sceneryProvider.sceneryRevision;
      this.staticPackCount = 0;
      sceneryProvider.forEachActiveScenery(this.packStaticSceneryVisitor);

      this.staticBillboards.mesh.count = this.staticPackCount;
      if (this.staticPackCount > 0) {
        this.staticBillboards.mesh.instanceMatrix.needsUpdate = true;
        this.staticBillboards.uvRectAttr.needsUpdate = true;
        this.staticBillboards.tiltAttr.needsUpdate = true;
      }
    }
  }
}
