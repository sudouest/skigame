import {
  angleDelta,
  clamp,
  degToRad,
  lerp,
  lerpAngle,
  smoothstep,
  wrapAngle,
} from '../core/math';
import type { SkierDef, SurfaceType } from '../content/types';
import type {
  PlayerIntent,
  SkierPose,
  SpineForkMeta,
  SurfaceQueryView,
  SurfaceSample,
  TerrainFieldView,
} from './contracts';
import type { EntityPools, RampPool, SkiTrackPool } from './entityPools';
import { COS_MAX_CLIMBABLE_SLOPE } from './physics/joltContactSolver';
import {
  createHeightPatchNormalOut,
  createWorldMoveRequest,
  createWorldMoveResult,
  type HeightPatchNormalOut,
  type WorldContactSolver,
  type WorldMoveRequest,
  type WorldMoveResult,
} from './physics/worldContactSolver';

export const SKI_GRAVITY = 22.0;
const POINTER_STEER_GAIN = 8.0;
const MAX_CARVE_ANGLE_RAD = 0.55;
const SKI_TRACK_SAMPLE_DIST_M = 0.85;

const RESTORE_TORQUE_START_RAD = degToRad(80);
const RESTORE_TORQUE_FULL_RAD = degToRad(115);
const RESTORE_TORQUE_MAX_RAD_PER_SEC = 5.8;

const JUMP_ROCK_ATTEN_START_RAD = degToRad(36);
const JUMP_ROCK_ATTEN_END_RAD = degToRad(46);
const JUMP_SNOW_ATTEN_START_RAD = degToRad(38);
const JUMP_SNOW_ATTEN_END_RAD = degToRad(50);

const AIRBORNE_HYSTERESIS_SEC = 0.07;
const AIRBORNE_MICROHOP_CLEARANCE_M = 0.12;
const CREST_LOOKAHEAD_SEC = 0.08;
const CREST_DETACH_MIN_SPEED_MPS = 1.4;
const STICK_TO_FLOOR_STEP_DOWN_M = 0.35;
const FLOOR_SEAT_BIAS_MPS = 0.65;
const FLOOR_SAFETY_PENETRATION_M = 0.60;

const WALL_SCRAPE_SPEED_MPS = 13.0;
const WALL_CRASH_SPEED_MPS = 20.0;
const LANDING_PISTE_STUMBLE_MPS = 27.0;
const LANDING_PISTE_WIPEOUT_MPS = 36.0;
const LANDING_HARD_STUMBLE_MPS = 16.0;
const LANDING_HARD_WIPEOUT_MPS = 24.0;
const WIPEOUT_TUMBLE_MU = 0.65;

const WALK_ENTER_FWD_SPEED_MPS = 0.25;
const WALK_ENTER_MAX_BACK_SPEED_MPS = 1.2;
const WALK_ENTER_MAX_LAT_SPEED_MPS = 2.5;
const WALK_STALL_DWELL_SEC = 0.18;
const WALK_ENTER_GRAV_MARGIN_MPS2 = 0.15;
const WALK_EXIT_GRAV_ACCEL_MPS2 = 0.60;
const WALK_BASE_SPEED_MPS = 3.2;
const WALK_MIN_UPHILL_SPEED_MPS = 1.2;
const WALK_ACCEL_MPS2 = 12.0;
const WALK_COS_MAX_ROCK_SLOPE = Math.cos(degToRad(35));
const WALK_STRIDE_LENGTH_M = 1.45;
export const CHASM_TRAP_DEPTH_FRACTION = 0.5;

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
  walking: boolean;
  walkPhaseRad: number;
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
    walking: false,
    walkPhaseRad: 0,
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
  dst.walking = src.walking;
  dst.walkPhaseRad = src.walkPhaseRad;
}

export interface PhysicsStepOutcome {
  wallImpactKind: 'none' | 'wall_scrape' | 'wall_crash';
  wallImpactSpeed: number;
  landingImpactKind: 'none' | 'hard_landing_stumble' | 'hard_landing_wipeout';
  landingImpactSpeed: number;
  hitHazardIndex: number;
  hitCreatureIndex: number;
  hitStructureIndex: number;
  hitForkBumper: boolean;
  rampLaunched: boolean;
}

export function createPhysicsStepOutcome(): PhysicsStepOutcome {
  return {
    wallImpactKind: 'none',
    wallImpactSpeed: 0,
    landingImpactKind: 'none',
    landingImpactSpeed: 0,
    hitHazardIndex: -1,
    hitCreatureIndex: -1,
    hitStructureIndex: -1,
    hitForkBumper: false,
    rampLaunched: false,
  };
}

export interface PhysicsStepContext {
  readonly skierDef: SkierDef;
  readonly surfaceQuery: SurfaceQueryView;
  readonly terrain: TerrainFieldView;
  readonly pools: EntityPools;
  readonly contactSolver: WorldContactSolver;
  readonly forkBumper: SpineForkMeta | null;
  readonly surface: SurfaceSample;
  readonly ramps: RampPool;
  readonly skiTracks: SkiTrackPool;
  readonly invulnerable: boolean;
}

interface SurfaceDynamicsParams {
  muK: number;
  cAero: number;
  cPlough: number;
  maxLatEdgeAccel: number;
  carveEfficiency: number;
  grip: number;
}

/**
 * Layer A True-3D Ski Dynamics (`SkiPhysics` / `SkiDynamics`) backed by Layer B (`WorldContactSolver`).
 *
 * Guarantees:
 * - True 3D orthonormal tangent-plane basis (f_hat, r_hat perp n_hat) and exact 3D tangential gravity
 *   (-g f_y, -g r_y) with ZERO `velY = slopeVelY` vertical velocity fabrication.
 * - Hard 52 deg climbability invariant (`grounded === false` whenever `n_y < cos(52 deg)`).
 * - Strictly energy-conserving concave transitions, landing projections, and carve redirection.
 * - High-drag rock (`mu_k = 0.40`, `c_plough = 0.20`), lively snow/powder, slippery ice + `iceGrip` perk.
 * - Continuous angular restoring torque + safe local `fallLine` stall pivot (zero hard snap teleports).
 * - dt-invariant normal-away convex crest detachment toggling Jolt `StickToFloor` + airborne hysteresis.
 * - Solid 3D wipeout tumble with 3D tangential gravity, tumble friction (`mu = 0.65`), and solid obstacle deflection.
 */
export class SkiPhysics {
  private coyoteTimerSec = 0;
  private coyoteSlopeVelY = 0;
  private coyoteNormalY = 1;
  private coyoteSurfaceType: SurfaceType = 'packed';
  private activeRampIndex = -1;
  private trackAccumDist = 0;
  private wasTrackGrounded = true;
  private physicallyGrounded = true;
  private airborneTimeSec = 0;
  private lastSampleX = NaN;
  private lastSampleZ = NaN;
  private lastSampleSegId = -1;
  private lastSolverX = NaN;
  private lastSolverY = NaN;
  private lastSolverZ = NaN;
  private contactNormalX = 0;
  private contactNormalY = 1;
  private contactNormalZ = 0;
  private hasJoltContactNormal = false;
  private walkingActive = false;
  private walkStallTimerSec = 0;

  private readonly moveReq: WorldMoveRequest = createWorldMoveRequest();
  private readonly moveRes: WorldMoveResult = createWorldMoveResult();
  private readonly patchAheadScratch: HeightPatchNormalOut = createHeightPatchNormalOut();
  private readonly cliffAheadScratch: HeightPatchNormalOut = createHeightPatchNormalOut();
  private readonly surfaceParamsScratch: SurfaceDynamicsParams = {
    muK: 0.03,
    cAero: 0.0055,
    cPlough: 0.018,
    maxLatEdgeAccel: 34,
    carveEfficiency: 0.45,
    grip: 1.0,
  };

