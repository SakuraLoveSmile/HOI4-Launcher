"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { createHash } = require("node:crypto");
const pgp = require("openpgp");
const { createPdxSignatureVerifier } = require("../electron/pdx-signature.cjs");
const {
  createSignatureFixture,
  signDocument,
  signedPacket,
  signatureArmor,
  fullConfig,
} = require("./fixtures/pdx-signatures/create-fixture.cjs");

const metadata = Buffer.from('{"version":1,"channel":"fixture"}\n');
const manifest = Buffer.from(
  '{"fixture.zip":{"sha256":"' + "a".repeat(64) + '","size":3}}\n',
);
let normal, expired, subkey, normalInput, expiredInput, subkeyInput;
test.before(async () => {
  normal = await createSignatureFixture();
  expired = await createSignatureFixture({
    expired: true,
    certificationHash: pgp.enums.hash.sha1,
  });
  subkey = await createSignatureFixture({ signingSubkey: true });
  normalInput = await normal.sign({ metadata, manifest });
  expiredInput = await expired.sign({ metadata, manifest });
  subkeyInput = await subkey.sign({ metadata, manifest });
});

function verifier(fixture = normal, options = {}) {
  return createPdxSignatureVerifier({
    rootKey: fixture.rootKey,
    rootFingerprint: fixture.rootFingerprint,
    now: () => fixture.now,
    ...options,
  });
}
const invalid = { code: "SIGNATURE_INVALID" };
const unavailable = { code: "SIGNATURE_UNAVAILABLE" };
const revoked = { code: "KEY_REVOKED" };
const fixturePath = (name) =>
  path.join(__dirname, "fixtures", "pdx-signatures", name);
async function publicCopy(fixture) {
  return pgp.readKey({ armoredKey: fixture.repositoryKey.toString("utf8") });
}
async function resignBinding(fixture, change) {
  const repository = await publicCopy(fixture),
    binding = repository.subkeys[0].bindingSignatures[0];
  const signingPacket = fixture.repositoryPrivate.subkeys[0].keyPacket;
  await change(binding, signingPacket, repository);
  await binding.sign(
    fixture.repositoryPrivate.keyPacket,
    { key: repository.keyPacket, bind: repository.subkeys[0].keyPacket },
    binding.created,
    false,
    fullConfig(),
  );
  return Buffer.from(repository.armor());
}

test("root-certified raw metadata and manifest verify without changing global hash policies", async () => {
  const before = {
    rejectHash: [...pgp.config.rejectHashAlgorithms],
    rejectMessageHash: [...pgp.config.rejectMessageHashAlgorithms],
  };
  const calls = [];
  const result = await verifier().verify({
    ...normalInput,
    lookupRevocation: async (fingerprint) => {
      calls.push(fingerprint);
      return { status: 204, bytes: Buffer.alloc(0) };
    },
  });
  assert.deepEqual(result, {
    rootFingerprint: normal.rootFingerprint,
    repositoryFingerprint: normal.repositoryPrivate
      .getFingerprint()
      .toUpperCase(),
    legacyExpiredKeys: false,
  });
  assert.deepEqual(calls, [
    result.rootFingerprint,
    result.repositoryFingerprint,
  ]);
  assert.deepEqual([...pgp.config.rejectHashAlgorithms], before.rejectHash);
  assert.deepEqual(
    [...pgp.config.rejectMessageHashAlgorithms],
    before.rejectMessageHash,
  );
});

