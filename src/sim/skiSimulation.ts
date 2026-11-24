import { EventBus } from '../core/eventBus';
import { clamp, damp, lerp } from '../core/math';
import { normalizeSeedUint, SeededRng } from '../core/rng';
import { SpatialGrid } from '../core/spatialGrid';
import { getSkierDef } from '../content/characters';
import { getCreatureDef } from '../content/creatures';
import { getDeliveryZoneDef } from '../content/deliveryZones';
import { getHazardDef } from '../content/hazards';
import { getPresentDef } from '../content/presents';
import { WEATHER_BLIZZARD } from '../content/stages';
import type { SkierDef, WeatherProfile } from '../content/types';
import { CameraRig } from './cameraRig';
import {
  createRibbonPointOut,
  createSurfaceSample,
  type ActiveWeatherState,
  type CameraPose,
  type DebugDrawView,
  type EntityPoolViews,
  type MountainFieldView,
  type PlayerIntent,
  type ReadonlySimState,
  type RebaseInfo,
  type RibbonPointOut,
  type SimEventMap,
  type SkierPose,
  type SurfaceSample,
  type TrailWindowView,
} from './contracts';
import { CreatureSystem } from './creatureSystem';
import { DebugDrawBuffer } from './debugDrawBuffer';
import { EntityPools } from './entityPools';
import { LayoutEngine, PacingDirector } from './layoutEngine';
import { MountainField } from './mountainField';
import {
  copySkierPose,
  createMutableSkierPose,
  SkiPhysics,
  type MutableSkierPose,
} from './skiPhysics';
import type { TrailSegment } from './trailSegment';
import { DEFAULT_FORK_PRUNE_DISTANCE_M, TrailWindow } from './trailWindow';

export const WORLD_REBASE_THRESHOLD_M = 128;
const MAX_CARRY_CAPACITY = 16;
const COMBO_DURATION_SEC = 8.0;

export interface SkiSimulationOptions {
  readonly seed?: number | string;
  readonly skierId?: string;
  readonly startStageId?: string;
  readonly gameMode?: 'endless' | 'scoreAttack';
  readonly eventBus?: EventBus<SimEventMap>;
  readonly debugDrawEnabled?: boolean;
  readonly blizzardEnabled?: boolean;
}

interface MutableSimState {
  tickCount: number;
  elapsedSec: number;
  distanceM: number;
  paused: boolean;
  gameMode: 'endless' | 'scoreAttack';
  livesRemaining: number;
  gameOver: boolean;

  skierId: string;
  skierState: 'skiing' | 'wipeout' | 'recovering';
  readonly prevSkier: MutableSkierPose;
  readonly currSkier: MutableSkierPose;
  readonly surfaceSample: SurfaceSample;
  wipeoutTimerSec: number;
  wipeoutDurationSec: number;
  invulnerableTimerSec: number;
  invulnerableDurationSec: number;

  readonly prevCamera: CameraPose;
  readonly currCamera: CameraPose;

  score: number;
  highCombo: number;
  comboCount: number;
  comboMultiplier: number;
  comboTimerSec: number;
  comboDurationSec: number;
  carriedCount: number;
  maxCarryCapacity: number;
  readonly carriedPresentDefIds: string[];
  deliveredTotal: number;

  activeStageId: string;
  readonly activeWeather: {
    profileId: string;
    blizzardEnabled: boolean;
    blizzardIntensity: number;
    snowParticleCount: number;
    windLateral: number;
    fogDistanceM: number;
    blizzardDim: number;
  };

  readonly trailWindow: TrailWindowView;
  readonly mountainField: MountainFieldView;
  readonly rebase: {
    rebaseCount: number;
    offsetX: number;
    offsetY: number;
    offsetZ: number;
    lastDeltaX: number;
    lastDeltaY: number;
    lastDeltaZ: number;
  };
  readonly entities: EntityPoolViews;
  readonly debugDraw: DebugDrawView;
}

/**
 * Top-level headless skiing simulation facade.
 * Owns authoritative World Space (X, Y, Z) state, 4-slot TrailWindow, LayoutEngine,
 * PacingDirector, EntityPools, World Floating Origin (128m rebase), CameraRig, and DebugDrawBuffer.
 * Zero Three.js imports, zero DOM globals, zero singletons, zero hot-loop heap allocations.
 */
export class SkiSimulation {
  readonly eventBus: EventBus<SimEventMap>;

  private readonly pacingDirector: PacingDirector;
  private readonly layoutEngine: LayoutEngine;
  private readonly trailWindow: TrailWindow;
  private readonly mountainField: MountainField;
  private readonly pools: EntityPools;
  private readonly physics: SkiPhysics;
  private readonly creatureSystem: CreatureSystem;
  private readonly cameraRig: CameraRig;
  private readonly debugDrawBuffer: DebugDrawBuffer;

  private readonly hazardGrid = new SpatialGrid<number>(16);
  private readonly presentGrid = new SpatialGrid<number>(16);
  private readonly deliveryGrid = new SpatialGrid<number>(24);

