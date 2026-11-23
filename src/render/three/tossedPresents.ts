import * as THREE from 'three';
import { clamp, lerp } from '../../core/math';
import type { ReadonlySimState } from '../../sim/contracts';
import type { GraphicsUtils } from './graphicsUtils';
import type { ProceduralMeshAssets } from './meshFactory';
import type { SharedToonMaterials } from './toonMaterials';

const MAX_TOSSED_PRESENTS = 64;

const _mat4 = new THREE.Matrix4();
const _pos = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _euler = new THREE.Euler(0, 0, 0, 'YXZ');
const _scale = new THREE.Vector3();

/**
 * Pooled parabolic arc meshes for Delivery Zone gift tosses (`kind === 0`)
 * and wipeout gift scatters (`kind === 1`), interpolated with `alpha`.
 */
export class TossedPresents {
  readonly rootGroup: THREE.Group;
  private readonly stdMesh: THREE.InstancedMesh;
  private readonly goldMesh: THREE.InstancedMesh;

  constructor(
    gfx: GraphicsUtils,
    materials: SharedToonMaterials,
    assets: ProceduralMeshAssets,
  ) {
    this.rootGroup = new THREE.Group();
    this.rootGroup.name = 'TossedPresentsRoot';

    this.stdMesh = gfx.createInstancedMesh(
      assets.presentStdGeo,
      materials.propToonMaterial,
      MAX_TOSSED_PRESENTS,
      'TossedPresentsStd',
    );
    this.stdMesh.frustumCulled = false;
    this.stdMesh.count = 0;

    this.goldMesh = gfx.createInstancedMesh(
      assets.presentGoldGeo,
      materials.propToonMaterial,
      MAX_TOSSED_PRESENTS,
      'TossedPresentsGold',
    );
    this.goldMesh.frustumCulled = false;
    this.goldMesh.count = 0;

    this.rootGroup.add(this.stdMesh, this.goldMesh);
  }

  sync(simState: ReadonlySimState, alpha: number): void {
    const t = clamp(alpha, 0, 1);
    const tossed = simState.entities.tossedPresents;
    let stdCount = 0;
    let goldCount = 0;

    for (let i = 0; i < tossed.count; i++) {
      const px = lerp(tossed.prevPosX[i]!, tossed.posX[i]!, t);
      const py = lerp(tossed.prevPosY[i]!, tossed.posY[i]!, t);
      const pz = lerp(tossed.prevPosZ[i]!, tossed.posZ[i]!, t);
      const spin = lerp(tossed.prevSpinRad[i]!, tossed.spinRad[i]!, t);
      const prog = clamp(tossed.progress[i]!, 0, 1);
      const isScatter = tossed.kind[i]! === 1;

      // Pop-out & shrink cleanly at arc end
      const arcScale = isScatter
        ? lerp(0.85, 0.35, prog)
        : 0.65 + Math.sin(prog * Math.PI) * 0.45;

      _pos.set(px, py, pz);
      _euler.set(spin * (isScatter ? 1.4 : 0.6), spin, isScatter ? spin * 0.8 : 0, 'YXZ');
      _quat.setFromEuler(_euler);
      _scale.setScalar(arcScale);
      _mat4.compose(_pos, _quat, _scale);

      const defId = tossed.defIds[i];
      if (defId === 'gift_golden') {
        if (goldCount < MAX_TOSSED_PRESENTS) {
          this.goldMesh.setMatrixAt(goldCount++, _mat4);
        }
      } else if (stdCount < MAX_TOSSED_PRESENTS) {
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
