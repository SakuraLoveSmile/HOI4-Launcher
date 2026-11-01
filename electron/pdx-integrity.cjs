"use strict";

const { createPdxSignatureVerifier } = require("./pdx-signature.cjs");
const MAX_REPOSITORY = 2 * 1024 * 1024;
const MAX_KEY = 64 * 1024;
const MAX_SIGNATURE = 16 * 1024;
const MAX_MANIFEST = 64 * 1024;
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const object = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
function invalid() {
  const error = new Error("Paradox 返回的模组信息无效或与请求版本不符。");
  error.code = "INVALID_METADATA";
  return error;
}
function createPdxIntegrity({
  now,
  verifier = createPdxSignatureVerifier({ now }),
} = {}) {
  if (typeof verifier?.verify !== "function")
    throw new TypeError("Invalid signature verifier");
  return Object.freeze({
    async getManifest({
      revision,
      fromRevision,
      loadResource,
      lookupRevocation,
    } = {}) {
      if (
        typeof revision !== "string" ||
        !/^[1-9]\d{0,15}$/.test(revision) ||
        /\D/.test(revision) ||
        !Number.isSafeInteger(Number(revision)) ||
        (fromRevision !== undefined &&
          (typeof fromRevision !== "string" ||
            !(
              fromRevision === "-1" ||
              (/^[1-9]\d{0,15}$/.test(fromRevision) &&
                Number.isSafeInteger(Number(fromRevision)))
            ) ||
            /[\r\n]/.test(fromRevision) ||
            fromRevision === revision)) ||
        typeof loadResource !== "function" ||
        typeof lookupRevocation !== "function"
      )
        throw invalid();
      // No key cache: each resolve, including a reopened transfer, obtains the
      // current key and revocation state. Signed bytes are never decoded or
      // parsed until both detached signatures have been verified.
      const load = async (resource, limit) => {
        const value = await loadResource(resource, limit);
        if (!Buffer.isBuffer(value) || !value.length || value.length > limit)
          throw invalid();
        return Buffer.from(value);
      };
      const repositoryKey = await load("_keys/public.gpg", MAX_KEY);
      const metadata = await load("repository.json", MAX_REPOSITORY);
      const metadataSignature = await load(
        "repository.json.asc",
        MAX_SIGNATURE,
      );
      const folder =
        fromRevision === undefined
          ? "complete"
          : `${fromRevision}_to_${revision}`;
      const manifest = await load(
        `${revision}/${folder}/manifest`,
        MAX_MANIFEST,
      );
      const manifestSignature = await load(
        `${revision}/${folder}/manifest.asc`,
        MAX_SIGNATURE,
      );
      const verification = await verifier.verify({
        repositoryKey,
        metadata,
        metadataSignature,
        manifest,
        manifestSignature,
        lookupRevocation,
      });
      let parsed;
      try {
        parsed = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(metadata),
        );
      } catch {
        throw invalid();
      }
      if (
        !object(parsed) ||
        parsed.version !== "0.3" ||
        !object(parsed.content) ||
        !object(parsed.content.versions) ||
        !own(parsed.content.versions, revision)
      )
        throw invalid();
      const version = parsed.content.versions[revision];
      if (
        !object(version) ||
        typeof version.completeSize !== "string" ||
        !/^[1-9]\d{0,15}$/.test(version.completeSize) ||
        /\D/.test(version.completeSize) ||
        !Number.isSafeInteger(Number(version.completeSize)) ||
        (own(version, "patches") && !object(version.patches))
      )
        throw invalid();
      let patchSize, patchUnpackedSize;
      if (fromRevision !== undefined) {
        const selected =
          object(version.patches) &&
          own(version.patches, fromRevision) &&
          version.patches[fromRevision];
        if (
          !object(selected) ||
          [selected.sizePacked, selected.sizeUnpacked].some(
            (value, index) =>
              typeof value !== "string" ||
              !(index === 1 ? /^(?:0|[1-9]\d{0,15})$/ : /^[1-9]\d{0,15}$/).test(
                value,
              ) ||
              /\D/.test(value) ||
              !Number.isSafeInteger(Number(value)),
          )
        )
          throw invalid();
        patchSize = Number(selected.sizePacked);
        patchUnpackedSize = Number(selected.sizeUnpacked);
      }
      return {
        manifest,
        completeSize: Number(version.completeSize),
        verification,
        ...(object(version.patches) ? { patches: version.patches } : {}),
        ...(fromRevision !== undefined ? { patchSize, patchUnpackedSize } : {}),
      };
    },
  });
}

module.exports = { createPdxIntegrity };
