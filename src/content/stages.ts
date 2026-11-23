import type { StageDef, WeatherProfile } from './types';

export const WEATHER_SUNNY: WeatherProfile = {
  id: 'weather_sunny',
  snowParticleCount: 24,
  windLateral: 1.5,
  fogMinDist: 145,
  fogMaxDist: 280,
  blizzardDim: 0,
  durationRangeSec: [30, 60],
};

export const WEATHER_CRISP_MOUNTAIN: WeatherProfile = {
  id: 'weather_crisp_mountain',
  snowParticleCount: 85,
  windLateral: 4.5,
  fogMinDist: 100,
  fogMaxDist: 210,
  blizzardDim: 0.12,
  durationRangeSec: [25, 50],
};

export const WEATHER_BLIZZARD: WeatherProfile = {
  id: 'weather_blizzard',
  snowParticleCount: 240,
  windLateral: 12.5,
  fogMinDist: 68,
  fogMaxDist: 125,
  blizzardDim: 0.35,
  durationRangeSec: [18, 35],
};

export const STAGE_SUNNY_BLUE: StageDef = {
  id: 'sunny-blue',
  name: 'Sunny Blue Run',
  subtitle: 'Wide packed-snow cruiser with gentle rollers and steady gifts',
  difficulty: 'blue',
  pacingRole: 'breather',
  scoreMultiplier: 1.0,
  badge: {
    shape: 'square',
    color: '#2563eb',
    label: 'BLUE RUN',
  },
  terrain: {
    pitchDeg: [10, 16],
    curveStrength: [0.004, 0.011],
    halfWidth: [14, 18],
    skirtWidth: 12,
    bankingFactor: 0.35,
    mogulDensity: 0.18,
    icePatchChance: 0.06,
    powderPatchChance: 0.18,
    rollerFrequency: 0.012,
    rollerAmplitude: 1.4,
    rampChance: 0.12,
  },
  weather: WEATHER_SUNNY,
  palette: {
    skyTop: '#3a86ff',
    skyBottom: '#bce0fd',
    fogColor: '#d7eefc',
    snowColor: '#f8fbff',
    shadowSnowTint: '#b8d4f2',
    bankTint: '#e3f0fc',
    iceTint: '#90e0ef',
    powderTint: '#ffffff',
    sunColor: '#fff6d6',
    ambientColor: '#90c2f9',
    biomeTint: '#ffffff',
  },
  surfaceWeights: {
    packed: 0.76,
    powder: 0.18,
    ice: 0.06,
  },
  layout: {
    segmentLengthRange: [280, 360],
    forkIntervalM: [280, 360],
    islandDividerChance: 0.25,
    deliveryCadenceM: [155, 220],
    obstacles: [
      {
        targetId: 'boulder_small',
        weight: 0.45,
        pattern: 'scatter',
        band: 'slalom',
        countRange: [2, 4],
        spacingM: [22, 36],
        minSafeClearanceM: 1.5,
      },
      {
        targetId: 'pine_tree',
        weight: 0.35,
        pattern: 'staggered',
        band: 'nearEdge',
        countRange: [2, 5],
        spacingM: [20, 34],
        minSafeClearanceM: 3.2,
      },
      {
        targetId: 'boulder_large',
        weight: 0.2,
        pattern: 'scatter',
        band: 'middle',
        countRange: [1, 2],
        spacingM: [32, 48],
        minSafeClearanceM: 3.0,
      },
    ],
    presents: [
      {
        targetId: 'gift_standard',
        weight: 0.85,
        pattern: 'sequence',
        band: 'onPath',
        countRange: [3, 6],
        spacingM: [9, 14],
        minSafeClearanceM: 0,
      },
      {
        targetId: 'gift_golden',
        weight: 0.15,
        pattern: 'sequence',
        band: 'slalom',
        countRange: [1, 2],
        spacingM: [16, 26],
        minSafeClearanceM: 0,
      },
    ],
    deliveryZones: [
      { deliveryZoneId: 'child_solo', weight: 0.5, band: 'nearEdge' },
      { deliveryZoneId: 'sled_duo', weight: 0.35, band: 'nearEdge' },
      { deliveryZoneId: 'village_plaza', weight: 0.15, band: 'nearEdge' },
    ],
    creatures: [
      {
        creatureId: 'bear_patrol',
        weight: 1.0,
        band: 'middle',
        spacingM: [160, 240],
        maxPerSegment: 1,
      },
    ],
    scenery: {
      pineDensity: 0.55,
      rockDensity: 0.25,
      groundMinRadius: 2.2,
      canopyMinRadius: 4.5,
    },
  },
  forkTargets: ['sunny-blue', 'icy-black'],
};

