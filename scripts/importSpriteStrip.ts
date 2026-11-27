import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

export type BackgroundKeyMode = 'auto' | 'border' | 'none';
export type OutlineMatteMode = 'auto' | 'dark-ink' | 'bg-decontaminate' | 'none';
export type PoseAnchorMode = 'band-core' | 'core' | 'bbox';

export interface PixelPoint {
  readonly x: number;
  readonly y: number;
}

export interface BackgroundKeyOptions {
  readonly bgMode?: BackgroundKeyMode;
  readonly outlineMatteMode?: OutlineMatteMode;
  readonly fringeStripPasses?: number;
  readonly bgTolerance?: number;
  readonly chromaTolerance?: number;
  readonly clearEnclosedMinArea?: number;
  readonly seedPoints?: readonly PixelPoint[];
}

export interface BackgroundKeyResult {
  readonly keyed: boolean;
  readonly resolvedOutlineMatte: Exclude<OutlineMatteMode, 'auto'>;
  readonly bgColor: readonly [number, number, number];
  readonly clearedExteriorCount: number;
  readonly clearedInteriorCount: number;
}

export interface PoseDetectionOptions {
  readonly expectedFrames?: number;
  readonly gapMergePx?: number;
  readonly minPoseAreaPx?: number;
  readonly minSpeckAreaPx?: number;
  readonly alphaThreshold?: number;
  readonly anchorMode?: PoseAnchorMode;
}

export interface PoseSpan {
  readonly index: number;
  readonly x0: number;
  readonly x1: number;
  readonly y0: number;
  readonly y1: number;
  readonly wx0: number;
  readonly wx1: number;
  readonly anchorX: number;
  readonly areaPx: number;
}

export interface SpriteStripImportOptions extends BackgroundKeyOptions, PoseDetectionOptions {
  readonly cellSize?: number;
  readonly padPx?: number;
  readonly innerMarginPx?: number;
  readonly fillRatio?: number;
  readonly scale?: number;
  readonly dilatePasses?: number;
}

export interface SpriteStripImportResult {
  readonly width: number;
  readonly height: number;
  readonly rgba: Uint8Array;
  readonly poses: readonly PoseSpan[];
  readonly scale: number;
  readonly groundY: number;
  readonly bgKeyResult: BackgroundKeyResult;
}