  private readonly state: MutableSimState;
  private skierDef: SkierDef;
  private seed: number | string;
  private startStageId: string;
  private scatterRng: SeededRng;
  private readonly recoverRibbonScratch: RibbonPointOut = createRibbonPointOut();

  // Pre-allocated synchronous EventBus payloads (zero hot-loop heap allocations)
  private readonly evPickup = {
    presentDefId: '',
    worldX: 0,
    worldY: 0,
    worldZ: 0,
    pickupPoints: 0,
    carriedCount: 0,
    maxCapacity: 0,
  };
  private readonly evDelivered = {
    deliveryZoneId: '',
    countDelivered: 0,
    pointsAwarded: 0,
    comboMultiplier: 1,
    totalScore: 0,
    worldX: 0,
    worldY: 0,
    worldZ: 0,
  };
  private readonly evWipeout: {
    hazardId: string;
    effect: 'wipeout' | 'stumble';
    presentsDropped: number;
    worldX: number;
    worldY: number;
    worldZ: number;
    recoverySec: number;
  } = {
    hazardId: '',
    effect: 'wipeout',
    presentsDropped: 0,
    worldX: 0,
    worldY: 0,
    worldZ: 0,
    recoverySec: 0,
  };
  private readonly evRecovered = {
    worldX: 0,
    worldY: 0,
    worldZ: 0,
    invulnerableSec: 0,
  };
  private readonly evForkEntered: {
    chosenSide: 'left' | 'right';
    newSegmentId: number;
    newStageId: string;
    previousStageId: string;
  } = {
    chosenSide: 'left',
    newSegmentId: 0,
    newStageId: '',
    previousStageId: '',
  };
  private readonly evRebased = {
    rebaseCount: 0,
    deltaX: 0,
    deltaY: 0,
    deltaZ: 0,
    totalOffsetX: 0,
    totalOffsetY: 0,
    totalOffsetZ: 0,
  };

  // Pre-bound collision visitor closures (zero hot-loop closure allocation)
  private hitHazardIndex = -1;
  private readonly visitHazardCollision = (idx: number, _distSq: number): boolean | void => {
    if (this.hitHazardIndex >= 0) return false;
    if (this.pools.hazards.triggered[idx] !== 0) return;

    const hx = this.pools.hazards.posX[idx]!;
    const hy = this.pools.hazards.posY[idx]!;
    const hz = this.pools.hazards.posZ[idx]!;
    const hr = this.pools.hazards.radius[idx]!;
    const hh = this.pools.hazards.height[idx]!;
    const dx = this.state.currSkier.posX - hx;
    const dz = this.state.currSkier.posZ - hz;
    const combinedR = this.skierDef.stats.collisionRadius + hr;

    if (dx * dx + dz * dz <= combinedR * combinedR) {
      const clearance = this.state.currSkier.posY - Math.max(hy, this.state.surfaceSample.groundY);
      if (clearance <= hh) {
        this.hitHazardIndex = idx;
        return false;
      }
    }
  };

  private readonly visitPresentPickup = (idx: number, _distSq: number): void => {
    if (this.pools.presents.collected[idx] !== 0) return;
    const defId = this.pools.presents.defIds[idx];
    if (!defId) return;
    const def = getPresentDef(defId);
    if (!def) return;

    const px = this.pools.presents.posX[idx]!;
    const py = this.pools.presents.posY[idx]!;
    const pz = this.pools.presents.posZ[idx]!;
    const dx = this.state.currSkier.posX - px;
    const dz = this.state.currSkier.posZ - pz;
    const magnet =
      this.skierDef.perk?.type === 'pickupMagnet' ? this.skierDef.perk.value : 1.0;
    const r = def.pickupRadius * magnet;

    if (dx * dx + dz * dz <= r * r && Math.abs(this.state.currSkier.posY - py) <= 3.0) {
      this.pools.presents.collected[idx] = 1;
      this.state.score += def.pickupPoints;
      if (this.state.carriedCount < this.state.maxCarryCapacity) {
        this.state.carriedPresentDefIds[this.state.carriedCount++] = def.id;
      }

      this.evPickup.presentDefId = def.id;
      this.evPickup.worldX = px;
      this.evPickup.worldY = py;
      this.evPickup.worldZ = pz;
      this.evPickup.pickupPoints = def.pickupPoints;
      this.evPickup.carriedCount = this.state.carriedCount;
      this.evPickup.maxCapacity = this.state.maxCarryCapacity;
      this.eventBus.emit('PRESENT_PICKED_UP', this.evPickup);
    }
  };

