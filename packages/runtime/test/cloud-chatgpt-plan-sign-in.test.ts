import { createHash, randomBytes, randomUUID } from "node:crypto";
import { CHATGPT_PLAN_LOGIN_FIELD, ChatGptPlanOAuth, parseChatGptPlanLogin } from "@qorpera/runtime/cloud-chatgpt-plan";
import { ChatGptPlanSignIns } from "@qorpera/runtime/cloud-chatgpt-plan-sign-in";
import {
	CloudModelLoginSignIns,
	type ModelLoginSignInAuthority,
} from "@qorpera/runtime/cloud-model-login-vault-sign-in";
import { CloudSecretBroker, type CloudSecretBrokerAuthority } from "@qorpera/runtime/cloud-secret-broker";
import { HttpCloudSecretBrokerService } from "@qorpera/runtime/cloud-secret-broker-http";
import { CloudSecretKeyring, withCloudSecretFields } from "@qorpera/runtime/cloud-secret-crypto";
import { afterEach, expect, it, vi } from "vitest";
import { fakeOpenAi } from "./fixtures/chatgpt-plan-openai.ts";

const keyrings: CloudSecretKeyring[] = [];
const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const close of closers.splice(0)) await close();
	for (const keyring of keyrings.splice(0)) keyring.close();
});

const HOST = "urn:uuid:3d2c6a1e-7b4f-4c55-9a1e-2f6b8c9d0e1f";
const signal = () => new AbortController().signal;

