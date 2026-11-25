import { getCreatureDef } from '../content/creatures';
import { getPresentDef } from '../content/presents';
import { getStageDef } from '../content/stages';
import type { SkierDef, StageBadge } from '../content/types';
import type { TiltControlStatus } from '../core/input';
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

export interface PickupBurstDisplay {
  readonly pointsText: string;
  readonly countText: string;
  readonly hasGolden: boolean;
  readonly tone: 'gift' | 'gold';
}

export interface DeliveryRibbonDisplay {
  readonly pointsText: string;
  readonly detailText: string;
  readonly comboText: string;
  readonly durationSec: number;
}

export interface CreatureBeaconDisplay {
  readonly side: 'left' | 'right' | 'center';
  readonly distanceText: string;
  readonly creatureName: string;
  readonly durationSec: number;
}

export interface StumbleChipDisplay {
  readonly text: string;
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

export function formatPickupBurstChip(
  totalPoints: number,
  count: number,
  hasGolden: boolean,
): PickupBurstDisplay {
  const safePoints = Number.isFinite(totalPoints) ? Math.max(0, Math.round(totalPoints)) : 0;
  const safeCount = Number.isFinite(count) ? Math.max(0, Math.round(count)) : 0;
  return {
    pointsText: `+${formatScore(safePoints)}`,
    countText: safeCount > 1 ? `×${safeCount}` : '',
    hasGolden,
    tone: hasGolden ? 'gold' : 'gift',
  };
}

export function formatDeliveryRibbon(
  ev: SimEventMap['PRESENT_DELIVERED'],
): DeliveryRibbonDisplay {
  const safeCount = Number.isFinite(ev.countDelivered)
    ? Math.max(0, Math.round(ev.countDelivered))
    : 0;
  const comboText =
    ev.comboMultiplier > 1 ? formatMultiplier(ev.comboMultiplier).replace(/^x/, '×') : '';
  return {
    pointsText: `+${formatScore(ev.pointsAwarded)}`,
    detailText: `${safeCount} DELIVERED`,
    comboText,
    durationSec: 2.1,
  };
}

export function formatCreatureEdgeBeacon(
  ev: SimEventMap['CREATURE_TELEGRAPH'],
): CreatureBeaconDisplay {
  const creature = getCreatureDef(ev.creatureDefId);
  const creatureName = (creature?.name ?? 'CREATURE').toUpperCase();
  const safeDist = Number.isFinite(ev.distanceToPlayerM)
    ? Math.max(1, Math.round(ev.distanceToPlayerM))
    : 1;
  return {
    side: ev.edgeSide,
    distanceText: `${safeDist}m`,
    creatureName,
    durationSec: 1.85,
  };
}

export function formatStumbleChip(ev: SimEventMap['PLAYER_WIPEOUT']): StumbleChipDisplay | null {
  if (ev.effect !== 'stumble') {
    return null;
  }
  const safeDropped = Number.isFinite(ev.presentsDropped)
    ? Math.max(0, Math.round(ev.presentsDropped))
    : 0;
  return {
    text: safeDropped > 0 ? `STUMBLE · -${safeDropped}` : 'STUMBLE',
    durationSec: 1.35,
  };
}

export function formatTiltStatusText(enabled: boolean, status: TiltControlStatus): string {
  switch (status) {
    case 'insecure':
      return 'Tilt steering requires HTTPS';
    case 'denied':
      return 'Motion access denied — allow in browser settings';
    case 'requesting':
      return 'Waiting for motion sensor permission…';
    case 'calibrating':
      return enabled ? 'Hold steady — calibrating tilt…' : '';
    case 'active':
      return 'Tilt device left/right to carve · Tap to jump';
    case 'no-sensor':
      return 'No accelerometer detected — using touch drag';
    case 'unsupported':
      return 'Motion sensors unavailable in this browser';
    case 'inactive':
    default:
      return '';
  }
}

export function formatControlsHint(tiltActive: boolean): string {
  if (tiltActive) {
    return 'Carve: Tilt Device (or A/D) · Jump: Tap or Space · Brake: 2-Finger Hold or S';
  }
  return 'Carve: A/D, Arrows, or Drag · Jump: Space or Tap · Brake: S or 2-Finger Hold';
}
