import { clamp, lerp, smoothstep } from '../core/math';
import { fbm2D, ridgedNoise2D } from '../core/noise';
import { getStageDef, STAGE_SUNNY_BLUE } from '../content/stages';
import type {
  LandscapeProfile,
  PisteSurfaceType,
  SideLandscapeSpec,
} from '../content/types';
import {
  createMountainColumnOut,
  createPisteHeightOut,
  createSpineFrameOut,
  createSpineProjectionOut,
  type MountainColumnOut,
  type MountainFieldView,
  type MountainSampleOut,
  type MountainSpineSource,
  type PisteHeightOut,
  type SpineFrameOut,
  type SpineProjectionOut,
  type SpineView,
} from './contracts';

const MACRO_SIGMA_SQ_2 = 2 * 85 * 85;
const MACRO_CUTOFF_START_M = 200;
const MACRO_CUTOFF_END_M = 300;
const LANDSCAPE_ATTEN_START_M = 140;
const LANDSCAPE_ATTEN_END_M = 260;
const OUTER_FUNNEL_START_M = 110;
const OUTER_FUNNEL_END_M = 200;
const PISTE_LONG_HANDOFF_M = 14;
const NORMAL_SAMPLE_EPS_M = 0.5;
const ROCK_SLOPE_NORMAL_Y_THRESHOLD = 0.72;

/**
 * Continuous unified mountain heightfield combining macro sheet elevation Y_macro(wx, wz),
 * off-piste procedural landscape archetypes dH_landscape(absX, absZ), outer valley funneling,
 * and groomed piste stamp blending across active, horizon, and ghost spines.
 * Zero Three.js/DOM dependencies and zero hot-loop heap allocations.
 */
export class MountainField implements MountainFieldView {
  worldSeed = 1;
  originOffsetX = 0;
  originOffsetZ = 0;

  private readonly spineSource: MountainSpineSource;

  // Pre-allocated scratch buffers (zero hot-loop heap allocations)
  private readonly projScratch: SpineProjectionOut = createSpineProjectionOut();
  private readonly nearestProjScratch: SpineProjectionOut = createSpineProjectionOut();
  private readonly fallbackProjScratch: SpineProjectionOut = createSpineProjectionOut();
  private readonly pisteScratch: PisteHeightOut = createPisteHeightOut();
  private readonly frameScratch: SpineFrameOut = createSpineFrameOut();
  private readonly heightColumnScratch: MountainColumnOut = createMountainColumnOut();
  private readonly stageIdsScratch: string[] = [];
  private readonly stageWeightsScratch: number[] = [];

  constructor(spineSource: MountainSpineSource) {
    this.spineSource = spineSource;
  }

  setWorldSeed(seed: number): void {
    this.worldSeed = seed >>> 0;
  }

  setOriginOffset(ox: number, oz: number): void {
    this.originOffsetX = ox;
    this.originOffsetZ = oz;
  }

  collectSpinesInBounds(
    minX: number,
    maxX: number,
    minZ: number,
    maxZ: number,
    padM: number,
    outSpines: SpineView[],
  ): void {
    this.spineSource.collectSpinesInBounds(minX, maxX, minZ, maxZ, padM, outSpines);
  }

  evaluateHeight(wx: number, wz: number, candidateSpines?: readonly SpineView[]): number {
    return this.evaluateColumnCore(wx, wz, this.heightColumnScratch, candidateSpines, false).heightY;
  }

  evaluateColumn(
    wx: number,
    wz: number,
    out: MountainColumnOut,
    candidateSpines?: readonly SpineView[],
  ): MountainColumnOut {
    return this.evaluateColumnCore(wx, wz, out, candidateSpines, true);
  }

  evaluate(
    wx: number,
    wz: number,
    out: MountainSampleOut,
    candidateSpines?: readonly SpineView[],
  ): MountainSampleOut {
    this.evaluateColumnCore(wx, wz, out, candidateSpines, true);

    const hL = this.evaluateHeight(wx - NORMAL_SAMPLE_EPS_M, wz, candidateSpines);
    const hR = this.evaluateHeight(wx + NORMAL_SAMPLE_EPS_M, wz, candidateSpines);
    const hD = this.evaluateHeight(wx, wz - NORMAL_SAMPLE_EPS_M, candidateSpines);
    const hU = this.evaluateHeight(wx, wz + NORMAL_SAMPLE_EPS_M, candidateSpines);

    const span = 2 * NORMAL_SAMPLE_EPS_M;
    const dHx = (hR - hL) / span;
    const dHz = (hU - hD) / span;
    const invLen = 1 / Math.hypot(-dHx, 1, -dHz);

    out.normalX = -dHx * invLen;
    out.normalY = invLen;
    out.normalZ = -dHz * invLen;
    out.surfaceType =
      !out.onPiste && out.normalY < ROCK_SLOPE_NORMAL_Y_THRESHOLD ? 'rock' : out.pisteSurfaceType;

    return out;
  }