/** A company, one pending plan sign-in in a fake database, the web client's request for it, and OpenAI. */
function world(options: { kind?: "codex" | "chatgpt_plan"; now?: () => number } = {}) {
	const openai = fakeOpenAi({ ...(options.now ? { now: options.now } : {}) });
	const companyId = randomUUID();
	const loginId = randomUUID();
	const capability = randomBytes(32).toString("base64url");
	const capabilitySha256 = createHash("sha256").update(capability).digest("hex");
	const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
	const kind = options.kind ?? "chatgpt_plan";
	const description = {
		schema: "qorpera.model-login-sign-in/v2",
		loginId,
		loginKind: kind,
		profileId: companyId,
		computeIdentityId: randomUUID(),
		computeIdentityOwnershipKind: "member",
		computeIdentityOwnerUserId: randomUUID(),
		computeIdentityOwnerScopeKey: null,
		clientConnectionId: randomUUID(),
		hostId: kind === "chatgpt_plan" ? HOST : null,
		status: "pending",
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
	const completions: Array<Parameters<ModelLoginSignInAuthority["completeChatGptPlanSignIn"]>[0]> = [];
	const database = { refuseCompletion: false };
	const authority: ModelLoginSignInAuthority = {
		describeModelLoginSignIn: vi.fn(async (request) => {
			if (request.loginId !== loginId || request.capabilitySha256 !== capabilitySha256)
				throw Object.assign(new Error("model login sign-in is unavailable"), { code: "42501" });
			return { ...description };
		}),
		completeModelLoginSignIn: vi.fn(async () => {
			throw new Error("not a Codex sign-in");
		}),
		modelLoginBrokerCompany: vi.fn(async () => companyId),
		completeChatGptPlanSignIn: vi.fn(async (completion) => {
			if (database.refuseCompletion) throw Object.assign(new Error("sign-in is unavailable"), { code: "55000" });
			completions.push({ ...completion, encryptedEnvelope: Buffer.from(completion.encryptedEnvelope) });
			description.status = "completed";
			description.modelLoginId = completion.modelLoginId;
			return { schema: "qorpera.model-login-sign-in-complete/v1" };
		}),
	};
	const oauth = new ChatGptPlanOAuth({ client: openai.client, fetch: openai.fetch });
	const plan = new ChatGptPlanSignIns({ oauth, authority, keyring, ...(options.now ? { now: options.now } : {}) });
	const signIns = new CloudModelLoginSignIns({ authority, keyring, plan });
	return {
		openai,
		companyId,
		loginId,
		capability,
		description,
		body,
		wrappingKey,
		keyring,
		authority,
		completions,
		database,
		signIns,
	};
}

type World = ReturnType<typeof world>;

const poll = (w: World) =>
	w.signIns.signIn({ companyId: w.companyId, capability: w.capability, body: w.body }, signal());

const confirm = (w: World, confirmation: unknown, capability = w.capability, loginId = w.loginId) =>
	w.signIns.confirmChatGptPlan(
		{
			companyId: w.companyId,
			capability,
			body: { schema: "qorpera.chatgpt-plan-confirm/v1", login_id: loginId, confirmation },
		},
		signal(),
	);

it("answers a plan sign-in's poll with OpenAI's address, the same one while the member signs in", async () => {
	const w = world();
	const first = await poll(w);
	expect(first).toMatchObject({ login_id: w.loginId, status: "awaiting_member", user_code: null });
	const url = new URL(first.interaction_url as string);
	expect(url.searchParams.get("state")).toMatch(new RegExp(`^${w.companyId}\\.[A-Za-z0-9_-]{43}$`));
	expect(url.searchParams.get("ext_agent_host_id")).toBe(HOST);
	expect(url.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
	expect((await poll(w)).interaction_url).toBe(first.interaction_url);
});

it("completes only after the starting browser confirms: one code, one confirmation, one login", async () => {
	const w = world();
	const { code, state } = w.openai.consent((await poll(w)).interaction_url as string, { subject: "user-abc" });
	const { confirmation } = w.signIns.receiveChatGptPlan({
		companyId: w.companyId,
		state,
		code,
		error: null,
		clientId: null,
	});
	// Nothing was exchanged at the callback.
	expect(w.openai.requests.filter((request) => request.form.get("grant_type") === "authorization_code")).toHaveLength(
		0,
	);
	// The same callback again finds no state.
	expect(() =>
		w.signIns.receiveChatGptPlan({ companyId: w.companyId, state, code, error: null, clientId: null }),
	).toThrow("state_unknown");
	expect(await confirm(w, confirmation)).toEqual({
		schema: "qorpera.native-provider-login-result/v1",
		login_id: w.loginId,
		status: "completed",
		interaction_url: null,
		user_code: null,
	});
	const saved = w.completions[0];
	if (!saved) throw new Error("expected a completion");
	expect(saved).toMatchObject({
		loginId: w.loginId,
		keyId: "company-kek-1",
		providerAccountReference: null,
		providerAccountEmail: "member@example.test",
	});
	expect(saved.renewNotBefore).not.toBeNull();
	const login = await withCloudSecretFields(
		saved.encryptedEnvelope,
		w.wrappingKey,
		{
			companyId: w.companyId,
			environmentId: w.description.computeIdentityId,
			secretId: saved.modelLoginId,
			version: 1,
			keyId: "company-kek-1",
		},
		async (fields) => parseChatGptPlanLogin(fields[CHATGPT_PLAN_LOGIN_FIELD] as string),
	);
	expect(login).toMatchObject({ subject: "user-abc", hostId: HOST, clientId: w.openai.clientId });
	expect(login.accessIssuedAt).toBe(saved.accessIssuedAt);
	// The confirmation is spent.
	await expect(confirm(w, confirmation)).rejects.toThrow("state_unknown");
	// A completed sign-in's poll says so.
	expect((await poll(w)).status).toBe("completed");
});

it("never completes for another browser: a wrong capability or sign-in burns the confirmation", async () => {
	const w = world();
	let lastUrl = (await poll(w)).interaction_url;
	const back = () => w.openai.consent(lastUrl as string, { subject: "user-abc" });
	let { code, state } = back();
	let { confirmation } = w.signIns.receiveChatGptPlan({
		companyId: w.companyId,
		state,
		code,
		error: null,
		clientId: null,
	});
	await expect(confirm(w, confirmation, randomBytes(32).toString("base64url"))).rejects.toThrow("state_unknown");
	await expect(confirm(w, confirmation)).rejects.toThrow("state_unknown");
	lastUrl = (await poll(w)).interaction_url;
	({ code, state } = back());
	({ confirmation } = w.signIns.receiveChatGptPlan({
		companyId: w.companyId,
		state,
		code,
		error: null,
		clientId: null,
	}));
	await expect(confirm(w, confirmation, w.capability, randomUUID())).rejects.toThrow("state_unknown");
	expect(w.completions).toHaveLength(0);
	expect(w.openai.requests.filter((request) => request.form.get("grant_type") === "authorization_code")).toHaveLength(
		0,
	);
});

it("refuses a callback for another company, another client, a declined consent, or after its time", async () => {
	let clock = Date.now();
	const w = world({ now: () => clock });
	const { code, state } = w.openai.consent((await poll(w)).interaction_url as string, { subject: "user-abc" });
	expect(() =>
		w.signIns.receiveChatGptPlan({ companyId: randomUUID(), state, code, error: null, clientId: null }),
	).toThrow("state_unknown");
	expect(() =>
		w.signIns.receiveChatGptPlan({ companyId: w.companyId, state, code, error: null, clientId: "oaiapp_other" }),
	).toThrow("provider_error");
	// The state was used up by that callback: the next poll starts a new one.
	const again = w.openai.consent((await poll(w)).interaction_url as string, { subject: "user-abc" });
	expect(() =>
		w.signIns.receiveChatGptPlan({
			companyId: w.companyId,
			state: again.state,
			code: null,
			error: "access_denied",
			clientId: null,
		}),
	).toThrow("declined");
	const late = w.openai.consent((await poll(w)).interaction_url as string, { subject: "user-abc" });
	clock += 11 * 60_000;
	expect(() =>
		w.signIns.receiveChatGptPlan({
			companyId: w.companyId,
			state: late.state,
			code: late.code,
			error: null,
			clientId: null,
		}),
	).toThrow();
});

it("ends a login at OpenAI when the database refuses to keep it", async () => {
	const w = world();
	const { code, state } = w.openai.consent((await poll(w)).interaction_url as string, { subject: "user-abc" });
	const { confirmation } = w.signIns.receiveChatGptPlan({
		companyId: w.companyId,
		state,
		code,
		error: null,
		clientId: null,
	});
	w.database.refuseCompletion = true;
	await expect(confirm(w, confirmation)).rejects.toThrow("provider_error");
	expect(w.openai.revoked.size).toBe(1);
});

it("refuses a Codex sign-in where only plan sign-ins are served, and a plan sign-in without a plan client", async () => {
	const codex = world({ kind: "codex" });
	await expect(poll(codex)).rejects.toThrow("Codex sign-ins are not served");
	const w = world();
	const helperOnly = new CloudModelLoginSignIns({
		authority: w.authority,
		keyring: w.keyring,
		helper: {
			beginSignIn: vi.fn(),
			readSignIn: vi.fn(),
			listCompletedSignIns: vi.fn(async () => []),
			finishSignIn: vi.fn(),
		},
	});
	await expect(
		helperOnly.signIn({ companyId: w.companyId, capability: w.capability, body: w.body }, signal()),
	).rejects.toThrow("ChatGPT plan sign-ins are not served");
	expect(() => new CloudModelLoginSignIns({ authority: w.authority, keyring: w.keyring })).toThrow();
});

it("serves the callback and the confirmation over the vault's routes", async () => {
	const w = world();
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
	const service = new HttpCloudSecretBrokerService(broker, randomBytes(32).toString("base64url"), {
		modelLoginSignIns: w.signIns,
	});
	closers.push(() => service.close());
	const port = await service.start();
	const post = (path: string, body: unknown, authorization?: string) =>
		fetch(`http://127.0.0.1:${port}/v1/model-logins/${w.companyId}/${path}`, {
			method: "POST",
			headers: { "content-type": "application/json", ...(authorization ? { authorization } : {}) },
			body: JSON.stringify(body),
		});
	const started = await post("login", w.body, `Bearer ${w.capability}`);
	const { code, state } = w.openai.consent(((await started.json()) as { interaction_url: string }).interaction_url, {
		subject: "user-abc",
	});
	const failed = await post("chatgpt-plan/callback", {
		schema: "qorpera.chatgpt-plan-callback/v1",
		state: `${w.companyId}.${"A".repeat(43)}`,
		code,
		error: null,
		clientId: null,
	});
	expect(await failed.json()).toEqual({
		schema: "qorpera.chatgpt-plan-callback-result/v1",
		status: "failed",
		confirmation: null,
		reason: "state_unknown",
	});
	const back = await post("chatgpt-plan/callback", {
		schema: "qorpera.chatgpt-plan-callback/v1",
		state,
		code,
		error: null,
		clientId: null,
	});
	const received = (await back.json()) as { status: string; confirmation: string; reason: null };
	expect(received).toMatchObject({
		schema: "qorpera.chatgpt-plan-callback-result/v1",
		status: "confirm",
		reason: null,
	});
	const confirmBody = {
		schema: "qorpera.chatgpt-plan-confirm/v1",
		login_id: w.loginId,
		confirmation: received.confirmation,
	};
	const stranger = await post("chatgpt-plan/confirm", confirmBody, `Bearer ${randomBytes(32).toString("base64url")}`);
	expect(stranger.status).toBe(403);
	expect(await stranger.json()).toEqual({ schema: "qorpera.chatgpt-plan-confirm-failed/v1", reason: "state_unknown" });
	expect(w.completions).toHaveLength(0);
	// The stranger burned it; the member's browser gets a fresh one from a new sign-in round.
	const restarted = await post("login", w.body, `Bearer ${w.capability}`);
	const second = w.openai.consent(((await restarted.json()) as { interaction_url: string }).interaction_url, {
		subject: "user-abc",
	});
	const secondBack = (await (
		await post("chatgpt-plan/callback", {
			schema: "qorpera.chatgpt-plan-callback/v1",
			state: second.state,
			code: second.code,
			error: null,
			clientId: null,
		})
	).json()) as { confirmation: string };
	const confirmed = await post(
		"chatgpt-plan/confirm",
		{ ...confirmBody, confirmation: secondBack.confirmation },
		`Bearer ${w.capability}`,
	);
	expect(confirmed.status).toBe(200);
	expect(await confirmed.json()).toMatchObject({ status: "completed", login_id: w.loginId });
	expect(w.completions).toHaveLength(1);
	// Malformed bodies are refused without detail.
	const malformed = await post("chatgpt-plan/callback", { schema: "qorpera.chatgpt-plan-callback/v1", state });
	expect(malformed.status).toBe(403);
});
