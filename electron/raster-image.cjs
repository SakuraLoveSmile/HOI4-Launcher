"use strict";

const { inflateSync } = require("node:zlib");
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_PIXELS = 16 * 1024 * 1024;
const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++)
    value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  return value >>> 0;
});
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 255];
  return (crc ^ 0xffffffff) >>> 0;
}
function size(width, height) {
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > 8192 ||
    height > 8192 ||
    width * height > MAX_PIXELS
  )
    throw new Error("dimensions");
  return { width, height };
}
function png(buffer, trimTrailing = false) {
  let offset = 8,
    header,
    ended = false,
    imageStarted = false,
    imageEnded = false,
    palette = false;
  const compressed = [];
  while (offset < buffer.length) {
    if (offset + 12 > buffer.length) throw new Error("chunk");
    const length = buffer.readUInt32BE(offset),
      type = buffer.toString("ascii", offset + 4, offset + 8),
      end = offset + 12 + length;
    if (
      end > buffer.length ||
      !/^[A-Za-z]{4}$/.test(type) ||
      crc32(buffer.subarray(offset + 4, end - 4)) !==
        buffer.readUInt32BE(end - 4)
    )
      throw new Error("chunk");
    const data = buffer.subarray(offset + 8, end - 4);
    if (!header && type !== "IHDR") throw new Error("header");
    if (type === "IHDR") {
      if (header || length !== 13) throw new Error("header");
      const dimensions = size(data.readUInt32BE(0), data.readUInt32BE(4)),
        depth = data[8],
        color = data[9];
      if (
        !{
          0: [1, 2, 4, 8, 16],
          2: [8, 16],
          3: [1, 2, 4, 8],
          4: [8, 16],
          6: [8, 16],
        }[color]?.includes(depth) ||
        data[10] ||
        data[11] ||
        data[12] > 1
      )
        throw new Error("header");
      header = { ...dimensions, depth, color, interlace: data[12] };
    } else if (type === "PLTE") {
      if (
        palette ||
        imageStarted ||
        !length ||
        length > 768 ||
        length % 3 ||
        [0, 4].includes(header.color) ||
        (header.color === 3 && length / 3 > 1 << header.depth)
      )
        throw new Error("palette");
      palette = true;
    } else if (type === "IDAT") {
      if (imageEnded || (header.color === 3 && !palette))
        throw new Error("image");
      imageStarted = true;
      compressed.push(data);
    } else if (type === "IEND") {
      if (length || !imageStarted || (!trimTrailing && end !== buffer.length))
        throw new Error("end");
      ended = true;
    } else {
      if (["acTL", "fcTL", "fdAT"].includes(type) || /^[A-Z]/.test(type))
        throw new Error("unsupported chunk");
      if (imageStarted) imageEnded = true;
    }
    offset = end;
    if (ended) break;
  }
  if (!ended) throw new Error("end");
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[header.color];
  const passes = header.interlace
    ? [
        [0, 0, 8, 8],
        [4, 0, 8, 8],
        [0, 4, 4, 8],
        [2, 0, 4, 4],
        [0, 2, 2, 4],
        [1, 0, 2, 2],
        [0, 1, 1, 2],
      ]
    : [[0, 0, 1, 1]];
  const rows = [],
    lengths = [];
  let expected = 0;
  for (const [x, y, dx, dy] of passes) {
    const width = Math.max(0, Math.ceil((header.width - x) / dx)),
      height = Math.max(0, Math.ceil((header.height - y) / dy));
    if (!width || !height) continue;
    const length = Math.ceil((width * channels * header.depth) / 8) + 1;
    rows.push(height);
    lengths.push(length);
    expected += height * length;
  }
  // Bound decoded allocation as well as the compressed file.
  if (expected > 128 * 1024 * 1024 + 65536) throw new Error("decoded size");
  const input = Buffer.concat(compressed);
  const inflated = inflateSync(input, {
    maxOutputLength: expected + 1,
    info: true,
  });
  const decoded = inflated.buffer;
  if (inflated.engine.bytesWritten !== input.length)
    throw new Error("trailing compressed data");
  if (decoded.length !== expected) throw new Error("decoded size");
  let position = 0;
  rows.forEach((count, index) => {
    for (let row = 0; row < count; row++, position += lengths[index])
      if (decoded[position] > 4) throw new Error("filter");
  });
  const dimensions = size(header.width, header.height);
  return trimTrailing ? { ...dimensions, byteLength: offset } : dimensions;
}

