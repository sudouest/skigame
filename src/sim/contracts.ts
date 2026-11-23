import type { SurfaceType, VisualSpec } from '../content/types';

export type { SurfaceType };

/**
 * Coordinate & Angle Conventions (Right-handed +Y up):
 * - World Space: (X, Y, Z) with +Y up.
 * - Yaw / Heading (`yawRad`, `headingRad`): 0 rad faces -Z; positive +yaw rotates
 *   counter-clockwise around +Y (matching THREE.Object3D.rotation.y):
 *     forwardXZ = (-sin(yaw), 0, -cos(yaw))
 *     rightXZ   = ( cos(yaw), 0, -sin(yaw))
 * - Pitch (`pitchRad`): signed rotation around local +X right axis (Euler 'YXZ'):
 *   negative pitchRad < 0 points forward nose downhill (forwardY = sin(pitchRad) < 0).
 * - Bank (`bankRad`): lateral terrain lean around local forward tangent T(s).
 */

/**
 * Compile-time immutable numeric buffer view backed by TypedArrays (Float32Array, Uint8Array, etc.).
 * Prevents renderers/UI from mutating simulation-owned pooled buffers with zero runtime wrapping.
 */
export interface ReadonlyNumericBuffer {
  readonly length: number;
  readonly [index: number]: number;
}

export interface PlayerIntent {
  /** Continuous steering axis in [-1, 1] (-1 = left, +1 = right). */
  readonly steer: number;
  /** Relative horizontal pointer/touch drag delta accumulated for this step (normalized). */
  readonly pointerSteerDelta: number;
  /** Edge-triggered jump intent. */
  readonly jumpPressed: boolean;
  /** Continuous snowplow brake held state. */
  readonly brake: boolean;
}

export interface MutablePlayerIntent {
  steer: number;
  pointerSteerDelta: number;
  jumpPressed: boolean;
  brake: boolean;
}

export function createMutablePlayerIntent(): MutablePlayerIntent {
  return {
    steer: 0,
    pointerSteerDelta: 0,
    jumpPressed: false,
    brake: false,
  };
}

export interface SurfaceSample {
  segmentId: number;
  s: number;
  x: number;
  groundY: number;
  normalX: number;
  normalY: number;
  normalZ: number;
  tangentX: number;
  tangentY: number;
  tangentZ: number;
  halfWidth: number;
  surfaceType: SurfaceType;
  inBank: boolean;
  inDivider: boolean;
  valid: boolean;
}

export type ReadonlySurfaceSample = Readonly<SurfaceSample>;

export function createSurfaceSample(): SurfaceSample {
  return {
    segmentId: -1,
    s: 0,
    x: 0,
    groundY: 0,
    normalX: 0,
    normalY: 1,
    normalZ: 0,
    tangentX: 0,
    tangentY: 0,
    tangentZ: -1,
    halfWidth: 14,
    surfaceType: 'packed',
    inBank: false,
    inDivider: false,
    valid: false,
  };
}

export interface CameraPose {
  readonly posX: number;
  readonly posY: number;
  readonly posZ: number;
  readonly lookAtX: number;
  readonly lookAtY: number;
  readonly lookAtZ: number;
  readonly rollRad: number;
  readonly minHorizontalFovDeg: number;
  readonly speedFovBoostDeg: number;
}

export interface RebaseInfo {
  readonly rebaseCount: number;
  /** Cumulative worldOriginOffset (Ox, Oy, Oz) subtracted from live simulation coordinates. */
  readonly offsetX: number;
  readonly offsetY: number;
  readonly offsetZ: number;
  /** Delta subtracted during the most recent rebase event. */
  readonly lastDeltaX: number;
  readonly lastDeltaY: number;
  readonly lastDeltaZ: number;
}

export type TrailSlotRole = 'prev' | 'curr' | 'nextLeft' | 'nextRight';

export interface ChunkRangeOut {
  startS: number;
  endS: number;
}

export function createChunkRangeOut(): ChunkRangeOut {
  return { startS: 0, endS: 0 };
}

