"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const openpgp = require("openpgp");

const ROOT_FINGERPRINT = "AF28077C9C565B53F3CD5A65788AA56D99D64E1C";
const MAX_KEY = 64 * 1024;
const MAX_SIGNATURE = 16 * 1024;
const MAX_DOCUMENT = 8 * 1024 * 1024;
const SAFE_ERROR = Symbol("pdx-signature-error");

function failure(code = "SIGNATURE_INVALID") {
  const error = new Error("下载文件校验失败，请重新下载。");
  error.code = code;
  error[SAFE_ERROR] = true;
  return error;
}

function bytes(value, maximum) {
  if (!Buffer.isBuffer(value) || !value.length || value.length > maximum)
    throw failure();
  return Buffer.from(value);
}

function armor(value, type) {
  const text = value.toString("ascii");
  if (
    value.some((byte) => byte > 127) ||
    !new RegExp(
      `^\\s*-----BEGIN PGP ${type}-----[\\s\\S]*-----END PGP ${type}-----\\s*$`,
    ).test(text) ||
    (text.match(/-----BEGIN PGP /g) || []).length !== 1 ||
    (text.match(/-----END PGP /g) || []).length !== 1
  )
    throw failure();
  return text;
}

function configuration() {
  // SHA-1 is required by the official, pinned legacy key certifications.
  // It remains forbidden for every content signature. No global config changes.
  return {
    ...openpgp.config,
    rejectHashAlgorithms: new Set([
      openpgp.enums.hash.md5,
      openpgp.enums.hash.ripemd,
    ]),
    rejectMessageHashAlgorithms: new Set([
      openpgp.enums.hash.md5,
      openpgp.enums.hash.ripemd,
      openpgp.enums.hash.sha1,
      openpgp.enums.hash.sha224,
    ]),
    minRSABits: 2048,
    ignoreMalformedPackets: false,
    ignoreUnsupportedPackets: false,
    allowInsecureVerificationWithReformattedKeys: false,
  };
}

function validTime(value) {
  return value instanceof Date && Number.isFinite(value.getTime());
}

function checkDates(signature, date, earliest) {
  if (
    !validTime(signature.created) ||
    signature.created > date ||
    (earliest && signature.created < earliest) ||
    !(signature.getExpirationTime() > date)
  )
    throw failure();
}

async function readKey(value, config) {
  const keys = await openpgp.readKeys({
    armoredKeys: armor(value, "PUBLIC KEY BLOCK"),
    config,
  });
  if (keys.length !== 1 || keys[0].isPrivate()) throw failure();
  return keys[0];
}

async function readSingleSignature(value, type, config) {
  const unarmored = await openpgp.unarmor(armor(value, type));
  const input = unarmored.data;
  if (!(input instanceof Uint8Array) || input.length < 2 || !(input[0] & 0x80))
    throw failure();
  let offset = 1,
    length;
  if (input[0] & 0x40) {
    if ((input[0] & 0x3f) !== openpgp.enums.packet.signature) throw failure();
    const first = input[offset++];
    if (first < 192) length = first;
    else if (first <= 223) {
      if (input.length < 3) throw failure();
      length = ((first - 192) << 8) + input[offset++] + 192;
    } else if (first === 255) {
      if (input.length < 6) throw failure();
      length = new DataView(
        input.buffer,
        input.byteOffset + offset,
        4,
      ).getUint32(0);
      offset += 4;
    } else throw failure(); // Partial-length signatures are not this protocol.
  } else {
    if (((input[0] >> 2) & 0x0f) !== openpgp.enums.packet.signature)
      throw failure();
    const lengthType = input[0] & 3;
    if (lengthType === 3) throw failure();
    const lengthBytes = 1 << lengthType;
    if (input.length < offset + lengthBytes) throw failure();
    length = 0;
    for (let index = 0; index < lengthBytes; index++)
      length = length * 256 + input[offset++];
  }
  // The library deliberately ignores marker/trust/padding packets. Check the
  // framing as well so those cannot hide extra packets behind a valid signature.
  if (length < 1 || offset + length !== input.length) throw failure();
  const signature = await openpgp.readSignature({
    binarySignature: input,
    config,
  });
  if (signature.packets.length !== 1) throw failure();
  return signature.packets[0];
}