  reset(): void {
    this.coyoteTimerSec = 0;
    this.coyoteSlopeVelY = 0;
    this.coyoteNormalY = 1;
    this.coyoteSurfaceType = 'packed';
    this.activeRampIndex = -1;
    this.trackAccumDist = 0;
    this.wasTrackGrounded = true;
    this.physicallyGrounded = true;
    this.airborneTimeSec = 0;
    this.contactNormalX = 0;
    this.contactNormalY = 1;
    this.contactNormalZ = 0;
    this.hasJoltContactNormal = false;
    this.walkingActive = false;
    this.walkStallTimerSec = 0;
    this.invalidateSurfaceCache();
    this.invalidateSolverPose();
  }

  invalidateSurfaceCache(): void {
    this.lastSampleX = NaN;
    this.lastSampleZ = NaN;
    this.lastSampleSegId = -1;
  }

  invalidateSolverPose(): void {
    this.lastSolverX = NaN;
    this.lastSolverY = NaN;
    this.lastSolverZ = NaN;
  }

  syncSolverPose(posX: number, posY: number, posZ: number): void {
    this.lastSolverX = posX;
    this.lastSolverY = posY;
    this.lastSolverZ = posZ;
  }

  shiftOrigin(dx: number, dy: number, dz: number): void {
    if (!Number.isNaN(this.lastSampleX)) {
      this.lastSampleX -= dx;
      this.lastSampleZ -= dz;
    }
    if (!Number.isNaN(this.lastSolverX)) {
      this.lastSolverX -= dx;
      this.lastSolverY -= dy;
      this.lastSolverZ -= dz;
    }
  }

  stepSkiing(
    dt: number,
    intent: PlayerIntent,
    skier: MutableSkierPose,
    ctx: PhysicsStepContext,
    outcome: PhysicsStepOutcome,
  ): void {
    this.clearOutcome(outcome);
    const {
      skierDef,
      surfaceQuery,
      terrain,
      pools,
      contactSolver,
      forkBumper,
      surface,
      ramps,
      skiTracks,
    } = ctx;

    const prevPosX = skier.posX;
    const prevPosY = skier.posY;
    const prevPosZ = skier.posZ;

    // Detect external teleport (e.g. test harnesses mutating currSkier directly)
    const teleported =
      Number.isNaN(this.lastSolverX) ||
      Math.abs(skier.posX - this.lastSolverX) > 1e-4 ||
      Math.abs(skier.posY - this.lastSolverY) > 1e-4 ||
      Math.abs(skier.posZ - this.lastSolverZ) > 1e-4;

    if (teleported) {
      this.physicallyGrounded = skier.grounded;
      this.airborneTimeSec = skier.grounded ? 0 : AIRBORNE_HYSTERESIS_SEC;
      this.activeRampIndex = -1;
      this.hasJoltContactNormal = false;
      this.walkingActive = skier.walking;
      this.walkStallTimerSec = 0;
      this.invalidateSurfaceCache();
    }

    // 1. Sample surface metadata at start of step if invalidated or moved
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
      if (!this.hasJoltContactNormal) {
        this.contactNormalX = surface.normalX;
        this.contactNormalY = surface.normalY;
        this.contactNormalZ = surface.normalZ;
      }
    }

    // Defense-in-depth: clamp before Jolt step if externally forced below terrain
    const preClamped = this.enforceFloorSafetyClamp(skier, surface);

    // Sync Layer B rolling heightfield + active 50-60m obstacle/ramp/creature/bumper bubble
    contactSolver.syncWorld(
      skier.posX,
      skier.posY,
      skier.posZ,
      dt,
      terrain,
      pools,
      forkBumper,
      false,
    );

    // Use Jolt's actual supporting triangle normal when grounded (avoids smeared 1m central-diff
    // crease normals projecting horizontal speed upward into a >52 deg cliff!).
    const useJoltNormal = this.hasJoltContactNormal && (this.physicallyGrounded || this.activeRampIndex >= 0);
    let nx = useJoltNormal ? this.contactNormalX : surface.normalX;
    let ny = useJoltNormal ? this.contactNormalY : surface.normalY;
    let nz = useJoltNormal ? this.contactNormalZ : surface.normalZ;
    const nLen = Math.hypot(nx, ny, nz);
    if (nLen > 1e-5) {
      nx /= nLen;
      ny /= nLen;
      nz /= nLen;
    } else {
      nx = 0;
      ny = 1;
      nz = 0;
    }

    // Hard climbability invariant: > 52 deg surfaces are NEVER grounded
    const climbableHere = ny >= COS_MAX_CLIMBABLE_SLOPE || this.activeRampIndex >= 0;
    if (!climbableHere) {
      this.physicallyGrounded = false;
      skier.grounded = false;
      this.walkingActive = false;
      this.walkStallTimerSec = 0;
    }

    const preClearance = skier.posY - surface.groundY;
    const effectiveGrounded =
      this.physicallyGrounded ||
      (this.airborneTimeSec < AIRBORNE_HYSTERESIS_SEC &&
        preClearance < AIRBORNE_MICROHOP_CLEARANCE_M &&
        climbableHere);

    const surfaceType: SurfaceType = this.activeRampIndex >= 0 ? 'packed' : surface.surfaceType;
    const params = this.computeSurfaceDynamics(surfaceType, surface.pisteWeight, skierDef);
    const steerInput = clamp(intent.steer + intent.pointerSteerDelta * POINTER_STEER_GAIN, -1, 1);
    const braking = intent.brake && effectiveGrounded;
    skier.braking = braking;

    const rockWalkable = surfaceType !== 'rock' || ny >= WALK_COS_MAX_ROCK_SLOPE;
    const inDeepChasm =
      surface.inChasmZone &&
      surface.chasmWipeoutDepth > 0 &&
      surface.macroY - skier.posY >= surface.chasmWipeoutDepth * CHASM_TRAP_DEPTH_FRACTION;
    const canWalkHere =
      this.physicallyGrounded &&
      climbableHere &&
      this.activeRampIndex < 0 &&
      !braking &&
      rockWalkable &&
      !inDeepChasm;
    if (!canWalkHere) {
      this.walkingActive = false;
      this.walkStallTimerSec = 0;
    }

    // 2. Steering & continuous angular restoring torque (replaces hard +/-80 deg union-clamp snaps)
    const airTurnScale = effectiveGrounded ? 1.0 : 0.42;
    const gripTurnScale = 0.55 + 0.45 * clamp(params.grip, 0.25, 1.3);
    const walkGripScale = this.walkingActive ? Math.max(gripTurnScale, 0.85) : gripTurnScale;
    const turnRateRad = 2.4 * airTurnScale * walkGripScale;
    skier.headingRad = wrapAngle(skier.headingRad - steerInput * turnRateRad * dt);

    const trailYaw = Math.atan2(-surface.tangentX, -surface.tangentZ);
    const fallLineYaw = Math.atan2(-surface.fallLineX, -surface.fallLineZ);
    const deltaTrail = angleDelta(trailYaw, skier.headingRad);
    const absDeltaTrail = Math.abs(deltaTrail);