export interface CliImportArgs {
  readonly help: boolean;
  readonly inputPath: string;
  readonly outputPath: string;
  readonly previewPath?: string;
  readonly options: SpriteStripImportOptions;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = ((): Uint32Array => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function makePngChunk(tag: string, data: Uint8Array): Buffer {
  const len = data.length;
  const out = Buffer.allocUnsafe(12 + len);
  out.writeUInt32BE(len, 0);
  out.write(tag, 4, 4, 'ascii');
  if (len > 0) {
    out.set(data, 8);
  }
  const crc = crc32(out.subarray(4, 8 + len));
  out.writeUInt32BE(crc, 8 + len);
  return out;
}

/**
 * Encodes an 8-bit RGBA image buffer into a valid PNG (color type 6, filter 0).
 */
export function encodeRgbaPng(width: number, height: number, rgba: Uint8Array): Buffer {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error(`Invalid PNG dimensions: ${width}x${height}`);
  }
  const stride = width * 4;
  if (rgba.length < stride * height) {
    throw new Error(`RGBA buffer too small (${rgba.length}) for ${width}x${height}`);
  }

  const ihdr = Buffer.allocUnsafe(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // non-interlaced

  const raw = Buffer.allocUnsafe((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const dstRow = y * (stride + 1);
    const srcRow = y * stride;
    raw[dstRow] = 0;
    raw.set(rgba.subarray(srcRow, srcRow + stride), dstRow + 1);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });

  return Buffer.concat([
    PNG_SIGNATURE,
    makePngChunk('IHDR', ihdr),
    makePngChunk('IDAT', idat),
    makePngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function paethPredictor(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/**
 * Decodes an 8-bit non-interlaced RGBA PNG (supporting PNG scanline filters 0..4).
 */
export function decodeRgbaPng(pngBytes: Uint8Array): {
  width: number;
  height: number;
  rgba: Uint8Array;
} {
  const buf = Buffer.isBuffer(pngBytes)
    ? pngBytes
    : Buffer.from(pngBytes.buffer, pngBytes.byteOffset, pngBytes.byteLength);
  if (buf.length < 33 || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error('Invalid PNG signature');
  }

  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  let seenIend = false;
  const idatChunks: Buffer[] = [];

  while (offset + 12 <= buf.length) {
    const len = buf.readUInt32BE(offset);
    const tag = buf.subarray(offset + 4, offset + 8).toString('ascii');
    const dataEnd = offset + 8 + len;
    if (dataEnd + 4 > buf.length) {
      throw new Error(`Truncated PNG chunk ${tag}`);
    }
    const data = buf.subarray(offset + 8, dataEnd);
    if (tag === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8] ?? 0;
      colorType = data[9] ?? 0;
      interlace = data[12] ?? 0;
    } else if (tag === 'IDAT') {
      idatChunks.push(data);
    } else if (tag === 'IEND') {
      seenIend = true;
      break;
    }
    offset = dataEnd + 4;
  }

  if (!seenIend) {
    throw new Error('Truncated PNG: missing IEND chunk');
  }
  if (idatChunks.length === 0) {
    throw new Error('PNG missing IDAT chunk');
  }

  if (width <= 0 || height <= 0 || bitDepth !== 8 || colorType !== 6 || interlace !== 0) {
    throw new Error(
      `Unsupported PNG format (${width}x${height}, depth=${bitDepth}, color=${colorType}, interlace=${interlace})`,
    );
  }

  const inflated = zlib.inflateSync(Buffer.concat(idatChunks));
  const bpp = 4;
  const stride = width * bpp;
  if (inflated.length < (stride + 1) * height) {
    throw new Error('Truncated PNG pixel payload');
  }

  const rgba = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const srcRow = y * (stride + 1);
    const filter = inflated[srcRow]!;
    const dstRow = y * stride;
    const prevRow = (y - 1) * stride;

    for (let i = 0; i < stride; i++) {
      const rawByte = inflated[srcRow + 1 + i]!;
      const left = i >= bpp ? rgba[dstRow + i - bpp]! : 0;
      const up = y > 0 ? rgba[prevRow + i]! : 0;
      const upLeft = y > 0 && i >= bpp ? rgba[prevRow + i - bpp]! : 0;

      let recon: number;
      switch (filter) {
        case 0:
          recon = rawByte;
          break;
        case 1:
          recon = (rawByte + left) & 0xff;
          break;
        case 2:
          recon = (rawByte + up) & 0xff;
          break;
        case 3:
          recon = (rawByte + ((left + up) >> 1)) & 0xff;
          break;
        case 4:
          recon = (rawByte + paethPredictor(left, up, upLeft)) & 0xff;
          break;
        default:
          throw new Error(`Unsupported PNG scanline filter ${filter}`);
      }
      rgba[dstRow + i] = recon;
    }
  }

  return { width, height, rgba };
}

/**
 * Decodes 8-bit RGBA PNGs natively in Node, falling back to `ffmpeg`/`ffprobe` for JPEG, WebP,
 * or non-RGBA8 PNGs.
 */
export function decodeImageViaFfmpeg(filePath: string): {
  width: number;
  height: number;
  rgba: Uint8Array;
} {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Input image not found: ${filePath}`);
  }
  if (filePath.toLowerCase().endsWith('.png')) {
    try {
      return decodeRgbaPng(fs.readFileSync(filePath));
    } catch {
      // Fall through to ffmpeg for RGB/indexed/16-bit PNGs
    }
  }

  const dimsText = execFileSync(
    'ffprobe',
    [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_entries',
      'stream=width,height',
      '-of',
      'csv=p=0',
      filePath,
    ],
    { encoding: 'utf8' },
  ).trim();
  const [wStr, hStr] = dimsText.split(',');
  const width = Number.parseInt(wStr ?? '', 10);
  const height = Number.parseInt(hStr ?? '', 10);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error(`Failed to read dimensions via ffprobe for ${filePath}: '${dimsText}'`);
  }

  const raw = execFileSync(
    'ffmpeg',
    ['-v', 'error', '-i', filePath, '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'],
    { maxBuffer: 128 * 1024 * 1024 },
  );
  const expectedBytes = width * height * 4;
  if (raw.length < expectedBytes) {
    throw new Error(
      `Decoded RGBA payload too small (${raw.length} < ${expectedBytes}) for ${filePath}`,
    );
  }
  return {
    width,
    height,
    rgba: new Uint8Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + expectedBytes)),
  };
}

/**
 * Propagates neighbor RGB values outward into transparent texels (`alpha === 0`) while keeping
 * `alpha === 0` so bilinear mipmaps never produce dark fringes along `alphaTest: 0.5` borders.
 */
export function dilateRgbaEdges(
  rgba: Uint8Array,
  width: number,
  height: number,
  passes = 6,
): void {
  const pixelCount = width * height;
  if (rgba.length < pixelCount * 4) {
    throw new Error('RGBA buffer too small for dilation');
  }

  let hasColor = new Uint8Array(pixelCount);
  let nextHasColor = new Uint8Array(pixelCount);
  const work = new Uint8Array(rgba);

  for (let i = 0; i < pixelCount; i++) {
    if ((rgba[i * 4 + 3] ?? 0) > 0) {
      hasColor[i] = 1;
    }
  }
  nextHasColor.set(hasColor);

  for (let pass = 0; pass < passes; pass++) {
    let anyChanged = false;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const idx = y * width + x;
        if (hasColor[idx] === 1) continue;

        let rSum = 0;
        let gSum = 0;
        let bSum = 0;
        let count = 0;

        for (let dy = -1; dy <= 1; dy++) {
          const ny = y + dy;
          if (ny < 0 || ny >= height) continue;
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            const nx = x + dx;
            if (nx < 0 || nx >= width) continue;
            const nIdx = ny * width + nx;
            if (hasColor[nIdx] === 1) {
              const base = nIdx * 4;
              rSum += rgba[base]!;
              gSum += rgba[base + 1]!;
              bSum += rgba[base + 2]!;
              count++;
            }
          }
        }

        if (count > 0) {
          const outBase = idx * 4;
          work[outBase] = Math.round(rSum / count);
          work[outBase + 1] = Math.round(gSum / count);
          work[outBase + 2] = Math.round(bSum / count);
          work[outBase + 3] = 0;
          nextHasColor[idx] = 1;
          anyChanged = true;
        }
      }
    }

    rgba.set(work);
    const tmp = hasColor;
    hasColor = nextHasColor;
    nextHasColor = tmp;
    nextHasColor.set(hasColor);

    if (!anyChanged) break;
  }
}

function clampByte(v: number): number {
  if (v <= 0) return 0;
  if (v >= 255) return 255;
  return Math.round(v);
}

function medianSorted(values: number[]): number {
  if (values.length === 0) return 255;
  values.sort((a, b) => a - b);
  const mid = values.length >> 1;
  if ((values.length & 1) === 1) {
    return values[mid]!;
  }
  return Math.round((values[mid - 1]! + values[mid]!) * 0.5);
}

function hasTransparentNeighbor8(
  rgba: Uint8Array,
  x: number,
  y: number,
  width: number,
  height: number,
): boolean {
  for (let dy = -1; dy <= 1; dy++) {
    const ny = y + dy;
    if (ny < 0 || ny >= height) continue;
    for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dy === 0) continue;
      const nx = x + dx;
      if (nx < 0 || nx >= width) continue;
      if (rgba[(ny * width + nx) * 4 + 3] === 0) {
        return true;
      }
    }
  }
  return false;
}

function hasDarkOutlineInBoundaryBand(
  rgba: Uint8Array,
  origAlpha: Uint8Array,
  width: number,
  height: number,
  bgR: number,
  bgG: number,
  bgB: number,
): boolean {
  let darkInkCount = 0;
  let lightEdgeCount = 0;
  let sampleCount = 0;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = y * width + x;
      const i4 = p * 4;
      if (origAlpha[p]! < 240 || rgba[i4 + 3] === 0) continue;

      let nearTransparent = false;
      for (let dy = -2; dy <= 2 && !nearTransparent; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) continue;
        for (let dx = -2; dx <= 2; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= width) continue;
          if (rgba[(ny * width + nx) * 4 + 3] === 0) {
            nearTransparent = true;
            break;
          }
        }
      }
      if (!nearTransparent) continue;

      const r = rgba[i4]!;
      const g = rgba[i4 + 1]!;
      const b = rgba[i4 + 2]!;
      const lum = 0.299 * r + 0.587 * g + 0.114 * b;
      const diffBg = Math.max(Math.abs(r - bgR), Math.abs(g - bgG), Math.abs(b - bgB));
      if (diffBg <= 70 && Math.max(r, g, b) - Math.min(r, g, b) <= 32) {
        // Likely outer ringing still touching dark outline
        continue;
      }
      sampleCount++;
      if (lum < 110) {
        darkInkCount++;
      } else if (lum >= 190) {
        lightEdgeCount++;
      }
    }
  }

  return sampleCount > 0 && darkInkCount >= Math.max(4, lightEdgeCount) && darkInkCount / sampleCount >= 0.35;
}

/**
 * Keys out solid border-connected backgrounds (preserving interior whites like teeth or snowflakes
 * unless explicitly opted into via `clearEnclosedMinArea` or `seedPoints`) and cleans outer halos
 * safely for both dark-ink outlines and light/white-fur sprites.
 */
export function keyOutBackground(
  rgba: Uint8Array,
  width: number,
  height: number,
  options: BackgroundKeyOptions = {},
): BackgroundKeyResult {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error(`Invalid dimensions for keyOutBackground: ${width}x${height}`);
  }
  if (rgba.length < width * height * 4) {
    throw new Error(`RGBA buffer too small (${rgba.length}) for ${width}x${height}`);
  }

  const bgMode = options.bgMode ?? 'auto';
  const outlineMatteMode = options.outlineMatteMode ?? 'auto';
  const bgTolerance = options.bgTolerance ?? 30;
  const chromaTolerance = options.chromaTolerance ?? 26;
  const clearEnclosedMinArea = options.clearEnclosedMinArea ?? 0;
  const seedPoints = options.seedPoints ?? [];

  if (bgMode === 'none') {
    return {
      keyed: false,
      resolvedOutlineMatte: 'none',
      bgColor: [255, 255, 255],
      clearedExteriorCount: 0,
      clearedInteriorCount: 0,
    };
  }

  // Sample entire perimeter: solid backgrounds have ~0% alpha=0 perimeter, while transparent PNGs
  // (even tightly cropped sprites touching a corner/bottom edge) retain >=25% transparent perimeter
  // (`--bg border` remains available to force keying explicitly).
  let perimeterTotal = 0;
  let perimeterTransparent = 0;
  const opR: number[] = [];
  const opG: number[] = [];
  const opB: number[] = [];

  const inspectPerimeter = (p: number): void => {
    const i4 = p * 4;
    perimeterTotal++;
    if (rgba[i4 + 3]! < 16) {
      perimeterTransparent++;
    } else {
      opR.push(rgba[i4]!);
      opG.push(rgba[i4 + 1]!);
      opB.push(rgba[i4 + 2]!);
    }
  };

  for (let x = 0; x < width; x++) {
    inspectPerimeter(x);
    if (height > 1) inspectPerimeter((height - 1) * width + x);
  }
  for (let y = 1; y < height - 1; y++) {
    inspectPerimeter(y * width);
    if (width > 1) inspectPerimeter(y * width + (width - 1));
  }

  if (bgMode === 'auto' && perimeterTotal > 0 && perimeterTransparent / perimeterTotal >= 0.25) {
    return {
      keyed: false,
      resolvedOutlineMatte: 'none',
      bgColor: [0, 0, 0],
      clearedExteriorCount: 0,
      clearedInteriorCount: 0,
    };
  }
  if (opR.length === 0) {
    return {
      keyed: false,
      resolvedOutlineMatte: 'none',
      bgColor: [0, 0, 0],
      clearedExteriorCount: 0,
      clearedInteriorCount: 0,
    };
  }

  const bgR = medianSorted(opR);
  const bgG = medianSorted(opG);
  const bgB = medianSorted(opB);
  const bgChroma = Math.max(bgR, bgG, bgB) - Math.min(bgR, bgG, bgB);
  const neutralBg = bgChroma <= chromaTolerance;

  const totalPixels = width * height;
  const origAlpha = new Uint8Array(totalPixels);
  for (let p = 0; p < totalPixels; p++) {
    origAlpha[p] = rgba[p * 4 + 3]!;
  }

  const isBgCandidate = (p: number): boolean => {
    const i = p * 4;
    if (rgba[i + 3]! < 16) return true;
    const r = rgba[i]!;
    const g = rgba[i + 1]!;
    const b = rgba[i + 2]!;
    const maxDiff = Math.max(Math.abs(r - bgR), Math.abs(g - bgG), Math.abs(b - bgB));
    if (maxDiff > bgTolerance) return false;
    if (neutralBg) {
      const chroma = Math.max(r, g, b) - Math.min(r, g, b);
      if (chroma > chromaTolerance) return false;
    }
    return true;
  };

  const bgMask = new Uint8Array(totalPixels);
  const queue = new Int32Array(totalPixels);
  let head = 0;
  let tail = 0;

  const tryEnqueue = (p: number): void => {
    if (bgMask[p] === 0 && isBgCandidate(p)) {
      bgMask[p] = 1;
      queue[tail++] = p;
    }
  };

  for (let x = 0; x < width; x++) {
    tryEnqueue(x);
    tryEnqueue((height - 1) * width + x);
  }
  for (let y = 0; y < height; y++) {
    tryEnqueue(y * width);
    tryEnqueue(y * width + (width - 1));
  }

  for (let i = 0; i < seedPoints.length; i++) {
    const pt = seedPoints[i]!;
    const sx = Math.max(0, Math.min(width - 1, Math.round(pt.x)));
    const sy = Math.max(0, Math.min(height - 1, Math.round(pt.y)));
    tryEnqueue(sy * width + sx);
  }

  while (head < tail) {
    const p = queue[head++]!;
    const x = p % width;
    const y = (p - x) / width;
    if (x > 0) tryEnqueue(p - 1);
    if (x + 1 < width) tryEnqueue(p + 1);
    if (y > 0) tryEnqueue(p - width);
    if (y + 1 < height) tryEnqueue(p + width);
  }
  const clearedExteriorCount = tail;

  // 4-connected interior pocket clearing matching exterior BFS so 1-px diagonal outlines stay sealed
  let clearedInteriorCount = 0;
  if (clearEnclosedMinArea > 0) {
    const seen = new Uint8Array(bgMask);
    const compQueue = new Int32Array(totalPixels);
    for (let p = 0; p < totalPixels; p++) {
      if (seen[p] === 1 || !isBgCandidate(p)) continue;
      let compHead = 0;
      let compTail = 0;
      seen[p] = 1;
      compQueue[compTail++] = p;
      while (compHead < compTail) {
        const cp = compQueue[compHead++]!;
        const cx = cp % width;
        const cy = (cp - cx) / width;
        if (cx > 0 && seen[cp - 1] === 0 && isBgCandidate(cp - 1)) {
          seen[cp - 1] = 1;
          compQueue[compTail++] = cp - 1;
        }
        if (cx + 1 < width && seen[cp + 1] === 0 && isBgCandidate(cp + 1)) {
          seen[cp + 1] = 1;
          compQueue[compTail++] = cp + 1;
        }
        if (cy > 0 && seen[cp - width] === 0 && isBgCandidate(cp - width)) {
          seen[cp - width] = 1;
          compQueue[compTail++] = cp - width;
        }
        if (cy + 1 < height && seen[cp + width] === 0 && isBgCandidate(cp + width)) {
          seen[cp + width] = 1;
          compQueue[compTail++] = cp + width;
        }
      }
      if (compTail >= clearEnclosedMinArea) {
        for (let k = 0; k < compTail; k++) {
          bgMask[compQueue[k]!] = 1;
        }
        clearedInteriorCount += compTail;
      }
    }
  }

  for (let p = 0; p < totalPixels; p++) {
    if (bgMask[p] === 1) {
      rgba[p * 4 + 3] = 0;
    }
  }

  let resolvedOutlineMatte: Exclude<OutlineMatteMode, 'auto'>;
  if (outlineMatteMode === 'auto') {
    resolvedOutlineMatte = hasDarkOutlineInBoundaryBand(
      rgba,
      origAlpha,
      width,
      height,
      bgR,
      bgG,
      bgB,
    )
      ? 'dark-ink'
      : 'bg-decontaminate';
  } else {
    resolvedOutlineMatte = outlineMatteMode;
  }

  const fringeStripPasses =
    options.fringeStripPasses ?? (resolvedOutlineMatte === 'dark-ink' ? 2 : 0);

  if (resolvedOutlineMatte !== 'none' && fringeStripPasses > 0) {
    const clearList: number[] = [];
    const ringTol = resolvedOutlineMatte === 'dark-ink' ? Math.max(bgTolerance, 80) : bgTolerance;
    for (let pass = 0; pass < fringeStripPasses; pass++) {
      clearList.length = 0;
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const p = y * width + x;
          const i4 = p * 4;
          if (origAlpha[p] !== 255 || rgba[i4 + 3] === 0) continue;
          if (!hasTransparentNeighbor8(rgba, x, y, width, height)) continue;
          const r = rgba[i4]!;
          const g = rgba[i4 + 1]!;
          const b = rgba[i4 + 2]!;
          const maxDiff = Math.max(Math.abs(r - bgR), Math.abs(g - bgG), Math.abs(b - bgB));
          if (neutralBg) {
            const chroma = Math.max(r, g, b) - Math.min(r, g, b);
            if (maxDiff <= ringTol && chroma <= 32) {
              clearList.push(p);
            }
          } else if (maxDiff <= ringTol) {
            clearList.push(p);
          }
        }
      }
      for (let k = 0; k < clearList.length; k++) {
        rgba[clearList[k]! * 4 + 3] = 0;
      }
    }
  }

  const bgLum = 0.299 * bgR + 0.587 * bgG + 0.114 * bgB;
  if (resolvedOutlineMatte === 'dark-ink' && neutralBg && bgLum >= 180) {
    const adjustIdx: number[] = [];
    const adjustR: number[] = [];
    const adjustG: number[] = [];
    const adjustB: number[] = [];
    const adjustA: number[] = [];

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const p = y * width + x;
        const i4 = p * 4;
        if (origAlpha[p] !== 255 || rgba[i4 + 3] === 0) continue;
        if (!hasTransparentNeighbor8(rgba, x, y, width, height)) continue;
        const r = rgba[i4]!;
        const g = rgba[i4 + 1]!;
        const b = rgba[i4 + 2]!;
        const minC = Math.min(r, g, b);
        const chroma = Math.max(r, g, b) - minC;
        if (minC >= 95 && chroma <= 38) {
          const lum = 0.299 * r + 0.587 * g + 0.114 * b;
          if (lum >= bgLum - 2) continue;
          const a = Math.max(0.04, Math.min(1, (bgLum - lum) / Math.max(1, bgLum - 42)));
          adjustIdx.push(i4);
          adjustR.push(clampByte((r - bgR * (1 - a)) / a));
          adjustG.push(clampByte((g - bgG * (1 - a)) / a));
          adjustB.push(clampByte((b - bgB * (1 - a)) / a));
          adjustA.push(clampByte(a * 255));
        }
      }
    }

    for (let k = 0; k < adjustIdx.length; k++) {
      const i4 = adjustIdx[k]!;
      rgba[i4] = adjustR[k]!;
      rgba[i4 + 1] = adjustG[k]!;
      rgba[i4 + 2] = adjustB[k]!;
      rgba[i4 + 3] = adjustA[k]!;
    }
  } else if (resolvedOutlineMatte === 'bg-decontaminate') {
    // Softly decontaminate newly exposed boundary pixels blended toward colored/neutral backgrounds
    // without eroding light-fur edges.
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const p = y * width + x;
        const i4 = p * 4;
        const aByte = rgba[i4 + 3]!;
        if (aByte === 0 || aByte === 255) continue;
        if (!hasTransparentNeighbor8(rgba, x, y, width, height)) continue;
        const a = aByte / 255;
        rgba[i4] = clampByte((rgba[i4]! - bgR * (1 - a)) / a);
        rgba[i4 + 1] = clampByte((rgba[i4 + 1]! - bgG * (1 - a)) / a);
        rgba[i4 + 2] = clampByte((rgba[i4 + 2]! - bgB * (1 - a)) / a);
      }
    }
  }

  return {
    keyed: true,
    resolvedOutlineMatte,
    bgColor: [bgR, bgG, bgB],
    clearedExteriorCount,
    clearedInteriorCount,
  };
}

/**
 * Clears tiny 2D isolated foreground dust specks before horizontal column projection so specks
 * near or above/below a pose never merge into `x0..x1` or corrupt `y0..y1`.
 */
function filterIsolatedForegroundSpecks(
  rgba: Uint8Array,
  width: number,
  height: number,
  alphaThreshold: number,
  minSpeckAreaPx: number,
  clearInBuffer: boolean,
): Uint8Array {
  const totalPixels = width * height;
  const fgMask = new Uint8Array(totalPixels);
  for (let p = 0; p < totalPixels; p++) {
    if (rgba[p * 4 + 3]! >= alphaThreshold) {
      fgMask[p] = 1;
    }
  }
  if (minSpeckAreaPx <= 1) {
    return fgMask;
  }

  const visited = new Uint8Array(totalPixels);
  const queue = new Int32Array(totalPixels);

  for (let p = 0; p < totalPixels; p++) {
    if (fgMask[p] === 0 || visited[p] === 1) continue;
    let head = 0;
    let tail = 0;
    visited[p] = 1;
    queue[tail++] = p;

    while (head < tail) {
      const cp = queue[head++]!;
      const cx = cp % width;
      const cy = (cp - cx) / width;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = cy + dy;
        if (ny < 0 || ny >= height) continue;
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = cx + dx;
          if (nx < 0 || nx >= width) continue;
          const np = ny * width + nx;
          if (fgMask[np] === 1 && visited[np] === 0) {
            visited[np] = 1;
            queue[tail++] = np;
          }
        }
      }
    }

    if (tail < minSpeckAreaPx) {
      for (let k = 0; k < tail; k++) {
        const kp = queue[k]!;
        fgMask[kp] = 0;
        if (clearInBuffer) {
          rgba[kp * 4 + 3] = 0;
        }
      }
    }
  }

  return fgMask;
}

/**
 * Segments horizontal pose spans from an RGBA buffer, filtering 2D isolated dust specks before
 * merging narrow gaps, computing character-agnostic horizontal anchors, and optionally zeroing
 * rejected speck columns.
 */
export function detectPoseSpans(
  rgba: Uint8Array,
  width: number,
  height: number,
  options: PoseDetectionOptions = {},
  clearRejectedSpecks = false,
): PoseSpan[] {
  const alphaThreshold = options.alphaThreshold ?? 128;
  const gapMergePx = options.gapMergePx ?? 6;
  const expectedFrames = options.expectedFrames ?? 4;
  const anchorMode = options.anchorMode ?? 'band-core';
  const minPoseAreaPx =
    options.minPoseAreaPx ?? Math.max(20, Math.min(500, Math.round(width * height * 0.0015)));
  const minSpeckAreaPx =
    options.minSpeckAreaPx ?? Math.max(3, Math.min(12, Math.round(minPoseAreaPx * 0.05)));

  const fgMask = filterIsolatedForegroundSpecks(
    rgba,
    width,
    height,
    alphaThreshold,
    minSpeckAreaPx,
    clearRejectedSpecks,
  );

  const colCount = new Int32Array(width);
  for (let y = 0; y < height; y++) {
    const rowOff = y * width;
    for (let x = 0; x < width; x++) {
      if (fgMask[rowOff + x] === 1) {
        colCount[x]!++;
      }
    }
  }

  const rawSpans: Array<{ x0: number; x1: number }> = [];
  let inSpan = false;
  let spanStart = 0;
  for (let x = 0; x < width; x++) {
    if (colCount[x]! > 0 && !inSpan) {
      spanStart = x;
      inSpan = true;
    } else if (colCount[x]! === 0 && inSpan) {
      rawSpans.push({ x0: spanStart, x1: x - 1 });
      inSpan = false;
    }
  }
  if (inSpan) {
    rawSpans.push({ x0: spanStart, x1: width - 1 });
  }

  const merged: Array<{ x0: number; x1: number }> = [];
  for (let i = 0; i < rawSpans.length; i++) {
    const cur = rawSpans[i]!;
    const prev = merged[merged.length - 1];
    if (prev && cur.x0 - prev.x1 - 1 <= gapMergePx) {
      prev.x1 = cur.x1;
    } else {
      merged.push({ x0: cur.x0, x1: cur.x1 });
    }
  }

  const kept: Array<{ x0: number; x1: number; areaPx: number }> = [];
  for (let i = 0; i < merged.length; i++) {
    const s = merged[i]!;
    let area = 0;
    for (let x = s.x0; x <= s.x1; x++) {
      area += colCount[x]!;
    }
    if (area >= minPoseAreaPx) {
      kept.push({ x0: s.x0, x1: s.x1, areaPx: area });
    } else if (clearRejectedSpecks) {
      for (let y = 0; y < height; y++) {
        const rowOff = y * width * 4;
        for (let x = s.x0; x <= s.x1; x++) {
          rgba[rowOff + x * 4 + 3] = 0;
        }
      }
    }
  }

  if (expectedFrames > 0 && kept.length !== expectedFrames) {
    const desc = kept.map((s, idx) => `#${idx}[x=${s.x0}..${s.x1},area=${s.areaPx}]`).join(', ');
    throw new Error(
      `Expected ${expectedFrames} pose frames but detected ${kept.length} (${desc || 'none'})`,
    );
  }

  const poses: PoseSpan[] = [];
  for (let i = 0; i < kept.length; i++) {
    const s = kept[i]!;
    let y0 = height;
    let y1 = -1;
    for (let y = 0; y < height; y++) {
      const rowOff = y * width;
      for (let x = s.x0; x <= s.x1; x++) {
        if (fgMask[rowOff + x] === 1) {
          if (y < y0) y0 = y;
          if (y > y1) y1 = y;
        }
      }
    }

    const wx0 = i === 0 ? 0 : Math.floor((kept[i - 1]!.x1 + s.x0) * 0.5) + 1;
    const wx1 = i === kept.length - 1 ? width - 1 : Math.floor((s.x1 + kept[i + 1]!.x0) * 0.5);

    let anchorX = (s.x0 + s.x1) * 0.5;
    if (anchorMode === 'core' || anchorMode === 'band-core') {
      const spanH = Math.max(1, y1 - y0 + 1);
      const by0 = anchorMode === 'band-core' ? Math.floor(y0 + spanH * 0.15) : y0;
      const by1 = anchorMode === 'band-core' ? Math.ceil(y0 + spanH * 0.85) : y1;
      let num = 0;
      let den = 0;
      for (let x = s.x0; x <= s.x1; x++) {
        let cnt = 0;
        for (let y = Math.max(y0, by0); y <= Math.min(y1, by1); y++) {
          if (fgMask[y * width + x] === 1) {
            cnt++;
          }
        }
        const w = cnt * cnt * cnt;
        num += x * w;
        den += w;
      }
      if (den > 0) {
        anchorX = num / den;
      }
    }

    poses.push({
      index: i,
      x0: s.x0,
      x1: s.x1,
      y0,
      y1,
      wx0,
      wx1,
      anchorX,
      areaPx: s.areaPx,
    });
  }

  return poses;
}

function samplePremulBilinear(
  srcRgba: Uint8Array,
  srcW: number,
  srcH: number,
  sx: number,
  sy: number,
  wx0: number,
  wx1: number,
): readonly [number, number, number, number] {
  if (sx < wx0 || sx > wx1 || sy < 0 || sy > srcH - 1) {
    return [0, 0, 0, 0];
  }
  const x0 = Math.floor(sx);
  const y0 = Math.floor(sy);
  const x1 = Math.min(wx1, x0 + 1);
  const y1 = Math.min(srcH - 1, y0 + 1);
  const fx = sx - x0;
  const fy = sy - y0;

  const i00 = (y0 * srcW + x0) * 4;
  const i10 = (y0 * srcW + x1) * 4;
  const i01 = (y1 * srcW + x0) * 4;
  const i11 = (y1 * srcW + x1) * 4;

  const a00 = srcRgba[i00 + 3]! / 255;
  const a10 = srcRgba[i10 + 3]! / 255;
  const a01 = srcRgba[i01 + 3]! / 255;
  const a11 = srcRgba[i11 + 3]! / 255;

  const w00 = (1 - fx) * (1 - fy);
  const w10 = fx * (1 - fy);
  const w01 = (1 - fx) * fy;
  const w11 = fx * fy;

  const pr =
    srcRgba[i00]! * a00 * w00 +
    srcRgba[i10]! * a10 * w10 +
    srcRgba[i01]! * a01 * w01 +
    srcRgba[i11]! * a11 * w11;
  const pg =
    srcRgba[i00 + 1]! * a00 * w00 +
    srcRgba[i10 + 1]! * a10 * w10 +
    srcRgba[i01 + 1]! * a01 * w01 +
    srcRgba[i11 + 1]! * a11 * w11;
  const pb =
    srcRgba[i00 + 2]! * a00 * w00 +
    srcRgba[i10 + 2]! * a10 * w10 +
    srcRgba[i01 + 2]! * a01 * w01 +
    srcRgba[i11 + 2]! * a11 * w11;
  const pa = a00 * w00 + a10 * w10 + a01 * w01 + a11 * w11;

  return [pr, pg, pb, pa];
}

/**
 * Processes an in-memory RGBA sprite strip into uniformly scaled, anchor-centered, border-padded,
 * RGB-dilated `cellSize x cellSize` cells ready for `CharacterBillboardAtlas`.
 */
export function processSpriteStripRgba(
  inputRgba: Uint8Array,
  width: number,
  height: number,
  options: SpriteStripImportOptions = {},
): SpriteStripImportResult {
  const cellSize = options.cellSize ?? 256;
  const padPx = options.padPx ?? 4;
  const innerMarginPx = options.innerMarginPx ?? 4;
  const fillRatio = options.fillRatio ?? 0.9;
  const dilatePasses = options.dilatePasses ?? 6;
  if (cellSize <= 0 || padPx < 0 || padPx * 2 >= cellSize) {
    throw new Error(`Invalid cellSize=${cellSize} / padPx=${padPx}`);
  }
  const groundY = cellSize - padPx - 2;

  const work = new Uint8Array(inputRgba);
  const bgKeyResult = keyOutBackground(work, width, height, options);
  const poses = detectPoseSpans(work, width, height, options, true);
  if (poses.length === 0) {
    throw new Error('No pose frames detected in sprite strip');
  }

  let scale = options.scale;
  if (scale === undefined) {
    let maxHalfReach = 1;
    let maxHeight = 1;
    for (let i = 0; i < poses.length; i++) {
      const pose = poses[i]!;
      const halfReach = Math.max(pose.anchorX - pose.x0, pose.x1 - pose.anchorX);
      const poseH = Math.max(1, pose.y1 - pose.y0 + 1);
      if (halfReach > maxHalfReach) maxHalfReach = halfReach;
      if (poseH > maxHeight) maxHeight = poseH;
    }
    const maxAllowedHalfW = cellSize * 0.5 - (padPx + innerMarginPx);
    const maxAllowedH = groundY - (padPx + innerMarginPx);
    const targetHeightPx = Math.min(maxAllowedH, Math.round(cellSize * fillRatio));
    scale = Math.min(maxAllowedHalfW / maxHalfReach, targetHeightPx / maxHeight);
  }
  if (!Number.isFinite(scale) || scale <= 0) {
    throw new Error(`Computed invalid sprite scale: ${scale}`);
  }

  const outWidth = poses.length * cellSize;
  const outHeight = cellSize;
  const outRgba = new Uint8Array(outWidth * outHeight * 4);

  for (let col = 0; col < poses.length; col++) {
    const pose = poses[col]!;
    const dstCx = col * cellSize + cellSize * 0.5;
    const srcCx = pose.anchorX;
    const srcYBot = pose.y1;

    for (let dy = padPx; dy < cellSize - padPx; dy++) {
      for (let dx = padPx; dx < cellSize - padPx; dx++) {
        const ox = col * cellSize + dx;
        const oy = dy;
        let prSum = 0;
        let pgSum = 0;
        let pbSum = 0;
        let paSum = 0;

        for (let subY = -0.25; subY <= 0.25; subY += 0.5) {
          for (let subX = -0.25; subX <= 0.25; subX += 0.5) {
            const sx = srcCx + (ox + 0.5 + subX - dstCx) / scale;
            const sy = srcYBot + (oy + 0.5 + subY - groundY) / scale;
            const [pr, pg, pb, pa] = samplePremulBilinear(
              work,
              width,
              height,
              sx,
              sy,
              pose.wx0,
              pose.wx1,
            );
            prSum += pr;
            pgSum += pg;
            pbSum += pb;
            paSum += pa;
          }
        }

        const pr = prSum * 0.25;
        const pg = pgSum * 0.25;
        const pb = pbSum * 0.25;
        const pa = paSum * 0.25;
        if (pa > 0.01) {
          const i4 = (oy * outWidth + ox) * 4;
          outRgba[i4] = clampByte(pr / pa);
          outRgba[i4 + 1] = clampByte(pg / pa);
          outRgba[i4 + 2] = clampByte(pb / pa);
          outRgba[i4 + 3] = clampByte(pa * 255);
        }
      }
    }
  }

  if (dilatePasses > 0) {
    dilateRgbaEdges(outRgba, outWidth, outHeight, dilatePasses);
  }

  return {
    width: outWidth,
    height: outHeight,
    rgba: outRgba,
    poses,
    scale,
    groundY,
    bgKeyResult,
  };
}

/**
 * Renders a 2x-height inspection sheet over dark slate (#1e293b) and bright snow (#f0f9ff)
 * with red vertical centerlines, ground baseline, and gray cell dividers.
 */
export function renderPreviewSheet(
  rgba: Uint8Array,
  width: number,
  height: number,
  cellSize: number,
  groundY: number,
): Uint8Array {
  const chkH = height * 2;
  const out = new Uint8Array(width * chkH * 4);
  const bgs: ReadonlyArray<readonly [number, number, number]> = [
    [30, 41, 59],
    [240, 249, 255],
  ];
  const halfCell = Math.floor(cellSize * 0.5);

  for (let half = 0; half < bgs.length; half++) {
    const bg = bgs[half]!;
    const yOff = half * height;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const si = (y * width + x) * 4;
        const di = ((y + yOff) * width + x) * 4;
        const a = rgba[si + 3]! / 255;
        let r = Math.round(rgba[si]! * a + bg[0] * (1 - a));
        let g = Math.round(rgba[si + 1]! * a + bg[1] * (1 - a));
        let b = Math.round(rgba[si + 2]! * a + bg[2] * (1 - a));
        if (x % cellSize === halfCell || y === groundY) {
          r = 239;
          g = 68;
          b = 68;
        } else if (x % cellSize === 0) {
          r = 100;
          g = 116;
          b = 139;
        }
        out[di] = r;
        out[di + 1] = g;
        out[di + 2] = b;
        out[di + 3] = 255;
      }
    }
  }

  return out;
}

function parseFiniteNum(raw: string | undefined, flag: string): number {
  const n = Number(raw);
  if (raw === undefined || !Number.isFinite(n)) {
    throw new Error(`Invalid numeric argument for ${flag}: '${raw ?? ''}'`);
  }
  return n;
}

export function parseCliArgs(argv: readonly string[]): CliImportArgs {
  let help = false;
  let inputPath = '';
  let outputPath = '';
  let previewPath: string | undefined;

  let expectedFrames = 4;
  let cellSize = 256;
  let padPx = 4;
  let fillRatio = 0.9;
  let scale: number | undefined;
  let anchorMode: PoseAnchorMode = 'band-core';
  let bgMode: BackgroundKeyMode = 'auto';
  let outlineMatteMode: OutlineMatteMode = 'auto';
  let fringeStripPasses: number | undefined;
  let bgTolerance = 30;
  let clearEnclosedMinArea = 0;
  let dilatePasses = 6;
  const seedPoints: PixelPoint[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--help' || arg === '-h') {
      help = true;
      continue;
    }
    const next = argv[++i];
    switch (arg) {
      case '--in':
        if (!next) throw new Error('Missing value for --in');
        inputPath = next;
        break;
      case '--out':
        if (!next) throw new Error('Missing value for --out');
        outputPath = next;
        break;
      case '--preview':
        if (!next) throw new Error('Missing value for --preview');
        previewPath = next;
        break;
      case '--frames':
        expectedFrames = Math.trunc(parseFiniteNum(next, '--frames'));
        if (expectedFrames < 0) throw new Error('--frames must be >= 0');
        break;
      case '--cell-size':
        cellSize = Math.trunc(parseFiniteNum(next, '--cell-size'));
        if (cellSize <= 0) throw new Error('--cell-size must be > 0');
        break;
      case '--pad':
        padPx = Math.trunc(parseFiniteNum(next, '--pad'));
        if (padPx < 0) throw new Error('--pad must be >= 0');
        break;
      case '--fill-ratio':
        fillRatio = parseFiniteNum(next, '--fill-ratio');
        if (fillRatio <= 0 || fillRatio > 1) throw new Error('--fill-ratio must be in (0, 1]');
        break;
      case '--scale':
        scale = parseFiniteNum(next, '--scale');
        if (scale <= 0) throw new Error('--scale must be > 0');
        break;
      case '--anchor':
        if (next !== 'band-core' && next !== 'core' && next !== 'bbox') {
          throw new Error(`Invalid --anchor '${next ?? ''}', expected band-core|core|bbox`);
        }
        anchorMode = next;
        break;
      case '--bg':
        if (next !== 'auto' && next !== 'border' && next !== 'none') {
          throw new Error(`Invalid --bg '${next ?? ''}', expected auto|border|none`);
        }
        bgMode = next;
        break;
      case '--outline-matte':
        if (
          next !== 'auto' &&
          next !== 'dark-ink' &&
          next !== 'bg-decontaminate' &&
          next !== 'none'
        ) {
          throw new Error(
            `Invalid --outline-matte '${next ?? ''}', expected auto|dark-ink|bg-decontaminate|none`,
          );
        }
        outlineMatteMode = next;
        break;
      case '--fringe-passes':
        fringeStripPasses = Math.trunc(parseFiniteNum(next, '--fringe-passes'));
        if (fringeStripPasses < 0) throw new Error('--fringe-passes must be >= 0');
        break;
      case '--bg-tolerance':
        bgTolerance = parseFiniteNum(next, '--bg-tolerance');
        if (bgTolerance < 0) throw new Error('--bg-tolerance must be >= 0');
        break;
      case '--clear-enclosed-min-area':
        clearEnclosedMinArea = Math.trunc(parseFiniteNum(next, '--clear-enclosed-min-area'));
        if (clearEnclosedMinArea < 0) throw new Error('--clear-enclosed-min-area must be >= 0');
        break;
      case '--dilate-passes':
        dilatePasses = Math.trunc(parseFiniteNum(next, '--dilate-passes'));
        if (dilatePasses < 0) throw new Error('--dilate-passes must be >= 0');
        break;
      case '--seed-bg': {
        const parts = (next ?? '').split(',');
        if (parts.length !== 2) {
          throw new Error(`Invalid --seed-bg '${next ?? ''}', expected x,y`);
        }
        seedPoints.push({
          x: parseFiniteNum(parts[0], '--seed-bg x'),
          y: parseFiniteNum(parts[1], '--seed-bg y'),
        });
        break;
      }
      default:
        throw new Error(`Unknown CLI argument: ${arg}`);
    }
  }