function jpeg(buffer, trimTrailing = false) {
  let offset = 2,
    dimensions,
    components,
    scans = 0,
    entropy = false,
    quantization = false,
    huffman = false;
  while (offset < buffer.length) {
    if (buffer[offset++] !== 255) throw new Error("marker");
    while (buffer[offset] === 255) offset++;
    const marker = buffer[offset++];
    if (marker === 0xd9) {
      if (
        (!trimTrailing && offset !== buffer.length) ||
        !dimensions ||
        !scans ||
        !entropy ||
        !quantization ||
        !huffman
      )
        throw new Error("end");
      return trimTrailing ? { ...dimensions, byteLength: offset } : dimensions;
    }
    if (
      marker === undefined ||
      marker === 0 ||
      marker === 0xd8 ||
      (marker >= 0xd0 && marker <= 0xd7) ||
      offset + 2 > buffer.length
    )
      throw new Error("marker");
    const length = buffer.readUInt16BE(offset),
      end = offset + length;
    if (length < 2 || end > buffer.length) throw new Error("segment");
    const data = buffer.subarray(offset + 2, end);
    if ([0xc0, 0xc1, 0xc2].includes(marker)) {
      if (
        dimensions ||
        data.length < 6 ||
        data[0] !== 8 ||
        ![1, 3, 4].includes(data[5]) ||
        data.length !== 6 + data[5] * 3
      )
        throw new Error("frame");
      dimensions = size(data.readUInt16BE(3), data.readUInt16BE(1));
      components = new Set();
      for (let i = 6; i < data.length; i += 3) {
        if (
          components.has(data[i]) ||
          !(data[i + 1] >> 4) ||
          data[i + 1] >> 4 > 4 ||
          !(data[i + 1] & 15) ||
          (data[i + 1] & 15) > 4 ||
          data[i + 2] > 3
        )
          throw new Error("frame");
        components.add(data[i]);
      }
    } else if (
      marker >= 0xc0 &&
      marker <= 0xcf &&
      ![0xc4, 0xc8, 0xcc].includes(marker)
    )
      throw new Error("unsupported frame");
    else if (marker === 0xdb) {
      let at = 0;
      while (at < data.length) {
        const table = data[at++];
        if (table >> 4 > 1 || (table & 15) > 3) throw new Error("table");
        at += (table >> 4 ? 2 : 1) * 64;
      }
      if (at !== data.length || !at) throw new Error("table");
      quantization = true;
    } else if (marker === 0xc4) {
      let at = 0;
      while (at < data.length) {
        const table = data[at++];
        if (table >> 4 > 1 || (table & 15) > 3 || at + 16 > data.length)
          throw new Error("table");
        let count = 0,
          available = 1;
        for (let i = 0; i < 16; i++) {
          const codes = data[at++];
          count += codes;
          available = available * 2 - codes;
          if (available < 0) throw new Error("table");
        }
        if (!count || count > 256) throw new Error("table");
        at += count;
      }
      if (at !== data.length) throw new Error("table");
      huffman = true;
    } else if (marker === 0xda) {
      if (
        !dimensions ||
        data.length < 6 ||
        !data[0] ||
        data[0] > components.size ||
        data.length !== 4 + 2 * data[0]
      )
        throw new Error("scan");
      for (let i = 1; i <= data[0] * 2; i += 2)
        if (
          !components.has(data[i]) ||
          data[i + 1] >> 4 > 3 ||
          (data[i + 1] & 15) > 3
        )
          throw new Error("scan");
      scans++;
      offset = end;
      while (offset < buffer.length) {
        if (buffer[offset] !== 255) {
          entropy = true;
          offset++;
          continue;
        }
        if (
          buffer[offset + 1] === 0 ||
          (buffer[offset + 1] >= 0xd0 && buffer[offset + 1] <= 0xd7)
        ) {
          entropy = true;
          offset += 2;
          continue;
        }
        break;
      }
      continue;
    }
    offset = end;
  }
  throw new Error("end");
}