    if (!this.walkingActive && absDeltaTrail > RESTORE_TORQUE_START_RAD) {
      const safeFallWeight =
        (1 - clamp(surface.pisteWeight, 0, 1)) * (surface.inChasmZone ? 0 : 1);
      const deltaFall = angleDelta(fallLineYaw, skier.headingRad);
      const fallAlignmentSuppression =
        safeFallWeight * (1 - smoothstep(degToRad(45), degToRad(80), Math.abs(deltaFall)));
      const torqueFactor =
        smoothstep(RESTORE_TORQUE_START_RAD, RESTORE_TORQUE_FULL_RAD, absDeltaTrail) *
        (1 - fallAlignmentSuppression);

      if (torqueFactor > 1e-4) {
        const pullSign = deltaTrail > 0 ? -1 : 1;
        const maxStep = Math.min(absDeltaTrail - RESTORE_TORQUE_START_RAD, RESTORE_TORQUE_MAX_RAD_PER_SEC * torqueFactor * dt);
        if (maxStep > 0) {
          skier.headingRad = wrapAngle(skier.headingRad + pullSign * maxStep);
        }
      }
    }

    const targetCarve = this.walkingActive ? 0 : steerInput * MAX_CARVE_ANGLE_RAD;
    skier.carveAngleRad = lerp(skier.carveAngleRad, targetCarve, 1 - Math.exp(-12 * dt));

    const fwdX = -Math.sin(skier.headingRad);
    const fwdZ = -Math.cos(skier.headingRad);
    const rightX = Math.cos(skier.headingRad);
    const rightZ = -Math.sin(skier.headingRad);

    // Check if a non-climbable >52 deg cliff lies immediately ahead along travel direction
    // (guards against cliff-crease projection injecting free upward velY before Jolt collides!)
    let cliffImmediatelyAhead = false;
    if (this.physicallyGrounded && this.activeRampIndex < 0) {
      const hSpd = Math.hypot(skier.velX, skier.velZ);
      if (hSpd > 2.0) {
        const probeDist = Math.max(0.85, hSpd * dt * 1.6);
        const dirX = skier.velX / hSpd;
        const dirZ = skier.velZ / hSpd;
        const cliffAhead = contactSolver.samplePatchNormal(
          skier.posX + dirX * probeDist,
          skier.posZ + dirZ * probeDist,
          this.cliffAheadScratch,
        );
        if (
          cliffAhead.valid &&
          cliffAhead.normalY < COS_MAX_CLIMBABLE_SLOPE &&
          skier.velX * cliffAhead.normalX + skier.velZ * cliffAhead.normalZ < -1.0
        ) {
          cliffImmediatelyAhead = true;
        }
      }
    }

    // 3. Apply Layer A 3D forces (strictly in 3D tangent plane when grounded; ballistic in air)
    let didJump = false;
    let appliedRampLaunch = false;
    const wasOnRampIndex = this.activeRampIndex;
    const wasPhysicallyGrounded = this.physicallyGrounded;
    const preForceVelY = skier.velY;

    if (this.physicallyGrounded && climbableHere) {
      this.coyoteTimerSec = 0.1;
      this.coyoteNormalY = ny;
      this.coyoteSurfaceType = surfaceType;

      // Exact 3D orthonormal tangent-plane basis (f_hat, r_hat perpendicular to n_hat)
      const fDotN = fwdX * nx + fwdZ * nz;
      const rawFx = fwdX - fDotN * nx;
      const rawFy = -fDotN * ny;
      const rawFz = fwdZ - fDotN * nz;
      const fInvLen = 1 / Math.max(1e-5, Math.hypot(rawFx, rawFy, rawFz));
      const fHatX = rawFx * fInvLen;
      const fHatY = rawFy * fInvLen;
      const fHatZ = rawFz * fInvLen;

      // r_hat = f_hat x n_hat (right-handed, unit length since f_hat perp n_hat)
      const rHatX = fHatY * nz - fHatZ * ny;
      const rHatY = fHatZ * nx - fHatX * nz;
      const rHatZ = fHatX * ny - fHatY * nx;

      // Project current 3D velocity into tangent plane (strictly energy-conserving: ||v_t|| <= ||v||)
      let vFwd = skier.velX * fHatX + skier.velY * fHatY + skier.velZ * fHatZ;
      let vLat = skier.velX * rHatX + skier.velY * rHatY + skier.velZ * rHatZ;
      this.coyoteSlopeVelY = vFwd * fHatY + vLat * rHatY;

      const normalLoad = SKI_GRAVITY * ny;
      const netGravFwdAccel = -SKI_GRAVITY * fHatY - params.muK * normalLoad;
      if (this.walkingActive && netGravFwdAccel > WALK_EXIT_GRAV_ACCEL_MPS2) {
        this.walkingActive = false;
        this.walkStallTimerSec = 0;
      }

      if (!this.walkingActive) {
        // Exact 3D tangential gravity components: g . f_hat = -g * fHatY, g . r_hat = -g * rHatY
        vFwd += -SKI_GRAVITY * fHatY * dt;
        vLat += -SKI_GRAVITY * rHatY * dt;

        // Zero-uphill poling start assist (yields when flat/uphill gravity cannot overcome friction)
        if (
          vFwd < 6.0 &&
          vFwd >= -0.5 &&
          !braking &&
          surfaceType !== 'rock' &&
          fHatY < 0.02 &&
          netGravFwdAccel > WALK_ENTER_GRAV_MARGIN_MPS2
        ) {
          const assistScale = 1 - smoothstep(-0.08, 0.02, fHatY);
          vFwd = Math.min(6.0, vFwd + 6.5 * assistScale * dt);
        }

        // Anisotropic edge-bite saturation + strictly energy-conserving carve redirection
        // (vFwd_new^2 + vLat_new^2 <= vFwd^2 + vLat^2 ALWAYS)
        const lateralDamp = Math.exp(-9.5 * params.grip * dt);
        const desiredLatDelta = vLat * (lateralDamp - 1);
        const maxLatImpulse = params.maxLatEdgeAccel * (0.45 + 0.55 * ny) * dt;
        const latDelta = clamp(desiredLatDelta, -maxLatImpulse, maxLatImpulse);
        const vLatNew = vLat + latDelta;
        const latEnergyRemoved = vLat * vLat - vLatNew * vLatNew;
        vLat = vLatNew;

        if (
          latEnergyRemoved > 0 &&
          vFwd >= 0 &&
          !braking &&
          params.carveEfficiency > 0 &&
          fHatY <= 0.02
        ) {
          vFwd = Math.sqrt(vFwd * vFwd + params.carveEfficiency * latEnergyRemoved);
        }

        // Snowplow braking (never boosts speed uphill or from slow speeds)
        if (braking) {
          if (vFwd > 4.5 && fHatY <= 0.05) {
            vFwd = Math.max(4.5, vFwd - 18.0 * dt);
          } else if (vFwd > 0) {
            vFwd = Math.max(0, vFwd - 18.0 * dt);
          } else if (vFwd < 0) {
            vFwd = Math.min(0, vFwd + 18.0 * dt);
          }
          vLat *= Math.exp(-6.0 * dt);
        }

        // Signed Coulomb + viscous plough + aerodynamic drag (strictly dissipative)
        const speedT = Math.hypot(vFwd, vLat);
        const fwdDragDecel =
          (params.muK * normalLoad + params.cPlough * Math.abs(vFwd) + params.cAero * speedT * Math.abs(vFwd)) *
          dt;
        if (vFwd > 0) {
          vFwd = Math.max(0, vFwd - fwdDragDecel);
        } else if (vFwd < 0) {
          vFwd = Math.min(0, vFwd + fwdDragDecel);
        }

        const latDragDecel = (params.muK * normalLoad * 0.65 + params.cPlough * 0.5 * Math.abs(vLat)) * dt;
        if (vLat > 0) {
          vLat = Math.max(0, vLat - latDragDecel);
        } else if (vLat < 0) {
          vLat = Math.min(0, vLat + latDragDecel);
        }

        // Soft aerodynamic top-speed governor around skierDef.stats.maxSpeed
        if (vFwd > skierDef.stats.maxSpeed) {
          const excess = vFwd - skierDef.stats.maxSpeed;
          vFwd -= excess * (1 - Math.exp(-2.8 * dt));
        }

        // Enter walking fallback once momentum & gravity cannot sustain forward skiing
        const stalledWithoutGravity =
          canWalkHere &&
          vFwd <= WALK_ENTER_FWD_SPEED_MPS &&
          vFwd >= -WALK_ENTER_MAX_BACK_SPEED_MPS &&
          Math.abs(vLat) <= WALK_ENTER_MAX_LAT_SPEED_MPS &&
          netGravFwdAccel <= WALK_ENTER_GRAV_MARGIN_MPS2;
        if (stalledWithoutGravity) {
          this.walkStallTimerSec += dt;
          if (this.walkStallTimerSec >= WALK_STALL_DWELL_SEC) {
            this.walkingActive = true;
            this.walkStallTimerSec = 0;
          }
        } else {
          this.walkStallTimerSec = 0;
        }
      }

      if (this.walkingActive) {
        const uphillFactor = clamp(fHatY, 0, 0.78);
        const slopeScale = lerp(
          1.0,
          WALK_MIN_UPHILL_SPEED_MPS / WALK_BASE_SPEED_MPS,
          smoothstep(0.05, 0.65, uphillFactor),
        );
        const rockScale = surfaceType === 'rock' ? 0.75 : 1.0;
        const targetWalkSpeed = WALK_BASE_SPEED_MPS * slopeScale * rockScale;
        const maxDelta = WALK_ACCEL_MPS2 * dt;
        if (vFwd < targetWalkSpeed) {
          vFwd = Math.min(targetWalkSpeed, Math.max(0, vFwd) + maxDelta);
        } else {
          vFwd = Math.max(targetWalkSpeed, vFwd - maxDelta);
        }
        vLat *= Math.exp(-16.0 * dt);
      }

      // Reconstruct exact 3D tangent velocity (NO velY = slopeVelY overwrite!)
      skier.velX = fHatX * vFwd + rHatX * vLat;
      skier.velY = fHatY * vFwd + rHatY * vLat;
      skier.velZ = fHatZ * vFwd + rHatZ * vLat;

      // Never allow cliff-crease normal projection to launch horizontal speed upward into a >52 deg cliff!
      if (cliffImmediatelyAhead && skier.velY > Math.max(0, preForceVelY)) {
        const preSpd = Math.hypot(skier.velX, skier.velY, skier.velZ);
        skier.velY = Math.max(0, preForceVelY);
        const curH = Math.hypot(skier.velX, skier.velZ);
        const targetH = Math.sqrt(Math.max(0, preSpd * preSpd - skier.velY * skier.velY));
        if (curH > 1e-4 && targetH > 0) {
          const hs = targetH / curH;
          skier.velX *= hs;
          skier.velZ *= hs;
        }
      }

      // Safe local fall-line stall pivot when stalling nose-up (disabled while walking or about to walk, in chasms, or steering)
      if (
        !this.walkingActive &&
        this.walkStallTimerSec <= 0 &&
        vFwd < 1.5 &&
        fHatY > 0.05 &&
        !surface.inChasmZone &&
        Math.abs(steerInput) <= 0.2
      ) {
        skier.headingRad = lerpAngle(skier.headingRad, fallLineYaw, 1 - Math.exp(-3.2 * dt));
      }
    } else {
      this.walkingActive = false;
      this.walkStallTimerSec = 0;
      this.coyoteTimerSec = Math.max(0, this.coyoteTimerSec - dt);
      // True 3D ballistic airtime with physical quadratic aerodynamic drag (bounds deep chasm freefall!)
      skier.velY -= SKI_GRAVITY * dt;
      const airSpd = Math.hypot(skier.velX, skier.velY, skier.velZ);
      const airDragFactor = Math.exp(-(0.04 + 0.0055 * airSpd) * dt);
      skier.velX *= airDragFactor;
      skier.velY *= airDragFactor;
      skier.velZ *= airDragFactor;
    }

