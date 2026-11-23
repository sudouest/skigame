import type {
  CreaturePoolView,
  DeliveryZonePoolView,
  EntityPoolViews,
  HazardPoolView,
  PresentPoolView,
  RampPoolView,
  SkiTrackPoolView,
  TossedPresentPoolView,
} from './contracts';

export const MAX_HAZARDS = 256;
export const MAX_PRESENTS = 256;
export const MAX_TOSSED_PRESENTS = 48;
export const MAX_DELIVERY_ZONES = 24;
export const MAX_CREATURES = 24;
export const MAX_SKI_TRACKS = 256;
export const MAX_RAMPS = 32;

export class HazardPool implements HazardPoolView {
  count = 0;
  readonly capacity: number;
  readonly defIds: string[];
  readonly segmentIds: Int32Array;
  readonly posX: Float32Array;
  readonly posY: Float32Array;
  readonly posZ: Float32Array;
  readonly normalX: Float32Array;
  readonly normalY: Float32Array;
  readonly normalZ: Float32Array;
  readonly yawRad: Float32Array;
  readonly scale: Float32Array;
  readonly radius: Float32Array;
  readonly height: Float32Array;
  readonly triggered: Uint8Array;
  readonly lethalFlags: Uint8Array;

  constructor(capacity = MAX_HAZARDS) {
    this.capacity = capacity;
    this.defIds = new Array<string>(capacity).fill('');
    this.segmentIds = new Int32Array(capacity);
    this.posX = new Float32Array(capacity);
    this.posY = new Float32Array(capacity);
    this.posZ = new Float32Array(capacity);
    this.normalX = new Float32Array(capacity);
    this.normalY = new Float32Array(capacity);
    this.normalZ = new Float32Array(capacity);
    this.yawRad = new Float32Array(capacity);
    this.scale = new Float32Array(capacity);
    this.radius = new Float32Array(capacity);
    this.height = new Float32Array(capacity);
    this.triggered = new Uint8Array(capacity);
    this.lethalFlags = new Uint8Array(capacity);
  }

  add(
    defId: string,
    segmentId: number,
    posX: number,
    posY: number,
    posZ: number,
    normalX: number,
    normalY: number,
    normalZ: number,
    yawRad: number,
    scale: number,
    radius: number,
    height: number,
    lethal: boolean,
  ): number {
    if (this.count >= this.capacity) return -1;
    const i = this.count++;
    this.defIds[i] = defId;
    this.segmentIds[i] = segmentId;
    this.posX[i] = posX;
    this.posY[i] = posY;
    this.posZ[i] = posZ;
    this.normalX[i] = normalX;
    this.normalY[i] = normalY;
    this.normalZ[i] = normalZ;
    this.yawRad[i] = yawRad;
    this.scale[i] = scale;
    this.radius[i] = radius;
    this.height[i] = height;
    this.triggered[i] = 0;
    this.lethalFlags[i] = lethal ? 1 : 0;
    return i;
  }

  pruneBySegment(segmentId: number): void {
    let i = 0;
    while (i < this.count) {
      if (this.segmentIds[i] === segmentId) {
        this.swapRemove(i);
      } else {
        i++;
      }
    }
  }

  shiftOrigin(dx: number, dy: number, dz: number): void {
    for (let i = 0; i < this.count; i++) {
      this.posX[i] = this.posX[i]! - dx;
      this.posY[i] = this.posY[i]! - dy;
      this.posZ[i] = this.posZ[i]! - dz;
    }
  }

  clear(): void {
    this.count = 0;
  }

