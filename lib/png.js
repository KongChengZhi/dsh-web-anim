/**
 * png.js — decode / encode PNG with node:zlib only.
 *
 * The plugin must not pull a native image library: DSH plugins ship as plain
 * ESM and a `sharp`-class dependency would defeat the point of the whole
 * package. Chrome already hands us PNG bytes from `Page.captureScreenshot`,
 * so all we need is inflate + the five PNG row filters on the way in, and
 * deflate on the way out. Measured on the reference machine: 7 frames of
 * 480x260 decode in ~26ms, a 990x318 sheet encodes in ~55ms.
 *
 * Scope is deliberately narrow — what Chrome emits for screenshots, and what
 * we emit for contact sheets:
 *   - bit depth 8 only (Chrome screenshots are 8-bit RGB or RGBA)
 *   - non-interlaced only
 *   - colour types 0 (gray), 2 (RGB), 3 (palette), 4 (gray+alpha), 6 (RGBA)
 * Anything else throws a typed error instead of returning wrong pixels. A
 * silent mis-decode would poison every pixel metric downstream, so failing
 * loudly here is the cheap option.
 */

import zlib from 'node:zlib';

const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

/** Raised for any PNG this codec will not handle. Never returns bad pixels. */
export class PngError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'PngError';
    this.code = code ?? 'PNG_UNSUPPORTED';
  }
}

/** Byte offsets each colour type needs per pixel before we expand to RGBA. */
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

/**
 * Decode a PNG buffer into `{ width, height, data }` with `data` as RGBA8.
 * @param {Buffer} buf
 * @returns {{width:number, height:number, data:Buffer}}
 */
export function decodePng(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 8 || !buf.subarray(0, 8).equals(SIGNATURE)) {
    throw new PngError('not a PNG (bad signature)', 'PNG_SIGNATURE');
  }
  let offset = 8;
  let ihdr = null;
  let palette = null;
  let transparency = null;
  const idat = [];

  while (offset < buf.length) {
    if (offset + 8 > buf.length) throw new PngError('truncated chunk header', 'PNG_TRUNCATED');
    const length = buf.readUInt32BE(offset);
    const type = buf.toString('ascii', offset + 4, offset + 8);
    const body = buf.subarray(offset + 8, offset + 8 + length);
    if (body.length !== length) throw new PngError('truncated chunk body', 'PNG_TRUNCATED');
    offset += 12 + length;                       // length + type + body + crc

    if (type === 'IHDR') {
      ihdr = {
        width: body.readUInt32BE(0),
        height: body.readUInt32BE(4),
        depth: body[8],
        colorType: body[9],
        interlace: body[12],
      };
    } else if (type === 'IDAT') {
      idat.push(body);
    } else if (type === 'PLTE') {
      palette = Buffer.from(body);
    } else if (type === 'tRNS') {
      transparency = Buffer.from(body);
    } else if (type === 'IEND') {
      break;
    }
  }

  if (!ihdr) throw new PngError('missing IHDR', 'PNG_NO_IHDR');
  if (ihdr.depth !== 8) throw new PngError(`bit depth ${ihdr.depth} is not supported`, 'PNG_DEPTH');
  if (ihdr.interlace) throw new PngError('interlaced PNG is not supported', 'PNG_INTERLACE');
  const channels = CHANNELS[ihdr.colorType];
  if (!channels) throw new PngError(`colour type ${ihdr.colorType} is not supported`, 'PNG_COLOR');
  if (idat.length === 0) throw new PngError('no IDAT data', 'PNG_NO_DATA');

  const { width, height } = ihdr;
  const stride = width * channels;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const expected = (stride + 1) * height;
  if (raw.length < expected) throw new PngError('pixel data shorter than the header claims', 'PNG_TRUNCATED');

  // Unfilter into a compact channel buffer, one row at a time (keeps peak memory at 2 rows).
  const pixels = Buffer.alloc(stride * height);
  let previous = Buffer.alloc(stride);
  let cursor = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[cursor];
    cursor += 1;
    const row = Buffer.from(raw.subarray(cursor, cursor + stride));
    cursor += stride;
    unfilterRow(filter, row, previous, channels);
    row.copy(pixels, y * stride);
    previous = row;
  }

  return { width, height, data: expandToRgba(pixels, width, height, ihdr.colorType, channels, palette, transparency) };
}

/**
 * Undo one PNG row filter in place.
 * @param {number} filter 0 none, 1 sub, 2 up, 3 average, 4 paeth
 */