  constructor(options: SkiSimulationOptions = {}) {
    this.seed = options.seed ?? 1337;
    this.startStageId = options.startStageId ?? 'sunny-blue';
    this.eventBus = options.eventBus ?? new EventBus<SimEventMap>();
    this.scatterRng = new SeededRng(this.seed);

    this.skierDef = getSkierDef(options.skierId ?? 'skier_alpine') ?? this.requireDefaultSkier();
    this.pacingDirector = new PacingDirector(this.seed);
    this.layoutEngine = new LayoutEngine(this.seed, this.pacingDirector);
    this.pools = new EntityPools();
    this.physics = new SkiPhysics();
    this.creatureSystem = new CreatureSystem();
    this.cameraRig = new CameraRig();
    this.debugDrawBuffer = new DebugDrawBuffer();
    this.debugDrawBuffer.enabled = Boolean(options.debugDrawEnabled);

    const prevSkier = createMutableSkierPose();
    const currSkier = createMutableSkierPose();
    const surfaceSample = createSurfaceSample();

    this.trailWindow = new TrailWindow(this.seed, this.startStageId, (segment) => {
      this.onSegmentCreated(segment);
    });
    this.mountainField = new MountainField(this.trailWindow);

    this.state = {
      tickCount: 0,
      elapsedSec: 0,
      distanceM: 0,
      paused: false,
      gameMode: options.gameMode ?? 'endless',
      livesRemaining: 3,
      gameOver: false,

      skierId: this.skierDef.id,
      skierState: 'skiing',
      prevSkier,
      currSkier,
      surfaceSample,
      wipeoutTimerSec: 0,
      wipeoutDurationSec: this.skierDef.stats.wipeoutRecoverySec,
      invulnerableTimerSec: 0,
      invulnerableDurationSec: this.skierDef.stats.invulnerableSec,

      prevCamera: this.cameraRig.getReadonlyPrev(),
      currCamera: this.cameraRig.getReadonlyCurr(),

      score: 0,
      highCombo: 0,
      comboCount: 0,
      comboMultiplier: 1,
      comboTimerSec: 0,
      comboDurationSec: COMBO_DURATION_SEC,
      carriedCount: 0,
      maxCarryCapacity: Math.min(MAX_CARRY_CAPACITY, this.skierDef.stats.presentCapacity),
      carriedPresentDefIds: new Array<string>(MAX_CARRY_CAPACITY).fill(''),
      deliveredTotal: 0,

      activeStageId: this.startStageId,
      activeWeather: {
        profileId: 'weather_sunny',
        blizzardEnabled: Boolean(options.blizzardEnabled),
        blizzardIntensity: options.blizzardEnabled ? 1 : 0,
        snowParticleCount: 24,
        windLateral: 1.5,
        fogDistanceM: 145,
        blizzardDim: 0,
      },

      trailWindow: this.trailWindow,
      mountainField: this.mountainField,
      rebase: {
        rebaseCount: 0,
        offsetX: 0,
        offsetY: 0,
        offsetZ: 0,
        lastDeltaX: 0,
        lastDeltaY: 0,
        lastDeltaZ: 0,
      },
      entities: this.pools,
      debugDraw: this.debugDrawBuffer,
    };

    this.reset(this.seed, this.skierDef.id);
  }

  getState(): ReadonlySimState {
    return this.state;
  }

  setPaused(paused: boolean): void {
    this.state.paused = paused;
  }

  setBlizzardEnabled(enabled: boolean): void {
    this.state.activeWeather.blizzardEnabled = enabled;
  }

  setDebugDrawEnabled(enabled: boolean): void {
    this.debugDrawBuffer.enabled = enabled;
    if (!enabled) {
      this.debugDrawBuffer.clear();
    } else {
      this.debugDrawBuffer.update(
        this.trailWindow,
        this.pools,
        this.state.currSkier,
        this.state.surfaceSample,
      );
    }
  }

  setSkier(skierId: string): void {
    const def = getSkierDef(skierId);
    if (!def) return;
    this.skierDef = def;
    this.state.skierId = def.id;
    this.state.maxCarryCapacity = Math.min(MAX_CARRY_CAPACITY, def.stats.presentCapacity);
    this.state.wipeoutDurationSec = def.stats.wipeoutRecoverySec;
    this.state.invulnerableDurationSec = def.stats.invulnerableSec;
    if (this.state.carriedCount > this.state.maxCarryCapacity) {
      this.state.carriedCount = this.state.maxCarryCapacity;
    }
  }

  sampleSurface(
    posX: number,
    posZ: number,
    hintSegmentId = this.state.surfaceSample.segmentId,
    hintS = this.state.surfaceSample.s,
    out = createSurfaceSample(),
  ): SurfaceSample {
    return this.trailWindow.sampleSurface(posX, posZ, hintSegmentId, hintS, out);
  }

  savePreviousPoses(): void {
    copySkierPose(this.state.currSkier, this.state.prevSkier);
    this.cameraRig.capturePrevious();
    this.pools.capturePreviousPoses();
  }

