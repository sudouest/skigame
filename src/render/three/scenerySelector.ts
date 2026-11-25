import type {
  ScenerySpeciesKind,
  SceneryTierRule,
  StageSceneryConfig,
} from '../../content/types';
import { clamp, smoothstep } from '../../core/math';
import type { BillboardFrameName } from './spriteAtlas';

export type TerrainLodTier = 0 | 1;

export interface SceneryEnvSignal {
  minNormalY: number;
  distFromTrail: number;
  relElevation: number;
  worldNoise01: number;
  lod: TerrainLodTier;
  scenery: StageSceneryConfig;
}

const OUTER_LOD_SLOPE_MARGIN = 0.07;

export function computeStageSceneryDensity(scenery: StageSceneryConfig): number {
  return clamp(
    scenery.offPisteTreeDensity + scenery.rockDensity * 0.45 + scenery.shrubDensity * 0.35,
    0,
    1.35,
  );
}

function getStageSpeciesFactor(
  species: ScenerySpeciesKind,
  scenery: StageSceneryConfig,
): number {
  switch (species) {
    case 'pine_green':
      return Math.max(0, scenery.offPisteTreeDensity) * (1 - clamp(scenery.frostedPineChance, 0, 1));
    case 'pine_frosted':
      return Math.max(0, scenery.offPisteTreeDensity) * clamp(scenery.frostedPineChance, 0, 1);
    case 'snow_shrub':
      return Math.max(0, scenery.shrubDensity);
    case 'alpine_rock':
      return Math.max(0, scenery.rockDensity) * 0.75;
    case 'rock_crag':
      return Math.max(0, scenery.rockDensity) * 0.65;
    default: {
      const _exhaustive: never = species;
      return _exhaustive;
    }
  }
}

export function evaluateSceneryRuleFitness(
  rule: SceneryTierRule,
  signal: SceneryEnvSignal,
): number {
  const lodMargin = signal.lod === 1 ? OUTER_LOD_SLOPE_MARGIN : 0;
  if (signal.minNormalY < rule.minNormalY + lodMargin) {
    return 0;
  }
  if (signal.distFromTrail < rule.minDistFromTrailM) {
    return 0;
  }

  const stageFactor = getStageSpeciesFactor(rule.species, signal.scenery);
  if (stageFactor <= 1e-4) {
    return 0;
  }

  const spread = Math.max(0.05, rule.normalYSpread);
  const slopeDelta = (signal.minNormalY - rule.preferredNormalY) / spread;
  const slopeScore = Math.exp(-0.5 * slopeDelta * slopeDelta);

  const idealDist = Math.max(rule.minDistFromTrailM + 1, rule.idealDistFromTrailM);
  const distScore = 0.35 + 0.65 * smoothstep(rule.minDistFromTrailM, idealDist, signal.distFromTrail);

  const elevNorm = clamp(signal.relElevation / 20, -1, 1);
  const elevScore = clamp(1 + rule.elevationBias * elevNorm * 0.55, 0.35, 1.65);

  const noise01 = clamp(signal.worldNoise01, 0, 1);
  let noiseMod: number;
  switch (rule.species) {
    case 'alpine_rock':
    case 'rock_crag':
      noiseMod = 0.65 + 0.7 * (1 - noise01);
      break;
    case 'pine_frosted':
      noiseMod = 0.7 + 0.6 * noise01;
      break;
    case 'pine_green':
    case 'snow_shrub':
      noiseMod = 0.75 + 0.5 * noise01;
      break;
    default: {
      const _exhaustive: never = rule.species;
      noiseMod = _exhaustive;
      break;
    }
  }

  return rule.baseWeight * stageFactor * slopeScore * distScore * elevScore * noiseMod;
}

/**
 * Selects a single winning scenery rule without heap allocations, skipping canopy trees
 * when `canopyBlocked` is true so ground cover naturally tucks beneath pine crowns.
 */
export function selectWinningSceneryRule(
  rules: readonly SceneryTierRule[],
  signal: SceneryEnvSignal,
  canopyBlocked: boolean,
  rngRoll01: number,
): SceneryTierRule | null {
  let totalWeight = 0;
  let lastEligible: SceneryTierRule | null = null;

  for (let i = 0; i < rules.length; i++) {
    const rule = rules[i]!;
    if (canopyBlocked && rule.layer === 'canopy') continue;
    const f = evaluateSceneryRuleFitness(rule, signal);
    if (f <= 0) continue;
    totalWeight += f * f;
    lastEligible = rule;
  }

  if (totalWeight <= 0 || lastEligible === null) {
    return null;
  }

  const target = clamp(rngRoll01, 0, 0.999999) * totalWeight;
  let acc = 0;
  for (let i = 0; i < rules.length; i++) {
    const rule = rules[i]!;
    if (canopyBlocked && rule.layer === 'canopy') continue;
    const f = evaluateSceneryRuleFitness(rule, signal);
    if (f <= 0) continue;
    acc += f * f;
    if (acc >= target) {
      return rule;
    }
  }

  return lastEligible;
}

export function speciesToBillboardFrame(species: ScenerySpeciesKind): BillboardFrameName {
  switch (species) {
    case 'pine_green':
      return 'pine_green';
    case 'pine_frosted':
      return 'pine_frosted';
    case 'snow_shrub':
      return 'snow_shrub';
    case 'alpine_rock':
      return 'alpine_rock';
    case 'rock_crag':
      return 'rock_crag';
    default: {
      const _exhaustive: never = species;
      throw new Error(`Unhandled scenery species: ${String(_exhaustive)}`);
    }
  }
}

export function computeScenerySlopeSinkY(
  species: ScenerySpeciesKind,
  minNormalY: number,
  width: number,
): number {
  if (species === 'alpine_rock' || species === 'rock_crag') {
    return Math.max(0, 1 - minNormalY) * width * 0.45;
  }
  if (species === 'pine_green' || species === 'pine_frosted') {
    return Math.max(0, 1 - minNormalY) * width * 0.25;
  }
  return 0;
}
