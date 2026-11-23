import { clamp, damp, lerp, lerpAngle } from '../core/math';
import type { CameraPose, SkierPose, SurfaceSample } from './contracts';
import type { TrailWindow } from './trailWindow';

export interface MutableCameraPose {
  posX: number;
  posY: number;
  posZ: number;
  lookAtX: number;
  lookAtY: number;
  lookAtZ: number;
  rollRad: number;
  minHorizontalFovDeg: number;
  speedFovBoostDeg: number;
}

export function createMutableCameraPose(): MutableCameraPose {
  return {
    posX: 0,
    posY: 4,
    posZ: 10,
    lookAtX: 0,
    lookAtY: 0,
    lookAtZ: -18,
    rollRad: 0,
    minHorizontalFovDeg: 72,
    speedFovBoostDeg: 0,
  };
}

/**
 * Headless spring-damped chase camera rig operating strictly in World Space (X, Y, Z),
 * featuring carve roll, speed FOV boost, responsive minHorizontalFovDeg, and a 25m
 * look-ahead crest elevation probe to preserve sightlines over Black Diamond drop-offs.
 */
export class CameraRig {
  readonly prevCamera: MutableCameraPose = createMutableCameraPose();
  readonly currCamera: MutableCameraPose = createMutableCameraPose();

  private chaseHeadingRad = 0;
  private crestLiftM = 0;
  private crestLookDropM = 0;
  private initialized = false;

  reset(skier: SkierPose, surface: SurfaceSample): void {
    this.initialized = true;
    this.chaseHeadingRad = skier.headingRad;
    this.crestLiftM = 0;
    this.crestLookDropM = 0;

    const fwdX = -Math.sin(this.chaseHeadingRad);
    const fwdZ = -Math.cos(this.chaseHeadingRad);

    const targetPosX = skier.posX - fwdX * 10.2;
    const targetPosY = Math.max(skier.posY, surface.groundY) + 3.6;
    const targetPosZ = skier.posZ - fwdZ * 10.2;

    const lookAtX = skier.posX + fwdX * 18.0;
    const lookAtY = skier.posY + tangentYOrDefault(surface) * 18.0 + 0.6;
    const lookAtZ = skier.posZ + fwdZ * 18.0;

    this.currCamera.posX = targetPosX;
    this.currCamera.posY = targetPosY;
    this.currCamera.posZ = targetPosZ;
    this.currCamera.lookAtX = lookAtX;
    this.currCamera.lookAtY = lookAtY;
    this.currCamera.lookAtZ = lookAtZ;
    this.currCamera.rollRad = 0;
    this.currCamera.minHorizontalFovDeg = 72;
    this.currCamera.speedFovBoostDeg = 0;

    this.capturePrevious();
  }

  capturePrevious(): void {
    this.prevCamera.posX = this.currCamera.posX;
    this.prevCamera.posY = this.currCamera.posY;
    this.prevCamera.posZ = this.currCamera.posZ;
    this.prevCamera.lookAtX = this.currCamera.lookAtX;
    this.prevCamera.lookAtY = this.currCamera.lookAtY;
    this.prevCamera.lookAtZ = this.currCamera.lookAtZ;
    this.prevCamera.rollRad = this.currCamera.rollRad;
    this.prevCamera.minHorizontalFovDeg = this.currCamera.minHorizontalFovDeg;
    this.prevCamera.speedFovBoostDeg = this.currCamera.speedFovBoostDeg;
  }

  shiftOrigin(dx: number, dy: number, dz: number): void {
    this.prevCamera.posX -= dx;
    this.prevCamera.posY -= dy;
    this.prevCamera.posZ -= dz;
    this.prevCamera.lookAtX -= dx;
    this.prevCamera.lookAtY -= dy;
    this.prevCamera.lookAtZ -= dz;

    this.currCamera.posX -= dx;
    this.currCamera.posY -= dy;
    this.currCamera.posZ -= dz;
    this.currCamera.lookAtX -= dx;
    this.currCamera.lookAtY -= dy;
    this.currCamera.lookAtZ -= dz;
  }

