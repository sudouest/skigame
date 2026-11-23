import type { CreatureDef } from './types';

export const CREATURE_BEAR_PATROL: CreatureDef = {
  id: 'bear_patrol',
  name: 'Mountain Bear',
  visual: {
    kind: 'procedural',
    preset: 'bear',
    palette: ['#5c3a21', '#8b5a2b', '#e6ccb2'],
    scale: 1.0,
    variant: 'patrol',
    outline: true,
  },
  collider: {
    shape: 'cylinder',
    radius: 1.2,
    height: 1.85,
  },
  impact: {
    effect: 'wipeout',
    presentsDropped: 3,
    speedRetention: 0,
  },
  lethal: false,
  behavior: {
    type: 'bearPatrol',
    crossSpeed: 4.2,
    lungeRadius: 7.5,
    telegraphSec: 0.75,
  },
  telegraph: {
    soundId: 'bear_roar',
    warningRange: 48,
    glowEyeColor: '#ffaa33',
    showEdgeIndicator: false,
  },
};

export const CREATURES: Readonly<Record<string, CreatureDef>> = {
  [CREATURE_BEAR_PATROL.id]: CREATURE_BEAR_PATROL,
};

export function getCreatureDef(id: string): CreatureDef | undefined {
  return CREATURES[id];
}
