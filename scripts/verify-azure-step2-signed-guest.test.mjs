import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const scriptUrl = new URL("../deploy/first-node/verify-azure-step2-signed-guest.sh", import.meta.url);

test("Azure signed-guest acceptance pins provenance before importing or booting", async () => {
	const source = await readFile(scriptUrl, "utf8");
	const provenanceOffset = source.indexOf('node "${PROVENANCE_TOOL}" verify');
	const importOffset = source.indexOf('lxc image import "${IMAGE_ARCHIVE}"');
	const bootOffset = source.indexOf('lxc init "${EXPECTED_IMAGE_FINGERPRINT}"');

	assert.match(source, /EXPECTED_HOSTNAME="qorpera-step2-compat-01"/);
	assert.match(source, /EXPECTED_NODE_PACKAGE_VERSION="22\.22\.1\+dfsg\+~cs22\.19\.15-1ubuntu1"/);
	assert.match(source, /EXPECTED_ZFSUTILS_PACKAGE_VERSION="2\.4\.1-1ubuntu5"/);
	assert.match(
		source,
		/EXPECTED_IMAGE_FINGERPRINT="f3f763287ee3fe7ba3e31926be8341b2e1567e35283e129f673edb4d5a75d67a"/,
	);
	assert.match(
		source,
		/EXPECTED_PROVENANCE_SHA256="d5bf211f0244290515ffd13eb67581245c8ed767775c54f17ee7e8fb4af22cd8"/,
	);
	assert.ok(provenanceOffset > 0);
	assert.ok(importOffset > provenanceOffset);
	assert.ok(bootOffset > provenanceOffset);
	assert.match(source.slice(bootOffset), /--profile "\$\{LXD_PROFILE\}"/);
	assert.match(source.slice(bootOffset), /--storage "\$\{LXD_POOL\}"/);
	assert.match(source.slice(bootOffset), /--config boot\.mode=uefi-secureboot/);
	assert.match(source.slice(bootOffset), /--config limits\.cpu=2/);
	assert.match(source.slice(bootOffset), /--config limits\.memory=4GiB/);
	assert.doesNotMatch(source, /qorpera-azure-pilot\.vcRgjP/);
});

test("Azure signed-guest acceptance proves fail-closed synthetic boundaries and retained replay", async () => {
	const source = await readFile(scriptUrl, "utf8");

	assert.match(source, /--provenance "\$\{PROVENANCE\}"/);
	assert.match(source, /--public-key "\$\{PUBLIC_KEY\}"/);
	assert.match(source, /PRIVATE_RESULT_FENCE_AND_REVOCATION_CONFIRMED/);
	assert.match(source, /NATIVE_ISOLATION_PROBE_PASSED/);
	assert.match(source, /AZURE_STEP2_SYNTHETIC_BOUNDARIES_VERIFIED/);
	assert.match(source, /AZURE_STEP2_SIGNED_GUEST_REBOOT_REPLAY_PASSED/);
	assert.match(source, /outer_boot_id=/);
	assert.match(source, /guest_boot_id=/);
	assert.match(source, /marker_sha256=/);
	assert.match(source, /sync -f '\$\{PERSISTENCE_MARKER\}'/);
	assert.match(source, /lxc stop "\$\{INSTANCE\}" --project "\$\{LXD_PROJECT\}" --timeout 120/);
	assert.match(source, /zpool sync qorpera-azure-step2/);
	assert.match(source, /\[\[ \$\(cat \/proc\/sys\/kernel\/random\/boot_id\) != "\$\{outer_boot_id\}" \]\]/);
	assert.match(source, /\[\[ \$\{new_guest_boot_id\} != "\$\{guest_boot_id\}" \]\]/);
	assert.match(source, /Refusing to remove an unrecognized instance/);
	assert.match(source, /! mountpoint -q \/var\/lib\/qorpera\/identity/);
	assert.match(source, /\[\[ ! -e \/qorpera\/company-live \]\]/);
	assert.match(source, /core\.https_address/);
	assert.match(source, /\(\^\|:\)\(8443\)\$/);
	assert.match(source, /snap list lxd \| awk 'NR == 2 \{ print \$NF \}'/);
	assert.match(source, /apt-mark showhold \| grep -Fxq "\$\{held_package\}"/);
	assert.match(source, /AZURE_STEP2_SIGNED_GUEST_VERIFIER_STAGED/);
});
