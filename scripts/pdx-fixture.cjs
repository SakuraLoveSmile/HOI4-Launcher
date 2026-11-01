"use strict";
// Small in-memory ZIP and fake HTTP responses. Never contacts a real provider.
const { crc32 } = require("node:zlib");
const { createHash } = require("node:crypto");

function zipFixture(files) {
  const local = [],
    central = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const filename = Buffer.from(name),
      bytes = Buffer.from(text);
    const header = Buffer.alloc(30),
      record = Buffer.alloc(46),
      crc = crc32(bytes);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x800, 6);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(bytes.length, 18);
    header.writeUInt32LE(bytes.length, 22);
    header.writeUInt16LE(filename.length, 26);
    record.writeUInt32LE(0x02014b50, 0);
    record.writeUInt16LE(20, 4);
    record.writeUInt16LE(20, 6);
    record.writeUInt16LE(0x800, 8);
    record.writeUInt32LE(crc, 16);
    record.writeUInt32LE(bytes.length, 20);
    record.writeUInt32LE(bytes.length, 24);
    record.writeUInt16LE(filename.length, 28);
    record.writeUInt32LE(offset, 42);
    local.push(header, filename, bytes);
    central.push(record, filename);
    offset += header.length + filename.length + bytes.length;
  }
  const end = Buffer.alloc(22),
    table = Buffer.concat(central);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(local.length / 3, 8);
  end.writeUInt16LE(local.length / 3, 10);
  end.writeUInt32LE(table.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, table, end]);
}

function createPdxFixture({
  revision = "1",
  title = "Hidden PDX fixture",
} = {}) {
  const bytes = zipFixture({
    "descriptor.mod": `name="${title}"\nsupported_version="1.19.*"\nversion="${revision}"\nreplace_path="history/states"\ntags={"Gameplay"}\n`,
    "events/fixture.txt": "# isolated downloadable mod\n",
  });
  const name = "11111111-2222-3333-4444-555555555555";
  const digest = createHash("sha256").update(bytes).digest("base64");
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, method: options?.method || "GET" });
    if (url.startsWith("https://api.paradox-interactive.com/mods?"))
      return Response.json({
        result: "OK",
        modDetail: {
          modId: "123",
          name,
          game: "hoi4",
          os: "Any",
          arch: "Any",
          modVersion: revision,
          state: "published",
          acl: "public",
          updating: false,
          isRegionBlocked: false,
          displayName: title,
        },
      });
    const prefix = `https://modscontent.paradox-interactive.com/hoi4/${name}/repo/Any__Any/${revision}/complete/`;
    if (url === prefix + "manifest")
      return new Response(
        `Name: Any__Any\nHash: sha256\n\n${name}.zip,${bytes.length},${digest},crw,${bytes.length},zip\n`,
      );
    if (url === prefix + name + ".zip")
      return new Response(bytes, {
        headers: { "Content-Length": String(bytes.length) },
      });
    throw new Error("Unrecognized fixture URL");
  };
  return { bytes, fetchImpl, calls };
}
module.exports = { createPdxFixture, zipFixture };
