import { clamp, clampAngleAround, degToRad, lerp, lerpAngle, smoothstep, wrapAngle } from '../core/math';
import type { SkierDef, SurfaceType } from '../content/types';
import type { PlayerIntent, SkierPose, SpineForkMeta, SurfaceQueryView, SurfaceSample } from './contracts';
import type { RampPool, SkiTrackPool } from './entityPools';

export const SKI_GRAVITY = 22.0;
const POINTER_STEER_GAIN = 8.0;
const MAX_CARVE_ANGLE_RAD = 0.55;
const DOWNHILL_CLAMP_RAD = degToRad(80);
const SKI_TRACK_SAMPLE_DIST_M = 0.85;

export interface MutableSkierPose {
  posX: number;
  posY: number;
  posZ: number;
  velX: number;
  velY: number;
  velZ: number;
  headingRad: number;
  carveAngleRad: number;
  pitchRad: number;
  speed: number;
  groundY: number;
  normalX: number;
  normalY: number;
  normalZ: number;
  grounded: boolean;
  braking: boolean;
}

export function createMutableSkierPose(): MutableSkierPose {
  return {
    posX: 0,
    posY: 0,
    posZ: 0,
    velX: 0,
    velY: 0,
    velZ: -12,
    headingRad: 0,
    carveAngleRad: 0,
    pitchRad: -0.22,
    speed: 12,
    groundY: 0,
    normalX: 0,
    normalY: 1,
    normalZ: 0,
    grounded: true,
    braking: false,
  };
}

export function copySkierPose(src: SkierPose, dst: MutableSkierPose): void {
  dst.posX = src.posX;
  dst.posY = src.posY;
  dst.posZ = src.posZ;
  dst.velX = src.velX;
  dst.velY = src.velY;
  dst.velZ = src.velZ;
  dst.headingRad = src.headingRad;
  dst.carveAngleRad = src.carveAngleRad;
  dst.pitchRad = src.pitchRad;
  dst.speed = src.speed;
  dst.groundY = src.groundY;
  dst.normalX = src.normalX;
  dst.normalY = src.normalY;
  dst.normalZ = src.normalZ;
  dst.grounded = src.grounded;
  dst.braking = src.braking;
}

export interface PhysicsStepContext {
  readonly skierDef: SkierDef;
  readonly surfaceQuery: SurfaceQueryView;
  readonly forkBumper: SpineForkMeta | null;
  readonly surface: SurfaceSample;
  readonly ramps: RampPool;
  readonly skiTracks: SkiTrackPool;
}

/**
 * World-space (X, Y, Z) 60 Hz skiing physics solver:
 * - World gravity (0, -g, 0) projected onto surfaceNormal
 * - Carving forward/lateral traction decomposition across packed/powder/ice/rock + perks
 * - +/-80 deg downhill heading clamp relative to blended surface downhill tangent
 * - Open-mountain carving with natural gravity deceleration, slope-scaled start assist, and signed drag
 * - Model A V-wedge nose bumper deflection and true 3D ballistic airtime
 */
export class SkiPhysics {
  private coyoteTimerSec = 0;
  private activeRampIndex = -1;
  private trackAccumDist = 0;
  private wasGroundedLastTick = true;
  private lastSampleX = NaN;
  private lastSampleZ = NaN;
  private lastSampleSegId = -1;
  private readonly rampScratch = {
    inRamp: false,
    rampIndex: -1,
    liftY: 0,
    slopeRate: 0,
  };

  reset(): void {
    this.coyoteTimerSec = 0;
    this.activeRampIndex = -1;
    this.trackAccumDist = 0;
    this.wasGroundedLastTick = true;
    this.invalidateSurfaceCache();
  }

  invalidateSurfaceCache(): void {
    this.lastSampleX = NaN;
    this.lastSampleZ = NaN;
    this.lastSampleSegId = -1;
  }