  private swapRemove(idx: number): void {
    const last = --this.count;
    if (idx !== last) {
      this.defIds[idx] = this.defIds[last]!;
      this.segmentIds[idx] = this.segmentIds[last]!;
      this.posX[idx] = this.posX[last]!;
      this.posY[idx] = this.posY[last]!;
      this.posZ[idx] = this.posZ[last]!;
      this.normalX[idx] = this.normalX[last]!;
      this.normalY[idx] = this.normalY[last]!;
      this.normalZ[idx] = this.normalZ[last]!;
      this.yawRad[idx] = this.yawRad[last]!;
      this.scale[idx] = this.scale[last]!;
      this.radius[idx] = this.radius[last]!;
      this.height[idx] = this.height[last]!;
      this.triggered[idx] = this.triggered[last]!;
      this.lethalFlags[idx] = this.lethalFlags[last]!;
    }
  }
}

export class PresentPool implements PresentPoolView {
  count = 0;
  readonly capacity: number;
  readonly defIds: string[];
  readonly segmentIds: Int32Array;
  readonly posX: Float32Array;
  readonly posY: Float32Array;
  readonly posZ: Float32Array;
  readonly bobPhase: Float32Array;
  readonly collected: Uint8Array;

  constructor(capacity = MAX_PRESENTS) {
    this.capacity = capacity;
    this.defIds = new Array<string>(capacity).fill('');
    this.segmentIds = new Int32Array(capacity);
    this.posX = new Float32Array(capacity);
    this.posY = new Float32Array(capacity);
    this.posZ = new Float32Array(capacity);
    this.bobPhase = new Float32Array(capacity);
    this.collected = new Uint8Array(capacity);
  }

  add(
    defId: string,
    segmentId: number,
    posX: number,
    posY: number,
    posZ: number,
    bobPhase: number,
  ): number {
    if (this.count >= this.capacity) return -1;
    const i = this.count++;
    this.defIds[i] = defId;
    this.segmentIds[i] = segmentId;
    this.posX[i] = posX;
    this.posY[i] = posY;
    this.posZ[i] = posZ;
    this.bobPhase[i] = bobPhase;
    this.collected[i] = 0;
    return i;
  }

  pruneBySegment(segmentId: number): void {
    let i = 0;
    while (i < this.count) {
      if (this.segmentIds[i] === segmentId) {
        const last = --this.count;
        if (i !== last) {
          this.defIds[i] = this.defIds[last]!;
          this.segmentIds[i] = this.segmentIds[last]!;
          this.posX[i] = this.posX[last]!;
          this.posY[i] = this.posY[last]!;
          this.posZ[i] = this.posZ[last]!;
          this.bobPhase[i] = this.bobPhase[last]!;
          this.collected[i] = this.collected[last]!;
        }
      } else {
        i++;
      }
    }
  }

  shiftOrigin(dx: number, dy: number, dz: number): void {
    for (let i = 0; i < this.count; i++) {
      this.posX[i] = this.posX[i]! - dx;
      this.posY[i] = this.posY[i]! - dy;
      this.posZ[i] = this.posZ[i]! - dz;
    }
  }

  clear(): void {
    this.count = 0;
  }
}

export class TossedPresentPool implements TossedPresentPoolView {
  count = 0;
  readonly capacity: number;
  readonly defIds: string[];
  readonly prevPosX: Float32Array;
  readonly prevPosY: Float32Array;
  readonly prevPosZ: Float32Array;
  readonly posX: Float32Array;
  readonly posY: Float32Array;
  readonly posZ: Float32Array;
  readonly prevSpinRad: Float32Array;
  readonly spinRad: Float32Array;
  readonly progress: Float32Array;
  readonly kind: Uint8Array;

  // Internal arc endpoints & durations
  private readonly startX: Float32Array;
  private readonly startY: Float32Array;
  private readonly startZ: Float32Array;
  private readonly targetX: Float32Array;
  private readonly targetY: Float32Array;
  private readonly targetZ: Float32Array;
  private readonly arcHeight: Float32Array;
  private readonly durationSec: Float32Array;
  private readonly elapsedSec: Float32Array;

