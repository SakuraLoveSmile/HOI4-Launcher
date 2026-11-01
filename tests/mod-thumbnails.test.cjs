"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { deflateSync, crc32 } = require("node:zlib");
const yazl = require("yazl");
const {
  validatedRaster,
  MAX_IMAGE_BYTES,
} = require("../electron/raster-image.cjs");
const { createModThumbnails } = require("../electron/mod-thumbnails.cjs");
const { createLauncherService } = require("../electron/launcher-service.cjs");

// Genuine 2x3 files encoded once with Pillow; tests require no decoder process.
const images = {
  png: "iVBORw0KGgoAAAANSUhEUgAAAAIAAAADCAIAAAA2iEnWAAAAFElEQVR4nGPUCKhgYGBgYgADKAUAEdQA9lftS1YAAAAASUVORK5CYII=",
  jpeg: "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAADAAIDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDiKKKK9g8s/9k=",
  gif: "R0lGODdhAgADAIEAAChQeAAAAAAAAAAAACwAAAAAAgADAAAIBgABCBwYEAA7",
  webp: "UklGRjQAAABXRUJQVlA4ICgAAACQAQCdASoCAAMAAUAmJZACdLoAA5gA/vSIh/VcnYnxw/ubHOLZDAAA",
  bmp: "Qk1OAAAAAAAAADYAAAAoAAAAAgAAAAMAAAABABgAAAAAABgAAADEDgAAxA4AAAAAAAAAAAAAeFAoeFAoAAB4UCh4UCgAAHhQKHhQKAAA",
};
for (const key of Object.keys(images))
  images[key] = Buffer.from(images[key], "base64");
const lossless = Buffer.from(
  "UklGRh4AAABXRUJQVlA4TBEAAAAvAYAAAAdQqKIUr/+BiOh/AAA=",
  "base64",
);
function pngChunk(type, data) {
  const result = Buffer.alloc(data.length + 12);
  result.writeUInt32BE(data.length);
  result.write(type, 4, "ascii");
  data.copy(result, 8);
  result.writeUInt32BE(crc32(result.subarray(4, -4)), result.length - 4);
  return result;
}
function png(width = 1, height = 1, raw = Buffer.from([0, 1, 2, 3, 255])) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}
async function zipBytes(entries) {
  const zip = new yazl.ZipFile(),
    parts = [];
  for (const entry of entries)
    zip.addBuffer(entry.bytes || images.png, entry.name || "cover.png", {
      compress: true,
      ...entry.options,
    });
  const result = (async () => {
    for await (const chunk of zip.outputStream) parts.push(chunk);
    return Buffer.concat(parts);
  })();
  zip.end();
  return result;
}
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ironclad-thumbnails-"));
  t.after(() =>
    fs.rm(root, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    }),
  );
  const write = async (file, bytes) => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, bytes);
    return file;
  };
  const contentPath = path.join(root, "mod"),
    reader = createModThumbnails();
  const mod = (picture = "cover.png", extra = {}) => ({
    id: "local:fixture.mod",
    available: true,
    contentPath,
    picture,
    ...extra,
  });
  return { root, write, contentPath, reader, mod };
}

test("validatedRaster recognizes real PNG, JPEG, GIF, lossy/lossless WebP and BMP", () => {
  for (const [format, bytes] of Object.entries(images))
    assert.deepEqual(
      validatedRaster(bytes),
      { mime: `image/${format}`, width: 2, height: 3 },
      format,
    );
  assert.deepEqual(validatedRaster(lossless), {
    mime: "image/webp",
    width: 2,
    height: 3,
  });
  assert.deepEqual(validatedRaster(png()), {
    mime: "image/png",
    width: 1,
    height: 1,
  });
});

test("unsupported, empty, oversized, truncated and HTML-appended images are rejected", () => {
  for (const invalid of [
    null,
    "png",
    new Uint8Array(images.png),
    Buffer.alloc(0),
    Buffer.alloc(MAX_IMAGE_BYTES + 1),
    Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'),
    Buffer.from("<html><script>alert(1)</script></html>"),
  ])
    assert.equal(validatedRaster(invalid), null);
  for (const bytes of [...Object.values(images), lossless]) {
    for (let length = 0; length < bytes.length; length++)
      assert.equal(
        validatedRaster(bytes.subarray(0, length)),
        null,
        `truncated ${length}`,
      );
    assert.equal(
      validatedRaster(
        Buffer.concat([bytes, Buffer.from("<html>appended</html>")]),
      ),
      null,
    );
  }
});