test("official original bytes establish the production trust chain with explicit expired-key compatibility", async () => {
  const input = {};
  for (const [key, name] of Object.entries({
    repositoryKey: "repository-key.asc",
    metadata: "repository.json",
    metadataSignature: "repository.json.asc",
    manifest: "manifest",
    manifestSignature: "manifest.asc",
  }))
    input[key] = await fs.readFile(fixturePath(name));
  const calls = [];
  const result = await createPdxSignatureVerifier({
    now: () => Date.UTC(2026, 9, 29, 12),
  }).verify({
    ...input,
    lookupRevocation: async (fingerprint) => {
      calls.push(fingerprint);
      return { status: 204, bytes: Buffer.alloc(0) };
    },
  });
  assert.deepEqual(result, {
    rootFingerprint: "AF28077C9C565B53F3CD5A65788AA56D99D64E1C",
    repositoryFingerprint: "E7120B18C9267050FA73CB6479A54411046A8535",
    legacyExpiredKeys: true,
  });
  assert.equal(calls.length, 2);
  await assert.rejects(
    createPdxSignatureVerifier().verify({
      ...input,
      metadata: Buffer.concat([input.metadata, Buffer.from(" ")]),
      lookupRevocation: normal.lookupRevocation,
    }),
    invalid,
  );
});
test("all supported root UID certification classes verify with their actual signature type", async () => {
  for (const type of [0x10, 0x11, 0x12, 0x13]) {
    const repository = await publicCopy(normal);
    repository.users[0].otherCertifications = [
      await signedPacket(
        normal.rootPrivate.keyPacket,
        type,
        { key: repository.keyPacket, userID: repository.users[0].userID },
        { date: normal.keyDate + 2000 },
      ),
    ];
    const result = await verifier().verify({
      ...normalInput,
      repositoryKey: Buffer.from(repository.armor()),
    });
    assert.equal(
      result.repositoryFingerprint,
      repository.getFingerprint().toUpperCase(),
    );
  }
});

test("real public fixture hashes are pinned to recorded original bytes", async () => {
  for (const [name, expected] of Object.entries({
    "repository-key.asc":
      "47ede5d8c6d05f5806e98227b67ed2517797f3cb911d838b6a4297d97226038b",
    "repository.json":
      "08599cb49aa8ec14046066ca7ec0cd3a546dd2cb8a17ff7eb29633f8b9de6096",
    "repository.json.asc":
      "809dd342d836b9660e5cee05b7822f446eb87f5992060c6cb403126a90b7b1f6",
    manifest:
      "a245e868bd1d2ca203148ba8ded3a3beb6933f9df3cb8e7d67c00c8c1044c9d2",
    "manifest.asc":
      "e0e9a3ba2c5b1a58a147656fd6c2e2de8647ddde2c54ea14d781a106fb9e5162",
  }))
    assert.equal(
      createHash("sha256")
        .update(await fs.readFile(fixturePath(name)))
        .digest("hex"),
      expected,
    );
});

test("expired certified keys can sign new content while SHA1 remains limited to certifications", async () => {
  const result = await verifier(expired).verify(expiredInput);
  assert.equal(result.legacyExpiredKeys, true);
  for (const hashAlgorithm of [pgp.enums.hash.sha1, pgp.enums.hash.sha224]) {
    const weak = await expired.sign({ metadata, manifest, hashAlgorithm });
    await assert.rejects(verifier(expired).verify(weak), invalid);
  }
});

test("altered metadata or manifest bytes and signatures from another trusted key fail", async () => {
  for (const key of ["metadata", "manifest"])
    await assert.rejects(
      verifier().verify({
        ...normalInput,
        [key]: Buffer.concat([normalInput[key], Buffer.from("\r\n")]),
      }),
      invalid,
    );
  const wrong = await signDocument(normal.rootPrivate.keyPacket, manifest, {
    date: normal.now,
  });
  await assert.rejects(
    verifier().verify({ ...normalInput, manifestSignature: wrong }),
    invalid,
  );
});