export interface SpineFrameOut {
  posX: number;
  posY: number;
  posZ: number;
  forwardX: number;
  forwardY: number;
  forwardZ: number;
  rightX: number;
  rightY: number;
  rightZ: number;
  /** Heading around +Y where 0 rad faces -Z (forwardXZ = (-sin(yaw), 0, -cos(yaw))). */
  yawRad: number;
  /** Signed downhill slope pitch around local +X (< 0 pitches nose downward). */
  pitchRad: number;
  bankRad: number;
  curvature: number;
  halfWidth: number;
  skirtWidth: number;
  dividerHalfWidth: number;
}

export function createSpineFrameOut(): SpineFrameOut {
  return {
    posX: 0,
    posY: 0,
    posZ: 0,
    forwardX: 0,
    forwardY: 0,
    forwardZ: -1,
    rightX: 1,
    rightY: 0,
    rightZ: 0,
    yawRad: 0,
    pitchRad: 0,
    bankRad: 0,
    curvature: 0,
    halfWidth: 14,
    skirtWidth: 12,
    dividerHalfWidth: 0,
  };
}

export interface RibbonPointOut {
  posX: number;
  posY: number;
  posZ: number;
  normalX: number;
  normalY: number;
  normalZ: number;
  lateralX: number;
  halfWidth: number;
  skirtWidth: number;
  slopeDeg: number;
  localHeight: number;
  surfaceType: SurfaceType;
  inPlayableCorridor: boolean;
  inDivider: boolean;
  isInnerForkSlope: boolean;
}

export function createRibbonPointOut(): RibbonPointOut {
  return {
    posX: 0,
    posY: 0,
    posZ: 0,
    normalX: 0,
    normalY: 1,
    normalZ: 0,
    lateralX: 0,
    halfWidth: 14,
    skirtWidth: 12,
    slopeDeg: 12,
    localHeight: 0,
    surfaceType: 'packed',
    inPlayableCorridor: true,
    inDivider: false,
    isInnerForkSlope: false,
  };
}

export interface SegmentForkMeta {
  /** True when this segment splits at s = length into nextLeft & nextRight. */
  readonly hasFork: boolean;
  /** Arc length along segment where the overhead iconographic fork arch spawns. */
  readonly archS: number;
  /** Arc length after which static obstacles are forbidden ahead of the fork seam. */
  readonly obstacleFreeStartS: number;
  readonly leftStageId: string | null;
  readonly rightStageId: string | null;
  /** True when this segment starts immediately downstream of a fork seam (s = 0). */
  readonly isForkChild: boolean;
  readonly forkSide: 'none' | 'left' | 'right';
  /** Distance from s = 0 over which the inner snowbank ramps from 0 to full height. */
  readonly innerWallRampLength: number;
  /** Rounded soft-bumper V-wedge nose radius at the split apex (meters). */
  readonly seamNoseRadius: number;
  /** Current shifted world coordinates of the fork seam apex. */
  readonly seamWorldX: number;
  readonly seamWorldY: number;
  readonly seamWorldZ: number;
  readonly seamYawRad: number;
}

/**
 * Static chunk-anchored landmark metadata consumed by ChunkStreamer & scenery exclusion SpatialGrid.
 * Ownership boundaries (prevents double-spawning):
 * - 'forkArch' & 'deliveryLandmark': static scenery landmarks placed by ChunkStreamer (cabins,
 *   lanterns, overhead fork arches). Waiting/cheering children remain in DeliveryZonePoolView.
 * - Playable ski ramps belong exclusively to EntityPoolViews.ramps (not landmarks).
 */
export interface SegmentLandmarkRequirement {
  readonly id: string;
  readonly kind: 'forkArch' | 'deliveryLandmark';
  readonly segmentId: number;
  readonly chunkIndex: number;
  readonly s: number;
  readonly x: number;
  readonly worldX: number;
  readonly worldY: number;
  readonly worldZ: number;
  /** Heading around +Y where 0 rad faces -Z (THREE.Object3D.rotation.y). */
  readonly yawRad: number;
  readonly clearanceRadius: number;
  readonly visual: VisualSpec;
  /** Left branch stage ID for 'forkArch' iconographic badges. */
  readonly leftBadgeStageId?: string;
  /** Right branch stage ID for 'forkArch' iconographic badges. */
  readonly rightBadgeStageId?: string;
}