test("all formats enforce dimensions, pixel count and required image structure", () => {
  assert.equal(validatedRaster(png(8193, 1)), null);
  assert.equal(validatedRaster(png(4097, 4097)), null);
  assert.equal(validatedRaster(png(0, 1)), null);
  assert.equal(validatedRaster(png(1, 1, Buffer.from([5, 1, 2, 3, 4]))), null);
  assert.equal(validatedRaster(png(1, 1, Buffer.alloc(1000))), null);
  const badCrc = Buffer.from(images.png);
  badCrc[45] ^= 1;
  assert.equal(validatedRaster(badCrc), null);
  const jpeg = Buffer.from(images.jpeg),
    frame = jpeg.indexOf(Buffer.from([255, 192]));
  jpeg.writeUInt16BE(8193, frame + 7);
  assert.equal(validatedRaster(jpeg), null);
  const gif = Buffer.from(images.gif);
  gif.writeUInt16LE(8193, 6);
  assert.equal(validatedRaster(gif), null);
  const badLzw = Buffer.from(images.gif);
  badLzw[badLzw.indexOf(0x2c) + 10] = 9;
  assert.equal(validatedRaster(badLzw), null);
  const webp = Buffer.from(images.webp);
  webp.writeUInt16LE(8193, 26);
  assert.equal(validatedRaster(webp), null);
  const webpVersion = Buffer.from(lossless);
  webpVersion[24] |= 0xe0;
  assert.equal(validatedRaster(webpVersion), null);
  const bmp = Buffer.from(images.bmp);
  bmp.writeInt32LE(8193, 18);
  assert.equal(validatedRaster(bmp), null);
  const compressedBmp = Buffer.from(images.bmp);
  compressedBmp.writeUInt32LE(1, 30);
  assert.equal(validatedRaster(compressedBmp), null);
});

test("GIF clear instructions have a bounded budget independent of output pixels", () => {
  function repeatedClears(count) {
    const codes = [...Array(count).fill(4), 0, 5];
    const compressed = Buffer.alloc(Math.ceil((codes.length * 3) / 8));
    let bit = 0;
    for (const code of codes)
      for (let shift = 0; shift < 3; shift++, bit++)
        compressed[bit >> 3] |= ((code >> shift) & 1) << (bit & 7);
    const blocks = [];
    for (let offset = 0; offset < compressed.length; offset += 255) {
      const bytes = compressed.subarray(offset, offset + 255);
      blocks.push(Buffer.from([bytes.length]), bytes);
    }
    return Buffer.concat([
      Buffer.from(
        "47494638396101000100800000000000ffffff2c00000000010001000002",
        "hex",
      ),
      ...blocks,
      Buffer.from([0, 0x3b]),
    ]);
  }
  assert.deepEqual(validatedRaster(repeatedClears(100)), {
    mime: "image/gif",
    width: 1,
    height: 1,
  });
  assert.equal(validatedRaster(repeatedClears(100000)), null);
});

test("directory artwork returns only validated data URLs for registered IDs", async (t) => {
  const f = await fixture(t),
    mods = [];
  for (const [format, bytes] of Object.entries(images)) {
    await f.write(path.join(f.contentPath, `nested/cover.${format}`), bytes);
    mods.push(f.mod(`nested\\cover.${format}`, { id: `local:${format}.mod` }));
  }
  await f.reader.replace(mods);
  for (const [format, bytes] of Object.entries(images)) {
    const result = await f.reader.get(`local:${format}.mod`);
    assert.deepEqual(result, {
      mime: `image/${format}`,
      width: 2,
      height: 3,
      dataUrl: `data:image/${format};base64,${bytes.toString("base64")}`,
    });
  }
  for (const id of [
    null,
    {},
    "local:missing.mod",
    path.join(f.contentPath, "nested/cover.png"),
    "x".repeat(513),
  ])
    assert.equal(await f.reader.get(id), null);
});

