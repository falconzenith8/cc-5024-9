// Minimal, dependency-free PNG codec (8/16-bit, non-interlaced).
//
// Supports colour types 0 (gray), 2 (RGB), 3 (palette), 4 (gray+alpha) and
// 6 (RGBA). Output is always 8-bit RGB or RGBA. Interlaced files are rejected
// with a clear error rather than silently decoded wrongly.
//
// Encoding uses adaptive per-row filters (None/Sub/Up/Average/Paeth) and zlib.

import zlib from 'node:zlib';

const SIGNATURE = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes, start = 0, end = bytes.length) {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  const crc = crc32(out, 4, 8 + data.length);
  view.setUint32(8 + data.length, crc);
  return out;
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function filterRow(filter, row, prev, bpp) {
  const out = new Uint8Array(row.length);
  if (filter === 0) {
    out.set(row);
  } else if (filter === 1) {
    for (let i = 0; i < row.length; i++) out[i] = (row[i] - (i >= bpp ? row[i - bpp] : 0)) & 0xff;
  } else if (filter === 2) {
    for (let i = 0; i < row.length; i++) out[i] = (row[i] - prev[i]) & 0xff;
  } else if (filter === 3) {
    for (let i = 0; i < row.length; i++) {
      const left = i >= bpp ? row[i - bpp] : 0;
      out[i] = (row[i] - ((left + prev[i]) >> 1)) & 0xff;
    }
  } else {
    for (let i = 0; i < row.length; i++) {
      const left = i >= bpp ? row[i - bpp] : 0;
      const upLeft = i >= bpp ? prev[i - bpp] : 0;
      out[i] = (row[i] - paeth(left, prev[i], upLeft)) & 0xff;
    }
  }
  return out;
}

/**
 * Encode 8-bit image data as PNG.
 * @param {{width:number,height:number,channels:3|4,data:Uint8Array|Uint8ClampedArray}} image
 * @returns {Buffer}
 */
export function encodePNG(image) {
  const { width, height, channels, data } = image;
  if (width <= 0 || height <= 0) throw new Error('PNG: width and height must be positive');
  if (channels !== 3 && channels !== 4) throw new Error('PNG: channels must be 3 or 4');
  if (data.length !== width * height * channels) {
    throw new Error(`PNG: data length ${data.length} does not match ${width}x${height}x${channels}`);
  }
  const bpp = channels;
  const stride = width * channels;
  const raw = Buffer.alloc((stride + 1) * height);
  let prev = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const row = Uint8Array.from(data.subarray(y * stride, (y + 1) * stride));
    let best = 0;
    let bestRow = filterRow(0, row, prev, bpp);
    let bestScore = scoreRow(bestRow);
    for (let f = 1; f <= 4; f++) {
      const candidate = filterRow(f, row, prev, bpp);
      const score = scoreRow(candidate);
      if (score < bestScore) {
        best = f;
        bestRow = candidate;
        bestScore = score;
      }
    }
    const off = y * (stride + 1);
    raw[off] = best;
    raw.set(bestRow, off + 1);
    prev = row;
  }

  const ihdr = new Uint8Array(13);
  const iv = new DataView(ihdr.buffer);
  iv.setUint32(0, width);
  iv.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = channels === 3 ? 2 : 6; // colour type
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // non-interlaced

  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    Buffer.from(SIGNATURE),
    Buffer.from(chunk('IHDR', ihdr)),
    Buffer.from(chunk('IDAT', idat)),
    Buffer.from(chunk('IEND', new Uint8Array(0))),
  ]);
}

function scoreRow(row) {
  let score = 0;
  for (let i = 0; i < row.length; i++) score += row[i] < 128 ? row[i] : 256 - row[i];
  return score;
}

/**
 * Decode a PNG buffer to 8-bit RGB/RGBA.
 * @param {Uint8Array} buffer
 * @returns {{width:number,height:number,channels:3|4,data:Uint8Array,bitDepth:number,colorType:number}}
 */
