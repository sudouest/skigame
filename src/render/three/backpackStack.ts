import * as THREE from 'three';
import { clamp } from '../../core/math';
import type { ReadonlySimState } from '../../sim/contracts';
import type { GraphicsUtils } from './graphicsUtils';
import type { ProceduralMeshAssets } from './meshFactory';
import type { SharedToonMaterials } from './toonMaterials';

const MAX_STACK_SLOTS = 24;

const _mat4 = new THREE.Matrix4();
const _pos = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _euler = new THREE.Euler(0, 0, 0, 'YXZ');
const _scale = new THREE.Vector3();

/**
 * Diegetic present stack attached to the skier's `backpackAnchor`.
 * Reuses shared present geometries and `propToonMaterial` via two small `InstancedMesh` pools
 * (`frustumCulled = false`) with zero material cloning and zero per-frame allocations.
 */
export class BackpackStack {
  private readonly stdMesh: THREE.InstancedMesh;
  private readonly goldMesh: THREE.InstancedMesh;
  private readonly popTimers = new Float32Array(MAX_STACK_SLOTS);
  private lastCarriedCount = 0;

  constructor(
    gfx: GraphicsUtils,
    materials: SharedToonMaterials,
    assets: ProceduralMeshAssets,
    backpackAnchor: THREE.Group,
  ) {
    this.stdMesh = gfx.createInstancedMesh(
      assets.presentStdGeo,
      materials.propToonMaterial,
      MAX_STACK_SLOTS,
      'BackpackStackStd',
    );
    this.stdMesh.frustumCulled = false;
    this.stdMesh.castShadow = true;
    this.stdMesh.count = 0;

    this.goldMesh = gfx.createInstancedMesh(
      assets.presentGoldGeo,
      materials.propToonMaterial,
      MAX_STACK_SLOTS,
      'BackpackStackGold',
    );
    this.goldMesh.frustumCulled = false;
    this.goldMesh.castShadow = true;
    this.goldMesh.count = 0;

    backpackAnchor.add(this.stdMesh, this.goldMesh);
  }

  triggerPickupPop(slotIndex: number): void {
    if (slotIndex >= 0 && slotIndex < MAX_STACK_SLOTS) {
      this.popTimers[slotIndex] = 0.28;
    }
  }

  sync(simState: ReadonlySimState, frameDtSec: number): void {
    const carriedCount = Math.min(simState.carriedCount, MAX_STACK_SLOTS);
    if (carriedCount > this.lastCarriedCount) {
      for (let i = this.lastCarriedCount; i < carriedCount; i++) {
        this.popTimers[i] = 0.28;
      }
    }
    this.lastCarriedCount = carriedCount;

    const dt = Math.max(0, frameDtSec);
    const carveSway = clamp(simState.currSkier.carveAngleRad * 0.16, -0.35, 0.35);
    const elapsed = simState.elapsedSec;

    let stdCount = 0;
    let goldCount = 0;

    for (let i = 0; i < carriedCount; i++) {
      const timer = this.popTimers[i]!;
      if (timer > 0) {
        this.popTimers[i] = Math.max(0, timer - dt);
      }
      const popPhase = timer > 0 ? Math.sin((1 - timer / 0.28) * Math.PI) * 0.28 : 0;

      // Stack up to 2 neat columns behind skier's back when capacity is large
      const col = carriedCount > 6 ? (i & 1) * 0.34 - 0.17 : 0;
      const tier = carriedCount > 6 ? (i >> 1) : i;
      const swayX = col - Math.sin(elapsed * 4.5 + tier * 0.6) * 0.025 + carveSway * tier * 0.12;
      const y = tier * 0.36;
      const z = 0.08 + tier * 0.03;

      const s = 0.42 * (1 + popPhase);
      _pos.set(swayX, y, z);
      _euler.set(0.08 * tier, (i % 3 - 1) * 0.16, -carveSway * 0.25, 'YXZ');
      _quat.setFromEuler(_euler);
      _scale.setScalar(s);
      _mat4.compose(_pos, _quat, _scale);

      const defId = simState.carriedPresentDefIds[i];
      if (defId === 'gift_golden') {
        this.goldMesh.setMatrixAt(goldCount++, _mat4);
      } else {
        this.stdMesh.setMatrixAt(stdCount++, _mat4);
      }
    }

    this.stdMesh.count = stdCount;
    if (stdCount > 0) {
      this.stdMesh.instanceMatrix.needsUpdate = true;
    }

    this.goldMesh.count = goldCount;
    if (goldCount > 0) {
      this.goldMesh.instanceMatrix.needsUpdate = true;
    }
  }
}