  private evaluateColumnCore(
    wx: number,
    wz: number,
    out: MountainColumnOut,
    candidateSpines: readonly SpineView[] | undefined,
    includeMetadata: boolean,
  ): MountainColumnOut {
    const spines =
      candidateSpines && candidateSpines.length > 0
        ? candidateSpines
        : this.spineSource.elevationSpines;

    if (spines.length === 0) {
      return this.populateEmptyFallback(wx, wz, out);
    }

    const absX = wx + this.originOffsetX;
    const absZ = wz + this.originOffsetZ;
    const cutoffSq = MACRO_CUTOFF_END_M * MACRO_CUTOFF_END_M;

    let sumW = 0;
    let weightedMacroY = 0;
    let weightedLandscapeDH = 0;
    let downhillAccX = 0;
    let downhillAccY = 0;
    let downhillAccZ = 0;

    let pisteSumW = 0;
    let pisteWeightedH = 0;
    let maxPisteW = 0;
    let dominantPisteSpine: SpineView | null = null;
    let dominantPisteS = 0;
    let dominantPisteSignedX = 0;
    let dominantPisteInDivider = false;

    let nearestSpine: SpineView | null = null;
    let nearestDistSq = Infinity;
    let minEdgeDist = Infinity;

    let fallbackSpine = spines[0]!;
    let fallbackAabbDistSq = Infinity;

    let stageCount = 0;

    for (let i = 0; i < spines.length; i++) {
      const sp = spines[i]!;
      const aabbDx =
        wx < sp.boundsMinX ? sp.boundsMinX - wx : wx > sp.boundsMaxX ? wx - sp.boundsMaxX : 0;
      const aabbDz =
        wz < sp.boundsMinZ ? sp.boundsMinZ - wz : wz > sp.boundsMaxZ ? wz - sp.boundsMaxZ : 0;
      const aabbDistSq = aabbDx * aabbDx + aabbDz * aabbDz;

      if (aabbDistSq < fallbackAabbDistSq) {
        fallbackAabbDistSq = aabbDistSq;
        fallbackSpine = sp;
      }

      if (aabbDistSq > cutoffSq) continue;

      sp.projectXZ(wx, wz, this.projScratch);
      const proj = this.projScratch;
      const distSq = proj.distSq;
      const dist = Math.sqrt(distSq);

      if (distSq < nearestDistSq) {
        nearestDistSq = distSq;
        nearestSpine = sp;
        this.copyProjection(proj, this.nearestProjScratch);
      }

      const latOutside = Math.max(0, Math.abs(proj.signedX) - proj.halfWidth);
      const edgeDist = Math.hypot(latOutside, proj.longExt);
      if (edgeDist < minEdgeDist) {
        minEdgeDist = edgeDist;
      }

      const w =
        Math.exp(-distSq / MACRO_SIGMA_SQ_2) *
        (1 - smoothstep(MACRO_CUTOFF_START_M, MACRO_CUTOFF_END_M, dist));

      const extDeltaY = proj.longExt * Math.tan(clamp(proj.pitchRad, -1.2, 1.2));
      const rawExtY = proj.spineY + extDeltaY;
      const landscape = this.resolveLandscape(sp);

      if (w > 0) {
        const extY = this.evaluateSmoothMacroSpineY(sp, wx, wz, rawExtY, dist, distSq);
        sumW += w;
        weightedMacroY += w * extY;

        const dH = this.evaluateSpineLandscape(sp, landscape, proj, edgeDist, dist, absX, absZ);
        weightedLandscapeDH += w * dH;

        if (includeMetadata) {
          downhillAccX += w * proj.forwardX;
          downhillAccY += w * proj.forwardY;
          downhillAccZ += w * proj.forwardZ;
          stageCount = this.accumulateStageWeight(sp.stageId, w, stageCount);
        }
      }

      const longMask = 1 - smoothstep(0, PISTE_LONG_HANDOFF_M, Math.abs(proj.longExt));
      if (longMask > 0) {
        const sideSpec = proj.signedX < 0 ? landscape.left : landscape.right;
        const blendW = Math.min(sideSpec.transitionWidth * 0.5, 10);
        const pisteW =
          (1 - smoothstep(proj.halfWidth, proj.halfWidth + blendW, Math.abs(proj.signedX))) *
          longMask;

        if (pisteW > 1e-6) {
          sp.evaluatePisteHeight(proj.s, proj.signedX, this.pisteScratch);
          const pisteH = this.pisteScratch.heightY + extDeltaY;
          pisteSumW += pisteW;
          pisteWeightedH += pisteW * pisteH;

          if (pisteW > maxPisteW) {
            maxPisteW = pisteW;
            dominantPisteSpine = sp;
            dominantPisteS = proj.s;
            dominantPisteSignedX = proj.signedX;
            dominantPisteInDivider = this.pisteScratch.inDivider;
          }
        }
      }
    }

    // Fallback to nearest spine when all spines sit past the 300m compact-support cutoff
    if (nearestSpine === null || sumW <= 1e-9) {
      if (nearestSpine === null) {
        fallbackSpine.projectXZ(wx, wz, this.fallbackProjScratch);
        nearestSpine = fallbackSpine;
        this.copyProjection(this.fallbackProjScratch, this.nearestProjScratch);
      }
      const np = this.nearestProjScratch;
      const dist = Math.sqrt(np.distSq);
      const latOutside = Math.max(0, Math.abs(np.signedX) - np.halfWidth);
      minEdgeDist = Math.hypot(latOutside, np.longExt);
      const extDeltaY = np.longExt * Math.tan(clamp(np.pitchRad, -1.2, 1.2));
      const macroY = this.evaluateSmoothMacroSpineY(
        nearestSpine,
        wx,
        wz,
        np.spineY + extDeltaY,
        dist,
        np.distSq,
      );
      const landscape = this.resolveLandscape(nearestSpine);
      const dH = this.evaluateSpineLandscape(nearestSpine, landscape, np, minEdgeDist, dist, absX, absZ);
      const outerFunnel = this.evaluateOuterValleyFunnel(minEdgeDist, absX, absZ);
      const offPisteRelief = (dH + outerFunnel) * (1 - maxPisteW);
      const finalPisteH = pisteSumW > 1e-6 ? pisteWeightedH / pisteSumW : macroY;
      const heightY = lerp(macroY + offPisteRelief, finalPisteH, maxPisteW);

      if (!includeMetadata) {
        out.heightY = heightY;
        return out;
      }

      return this.populateOutput(
        out,
        heightY,
        macroY,
        maxPisteW,
        nearestSpine,
        np,
        dominantPisteSpine,
        dominantPisteS,
        dominantPisteSignedX,
        dominantPisteInDivider,
        np.forwardX,
        np.forwardY,
        np.forwardZ,
        null,
        0,
      );
    }

    const macroY = weightedMacroY / sumW;
    const avgLandscapeDH = weightedLandscapeDH / sumW;
    const outerFunnel = this.evaluateOuterValleyFunnel(minEdgeDist, absX, absZ);
    const offPisteRelief = (avgLandscapeDH + outerFunnel) * (1 - maxPisteW);
    const finalPisteH = pisteSumW > 1e-6 ? pisteWeightedH / pisteSumW : macroY;
    const heightY = lerp(macroY + offPisteRelief, finalPisteH, maxPisteW);

    if (!includeMetadata) {
      out.heightY = heightY;
      return out;
    }

    const np = this.nearestProjScratch;
    const dLen = Math.hypot(downhillAccX, downhillAccY, downhillAccZ);
    let dhX = np.forwardX;
    let dhY = np.forwardY;
    let dhZ = np.forwardZ;
    if (dLen > 1e-6) {
      const invD = 1 / dLen;
      dhX = downhillAccX * invD;
      dhY = downhillAccY * invD;
      dhZ = downhillAccZ * invD;
    }

    let secondaryStageId: string | null = null;
    let secondaryStageWeight = 0;
    let bestSecW = 0;
    for (let i = 0; i < stageCount; i++) {
      const sid = this.stageIdsScratch[i]!;
      if (sid === nearestSpine.stageId) continue;
      const sw = this.stageWeightsScratch[i]!;
      if (sw > bestSecW) {
        bestSecW = sw;
        secondaryStageId = sid;
      }
    }
    if (secondaryStageId !== null && bestSecW > 1e-6) {
      secondaryStageWeight = clamp(bestSecW / sumW, 0, 1);
    } else {
      secondaryStageId = null;
      secondaryStageWeight = 0;
    }

    return this.populateOutput(
      out,
      heightY,
      macroY,
      maxPisteW,
      nearestSpine,
      np,
      dominantPisteSpine,
      dominantPisteS,
      dominantPisteSignedX,
      dominantPisteInDivider,
      dhX,
      dhY,
      dhZ,
      secondaryStageId,
      secondaryStageWeight,
    );
  }

