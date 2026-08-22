import assert from "node:assert/strict";
import test from "node:test";
import { createCompanyFileObjectLoader } from "./object-loader.ts";

const profileId = "14000000-0000-4000-8000-000000000001";
const sha256 = "a".repeat(64);

test("forwards member authority to the NAS gateway", async () => {
	let requestUrl = "";
	let authorization = "";
	let storageDownloads = 0;
	const loader = createCompanyFileObjectLoader({
		gatewayUrl: "https://objects.qorpera.com/",
		internalServiceRequest: false,
		memberToken: "member-token",
		storageDownload: async () => {
			storageDownloads++;
			return new Uint8Array();
		},
		fetch: async (input, init) => {
			const request = new Request(input, init);
			requestUrl = request.url;
			authorization = request.headers.get("authorization") ?? "";
			return new Response(Uint8Array.from([1, 2, 3]));
		},
	});

	assert.deepEqual(await loader(profileId, sha256), Uint8Array.from([1, 2, 3]));
	assert.equal(requestUrl, `https://objects.qorpera.com/v1/profile-objects/${profileId}/${sha256}`);
	assert.equal(authorization, "Bearer member-token");
	assert.equal(storageDownloads, 0);
});

test("uses only the verifier token for internal service reads", async () => {
	let authorization = "";
	const loader = createCompanyFileObjectLoader({
		gatewayUrl: "https://objects.qorpera.com",
		internalServiceRequest: true,
		memberToken: "service-key-must-not-be-forwarded",
		verifierToken: "verifier-token",
		storageDownload: async () => new Uint8Array(),
		fetch: async (input, init) => {
			authorization = new Request(input, init).headers.get("authorization") ?? "";
			return new Response(Uint8Array.from([4]));
		},
	});

	assert.deepEqual(await loader(profileId, sha256), Uint8Array.from([4]));
	assert.equal(authorization, "Bearer verifier-token");
});

test("fails closed when internal gateway authority is missing", () => {
	assert.throws(
		() =>
			createCompanyFileObjectLoader({
				gatewayUrl: "https://objects.qorpera.com",
				internalServiceRequest: true,
				memberToken: "service-key",
				storageDownload: async () => new Uint8Array(),
			}),
		/not configured/,
	);
});

test("retains the Supabase Storage fallback when no gateway is configured", async () => {
	let downloaded = "";
	const loader = createCompanyFileObjectLoader({
		internalServiceRequest: false,
		memberToken: "member-token",
		storageDownload: async (objectProfileId, objectSha256) => {
			downloaded = `${objectProfileId}/${objectSha256}`;
			return Uint8Array.from([5]);
		},
	});

	assert.deepEqual(await loader(profileId, sha256), Uint8Array.from([5]));
	assert.equal(downloaded, `${profileId}/${sha256}`);
});

test("does not fall back after a gateway read is rejected", async () => {
	let storageDownloads = 0;
	const loader = createCompanyFileObjectLoader({
		gatewayUrl: "https://objects.qorpera.com",
		internalServiceRequest: false,
		memberToken: "member-token",
		storageDownload: async () => {
			storageDownloads++;
			return new Uint8Array();
		},
		fetch: async () => Response.json({ error: "denied" }, { status: 403 }),
	});

	await assert.rejects(loader(profileId, sha256), /unavailable/);
	assert.equal(storageDownloads, 0);
});