/**
 * Read-only view of a trail segment in the 4-slot sliding window.
 * Used by RibbonPool and ChunkStreamer to build chunk meshes and scenery with zero allocation.
 */
export interface TerrainSegmentView {
  readonly id: number;
  readonly slot: TrailSlotRole;
  readonly stageId: string;
  readonly seed: number;
  readonly length: number;
  readonly chunkLength: number;
  readonly chunkCount: number;
  readonly prevSegmentId: number | null;
  readonly nextLeftId: number | null;
  readonly nextRightId: number | null;
  readonly fork: SegmentForkMeta;
  readonly landmarks: readonly SegmentLandmarkRequirement[];

  getChunkBounds(chunkIndex: number, out: ChunkRangeOut): void;
  sampleSpineFrame(s: number, out: SpineFrameOut): void;
  /** Evaluates surface at arc-length s and normalized transverse coordinate u in [-1, 1]. */
  evaluateRibbonPoint(s: number, u: number, out: RibbonPointOut): void;
  /** Evaluates surface at arc-length s and lateral offset x in meters. */
  evaluateSurfaceAtX(s: number, x: number, out: RibbonPointOut): void;
  /** Returns the guaranteed reachable centerline x offset at arc-length s. */
  sampleSafeX(s: number): number;
}

export interface TrailWindowView {
  readonly prev: TerrainSegmentView | null;
  readonly curr: TerrainSegmentView;
  readonly nextLeft: TerrainSegmentView | null;
  readonly nextRight: TerrainSegmentView | null;
}

export interface HazardPoolView {
  readonly count: number;
  readonly capacity: number;
  readonly defIds: readonly string[];
  readonly segmentIds: ReadonlyNumericBuffer;
  readonly posX: ReadonlyNumericBuffer;
  readonly posY: ReadonlyNumericBuffer;
  readonly posZ: ReadonlyNumericBuffer;
  /** Local terrain surface normal for terrain-aligned contact shadow orientation. */
  readonly normalX: ReadonlyNumericBuffer;
  readonly normalY: ReadonlyNumericBuffer;
  readonly normalZ: ReadonlyNumericBuffer;
  /** Heading around +Y where 0 rad faces -Z (THREE.Object3D.rotation.y). */
  readonly yawRad: ReadonlyNumericBuffer;
  readonly scale: ReadonlyNumericBuffer;
  readonly radius: ReadonlyNumericBuffer;
  readonly height: ReadonlyNumericBuffer;
  /** 0 = intact, 1 = triggered/clipped. */
  readonly triggered: ReadonlyNumericBuffer;
}

export interface PresentPoolView {
  readonly count: number;
  readonly capacity: number;
  readonly defIds: readonly string[];
  readonly segmentIds: ReadonlyNumericBuffer;
  readonly posX: ReadonlyNumericBuffer;
  readonly posY: ReadonlyNumericBuffer;
  readonly posZ: ReadonlyNumericBuffer;
  readonly bobPhase: ReadonlyNumericBuffer;
  /** 0 = available in world, 1 = collected. */
  readonly collected: ReadonlyNumericBuffer;
}

export interface TossedPresentPoolView {
  readonly count: number;
  readonly capacity: number;
  readonly defIds: readonly string[];
  readonly prevPosX: ReadonlyNumericBuffer;
  readonly prevPosY: ReadonlyNumericBuffer;
  readonly prevPosZ: ReadonlyNumericBuffer;
  readonly posX: ReadonlyNumericBuffer;
  readonly posY: ReadonlyNumericBuffer;
  readonly posZ: ReadonlyNumericBuffer;
  readonly prevSpinRad: ReadonlyNumericBuffer;
  readonly spinRad: ReadonlyNumericBuffer;
  readonly progress: ReadonlyNumericBuffer;
  /** 0 = delivery toss arc, 1 = wipeout scatter burst. */
  readonly kind: ReadonlyNumericBuffer;
}

