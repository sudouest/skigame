import { describe, expect, it } from 'vitest';
import {
  CREATURES,
  DELIVERY_ZONES,
  HAZARDS,
  PRESENTS,
  SKIERS,
  STAGES,
  WEATHER_PROFILES,
  getAllStages,
  getCreatureDef,
  getDeliveryZoneDef,
  getHazardDef,
  getPresentDef,
  getSkierDef,
  getStageDef,
} from './index';

describe('content registries & invariants', () => {
  it('exposes contrasting forkable sunny-blue and icy-black stages', () => {
    const sunny = getStageDef('sunny-blue');
    const icy = getStageDef('icy-black');

    expect(sunny).toBeDefined();
    expect(icy).toBeDefined();
    expect(getAllStages()).toHaveLength(2);
    expect(STAGES['sunny-blue']).toBe(sunny);
    expect(STAGES['icy-black']).toBe(icy);

    // Contrasting gameplay characteristics
    expect(sunny!.terrain.halfWidth[0]).toBeGreaterThan(icy!.terrain.halfWidth[1]);
    expect(icy!.terrain.pitchDeg[0]).toBeGreaterThan(sunny!.terrain.pitchDeg[1]);
    expect(icy!.terrain.icePatchChance).toBeGreaterThan(sunny!.terrain.icePatchChance);
    expect(icy!.terrain.rampChance).toBeGreaterThan(sunny!.terrain.rampChance);
    expect(icy!.scoreMultiplier).toBeGreaterThan(sunny!.scoreMultiplier);
    expect(sunny!.forkTargets).toContain('icy-black');
    expect(icy!.forkTargets).toContain('sunny-blue');
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
});