  if (padPx * 2 >= cellSize) {
    throw new Error(`--pad (${padPx}) must be less than half of --cell-size (${cellSize})`);
  }

  if (!help && (!inputPath || !outputPath)) {
    throw new Error('Both --in <path> and --out <path> are required (pass --help for usage)');
  }

  return {
    help,
    inputPath,
    outputPath,
    previewPath,
    options: {
      expectedFrames,
      cellSize,
      padPx,
      fillRatio,
      scale,
      anchorMode,
      bgMode,
      outlineMatteMode,
      fringeStripPasses,
      bgTolerance,
      clearEnclosedMinArea,
      dilatePasses,
      seedPoints,
    },
  };
}

export function importSpriteStripFile(
  inputPath: string,
  outputPath: string,
  options: SpriteStripImportOptions = {},
  previewPath?: string,
): SpriteStripImportResult {
  const decoded = decodeImageViaFfmpeg(inputPath);
  const result = processSpriteStripRgba(decoded.rgba, decoded.width, decoded.height, options);

  if (previewPath) {
    const previewRgba = renderPreviewSheet(
      result.rgba,
      result.width,
      result.height,
      options.cellSize ?? 256,
      result.groundY,
    );
    fs.mkdirSync(path.dirname(previewPath), { recursive: true });
    fs.writeFileSync(previewPath, encodeRgbaPng(result.width, result.height * 2, previewRgba));
  }

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, encodeRgbaPng(result.width, result.height, result.rgba));
  return result;
}