  reset(seed: number | string = this.seed, skierId?: string): void {
    this.seed = seed;
    this.scatterRng = new SeededRng(seed);
    if (skierId) {
      this.setSkier(skierId);
    }

    this.pools.clear();
    this.hazardGrid.clear();
    this.presentGrid.clear();
    this.deliveryGrid.clear();
    this.physics.reset();
    this.layoutEngine.reset(seed);

    this.state.tickCount = 0;
    this.state.elapsedSec = 0;
    this.state.distanceM = 0;
    this.state.paused = false;
    this.state.livesRemaining = 3;
    this.state.gameOver = false;
    this.state.skierState = 'skiing';
    this.state.wipeoutTimerSec = 0;
    this.state.invulnerableTimerSec = 0;
    this.state.score = 0;
    this.state.highCombo = 0;
    this.state.comboCount = 0;
    this.state.comboMultiplier = 1;
    this.state.comboTimerSec = 0;
    this.state.carriedCount = 0;
    this.state.carriedPresentDefIds.fill('');
    this.state.deliveredTotal = 0;

    this.state.rebase.rebaseCount = 0;
    this.state.rebase.offsetX = 0;
    this.state.rebase.offsetY = 0;
    this.state.rebase.offsetZ = 0;
    this.state.rebase.lastDeltaX = 0;
    this.state.rebase.lastDeltaY = 0;
    this.state.rebase.lastDeltaZ = 0;
    this.mountainField.setWorldSeed(normalizeSeedUint(this.seed));
    this.mountainField.setOriginOffset(0, 0);

    // Reset trail window after clearing pools so segment creation bakes cleanly into empty pools
    this.trailWindow.reset(seed, this.startStageId);
    this.rebuildSpatialGrids();

    // Place skier cleanly on start of segment 1
    this.trailWindow.sampleSurface(0, 0, this.trailWindow.curr.id, 0, this.state.surfaceSample);
    const curr = this.state.currSkier;
    curr.posX = 0;
    curr.posY = this.state.surfaceSample.groundY;
    curr.posZ = 0;
    curr.headingRad = Math.atan2(
      -this.state.surfaceSample.tangentX,
      -this.state.surfaceSample.tangentZ,
    );
    const initSpeed = 14;
    curr.velX = this.state.surfaceSample.tangentX * initSpeed;
    curr.velY = this.state.surfaceSample.tangentY * initSpeed;
    curr.velZ = this.state.surfaceSample.tangentZ * initSpeed;
    curr.carveAngleRad = 0;
    curr.pitchRad = Math.asin(clamp(this.state.surfaceSample.tangentY, -0.9, 0.9));
    curr.speed = initSpeed;
    curr.groundY = this.state.surfaceSample.groundY;
    curr.normalX = this.state.surfaceSample.normalX;
    curr.normalY = this.state.surfaceSample.normalY;
    curr.normalZ = this.state.surfaceSample.normalZ;
    curr.grounded = true;
    curr.braking = false;
    copySkierPose(curr, this.state.prevSkier);

    this.state.activeStageId = this.trailWindow.curr.stageId;
    this.syncWeatherImmediate(this.trailWindow.curr.stage.weather);
    this.cameraRig.reset(curr, this.state.surfaceSample);
    this.debugDrawBuffer.update(this.trailWindow, this.pools, curr, this.state.surfaceSample);
  }