test("root fingerprint pinning and root certification cannot be replaced by a self-signed key", async () => {
  await assert.rejects(
    verifier(normal, { rootFingerprint: "0".repeat(40) }).verify(normalInput),
    invalid,
  );
  const repository = await publicCopy(normal);
  repository.users[0].otherCertifications = [];
  await assert.rejects(
    verifier().verify({
      ...normalInput,
      repositoryKey: Buffer.from(repository.armor()),
    }),
    invalid,
  );
  const forged = await signedPacket(
    normal.repositoryPrivate.keyPacket,
    pgp.enums.signature.certGeneric,
    { key: repository.keyPacket, userID: repository.users[0].userID },
    { date: normal.keyDate + 2000 },
  );
  forged.issuerKeyID = normal.rootPrivate.getKeyID();
  repository.users[0].otherCertifications.push(forged);
  await assert.rejects(
    verifier().verify({
      ...normalInput,
      repositoryKey: Buffer.from(repository.armor()),
    }),
    invalid,
  );
});

test("multiple key entities and extra armor blocks or trailing provider text are rejected", async () => {
  const root = await pgp.readKey({
    armoredKey: normal.rootKey.toString("utf8"),
  });
  const repository = await publicCopy(normal);
  const packets = new pgp.PacketList();
  packets.push(...root.toPacketList(), ...repository.toPacketList());
  for (const repositoryKey of [
    Buffer.from(pgp.armor(pgp.enums.armor.publicKey, packets.write())),
    Buffer.concat([normal.repositoryKey, normal.rootKey]),
    Buffer.concat([normal.repositoryKey, Buffer.from("token=fixture-secret")]),
  ])
    await assert.rejects(
      verifier().verify({ ...normalInput, repositoryKey }),
      invalid,
    );
});

test("future and expired content signatures are not accepted by the key-expiry exception", async () => {
  for (const options of [
    { date: expired.now + 1000 },
    { date: expired.now - 10000, signatureExpirationTime: 1 },
  ]) {
    const input = await expired.sign({ metadata, manifest, ...options });
    await assert.rejects(verifier(expired).verify(input), invalid);
  }
});

test("future and expired root certifications fail independently of legacy key expiration", async () => {
  for (const options of [
    { date: normal.now + 1000 },
    { date: normal.now - 10000, signatureExpirationTime: 1 },
  ]) {
    const repository = await publicCopy(normal);
    repository.users[0].otherCertifications = [
      await signedPacket(
        normal.rootPrivate.keyPacket,
        pgp.enums.signature.certGeneric,
        { key: repository.keyPacket, userID: repository.users[0].userID },
        options,
      ),
    ];
    await assert.rejects(
      verifier().verify({
        ...normalInput,
        repositoryKey: Buffer.from(repository.armor()),
      }),
      invalid,
    );
  }
});

test("future root or repository primary creation dates fail before trust is granted", async () => {
  const future = await createSignatureFixture({ keyDate: normal.now + 1000 });
  const input = await future.sign({
    metadata,
    manifest,
    date: normal.now + 10000,
  });
  await assert.rejects(
    verifier(future, { now: () => normal.now }).verify(input),
    invalid,
  );
  await assert.rejects(
    verifier().verify({ ...normalInput, repositoryKey: future.repositoryKey }),
    invalid,
  );
});

test("a valid signing subkey requires a current binding, signing flag and valid back signature", async () => {
  assert.equal(
    (await verifier(subkey).verify(subkeyInput)).legacyExpiredKeys,
    false,
  );
  for (const change of [
    async (binding) => {
      binding.embeddedSignature = null;
    },
    async (binding) => {
      binding.keyFlags = new Uint8Array([
        pgp.enums.keyFlags.encryptCommunication,
      ]);
    },
    async (binding) => {
      binding.created = new Date(subkey.now + 1000);
    },
    async (binding, privatePacket, repository) => {
      binding.embeddedSignature = await signedPacket(
        privatePacket,
        pgp.enums.signature.keyBinding,
        { key: repository.keyPacket, bind: repository.subkeys[0].keyPacket },
        { date: subkey.now + 1000 },
      );
    },
  ]) {
    const repositoryKey = await resignBinding(subkey, change);
    await assert.rejects(
      verifier(subkey).verify({ ...subkeyInput, repositoryKey }),
      invalid,
    );
  }
});