export const STAGE_ICY_BLACK: StageDef = {
  id: 'icy-black',
  name: 'Icy Black Diamond',
  subtitle: 'Narrow glacial chute with steep crest drops, jump ramps, and golden gifts',
  difficulty: 'black',
  pacingRole: 'intense',
  scoreMultiplier: 2.0,
  badge: {
    shape: 'diamond',
    color: '#111827',
    label: 'BLACK DIAMOND',
  },
  terrain: {
    pitchDeg: [24, 33],
    curveStrength: [0.008, 0.017],
    halfWidth: [8.5, 11.5],
    skirtWidth: 10,
    bankingFactor: 0.52,
    mogulDensity: 0.42,
    icePatchChance: 0.36,
    powderPatchChance: 0.12,
    rollerFrequency: 0.02,
    rollerAmplitude: 3.1,
    rampChance: 0.35,
  },
  weather: WEATHER_CRISP_MOUNTAIN,
  palette: {
    skyTop: '#1d3557',
    skyBottom: '#8fb8de',
    fogColor: '#b7d4ec',
    snowColor: '#eef6ff',
    shadowSnowTint: '#8eb6db',
    bankTint: '#cfe4f7',
    iceTint: '#5ce1e6',
    powderTint: '#f5faff',
    sunColor: '#e0f2fe',
    ambientColor: '#72a3d4',
    biomeTint: '#d8ebff',
  },
  surfaceWeights: {
    packed: 0.52,
    powder: 0.12,
    ice: 0.36,
  },
  layout: {
    segmentLengthRange: [260, 340],
    forkIntervalM: [260, 340],
    islandDividerChance: 0.45,
    deliveryCadenceM: [155, 215],
    obstacles: [
      {
        targetId: 'boulder_large',
        weight: 0.38,
        pattern: 'gate',
        band: 'slalom',
        countRange: [2, 3],
        spacingM: [20, 30],
        minSafeClearanceM: 2.8,
      },
      {
        targetId: 'pine_tree',
        weight: 0.34,
        pattern: 'cluster',
        band: 'nearEdge',
        countRange: [2, 4],
        spacingM: [16, 26],
        minSafeClearanceM: 3.0,
      },
      {
        targetId: 'boulder_small',
        weight: 0.28,
        pattern: 'sequence',
        band: 'onPath',
        countRange: [2, 3],
        spacingM: [18, 28],
        minSafeClearanceM: 1.2,
      },
    ],
    presents: [
      {
        targetId: 'gift_golden',
        weight: 0.45,
        pattern: 'sequence',
        band: 'slalom',
        countRange: [2, 4],
        spacingM: [11, 16],
        minSafeClearanceM: 0,
      },
      {
        targetId: 'gift_standard',
        weight: 0.55,
        pattern: 'sequence',
        band: 'onPath',
        countRange: [3, 5],
        spacingM: [9, 13],
        minSafeClearanceM: 0,
      },
    ],
    deliveryZones: [
      { deliveryZoneId: 'sled_duo', weight: 0.5, band: 'nearEdge' },
      { deliveryZoneId: 'village_plaza', weight: 0.3, band: 'nearEdge' },
      { deliveryZoneId: 'child_solo', weight: 0.2, band: 'nearEdge' },
    ],
    creatures: [
      {
        creatureId: 'bear_patrol',
        weight: 1.0,
        band: 'slalom',
        spacingM: [120, 190],
        maxPerSegment: 2,
      },
    ],
    scenery: {
      pineDensity: 0.42,
      rockDensity: 0.55,
      groundMinRadius: 2.0,
      canopyMinRadius: 4.2,
    },
  },
  forkTargets: ['sunny-blue', 'icy-black'],
};

export const STAGES: Readonly<Record<string, StageDef>> = {
  [STAGE_SUNNY_BLUE.id]: STAGE_SUNNY_BLUE,
  [STAGE_ICY_BLACK.id]: STAGE_ICY_BLACK,
};

export const WEATHER_PROFILES: Readonly<Record<string, WeatherProfile>> = {
  [WEATHER_SUNNY.id]: WEATHER_SUNNY,
  [WEATHER_CRISP_MOUNTAIN.id]: WEATHER_CRISP_MOUNTAIN,
  [WEATHER_BLIZZARD.id]: WEATHER_BLIZZARD,
};

export function getStageDef(id: string): StageDef | undefined {
  return STAGES[id];
}

export function getAllStages(): readonly StageDef[] {
  return [STAGE_SUNNY_BLUE, STAGE_ICY_BLACK];
}