export interface DeliveryZonePoolView {
  readonly count: number;
  readonly capacity: number;
  readonly defIds: readonly string[];
  readonly segmentIds: ReadonlyNumericBuffer;
  readonly posX: ReadonlyNumericBuffer;
  readonly posY: ReadonlyNumericBuffer;
  readonly posZ: ReadonlyNumericBuffer;
  readonly yawRad: ReadonlyNumericBuffer;
  readonly radius: ReadonlyNumericBuffer;
  readonly deliveredCount: ReadonlyNumericBuffer;
  /** 1 = active awaiting delivery, 0 = completed/inactive. */
  readonly active: ReadonlyNumericBuffer;
  readonly celebratingTimer: ReadonlyNumericBuffer;
}

export const CREATURE_PHASE_IDLE = 0;
export const CREATURE_PHASE_TELEGRAPH = 1;
export const CREATURE_PHASE_ATTACK = 2;
export const CREATURE_PHASE_RECOVER = 3;

export interface CreaturePoolView {
  readonly count: number;
  readonly capacity: number;
  readonly defIds: readonly string[];
  readonly segmentIds: ReadonlyNumericBuffer;
  readonly prevPosX: ReadonlyNumericBuffer;
  readonly prevPosY: ReadonlyNumericBuffer;
  readonly prevPosZ: ReadonlyNumericBuffer;
  readonly posX: ReadonlyNumericBuffer;
  readonly posY: ReadonlyNumericBuffer;
  readonly posZ: ReadonlyNumericBuffer;
  /** Local terrain surface normal for terrain-aligned contact shadow orientation. */
  readonly normalX: ReadonlyNumericBuffer;
  readonly normalY: ReadonlyNumericBuffer;
  readonly normalZ: ReadonlyNumericBuffer;
  /** Heading around +Y where 0 rad faces -Z (forwardXZ = (-sin(heading), 0, -cos(heading))). */
  readonly prevHeadingRad: ReadonlyNumericBuffer;
  readonly headingRad: ReadonlyNumericBuffer;
  readonly groundY: ReadonlyNumericBuffer;
  /** Phase code: 0=idle, 1=telegraph, 2=attack/patrol, 3=recover. */
  readonly stateCode: ReadonlyNumericBuffer;
  readonly stateTimer: ReadonlyNumericBuffer;
  readonly telegraphProgress: ReadonlyNumericBuffer;
  readonly radius: ReadonlyNumericBuffer;
}

export interface SkiTrackPoolView {
  readonly count: number;
  readonly capacity: number;
  /** Ring buffer write head index; oldest sample starts at (head - count + capacity) % capacity. */
  readonly head: number;
  readonly posX: ReadonlyNumericBuffer;
  readonly posY: ReadonlyNumericBuffer;
  readonly posZ: ReadonlyNumericBuffer;
  readonly normalX: ReadonlyNumericBuffer;
  readonly normalY: ReadonlyNumericBuffer;
  readonly normalZ: ReadonlyNumericBuffer;
  readonly rightX: ReadonlyNumericBuffer;
  readonly rightY: ReadonlyNumericBuffer;
  readonly rightZ: ReadonlyNumericBuffer;
  readonly ageSec: ReadonlyNumericBuffer;
  /** 1 = grounded contact sample, 0 = airborne break. */
  readonly grounded: ReadonlyNumericBuffer;
}

export interface RampPoolView {
  readonly count: number;
  readonly capacity: number;
  readonly defIds: readonly string[];
  readonly segmentIds: ReadonlyNumericBuffer;
  readonly posX: ReadonlyNumericBuffer;
  readonly posY: ReadonlyNumericBuffer;
  readonly posZ: ReadonlyNumericBuffer;
  /** Heading around +Y where 0 rad faces -Z (THREE.Object3D.rotation.y). */
  readonly yawRad: ReadonlyNumericBuffer;
  /** Signed downhill slope pitch at the ramp spawn point (Euler 'YXZ' X-rotation, < 0 downhill). */
  readonly pitchRad: ReadonlyNumericBuffer;
  readonly width: ReadonlyNumericBuffer;
  readonly length: ReadonlyNumericBuffer;
  readonly height: ReadonlyNumericBuffer;
}