test("a signing subkey and its binding cannot be newer than the claimed content signature", async () => {
  const input = await subkey.sign({
    metadata,
    manifest,
    date: subkey.keyDate + 500,
  });
  await assert.rejects(verifier(subkey).verify(input), invalid);
  const repositoryKey = await resignBinding(subkey, async (binding) => {
    binding.created = new Date(subkey.now - 1000);
  });
  const older = await subkey.sign({
    metadata,
    manifest,
    date: subkey.now - 2000,
  });
  await assert.rejects(
    verifier(subkey).verify({ ...older, repositoryKey }),
    invalid,
  );
});

test("a primary key without signing capability is rejected even if root-certified", async () => {
  const repository = await publicCopy(normal),
    user = repository.users[0];
  const self = user.selfCertifications[0];
  self.keyFlags = new Uint8Array([pgp.enums.keyFlags.encryptCommunication]);
  await self.sign(
    normal.repositoryPrivate.keyPacket,
    { key: repository.keyPacket, userID: user.userID },
    self.created,
    false,
    fullConfig(),
  );
  await assert.rejects(
    verifier().verify({
      ...normalInput,
      repositoryKey: Buffer.from(repository.armor()),
    }),
    invalid,
  );
});

test("204 and legacy 404 are absence of a revocation certificate, other transport failures are closed", async () => {
  assert.ok(
    await verifier().verify({
      ...normalInput,
      lookupRevocation: async () => ({
        status: 404,
        bytes: Buffer.from("not found"),
      }),
    }),
  );
  for (const lookupRevocation of [
    async () => ({ status: 503, bytes: Buffer.from("provider secret") }),
    async () => ({ status: 204, bytes: Buffer.from("unexpected") }),
    async () => {
      throw new Error("Authorization: Bearer fixture-secret");
    },
  ])
    await assert.rejects(
      verifier().verify({ ...normalInput, lookupRevocation }),
      (error) => {
        assert.equal(error.code, unavailable.code);
        assert.doesNotMatch(error.message, /provider|Authorization|secret/);
        return true;
      },
    );
});

test("valid root and repository self-revocation certificates revoke their corresponding chain", async () => {
  for (const [fingerprint, certificate] of [
    [normal.rootFingerprint, normal.rootRevocation],
    [
      normal.repositoryPrivate.getFingerprint().toUpperCase(),
      normal.repositoryRevocation,
    ],
  ]) {
    await assert.rejects(
      verifier().verify({
        ...normalInput,
        lookupRevocation: async (value) =>
          value === fingerprint
            ? { status: 200, bytes: certificate }
            : { status: 204, bytes: Buffer.alloc(0) },
      }),
      revoked,
    );
  }
});

test("a revoked embedded primary key is rejected even if network revocation returns 204", async () => {
  const publicKey = await publicCopy(normal);
  const changed = await pgp.revokeKey({
    key: publicKey,
    revocationCertificate: normal.repositoryRevocation.toString("utf8"),
    format: "object",
  });
  await assert.rejects(
    verifier().verify({
      ...normalInput,
      repositoryKey: Buffer.from(changed.publicKey.armor()),
    }),
    revoked,
  );
});

test("forged, wrong-target, empty or wrongly armored 200 revocation replies never become absence", async () => {
  const repositoryFingerprint = normal.repositoryPrivate
    .getFingerprint()
    .toUpperCase();
  for (const certificate of [
    normal.rootRevocation,
    Buffer.alloc(0),
    normal.repositoryKey,
    normalInput.manifestSignature,
    Buffer.from(
      "-----BEGIN PGP PUBLIC KEY BLOCK-----\n\ninvalid\n-----END PGP PUBLIC KEY BLOCK-----",
    ),
  ])
    await assert.rejects(
      verifier().verify({
        ...normalInput,
        lookupRevocation: async (value) =>
          value === repositoryFingerprint
            ? { status: 200, bytes: certificate }
            : { status: 204, bytes: Buffer.alloc(0) },
      }),
      invalid,
    );
});

