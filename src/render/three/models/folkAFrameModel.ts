import * as THREE from 'three';
import type { GraphicsUtils } from '../graphicsUtils';
import type { ChimneyEmitterAnchor, LandmarkModelDef } from '../landmarkRegistry';
import { createTexturedToonMaterial, type SharedToonMaterials } from '../toonMaterials';
import {
  type AtlasTileRect,
  buildMergedColoredGeometry,
  buildMergedTexturedGeometry,
  type ColoredGeometryPart,
  createProceduralCanvasTexture,
  drawFolkStar,
  drawRoundedRectPath,
  makeAtlasTile,
  type TexturedGeometryPart,
  type TileMappingSpec,
} from './proceduralModelUtils';

export const FOLK_AFRAME_ATLAS_SIZE = 1024;

const STOVEPIPE_BASE_POS = { x: -1.16, y: 4.25, z: -0.58 } as const;
const STOVEPIPE_TILT = { rx: -0.04, ry: 0, rz: 0.14 } as const;
const STOVEPIPE_EXIT_LOCAL_POS = { x: -0.02, y: 1.74, z: 0 } as const;

const _aframeSmokeVec = new THREE.Vector3(
  STOVEPIPE_EXIT_LOCAL_POS.x,
  STOVEPIPE_EXIT_LOCAL_POS.y,
  STOVEPIPE_EXIT_LOCAL_POS.z,
)
  .applyEuler(new THREE.Euler(STOVEPIPE_TILT.rx, STOVEPIPE_TILT.ry, STOVEPIPE_TILT.rz, 'YXZ'))
  .add(new THREE.Vector3(STOVEPIPE_BASE_POS.x, STOVEPIPE_BASE_POS.y, STOVEPIPE_BASE_POS.z));

/**
 * Exact local chimney smoke origin on the Folk A-Frame Chalet right beneath its conical rain cap.
 */
export const FOLK_AFRAME_SMOKE_ANCHOR: ChimneyEmitterAnchor = {
  x: _aframeSmokeVec.x,
  y: _aframeSmokeVec.y,
  z: _aframeSmokeVec.z,
  tiltX: -0.14,
  tiltZ: -0.04,
  puffScale: 0.92,
};

export type FolkAFrameTileName =
  | 'aframeRoofSnow'
  | 'aframeBargeboard'
  | 'aframeFrieze'
  | 'aframePediment'
  | 'aframeRoundFrame'
  | 'aframeDoor'
  | 'logBark'
  | 'logEnd'
  | 'wainscoting'
  | 'porchPlanks'
  | 'stovepipe'
  | 'greenTrim'
  | 'snowBank';

export type FolkAFrameAtlasTile = AtlasTileRect;

export const FOLK_AFRAME_ATLAS_TILES: Readonly<Record<FolkAFrameTileName, FolkAFrameAtlasTile>> = {
  // Row 0 (y: 0..256)
  aframeRoofSnow: makeAtlasTile(0, 0, 512, 256, FOLK_AFRAME_ATLAS_SIZE),
  aframeBargeboard: makeAtlasTile(512, 0, 256, 256, FOLK_AFRAME_ATLAS_SIZE),
  aframeFrieze: makeAtlasTile(768, 0, 256, 256, FOLK_AFRAME_ATLAS_SIZE),
  // Row 1 (y: 256..512)
  aframePediment: makeAtlasTile(0, 256, 512, 256, FOLK_AFRAME_ATLAS_SIZE),
  aframeRoundFrame: makeAtlasTile(512, 256, 256, 256, FOLK_AFRAME_ATLAS_SIZE),
  aframeDoor: makeAtlasTile(768, 256, 256, 256, FOLK_AFRAME_ATLAS_SIZE),
  // Row 2 (y: 512..768)
  logBark: makeAtlasTile(0, 512, 512, 256, FOLK_AFRAME_ATLAS_SIZE),
  logEnd: makeAtlasTile(512, 512, 256, 256, FOLK_AFRAME_ATLAS_SIZE),
  wainscoting: makeAtlasTile(768, 512, 256, 256, FOLK_AFRAME_ATLAS_SIZE),
  // Row 3 (y: 768..1024)
  porchPlanks: makeAtlasTile(0, 768, 256, 256, FOLK_AFRAME_ATLAS_SIZE),
  stovepipe: makeAtlasTile(256, 768, 256, 256, FOLK_AFRAME_ATLAS_SIZE),
  greenTrim: makeAtlasTile(512, 768, 256, 256, FOLK_AFRAME_ATLAS_SIZE),
  snowBank: makeAtlasTile(768, 768, 256, 256, FOLK_AFRAME_ATLAS_SIZE),
};

/**
 * Paints the complete 1024x1024 procedural Folk A-Frame Chalet CanvasTexture atlas.
 */
