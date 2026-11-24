import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { SKIER_ALPINE, SKIER_CARVER } from '../../content/characters';
import {
  computeRatio01,
  formatCreatureEdgeBeacon,
  formatCreatureTelegraphPopup,
  formatDeliveryPopup,
  formatDeliveryRibbon,
  formatDistanceM,
  formatForkEnteredPopup,
  formatLeakCheckSummary,
  formatMultiplier,
  formatPickupBurstChip,
  formatPickupPopup,
  formatScore,
  formatSkierCardInfo,
  formatStageDisplay,
  formatStumbleChip,
  formatTrianglesCount,
  formatWipeoutEventPopup,
} from '../hudFormatting';
import { createLeakCheckStatus } from '../types';

function collectTsFiles(dir: string): string[] {
  const out: string[] = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectTsFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

describe('UI formatting & architectural isolation', () => {
  it('formats scores, distances, multipliers, ratios, triangles, and leak summaries accurately', () => {
    expect(formatScore(0)).toBe('0');
    expect(formatScore(1254.6)).toBe('1,255');
    expect(formatScore(-10)).toBe('0');

    expect(formatDistanceM(0)).toBe('0 m');
    expect(formatDistanceM(428.9)).toBe('428 m');
    expect(formatDistanceM(1250)).toBe('1.25 km');

    expect(formatMultiplier(1)).toBe('x1');
    expect(formatMultiplier(2)).toBe('x2');
    expect(formatMultiplier(2.5)).toBe('x2.5');

    expect(computeRatio01(4, 8)).toBeCloseTo(0.5, 6);
    expect(computeRatio01(12, 8)).toBe(1);
    expect(computeRatio01(-1, 8)).toBe(0);
    expect(computeRatio01(2, 0)).toBe(0);

    expect(formatTrianglesCount(850)).toBe('850');
    expect(formatTrianglesCount(18420)).toBe('18.4k');

    const pending = createLeakCheckStatus();
    expect(formatLeakCheckSummary(pending)).toBe('pending (20s)');

    const clean = { ...pending, hasRun: true, totalLeaks: 0 };
    expect(formatLeakCheckSummary(clean)).toBe('0 leaks');

    const leaky = {
      ...pending,
      hasRun: true,
      totalLeaks: 3,
      detachedObjects: 1,
      uncollectedResources: 1,
      untrackedSceneObjects: 1,
    };
    expect(formatLeakCheckSummary(leaky)).toBe('3 leaks (det:1, res:1, scn:1)');
  });

  it('maps stage badges, skier cards, and simulation events cleanly', () => {
    const powder = formatStageDisplay('powder-bowl');
    expect(powder.name).toBe('Powder Bowl Meadow');
    expect(powder.badgeSymbol).toBe('●');
    expect(powder.badgeColor).toBe('#16a34a');
    expect(powder.multiplier).toBe(1);

    const blue = formatStageDisplay('sunny-blue');
    expect(blue.name).toBe('Sunny Blue Run');
    expect(blue.badgeSymbol).toBe('■');
    expect(blue.multiplier).toBe(1);

    const gorge = formatStageDisplay('granite-gorge');
    expect(gorge.name).toBe('Granite Gorge');
    expect(gorge.badgeSymbol).toBe('■');
    expect(gorge.multiplierLabel).toBe('1.5x');

    const black = formatStageDisplay('icy-black');
    expect(black.name).toBe('Icy Black Diamond');
    expect(black.badgeSymbol).toBe('◆');
    expect(black.multiplierLabel).toBe('2x');

    const blizzard = formatStageDisplay('blizzard-ridge');
    expect(blizzard.name).toBe('Blizzard Ridge');
    expect(blizzard.badgeSymbol).toBe('◆');
    expect(blizzard.multiplierLabel).toBe('2.5x');

    const alpineCard = formatSkierCardInfo(SKIER_ALPINE);
    expect(alpineCard.perkLabel).toContain('Gift Magnet');
    const carverCard = formatSkierCardInfo(SKIER_CARVER);
    expect(carverCard.perkLabel).toContain('Ice Grip');

    const pickup = formatPickupPopup({
      presentDefId: 'gift_golden',
      worldX: 0,
      worldY: 0,
      worldZ: 0,
      pickupPoints: 75,
      carriedCount: 12,
      maxCapacity: 12,
    });
    expect(pickup.tone).toBe('gold');
    expect(pickup.title).toContain('+75');
    expect(pickup.subtitle).toContain('Pack Full');

    const delivered = formatDeliveryPopup({
      deliveryZoneId: 'village_plaza',
      countDelivered: 4,
      pointsAwarded: 1200,
      comboMultiplier: 2.5,
      totalScore: 2500,
      worldX: 0,
      worldY: 0,
      worldZ: 0,
    });
    expect(delivered.tone).toBe('delivery');
    expect(delivered.title).toContain('1,200');
    expect(delivered.subtitle).toContain('x2.5 COMBO');

    const fork = formatForkEnteredPopup({
      chosenSide: 'right',
      newSegmentId: 3,
      newStageId: 'icy-black',
      previousStageId: 'sunny-blue',
    });
    expect(fork.tone).toBe('fork');
    expect(fork.title).toContain('ICY BLACK DIAMOND');
    expect(fork.subtitle).toContain('Right Fork');

    const bear = formatCreatureTelegraphPopup({
      creatureDefId: 'bear_patrol',
      soundId: 'bear_roar',
      worldX: -5,
      worldY: 0,
      worldZ: -20,
      distanceToPlayerM: 22.4,
      showEdgeIndicator: true,
      edgeSide: 'left',
    });
    expect(bear.tone).toBe('warning');
    expect(bear.title).toContain('◀');
    expect(bear.subtitle).toContain('22 m');

    expect(
      formatWipeoutEventPopup({
        hazardId: 'boulder_small',
        effect: 'stumble',
        presentsDropped: 1,
        worldX: 0,
        worldY: 0,
        worldZ: 0,
        recoverySec: 0,
      })?.tone,
    ).toBe('stumble');
    expect(
      formatWipeoutEventPopup({
        hazardId: 'pine_tree',
        effect: 'wipeout',
        presentsDropped: 3,
        worldX: 0,
        worldY: 0,
        worldZ: 0,
        recoverySec: 1.2,
      }),
    ).toBeNull();
  });

  it('formats coalesced pickup chips, delivery ribbons, creature edge beacons, and stumble chips', () => {
    const singleGift = formatPickupBurstChip(25, 1, false);
    expect(singleGift).toEqual({
      pointsText: '+25',
      countText: '',
      hasGolden: false,
      tone: 'gift',
    });

    const multiGold = formatPickupBurstChip(125.4, 3, true);
    expect(multiGold).toEqual({
      pointsText: '+125',
      countText: '×3',
      hasGolden: true,
      tone: 'gold',
    });

    const deliveryWithCombo = formatDeliveryRibbon({
      deliveryZoneId: 'village_plaza',
      countDelivered: 4,
      pointsAwarded: 1400,
      comboMultiplier: 3,
      totalScore: 4250,
      worldX: 0,
      worldY: 0,
      worldZ: 0,
    });
    expect(deliveryWithCombo).toEqual({
      pointsText: '+1,400',
      detailText: '4 DELIVERED',
      comboText: '×3',
      durationSec: 2.1,
    });

    const deliveryNoCombo = formatDeliveryRibbon({
      deliveryZoneId: 'child_solo',
      countDelivered: 1,
      pointsAwarded: 100,
      comboMultiplier: 1,
      totalScore: 100,
      worldX: 0,
      worldY: 0,
      worldZ: 0,
    });
    expect(deliveryNoCombo.comboText).toBe('');
    expect(deliveryNoCombo.detailText).toBe('1 DELIVERED');

    const bearLeft = formatCreatureEdgeBeacon({
      creatureDefId: 'bear_patrol',
      soundId: 'bear_roar',
      worldX: -6,
      worldY: 0,
      worldZ: -34,
      distanceToPlayerM: 33.7,
      showEdgeIndicator: false,
      edgeSide: 'left',
    });
    expect(bearLeft).toEqual({
      side: 'left',
      distanceText: '34m',
      creatureName: 'MOUNTAIN BEAR',
      durationSec: 1.85,
    });

    const bearCenter = formatCreatureEdgeBeacon({
      creatureDefId: 'unknown_beast',
      soundId: 'roar',
      worldX: 0,
      worldY: 0,
      worldZ: -10,
      distanceToPlayerM: 0.2,
      showEdgeIndicator: true,
      edgeSide: 'center',
    });
    expect(bearCenter.side).toBe('center');
    expect(bearCenter.distanceText).toBe('1m');
    expect(bearCenter.creatureName).toBe('CREATURE');

    expect(
      formatStumbleChip({
        hazardId: 'boulder_small',
        effect: 'stumble',
        presentsDropped: 2,
        worldX: 0,
        worldY: 0,
        worldZ: 0,
        recoverySec: 0,
      }),
    ).toEqual({ text: 'STUMBLE · -2', durationSec: 1.35 });

    expect(
      formatStumbleChip({
        hazardId: 'boulder_small',
        effect: 'stumble',
        presentsDropped: 0,
        worldX: 0,
        worldY: 0,
        worldZ: 0,
        recoverySec: 0,
      }),
    ).toEqual({ text: 'STUMBLE', durationSec: 1.35 });

    expect(
      formatStumbleChip({
        hazardId: 'pine_tree',
        effect: 'wipeout',
        presentsDropped: 3,
        worldX: 0,
        worldY: 0,
        worldZ: 0,
        recoverySec: 1.2,
      }),
    ).toBeNull();
  });

  it('prevents src/ui/ from importing three, render/three internals, or sim implementations', () => {
    const uiRoot = path.resolve(__dirname, '..');
    const files = collectTsFiles(uiRoot);
    const violations: string[] = [];

    for (const filePath of files) {
      if (filePath.includes(`${path.sep}__tests__${path.sep}`)) continue;
      const text = fs.readFileSync(filePath, 'utf8');
      const sf = ts.createSourceFile(filePath, text, ts.ScriptTarget.ES2022, true);
      sf.forEachChild((node) => {
        if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
          const spec = node.moduleSpecifier.text;
          if (spec === 'three' || spec.startsWith('three/')) {
            violations.push(`${path.basename(filePath)} imports '${spec}'`);
          }
          if (spec.includes('/render/')) {
            violations.push(`${path.basename(filePath)} imports renderer module '${spec}'`);
          }
          if (spec.includes('/sim/') && !spec.endsWith('/sim/contracts')) {
            violations.push(`${path.basename(filePath)} imports non-contract sim module '${spec}'`);
          }
        }
      });
    }

    expect(violations).toEqual([]);
  });
});