function gif(buffer) {
  if (buffer.length < 14) throw new Error("header");
  const dimensions = size(buffer.readUInt16LE(6), buffer.readUInt16LE(8));
  let offset = 13,
    colors = buffer[10] & 128 ? 1 << ((buffer[10] & 7) + 1) : 0,
    frames = 0,
    pixels = 0;
  offset += colors * 3;
  function blocks() {
    const parts = [];
    while (offset < buffer.length) {
      const length = buffer[offset++];
      if (!length) return Buffer.concat(parts);
      if (offset + length > buffer.length) break;
      parts.push(buffer.subarray(offset, (offset += length)));
    }
    throw new Error("blocks");
  }
  while (offset < buffer.length) {
    const marker = buffer[offset++];
    if (marker === 0x3b) {
      if (!frames || offset !== buffer.length) throw new Error("end");
      return dimensions;
    }
    if (marker === 0x21) {
      if (offset >= buffer.length) throw new Error("extension");
      offset++;
      blocks();
      continue;
    }
    if (marker !== 0x2c || offset + 9 > buffer.length) throw new Error("image");
    const x = buffer.readUInt16LE(offset),
      y = buffer.readUInt16LE(offset + 2),
      width = buffer.readUInt16LE(offset + 4),
      height = buffer.readUInt16LE(offset + 6),
      flags = buffer[offset + 8];
    size(width, height);
    pixels += width * height;
    if (
      x + width > dimensions.width ||
      y + height > dimensions.height ||
      ++frames > 256 ||
      pixels > MAX_PIXELS
    )
      throw new Error("image size");
    offset += 9;
    const localColors = flags & 128 ? 1 << ((flags & 7) + 1) : colors;
    if (flags & 128) offset += localColors * 3;
    if (!localColors || offset >= buffer.length) throw new Error("palette");
    const bits = buffer[offset++];
    if (bits < 2 || bits > 8) throw new Error("lzw");
    const compressed = blocks(),
      clear = 1 << bits,
      end = clear + 1,
      lengths = new Uint32Array(4096);
    let codeBits = bits + 1,
      next = end + 1,
      previous = 0,
      bit = 0,
      decoded = 0,
      instructions = 0,
      cleared = false,
      terminated = false;
    while (bit + codeBits <= compressed.length * 8) {
      if (++instructions > Math.max(4096, width * height * 2 + 2))
        throw new Error("lzw work limit");
      let code = 0;
      for (let shift = 0; shift < codeBits; shift++, bit++)
        code |= ((compressed[bit >> 3] >> (bit & 7)) & 1) << shift;
      if (code === clear) {
        // Resetting next makes old dictionary slots unreachable; new entries
        // overwrite them before use, so clearing all 4096 slots is unnecessary.
        codeBits = bits + 1;
        next = end + 1;
        previous = 0;
        cleared = true;
        continue;
      }
      if (!cleared) throw new Error("lzw clear");
      if (code === end) {
        terminated = true;
        break;
      }
      let length;
      if (code < clear) {
        if (code >= localColors) throw new Error("palette");
        length = 1;
      } else if (code < next && lengths[code]) length = lengths[code];
      else if (code === next && previous) length = previous + 1;
      else throw new Error("lzw code");
      decoded += length;
      if (decoded > width * height) throw new Error("lzw size");
      if (previous && next < 4096) {
        lengths[next++] = previous + 1;
        if (next === 1 << codeBits && codeBits < 12) codeBits++;
      }
      previous = length;
    }
    if (!terminated || decoded !== width * height) throw new Error("lzw end");
  }
  throw new Error("end");
}

