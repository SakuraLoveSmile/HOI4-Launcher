import { mkdir, writeFile } from "node:fs/promises";
import { deflateSync } from "node:zlib";

// Reproduce the three bars in the UI's code-native brand mark as a Windows icon.
const size = 256;
const pixels = Buffer.alloc((size * 4 + 1) * size);
const inside = (x, y, points) => {
  let found = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [xi, yi] = points[i],
      [xj, yj] = points[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi)
      found = !found;
  }
  return found;
};
const bars = [
  [
    [85, 77],
    [110, 77],
    [79, 185],
    [54, 185],
  ],
  [
    [130, 53],
    [156, 53],
    [112, 205],
    [86, 205],
  ],
  [
    [170, 99],
    [195, 99],
    [166, 201],
    [140, 201],
  ],
];
for (let y = 0; y < size; y++) {
  for (let x = 0; x < size; x++) {
    const insetX = Math.max(25 - x, 0, x - 230),
      insetY = Math.max(25 - y, 0, y - 230);
    const visible = insetX * insetX + insetY * insetY <= 25 * 25;
    const gold = bars.some((bar) => inside(x + 0.5, y + 0.5, bar));
    const rgb = gold ? [209, 189, 128] : [24, 32, 24];
    const offset = y * (size * 4 + 1) + 1 + x * 4;
    pixels.set([...rgb, visible ? 255 : 0], offset);
  }
}
function crc32(buffer) {
  let crc = -1;
  for (const byte of buffer) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ -1) >>> 0;
}
function chunk(name, data) {
  const type = Buffer.from(name),
    length = Buffer.alloc(4),
    crc = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  crc.writeUInt32BE(crc32(Buffer.concat([type, data])));
  return Buffer.concat([length, type, data, crc]);
}
const header = Buffer.alloc(13);
header.writeUInt32BE(size, 0);
header.writeUInt32BE(size, 4);
header[8] = 8;
header[9] = 6;
const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk("IHDR", header),
  chunk("IDAT", deflateSync(pixels)),
  chunk("IEND", Buffer.alloc(0)),
]);
const icoHeader = Buffer.alloc(22);
icoHeader.writeUInt16LE(1, 2);
icoHeader.writeUInt16LE(1, 4);
icoHeader.writeUInt16LE(1, 10);
icoHeader.writeUInt16LE(32, 12);
icoHeader.writeUInt32LE(png.length, 14);
icoHeader.writeUInt32LE(22, 18);
await mkdir("assets", { recursive: true });
await writeFile("assets/icon.png", png);
await writeFile("assets/icon.ico", Buffer.concat([icoHeader, png]));
console.log("Brand icon generated.");