  step(fixedDt: number, intent: PlayerIntent): void {
    if (this.state.paused || this.state.gameOver) return;
    const dt = clamp(fixedDt, 0, 0.05);
    if (dt <= 0) return;

    this.state.tickCount++;
    this.state.elapsedSec += dt;

    if (this.state.invulnerableTimerSec > 0) {
      this.state.invulnerableTimerSec = Math.max(0, this.state.invulnerableTimerSec - dt);
    }
    if (this.state.comboTimerSec > 0) {
      this.state.comboTimerSec = Math.max(0, this.state.comboTimerSec - dt);
      if (this.state.comboTimerSec === 0) {
        this.state.comboCount = 0;
        this.state.comboMultiplier = 1;
      }
    }

    const curr = this.state.currSkier;
    const prevX = curr.posX;
    const prevZ = curr.posZ;

    // 1. Skier physics / wipeout state machine
    if (this.state.skierState === 'skiing' || this.state.skierState === 'recovering') {
      this.physics.stepSkiing(dt, intent, curr, {
        skierDef: this.skierDef,
        trailWindow: this.trailWindow,
        surface: this.state.surfaceSample,
        ramps: this.pools.ramps,
        skiTracks: this.pools.skiTracks,
      });
      if (this.state.skierState === 'recovering' && this.state.invulnerableTimerSec <= 1.2) {
        this.state.skierState = 'skiing';
      }
    } else if (this.state.skierState === 'wipeout') {
      // Slide to a halt during comical tumble, then recover onto nearest safeX world point
      const dampFactor = Math.exp(-4.5 * dt);
      curr.velX *= dampFactor;
      curr.velZ *= dampFactor;
      curr.posX += curr.velX * dt;
      curr.posZ += curr.velZ * dt;
      this.trailWindow.sampleSurface(
        curr.posX,
        curr.posZ,
        this.state.surfaceSample.segmentId,
        this.state.surfaceSample.s,
        this.state.surfaceSample,
      );
      curr.groundY = this.state.surfaceSample.groundY;
      curr.posY = curr.groundY;
      curr.normalX = this.state.surfaceSample.normalX;
      curr.normalY = this.state.surfaceSample.normalY;
      curr.normalZ = this.state.surfaceSample.normalZ;
      curr.speed = Math.hypot(curr.velX, curr.velZ);

      this.state.wipeoutTimerSec = Math.max(0, this.state.wipeoutTimerSec - dt);
      if (this.state.wipeoutTimerSec <= 0) {
        this.recoverOntoSafeX();
      }
    }

    this.state.distanceM += Math.hypot(curr.posX - prevX, curr.posZ - prevZ);

    // 2. Advance creatures, tossed presents, ski tracks, delivery celebration timers
    this.creatureSystem.step(
      dt,
      curr.posX,
      curr.posZ,
      curr.headingRad,
      this.pools.creatures,
      this.trailWindow,
      this.eventBus,
    );
    this.pools.tossedPresents.step(dt);
    this.pools.skiTracks.stepAges(dt);
    this.pools.deliveryZones.stepTimers(dt);

    // 3. Collisions, magnetic pickups & auto-toss delivery zones (when active)
    if (this.state.skierState !== 'wipeout') {
      this.checkPresentPickups();
      this.checkDeliveryZones();
      if (this.state.invulnerableTimerSec <= 0) {
        this.checkObstacleAndCreatureCollisions();
      }
    }

    // 4. Advance 4-slot TrailWindow & prune unchosen forks / old segments
    const windowResult = this.trailWindow.updateProgression(
      this.state.surfaceSample.segmentId,
      this.state.surfaceSample.s,
      DEFAULT_FORK_PRUNE_DISTANCE_M,
      curr.posX,
      curr.posZ,
    );
    if (windowResult.forkEntered) {
      this.state.activeStageId = windowResult.forkEntered.newSegment.stageId;
      this.evForkEntered.chosenSide = windowResult.forkEntered.chosenSide;
      this.evForkEntered.newSegmentId = windowResult.forkEntered.newSegment.id;
      this.evForkEntered.newStageId = windowResult.forkEntered.newSegment.stageId;
      this.evForkEntered.previousStageId = windowResult.forkEntered.previousStageId;
      this.eventBus.emit('FORK_ENTERED', this.evForkEntered);
    }
    if (windowResult.prunedIds.length > 0) {
      for (let i = 0; i < windowResult.prunedIds.length; i++) {
        const prunedId = windowResult.prunedIds[i]!;
        this.pools.pruneBySegment(prunedId);
        this.layoutEngine.pruneSegment(prunedId);
      }
      this.rebuildSpatialGrids();
    }

    // Update activeStageId continuously when on active segment
    const activeSeg = this.trailWindow.getActiveSegmentById(this.state.surfaceSample.segmentId);
    if (activeSeg) {
      this.state.activeStageId = activeSeg.stageId;
    }

    // 5. Weather transition
    this.updateWeather(dt, activeSeg ?? this.trailWindow.curr);

    // 6. Chase camera with 25m crest elevation look-ahead
    this.cameraRig.update(dt, curr, this.state.surfaceSample, this.trailWindow);

    // 7. Translation-only 128m World Floating Origin Rebase
    if (
      Math.abs(curr.posX) >= WORLD_REBASE_THRESHOLD_M ||
      Math.abs(curr.posY) >= WORLD_REBASE_THRESHOLD_M ||
      Math.abs(curr.posZ) >= WORLD_REBASE_THRESHOLD_M
    ) {
      this.performOriginRebase(curr.posX, curr.posY, curr.posZ);
    }

    // 8. Debug draw buffer update
    this.debugDrawBuffer.update(
      this.trailWindow,
      this.pools,
      curr,
      this.state.surfaceSample,
    );
  }

  private onSegmentCreated(segment: TrailSegment): void {
    if (!this.state) return;
    const startHazard = this.pools.hazards.count;
    const startPresent = this.pools.presents.count;
    const startDelivery = this.pools.deliveryZones.count;

    const fillRatio =
      this.state.maxCarryCapacity > 0
        ? this.state.carriedCount / this.state.maxCarryCapacity
        : 0;
    this.layoutEngine.bakeSegment(segment, this.pools, fillRatio);

    for (let i = startHazard; i < this.pools.hazards.count; i++) {
      this.hazardGrid.insert(
        i,
        this.pools.hazards.posX[i]!,
        this.pools.hazards.posZ[i]!,
        this.pools.hazards.radius[i]!,
      );
    }
    for (let i = startPresent; i < this.pools.presents.count; i++) {
      this.presentGrid.insert(
        i,
        this.pools.presents.posX[i]!,
        this.pools.presents.posZ[i]!,
        2.8,
      );
    }
    for (let i = startDelivery; i < this.pools.deliveryZones.count; i++) {
      this.deliveryGrid.insert(
        i,
        this.pools.deliveryZones.posX[i]!,
        this.pools.deliveryZones.posZ[i]!,
        Math.max(
          this.pools.deliveryZones.radius[i]!,
          this.pools.deliveryZones.lengthM[i]! * 0.5,
        ),
      );
    }
  }

  private rebuildSpatialGrids(): void {
    this.hazardGrid.clear();
    for (let i = 0; i < this.pools.hazards.count; i++) {
      this.hazardGrid.insert(
        i,
        this.pools.hazards.posX[i]!,
        this.pools.hazards.posZ[i]!,
        this.pools.hazards.radius[i]!,
      );
    }
    this.presentGrid.clear();
    for (let i = 0; i < this.pools.presents.count; i++) {
      if (this.pools.presents.collected[i] !== 0) continue;
      this.presentGrid.insert(
        i,
        this.pools.presents.posX[i]!,
        this.pools.presents.posZ[i]!,
        2.8,
      );
    }
    this.deliveryGrid.clear();
    for (let i = 0; i < this.pools.deliveryZones.count; i++) {
      if (this.pools.deliveryZones.active[i] === 0) continue;
      this.deliveryGrid.insert(
        i,
        this.pools.deliveryZones.posX[i]!,
        this.pools.deliveryZones.posZ[i]!,
        Math.max(
          this.pools.deliveryZones.radius[i]!,
          this.pools.deliveryZones.lengthM[i]! * 0.5,
        ),
      );
    }
  }