test("picture paths cannot escape, name streams or supply unsupported content", async (t) => {
  const f = await fixture(t);
  await f.write(path.join(f.contentPath, "cover.png"), images.png);
  await f.write(path.join(f.root, "outside.png"), images.png);
  for (const picture of [
    "../outside.png",
    "nested/../../outside.png",
    "/cover.png",
    "C:/cover.png",
    "\\\\server\\share\\cover.png",
    "cover.png:stream",
    "cover.png\0",
    "nested//cover.png",
    "./cover.png",
    "cover.png ",
    "CON.png",
    "cover.svg",
    "https://site.invalid/cover.png",
    "missing.png",
  ]) {
    await f.reader.replace([f.mod(picture)]);
    assert.equal(await f.reader.get(f.mod().id), null, picture);
  }
  for (const [name, bytes] of [
    ["fake.png", Buffer.from("<svg/>")],
    ["broken.png", images.png.subarray(0, 50)],
  ]) {
    await f.write(path.join(f.contentPath, name), bytes);
    await f.reader.replace([f.mod(name)]);
    assert.equal(await f.reader.get(f.mod().id), null);
  }
});

test("cover MIME comes from validated bytes even when its filename has another image extension", async (t) => {
  const f = await fixture(t);
  for (const [format, bytes] of Object.entries(images)) {
    await f.write(path.join(f.contentPath, "thumbnail.png"), bytes);
    await f.reader.replace([f.mod("thumbnail.png")]);
    const result = await f.reader.get(f.mod().id);
    assert.equal(result.mime, `image/${format}`);
    assert.equal(
      result.dataUrl,
      `data:image/${format};base64,${bytes.toString("base64")}`,
    );
  }
});

test("missing and extensionless picture fields resolve only conventional in-mod artwork", async (t) => {
  const f = await fixture(t);
  await f.write(path.join(f.contentPath, "thumbnail.jpg"), images.jpeg);
  for (const picture of [undefined, "", "thumbnail", "old.png"]) {
    const registered = await f.reader.replace([{ ...f.mod(picture), picture }]);
    assert.equal(registered.get(f.mod().id), "thumbnail.jpg");
    assert.equal((await f.reader.get(f.mod().id)).mime, "image/jpeg");
  }
  await f.write(path.join(f.contentPath, "nested", "art"), images.webp);
  await f.reader.replace([f.mod("nested/art")]);
  assert.equal((await f.reader.get(f.mod().id)).mime, "image/webp");
  await f.write(path.join(f.contentPath, "nested", "cover.png"), images.png);
  await f.reader.replace([f.mod("nested/cover")]);
  assert.equal((await f.reader.get(f.mod().id)).mime, "image/png");
  for (const picture of [
    "../outside.png",
    "C:/outside.png",
    "cover.svg",
    "cover.png:stream",
  ]) {
    await f.reader.replace([f.mod(picture)]);
    assert.equal(await f.reader.get(f.mod().id), null);
  }
});

test("explicit artwork wins over root fallback and refresh discovers a newly created explicit file", async (t) => {
  const f = await fixture(t);
  await f.write(path.join(f.contentPath, "thumbnail.png"), images.png);
  await f.reader.replace([f.mod("preferred.jpg")]);
  assert.equal((await f.reader.get(f.mod().id)).mime, "image/png");
  await f.write(path.join(f.contentPath, "preferred.jpg"), images.jpeg);
  await f.reader.replace([f.mod("preferred.jpg")]);
  assert.equal((await f.reader.get(f.mod().id)).mime, "image/jpeg");
});

test("ZIP fallback handles missing and extensionless fields without entry-order changing precedence", async (t) => {
  const f = await fixture(t);
  const archive = await f.write(
    path.join(f.root, "mod.zip"),
    await zipBytes([
      { name: "thumbnail.jpg", bytes: images.jpeg },
      { name: "nested/preferred.png", bytes: images.webp },
      { name: "thumbnail.png", bytes: images.png },
    ]),
  );
  for (const [picture, mime] of [
    ["", "image/png"],
    ["thumbnail", "image/png"],
    ["nested/preferred", "image/webp"],
    ["thumbnail.JPG", "image/jpeg"],
  ]) {
    await f.reader.replace([f.mod(picture, { contentPath: archive })]);
    assert.equal((await f.reader.get(f.mod().id)).mime, mime);
  }
});

