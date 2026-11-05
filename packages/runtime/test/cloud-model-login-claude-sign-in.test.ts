import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelLoginHelperClient, ModelLoginHelperService } from "@qorpera/runtime/cloud-model-login-helper";
import {
	CLAUDE_LOGIN_FILES_SCHEMA,
	CodexSignIns,
	type ModelLoginSignInBinding,
	type ModelLoginSignInHelper,
	type ModelLoginSignInState,
} from "@qorpera/runtime/cloud-model-login-sign-in";
import {
	CLAUDE_LOGIN_FIELD,
	ClaudeCodeRefused,
	CloudModelLoginSignIns,
	type ModelLoginSignInAuthority,
} from "@qorpera/runtime/cloud-model-login-vault-sign-in";
import { NATIVE_CLAUDE_SIGN_IN_EGRESS_HOSTS } from "@qorpera/runtime/cloud-native-egress";
import { nativeIsolationEgressHosts, nativeIsolationInvocation } from "@qorpera/runtime/cloud-native-isolation";
import { OfficialCliNativeHarnessDriver } from "@qorpera/runtime/cloud-native-provider-host";
import { CloudSecretKeyring } from "@qorpera/runtime/cloud-secret-crypto";
import { afterEach, expect, it, vi } from "vitest";

const roots: string[] = [];
const closers: Array<() => Promise<void>> = [];
const keyrings: CloudSecretKeyring[] = [];
afterEach(async () => {
	for (const close of closers.splice(0)) await close();
	for (const keyring of keyrings.splice(0)) keyring.close();
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function temporary(prefix: string): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), prefix));
	roots.push(root);
	return root;
}

const signal = () => new AbortController().signal;
const GOOD_CODE = "anthropic-code-1234#state-5678";
const CREDENTIALS = '{"claudeAiOauth":{"accessToken":"sk-ant-oat-test","refreshToken":"sk-ant-ort-test"}}';
const SETTINGS = '{"oauthAccount":{"emailAddress":"member@example.test"}}';

/** A stand-in for the official `claude auth login --claudeai` and `claude auth status`: prints Anthropic's link, then
 * reads one line; the right code writes Claude Code's two login files, any other is refused, as Claude Code does. */
async function fakeClaude(): Promise<string> {
	const directory = await temporary("qorpera-fake-claude-");
	const path = join(directory, "claude");
	await writeFile(
		path,
		`#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const [command, flag] = process.argv.slice(2);
const config = process.env.CLAUDE_CONFIG_DIR;
if (command === "auth" && flag === "status") {
	const loggedIn = fs.existsSync(path.join(config, ".credentials.json"));
	process.stdout.write(JSON.stringify({ loggedIn, authMethod: "claude.ai", email: loggedIn ? "member@example.test" : undefined }));
	process.exit(loggedIn ? 0 : 1);
}
if (command !== "auth" || flag !== "login" || process.argv[4] !== "--claudeai") process.exit(64);
process.stdout.write("Opening browser to sign in…\\nIf the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&state=abc\\nPaste code here if prompted > ");
let input = "";
process.stdin.on("data", (chunk) => {
	input += chunk;
	if (!input.includes("\\n")) return;
	if (input.trim() !== ${JSON.stringify(GOOD_CODE)}) {
		process.stderr.write("Invalid code. Please make sure the full code was copied.\\n");
		process.exit(1);
	}
	fs.writeFileSync(path.join(config, ".credentials.json"), ${JSON.stringify(CREDENTIALS)});
	fs.writeFileSync(path.join(config, ".claude.json"), ${JSON.stringify(SETTINGS)});
	process.stdout.write("Login successful.\\n");
	process.exit(0);
});
`,
	);
	await chmod(path, 0o755);
	return path;
}

async function claudeSignIns(options: { claude?: boolean } = {}) {
	const temporaryRoot = await temporary("qorpera-claude-sign-in-root-");
	const service = new CodexSignIns({
		driver: new OfficialCliNativeHarnessDriver("/nonexistent/codex", await fakeClaude()),
		temporaryRoot,
		promptWaitMs: 5000,
		claude: options.claude ?? true,
	});
	closers.push(() => service.close());
	return { service, temporaryRoot };
}