    // 4. Jump impulse (gated/attenuated on rock & >38 deg slopes; saturated on high-speed ramps)
    const canJump = this.physicallyGrounded || this.coyoteTimerSec > 0;
    if (intent.jumpPressed && canJump) {
      const jumpNy = this.physicallyGrounded ? ny : this.coyoteNormalY;
      const jumpSurfaceType = this.physicallyGrounded ? surfaceType : this.coyoteSurfaceType;
      const jumpScale = this.computeJumpScale(jumpSurfaceType, jumpNy, this.activeRampIndex >= 0);

      if (jumpScale > 0.05) {
        const preSpeed3d = Math.hypot(skier.velX, skier.velY, skier.velZ);
        const onRamp = this.activeRampIndex >= 0;
        const rampBonus = onRamp
          ? lerp(2.2, 0.0, smoothstep(22, 32, preSpeed3d))
          : 0;
        const impulse = (skierDef.stats.jumpImpulse + rampBonus) * jumpScale;

        if (onRamp) {
          // Saturate high-speed ramp + jump combined upward velocity so icy-black kickers reward cleanly
          const maxUpBoost = lerp(11.5, 7.5, smoothstep(24, 34, preSpeed3d));
          const cappedImpulse = Math.min(impulse, maxUpBoost);
          skier.velY += cappedImpulse;
        } else if (skier.velY <= 0) {
          // Downhill or flat: preserve coyote-time vertical jump base (clears boulder_small 0.72m!)
          const baseY = this.physicallyGrounded
            ? skier.velY
            : Math.max(skier.velY, this.coyoteSlopeVelY);
          skier.velY = baseY + impulse;
        } else {
          // Moving uphill: cap upward velocity so jumping uphill never stacks climb height
          skier.velY = Math.max(skier.velY, impulse);
        }

        didJump = true;
        this.physicallyGrounded = false;
        this.airborneTimeSec = AIRBORNE_HYSTERESIS_SEC;
        this.coyoteTimerSec = 0;
        this.activeRampIndex = -1;
        this.walkingActive = false;
        this.walkStallTimerSec = 0;
      }
    }

    // 5. dt-invariant convex crest detachment & ramp lip check -> control Jolt StickToFloor!
    let stickStepDownM = 0;
    let pendingLipLaunchRampIdx = -1;