  private populateOutput(
    out: MountainColumnOut,
    heightY: number,
    macroY: number,
    pisteWeight: number,
    nearestSpine: SpineView,
    np: SpineProjectionOut,
    dominantPisteSpine: SpineView | null,
    dominantPisteS: number,
    dominantPisteSignedX: number,
    dominantPisteInDivider: boolean,
    downhillX: number,
    downhillY: number,
    downhillZ: number,
    secondaryStageId: string | null,
    secondaryStageWeight: number,
  ): MountainColumnOut {
    const onPiste = pisteWeight >= 0.5;
    let pisteSurfaceType: PisteSurfaceType = 'powder';
    let inDivider = false;
    if (pisteWeight > 0 && dominantPisteSpine !== null) {
      pisteSurfaceType = dominantPisteSpine.evaluatePisteSurface(
        dominantPisteS,
        dominantPisteSignedX,
      );
      inDivider = dominantPisteInDivider;
    }

    const nearestLandscape = this.resolveLandscape(nearestSpine);
    const dominantSide = np.signedX < 0 ? nearestLandscape.left : nearestLandscape.right;
    const absSignedX = Math.abs(np.signedX);

    let inChasmZone = false;
    let chasmWipeoutDepth = 0;
    if (
      !onPiste &&
      dominantSide.archetype === 'chasm' &&
      absSignedX > np.halfWidth &&
      Math.abs(np.longExt) < 25
    ) {
      const withinFarWall =
        dominantSide.farWallOffsetM === undefined ||
        absSignedX <= np.halfWidth + dominantSide.farWallOffsetM;
      const isSuppressedInnerFork =
        nearestSpine.fork.isForkChild &&
        ((nearestSpine.fork.forkSide === 'left' && np.signedX > 0) ||
          (nearestSpine.fork.forkSide === 'right' && np.signedX < 0)) &&
        np.s < 25;
      if (withinFarWall && !isSuppressedInnerFork) {
        inChasmZone = true;
        chasmWipeoutDepth = dominantSide.chasmWipeoutDepth;
      }
    }

    out.heightY = heightY;
    out.macroY = macroY;
    out.pisteWeight = pisteWeight;
    out.onPiste = onPiste;
    out.pisteSurfaceType = pisteSurfaceType;
    out.inDivider = inDivider;
    out.inChasmZone = inChasmZone;
    out.chasmWipeoutDepth = chasmWipeoutDepth;
    out.chasmDepthBelowSpine = Math.max(0, np.spineY - heightY);
    out.nearestSpineY = np.spineY;
    out.nearestSegmentId = nearestSpine.id;
    out.nearestStageId = nearestSpine.stageId;
    out.secondaryStageId = secondaryStageId;
    out.secondaryStageWeight = secondaryStageWeight;
    out.nearestS = np.s;
    out.nearestSignedX = np.signedX;
    out.nearestHalfWidth = np.halfWidth;
    out.downhillX = downhillX;
    out.downhillY = downhillY;
    out.downhillZ = downhillZ;
    return out;
  }