test("invalid ZIP fallback never blocks an explicit valid image regardless of entry order", async (t) => {
  const f = await fixture(t);
  for (const length of [0, MAX_IMAGE_BYTES + 1]) {
    const entries = [
      { name: "thumbnail.png", bytes: Buffer.alloc(length) },
      { name: "preferred.png", bytes: images.png },
    ];
    for (const reverse of [false, true]) {
      const archive = await f.write(
        path.join(f.root, "mod.zip"),
        await zipBytes(reverse ? [...entries].reverse() : entries),
      );
      await f.reader.replace([
        f.mod("preferred.png", { contentPath: archive }),
      ]);
      assert.equal((await f.reader.get(f.mod().id)).mime, "image/png");
    }
  }
});

test("PNG cover display strips trailing editor metadata and still validates the entire retained stream", async (t) => {
  const f = await fixture(t);
  const file = path.join(f.contentPath, "cover.png");
  const trailing = Buffer.from(
    "<html>editor metadata must never reach the renderer</html>",
  );
  await f.write(file, Buffer.concat([images.png, trailing]));
  assert.equal(
    validatedRaster(await fs.readFile(file)),
    null,
    "shared validator remains strict",
  );
  await f.reader.replace([f.mod()]);
  assert.equal(
    (await f.reader.get(f.mod().id)).dataUrl,
    `data:image/png;base64,${images.png.toString("base64")}`,
  );
  const corrupt = Buffer.from(images.png);
  corrupt[45] ^= 1;
  await f.write(file, Buffer.concat([corrupt, trailing]));
  await f.reader.replace([f.mod()]);
  assert.equal(await f.reader.get(f.mod().id), null);
});

test("static WebP accepts bounded C2PA metadata without treating it as image data", () => {
  const chunk = Buffer.concat([
    Buffer.from("C2PA"),
    Buffer.from([4, 0, 0, 0]),
    Buffer.from("test"),
  ]);
  const withMetadata = Buffer.concat([images.webp, chunk]);
  withMetadata.writeUInt32LE(withMetadata.length - 8, 4);
  assert.deepEqual(validatedRaster(withMetadata), {
    mime: "image/webp",
    width: 2,
    height: 3,
  });
  withMetadata.writeUInt32LE(9999, images.webp.length + 4);
  assert.equal(validatedRaster(withMetadata), null);
});

test("JPEG display trims only the parsed EOI, not an EOI embedded in EXIF", async (t) => {
  const f = await fixture(t);
  const exif = Buffer.from([255, 225, 0, 8, 69, 120, 105, 102, 255, 217]);
  const prefix = Buffer.concat([
    images.jpeg.subarray(0, 2),
    exif,
    images.jpeg.subarray(2),
  ]);
  await f.write(
    path.join(f.contentPath, "cover.png"),
    Buffer.concat([prefix, Buffer.from("editor tail")]),
  );
  await f.reader.replace([f.mod()]);
  assert.equal(
    (await f.reader.get(f.mod().id)).dataUrl,
    `data:image/jpeg;base64,${prefix.toString("base64")}`,
  );
  assert.equal(
    validatedRaster(Buffer.concat([prefix, Buffer.from("editor tail")])),
    null,
  );
  const damaged = Buffer.from(prefix);
  damaged[2 + exif.length] = 0;
  await f.write(path.join(f.contentPath, "cover.png"), damaged);
  await f.reader.replace([f.mod()]);
  assert.equal(await f.reader.get(f.mod().id), null);
});

test("scanned library exposes fallback artwork without changing the source descriptor or settings", async (t) => {
  const f = await fixture(t);
  const documents = path.join(f.root, "Documents");
  const userData = path.join(
    documents,
    "Paradox Interactive",
    "Hearts of Iron IV",
  );
  const descriptor = path.join(userData, "mod", "fallback.mod");
  const original = 'name="Fallback"\npath="mod/fallback"\n';
  await f.write(descriptor, original);
  await f.write(
    path.join(userData, "mod", "fallback", "thumbnail.png"),
    images.jpeg,
  );
  const settingsPath = path.join(f.root, "settings.json");
  const service = createLauncherService({
    documentsPath: documents,
    settingsPath,
    steamRoots: [],
    processProbe: async () => null,
  });
  const state = await service.getState();
  assert.equal(state.mods[0].picture, "thumbnail.png");
  assert.equal(
    (await service.getModThumbnail(state.mods[0].id)).mime,
    "image/jpeg",
  );
  assert.equal(await fs.readFile(descriptor, "utf8"), original);
  await assert.rejects(fs.stat(settingsPath), { code: "ENOENT" });
});

