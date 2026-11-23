import { getCreatureDef } from '../content/creatures';
import { getPresentDef } from '../content/presents';
import { getStageDef } from '../content/stages';
import type { SkierDef, StageBadge } from '../content/types';
import { clamp } from '../core/math';
import type { SimEventMap } from '../sim/contracts';
import type { LeakCheckStatus } from './types';

export interface StageDisplayInfo {
  readonly id: string;
  readonly name: string;
  readonly shortLabel: string;
  readonly badgeShape: StageBadge['shape'];
  readonly badgeSymbol: string;
  readonly badgeColor: string;
  readonly multiplier: number;
  readonly multiplierLabel: string;
}

export interface SkierCardDisplayInfo {
  readonly id: string;
  readonly name: string;
  readonly maxSpeedLabel: string;
  readonly capacityLabel: string;
  readonly perkLabel: string;
  readonly primaryColor: string;
  readonly accentColor: string;
}

export type PopupTone = 'gift' | 'gold' | 'delivery' | 'fork' | 'warning' | 'stumble';

export interface PopupDescriptor {
  readonly title: string;
  readonly subtitle: string;
  readonly tone: PopupTone;
  readonly durationSec: number;
}

export function formatScore(score: number): string {
  const safe = Number.isFinite(score) ? Math.max(0, Math.round(score)) : 0;
  return safe.toLocaleString('en-US');
}

export function formatDistanceM(distanceM: number): string {
  const safe = Number.isFinite(distanceM) ? Math.max(0, distanceM) : 0;
  if (safe >= 1000) {
    return `${(safe / 1000).toFixed(2)} km`;
  }
  return `${Math.floor(safe)} m`;
}

export function formatMultiplier(multiplier: number): string {
  const safe = Number.isFinite(multiplier) ? Math.max(1, multiplier) : 1;
  const rounded = Math.round(safe * 10) / 10;
  return Number.isInteger(rounded) ? `x${rounded}` : `x${rounded.toFixed(1)}`;
}

export function computeRatio01(current: number, duration: number): number {
  if (!Number.isFinite(current) || !Number.isFinite(duration) || duration <= 0) {
    return 0;
  }
  return clamp(current / duration, 0, 1);
}

export function formatTrianglesCount(triangles: number): string {
  const safe = Number.isFinite(triangles) ? Math.max(0, Math.round(triangles)) : 0;
  if (safe >= 1000) {
    return `${(safe / 1000).toFixed(1)}k`;
  }
  return `${safe}`;
}

export function formatLeakCheckSummary(status: LeakCheckStatus): string {
  if (!status.hasRun) {
    return 'pending (20s)';
  }
  if (status.totalLeaks === 0) {
    return '0 leaks';
  }
  return `${status.totalLeaks} leaks (det:${status.detachedObjects}, res:${status.uncollectedResources}, scn:${status.untrackedSceneObjects})`;
}

export function getBadgeSymbol(shape: StageBadge['shape']): string {
  switch (shape) {
    case 'diamond':
      return '◆';
    case 'circle':
      return '●';
    case 'square':
    default:
      return '■';
  }
}

export function formatStageDisplay(stageId: string | null): StageDisplayInfo {
  const def = stageId ? getStageDef(stageId) : undefined;
  if (!def) {
    return {
      id: stageId ?? 'unknown',
      name: stageId ?? 'Mountain Run',
      shortLabel: 'TRAIL',
      badgeShape: 'square',
      badgeSymbol: '■',
      badgeColor: '#2563eb',
      multiplier: 1,
      multiplierLabel: '1x',
    };
  }
  return {
    id: def.id,
    name: def.name,
    shortLabel: def.badge.label,
    badgeShape: def.badge.shape,
    badgeSymbol: getBadgeSymbol(def.badge.shape),
    badgeColor: def.badge.color,
    multiplier: def.scoreMultiplier,
    multiplierLabel: `${def.scoreMultiplier}x`,
  };
}

