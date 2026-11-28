import * as THREE from 'three';
import type { GraphicsUtils } from '../graphicsUtils';
import { computeSmoothNormals } from '../smoothNormals';
import { dilateAtlasEdges } from '../spriteAtlas';

export interface AtlasTileRect {
  readonly px: number;
  readonly py: number;
  readonly pw: number;
  readonly ph: number;
  readonly u0: number;
  readonly v0: number;
  readonly u1: number;
  readonly v1: number;
}

export function makeAtlasTile(
  px: number,
  py: number,
  pw: number,
  ph: number,
  atlasSize = 1024,
  padPx = 2,
): AtlasTileRect {
  return {
    px,
    py,
    pw,
    ph,
    u0: (px + padPx) / atlasSize,
    // CanvasTexture uses flipY = true: canvas y grows downward while UV v grows upward.
    v0: 1 - (py + ph - padPx) / atlasSize,
    u1: (px + pw - padPx) / atlasSize,
    v1: 1 - (py + padPx) / atlasSize,
  };
}

export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export interface PartTransform {
  readonly geometry: THREE.BufferGeometry;
  readonly tx?: number;
  readonly ty?: number;
  readonly tz?: number;
  readonly rx?: number;
  readonly ry?: number;
  readonly rz?: number;
  readonly sx?: number;
  readonly sy?: number;
  readonly sz?: number;
}

export interface ColoredGeometryPart extends PartTransform {
  readonly color: THREE.ColorRepresentation;
}

export interface TileMappingSpec<TTile extends string = string> {
  readonly tile: TTile;
  readonly swapUV?: boolean;
  readonly flipU?: boolean;
  readonly flipV?: boolean;
}

export interface TexturedGeometryPart<TTile extends string = string> extends PartTransform {
  readonly tile: TTile;
  readonly groupTiles?: Readonly<Record<number, TTile | TileMappingSpec<TTile>>>;
  readonly swapUV?: boolean;
  readonly flipU?: boolean;
  readonly flipV?: boolean;
}

const _mat4 = new THREE.Matrix4();
const _pos = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _euler = new THREE.Euler(0, 0, 0, 'YXZ');
const _scale = new THREE.Vector3();
const _normVec = new THREE.Vector3();
const _tmpColor = new THREE.Color();

function prepareTransformedParts(
  parts: readonly PartTransform[],
): { readonly geometries: THREE.BufferGeometry[]; readonly totalVertices: number } {
  const geometries: THREE.BufferGeometry[] = [];
  let totalVertices = 0;

  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]!;
    const geom = p.geometry.index ? p.geometry.toNonIndexed() : p.geometry;
    if (geom !== p.geometry) {
      p.geometry.dispose();
    }

    _pos.set(p.tx ?? 0, p.ty ?? 0, p.tz ?? 0);
    _euler.set(p.rx ?? 0, p.ry ?? 0, p.rz ?? 0, 'YXZ');
    _quat.setFromEuler(_euler);
    _scale.set(p.sx ?? 1, p.sy ?? 1, p.sz ?? 1);
    _mat4.compose(_pos, _quat, _scale);

    const posAttr = geom.getAttribute('position');
    if (posAttr) {
      geom.applyMatrix4(_mat4);
      geom.computeVertexNormals();
      totalVertices += posAttr.count;
    }
    geometries.push(geom);
  }

  return { geometries, totalVertices };
}

function resolveGroupMapping<TTile extends string>(
  part: TexturedGeometryPart<TTile>,
  materialIndex: number,
): TileMappingSpec<TTile> {
  const override = part.groupTiles?.[materialIndex];
  if (typeof override === 'string') {
    return {
      tile: override,
      swapUV: part.swapUV,
      flipU: part.flipU,
      flipV: part.flipV,
    };
  }
  if (override) {
    return override;
  }
  return {
    tile: part.tile,
    swapUV: part.swapUV,
    flipU: part.flipU,
    flipV: part.flipV,
  };
}

/**
 * Merges multiple UV-mapped BufferGeometries into a single non-indexed BufferGeometry
 * remapping per-group UVs into `tiles`, optionally computing `aSmoothNormal`.
 */
