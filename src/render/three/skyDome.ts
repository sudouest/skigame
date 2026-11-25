import * as THREE from 'three';
import { STAGE_SUNNY_BLUE } from '../../content/stages';
import type { GraphicsUtils } from './graphicsUtils';

const SKY_DOME_RADIUS_M = 200;

const SKY_DOME_VERTEX_SHADER = /* glsl */ `
varying vec3 vLocalDir;

void main() {
  vLocalDir = normalize(position);
  vec4 clipPos = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_Position = vec4(clipPos.xy, clipPos.w * 0.999, clipPos.w);
}
`;

const SKY_DOME_FRAGMENT_SHADER = /* glsl */ `
uniform vec3 uFogColor;
uniform vec3 uSkyBottom;
uniform vec3 uSkyTop;
uniform vec3 uSunColor;
uniform vec3 uSunDir;
uniform float uBlizzardDim;

varying vec3 vLocalDir;

void main() {
  vec3 dir = normalize(vLocalDir);
  float elev = dir.y;

  // Seamless blend: fogColor (below/at horizon) -> skyBottom -> skyTop (zenith)
  float horizonToBottom = smoothstep(-0.04, 0.14, elev);
  float bottomToTop = smoothstep(0.08, 0.68, elev);

  vec3 skyCol = mix(uFogColor, uSkyBottom, horizonToBottom);
  skyCol = mix(skyCol, uSkyTop, bottomToTop);

  // Warm stylized sun halo + disc aligned with directional sun light, dimmed in blizzards
  vec3 sunDir = normalize(uSunDir);
  float sunDot = max(dot(dir, sunDir), 0.0);
  float clearSky = clamp(1.0 - uBlizzardDim * 1.35, 0.0, 1.0);
  float aboveHorizon = smoothstep(-0.02, 0.08, elev);

  float sd2 = sunDot * sunDot;
  float sd4 = sd2 * sd2;
  float sd8 = sd4 * sd4;
  float sd16 = sd8 * sd8;
  float sd32 = sd16 * sd16;
  float outerHalo = sd8 * sd2 * 0.28; // sunDot^10 without pow(0, y)
  float innerHalo = sd32 * sd32 * 0.48; // sunDot^64
  float sunDisc = smoothstep(0.9965, 0.9988, sunDot) * 0.85;
  vec3 sunWarm = mix(uSunColor, vec3(1.0, 0.98, 0.90), 0.45);
  skyCol += sunWarm * (outerHalo + innerHalo + sunDisc) * clearSky * aboveHorizon;

  // Softly veil sky toward overcast fog haze during blizzards
  skyCol = mix(skyCol, uFogColor * 0.96, clamp(uBlizzardDim * 0.42, 0.0, 0.45));

  gl_FragColor = vec4(skyCol, 1.0);
  #include <colorspace_fragment>
}
`;

export interface SkyDomeUniforms {
  readonly uFogColor: { value: THREE.Color };
  readonly uSkyBottom: { value: THREE.Color };
  readonly uSkyTop: { value: THREE.Color };
  readonly uSunColor: { value: THREE.Color };
  readonly uSunDir: { value: THREE.Vector3 };
  readonly uBlizzardDim: { value: number };
}

/**
 * Camera-centered gradient sky dome blending `fogColor` -> `StagePalette.skyBottom` ->
 * `StagePalette.skyTop` with a warm stylized sun halo aligned to the scene's directional light.
 * Created via `GraphicsUtils.createMesh` with cached geometry/material for zero GPU leaks
 * and zero per-frame allocations.
 */
export class SkyDome {
  readonly mesh: THREE.Mesh;
  readonly material: THREE.ShaderMaterial;
  readonly uniforms: SkyDomeUniforms;

  private readonly gfx: GraphicsUtils;

  constructor(gfx: GraphicsUtils, scene: THREE.Scene) {
    this.gfx = gfx;

    const palette = STAGE_SUNNY_BLUE.palette;
    this.uniforms = {
      uFogColor: { value: new THREE.Color(palette.fogColor) },
      uSkyBottom: { value: new THREE.Color(palette.skyBottom) },
      uSkyTop: { value: new THREE.Color(palette.skyTop) },
      uSunColor: { value: new THREE.Color(palette.sunColor) },
      uSunDir: { value: new THREE.Vector3(35, 65, 40).normalize() },
      uBlizzardDim: { value: 0 },
    };

    const geometry = new THREE.SphereGeometry(SKY_DOME_RADIUS_M, 24, 14);
    geometry.name = 'SkyDomeGeometry';
    gfx.markAsCache(geometry, 'SkyDomeGeometry');

    this.material = new THREE.ShaderMaterial({
      name: 'SkyDomeMaterial',
      uniforms: this.uniforms as unknown as Record<string, THREE.IUniform>,
      vertexShader: SKY_DOME_VERTEX_SHADER,
      fragmentShader: SKY_DOME_FRAGMENT_SHADER,
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: false,
      fog: false,
      toneMapped: false,
    });
    gfx.markAsCache(this.material, 'SkyDomeMaterial');

    this.mesh = gfx.createMesh(geometry, this.material, 'SkyDomeMesh');
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -1000;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    scene.add(this.mesh);
  }

  /**
   * Centers the sky dome on `camera.position` and copies smoothly transitioned palette
   * colors + directional sun vector with zero heap allocations.
   */
  sync(
    camera: THREE.Camera,
    fogColor: THREE.Color,
    skyBottomColor: THREE.Color,
    skyTopColor: THREE.Color,
    sunColor: THREE.Color,
    sunDirX: number,
    sunDirY: number,
    sunDirZ: number,
    blizzardDim: number,
  ): void {
    this.mesh.position.copy(camera.position);
    this.uniforms.uFogColor.value.copy(fogColor);
    this.uniforms.uSkyBottom.value.copy(skyBottomColor);
    this.uniforms.uSkyTop.value.copy(skyTopColor);
    this.uniforms.uSunColor.value.copy(sunColor);
    this.uniforms.uSunDir.value.set(sunDirX, sunDirY, sunDirZ);
    this.uniforms.uBlizzardDim.value = blizzardDim;
  }

  dispose(): void {
    this.gfx.disposeObject(this.mesh);
  }
}
