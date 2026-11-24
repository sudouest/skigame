import type { EventBus } from '../core/eventBus';
import { clamp, wrapAngle } from '../core/math';
import { getCreatureDef } from '../content/creatures';
import {
  CREATURE_PHASE_ATTACK,
  CREATURE_PHASE_IDLE,
  CREATURE_PHASE_RECOVER,
  CREATURE_PHASE_TELEGRAPH,
  createSurfaceSample,
  type SimEventMap,
  type SurfaceQueryView,
  type SurfaceSample,
} from './contracts';
import type { CreaturePool } from './entityPools';

/**
 * Three-tier world-space creature behavior orchestrator for patrolling creatures (Bear).
 * Executes in authoritative World Space (X, Y, Z), querying SurfaceQueryView.sampleSurface
 * with a non-authoritative hint cache for seamless cross-seam movement.
 */
export class CreatureSystem {
  private readonly sampleScratch: SurfaceSample = createSurfaceSample();
  private readonly telegraphPayloadScratch: {
    creatureDefId: string;
    soundId: string;
    worldX: number;
    worldY: number;
    worldZ: number;
    distanceToPlayerM: number;
    showEdgeIndicator: boolean;
    edgeSide: 'left' | 'right' | 'center';
  } = {
    creatureDefId: '',
    soundId: '',
    worldX: 0,
    worldY: 0,
    worldZ: 0,
    distanceToPlayerM: 0,
    showEdgeIndicator: false,
    edgeSide: 'center',
  };

  step(
    dt: number,
    skierPosX: number,
    skierPosZ: number,
    skierYawRad: number,
    creatures: CreaturePool,
    surfaceQuery: SurfaceQueryView,
    eventBus: EventBus<SimEventMap>,
  ): void {
    const skierRightX = Math.cos(skierYawRad);
    const skierRightZ = -Math.sin(skierYawRad);

    for (let i = 0; i < creatures.count; i++) {
      const defId = creatures.defIds[i];
      if (!defId) continue;
      const def = getCreatureDef(defId);
      if (!def || def.behavior.type !== 'bearPatrol') continue;

      const cx = creatures.posX[i]!;
      const cy = creatures.posY[i]!;
      const cz = creatures.posZ[i]!;
      const dx = cx - skierPosX;
      const dz = cz - skierPosZ;
      const distToPlayer = Math.hypot(dx, dz);

      let phase = creatures.stateCode[i]!;
      let timer = creatures.stateTimer[i]! + dt;

      if (phase === CREATURE_PHASE_IDLE) {
        if (distToPlayer <= def.telegraph.warningRange) {
          phase = CREATURE_PHASE_TELEGRAPH;
          timer = 0;
          creatures.telegraphProgress[i] = 0;

          if (creatures.telegraphed[i] === 0) {
            creatures.telegraphed[i] = 1;
            const lateralDot = dx * skierRightX + dz * skierRightZ;
            const edgeSide: 'left' | 'right' | 'center' =
              lateralDot < -1.5 ? 'left' : lateralDot > 1.5 ? 'right' : 'center';

            this.telegraphPayloadScratch.creatureDefId = def.id;
            this.telegraphPayloadScratch.soundId = def.telegraph.soundId;
            this.telegraphPayloadScratch.worldX = cx;
            this.telegraphPayloadScratch.worldY = cy;
            this.telegraphPayloadScratch.worldZ = cz;
            this.telegraphPayloadScratch.distanceToPlayerM = distToPlayer;
            this.telegraphPayloadScratch.showEdgeIndicator = Boolean(
              def.telegraph.showEdgeIndicator,
            );
            this.telegraphPayloadScratch.edgeSide = edgeSide;
            eventBus.emit('CREATURE_TELEGRAPH', this.telegraphPayloadScratch);
          }
        }
      } else if (phase === CREATURE_PHASE_TELEGRAPH) {
        const dur = Math.max(0.05, def.behavior.telegraphSec);
        creatures.telegraphProgress[i] = clamp(timer / dur, 0, 1);
        if (timer >= dur) {
          phase = CREATURE_PHASE_ATTACK;
          timer = 0;
          creatures.telegraphProgress[i] = 1;
        }
      } else if (phase === CREATURE_PHASE_ATTACK) {
        // Cross-trail patrol in World Space (X, Z) + gentle downhill drift
        const hintSeg = creatures.hintSegId[i]!;
        const hintS = creatures.hintS[i]!;
        surfaceQuery.sampleSurface(cx, cz, hintSeg, hintS, this.sampleScratch);

        if (this.sampleScratch.valid) {
          creatures.hintSegId[i] = this.sampleScratch.segmentId;
          creatures.hintS[i] = this.sampleScratch.s;
          creatures.segmentIds[i] = this.sampleScratch.segmentId;

          // Tangent & horizontal right vector of local trail surface
          const tx = this.sampleScratch.tangentX;
          const tz = this.sampleScratch.tangentZ;
          const tLen = Math.hypot(tx, tz) || 1;
          const fwdX = tx / tLen;
          const fwdZ = tz / tLen;
          // rightXZ from forwardXZ=(fwdX, 0, fwdZ): ( -fwdZ, 0, fwdX )
          const rightX = -fwdZ;
          const rightZ = fwdX;

          const limitX = Math.max(4.0, this.sampleScratch.halfWidth * 0.78);
          let dir = creatures.patrolDir[i]! >= 0 ? 1 : -1;
          if (this.sampleScratch.x >= limitX && dir > 0) {
            dir = -1;
          } else if (this.sampleScratch.x <= -limitX && dir < 0) {
            dir = 1;
          }
          creatures.patrolDir[i] = dir;

          const crossSpeed = def.behavior.crossSpeed;
          const forwardCreep = 1.25;
          const vx = rightX * (dir * crossSpeed) + fwdX * forwardCreep;
          const vz = rightZ * (dir * crossSpeed) + fwdZ * forwardCreep;

          const nextX = cx + vx * dt;
          const nextZ = cz + vz * dt;
          surfaceQuery.sampleSurface(
            nextX,
            nextZ,
            creatures.hintSegId[i]!,
            creatures.hintS[i]!,
            this.sampleScratch,
          );

          creatures.posX[i] = nextX;
          creatures.posZ[i] = nextZ;
          creatures.posY[i] = this.sampleScratch.groundY;
          creatures.groundY[i] = this.sampleScratch.groundY;
          creatures.normalX[i] = this.sampleScratch.normalX;
          creatures.normalY[i] = this.sampleScratch.normalY;
          creatures.normalZ[i] = this.sampleScratch.normalZ;
          creatures.hintSegId[i] = this.sampleScratch.segmentId;
          creatures.hintS[i] = this.sampleScratch.s;
          creatures.segmentIds[i] = this.sampleScratch.segmentId;
          creatures.headingRad[i] = wrapAngle(Math.atan2(-vx, -vz));
        }

        if (timer > 5.0) {
          phase = CREATURE_PHASE_RECOVER;
          timer = 0;
        }
      } else if (phase === CREATURE_PHASE_RECOVER) {
        creatures.telegraphProgress[i] = clamp(1 - timer / 0.8, 0, 1);
        if (timer >= 0.8) {
          phase = CREATURE_PHASE_ATTACK;
          timer = 0;
        }
      }

      creatures.stateCode[i] = phase;
      creatures.stateTimer[i] = timer;
    }
  }
}
