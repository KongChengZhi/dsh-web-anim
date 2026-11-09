/**
 * image.js — pixel work on decoded frames: box downscale, deterministic diff,
 * and contact-sheet composition.
 *
 * Everything here is pure (buffer in, buffer out) so it can be unit-tested
 * without a browser. That matters: the sheet layout and the diff thresholds are
 * where "the picture looked wrong" bugs live, and they must be reproducible.
 */

import { encodePng } from './png.js';
import { drawText, textWidth, GLYPH_HEIGHT } from './font.js';

/** Sheet background. Dark enough that white-ish pages still read as cells. */
const SHEET_BG = [17, 17, 17];
/** Label colour. Yellow survives both dark and light frames. */
const LABEL = [255, 214, 0];
/** Border around each cell. */
const CELL_BORDER = [90, 90, 90];

/**
 * Area-average downscale. Never point-samples: a point sample of a moving
 * element produces aliasing that the diff would then report as "movement".
 *
 * @param {Buffer} src RGBA8
 * @param {number} sw
 * @param {number} sh
 * @param {number} dw
 * @param {number} dh
 * @returns {Buffer} RGBA8
 */
export function boxDownscale(src, sw, sh, dw, dh) {
  const dst = Buffer.alloc(dw * dh * 4);
  const fx = sw / dw;
  const fy = sh / dh;

  for (let y = 0; y < dh; y += 1) {
    const y0 = Math.floor(y * fy);
    const y1 = Math.max(y0 + 1, Math.min(sh, Math.floor((y + 1) * fy)));
    for (let x = 0; x < dw; x += 1) {
      const x0 = Math.floor(x * fx);
      const x1 = Math.max(x0 + 1, Math.min(sw, Math.floor((x + 1) * fx)));
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let n = 0;
      for (let sy = y0; sy < y1; sy += 1) {
        let offset = (sy * sw + x0) * 4;
        for (let sx = x0; sx < x1; sx += 1) {
          r += src[offset];
          g += src[offset + 1];
          b += src[offset + 2];
          a += src[offset + 3];
          offset += 4;
          n += 1;
        }
      }
      const out = (y * dw + x) * 4;
      dst[out] = Math.round(r / n);
      dst[out + 1] = Math.round(g / n);
      dst[out + 2] = Math.round(b / n);
      dst[out + 3] = Math.round(a / n);
    }
  }
  return dst;
}

/**
 * Pixel statistics between two equally sized RGBA frames.
 *
 * `meanDelta` is the average absolute per-channel difference (0..255). It is
 * the number the "did anything move?" gate reads. `changedRatio` counts pixels
 * whose delta crosses `threshold` — that is the number that says "how much of
 * the screen moved", which is what separates a 2px jitter from a full cut.
 *
 * @param {Buffer} a
 * @param {Buffer} b
 * @param {{threshold?:number}} [options]
 */
