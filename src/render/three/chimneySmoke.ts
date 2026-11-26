import * as THREE from 'three';
import type { GraphicsUtils } from './graphicsUtils';
import { createProceduralCanvasTexture } from './models/proceduralModelUtils';
import type { SharedLightingUniforms } from './toonMaterials';

export const FOLK_SMOKE_WIDTH = 512;
export const FOLK_SMOKE_HEIGHT = 512;
export const CABIN_SMOKE_PUFFS_PER_CABIN = 16;
export const CABIN_SMOKE_CYCLE_SEC = 3.8;
export const CABIN_SMOKE_RISE_HEIGHT_M = 5.2;

export interface FolkSmokeFrameRect {
  readonly uOffset: number;
  readonly vOffset: number;
  readonly uScale: number;
  readonly vScale: number;
}

const SMOKE_PAD_UV = 4 / FOLK_SMOKE_WIDTH;
const SMOKE_CELL_UV = 0.5 - SMOKE_PAD_UV * 2;

export const FOLK_SMOKE_FRAMES: readonly FolkSmokeFrameRect[] = [
  // Row 0 (top half in canvas; CanvasTexture flipY = true puts row 0 at v in [0.5, 1])
  { uOffset: SMOKE_PAD_UV, vOffset: 0.5 + SMOKE_PAD_UV, uScale: SMOKE_CELL_UV, vScale: SMOKE_CELL_UV },
  { uOffset: 0.5 + SMOKE_PAD_UV, vOffset: 0.5 + SMOKE_PAD_UV, uScale: SMOKE_CELL_UV, vScale: SMOKE_CELL_UV },
  // Row 1 (bottom half in canvas; v in [0, 0.5])
  { uOffset: SMOKE_PAD_UV, vOffset: SMOKE_PAD_UV, uScale: SMOKE_CELL_UV, vScale: SMOKE_CELL_UV },
  { uOffset: 0.5 + SMOKE_PAD_UV, vOffset: SMOKE_PAD_UV, uScale: SMOKE_CELL_UV, vScale: SMOKE_CELL_UV },
];

/**
 * Paints the 512x512 2x2 folk-art smoke puff sprite sheet on transparent background:
 * 4 hand-inked silver-blue / off-white puffs & spiral curls with slate-blue contours.
 */
