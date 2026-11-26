import * as THREE from 'three';
import { STAGE_SUNNY_BLUE } from '../../content/stages';
import { createChimneySmokeAssets } from './chimneySmoke';
import type { ClipmapDataStore } from './clipmapDataStore';
import type { GraphicsUtils } from './graphicsUtils';

/**
 * Period (meters) for rebase-invariant world-space procedural noise offset wrapping.
 * Every shader noise frequency is a rational multiple of 1/16 cycles/m and hashes
 * wrap modulo 64 lattice cells, guaranteeing bit-exact continuity across both
 * 128 m floating-origin rebases and 1024 m modulo wraps.
 */
export const NOISE_ORIGIN_MOD_PERIOD = 1024;

export function positiveMod(value: number, period: number): number {
  return ((value % period) + period) % period;
}

export interface SharedLightingUniforms {
  readonly uBiomeTint: { value: THREE.Color };
  readonly uBlizzardDim: { value: number };
  readonly uShadowSnowTint: { value: THREE.Color };
  readonly uSkyTopColor: { value: THREE.Color };
  readonly uCliffColor: { value: THREE.Color };
  readonly uNoiseOriginModXZ: { value: THREE.Vector2 };
  readonly uNoiseOriginModY: { value: number };
}

export interface ClipmapShaderUniforms {
  readonly uHeightTex: { value: THREE.DataArrayTexture | null };
  readonly uNormalMaskTex: { value: THREE.DataArrayTexture | null };
  readonly uAlbedoTex: { value: THREE.DataArrayTexture | null };
  readonly uFlowElevTex: { value: THREE.DataArrayTexture | null };
  readonly uFocusLocalXZ: { value: THREE.Vector2 };
  readonly uLayerOriginModXZ: { value: THREE.Vector2[] };
  readonly uLayerInvSpan: { value: number[] };
  readonly uMorphEnds: { value: number[] };
}

export interface SharedToonMaterials {
  readonly gradientMap: THREE.DataTexture;
  readonly sharedUniforms: SharedLightingUniforms;
  readonly clipmapUniforms: ClipmapShaderUniforms;
  readonly terrainMaterial: THREE.MeshToonMaterial;
  readonly propToonMaterial: THREE.MeshToonMaterial;
  readonly beaconGlowMaterial: THREE.MeshBasicMaterial;
  readonly cabinSmokeTexture: THREE.Texture;
  readonly cabinSmokeMaterial: THREE.MeshBasicMaterial;
}

/**
 * Patches a `MeshToonMaterial` with shared `uBiomeTint` and `uBlizzardDim` uniforms.
 */
export function patchToonTint(
  mat: THREE.MeshToonMaterial,
  sharedUniforms: SharedLightingUniforms,
  cacheKey = 'toon-biome-blizzard-v1',
): void {
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
  mat.customProgramCacheKey = () => cacheKey;
}

/**
 * Creates and caches a textured `MeshToonMaterial` sharing the global 3x1 `gradientMap`
 * and `uBiomeTint` / `uBlizzardDim` lighting uniforms.
 */
export function createTexturedToonMaterial(
  gfx: GraphicsUtils,
  map: THREE.Texture,
  gradientMap: THREE.DataTexture,
  sharedUniforms: SharedLightingUniforms,
  label: string,
): THREE.MeshToonMaterial {
  const mat = new THREE.MeshToonMaterial({
    color: 0xffffff,
    map,
    vertexColors: false,
    gradientMap,
  });
  mat.name = label;
  patchToonTint(mat, sharedUniforms, 'toon-textured-biome-blizzard-v1');
  gfx.markAsCache(mat, label);
  return mat;
}

/**
 * Binds `ClipmapDataStore`'s 4 `DataArrayTexture`s to `materials.clipmapUniforms` and registers
 * them on `materials.terrainMaterial.userData.trackedTextures` so `GraphicsTracker` ref-counts
 * and disposes all 4 GPU array textures with zero leaks.
 * Call BEFORE creating the `TerrainClipmap` `InstancedMesh`.
 */
export function bindClipmapStoreToMaterial(
  gfx: GraphicsUtils,
  materials: SharedToonMaterials,
  store: ClipmapDataStore,
): void {
  materials.clipmapUniforms.uHeightTex.value = store.heightTex;
  materials.clipmapUniforms.uNormalMaskTex.value = store.normalMaskTex;
  materials.clipmapUniforms.uAlbedoTex.value = store.albedoTex;
  materials.clipmapUniforms.uFlowElevTex.value = store.flowElevTex;

  materials.terrainMaterial.userData.trackedTextures = [
    store.heightTex,
    store.normalMaskTex,
    store.albedoTex,
    store.flowElevTex,
  ];
  gfx.markAsCache(materials.terrainMaterial, 'SharedTerrainClipmapToonMaterial');
}