  constructor(capacity = MAX_TOSSED_PRESENTS) {
    this.capacity = capacity;
    this.defIds = new Array<string>(capacity).fill('');
    this.prevPosX = new Float32Array(capacity);
    this.prevPosY = new Float32Array(capacity);
    this.prevPosZ = new Float32Array(capacity);
    this.posX = new Float32Array(capacity);
    this.posY = new Float32Array(capacity);
    this.posZ = new Float32Array(capacity);
    this.prevSpinRad = new Float32Array(capacity);
    this.spinRad = new Float32Array(capacity);
    this.progress = new Float32Array(capacity);
    this.kind = new Uint8Array(capacity);

    this.startX = new Float32Array(capacity);
    this.startY = new Float32Array(capacity);
    this.startZ = new Float32Array(capacity);
    this.targetX = new Float32Array(capacity);
    this.targetY = new Float32Array(capacity);
    this.targetZ = new Float32Array(capacity);
    this.arcHeight = new Float32Array(capacity);
    this.durationSec = new Float32Array(capacity);
    this.elapsedSec = new Float32Array(capacity);
  }

  spawnArc(
    defId: string,
    kind: 0 | 1,
    sx: number,
    sy: number,
    sz: number,
    tx: number,
    ty: number,
    tz: number,
    arcHeight: number,
    durationSec: number,
    delaySec = 0,
  ): void {
    if (this.count >= this.capacity) {
      // Recycle oldest finished/active slot cleanly without allocating
      this.swapRemove(0);
    }
    const i = this.count++;
    this.defIds[i] = defId;
    this.kind[i] = kind;
    this.startX[i] = sx;
    this.startY[i] = sy;
    this.startZ[i] = sz;
    this.targetX[i] = tx;
    this.targetY[i] = ty;
    this.targetZ[i] = tz;
    this.arcHeight[i] = arcHeight;
    this.durationSec[i] = Math.max(0.1, durationSec);
    this.elapsedSec[i] = -Math.max(0, delaySec);
    this.prevPosX[i] = sx;
    this.prevPosY[i] = sy;
    this.prevPosZ[i] = sz;
    this.posX[i] = sx;
    this.posY[i] = sy;
    this.posZ[i] = sz;
    this.prevSpinRad[i] = 0;
    this.spinRad[i] = 0;
    this.progress[i] = 0;
  }

  capturePrevious(): void {
    for (let i = 0; i < this.count; i++) {
      this.prevPosX[i] = this.posX[i]!;
      this.prevPosY[i] = this.posY[i]!;
      this.prevPosZ[i] = this.posZ[i]!;
      this.prevSpinRad[i] = this.spinRad[i]!;
    }
  }

  step(dt: number): void {
    let i = 0;
    while (i < this.count) {
      const elapsed = this.elapsedSec[i]! + dt;
      this.elapsedSec[i] = elapsed;
      if (elapsed < 0) {
        i++;
        continue;
      }
      const dur = this.durationSec[i]!;
      const p = elapsed / dur;
      if (p >= 1.0) {
        this.swapRemove(i);
        continue;
      }
      this.progress[i] = p;
      const sx = this.startX[i]!;
      const sy = this.startY[i]!;
      const sz = this.startZ[i]!;
      const tx = this.targetX[i]!;
      const ty = this.targetY[i]!;
      const tz = this.targetZ[i]!;
      const lift = 4 * this.arcHeight[i]! * p * (1 - p);
      this.posX[i] = sx + (tx - sx) * p;
      this.posY[i] = sy + (ty - sy) * p + lift;
      this.posZ[i] = sz + (tz - sz) * p;
      this.spinRad[i] = this.spinRad[i]! + (this.kind[i] === 0 ? 7.5 : 12.0) * dt;
      i++;
    }
  }

