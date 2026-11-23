import { clamp, degToRad } from '../core/math';
import { SeededRng } from '../core/rng';
import { SpatialGrid } from '../core/spatialGrid';
import { getCreatureDef } from '../content/creatures';
import { getDeliveryZoneDef } from '../content/deliveryZones';
import { getHazardDef, getRampDef } from '../content/hazards';
import { getPresentDef } from '../content/presents';
import type {
  DeliveryZoneDef,
  HazardDef,
  PlacementBand,
  StageCreatureRule,
  StageDeliveryRule,
  StageSpawnRule,
} from '../content/types';
import {
  createRibbonPointOut,
  createSpineFrameOut,
  type RibbonPointOut,
  type SegmentLandmarkRequirement,
  type SpineFrameOut,
} from './contracts';
import type { EntityPools } from './entityPools';
import type { TrailSegment } from './trailSegment';

export interface LayoutBakeResult {
  readonly deliveryZoneCount: number;
  readonly hazardCount: number;
  readonly presentCount: number;
  readonly creatureCount: number;
  readonly rampCount: number;
}

/**
 * Coordinates delivery cadence across fork boundaries and accelerates Delivery Zone spawns
 * when the skier's backpack is >= 75% full.
 */
export class PacingDirector {
  private readonly endDeliveryGapBySegment = new Map<number, number>();
  private rng: SeededRng;

  constructor(seed: number | string = 1) {
    this.rng = new SeededRng(seed);
  }

  reset(seed: number | string): void {
    this.rng = new SeededRng(seed);
    this.endDeliveryGapBySegment.clear();
  }

  pruneSegment(segmentId: number): void {
    this.endDeliveryGapBySegment.delete(segmentId);
  }

  /**
   * Computes local s-positions along `segment` where guaranteed Delivery Zones spawn,
   * preserving 150-220m cadence across forks and accelerating when backpack fill >= 75%.
   */
  planDeliveryPositions(
    segment: TrailSegment,
    backpackFillRatio: number,
    outPositions: number[],
  ): void {
    outPositions.length = 0;

    const prevGap =
      segment.prevSegmentId !== null
        ? (this.endDeliveryGapBySegment.get(segment.prevSegmentId) ?? 35)
        : 35;

    const [baseMin, baseMax] = segment.stage.layout.deliveryCadenceM;
    const accelerated = backpackFillRatio >= 0.75;
    const minCadence = accelerated ? Math.max(95, baseMin * 0.65) : Math.max(150, baseMin);
    const maxCadence = accelerated ? Math.max(135, baseMax * 0.68) : Math.min(220, baseMax);

    const segRng = this.rng.fork(`deliv_${segment.id}`);
    const minStartS = segment.fork.isForkChild ? 28 : 26;
    const maxEndS = segment.fork.hasFork
      ? Math.max(minStartS + 10, segment.fork.obstacleFreeStartS - 5)
      : segment.length - 20;

    let lastPlacedS = -prevGap;
    let targetGap = segRng.nextRange(minCadence, maxCadence);
    let candidateS = lastPlacedS + targetGap;

    while (candidateS <= maxEndS) {
      let clampedS = clamp(candidateS, minStartS, maxEndS);
      // If no second zone will fit after clampedS, nudge forward if needed so endGap <= 188m
      if (
        !accelerated &&
        segment.length - clampedS > 188 &&
        maxEndS - clampedS < minCadence
      ) {
        const desiredTailS = segment.length - 188;
        if (desiredTailS - lastPlacedS <= maxCadence && desiredTailS <= maxEndS) {
          clampedS = Math.max(clampedS, desiredTailS);
        }
      }

      if (clampedS - lastPlacedS >= (accelerated ? 70 : 145)) {
        outPositions.push(clampedS);
        lastPlacedS = clampedS;
      }
      targetGap = segRng.nextRange(minCadence, maxCadence);
      candidateS = lastPlacedS + targetGap;
    }

    // Ensure gap through end of segment stays within cadence on the next segment
    const tailGap = segment.length - lastPlacedS;
    if (tailGap > 188 && maxEndS - lastPlacedS >= minCadence) {
      const safetyS = clamp(
        lastPlacedS + segRng.nextRange(minCadence, Math.min(maxCadence, maxEndS - lastPlacedS)),
        minStartS,
        maxEndS,
      );
      if (safetyS - lastPlacedS >= minCadence) {
        outPositions.push(safetyS);
        lastPlacedS = safetyS;
      }
    }

    this.endDeliveryGapBySegment.set(segment.id, Math.max(0, segment.length - lastPlacedS));
  }
}

