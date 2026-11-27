import * as THREE from 'three';
import {
  computePortraitAspectFactor,
  OUTLINE_VISIBILITY_TUNING,
  type OutlineVisibilityTuning,
} from '../../content/visibilityTuning';
import type { GraphicsUtils } from './graphicsUtils';

export interface OutlineMaterialOptions {
  readonly color?: THREE.ColorRepresentation;
  readonly outlineWidth?: number;
  readonly minClipOffset?: number;
  readonly maxClipOffset?: number;
}

/**
 * Creates a distance-clamped inverted-hull outline ShaderMaterial (`side: THREE.BackSide`)
 * that extrudes vertices along the averaged `aSmoothNormal` attribute to prevent corner cracks
 * on flat-shaded low-poly meshes while supporting both `Mesh` and `InstancedMesh` (`USE_INSTANCING`)
 * and Three.js scene `FogExp2` integration.
 */
export function createSmoothOutlineMaterial(
  gfx: GraphicsUtils,
  options: OutlineMaterialOptions = {},
): THREE.ShaderMaterial {
  const outlineColor = new THREE.Color(options.color ?? '#182235');
  const outlineWidth = options.outlineWidth ?? 0.045;
  const minClipOffset = options.minClipOffset ?? 0.0025;
  const maxClipOffset = options.maxClipOffset ?? 0.016;

  const uniforms = THREE.UniformsUtils.merge([
    THREE.UniformsLib.fog,
    {
      uOutlineColor: { value: outlineColor },
      uOutlineWidth: { value: outlineWidth },
      uMinClipOffset: { value: minClipOffset },
      uMaxClipOffset: { value: maxClipOffset },
    },
  ]);

  const material = new THREE.ShaderMaterial({
    name: 'SmoothNormalInvertedHullOutline',
    uniforms,
    side: THREE.BackSide,
    depthWrite: true,
    transparent: false,
    fog: true,
    vertexShader: /* glsl */ `
attribute vec3 aSmoothNormal;

uniform float uOutlineWidth;
uniform float uMinClipOffset;
uniform float uMaxClipOffset;

#include <common>
#include <fog_pars_vertex>

void main() {
  vec3 smoothDir = length(aSmoothNormal) > 1e-5 ? normalize(aSmoothNormal) : normalize(normal);

  vec4 localPos = vec4(position, 1.0);
  vec4 localNorm = vec4(smoothDir, 0.0);

  #ifdef USE_INSTANCING
    localPos = instanceMatrix * localPos;
    localNorm = instanceMatrix * localNorm;
  #endif

  vec4 mvPosition = modelViewMatrix * localPos;
  vec3 viewNormal = normalize((modelViewMatrix * localNorm).xyz);
  vec4 clipPos = projectionMatrix * mvPosition;
  vec3 clipNormal = mat3(projectionMatrix) * viewNormal;

  vec2 offsetDir = length(clipNormal.xy) > 1e-5 ? normalize(clipNormal.xy) : vec2(0.0, 1.0);
  float dist = max(1.5, -mvPosition.z);
  float clipThickness = clamp(uOutlineWidth / dist, uMinClipOffset, uMaxClipOffset);

  // Subtle depth bias prevents z-fighting against front faces at grazing angles.
  clipPos.xy += offsetDir * clipThickness * clipPos.w;
  clipPos.z += 0.0004 * clipPos.w;
  gl_Position = clipPos;

  #include <fog_vertex>
}
`,
    fragmentShader: /* glsl */ `
uniform vec3 uOutlineColor;

#include <common>
#include <fog_pars_fragment>

void main() {
  gl_FragColor = vec4(uOutlineColor, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}
`,
  });

  material.userData.baseOutlineWidth = outlineWidth;
  material.userData.baseMinClipOffset = minClipOffset;
  material.userData.baseMaxClipOffset = maxClipOffset;

  gfx.markAsCache(material, 'SmoothNormalInvertedHullOutline');
  return material;
}

/**
 * Scales smooth-normal outline uniforms idempotently from stored base values so
 * 3D silhouettes stay crisp on narrow portrait mobile screens without compounding on resize.
 */
export function syncOutlineMaterialForAspect(
  material: THREE.ShaderMaterial,
  aspect: number,
  tuning: OutlineVisibilityTuning = OUTLINE_VISIBILITY_TUNING,
): number {
  const rawBaseWidth = material.userData.baseOutlineWidth;
  const rawBaseMin = material.userData.baseMinClipOffset;
  const rawBaseMax = material.userData.baseMaxClipOffset;
  const baseWidth =
    typeof rawBaseWidth === 'number' && Number.isFinite(rawBaseWidth) ? rawBaseWidth : 0.045;
  const baseMin =
    typeof rawBaseMin === 'number' && Number.isFinite(rawBaseMin) ? rawBaseMin : 0.0025;
  const baseMax =
    typeof rawBaseMax === 'number' && Number.isFinite(rawBaseMax) ? rawBaseMax : 0.016;

  let scale = 1.0;
  let nextMin = baseMin;
  let nextMax = Math.max(baseMin, baseMax);

  if (tuning.enabled) {
    const baseWScale = Number.isFinite(tuning.baseWidthScale)
      ? Math.max(0.1, tuning.baseWidthScale)
      : 1.0;
    const portraitBoost = Number.isFinite(tuning.portraitBoostScale)
      ? Math.max(0, tuning.portraitBoostScale)
      : 0.45;
    scale = Math.max(0.1, baseWScale + portraitBoost * computePortraitAspectFactor(aspect));
    const ceiling =
      Number.isFinite(tuning.maxClipOffsetCeiling) && tuning.maxClipOffsetCeiling > 0
        ? tuning.maxClipOffsetCeiling
        : 0.024;
    nextMin = Math.min(ceiling, baseMin * scale);
    nextMax = Math.max(nextMin, Math.min(ceiling, baseMax * scale));
  }

  const uWidth = material.uniforms.uOutlineWidth;
  const uMin = material.uniforms.uMinClipOffset;
  const uMax = material.uniforms.uMaxClipOffset;
  if (uWidth) uWidth.value = baseWidth * scale;
  if (uMin) uMin.value = nextMin;
  if (uMax) uMax.value = nextMax;

  return scale;
}