export interface EntityPoolViews {
  readonly hazards: HazardPoolView;
  readonly presents: PresentPoolView;
  readonly tossedPresents: TossedPresentPoolView;
  readonly deliveryZones: DeliveryZonePoolView;
  readonly creatures: CreaturePoolView;
  readonly skiTracks: SkiTrackPoolView;
  readonly ramps: RampPoolView;
}

export interface DebugDrawView {
  readonly enabled: boolean;
  /** Number of safeX(s) world-space polyline points. */
  readonly safePathPointCount: number;
  /** Flat packed [x, y, z, ...] (length >= safePathPointCount * 3). */
  readonly safePathPoints: ReadonlyNumericBuffer;
  /** Segment ID per point so the renderer breaks strips across fork branches. */
  readonly safePathSegmentIds: ReadonlyNumericBuffer;

  /** Number of collider cylinders (hazards & creatures). */
  readonly colliderCount: number;
  /** Flat packed [x, groundY, z, ...] (length >= colliderCount * 3). */
  readonly colliderPositions: ReadonlyNumericBuffer;
  readonly colliderRadii: ReadonlyNumericBuffer;
  readonly colliderHeights: ReadonlyNumericBuffer;
  /** 0 = stumble/non-lethal, 1 = wipeout/lethal, 2 = creature. */
  readonly colliderKinds: ReadonlyNumericBuffer;

  /** Number of active delivery zone circles. */
  readonly deliveryZoneCount: number;
  /** Flat packed [x, y, z, ...] (length >= deliveryZoneCount * 3). */
  readonly deliveryPositions: ReadonlyNumericBuffer;
  readonly deliveryRadii: ReadonlyNumericBuffer;

  /** Number of visible fork V-wedge geometries. */
  readonly forkCount: number;
  /** Flat packed [x, y, z, ...] apex points. */
  readonly forkApexPositions: ReadonlyNumericBuffer;
  /** Flat packed [x, y, z, ...] left V-wedge endpoints. */
  readonly forkLeftTargets: ReadonlyNumericBuffer;
  /** Flat packed [x, y, z, ...] right V-wedge endpoints. */
  readonly forkRightTargets: ReadonlyNumericBuffer;
  readonly forkNoseRadii: ReadonlyNumericBuffer;

  /** Number of chunk boundary cross-lines. */
  readonly chunkBoundaryCount: number;
  /** Flat packed [x0, y0, z0, x1, y1, z1, ...] (length >= chunkBoundaryCount * 6). */
  readonly chunkBoundaryLines: ReadonlyNumericBuffer;

  /** Skier world position [x, y, z]. */
  readonly skierPos: ReadonlyNumericBuffer;
  /** Skier surface normal [nx, ny, nz]. */
  readonly skierNormal: ReadonlyNumericBuffer;
  /** Local downhill tangent [tx, ty, tz]. */
  readonly skierDownhill: ReadonlyNumericBuffer;
  /** Skier velocity [vx, vy, vz]. */
  readonly skierVelocity: ReadonlyNumericBuffer;
}

export interface SkierPose {
  readonly posX: number;
  readonly posY: number;
  readonly posZ: number;
  readonly velX: number;
  readonly velY: number;
  readonly velZ: number;
  /** Heading around +Y where 0 rad faces -Z (forwardXZ = (-sin(heading), 0, -cos(heading))). */
  readonly headingRad: number;
  readonly carveAngleRad: number;
  /** Signed downhill pitch around local +X (Euler 'YXZ' X-rotation, < 0 downhill). */
  readonly pitchRad: number;
  readonly speed: number;
  readonly groundY: number;
  readonly normalX: number;
  readonly normalY: number;
  readonly normalZ: number;
  readonly grounded: boolean;
  readonly braking: boolean;
}