async function primary(key, date, config, status) {
  if (!validTime(key.getCreationTime()) || key.getCreationTime() > date)
    throw failure();
  try {
    await key.verifyPrimaryKey(date, {}, config);
  } catch (error) {
    // CPatch explicitly accepts expired legacy keys. This exception applies
    // only after valid current self-certification and revocation checks, and
    // does not ignore an expired/future signature or any other validation error.
    if (error.message === "Primary key is expired") status.expired = true;
    else if (error.message === "Primary key is revoked")
      throw failure("KEY_REVOKED");
    else throw error;
  }
  const user = await key.getPrimaryUser(date, {}, config);
  checkDates(user.selfCertification, date, key.getCreationTime());
  return user;
}

function hasFlag(signature, flag) {
  return !!(signature.keyFlags?.[0] & flag);
}

async function signingKey(key, issuer, signedAt, date, config, status) {
  await primary(key, date, config, status);
  const user = await key.getPrimaryUser(signedAt, {}, config);
  checkDates(user.selfCertification, signedAt, key.getCreationTime());
  // getSigningKey(null date) retains cryptographic self/binding/back-signature,
  // signing capability, key size and algorithm checks. Dates are checked below.
  const selected = await key.getSigningKey(issuer, null, {}, config);
  if (
    !validTime(selected.getCreationTime()) ||
    selected.getCreationTime() > signedAt ||
    key.getCreationTime() > signedAt
  )
    throw failure();
  if (selected === key) {
    if (!hasFlag(user.selfCertification, openpgp.enums.keyFlags.signData))
      throw failure();
    return selected;
  }
  const data = { key: key.keyPacket, bind: selected.keyPacket };
  let binding;
  for (const candidate of [...selected.bindingSignatures].sort(
    (a, b) => b.created - a.created,
  )) {
    try {
      checkDates(candidate, signedAt, selected.getCreationTime());
      await candidate.verify(
        key.keyPacket,
        openpgp.enums.signature.subkeyBinding,
        data,
        signedAt,
        false,
        config,
      );
      binding = candidate;
      break;
    } catch {}
  }
  if (
    !binding ||
    !hasFlag(binding, openpgp.enums.keyFlags.signData) ||
    !binding.embeddedSignature
  )
    throw failure();
  if (await selected.isRevoked(binding, null, date, config))
    throw failure("KEY_REVOKED");
  checkDates(binding.embeddedSignature, signedAt, selected.getCreationTime());
  await binding.embeddedSignature.verify(
    selected.keyPacket,
    openpgp.enums.signature.keyBinding,
    data,
    signedAt,
    false,
    config,
  );
  try {
    await selected.verify(date, config);
  } catch (error) {
    if (error.message === "Subkey is expired") status.expired = true;
    else if (error.message === "Subkey is revoked")
      throw failure("KEY_REVOKED");
    else throw error;
  }
  return selected;
}

async function rootCertification(root, repository, date, config, status) {
  const rootUser = await primary(root, date, config, status);
  if (!hasFlag(rootUser.selfCertification, openpgp.enums.keyFlags.certifyKeys))
    throw failure();
  for (const user of repository.users) {
    for (const certificate of user.otherCertifications) {
      if (
        ![0x10, 0x11, 0x12, 0x13].includes(certificate.signatureType) ||
        !certificate.issuerKeyID.equals(root.getKeyID())
      )
        continue;
      try {
        checkDates(certificate, date, repository.getCreationTime());
        if (certificate.created < root.getCreationTime()) continue;
        await signingKey(
          root,
          root.getKeyID(),
          certificate.created,
          date,
          config,
          status,
        );
        await user.verify(date, config);
        if (await user.isRevoked(certificate, root.keyPacket, date, config))
          continue;
        await certificate.verify(
          root.keyPacket,
          certificate.signatureType,
          {
            key: repository.keyPacket,
            userID: user.userID,
            userAttribute: user.userAttribute,
          },
          date,
          false,
          config,
        );
        return;
      } catch {}
    }
  }
  throw failure();
}

