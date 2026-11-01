"use strict";

// Test-only generated keys. Never use this module or its private keys in the
// application. No network, real account or external executable is involved.
const pgp = require("openpgp");
const DEFAULT_NOW = Date.UTC(2026, 0, 15, 12);
const DEFAULT_KEY_DATE = Date.UTC(2020, 0, 15, 12);

function fullConfig() {
  return { ...pgp.config, nonDeterministicSignaturesViaNotation: false };
}

async function signedPacket(
  privatePacket,
  type,
  data,
  {
    date = DEFAULT_NOW,
    hashAlgorithm = pgp.enums.hash.sha256,
    signatureExpirationTime,
    detached = false,
  } = {},
) {
  const packet = new pgp.SignaturePacket();
  packet.signatureType = type;
  packet.publicKeyAlgorithm = privatePacket.algorithm;
  packet.hashAlgorithm = hashAlgorithm;
  if (signatureExpirationTime !== undefined) {
    packet.signatureNeverExpires = false;
    packet.signatureExpirationTime = signatureExpirationTime;
  }
  await packet.sign(
    privatePacket,
    data,
    new Date(date),
    detached,
    fullConfig(),
  );
  return packet;
}

function signatureArmor(packet, type = pgp.enums.armor.signature) {
  const packets = new pgp.PacketList();
  packets.push(packet);
  return Buffer.from(pgp.armor(type, packets.write()));
}

async function signDocument(privatePacket, document, options = {}) {
  const message = await pgp.createMessage({ binary: new Uint8Array(document) });
  const packet = await signedPacket(
    privatePacket,
    pgp.enums.signature.binary,
    message.packets[0],
    { ...options, detached: true },
  );
  return signatureArmor(packet);
}

async function createSignatureFixture({
  now = DEFAULT_NOW,
  keyDate = DEFAULT_KEY_DATE,
  expired = false,
  signingSubkey = false,
  certificationHash = pgp.enums.hash.sha256,
} = {}) {
  const generate = async (name) => {
    const result = await pgp.generateKey({
      type: "rsa",
      rsaBits: 2048,
      userIDs: [{ name, email: "fixture@example.invalid" }],
      date: new Date(keyDate),
      keyExpirationTime: expired ? 86400 : 0,
      subkeys: [],
      format: "object",
    });
    return result;
  };
  const root = await generate("Test root - NOT official");
  const repository = await generate("Test repository - NOT official");
  let repositoryPrivate = repository.privateKey;
  if (signingSubkey)
    repositoryPrivate = await repositoryPrivate.addSubkey({
      type: "rsa",
      rsaBits: 2048,
      sign: true,
      date: new Date(keyDate + 1000),
      keyExpirationTime: expired ? 86400 : 0,
    });
  const certification = await signedPacket(
    root.privateKey.keyPacket,
    pgp.enums.signature.certGeneric,
    {
      key: repositoryPrivate.keyPacket,
      userID: repositoryPrivate.users[0].userID,
    },
    { date: keyDate + 2000, hashAlgorithm: certificationHash },
  );
  repositoryPrivate.users[0].otherCertifications.push(certification);
  const selected = signingSubkey
    ? repositoryPrivate.subkeys[0].keyPacket
    : repositoryPrivate.keyPacket;
  const fixture = {
    now,
    keyDate,
    rootPrivate: root.privateKey,
    repositoryPrivate,
    rootKey: Buffer.from(root.publicKey.armor()),
    rootFingerprint: root.publicKey.getFingerprint().toUpperCase(),
    repositoryKey: Buffer.from(repositoryPrivate.toPublic().armor()),
    rootRevocation: Buffer.from(root.revocationCertificate),
    repositoryRevocation: Buffer.from(repository.revocationCertificate),
    lookupRevocation: async () => ({ status: 204, bytes: Buffer.alloc(0) }),
    async sign({
      metadata,
      manifest,
      date = now,
      hashAlgorithm = pgp.enums.hash.sha256,
      signatureExpirationTime,
    } = {}) {
      const options = { date, hashAlgorithm, signatureExpirationTime };
      return {
        rootKey: fixture.rootKey,
        rootFingerprint: fixture.rootFingerprint,
        repositoryKey: fixture.repositoryKey,
        metadata,
        manifest,
        metadataSignature: await signDocument(selected, metadata, options),
        manifestSignature: await signDocument(selected, manifest, options),
        lookupRevocation: fixture.lookupRevocation,
      };
    },
  };
  return fixture;
}

module.exports = {
  createSignatureFixture,
  signDocument,
  signedPacket,
  signatureArmor,
  fullConfig,
};
