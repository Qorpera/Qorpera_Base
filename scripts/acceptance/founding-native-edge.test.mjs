import assert from "node:assert/strict";
import test from "node:test";
import { foundingNativeEdge } from "./founding-native-edge.mjs";

test("actual orchestrator entrypoint hashes capability and refuses SQL-rejected caller before claim", async () => {
	const calls = [];
	const edge = await foundingNativeEdge({
		name: "runner-orchestrator",
		restPort: 12345,
		serviceJwt: "header.payload.signature",
		transport: async (url, init) => {
			calls.push({ url, init });
			return Response.json(false);
		},
	});
	const result = await edge.handler(
		new Request("https://isolated.invalid/functions/v1/runner-orchestrator", {
			method: "POST",
			headers: { authorization: `Bearer ${"A".repeat(43)}`, "content-type": "application/json" },
			body: JSON.stringify({
				action: "claim",
				orchestratorId: "12345678-1234-4234-8234-123456789abc",
				clientClaimId: "12345678-1234-4234-8234-123456789abd",
				leaseSeconds: 120,
			}),
		}),
	);
	assert.equal(result.status, 401);
	assert.equal(calls.length, 1);
	assert.equal(calls[0].url, "http://127.0.0.1:12345/rpc/qorpera_runner_orchestrator_control_valid");
	assert.match(JSON.parse(calls[0].init.body).p_control_token_sha256, /^[0-9a-f]{64}$/);
	assert(!calls[0].init.body.includes("A".repeat(43)));
});

test("actual runner entrypoint denies malformed requests without contacting database", async () => {
	let calls = 0;
	const edge = await foundingNativeEdge({
		name: "runner-control",
		restPort: 12345,
		serviceJwt: "header.payload.signature",
		transport: async () => {
			calls++;
			throw new Error("Unexpected database request");
		},
	});
	assert.equal((await edge.handler(new Request("https://isolated.invalid/", { method: "GET" }))).status, 405);
	assert.equal(
		(await edge.handler(new Request("https://isolated.invalid/", { method: "POST", body: "{}" }))).status,
		400,
	);
	assert.equal(calls, 0);
});