export function buildMergedTexturedGeometry<TTile extends string>(
  parts: readonly TexturedGeometryPart<TTile>[],
  tiles: Readonly<Record<TTile, AtlasTileRect>>,
  label: string,
  withSmoothNormals = true,
): THREE.BufferGeometry {
  const { geometries: prepared, totalVertices } = prepareTransformedParts(parts);

  const positions = new Float32Array(totalVertices * 3);
  const normals = new Float32Array(totalVertices * 3);
  const uvs = new Float32Array(totalVertices * 2);

  let writeVertex = 0;
  for (let i = 0; i < prepared.length; i++) {
    const geom = prepared[i]!;
    const part = parts[i]!;
    const posAttr = geom.getAttribute('position');
    const normAttr = geom.getAttribute('normal');
    const uvAttr = geom.getAttribute('uv');

    if (posAttr && normAttr) {
      const count = posAttr.count;
      const vertexMapping = new Array<TileMappingSpec<TTile>>(count);
      const defaultSpec: TileMappingSpec<TTile> = {
        tile: part.tile,
        swapUV: part.swapUV,
        flipU: part.flipU,
        flipV: part.flipV,
      };
      vertexMapping.fill(defaultSpec);

      if (geom.groups.length > 0 && part.groupTiles) {
        for (let g = 0; g < geom.groups.length; g++) {
          const grp = geom.groups[g]!;
          const spec = resolveGroupMapping(part, grp.materialIndex ?? 0);
          const end = Math.min(count, grp.start + grp.count);
          for (let v = grp.start; v < end; v++) {
            vertexMapping[v] = spec;
          }
        }
      }

      for (let v = 0; v < count; v++) {
        const dstIdx = writeVertex + v;
        const i3 = dstIdx * 3;
        const i2 = dstIdx * 2;

        positions[i3] = posAttr.getX(v);
        positions[i3 + 1] = posAttr.getY(v);
        positions[i3 + 2] = posAttr.getZ(v);

        _normVec.set(normAttr.getX(v), normAttr.getY(v), normAttr.getZ(v)).normalize();
        normals[i3] = _normVec.x;
        normals[i3 + 1] = _normVec.y;
        normals[i3 + 2] = _normVec.z;

        const spec = vertexMapping[v]!;
        const rect = tiles[spec.tile];
        let u = uvAttr ? clamp01(uvAttr.getX(v)) : 0.5;
        let vv = uvAttr ? clamp01(uvAttr.getY(v)) : 0.5;
        if (spec.swapUV) {
          const tmp = u;
          u = vv;
          vv = tmp;
        }
        if (spec.flipU) u = 1 - u;
        if (spec.flipV) vv = 1 - vv;

        uvs[i2] = rect.u0 + u * (rect.u1 - rect.u0);
        uvs[i2 + 1] = rect.v0 + vv * (rect.v1 - rect.v0);
      }

      writeVertex += count;
    }
    geom.dispose();
  }

  const merged = new THREE.BufferGeometry();
  merged.name = label;
  merged.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  merged.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  merged.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  merged.computeBoundingBox();
  merged.computeBoundingSphere();

  if (withSmoothNormals) {
    computeSmoothNormals(merged);
  }
  return merged;
}

/**
 * Merges multiple colored primitive BufferGeometries into a single flat-shaded non-indexed
 * vertex-colored BufferGeometry and optionally computes `aSmoothNormal` for gap-free outlines.
 */
export function buildMergedColoredGeometry(
  parts: readonly ColoredGeometryPart[],
  label: string,
  withSmoothNormals = true,
): THREE.BufferGeometry {
  const { geometries: prepared, totalVertices } = prepareTransformedParts(parts);

  const positions = new Float32Array(totalVertices * 3);
  const normals = new Float32Array(totalVertices * 3);
  const colors = new Float32Array(totalVertices * 3);

  let writeOffset = 0;
  for (let i = 0; i < prepared.length; i++) {
    const geom = prepared[i]!;
    const part = parts[i]!;
    const posAttr = geom.getAttribute('position');
    const normAttr = geom.getAttribute('normal');
    _tmpColor.set(part.color);

    if (posAttr && normAttr) {
      for (let v = 0; v < posAttr.count; v++) {
        const i3 = (writeOffset + v) * 3;
        positions[i3] = posAttr.getX(v);
        positions[i3 + 1] = posAttr.getY(v);
        positions[i3 + 2] = posAttr.getZ(v);

        _normVec.set(normAttr.getX(v), normAttr.getY(v), normAttr.getZ(v)).normalize();
        normals[i3] = _normVec.x;
        normals[i3 + 1] = _normVec.y;
        normals[i3 + 2] = _normVec.z;

        colors[i3] = _tmpColor.r;
        colors[i3 + 1] = _tmpColor.g;
        colors[i3 + 2] = _tmpColor.b;
      }
      writeOffset += posAttr.count;
    }
    geom.dispose();
  }

  const merged = new THREE.BufferGeometry();
  merged.name = label;
  merged.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  merged.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  merged.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  merged.computeBoundingBox();
  merged.computeBoundingSphere();

  if (withSmoothNormals) {
    computeSmoothNormals(merged);
  }
  return merged;
}

export function makeHeadlessFallbackTexture(
  gfx: GraphicsUtils,
  label: string,
  r: number,
  g: number,
  b: number,
  a: number,
): THREE.DataTexture {
  const w = 8;
  const h = 8;
  const data = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    data[i * 4] = r;
    data[i * 4 + 1] = g;
    data[i * 4 + 2] = b;
    data[i * 4 + 3] = a;
  }
  const tex = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.name = label;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  gfx.markAsCache(tex, label);
  return tex;
}

/**
 * Renders a procedural Canvas2D texture (with optional transparent RGB edge dilation)
 * in browsers or synthesizes a tracked 8x8 DataTexture fallback in headless Node environments.
 */