export function formatSkierCardInfo(skier: SkierDef): SkierCardDisplayInfo {
  let perkLabel = 'Balanced All-Rounder';
  if (skier.perk?.type === 'pickupMagnet') {
    perkLabel = `Gift Magnet +${Math.round((skier.perk.value - 1) * 100)}%`;
  } else if (skier.perk?.type === 'iceGrip') {
    perkLabel = `Ice Grip +${Math.round((skier.perk.value - 1) * 100)}%`;
  } else if (skier.perk?.type === 'yetiRepellent') {
    perkLabel = 'Yeti Deterrent';
  }

  const palette = skier.visual.kind === 'procedural' ? skier.visual.palette : [];
  return {
    id: skier.id,
    name: skier.name,
    maxSpeedLabel: `${skier.stats.maxSpeed} m/s`,
    capacityLabel: `${skier.stats.presentCapacity} Gifts`,
    perkLabel,
    primaryColor: palette[0] ?? '#e63946',
    accentColor: palette[2] ?? '#ffd166',
  };
}

export function formatPickupPopup(ev: SimEventMap['PRESENT_PICKED_UP']): PopupDescriptor {
  const def = getPresentDef(ev.presentDefId);
  const isGold = ev.presentDefId === 'gift_golden';
  const full = ev.carriedCount >= ev.maxCapacity;
  return {
    title: `+${ev.pickupPoints} ${isGold ? '★ GOLDEN GIFT' : (def?.name ?? 'GIFT').toUpperCase()}`,
    subtitle: full
      ? `Pack Full (${ev.carriedCount}/${ev.maxCapacity}) — Find Children!`
      : `Pack ${ev.carriedCount}/${ev.maxCapacity}`,
    tone: isGold ? 'gold' : 'gift',
    durationSec: 1.5,
  };
}

export function formatDeliveryPopup(ev: SimEventMap['PRESENT_DELIVERED']): PopupDescriptor {
  const multNote = ev.comboMultiplier > 1 ? ` · ${formatMultiplier(ev.comboMultiplier)} COMBO` : '';
  return {
    title: `+${formatScore(ev.pointsAwarded)} DELIVERED!`,
    subtitle: `${ev.countDelivered} ${ev.countDelivered === 1 ? 'Gift' : 'Gifts'}${multNote}`,
    tone: 'delivery',
    durationSec: 2.1,
  };
}

export function formatForkEnteredPopup(ev: SimEventMap['FORK_ENTERED']): PopupDescriptor {
  const stage = formatStageDisplay(ev.newStageId);
  const sideLabel = ev.chosenSide === 'left' ? 'Left Fork' : 'Right Fork';
  const multText = stage.multiplier > 1 ? ` · ${stage.multiplierLabel} Score` : '';
  return {
    title: `${stage.badgeSymbol} ${stage.name.toUpperCase()}`,
    subtitle: `${sideLabel}${multText}`,
    tone: 'fork',
    durationSec: 2.2,
  };
}

export function formatCreatureTelegraphPopup(
  ev: SimEventMap['CREATURE_TELEGRAPH'],
): PopupDescriptor {
  const creature = getCreatureDef(ev.creatureDefId);
  const creatureName = (creature?.name ?? 'CREATURE').toUpperCase();
  const distText = `${Math.max(1, Math.round(ev.distanceToPlayerM))} m`;
  const title =
    ev.edgeSide === 'left'
      ? `◀ ${creatureName} LEFT!`
      : ev.edgeSide === 'right'
        ? `${creatureName} RIGHT! ▶`
        : `⚠ ${creatureName} AHEAD!`;
  return {
    title,
    subtitle: `${distText} away — Carve clear!`,
    tone: 'warning',
    durationSec: 1.85,
  };
}

export function formatWipeoutEventPopup(ev: SimEventMap['PLAYER_WIPEOUT']): PopupDescriptor | null {
  if (ev.effect !== 'stumble') {
    return null;
  }
  const dropped =
    ev.presentsDropped > 0
      ? `Dropped ${ev.presentsDropped} ${ev.presentsDropped === 1 ? 'gift' : 'gifts'}`
      : 'Keep carving!';
  return {
    title: 'STUMBLE!',
    subtitle: dropped,
    tone: 'stumble',
    durationSec: 1.4,
  };
}