  private populateEmptyFallback(wx: number, wz: number, out: MountainColumnOut): MountainColumnOut {
    const absX = wx + this.originOffsetX;
    const absZ = wz + this.originOffsetZ;
    const funnel = this.evaluateOuterValleyFunnel(200, absX, absZ);
    out.heightY = funnel;
    out.macroY = 0;
    out.pisteWeight = 0;
    out.onPiste = false;
    out.pisteSurfaceType = 'powder';
    out.inDivider = false;
    out.inChasmZone = false;
    out.chasmWipeoutDepth = 0;
    out.chasmDepthBelowSpine = 0;
    out.nearestSpineY = 0;
    out.nearestSegmentId = -1;
    out.nearestStageId = 'sunny-blue';
    out.secondaryStageId = null;
    out.secondaryStageWeight = 0;
    out.nearestS = 0;
    out.nearestSignedX = 0;
    out.nearestHalfWidth = 14;
    out.downhillX = 0;
    out.downhillY = 0;
    out.downhillZ = -1;
    return out;
  }

  private evaluateSpineLandscape(
    spine: SpineView,
    landscape: LandscapeProfile,
    proj: SpineProjectionOut,
    edgeDist: number,
    dist: number,
    absX: number,
    absZ: number,
  ): number {
    const absLat = proj.halfWidth + edgeDist;
    let leftDH = this.evaluateSideSpec(landscape.left, proj.halfWidth, absLat, absX, absZ);
    let rightDH = this.evaluateSideSpec(landscape.right, proj.halfWidth, absLat, absX, absZ);

    // Smoothly attenuate inner-fork side landscape over s in [20, 85] so chasms/walls
    // never crater the V-wedge nose immediately downstream of a fork seam
    if (spine.fork.isForkChild) {
      const innerAtten = smoothstep(20, 85, proj.s);
      if (spine.fork.forkSide === 'left') {
        rightDH *= innerAtten;
      } else if (spine.fork.forkSide === 'right') {
        leftDH *= innerAtten;
      }
    }

    const sideBlend = smoothstep(-2, 2, proj.signedX);
    const blended = lerp(leftDH, rightDH, sideBlend);
    const distAtten = 1 - smoothstep(LANDSCAPE_ATTEN_START_M, LANDSCAPE_ATTEN_END_M, dist);
    return blended * distAtten;
  }