async function checkRevocation(key, lookup, date, config) {
  let response;
  try {
    response = await lookup(key.getFingerprint().toUpperCase());
  } catch {
    throw failure("SIGNATURE_UNAVAILABLE");
  }
  if (
    !response ||
    !Buffer.isBuffer(response.bytes) ||
    response.bytes.length > MAX_KEY
  )
    throw failure("SIGNATURE_UNAVAILABLE");
  if (
    response.status === 404 ||
    (response.status === 204 && response.bytes.length === 0)
  )
    return;
  if (response.status !== 200) throw failure("SIGNATURE_UNAVAILABLE");
  const packet = await readSingleSignature(
    bytes(response.bytes, MAX_KEY),
    "PUBLIC KEY BLOCK",
    config,
  );
  if (
    packet.signatureType !== openpgp.enums.signature.keyRevocation ||
    !packet.issuerKeyID.equals(key.getKeyID())
  )
    throw failure();
  checkDates(packet, date, key.getCreationTime());
  await packet.verify(
    key.keyPacket,
    openpgp.enums.signature.keyRevocation,
    { key: key.keyPacket },
    date,
    false,
    config,
  );
  throw failure("KEY_REVOKED");
}

async function documentSignature(document, value, key, date, config, status) {
  const packet = await readSingleSignature(value, "SIGNATURE", config);
  if (
    packet.signatureType !== openpgp.enums.signature.binary ||
    ![
      openpgp.enums.hash.sha256,
      openpgp.enums.hash.sha384,
      openpgp.enums.hash.sha512,
    ].includes(packet.hashAlgorithm)
  )
    throw failure();
  checkDates(packet, date, key.getCreationTime());
  const selected = await signingKey(
    key,
    packet.issuerKeyID,
    packet.created,
    date,
    config,
    status,
  );
  const message = await openpgp.createMessage({
    binary: new Uint8Array(document),
  });
  // The packet API is required: high-level verify always rechecks key expiry at
  // signature creation time, even when its own date option is null.
  await packet.verify(
    selected.keyPacket,
    openpgp.enums.signature.binary,
    message.packets[0],
    date,
    true,
    config,
  );
}

function createPdxSignatureVerifier({
  rootKey,
  rootFingerprint = ROOT_FINGERPRINT,
  now = Date.now,
} = {}) {
  if (
    typeof rootFingerprint !== "string" ||
    !/^[0-9a-f]{40}$/i.test(rootFingerprint) ||
    typeof now !== "function"
  )
    throw failure();
  const configuredRoot = rootKey === undefined ? null : bytes(rootKey, MAX_KEY);
  const expected = rootFingerprint.toUpperCase();
  return {
    async verify(request = {}) {
      try {
        const {
          repositoryKey,
          metadata,
          metadataSignature,
          manifest,
          manifestSignature,
          lookupRevocation,
        } = request;
        if (typeof lookupRevocation !== "function") throw failure();
        // Copy caller-owned buffers before the first await.
        const input = {
          repositoryKey: bytes(repositoryKey, MAX_KEY),
          metadata: bytes(metadata, MAX_DOCUMENT),
          metadataSignature: bytes(metadataSignature, MAX_SIGNATURE),
          manifest: bytes(manifest, MAX_DOCUMENT),
          manifestSignature: bytes(manifestSignature, MAX_SIGNATURE),
        };
        const date = new Date(now());
        if (!validTime(date)) throw failure();
        const config = configuration(),
          status = { expired: false };
        const root = await readKey(
          configuredRoot ||
            bytes(
              await fs.readFile(
                path.join(__dirname, "keys", "pdx-production-root.asc"),
              ),
              MAX_KEY,
            ),
          config,
        );
        if (root.getFingerprint().toUpperCase() !== expected) throw failure();
        await primary(root, date, config, status);
        await checkRevocation(root, lookupRevocation, date, config);
        const repository = await readKey(input.repositoryKey, config);
        await primary(repository, date, config, status);
        await rootCertification(root, repository, date, config, status);
        await checkRevocation(repository, lookupRevocation, date, config);
        await documentSignature(
          input.metadata,
          input.metadataSignature,
          repository,
          date,
          config,
          status,
        );
        await documentSignature(
          input.manifest,
          input.manifestSignature,
          repository,
          date,
          config,
          status,
        );
        return {
          rootFingerprint: expected,
          repositoryFingerprint: repository.getFingerprint().toUpperCase(),
          legacyExpiredKeys: status.expired,
        };
      } catch (error) {
        throw error?.[SAFE_ERROR] ? error : failure();
      }
    },
  };
}

module.exports = { createPdxSignatureVerifier };
