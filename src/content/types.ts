/**
 * Pure declarative content schemas for skigame.
 * Zero Three.js imports, zero DOM imports, zero simulation imports.
 */

export type SurfaceType = 'packed' | 'powder' | 'ice';

export type ProceduralVisualPreset =
  | 'pine'
  | 'boulder'
  | 'present'
  | 'ramp'
  | 'arch'
  | 'lantern'
  | 'skier'
  | 'bear'
  | 'child'
  | 'cabin';

export type VisualSpec =
  | {
      readonly kind: 'mesh';
      readonly modelId: string;
      readonly scale?: number;
      readonly yawOffset?: number;
      readonly outline?: boolean;
    }
  | {
      readonly kind: 'billboard';
      readonly atlasId: string;
      readonly frame: string;
      readonly width: number;
      readonly height: number;
      readonly outlineTint?: string;
    }
  | {
      readonly kind: 'procedural';
      readonly preset: ProceduralVisualPreset;
      readonly palette: readonly string[];
      readonly scale?: number;
      readonly variant?: string;
      readonly outline?: boolean;
    };

export interface StageTerrainProfile {
  /** Downhill slope pitch range in degrees (positive magnitudes, e.g. [10, 15]). */
  readonly pitchDeg: readonly [min: number, max: number];
  /** Spine horizontal curvature range, strictly clamped by |k| * (halfWidth + skirtWidth) <= 0.4. */
  readonly curveStrength: readonly [min: number, max: number];
  /** Playable corridor half-width range in meters. */
  readonly halfWidth: readonly [min: number, max: number];
  /** Outer scenic snowbank & flank skirt width beyond halfWidth in meters. */
  readonly skirtWidth: number;
  /** Subtle terrain bank angle factor into turns. */
  readonly bankingFactor: number;
  /** Bumpiness amplitude ratio (0..1). */
  readonly mogulDensity: number;
  /** Probability (0..1) of low-grip ice surface patches. */
  readonly icePatchChance: number;
  /** Probability (0..1) of deep-powder surface patches. */
  readonly powderPatchChance: number;
  /** Spatial frequency (cycles/meter) of downhill rollers/crests. */
  readonly rollerFrequency: number;
  /** Vertical amplitude (meters) of downhill rollers/crests. */
  readonly rollerAmplitude: number;
  /** Probability (0..1) of spawning authored ski jump ramps per candidate slot. */
  readonly rampChance: number;
}

export interface WeatherProfile {
  readonly id: string;
  /** Scales camera-local snow-streak instanced pool (0..250). */
  readonly snowParticleCount: number;
  /** Lateral wind drift speed for falling snow particles (m/s). */
  readonly windLateral: number;
  /** Near fog start distance, clamped >= 65m for ~2.5s reaction window at peak speed. */
  readonly fogMinDist: number;
  /** Far fog distance in meters. */
  readonly fogMaxDist: number;
  /** Shared tint dim factor applied uniformly to 3D and 2.5D assets (0..1). */
  readonly blizzardDim: number;
  /** Duration range for weather pulses in seconds. */
  readonly durationRangeSec: readonly [min: number, max: number];
}

export type LayoutPattern = 'scatter' | 'sequence' | 'staggered' | 'gate' | 'cluster';

export type PlacementBand = 'onPath' | 'slalom' | 'nearEdge' | 'middle' | 'offPiste';

export interface StageSpawnRule {
  readonly targetId: string;
  readonly weight: number;
  readonly pattern: LayoutPattern;
  readonly band: PlacementBand;
  readonly countRange: readonly [min: number, max: number];
  readonly spacingM: readonly [min: number, max: number];
  readonly minSafeClearanceM: number;
}

export interface StageCreatureRule {
  readonly creatureId: string;
  readonly weight: number;
  readonly band: PlacementBand;
  readonly spacingM: readonly [min: number, max: number];
  readonly maxPerSegment: number;
}

export interface StageDeliveryRule {
  readonly deliveryZoneId: string;
  readonly weight: number;
  readonly band: PlacementBand;
}

export interface StageSceneryConfig {
  readonly pineDensity: number;
  readonly rockDensity: number;
  readonly groundMinRadius: number;
  readonly canopyMinRadius: number;
}

export interface StagePalette {
  readonly skyTop: string;
  readonly skyBottom: string;
  readonly fogColor: string;
  readonly snowColor: string;
  readonly shadowSnowTint: string;
  readonly bankTint: string;
  readonly iceTint: string;
  readonly powderTint: string;
  readonly sunColor: string;
  readonly ambientColor: string;
  readonly biomeTint: string;
}

export interface StageBadge {
  readonly shape: 'circle' | 'square' | 'diamond';
  readonly color: string;
  readonly label: string;
}

