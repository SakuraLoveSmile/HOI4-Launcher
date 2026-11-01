# XZ decoder materials

IRONCLAD vendors only the 12,558-byte WASM decoder embedded in the original `xz-decompress` 0.2.3 npm package. The package archive, unmodified JS bundle, declared MIT metadata, upstream README, native bridge source, walloc source and applicable MIT/public-domain notices are retained here. Exact source URLs and SHA256 values are recorded in `sources.json`.

`xz-decompress.js` is a source material; the application does not load or execute its JavaScript wrapper. `electron/pdx-xz.cjs` provides a small private bridge to the module's context API. Three persistent section decoders share one isolated WASM instance; the instance's combined linear memory has a hard limit.

Run `node scripts/vendor-xz-wasm.cjs --check` to reproduce and compare the original and bounded module using these saved materials, without network access or evaluating upstream JavaScript/WASM. Omitting `--check` regenerates the two modules and their deterministic `electron/vendor/xz/metadata.json`.

The script pins the package archive, JS bundle and original WASM SHA256. The only transformation changes memory section 5 from `minimum=2 pages, no maximum` to `minimum=2 pages, maximum=1024 pages`. All non-memory-section bytes remain unchanged. Runtime uses the same checked transformation before instantiation and can request a smaller 64 KiB aligned maximum; it cannot exceed 64 MiB. The original module is retained for provenance and is never instantiated by the application.

The decoder does not reconstruct VCDIFF windows or verify source/target ZIP identities. Its caller must validate VCDIFF framing, per-window checksums and the final trusted output hash before installation. Xdelta3 secondary streams can intentionally omit XZ EOF: section success means every supplied byte was consumed and exactly the declared output size was produced. This API does not treat that as proof of a complete standalone XZ file. Decodes must be awaited sequentially; errors, cancellation, disposal or overlapping calls invalidate the whole instance.

Only WASM linear memory is covered by the shared 64 MiB hard maximum. Node input snapshots and returned output buffers have separate per-section limits of 64 MiB; a lower `maxDecodedBytes` can further restrict returned output. Work runs in 64 KiB native input/output batches, yields to the event loop every four decoder iterations, and checks cancellation between batches. Allocation failures and decoder traps discard the instance and expose fixed error codes.

No package dependency, native addon, runtime network fetch, official executable or compiler is required. The wasm byte transformation is reproducible from the shipped package; this does not claim a reproducible recompilation of the original upstream C source/toolchain.
