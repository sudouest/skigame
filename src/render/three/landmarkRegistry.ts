import * as THREE from 'three';
import type { LandmarkYawPolicy } from '../../content/types';
import type { SegmentLandmarkRequirement } from '../../sim/contracts';
import type { GraphicsUtils } from './graphicsUtils';
import type { ProceduralMeshAssets } from './meshFactory';
import { createFolkAFrameLandmarkDef } from './models/folkAFrameModel';
import { createFolkCabinLandmarkDef } from './models/folkCabinModel';
import { createTrailGateLandmarkDef } from './models/trailGateModel';
import type { SharedToonMaterials } from './toonMaterials';

export interface ChimneyEmitterAnchor {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly tiltX: number;
  readonly tiltZ: number;
  readonly puffScale?: number;
}

export interface LandmarkInstanceHandle {
  readonly group: THREE.Group;
  readonly configure?: (lm: SegmentLandmarkRequirement, segmentSeed: number) => void;
}

export interface LandmarkModelDef {
  readonly id: string;
  readonly poolCapacity: number;
  readonly yawPolicy: LandmarkYawPolicy;
  readonly smokeAnchors?: readonly ChimneyEmitterAnchor[];
  readonly createInstance: (index: number) => LandmarkInstanceHandle;
}

/**
 * Dependency-injected registry mapping landmark visual signatures (e.g. `forkArch`,
 * `proc:cabin:folk_log`, `proc:cabin:folk_aframe`, `mesh:<id>`) to pool descriptors
 * and chimney smoke emitters.
 */
export class LandmarkModelRegistry {
  private readonly defs = new Map<string, LandmarkModelDef>();
  private readonly aliases = new Map<string, string>();

  register(def: LandmarkModelDef): this {
    this.defs.set(def.id, def);
    return this;
  }

  alias(fromId: string, toId: string): this {
    this.aliases.set(fromId, toId);
    return this;
  }

  resolve(id: string): LandmarkModelDef | undefined {
    const direct = this.defs.get(id);
    if (direct) return direct;
    const targetId = this.aliases.get(id);
    return targetId !== undefined ? this.defs.get(targetId) : undefined;
  }

  getDefs(): readonly LandmarkModelDef[] {
    return Array.from(this.defs.values());
  }
}

/**
 * Builds the default landmark model registry populated with fork arches, delivery lanterns,
 * delivery arches, the Folk Log Cabin, and the Folk A-Frame Chalet.
 */
export function createDefaultLandmarkRegistry(
  gfx: GraphicsUtils,
  materials: SharedToonMaterials,
  meshAssets: ProceduralMeshAssets,
  outlineMaterial?: THREE.Material,
): LandmarkModelRegistry {
  const registry = new LandmarkModelRegistry();

  registry.register(createTrailGateLandmarkDef(gfx, materials, outlineMaterial));

  registry.register({
    id: 'proc:lantern',
    poolCapacity: 12,
    yawPolicy: 'none',
    createInstance: (index) => {
      const group = new THREE.Group();
      group.name = `PooledDeliveryLantern_${index}`;
      const postMesh = gfx.createMesh(
        meshAssets.lanternPostGeo,
        materials.propToonMaterial,
        `LanternPost_${index}`,
      );
      postMesh.castShadow = true;
      const glowMesh = gfx.createMesh(
        meshAssets.lanternGlowGeo,
        materials.beaconGlowMaterial,
        `LanternGlow_${index}`,
      );
      glowMesh.castShadow = false;
      group.add(postMesh, glowMesh);
      gfx.markAsCache(group, group.name);
      return { group };
    },
  });

  registry.register({
    id: 'proc:arch',
    poolCapacity: 8,
    yawPolicy: 'none',
    createInstance: (index) => {
      const group = new THREE.Group();
      group.name = `PooledDeliveryArch_${index}`;
      const archMesh = gfx.createMesh(
        meshAssets.deliveryArchGeo,
        materials.propToonMaterial,
        `DeliveryArch_${index}`,
      );
      archMesh.castShadow = true;
      const glowMesh = gfx.createMesh(
        meshAssets.deliveryArchGlowGeo,
        materials.beaconGlowMaterial,
        `DeliveryArchGlow_${index}`,
      );
      glowMesh.castShadow = false;
      group.add(archMesh, glowMesh);
      gfx.markAsCache(group, group.name);
      return { group };
    },
  });

  registry.register(createFolkCabinLandmarkDef(gfx, materials, outlineMaterial));
  registry.register(createFolkAFrameLandmarkDef(gfx, materials, outlineMaterial));
  registry.alias('proc:cabin', 'proc:cabin:folk_log');

  return registry;
}
