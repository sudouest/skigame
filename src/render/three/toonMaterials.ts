import * as THREE from 'three';
import type { GraphicsUtils } from './graphicsUtils';

export interface SharedLightingUniforms {
  readonly uBiomeTint: { value: THREE.Color };
  readonly uBlizzardDim: { value: number };
}

export interface SharedToonMaterials {
  readonly gradientMap: THREE.DataTexture;
  readonly sharedUniforms: SharedLightingUniforms;
  readonly terrainMaterial: THREE.MeshToonMaterial;
  readonly propToonMaterial: THREE.MeshToonMaterial;
  readonly beaconGlowMaterial: THREE.MeshBasicMaterial;
}

/**
 * Creates the single cached 3x1 toon gradient DataTexture ([95, 185, 255])
 * and shared toon materials so terrain chunks, props, and beacons never duplicate shaders.
 */
export function createSharedToonMaterials(gfx: GraphicsUtils): SharedToonMaterials {
  const gradientData = new Uint8Array([
    95, 95, 95, 255,
    185, 185, 185, 255,
    255, 255, 255, 255,
  ]);
  const gradientMap = new THREE.DataTexture(
    gradientData,
    3,
    1,
    THREE.RGBAFormat,
    THREE.UnsignedByteType,
  );
  gradientMap.name = 'ToonGradientMap3x1';
  gradientMap.minFilter = THREE.NearestFilter;
  gradientMap.magFilter = THREE.NearestFilter;
  gradientMap.generateMipmaps = false;
  gradientMap.colorSpace = THREE.NoColorSpace;
  gradientMap.unpackAlignment = 1;
  gradientMap.needsUpdate = true;
  gfx.markAsCache(gradientMap, 'ToonGradientMap');

  const sharedUniforms: SharedLightingUniforms = {
    uBiomeTint: { value: new THREE.Color(1, 1, 1) },
    uBlizzardDim: { value: 0 },
  };

  const patchToonTint = (mat: THREE.MeshToonMaterial): void => {
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uBiomeTint = sharedUniforms.uBiomeTint;
      shader.uniforms.uBlizzardDim = sharedUniforms.uBlizzardDim;

      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
uniform vec3 uBiomeTint;
uniform float uBlizzardDim;`,
        )
        .replace(
          '#include <opaque_fragment>',
          `outgoingLight *= mix(vec3(1.0), uBiomeTint, 0.25) * (1.0 - uBlizzardDim * 0.35);
#include <opaque_fragment>`,
        );
    };
    mat.customProgramCacheKey = () => 'toon-biome-blizzard-v1';
  };

  const terrainMaterial = new THREE.MeshToonMaterial({
    color: 0xffffff,
    vertexColors: true,
    gradientMap,
  });
  terrainMaterial.name = 'SharedTerrainRibbonToonMaterial';
  patchToonTint(terrainMaterial);
  gfx.markAsCache(terrainMaterial, 'SharedTerrainRibbonToonMaterial');

  const propToonMaterial = new THREE.MeshToonMaterial({
    color: 0xffffff,
    vertexColors: true,
    gradientMap,
  });
  propToonMaterial.name = 'SharedPropToonMaterial';
  patchToonTint(propToonMaterial);
  gfx.markAsCache(propToonMaterial, 'SharedPropToonMaterial');

  // Unlit warm glow material for Delivery Zone beacons & golden accents that pierce blizzard fog.
  const beaconGlowMaterial = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    vertexColors: true,
    fog: false,
  });
  beaconGlowMaterial.name = 'SharedBeaconGlowMaterial';
  gfx.markAsCache(beaconGlowMaterial, 'SharedBeaconGlowMaterial');

  return {
    gradientMap,
    sharedUniforms,
    terrainMaterial,
    propToonMaterial,
    beaconGlowMaterial,
  };
}