  shiftOrigin(dx: number, dy: number, dz: number): void {
    for (let i = 0; i < this.count; i++) {
      this.prevPosX[i] = this.prevPosX[i]! - dx;
      this.prevPosY[i] = this.prevPosY[i]! - dy;
      this.prevPosZ[i] = this.prevPosZ[i]! - dz;
      this.posX[i] = this.posX[i]! - dx;
      this.posY[i] = this.posY[i]! - dy;
      this.posZ[i] = this.posZ[i]! - dz;
      this.startX[i] = this.startX[i]! - dx;
      this.startY[i] = this.startY[i]! - dy;
      this.startZ[i] = this.startZ[i]! - dz;
      this.targetX[i] = this.targetX[i]! - dx;
      this.targetY[i] = this.targetY[i]! - dy;
      this.targetZ[i] = this.targetZ[i]! - dz;
    }
  }

  clear(): void {
    this.count = 0;
  }

  private swapRemove(idx: number): void {
    const last = --this.count;
    if (idx !== last) {
      this.defIds[idx] = this.defIds[last]!;
      this.prevPosX[idx] = this.prevPosX[last]!;
      this.prevPosY[idx] = this.prevPosY[last]!;
      this.prevPosZ[idx] = this.prevPosZ[last]!;
      this.posX[idx] = this.posX[last]!;
      this.posY[idx] = this.posY[last]!;
      this.posZ[idx] = this.posZ[last]!;
      this.prevSpinRad[idx] = this.prevSpinRad[last]!;
      this.spinRad[idx] = this.spinRad[last]!;
      this.progress[idx] = this.progress[last]!;
      this.kind[idx] = this.kind[last]!;
      this.startX[idx] = this.startX[last]!;
      this.startY[idx] = this.startY[last]!;
      this.startZ[idx] = this.startZ[last]!;
      this.targetX[idx] = this.targetX[last]!;
      this.targetY[idx] = this.targetY[last]!;
      this.targetZ[idx] = this.targetZ[last]!;
      this.arcHeight[idx] = this.arcHeight[last]!;
      this.durationSec[idx] = this.durationSec[last]!;
      this.elapsedSec[idx] = this.elapsedSec[last]!;
    }
  }
}

export class DeliveryZonePool implements DeliveryZonePoolView {
  count = 0;
  readonly capacity: number;
  readonly defIds: string[];
  readonly segmentIds: Int32Array;
  readonly posX: Float32Array;
  readonly posY: Float32Array;
  readonly posZ: Float32Array;
  readonly yawRad: Float32Array;
  readonly radius: Float32Array;
  readonly lengthM: Float32Array;
  readonly deliveredCount: Uint16Array;
  readonly active: Uint8Array;
  readonly celebratingTimer: Float32Array;

  constructor(capacity = MAX_DELIVERY_ZONES) {
    this.capacity = capacity;
    this.defIds = new Array<string>(capacity).fill('');
    this.segmentIds = new Int32Array(capacity);
    this.posX = new Float32Array(capacity);
    this.posY = new Float32Array(capacity);
    this.posZ = new Float32Array(capacity);
    this.yawRad = new Float32Array(capacity);
    this.radius = new Float32Array(capacity);
    this.lengthM = new Float32Array(capacity);
    this.deliveredCount = new Uint16Array(capacity);
    this.active = new Uint8Array(capacity);
    this.celebratingTimer = new Float32Array(capacity);
  }

  add(
    defId: string,
    segmentId: number,
    posX: number,
    posY: number,
    posZ: number,
    yawRad: number,
    radius: number,
    lengthM: number,
  ): number {
    if (this.count >= this.capacity) return -1;
    const i = this.count++;
    this.defIds[i] = defId;
    this.segmentIds[i] = segmentId;
    this.posX[i] = posX;
    this.posY[i] = posY;
    this.posZ[i] = posZ;
    this.yawRad[i] = yawRad;
    this.radius[i] = radius;
    this.lengthM[i] = lengthM;
    this.deliveredCount[i] = 0;
    this.active[i] = 1;
    this.celebratingTimer[i] = 0;
    return i;
  }

  stepTimers(dt: number): void {
    for (let i = 0; i < this.count; i++) {
      const t = this.celebratingTimer[i]!;
      if (t > 0) {
        this.celebratingTimer[i] = Math.max(0, t - dt);
      }
    }
  }

