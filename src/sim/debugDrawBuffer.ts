import {
  createRibbonPointOut,
  createSpineFrameOut,
  type DebugDrawView,
  type RibbonPointOut,
  type SkierPose,
  type SpineFrameOut,
  type SurfaceSample,
} from './contracts';
import type { EntityPools } from './entityPools';
import type { TrailSegment } from './trailSegment';
import type { TrailWindow } from './trailWindow';

const MAX_SAFE_PATH_POINTS = 512;
const MAX_COLLIDERS = 280;
const MAX_DELIVERIES = 24;
const MAX_FORKS = 4;
const MAX_CHUNK_BOUNDARIES = 64;

/**
 * Zero-allocation flat typed-array buffer backing DebugDrawView so debug geometry
 * (safeX splines, collider cylinders/heights, delivery radii, fork V-wedges, chunk lines)
 * can be inspected visually without importing Three.js into src/sim/.
 */
export class DebugDrawBuffer implements DebugDrawView {
  enabled = false;

  safePathPointCount = 0;
  readonly safePathPoints = new Float32Array(MAX_SAFE_PATH_POINTS * 3);
  readonly safePathSegmentIds = new Int32Array(MAX_SAFE_PATH_POINTS);

  colliderCount = 0;
  readonly colliderPositions = new Float32Array(MAX_COLLIDERS * 3);
  readonly colliderRadii = new Float32Array(MAX_COLLIDERS);
  readonly colliderHeights = new Float32Array(MAX_COLLIDERS);
  readonly colliderKinds = new Uint8Array(MAX_COLLIDERS);

  deliveryZoneCount = 0;
  readonly deliveryPositions = new Float32Array(MAX_DELIVERIES * 3);
  readonly deliveryRadii = new Float32Array(MAX_DELIVERIES);

  forkCount = 0;
  readonly forkApexPositions = new Float32Array(MAX_FORKS * 3);
  readonly forkLeftTargets = new Float32Array(MAX_FORKS * 3);
  readonly forkRightTargets = new Float32Array(MAX_FORKS * 3);
  readonly forkNoseRadii = new Float32Array(MAX_FORKS);

  chunkBoundaryCount = 0;
  readonly chunkBoundaryLines = new Float32Array(MAX_CHUNK_BOUNDARIES * 6);

  readonly skierPos = new Float32Array(3);
  readonly skierNormal = new Float32Array(3);
  readonly skierDownhill = new Float32Array(3);
  readonly skierVelocity = new Float32Array(3);

  private readonly scratchRibbon: RibbonPointOut = createRibbonPointOut();
  private readonly scratchFrame: SpineFrameOut = createSpineFrameOut();
  private readonly scratchRibbonL: RibbonPointOut = createRibbonPointOut();
  private readonly scratchRibbonR: RibbonPointOut = createRibbonPointOut();

  clear(): void {
    this.safePathPointCount = 0;
    this.colliderCount = 0;
    this.deliveryZoneCount = 0;
    this.forkCount = 0;
    this.chunkBoundaryCount = 0;
  }