export function decodePNG(buffer) {
  const bytes = Buffer.from(buffer);
  for (let i = 0; i < SIGNATURE.length; i++) {
    if (bytes[i] !== SIGNATURE[i]) throw new Error('PNG: invalid signature');
  }
  let off = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  let palette = null;
  let trns = null;
  const idatParts = [];
  let sawIHDR = false;
  let sawIEND = false;

  while (off + 8 <= bytes.length) {
    const len = bytes.readUInt32BE(off);
    const type = bytes.toString('ascii', off + 4, off + 8);
    const dataStart = off + 8;
    const dataEnd = dataStart + len;
    if (dataEnd + 4 > bytes.length) throw new Error('PNG: truncated chunk');
    const expected = bytes.readUInt32BE(dataEnd);
    const actual = crc32(bytes, off + 4, dataEnd);
    if (expected !== actual) throw new Error(`PNG: CRC mismatch in ${type} chunk`);
    const data = bytes.subarray(dataStart, dataEnd);
    if (type === 'IHDR') {
      if (len !== 13) throw new Error('PNG: bad IHDR length');
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      const compression = data[10];
      const filter = data[11];
      interlace = data[12];
      if (compression !== 0 || filter !== 0) throw new Error('PNG: unsupported compression/filter method');
      if (interlace !== 0) throw new Error('PNG: interlaced images are not supported; re-save as non-interlaced');
      sawIHDR = true;
    } else if (type === 'PLTE') {
      palette = Uint8Array.from(data);
    } else if (type === 'tRNS') {
      trns = Uint8Array.from(data);
    } else if (type === 'IDAT') {
      idatParts.push(Buffer.from(data));
    } else if (type === 'IEND') {
      sawIEND = true;
      break;
    }
    off = dataEnd + 4;
  }
  if (!sawIHDR) throw new Error('PNG: missing IHDR');
  if (!sawIEND) throw new Error('PNG: missing IEND');
  if (idatParts.length === 0) throw new Error('PNG: missing IDAT');

  const allowed = new Set([0, 2, 3, 4, 6]);
  if (!allowed.has(colorType)) throw new Error(`PNG: unsupported colour type ${colorType}`);
  if (bitDepth !== 8 && bitDepth !== 16 && !(colorType === 0 || colorType === 3)) {
    throw new Error(`PNG: unsupported bit depth ${bitDepth}`);
  }

  const channelsPerColor = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  const bitsPerPixel = channelsPerColor * bitDepth;
  const bpp = Math.max(1, Math.ceil(bitsPerPixel / 8));
  const stride = Math.ceil((width * bitsPerPixel) / 8);
  const raw = zlib.inflateSync(Buffer.concat(idatParts));
  const expectedRaw = (stride + 1) * height;
  if (raw.length < expectedRaw) throw new Error('PNG: truncated image data');

  const unfiltered = new Uint8Array(stride * height);
  let prev = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const row = new Uint8Array(stride);
    if (filter === 0) {
      row.set(src);
    } else if (filter === 1) {
      for (let i = 0; i < stride; i++) row[i] = (src[i] + (i >= bpp ? row[i - bpp] : 0)) & 0xff;
    } else if (filter === 2) {
      for (let i = 0; i < stride; i++) row[i] = (src[i] + prev[i]) & 0xff;
    } else if (filter === 3) {
      for (let i = 0; i < stride; i++) {
        const left = i >= bpp ? row[i - bpp] : 0;
        row[i] = (src[i] + ((left + prev[i]) >> 1)) & 0xff;
      }
    } else if (filter === 4) {
      for (let i = 0; i < stride; i++) {
        const left = i >= bpp ? row[i - bpp] : 0;
        const upLeft = i >= bpp ? prev[i - bpp] : 0;
        row[i] = (src[i] + paeth(left, prev[i], upLeft)) & 0xff;
      }
    } else {
      throw new Error(`PNG: invalid filter type ${filter} on row ${y}`);
    }
    unfiltered.set(row, y * stride);
    prev = row;
  }

  const hasAlpha = colorType === 4 || colorType === 6 || (trns && (colorType === 0 || colorType === 2 || colorType === 3));
  const outChannels = hasAlpha ? 4 : 3;
  const out = new Uint8Array(width * height * outChannels);
  const maxVal = (1 << bitDepth) - 1;

  const readSample = (value) => {
    if (bitDepth === 8) return value;
    if (bitDepth === 16) return Math.round(value / 257);
    // 1/2/4-bit: scale to 0..255
    return Math.round((value * 255) / maxVal);
  };

  const sampleAt = (rowBytes, index) => {
    if (bitDepth === 8) return rowBytes[index];
    if (bitDepth === 16) return rowBytes[index * 2] * 256 + rowBytes[index * 2 + 1];
    const bitPos = index * bitDepth;
    const byte = rowBytes[bitPos >> 3];
    const shift = 8 - bitDepth - (bitPos & 7);
    return (byte >> shift) & maxVal;
  };

  for (let y = 0; y < height; y++) {
    const row = unfiltered.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < width; x++) {
      let r;
      let g;
      let b;
      let a = 255;
      if (colorType === 0) {
        const raw0 = sampleAt(row, x);
        const v = readSample(raw0);
        r = v;
        g = v;
        b = v;
        if (trns && raw0 === (trns[0] * 256 + trns[1])) a = 0;
      } else if (colorType === 2) {
        const rr = sampleAt(row, x * 3);
        const gg = sampleAt(row, x * 3 + 1);
        const bb = sampleAt(row, x * 3 + 2);
        r = readSample(rr);
        g = readSample(gg);
        b = readSample(bb);
        if (trns) {
          const tr = trns[0] * 256 + trns[1];
          const tg = trns[2] * 256 + trns[3];
          const tb = trns[4] * 256 + trns[5];
          if (rr === tr && gg === tg && bb === tb) a = 0;
        }
      } else if (colorType === 3) {
        const idx = sampleAt(row, x);
        if (!palette || idx * 3 + 2 >= palette.length) throw new Error('PNG: palette index out of range');
        r = palette[idx * 3];
        g = palette[idx * 3 + 1];
        b = palette[idx * 3 + 2];
        if (trns && idx < trns.length) a = trns[idx];
      } else if (colorType === 4) {
        const v = readSample(sampleAt(row, x * 2));
        r = v;
        g = v;
        b = v;
        a = readSample(sampleAt(row, x * 2 + 1));
      } else {
        r = readSample(sampleAt(row, x * 4));
        g = readSample(sampleAt(row, x * 4 + 1));
        b = readSample(sampleAt(row, x * 4 + 2));
        a = readSample(sampleAt(row, x * 4 + 3));
      }
      const o = (y * width + x) * outChannels;
      out[o] = r;
      out[o + 1] = g;
      out[o + 2] = b;
      if (outChannels === 4) out[o + 3] = a;
    }
  }

  return { width, height, channels: outChannels, data: out, bitDepth, colorType };
}