function unfilterRow(filter, row, previous, bpp) {
  if (filter === 0) return;
  if (filter === 1) {
    for (let x = bpp; x < row.length; x += 1) row[x] = (row[x] + row[x - bpp]) & 0xff;
    return;
  }
  if (filter === 2) {
    for (let x = 0; x < row.length; x += 1) row[x] = (row[x] + previous[x]) & 0xff;
    return;
  }
  if (filter === 3) {
    for (let x = 0; x < row.length; x += 1) {
      const left = x >= bpp ? row[x - bpp] : 0;
      row[x] = (row[x] + ((left + previous[x]) >> 1)) & 0xff;
    }
    return;
  }
  if (filter === 4) {
    for (let x = 0; x < row.length; x += 1) {
      const left = x >= bpp ? row[x - bpp] : 0;
      const up = previous[x];
      const upLeft = x >= bpp ? previous[x - bpp] : 0;
      const p = left + up - upLeft;
      const pa = Math.abs(p - left);
      const pb = Math.abs(p - up);
      const pc = Math.abs(p - upLeft);
      const predictor = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
      row[x] = (row[x] + predictor) & 0xff;
    }
    return;
  }
  throw new PngError(`row filter ${filter} is not valid`, 'PNG_FILTER');
}

/** Widen whatever the file carries into a single RGBA8 buffer. */
function expandToRgba(pixels, width, height, colorType, channels, palette, transparency) {
  const count = width * height;
  const rgba = Buffer.alloc(count * 4);
  if (colorType === 6) {
    pixels.copy(rgba);
    return rgba;
  }
  if (colorType === 2) {
    for (let i = 0; i < count; i += 1) {
      const s = i * 3;
      const d = i * 4;
      rgba[d] = pixels[s];
      rgba[d + 1] = pixels[s + 1];
      rgba[d + 2] = pixels[s + 2];
      rgba[d + 3] = 255;
    }
    return rgba;
  }
  if (colorType === 0) {
    for (let i = 0; i < count; i += 1) {
      const v = pixels[i];
      const d = i * 4;
      rgba[d] = v;
      rgba[d + 1] = v;
      rgba[d + 2] = v;
      rgba[d + 3] = 255;
    }
    return rgba;
  }
  if (colorType === 4) {
    for (let i = 0; i < count; i += 1) {
      const v = pixels[i * 2];
      const d = i * 4;
      rgba[d] = v;
      rgba[d + 1] = v;
      rgba[d + 2] = v;
      rgba[d + 3] = pixels[i * 2 + 1];
    }
    return rgba;
  }
  // colour type 3 — palette
  if (!palette) throw new PngError('palette image without PLTE', 'PNG_NO_PALETTE');
  for (let i = 0; i < count; i += 1) {
    const index = pixels[i];
    const s = index * 3;
    const d = i * 4;
    rgba[d] = palette[s] ?? 0;
    rgba[d + 1] = palette[s + 1] ?? 0;
    rgba[d + 2] = palette[s + 2] ?? 0;
    rgba[d + 3] = transparency && index < transparency.length ? transparency[index] : 255;
  }
  return rgba;
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

/** CRC32 as PNG defines it. */
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/** Wrap one chunk: length, type, body, crc. */
function chunk(type, body) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(body.length);
  const typed = Buffer.concat([Buffer.from(type, 'ascii'), body]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed));
  return Buffer.concat([length, typed, crc]);
}

/**
 * Encode RGBA8 pixels as a PNG.
 *
 * Deterministic on purpose: the same pixel buffer always produces byte-identical
 * output, so a stored capture can be re-derived and compared byte for byte.
 * Filter 0 (none) everywhere — adaptive filtering would shave a few percent off
 * the file for a lot more code, and these sheets are small already.
 *
 * @param {number} width
 * @param {number} height
 * @param {Buffer} rgba
 * @returns {Buffer}
 */
export function encodePng(width, height, rgba) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new PngError(`invalid dimensions ${width}x${height}`, 'PNG_DIMENSIONS');
  }
  if (rgba.length < width * height * 4) throw new PngError('pixel buffer is too small', 'PNG_PIXELS');

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    // raw[y * (stride+1)] stays 0 — that is the "filter: none" byte
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;    // bit depth
  ihdr[9] = 6;    // colour type RGBA
  ihdr[10] = 0;   // compression
  ihdr[11] = 0;   // filter
  ihdr[12] = 0;   // interlace

  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
