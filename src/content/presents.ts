import type { PresentDef } from './types';

export const PRESENT_STANDARD: PresentDef = {
  id: 'gift_standard',
  name: 'Holiday Present',
  visual: {
    kind: 'procedural',
    preset: 'present',
    palette: ['#e63946', '#ffd166', '#ffffff'],
    scale: 1.0,
    variant: 'standard',
    outline: true,
  },
  basePoints: 100,
  pickupPoints: 25,
  bagWeight: 1,
  pickupRadius: 2.3,
  glowColor: '#ff4d6d',
};

export const PRESENT_GOLDEN: PresentDef = {
  id: 'gift_golden',
  name: 'Golden Star Present',
  visual: {
    kind: 'procedural',
    preset: 'present',
    palette: ['#ffb703', '#ffffff', '#fb8500'],
    scale: 1.2,
    variant: 'golden',
    outline: true,
  },
  basePoints: 350,
  pickupPoints: 75,
  bagWeight: 1,
  pickupRadius: 2.6,
  glowColor: '#ffd700',
};

export const PRESENTS: Readonly<Record<string, PresentDef>> = {
  [PRESENT_STANDARD.id]: PRESENT_STANDARD,
  [PRESENT_GOLDEN.id]: PRESENT_GOLDEN,
};

export function getPresentDef(id: string): PresentDef | undefined {
  return PRESENTS[id];
}
