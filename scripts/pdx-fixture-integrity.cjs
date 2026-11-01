"use strict";

// Only for pre-existing isolated transport/resume fixtures. These tests own
// their unsigned manifest, so they replace the cryptographic boundary while
// exercising the real content parser, stream and installer. Production never
// imports this file; real signature coverage uses the default verifier.
const fixtureIntegrity = Object.freeze({
  async getManifest({ revision, loadResource }) {
    return {
      manifest: await loadResource(`${revision}/complete/manifest`, 64 * 1024),
    };
  },
});
module.exports = { fixtureIntegrity };