function binding(overrides: Partial<ModelLoginSignInBinding> = {}): ModelLoginSignInBinding {
	return {
		signInId: randomUUID(),
		companyId: randomUUID(),
		computeIdentityId: randomUUID(),
		capabilitySha256: randomBytes(32).toString("hex"),
		expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
		harness: "claude-code",
		...overrides,
	};
}

function files(state: ModelLoginSignInState | { status: "unknown" }): Record<string, string> {
	if (state.status !== "completed") throw new Error(`expected a completed sign-in, got ${state.status}`);
	const value = JSON.parse(state.authJson) as { schema: string; files: Record<string, string> };
	expect(value.schema).toBe(CLAUDE_LOGIN_FILES_SCHEMA);
	return Object.fromEntries(
		Object.entries(value.files).map(([name, bytes]) => [name, Buffer.from(bytes, "base64").toString("utf8")]),
	);
}

it("runs the official Claude sign-in, takes Anthropic's code once and keeps Claude Code's login files as they are", async () => {
	const { service, temporaryRoot } = await claudeSignIns();
	const signIn = binding();
	const target = { signInId: signIn.signInId, companyId: signIn.companyId };
	// Anthropic's page, and no device code (the prompt's "code here" is no code).
	expect(await service.beginSignIn(signIn, signal())).toEqual({
		status: "awaiting_member",
		interactionUrl: "https://claude.com/cai/oauth/authorize?code=true&state=abc",
	});
	// Another company's view of the same sign-in knows nothing, and its code is not taken.
	expect(await service.submitCode({ ...target, companyId: randomUUID(), code: GOOD_CODE }, signal())).toEqual({
		status: "unknown",
	});
	const state = await service.submitCode({ ...target, code: GOOD_CODE }, signal());
	expect(files(state)).toEqual({ ".credentials.json": CREDENTIALS, ".claude.json": SETTINGS });
	expect(state).toMatchObject({ providerAccountEmail: "member@example.test" });
	expect(await service.listCompletedSignIns({ companyId: signIn.companyId }, signal())).toEqual([
		{ signInId: signIn.signInId, capabilitySha256: signIn.capabilitySha256 },
	]);
	// Once only.
	await expect(service.submitCode({ ...target, code: GOOD_CODE }, signal())).rejects.toThrow();
	// Claude Code has stopped: its home is gone; the login lives in memory until the broker ends it.
	await vi.waitFor(async () => expect(await readdir(temporaryRoot)).toEqual([]));
	await service.finishSignIn(target, signal());
	expect(await service.readSignIn(target, signal())).toEqual({ status: "unknown" });
});

it("fails a Claude sign-in whose code Claude Code refused, and one the helper cannot run", async () => {
	const { service } = await claudeSignIns();
	const signIn = binding();
	const target = { signInId: signIn.signInId, companyId: signIn.companyId };
	await service.beginSignIn(signIn, signal());
	expect(await service.submitCode({ ...target, code: "not-the-code-at-all" }, signal())).toEqual({
		status: "failed",
		reason: "sign_in_not_completed",
	});
	// A Codex sign-in takes no code, and a binding cannot switch harness.
	const codex = binding({ harness: undefined });
	const { service: plain } = await claudeSignIns({ claude: false });
	await plain.beginSignIn(codex, signal()).catch(() => undefined);
	await expect(
		plain.submitCode({ signInId: codex.signInId, companyId: codex.companyId, code: GOOD_CODE }, signal()),
	).rejects.toThrow();
	await expect(plain.beginSignIn({ ...codex, harness: "claude-code" }, signal())).rejects.toThrow(
		"Sign-in belongs to another company or capability",
	);
	// Without the pinned Claude Code, a Claude sign-in fails at once.
	const other = binding();
	await vi.waitFor(async () =>
		expect(await plain.beginSignIn(other, signal())).toEqual({ status: "failed", reason: "claude_unavailable" }),
	);
});

