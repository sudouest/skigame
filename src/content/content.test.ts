import { describe, expect, it } from 'vitest';
import {
  CAMERA_FRAMING_TUNING,
  CHARACTER_SCALE_TUNING,
  CREATURES,
  DEFAULT_SCENERY_TIER_RULES,
  DEFAULT_VISIBILITY_TUNING,
  DELIVERY_ZONES,
  HAZARDS,
  LEGACY_CAMERA_FRAMING_TUNING,
  OUTLINE_VISIBILITY_TUNING,
  PORTRAIT_FOV_TUNING,
  PRESENTS,
  RAMPS,
  RAMP_GENTLE,
  RAMP_STANDARD,
  RAMP_STEEP,
  SKIERS,
  STAGES,
  WEATHER_PROFILES,
  computePortraitAspectFactor,
  extractVisualScale,
  getAllStages,
  getCreatureDef,
  getDeliveryZoneDef,
  getHazardDef,
  getPresentDef,
  getRampDef,
  getSkierDef,
  getStageDef,
  resolveActiveCameraFraming,
  resolveChildScaleMultiplier,
  resolveChildSlotSpreadMultiplier,
  resolveCreatureScaleMultiplier,
  resolveSkierVisualScale,
} from './index';

describe('content registries & invariants', () => {
  it('exposes all 5 forkable stages covering every landscape archetype, difficulty badge, and weather profile', () => {
    const allStages = getAllStages();
    expect(allStages).toHaveLength(5);

    const powder = getStageDef('powder-bowl');
    const sunny = getStageDef('sunny-blue');
    const gorge = getStageDef('granite-gorge');
    const icy = getStageDef('icy-black');
    const blizzard = getStageDef('blizzard-ridge');

    expect(powder).toBeDefined();
    expect(sunny).toBeDefined();
    expect(gorge).toBeDefined();
    expect(icy).toBeDefined();
    expect(blizzard).toBeDefined();

    for (const stage of allStages) {
      expect(STAGES[stage.id]).toBe(stage);
      expect(stage.forkTargets.length).toBeGreaterThanOrEqual(2);
      for (const targetId of stage.forkTargets) {
        expect(STAGES[targetId]).toBeDefined();
      }
    }

    // Coverage across all 3 badge shapes & difficulties
    expect(new Set(allStages.map((s) => s.badge.shape))).toEqual(
      new Set(['circle', 'square', 'diamond']),
    );
    expect(new Set(allStages.map((s) => s.difficulty))).toEqual(
      new Set(['green', 'blue', 'black']),
    );

    // Coverage across all 4 landscape archetypes
    const archetypes = new Set<string>();
    for (const stage of allStages) {
      archetypes.add(stage.landscape.left.archetype);
      archetypes.add(stage.landscape.right.archetype);
    }
    expect(archetypes).toEqual(
      new Set(['rollingHills', 'alpineBowl', 'canyonWalls', 'chasm']),
    );

    // Coverage across all 3 weather profiles
    expect(new Set(allStages.map((s) => s.weather.id))).toEqual(
      new Set(['weather_sunny', 'weather_crisp_mountain', 'weather_blizzard']),
    );

    // Contrasting gameplay characteristics
    expect(sunny!.terrain.halfWidth[0]).toBeGreaterThan(icy!.terrain.halfWidth[1]);
    expect(icy!.terrain.pitchDeg[0]).toBeGreaterThan(sunny!.terrain.pitchDeg[1]);
    expect(icy!.terrain.icePatchChance).toBeGreaterThan(sunny!.terrain.icePatchChance);
    expect(icy!.terrain.rampChance).toBeGreaterThan(sunny!.terrain.rampChance);
    expect(icy!.scoreMultiplier).toBeGreaterThan(sunny!.scoreMultiplier);
    expect(powder!.landscape.left.archetype).toBe('alpineBowl');
    expect(powder!.landscape.right.archetype).toBe('alpineBowl');
    expect(gorge!.landscape.left.archetype).toBe('canyonWalls');
    expect(gorge!.landscape.right.archetype).toBe('canyonWalls');
    expect(icy!.landscape.left.archetype).toBe('canyonWalls');
    expect(icy!.landscape.right.archetype).toBe('chasm');
    expect(blizzard!.landscape.left.archetype).toBe('chasm');
    expect(blizzard!.landscape.right.archetype).toBe('alpineBowl');
  });

  it('satisfies terrain patch probabilities, landscape profiles, palette hex colors, and scenery tier rule invariants', () => {
    const hexColorRegex = /^#[0-9a-fA-F]{6}$/;
    const validArchetypes = new Set(['rollingHills', 'alpineBowl', 'canyonWalls', 'chasm']);

    expect(DEFAULT_SCENERY_TIER_RULES.length).toBeGreaterThanOrEqual(5);
    for (const rule of DEFAULT_SCENERY_TIER_RULES) {
      expect(rule.minNormalY).toBeGreaterThanOrEqual(0.72);
      expect(rule.normalYSpread).toBeGreaterThan(0);
      expect(rule.widthRange[1]).toBeGreaterThanOrEqual(rule.widthRange[0]);
      expect(rule.heightRange[1]).toBeGreaterThanOrEqual(rule.heightRange[0]);
    }

    for (const stage of getAllStages()) {
      expect(stage.terrain.icePatchChance).toBeGreaterThanOrEqual(0);
      expect(stage.terrain.powderPatchChance).toBeGreaterThanOrEqual(0);
      expect(
        stage.terrain.icePatchChance + stage.terrain.powderPatchChance,
      ).toBeLessThanOrEqual(1);

      expect(stage.palette.cliffColor).toMatch(hexColorRegex);
      if (stage.palette.chasmFloorColor !== undefined) {
        expect(stage.palette.chasmFloorColor).toMatch(hexColorRegex);
      }

      const sc = stage.layout.scenery;
      expect(sc.offPisteTreeDensity).toBeGreaterThanOrEqual(0);
      expect(sc.offPisteTreeDensity).toBeLessThanOrEqual(1);
      expect(sc.rockDensity).toBeGreaterThanOrEqual(0);
      expect(sc.rockDensity).toBeLessThanOrEqual(1);
      expect(sc.shrubDensity).toBeGreaterThanOrEqual(0);
      expect(sc.shrubDensity).toBeLessThanOrEqual(1);
      expect(sc.frostedPineChance).toBeGreaterThanOrEqual(0);
      expect(sc.frostedPineChance).toBeLessThanOrEqual(1);
      expect(sc.groundMinRadius).toBeGreaterThan(0);
      expect(sc.canopyMinRadius).toBeGreaterThanOrEqual(sc.groundMinRadius);

      for (const side of [stage.landscape.left, stage.landscape.right]) {
        expect(validArchetypes.has(side.archetype)).toBe(true);
        expect(side.reliefScale).toBeGreaterThan(0);
        expect(side.transitionWidth).toBeGreaterThan(0);
        expect(side.noiseFrequency).toBeGreaterThan(0);

        if (side.archetype === 'chasm') {
          expect(side.chasmWipeoutDepth).toBeGreaterThan(0);
          expect(side.chasmWipeoutDepth).toBeLessThan(side.reliefScale);
          if (side.farWallOffsetM !== undefined) {
            expect(side.farWallOffsetM).toBeGreaterThan(side.transitionWidth);
          }
          expect(stage.palette.chasmFloorColor).toBeDefined();
        }
      }
    }
  });

  it('satisfies ribbon curvature safety |k| * (halfWidth + skirtWidth) <= 0.4 and fog floor >= 65m', () => {
    for (const stage of getAllStages()) {
      const maxK = stage.terrain.curveStrength[1];
      const maxW = stage.terrain.halfWidth[1] + stage.terrain.skirtWidth;
      expect(maxK * maxW).toBeLessThanOrEqual(0.4);
      expect(stage.weather.fogMinDist).toBeGreaterThanOrEqual(65);
      expect(stage.layout.deliveryCadenceM[0]).toBeGreaterThanOrEqual(150);
      expect(stage.layout.deliveryCadenceM[1]).toBeLessThanOrEqual(250);
    }

    for (const weather of Object.values(WEATHER_PROFILES)) {
      expect(weather.fogMinDist).toBeGreaterThanOrEqual(65);
    }
  });

  it('registers all MVP hazards, creatures, presents, delivery zones, and skiers', () => {
    const smallBoulder = getHazardDef('boulder_small');
    const largeBoulder = getHazardDef('boulder_large');
    const pine = getHazardDef('pine_tree');
    expect(smallBoulder).toBeDefined();
    expect(largeBoulder).toBeDefined();
    expect(pine).toBeDefined();
    expect(Object.keys(HAZARDS)).toHaveLength(3);

    expect(smallBoulder!.lethal).toBe(false);
    expect(smallBoulder!.collider.height).toBeLessThan(1.0);
    expect(largeBoulder!.lethal).toBe(true);
    expect(largeBoulder!.collider.height).toBeGreaterThan(2.0);
    expect(pine!.lethal).toBe(true);

    const bear = getCreatureDef('bear_patrol');
    expect(bear).toBeDefined();
    expect(bear!.behavior.type).toBe('bearPatrol');
    expect(Object.keys(CREATURES)).toContain('bear_patrol');

    const standardGift = getPresentDef('gift_standard');
    const goldenGift = getPresentDef('gift_golden');
    expect(standardGift).toBeDefined();
    expect(goldenGift).toBeDefined();
    expect(goldenGift!.basePoints).toBeGreaterThan(standardGift!.basePoints);
    expect(Object.keys(PRESENTS)).toHaveLength(2);

    expect(getDeliveryZoneDef('child_solo')).toBeDefined();
    expect(getDeliveryZoneDef('sled_duo')).toBeDefined();
    expect(getDeliveryZoneDef('village_plaza')).toBeDefined();
    expect(Object.keys(DELIVERY_ZONES)).toHaveLength(3);

    expect(getSkierDef('skier_alpine')).toBeDefined();
    expect(getSkierDef('skier_carver')).toBeDefined();
    expect(Object.keys(SKIERS)).toHaveLength(2);
  });

  it('registers 3 ramp presets with increasing incline angles and difficulty-weighted stage distributions', () => {
    expect(Object.keys(RAMPS)).toHaveLength(3);
    expect(getRampDef('ski_ramp_gentle')).toBe(RAMP_GENTLE);
    expect(getRampDef('ski_ramp_standard')).toBe(RAMP_STANDARD);
    expect(getRampDef('ski_ramp_steep')).toBe(RAMP_STEEP);

    const gentleAngle = Math.atan2(RAMP_GENTLE.height, RAMP_GENTLE.length);
    const standardAngle = Math.atan2(RAMP_STANDARD.height, RAMP_STANDARD.length);
    const steepAngle = Math.atan2(RAMP_STEEP.height, RAMP_STEEP.length);
    expect(gentleAngle).toBeLessThan(standardAngle);
    expect(standardAngle).toBeLessThan(steepAngle);
    expect(RAMP_GENTLE.lipPitchBoostDeg).toBeLessThan(RAMP_STANDARD.lipPitchBoostDeg);
    expect(RAMP_STANDARD.lipPitchBoostDeg).toBeLessThan(RAMP_STEEP.lipPitchBoostDeg);
    expect(RAMP_GENTLE.landingClearanceM!).toBeLessThan(RAMP_STANDARD.landingClearanceM!);
    expect(RAMP_STANDARD.landingClearanceM!).toBeLessThan(RAMP_STEEP.landingClearanceM!);

    for (const stage of getAllStages()) {
      const rules = stage.layout.ramps;
      expect(rules).toBeDefined();
      expect(rules!.length).toBeGreaterThanOrEqual(3);
      for (const rule of rules!) {
        expect(getRampDef(rule.rampId)).toBeDefined();
        expect(rule.weight).toBeGreaterThan(0);
      }
    }

    const powderWeights = new Map(getStageDef('powder-bowl')!.layout.ramps!.map((r) => [r.rampId, r.weight]));
    const icyWeights = new Map(getStageDef('icy-black')!.layout.ramps!.map((r) => [r.rampId, r.weight]));
    expect(powderWeights.get('ski_ramp_gentle')!).toBeGreaterThan(icyWeights.get('ski_ramp_gentle')!);
    expect(icyWeights.get('ski_ramp_steep')!).toBeGreaterThan(powderWeights.get('ski_ramp_steep')!);
  });

  it('exposes parametric visibility tuning defaults, clean enabled=false toggles, and NaN/bounds sanitization', () => {
    expect(DEFAULT_VISIBILITY_TUNING.portraitFov).toBe(PORTRAIT_FOV_TUNING);
    expect(DEFAULT_VISIBILITY_TUNING.characterScale).toBe(CHARACTER_SCALE_TUNING);
    expect(DEFAULT_VISIBILITY_TUNING.cameraFraming).toBe(CAMERA_FRAMING_TUNING);
    expect(DEFAULT_VISIBILITY_TUNING.outline).toBe(OUTLINE_VISIBILITY_TUNING);

    expect(PORTRAIT_FOV_TUNING.enabled).toBe(true);
    expect(PORTRAIT_FOV_TUNING.hardMaxVerticalFovDeg).toBeGreaterThanOrEqual(
      PORTRAIT_FOV_TUNING.maxBaseVerticalFovDeg,
    );

    expect(resolveSkierVisualScale(1.0, CHARACTER_SCALE_TUNING)).toBeCloseTo(
      CHARACTER_SCALE_TUNING.skierScale,
      6,
    );
    expect(resolveSkierVisualScale(1.2, { ...CHARACTER_SCALE_TUNING, enabled: false })).toBeCloseTo(
      1.2,
      6,
    );
    expect(resolveSkierVisualScale(Number.NaN, { ...CHARACTER_SCALE_TUNING, skierScale: -2 })).toBe(
      1.0,
    );

    expect(resolveChildScaleMultiplier(CHARACTER_SCALE_TUNING)).toBeCloseTo(
      CHARACTER_SCALE_TUNING.childScale,
      6,
    );
    expect(resolveChildScaleMultiplier({ ...CHARACTER_SCALE_TUNING, enabled: false })).toBe(1.0);
    expect(resolveChildScaleMultiplier({ ...CHARACTER_SCALE_TUNING, childScale: Number.NaN })).toBe(
      1.0,
    );
    expect(resolveChildScaleMultiplier({ ...CHARACTER_SCALE_TUNING, childScale: 0 })).toBe(1.0);
    expect(resolveChildSlotSpreadMultiplier(CHARACTER_SCALE_TUNING)).toBeCloseTo(
      CHARACTER_SCALE_TUNING.childSlotSpreadScale,
      6,
    );
    expect(resolveChildSlotSpreadMultiplier({ ...CHARACTER_SCALE_TUNING, enabled: false })).toBe(
      1.0,
    );
    expect(
      resolveChildSlotSpreadMultiplier({ ...CHARACTER_SCALE_TUNING, childSlotSpreadScale: -1 }),
    ).toBe(1.0);
    expect(resolveCreatureScaleMultiplier(CHARACTER_SCALE_TUNING)).toBeCloseTo(
      CHARACTER_SCALE_TUNING.creatureScale,
      6,
    );
    expect(resolveCreatureScaleMultiplier({ ...CHARACTER_SCALE_TUNING, enabled: false })).toBe(1.0);
    expect(resolveCreatureScaleMultiplier({ ...CHARACTER_SCALE_TUNING, creatureScale: -0.5 })).toBe(
      1.0,
    );

    expect(extractVisualScale(undefined)).toBe(1.0);
    expect(extractVisualScale(getSkierDef('skier_alpine')?.visual)).toBe(1.0);
    expect(extractVisualScale(getPresentDef('gift_golden')?.visual)).toBe(1.2);
    expect(
      extractVisualScale({
        kind: 'billboard',
        atlasId: 'a',
        frame: 'f',
        width: 2,
        height: 2,
      }),
    ).toBe(1.0);

    expect(resolveActiveCameraFraming(CAMERA_FRAMING_TUNING)).toEqual(CAMERA_FRAMING_TUNING);
    expect(resolveActiveCameraFraming({ ...CAMERA_FRAMING_TUNING, enabled: false })).toBe(
      LEGACY_CAMERA_FRAMING_TUNING,
    );
    const sanitizedFraming = resolveActiveCameraFraming({
      ...CAMERA_FRAMING_TUNING,
      trailDistMinM: 12,
      trailDistMaxM: 8,
      resetTrailDistM: 25,
      baseHeightMinM: 5,
      baseHeightMaxM: 2,
      resetBaseHeightM: 0.5,
      maxSpeedFovBoostDeg: -4,
      lookAheadM: Number.NaN,
    });
    expect(sanitizedFraming.trailDistMaxM).toBeGreaterThanOrEqual(sanitizedFraming.trailDistMinM);
    expect(sanitizedFraming.resetTrailDistM).toBeGreaterThanOrEqual(sanitizedFraming.trailDistMinM);
    expect(sanitizedFraming.resetTrailDistM).toBeLessThanOrEqual(sanitizedFraming.trailDistMaxM);
    expect(sanitizedFraming.baseHeightMaxM).toBeGreaterThanOrEqual(sanitizedFraming.baseHeightMinM);
    expect(sanitizedFraming.resetBaseHeightM).toBeGreaterThanOrEqual(
      sanitizedFraming.baseHeightMinM,
    );
    expect(sanitizedFraming.resetBaseHeightM).toBeLessThanOrEqual(sanitizedFraming.baseHeightMaxM);
    expect(sanitizedFraming.maxSpeedFovBoostDeg).toBe(
      CAMERA_FRAMING_TUNING.maxSpeedFovBoostDeg,
    );
    expect(sanitizedFraming.lookAheadM).toBe(CAMERA_FRAMING_TUNING.lookAheadM);

    expect(computePortraitAspectFactor(16 / 9)).toBe(0);
    expect(computePortraitAspectFactor(1.0)).toBe(0);
    expect(computePortraitAspectFactor(9 / 16)).toBeGreaterThan(0.7);
    expect(computePortraitAspectFactor(9 / 20)).toBe(1.0);
    expect(computePortraitAspectFactor(Number.NaN)).toBe(0);
  });
});
