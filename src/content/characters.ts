import type { SkierDef } from './types';

export const SKIER_ALPINE: SkierDef = {
  id: 'skier_alpine',
  name: 'Pip the Alpine Courier',
  visual: {
    kind: 'procedural',
    preset: 'skier',
    palette: ['#e63946', '#1d3557', '#ffd166', '#f8fafc'],
    scale: 1.0,
    variant: 'alpine',
    outline: true,
  },
  stats: {
    maxSpeed: 34,
    carveGrip: 1.0,
    jumpImpulse: 8.6,
    presentCapacity: 12,
    wipeoutRecoverySec: 1.2,
    invulnerableSec: 1.5,
    collisionRadius: 0.55,
    skierHeight: 1.7,
  },
  perk: {
    type: 'pickupMagnet',
    value: 1.15,
  },
};

export const SKIER_CARVER: SkierDef = {
  id: 'skier_carver',
  name: 'Sora the Ice Carver',
  visual: {
    kind: 'procedural',
    preset: 'skier',
    palette: ['#00b4d8', '#03045e', '#90e0ef', '#ffffff'],
    scale: 1.0,
    variant: 'carver',
    outline: true,
  },
  stats: {
    maxSpeed: 36,
    carveGrip: 1.15,
    jumpImpulse: 8.4,
    presentCapacity: 10,
    wipeoutRecoverySec: 1.1,
    invulnerableSec: 1.5,
    collisionRadius: 0.55,
    skierHeight: 1.7,
  },
  perk: {
    type: 'iceGrip',
    value: 1.6,
  },
};

export const SKIERS: Readonly<Record<string, SkierDef>> = {
  [SKIER_ALPINE.id]: SKIER_ALPINE,
  [SKIER_CARVER.id]: SKIER_CARVER,
};

export function getSkierDef(id: string): SkierDef | undefined {
  return SKIERS[id];
}