export function drawFolkSmokeSprite(ctx: CanvasRenderingContext2D): void {
  ctx.save();
  ctx.clearRect(0, 0, FOLK_SMOKE_WIDTH, FOLK_SMOKE_HEIGHT);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  const ink = '#4e5f70';
  const swirlInk = '#6c7e91';
  const bodyLight = '#f4f8fc';
  const bodyMid = '#dce6f0';
  const bodyShade = '#c3d3e3';

  // Cell (0, 0) [0..256, 0..256]: Plump 5-lobed folk cloud puff with inner spiral swirl
  {
    const cx = 128;
    const cy = 132;
    ctx.fillStyle = bodyLight;
    ctx.strokeStyle = ink;
    ctx.lineWidth = 6.5;
    ctx.beginPath();
    ctx.moveTo(cx - 56, cy + 44);
    ctx.bezierCurveTo(cx - 102, cy + 44, cx - 106, cy - 12, cx - 64, cy - 26);
    ctx.bezierCurveTo(cx - 70, cy - 82, cx - 12, cy - 98, cx + 16, cy - 64);
    ctx.bezierCurveTo(cx + 56, cy - 92, cx + 106, cy - 42, cx + 78, cy + 4);
    ctx.bezierCurveTo(cx + 98, cy + 42, cx + 52, cy + 72, cx + 12, cy + 56);
    ctx.bezierCurveTo(cx - 18, cy + 76, cx - 62, cy + 66, cx - 56, cy + 44);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = bodyMid;
    ctx.beginPath();
    ctx.ellipse(cx - 8, cy + 28, 48, 22, -0.08, 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = swirlInk;
    ctx.lineWidth = 4.2;
    ctx.beginPath();
    for (let i = 0; i <= 42; i++) {
      const f = i / 42;
      const a = f * Math.PI * 3.1 + 0.4;
      const r = 6 + f * 30;
      const sx = cx + Math.cos(a) * r;
      const sy = cy - 4 + Math.sin(a) * r;
      if (i === 0) ctx.moveTo(sx, sy);
      else ctx.lineTo(sx, sy);
    }
    ctx.stroke();
  }

  // Cell (1, 0) [256..512, 0..256]: Curling S-scroll folk wisp with accent flecks
  {
    const ox = 256;
    const cx = ox + 128;
    const cy = 128;
    ctx.fillStyle = bodyLight;
    ctx.strokeStyle = ink;
    ctx.lineWidth = 6.2;
    ctx.beginPath();
    ctx.moveTo(cx - 26, cy + 78);
    ctx.bezierCurveTo(cx - 64, cy + 34, cx - 58, cy - 26, cx - 18, cy - 58);
    ctx.bezierCurveTo(cx + 22, cy - 90, cx + 78, cy - 66, cx + 74, cy - 20);
    ctx.bezierCurveTo(cx + 70, cy + 22, cx + 18, cy + 26, cx + 10, cy - 4);
    ctx.bezierCurveTo(cx + 4, cy - 26, cx + 32, cy - 34, cx + 40, cy - 18);
    ctx.bezierCurveTo(cx + 52, cy - 40, cx + 22, cy - 58, cx - 4, cy - 34);
    ctx.bezierCurveTo(cx - 32, cy - 8, cx - 22, cy + 38, cx + 8, cy + 70);
    ctx.bezierCurveTo(cx + 2, cy + 84, cx - 14, cy + 88, cx - 26, cy + 78);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    ctx.strokeStyle = swirlInk;
    ctx.lineWidth = 3.8;
    ctx.beginPath();
    ctx.arc(cx + 34, cy - 18, 20, -Math.PI * 0.75, Math.PI * 0.85);
    ctx.stroke();

    ctx.fillStyle = ink;
    for (const [dx, dy, r] of [
      [-58, -50, 4],
      [66, 42, 4.5],
      [-56, 48, 3.2],
    ]) {
      ctx.beginPath();
      ctx.arc(cx + dx!, cy + dy!, r!, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // Cell (0, 1) [0..256, 256..512]: Scalloped storybook cloudlet with double-C curl
  {
    const oy = 256;
    const cx = 128;
    const cy = oy + 128;
    ctx.fillStyle = bodyMid;
    ctx.strokeStyle = ink;
    ctx.lineWidth = 6.5;
    ctx.beginPath();
    ctx.moveTo(cx - 64, cy + 26);
    ctx.bezierCurveTo(cx - 98, cy + 8, cx - 84, cy - 58, cx - 34, cy - 58);
    ctx.bezierCurveTo(cx - 12, cy - 94, cx + 46, cy - 86, cx + 56, cy - 42);
    ctx.bezierCurveTo(cx + 98, cy - 32, cx + 96, cy + 26, cx + 54, cy + 36);
    ctx.bezierCurveTo(cx + 42, cy + 74, cx - 18, cy + 78, cx - 34, cy + 50);
    ctx.bezierCurveTo(cx - 56, cy + 62, cx - 78, cy + 44, cx - 64, cy + 26);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = bodyLight;
    ctx.beginPath();
    ctx.ellipse(cx - 4, cy - 16, 46, 32, 0.15, 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = swirlInk;
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.arc(cx - 20, cy - 8, 22, Math.PI * 0.2, Math.PI * 1.65);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx + 26, cy + 6, 17, -Math.PI * 0.85, Math.PI * 0.65);
    ctx.stroke();
  }

  // Cell (1, 1) [256..512, 256..512]: Playful twin-lobed curling whiff puff
  {
    const ox = 256;
    const oy = 256;
    const cx = ox + 128;
    const cy = oy + 128;
    ctx.fillStyle = bodyLight;
    ctx.strokeStyle = ink;
    ctx.lineWidth = 6.2;
    ctx.beginPath();
    ctx.moveTo(cx - 58, cy + 34);
    ctx.bezierCurveTo(cx - 94, cy + 16, cx - 86, cy - 44, cx - 40, cy - 50);
    ctx.bezierCurveTo(cx - 18, cy - 84, cx + 32, cy - 80, cx + 44, cy - 46);
    ctx.bezierCurveTo(cx + 88, cy - 44, cx + 94, cy + 12, cx + 56, cy + 34);
    ctx.bezierCurveTo(cx + 42, cy + 66, cx - 2, cy + 64, cx - 16, cy + 44);
    ctx.bezierCurveTo(cx - 34, cy + 62, cx - 64, cy + 54, cx - 58, cy + 34);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = bodyShade;
    ctx.beginPath();
    ctx.ellipse(cx + 12, cy + 20, 38, 16, -0.1, 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = swirlInk;
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.arc(cx - 24, cy - 10, 18, Math.PI * 0.35, Math.PI * 1.9);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx + 28, cy - 6, 16, -Math.PI * 0.9, Math.PI * 0.55);
    ctx.stroke();

    ctx.fillStyle = ink;
    ctx.beginPath();
    ctx.arc(cx - 4, cy - 68, 3.8, 0, Math.PI * 2);
    ctx.arc(cx + 68, cy - 54, 3.2, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.restore();
}

export function buildChimneySmokeQuadGeometry(label = 'DeliveryCabinSmokeGeo'): THREE.BufferGeometry {
  const smokeGeo = new THREE.PlaneGeometry(1, 1);
  smokeGeo.name = label;
  smokeGeo.computeBoundingBox();
  smokeGeo.computeBoundingSphere();
  return smokeGeo;
}

export interface ChimneySmokeAssets {
  readonly smokeTexture: THREE.Texture;
  readonly smokeMaterial: THREE.MeshBasicMaterial;
  readonly smokeQuadGeo: THREE.BufferGeometry;
}

/**
 * Creates and caches the shared folk chimney smoke sprite atlas, instanced billboard material,
 * and unit quad geometry used across all smoke-emitting buildings in `LandmarkStreamer`.
 */
export function createChimneySmokeAssets(
  gfx: GraphicsUtils,
  sharedUniforms: SharedLightingUniforms,
): ChimneySmokeAssets {
  const smokeTexture = createProceduralCanvasTexture(
    gfx,
    FOLK_SMOKE_WIDTH,
    FOLK_SMOKE_HEIGHT,
    drawFolkSmokeSprite,
    'FolkCabinSmokeTex',
    [225, 236, 245, 255],
    5,
  );

  const smokeMaterial = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    map: smokeTexture,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    fog: true,
  });
  smokeMaterial.name = 'SharedFolkCabinSmokeMaterial';
  smokeMaterial.onBeforeCompile = (shader) => {
    shader.uniforms.uBiomeTint = sharedUniforms.uBiomeTint;
    shader.uniforms.uBlizzardDim = sharedUniforms.uBlizzardDim;

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <uv_pars_vertex>',
        `#include <uv_pars_vertex>
attribute vec4 aUvRect;
attribute float aSmokeAlpha;
varying float vSmokeAlpha;`,
      )
      .replace(
        '#include <uv_vertex>',
        `#include <uv_vertex>
#ifdef USE_MAP
  vMapUv = uv * aUvRect.zw + aUvRect.xy;
#endif
vSmokeAlpha = aSmokeAlpha;`,
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
uniform vec3 uBiomeTint;
uniform float uBlizzardDim;
varying float vSmokeAlpha;`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
diffuseColor.rgb *= mix(vec3(1.0), uBiomeTint, 0.25) * (1.0 - uBlizzardDim * 0.35);`,
      )
      .replace(
        '#include <map_fragment>',
        `#include <map_fragment>
diffuseColor.a *= vSmokeAlpha;`,
      );
  };
  smokeMaterial.customProgramCacheKey = () => 'folk-cabin-smoke-v2';
  gfx.markAsCache(smokeMaterial, 'SharedFolkCabinSmokeMaterial');

  const smokeQuadGeo = buildChimneySmokeQuadGeometry('DeliveryCabinSmokeGeo');
  gfx.markAsCache(smokeQuadGeo, smokeQuadGeo.name);

  return {
    smokeTexture,
    smokeMaterial,
    smokeQuadGeo,
  };
}
