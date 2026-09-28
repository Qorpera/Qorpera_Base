import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { ModelLoginSignInHelper, ModelLoginSignInState } from "@qorpera/runtime/cloud-model-login-sign-in";
import { MODEL_LOGIN_FIELD } from "@qorpera/runtime/cloud-model-login-vault";
import {
	CloudModelLoginSignIns,
	type ModelLoginSignInAuthority,
} from "@qorpera/runtime/cloud-model-login-vault-sign-in";
import { CloudSecretBroker, type CloudSecretBrokerAuthority } from "@qorpera/runtime/cloud-secret-broker";
import { HttpCloudSecretBrokerService } from "@qorpera/runtime/cloud-secret-broker-http";
import { CloudSecretKeyring, withCloudSecretFields } from "@qorpera/runtime/cloud-secret-crypto";
import { afterEach, expect, it, vi } from "vitest";

const keyrings: CloudSecretKeyring[] = [];
const services: HttpCloudSecretBrokerService[] = [];
afterEach(async () => {
	for (const service of services.splice(0)) await service.close();
	for (const keyring of keyrings.splice(0)) keyring.close();
});

const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
const now = Math.floor(Date.now() / 1000);
const LOGIN = `${JSON.stringify({
	OPENAI_API_KEY: null,
	tokens: {
		id_token: `${part({ alg: "RS256" })}.${part({ email: "member@example.test" })}.c2ln`,
		access_token: `${part({ alg: "RS256" })}.${part({ iat: now, exp: now + 864_000 })}.c2ln`,
		refresh_token: "rt-signed-in",
		account_id: "account-1",
	},
	last_refresh: new Date(now * 1000).toISOString(),
})}\n`;

function fixture(states: ModelLoginSignInState[], options: { status?: string; completeFails?: boolean } = {}) {
	const companyId = randomUUID();
	const loginId = randomUUID();
	const capability = randomBytes(32).toString("base64url");
	const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
	const description = {
		schema: "qorpera.model-login-sign-in/v1",
		loginId,
		profileId: companyId,
		computeIdentityId: randomUUID(),
		computeIdentityOwnershipKind: "member",
		computeIdentityOwnerUserId: randomUUID(),
		computeIdentityOwnerScopeKey: null,
		clientConnectionId: randomUUID(),
		status: options.status ?? "pending",
		expiresAt,
		keyId: "company-kek-1",
		modelLoginId: null,
	};
	const body = {
		schema: "qorpera.native-provider-login/v1",
		login_id: loginId,
		client_connection_id: description.clientConnectionId,
		compute_identity_id: description.computeIdentityId,
		compute_identity_ownership_kind: "member",
		compute_identity_owner_user_id: description.computeIdentityOwnerUserId,
		compute_identity_owner_scope_key: null,
		provider: "openai",
		native_harness: "codex-cli",
		login_capability: capability,
		expires_at: expiresAt,
	};
	const wrappingKey = randomBytes(32);
	const keyring = new CloudSecretKeyring({ "company-kek-1": wrappingKey });
	keyrings.push(keyring);
	const completions: Array<Parameters<ModelLoginSignInAuthority["completeModelLoginSignIn"]>[0]> = [];
	const authority: ModelLoginSignInAuthority = {
		describeModelLoginSignIn: vi.fn(async (request) => {
			expect(request).toEqual({ loginId, capabilitySha256: createHash("sha256").update(capability).digest("hex") });
			return { ...description };
		}),
		completeModelLoginSignIn: vi.fn(async (completion) => {
			completions.push({ ...completion, encryptedEnvelope: Buffer.from(completion.encryptedEnvelope) });
			if (options.completeFails) throw new Error("answer lost");
			description.status = "completed";
			return { schema: "qorpera.model-login-sign-in-complete/v1" };
		}),
	};
	const queue = [...states];
	const helper: ModelLoginSignInHelper = {
		beginSignIn: vi.fn(async (): Promise<ModelLoginSignInState> => queue.shift() ?? { status: "preparing" }),
		finishSignIn: vi.fn(async () => undefined),
	};
	const signIns = new CloudModelLoginSignIns({ authority, keyring, helper });
	return { companyId, loginId, capability, body, description, wrappingKey, authority, helper, signIns, completions };
}

const signal = () => new AbortController().signal;