export function frameDiff(a, b, options = {}) {
  const threshold = options.threshold ?? 4;
  const pixels = Math.min(a.length, b.length) / 4;
  let sum = 0;
  let changed = 0;
  let maxDelta = 0;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -1;
  let maxY = -1;
  let width = options.width ?? 0;

  for (let i = 0; i < pixels; i += 1) {
    const o = i * 4;
    const d = (Math.abs(a[o] - b[o]) + Math.abs(a[o + 1] - b[o + 1]) + Math.abs(a[o + 2] - b[o + 2])) / 3;
    sum += d;
    if (d > maxDelta) maxDelta = d;
    if (d > threshold) {
      changed += 1;
      if (width > 0) {
        const x = i % width;
        const y = (i - x) / width;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  return {
    pixels,
    meanDelta: pixels > 0 ? sum / pixels : 0,
    changedRatio: pixels > 0 ? changed / pixels : 0,
    changedPixels: changed,
    maxDelta,
    bbox: maxX < 0 ? null : { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 },
  };
}

/** Default pixel budget for one sheet (~360k px, roughly 233 image tokens). */
/**
 * How uniform is this frame?
 *
 * ## Why a debugging tool needs this
 *
 * A page that fails to render still produces a perfectly good screenshot: a
 * three.js demo whose WebGL context was refused captures as a uniform grey
 * rectangle. Nothing throws, no cell is missing, and the result reads as a
 * confident capture — which is the worst failure mode this package can have,
 * because the model will believe it.
 *
 * Measured on a real third-party page during the pre-release audit: 4 canvases
 * detected, all 4 cells identical, sheet 7KB for a 672x630 image. Every number
 * was consistent with "nothing moved", and the real cause was "nothing painted".
 *
 * ## The discriminator is the COLOUR COUNT, not the dominant-colour share
 *
 * Measured across every fixture (4-bit quantisation per channel), because the
 * obvious criterion turned out to be the wrong one:
 *
 *   fixture          distinct colours   dominant share
 *   blank.html        1                 1.000     <- genuinely nothing painted
 *   timeline.html     9-11              0.95-0.97
 *   animation.html    18-32             0.95
 *   canvas.html       28-30             0.969
 *   static.html       146               0.984     <- sparse REAL page
 *
 * "One colour covers >=96% of the frame" flags static.html — a page with a
 * heading and nothing else — while canvas.html at 0.969 sits right on the line.
 * The dominant *share* does not separate the cases; the number of distinct
 * colours does, with a wide margin (1 versus 9 at the closest).
 *
 * A real page, however sparse, has antialiased type, a border, a shadow, a
 * gradient edge. A page that painted nothing has exactly one colour.
 *
 * @param {Buffer} data RGBA
 * @returns {{colors:number, dominantRatio:number, uniform:boolean}}
 */
export function frameUniformity(data) {
  if (!data || data.length < 4) return { colors: 0, dominantRatio: 1, uniform: true };
  // Quantise to 4 bits per channel: a screenshot's compression noise would
  // otherwise split one flat colour into hundreds of "distinct" ones.
  const counts = new Map();
  let pixels = 0;
  for (let o = 0; o + 3 < data.length; o += 4) {
    const key = ((data[o] >> 4) << 8) | ((data[o + 1] >> 4) << 4) | (data[o + 2] >> 4);
    counts.set(key, (counts.get(key) || 0) + 1);
    pixels += 1;
  }
  let dominant = 0;
  for (const count of counts.values()) if (count > dominant) dominant = count;
  const dominantRatio = pixels > 0 ? dominant / pixels : 1;
  return {
    colors: counts.size,
    dominantRatio,
    // 4 sits between the measured extremes (1 for a blank frame, 9 for the
    // sparsest real page) with room on both sides.
    uniform: counts.size <= 4 && dominantRatio >= 0.96,
  };
}

export const DEFAULT_SHEET_BUDGET_PX = 360_000;

/**
 * Compose frames into one contact sheet with burned-in cell numbers and times.
 *
 * ## The cost model this implements
 *
 * Image price is billed by AREA, not by frame count. So the right invariant is:
 * **a sheet costs roughly the same however many cells it holds** — more cells buy
 * a denser timeline at the price of detail per cell, not a bigger bill. That is
 * the opposite of the "one screenshot per frame" habit this package replaces,
 * where cost grows linearly with the number of moments you look at.
 *
 * Concretely: the pixel budget is fixed (`budgetPx`, ~360k ≈ 233 tokens), the
 * cell count is what the caller asked for, so the cell size is solved from those
 * two and the frames' aspect ratio. A readability floor (minCellWidth) caps how
 * many cells are useful in one sheet; beyond it the caller should capture two
 * windows rather than squeeze 30 cells into one picture.
 *
 * Aspect is preserved per cell: a squashed frame turns a circle into an ellipse
 * and the model can no longer judge easing.
 *
 * @param {Array<{data:Buffer,width:number,height:number,t:number,label?:string}>} frames
 * @param {{maxSide?:number, budgetPx?:number, labelHeight?:number, padding?:number, columns?:number, minCellWidth?:number}} [options]
 * @returns {{png:Buffer, width:number, height:number, cells:Array, tokens:number}}
 */
export function composeSheet(frames, options = {}) {
  if (!Array.isArray(frames) || frames.length === 0) throw new Error('composeSheet: no frames');
  const maxSide = options.maxSide ?? 1300;
  const budgetPx = options.budgetPx ?? DEFAULT_SHEET_BUDGET_PX;
  const labelHeight = options.labelHeight ?? 18;
  const padding = options.padding ?? 6;
  const minCellWidth = options.minCellWidth ?? 200;

  const srcAspect = frames[0].height / frames[0].width;
  const layout = solveLayout({
    count: frames.length,
    srcAspect,
    maxSide,
    budgetPx,
    labelHeight,
    padding,
    minCellWidth,
    columns: options.columns,
  });

  const { columns, cellWidth, cellHeight, width, height } = layout;
  const sheet = Buffer.alloc(width * height * 4);
  for (let i = 0; i < sheet.length; i += 4) {
    sheet[i] = SHEET_BG[0];
    sheet[i + 1] = SHEET_BG[1];
    sheet[i + 2] = SHEET_BG[2];
    sheet[i + 3] = 255;
  }

  const cells = [];
  for (let i = 0; i < frames.length; i += 1) {
    const frame = frames[i];
    const row = Math.floor(i / columns);
    const col = i % columns;
    // The last row usually holds fewer cells. It stays at the same cell size and
    // is centred: stretching it to fill the width would change the cell aspect
    // ratio, and a squashed frame is worse than an empty band — the model judges
    // easing and layout from the shape, which must not lie.
    const inThisRow = Math.min(columns, frames.length - row * columns);
    const rowWidth = inThisRow * cellWidth + (inThisRow - 1) * padding;
    const rowOffset = Math.max(0, Math.round((width - padding * 2 - rowWidth) / 2));
    const cellWidthThisRow = cellWidth;
    const px = padding + rowOffset + col * (cellWidthThisRow + padding);
    const py = padding + row * (cellHeight + labelHeight + padding);

    const small = boxDownscale(frame.data, frame.width, frame.height, cellWidthThisRow, cellHeight);
    blit(sheet, width, height, small, cellWidthThisRow, cellHeight, px, py + labelHeight);
    strokeRect(sheet, width, height, px, py + labelHeight, cellWidthThisRow, cellHeight);

    const scale = labelHeight >= 21 && cellWidth >= 200 ? 3 : 2;
    const text = frame.label ?? `#${i + 1} t=${Math.round(frame.t)}ms`;
    drawText(sheet, width, height, px + 2, py + Math.max(1, Math.floor((labelHeight - GLYPH_HEIGHT * scale) / 2)), text, {
      scale,
      color: LABEL,
    });

    cells.push({
      index: i + 1,
      t: frame.t,
      x: px,
      y: py + labelHeight,
      width: cellWidthThisRow,
      height: cellHeight,
      label: text,
    });
  }

  return { png: encodePng(width, height, sheet), width, height, cells, tokens: imageTokens(width, height) };
}

/**
 * Solve the grid: pixel budget + cell count -> cell size + column count.
 *
 * Cell size comes from the budget; the column count then comes from "how many of
 * those cells fit across without leaving a nearly empty last row". Both are pure
 * arithmetic, which is what makes the cost of a capture predictable before it
 * runs.
 *
 * @param {{count:number, srcAspect:number, maxSide:number, budgetPx:number, labelHeight:number, padding:number, minCellWidth:number, columns?:number}} input
 */
export function solveLayout(input) {
  const { count, srcAspect, maxSide, budgetPx, labelHeight, padding, minCellWidth, columns: forced } = input;

  // Cell area that spends the budget evenly across cells: n * w * (w*aspect) = budget.
  const idealWidth = Math.sqrt(budgetPx / Math.max(1, count * srcAspect));
  const widestAllowed = Math.floor((maxSide - padding * 2) / 1);
  let cellWidth = Math.max(minCellWidth, Math.min(idealWidth, widestAllowed));
  cellWidth = Math.round(cellWidth);

  const columns = forced ?? chooseColumns(count, cellWidth, srcAspect, maxSide, padding, labelHeight);
  let rows = Math.ceil(count / columns);

  // Shrink only if this grid would overflow maxSide; never below the floor.
  const byWidth = Math.floor((maxSide - padding * (columns + 1)) / columns);
  const byHeight = Math.floor((maxSide - padding * (rows + 1) - rows * labelHeight) / rows);
  const cappedWidth = Math.min(cellWidth, byWidth, Math.round(byHeight / srcAspect));
  if (cappedWidth < cellWidth) cellWidth = Math.max(16, cappedWidth);
  rows = Math.ceil(count / columns);

  const cellHeight = Math.max(9, Math.round(cellWidth * srcAspect));
  return {
    columns,
    rows,
    cellWidth,
    cellHeight,
    width: columns * cellWidth + padding * (columns + 1),
    height: rows * (cellHeight + labelHeight) + padding * (rows + 1),
  };
}

/**
 * Prefer the column count that wastes the fewest slots and keeps the sheet from
 * becoming a ribbon, given cells of this size.
 */
function chooseColumns(count, cellWidth, srcAspect, maxSide, padding, labelHeight) {
  const cellHeight = cellWidth * srcAspect;
  let best = 1;
  let bestScore = Infinity;
  const limit = Math.min(count, 6);
  for (let columns = 1; columns <= limit; columns += 1) {
    const rows = Math.ceil(count / columns);
    const width = columns * cellWidth + padding * (columns + 1);
    const height = rows * (cellHeight + labelHeight) + padding * (rows + 1);
    if (width > maxSide || height > maxSide) continue;
    const empty = columns * rows - count;
    const aspect = width / height;
    // Ribbons are hard to read; square-ish is what a contact sheet wants to be.
    const aspectPenalty = Math.abs(Math.log(aspect)) * 2;
    const score = empty * 1.5 + aspectPenalty;
    if (score < bestScore) {
      bestScore = score;
      best = columns;
    }
  }
  return best;
}


/** Copy an RGBA block into the sheet at (dx, dy), clipping at the edges. */
function blit(dst, dstW, dstH, src, srcW, srcH, dx, dy) {
  for (let y = 0; y < srcH; y += 1) {
    const ty = dy + y;
    if (ty < 0 || ty >= dstH) continue;
    const srcStart = y * srcW * 4;
    const dstStart = (ty * dstW + dx) * 4;
    src.copy(dst, dstStart, srcStart, srcStart + Math.min(srcW, dstW - dx) * 4);
  }
}

/** 1px rectangle outline, clipped. */
function strokeRect(dst, dstW, dstH, x, y, w, h) {
  const put = (px, py) => {
    if (px < 0 || py < 0 || px >= dstW || py >= dstH) return;
    const o = (py * dstW + px) * 4;
    dst[o] = CELL_BORDER[0];
    dst[o + 1] = CELL_BORDER[1];
    dst[o + 2] = CELL_BORDER[2];
  };
  for (let i = 0; i < w; i += 1) {
    put(x + i, y);
    put(x + i, y + h - 1);
  }
  for (let i = 0; i < h; i += 1) {
    put(x, y + i);
    put(x + w - 1, y + i);
  }
}

/**
 * Estimate what one sheet costs in provider image tokens.
 *
 * Mirrors the provider's own arithmetic (14px patch alignment, 3:1 downsample,
 * one separator token per row plus two frame tokens) so the number we report is
 * the number that gets billed, not a "pixels / 1650" approximation.
 *
 * @param {number} width
 * @param {number} height
 * @returns {number} tokens
 */
export function imageTokens(width, height) {
  const PATCH = 14;
  const DOWNSAMPLE = 3;
  const CELL = PATCH * DOWNSAMPLE;
  const CAP = 1024;
  const FLOOR_AREA = 544 * 544;

  const ceilDiv = (v, d) => Math.floor((v + d - 1) / d);
  const gridCells = (padded) => ceilDiv(Math.floor(padded / PATCH), DOWNSAMPLE);
  const gridTokens = (rows, cols) => rows * (cols + 1) + 2;
  const pad = (px) => ceilDiv(px, PATCH) * PATCH;

  const project = (W, H) => {
    const tokens = gridTokens(gridCells(pad(H)), gridCells(pad(W)));
    if (tokens <= CAP) return { W, H, tokens };
    const aspect = H / W;
    const idealW = Math.sqrt((CAP - 2) / aspect + 0.25) - 0.5;
    let solvedW = Math.trunc(idealW);
    let solvedH = Math.trunc(idealW * aspect);
    if (solvedW < 1) {
      solvedW = 1;
      solvedH = Math.floor((CAP - 2) / 2);
    } else if (solvedH < 1) {
      solvedH = 1;
      solvedW = Math.floor((CAP - 2) / solvedH) - 1;
    }
    const scale = Math.min((solvedW * CELL) / W, (solvedH * CELL) / H);
    const bw = Math.trunc((W * scale) / PATCH) * PATCH;
    const bh = Math.trunc((H * scale) / PATCH) * PATCH;
    return { W: bw, H: bh, tokens: gridTokens(gridCells(bh), gridCells(bw)) };
  };

  let W = Math.round(width);
  let H = Math.round(height);
  if (W <= 0 || H <= 0) return 0;
  const area = W * H;
  if (area < FLOOR_AREA) {
    const scale = Math.sqrt(FLOOR_AREA / area);
    W = Math.trunc(W * scale);
    H = Math.trunc(H * scale);
  }
  let current = project(W, H);
  for (let i = 0; i < 10; i += 1) {
    const next = project(current.W, current.H);
    if (next.tokens === current.tokens && next.W === current.W && next.H === current.H) return next.tokens;
    current = next;
  }
  return current.tokens;
}

/** Where a 5x7 label needs to sit for a given cell height. */
export function labelBaseline(cellHeight) {
  return cellHeight >= 21 ? 3 : 2;
}

/** Re-exported so callers do not import the font module directly. */
export { textWidth };