it("carries a Claude sign-in's harness and its code over the helper's socket, to the client that began it only", async () => {
	const directory = await temporary("qorpera-claude-helper-");
	const socketPath = join(directory, "helper.sock");
	const token = randomBytes(32).toString("base64url");
	const signIn = binding();
	const target = { signInId: signIn.signInId, companyId: signIn.companyId };
	const completed = {
		status: "completed" as const,
		authJson: JSON.stringify({ schema: CLAUDE_LOGIN_FILES_SCHEMA, files: { ".credentials.json": "e30=" } }),
	};
	const fake: ModelLoginSignInHelper = {
		beginSignIn: vi.fn(async () => ({ status: "awaiting_member" as const, interactionUrl: "https://claude.com/x" })),
		readSignIn: vi.fn(async () => completed),
		listCompletedSignIns: vi.fn(async () => []),
		finishSignIn: vi.fn(async () => undefined),
		submitCode: vi.fn(async () => completed),
	};
	const service = new ModelLoginHelperService({ socketPath, token, renewer: { renew: vi.fn() }, signIns: fake });
	await service.start();
	closers.push(() => service.close());
	const client = new ModelLoginHelperClient({ socketPath, token });
	await expect(client.beginSignIn(signIn, signal())).resolves.toEqual({
		status: "awaiting_member",
		interactionUrl: "https://claude.com/x",
	});
	expect(fake.beginSignIn).toHaveBeenCalledWith(signIn, expect.any(AbortSignal));
	await expect(client.submitCode({ ...target, code: GOOD_CODE }, signal())).resolves.toEqual(completed);
	expect(fake.submitCode).toHaveBeenCalledWith({ ...target, code: GOOD_CODE }, expect.any(AbortSignal));
	// A code that is no line of printable text never reaches the helper's sign-ins.
	await expect(client.submitCode({ ...target, code: "two\nlines" }, signal())).rejects.toThrow();
	await expect(client.beginSignIn({ ...signIn, harness: "codex-cli" as never }, signal())).rejects.toThrow();
	expect(fake.submitCode).toHaveBeenCalledTimes(1);
});

it("runs Claude Code in the sandbox with its own config directory and Anthropic's sign-in hosts alone", () => {
	expect(nativeIsolationEgressHosts(undefined, "claude-code")).toBe(NATIVE_CLAUDE_SIGN_IN_EGRESS_HOSTS);
	expect(NATIVE_CLAUDE_SIGN_IN_EGRESS_HOSTS).toEqual(["platform.claude.com", "api.anthropic.com"]);
	const invocation = nativeIsolationInvocation({
		configuration: { entryPoint: "/opt/qorpera/native-entry.mjs" },
		command: "/opt/qorpera/claude",
		args: ["auth", "login", "--claudeai"],
		scratchRoot: "/run/helper/qorpera-native-auth-1",
		codexHome: "/run/helper/qorpera-sign-in-1/claude",
		relayPath: "/run/helper/qorpera-native-auth-1/egress.sock",
		harness: "claude-code",
	});
	const environment = new Map<string, string>();
	for (let index = 0; index < invocation.args.length; index += 1)
		if (invocation.args[index] === "--setenv")
			environment.set(invocation.args[index + 1] as string, invocation.args[index + 2] as string);
	expect(environment.get("CLAUDE_CONFIG_DIR")).toBe("/run/helper/qorpera-sign-in-1/claude");
	expect(environment.get("DISABLE_AUTOUPDATER")).toBe("1");
	expect(environment.get("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC")).toBe("1");
	expect(environment.has("CODEX_HOME")).toBe(false);
	expect(invocation.args).toContain("--unshare-net");
	expect(() =>
		nativeIsolationInvocation({
			configuration: { entryPoint: "/opt/qorpera/native-entry.mjs" },
			command: "/opt/qorpera/claude",
			args: [],
			scratchRoot: "/run/helper/qorpera-native-auth-1",
			codexHome: "/run/helper/qorpera-sign-in-1/claude",
			relayPath: "/run/helper/qorpera-native-auth-1/egress.sock",
			harness: "claude-code",
			chatGptPlan: { accessToken: "token" },
		}),
	).toThrow("A Claude sign-in runs alone");
});