export interface StageLayoutConfig {
  readonly segmentLengthRange: readonly [min: number, max: number];
  readonly forkIntervalM: readonly [min: number, max: number];
  readonly islandDividerChance: number;
  readonly deliveryCadenceM: readonly [min: number, max: number];
  readonly obstacles: readonly StageSpawnRule[];
  readonly presents: readonly StageSpawnRule[];
  readonly deliveryZones: readonly StageDeliveryRule[];
  readonly creatures: readonly StageCreatureRule[];
  readonly scenery: StageSceneryConfig;
}

export interface StageDef {
  readonly id: string;
  readonly name: string;
  readonly subtitle: string;
  readonly difficulty: 'green' | 'blue' | 'black';
  readonly pacingRole: 'breather' | 'intense';
  readonly scoreMultiplier: number;
  readonly badge: StageBadge;
  readonly terrain: StageTerrainProfile;
  readonly weather: WeatherProfile;
  readonly palette: StagePalette;
  readonly surfaceWeights: Readonly<Record<SurfaceType, number>>;
  readonly layout: StageLayoutConfig;
  readonly forkTargets: readonly string[];
}

export type HazardImpactEffect = 'wipeout' | 'stumble' | 'slow' | 'launch';

export interface HazardDef {
  readonly id: string;
  readonly name: string;
  readonly visual: VisualSpec;
  readonly collider: {
    readonly shape: 'cylinder' | 'box';
    readonly radius: number;
    /** Skier clears cleanly when (posY - groundY) > height. */
    readonly height: number;
  };
  readonly impact: {
    readonly effect: HazardImpactEffect;
    readonly presentsDropped: number;
    readonly speedRetention: number;
  };
  /** True for static wipeout hazards that must respect safeX +/- 2.5m and post-brow clearance. */
  readonly lethal: boolean;
}

export interface RampDef {
  readonly id: string;
  readonly name: string;
  readonly visual: VisualSpec;
  readonly width: number;
  readonly length: number;
  readonly height: number;
  readonly lipPitchBoostDeg: number;
}

export type CreatureBehaviorConfig =
  | {
      readonly type: 'bearPatrol';
      readonly crossSpeed: number;
      readonly lungeRadius: number;
      readonly telegraphSec: number;
    }
  | {
      readonly type: 'ogreThrower';
      readonly projectileSpeed: number;
      readonly throwCooldownSec: number;
      readonly minLeadDist: number;
    }
  | {
      readonly type: 'yetiFlankAmbush';
      readonly triggerDist: number;
      readonly flankOffsetX: number;
      readonly speedMatchFactor: number;
    };

export interface CreatureDef extends HazardDef {
  readonly behavior: CreatureBehaviorConfig;
  readonly telegraph: {
    readonly soundId: string;
    readonly warningRange: number;
    readonly glowEyeColor?: string;
    readonly showEdgeIndicator?: boolean;
  };
}

export interface PresentDef {
  readonly id: string;
  readonly name: string;
  readonly visual: VisualSpec;
  /** Points awarded upon delivery to a DeliveryZone. */
  readonly basePoints: number;
  /** Small immediate grab feedback points. */
  readonly pickupPoints: number;
  /** Slots occupied on the skier's backpack stack. */
  readonly bagWeight: number;
  /** Generous magnetic pickup radius in meters. */
  readonly pickupRadius: number;
  /** Fog-piercing ribbon/aura tint. */
  readonly glowColor: string;
}

export interface DeliveryZoneDef {
  readonly id: string;
  readonly name: string;
  readonly maxAcceptCount: number | 'all';
  /** Generous auto-toss trigger radius in meters (~7m). */
  readonly deliveryRadius: number;
  /** Elongated trigger length along the trail in meters (~16m). */
  readonly deliveryLength: number;
  /** Multiplier bonus added per simultaneous delivered gift. */
  readonly comboBonusPerGift: number;
  readonly childVisuals: readonly VisualSpec[];
  readonly landmarkVisual: VisualSpec;
  readonly requiredSceneryId?: string;
}

export type SkierPerk =
  | { readonly type: 'pickupMagnet'; readonly value: number }
  | { readonly type: 'iceGrip'; readonly value: number }
  | { readonly type: 'yetiRepellent'; readonly value: number };

export interface SkierDef {
  readonly id: string;
  readonly name: string;
  readonly visual: VisualSpec;
  readonly stats: {
    readonly maxSpeed: number;
    readonly carveGrip: number;
    readonly jumpImpulse: number;
    readonly presentCapacity: number;
    readonly wipeoutRecoverySec: number;
    readonly invulnerableSec: number;
    readonly collisionRadius: number;
    readonly skierHeight: number;
  };
  readonly perk?: SkierPerk;
}