  private checkPresentPickups(): void {
    const magnet =
      this.skierDef.perk?.type === 'pickupMagnet' ? this.skierDef.perk.value : 1.0;
    const queryR = 3.2 * magnet;
    this.presentGrid.forEachInRadius(
      this.state.currSkier.posX,
      this.state.currSkier.posZ,
      queryR,
      this.visitPresentPickup,
    );
  }

  private checkDeliveryZones(): void {
    if (this.state.carriedCount <= 0) return;

    const sx = this.state.currSkier.posX;
    const sy = this.state.currSkier.posY;
    const sz = this.state.currSkier.posZ;
    const zones = this.pools.deliveryZones;

    for (let i = 0; i < zones.count; i++) {
      if (zones.active[i] === 0) continue;
      const zx = zones.posX[i]!;
      const zy = zones.posY[i]!;
      const zz = zones.posZ[i]!;
      const dx = sx - zx;
      const dz = sz - zz;
      const rad = zones.radius[i]!;
      const halfLen = Math.max(rad, zones.lengthM[i]! * 0.5);
      if (dx * dx + dz * dz > (rad + halfLen) * (rad + halfLen)) continue;

      const yaw = zones.yawRad[i]!;
      const fwdX = -Math.sin(yaw);
      const fwdZ = -Math.cos(yaw);
      const rightX = Math.cos(yaw);
      const rightZ = -Math.sin(yaw);
      const localLong = Math.abs(dx * fwdX + dz * fwdZ);
      const localLat = Math.abs(dx * rightX + dz * rightZ);

      if (localLat <= rad && localLong <= halfLen) {
        const defId = zones.defIds[i];
        const def = defId ? getDeliveryZoneDef(defId) : undefined;
        if (!def) continue;

        const maxAccept =
          def.maxAcceptCount === 'all' ? this.state.carriedCount : def.maxAcceptCount;
        const deliverCount = Math.min(this.state.carriedCount, maxAccept);
        if (deliverCount <= 0) continue;

        // Calculate score & escalating combo multiplier
        let baseSum = 0;
        for (let k = 0; k < deliverCount; k++) {
          const giftIdx = this.state.carriedCount - 1 - k;
          const giftId = this.state.carriedPresentDefIds[giftIdx] ?? 'gift_standard';
          const giftDef = getPresentDef(giftId);
          baseSum += giftDef ? giftDef.basePoints : 100;

          this.pools.tossedPresents.spawnArc(
            giftId,
            0,
            sx,
            sy + 1.15,
            sz,
            zx + (k - deliverCount * 0.5) * 0.35,
            zy + 0.9,
            zz,
            2.6 + k * 0.15,
            0.46,
            k * 0.045,
          );
        }

        this.state.carriedCount -= deliverCount;
        this.state.deliveredTotal += deliverCount;

        if (this.state.comboTimerSec > 0) {
          this.state.comboCount += deliverCount;
        } else {
          this.state.comboCount = deliverCount;
        }
        const stage = this.trailWindow.getActiveSegmentById(zones.segmentIds[i]!)?.stage;
        const stageMult = stage ? stage.scoreMultiplier : 1.0;
        this.state.comboMultiplier =
          1.0 +
          Math.floor(this.state.comboCount * 0.5) * 0.5 +
          deliverCount * def.comboBonusPerGift;
        this.state.comboTimerSec = this.state.comboDurationSec;
        this.state.highCombo = Math.max(this.state.highCombo, this.state.comboCount);

        const pointsAwarded = Math.round(baseSum * this.state.comboMultiplier * stageMult);
        this.state.score += pointsAwarded;

        zones.deliveredCount[i] = deliverCount;
        zones.active[i] = 0;
        zones.celebratingTimer[i] = 2.5;

        this.evDelivered.deliveryZoneId = def.id;
        this.evDelivered.countDelivered = deliverCount;
        this.evDelivered.pointsAwarded = pointsAwarded;
        this.evDelivered.comboMultiplier = this.state.comboMultiplier;
        this.evDelivered.totalScore = this.state.score;
        this.evDelivered.worldX = zx;
        this.evDelivered.worldY = zy;
        this.evDelivered.worldZ = zz;
        this.eventBus.emit('PRESENT_DELIVERED', this.evDelivered);
        return;
      }
    }
  }