    if (!didJump && this.physicallyGrounded && !cliffImmediatelyAhead) {
      if (this.activeRampIndex >= 0) {
        // Check if moving past the ramp's forward lip this step -> release StickToFloor for clean lip launch
        const rIdx = this.activeRampIndex;
        if (rIdx < ramps.count && this.isExitingRampLip(skier, dt, ramps, rIdx)) {
          pendingLipLaunchRampIdx = rIdx;
          stickStepDownM = 0;
        } else {
          stickStepDownM = STICK_TO_FLOOR_STEP_DOWN_M;
        }
      } else {
        // dt-invariant normal-away crest detachment using O(1) cached heightfield patch normal
        const aheadX = skier.posX + skier.velX * CREST_LOOKAHEAD_SEC;
        const aheadZ = skier.posZ + skier.velZ * CREST_LOOKAHEAD_SEC;
        const ahead = contactSolver.samplePatchNormal(aheadX, aheadZ, this.patchAheadScratch);
        let detaching = false;

        if (ahead.valid) {
          const vDotNAhead =
            skier.velX * ahead.normalX +
            skier.velY * ahead.normalY +
            skier.velZ * ahead.normalZ;
          const detachThreshold = Math.max(
            CREST_DETACH_MIN_SPEED_MPS,
            SKI_GRAVITY * Math.max(0.45, ahead.normalY) * CREST_LOOKAHEAD_SEC,
          );
          if (ahead.normalY < COS_MAX_CLIMBABLE_SLOPE || vDotNAhead > detachThreshold) {
            detaching = true;
          }
        }
        stickStepDownM = detaching ? 0 : STICK_TO_FLOOR_STEP_DOWN_M;
      }
    }

    // 6. Execute Layer B Jolt CharacterVirtual swept contact step
    const preStepVelX = skier.velX;
    const preStepVelY = skier.velY;
    const preStepVelZ = skier.velZ;
    const preStepSpeed = Math.hypot(preStepVelX, preStepVelY, preStepVelZ);

    const req = this.moveReq;
    req.dt = dt;
    req.posX = skier.posX;
    req.posY = skier.posY;
    req.posZ = skier.posZ;
    req.velX = skier.velX;
    req.velY = skier.velY;
    req.velZ = skier.velZ;
    req.gravityY = -SKI_GRAVITY;
    req.stickToFloorStepDownM = stickStepDownM;
    req.seatBiasMps = stickStepDownM > 0 && this.activeRampIndex < 0 ? FLOOR_SEAT_BIAS_MPS : 0;
    req.seatNormalX = nx;
    req.seatNormalY = ny;
    req.seatNormalZ = nz;
    req.collideHazards = true;
    req.collideCreatures = true;
    req.isWipeoutTumble = false;
    req.syncPositionFirst = teleported || preClamped;

    const res = this.moveRes;
    contactSolver.stepCharacter(req, res);

    skier.posX = res.posX;
    skier.posY = res.posY;
    skier.posZ = res.posZ;
    skier.velX = res.velX;
    skier.velY = res.velY;
    skier.velZ = res.velZ;

    // 7. Re-sample terrain metadata at post-step world XZ
    surfaceQuery.sampleSurface(
      skier.posX,
      skier.posZ,
      surface.segmentId,
      surface.s,
      surface,
    );

    // Defense-in-depth floor safety clamp: recover immediately if capsule ever dropped >0.60m below groundY
    if (this.enforceFloorSafetyClamp(skier, surface)) {
      contactSolver.teleportCharacter(
        skier.posX,
        skier.posY,
        skier.posZ,
        skier.velX,
        skier.velY,
        skier.velZ,
      );
      if (surface.normalY >= COS_MAX_CLIMBABLE_SLOPE) {
        res.isSupported = true;
        res.groundNormalX = surface.normalX;
        res.groundNormalY = surface.normalY;
        res.groundNormalZ = surface.normalZ;
        res.groundKind = 'terrain';
        res.groundPoolIndex = -1;
      }
    }

    // 8. Process Jolt swept contacts (hazards, creatures, structures, fork V-wedge bumper, >52 deg wall impacts)
    for (let i = 0; i < res.contactCount; i++) {
      const c = res.contacts[i]!;
      if (c.kind === 'hazard' && outcome.hitHazardIndex < 0 && c.poolIndex >= 0) {
        outcome.hitHazardIndex = c.poolIndex;
      } else if (c.kind === 'creature' && outcome.hitCreatureIndex < 0 && c.poolIndex >= 0) {
        outcome.hitCreatureIndex = c.poolIndex;
      } else if (c.kind === 'structure' && outcome.hitStructureIndex < 0 && c.poolIndex >= 0) {
        outcome.hitStructureIndex = c.poolIndex;
      } else if (c.kind === 'forkBumper') {
        outcome.hitForkBumper = true;
      }
    }
    if (
      outcome.hitStructureIndex < 0 &&
      res.groundKind === 'structure' &&
      res.groundPoolIndex >= 0
    ) {
      outcome.hitStructureIndex = res.groundPoolIndex;
    }

    // Soft fork V-wedge branch nudge & fallback push if teleported inside nose cylinder
    if (forkBumper && forkBumper.hasFork) {
      this.applyForkBumperNudge(
        skier,
        surface,
        forkBumper,
        surfaceQuery,
        skierDef.stats.collisionRadius,
        outcome.hitForkBumper,
        contactSolver,
      );
    }

    // 9. Enforce energy conservation & anti-climb on steep (> 52 deg) wall deflections
    const postSpeed = Math.hypot(skier.velX, skier.velY, skier.velZ);
    if (!didJump && res.wallHit) {
      // Strictly prevent climbing steep cliffs or gaining upward KE from wall impact
      const maxAllowedUpY = Math.max(0, preStepVelY);
      if (skier.velY > maxAllowedUpY) {
        skier.velY = maxAllowedUpY;
      }
      // Wall scrape friction bleed proportional to impact closing speed (never dock 4% on 0 m/s grazes!)
      const scrapeRetain =
        res.wallImpactSpeed > 0.25 ? clamp(1 - 0.025 * res.wallImpactSpeed, 0.45, 0.995) : 1.0;
      const curSpd = Math.hypot(skier.velX, skier.velY, skier.velZ);
      const maxAllowedSpd = preStepSpeed * scrapeRetain;
      if (curSpd > maxAllowedSpd && curSpd > 1e-5) {
        const s = maxAllowedSpd / curSpd;
        skier.velX *= s;
        skier.velY *= s;
        skier.velZ *= s;
      }

      if (!ctx.invulnerable) {
        if (res.wallImpactSpeed >= WALL_CRASH_SPEED_MPS) {
          outcome.wallImpactKind = 'wall_crash';
          outcome.wallImpactSpeed = res.wallImpactSpeed;
        } else if (res.wallImpactSpeed >= WALL_SCRAPE_SPEED_MPS) {
          outcome.wallImpactKind = 'wall_scrape';
          outcome.wallImpactSpeed = res.wallImpactSpeed;
        }
      }
    } else if (!didJump && res.isSupported && postSpeed > preStepSpeed + 0.05 && preStepSpeed > 1e-4) {
      // Strictly energy-conserving concave transition / landing projection (||v+|| <= ||v-||)
      const s = preStepSpeed / postSpeed;
      skier.velX *= s;
      skier.velY *= s;
      skier.velZ *= s;
    }

    // 10. Resolve grounded state, ramp deck latching, directional ramp lip launch & landing severity
    let nowSupported = res.isSupported && !didJump;
    if (nowSupported && res.groundKind === 'terrain' && surface.normalY < COS_MAX_CLIMBABLE_SLOPE) {
      nowSupported = false;
    }

    // Check directional ramp lip launch (either detected pre-step or exited ramp deck this step)
    const exitedRampIdx =
      pendingLipLaunchRampIdx >= 0
        ? pendingLipLaunchRampIdx
        : wasOnRampIndex >= 0 && (!nowSupported || res.groundKind !== 'ramp') && !didJump
          ? wasOnRampIndex
          : -1;

