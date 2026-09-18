import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const scriptUrl = new URL("../deploy/first-node/bootstrap-azure-step2-pilot-lxd.sh", import.meta.url);

test("Azure pilot LXD bootstrap formats only the exact empty retained disk", async () => {
	const source = await readFile(scriptUrl, "utf8");
	const destructiveOffset = source.indexOf("lxd init --preseed");

	assert.match(source, /EXPECTED_HOSTNAME="qorpera-step2-compat-01"/);
	assert.match(source, /EXPECTED_DATA_DISK_LINK="\/dev\/disk\/azure\/data\/by-lun\/0"/);
	assert.match(source, /EXPECTED_DATA_DISK_BYTES=274877906944/);
	assert.match(source, /--preflight-only\|--format-empty-pilot-disk\|--stage-self EXPECTED_SHA256/);
	assert.match(source, /AZURE_STEP2_BOOTSTRAP_STAGED/);
	assert.match(source, /!source_started && \/\^export arg\[0-9\]\+=\//);
	assert.match(source, /Azure Run Command changed the submitted bootstrap bytes/);
	assert.match(source, /install -o root -g root -m 0600 "\$\{stage_tmp\}" "\$\{PILOT_BOOTSTRAP\}"/);
	assert.match(source, /wipefs --no-act --noheadings "\$\{data_disk\}"/);
	assert.match(source, /state=empty-unformatted-unmounted/);
	assert.ok(destructiveOffset > source.indexOf("wipefs --no-act"));
	assert.ok(destructiveOffset > source.indexOf("findmnt --raw --noheadings --source"));
	assert.match(source.slice(destructiveOffset), /source: \$\{EXPECTED_DATA_DISK_LINK\}/);
	assert.match(source.slice(destructiveOffset), /source\.wipe: "true"/);
	assert.doesNotMatch(source, /company41-node-01/);
});

test("Azure pilot LXD bootstrap pins the existing VM and network boundary", async () => {
	const source = await readFile(scriptUrl, "utf8");

	assert.match(source, /EXPECTED_LXD_VERSION="6\.9-ab8fad2"/);
	assert.match(source, /EXPECTED_LXD_REVISION="40424"/);
	assert.match(source, /EXPECTED_NODE_PACKAGE_VERSION="22\.22\.1\+dfsg\+~cs22\.19\.15-1ubuntu1"/);
	assert.match(source, /EXPECTED_NODE_VERSION="v22\.22\.1"/);
	assert.match(source, /EXPECTED_ZFSUTILS_PACKAGE_VERSION="2\.4\.1-1ubuntu5"/);
	assert.match(source, /"nodejs=\$\{EXPECTED_NODE_PACKAGE_VERSION\}"/);
	assert.match(source, /"zfsutils-linux=\$\{EXPECTED_ZFSUTILS_PACKAGE_VERSION\}"/);
	assert.match(source, /dpkg-query --show --showformat='\$\{Version\}' nodejs/);
	assert.match(source, /dpkg-query --show --showformat='\$\{Version\}' zfsutils-linux/);
	assert.match(source, /apt-mark hold nodejs zfsutils-linux/);
	assert.match(source, /snap refresh --hold=forever lxd/);
	assert.match(source, /lxc config unset core\.https_address/);
	assert.match(source, /security\.mac_filtering=true/);
	assert.match(source, /security\.ipv4_filtering=true/);
	assert.match(source, /security\.ipv6_filtering=true/);
	assert.match(source, /security\.port_isolation=true/);
	assert.match(source, /boot\.mode=uefi-secureboot/);
	assert.match(source, /security\.devlxd=false/);
	assert.match(source, /\(\^\|:\)\(8443\)\$/);
});
