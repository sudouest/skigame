import * as THREE from 'three';
import type { GraphicsUtils } from './graphicsUtils';
import type { SharedLightingUniforms } from './toonMaterials';

/**
 * Builds a ground-pivoted unit billboard plane (`x in [-0.5, 0.5]`, `y in [0, 1]`)
 * so instance world positions place the bottom of trees, children, and bears flush on terrain.
 */
export function createBillboardQuadGeometry(gfx: GraphicsUtils): THREE.BufferGeometry {
  const geo = new THREE.PlaneGeometry(1, 1);
  geo.translate(0, 0.5, 0);
  geo.name = 'BillboardQuadGeometry';
  gfx.markAsCache(geo, 'BillboardQuadGeometry');
  return geo;
}

/**
 * Creates a GPU-instanced Y-axis cylindrical billboard material by patching
 * `THREE.MeshBasicMaterial` via `onBeforeCompile`.
 * Requires per-instance `aUvRect` (`vec4`: `uOffset, vOffset, uScale, vScale`) and
 * `aTilt` (`float`: screen-space CCW radians around ground pivot `(0, 0)`) buffer attributes,
 * supplied by `InstancePools`'s `createBillboardPoolMesh`.
 * Preserves automatic Three.js scene fog integration, enforces cutout sorting safety
 * (`alphaTest: 0.5`, `transparent: false`, `depthWrite: true`), gates `alphaToCoverage`
 * on MSAA contexts, and shares `uBiomeTint` / `uBlizzardDim` uniforms.
 */
export function createCylindricalBillboardMaterial(
  gfx: GraphicsUtils,
  atlasTexture: THREE.Texture,
  sharedUniforms: SharedLightingUniforms,
  antialiasEnabled: boolean,
  materialName = 'CylindricalBillboardMaterial',
): THREE.MeshBasicMaterial {
  const mat = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    map: atlasTexture,
    alphaTest: 0.5,
    transparent: false,
    depthWrite: true,
    side: THREE.DoubleSide,
    fog: true,
  });
  mat.alphaToCoverage = antialiasEnabled;
  mat.name = materialName;

  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uBiomeTint = sharedUniforms.uBiomeTint;
    shader.uniforms.uBlizzardDim = sharedUniforms.uBlizzardDim;

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <uv_pars_vertex>',
        `#include <uv_pars_vertex>
attribute vec4 aUvRect;
attribute float aTilt;`,
      )
      .replace(
        '#include <uv_vertex>',
        `#include <uv_vertex>
#ifdef USE_MAP
  vMapUv = uv * aUvRect.zw + aUvRect.xy;
#endif`,
      )
      .replace(
        '#include <project_vertex>',
        `#ifdef USE_INSTANCING
  vec4 bbCenterWorld = modelMatrix * vec4(instanceMatrix[3].xyz, 1.0);
  float bbScaleX = length(instanceMatrix[0].xyz);
  float bbScaleY = length(instanceMatrix[1].xyz);
#else
  vec4 bbCenterWorld = modelMatrix * vec4(0.0, 0.0, 0.0, 1.0);
  float bbScaleX = 1.0;
  float bbScaleY = 1.0;
#endif
vec2 bbToCamXZ = cameraPosition.xz - bbCenterWorld.xz;
float bbLenXZ = length(bbToCamXZ);
vec2 bbFwdXZ = bbLenXZ > 1e-4 ? (bbToCamXZ / bbLenXZ) : vec2(0.0, 1.0);
vec3 bbRightWorld = vec3(bbFwdXZ.y, 0.0, -bbFwdXZ.x);
float bbCosT = cos(aTilt);
float bbSinT = sin(aTilt);
float bbLocalX = transformed.x * bbScaleX;
float bbLocalY = transformed.y * bbScaleY;
float bbRotX = bbLocalX * bbCosT - bbLocalY * bbSinT;
float bbRotY = bbLocalX * bbSinT + bbLocalY * bbCosT;
// Flip horizontally if instanceScaleX is negative via aUvRect.z sign rather than negative matrix scale.
vec3 bbWorldPos = bbCenterWorld.xyz
  + bbRightWorld * bbRotX
  + vec3(0.0, bbRotY, 0.0);
vec4 mvPosition = viewMatrix * vec4(bbWorldPos, 1.0);
gl_Position = projectionMatrix * mvPosition;`,
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
uniform vec3 uBiomeTint;
uniform float uBlizzardDim;`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
diffuseColor.rgb *= mix(vec3(1.0), uBiomeTint, 0.35) * (1.0 - uBlizzardDim * 0.42);`,
      );
  };

  mat.customProgramCacheKey = () =>
    antialiasEnabled ? 'cylindrical-billboard-msaa-v2' : 'cylindrical-billboard-v2';

  gfx.markAsCache(mat, materialName);
  return mat;
}