  update(dt: number, skier: SkierPose, surface: SurfaceSample, trailWindow: TrailWindow): void {
    if (!this.initialized) {
      this.reset(skier, surface);
      return;
    }

    // Blend chase yaw smoothly between downhill tangent and skier carving heading
    const downhillYaw = Math.atan2(-surface.tangentX, -surface.tangentZ);
    const targetYaw = lerpAngle(downhillYaw, skier.headingRad, 0.35);
    const yawAlpha = 1 - Math.exp(-5.5 * dt);
    this.chaseHeadingRad = lerpAngle(this.chaseHeadingRad, targetYaw, yawAlpha);

    const fwdX = -Math.sin(this.chaseHeadingRad);
    const fwdZ = -Math.cos(this.chaseHeadingRad);

    // 25m Look-Ahead Crest Elevation Probe along active segment
    const probeAheadM = 25.0;
    const aheadGroundY = surface.valid
      ? trailWindow.probeAheadGroundY(surface.segmentId, surface.s, surface.x, probeAheadM)
      : skier.groundY + surface.tangentY * probeAheadM;

    const expectedLinearY = surface.groundY + surface.tangentY * probeAheadM;
    const crestDrop = Math.max(0, expectedLinearY - aheadGroundY);
    // Raise camera and pitch look-at down into landing pocket when approaching convex brow
    const targetCrestLift = clamp((crestDrop - 0.35) * 0.65, 0, 3.2);
    const targetLookDrop = clamp((crestDrop - 0.35) * 0.45, 0, 2.4);
    this.crestLiftM = damp(this.crestLiftM, targetCrestLift, 4.5, dt);
    this.crestLookDropM = damp(this.crestLookDropM, targetLookDrop, 4.5, dt);

    const speedRatio = clamp((skier.speed - 12) / 24, 0, 1);
    const trailDist = lerp(9.4, 11.4, speedRatio);
    const baseHeight = lerp(3.4, 4.0, speedRatio) + this.crestLiftM;

    const desiredPosX = skier.posX - fwdX * trailDist;
    const desiredPosY = Math.max(skier.posY, surface.groundY) + baseHeight;
    const desiredPosZ = skier.posZ - fwdZ * trailDist;

    const posLambda = 9.0;
    this.currCamera.posX = damp(this.currCamera.posX, desiredPosX, posLambda, dt);
    this.currCamera.posY = damp(this.currCamera.posY, desiredPosY, posLambda * 0.85, dt);
    this.currCamera.posZ = damp(this.currCamera.posZ, desiredPosZ, posLambda, dt);

    // Look ~18m ahead of skier so skier torso never blocks obstacles directly in front
    const lookAheadM = 18.0;
    const ahead18Y = surface.valid
      ? trailWindow.probeAheadGroundY(surface.segmentId, surface.s, surface.x, lookAheadM)
      : skier.groundY + surface.tangentY * lookAheadM;

    const desiredLookX = skier.posX + fwdX * lookAheadM;
    const desiredLookY = Math.max(ahead18Y, skier.posY + surface.tangentY * lookAheadM) + 0.6 - this.crestLookDropM;
    const desiredLookZ = skier.posZ + fwdZ * lookAheadM;

    const lookLambda = 11.5;
    this.currCamera.lookAtX = damp(this.currCamera.lookAtX, desiredLookX, lookLambda, dt);
    this.currCamera.lookAtY = damp(this.currCamera.lookAtY, desiredLookY, lookLambda, dt);
    this.currCamera.lookAtZ = damp(this.currCamera.lookAtZ, desiredLookZ, lookLambda, dt);

    this.currCamera.rollRad = damp(
      this.currCamera.rollRad,
      -skier.carveAngleRad * 0.14,
      7.5,
      dt,
    );
    this.currCamera.minHorizontalFovDeg = 72;
    this.currCamera.speedFovBoostDeg = damp(
      this.currCamera.speedFovBoostDeg,
      speedRatio * 14,
      4.0,
      dt,
    );
  }

  getReadonlyPrev(): CameraPose {
    return this.prevCamera;
  }

  getReadonlyCurr(): CameraPose {
    return this.currCamera;
  }
}

function tangentYOrDefault(surface: SurfaceSample): number {
  return surface.valid ? surface.tangentY : -0.22;
}