    if (exitedRampIdx >= 0 && exitedRampIdx < ramps.count) {
      if (this.tryApplyRampLipLaunch(skier, dt, ramps, exitedRampIdx, contactSolver)) {
        appliedRampLaunch = true;
        nowSupported = false;
        this.activeRampIndex = -1;
        this.airborneTimeSec = AIRBORNE_HYSTERESIS_SEC;
        outcome.rampLaunched = true;
      }
    }

    if (nowSupported) {
      // Check surface-split landing severity when returning from real airtime
      if (!wasPhysicallyGrounded && this.airborneTimeSec >= 0.1) {
        const landNx = res.groundNormalX;
        const landNy = res.groundNormalY;
        const landNz = res.groundNormalZ;
        const normalImpact = Math.max(
          0,
          -(preStepVelX * landNx + preStepVelY * landNy + preStepVelZ * landNz),
        );
        const onSoftSnow =
          res.groundKind === 'ramp' || (surface.onPiste && surface.surfaceType !== 'rock');
        const stumbleThresh = onSoftSnow ? LANDING_PISTE_STUMBLE_MPS : LANDING_HARD_STUMBLE_MPS;
        const wipeoutThresh = onSoftSnow ? LANDING_PISTE_WIPEOUT_MPS : LANDING_HARD_WIPEOUT_MPS;

        if (!ctx.invulnerable) {
          if (normalImpact >= wipeoutThresh) {
            outcome.landingImpactKind = 'hard_landing_wipeout';
            outcome.landingImpactSpeed = normalImpact;
          } else if (normalImpact >= stumbleThresh) {
            outcome.landingImpactKind = 'hard_landing_stumble';
            outcome.landingImpactSpeed = normalImpact;
          }
        }
      }

      this.physicallyGrounded = true;
      this.airborneTimeSec = 0;
      this.contactNormalX = res.groundNormalX;
      this.contactNormalY = res.groundNormalY;
      this.contactNormalZ = res.groundNormalZ;
      this.hasJoltContactNormal = true;
      this.activeRampIndex = res.groundKind === 'ramp' ? res.groundPoolIndex : -1;
    } else {
      this.physicallyGrounded = false;
      this.hasJoltContactNormal = false;
      this.activeRampIndex = -1;
      this.walkingActive = false;
      this.walkStallTimerSec = 0;
      if (!didJump && !appliedRampLaunch) {
        this.airborneTimeSec += dt;
      }
    }

    // Airborne hysteresis prevents <0.07s & <0.12m terrain micro-hops from flickering tracks/stance
    const postClearance = skier.posY - surface.groundY;
    const displayGrounded =
      this.physicallyGrounded ||
      (!didJump &&
        !appliedRampLaunch &&
        this.airborneTimeSec < AIRBORNE_HYSTERESIS_SEC &&
        postClearance < AIRBORNE_MICROHOP_CLEARANCE_M &&
        surface.normalY >= COS_MAX_CLIMBABLE_SLOPE);
    skier.grounded = displayGrounded;
    skier.walking = this.walkingActive;

    const stepDist3d = Math.hypot(
      skier.posX - prevPosX,
      skier.posY - prevPosY,
      skier.posZ - prevPosZ,
    );
    if (skier.walking && stepDist3d > 1e-4) {
      skier.walkPhaseRad += (stepDist3d / WALK_STRIDE_LENGTH_M) * Math.PI * 2;
    }

    // Update cached sample & solver pose for teleport detection next tick
    this.lastSampleX = skier.posX;
    this.lastSampleZ = skier.posZ;
    this.lastSampleSegId = surface.segmentId;
    this.syncSolverPose(skier.posX, skier.posY, skier.posZ);

    // 11. Populate pose metadata
    skier.groundY = surface.groundY;
    skier.normalX = this.activeRampIndex >= 0 ? this.contactNormalX : surface.normalX;
    skier.normalY = this.activeRampIndex >= 0 ? this.contactNormalY : surface.normalY;
    skier.normalZ = this.activeRampIndex >= 0 ? this.contactNormalZ : surface.normalZ;
    skier.speed = Math.hypot(skier.velX, skier.velY, skier.velZ);

    const horizSpeed = Math.max(0.5, Math.hypot(skier.velX, skier.velZ));
    if (skier.grounded) {
      const poseNx = skier.normalX;
      const poseNy = Math.max(0.35, skier.normalY);
      const poseNz = skier.normalZ;
      const fy = -(fwdX * poseNx + fwdZ * poseNz) / poseNy;
      skier.pitchRad = clamp(Math.atan2(fy, 1), -0.85, 0.65);
    } else {
      skier.pitchRad = clamp(Math.atan2(skier.velY, horizSpeed), -0.7, 0.65);
    }

    // 12. Update ski track ribbon ring buffer (PRESERVING M2 cross-slope rightY tangent projection!)
    const stepDist = Math.hypot(skier.posX - prevPosX, skier.posZ - prevPosZ);
    const trackNx = surface.normalX;
    const trackNy = surface.normalY;
    const trackNz = surface.normalZ;
    const rawTrackRightY = -(rightX * trackNx + rightZ * trackNz) / Math.max(0.35, trackNy);
    const trackRightLen = Math.hypot(rightX, rawTrackRightY, rightZ) || 1;
    const trackRightX = rightX / trackRightLen;
    const trackRightY = rawTrackRightY / trackRightLen;
    const trackRightZ = rightZ / trackRightLen;