interface RampWindow {
  readonly startS: number;
  readonly endS: number;
}

/**
 * Multi-track declarative layout engine baking placements once via trackToWorld(s, x)
 * into authoritative World Space (X, Y, Z) while enforcing safeX, post-brow, and fork runway invariants.
 */
export class LayoutEngine {
  private readonly pacing: PacingDirector;
  private rng: SeededRng;

  private readonly segmentOccupationGrid = new SpatialGrid<number>(12);
  private readonly scratchFrame: SpineFrameOut = createSpineFrameOut();
  private readonly scratchRibbon: RibbonPointOut = createRibbonPointOut();
  private readonly deliverySBuffer: number[] = [];
  private readonly rampWindows: RampWindow[] = [];

  constructor(seed: number | string = 1, pacing?: PacingDirector) {
    this.rng = new SeededRng(seed);
    this.pacing = pacing ?? new PacingDirector(seed);
  }

  reset(seed: number | string): void {
    this.rng = new SeededRng(seed);
    this.pacing.reset(seed);
    this.segmentOccupationGrid.clear();
  }

  pruneSegment(segmentId: number): void {
    this.pacing.pruneSegment(segmentId);
  }

  bakeSegment(
    segment: TrailSegment,
    pools: EntityPools,
    backpackFillRatio: number,
  ): LayoutBakeResult {
    const segRng = this.rng.fork(segment.id * 97 + 13);
    this.segmentOccupationGrid.clear();
    this.rampWindows.length = 0;

    let deliveryZoneCount = 0;
    let hazardCount = 0;
    let presentCount = 0;
    let creatureCount = 0;
    let rampCount = 0;

    const minContentS = segment.fork.isForkChild ? 20 : 22;
    const maxHazardS = segment.fork.hasFork
      ? segment.fork.obstacleFreeStartS - 2
      : segment.length - 12;

    // 1. Guaranteed Delivery Zones (+ SegmentLandmarkRequirement)
    this.pacing.planDeliveryPositions(segment, backpackFillRatio, this.deliverySBuffer);
    for (let i = 0; i < this.deliverySBuffer.length; i++) {
      const s = this.deliverySBuffer[i]!;
      const rule = this.pickWeightedDeliveryRule(segment.stage.layout.deliveryZones, segRng);
      const def = rule ? getDeliveryZoneDef(rule.deliveryZoneId) : getDeliveryZoneDef('child_solo');
      if (!def) continue;

      if (this.placeDeliveryZone(segment, def, s, segRng, pools)) {
        deliveryZoneCount++;
      }
    }

    // 2. Explicit Playable Ski Ramps
    const rampDef = getRampDef('ski_ramp_standard');
    if (rampDef && maxHazardS > minContentS + 40) {
      const rampSlotSpan = 75;
      for (let slotS = minContentS + 24; slotS < maxHazardS - 32; slotS += rampSlotSpan) {
        if (!segRng.nextBool(segment.stage.terrain.rampChance)) continue;
        const s = clamp(slotS + segRng.nextRange(-10, 10), minContentS + 10, maxHazardS - 30);
        segment.sampleSpineFrame(s, this.scratchFrame);
        const safeX = segment.sampleSafeX(s);
        const x = clamp(
          safeX + segRng.nextRange(-3.2, 3.2),
          -(this.scratchFrame.halfWidth - 3.5),
          this.scratchFrame.halfWidth - 3.5,
        );
        if (Math.abs(x) < this.scratchFrame.dividerHalfWidth + 2.5) continue;

        segment.evaluateSurfaceAtX(s, x, this.scratchRibbon);
        if (this.segmentOccupationGrid.hasOverlap(this.scratchRibbon.posX, this.scratchRibbon.posZ, 10)) {
          continue;
        }
        const idx = pools.ramps.add(
          rampDef.id,
          segment.id,
          this.scratchRibbon.posX,
          this.scratchRibbon.posY,
          this.scratchRibbon.posZ,
          this.scratchFrame.yawRad,
          this.scratchFrame.pitchRad,
          rampDef.width,
          rampDef.length,
          rampDef.height,
          rampDef.lipPitchBoostDeg,
        );
        if (idx >= 0) {
          this.segmentOccupationGrid.insert(idx, this.scratchRibbon.posX, this.scratchRibbon.posZ, 8);
          this.rampWindows.push({ startS: s - 4, endS: s + 28 });
          rampCount++;
        }
      }
    }

    // 3. Static Hazards Track (enforcing safeX +/- 2.5m, post-brow, and 50m fork runway clearance)
    const obstacleRules = segment.stage.layout.obstacles;
    if (obstacleRules.length > 0 && maxHazardS > minContentS + 20) {
      let cursorS = minContentS + 8;
      while (cursorS < maxHazardS - 6) {
        const rule = this.pickWeightedSpawnRule(obstacleRules, segRng);
        if (!rule) break;
        const hazardDef = getHazardDef(rule.targetId);
        if (!hazardDef) {
          cursorS += 24;
          continue;
        }
        const count = segRng.nextInt(rule.countRange[0], rule.countRange[1] + 1);
        const baseSpacing = segRng.nextRange(rule.spacingM[0], rule.spacingM[1]);
        const placed = this.placeHazardPattern(
          segment,
          rule,
          hazardDef,
          cursorS,
          maxHazardS,
          count,
          baseSpacing,
          segRng,
          pools,
        );
        hazardCount += placed;
        cursorS += Math.max(24, baseSpacing * Math.max(1, count * 0.65));
      }
    }

    // 4. Presents Track (onPath / slalom sequences & golden lines)
    const presentRules = segment.stage.layout.presents;
    if (presentRules.length > 0) {
      let cursorS = 24;
      const maxPresentS = segment.length - 18;
      while (cursorS < maxPresentS) {
        const rule = this.pickWeightedSpawnRule(presentRules, segRng);
        if (!rule) break;
        const presentDef = getPresentDef(rule.targetId);
        if (!presentDef) {
          cursorS += 28;
          continue;
        }
        const count = segRng.nextInt(rule.countRange[0], rule.countRange[1] + 1);
        const stepS = segRng.nextRange(rule.spacingM[0], rule.spacingM[1]);
        const laneDir = segRng.nextBool(0.5) ? 1 : -1;

        for (let i = 0; i < count; i++) {
          const s = cursorS + i * stepS;
          if (s >= maxPresentS) break;
          segment.sampleSpineFrame(s, this.scratchFrame);
          const hw = this.scratchFrame.halfWidth;
          const x = this.sampleBandX(
            segment,
            s,
            hw,
            this.scratchFrame.dividerHalfWidth,
            rule.band,
            laneDir,
            segRng,
          );
          segment.evaluateSurfaceAtX(s, x, this.scratchRibbon);
          if (
            this.segmentOccupationGrid.hasOverlap(
              this.scratchRibbon.posX,
              this.scratchRibbon.posZ,
              2.6,
            )
          ) {
            continue;
          }
          const idx = pools.presents.add(
            presentDef.id,
            segment.id,
            this.scratchRibbon.posX,
            this.scratchRibbon.posY + 0.65,
            this.scratchRibbon.posZ,
            segRng.nextRange(0, Math.PI * 2),
          );
          if (idx >= 0) {
            presentCount++;
          }
        }
        cursorS += count * stepS + segRng.nextRange(28, 46);
      }
    }

    // 5. World-Space Creature Spawns (Bear Patrol)
    const creatureRules = segment.stage.layout.creatures;
    if (creatureRules.length > 0 && maxHazardS > minContentS + 45) {
      const rule = this.pickWeightedCreatureRule(creatureRules, segRng);
      const creatureDef = rule ? getCreatureDef(rule.creatureId) : undefined;
      if (rule && creatureDef) {
        let placedForSeg = 0;
        let cursorS = minContentS + 45;
        while (cursorS < maxHazardS - 18 && placedForSeg < rule.maxPerSegment) {
          const s = clamp(cursorS, minContentS + 30, maxHazardS - 14);
          if (!this.isInsideRampWindow(s)) {
            segment.sampleSpineFrame(s, this.scratchFrame);
            const hw = this.scratchFrame.halfWidth;
            const side = segRng.nextBool(0.5) ? 1 : -1;
            const x = clamp(
              side * hw * 0.55,
              -(hw - 2.5),
              hw - 2.5,
            );
            segment.evaluateSurfaceAtX(s, x, this.scratchRibbon);
            if (
              !this.segmentOccupationGrid.hasOverlap(
                this.scratchRibbon.posX,
                this.scratchRibbon.posZ,
                6.0,
              )
            ) {
              const heading = this.scratchFrame.yawRad + (side > 0 ? Math.PI * 0.5 : -Math.PI * 0.5);
              const idx = pools.creatures.add(
                creatureDef.id,
                segment.id,
                this.scratchRibbon.posX,
                this.scratchRibbon.posY,
                this.scratchRibbon.posZ,
                this.scratchRibbon.normalX,
                this.scratchRibbon.normalY,
                this.scratchRibbon.normalZ,
                heading,
                creatureDef.collider.radius,
                creatureDef.collider.height,
                s,
                side > 0 ? -1 : 1,
              );
              if (idx >= 0) {
                creatureCount++;
                placedForSeg++;
              }
            }
          }
          cursorS += segRng.nextRange(rule.spacingM[0], rule.spacingM[1]);
        }
      }
    }

    return {
      deliveryZoneCount,
      hazardCount,
      presentCount,
      creatureCount,
      rampCount,
    };
  }