  private evaluateSideSpec(
    side: SideLandscapeSpec,
    hw: number,
    absLat: number,
    absX: number,
    absZ: number,
  ): number {
    const tw = Math.max(1, side.transitionWidth);
    const ramp = smoothstep(hw, hw + tw, absLat);
    if (ramp <= 0) return 0;

    const nx = absX * side.noiseFrequency;
    const nz = absZ * side.noiseFrequency;

    switch (side.archetype) {
      case 'rollingHills': {
        const nFbm = fbm2D(nx, nz, 101, 3, 2.0, 0.5);
        return ramp * side.reliefScale * nFbm;
      }
      case 'alpineBowl': {
        const nFbm = fbm2D(nx, nz, 101, 3, 2.0, 0.5);
        const bowlOuter = smoothstep(hw, hw + Math.max(20, tw * 2.5), absLat);
        return ramp * side.reliefScale * (0.25 + 0.55 * bowlOuter + 0.2 * nFbm);
      }
      case 'canyonWalls': {
        const nRidged = ridgedNoise2D(nx, nz, 202, 3, 2.0, 0.5);
        return ramp * side.reliefScale * (0.6 + 0.4 * nRidged);
      }
      case 'chasm': {
        const drop = -side.reliefScale * ramp;
        let farRise = 0;
        if (side.farWallOffsetM !== undefined) {
          const farStart = hw + side.farWallOffsetM;
          const farTw = Math.max(tw, 24);
          const farT = smoothstep(farStart, farStart + farTw, absLat);
          if (farT > 0) {
            const nRidged = ridgedNoise2D(nx, nz, 202, 3, 2.0, 0.5);
            farRise = side.reliefScale * (0.85 + 0.35 * nRidged) * farT;
          }
        }
        return drop + farRise;
      }
    }
  }

  private evaluateOuterValleyFunnel(minEdgeDist: number, absX: number, absZ: number): number {
    const t = smoothstep(OUTER_FUNNEL_START_M, OUTER_FUNNEL_END_M, minEdgeDist);
    if (t <= 0) return 0;
    const nRidged = ridgedNoise2D(absX * 0.01, absZ * 0.01, 303, 3, 2.0, 0.5);
    return t * (38 + 14 * nRidged);
  }

