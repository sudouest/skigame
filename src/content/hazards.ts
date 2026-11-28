import type { HazardDef, RampDef } from './types';

export const HAZARD_BOULDER_SMALL: HazardDef = {
  id: 'boulder_small',
  name: 'Low Boulder',
  visual: {
    kind: 'procedural',
    preset: 'boulder',
    palette: ['#64748b', '#94a3b8', '#e2e8f0'],
    scale: 0.85,
    variant: 'small',
    outline: true,
  },
  collider: {
    shape: 'cylinder',
    radius: 0.95,
    height: 0.72,
  },
  impact: {
    effect: 'stumble',
    presentsDropped: 1,
    speedRetention: 0.58,
  },
  lethal: false,
};

export const HAZARD_BOULDER_LARGE: HazardDef = {
  id: 'boulder_large',
  name: 'Giant Granite Boulder',
  visual: {
    kind: 'procedural',
    preset: 'boulder',
    palette: ['#475569', '#64748b', '#cbd5e1'],
    scale: 1.85,
    variant: 'large',
    outline: true,
  },
  collider: {
    shape: 'cylinder',
    radius: 1.85,
    height: 2.35,
  },
  impact: {
    effect: 'wipeout',
    presentsDropped: 3,
    speedRetention: 0,
  },
  lethal: true,
};

export const HAZARD_PINE_TREE: HazardDef = {
  id: 'pine_tree',
  name: 'Tall Alpine Pine',
  visual: {
    kind: 'procedural',
    preset: 'pine',
    palette: ['#1b4332', '#2d6a4f', '#5c4033', '#f8fafc'],
    scale: 1.0,
    variant: 'tall',
    outline: true,
  },
  collider: {
    shape: 'cylinder',
    radius: 0.8,
    height: 6.5,
  },
  impact: {
    effect: 'wipeout',
    presentsDropped: 3,
    speedRetention: 0,
  },
  lethal: true,
};

const RAMP_SHARED_PALETTE = ['#f5f8fc', '#7f6f5d', '#ff6a00', '#38f6ff', '#2e452d'] as const;

export const RAMP_GENTLE: RampDef = {
  id: 'ski_ramp_gentle',
  name: 'Gentle Roller Kicker',
  visual: {
    kind: 'procedural',
    preset: 'ramp',
    palette: RAMP_SHARED_PALETTE,
    scale: 1.0,
    variant: 'gentle',
    outline: true,
  },
  width: 4.4,
  length: 6.8,
  height: 0.95,
  lipPitchBoostDeg: 12,
  landingClearanceM: 24,
};

export const DEFAULT_RAMP: RampDef = {
  id: 'ski_ramp_standard',
  name: 'Powder Kicker Ramp',
  visual: {
    kind: 'procedural',
    preset: 'ramp',
    palette: RAMP_SHARED_PALETTE,
    scale: 1.0,
    variant: 'standard',
    outline: true,
  },
  width: 4.2,
  length: 6.5,
  height: 1.35,
  lipPitchBoostDeg: 18,
  landingClearanceM: 28,
};

export const RAMP_STANDARD: RampDef = DEFAULT_RAMP;

export const RAMP_STEEP: RampDef = {
  id: 'ski_ramp_steep',
  name: 'Big Air Steep Kicker',
  visual: {
    kind: 'procedural',
    preset: 'ramp',
    palette: RAMP_SHARED_PALETTE,
    scale: 1.0,
    variant: 'steep',
    outline: true,
  },
  width: 4.0,
  length: 6.0,
  height: 2.25,
  lipPitchBoostDeg: 25,
  landingClearanceM: 48,
};

export const HAZARDS: Readonly<Record<string, HazardDef>> = {
  [HAZARD_BOULDER_SMALL.id]: HAZARD_BOULDER_SMALL,
  [HAZARD_BOULDER_LARGE.id]: HAZARD_BOULDER_LARGE,
  [HAZARD_PINE_TREE.id]: HAZARD_PINE_TREE,
};

export const RAMPS: Readonly<Record<string, RampDef>> = {
  [RAMP_GENTLE.id]: RAMP_GENTLE,
  [DEFAULT_RAMP.id]: DEFAULT_RAMP,
  [RAMP_STEEP.id]: RAMP_STEEP,
};

export function getHazardDef(id: string): HazardDef | undefined {
  return HAZARDS[id];
}

export function getRampDef(id: string): RampDef | undefined {
  return RAMPS[id];
}