  pruneBySegment(segmentId: number): void {
    let i = 0;
    while (i < this.count) {
      if (this.segmentIds[i] === segmentId) {
        const last = --this.count;
        if (i !== last) {
          this.defIds[i] = this.defIds[last]!;
          this.segmentIds[i] = this.segmentIds[last]!;
          this.posX[i] = this.posX[last]!;
          this.posY[i] = this.posY[last]!;
          this.posZ[i] = this.posZ[last]!;
          this.yawRad[i] = this.yawRad[last]!;
          this.radius[i] = this.radius[last]!;
          this.lengthM[i] = this.lengthM[last]!;
          this.deliveredCount[i] = this.deliveredCount[last]!;
          this.active[i] = this.active[last]!;
          this.celebratingTimer[i] = this.celebratingTimer[last]!;
        }
      } else {
        i++;
      }
    }
  }

  shiftOrigin(dx: number, dy: number, dz: number): void {
    for (let i = 0; i < this.count; i++) {
      this.posX[i] = this.posX[i]! - dx;
      this.posY[i] = this.posY[i]! - dy;
      this.posZ[i] = this.posZ[i]! - dz;
    }
  }

  clear(): void {
    this.count = 0;
  }
}

export class CreaturePool implements CreaturePoolView {
  count = 0;
  readonly capacity: number;
  readonly defIds: string[];
  readonly segmentIds: Int32Array;
  readonly prevPosX: Float32Array;
  readonly prevPosY: Float32Array;
  readonly prevPosZ: Float32Array;
  readonly posX: Float32Array;
  readonly posY: Float32Array;
  readonly posZ: Float32Array;
  readonly normalX: Float32Array;
  readonly normalY: Float32Array;
  readonly normalZ: Float32Array;
  readonly prevHeadingRad: Float32Array;
  readonly headingRad: Float32Array;
  readonly groundY: Float32Array;
  readonly stateCode: Uint8Array;
  readonly stateTimer: Float32Array;
  readonly telegraphProgress: Float32Array;
  readonly radius: Float32Array;

  // Non-authoritative query hint cache & patrol state per creature
  readonly height: Float32Array;
  readonly hintSegId: Int32Array;
  readonly hintS: Float32Array;
  readonly patrolDir: Int8Array;
  readonly telegraphed: Uint8Array;
  readonly patrolAnchorX: Float32Array;
  readonly patrolAnchorZ: Float32Array;

  constructor(capacity = MAX_CREATURES) {
    this.capacity = capacity;
    this.defIds = new Array<string>(capacity).fill('');
    this.segmentIds = new Int32Array(capacity);
    this.prevPosX = new Float32Array(capacity);
    this.prevPosY = new Float32Array(capacity);
    this.prevPosZ = new Float32Array(capacity);
    this.posX = new Float32Array(capacity);
    this.posY = new Float32Array(capacity);
    this.posZ = new Float32Array(capacity);
    this.normalX = new Float32Array(capacity);
    this.normalY = new Float32Array(capacity);
    this.normalZ = new Float32Array(capacity);
    this.prevHeadingRad = new Float32Array(capacity);
    this.headingRad = new Float32Array(capacity);
    this.groundY = new Float32Array(capacity);
    this.stateCode = new Uint8Array(capacity);
    this.stateTimer = new Float32Array(capacity);
    this.telegraphProgress = new Float32Array(capacity);
    this.radius = new Float32Array(capacity);

    this.height = new Float32Array(capacity);
    this.hintSegId = new Int32Array(capacity);
    this.hintS = new Float32Array(capacity);
    this.patrolDir = new Int8Array(capacity);
    this.telegraphed = new Uint8Array(capacity);
    this.patrolAnchorX = new Float32Array(capacity);
    this.patrolAnchorZ = new Float32Array(capacity);
  }