  private evaluateSmoothMacroSpineY(
    sp: SpineView,
    wx: number,
    wz: number,
    rawExtY: number,
    dist: number,
    distSq: number,
  ): number {
    // Near the spine (<= 25m) use exact tangent projection; further out on tight curves
    // blend toward a C^inf Gaussian average along the spine (independent of proj.s/longExt)
    // so inner-turn Voronoi medial axes never introduce step cliffs.
    const blend = smoothstep(25, 50, dist);
    if (blend <= 0) return rawExtY;

    const invTwoSigmaSq = 1 / (2 * 40 * 40);
    let wSum = 0;
    let ySum = 0;

    const anchorCount = sp.macroAnchorCount;
    const anchorX = sp.macroAnchorX;
    const anchorY = sp.macroAnchorY;
    const anchorZ = sp.macroAnchorZ;
    if (
      anchorCount !== undefined &&
      anchorX !== undefined &&
      anchorY !== undefined &&
      anchorZ !== undefined
    ) {
      for (let i = 0; i < anchorCount; i++) {
        const dx = wx - anchorX[i]!;
        const dz = wz - anchorZ[i]!;
        const dSq = dx * dx + dz * dz;
        const deltaSq = dSq - distSq;
        if (deltaSq > 38400) continue;
        const w = deltaSq <= 0 ? 1 : Math.exp(-deltaSq * invTwoSigmaSq);
        wSum += w;
        ySum += w * anchorY[i]!;
      }
    } else {
      const step = 16;

      // Sample upstream tangent extension out to -320m at uniform 16m spacing
      sp.sampleSpineFrame(0, this.frameScratch);
      for (let ds = -320; ds <= -step; ds += step) {
        const px = this.frameScratch.posX + this.frameScratch.forwardX * ds;
        const py = this.frameScratch.posY + this.frameScratch.forwardY * ds;
        const pz = this.frameScratch.posZ + this.frameScratch.forwardZ * ds;
        const dSq = (wx - px) * (wx - px) + (wz - pz) * (wz - pz);
        const deltaSq = dSq - distSq;
        if (deltaSq > 38400) continue;
        const w = deltaSq <= 0 ? 1 : Math.exp(-deltaSq * invTwoSigmaSq);
        wSum += w;
        ySum += w * py;
      }

      // Sample along spine [0, length) at uniform 16m spacing
      for (let s = 0; s < sp.length; s += step) {
        sp.sampleSpineFrame(s, this.frameScratch);
        const dSq =
          (wx - this.frameScratch.posX) * (wx - this.frameScratch.posX) +
          (wz - this.frameScratch.posZ) * (wz - this.frameScratch.posZ);
        const deltaSq = dSq - distSq;
        if (deltaSq > 38400) continue;
        const w = deltaSq <= 0 ? 1 : Math.exp(-deltaSq * invTwoSigmaSq);
        wSum += w;
        ySum += w * this.frameScratch.posY;
      }

      // Sample endpoint and downstream tangent extension out to +320m at uniform 16m spacing
      sp.sampleSpineFrame(sp.length, this.frameScratch);
      for (let ds = 0; ds <= 320; ds += step) {
        const px = this.frameScratch.posX + this.frameScratch.forwardX * ds;
        const py = this.frameScratch.posY + this.frameScratch.forwardY * ds;
        const pz = this.frameScratch.posZ + this.frameScratch.forwardZ * ds;
        const dSq = (wx - px) * (wx - px) + (wz - pz) * (wz - pz);
        const deltaSq = dSq - distSq;
        if (deltaSq > 38400) continue;
        const w = deltaSq <= 0 ? 1 : Math.exp(-deltaSq * invTwoSigmaSq);
        wSum += w;
        ySum += w * py;
      }
    }

    const softY = wSum > 1e-12 ? ySum / wSum : rawExtY;
    return lerp(rawExtY, softY, blend);
  }

  private resolveLandscape(spine: SpineView): LandscapeProfile {
    return spine.landscape ?? getStageDef(spine.stageId)?.landscape ?? STAGE_SUNNY_BLUE.landscape;
  }

  private accumulateStageWeight(stageId: string, weight: number, count: number): number {
    for (let i = 0; i < count; i++) {
      if (this.stageIdsScratch[i] === stageId) {
        this.stageWeightsScratch[i] = this.stageWeightsScratch[i]! + weight;
        return count;
      }
    }
    this.stageIdsScratch[count] = stageId;
    this.stageWeightsScratch[count] = weight;
    return count + 1;
  }

  private copyProjection(src: SpineProjectionOut, dst: SpineProjectionOut): void {
    dst.s = src.s;
    dst.signedX = src.signedX;
    dst.longExt = src.longExt;
    dst.distSq = src.distSq;
    dst.spineX = src.spineX;
    dst.spineY = src.spineY;
    dst.spineZ = src.spineZ;
    dst.forwardX = src.forwardX;
    dst.forwardY = src.forwardY;
    dst.forwardZ = src.forwardZ;
    dst.rightX = src.rightX;
    dst.rightZ = src.rightZ;
    dst.pitchRad = src.pitchRad;
    dst.halfWidth = src.halfWidth;
    dst.dividerHalfWidth = src.dividerHalfWidth;
  }
}