export function drawFolkAFrameAtlas(ctx: CanvasRenderingContext2D): void {
  const ink = '#2b160a';
  ctx.save();
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  // 1. aframeRoofSnow (0, 0, 512, 256) - icy blue-white roof snow with crimson scalloped upper ridge border
  // Note: tileV = 1 sits at canvas top (t.py), which maps to the upper ridge on both A-frame roof slopes.
  {
    const t = FOLK_AFRAME_ATLAS_TILES.aframeRoofSnow;
    const grad = ctx.createLinearGradient(t.px, t.py, t.px, t.py + t.ph);
    grad.addColorStop(0, '#e3eef7');
    grad.addColorStop(0.5, '#d5e4f0');
    grad.addColorStop(1, '#c3d6e8');
    ctx.fillStyle = grad;
    ctx.fillRect(t.px, t.py, t.pw, t.ph);

    // Subtle wind-swept snow drift wisps running down the steep slope
    ctx.strokeStyle = '#f5fafe';
    ctx.lineWidth = 4.5;
    for (const [wx, wy, wh] of [
      [84, 96, 86],
      [212, 118, 94],
      [348, 88, 78],
      [444, 126, 88],
    ]) {
      ctx.beginPath();
      ctx.moveTo(t.px + wx!, t.py + wy!);
      ctx.quadraticCurveTo(t.px + wx! - 10, t.py + wy! + wh! * 0.5, t.px + wx! + 4, t.py + wy! + wh!);
      ctx.stroke();
    }

    // Crimson scalloped folk-art border along the upper ridge (canvas top edge t.py)
    const scallopCount = 8;
    const stepW = t.pw / scallopCount;
    ctx.fillStyle = '#a82d26';
    ctx.beginPath();
    ctx.moveTo(t.px, t.py);
    ctx.lineTo(t.px + t.pw, t.py);
    ctx.lineTo(t.px + t.pw, t.py + 30);
    for (let i = scallopCount - 1; i >= 0; i--) {
      const xRight = t.px + (i + 1) * stepW;
      const xMid = t.px + (i + 0.5) * stepW;
      const xLeft = t.px + i * stepW;
      ctx.quadraticCurveTo(xRight - stepW * 0.25, t.py + 46, xMid, t.py + 36);
      ctx.quadraticCurveTo(xLeft + stepW * 0.25, t.py + 46, xLeft, t.py + 30);
    }
    ctx.closePath();
    ctx.fill();

    ctx.strokeStyle = '#681915';
    ctx.lineWidth = 2.6;
    ctx.stroke();

    // Alternating golden dots & folk stars along and just below the crimson ridge scallop
    for (let i = 0; i < scallopCount; i++) {
      const cx = t.px + (i + 0.5) * stepW;
      ctx.fillStyle = '#ebb434';
      ctx.beginPath();
      ctx.arc(cx, t.py + 20, 4.2, 0, Math.PI * 2);
      ctx.fill();

      if (i % 2 === 0) {
        drawFolkStar(ctx, cx, t.py + 58, 9, 6.5, '#ebb434');
      } else {
        ctx.fillStyle = '#b93326';
        ctx.beginPath();
        ctx.arc(cx, t.py + 56, 3.8, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  // 2. aframeBargeboard (512, 0, 256, 256) - forest-green angled fascia with crimson wavy stripe & gold dots
  {
    const t = FOLK_AFRAME_ATLAS_TILES.aframeBargeboard;
    ctx.fillStyle = '#2f5e42';
    ctx.fillRect(t.px, t.py, t.pw, t.ph);

    // Inner deep red band
    ctx.fillStyle = '#9e2d24';
    ctx.fillRect(t.px, t.py + 48, t.pw, t.ph - 96);

    ctx.strokeStyle = ink;
    ctx.lineWidth = 5;
    ctx.strokeRect(t.px + 3, t.py + 3, t.pw - 6, t.ph - 6);
    ctx.beginPath();
    ctx.moveTo(t.px, t.py + 48);
    ctx.lineTo(t.px + t.pw, t.py + 48);
    ctx.moveTo(t.px, t.py + t.ph - 48);
    ctx.lineTo(t.px + t.pw, t.py + t.ph - 48);
    ctx.stroke();

    // Wavy cream/gold inner vine + golden stars & dots along green edges
    ctx.strokeStyle = '#f2c144';
    ctx.lineWidth = 5;
    ctx.beginPath();
    for (let i = 0; i <= 40; i++) {
      const f = i / 40;
      const x = t.px + f * t.pw;
      const y = t.py + t.ph * 0.5 + Math.sin(f * Math.PI * 8) * 32;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    for (let i = 0; i < 6; i++) {
      const gx = t.px + ((i + 0.5) / 6) * t.pw;
      ctx.fillStyle = '#f2c144';
      ctx.beginPath();
      ctx.arc(gx, t.py + 24, 5, 0, Math.PI * 2);
      ctx.arc(gx, t.py + t.ph - 24, 5, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // 3. aframeFrieze (768, 0, 256, 256) - dark brown frieze beam with cream/gold chevron zigzag
  {
    const t = FOLK_AFRAME_ATLAS_TILES.aframeFrieze;
    ctx.fillStyle = '#522914';
    ctx.fillRect(t.px, t.py, t.pw, t.ph);

    ctx.strokeStyle = ink;
    ctx.lineWidth = 6;
    ctx.strokeRect(t.px + 3, t.py + 3, t.pw - 6, t.ph - 6);

    // Cream & gold zigzag chevron across the beam
    const teeth = 8;
    const step = t.pw / teeth;
    ctx.strokeStyle = '#f2dfbe';
    ctx.lineWidth = 8;
    ctx.beginPath();
    for (let i = 0; i <= teeth; i++) {
      const x = t.px + i * step;
      const y = t.py + (i % 2 === 0 ? t.ph * 0.28 : t.ph * 0.72);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // Alternating crimson & pine-green dots inside zigzag triangles
    for (let i = 0; i < teeth; i++) {
      const cx = t.px + (i + 0.5) * step;
      const up = i % 2 === 0;
      ctx.fillStyle = up ? '#c43427' : '#3d7a56';
      ctx.beginPath();
      ctx.arc(cx, t.py + (up ? t.ph * 0.72 : t.ph * 0.28), 6, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // 4. aframePediment (0, 256, 512, 256) - amber vertical planks + botanical tulip & crimson folk spirals
  // Window anchor at UV (0.5, 0.331) -> canvas (wcx = px + 256, wcy = py + 171)
  {
    const t = FOLK_AFRAME_ATLAS_TILES.aframePediment;
    ctx.fillStyle = '#cc8a32';
    ctx.fillRect(t.px, t.py, t.pw, t.ph);

    // Vertical wood planks inside the steep A-frame gable
    ctx.strokeStyle = '#995e1a';
    ctx.lineWidth = 3;
    for (let x = 32; x < t.pw; x += 32) {
      ctx.beginPath();
      ctx.moveTo(t.px + x, t.py);
      ctx.lineTo(t.px + x, t.py + t.ph);
      ctx.stroke();
    }

    const wcx = t.px + t.pw * 0.5;
    const wcy = t.py + t.ph * 0.669;

    // Upper folk botanical tulip stem, green leaves, red blossom & flanking gold stars (above round window)
    ctx.strokeStyle = '#336b4a';
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.moveTo(wcx, wcy - 54);
    ctx.lineTo(wcx, t.py + 56);
    ctx.stroke();

    for (const side of [-1, 1] as const) {
      ctx.fillStyle = '#366f4d';
      ctx.beginPath();
      ctx.ellipse(wcx + side * 18, t.py + 92, 14, 6.5, side * -0.55, 0, Math.PI * 2);
      ctx.fill();

      drawFolkStar(ctx, wcx + side * 40, t.py + 114, 9, 6.5, '#f2bc36');
    }

    ctx.fillStyle = '#a82d26';
    ctx.beginPath();
    ctx.moveTo(wcx, t.py + 40);
    ctx.quadraticCurveTo(wcx + 16, t.py + 58, wcx, t.py + 72);
    ctx.quadraticCurveTo(wcx - 16, t.py + 58, wcx, t.py + 40);
    ctx.closePath();
    ctx.fill();

    // Lower symmetrical curling crimson-brown folk spirals & center crimson star (below round window)
    const scrollY = t.py + t.ph * 0.86;
    drawFolkStar(ctx, wcx, scrollY, 12, 8.5, '#a82d26');

    for (const side of [-1, 1] as const) {
      ctx.strokeStyle = '#8f3020';
      ctx.lineWidth = 5;
      ctx.beginPath();
      for (let i = 0; i <= 36; i++) {
        const f = i / 36;
        const a = f * Math.PI * 2.6;
        const r = 4 + f * 22;
        const sx = wcx + side * 66 + Math.cos(a) * side * r;
        const sy = scrollY - 4 + Math.sin(a) * r;
        if (i === 0) ctx.moveTo(sx, sy);
        else ctx.lineTo(sx, sy);
      }
      ctx.stroke();

      ctx.strokeStyle = '#f2bc36';
      ctx.lineWidth = 3.5;
      ctx.beginPath();
      ctx.arc(wcx + side * 114, scrollY + 6, 12, Math.PI * 0.2, Math.PI * 1.4);
      ctx.stroke();

      ctx.fillStyle = '#366f4d';
      ctx.beginPath();
      ctx.ellipse(wcx + side * 34, scrollY + 12, 9, 4.5, side * 0.4, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // 5. aframeRoundFrame (512, 256, 256, 256)
  {
    const t = FOLK_AFRAME_ATLAS_TILES.aframeRoundFrame;
    ctx.fillStyle = '#4e2712';
    ctx.fillRect(t.px, t.py, t.pw, t.ph);

    const cx = t.px + t.pw * 0.5;
    const cy = t.py + t.ph * 0.5;
    ctx.strokeStyle = ink;
    ctx.lineWidth = 8;
    ctx.beginPath();
    ctx.arc(cx, cy, 118, 0, Math.PI * 2);
    ctx.stroke();

    const beadCount = 14;
    for (let i = 0; i < beadCount; i++) {
      const ang = (i / beadCount) * Math.PI * 2;
      ctx.fillStyle = i % 2 === 0 ? '#f2c144' : '#c93428';
      ctx.beginPath();
      ctx.arc(cx + Math.cos(ang) * 98, cy + Math.sin(ang) * 98, 7.2, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // 6. aframeDoor (768, 256, 256, 256) - vertical plank door with rectangular handle
  {
    const t = FOLK_AFRAME_ATLAS_TILES.aframeDoor;
    ctx.fillStyle = '#a05f2c';
    ctx.fillRect(t.px, t.py, t.pw, t.ph);

    for (let i = 0; i < 4; i++) {
      const px = t.px + i * 64;
      ctx.fillStyle = i % 2 === 0 ? '#a46431' : '#945628';
      ctx.fillRect(px, t.py, 64, t.ph);
      ctx.strokeStyle = ink;
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.moveTo(px, t.py);
      ctx.lineTo(px, t.py + t.ph);
      ctx.stroke();
    }

    ctx.strokeStyle = ink;
    ctx.lineWidth = 8;
    ctx.strokeRect(t.px + 4, t.py + 4, t.pw - 8, t.ph - 8);

    // Rectangular vertical wooden handle on right side
    ctx.fillStyle = '#6f3d19';
    ctx.strokeStyle = ink;
    ctx.lineWidth = 4;
    drawRoundedRectPath(ctx, t.px + t.pw * 0.77, t.py + t.ph * 0.48, 16, 36, 4);
    ctx.fill();
    ctx.stroke();
  }

  // 7. logBark (0, 512, 512, 256)
  {
    const t = FOLK_AFRAME_ATLAS_TILES.logBark;
    const grad = ctx.createLinearGradient(t.px, t.py, t.px, t.py + t.ph);
    grad.addColorStop(0, '#a86925');
    grad.addColorStop(0.5, '#dfa447');
    grad.addColorStop(1, '#8f551a');
    ctx.fillStyle = grad;
    ctx.fillRect(t.px, t.py, t.pw, t.ph);

    ctx.strokeStyle = '#6b3d13';
    ctx.lineWidth = 2.8;
    for (const offset of [34, 86, 136, 188, 224]) {
      ctx.beginPath();
      ctx.moveTo(t.px, t.py + offset);
      ctx.bezierCurveTo(t.px + 160, t.py + offset + 6, t.px + 340, t.py + offset - 6, t.px + t.pw, t.py + offset);
      ctx.stroke();
    }
  }

  // 8. logEnd (512, 512, 256, 256)
  {
    const t = FOLK_AFRAME_ATLAS_TILES.logEnd;
    ctx.fillStyle = '#5a3215';
    ctx.fillRect(t.px, t.py, t.pw, t.ph);

    const cx = t.px + t.pw * 0.5;
    const cy = t.py + t.ph * 0.5;
    ctx.fillStyle = '#dec08e';
    ctx.strokeStyle = ink;
    ctx.lineWidth = 7;
    ctx.beginPath();
    ctx.arc(cx, cy, 108, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    ctx.strokeStyle = '#573317';
    ctx.lineWidth = 4.2;
    ctx.beginPath();
    for (let i = 0; i <= 84; i++) {
      const f = i / 84;
      const ang = f * Math.PI * 2 * 3.0;
      const rad = 8 + f * 84;
      const px = cx + Math.cos(ang) * rad;
      const py = cy + Math.sin(ang) * rad;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.stroke();
  }

  // 9. wainscoting (768, 512, 256, 256) - dark chestnut vertical wainscot skirt boards
  {
    const t = FOLK_AFRAME_ATLAS_TILES.wainscoting;
    ctx.fillStyle = '#75421f';
    ctx.fillRect(t.px, t.py, t.pw, t.ph);

    for (let i = 0; i < 6; i++) {
      const px = t.px + i * (t.pw / 6);
      ctx.fillStyle = i % 2 === 0 ? '#7b4722' : '#6c3b1b';
      ctx.fillRect(px, t.py, t.pw / 6, t.ph);
      ctx.strokeStyle = ink;
      ctx.lineWidth = 3.5;
      ctx.beginPath();
      ctx.moveTo(px, t.py);
      ctx.lineTo(px, t.py + t.ph);
      ctx.stroke();
    }

    // Horizontal top wainscot rail
    ctx.fillStyle = '#5c3114';
    ctx.fillRect(t.px, t.py, t.pw, 26);
    ctx.strokeStyle = ink;
    ctx.lineWidth = 5;
    ctx.strokeRect(t.px + 2, t.py + 2, t.pw - 4, 24);
  }

  // 10. porchPlanks (0, 768, 256, 256)
  {
    const t = FOLK_AFRAME_ATLAS_TILES.porchPlanks;
    ctx.fillStyle = '#945728';
    ctx.fillRect(t.px, t.py, t.pw, t.ph);

    for (let i = 0; i < 5; i++) {
      const px = t.px + i * (t.pw / 5);
      ctx.fillStyle = i % 2 === 0 ? '#985b2c' : '#894f23';
      ctx.fillRect(px, t.py, t.pw / 5, t.ph);
      ctx.strokeStyle = ink;
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.moveTo(px, t.py);
      ctx.lineTo(px, t.py + t.ph);
      ctx.stroke();
    }
    ctx.strokeStyle = ink;
    ctx.lineWidth = 6;
    ctx.strokeRect(t.px + 3, t.py + 3, t.pw - 6, t.ph - 6);
  }

  // 11. stovepipe (256, 768, 256, 256) - dark charcoal riveted metal stovepipe
  {
    const t = FOLK_AFRAME_ATLAS_TILES.stovepipe;
    const grad = ctx.createLinearGradient(t.px, t.py, t.px + t.pw, t.py);
    grad.addColorStop(0, '#362e2a');
    grad.addColorStop(0.35, '#594c45');
    grad.addColorStop(0.75, '#483d38');
    grad.addColorStop(1, '#2b2421');
    ctx.fillStyle = grad;
    ctx.fillRect(t.px, t.py, t.pw, t.ph);

    ctx.strokeStyle = '#1e1917';
    ctx.lineWidth = 5;
    for (const bandY of [64, 148, 208]) {
      ctx.beginPath();
      ctx.moveTo(t.px, t.py + bandY);
      ctx.lineTo(t.px + t.pw, t.py + bandY);
      ctx.stroke();
    }
  }

  // 12. greenTrim (512, 768, 256, 256) - forest-green door frame & roof soffit trim
  {
    const t = FOLK_AFRAME_ATLAS_TILES.greenTrim;
    ctx.fillStyle = '#2f5e42';
    ctx.fillRect(t.px, t.py, t.pw, t.ph);
    ctx.strokeStyle = '#183624';
    ctx.lineWidth = 8;
    ctx.strokeRect(t.px + 4, t.py + 4, t.pw - 8, t.ph - 8);
  }

  // 13. snowBank (768, 768, 256, 256)
  {
    const t = FOLK_AFRAME_ATLAS_TILES.snowBank;
    const grad = ctx.createLinearGradient(t.px, t.py, t.px, t.py + t.ph);
    grad.addColorStop(0, '#f5f9fd');
    grad.addColorStop(0.55, '#dce9f4');
    grad.addColorStop(1, '#c3d6e8');
    ctx.fillStyle = grad;
    ctx.fillRect(t.px, t.py, t.pw, t.ph);

    ctx.strokeStyle = '#aec4da';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(t.px + 28, t.py + 128);
    ctx.quadraticCurveTo(t.px + 128, t.py + 104, t.px + 228, t.py + 132);
    ctx.stroke();
  }

  ctx.restore();
}

/**
 * Builds a closed trapezoidal prism spanning `z in [-halfDepth, +halfDepth]`,
 * tapering horizontally from `bottomHalfW` at `bottomY` to `topHalfW` at `topY`.
 */
function buildTrapezoidPrismGeometry(
  bottomHalfW: number,
  topHalfW: number,
  bottomY: number,
  topY: number,
  halfDepth: number,
): THREE.BufferGeometry {
  const fBL: [number, number, number] = [-bottomHalfW, bottomY, halfDepth];
  const fBR: [number, number, number] = [bottomHalfW, bottomY, halfDepth];
  const fTR: [number, number, number] = [topHalfW, topY, halfDepth];
  const fTL: [number, number, number] = [-topHalfW, topY, halfDepth];

  const bBL: [number, number, number] = [-bottomHalfW, bottomY, -halfDepth];
  const bBR: [number, number, number] = [bottomHalfW, bottomY, -halfDepth];
  const bTR: [number, number, number] = [topHalfW, topY, -halfDepth];
  const bTL: [number, number, number] = [-topHalfW, topY, -halfDepth];

  const pos: number[] = [];
  const uv: number[] = [];
  const geo = new THREE.BufferGeometry();

  const pushTri = (
    a: [number, number, number],
    ua: [number, number],
    b: [number, number, number],
    ub: [number, number],
    c: [number, number, number],
    uc: [number, number],
  ): void => {
    pos.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
    uv.push(ua[0], ua[1], ub[0], ub[1], uc[0], uc[1]);
  };

  // Group 0: Front (+Z) and back (-Z) faces
  pushTri(fBL, [0, 0], fBR, [1, 0], fTR, [1, 1]);
  pushTri(fBL, [0, 0], fTR, [1, 1], fTL, [0, 1]);

  pushTri(bBR, [0, 0], bBL, [1, 0], bTL, [1, 1]);
  pushTri(bBR, [0, 0], bTL, [1, 1], bTR, [0, 1]);
  geo.addGroup(0, 12, 0);

  // Group 1: Side slopes, top, and bottom closure
  pushTri(fBL, [0, 0], fTL, [0, 1], bTL, [1, 1]);
  pushTri(fBL, [0, 0], bTL, [1, 1], bBL, [1, 0]);

  pushTri(fBR, [0, 0], bTR, [1, 1], fTR, [0, 1]);
  pushTri(fBR, [0, 0], bBR, [1, 0], bTR, [1, 1]);

  pushTri(fTL, [0, 0], fTR, [1, 0], bTR, [1, 1]);
  pushTri(fTL, [0, 0], bTR, [1, 1], bTL, [0, 1]);

  pushTri(fBL, [0, 0], bBL, [0, 1], bBR, [1, 1]);
  pushTri(fBL, [0, 0], bBR, [1, 1], fBR, [1, 0]);
  geo.addGroup(12, 24, 1);

  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.computeVertexNormals();
  return geo;
}

/**
 * Builds a closed triangular prism spanning `z in [-halfDepth, +halfDepth]`,
 * `x in [-halfWidth, +halfWidth]` at `baseY`, rising to `(0, apexY)` with outward CCW normals.
 */
function buildAFramePedimentPrismGeometry(
  halfWidth: number,
  baseY: number,
  apexY: number,
  halfDepth: number,
): THREE.BufferGeometry {
  const fL: [number, number, number] = [-halfWidth, baseY, halfDepth];
  const fR: [number, number, number] = [halfWidth, baseY, halfDepth];
  const fT: [number, number, number] = [0, apexY, halfDepth];
  const bL: [number, number, number] = [-halfWidth, baseY, -halfDepth];
  const bR: [number, number, number] = [halfWidth, baseY, -halfDepth];
  const bT: [number, number, number] = [0, apexY, -halfDepth];

  const pos: number[] = [];
  const uv: number[] = [];
  const geo = new THREE.BufferGeometry();

  const pushTri = (
    a: [number, number, number],
    ua: [number, number],
    b: [number, number, number],
    ub: [number, number],
    c: [number, number, number],
    uc: [number, number],
  ): void => {
    pos.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
    uv.push(ua[0], ua[1], ub[0], ub[1], uc[0], uc[1]);
  };

  pushTri(fL, [0, 0], fR, [1, 0], fT, [0.5, 1]);
  pushTri(bR, [0, 0], bL, [1, 0], bT, [0.5, 1]);
  geo.addGroup(0, 6, 0);

  pushTri(fL, [0, 0], fT, [1, 1], bT, [1, 0]);
  pushTri(fL, [0, 0], bT, [1, 0], bL, [0, 1]);

  pushTri(fR, [0, 0], bT, [1, 0], fT, [1, 1]);
  pushTri(fR, [0, 0], bR, [0, 1], bT, [1, 0]);

  pushTri(fL, [0, 0], bL, [0, 1], bR, [1, 1]);
  pushTri(fL, [0, 0], bR, [1, 1], fR, [1, 0]);
  geo.addGroup(6, 18, 1);

  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.computeVertexNormals();
  return geo;
}

export interface FolkAFrameGeometries {
  readonly chaletGeo: THREE.BufferGeometry;
  readonly chaletGlowGeo: THREE.BufferGeometry;
}

/**
 * Builds the sculpted 3D Folk A-Frame Chalet geometry (`chaletGeo`) and glowing 4-pane window
 * geometry (`chaletGlowGeo`).
 */
export function buildFolkAFrameGeometries(): FolkAFrameGeometries {
  const parts: TexturedGeometryPart<FolkAFrameTileName>[] = [];
  const glowParts: ColoredGeometryPart[] = [];

  // 1. Grounded slope snow skirt (y down to -1.18m) + plump base snowdrifts
  parts.push(
    {
      geometry: new THREE.BoxGeometry(5.64, 1.24, 5.56),
      tile: 'snowBank',
      ty: -0.56,
    },
    {
      geometry: new THREE.SphereGeometry(1, 10, 7),
      tile: 'snowBank',
      tx: -2.86,
      ty: 0.08,
      tz: -0.1,
      sx: 0.96,
      sy: 0.42,
      sz: 3.15,
    },
    {
      geometry: new THREE.SphereGeometry(1, 10, 7),
      tile: 'snowBank',
      tx: 2.86,
      ty: 0.08,
      tz: -0.1,
      sx: 0.96,
      sy: 0.42,
      sz: 3.15,
    },
    {
      geometry: new THREE.SphereGeometry(1, 10, 7),
      tile: 'snowBank',
      tx: 0,
      ty: 0.02,
      tz: -2.92,
      sx: 3.0,
      sy: 0.42,
      sz: 0.9,
    },
    {
      geometry: new THREE.SphereGeometry(1, 9, 6),
      tile: 'snowBank',
      tx: -1.9,
      ty: 0.08,
      tz: 2.74,
      sx: 1.15,
      sy: 0.36,
      sz: 0.78,
    },
    {
      geometry: new THREE.SphereGeometry(1, 9, 6),
      tile: 'snowBank',
      tx: 1.9,
      ty: 0.08,
      tz: 2.74,
      sx: 1.15,
      sy: 0.36,
      sz: 0.78,
    },
  );

  // 2. Lower trapezoidal A-frame wall core (dark vertical wainscoting) + upper triangular pediment
  parts.push(
    {
      geometry: buildTrapezoidPrismGeometry(2.46, 1.43, 0, 2.32, 2.54),
      tile: 'wainscoting',
      groupTiles: {
        0: 'wainscoting',
        1: 'greenTrim',
      },
    },
    {
      geometry: buildAFramePedimentPrismGeometry(1.44, 2.32, 5.52, 2.54),
      tile: 'aframePediment',
      groupTiles: {
        0: 'aframePediment',
        1: 'greenTrim',
      },
    },
  );

  // 3. 4 staggered horizontal log courses across lower front & back A-frame walls with spiral log ends
  const logRadius = 0.175;
  const logGroupTiles: Readonly<Record<number, FolkAFrameTileName | TileMappingSpec<FolkAFrameTileName>>> = {
    0: { tile: 'logBark', swapUV: true },
    1: 'logEnd',
    2: 'logEnd',
  };
  const logCourses: ReadonlyArray<{ readonly y: number; readonly len: number }> = [
    { y: 0.86, len: 4.16 },
    { y: 1.24, len: 3.82 },
    { y: 1.62, len: 3.48 },
    { y: 2.0, len: 3.14 },
  ];
  for (const course of logCourses) {
    for (const sz of [-2.54, 2.54]) {
      parts.push({
        geometry: new THREE.CylinderGeometry(logRadius, logRadius, course.len, 10, 1, false),
        tile: 'logBark',
        groupTiles: logGroupTiles,
        tx: 0,
        ty: course.y,
        tz: sz,
        rz: Math.PI * 0.5,
      });
    }
  }

  // 4. Horizontal zigzag chevron frieze beams + beaded round attic windows on front (+Z) & back (-Z)
  const roundFrameGroups: Readonly<Record<number, FolkAFrameTileName | TileMappingSpec<FolkAFrameTileName>>> = {
    0: 'greenTrim',
    1: 'aframeRoundFrame',
    2: 'aframeRoundFrame',
  };
  for (const endSign of [-1, 1] as const) {
    parts.push(
      {
        geometry: new THREE.BoxGeometry(2.96, 0.26, 0.24),
        tile: 'aframeFrieze',
        tx: 0,
        ty: 2.26,
        tz: endSign * 2.58,
      },
      {
        geometry: new THREE.CylinderGeometry(0.52, 0.52, 0.14, 20),
        tile: 'aframeRoundFrame',
        groupTiles: roundFrameGroups,
        tx: 0,
        ty: 3.38,
        tz: endSign * 2.58,
        rx: Math.PI * 0.5,
      },
    );

    glowParts.push(
      {
        geometry: new THREE.CylinderGeometry(0.36, 0.36, 0.05, 16),
        color: '#ffe066',
        tx: 0,
        ty: 3.38,
        tz: endSign * 2.645,
        rx: Math.PI * 0.5,
      },
      {
        geometry: new THREE.BoxGeometry(0.74, 0.055, 0.07),
        color: '#3b1d0c',
        tx: 0,
        ty: 3.38,
        tz: endSign * 2.66,
      },
      {
        geometry: new THREE.BoxGeometry(0.055, 0.74, 0.07),
        color: '#3b1d0c',
        tx: 0,
        ty: 3.38,
        tz: endSign * 2.66,
      },
    );
  }

  // 5. Front door (+Z) with forest-green jambs, lintel snow cap, chestnut plank door & 4-pane glass
  parts.push(
    {
      geometry: new THREE.BoxGeometry(0.16, 1.8, 0.28),
      tile: 'greenTrim',
      tx: -0.56,
      ty: 0.9,
      tz: 2.64,
    },
    {
      geometry: new THREE.BoxGeometry(0.16, 1.8, 0.28),
      tile: 'greenTrim',
      tx: 0.56,
      ty: 0.9,
      tz: 2.64,
    },
    {
      geometry: new THREE.BoxGeometry(1.36, 0.17, 0.3),
      tile: 'greenTrim',
      tx: 0,
      ty: 1.78,
      tz: 2.65,
    },
    {
      geometry: new THREE.BoxGeometry(1.42, 0.08, 0.32),
      tile: 'snowBank',
      tx: 0,
      ty: 1.9,
      tz: 2.66,
    },
    {
      geometry: new THREE.BoxGeometry(0.98, 1.72, 0.14),
      tile: 'aframeDoor',
      tx: 0,
      ty: 0.86,
      tz: 2.62,
    },
  );

  glowParts.push(
    {
      geometry: new THREE.BoxGeometry(0.5, 0.5, 0.04),
      color: '#3b1d0c',
      tx: 0,
      ty: 1.3,
      tz: 2.695,
    },
    {
      geometry: new THREE.BoxGeometry(0.42, 0.42, 0.04),
      color: '#ffe066',
      tx: 0,
      ty: 1.3,
      tz: 2.71,
    },
    {
      geometry: new THREE.BoxGeometry(0.44, 0.05, 0.05),
      color: '#3b1d0c',
      tx: 0,
      ty: 1.3,
      tz: 2.725,
    },
    {
      geometry: new THREE.BoxGeometry(0.05, 0.44, 0.05),
      color: '#3b1d0c',
      tx: 0,
      ty: 1.3,
      tz: 2.725,
    },
  );

  // 6. Steep snowy A-frame roof slopes, ornate green/red/gold bargeboards & sculpted ridge/verge snow
  const roofEaveX = 2.86;
  const roofEaveY = 0.06;
  const roofRidgeY = 5.76;
  const roofDx = roofEaveX;
  const roofDy = roofRidgeY - roofEaveY;
  const roofAngle = Math.atan2(roofDy, roofDx);
  const roofSlopeLen = Math.hypot(roofDx, roofDy);
  const sinA = Math.sin(roofAngle);
  const cosA = Math.cos(roofAngle);

  // tileV = 1 sits at the upper ridge edge on BOTH slopes
  const leftSlopeGroups: Readonly<Record<number, FolkAFrameTileName | TileMappingSpec<FolkAFrameTileName>>> = {
    0: 'snowBank',
    1: 'snowBank',
    2: { tile: 'aframeRoofSnow', swapUV: true },
    3: 'snowBank',
    4: 'snowBank',
    5: 'snowBank',
  };
  const rightSlopeGroups: Readonly<Record<number, FolkAFrameTileName | TileMappingSpec<FolkAFrameTileName>>> = {
    0: 'snowBank',
    1: 'snowBank',
    2: { tile: 'aframeRoofSnow', swapUV: true, flipV: true },
    3: 'snowBank',
    4: 'snowBank',
    5: 'snowBank',
  };

  for (const slopeSign of [-1, 1] as const) {
    const midX = slopeSign * (roofEaveX * 0.5);
    const midY = (roofRidgeY + roofEaveY) * 0.5;
    const normX = slopeSign * sinA;
    const normY = cosA;
    const rz = slopeSign < 0 ? roofAngle : -roofAngle;

    parts.push({
      geometry: new THREE.BoxGeometry(roofSlopeLen + 0.14, 0.18, 6.02),
      tile: 'greenTrim',
      tx: midX,
      ty: midY,
      tz: 0,
      rz,
    });

    for (const endSign of [-1, 1] as const) {
      parts.push({
        geometry: new THREE.BoxGeometry(roofSlopeLen + 0.2, 0.3, 0.22),
        tile: 'aframeBargeboard',
        tx: midX + normX * 0.02,
        ty: midY + normY * 0.02,
        tz: endSign * 2.94,
        rz,
      });
    }

    parts.push({
      geometry: new THREE.BoxGeometry(roofSlopeLen + 0.16, 0.24, 6.08),
      tile: 'snowBank',
      groupTiles: slopeSign < 0 ? leftSlopeGroups : rightSlopeGroups,
      tx: midX + normX * 0.2,
      ty: midY + normY * 0.2,
      tz: 0,
      rz,
    });

    for (const endSign of [-1, 1] as const) {
      parts.push({
        geometry: new THREE.CylinderGeometry(0.14, 0.14, roofSlopeLen + 0.24, 8, 1, false),
        tile: 'snowBank',
        tx: midX + normX * 0.26,
        ty: midY + normY * 0.26,
        tz: endSign * 3.01,
        rz: rz + Math.PI * 0.5,
      });
    }
  }

  // Sculpted rounded snow ridge roll & front/back green peak keystone accents
  parts.push({
    geometry: new THREE.CylinderGeometry(0.24, 0.24, 6.18, 10, 1, false),
    tile: 'snowBank',
    tx: 0,
    ty: roofRidgeY + 0.18,
    tz: 0,
    rx: Math.PI * 0.5,
  });
  for (const endSign of [-1, 1] as const) {
    parts.push({
      geometry: new THREE.BoxGeometry(0.36, 0.36, 0.24),
      tile: 'greenTrim',
      tx: 0,
      ty: roofRidgeY - 0.16,
      tz: endSign * 2.95,
      rz: Math.PI * 0.25,
    });
  }

  // 7. Covered left-side porch / alcove wing (-X side) peeking beneath the steep snow roof
  parts.push(
    {
      geometry: new THREE.BoxGeometry(1.7, 0.88, 1.88),
      tile: 'porchPlanks',
      tx: -2.42,
      ty: 0.44,
      tz: -1.22,
    },
    {
      geometry: new THREE.BoxGeometry(1.7, 1.72, 0.22),
      tile: 'porchPlanks',
      tx: -2.42,
      ty: 0.86,
      tz: -2.06,
    },
    {
      geometry: new THREE.BoxGeometry(0.22, 1.72, 0.22),
      tile: 'greenTrim',
      tx: -3.16,
      ty: 0.86,
      tz: -0.38,
    },
    {
      geometry: new THREE.BoxGeometry(1.94, 0.12, 2.14),
      tile: 'greenTrim',
      tx: -2.38,
      ty: 1.82,
      tz: -1.22,
      rz: 0.34,
    },
    {
      geometry: new THREE.BoxGeometry(1.98, 0.15, 2.2),
      tile: 'snowBank',
      tx: -2.42,
      ty: 1.94,
      tz: -1.22,
      rz: 0.34,
    },
  );

  // Warm recessed alcove glow window
  glowParts.push(
    {
      geometry: new THREE.BoxGeometry(0.16, 0.72, 0.9),
      color: '#3b1d0c',
      tx: -2.72,
      ty: 1.24,
      tz: -1.16,
    },
    {
      geometry: new THREE.BoxGeometry(0.18, 0.62, 0.78),
      color: '#ffd875',
      tx: -2.74,
      ty: 1.24,
      tz: -1.16,
    },
  );

  // 8. Crooked dark metal stovepipe chimney with conical rain cap on -X upper slope
  const pipeEuler = new THREE.Euler(STOVEPIPE_TILT.rx, STOVEPIPE_TILT.ry, STOVEPIPE_TILT.rz, 'YXZ');
  const addPipePart = (
    geometry: THREE.BufferGeometry,
    tile: FolkAFrameTileName,
    localY: number,
    localX = 0,
    localZ = 0,
  ): void => {
    const offset = new THREE.Vector3(localX, localY, localZ).applyEuler(pipeEuler);
    parts.push({
      geometry,
      tile,
      tx: STOVEPIPE_BASE_POS.x + offset.x,
      ty: STOVEPIPE_BASE_POS.y + offset.y,
      tz: STOVEPIPE_BASE_POS.z + offset.z,
      rx: STOVEPIPE_TILT.rx,
      ry: STOVEPIPE_TILT.ry,
      rz: STOVEPIPE_TILT.rz,
    });
  };

  parts.push({
    geometry: new THREE.SphereGeometry(0.42, 9, 6),
    tile: 'snowBank',
    tx: -1.16,
    ty: 4.3,
    tz: -0.58,
    sx: 1.1,
    sy: 0.45,
    sz: 1.1,
  });

  addPipePart(new THREE.CylinderGeometry(0.2, 0.24, 0.88, 10), 'stovepipe', 0.44, 0, 0);
  addPipePart(new THREE.CylinderGeometry(0.17, 0.19, 0.86, 10), 'stovepipe', 1.25, -0.02, 0);
  addPipePart(new THREE.ConeGeometry(0.36, 0.34, 10), 'stovepipe', 1.94, -0.02, 0);

  const chaletGeo = buildMergedTexturedGeometry(
    parts,
    FOLK_AFRAME_ATLAS_TILES,
    'DeliveryChaletAFrameGeo',
    true,
  );
  const chaletGlowGeo = buildMergedColoredGeometry(
    glowParts,
    'DeliveryChaletAFrameGlowGeo',
    false,
  );

  return {
    chaletGeo,
    chaletGlowGeo,
  };
}

/**
 * Registers the Folk A-Frame Chalet landmark archetype (`proc:cabin:folk_aframe`) with its own
 * cached geometry, atlas material, optional outline hull, and stovepipe smoke anchor.
 */
export function createFolkAFrameLandmarkDef(
  gfx: GraphicsUtils,
  materials: SharedToonMaterials,
  outlineMaterial?: THREE.Material,
): LandmarkModelDef {
  const { chaletGeo, chaletGlowGeo } = buildFolkAFrameGeometries();
  gfx.markAsCache(chaletGeo, chaletGeo.name);
  gfx.markAsCache(chaletGlowGeo, chaletGlowGeo.name);

  const atlasTex = createProceduralCanvasTexture(
    gfx,
    FOLK_AFRAME_ATLAS_SIZE,
    FOLK_AFRAME_ATLAS_SIZE,
    drawFolkAFrameAtlas,
    'FolkAFrameAtlasTex',
    [195, 138, 66, 255],
  );
  const chaletMat = createTexturedToonMaterial(
    gfx,
    atlasTex,
    materials.gradientMap,
    materials.sharedUniforms,
    'FolkAFrameToonMaterial',
  );

  return {
    id: 'proc:cabin:folk_aframe',
    poolCapacity: 8,
    yawPolicy: 'faceTrail',
    smokeAnchors: [FOLK_AFRAME_SMOKE_ANCHOR],
    createInstance: (index) => {
      const group = new THREE.Group();
      group.name = `PooledDeliveryChaletAFrame_${index}`;
      const chaletMesh = gfx.createMesh(chaletGeo, chaletMat, `DeliveryChaletAFrame_${index}`);
      chaletMesh.castShadow = true;
      if (outlineMaterial) {
        const outlineMesh = gfx.createMesh(
          chaletGeo,
          outlineMaterial,
          `DeliveryChaletAFrameOutline_${index}`,
        );
        outlineMesh.castShadow = false;
        group.add(outlineMesh);
      }
      const glowMesh = gfx.createMesh(
        chaletGlowGeo,
        materials.beaconGlowMaterial,
        `DeliveryChaletAFrameGlow_${index}`,
      );
      glowMesh.castShadow = false;
      group.add(chaletMesh, glowMesh);
      gfx.markAsCache(group, group.name);
      return { group };
    },
  };
}
