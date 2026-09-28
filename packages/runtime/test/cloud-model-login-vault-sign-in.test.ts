import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	CodexSignIns,
	type ModelLoginSignInHelper,
	type ModelLoginSignInState,
} from "@qorpera/runtime/cloud-model-login-sign-in";
import { MODEL_LOGIN_FIELD } from "@qorpera/runtime/cloud-model-login-vault";
import {
	CloudModelLoginSignIns,
	type ModelLoginSignInAnswer,
	type ModelLoginSignInAuthority,
} from "@qorpera/runtime/cloud-model-login-vault-sign-in";
import { OfficialCliNativeHarnessDriver } from "@qorpera/runtime/cloud-native-provider-host";
import { CloudSecretBroker, type CloudSecretBrokerAuthority } from "@qorpera/runtime/cloud-secret-broker";
import { HttpCloudSecretBrokerService } from "@qorpera/runtime/cloud-secret-broker-http";
import { CloudSecretKeyring, withCloudSecretFields } from "@qorpera/runtime/cloud-secret-crypto";
import { afterEach, expect, it, vi } from "vitest";

const keyrings: CloudSecretKeyring[] = [];
const closers: Array<() => Promise<void>> = [];
const roots: string[] = [];
afterEach(async () => {
	for (const close of closers.splice(0)) await close();
	for (const keyring of keyrings.splice(0)) keyring.close();
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
const now = Math.floor(Date.now() / 1000);
const LOGIN_FIELDS = {
	OPENAI_API_KEY: null,
	tokens: {
		id_token: `${part({ alg: "RS256" })}.${part({ email: "member@example.test" })}.c2ln`,
		access_token: `${part({ alg: "RS256" })}.${part({ iat: now, exp: now + 864_000 })}.c2ln`,
		refresh_token: "rt-signed-in",
		account_id: "account-1",
	},
	last_refresh: new Date(now * 1000).toISOString(),
};
const LOGIN = `${JSON.stringify(LOGIN_FIELDS)}\n`;
const signal = () => new AbortController().signal;

/** A company, one pending sign-in in a fake database, and the web client's request for it. */
function world(options: { status?: string } = {}) {
	const companyId = randomUUID();
	const loginId = randomUUID();
	const capability = randomBytes(32).toString("base64url");
	const capabilitySha256 = createHash("sha256").update(capability).digest("hex");
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
		modelLoginId: null as string | null,
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
	const database = { failCompletion: false, loseAnswer: false };
	const authority: ModelLoginSignInAuthority = {
		describeModelLoginSignIn: vi.fn(async (request) => {
			if (request.loginId !== loginId || request.capabilitySha256 !== capabilitySha256)
				throw new Error("model login sign-in is unavailable");
			return { ...description };
		}),
		completeModelLoginSignIn: vi.fn(async (completion) => {
			if (database.failCompletion) throw new Error("database unavailable");
			completions.push({ ...completion, encryptedEnvelope: Buffer.from(completion.encryptedEnvelope) });
			description.status = "completed";
			description.modelLoginId = completion.modelLoginId;
			if (database.loseAnswer) throw new Error("answer lost");
			return { schema: "qorpera.model-login-sign-in-complete/v1" };
		}),
		modelLoginBrokerCompany: vi.fn(async () => companyId),
	};
	const request = { companyId, capability, body };
	return {
		companyId,
		loginId,
		capabilitySha256,
		description,
		request,
		wrappingKey,
		keyring,
		authority,
		completions,
		database,
	};
}

type World = ReturnType<typeof world>;

/** A helper whose sign-in state the test sets. */
function scriptedHelper(w: World) {
	let state: ModelLoginSignInState | { status: "unknown" } = { status: "unknown" };
	const helper: ModelLoginSignInHelper = {
		beginSignIn: vi.fn(async () => {
			if (state.status === "unknown") state = { status: "preparing" };
			return state as ModelLoginSignInState;
		}),
		readSignIn: vi.fn(async (request) =>
			request.companyId === w.companyId ? state : { status: "unknown" as const },
		),
		listCompletedSignIns: vi.fn(async (request) =>
			request.companyId === w.companyId && state.status === "completed"
				? [{ signInId: w.loginId, capabilitySha256: w.capabilitySha256 }]
				: [],
		),
		finishSignIn: vi.fn(async () => {
			state = { status: "unknown" };
		}),
	};
	return {
		helper,
		set(next: ModelLoginSignInState | { status: "unknown" }) {
			state = next;
		},
	};
}

async function openVersionOne(w: World): Promise<unknown> {
	const saved = w.completions[0];
	if (!saved) throw new Error("expected a completion");
	expect(saved.envelopeSha256).toBe(createHash("sha256").update(saved.encryptedEnvelope).digest("hex"));
	return withCloudSecretFields(
		saved.encryptedEnvelope,
		w.wrappingKey,
		{
			companyId: w.companyId,
			environmentId: w.description.computeIdentityId,
			secretId: saved.modelLoginId,
			version: 1,
			keyId: "company-kek-1",
		},
		async (fields) => fields[MODEL_LOGIN_FIELD],
	);
}

/** The unchanged web client: it asks while the answer is `preparing`, then only waits. */
async function webClient(signIns: CloudModelLoginSignIns, request: World["request"]): Promise<ModelLoginSignInAnswer> {
	let answer: ModelLoginSignInAnswer;
	do answer = await signIns.signIn(request, signal());
	while (answer.status === "preparing");
	return answer;
}

it("completes a real device sign-in after the web client stops asking at the link and code", async () => {
	const w = world();
	const directory = await mkdtemp(join(tmpdir(), "qorpera-vault-sign-in-e2e-"));
	roots.push(directory);
	const codex = join(directory, "codex");
	await writeFile(
		codex,
		`#!/usr/bin/env node
const [command, flag] = process.argv.slice(2);
if (command === "login" && flag === "status") { process.stdout.write("Logged in using ChatGPT\\n"); process.exit(0); }
if (command !== "login" || flag !== "--device-auth") process.exit(64);
process.stdout.write("Open https://auth.openai.com/codex/device and enter ABCD-12345\\n");
setTimeout(() => {
	require("node:fs").writeFileSync(require("node:path").join(process.env.CODEX_HOME, "auth.json"), ${JSON.stringify(LOGIN)});
	process.exit(0);
}, 400);
`,
	);
	await chmod(codex, 0o755);
	const temporaryRoot = join(directory, "helper");
	await mkdir(temporaryRoot, { mode: 0o700 });
	const helper = new CodexSignIns({
		driver: new OfficialCliNativeHarnessDriver(codex, "/nonexistent/claude"),
		temporaryRoot,
		promptWaitMs: 5000,
	});
	closers.push(() => helper.close());
	const signIns = new CloudModelLoginSignIns({
		authority: w.authority,
		keyring: w.keyring,
		helper,
		collectEveryMs: 50,
	});
	signIns.start();
	closers.push(() => signIns.close());
	expect(await webClient(signIns, w.request)).toMatchObject({
		status: "awaiting_member",
		interaction_url: "https://auth.openai.com/codex/device",
	});
	// No further request comes: the broker collects the finished sign-in itself.
	await vi.waitFor(() => expect(w.description.status).toBe("completed"), { timeout: 5000 });
	await expect(openVersionOne(w)).resolves.toBe(LOGIN);
	expect(w.completions[0]).toMatchObject({ loginId: w.loginId, providerAccountEmail: "member@example.test" });
	expect(Date.parse(w.completions[0]?.accessExpiresAt ?? "") / 1000).toBe(now + 864_000);
	// Finished: the helper holds nothing any longer.
	await vi.waitFor(async () =>
		expect(await helper.readSignIn({ signInId: w.loginId, companyId: w.companyId }, signal())).toEqual({
			status: "unknown",
		}),
	);
});

it("finds a finished sign-in after a broker restart, and completes an already finished one at the member's poll", async () => {
	const w = world();
	const scripted = scriptedHelper(w);
	scripted.set({ status: "completed", authJson: LOGIN, providerAccountReference: "codex-cli:ref" });
	// A broker that restarted knows nothing of the sign-in; its first collection finds it.
	const restarted = new CloudModelLoginSignIns({
		authority: w.authority,
		keyring: w.keyring,
		helper: scripted.helper,
	});
	await restarted.collect();
	expect(w.description.status).toBe("completed");
	await expect(openVersionOne(w)).resolves.toBe(LOGIN);
	expect(w.completions[0]).toMatchObject({ providerAccountReference: "codex-cli:ref" });
	expect(scripted.helper.finishSignIn).toHaveBeenCalledWith(
		{ signInId: w.loginId, companyId: w.companyId },
		expect.any(AbortSignal),
	);
	// A poll that finds the helper already finished completes at once.
	const polled = world();
	const polledHelper = scriptedHelper(polled);
	polledHelper.set({ status: "completed", authJson: LOGIN });
	const signIns = new CloudModelLoginSignIns({
		authority: polled.authority,
		keyring: polled.keyring,
		helper: polledHelper.helper,
	});
	expect((await signIns.signIn(polled.request, signal())).status).toBe("completed");
	// Later polls answer from the database and start nothing.
	vi.mocked(polledHelper.helper.beginSignIn).mockClear();
	expect((await signIns.signIn(polled.request, signal())).status).toBe("completed");
	expect(polledHelper.helper.beginSignIn).not.toHaveBeenCalled();
});

it("keeps a finished login for the next collection when saving fails, and settles one whose answer was lost", async () => {
	const w = world();
	const scripted = scriptedHelper(w);
	scripted.set({ status: "completed", authJson: LOGIN });
	const signIns = new CloudModelLoginSignIns({ authority: w.authority, keyring: w.keyring, helper: scripted.helper });
	w.database.failCompletion = true;
	await signIns.collect();
	expect(w.description.status).toBe("pending");
	expect(scripted.helper.finishSignIn).not.toHaveBeenCalled();
	w.database.failCompletion = false;
	w.database.loseAnswer = true;
	await signIns.collect();
	expect(w.description.status).toBe("completed");
	expect(scripted.helper.finishSignIn).toHaveBeenCalledTimes(1);
	expect(w.completions).toHaveLength(1);
});

it("drops a finished login from the helper once the database keeps refusing it, but not during an outage", async () => {
	const w = world();
	const scripted = scriptedHelper(w);
	scripted.set({ status: "completed", authJson: LOGIN });
	const signIns = new CloudModelLoginSignIns({ authority: w.authority, keyring: w.keyring, helper: scripted.helper });
	// A database outage is no refusal: the helper keeps the login for the next collection.
	vi.mocked(w.authority.describeModelLoginSignIn).mockRejectedValue(new Error("connect ECONNREFUSED"));
	for (let pass = 0; pass < 4; pass += 1) await signIns.collect();
	expect(scripted.helper.finishSignIn).not.toHaveBeenCalled();
	// The company was switched back while the member finished: every lookup is refused.
	vi.mocked(w.authority.describeModelLoginSignIn).mockRejectedValue(
		Object.assign(new Error("model login sign-in is unavailable"), { code: "42501" }),
	);
	await signIns.collect();
	await signIns.collect();
	expect(scripted.helper.finishSignIn).not.toHaveBeenCalled();
	await signIns.collect();
	expect(scripted.helper.finishSignIn).toHaveBeenCalledTimes(1);
	expect(w.authority.completeModelLoginSignIn).not.toHaveBeenCalled();
});

it("ends the helper's copy of a sign-in that failed, ended, holds unknown fields or cannot be sealed", async () => {
	const cases: Array<[string, ModelLoginSignInState]> = [
		["failed", { status: "failed", reason: "sign_in_not_completed" }],
		["unknown fields", { status: "completed", authJson: JSON.stringify({ ...LOGIN_FIELDS, agent_identity: "x" }) }],
	];
	for (const [label, state] of cases) {
		const w = world();
		const scripted = scriptedHelper(w);
		scripted.set(state);
		const signIns = new CloudModelLoginSignIns({
			authority: w.authority,
			keyring: w.keyring,
			helper: scripted.helper,
		});
		await expect(signIns.signIn(w.request, signal()), label).rejects.toThrow();
		expect(scripted.helper.finishSignIn, label).toHaveBeenCalled();
		expect(w.authority.completeModelLoginSignIn, label).not.toHaveBeenCalled();
	}
	const ended = world({ status: "expired" });
	const endedHelper = scriptedHelper(ended);
	await expect(
		new CloudModelLoginSignIns({
			authority: ended.authority,
			keyring: ended.keyring,
			helper: endedHelper.helper,
		}).signIn(ended.request, signal()),
	).rejects.toThrow("ended");
	expect(endedHelper.helper.finishSignIn).toHaveBeenCalled();
	expect(endedHelper.helper.beginSignIn).not.toHaveBeenCalled();
	const unsealable = world();
	const unsealableHelper = scriptedHelper(unsealable);
	unsealableHelper.set({ status: "completed", authJson: LOGIN });
	const otherKey = new CloudSecretKeyring({ "other-kek": randomBytes(32) });
	keyrings.push(otherKey);
	await new CloudModelLoginSignIns({
		authority: unsealable.authority,
		keyring: otherKey,
		helper: unsealableHelper.helper,
	}).collect();
	expect(unsealableHelper.helper.finishSignIn).toHaveBeenCalled();
	expect(unsealable.description.status).toBe("pending");
});

it("refuses a request that differs from the database's pending sign-in, and answers a slow helper as preparing", async () => {
	const w = world();
	const scripted = scriptedHelper(w);
	const signIns = new CloudModelLoginSignIns({ authority: w.authority, keyring: w.keyring, helper: scripted.helper });
	const attempts: Array<[Record<string, unknown>, string?]> = [
		[{ ...w.request.body }, randomUUID()],
		[{ ...w.request.body, client_connection_id: randomUUID() }],
		[{ ...w.request.body, compute_identity_id: randomUUID() }],
		[{ ...w.request.body, compute_identity_owner_user_id: randomUUID() }],
		[{ ...w.request.body, expires_at: new Date(Date.now() + 60_000).toISOString() }],
		[{ ...w.request.body, native_harness: "claude-code" }],
		[{ ...w.request.body, login_capability: randomBytes(32).toString("base64url") }],
		[{ ...w.request.body, refresh_token: "x" }],
	];
	for (const [body, companyId] of attempts)
		await expect(
			signIns.signIn({ companyId: companyId ?? w.companyId, capability: w.request.capability, body }, signal()),
		).rejects.toThrow();
	expect(scripted.helper.beginSignIn).not.toHaveBeenCalled();
	vi.mocked(scripted.helper.beginSignIn).mockRejectedValueOnce(new Error("helper timed out"));
	expect((await signIns.signIn(w.request, signal())).status).toBe("preparing");
	expect(scripted.helper.beginSignIn).toHaveBeenCalledWith(
		{
			signInId: w.loginId,
			companyId: w.companyId,
			computeIdentityId: w.description.computeIdentityId,
			capabilitySha256: w.capabilitySha256,
			expiresAt: w.description.expiresAt,
		},
		expect.any(AbortSignal),
	);
});

it("serves the sign-in route to the sign-in's own capability, uncached, and only when the helper is there", async () => {
	const w = world();
	const scripted = scriptedHelper(w);
	scripted.set({
		status: "awaiting_member",
		interactionUrl: "https://auth.openai.com/codex/device",
		userCode: "ABCD-12345",
	});
	const refuse = vi.fn(async () => {
		throw new Error("not in this test");
	});
	const brokerAuthority: CloudSecretBrokerAuthority = {
		describeCapture: refuse,
		completeCapture: refuse,
		authorizeOperation: refuse,
		authorizeRepositoryCredential: refuse,
	};
	const broker = new CloudSecretBroker({ authority: brokerAuthority, keyring: w.keyring, adapters: [] });
	const runtimeToken = randomBytes(32).toString("base64url");
	const signIns = new CloudModelLoginSignIns({ authority: w.authority, keyring: w.keyring, helper: scripted.helper });
	const withSignIns = new HttpCloudSecretBrokerService(broker, runtimeToken, { modelLoginSignIns: signIns });
	const without = new HttpCloudSecretBrokerService(broker, runtimeToken, {});
	closers.push(
		() => withSignIns.close(),
		() => without.close(),
	);
	const port = await withSignIns.start();
	const post = (servicePort: number, authorization: string | undefined, company = w.companyId) =>
		fetch(`http://127.0.0.1:${servicePort}/v1/model-logins/${company}/login`, {
			method: "POST",
			headers: { ...(authorization ? { authorization } : {}), "content-type": "application/json" },
			body: JSON.stringify(w.request.body),
		});
	expect((await post(await without.start(), `Bearer ${w.request.capability}`)).status).toBe(404);
	const served = await post(port, `Bearer ${w.request.capability}`);
	expect(served.status).toBe(200);
	expect(served.headers.get("cache-control")).toBe("no-store");
	expect(served.headers.get("access-control-allow-origin")).toBeNull();
	expect(await served.json()).toEqual({
		schema: "qorpera.native-provider-login-result/v1",
		login_id: w.loginId,
		status: "awaiting_member",
		interaction_url: "https://auth.openai.com/codex/device",
		user_code: "ABCD-12345",
	});
	vi.mocked(scripted.helper.beginSignIn).mockClear();
	for (const response of [
		await post(port, undefined),
		await post(port, `Bearer ${runtimeToken}`),
		await post(port, `Bearer ${w.request.capability}`, randomUUID()),
	]) {
		expect(response.status).toBe(403);
		expect(await response.json()).toEqual({ schema: "qorpera.cloud-secret-error/v1", error: "unavailable" });
	}
	expect(scripted.helper.beginSignIn).not.toHaveBeenCalled();
});