export function createProceduralCanvasTexture(
  gfx: GraphicsUtils,
  width: number,
  height: number,
  drawFn: (ctx: CanvasRenderingContext2D) => void,
  label: string,
  fallbackRgba: readonly [number, number, number, number],
  dilatePasses = 0,
): THREE.Texture {
  if (typeof document === 'undefined') {
    return makeHeadlessFallbackTexture(
      gfx,
      `${label}Fallback`,
      fallbackRgba[0],
      fallbackRgba[1],
      fallbackRgba[2],
      fallbackRgba[3],
    );
  }

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error(`Failed to create 2D context for ${label}`);
  }
  drawFn(ctx);

  if (dilatePasses > 0) {
    const imgData = ctx.getImageData(0, 0, width, height);
    dilateAtlasEdges(imgData.data, width, height, dilatePasses);
    ctx.putImageData(imgData, 0, 0);
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.name = label;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  gfx.markAsCache(tex, label);
  return tex;
}

export function drawRoundedRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const rad = Math.min(r, w * 0.5, h * 0.5);
  ctx.beginPath();
  ctx.moveTo(x + rad, y);
  ctx.lineTo(x + w - rad, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rad);
  ctx.lineTo(x + w, y + h - rad);
  ctx.quadraticCurveTo(x + w, y + h, x + w - rad, y + h);
  ctx.lineTo(x + rad, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - rad);
  ctx.lineTo(x, y + rad);
  ctx.quadraticCurveTo(x, y, x + rad, y);
  ctx.closePath();
}

export function drawFolkStar(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  outerR: number,
  innerR: number,
  color: string,
): void {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineCap = 'round';
  ctx.lineWidth = 3.2;

  for (let i = 0; i < 4; i++) {
    const a = (i * Math.PI) / 4;
    const r = i % 2 === 0 ? outerR : innerR;
    ctx.beginPath();
    ctx.moveTo(cx - Math.cos(a) * r, cy - Math.sin(a) * r);
    ctx.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
    ctx.stroke();
  }

  for (let i = 0; i < 8; i++) {
    const a = (i * Math.PI) / 4;
    const r = (i % 2 === 0 ? outerR : innerR) * 0.88;
    ctx.beginPath();
    ctx.arc(cx + Math.cos(a) * r, cy + Math.sin(a) * r, 2.3, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

/**
 * Builds a closed non-indexed tapered vertical rectangular timber post with guaranteed
 * outward CCW winding and clean [0, 1] UVs per face (`groups[0]` side faces, `groups[1]` caps).
 */
export function buildTaperedPostGeometry(
  wBot: number,
  dBot: number,
  wTop: number,
  dTop: number,
  yBot: number,
  yTop: number,
): THREE.BufferGeometry {
  const hwB = wBot * 0.5;
  const hdB = dBot * 0.5;
  const hwT = wTop * 0.5;
  const hdT = dTop * 0.5;

  const b0: readonly [number, number, number] = [-hwB, yBot, hdB];
  const b1: readonly [number, number, number] = [hwB, yBot, hdB];
  const b2: readonly [number, number, number] = [hwB, yBot, -hdB];
  const b3: readonly [number, number, number] = [-hwB, yBot, -hdB];

  const t0: readonly [number, number, number] = [-hwT, yTop, hdT];
  const t1: readonly [number, number, number] = [hwT, yTop, hdT];
  const t2: readonly [number, number, number] = [hwT, yTop, -hdT];
  const t3: readonly [number, number, number] = [-hwT, yTop, -hdT];

  const positions: number[] = [];
  const uvs: number[] = [];

  const pushTri = (
    p0: readonly [number, number, number],
    uv0: readonly [number, number],
    p1: readonly [number, number, number],
    uv1: readonly [number, number],
    p2: readonly [number, number, number],
    uv2: readonly [number, number],
  ): void => {
    positions.push(p0[0], p0[1], p0[2], p1[0], p1[1], p1[2], p2[0], p2[1], p2[2]);
    uvs.push(uv0[0], uv0[1], uv1[0], uv1[1], uv2[0], uv2[1]);
  };

  const pushQuad = (
    p0: readonly [number, number, number],
    p1: readonly [number, number, number],
    p2: readonly [number, number, number],
    p3: readonly [number, number, number],
  ): void => {
    pushTri(p0, [0, 0], p1, [1, 0], p2, [1, 1]);
    pushTri(p0, [0, 0], p2, [1, 1], p3, [0, 1]);
  };

  // Side faces (vertices 0..23 -> materialIndex 0)
  pushQuad(b0, b1, t1, t0); // +Z front
  pushQuad(b1, b2, t2, t1); // +X right
  pushQuad(b2, b3, t3, t2); // -Z back
  pushQuad(b3, b0, t0, t3); // -X left

  // Caps (vertices 24..35 -> materialIndex 1)
  pushQuad(t0, t1, t2, t3); // +Y top
  pushQuad(b3, b2, b1, b0); // -Y bottom

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.computeVertexNormals();
  geo.addGroup(0, 24, 0);
  geo.addGroup(24, 12, 1);
  return geo;
}
