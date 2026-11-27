import {
  CAMERA_FRAMING_TUNING,
  resolveActiveCameraFraming,
  type CameraFramingTuning,
} from '../content/visibilityTuning';
import { clamp, damp, lerp, lerpAngle } from '../core/math';
import type { CameraPose, SkierPose, SurfaceQueryView, SurfaceSample } from './contracts';

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

  private readonly framing: CameraFramingTuning;
  private chaseHeadingRad = 0;
  private crestLiftM = 0;
  private crestLookDropM = 0;
  private walkCameraBlend = 0;
  private initialized = false;

  constructor(framingTuning: CameraFramingTuning = CAMERA_FRAMING_TUNING) {
    this.framing = resolveActiveCameraFraming(framingTuning);
  }

  reset(skier: SkierPose, surface: SurfaceSample, surfaceQuery?: SurfaceQueryView): void {
    this.initialized = true;
    this.chaseHeadingRad = skier.headingRad;
    this.crestLiftM = 0;
    this.crestLookDropM = 0;
    this.walkCameraBlend = skier.walking ? 1 : 0;

    const fwdX = -Math.sin(this.chaseHeadingRad);
    const fwdZ = -Math.cos(this.chaseHeadingRad);

    const trailDist = this.framing.resetTrailDistM;
    const trailUphillSlope = surface.valid
      ? Math.max(
          0,
          (fwdX * surface.normalX + fwdZ * surface.normalZ) / Math.max(0.35, surface.normalY),
        )
      : 0.22;
    const slopeRise = Math.max(
      computeUphillSlopeRise(surface, trailDist),
      trailUphillSlope * trailDist,
    );

    const targetPosX = skier.posX - fwdX * trailDist;
    const targetPosZ = skier.posZ - fwdZ * trailDist;
    let targetPosY = Math.max(skier.posY, surface.groundY) + slopeRise + this.framing.resetBaseHeightM;
    if (surfaceQuery) {
      targetPosY = Math.max(
        targetPosY,
        surfaceQuery.evaluateHeight(targetPosX, targetPosZ) + 2.6,
      );
    }
    if (surface.valid && surface.normalY >= 0.20) {
      targetPosY = Math.max(
        targetPosY,
        computeMinFrontFaceY(
          skier.posY,
          targetPosX - skier.posX,
          targetPosZ - skier.posZ,
          surface,
        ),
      );
    }

    const lookAheadM = this.framing.lookAheadM;
    const lookAtX = skier.posX + fwdX * lookAheadM;
    const lookAtY = skier.posY + tangentYOrDefault(surface) * lookAheadM + 0.6;
    const lookAtZ = skier.posZ + fwdZ * lookAheadM;

    this.currCamera.posX = targetPosX;
    this.currCamera.posY = targetPosY;
    this.currCamera.posZ = targetPosZ;
    this.currCamera.lookAtX = lookAtX;
    this.currCamera.lookAtY = lookAtY;
    this.currCamera.lookAtZ = lookAtZ;
    this.currCamera.rollRad = 0;
    this.currCamera.minHorizontalFovDeg = this.framing.minHorizontalFovDeg;
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

  update(dt: number, skier: SkierPose, surface: SurfaceSample, surfaceQuery: SurfaceQueryView): void {
    if (!this.initialized) {
      this.reset(skier, surface, surfaceQuery);
      return;
    }

    // Blend chase yaw smoothly between downhill tangent and skier carving heading
    // (tracks skier heading closely while walking so uphill/sideways recovery stays framed)
    this.walkCameraBlend = damp(this.walkCameraBlend, skier.walking ? 1 : 0, 4.0, dt);
    const downhillYaw = Math.atan2(-surface.tangentX, -surface.tangentZ);
    const baseHeadingWeight = lerp(0.55, 0.35, clamp(surface.pisteWeight, 0, 1));
    const headingWeight = lerp(baseHeadingWeight, 1.0, this.walkCameraBlend);
    const targetYaw = lerpAngle(downhillYaw, skier.headingRad, headingWeight);
    const yawAlpha = 1 - Math.exp(-5.5 * dt);
    this.chaseHeadingRad = lerpAngle(this.chaseHeadingRad, targetYaw, yawAlpha);

    const fwdX = -Math.sin(this.chaseHeadingRad);
    const fwdZ = -Math.cos(this.chaseHeadingRad);

    // 25m Look-Ahead Crest Elevation Probe along skier velocity/heading on MountainField
    const horizVel = Math.hypot(skier.velX, skier.velZ);
    const probeDirX = horizVel > 3.0 ? skier.velX / horizVel : -Math.sin(skier.headingRad);
    const probeDirZ = horizVel > 3.0 ? skier.velZ / horizVel : -Math.cos(skier.headingRad);
    const probeAheadM = 25.0;
    const aheadGroundY = surfaceQuery.evaluateHeight(
      skier.posX + probeDirX * probeAheadM,
      skier.posZ + probeDirZ * probeAheadM,
    );
    const probeSlope = surface.valid
      ? clamp(
          -(probeDirX * surface.normalX + probeDirZ * surface.normalZ) /
            Math.max(0.35, surface.normalY),
          -1.2,
          0.8,
        )
      : tangentYOrDefault(surface);
    const expectedLinearY = surface.groundY + probeSlope * probeAheadM;
    const crestDrop = Math.max(0, expectedLinearY - aheadGroundY);
    // Raise camera and pitch look-at down into landing pocket when approaching convex brow
    const targetCrestLift = clamp((crestDrop - 0.35) * 0.65, 0, 3.2);
    const targetLookDrop = clamp((crestDrop - 0.35) * 0.45, 0, 2.4);
    this.crestLiftM = damp(this.crestLiftM, targetCrestLift, 4.5, dt);
    this.crestLookDropM = damp(this.crestLookDropM, targetLookDrop, 4.5, dt);

    const speedRatio = clamp((skier.speed - 12) / 24, 0, 1);
    const trailDist = lerp(this.framing.trailDistMinM, this.framing.trailDistMaxM, speedRatio);
    const baseHeight =
      lerp(this.framing.baseHeightMinM, this.framing.baseHeightMaxM, speedRatio) + this.crestLiftM;
    const trailUphillSlope = surface.valid
      ? Math.max(
          0,
          (fwdX * surface.normalX + fwdZ * surface.normalZ) / Math.max(0.35, surface.normalY),
        )
      : 0.22;
    const slopeRise = Math.max(
      computeUphillSlopeRise(surface, trailDist),
      trailUphillSlope * trailDist,
    );

    const desiredPosX = skier.posX - fwdX * trailDist;
    const desiredPosZ = skier.posZ - fwdZ * trailDist;
    const desiredCamGroundY = surfaceQuery.evaluateHeight(desiredPosX, desiredPosZ);
    const slopeAnchorY = Math.max(skier.posY, surface.groundY) + slopeRise + baseHeight;
    const terrainClearanceY = desiredCamGroundY + Math.max(2.6, baseHeight * 0.72);
    const desiredPosY = Math.max(slopeAnchorY, terrainClearanceY);

    const posLambda = 9.0;
    this.currCamera.posX = damp(this.currCamera.posX, desiredPosX, posLambda, dt);
    this.currCamera.posY = damp(this.currCamera.posY, desiredPosY, posLambda * 0.85, dt);
    this.currCamera.posZ = damp(this.currCamera.posZ, desiredPosZ, posLambda, dt);

    const actualCamGroundY = surfaceQuery.evaluateHeight(
      this.currCamera.posX,
      this.currCamera.posZ,
    );
    const minCamY = actualCamGroundY + 2.0;
    if (this.currCamera.posY < minCamY) {
      this.currCamera.posY = minCamY;
    }

    if (surface.valid && surface.normalY >= 0.20) {
      const minFrontFaceY = computeMinFrontFaceY(
        skier.posY,
        this.currCamera.posX - skier.posX,
        this.currCamera.posZ - skier.posZ,
        surface,
      );
      if (this.currCamera.posY < minFrontFaceY) {
        this.currCamera.posY = minFrontFaceY;
      }
    }

    // Look ahead of skier so skier torso never blocks obstacles directly in front
    const lookAheadM = this.framing.lookAheadM;
    const desiredLookX = skier.posX + fwdX * lookAheadM;
    const desiredLookZ = skier.posZ + fwdZ * lookAheadM;
    const aheadLookY = surfaceQuery.evaluateHeight(desiredLookX, desiredLookZ);
    const lookSlope = surface.valid
      ? clamp(
          -(fwdX * surface.normalX + fwdZ * surface.normalZ) / Math.max(0.35, surface.normalY),
          -1.2,
          0.8,
        )
      : tangentYOrDefault(surface);

    const desiredLookY =
      Math.max(aheadLookY, skier.posY + lookSlope * lookAheadM) + 0.6 - this.crestLookDropM;

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
    this.currCamera.minHorizontalFovDeg = this.framing.minHorizontalFovDeg;
    this.currCamera.speedFovBoostDeg = damp(
      this.currCamera.speedFovBoostDeg,
      speedRatio * this.framing.maxSpeedFovBoostDeg,
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

function computeUphillSlopeRise(surface: SurfaceSample, trailDist: number): number {
  const horizTangent = surface.valid
    ? Math.max(0.45, Math.hypot(surface.tangentX, surface.tangentZ))
    : 0.975;
  const downhillY = Math.max(0, -tangentYOrDefault(surface));
  return (downhillY / horizTangent) * trailDist;
}

function computeMinFrontFaceY(
  skierPosY: number,
  camDx: number,
  camDz: number,
  surface: SurfaceSample,
): number {
  const k = 0.14;
  const ny = surface.normalY;
  const b = -(camDx * surface.normalX + camDz * surface.normalZ);
  const hSq = camDx * camDx + camDz * camDz;
  const a = ny * ny - k * k;
  const exactOffsetY = (b * ny + k * Math.sqrt(b * b + a * hSq)) / a;
  const safePlaneOffset = clamp(b / ny, -6.0, 26.0) + 2.2;
  return skierPosY + Math.max(exactOffsetY, safePlaneOffset);
}