  add(
    defId: string,
    segmentId: number,
    posX: number,
    posY: number,
    posZ: number,
    normalX: number,
    normalY: number,
    normalZ: number,
    headingRad: number,
    radius: number,
    height: number,
    hintS: number,
    patrolDir: 1 | -1,
  ): number {
    if (this.count >= this.capacity) return -1;
    const i = this.count++;
    this.defIds[i] = defId;
    this.segmentIds[i] = segmentId;
    this.prevPosX[i] = posX;
    this.prevPosY[i] = posY;
    this.prevPosZ[i] = posZ;
    this.posX[i] = posX;
    this.posY[i] = posY;
    this.posZ[i] = posZ;
    this.normalX[i] = normalX;
    this.normalY[i] = normalY;
    this.normalZ[i] = normalZ;
    this.prevHeadingRad[i] = headingRad;
    this.headingRad[i] = headingRad;
    this.groundY[i] = posY;
    this.stateCode[i] = 0;
    this.stateTimer[i] = 0;
    this.telegraphProgress[i] = 0;
    this.radius[i] = radius;
    this.height[i] = height;
    this.hintSegId[i] = segmentId;
    this.hintS[i] = hintS;
    this.patrolDir[i] = patrolDir;
    this.telegraphed[i] = 0;
    this.patrolAnchorX[i] = posX;
    this.patrolAnchorZ[i] = posZ;
    return i;
  }

  capturePrevious(): void {
    for (let i = 0; i < this.count; i++) {
      this.prevPosX[i] = this.posX[i]!;
      this.prevPosY[i] = this.posY[i]!;
      this.prevPosZ[i] = this.posZ[i]!;
      this.prevHeadingRad[i] = this.headingRad[i]!;
    }
  }

  pruneBySegment(segmentId: number): void {
    let i = 0;
    while (i < this.count) {
      if (this.segmentIds[i] === segmentId) {
        const last = --this.count;
        if (i !== last) {
          this.defIds[i] = this.defIds[last]!;
          this.segmentIds[i] = this.segmentIds[last]!;
          this.prevPosX[i] = this.prevPosX[last]!;
          this.prevPosY[i] = this.prevPosY[last]!;
          this.prevPosZ[i] = this.prevPosZ[last]!;
          this.posX[i] = this.posX[last]!;
          this.posY[i] = this.posY[last]!;
          this.posZ[i] = this.posZ[last]!;
          this.normalX[i] = this.normalX[last]!;
          this.normalY[i] = this.normalY[last]!;
          this.normalZ[i] = this.normalZ[last]!;
          this.prevHeadingRad[i] = this.prevHeadingRad[last]!;
          this.headingRad[i] = this.headingRad[last]!;
          this.groundY[i] = this.groundY[last]!;
          this.stateCode[i] = this.stateCode[last]!;
          this.stateTimer[i] = this.stateTimer[last]!;
          this.telegraphProgress[i] = this.telegraphProgress[last]!;
          this.radius[i] = this.radius[last]!;
          this.height[i] = this.height[last]!;
          this.hintSegId[i] = this.hintSegId[last]!;
          this.hintS[i] = this.hintS[last]!;
          this.patrolDir[i] = this.patrolDir[last]!;
          this.telegraphed[i] = this.telegraphed[last]!;
          this.patrolAnchorX[i] = this.patrolAnchorX[last]!;
          this.patrolAnchorZ[i] = this.patrolAnchorZ[last]!;
        }
      } else {
        i++;
      }
    }
  }

  shiftOrigin(dx: number, dy: number, dz: number): void {
    for (let i = 0; i < this.count; i++) {
      this.prevPosX[i] = this.prevPosX[i]! - dx;
      this.prevPosY[i] = this.prevPosY[i]! - dy;
      this.prevPosZ[i] = this.prevPosZ[i]! - dz;
      this.posX[i] = this.posX[i]! - dx;
      this.posY[i] = this.posY[i]! - dy;
      this.posZ[i] = this.posZ[i]! - dz;
      this.groundY[i] = this.groundY[i]! - dy;
      this.patrolAnchorX[i] = this.patrolAnchorX[i]! - dx;
      this.patrolAnchorZ[i] = this.patrolAnchorZ[i]! - dz;
    }
  }

