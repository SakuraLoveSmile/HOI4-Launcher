# CPatch signature test fixtures

The five public resources were fetched anonymously on 2026-10-29 from the public HOI4 mod repository below. No credentials or ZIP body were fetched. Original bytes are preserved for detached-signature verification.

`https://modscontent.paradox-interactive.com/hoi4/6cca83a0-a6ec-11f1-92e5-affbeaa2abe2/repo/Any__Any/`

| Local file          | Resource under repository | SHA-256                                                          |
| ------------------- | ------------------------- | ---------------------------------------------------------------- |
| repository-key.asc  | \_keys/public.gpg         | 47ede5d8c6d05f5806e98227b67ed2517797f3cb911d838b6a4297d97226038b |
| repository.json     | repository.json           | 08599cb49aa8ec14046066ca7ec0cd3a546dd2cb8a17ff7eb29633f8b9de6096 |
| repository.json.asc | repository.json.asc       | 809dd342d836b9660e5cee05b7822f446eb87f5992060c6cb403126a90b7b1f6 |
| manifest            | 12/complete/manifest      | a245e868bd1d2ca203148ba8ded3a3beb6933f9df3cb8e7d67c00c8c1044c9d2 |
| manifest.asc        | 12/complete/manifest.asc  | e0e9a3ba2c5b1a58a147656fd6c2e2de8647ddde2c54ea14d781a106fb9e5162 |

The production root is read from the shipped `electron/keys/pdx-production-root.asc` and pinned by its fingerprint. Its original source was static extraction from the official CPatch binary; see `docs/cpatch-signature-research.md`. Root/repository revocation endpoints both returned HTTP 204 during collection. Tests mock that response and do not treat a stored empty response as fresh revocation status.

`create-fixture.cjs` generates independent RSA test keys in memory and signs small supplied buffers. Its private keys are **test-only**, generated during each test run, unrelated to any account or official key, and never distributed in the application. It also supports deliberately expired keys, weak hashes and invalid dates for rejection tests. Do not import this helper into production code.