test("image byte limit is checked before opening or allocating the body", async (t) => {
  const f = await fixture(t),
    file = await f.write(path.join(f.contentPath, "cover.png"), images.png);
  await fs.truncate(file, MAX_IMAGE_BYTES + 1);
  const originalOpen = fs.open;
  let opens = 0;
  t.after(() => {
    fs.open = originalOpen;
  });
  fs.open = async (...args) => {
    opens++;
    return originalOpen(...args);
  };
  await f.reader.replace([f.mod()]);
  assert.equal(await f.reader.get(f.mod().id), null);
  assert.equal(opens, 0);
});

test("changes and replacements require a refreshed registration", async (t) => {
  const f = await fixture(t),
    file = await f.write(path.join(f.contentPath, "cover.png"), images.png);
  await f.reader.replace([f.mod()]);
  assert.equal((await f.reader.get(f.mod().id)).width, 2);
  await fs.writeFile(file, png());
  assert.equal(await f.reader.get(f.mod().id), null);
  await f.reader.replace([f.mod()]);
  assert.equal((await f.reader.get(f.mod().id)).width, 1);
  await fs.rename(file, `${file}.old`);
  await fs.writeFile(file, images.png);
  assert.equal(await f.reader.get(f.mod().id), null);
  await f.reader.replace([f.mod()]);
  assert.equal((await f.reader.get(f.mod().id)).width, 2);
  await f.reader.replace([]);
  assert.equal(await f.reader.get(f.mod().id), null);
});

test("hardlinks and ancestor junctions are refused", async (t) => {
  const f = await fixture(t),
    file = await f.write(path.join(f.contentPath, "cover.png"), images.png);
  await fs.link(file, path.join(f.root, "linked.png"));
  await f.reader.replace([f.mod()]);
  assert.equal(await f.reader.get(f.mod().id), null);
  await fs.unlink(path.join(f.root, "linked.png"));
  await f.reader.replace([f.mod()]);
  const moved = path.join(f.root, "moved");
  await fs.rename(f.contentPath, moved);
  await fs.symlink(
    moved,
    f.contentPath,
    process.platform === "win32" ? "junction" : "dir",
  );
  assert.equal(await f.reader.get(f.mod().id), null);
  await f.reader.replace([f.mod()]);
  assert.equal(await f.reader.get(f.mod().id), null);
  assert.deepEqual(
    await fs.readFile(path.join(moved, "cover.png")),
    images.png,
  );
});

test("source mutation during reading is rejected and the opened handle is closed", async (t) => {
  const f = await fixture(t),
    file = await f.write(path.join(f.contentPath, "cover.png"), images.png);
  await f.reader.replace([f.mod()]);
  const originalOpen = fs.open;
  let opens = 0,
    closes = 0;
  t.after(() => {
    fs.open = originalOpen;
  });
  fs.open = async (...args) => {
    const handle = await originalOpen(...args);
    if (args[0] === file) {
      opens++;
      const read = handle.read.bind(handle),
        close = handle.close.bind(handle);
      handle.read = async (...params) => {
        const result = await read(...params);
        await fs.appendFile(file, "changed");
        return result;
      };
      handle.close = async () => {
        closes++;
        return close();
      };
    }
    return handle;
  };
  assert.equal(await f.reader.get(f.mod().id), null);
  assert.equal(opens, 1);
  assert.equal(closes, 1);
});

test("ZIP artwork is read in memory, case matched and never extracted", async (t) => {
  const f = await fixture(t),
    archive = await f.write(
      path.join(f.root, "mod.zip"),
      await zipBytes([
        { name: "descriptor.mod", bytes: Buffer.from('name="Fixture"') },
        { name: "Nested/Cover.png" },
        { name: "unrelated.txt", bytes: Buffer.alloc(1024 * 1024) },
      ]),
    );
  const before = await fs.readdir(f.root);
  await f.reader.replace([f.mod("nested/cover.png", { contentPath: archive })]);
  assert.deepEqual(await f.reader.get(f.mod().id), {
    mime: "image/png",
    width: 2,
    height: 3,
    dataUrl: `data:image/png;base64,${images.png.toString("base64")}`,
  });
  assert.deepEqual(await fs.readdir(f.root), before);
});

