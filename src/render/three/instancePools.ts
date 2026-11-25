import * as THREE from 'three';
import { getCreatureDef } from '../../content/creatures';
import { getDeliveryZoneDef } from '../../content/deliveryZones';
import { getHazardDef, getRampDef } from '../../content/hazards';
import { getStageDef } from '../../content/stages';
import { clamp, lerp, lerpAngle } from '../../core/math';
import {
  CREATURE_PHASE_ATTACK,
  CREATURE_PHASE_TELEGRAPH,
  type ReadonlySimState,
} from '../../sim/contracts';
import type { GraphicsUtils } from './graphicsUtils';
import type { ProceduralMeshAssets } from './meshFactory';
import { ATLAS_FRAMES, type BillboardFrameName } from './spriteAtlas';
import type { SceneryProvider } from './sceneryCellStreamer';
import type { SharedToonMaterials } from './toonMaterials';

const MAX_BOULDERS_SMALL = 128;
const MAX_BOULDERS_LARGE = 96;
const MAX_PRESENTS_STD = 192;
const MAX_PRESENTS_GOLD = 96;
const MAX_RAMPS = 48;
const MAX_DYNAMIC_BILLBOARDS = 256;
export const MAX_STATIC_BILLBOARDS = 4096;

const _mat4 = new THREE.Matrix4();
const _pos = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _euler = new THREE.Euler(0, 0, 0, 'YXZ');
const _scale = new THREE.Vector3();

interface BillboardMeshWrapper {
  readonly mesh: THREE.InstancedMesh;
  readonly uvRectArray: Float32Array;
  readonly uvRectAttr: THREE.InstancedBufferAttribute;
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
  gfx.markAsCache(instGeo, instGeo.name);

  const mesh = gfx.createInstancedMesh(instGeo, billboardMat, capacity, label);
  mesh.frustumCulled = false;
  mesh.count = 0;

  return { mesh, uvRectArray, uvRectAttr, capacity };
}

function writeUvRect(
  uvRectArray: Float32Array,
  index: number,
  frame: BillboardFrameName,
  flipX: boolean,
): void {
  const rect = ATLAS_FRAMES[frame];
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
  private readonly staticBillboards: BillboardMeshWrapper;
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
    writeUvRect(this.staticBillboards.uvRectArray, this.staticPackCount, item.frame, item.flipX);
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
  ) {
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
    this.staticBillboards = createBillboardPoolMesh(
      gfx,
      billboardQuadGeo,
      billboardMat,
      MAX_STATIC_BILLBOARDS,
      'StaticSceneryBillboardPool',
    );
    this.staticBillboards.mesh.castShadow = false;
    this.rootGroup.add(this.dynamicBillboards.mesh, this.staticBillboards.mesh);
  }

  sync(simState: ReadonlySimState, alpha: number, sceneryProvider: SceneryProvider): void {
    const t = clamp(alpha, 0, 1);
    const elapsed = simState.elapsedSec;
    const frostedChance =
      getStageDef(simState.activeStageId)?.layout.scenery.frostedPineChance ?? 0.2;
    const pineHazardFrame: BillboardFrameName =
      frostedChance >= 0.5 ? 'pine_frosted' : 'pine_green';

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
        _pos.set(px, py, pz);
        _quat.identity();
        _scale.set(4.6 * hScale, 6.8 * hScale * tilt, 1);
        _mat4.compose(_pos, _quat, _scale);
        this.dynamicBillboards.mesh.setMatrixAt(dynBbCount, _mat4);
        writeUvRect(
          this.dynamicBillboards.uvRectArray,
          dynBbCount,
          pineHazardFrame,
          (i & 1) === 1,
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

    // 4. Waiting / Cheering Children at DeliveryZones (2.5D cylindrical billboards)
    const zones = simState.entities.deliveryZones;
    for (let i = 0; i < zones.count; i++) {
      const zoneDef = getDeliveryZoneDef(zones.defIds[i]!);
      const childCount = zoneDef ? zoneDef.childVisuals.length : 1;
      const yaw = zones.yawRad[i]!;
      const rightX = Math.cos(yaw);
      const rightZ = -Math.sin(yaw);
      const celebrating = zones.celebratingTimer[i]! > 0 || zones.active[i]! === 0;

      for (let c = 0; c < childCount; c++) {
        if (dynBbCount >= this.dynamicBillboards.capacity) break;
        const spread = (c - (childCount - 1) * 0.5) * 1.45;
        const hop = celebrating ? Math.abs(Math.sin(elapsed * 9.5 + c * 1.4)) * 0.45 : 0;

        _pos.set(
          zones.posX[i]! + rightX * spread,
          zones.posY[i]! + hop,
          zones.posZ[i]! + rightZ * spread,
        );
        _quat.identity();
        _scale.set(1.65, 1.85, 1);
        _mat4.compose(_pos, _quat, _scale);

        const frame: BillboardFrameName = celebrating
          ? 'child_cheer'
          : (c % 2 === 1 ? 'child_blue' : 'child_idle');

        this.dynamicBillboards.mesh.setMatrixAt(dynBbCount, _mat4);
        writeUvRect(this.dynamicBillboards.uvRectArray, dynBbCount, frame, c % 2 === 1);
        dynBbCount++;
      }
    }

    // 5. World-Space Patrolling Creatures (interpolated prev -> curr with alpha)
    const creatures = simState.entities.creatures;
    for (let i = 0; i < creatures.count; i++) {
      if (dynBbCount >= this.dynamicBillboards.capacity) break;
      const def = getCreatureDef(creatures.defIds[i]!);
      const cx = lerp(creatures.prevPosX[i]!, creatures.posX[i]!, t);
      const cy = lerp(creatures.prevPosY[i]!, creatures.posY[i]!, t);
      const cz = lerp(creatures.prevPosZ[i]!, creatures.posZ[i]!, t);
      const phase = creatures.stateCode[i]!;
      const isTelegraph =
        phase === CREATURE_PHASE_TELEGRAPH || phase === CREATURE_PHASE_ATTACK;
      const baseScale = def?.visual.kind === 'procedural' ? (def.visual.scale ?? 1) : 1;
      const pulse = isTelegraph ? 1 + 0.14 * creatures.telegraphProgress[i]! : 1;
      const waddle = Math.abs(Math.sin(elapsed * 8.5 + i * 2.1)) * 0.12;

      _pos.set(cx, cy + waddle, cz);
      _quat.identity();
      _scale.set(2.55 * baseScale * pulse, 2.75 * baseScale * pulse, 1);
      _mat4.compose(_pos, _quat, _scale);

      const heading = lerpAngle(creatures.prevHeadingRad[i]!, creatures.headingRad[i]!, t);
      const movingRight = Math.sin(heading) < 0;

      this.dynamicBillboards.mesh.setMatrixAt(dynBbCount, _mat4);
      writeUvRect(
        this.dynamicBillboards.uvRectArray,
        dynBbCount,
        isTelegraph ? 'bear_telegraph' : 'bear_walk',
        movingRight,
      );
      dynBbCount++;
    }

    this.dynamicBillboards.mesh.count = dynBbCount;
    if (dynBbCount > 0) {
      this.dynamicBillboards.mesh.instanceMatrix.needsUpdate = true;
      this.dynamicBillboards.uvRectAttr.needsUpdate = true;
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
      }
    }
  }
}