  private checkObstacleAndCreatureCollisions(): void {
    const curr = this.state.currSkier;

    // 1. World-space Hazards via SpatialGrid
    this.hitHazardIndex = -1;
    this.hazardGrid.forEachInRadius(
      curr.posX,
      curr.posZ,
      this.skierDef.stats.collisionRadius + 2.5,
      this.visitHazardCollision,
    );

    if (this.hitHazardIndex >= 0) {
      const idx = this.hitHazardIndex;
      const defId = this.pools.hazards.defIds[idx];
      const def = defId ? getHazardDef(defId) : undefined;
      this.pools.hazards.triggered[idx] = 1;
      if (def) {
        this.triggerImpact(
          def.id,
          def.impact.effect === 'stumble' ? 'stumble' : 'wipeout',
          def.impact.presentsDropped,
          def.impact.speedRetention,
        );
        return;
      }
    }

    // 2. World-space Patrolling Creatures
    const creatures = this.pools.creatures;
    for (let i = 0; i < creatures.count; i++) {
      const cx = creatures.posX[i]!;
      const cz = creatures.posZ[i]!;
      const cr = creatures.radius[i]!;
      const ch = creatures.height[i]!;
      const dx = curr.posX - cx;
      const dz = curr.posZ - cz;
      const combinedR = this.skierDef.stats.collisionRadius + cr;

      if (dx * dx + dz * dz <= combinedR * combinedR) {
        const clearance = curr.posY - Math.max(creatures.groundY[i]!, this.state.surfaceSample.groundY);
        if (clearance <= ch) {
          const defId = creatures.defIds[i];
          const def = defId ? getCreatureDef(defId) : undefined;
          if (def) {
            this.triggerImpact(
              def.id,
              def.impact.effect === 'stumble' ? 'stumble' : 'wipeout',
              def.impact.presentsDropped,
              def.impact.speedRetention,
            );
            return;
          }
        }
      }
    }
  }

  private triggerImpact(
    hazardId: string,
    effect: 'wipeout' | 'stumble',
    presentsDropped: number,
    speedRetention: number,
  ): void {
    const curr = this.state.currSkier;
    const dropCount = Math.min(this.state.carriedCount, presentsDropped);

    for (let k = 0; k < dropCount; k++) {
      const giftIdx = --this.state.carriedCount;
      const giftId = this.state.carriedPresentDefIds[giftIdx] || 'gift_standard';
      const angle = this.scatterRng.nextRange(0, Math.PI * 2);
      const dist = this.scatterRng.nextRange(2.4, 5.2);
      this.pools.tossedPresents.spawnArc(
        giftId,
        1,
        curr.posX,
        curr.posY + 1.0,
        curr.posZ,
        curr.posX + Math.cos(angle) * dist,
        curr.groundY + 0.35,
        curr.posZ + Math.sin(angle) * dist,
        2.1,
        0.58,
        0,
      );
    }

    curr.velX *= speedRetention;
    curr.velZ *= speedRetention;
    curr.speed = Math.hypot(curr.velX, curr.velY, curr.velZ);

    if (effect === 'stumble') {
      this.state.invulnerableTimerSec = 0.55;
      this.evWipeout.hazardId = hazardId;
      this.evWipeout.effect = 'stumble';
      this.evWipeout.presentsDropped = dropCount;
      this.evWipeout.worldX = curr.posX;
      this.evWipeout.worldY = curr.posY;
      this.evWipeout.worldZ = curr.posZ;
      this.evWipeout.recoverySec = 0;
      this.eventBus.emit('PLAYER_WIPEOUT', this.evWipeout);
      return;
    }

    // Full cartoon wipeout
    this.state.comboCount = 0;
    this.state.comboMultiplier = 1;
    this.state.comboTimerSec = 0;
    this.state.skierState = 'wipeout';
    this.state.wipeoutDurationSec = this.skierDef.stats.wipeoutRecoverySec;
    this.state.wipeoutTimerSec = this.state.wipeoutDurationSec;

    if (this.state.gameMode === 'scoreAttack') {
      this.state.livesRemaining = Math.max(0, this.state.livesRemaining - 1);
      if (this.state.livesRemaining === 0) {
        this.state.gameOver = true;
      }
    }

    this.evWipeout.hazardId = hazardId;
    this.evWipeout.effect = 'wipeout';
    this.evWipeout.presentsDropped = dropCount;
    this.evWipeout.worldX = curr.posX;
    this.evWipeout.worldY = curr.posY;
    this.evWipeout.worldZ = curr.posZ;
    this.evWipeout.recoverySec = this.state.wipeoutDurationSec;
    this.eventBus.emit('PLAYER_WIPEOUT', this.evWipeout);
  }