/**
 * Creates the single cached 3x1 toon gradient DataTexture ([95, 185, 255])
 * and shared toon materials so CDLOD terrain, props, and beacons share compiled programs.
 *
 * `terrainMaterial` (`terrain-cdlod-snow-toon-v3`) combines:
 * - Instanced CDLOD vertex displacement via `texelFetch(uHeightTex, ...)` (`R32F`, `NearestFilter`)
 *   with exact Strugar geomorphing (`ivec2(round(aPatchTex.xy))`, `int(round(aPatchTex.z))`, `distXZ`)
 * - Vertex normal reconstruction from `uNormalMaskTex` BEFORE `<defaultnormal_vertex>` so
 *   `BasicShadowMap` `shadowNormalBias` uses true terrain normals rather than flat `(0, 1, 0)`
 * - Fragment morph-band seam blending (`vMorph > 0.001 && fragLod < 4`) across `uNormalMaskTex`,
 *   `uAlbedoTex` (`SRGBColorSpace`), and `uFlowElevTex`
 * - M2 chromatic alpine snow-toon hybrid shading: cool `uShadowSnowTint` shadow terminator,
 *   continuous sunlit slope gradient (`0.84 + 0.16 * saturate(ndl)`), crest Fresnel `uSkyTopColor`,
 *   CPU-baked Laplacian + chasm AO, `C^1` 32m-tiled flow-aligned corduroy, off-piste sastrugi,
 *   grazing snow sparkle, glossy specular ice patches, and stratified granite cliffs.
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
    uShadowSnowTint: { value: new THREE.Color(STAGE_SUNNY_BLUE.palette.shadowSnowTint) },
    uSkyTopColor: { value: new THREE.Color(STAGE_SUNNY_BLUE.palette.skyTop) },
    uCliffColor: { value: new THREE.Color(STAGE_SUNNY_BLUE.palette.cliffColor) },
    uNoiseOriginModXZ: { value: new THREE.Vector2(0, 0) },
    uNoiseOriginModY: { value: 0 },
  };

  const clipmapUniforms: ClipmapShaderUniforms = {
    uHeightTex: { value: null },
    uNormalMaskTex: { value: null },
    uAlbedoTex: { value: null },
    uFlowElevTex: { value: null },
    uFocusLocalXZ: { value: new THREE.Vector2(0, 0) },
    uLayerOriginModXZ: {
      value: [
        new THREE.Vector2(0, 0),
        new THREE.Vector2(0, 0),
        new THREE.Vector2(0, 0),
        new THREE.Vector2(0, 0),
        new THREE.Vector2(0, 0),
      ],
    },
    uLayerInvSpan: { value: [1 / 128, 1 / 256, 1 / 512, 1 / 1024, 1 / 2048] },
    uMorphEnds: { value: [24, 56, 116, 240, 640] },
  };

  const applyToonTint = (mat: THREE.MeshToonMaterial): void => {
    patchToonTint(mat, sharedUniforms, 'toon-biome-blizzard-v1');
  };

  const patchTerrainCdlodToon = (mat: THREE.MeshToonMaterial): void => {
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uBiomeTint = sharedUniforms.uBiomeTint;
      shader.uniforms.uBlizzardDim = sharedUniforms.uBlizzardDim;
      shader.uniforms.uShadowSnowTint = sharedUniforms.uShadowSnowTint;
      shader.uniforms.uSkyTopColor = sharedUniforms.uSkyTopColor;
      shader.uniforms.uCliffColor = sharedUniforms.uCliffColor;
      shader.uniforms.uNoiseOriginModXZ = sharedUniforms.uNoiseOriginModXZ;
      shader.uniforms.uNoiseOriginModY = sharedUniforms.uNoiseOriginModY;

      shader.uniforms.uHeightTex = clipmapUniforms.uHeightTex;
      shader.uniforms.uNormalMaskTex = clipmapUniforms.uNormalMaskTex;
      shader.uniforms.uAlbedoTex = clipmapUniforms.uAlbedoTex;
      shader.uniforms.uFlowElevTex = clipmapUniforms.uFlowElevTex;
      shader.uniforms.uFocusLocalXZ = clipmapUniforms.uFocusLocalXZ;
      shader.uniforms.uLayerOriginModXZ = clipmapUniforms.uLayerOriginModXZ;
      shader.uniforms.uLayerInvSpan = clipmapUniforms.uLayerInvSpan;
      shader.uniforms.uMorphEnds = clipmapUniforms.uMorphEnds;

      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          `#include <common>
attribute vec4 aPatchWorld;
attribute vec4 aPatchTex;
uniform highp sampler2DArray uHeightTex;
uniform highp sampler2DArray uNormalMaskTex;
uniform vec2 uFocusLocalXZ;
uniform vec2 uLayerOriginModXZ[5];
uniform float uLayerInvSpan[5];
uniform float uMorphEnds[5];
varying vec3 vTerrainWorldPos;
varying vec3 vTerrainWorldNormal;
varying float vMorph;
varying float vLodLayer;

vec2 cdlodLayerUv(vec2 localXZ, int layerIdx) {
  return (localXZ + uLayerOriginModXZ[layerIdx]) * uLayerInvSpan[layerIdx] + vec2(0.5 / 256.0);
}

vec3 cdlodSampleWorldNormal(vec2 localXZ, int layerIdx) {
  vec2 nm = texture(uNormalMaskTex, vec3(cdlodLayerUv(localXZ, layerIdx), float(layerIdx))).rg;
  vec2 nxz = nm * 2.0 - 1.0;
  float ny = sqrt(max(0.01, 1.0 - dot(nxz, nxz)));
  return normalize(vec3(nxz.x, ny, nxz.y));
}`,
        )
        .replace(
          '#include <beginnormal_vertex>',
          `ivec2 cdlodGrid = ivec2(round(position.xz));
ivec2 cdlodOdd = cdlodGrid & 1;
ivec2 cdlodCoarseGrid = cdlodGrid - cdlodOdd;
ivec2 cdlodOriginMod = ivec2(round(aPatchTex.xy));
int cdlodLayer = clamp(int(round(aPatchTex.z)), 0, 4);
int cdlodNextLayer = min(cdlodLayer + 1, 4);
float cdlodSpacing = aPatchWorld.w;

vec2 cdlodFineXZ = aPatchWorld.xz + vec2(cdlodGrid) * cdlodSpacing;
vec2 cdlodCoarseXZ = aPatchWorld.xz + vec2(cdlodCoarseGrid) * cdlodSpacing;
float cdlodDistXZ = length(cdlodFineXZ - uFocusLocalXZ);
float cdlodMorphStart = aPatchTex.w;
float cdlodMorphEnd = uMorphEnds[cdlodLayer];
float cdlodMorph = (cdlodLayer < 4)
  ? clamp((cdlodDistXZ - cdlodMorphStart) / max(1e-4, cdlodMorphEnd - cdlodMorphStart), 0.0, 1.0)
  : 0.0;

vec2 cdlodMorphedXZ = mix(cdlodFineXZ, cdlodCoarseXZ, cdlodMorph);

ivec2 cdlodTexFine = (cdlodOriginMod + cdlodGrid) & 255;
float cdlodH0 = texelFetch(uHeightTex, ivec3(cdlodTexFine, cdlodLayer), 0).r;
float cdlodH1 = cdlodH0;
if (cdlodLayer < 4 && cdlodMorph > 0.0001) {
  ivec2 cdlodTexCoarse = ivec2(round((cdlodCoarseXZ + uLayerOriginModXZ[cdlodNextLayer]) * (0.5 / cdlodSpacing))) & 255;
  cdlodH1 = texelFetch(uHeightTex, ivec3(cdlodTexCoarse, cdlodNextLayer), 0).r;
}
float cdlodHeight = mix(cdlodH0, cdlodH1, cdlodMorph);
vec3 cdlodLocalPos = vec3(cdlodMorphedXZ.x, aPatchWorld.y + cdlodHeight, cdlodMorphedXZ.y);

vec3 cdlodWorldNorm = cdlodSampleWorldNormal(cdlodMorphedXZ, cdlodLayer);
if (cdlodLayer < 4 && cdlodMorph > 0.001) {
  vec3 cdlodWorldNormNext = cdlodSampleWorldNormal(cdlodMorphedXZ, cdlodNextLayer);
  cdlodWorldNorm = normalize(mix(cdlodWorldNorm, cdlodWorldNormNext, cdlodMorph));
}

vec3 objectNormal = cdlodWorldNorm;
#ifdef USE_TANGENT
  vec3 objectTangent = vec3( tangent.xyz );
#endif
vTerrainWorldNormal = cdlodWorldNorm;
vMorph = cdlodMorph;
vLodLayer = float(cdlodLayer);`,
        )
        .replace(
          '#include <begin_vertex>',
          `vec3 transformed = cdlodLocalPos;`,
        )
        .replace(
          '#include <project_vertex>',
          `#include <project_vertex>
vTerrainWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;`,
        );

      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
uniform vec3 uBiomeTint;
uniform float uBlizzardDim;
uniform vec3 uShadowSnowTint;
uniform vec3 uSkyTopColor;
uniform vec3 uCliffColor;
uniform vec2 uNoiseOriginModXZ;
uniform float uNoiseOriginModY;
uniform highp sampler2DArray uNormalMaskTex;
uniform highp sampler2DArray uAlbedoTex;
uniform highp sampler2DArray uFlowElevTex;
uniform vec2 uLayerOriginModXZ[5];
uniform float uLayerInvSpan[5];
varying vec3 vTerrainWorldPos;
varying vec3 vTerrainWorldNormal;
varying float vMorph;
varying float vLodLayer;

vec2 cdlodFragLayerUv(vec2 localXZ, int layerIdx) {
  return (localXZ + uLayerOriginModXZ[layerIdx]) * uLayerInvSpan[layerIdx] + vec2(0.5 / 256.0);
}

float terrainHash21(vec2 cell) {
  vec2 p = mod(cell, 64.0);
  p = fract(p * vec2(0.1031, 0.1030));
  p += dot(p, p.yx + 33.33);
  return fract((p.x + p.y) * p.x);
}

vec3 terrainHash23(vec2 cell) {
  vec2 p = mod(cell, 64.0);
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yxz + 33.33);
  return fract((p3.xxy + p3.yzz) * p3.zyx);
}

// Period-64 smooth value noise returning vec3(value [0..1], dVal/du, dVal/dv).
vec3 terrainNoiseGrad(vec2 uv) {
  vec2 i = floor(uv);
  vec2 f = fract(uv);
  vec2 u = f * f * (3.0 - 2.0 * f);
  vec2 du = 6.0 * f * (1.0 - f);

  float a = terrainHash21(i);
  float b = terrainHash21(i + vec2(1.0, 0.0));
  float c = terrainHash21(i + vec2(0.0, 1.0));
  float d = terrainHash21(i + vec2(1.0, 1.0));

  float k0 = a;
  float k1 = b - a;
  float k2 = c - a;
  float k3 = a - b - c + d;

  float val = k0 + k1 * u.x + k2 * u.y + k3 * u.x * u.y;
  vec2 grad = du * vec2(k1 + k3 * u.y, k2 + k3 * u.x);
  return vec3(val, grad);
}`,
        )
        .replace(
          '#include <lights_toon_pars_fragment>',
          `varying vec3 vViewPosition;
struct ToonMaterial {
  vec3 diffuseColor;
  float cliffRock;
  float iceWeight;
  float terrainAO;
  float viewDist;
  vec2 pWorld;
  vec3 worldNormal;
};

void RE_Direct_Toon(
  const in IncidentLight directLight,
  const in vec3 geometryPosition,
  const in vec3 geometryNormal,
  const in vec3 geometryViewDir,
  const in vec3 geometryClearcoatNormal,
  const in ToonMaterial material,
  inout ReflectedLight reflectedLight
) {
  float ndl = dot(geometryNormal, directLight.direction);

  // Chromatic soft-knee snow-toon hybrid:
  // bold alpine-blue shadow terminator + gentle continuous sunlit slope gradient (~0.84 + 0.16 * ndl)
  float snowLitMask = smoothstep(0.06, 0.28, ndl);
  float snowSunlit = 0.84 + 0.16 * saturate(ndl);
  vec3 snowShadow = mix(vec3(0.36, 0.46, 0.62), uShadowSnowTint * 0.72, 0.75);
  vec3 snowIrradiance = mix(snowShadow * 0.55, vec3(snowSunlit), snowLitMask);

  // Crisp stylized 3-band soft-knee toon shading on granite cliffs to match cel props
  float rockBand1 = smoothstep(-0.14, 0.02, ndl);
  float rockBand2 = smoothstep(0.30, 0.46, ndl);
  float rockToon = 0.34 + 0.38 * rockBand1 + 0.28 * rockBand2;

  vec3 toonIrradiance = mix(snowIrradiance, vec3(rockToon), material.cliffRock);
  float directAo = mix(1.0, material.terrainAO, 0.45);
  reflectedLight.directDiffuse += toonIrradiance * directLight.color * BRDF_Lambert(material.diffuseColor) * directAo;

  // Glossy specular ice patches (Blinn-Phong + crisp cartoon glint so ice reads 60m+ ahead)
  if (material.iceWeight > 0.01 && ndl > 0.0) {
    vec3 halfRaw = directLight.direction + geometryViewDir;
    float halfLen = length(halfRaw);
    vec3 halfVec = halfLen > 1e-4 ? (halfRaw / halfLen) : geometryNormal;
    float ndh = saturate(dot(geometryNormal, halfVec));
    float ndh2 = ndh * ndh;
    float ndh4 = ndh2 * ndh2;
    float ndh8 = ndh4 * ndh4;
    float ndh16 = ndh8 * ndh8;
    float iceBlinn = ndh16 * ndh16; // ndh^32 without pow(0, y)
    float iceSharp = iceBlinn * iceBlinn * iceBlinn; // ndh^96
    float iceGlint = smoothstep(0.38, 0.66, iceBlinn) * 0.34 + iceBlinn * 0.28 + iceSharp * 0.55;
    vec3 iceSpecColor = mix(vec3(0.72, 0.96, 1.0), vec3(1.0), 0.45);
    reflectedLight.directSpecular += directLight.color * iceSpecColor * (iceGlint * material.iceWeight * 0.65);
  }

  // Grazing snow sparkle / micro-glint (ndl > 0.45 && dist < 45m && blizzardDim < 0.5)
  float sparkleGate = smoothstep(0.45, 0.62, ndl)
    * (1.0 - smoothstep(26.0, 45.0, material.viewDist))
    * (1.0 - smoothstep(0.25, 0.50, uBlizzardDim))
    * (1.0 - material.cliffRock);
  if (sparkleGate > 0.005) {
    vec3 h1 = terrainHash23(floor(material.pWorld * 2.0));
    vec3 h2 = terrainHash23(floor(material.pWorld * 4.0 + vec2(19.0, 37.0)));
    vec3 jitter1 = normalize(vec3(h1.x - 0.5, 1.4, h1.y - 0.5));
    vec3 jitter2 = normalize(vec3(h2.x - 0.5, 1.4, h2.y - 0.5));
    vec3 halfViewRaw = directLight.direction + geometryViewDir;
    float halfViewLen = length(halfViewRaw);
    vec3 halfView = halfViewLen > 1e-4 ? (halfViewRaw / halfViewLen) : geometryNormal;
    vec3 halfWorld = normalize(vec3(
      dot(viewMatrix[0].xyz, halfView),
      dot(viewMatrix[1].xyz, halfView),
      dot(viewMatrix[2].xyz, halfView)
    ));
    vec3 fn1 = normalize(mix(material.worldNormal, jitter1, 0.45));
    vec3 fn2 = normalize(mix(material.worldNormal, jitter2, 0.45));
    float g1 = smoothstep(0.955, 0.992, dot(fn1, halfWorld)) * step(0.42, h1.z);
    float g2 = smoothstep(0.960, 0.994, dot(fn2, halfWorld)) * step(0.48, h2.z);
    float sparkle = clamp(g1 + g2 * 0.85, 0.0, 1.2);
    reflectedLight.directSpecular += directLight.color * (sparkle * sparkleGate * 0.52);
  }
}

void RE_IndirectDiffuse_Toon(
  const in vec3 irradiance,
  const in vec3 geometryPosition,
  const in vec3 geometryNormal,
  const in vec3 geometryViewDir,
  const in vec3 geometryClearcoatNormal,
  const in ToonMaterial material,
  inout ReflectedLight reflectedLight
) {
  float snowFactor = 1.0 - material.cliffRock;
  // Cool alpine shadow tint in ambient/indirect fill + CPU-baked ridge/canyon AO
  vec3 ambientTint = mix(vec3(1.0), mix(uShadowSnowTint, vec3(1.0), 0.35), snowFactor * 0.45);
  reflectedLight.indirectDiffuse += irradiance * ambientTint * BRDF_Lambert(material.diffuseColor) * material.terrainAO;

  // Subtle crest Fresnel sky-rim sheen on sunlit snow ridges (multiply form avoids pow(0, y) NaN)
  float ndv = saturate(dot(geometryNormal, geometryViewDir));
  float invNdv = 1.0 - ndv;
  float fresnel = invNdv * invNdv * invNdv;
  float crestMask = smoothstep(0.96, 1.05, material.terrainAO);
  float rimStrength = (0.08 + 0.14 * crestMask) * snowFactor * (1.0 - uBlizzardDim * 0.65);
  vec3 rimColor = mix(uSkyTopColor, vec3(1.0), 0.55);
  reflectedLight.indirectDiffuse += rimColor * (fresnel * rimStrength * 0.42);

  // Grazing sky reflection on ice patches so ice gleams cleanly even away from the sun angle
  if (material.iceWeight > 0.01) {
    vec3 iceSkyRefl = mix(vec3(0.45, 0.88, 1.0), uSkyTopColor, 0.45);
    float iceFresnel = invNdv * invNdv * sqrt(invNdv);
    reflectedLight.indirectDiffuse += iceSkyRefl * (iceFresnel * 0.28 + 0.06) * material.iceWeight * (1.0 - uBlizzardDim * 0.45);
  }
}

#define RE_Direct RE_Direct_Toon
#define RE_IndirectDiffuse RE_IndirectDiffuse_Toon`,
        )
        .replace(
          '#include <color_fragment>',
          `#include <color_fragment>
int fragLod = clamp(int(round(vLodLayer)), 0, 4);
vec2 uvL0 = cdlodFragLayerUv(vTerrainWorldPos.xz, fragLod);
vec4 nmSample = texture(uNormalMaskTex, vec3(uvL0, float(fragLod)));
vec4 albSample = texture(uAlbedoTex, vec3(uvL0, float(fragLod)));
vec4 feSample = texture(uFlowElevTex, vec3(uvL0, float(fragLod)));
if (vMorph > 0.001 && fragLod < 4) {
  int nextLod = fragLod + 1;
  vec2 uvL1 = cdlodFragLayerUv(vTerrainWorldPos.xz, nextLod);
  vec4 nmNext = texture(uNormalMaskTex, vec3(uvL1, float(nextLod)));
  vec4 albNext = texture(uAlbedoTex, vec3(uvL1, float(nextLod)));
  vec4 feNext = texture(uFlowElevTex, vec3(uvL1, float(nextLod)));
  nmSample = mix(nmSample, nmNext, vMorph);
  albSample = mix(albSample, albNext, vMorph);
  feSample = mix(feSample, feNext, vMorph);
}

vec2 nmXZ = nmSample.rg * 2.0 - 1.0;
float nmY = sqrt(max(0.01, 1.0 - dot(nmXZ, nmXZ)));
vec3 worldNorm = normalize(vec3(nmXZ.x, nmY, nmXZ.y));
float terrainNy = clamp(worldNorm.y, 0.0, 1.0);

float pisteW = clamp(nmSample.b, 0.0, 1.0);
float iceW = clamp(nmSample.a, 0.0, 1.0);
float powderW = clamp(albSample.a, 0.0, 1.0);
float relElev = feSample.b * 80.0 - 40.0;
float terrainAO = clamp(0.5 + feSample.a * 0.6, 0.55, 1.1);
vec2 flowRaw = feSample.rg * 2.0 - 1.0;
float flowLen = length(flowRaw);
vec2 flowDir = flowLen > 1e-4 ? (flowRaw / flowLen) : vec2(0.0, -1.0);

diffuseColor.rgb = albSample.rgb;

vec2 pWorld = vTerrainWorldPos.xz + uNoiseOriginModXZ;
float absYWorld = vTerrainWorldPos.y + uNoiseOriginModY;
float viewDist = length(vViewPosition);

// Continuous per-pixel cliff rock blending (canonical 0.5m normals eliminate LOD rock-mask creases)
float offPisteRockMask = 1.0 - smoothstep(0.35, 0.65, pisteW);
float rockStartNy = 0.87;
float rockFullNy = 0.78;
vec3 rockBaseNoise = terrainNoiseGrad(pWorld * 0.0625);
vec3 rockDetailNoise = terrainNoiseGrad(pWorld * 0.25);
float strataWave = sin(absYWorld * 0.78539816 + rockBaseNoise.x * 3.2);
float strataFine = sin(absYWorld * 2.35619449 + rockDetailNoise.x * 2.4);
float rockLipJitter = (rockDetailNoise.x - 0.5) * 0.035 + strataWave * 0.015;
float lipEdgeGate = smoothstep(rockFullNy - 0.02, rockStartNy, terrainNy);
float fragCliffRock = (1.0 - smoothstep(rockFullNy, rockStartNy, terrainNy + rockLipJitter * lipEdgeGate)) * offPisteRockMask;

vec3 rockAlbedo = uCliffColor;
if (fragCliffRock > 0.01) {
  float chasmRockDark = 1.0 - clamp(max(0.0, -relElev - 4.0) / 36.0, 0.0, 0.35);
  float strataLedge = smoothstep(-0.35, 0.55, strataWave) * 0.14 - 0.06;
  float crevice = smoothstep(0.65, 0.95, -strataFine) * 0.18;
  float blockShade = (rockDetailNoise.x - 0.5) * 0.12;
  float graniteShade = clamp(1.0 + strataLedge + blockShade - crevice, 0.68, 1.18) * chasmRockDark;
  rockAlbedo *= graniteShade;
  float ledgeDust = smoothstep(0.55, 0.85, strataWave) * smoothstep(0.58, 0.82, terrainNy) * 0.22;
  rockAlbedo = mix(rockAlbedo, vec3(0.88, 0.93, 0.99), ledgeDust * (1.0 - fragCliffRock * 0.45));
}

float snowMask = 1.0 - fragCliffRock;

// Flow-aligned groomed corduroy on piste (C^1 32m tiled phase: exact 1024m wrap, zero curvature moire, fwidth AA)
float corduroyFade = (1.0 - smoothstep(18.0, 55.0, viewDist))
  * smoothstep(0.2, 0.65, pisteW)
  * (1.0 - iceW)
  * (1.0 - smoothstep(0.55, 0.85, powderW))
  * snowMask;
float corduroySlope = 0.0;
if (corduroyFade > 0.005) {
  vec2 flowRight = vec2(-flowDir.y, flowDir.x);
  vec2 cellU = fract(pWorld * 0.03125); // 1/32 exact divisor of 128m rebase & 1024m wrap
  vec2 cellS = cellU * cellU * (3.0 - 2.0 * cellU);
  float cordK = 11.78097245; // 60 * 2pi / 32 (~0.53m groove spacing)
  float w00 = (1.0 - cellS.x) * (1.0 - cellS.y);
  float w10 = cellS.x * (1.0 - cellS.y);
  float w01 = (1.0 - cellS.x) * cellS.y;
  float w11 = cellS.x * cellS.y;
  float ph00 = dot(cellU * 32.0, flowRight) * cordK;
  float ph10 = dot((cellU - vec2(1.0, 0.0)) * 32.0, flowRight) * cordK;
  float ph01 = dot((cellU - vec2(0.0, 1.0)) * 32.0, flowRight) * cordK;
  float ph11 = dot((cellU - vec2(1.0, 1.0)) * 32.0, flowRight) * cordK;
  float invRms = inversesqrt(max(1e-4, w00 * w00 + w10 * w10 + w01 * w01 + w11 * w11));
  float cordVal = (w00 * sin(ph00) + w10 * sin(ph10) + w01 * sin(ph01) + w11 * sin(ph11)) * invRms;
  float cordCos = (w00 * cos(ph00) + w10 * cos(ph10) + w01 * cos(ph01) + w11 * cos(ph11)) * invRms;
  float cordPixStep = max(length(dFdx(pWorld)), length(dFdy(pWorld))) * cordK;
  float cordAA = clamp(1.0 - cordPixStep * 0.35, 0.0, 1.0);
  float cordMod = 0.78 + 0.22 * rockDetailNoise.x;
  corduroySlope = cordCos * corduroyFade * cordAA * cordMod;
  diffuseColor.rgb *= (1.0 + cordVal * 0.028 * corduroyFade * cordAA * cordMod);
}

// Off-piste wind sastrugi ripples (pisteWeight < 0.8, rational orthogonal wind frame for exact 1024m wrap)
float sastrugiFade = (1.0 - smoothstep(28.0, 95.0, viewDist)) * max(1.0 - smoothstep(0.2, 0.8, pisteW), powderW * 0.45) * (1.0 - iceW) * snowMask;
vec2 sastrugiGradXZ = vec2(0.0);
if (sastrugiFade > 0.005) {
  vec2 wp1 = vec2(
    pWorld.x * 0.125 + pWorld.y * 0.0625,
    -pWorld.x * 0.1875 + pWorld.y * 0.375
  );
  vec3 s1 = terrainNoiseGrad(wp1);
  vec3 s2 = terrainNoiseGrad(wp1 * 2.0 + vec2(17.0, 29.0));
  float sVal = (s1.x * 0.68 + s2.x * 0.32) - 0.5;
  vec2 gW = s1.yz * 0.68 + s2.yz * 0.64;
  sastrugiGradXZ = vec2(
    gW.x * 0.125 - gW.y * 0.1875,
    gW.x * 0.0625 + gW.y * 0.375
  ) * sastrugiFade;
  diffuseColor.rgb *= (1.0 + sVal * 0.045 * sastrugiFade);
}

// Glossy glacial ice patches (crisp cyan tint + crystal veins)
vec2 iceGradXZ = vec2(0.0);
if (iceW > 0.01 && snowMask > 0.01) {
  vec3 iceN1 = terrainNoiseGrad(pWorld * 0.25);
  vec3 iceN2 = terrainNoiseGrad(pWorld * 0.5 + vec2(11.0, 23.0));
  float iceVeins = smoothstep(0.42, 0.58, abs(iceN1.x - iceN2.x) * 2.4);
  vec3 glacialTint = vec3(0.42, 0.86, 0.96);
  diffuseColor.rgb = mix(diffuseColor.rgb, mix(diffuseColor.rgb, glacialTint, 0.22), iceW * snowMask);
  diffuseColor.rgb *= (0.95 + 0.09 * iceVeins * iceW * snowMask);
  iceGradXZ = (iceN1.yz * 0.25 + iceN2.yz * 0.25) * iceW * snowMask * (1.0 - smoothstep(35.0, 90.0, viewDist));
}

diffuseColor.rgb = mix(diffuseColor.rgb, rockAlbedo, fragCliffRock);`,
        )
        .replace(
          '#include <normal_fragment_begin>',
          `#include <normal_fragment_begin>
vec3 worldPerturb = vec3(0.0);
if (abs(corduroySlope) > 1e-4) {
  vec2 flowRightN = vec2(-flowDir.y, flowDir.x);
  worldPerturb += vec3(flowRightN.x, 0.0, flowRightN.y) * (corduroySlope * 0.14);
}
worldPerturb -= vec3(sastrugiGradXZ.x, 0.0, sastrugiGradXZ.y) * 0.42;
worldPerturb -= vec3(iceGradXZ.x, 0.0, iceGradXZ.y) * 0.16;

// World-space stratified granite cliff normals (zero low-poly dFdx x dFdy triangle faceting)
if (fragCliffRock > 0.01) {
  float rockDistFade = 1.0 - smoothstep(80.0, 240.0, viewDist);
  float dStrataY = cos(absYWorld * 0.78539816 + rockBaseNoise.x * 3.2) * 0.78539816 * 0.65
                 + cos(absYWorld * 2.35619449 + rockDetailNoise.x * 2.4) * 2.35619449 * 0.25;
  vec2 rockGradXZ = rockBaseNoise.yz * 0.0625 * 2.2 + rockDetailNoise.yz * 0.25 * 1.4;
  vec3 granitePerturb = vec3(-rockGradXZ.x, -dStrataY * 0.32, -rockGradXZ.y);
  granitePerturb -= worldNorm * dot(granitePerturb, worldNorm);
  worldPerturb += granitePerturb * (fragCliffRock * 0.58 * rockDistFade);
}

vec3 perturbedWorldNormal = normalize(worldNorm + worldPerturb);
normal = normalize((viewMatrix * vec4(perturbedWorldNormal, 0.0)).xyz) * faceDirection;`,
        )
        .replace(
          '#include <lights_toon_fragment>',
          `ToonMaterial material;
material.diffuseColor = diffuseColor.rgb;
material.cliffRock = fragCliffRock;
material.iceWeight = iceW * snowMask;
material.terrainAO = terrainAO;
material.viewDist = viewDist;
material.pWorld = pWorld;
material.worldNormal = perturbedWorldNormal;`,
        )
        .replace(
          '#include <opaque_fragment>',
          `outgoingLight += reflectedLight.directSpecular;
outgoingLight *= mix(vec3(1.0), uBiomeTint, 0.25) * (1.0 - uBlizzardDim * 0.35);
#include <opaque_fragment>`,
        );
    };
    mat.customProgramCacheKey = () => 'terrain-cdlod-snow-toon-v3';
  };

  const terrainMaterial = new THREE.MeshToonMaterial({
    color: 0xffffff,
    vertexColors: false,
    gradientMap,
  });
  terrainMaterial.name = 'SharedTerrainClipmapToonMaterial';
  patchTerrainCdlodToon(terrainMaterial);
  gfx.markAsCache(terrainMaterial, 'SharedTerrainClipmapToonMaterial');

  const propToonMaterial = new THREE.MeshToonMaterial({
    color: 0xffffff,
    vertexColors: true,
    gradientMap,
  });
  propToonMaterial.name = 'SharedPropToonMaterial';
  applyToonTint(propToonMaterial);
  gfx.markAsCache(propToonMaterial, 'SharedPropToonMaterial');

  // Unlit warm glow material for Delivery Zone beacons & golden accents that pierce blizzard fog.
  const beaconGlowMaterial = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    vertexColors: true,
    fog: false,
  });
  beaconGlowMaterial.name = 'SharedBeaconGlowMaterial';
  gfx.markAsCache(beaconGlowMaterial, 'SharedBeaconGlowMaterial');

  const chimneySmoke = createChimneySmokeAssets(gfx, sharedUniforms);

  return {
    gradientMap,
    sharedUniforms,
    clipmapUniforms,
    terrainMaterial,
    propToonMaterial,
    beaconGlowMaterial,
    cabinSmokeTexture: chimneySmoke.smokeTexture,
    cabinSmokeMaterial: chimneySmoke.smokeMaterial,
  };
}