/** The shared vault: a member's pending Claude sign-in in a fake database, and the web client's request for it. */
function vault() {
	const companyId = randomUUID();
	const loginId = randomUUID();
	const memberId = randomUUID();
	const capability = randomBytes(32).toString("base64url");
	const capabilitySha256 = createHash("sha256").update(capability).digest("hex");
	const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
	const description = {
		schema: "qorpera.model-login-sign-in/v2",
		loginId,
		loginKind: "claude",
		hostId: null,
		profileId: companyId,
		computeIdentityId: randomUUID(),
		computeIdentityOwnershipKind: "member",
		computeIdentityOwnerUserId: memberId,
		computeIdentityOwnerScopeKey: null,
		clientConnectionId: randomUUID(),
		status: "pending",
		expiresAt,
		keyId: "vault-root-1",
		modelLoginId: null as string | null,
		scope: "account",
	};
	const body = {
		schema: "qorpera.native-provider-login/v1",
		login_id: loginId,
		client_connection_id: description.clientConnectionId,
		compute_identity_id: description.computeIdentityId,
		compute_identity_ownership_kind: "member",
		compute_identity_owner_user_id: memberId,
		compute_identity_owner_scope_key: null,
		provider: "anthropic",
		native_harness: "claude-code",
		login_capability: capability,
		expires_at: expiresAt,
	};
	const keyring = new CloudSecretKeyring({}, { "vault-root-1": randomBytes(32) });
	keyrings.push(keyring);
	const completions: Array<Parameters<NonNullable<ModelLoginSignInAuthority["completeClaudeLoginSignIn"]>>[0]> = [];
	const authority: ModelLoginSignInAuthority = {
		describeModelLoginSignIn: vi.fn(async (request) => {
			if (request.loginId !== loginId || request.capabilitySha256 !== capabilitySha256)
				throw new Error("model login sign-in is unavailable");
			return { ...description };
		}),
		completeModelLoginSignIn: vi.fn(),
		completeAccountModelLoginSignIn: vi.fn(),
		completeClaudeLoginSignIn: vi.fn(async (completion) => {
			completions.push({ ...completion, encryptedEnvelope: Buffer.from(completion.encryptedEnvelope) });
			description.status = "completed";
			description.modelLoginId = completion.claudeLoginId;
			return { schema: "qorpera.claude-sign-in-complete/v1" };
		}),
		modelLoginBrokerCompany: vi.fn(async () => companyId),
		completeChatGptPlanSignIn: vi.fn(),
	};
	const code = (value: string) => ({
		companyId,
		capability,
		body: { schema: "qorpera.claude-sign-in-code/v1", login_id: loginId, code: value },
	});
	return {
		companyId,
		loginId,
		memberId,
		description,
		keyring,
		authority,
		completions,
		request: { companyId, capability, body },
		code,
	};
}

it("completes a member's Claude sign-in in the vault: Anthropic's page, then the code, sealed under the member's key", async () => {
	const w = vault();
	const { service } = await claudeSignIns();
	const signIns = new CloudModelLoginSignIns({ authority: w.authority, keyring: w.keyring, helper: service });
	let answer = await signIns.signIn(w.request, signal());
	while (answer.status === "preparing") answer = await signIns.signIn(w.request, signal());
	expect(answer).toEqual({
		schema: "qorpera.native-provider-login-result/v1",
		login_id: w.loginId,
		status: "awaiting_member",
		interaction_url: "https://claude.com/cai/oauth/authorize?code=true&state=abc",
		user_code: null,
	});
	// Pasted text may carry spaces and a line end.
	expect(await signIns.submitClaudeCode(w.code(` ${GOOD_CODE}\n`), signal())).toMatchObject({
		login_id: w.loginId,
		status: "completed",
	});
	expect(w.authority.completeModelLoginSignIn).not.toHaveBeenCalled();
	expect(w.authority.completeAccountModelLoginSignIn).not.toHaveBeenCalled();
	const saved = w.completions[0];
	if (!saved) throw new Error("expected a completion");
	expect(saved).toMatchObject({
		loginId: w.loginId,
		keyId: "vault-root-1",
		providerAccountEmail: "member@example.test",
	});
	expect(saved.envelopeSha256).toBe(createHash("sha256").update(saved.encryptedEnvelope).digest("hex"));
	const sealed = await w.keyring.useMember(
		saved.encryptedEnvelope,
		{ memberId: w.memberId, loginId: saved.claudeLoginId, version: 1, keyId: "vault-root-1" },
		async (fields) => fields[CLAUDE_LOGIN_FIELD],
	);
	expect(files({ status: "completed", authJson: sealed as string })).toEqual({
		".credentials.json": CREDENTIALS,
		".claude.json": SETTINGS,
	});
	// The sign-in is complete: a second code answers completed and reaches nothing.
	expect(await signIns.submitClaudeCode(w.code(GOOD_CODE), signal())).toMatchObject({ status: "completed" });
	expect(w.completions).toHaveLength(1);
});