  update(
    trailWindow: TrailWindow,
    pools: EntityPools,
    skier: SkierPose,
    surface: SurfaceSample,
  ): void {
    if (!this.enabled) {
      this.clear();
      return;
    }

    this.safePathPointCount = 0;
    this.chunkBoundaryCount = 0;
    this.forkCount = 0;

    this.appendSegmentDebug(trailWindow.prev);
    this.appendSegmentDebug(trailWindow.curr);
    this.appendSegmentDebug(trailWindow.nextLeft);
    this.appendSegmentDebug(trailWindow.nextRight);

    // Fork V-wedge visualization
    if (trailWindow.curr.fork.hasFork && trailWindow.nextLeft && trailWindow.nextRight) {
      const fIdx = this.forkCount++;
      const f = trailWindow.curr.fork;
      this.forkApexPositions[fIdx * 3] = f.seamWorldX;
      this.forkApexPositions[fIdx * 3 + 1] = f.seamWorldY;
      this.forkApexPositions[fIdx * 3 + 2] = f.seamWorldZ;
      this.forkNoseRadii[fIdx] = f.seamNoseRadius;

      trailWindow.nextLeft.sampleSpineFrame(25, this.scratchFrame);
      this.forkLeftTargets[fIdx * 3] = this.scratchFrame.posX;
      this.forkLeftTargets[fIdx * 3 + 1] = this.scratchFrame.posY;
      this.forkLeftTargets[fIdx * 3 + 2] = this.scratchFrame.posZ;

      trailWindow.nextRight.sampleSpineFrame(25, this.scratchFrame);
      this.forkRightTargets[fIdx * 3] = this.scratchFrame.posX;
      this.forkRightTargets[fIdx * 3 + 1] = this.scratchFrame.posY;
      this.forkRightTargets[fIdx * 3 + 2] = this.scratchFrame.posZ;
    }

    // Colliders: hazards (0 = stumble, 1 = wipeout) & creatures (2)
    let cCount = 0;
    for (let i = 0; i < pools.hazards.count && cCount < MAX_COLLIDERS; i++) {
      this.colliderPositions[cCount * 3] = pools.hazards.posX[i]!;
      this.colliderPositions[cCount * 3 + 1] = pools.hazards.posY[i]!;
      this.colliderPositions[cCount * 3 + 2] = pools.hazards.posZ[i]!;
      this.colliderRadii[cCount] = pools.hazards.radius[i]!;
      this.colliderHeights[cCount] = pools.hazards.height[i]!;
      this.colliderKinds[cCount] = pools.hazards.lethalFlags[i] === 1 ? 1 : 0;
      cCount++;
    }
    for (let i = 0; i < pools.creatures.count && cCount < MAX_COLLIDERS; i++) {
      this.colliderPositions[cCount * 3] = pools.creatures.posX[i]!;
      this.colliderPositions[cCount * 3 + 1] = pools.creatures.groundY[i]!;
      this.colliderPositions[cCount * 3 + 2] = pools.creatures.posZ[i]!;
      this.colliderRadii[cCount] = pools.creatures.radius[i]!;
      this.colliderHeights[cCount] = pools.creatures.height[i]!;
      this.colliderKinds[cCount] = 2;
      cCount++;
    }
    this.colliderCount = cCount;

    // Active delivery zones
    let dCount = 0;
    for (let i = 0; i < pools.deliveryZones.count && dCount < MAX_DELIVERIES; i++) {
      if (pools.deliveryZones.active[i] === 0) continue;
      this.deliveryPositions[dCount * 3] = pools.deliveryZones.posX[i]!;
      this.deliveryPositions[dCount * 3 + 1] = pools.deliveryZones.posY[i]!;
      this.deliveryPositions[dCount * 3 + 2] = pools.deliveryZones.posZ[i]!;
      this.deliveryRadii[dCount] = pools.deliveryZones.radius[i]!;
      dCount++;
    }
    this.deliveryZoneCount = dCount;

    this.skierPos[0] = skier.posX;
    this.skierPos[1] = skier.posY;
    this.skierPos[2] = skier.posZ;
    this.skierNormal[0] = skier.normalX;
    this.skierNormal[1] = skier.normalY;
    this.skierNormal[2] = skier.normalZ;
    this.skierDownhill[0] = surface.tangentX;
    this.skierDownhill[1] = surface.tangentY;
    this.skierDownhill[2] = surface.tangentZ;
    this.skierVelocity[0] = skier.velX;
    this.skierVelocity[1] = skier.velY;
    this.skierVelocity[2] = skier.velZ;
  }

  private appendSegmentDebug(segment: TrailSegment | null): void {
    if (!segment) return;

    const sampleStep = 10;
    for (let s = 0; s <= segment.length && this.safePathPointCount < MAX_SAFE_PATH_POINTS; s += sampleStep) {
      const safeX = segment.sampleSafeX(s);
      segment.evaluateSurfaceAtX(s, safeX, this.scratchRibbon);
      const idx = this.safePathPointCount++;
      this.safePathPoints[idx * 3] = this.scratchRibbon.posX;
      this.safePathPoints[idx * 3 + 1] = this.scratchRibbon.posY + 0.15;
      this.safePathPoints[idx * 3 + 2] = this.scratchRibbon.posZ;
      this.safePathSegmentIds[idx] = segment.id;
    }

    for (let c = 0; c <= segment.chunkCount && this.chunkBoundaryCount < MAX_CHUNK_BOUNDARIES; c++) {
      const s = Math.min(segment.length, c * segment.chunkLength);
      segment.sampleSpineFrame(s, this.scratchFrame);
      const hw = this.scratchFrame.halfWidth;
      segment.evaluateSurfaceAtX(s, -hw, this.scratchRibbonL);
      segment.evaluateSurfaceAtX(s, hw, this.scratchRibbonR);
      const base = this.chunkBoundaryCount++ * 6;
      this.chunkBoundaryLines[base] = this.scratchRibbonL.posX;
      this.chunkBoundaryLines[base + 1] = this.scratchRibbonL.posY + 0.1;
      this.chunkBoundaryLines[base + 2] = this.scratchRibbonL.posZ;
      this.chunkBoundaryLines[base + 3] = this.scratchRibbonR.posX;
      this.chunkBoundaryLines[base + 4] = this.scratchRibbonR.posY + 0.1;
      this.chunkBoundaryLines[base + 5] = this.scratchRibbonR.posZ;
    }
  }
}