  clear(): void {
    this.count = 0;
  }
}

export class SkiTrackPool implements SkiTrackPoolView {
  count = 0;
  readonly capacity: number;
  head = 0;
  readonly posX: Float32Array;
  readonly posY: Float32Array;
  readonly posZ: Float32Array;
  readonly normalX: Float32Array;
  readonly normalY: Float32Array;
  readonly normalZ: Float32Array;
  readonly rightX: Float32Array;
  readonly rightY: Float32Array;
  readonly rightZ: Float32Array;
  readonly ageSec: Float32Array;
  readonly grounded: Uint8Array;

  constructor(capacity = MAX_SKI_TRACKS) {
    this.capacity = capacity;
    this.posX = new Float32Array(capacity);
    this.posY = new Float32Array(capacity);
    this.posZ = new Float32Array(capacity);
    this.normalX = new Float32Array(capacity);
    this.normalY = new Float32Array(capacity);
    this.normalZ = new Float32Array(capacity);
    this.rightX = new Float32Array(capacity);
    this.rightY = new Float32Array(capacity);
    this.rightZ = new Float32Array(capacity);
    this.ageSec = new Float32Array(capacity);
    this.grounded = new Uint8Array(capacity);
  }

  pushSample(
    px: number,
    py: number,
    pz: number,
    nx: number,
    ny: number,
    nz: number,
    rx: number,
    ry: number,
    rz: number,
    grounded: boolean,
  ): void {
    const idx = this.head;
    this.posX[idx] = px;
    this.posY[idx] = py;
    this.posZ[idx] = pz;
    this.normalX[idx] = nx;
    this.normalY[idx] = ny;
    this.normalZ[idx] = nz;
    this.rightX[idx] = rx;
    this.rightY[idx] = ry;
    this.rightZ[idx] = rz;
    this.ageSec[idx] = 0;
    this.grounded[idx] = grounded ? 1 : 0;

    this.head = (this.head + 1) % this.capacity;
    if (this.count < this.capacity) {
      this.count++;
    }
  }

  stepAges(dt: number, maxAgeSec = 6.0): void {
    for (let i = 0; i < this.count; i++) {
      const slot = (this.head - this.count + i + this.capacity) % this.capacity;
      this.ageSec[slot] = this.ageSec[slot]! + dt;
    }
    while (this.count > 0) {
      const oldest = (this.head - this.count + this.capacity) % this.capacity;
      if (this.ageSec[oldest]! > maxAgeSec) {
        this.count--;
      } else {
        break;
      }
    }
  }

  shiftOrigin(dx: number, dy: number, dz: number): void {
    for (let i = 0; i < this.count; i++) {
      const slot = (this.head - this.count + i + this.capacity) % this.capacity;
      this.posX[slot] = this.posX[slot]! - dx;
      this.posY[slot] = this.posY[slot]! - dy;
      this.posZ[slot] = this.posZ[slot]! - dz;
    }
  }

  clear(): void {
    this.count = 0;
    this.head = 0;
  }
}

export class RampPool implements RampPoolView {
  count = 0;
  readonly capacity: number;
  readonly defIds: string[];
  readonly segmentIds: Int32Array;
  readonly posX: Float32Array;
  readonly posY: Float32Array;
  readonly posZ: Float32Array;
  readonly yawRad: Float32Array;
  readonly pitchRad: Float32Array;
  readonly width: Float32Array;
  readonly length: Float32Array;
  readonly height: Float32Array;
  readonly lipPitchBoostDeg: Float32Array;

