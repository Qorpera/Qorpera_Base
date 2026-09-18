import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("bootstraps only from managed identity, digest-pinned artifacts and host+TPM2-sealed credentials", async () => {
	const script = await readFile(
		resolve(repositoryRoot, "deploy/cloud-secret-broker/azure/bootstrap-step2-secret-custody-canary.sh"),
		"utf8",
	);
	const brokerUnit = await readFile(
		resolve(repositoryRoot, "deploy/cloud-secret-broker/azure/qorpera-cloud-secret-broker-canary.service"),
		"utf8",
	);
	const refreshScript = await readFile(
		resolve(repositoryRoot, "deploy/cloud-secret-broker/azure/refresh-step2-secret-custody-credentials.sh"),
		"utf8",
	);
	assert.match(script, /metadata\/identity\/oauth2\/token/);
	assert.match(script, /metadata_token 'https%3A%2F%2Fvault\.azure\.net'/);
	assert.match(script, /metadata_token 'https%3A%2F%2Fstorage\.azure\.com%2F'/);
	assert.match(script, /systemd-creds encrypt --with-key=host\+tpm2/);
	assert.match(script, /systemd-creds decrypt/);
	assert.match(script, /\/dev\/tpmrm0/);
	assert.match(script, /sha256sum --check --status/);
	assert.match(script, /qorpera-step2-secret-canary-\$\{artifact_sha256\}\.tgz/);
	assert.match(script, /archive contains unexpected entries/);
	assert.match(script, /--no-same-owner --no-same-permissions --no-xattrs/);
	assert.match(script, /manifest inventory differs/);
	assert.match(script, /installed inventory differs/);
	assert.match(script, /jq -jer '\.value'/);
	assert.match(script, /systemctl enable qorpera-cloud-secret-broker-canary\.service/);
	assert.match(script, /systemctl restart qorpera-cloud-secret-broker-canary\.service/);
	assert.ok(!script.includes("systemctl enable --now"));
	assert.match(brokerUnit, /LoadCredentialEncrypted/);
	assert.match(brokerUnit, /LoadCredentialEncrypted=qorpera-cloud-secret-database-url/);
	assert.match(brokerUnit, /LoadCredential=qorpera-cloud-secret-database-ca:/);
	assert.doesNotMatch(brokerUnit, /LoadCredentialEncrypted=qorpera-supabase-service-key/);
	assert.ok(!script.includes("az login"));
	assert.ok(!script.includes("--value"));
	assert.ok(!script.includes("LoadCredential="));
	assert.ok(!script.includes("Environment=QORPERA_"));
	assert.match(refreshScript, /metadata\/identity\/oauth2\/token/);
	assert.match(refreshScript, /jq -jer '\.value'/);
	assert.match(refreshScript, /systemd-creds encrypt --with-key=host\+tpm2/);
	assert.match(refreshScript, /mv "\$\{credential\}" "\/etc\/credstore\.encrypted\/\$\{credential##\*\/\}"/);
	assert.ok(!refreshScript.includes("az login"));
	assert.ok(!refreshScript.includes("--value"));
});