  stepSkiing(
    dt: number,
    intent: PlayerIntent,
    skier: MutableSkierPose,
    ctx: PhysicsStepContext,
  ): void {
    const { skierDef, surfaceQuery, forkBumper, surface, ramps, skiTracks } = ctx;
    const prevPosX = skier.posX;
    const prevPosY = skier.posY;
    const prevPosZ = skier.posZ;
    const prevVelY = skier.velY;

    // 1. Reuse previous tick's post-integrate surface sample unless position/segment invalidated externally
    if (
      !surface.valid ||
      surface.segmentId !== this.lastSampleSegId ||
      Math.abs(skier.posX - this.lastSampleX) > 1e-6 ||
      Math.abs(skier.posZ - this.lastSampleZ) > 1e-6
    ) {
      surfaceQuery.sampleSurface(
        skier.posX,
        skier.posZ,
        surface.segmentId,
        surface.s,
        surface,
      );
    }

    const surfaceGrip = this.computeSurfaceGrip(surface.surfaceType, skierDef);
    const steerInput = clamp(intent.steer + intent.pointerSteerDelta * POINTER_STEER_GAIN, -1, 1);
    const braking = intent.brake && skier.grounded;
    skier.braking = braking;

    // 2. Steering & carve lean (-steer: left increases +yaw CCW around +Y)
    const airTurnScale = skier.grounded ? 1.0 : 0.42;
    const gripTurnScale = 0.55 + 0.45 * clamp(surfaceGrip, 0.25, 1.3);
    const turnRateRad = 2.4 * airTurnScale * gripTurnScale;
    skier.headingRad = wrapAngle(skier.headingRad - steerInput * turnRateRad * dt);

    // Clamp heading within +/- 80 deg of local downhillTangent to prevent skiing uphill
    const downhillYaw = Math.atan2(-surface.tangentX, -surface.tangentZ);
    skier.headingRad = clampAngleAround(skier.headingRad, downhillYaw, DOWNHILL_CLAMP_RAD);

    const targetCarve = steerInput * MAX_CARVE_ANGLE_RAD;
    skier.carveAngleRad = lerp(skier.carveAngleRad, targetCarve, 1 - Math.exp(-12 * dt));

    const fwdX = -Math.sin(skier.headingRad);
    const fwdZ = -Math.cos(skier.headingRad);
    const rightX = Math.cos(skier.headingRad);
    const rightZ = -Math.sin(skier.headingRad);

    // 3. Apply forces
    if (skier.grounded) {
      this.coyoteTimerSec = 0.1;

      // Project world gravity (0, -g, 0) onto surface normal N
      const nx = surface.normalX;
      const ny = surface.normalY;
      const nz = surface.normalZ;
      const gx = SKI_GRAVITY * ny * nx;
      const gy = -SKI_GRAVITY * (1 - ny * ny);
      const gz = SKI_GRAVITY * ny * nz;

      skier.velX += gx * dt;
      skier.velY += gy * dt;
      skier.velZ += gz * dt;

      // Signed terrain slope along ski heading (< 0 downhill, > 0 uphill)
      const slopeAlongHeading = -(fwdX * nx + fwdZ * nz) / Math.max(0.35, ny);

      // Forward / lateral velocity decomposition relative to ski edges
      let vFwd = skier.velX * fwdX + skier.velZ * fwdZ;
      let vLat = skier.velX * rightX + skier.velZ * rightZ;

      // Slope-scaled start assist on flat/downhill; disappears on uphill walls
      if (vFwd < 6.0 && vFwd >= -0.5 && !braking) {
        const assistScale = 1 - smoothstep(0.0, 0.15, slopeAlongHeading);
        vFwd += 7.5 * assistScale * dt;
      }

      // Edge-grip opposes sideslip; low grip on ice/rock increases lateral drift
      const lateralDamp = Math.exp(-9.5 * surfaceGrip * dt);
      const carvedTransfer = (vLat - vLat * lateralDamp) * 0.18;
      vLat *= lateralDamp;
      vFwd += Math.abs(carvedTransfer) * 0.25;

      // Surface drag (off-piste snow adds smooth drag; braking decelerates safely on steep slopes)
      let quadDrag: number;
      let linearDrag: number;
      switch (surface.surfaceType) {
        case 'packed':
          quadDrag = 0.0064;
          linearDrag = 0.035;
          break;
        case 'powder':
          quadDrag = 0.0095;
          linearDrag = 0.16;
          break;
        case 'ice':
          quadDrag = 0.0052;
          linearDrag = 0.015;
          break;
        case 'rock':
          quadDrag = 0.0048;
          linearDrag = 0.01;
          break;
        default: {
          const _exhaustive: never = surface.surfaceType;
          throw new Error(`Unhandled surface type: ${String(_exhaustive)}`);
        }
      }
      if (surface.surfaceType !== 'rock') {
        linearDrag += 0.18 * (1 - clamp(surface.pisteWeight, 0, 1));
      }
      if (braking) {
        if (vFwd > 4.5 && slopeAlongHeading < 0.05) {
          vFwd = Math.max(4.5, vFwd - 18.0 * dt);
        } else if (vFwd > 0) {
          vFwd = Math.max(0, vFwd - 18.0 * dt);
        } else if (vFwd < 0) {
          vFwd = Math.min(0, vFwd + 18.0 * dt);
        }
        vLat *= Math.exp(-6.0 * dt);
      }

      // Signed drag opposes motion without erasing backward gravity slide on uphill stalls
      const dragDecel = (quadDrag * Math.abs(vFwd) + linearDrag) * Math.abs(vFwd) * dt;
      if (vFwd > 0) {
        vFwd = Math.max(0, vFwd - dragDecel);
      } else if (vFwd < 0) {
        vFwd = Math.min(0, vFwd + dragDecel);
      }

      // Soft aerodynamic top-speed governor around skierDef.stats.maxSpeed
      if (vFwd > skierDef.stats.maxSpeed) {
        const excess = vFwd - skierDef.stats.maxSpeed;
        vFwd -= excess * (1 - Math.exp(-2.8 * dt));
      }

      skier.velX = fwdX * vFwd + rightX * vLat;
      skier.velZ = fwdZ * vFwd + rightZ * vLat;

      // Gently pivot skis back toward local fall-line when stalling nose-up on steep walls
      if (vFwd < 1.5 && slopeAlongHeading > 0.05) {
        skier.headingRad = clampAngleAround(
          lerpAngle(skier.headingRad, downhillYaw, 1 - Math.exp(-2.8 * dt)),
          downhillYaw,
          DOWNHILL_CLAMP_RAD,
        );
      }
    } else {
      this.coyoteTimerSec = Math.max(0, this.coyoteTimerSec - dt);
      // True 3D ballistic airtime
      skier.velY -= SKI_GRAVITY * dt;
      // Very light air drag
      const airDamp = Math.exp(-0.04 * dt);
      skier.velX *= airDamp;
      skier.velZ *= airDamp;
    }

    // 4. Integrate horizontal position
    skier.posX += skier.velX * dt;
    skier.posZ += skier.velZ * dt;

    // 5. Re-sample surface at new horizontal coordinates
    surfaceQuery.sampleSurface(
      skier.posX,
      skier.posZ,
      surface.segmentId,
      surface.s,
      surface,
    );

    // 6. Model A V-wedge nose bumper deflection (open-mountain skiing: zero corridor walls)
    this.applyForkNoseBumper(skier, surface, forkBumper, surfaceQuery, skierDef.stats.collisionRadius);
    this.lastSampleX = skier.posX;
    this.lastSampleZ = skier.posZ;
    this.lastSampleSegId = surface.segmentId;

    // 7. Evaluate ramp contact and vertical ground tracking / ballistic launch
    this.evaluateRampAt(skier.posX, skier.posZ, ramps);
    const rampInfo = this.rampScratch;
    const targetGroundY = surface.groundY + rampInfo.liftY;

    const invNy = 1 / Math.max(0.35, surface.normalY);
    const slopeVelY =
      -(skier.velX * surface.normalX + skier.velZ * surface.normalZ) * invNy +
      (rampInfo.inRamp ? rampInfo.slopeRate * Math.hypot(skier.velX, skier.velZ) : 0);

    const canJump = skier.grounded || this.coyoteTimerSec > 0;
    if (intent.jumpPressed && canJump) {
      const rampBonus = rampInfo.inRamp || this.activeRampIndex >= 0 ? 2.2 : 0;
      skier.velY = Math.max(skier.velY, slopeVelY) + skierDef.stats.jumpImpulse + rampBonus;
      skier.posY = Math.max(skier.posY, targetGroundY) + skier.velY * dt;
      skier.grounded = false;
      this.coyoteTimerSec = 0;
      this.activeRampIndex = -1;
    } else if (skier.grounded) {
      // Check ramp lip launch!
      if (this.activeRampIndex >= 0 && !rampInfo.inRamp) {
        const exitedIdx = this.activeRampIndex;
        const rampPitch = ramps.pitchRad[exitedIdx]!;
        const boostDeg = ramps.lipPitchBoostDeg[exitedIdx]!;
        const launchPitch = rampPitch + degToRad(boostDeg);
        const speed3d = Math.max(14, Math.hypot(skier.velX, skier.velY, skier.velZ));
        const newVelY = speed3d * Math.sin(launchPitch);
        const newHoriz = speed3d * Math.cos(launchPitch);
        const curHoriz = Math.max(1e-4, Math.hypot(skier.velX, skier.velZ));
        const hScale = newHoriz / curHoriz;
        skier.velX *= hScale;
        skier.velZ *= hScale;
        skier.velY = newVelY;
        skier.posY += newVelY * dt;
        skier.grounded = false;
        this.activeRampIndex = -1;
      } else {
        this.activeRampIndex = rampInfo.inRamp ? rampInfo.rampIndex : -1;
        // Natural ballistic launch over steep convex crests when downward drop exceeds gravity
        const horizSpeed = Math.hypot(skier.velX, skier.velZ);
        const freeFallY = prevPosY + (prevVelY - SKI_GRAVITY * dt) * dt;
        if (!rampInfo.inRamp && freeFallY > targetGroundY + 0.09 && horizSpeed > 13) {
          skier.posY = freeFallY;
          skier.velY = prevVelY - SKI_GRAVITY * dt;
          skier.grounded = false;
        } else {
          skier.posY = targetGroundY;
          skier.velY = slopeVelY;
          skier.grounded = true;
        }
      }
    } else {
      // Airborne integration & landing check
      skier.posY += skier.velY * dt;
      if (skier.posY <= targetGroundY && skier.velY <= slopeVelY + 1.5) {
        skier.posY = targetGroundY;
        skier.velY = slopeVelY;
        skier.grounded = true;
        this.activeRampIndex = rampInfo.inRamp ? rampInfo.rampIndex : -1;
      }
    }

    // 8. Populate pose metadata
    skier.groundY = surface.groundY;
    skier.normalX = surface.normalX;
    skier.normalY = surface.normalY;
    skier.normalZ = surface.normalZ;
    skier.speed = Math.hypot(skier.velX, skier.velY, skier.velZ);

    const horizSpeed = Math.max(0.5, Math.hypot(skier.velX, skier.velZ));
    if (skier.grounded) {
      const fy = -(fwdX * surface.normalX + fwdZ * surface.normalZ) / Math.max(0.35, surface.normalY);
      skier.pitchRad = clamp(Math.atan2(fy, 1), -0.85, 0.65);
    } else {
      skier.pitchRad = clamp(Math.atan2(skier.velY, horizSpeed), -0.7, 0.65);
    }

    // 9. Update ski track ribbon ring buffer
    const stepDist = Math.hypot(skier.posX - prevPosX, skier.posZ - prevPosZ);
    if (skier.grounded && !rampInfo.inRamp) {
      this.trackAccumDist += stepDist;
      if (!this.wasGroundedLastTick || this.trackAccumDist >= SKI_TRACK_SAMPLE_DIST_M) {
        this.trackAccumDist = 0;
        skiTracks.pushSample(
          skier.posX,
          surface.groundY + 0.03,
          skier.posZ,
          surface.normalX,
          surface.normalY,
          surface.normalZ,
          rightX,
          0,
          rightZ,
          true,
        );
      }
    } else if (this.wasGroundedLastTick) {
      // Break ski track ribbon cleanly on takeoff
      skiTracks.pushSample(
        prevPosX,
        surface.groundY + 0.03,
        prevPosZ,
        surface.normalX,
        surface.normalY,
        surface.normalZ,
        rightX,
        0,
        rightZ,
        false,
      );
      this.trackAccumDist = 0;
    }
    this.wasGroundedLastTick = skier.grounded && !rampInfo.inRamp;
  }

