import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { parseCompanyComputerConfigurationMaterial } from "../../packages/contracts/src/company-computer-configuration.ts";
import { officeLifecycleBearerToken } from "./office-lifecycle-credentials.mjs";

test("physical office bearer fixtures satisfy the actual closed configuration contract", () => {
	const material = { configuration: "{}", registry: "isolated-registry-credential-for-acceptance",
		native: officeLifecycleBearerToken(), objects: officeLifecycleBearerToken(), tlsCert: "certificate", tlsKey: "key" };
	assert.deepEqual(parseCompanyComputerConfigurationMaterial(material), material);
	for (const field of ["native", "objects"]) {
		assert.equal(Buffer.from(material[field], "base64url").length, 32);
		assert.throws(() => parseCompanyComputerConfigurationMaterial({ ...material,
			[field]: randomBytes(48).toString("base64url") }), /INVALID_OFFICE_CONFIGURATION_MATERIAL/);
	}
	assert.notEqual(material.native, material.objects);
});