it("answers the member's poll with the link and code, then seals and completes the login as version 1", async () => {
	const f = fixture([
		{ status: "preparing" },
		{ status: "awaiting_member", interactionUrl: "https://auth.openai.com/codex/device", userCode: "ABCD-12345" },
		{
			status: "completed",
			authJson: LOGIN,
			providerAccountEmail: "member@example.test",
			providerAccountReference: "codex-cli:ref",
		},
	]);
	const poll = () => f.signIns.signIn({ companyId: f.companyId, capability: f.capability, body: f.body }, signal());
	expect(await poll()).toEqual({
		schema: "qorpera.native-provider-login-result/v1",
		login_id: f.loginId,
		status: "preparing",
		interaction_url: null,
		user_code: null,
	});
	expect(await poll()).toMatchObject({
		status: "awaiting_member",
		interaction_url: "https://auth.openai.com/codex/device",
		user_code: "ABCD-12345",
	});
	expect(await poll()).toMatchObject({ status: "completed", interaction_url: null, user_code: null });
	expect(f.helper.beginSignIn).toHaveBeenCalledWith(
		{ signInId: f.loginId, expiresAt: f.description.expiresAt },
		expect.any(AbortSignal),
	);
	const saved = f.completions[0];
	if (!saved) throw new Error("expected a completion");
	expect(saved).toMatchObject({
		loginId: f.loginId,
		keyId: "company-kek-1",
		providerAccountEmail: "member@example.test",
		providerAccountReference: "codex-cli:ref",
		envelopeSha256: createHash("sha256").update(saved.encryptedEnvelope).digest("hex"),
	});
	expect(Date.parse(saved.accessExpiresAt) / 1000).toBe(now + 864_000);
	// Version 1 of this login under the company's key: the full login, renewal token included.
	await expect(
		withCloudSecretFields(
			saved.encryptedEnvelope,
			f.wrappingKey,
			{
				companyId: f.companyId,
				environmentId: f.description.computeIdentityId,
				secretId: saved.modelLoginId,
				version: 1,
				keyId: "company-kek-1",
			},
			async (fields) => fields[MODEL_LOGIN_FIELD],
		),
	).resolves.toBe(LOGIN);
	expect(f.helper.finishSignIn).toHaveBeenCalledWith(f.loginId, expect.any(AbortSignal));
	// Completed: later polls answer from the database and never start Codex again.
	(f.helper.beginSignIn as ReturnType<typeof vi.fn>).mockClear();
	expect((await poll()).status).toBe("completed");
	expect(f.helper.beginSignIn).not.toHaveBeenCalled();
});

it("refuses a request that differs from the database's pending sign-in, before any Codex runs", async () => {
	const f = fixture([{ status: "awaiting_member", userCode: "ABCD-12345" }]);
	const attempts: Array<[string, Record<string, unknown>, string?]> = [
		["another company", { ...f.body }, randomUUID()],
		["another connection", { ...f.body, client_connection_id: randomUUID() }],
		["another identity", { ...f.body, compute_identity_id: randomUUID() }],
		["another owner", { ...f.body, compute_identity_owner_user_id: randomUUID() }],
		["another expiry", { ...f.body, expires_at: new Date(Date.now() + 60_000).toISOString() }],
		["a Claude sign-in", { ...f.body, native_harness: "claude-code" }],
		[
			"a capability in the body that is not the bearer",
			{ ...f.body, login_capability: randomBytes(32).toString("base64url") },
		],
		["an extra field", { ...f.body, refresh_token: "x" }],
	];
	for (const [, body, companyId] of attempts)
		await expect(
			f.signIns.signIn({ companyId: companyId ?? f.companyId, capability: f.capability, body }, signal()),
		).rejects.toThrow();
	expect(f.helper.beginSignIn).not.toHaveBeenCalled();
	const ended = fixture([], { status: "expired" });
	await expect(
		ended.signIns.signIn({ companyId: ended.companyId, capability: ended.capability, body: ended.body }, signal()),
	).rejects.toThrow("ended");
	expect(ended.helper.beginSignIn).not.toHaveBeenCalled();
});