  private placeDeliveryZone(
    segment: TrailSegment,
    def: DeliveryZoneDef,
    s: number,
    rng: SeededRng,
    pools: EntityPools,
  ): boolean {
    segment.sampleSpineFrame(s, this.scratchFrame);
    const hw = this.scratchFrame.halfWidth;
    const safeX = segment.sampleSafeX(s);
    const side: 1 | -1 = safeX >= 0 ? -1 : 1;
    // Place children near safeX within deliveryRadius (7.5-9.0m) so safeX stays inside zone
    const zoneX = clamp(safeX + side * 4.2, -(hw - 2.4), hw - 2.4);

    segment.evaluateSurfaceAtX(s, zoneX, this.scratchRibbon);
    const zoneYaw = this.scratchFrame.yawRad + side * 0.45;

    const idx = pools.deliveryZones.add(
      def.id,
      segment.id,
      this.scratchRibbon.posX,
      this.scratchRibbon.posY,
      this.scratchRibbon.posZ,
      zoneYaw,
      def.deliveryRadius,
      def.deliveryLength,
    );
    if (idx < 0) return false;

    this.segmentOccupationGrid.insert(
      idx,
      this.scratchRibbon.posX,
      this.scratchRibbon.posZ,
      def.deliveryRadius + 2.5,
    );

    // Emit SegmentLandmarkRequirement for ChunkStreamer (cabin/lantern/arch beside children)
    const landmarkX = clamp(zoneX + side * 3.0, -(hw + 2.0), hw + 2.0);
    segment.evaluateSurfaceAtX(s, landmarkX, this.scratchRibbon);
    const landmarkReq: SegmentLandmarkRequirement = {
      id: `deliv_lm_${segment.id}_${Math.round(s)}_${rng.nextInt(100, 999)}`,
      kind: 'deliveryLandmark',
      segmentId: segment.id,
      chunkIndex: Math.floor(s / segment.chunkLength),
      s,
      x: landmarkX,
      worldX: this.scratchRibbon.posX,
      worldY: this.scratchRibbon.posY,
      worldZ: this.scratchRibbon.posZ,
      yawRad: this.scratchFrame.yawRad + side * 0.35,
      clearanceRadius: 4.5,
      visual: def.landmarkVisual,
    };
    segment.addLandmarkRequirement(landmarkReq);
    this.segmentOccupationGrid.insert(
      idx,
      this.scratchRibbon.posX,
      this.scratchRibbon.posZ,
      4.5,
    );

    return true;
  }

