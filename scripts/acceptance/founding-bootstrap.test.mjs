import assert from "node:assert/strict";
import test from "node:test";
import { bootstrapAuthorityTransport } from "./founding-bootstrap.mjs";

test("bootstrap authority preserves actual member credentials and refuses remote or Storage fallback", async () => {
	const calls = [];
	const transport = bootstrapAuthorityTransport("https://127.0.0.1:4331", 5433, async (url, init) => {
		calls.push({ url, init });
		return new Response("true");
	});
	const init = {
		method: "POST",
		headers: { authorization: "Bearer actual-member-session", apikey: "public" },
		body: "{}",
	};
	await transport("https://127.0.0.1:4331/rest/v1/rpc/qorpera_authorize_member_company_snapshot_object", init);
	assert.equal(calls[0].url, "http://127.0.0.1:5433/rpc/qorpera_authorize_member_company_snapshot_object");
	assert.deepEqual(calls[0].init.headers, init.headers);
	assert.equal(calls[0].init.body, "{}");
	assert.equal(calls[0].init.redirect, "error");
	for (const url of [
		"https://production.invalid/rest/v1/rpc/qorpera_claim_company_bootstrap",
		"http://127.0.0.1:4331/rest/v1/rpc/qorpera_claim_company_bootstrap",
		"https://127.0.0.1:4331/storage/v1/object/profile-objects/value",
		"https://127.0.0.1:4331/rest/v1/rpc/qorpera_claim_company_bootstrap?redirect=remote",
		"https://127.0.0.1:4331/rest/v1/profiles",
	])
		assert.throws(() => transport(url, init), /only its own/);
	assert.equal(calls.length, 1, "Rejected destinations must not receive any credential");
});
