import type { SpineForkMeta, TerrainFieldView } from '../contracts';
import type { EntityPools } from '../entityPools';

export type ContactBodyKind =
  | 'none'
  | 'terrain'
  | 'ramp'
  | 'hazard'
  | 'creature'
  | 'forkBumper'
  | 'structure';

export const MAX_CONTACT_EVENTS_PER_STEP = 16;

export interface ContactEvent {
  kind: ContactBodyKind;
  poolIndex: number;
  posX: number;
  posY: number;
  posZ: number;
  /** Outward surface normal pointing toward the skier. */
  normalX: number;
  normalY: number;
  normalZ: number;
  /** Relative closing speed into the surface along -normal (m/s, >= 0). */
  impactSpeed: number;
}

export interface WorldMoveRequest {
  dt: number;
  posX: number;
  posY: number;
  posZ: number;
  velX: number;
  velY: number;
  velZ: number;
  gravityY: number;
  /** Downward step distance for floor adhesion; set 0 when detaching over crests or jumping. */
  stickToFloorStepDownM: number;
  /** Optional tiny inward normal seating speed (m/s) when adhering to gentle convex snow slopes. */
  seatBiasMps: number;
  seatNormalX: number;
  seatNormalY: number;
  seatNormalZ: number;
  collideHazards: boolean;
  collideCreatures: boolean;
  isWipeoutTumble: boolean;
  syncPositionFirst: boolean;
}

export interface WorldMoveResult {
  posX: number;
  posY: number;
  posZ: number;
  velX: number;
  velY: number;
  velZ: number;
  isSupported: boolean;
  onSteepGround: boolean;
  groundNormalX: number;
  groundNormalY: number;
  groundNormalZ: number;
  groundKind: ContactBodyKind;
  groundPoolIndex: number;
  wallHit: boolean;
  wallNormalX: number;
  wallNormalY: number;
  wallNormalZ: number;
  wallImpactSpeed: number;
  contactCount: number;
  readonly contacts: readonly ContactEvent[];
}

export interface HeightPatchNormalOut {
  valid: boolean;
  normalX: number;
  normalY: number;
  normalZ: number;
  heightY: number;
}

export function createWorldMoveRequest(): WorldMoveRequest {
  return {
    dt: 1 / 60,
    posX: 0,
    posY: 0,
    posZ: 0,
    velX: 0,
    velY: 0,
    velZ: 0,
    gravityY: -22,
    stickToFloorStepDownM: 0.35,
    seatBiasMps: 0,
    seatNormalX: 0,
    seatNormalY: 1,
    seatNormalZ: 0,
    collideHazards: true,
    collideCreatures: true,
    isWipeoutTumble: false,
    syncPositionFirst: false,
  };
}

export function createWorldMoveResult(): WorldMoveResult {
  const contacts: ContactEvent[] = [];
  for (let i = 0; i < MAX_CONTACT_EVENTS_PER_STEP; i++) {
    contacts.push({
      kind: 'none',
      poolIndex: -1,
      posX: 0,
      posY: 0,
      posZ: 0,
      normalX: 0,
      normalY: 1,
      normalZ: 0,
      impactSpeed: 0,
    });
  }
  return {
    posX: 0,
    posY: 0,
    posZ: 0,
    velX: 0,
    velY: 0,
    velZ: 0,
    isSupported: false,
    onSteepGround: false,
    groundNormalX: 0,
    groundNormalY: 1,
    groundNormalZ: 0,
    groundKind: 'none',
    groundPoolIndex: -1,
    wallHit: false,
    wallNormalX: 0,
    wallNormalY: 1,
    wallNormalZ: 0,
    wallImpactSpeed: 0,
    contactCount: 0,
    contacts,
  };
}

export function createHeightPatchNormalOut(): HeightPatchNormalOut {
  return {
    valid: false,
    normalX: 0,
    normalY: 1,
    normalZ: 0,
    heightY: 0,
  };
}

/**
 * Clean Layer B contact/collision interface isolating Layer A (`SkiPhysics` / `SkiDynamics`)
 * from the underlying 3D physics engine (Jolt Physics WASM).
 * Strictly headless, zero Three.js/DOM, zero hot-loop heap allocations.
 */
export interface WorldContactSolver {
  syncWorld(
    skierX: number,
    skierY: number,
    skierZ: number,
    dt: number,
    terrain: TerrainFieldView,
    pools: EntityPools,
    forkBumper: SpineForkMeta | null,
    forceTerrainRefresh?: boolean,
  ): void;

  /**
   * Fast O(1) normal/height lookup inside the cached rolling terrain height patch
   * used by Layer A for dt-invariant convex crest detachment without extra terrain queries.
   */
  samplePatchNormal(wx: number, wz: number, out: HeightPatchNormalOut): HeightPatchNormalOut;

  stepCharacter(req: WorldMoveRequest, out: WorldMoveResult): void;

  teleportCharacter(
    posX: number,
    posY: number,
    posZ: number,
    velX: number,
    velY: number,
    velZ: number,
  ): void;

  shiftOrigin(dx: number, dy: number, dz: number): void;

  onPoolsPruned(): void;

  reset(): void;

  dispose(): void;
}