it("ends a failed sign-in, refuses a login with unknown fields, and settles a completion whose answer was lost", async () => {
	const failed = fixture([{ status: "failed", reason: "sign_in_not_completed" }]);
	await expect(
		failed.signIns.signIn(
			{ companyId: failed.companyId, capability: failed.capability, body: failed.body },
			signal(),
		),
	).rejects.toThrow("failed");
	expect(failed.helper.finishSignIn).toHaveBeenCalled();
	const odd = fixture([
		{ status: "completed", authJson: JSON.stringify({ ...JSON.parse(LOGIN), agent_identity: "x" }) },
	]);
	await expect(
		odd.signIns.signIn({ companyId: odd.companyId, capability: odd.capability, body: odd.body }, signal()),
	).rejects.toThrow();
	expect(odd.authority.completeModelLoginSignIn).not.toHaveBeenCalled();
	// The database completed it, but the answer never came back: the next look finds it complete.
	const lost = fixture([{ status: "completed", authJson: LOGIN }], { completeFails: true });
	(lost.authority.describeModelLoginSignIn as ReturnType<typeof vi.fn>)
		.mockResolvedValueOnce({ ...lost.description })
		.mockResolvedValueOnce({ ...lost.description, status: "completed" });
	expect(
		(await lost.signIns.signIn({ companyId: lost.companyId, capability: lost.capability, body: lost.body }, signal()))
			.status,
	).toBe("completed");
	// Not completed after all: the failure stands and the member tries again.
	const refused = fixture([{ status: "completed", authJson: LOGIN }], { completeFails: true });
	await expect(
		refused.signIns.signIn(
			{ companyId: refused.companyId, capability: refused.capability, body: refused.body },
			signal(),
		),
	).rejects.toThrow("answer lost");
});

it("serves the sign-in route to the sign-in's own capability, uncached, and only when the helper is there", async () => {
	const f = fixture([
		{ status: "awaiting_member", interactionUrl: "https://auth.openai.com/codex/device", userCode: "ABCD-12345" },
	]);
	const refuse = vi.fn(async () => {
		throw new Error("not in this test");
	});
	const brokerAuthority: CloudSecretBrokerAuthority = {
		describeCapture: refuse,
		completeCapture: refuse,
		authorizeOperation: refuse,
		authorizeRepositoryCredential: refuse,
	};
	const keyring = new CloudSecretKeyring({ "company-kek-1": randomBytes(32) });
	keyrings.push(keyring);
	const broker = new CloudSecretBroker({ authority: brokerAuthority, keyring, adapters: [] });
	const runtimeToken = randomBytes(32).toString("base64url");
	const withSignIns = new HttpCloudSecretBrokerService(broker, runtimeToken, { modelLoginSignIns: f.signIns });
	const without = new HttpCloudSecretBrokerService(broker, runtimeToken, {});
	services.push(withSignIns, without);
	const port = await withSignIns.start();
	const post = (servicePort: number, authorization: string | undefined, company = f.companyId) =>
		fetch(`http://127.0.0.1:${servicePort}/v1/model-logins/${company}/login`, {
			method: "POST",
			headers: { ...(authorization ? { authorization } : {}), "content-type": "application/json" },
			body: JSON.stringify(f.body),
		});
	expect((await post(await without.start(), `Bearer ${f.capability}`)).status).toBe(404);
	const served = await post(port, `Bearer ${f.capability}`);
	expect(served.status).toBe(200);
	expect(served.headers.get("cache-control")).toBe("no-store");
	expect(served.headers.get("access-control-allow-origin")).toBeNull();
	expect(await served.json()).toEqual({
		schema: "qorpera.native-provider-login-result/v1",
		login_id: f.loginId,
		status: "awaiting_member",
		interaction_url: "https://auth.openai.com/codex/device",
		user_code: "ABCD-12345",
	});
	// No bearer, the runtime token, or another company's address: nothing is started.
	(f.helper.beginSignIn as ReturnType<typeof vi.fn>).mockClear();
	for (const response of [
		await post(port, undefined),
		await post(port, `Bearer ${runtimeToken}`),
		await post(port, `Bearer ${f.capability}`, randomUUID()),
	]) {
		expect(response.status).toBe(403);
		expect(await response.json()).toEqual({ schema: "qorpera.cloud-secret-error/v1", error: "unavailable" });
	}
	expect(f.helper.beginSignIn).not.toHaveBeenCalled();
});