  private recoverOntoSafeX(): void {
    const surface = this.state.surfaceSample;
    const seg = this.trailWindow.getActiveSegmentById(surface.segmentId) ?? this.trailWindow.curr;
    const safeX = seg.sampleSafeX(surface.s);
    seg.evaluateSurfaceAtX(surface.s, safeX, this.recoverRibbonScratch);

    this.trailWindow.sampleSurface(
      this.recoverRibbonScratch.posX,
      this.recoverRibbonScratch.posZ,
      seg.id,
      surface.s,
      this.state.surfaceSample,
    );

    const curr = this.state.currSkier;
    curr.posX = this.recoverRibbonScratch.posX;
    curr.posY = this.state.surfaceSample.groundY;
    curr.posZ = this.recoverRibbonScratch.posZ;
    curr.groundY = this.state.surfaceSample.groundY;
    curr.normalX = this.state.surfaceSample.normalX;
    curr.normalY = this.state.surfaceSample.normalY;
    curr.normalZ = this.state.surfaceSample.normalZ;
    curr.headingRad = Math.atan2(
      -this.state.surfaceSample.tangentX,
      -this.state.surfaceSample.tangentZ,
    );
    const recoverSpeed = 10.0;
    curr.velX = this.state.surfaceSample.tangentX * recoverSpeed;
    curr.velY = this.state.surfaceSample.tangentY * recoverSpeed;
    curr.velZ = this.state.surfaceSample.tangentZ * recoverSpeed;
    curr.speed = recoverSpeed;
    curr.carveAngleRad = 0;
    curr.grounded = true;
    curr.braking = false;
    this.physics.reset();

    this.state.skierState = 'skiing';
    this.state.wipeoutTimerSec = 0;
    this.state.invulnerableDurationSec = this.skierDef.stats.invulnerableSec;
    this.state.invulnerableTimerSec = this.state.invulnerableDurationSec;

    this.evRecovered.worldX = curr.posX;
    this.evRecovered.worldY = curr.posY;
    this.evRecovered.worldZ = curr.posZ;
    this.evRecovered.invulnerableSec = this.state.invulnerableTimerSec;
    this.eventBus.emit('PLAYER_RECOVERED', this.evRecovered);
  }

  private performOriginRebase(dx: number, dy: number, dz: number): void {
    const curr = this.state.currSkier;
    const prev = this.state.prevSkier;

    curr.posX -= dx;
    curr.posY -= dy;
    curr.posZ -= dz;
    curr.groundY -= dy;

    prev.posX -= dx;
    prev.posY -= dy;
    prev.posZ -= dz;
    prev.groundY -= dy;

    this.trailWindow.rebaseOrigin(dx, dy, dz);
    this.pools.shiftOrigin(dx, dy, dz);
    this.hazardGrid.shiftOrigin(dx, dz);
    this.presentGrid.shiftOrigin(dx, dz);
    this.deliveryGrid.shiftOrigin(dx, dz);
    this.cameraRig.shiftOrigin(dx, dy, dz);

    // Refresh surfaceSample groundY so it matches the shifted coordinate frame
    this.state.surfaceSample.groundY -= dy;

    this.state.rebase.rebaseCount += 1;
    this.state.rebase.offsetX += dx;
    this.state.rebase.offsetY += dy;
    this.state.rebase.offsetZ += dz;
    this.mountainField.setOriginOffset(this.state.rebase.offsetX, this.state.rebase.offsetZ);
    this.state.rebase.lastDeltaX = dx;
    this.state.rebase.lastDeltaY = dy;
    this.state.rebase.lastDeltaZ = dz;

    this.evRebased.rebaseCount = this.state.rebase.rebaseCount;
    this.evRebased.deltaX = dx;
    this.evRebased.deltaY = dy;
    this.evRebased.deltaZ = dz;
    this.evRebased.totalOffsetX = this.state.rebase.offsetX;
    this.evRebased.totalOffsetY = this.state.rebase.offsetY;
    this.evRebased.totalOffsetZ = this.state.rebase.offsetZ;
    this.eventBus.emit('WORLD_REBASED', this.evRebased);
  }

  private syncWeatherImmediate(stageWeather: WeatherProfile): void {
    const w = this.state.activeWeather;
    const target = w.blizzardEnabled ? WEATHER_BLIZZARD : stageWeather;
    w.profileId = target.id;
    w.blizzardIntensity = w.blizzardEnabled ? 1 : 0;
    w.snowParticleCount = target.snowParticleCount;
    w.windLateral = target.windLateral;
    w.fogDistanceM = Math.max(65, target.fogMinDist);
    w.blizzardDim = target.blizzardDim;
  }

  private updateWeather(dt: number, seg: TrailSegment): void {
    const w = this.state.activeWeather;
    const target = w.blizzardEnabled ? WEATHER_BLIZZARD : seg.stage.weather;
    w.profileId = target.id;
    w.blizzardIntensity = damp(w.blizzardIntensity, w.blizzardEnabled ? 1 : 0, 2.5, dt);
    w.snowParticleCount = Math.round(
      lerp(w.snowParticleCount, target.snowParticleCount, 1 - Math.exp(-3.0 * dt)),
    );
    w.windLateral = damp(w.windLateral, target.windLateral, 2.5, dt);
    w.fogDistanceM = Math.max(65, damp(w.fogDistanceM, Math.max(65, target.fogMinDist), 2.5, dt));
    w.blizzardDim = damp(w.blizzardDim, target.blizzardDim, 2.5, dt);
  }

  private requireDefaultSkier(): SkierDef {
    const skier = getSkierDef('skier_alpine');
    if (!skier) {
      throw new Error("Missing default skier definition 'skier_alpine'");
    }
    return skier;
  }
}

export function createSkiSimulation(options: SkiSimulationOptions = {}): SkiSimulation {
  return new SkiSimulation(options);
}