const USAGE_TEXT = `Usage: npm run import:sprite -- --in <input-image> --out <output.png> [options]

Options:
  --frames <n>                   Expected horizontal poses (default: 4, 0 = auto)
  --cell-size <px>               Output square cell size in px (default: 256)
  --pad <px>                     Transparent cell border padding in px (default: 4)
  --fill-ratio <0..1>            Target max sprite height fill within cell (default: 0.90)
  --scale <num>                  Optional explicit uniform scale factor
  --anchor <band-core|core|bbox> Horizontal centering anchor (default: band-core)
  --bg <auto|border|none>        Background removal mode (default: auto)
  --outline-matte <mode>         auto|dark-ink|bg-decontaminate|none (default: auto)
  --fringe-passes <n>            Outer halo passes (default: 2 for dark-ink, 0 otherwise)
  --bg-tolerance <n>             Max channel delta from corner bg color (default: 30)
  --clear-enclosed-min-area <px> Optional min interior bg pocket area to clear (default: 0)
  --seed-bg <x,y>                Optional enclosed background pixel seed (repeatable)
  --dilate-passes <n>            RGB edge dilation passes into alpha=0 texels (default: 6)
  --preview <path.png>           Write dark/light alignment inspection sheet
  -h, --help                     Show this help message
`;

const isCliMain =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isCliMain) {
  const parsed = parseCliArgs(process.argv.slice(2));
  if (parsed.help) {
    console.log(USAGE_TEXT);
  } else {
    const res = importSpriteStripFile(
      parsed.inputPath,
      parsed.outputPath,
      parsed.options,
      parsed.previewPath,
    );
    console.log(
      `Imported ${res.poses.length} frames -> ${parsed.outputPath} (${res.width}x${res.height}, scale=${res.scale.toFixed(4)}, matte=${res.bgKeyResult.resolvedOutlineMatte})`,
    );
  }
}