  private computeSurfaceGrip(surfaceType: SurfaceType, skierDef: SkierDef): number {
    let base: number;
    switch (surfaceType) {
      case 'packed':
        base = 1.0;
        break;
      case 'powder':
        base = 0.72;
        break;
      case 'ice':
        base = 0.25 * (skierDef.perk?.type === 'iceGrip' ? skierDef.perk.value : 1);
        break;
      case 'rock':
        base = 0.15;
        break;
      default: {
        const _exhaustive: never = surfaceType;
        throw new Error(`Unhandled surface type: ${String(_exhaustive)}`);
      }
    }
    return base * skierDef.stats.carveGrip;
  }

  private applyForkNoseBumper(
    skier: MutableSkierPose,
    surface: SurfaceSample,
    forkBumper: SpineForkMeta | null,
    surfaceQuery: SurfaceQueryView,
    skierRadius: number,
  ): void {
    // Model A rounded soft-bumper V-wedge nose deflection (r = 1.5m)
    if (!forkBumper || !forkBumper.hasFork) return;

    const dx = skier.posX - forkBumper.seamWorldX;
    const dz = skier.posZ - forkBumper.seamWorldZ;
    const distXZ = Math.hypot(dx, dz);
    const minClear = forkBumper.seamNoseRadius + skierRadius;
    const clearanceY = skier.posY - surface.groundY;

    if (distXZ < minClear && clearanceY < 1.65) {
      const seamRightX = Math.cos(forkBumper.seamYawRad);
      const seamRightZ = -Math.sin(forkBumper.seamYawRad);
      const seamFwdX = -Math.sin(forkBumper.seamYawRad);
      const seamFwdZ = -Math.cos(forkBumper.seamYawRad);
      const latDot = dx * seamRightX + dz * seamRightZ;
      const side = latDot < 0 ? -1 : 1;

      const push = minClear - distXZ + 0.08;
      skier.posX += (seamRightX * side * 0.92 + seamFwdX * 0.35) * push;
      skier.posZ += (seamRightZ * side * 0.92 + seamFwdZ * 0.35) * push;

      // Nudge velocity & heading smoothly onto chosen branch
      const vLat = skier.velX * seamRightX + skier.velZ * seamRightZ;
      if (vLat * side < 4.5) {
        const deltaV = 4.5 * side - vLat;
        skier.velX += seamRightX * deltaV * 0.5;
        skier.velZ += seamRightZ * deltaV * 0.5;
      }
      skier.headingRad = wrapAngle(skier.headingRad - side * 0.14);

      surfaceQuery.sampleSurface(skier.posX, skier.posZ, surface.segmentId, surface.s, surface);
    }
  }

