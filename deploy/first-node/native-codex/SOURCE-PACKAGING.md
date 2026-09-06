# Current source packaging

`source-guest-package-manifest.json` records the complete unsigned output of the
current guest packager in `--contract-only` mode, with its runtime bundle digest.
The package test rebuilds and compares every artifact on both Linux and macOS.
It also verifies each locally generated artifact's bytes and SHA-256 against that
output; the OCI archive and signature remain pinned external references.

After changing runtime inputs or guest packaging, regenerate in this order:

```sh
node scripts/generate-cloud-runtime-bundle.mjs
node scripts/generate-lxd-guest-source-manifest.mjs
```

Review the generated changes, then verify them with:

```sh
node scripts/generate-lxd-guest-source-manifest.mjs --check
node --test scripts/package-lxd-runner-guest.test.mjs scripts/generate-cloud-runtime-bundle.test.mjs
```

`guest-package-manifest.json` remains the sealed v56 image's historical manifest.
Its archive, signature, image fingerprint and acceptance pins must continue to
describe those exact historical bytes. The tests retain their consistency checks.
The source manifest does not contain a newly built native binary or authorize an
image deployment. A new runtime still requires the isolated activation, signed
candidate and current acceptance evidence in
[`RUNTIME-STEPS-0-2-AMENDMENT-RATIFICATION.md`](../RUNTIME-STEPS-0-2-AMENDMENT-RATIFICATION.md).