test("revocation signatures from the root cannot revoke a distinct repository key", async () => {
  const packet = await signedPacket(
    normal.rootPrivate.keyPacket,
    pgp.enums.signature.keyRevocation,
    { key: normal.repositoryPrivate.keyPacket },
    { date: normal.now },
  );
  const certificate = signatureArmor(packet, pgp.enums.armor.publicKey);
  await assert.rejects(
    verifier().verify({
      ...normalInput,
      lookupRevocation: async (value) =>
        value === normal.rootFingerprint
          ? { status: 204, bytes: Buffer.alloc(0) }
          : { status: 200, bytes: certificate },
    }),
    invalid,
  );
});

test("future revocation packets and multiple packets are rejected", async () => {
  const packet = await signedPacket(
    normal.rootPrivate.keyPacket,
    pgp.enums.signature.keyRevocation,
    { key: normal.rootPrivate.keyPacket },
    { date: normal.now + 1000 },
  );
  const future = signatureArmor(packet, pgp.enums.armor.publicKey);
  const packets = new pgp.PacketList();
  packets.push(packet, packet);
  const multiple = Buffer.from(
    pgp.armor(pgp.enums.armor.publicKey, packets.write()),
  );
  for (const bytes of [future, multiple])
    await assert.rejects(
      verifier().verify({
        ...normalInput,
        lookupRevocation: async () => ({ status: 200, bytes }),
      }),
      invalid,
    );
});

test("only one binary document signature is accepted, without canonical text transformations", async () => {
  const signature = await pgp.readSignature({
    armoredSignature: normalInput.manifestSignature.toString("utf8"),
  });
  signature.packets.push(signature.packets[0]);
  const text = await pgp.createMessage({ text: manifest.toString("utf8") });
  const textPacket = await signedPacket(
    normal.repositoryPrivate.keyPacket,
    pgp.enums.signature.text,
    text.packets[0],
    { date: normal.now, detached: true },
  );
  for (const manifestSignature of [
    Buffer.from(signature.armor()),
    signatureArmor(textPacket),
    Buffer.from("invalid"),
    Buffer.concat([
      normalInput.manifestSignature,
      normalInput.manifestSignature,
    ]),
  ])
    await assert.rejects(
      verifier().verify({ ...normalInput, manifestSignature }),
      invalid,
    );
});

test("input size/type limits and invalid clocks fail with a fixed safe diagnostic", async () => {
  for (const patch of [
    { metadata: Buffer.alloc(8 * 1024 * 1024 + 1) },
    { manifestSignature: Buffer.alloc(16 * 1024 + 1) },
    { repositoryKey: Buffer.alloc(64 * 1024 + 1) },
    { manifest: Buffer.alloc(0) },
    { metadata: "provider-secret" },
    { lookupRevocation: null },
  ])
    await assert.rejects(
      verifier().verify({ ...normalInput, ...patch }),
      invalid,
    );
  await assert.rejects(
    verifier(normal, { now: () => NaN }).verify(normalInput),
    invalid,
  );
  await assert.rejects(verifier().verify(null), invalid);
  await assert.rejects(verifier().verify(), invalid);
  assert.throws(() => verifier(normal, { rootFingerprint: "bad" }), invalid);
});