  constructor(capacity = MAX_RAMPS) {
    this.capacity = capacity;
    this.defIds = new Array<string>(capacity).fill('');
    this.segmentIds = new Int32Array(capacity);
    this.posX = new Float32Array(capacity);
    this.posY = new Float32Array(capacity);
    this.posZ = new Float32Array(capacity);
    this.yawRad = new Float32Array(capacity);
    this.pitchRad = new Float32Array(capacity);
    this.width = new Float32Array(capacity);
    this.length = new Float32Array(capacity);
    this.height = new Float32Array(capacity);
    this.lipPitchBoostDeg = new Float32Array(capacity);
  }

  add(
    defId: string,
    segmentId: number,
    posX: number,
    posY: number,
    posZ: number,
    yawRad: number,
    pitchRad: number,
    width: number,
    length: number,
    height: number,
    lipPitchBoostDeg: number,
  ): number {
    if (this.count >= this.capacity) return -1;
    const i = this.count++;
    this.defIds[i] = defId;
    this.segmentIds[i] = segmentId;
    this.posX[i] = posX;
    this.posY[i] = posY;
    this.posZ[i] = posZ;
    this.yawRad[i] = yawRad;
    this.pitchRad[i] = pitchRad;
    this.width[i] = width;
    this.length[i] = length;
    this.height[i] = height;
    this.lipPitchBoostDeg[i] = lipPitchBoostDeg;
    return i;
  }

  pruneBySegment(segmentId: number): void {
    let i = 0;
    while (i < this.count) {
      if (this.segmentIds[i] === segmentId) {
        const last = --this.count;
        if (i !== last) {
          this.defIds[i] = this.defIds[last]!;
          this.segmentIds[i] = this.segmentIds[last]!;
          this.posX[i] = this.posX[last]!;
          this.posY[i] = this.posY[last]!;
          this.posZ[i] = this.posZ[last]!;
          this.yawRad[i] = this.yawRad[last]!;
          this.pitchRad[i] = this.pitchRad[last]!;
          this.width[i] = this.width[last]!;
          this.length[i] = this.length[last]!;
          this.height[i] = this.height[last]!;
          this.lipPitchBoostDeg[i] = this.lipPitchBoostDeg[last]!;
        }
      } else {
        i++;
      }
    }
  }

  shiftOrigin(dx: number, dy: number, dz: number): void {
    for (let i = 0; i < this.count; i++) {
      this.posX[i] = this.posX[i]! - dx;
      this.posY[i] = this.posY[i]! - dy;
      this.posZ[i] = this.posZ[i]! - dz;
    }
  }

  clear(): void {
    this.count = 0;
  }
}

export class EntityPools implements EntityPoolViews {
  readonly hazards = new HazardPool();
  readonly presents = new PresentPool();
  readonly tossedPresents = new TossedPresentPool();
  readonly deliveryZones = new DeliveryZonePool();
  readonly creatures = new CreaturePool();
  readonly skiTracks = new SkiTrackPool();
  readonly ramps = new RampPool();

  capturePreviousPoses(): void {
    this.tossedPresents.capturePrevious();
    this.creatures.capturePrevious();
  }

  pruneBySegment(segmentId: number): void {
    this.hazards.pruneBySegment(segmentId);
    this.presents.pruneBySegment(segmentId);
    this.deliveryZones.pruneBySegment(segmentId);
    this.creatures.pruneBySegment(segmentId);
    this.ramps.pruneBySegment(segmentId);
  }

  shiftOrigin(dx: number, dy: number, dz: number): void {
    this.hazards.shiftOrigin(dx, dy, dz);
    this.presents.shiftOrigin(dx, dy, dz);
    this.tossedPresents.shiftOrigin(dx, dy, dz);
    this.deliveryZones.shiftOrigin(dx, dy, dz);
    this.creatures.shiftOrigin(dx, dy, dz);
    this.skiTracks.shiftOrigin(dx, dy, dz);
    this.ramps.shiftOrigin(dx, dy, dz);
  }

  clear(): void {
    this.hazards.clear();
    this.presents.clear();
    this.tossedPresents.clear();
    this.deliveryZones.clear();
    this.creatures.clear();
    this.skiTracks.clear();
    this.ramps.clear();
  }
}
