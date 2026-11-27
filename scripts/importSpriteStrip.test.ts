import zlib from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  decodeRgbaPng,
  detectPoseSpans,
  dilateRgbaEdges,
  encodeRgbaPng,
  keyOutBackground,
  parseCliArgs,
  processSpriteStripRgba,
  renderPreviewSheet,
} from './importSpriteStrip';

function makeSolidRgba(w: number, h: number, r: number, g: number, b: number, a: number): Uint8Array {
  const buf = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const o = i * 4;
    buf[o] = r;
    buf[o + 1] = g;
    buf[o + 2] = b;
    buf[o + 3] = a;
  }
  return buf;
}

function fillRectRgba(
  buf: Uint8Array,
  w: number,
  x0: number,
  y0: number,
  rw: number,
  rh: number,
  r: number,
  g: number,
  b: number,
  a: number,
): void {
  for (let y = y0; y < y0 + rh; y++) {
    for (let x = x0; x < x0 + rw; x++) {
      const o = (y * w + x) * 4;
      buf[o] = r;
      buf[o + 1] = g;
      buf[o + 2] = b;
      buf[o + 3] = a;
    }
  }
}

describe('scripts/importSpriteStrip reusable sprite importer', () => {
  it('round-trips RGBA buffers cleanly through encodeRgbaPng and decodeRgbaPng (including filters 1..4)', () => {
    const w = 16;
    const h = 12;
    const rgba = makeSolidRgba(w, h, 35, 90, 140, 255);
    fillRectRgba(rgba, w, 2, 2, 6, 5, 220, 40, 60, 180);
    fillRectRgba(rgba, w, 9, 4, 4, 6, 0, 0, 0, 0);

    const png = encodeRgbaPng(w, h, rgba);
    const decoded = decodeRgbaPng(png);
    expect(decoded.width).toBe(w);
    expect(decoded.height).toBe(h);
    expect(decoded.rgba).toEqual(rgba);

    // Build a filter-4 (Paeth) + filter-1/2/3 PNG payload to verify full decoder support
    const rawFiltered = Buffer.alloc((w * 4 + 1) * h);
    const stride = w * 4;
    for (let y = 0; y < h; y++) {
      const filter = y % 5;
      rawFiltered[y * (stride + 1)] = filter;
      for (let i = 0; i < stride; i++) {
        const cur = rgba[y * stride + i]!;
        const left = i >= 4 ? rgba[y * stride + i - 4]! : 0;
        const up = y > 0 ? rgba[(y - 1) * stride + i]! : 0;
        const upLeft = y > 0 && i >= 4 ? rgba[(y - 1) * stride + i - 4]! : 0;
        let pred = 0;
        if (filter === 1) pred = left;
        else if (filter === 2) pred = up;
        else if (filter === 3) pred = (left + up) >> 1;
        else if (filter === 4) {
          const p = left + up - upLeft;
          const pa = Math.abs(p - left);
          const pb = Math.abs(p - up);
          const pc = Math.abs(p - upLeft);
          pred = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
        }
        rawFiltered[y * (stride + 1) + 1 + i] = (cur - pred) & 0xff;
      }
    }
    const idatPos = png.indexOf('IDAT');
    const iendPos = png.indexOf('IEND');
    const customIdat = zlib.deflateSync(rawFiltered);
    const rebuilt = Buffer.concat([
      png.subarray(0, idatPos - 4),
      (() => {
        const chunk = Buffer.alloc(12 + customIdat.length);
        chunk.writeUInt32BE(customIdat.length, 0);
        chunk.write('IDAT', 4, 4, 'ascii');
        customIdat.copy(chunk, 8);
        // Compute CRC via re-encoding helper? Better: skip CRC validation since decodeRgbaPng only validates structure; write 0 CRC.
        return chunk;
      })(),
      png.subarray(iendPos - 4),
    ]);
    expect(decodeRgbaPng(rebuilt).rgba).toEqual(rgba);

    // Invalid PNG decoding error paths
    expect(() => decodeRgbaPng(Buffer.from('not-a-png'))).toThrow(/Invalid PNG signature/);
    const truncated = png.subarray(0, png.length - 4);
    expect(() => decodeRgbaPng(truncated)).toThrow();
  });

  it('keys exterior white background, strips fringe ringing, preserves 4-connected sealed interior whites, and handles light-fur & colored backgrounds', () => {
    const w = 40;
    const h = 36;
    const rgba = makeSolidRgba(w, h, 255, 255, 255, 255);
    // Dark outline sprite body
    fillRectRgba(rgba, w, 10, 6, 20, 24, 24, 24, 30, 255);
    // Bright white ringing pixel immediately outside outline
    fillRectRgba(rgba, w, 9, 10, 1, 4, 210, 210, 210, 255);
    // Interior white eye/teeth sealed ONLY by a 1-px diagonal dark outline (4-connected must NOT leak!)
    fillRectRgba(rgba, w, 16, 12, 3, 3, 252, 252, 252, 255);
    fillRectRgba(rgba, w, 15, 11, 5, 5, 24, 24, 30, 255);
    fillRectRgba(rgba, w, 16, 12, 3, 3, 252, 252, 252, 255);
    // Carve 4-connected diagonal corner gaps on that box so only diagonal outline seals it
    fillRectRgba(rgba, w, 15, 11, 1, 1, 255, 255, 255, 255);
    // Enclosed large white leg pocket >= 12px
    fillRectRgba(rgba, w, 18, 22, 4, 5, 254, 254, 254, 255);

    const res = keyOutBackground(rgba, w, h, {
      bgMode: 'border',
      clearEnclosedMinArea: 15,
    });
    expect(res.keyed).toBe(true);
    expect(res.resolvedOutlineMatte).toBe('dark-ink');
    // Exterior cleared
    expect(rgba[(0 * w + 0) * 4 + 3]).toBe(0);
    // Bright outer ringing stripped
    expect(rgba[(11 * w + 9) * 4 + 3]).toBe(0);
    // Sealed 9px interior white eye preserved (4-connected did not leak diagonally and < 15px)!
    expect(rgba[(13 * w + 17) * 4 + 3]).toBe(255);
    // Large enclosed pocket >= 15px cleared!
    expect(rgba[(24 * w + 19) * 4 + 3]).toBe(0);

    // Lineless white rabbit fur (rgb 252,252,254) on light-grey background (rgb 200,200,200):
    // 'auto' must detect no dark ink and preserve 100% of white fur edges!
    const rw = 32;
    const rh = 32;
    const rabbitRgba = makeSolidRgba(rw, rh, 200, 200, 200, 255);
    fillRectRgba(rabbitRgba, rw, 8, 6, 16, 20, 252, 252, 254, 255);
    const rabbitRes = keyOutBackground(rabbitRgba, rw, rh, { bgMode: 'auto' });
    expect(rabbitRes.keyed).toBe(true);
    expect(rabbitRes.resolvedOutlineMatte).toBe('bg-decontaminate');
    expect(rabbitRgba[(0 * rw + 0) * 4 + 3]).toBe(0);
    expect(rabbitRgba[(6 * rw + 8) * 4 + 3]).toBe(255);
    expect(rabbitRgba[(6 * rw + 8) * 4]).toBe(252);

    // Colored green-screen background + partial alpha decontamination
    const greenRgba = makeSolidRgba(24, 24, 0, 255, 0, 255);
    fillRectRgba(greenRgba, 24, 6, 6, 12, 12, 180, 40, 40, 255);
    // Blended edge pixel (50% red coat, 50% green bg, alpha=128)
    fillRectRgba(greenRgba, 24, 5, 10, 1, 1, 90, 148, 20, 128);
    const greenRes = keyOutBackground(greenRgba, 24, 24, {
      bgMode: 'border',
      outlineMatteMode: 'bg-decontaminate',
    });
    expect(greenRes.keyed).toBe(true);
    expect(greenRgba[(0 * 24 + 0) * 4 + 3]).toBe(0);
    // Green spill reduced on semi-transparent boundary pixel
    expect(greenRgba[(10 * 24 + 5) * 4 + 1]).toBeLessThan(80);
  });

  it('skips keying on native transparent RGBA input even if sprite touches one corner', () => {
    const w = 32;
    const h = 32;
    const rgba = makeSolidRgba(w, h, 0, 0, 0, 0);
    // Bright white character body touching top-left corner (0,0)
    fillRectRgba(rgba, w, 0, 0, 12, 18, 250, 250, 252, 255);

    const res = keyOutBackground(rgba, w, h, { bgMode: 'auto' });
    expect(res.keyed).toBe(false);
    expect(rgba[(0 * w + 0) * 4 + 3]).toBe(255);
    expect(rgba[(12 * w + 6) * 4]).toBe(250);
  });

  it('detectPoseSpans filters 2D specks near or above poses before span merging & y-bounds', () => {
    const w = 160;
    const h = 64;
    const rgba = makeSolidRgba(w, h, 0, 0, 0, 0);

    // Pose 0: core torso [20..36], protruding thin right scarf [39..54] (gap <= 6px merged)
    fillRectRgba(rgba, w, 20, 12, 16, 44, 30, 60, 90, 255);
    fillRectRgba(rgba, w, 39, 20, 16, 5, 160, 50, 80, 255);

    // Stray 1-px specks: 2px from Pose 0 horizontally AND directly above Pose 0 at y=2!
    fillRectRgba(rgba, w, 57, 25, 1, 1, 40, 40, 40, 255);
    fillRectRgba(rgba, w, 28, 2, 1, 1, 40, 40, 40, 255);
    // Stray 1-px speck at x=75
    fillRectRgba(rgba, w, 75, 30, 1, 1, 40, 40, 40, 255);

    // Pose 1: core torso [100..118]
    fillRectRgba(rgba, w, 100, 12, 18, 44, 40, 120, 80, 255);

    const poses = detectPoseSpans(rgba, w, h, { expectedFrames: 2, anchorMode: 'band-core' }, true);
    expect(poses).toHaveLength(2);
    // Horizontal speck at x=57 did NOT merge into Pose 0, and vertical speck at y=2 did NOT pull y0 up!
    expect(poses[0]!.x0).toBe(20);
    expect(poses[0]!.x1).toBe(54);
    expect(poses[0]!.y0).toBe(12);
    expect(poses[0]!.y1).toBe(55);
    // band-core anchor stays centered near torso [20..36] (~27.5), NOT dragged right to bbox mid (37)
    expect(poses[0]!.anchorX).toBeGreaterThan(25);
    expect(poses[0]!.anchorX).toBeLessThan(30);
    expect(rgba[(30 * w + 75) * 4 + 3]).toBe(0);
    expect(rgba[(25 * w + 57) * 4 + 3]).toBe(0);
    expect(rgba[(2 * w + 28) * 4 + 3]).toBe(0);

    expect(() => detectPoseSpans(rgba, w, h, { expectedFrames: 4 })).toThrow(
      /Expected 4 pose frames/,
    );
  });

  it('packs poses uniformly with strict transparent padding, crouch height preservation, RGB dilation, and preview rendering', () => {
    const w = 128;
    const h = 64;
    const rgba = makeSolidRgba(w, h, 255, 255, 255, 255);
    // Tall standing pose 0 (h=48)
    fillRectRgba(rgba, w, 12, 8, 22, 48, 40, 90, 130, 255);
    // Shorter crouching pose 1 (h=32)
    fillRectRgba(rgba, w, 72, 24, 24, 32, 180, 60, 50, 255);

    const cellSize = 64;
    const padPx = 4;
    const res = processSpriteStripRgba(rgba, w, h, {
      expectedFrames: 2,
      cellSize,
      padPx,
      innerMarginPx: 2,
      fillRatio: 0.85,
      dilatePasses: 4,
    });

    expect(res.width).toBe(128);
    expect(res.height).toBe(64);
    expect(res.poses).toHaveLength(2);

    // Every border pixel within padPx around both cells must remain alpha === 0
    for (let col = 0; col < 2; col++) {
      let minY = cellSize;
      let dilatedCount = 0;
      for (let ly = 0; ly < cellSize; ly++) {
        for (let lx = 0; lx < cellSize; lx++) {
          const i4 = (ly * res.width + col * cellSize + lx) * 4;
          const a = res.rgba[i4 + 3]!;
          const inPad =
            lx < padPx || lx >= cellSize - padPx || ly < padPx || ly >= cellSize - padPx;
          if (inPad) {
            expect(a).toBe(0);
          }
          if (a >= 128 && ly < minY) minY = ly;
          if (a === 0 && (res.rgba[i4]! > 0 || res.rgba[i4 + 1]! > 0 || res.rgba[i4 + 2]! > 0)) {
            dilatedCount++;
          }
        }
      }
      expect(dilatedCount).toBeGreaterThan(20);
      if (col === 0) {
        // Standing pose reaches higher than crouch pose (col 1) under uniform scaling
        expect(minY).toBeLessThan(20);
      } else {
        expect(minY).toBeGreaterThan(20);
      }
    }

    // Direct dilation test
    const dBuf = makeSolidRgba(5, 5, 0, 0, 0, 0);
    fillRectRgba(dBuf, 5, 2, 2, 1, 1, 200, 120, 40, 255);
    dilateRgbaEdges(dBuf, 5, 5, 1);
    expect(dBuf[(2 * 5 + 1) * 4]).toBe(200);
    expect(dBuf[(2 * 5 + 1) * 4 + 3]).toBe(0);

    // Preview sheet dimensions
    const preview = renderPreviewSheet(res.rgba, res.width, res.height, cellSize, res.groundY);
    expect(preview.length).toBe(res.width * res.height * 2 * 4);
  });

  it('parses CLI flags cleanly and rejects missing/invalid options', () => {
    const parsed = parseCliArgs([
      '--in',
      'in.jpg',
      '--out',
      'out.png',
      '--frames',
      '4',
      '--cell-size',
      '256',
      '--pad',
      '4',
      '--fill-ratio',
      '0.9',
      '--anchor',
      'core',
      '--bg',
      'border',
      '--bg-tolerance',
      '25',
      '--clear-enclosed-min-area',
      '40',
      '--seed-bg',
      '10,20',
      '--seed-bg',
      '30,40',
      '--preview',
      'prev.png',
    ]);
    expect(parsed.help).toBe(false);
    expect(parsed.inputPath).toBe('in.jpg');
    expect(parsed.outputPath).toBe('out.png');
    expect(parsed.previewPath).toBe('prev.png');
    expect(parsed.options.anchorMode).toBe('core');
    expect(parsed.options.bgMode).toBe('border');
    expect(parsed.options.seedPoints).toEqual([
      { x: 10, y: 20 },
      { x: 30, y: 40 },
    ]);

    expect(parseCliArgs(['--help']).help).toBe(true);
    const explicitScale = parseCliArgs(['--in', 'a.jpg', '--out', 'b.png', '--scale', '0.5', '--outline-matte', 'dark-ink', '--fringe-passes', '1']);
    expect(explicitScale.options.scale).toBe(0.5);
    expect(explicitScale.options.outlineMatteMode).toBe('dark-ink');
    expect(explicitScale.options.fringeStripPasses).toBe(1);

    expect(() => parseCliArgs(['--in', 'a.jpg'])).toThrow(/Both --in <path> and --out <path>/);
    expect(() => parseCliArgs(['--in', 'a.jpg', '--out', 'b.png', '--unknown'])).toThrow(
      /Unknown CLI argument/,
    );
    expect(() => parseCliArgs(['--in', 'a.jpg', '--out', 'b.png', '--cell-size', '0'])).toThrow(
      /--cell-size must be > 0/,
    );
    expect(() => parseCliArgs(['--in', 'a.jpg', '--out', 'b.png', '--frames', '-1'])).toThrow(
      /--frames must be >= 0/,
    );
    expect(() => parseCliArgs(['--in', 'a.jpg', '--out', 'b.png', '--pad', '128', '--cell-size', '256'])).toThrow(
      /--pad \(128\) must be less than half/,
    );
  });
});