  private placeHazardPattern(
    segment: TrailSegment,
    rule: StageSpawnRule,
    hazardDef: HazardDef,
    startS: number,
    maxS: number,
    count: number,
    spacing: number,
    rng: SeededRng,
    pools: EntityPools,
  ): number {
    let placed = 0;
    const baseSide = rng.nextBool(0.5) ? 1 : -1;

    for (let i = 0; i < count; i++) {
      const s = startS + i * (rule.pattern === 'gate' ? spacing * 0.4 : spacing * 0.65);
      if (s >= maxS) break;
      if (hazardDef.lethal && (segment.isNearCrestPocket(s) || this.isInsideRampWindow(s))) {
        continue;
      }

      segment.sampleSpineFrame(s, this.scratchFrame);
      const hw = this.scratchFrame.halfWidth;
      const divHw = this.scratchFrame.dividerHalfWidth;
      const safeX = segment.sampleSafeX(s);

      let x = 0;
      if (rule.pattern === 'gate') {
        // Gate frames safeX on left and right sides with wide safe clearance
        const gateSide = i % 2 === 0 ? -1 : 1;
        const minClear = Math.max(3.2, rule.minSafeClearanceM + hazardDef.collider.radius);
        x = safeX + gateSide * (minClear + rng.nextRange(0.4, 2.8));
      } else if (rule.pattern === 'staggered') {
        const stagSide = i % 2 === 0 ? baseSide : -baseSide;
        x = this.sampleBandX(segment, s, hw, divHw, rule.band, stagSide, rng);
      } else if (rule.pattern === 'cluster') {
        x = this.sampleBandX(segment, s, hw, divHw, rule.band, baseSide, rng) + rng.nextRange(-2, 2);
      } else {
        x = this.sampleBandX(segment, s, hw, divHw, rule.band, baseSide, rng);
      }

      x = clamp(x, -(hw + 1.0), hw + 1.0);
      if (divHw > 0.1 && Math.abs(x) < divHw + 1.2) {
        continue;
      }

      // Enforce hard safeX clearance for lethal hazards (>= 2.5m + collider radius)
      const distFromSafe = Math.abs(x - safeX);
      if (hazardDef.lethal) {
        const requiredClearance = Math.max(2.5, rule.minSafeClearanceM) + hazardDef.collider.radius;
        if (distFromSafe < requiredClearance) {
          const pushSign = x >= safeX ? 1 : -1;
          const nudgedX = safeX + pushSign * (requiredClearance + 0.5);
          if (Math.abs(nudgedX) <= hw + 0.5) {
            x = nudgedX;
          } else {
            const altX = safeX - pushSign * (requiredClearance + 0.5);
            if (Math.abs(altX) <= hw + 0.5) {
              x = altX;
            } else {
              continue;
            }
          }
        }
      } else if (rule.band !== 'onPath' && distFromSafe < rule.minSafeClearanceM) {
        continue;
      }

      segment.evaluateSurfaceAtX(s, x, this.scratchRibbon);
      const minGap = hazardDef.collider.radius + 2.4;
      if (
        this.segmentOccupationGrid.hasOverlap(
          this.scratchRibbon.posX,
          this.scratchRibbon.posZ,
          minGap,
        )
      ) {
        continue;
      }

      const scale =
        hazardDef.visual.kind === 'procedural' && hazardDef.visual.scale !== undefined
          ? hazardDef.visual.scale
          : 1.0;
      const yaw =
        hazardDef.id === 'pine_tree'
          ? rng.nextRange(0, Math.PI * 2)
          : this.scratchFrame.yawRad + rng.nextRange(-0.8, 0.8);

      const idx = pools.hazards.add(
        hazardDef.id,
        segment.id,
        this.scratchRibbon.posX,
        this.scratchRibbon.posY,
        this.scratchRibbon.posZ,
        this.scratchRibbon.normalX,
        this.scratchRibbon.normalY,
        this.scratchRibbon.normalZ,
        yaw,
        scale * rng.nextRange(0.92, 1.08),
        hazardDef.collider.radius,
        hazardDef.collider.height,
        hazardDef.lethal,
      );

      if (idx >= 0) {
        this.segmentOccupationGrid.insert(
          idx,
          this.scratchRibbon.posX,
          this.scratchRibbon.posZ,
          hazardDef.collider.radius + 1.5,
        );
        placed++;
      }
    }
    return placed;
  }