test("ignored marker, trust and padding packets cannot hide behind an accepted signature", async () => {
  const signature = await pgp.unarmor(
    normalInput.manifestSignature.toString("utf8"),
  );
  const revocation = await pgp.unarmor(normal.rootRevocation.toString("utf8"));
  for (const extra of [
    Buffer.from([0xca, 3, 0x50, 0x47, 0x50]),
    Buffer.from([0xcc, 0]),
    Buffer.from([0xd5, 0]),
  ]) {
    const manifestSignature = Buffer.from(
      pgp.armor(
        pgp.enums.armor.signature,
        Buffer.concat([signature.data, extra]),
      ),
    );
    await assert.rejects(
      verifier().verify({ ...normalInput, manifestSignature }),
      invalid,
    );
    const certificate = Buffer.from(
      pgp.armor(
        pgp.enums.armor.publicKey,
        Buffer.concat([revocation.data, extra]),
      ),
    );
    await assert.rejects(
      verifier().verify({
        ...normalInput,
        lookupRevocation: async () => ({ status: 200, bytes: certificate }),
      }),
      invalid,
    );
  }
});

test("legacy key expiry does not hide an expired or future self-certification", async () => {
  for (const change of [
    (self) => {
      self.signatureNeverExpires = false;
      self.signatureExpirationTime = 1;
    },
    (self) => {
      self.created = new Date(normal.now + 1000);
    },
  ]) {
    const repository = await publicCopy(normal),
      user = repository.users[0],
      self = user.selfCertifications[0];
    change(self);
    await self.sign(
      normal.repositoryPrivate.keyPacket,
      { key: repository.keyPacket, userID: user.userID },
      self.created,
      false,
      fullConfig(),
    );
    await assert.rejects(
      verifier().verify({
        ...normalInput,
        repositoryKey: Buffer.from(repository.armor()),
      }),
      invalid,
    );
  }
});

test("a revoked root user certification and revoked signing subkey are rejected", async () => {
  const repository = await publicCopy(normal),
    user = repository.users[0];
  user.revocationSignatures.push(
    await signedPacket(
      normal.rootPrivate.keyPacket,
      pgp.enums.signature.certRevocation,
      { key: repository.keyPacket, userID: user.userID },
      { date: normal.now - 1000 },
    ),
  );
  await assert.rejects(
    verifier().verify({
      ...normalInput,
      repositoryKey: Buffer.from(repository.armor()),
    }),
    invalid,
  );
  const signingRepository = await publicCopy(subkey);
  signingRepository.subkeys[0].revocationSignatures.push(
    await signedPacket(
      subkey.repositoryPrivate.keyPacket,
      pgp.enums.signature.subkeyRevocation,
      {
        key: signingRepository.keyPacket,
        bind: signingRepository.subkeys[0].keyPacket,
      },
      { date: subkey.now - 1000 },
    ),
  );
  await assert.rejects(
    verifier(subkey).verify({
      ...subkeyInput,
      repositoryKey: Buffer.from(signingRepository.armor()),
    }),
    invalid,
  );
});

test("a trusted root without certification capability cannot authorize repository keys", async () => {
  const root = await pgp.readKey({
      armoredKey: normal.rootKey.toString("utf8"),
    }),
    user = root.users[0],
    self = user.selfCertifications[0];
  self.keyFlags = new Uint8Array([pgp.enums.keyFlags.signData]);
  await self.sign(
    normal.rootPrivate.keyPacket,
    { key: root.keyPacket, userID: user.userID },
    self.created,
    false,
    fullConfig(),
  );
  await assert.rejects(
    verifier(normal, { rootKey: Buffer.from(root.armor()) }).verify(
      normalInput,
    ),
    invalid,
  );
});

test("verification snapshots the caller buffers before awaiting external revocation lookup", async () => {
  const mutableMetadata = Buffer.from(metadata);
  const original = await normal.sign({ metadata: mutableMetadata, manifest });
  const result = await verifier().verify({
    ...original,
    lookupRevocation: async () => {
      mutableMetadata.fill(0);
      return { status: 204, bytes: Buffer.alloc(0) };
    },
  });
  assert.equal(
    result.repositoryFingerprint,
    normal.repositoryPrivate.getFingerprint().toUpperCase(),
  );
  assert.notDeepEqual(mutableMetadata, metadata);
});
