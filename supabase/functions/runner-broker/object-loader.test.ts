import assert from "node:assert/strict";
import test from "node:test";
import { createRunnerBrokerObjectLoader } from "./object-loader.ts";

const profileId = "14000000-0000-4000-8000-000000000001";
const sha256 = "a".repeat(64);

test("reads NAS-primary objects with verifier-only authority", async () => {
	let authorization = "";
	let storageDownloads = 0;
	const loader = createRunnerBrokerObjectLoader({
		primary: "nas",
		gatewayUrl: "https://objects.qorpera.com/",
		verifierToken: "verifier-token",
		storageDownload: async () => {
			storageDownloads++;
			return new Uint8Array();
		},
		fetch: async (input, init) => {
			authorization = new Request(input, init).headers.get("authorization") ?? "";
			return new Response(Uint8Array.from([1, 2, 3]));
		},
	});

	assert.deepEqual(await loader(profileId, sha256), Uint8Array.from([1, 2, 3]));
	assert.equal(authorization, "Bearer verifier-token");
	assert.equal(storageDownloads, 0);
});

test("reads explicitly configured Supabase-primary objects directly", async () => {
	let downloaded = "";
	const loader = createRunnerBrokerObjectLoader({
		primary: "supabase",
		storageDownload: async (objectProfileId, objectSha256) => {
			downloaded = `${objectProfileId}/${objectSha256}`;
			return Uint8Array.from([4]);
		},
	});

	assert.deepEqual(await loader(profileId, sha256), Uint8Array.from([4]));
	assert.equal(downloaded, `${profileId}/${sha256}`);
});

test("fails closed when NAS-primary authority is incomplete", () => {
	assert.throws(
		() =>
			createRunnerBrokerObjectLoader({
				primary: "nas",
				gatewayUrl: "https://objects.qorpera.com",
				storageDownload: async () => new Uint8Array(),
			}),
		/not configured/,
	);
});

test("does not fall back after a NAS gateway rejection", async () => {
	let storageDownloads = 0;
	const loader = createRunnerBrokerObjectLoader({
		primary: "nas",
		gatewayUrl: "https://objects.qorpera.com",
		verifierToken: "verifier-token",
		storageDownload: async () => {
			storageDownloads++;
			return new Uint8Array();
		},
		fetch: async () => Response.json({ error: "unavailable" }, { status: 503 }),
	});

	await assert.rejects(loader(profileId, sha256), /unavailable/);
	assert.equal(storageDownloads, 0);
});