  private sampleBandX(
    segment: TrailSegment,
    s: number,
    hw: number,
    divHw: number,
    band: PlacementBand,
    sideSign: number,
    rng: SeededRng,
  ): number {
    const safeX = segment.sampleSafeX(s);
    switch (band) {
      case 'onPath':
        return clamp(safeX + rng.nextRange(-1.4, 1.4), -(hw - 1.5), hw - 1.5);
      case 'slalom':
        return clamp(
          safeX + sideSign * rng.nextRange(3.2, Math.max(4.0, hw * 0.55)),
          -(hw - 1.5),
          hw - 1.5,
        );
      case 'nearEdge':
        return sideSign * rng.nextRange(Math.max(divHw + 2.0, hw * 0.62), Math.max(divHw + 2.5, hw - 1.0));
      case 'offPiste':
        return sideSign * rng.nextRange(hw + 0.5, hw + 4.0);
      case 'middle':
      default:
        return rng.nextRange(-(hw * 0.72), hw * 0.72);
    }
  }

  private isInsideRampWindow(s: number): boolean {
    for (let i = 0; i < this.rampWindows.length; i++) {
      const rw = this.rampWindows[i]!;
      if (s >= rw.startS && s <= rw.endS) return true;
    }
    return false;
  }

  private pickWeightedSpawnRule(
    rules: readonly StageSpawnRule[],
    rng: SeededRng,
  ): StageSpawnRule | undefined {
    return rng.pickWeighted(rules, (r) => r.weight);
  }

  private pickWeightedDeliveryRule(
    rules: readonly StageDeliveryRule[],
    rng: SeededRng,
  ): StageDeliveryRule | undefined {
    return rng.pickWeighted(rules, (r) => r.weight);
  }

  private pickWeightedCreatureRule(
    rules: readonly StageCreatureRule[],
    rng: SeededRng,
  ): StageCreatureRule | undefined {
    return rng.pickWeighted(rules, (r) => r.weight);
  }
}

export { degToRad };
