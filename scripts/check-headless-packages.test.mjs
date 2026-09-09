import assert from "node:assert/strict";
import { createHash, webcrypto } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { build } from "esbuild";
import { checkHeadlessPackages } from "./check-headless-packages.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const uuid = (n) => `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

test("browser client completes the existing login protocol using Web Crypto and no Node globals", async () => {
	const bundle = await build({ absWorkingDir: root, entryPoints: ["packages/cloud-client/src/index.ts"],
		platform: "browser", format: "iife", globalName: "QorperaClient", bundle: true, write: false, logLevel: "silent" });
	const context = { crypto: webcrypto, btoa, TextEncoder, TextDecoder, URL, AbortController, AbortSignal,
		setTimeout, clearTimeout, Response, fetch, structuredClone };
	runInNewContext(bundle.outputFiles[0].text, context);
	const client = context.QorperaClient;
	let loginRequest;
	const plane = new client.NativeSubscriptionControlPlane({ rpc: async (method, args) => {
		assert.equal(method, "qorpera_begin_native_provider_login");
		loginRequest = args;
		return { login_id: uuid(1), compute_identity_id: uuid(2), compute_identity_ownership_kind: "member",
			compute_identity_owner_user_id: uuid(3), compute_identity_owner_scope_key: null, provider: "openai",
			native_harness: "codex-cli", expires_at: new Date(Date.now() + 60_000).toISOString() };
	} });
	const authorization = await plane.beginNativeProviderLogin({ profileId: uuid(4), computeIdentityId: uuid(2), provider: "openai", nativeHarness: "codex-cli" });
	assert.match(authorization.capability, /^[A-Za-z0-9_-]{43}$/);
	assert.equal(loginRequest.p_capability_sha256, createHash("sha256").update(authorization.capability).digest("hex"));
	assert(!JSON.stringify(loginRequest).includes(authorization.capability));
	const bridge = new client.HttpNativeProviderIdentityBridge("https://control.example/native/", async (url, request) => {
		assert.equal(url, "https://control.example/native/login");
		assert.equal(request.headers.authorization, `Bearer ${authorization.capability}`);
		assert.equal(request.redirect, "error");
		const body = JSON.parse(request.body);
		assert.equal(body.login_id, authorization.loginId);
		assert.equal(body.compute_identity_id, uuid(2));
		return Response.json({ schema: "qorpera.native-provider-login-result/v1", login_id: uuid(1), status: "awaiting_member", interaction_url: "https://login.example/device", user_code: "FIXTURE" });
	});
	const reply = await bridge.beginLogin(authorization);
	assert.equal(reply.loginId, uuid(1));
	assert.equal(reply.status, "awaiting_member");
	assert.equal(typeof bridge.start, "undefined");
	assert.equal(typeof bridge.startCompany, "undefined");
});

test("headless boundary rejects client imports of runtime authority, including type-only imports", async () => {
	for (const source of ["import type { CloudNativeToolRun } from '@qorpera/runtime/cloud-native-tool-authority';", "export { executeNativeCloudRunnerJob } from '../../runtime/src/cloud-native-provider.ts';"]) {
		const fixture = await mkdtemp(join(tmpdir(), "qorpera-boundary-denial-"));
		try {
			for (const name of ["shell", "runtime", "cloud-client", "member-web"]) await mkdir(join(fixture, `packages/${name}/src`), { recursive: true });
			await writeFile(join(fixture, "packages/cloud-client/src/index.ts"), source);
			await assert.rejects(checkHeadlessPackages(fixture), /Headless package boundary failed/);
		} finally { await rm(fixture, { recursive: true, force: true }); }
	}
});

test("current runtime bundles independently and browser SDK contains no desktop, runtime, or Node adapter", async () => {
	const result = await checkHeadlessPackages();
	assert(result.runtimeSources > 60);
	assert(result.runtimeInputs >= result.runtimeSources);
	assert(result.browserInputs > 1);
	assert(result.webInputs > 1);
});
