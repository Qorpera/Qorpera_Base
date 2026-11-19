import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("the custody scripts never put a secret on a command line or in a plain unit credential", async () => {
	const script = await readFile(
		resolve(repositoryRoot, "deploy/cloud-secret-broker/azure/bootstrap-step2-secret-custody-canary.sh"),
		"utf8",
	);
	const refreshScript = await readFile(
		resolve(repositoryRoot, "deploy/cloud-secret-broker/azure/refresh-step2-secret-custody-credentials.sh"),
		"utf8",
	);
	assert.ok(!script.includes("az login"));
	assert.ok(!script.includes("--value"));
	assert.ok(!script.includes("LoadCredential="));
	assert.ok(!script.includes("Environment=QORPERA_"));
	assert.ok(!refreshScript.includes("az login"));
	assert.ok(!refreshScript.includes("--value"));
});