function webp(buffer) {
  if (buffer.length < 26 || buffer.readUInt32LE(4) !== buffer.length - 8)
    throw new Error("riff");
  let offset = 12,
    canvas,
    image;
  while (offset < buffer.length) {
    if (offset + 8 > buffer.length) throw new Error("chunk");
    const type = buffer.toString("ascii", offset, offset + 4),
      length = buffer.readUInt32LE(offset + 4),
      end = offset + 8 + length;
    if (end > buffer.length || end + (length & 1) > buffer.length)
      throw new Error("chunk");
    const data = buffer.subarray(offset + 8, end);
    if (type === "VP8X") {
      if (
        offset !== 12 ||
        length !== 10 ||
        data[0] & 0xc3 ||
        data[1] ||
        data[2] ||
        data[3]
      )
        throw new Error("extended");
      canvas = size(data.readUIntLE(4, 3) + 1, data.readUIntLE(7, 3) + 1);
    } else if (type === "VP8 ") {
      if (
        image ||
        length <= 10 ||
        data[0] & 1 ||
        (data[0] & 0x10) !== 0x10 ||
        !data.subarray(3, 6).equals(Buffer.from([0x9d, 0x01, 0x2a]))
      )
        throw new Error("vp8");
      if (data.readUIntLE(0, 3) >>> 5 > length - 10)
        throw new Error("vp8 partition");
      image = size(
        data.readUInt16LE(6) & 0x3fff,
        data.readUInt16LE(8) & 0x3fff,
      );
    } else if (type === "VP8L") {
      if (image || length <= 5 || data[0] !== 0x2f) throw new Error("vp8l");
      const bits = data.readUInt32LE(1);
      if (bits >>> 29) throw new Error("version");
      image = size((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
    } else if (type === "C2PA") {
      // C2PA provenance is an optional RIFF metadata chunk, including in simple
      // WebP files without VP8X. Its payload is never interpreted here.
    } else if (!["ALPH", "ICCP", "EXIF", "XMP "].includes(type) || !canvas)
      throw new Error("unsupported chunk");
    offset = end + (length & 1);
  }
  if (
    !image ||
    (canvas && (canvas.width !== image.width || canvas.height !== image.height))
  )
    throw new Error("image");
  return image;
}

function bmp(buffer) {
  if (
    buffer.length < 26 ||
    buffer.readUInt32LE(2) !== buffer.length ||
    buffer.readUInt32LE(6)
  )
    throw new Error("header");
  const start = buffer.readUInt32LE(10),
    header = buffer.readUInt32LE(14);
  if (
    ![12, 40, 52, 56, 108, 124].includes(header) ||
    buffer.length < 14 + header ||
    start < 14 + header
  )
    throw new Error("dib");
  const core = header === 12,
    width = core ? buffer.readUInt16LE(18) : buffer.readInt32LE(18),
    height = core ? buffer.readUInt16LE(20) : Math.abs(buffer.readInt32LE(22));
  const dimensions = size(width, height),
    planes = buffer.readUInt16LE(core ? 22 : 26),
    depth = buffer.readUInt16LE(core ? 24 : 28);
  if (
    planes !== 1 ||
    ![1, 4, 8, 16, 24, 32].includes(depth) ||
    (!core && buffer.readUInt32LE(30))
  )
    throw new Error("format");
  const bytes = Math.ceil((width * depth) / 32) * 4 * height;
  const colors =
    depth <= 8 ? (!core && buffer.readUInt32LE(46)) || 1 << depth : 0;
  if (
    colors > 1 << depth ||
    start < 14 + header + colors * (core ? 3 : 4) ||
    start + bytes !== buffer.length ||
    (!core && buffer.readUInt32LE(34) && buffer.readUInt32LE(34) !== bytes)
  )
    throw new Error("pixels");
  return dimensions;
}

function validatedRaster(buffer) {
  if (
    !Buffer.isBuffer(buffer) ||
    !buffer.length ||
    buffer.length > MAX_IMAGE_BYTES
  )
    return null;
  try {
    if (
      buffer
        .subarray(0, 8)
        .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    )
      return { mime: "image/png", ...png(buffer) };
    if (buffer[0] === 255 && buffer[1] === 216)
      return { mime: "image/jpeg", ...jpeg(buffer) };
    if (["GIF87a", "GIF89a"].includes(buffer.toString("ascii", 0, 6)))
      return { mime: "image/gif", ...gif(buffer) };
    if (
      buffer.toString("ascii", 0, 4) === "RIFF" &&
      buffer.toString("ascii", 8, 12) === "WEBP"
    )
      return { mime: "image/webp", ...webp(buffer) };
    if (buffer.toString("ascii", 0, 2) === "BM")
      return { mime: "image/bmp", ...bmp(buffer) };
  } catch {
    /* Invalid images are optional artwork, never launcher errors. */
  }
  return null;
}

// Cover display can discard bytes after a complete PNG/JPEG stream, as common
// editors append private metadata. Validate the retained stream first, and never
// forward the discarded tail. Other consumers keep validatedRaster's strict API.
function validatedCoverRaster(buffer) {
  if (
    !Buffer.isBuffer(buffer) ||
    !buffer.length ||
    buffer.length > MAX_IMAGE_BYTES
  )
    return null;
  try {
    let parsed, mime;
    if (buffer.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) {
      parsed = png(buffer, true);
      mime = "image/png";
    } else if (buffer[0] === 255 && buffer[1] === 216) {
      parsed = jpeg(buffer, true);
      mime = "image/jpeg";
    }
    if (parsed) {
      const { byteLength, ...dimensions } = parsed;
      return {
        image: { mime, ...dimensions },
        bytes: buffer.subarray(0, byteLength),
      };
    }
    const image = validatedRaster(buffer);
    return image ? { image, bytes: buffer } : null;
  } catch {
    return null;
  }
}

module.exports = {
  validatedRaster,
  validatedCoverRaster,
  MAX_IMAGE_BYTES,
  crc32,
};