test("ZIP duplicates, symlinks, encrypted entries, CRC errors and oversized images fail closed", async (t) => {
  const f = await fixture(t);
  const normal = await zipBytes([{}]);
  const encrypted = Buffer.from(normal);
  encrypted.writeUInt16LE(encrypted.readUInt16LE(6) | 1, 6);
  const central = encrypted.indexOf(Buffer.from([80, 75, 1, 2]));
  encrypted.writeUInt16LE(encrypted.readUInt16LE(central + 8) | 1, central + 8);
  const crc = Buffer.from(normal);
  crc.writeUInt32LE(0, crc.indexOf(Buffer.from([80, 75, 1, 2])) + 16);
  const cases = [
    await zipBytes([{ name: "cover.png" }, { name: "cover.png" }]),
    await zipBytes([{ name: "cover.png" }, { name: "COVER.PNG" }]),
    await zipBytes([{ name: "cover.png", options: { mode: 0o120777 } }]),
    await zipBytes([
      { name: "cover.png", bytes: Buffer.alloc(MAX_IMAGE_BYTES + 1) },
    ]),
    encrypted,
    crc,
    normal.subarray(0, normal.length - 1),
    Buffer.from("not a zip"),
  ];
  for (let index = 0; index < cases.length; index++) {
    const archive = await f.write(
      path.join(f.root, `bad-${index}.zip`),
      cases[index],
    );
    await f.reader.replace([f.mod("cover.png", { contentPath: archive })]);
    assert.equal(await f.reader.get(f.mod().id), null, `bad ZIP ${index}`);
    assert.deepEqual(await fs.readFile(archive), cases[index]);
  }
});

test("ZIP changes require a fresh state scan and missing/invalid image reads close handles", async (t) => {
  const f = await fixture(t),
    archive = await f.write(path.join(f.root, "mod.zip"), await zipBytes([{}]));
  await f.reader.replace([f.mod("cover.png", { contentPath: archive })]);
  await fs.appendFile(archive, "changed");
  assert.equal(await f.reader.get(f.mod().id), null);
  const originalOpen = fs.open;
  let opens = 0,
    closes = 0;
  t.after(() => {
    fs.open = originalOpen;
  });
  fs.open = async (...args) => {
    const handle = await originalOpen(...args);
    if (args[0] === archive) {
      opens++;
      const close = handle.close.bind(handle);
      handle.close = async () => {
        closes++;
        return close();
      };
    }
    return handle;
  };
  for (const bytes of [
    await zipBytes([{ name: "elsewhere.png" }]),
    await zipBytes([{ bytes: Buffer.from("invalid PNG") }]),
    Buffer.from("bad zip"),
  ]) {
    await fs.writeFile(archive, bytes);
    await f.reader.replace([f.mod("cover.png", { contentPath: archive })]);
    assert.equal(await f.reader.get(f.mod().id), null);
  }
  assert.equal(opens, 3);
  assert.equal(closes, opens);
});

for (const archive of [false, true]) {
  test(`an unchanged ${archive ? "ZIP" : "directory"} registration keeps a pending cover readable across background scans`, async (t) => {
    const f = await fixture(t);
    const file = archive
      ? await f.write(path.join(f.root, "archive.zip"), await zipBytes([{}]))
      : await f.write(path.join(f.contentPath, "cover.png"), images.png);
    const mod = f.mod("cover.png", archive ? { contentPath: file } : {});
    await f.reader.replace([mod]);
    const open = fs.open;
    let opened,
      release,
      opens = 0;
    const ready = new Promise((resolve) => {
      opened = resolve;
    });
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    t.after(() => release());
    t.mock.method(fs, "open", async (...args) => {
      const handle = await open(...args);
      if (args[0] === file) {
        opens++;
        opened();
        await gate;
      }
      return handle;
    });
    const pending = f.reader.get(mod.id);
    await ready;
    await f.reader.replace([{ ...mod }]);
    await f.reader.replace([{ ...mod }]);
    const duplicate = f.reader.get(mod.id);
    release();
    const results = await Promise.all([pending, duplicate]);
    assert.ok(results.every((result) => result?.width === 2));
    assert.equal(opens, 1);
  });
}

test("an image read that races a registry refresh never returns stale artwork", async (t) => {
  const f = await fixture(t),
    file = await f.write(path.join(f.contentPath, "cover.png"), images.png);
  await f.reader.replace([f.mod()]);
  const originalOpen = fs.open;
  let release, opened;
  const gate = new Promise((resolve) => {
    opened = resolve;
  });
  t.after(() => {
    fs.open = originalOpen;
  });
  fs.open = async (...args) => {
    const handle = await originalOpen(...args);
    if (args[0] === file) {
      opened();
      await new Promise((resolve) => {
        release = resolve;
      });
    }
    return handle;
  };
  const pending = f.reader.get(f.mod().id);
  await gate;
  await f.reader.replace([]);
  release();
  assert.equal(await pending, null);
});