  private evaluateRampAt(posX: number, posZ: number, ramps: RampPool): void {
    this.rampScratch.inRamp = false;
    this.rampScratch.rampIndex = -1;
    this.rampScratch.liftY = 0;
    this.rampScratch.slopeRate = 0;

    for (let i = 0; i < ramps.count; i++) {
      const rx = ramps.posX[i]!;
      const rz = ramps.posZ[i]!;
      const dx = posX - rx;
      const dz = posZ - rz;
      const len = ramps.length[i]!;
      const wid = ramps.width[i]!;
      if (dx * dx + dz * dz > (len + wid) * (len + wid)) continue;

      const yaw = ramps.yawRad[i]!;
      const fwdX = -Math.sin(yaw);
      const fwdZ = -Math.cos(yaw);
      const rightX = Math.cos(yaw);
      const rightZ = -Math.sin(yaw);

      const longDist = dx * fwdX + dz * fwdZ;
      const latDist = dx * rightX + dz * rightZ;
      const t = (longDist + 0.5 * len) / len;
      if (Math.abs(latDist) <= 0.5 * wid + 0.35 && t >= 0 && t <= 1.0) {
        const h = ramps.height[i]!;
        this.rampScratch.inRamp = true;
        this.rampScratch.rampIndex = i;
        this.rampScratch.liftY = h * t * t;
        this.rampScratch.slopeRate = (2 * h * t) / len;
        return;
      }
    }
  }
}