it("refuses a wrong Claude code, a code for a Codex sign-in, and a request whose provider differs from the sign-in's", async () => {
	const w = vault();
	const { service } = await claudeSignIns();
	const signIns = new CloudModelLoginSignIns({ authority: w.authority, keyring: w.keyring, helper: service });
	while ((await signIns.signIn(w.request, signal())).status === "preparing");
	await expect(signIns.submitClaudeCode(w.code("x"), signal())).rejects.toBeInstanceOf(ClaudeCodeRefused);
	await expect(signIns.submitClaudeCode(w.code("not-the-code-at-all"), signal())).rejects.toBeInstanceOf(
		ClaudeCodeRefused,
	);
	expect(w.completions).toHaveLength(0);
	// The helper's copy ended with the refused code.
	expect(await service.readSignIn({ signInId: w.loginId, companyId: w.companyId }, signal())).toEqual({
		status: "unknown",
	});
	// A Codex request for a Claude sign-in, and a code for a Codex sign-in.
	await expect(
		signIns.signIn(
			{ ...w.request, body: { ...w.request.body, provider: "openai", native_harness: "codex-cli" } },
			signal(),
		),
	).rejects.toThrow("Vault sign-in request crossed its authority");
	w.description.loginKind = "codex";
	await expect(signIns.submitClaudeCode(w.code(GOOD_CODE), signal())).rejects.toThrow(
		"Claude sign-in code crossed its authority",
	);
	// A Claude sign-in is an account sign-in, always.
	w.description.loginKind = "claude";
	const { scope: _scope, ...company } = w.description;
	vi.mocked(w.authority.describeModelLoginSignIn).mockResolvedValueOnce(company);
	await expect(signIns.submitClaudeCode(w.code(GOOD_CODE), signal())).rejects.toThrow(
		"Vault sign-in description is invalid",
	);
});

it("answers preparing once the route's time is up, and still saves the login it took the code for", async () => {
	const w = vault();
	const completed = {
		status: "completed" as const,
		authJson: JSON.stringify({ schema: CLAUDE_LOGIN_FILES_SCHEMA, files: { ".credentials.json": "e30=" } }),
	};
	const helper: ModelLoginSignInHelper = {
		beginSignIn: vi.fn(async () => ({ status: "awaiting_member" as const, interactionUrl: "https://claude.com/x" })),
		readSignIn: vi.fn(async () => completed),
		listCompletedSignIns: vi.fn(async () => []),
		finishSignIn: vi.fn(async () => undefined),
		submitCode: vi.fn(async () => completed),
	};
	const save = vi.mocked(w.authority.completeClaudeLoginSignIn!).getMockImplementation()!;
	vi.mocked(w.authority.completeClaudeLoginSignIn!).mockImplementation(async (completion, saveSignal) => {
		await new Promise((resolveWait) => setTimeout(resolveWait, 300));
		return save(completion, saveSignal);
	});
	const signIns = new CloudModelLoginSignIns({ authority: w.authority, keyring: w.keyring, helper });
	expect(await signIns.submitClaudeCode(w.code(GOOD_CODE), AbortSignal.timeout(100))).toMatchObject({
		status: "preparing",
	});
	await vi.waitFor(() => expect(w.completions).toHaveLength(1));
	expect(helper.finishSignIn).toHaveBeenCalled();
});