test("launcher registers local, Steam and PDX artwork from scanned metadata without per-image rescans", async (t) => {
  const f = await fixture(t),
    documents = path.join(f.root, "Documents"),
    userData = path.join(documents, "Paradox Interactive", "Hearts of Iron IV"),
    steam = path.join(f.root, "Steam");
  const local = path.join(userData, "mod", "local"),
    pdx = path.join(userData, "pdx-mod", "content"),
    workshop = path.join(
      steam,
      "steamapps",
      "workshop",
      "content",
      "394360",
      "123",
    );
  const descriptor = (name, folder, picture) =>
    `name="${name}"\npath=${JSON.stringify(folder.replace(/\\/g, "/"))}\npicture="${picture}"\n`;
  await f.write(
    path.join(userData, "mod", "local.mod"),
    descriptor("Local", local, "cover.png"),
  );
  await f.write(path.join(local, "cover.png"), images.png);
  await f.write(
    path.join(userData, "mod", "pdx_456_12.mod"),
    descriptor("PDX", pdx, "cover.jpeg"),
  );
  await f.write(path.join(pdx, "cover.jpeg"), images.jpeg);
  await f.write(
    path.join(workshop, "descriptor.mod"),
    'name="Steam"\npicture="cover.gif"\n',
  );
  await f.write(path.join(workshop, "cover.gif"), images.gif);
  const archive = await f.write(
    path.join(userData, "mod", "archive.zip"),
    await zipBytes([{}]),
  );
  await f.write(
    path.join(userData, "mod", "archive.mod"),
    `name="ZIP"\narchive=${JSON.stringify(archive.replace(/\\/g, "/"))}\npicture="cover.png"\n`,
  );
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => {
    assert.fail("No network allowed");
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const service = createLauncherService({
    documentsPath: documents,
    settingsPath: path.join(f.root, "settings.json"),
    steamRoots: [steam],
    spawnProcess() {
      assert.fail("No process allowed");
    },
  });
  assert.equal(await service.getModThumbnail("local:local.mod"), null);
  const state = await service.getState();
  assert.equal(state.mods.length, 4);
  const originalReaddir = fs.readdir;
  let scans = 0;
  fs.readdir = async (...args) => {
    scans++;
    return originalReaddir(...args);
  };
  t.after(() => {
    fs.readdir = originalReaddir;
  });
  for (const [id, mime] of [
    ["local:local.mod", "image/png"],
    ["workshop:123", "image/gif"],
    ["pdx:456", "image/jpeg"],
    ["local:archive.mod", "image/png"],
  ])
    assert.equal((await service.getModThumbnail(id)).mime, mime);
  assert.equal(scans, 0);
  await fs.writeFile(path.join(local, "cover.png"), png());
  assert.equal(await service.getModThumbnail("local:local.mod"), null);
  await service.getState();
  assert.equal((await service.getModThumbnail("local:local.mod")).width, 1);
  await assert.rejects(fs.stat(path.join(f.root, "settings.json")), {
    code: "ENOENT",
  });
});

test("PNG rejects extra data hidden after its compressed image stream", () => {
  const bytes = png(),
    length = bytes.readUInt32BE(33),
    data = bytes.subarray(41, 41 + length);
  const invalid = Buffer.concat([
    bytes.subarray(0, 33),
    pngChunk("IDAT", Buffer.concat([data, Buffer.from("junk")])),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
  assert.equal(validatedRaster(invalid), null);
});

test("concurrent requests deduplicate each ID and bound open readers to two", async (t) => {
  const f = await fixture(t),
    file = await f.write(path.join(f.contentPath, "cover.png"), images.png);
  const mods = Array.from({ length: 6 }, (_, i) =>
    f.mod("cover.png", { id: `local:${i}.mod` }),
  );
  await f.reader.replace(mods);
  const originalOpen = fs.open;
  let opens = 0,
    current = 0,
    maximum = 0,
    openedTwo,
    release;
  const ready = new Promise((resolve) => {
      openedTwo = resolve;
    }),
    gate = new Promise((resolve) => {
      release = resolve;
    });
  t.after(() => {
    fs.open = originalOpen;
    release();
  });
  fs.open = async (...args) => {
    const handle = await originalOpen(...args);
    if (args[0] === file) {
      opens++;
      current++;
      maximum = Math.max(current, maximum);
      if (opens === 2) openedTwo();
      const read = handle.read.bind(handle),
        close = handle.close.bind(handle);
      handle.read = async (...params) => {
        await gate;
        return read(...params);
      };
      handle.close = async () => {
        try {
          return await close();
        } finally {
          current--;
        }
      };
    }
    return handle;
  };
  const requests = mods.flatMap((mod) => [
    f.reader.get(mod.id),
    f.reader.get(mod.id),
  ]);
  await ready;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(opens, 2);
  release();
  const results = await Promise.all(requests);
  assert.ok(results.every((result) => result?.width === 2));
  assert.equal(opens, 6);
  assert.equal(current, 0);
  assert.equal(maximum, 2);
});

test("replacing an image between path check and open is detected without reading replacement bytes", async (t) => {
  const f = await fixture(t),
    file = await f.write(path.join(f.contentPath, "cover.png"), images.png);
  await f.reader.replace([f.mod()]);
  const originalOpen = fs.open;
  let reads = 0,
    closes = 0;
  t.after(() => {
    fs.open = originalOpen;
  });
  fs.open = async (...args) => {
    if (args[0] === file) {
      await fs.rename(file, `${file}.old`);
      await fs.writeFile(file, png());
    }
    const handle = await originalOpen(...args);
    if (args[0] === file) {
      const read = handle.read.bind(handle),
        close = handle.close.bind(handle);
      handle.read = async (...params) => {
        reads++;
        return read(...params);
      };
      handle.close = async () => {
        closes++;
        return close();
      };
    }
    return handle;
  };
  assert.equal(await f.reader.get(f.mod().id), null);
  assert.equal(reads, 0);
  assert.equal(closes, 1);
  assert.deepEqual(await fs.readFile(file), png());
});

test("ZIP mutation during lazy metadata reading is rejected and its handle closes once", async (t) => {
  const f = await fixture(t),
    archive = await f.write(path.join(f.root, "mod.zip"), await zipBytes([{}]));
  await f.reader.replace([f.mod("cover.png", { contentPath: archive })]);
  const originalOpen = fs.open;
  let changed = false,
    closes = 0;
  t.after(() => {
    fs.open = originalOpen;
  });
  fs.open = async (...args) => {
    const handle = await originalOpen(...args);
    if (args[0] === archive) {
      const read = handle.read.bind(handle),
        close = handle.close.bind(handle);
      handle.read = async (...params) => {
        const result = await read(...params);
        if (!changed) {
          changed = true;
          await fs.appendFile(archive, "changed");
        }
        return result;
      };
      handle.close = async () => {
        closes++;
        return close();
      };
    }
    return handle;
  };
  assert.equal(await f.reader.get(f.mod().id), null);
  assert.equal(changed, true);
  assert.equal(closes, 1);
});

test("ZIP ancestor replacement during reading never follows a junction", async (t) => {
  const f = await fixture(t),
    bytes = await zipBytes([{}]),
    archive = await f.write(path.join(f.contentPath, "mod.zip"), bytes),
    moved = path.join(f.root, "moved");
  await f.reader.replace([f.mod("cover.png", { contentPath: archive })]);
  const originalOpen = fs.open;
  let changed = false;
  t.after(() => {
    fs.open = originalOpen;
  });
  fs.open = async (...args) => {
    const handle = await originalOpen(...args);
    if (args[0] === archive) {
      const read = handle.read.bind(handle);
      handle.read = async (...params) => {
        const result = await read(...params);
        if (!changed) {
          changed = true;
          const temporary = path.join(f.root, "moving.zip");
          await fs.rename(archive, temporary);
          await fs.rename(f.contentPath, moved);
          await fs.rename(temporary, path.join(moved, "mod.zip"));
          await fs.symlink(
            moved,
            f.contentPath,
            process.platform === "win32" ? "junction" : "dir",
          );
        }
        return result;
      };
    }
    return handle;
  };
  assert.equal(await f.reader.get(f.mod().id), null);
  assert.equal(changed, true);
  assert.deepEqual(await fs.readFile(path.join(moved, "mod.zip")), bytes);
});