    const trackGroundedNow =
      skier.grounded && !skier.walking && this.activeRampIndex < 0 && res.groundKind !== 'structure';
    if (trackGroundedNow) {
      this.trackAccumDist += stepDist;
      if (!this.wasTrackGrounded || this.trackAccumDist >= SKI_TRACK_SAMPLE_DIST_M) {
        this.trackAccumDist = 0;
        skiTracks.pushSample(
          skier.posX,
          surface.groundY + 0.03,
          skier.posZ,
          trackNx,
          trackNy,
          trackNz,
          trackRightX,
          trackRightY,
          trackRightZ,
          true,
        );
      }
    } else if (this.wasTrackGrounded) {
      // Break ski track ribbon cleanly on takeoff
      skiTracks.pushSample(
        prevPosX,
        surface.groundY + 0.03,
        prevPosZ,
        trackNx,
        trackNy,
        trackNz,
        trackRightX,
        trackRightY,
        trackRightZ,
        false,
      );
      this.trackAccumDist = 0;
    }
    this.wasTrackGrounded = trackGroundedNow;
  }

  /**
   * Solid 3D wipeout tumble step:
   * - Steps through Jolt `CharacterVirtual` with solid terrain, boulders, trees, ramps & walls.
   * - Applies 3D tangential gravity + isotropic tumble friction (mu = 0.65) when grounded,
   *   or ballistic gravity when airborne (e.g. falling into a chasm).
   * - Tumbling skiers slide downhill and physically deflect off walls/boulders/trees instead of
   *   sliding uphill or ghosting.
   */
  stepWipeout(
    dt: number,
    skier: MutableSkierPose,
    ctx: PhysicsStepContext,
  ): void {
    const { surfaceQuery, terrain, pools, contactSolver, forkBumper, surface } = ctx;

    const teleported =
      Number.isNaN(this.lastSolverX) ||
      Math.abs(skier.posX - this.lastSolverX) > 1e-4 ||
      Math.abs(skier.posY - this.lastSolverY) > 1e-4 ||
      Math.abs(skier.posZ - this.lastSolverZ) > 1e-4;

    if (teleported) {
      this.physicallyGrounded = skier.grounded;
      this.invalidateSurfaceCache();
    }

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

    const preClamped = this.enforceFloorSafetyClamp(skier, surface);

    contactSolver.syncWorld(
      skier.posX,
      skier.posY,
      skier.posZ,
      dt,
      terrain,
      pools,
      forkBumper,
      false,
    );

    const nx = surface.normalX;
    const ny = surface.normalY;
    const nz = surface.normalZ;
    const airborne = !this.physicallyGrounded || skier.posY > surface.groundY + 0.15;

    if (!airborne && ny >= COS_MAX_CLIMBABLE_SLOPE) {
      // Exact 3D tangential gravity: g_t = g - (g . n) n
      const gx = SKI_GRAVITY * ny * nx;
      const gy = -SKI_GRAVITY * (1 - ny * ny);
      const gz = SKI_GRAVITY * ny * nz;

      let vx = skier.velX + gx * dt;
      let vy = skier.velY + gy * dt;
      let vz = skier.velZ + gz * dt;

      // Project onto tangent plane
      const vDotN = vx * nx + vy * ny + vz * nz;
      vx -= vDotN * nx;
      vy -= vDotN * ny;
      vz -= vDotN * nz;

      // High isotropic tumble friction (mu = 0.65) + snow viscous damping
      const speed = Math.hypot(vx, vy, vz);
      const decel = (WIPEOUT_TUMBLE_MU * SKI_GRAVITY * ny + 2.2 * speed) * dt;
      if (speed > 1e-5) {
        const newSpeed = Math.max(0, speed - decel);
        const scale = newSpeed / speed;
        vx *= scale;
        vy *= scale;
        vz *= scale;
      } else {
        vx = 0;
        vy = 0;
        vz = 0;
      }

      skier.velX = vx;
      skier.velY = vy;
      skier.velZ = vz;
    } else {
      // Ballistic tumble fall (e.g. chasm drop or airborne knockback)
      skier.velY -= SKI_GRAVITY * dt;
      const damp = Math.exp(-0.25 * dt);
      skier.velX *= damp;
      skier.velZ *= damp;
    }

    const req = this.moveReq;
    req.dt = dt;
    req.posX = skier.posX;
    req.posY = skier.posY;
    req.posZ = skier.posZ;
    req.velX = skier.velX;
    req.velY = skier.velY;
    req.velZ = skier.velZ;
    req.gravityY = -SKI_GRAVITY;
    req.stickToFloorStepDownM = airborne ? 0 : 0.25;
    req.seatBiasMps = 0;
    req.collideHazards = true;
    req.collideCreatures = true;
    req.isWipeoutTumble = true;
    req.syncPositionFirst = teleported || preClamped;

    const res = this.moveRes;
    contactSolver.stepCharacter(req, res);

    skier.posX = res.posX;
    skier.posY = res.posY;
    skier.posZ = res.posZ;
    skier.velX = res.velX;
    skier.velY = res.velY;
    skier.velZ = res.velZ;
    this.physicallyGrounded = res.isSupported && res.groundNormalY >= COS_MAX_CLIMBABLE_SLOPE;
    skier.grounded = this.physicallyGrounded;
    skier.braking = false;
    this.walkingActive = false;
    this.walkStallTimerSec = 0;
    skier.walking = false;

    // Damp bounce slightly on obstacle/wall tumble deflection
    if (res.wallHit || res.contactCount > 0) {
      const bleed = 0.82;
      skier.velX *= bleed;
      skier.velY = Math.min(skier.velY, 0);
      skier.velZ *= bleed;
    }

    surfaceQuery.sampleSurface(
      skier.posX,
      skier.posZ,
      surface.segmentId,
      surface.s,
      surface,
    );
    if (this.enforceFloorSafetyClamp(skier, surface)) {
      contactSolver.teleportCharacter(
        skier.posX,
        skier.posY,
        skier.posZ,
        skier.velX,
        skier.velY,
        skier.velZ,
      );
      if (surface.normalY >= COS_MAX_CLIMBABLE_SLOPE) {
        this.physicallyGrounded = true;
        skier.grounded = true;
      }
    }
    skier.groundY = surface.groundY;
    skier.normalX = surface.normalX;
    skier.normalY = surface.normalY;
    skier.normalZ = surface.normalZ;
    skier.speed = Math.hypot(skier.velX, skier.velY, skier.velZ);

    this.lastSampleX = skier.posX;
    this.lastSampleZ = skier.posZ;
    this.lastSampleSegId = surface.segmentId;
    this.syncSolverPose(skier.posX, skier.posY, skier.posZ);
  }

  private enforceFloorSafetyClamp(
    skier: MutableSkierPose,
    surface: SurfaceSample,
  ): boolean {
    if (!surface.valid || skier.posY >= surface.groundY - FLOOR_SAFETY_PENETRATION_M) {
      return false;
    }
    skier.posY = surface.groundY;
    const nx = surface.normalX;
    const ny = surface.normalY;
    const nz = surface.normalZ;
    const nLenSq = nx * nx + ny * ny + nz * nz;
    const vDotN = skier.velX * nx + skier.velY * ny + skier.velZ * nz;
    if (vDotN < 0 && nLenSq > 1e-6) {
      const s = vDotN / nLenSq;
      skier.velX -= s * nx;
      skier.velY -= s * ny;
      skier.velZ -= s * nz;
    }
    return true;
  }

  private clearOutcome(out: PhysicsStepOutcome): void {
    out.wallImpactKind = 'none';
    out.wallImpactSpeed = 0;
    out.landingImpactKind = 'none';
    out.landingImpactSpeed = 0;
    out.hitHazardIndex = -1;
    out.hitCreatureIndex = -1;
    out.hitStructureIndex = -1;
    out.hitForkBumper = false;
    out.rampLaunched = false;
  }

  private computeSurfaceDynamics(
    surfaceType: SurfaceType,
    pisteWeight: number,
    skierDef: SkierDef,
  ): SurfaceDynamicsParams {
    const out = this.surfaceParamsScratch;
    const offPiste = 1 - clamp(pisteWeight, 0, 1);
    const carveMult = skierDef.stats.carveGrip;

    switch (surfaceType) {
      case 'packed':
        out.muK = 0.03 + 0.045 * offPiste;
        out.cAero = 0.0055;
        out.cPlough = 0.018 + 0.045 * offPiste;
        out.grip = 1.0 * carveMult;
        out.maxLatEdgeAccel = 34.0 * out.grip;
        out.carveEfficiency = clamp(0.45 * out.grip, 0, 0.55);
        break;
      case 'powder':
        out.muK = 0.048 + 0.04 * offPiste;
        out.cAero = 0.0072;
        out.cPlough = 0.055 + 0.04 * offPiste;
        out.grip = 0.72 * carveMult;
        out.maxLatEdgeAccel = 24.0 * out.grip;
        out.carveEfficiency = clamp(0.35 * out.grip, 0, 0.45);
        break;
      case 'ice': {
        const icePerk = skierDef.perk?.type === 'iceGrip' ? skierDef.perk.value : 1.0;
        out.muK = 0.018 + 0.04 * offPiste;
        out.cAero = 0.0046;
        out.cPlough = 0.008 + 0.03 * offPiste;
        out.grip = 0.25 * icePerk * carveMult;
        out.maxLatEdgeAccel = 14.0 * out.grip;
        out.carveEfficiency = clamp(0.25 * out.grip, 0, 0.4);
        break;
      }
      case 'rock':
        // High rock drag with NO off-piste skip — prevents frictionless rock wall climbing
        out.muK = 0.40;
        out.cAero = 0.012;
        out.cPlough = 0.20;
        out.grip = 0.15 * carveMult;
        out.maxLatEdgeAccel = 10.0 * out.grip;
        out.carveEfficiency = 0;
        break;
      default: {
        const _exhaustive: never = surfaceType;
        throw new Error(`Unhandled surface type: ${String(_exhaustive)}`);
      }
    }
    return out;
  }

  private computeJumpScale(surfaceType: SurfaceType, normalY: number, onRamp: boolean): number {
    if (onRamp) return 1.0;
    const slopeRad = Math.acos(clamp(normalY, -1, 1));
    if (surfaceType === 'rock') {
      return 0.25 * (1 - smoothstep(JUMP_ROCK_ATTEN_START_RAD, JUMP_ROCK_ATTEN_END_RAD, slopeRad));
    }
    return lerp(1.0, 0.2, smoothstep(JUMP_SNOW_ATTEN_START_RAD, JUMP_SNOW_ATTEN_END_RAD, slopeRad));
  }

  private isExitingRampLip(
    skier: MutableSkierPose,
    dt: number,
    ramps: RampPool,
    rampIdx: number,
  ): boolean {
    const yaw = ramps.yawRad[rampIdx]!;
    const fwdX = -Math.sin(yaw);
    const fwdZ = -Math.cos(yaw);
    const vAlong = skier.velX * fwdX + skier.velZ * fwdZ;
    if (vAlong < 3.0) return false;

    const dx = skier.posX + skier.velX * dt - ramps.posX[rampIdx]!;
    const dz = skier.posZ + skier.velZ * dt - ramps.posZ[rampIdx]!;
    const longDist = dx * fwdX + dz * fwdZ;
    const rampPitch = ramps.pitchRad[rampIdx]!;
    const rampHeight = ramps.height[rampIdx]!;
    const halfLen = ramps.length[rampIdx]! * 0.5;
    const pitchedHalfLen = halfLen * Math.cos(rampPitch) - rampHeight * Math.sin(rampPitch);
    return longDist >= pitchedHalfLen - 0.15;
  }

  private tryApplyRampLipLaunch(
    skier: MutableSkierPose,
    dt: number,
    ramps: RampPool,
    rampIdx: number,
    contactSolver: WorldContactSolver,
  ): boolean {
    const yaw = ramps.yawRad[rampIdx]!;
    const fwdX = -Math.sin(yaw);
    const fwdZ = -Math.cos(yaw);
    const rightX = Math.cos(yaw);
    const rightZ = -Math.sin(yaw);

    // Directional check: only fire lip launch when riding forward off the front kicker lip
    const vAlong = skier.velX * fwdX + skier.velZ * fwdZ;
    if (vAlong < 3.0) return false;

    const dx = skier.posX - ramps.posX[rampIdx]!;
    const dz = skier.posZ - ramps.posZ[rampIdx]!;
    const longDist = dx * fwdX + dz * fwdZ;
    const latDist = Math.abs(dx * rightX + dz * rightZ);
    const rampPitch = ramps.pitchRad[rampIdx]!;
    const rampHeight = ramps.height[rampIdx]!;
    const halfLen = ramps.length[rampIdx]! * 0.5;
    const halfWid = ramps.width[rampIdx]! * 0.5;
    const pitchedHalfLen = halfLen * Math.cos(rampPitch) - rampHeight * Math.sin(rampPitch);
    if (longDist < pitchedHalfLen * 0.65 || latDist > halfWid + 0.45) {
      return false;
    }

    const rawBoostDeg = ramps.lipPitchBoostDeg[rampIdx]!;
    const speed3d = Math.hypot(skier.velX, skier.velY, skier.velZ);

    // Smoothly saturate ramp-lip boost proportionally above 24 m/s while staying above each
    // ramp's own geometric wedge slope so gentle/standard/steep kickers preserve distinct airtime.
    const geometricDeckDeg =
      (Math.atan2(Math.max(0, rampHeight), Math.max(1e-4, ramps.length[rampIdx]!)) * 180) /
      Math.PI;
    const highSpeedFloorDeg = Math.min(rawBoostDeg, geometricDeckDeg + 0.75);
    const highSpeedBoostDeg = clamp(rawBoostDeg * (2 / 3), highSpeedFloorDeg, rawBoostDeg);
    const satBoostDeg = lerp(rawBoostDeg, highSpeedBoostDeg, smoothstep(24, 34, speed3d));
    const launchPitch = clamp(rampPitch + degToRad(satBoostDeg), -0.45, 0.55);

    const launchSpeed = Math.max(14, speed3d);
    const desiredVelY = launchSpeed * Math.sin(launchPitch);
    const finalVelY = Math.max(skier.velY, desiredVelY);
    const desiredHoriz = Math.sqrt(Math.max(0, launchSpeed * launchSpeed - finalVelY * finalVelY));
    const curHoriz = Math.max(1e-4, Math.hypot(skier.velX, skier.velZ));
    const hScale = desiredHoriz / curHoriz;

    skier.velX *= hScale;
    skier.velZ *= hScale;
    skier.velY = finalVelY;
    skier.posY += Math.max(0, skier.velY) * dt * 0.5;
    contactSolver.teleportCharacter(
      skier.posX,
      skier.posY,
      skier.posZ,
      skier.velX,
      skier.velY,
      skier.velZ,
    );
    return true;
  }

  private applyForkBumperNudge(
    skier: MutableSkierPose,
    surface: SurfaceSample,
    forkBumper: SpineForkMeta,
    surfaceQuery: SurfaceQueryView,
    skierRadius: number,
    hitByJolt: boolean,
    contactSolver: WorldContactSolver,
  ): void {
    const dx = skier.posX - forkBumper.seamWorldX;
    const dz = skier.posZ - forkBumper.seamWorldZ;
    const distXZ = Math.hypot(dx, dz);
    const minClear = forkBumper.seamNoseRadius + skierRadius;
    const clearanceY = skier.posY - Math.min(surface.groundY, forkBumper.seamWorldY);

    if (!hitByJolt && !(distXZ < minClear && clearanceY < 1.65)) {
      return;
    }

    const seamRightX = Math.cos(forkBumper.seamYawRad);
    const seamRightZ = -Math.sin(forkBumper.seamYawRad);
    const seamFwdX = -Math.sin(forkBumper.seamYawRad);
    const seamFwdZ = -Math.cos(forkBumper.seamYawRad);
    const latDot = dx * seamRightX + dz * seamRightZ;
    const side = latDot < 0 ? -1 : 1;

    if (distXZ < minClear && clearanceY < 1.65) {
      const push = minClear - distXZ + 0.08;
      skier.posX += (seamRightX * side * 0.92 + seamFwdX * 0.35) * push;
      skier.posZ += (seamRightZ * side * 0.92 + seamFwdZ * 0.35) * push;
      surfaceQuery.sampleSurface(skier.posX, skier.posZ, surface.segmentId, surface.s, surface);
      skier.posY = Math.max(skier.posY, surface.groundY);
    }

    const vLat = skier.velX * seamRightX + skier.velZ * seamRightZ;
    if (vLat * side < 4.5) {
      const deltaV = 4.5 * side - vLat;
      skier.velX += seamRightX * deltaV * 0.5;
      skier.velZ += seamRightZ * deltaV * 0.5;
    }
    skier.headingRad = wrapAngle(skier.headingRad - side * 0.14);
    contactSolver.teleportCharacter(
      skier.posX,
      skier.posY,
      skier.posZ,
      skier.velX,
      skier.velY,
      skier.velZ,
    );
  }
}