export interface ActiveWeatherState {
  readonly profileId: string;
  readonly blizzardEnabled: boolean;
  readonly blizzardIntensity: number;
  readonly snowParticleCount: number;
  readonly windLateral: number;
  readonly fogDistanceM: number;
  readonly blizzardDim: number;
}

export interface UpcomingForkState {
  readonly active: boolean;
  readonly distanceM: number;
  readonly leftStageId: string | null;
  readonly rightStageId: string | null;
}

export interface ReadonlySimState {
  readonly tickCount: number;
  readonly elapsedSec: number;
  readonly distanceM: number;
  readonly paused: boolean;
  readonly gameMode: 'endless' | 'scoreAttack';
  readonly livesRemaining: number;
  readonly gameOver: boolean;

  readonly skierId: string;
  readonly skierState: 'skiing' | 'wipeout' | 'recovering';
  readonly prevSkier: SkierPose;
  readonly currSkier: SkierPose;
  readonly surfaceSample: ReadonlySurfaceSample;
  readonly wipeoutTimerSec: number;
  readonly wipeoutDurationSec: number;
  readonly invulnerableTimerSec: number;
  readonly invulnerableDurationSec: number;

  readonly prevCamera: CameraPose;
  readonly currCamera: CameraPose;

  readonly score: number;
  readonly highCombo: number;
  readonly comboCount: number;
  readonly comboMultiplier: number;
  readonly comboTimerSec: number;
  readonly comboDurationSec: number;
  readonly carriedCount: number;
  readonly maxCarryCapacity: number;
  /** Fixed-capacity array; valid entries occupy [0, carriedCount). */
  readonly carriedPresentDefIds: readonly string[];
  readonly deliveredTotal: number;

  readonly activeStageId: string;
  readonly activeWeather: ActiveWeatherState;
  readonly upcomingFork: UpcomingForkState;

  readonly trailWindow: TrailWindowView;
  readonly rebase: RebaseInfo;
  readonly entities: EntityPoolViews;
  readonly debugDraw: DebugDrawView;
}

export interface SimEventMap {
  PRESENT_PICKED_UP: {
    readonly presentDefId: string;
    readonly worldX: number;
    readonly worldY: number;
    readonly worldZ: number;
    readonly pickupPoints: number;
    readonly carriedCount: number;
    readonly maxCapacity: number;
  };
  PRESENT_DELIVERED: {
    readonly deliveryZoneId: string;
    readonly countDelivered: number;
    readonly pointsAwarded: number;
    readonly comboMultiplier: number;
    readonly totalScore: number;
    readonly worldX: number;
    readonly worldY: number;
    readonly worldZ: number;
  };
  PLAYER_WIPEOUT: {
    readonly hazardId: string;
    readonly effect: 'wipeout' | 'stumble';
    readonly presentsDropped: number;
    readonly worldX: number;
    readonly worldY: number;
    readonly worldZ: number;
    readonly recoverySec: number;
  };
  PLAYER_RECOVERED: {
    readonly worldX: number;
    readonly worldY: number;
    readonly worldZ: number;
    readonly invulnerableSec: number;
  };
  FORK_APPROACHING: {
    readonly segmentId: number;
    readonly distanceToSeamM: number;
    readonly leftStageId: string;
    readonly rightStageId: string;
  };
  FORK_ENTERED: {
    readonly chosenSide: 'left' | 'right';
    readonly newSegmentId: number;
    readonly newStageId: string;
    readonly previousStageId: string;
  };
  WORLD_REBASED: {
    readonly rebaseCount: number;
    readonly deltaX: number;
    readonly deltaY: number;
    readonly deltaZ: number;
    readonly totalOffsetX: number;
    readonly totalOffsetY: number;
    readonly totalOffsetZ: number;
  };
  CREATURE_TELEGRAPH: {
    readonly creatureDefId: string;
    readonly soundId: string;
    readonly worldX: number;
    readonly worldY: number;
    readonly worldZ: number;
    readonly distanceToPlayerM: number;
    readonly showEdgeIndicator: boolean;
    readonly edgeSide: 'left' | 'right' | 'center';
  };
}

export type SimEvents = SimEventMap;
