import { randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelLoginHelperClient, ModelLoginHelperService } from "@qorpera/runtime/cloud-model-login-helper";
import { codexSelfCheck } from "@qorpera/runtime/cloud-model-login-renewal";
import {
	CodexSignIns,
	type ModelLoginSignInBinding,
	type ModelLoginSignInHelper,
} from "@qorpera/runtime/cloud-model-login-sign-in";
import { OfficialCliNativeHarnessDriver } from "@qorpera/runtime/cloud-native-provider-host";
import { afterEach, expect, it, vi } from "vitest";

const roots: string[] = [];
const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const close of closers.splice(0)) await close();
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function temporary(prefix: string): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), prefix));
	roots.push(root);
	return root;
}

const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

/** A stand-in for the official `codex login --device-auth`, `codex login status` and
 * `codex --version`: prints the link and code, then saves the member's login once they
 * "finish", as Codex would. */
async function fakeCodex(finishAfterMs: number, launches?: string): Promise<string> {
	const directory = await temporary("qorpera-fake-codex-signin-");
	const path = join(directory, "codex");
	const now = Math.floor(Date.now() / 1000);
	const login = JSON.stringify({
		OPENAI_API_KEY: null,
		tokens: {
			id_token: `${part({ alg: "RS256" })}.${part({ email: "member@example.test" })}.c2ln`,
			access_token: `${part({ alg: "RS256" })}.${part({ iat: now, exp: now + 864_000 })}.c2ln`,
			refresh_token: "rt-signed-in",
			account_id: "account-1",
		},
		last_refresh: new Date().toISOString(),
	});
	await writeFile(
		path,
		`#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const [command, flag] = process.argv.slice(2);
${launches ? `fs.appendFileSync(${JSON.stringify(launches)}, process.argv.slice(2).join(" ") + "\\n");` : ""}
if (command === "--version") {
	process.stdout.write("codex-cli 0.155.1\\n");
	process.exit(0);
}
if (command === "login" && flag === "status") {
	process.stdout.write("Logged in using ChatGPT\\n");
	process.exit(0);
}
if (command !== "login" || flag !== "--device-auth") process.exit(64);
process.stdout.write("Follow these steps to sign in with ChatGPT:\\n1. Open https://auth.openai.com/codex/device\\n2. Enter this one-time code\\n   ABCD-12345\\n");
setTimeout(() => {
	fs.writeFileSync(path.join(process.env.CODEX_HOME, "auth.json"), ${JSON.stringify(login)});
	process.exit(0);
}, ${finishAfterMs});
`,
	);
	await chmod(path, 0o755);
	return path;
}

async function signIns(
	options: {
		finishAfterMs?: number;
		limit?: number;
		companyLimit?: number;
		beforeLaunch?: () => Promise<void>;
		launches?: string;
	} = {},
) {
	const temporaryRoot = await temporary("qorpera-sign-in-root-");
	const service = new CodexSignIns({
		driver: new OfficialCliNativeHarnessDriver(
			await fakeCodex(options.finishAfterMs ?? 300, options.launches),
			"/nonexistent/claude",
			undefined,
			options.beforeLaunch ? { beforeLaunch: options.beforeLaunch } : {},
		),
		temporaryRoot,
		promptWaitMs: 5000,
		...(options.limit ? { limit: options.limit } : {}),
		...(options.companyLimit ? { companyLimit: options.companyLimit } : {}),
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
		...overrides,
	};
}

const signal = () => new AbortController().signal;

it("runs the official device sign-in, shows the link and code, and keeps the finished login for its broker", async () => {
	const { service, temporaryRoot } = await signIns({ finishAfterMs: 400 });
	const signIn = binding();
	const target = { signInId: signIn.signInId, companyId: signIn.companyId };
	expect(await service.beginSignIn(signIn, signal())).toEqual({
		status: "awaiting_member",
		interactionUrl: "https://auth.openai.com/codex/device",
		userCode: "ABCD-12345",
	});
	// The web client stops asking here; the broker collects the finished sign-in itself.
	await vi.waitFor(
		async () =>
			expect(await service.listCompletedSignIns({ companyId: signIn.companyId }, signal())).toEqual([
				{ signInId: signIn.signInId, capabilitySha256: signIn.capabilitySha256 },
			]),
		{ timeout: 5000 },
	);
	expect(await service.listCompletedSignIns({ companyId: randomUUID() }, signal())).toEqual([]);
	expect(await service.readSignIn({ ...target, companyId: randomUUID() }, signal())).toEqual({ status: "unknown" });
	const done = await service.readSignIn(target, signal());
	if (done.status !== "completed") throw new Error("expected a completed sign-in");
	expect(JSON.parse(done.authJson).tokens.refresh_token).toBe("rt-signed-in");
	expect(done.providerAccountEmail).toBe("member@example.test");
	expect(done.providerAccountReference).toMatch(/^codex-cli:[0-9a-f]{64}$/);
	// Codex has stopped: its private home is gone; the login lives in memory until finished.
	await vi.waitFor(async () => expect(await readdir(temporaryRoot)).toEqual([]), { timeout: 2000 });
	// Another company cannot end it; its own broker can.
	await service.finishSignIn({ ...target, companyId: randomUUID() }, signal());
	expect((await service.readSignIn(target, signal())).status).toBe("completed");
	await service.finishSignIn(target, signal());
	expect(await service.readSignIn(target, signal())).toEqual({ status: "unknown" });
	// An ended sign-in is not started again, whoever asks: a late poll finds it complete instead.
	await expect(service.beginSignIn(signIn, signal())).resolves.toEqual({ status: "preparing" });
	expect(await readdir(temporaryRoot)).toEqual([]);
});

it("binds a sign-in to its company and capability, starts Codex once, and replaces a member's older sign-in", async () => {
	const launches = join(await temporary("qorpera-sign-in-launches-"), "launches");
	const { service, temporaryRoot } = await signIns({ finishAfterMs: 60_000, launches });
	const first = binding();
	// Two polls at once start one Codex.
	const [one, two] = await Promise.all([service.beginSignIn(first, signal()), service.beginSignIn(first, signal())]);
	expect(one.status).toBe("awaiting_member");
	expect(two.status).toBe("awaiting_member");
	await expect(service.beginSignIn({ ...first, capabilitySha256: "0".repeat(64) }, signal())).rejects.toThrow(
		"another company or capability",
	);
	await expect(service.beginSignIn({ ...first, companyId: randomUUID() }, signal())).rejects.toThrow(
		"another company or capability",
	);
	// The member retried: the older sign-in of the same identity ends.
	const retry = binding({ companyId: first.companyId, computeIdentityId: first.computeIdentityId });
	expect((await service.beginSignIn(retry, signal())).status).toBe("awaiting_member");
	expect(await service.readSignIn({ signInId: first.signInId, companyId: first.companyId }, signal())).toEqual({
		status: "unknown",
	});
	await service.finishSignIn({ signInId: retry.signInId, companyId: retry.companyId }, signal());
	await vi.waitFor(async () => expect(await readdir(temporaryRoot)).toEqual([]), { timeout: 2000 });
	expect((await readFile(launches, "utf8")).trim().split("\n")).toEqual([
		"login --device-auth",
		"login --device-auth",
	]);
});

it("keeps each company inside its share, refuses an ended sign-in, and stops when the pinned binary changed", async () => {
	const limited = await signIns({ finishAfterMs: 60_000, limit: 3, companyLimit: 1 });
	expect(
		await limited.service.beginSignIn(binding({ expiresAt: new Date(Date.now() - 1000).toISOString() }), signal()),
	).toEqual({ status: "failed", reason: "sign_in_expired" });
	const held = binding();
	expect((await limited.service.beginSignIn(held, signal())).status).toBe("awaiting_member");
	// The same company's second member waits; another company does not.
	expect(await limited.service.beginSignIn(binding({ companyId: held.companyId }), signal())).toEqual({
		status: "preparing",
	});
	expect((await limited.service.beginSignIn(binding(), signal())).status).toBe("awaiting_member");
	await limited.service.close();
	expect(await readdir(limited.temporaryRoot)).toEqual([]);
	const changed = await signIns({
		beforeLaunch: async () => {
			throw new Error("binary changed");
		},
	});
	const refused = binding();
	await vi.waitFor(
		async () =>
			expect(await changed.service.beginSignIn(refused, signal())).toEqual({
				status: "failed",
				reason: "codex_launch_failed",
			}),
		{ timeout: 2000 },
	);
	await expect(changed.service.beginSignIn({ ...binding(), signInId: "not-a-sign-in" }, signal())).rejects.toThrow(
		"binding is invalid",
	);
});

it("checks the pinned Codex answers its version before the helper serves anything", async () => {
	const temporaryRoot = await temporary("qorpera-self-check-");
	await expect(codexSelfCheck({ codexPath: await fakeCodex(0), temporaryRoot })).resolves.toBe("codex-cli 0.155.1");
	expect(await readdir(temporaryRoot)).toEqual([]);
	await expect(codexSelfCheck({ codexPath: "/nonexistent/codex", temporaryRoot })).rejects.toThrow();
});

it("serves sign-ins over the helper socket to the broker only", async () => {
	const directory = await temporary("qorpera-sign-in-socket-");
	const socketPath = join(directory, "helper.sock");
	const token = randomBytes(32).toString("base64url");
	const signIn = binding();
	const target = { signInId: signIn.signInId, companyId: signIn.companyId };
	const fake: ModelLoginSignInHelper = {
		beginSignIn: vi.fn(async () => ({ status: "awaiting_member" as const, userCode: "ABCD-12345" })),
		readSignIn: vi.fn(async () => ({
			status: "completed" as const,
			authJson: '{"tokens":{}}',
			providerAccountEmail: "member@example.test",
		})),
		listCompletedSignIns: vi.fn(async () => [
			{ signInId: signIn.signInId, capabilitySha256: signIn.capabilitySha256 },
		]),
		finishSignIn: vi.fn(async () => undefined),
	};
	const service = new ModelLoginHelperService({ socketPath, token, renewer: { renew: vi.fn() }, signIns: fake });
	await service.start();
	closers.push(() => service.close());
	expect((await stat(socketPath)).mode & 0o777).toBe(0o660);
	const client = new ModelLoginHelperClient({ socketPath, token });
	await expect(client.beginSignIn(signIn, signal())).resolves.toEqual({
		status: "awaiting_member",
		userCode: "ABCD-12345",
	});
	expect(fake.beginSignIn).toHaveBeenCalledWith(signIn, expect.any(AbortSignal));
	await expect(client.readSignIn(target, signal())).resolves.toMatchObject({ status: "completed" });
	await expect(client.listCompletedSignIns({ companyId: signIn.companyId }, signal())).resolves.toEqual([
		{ signInId: signIn.signInId, capabilitySha256: signIn.capabilitySha256 },
	]);
	await client.finishSignIn(target, signal());
	expect(fake.finishSignIn).toHaveBeenCalledWith(target, expect.any(AbortSignal));
	vi.mocked(fake.readSignIn).mockResolvedValueOnce({ status: "unknown" } as never);
	await expect(client.readSignIn(target, signal())).resolves.toEqual({ status: "unknown" });
	const stranger = new ModelLoginHelperClient({ socketPath, token: randomBytes(32).toString("base64url") });
	await expect(stranger.beginSignIn(signIn, signal())).rejects.toThrow();
	// A helper without sign-ins has no such routes.
	const plainSocket = join(directory, "plain.sock");
	const plain = new ModelLoginHelperService({ socketPath: plainSocket, token, renewer: { renew: vi.fn() } });
	await plain.start();
	closers.push(() => plain.close());
	await expect(
		new ModelLoginHelperClient({ socketPath: plainSocket, token }).beginSignIn(signIn, signal()),
	).rejects.toThrow();
});

it("answers a sign-in only to the client that began it: the shared vault and the company brokers stay apart", async () => {
	const directory = await temporary("qorpera-sign-in-clients-");
	const socketPath = join(directory, "helper.sock");
	const token = randomBytes(32).toString("base64url");
	const vaultToken = randomBytes(32).toString("base64url");
	const brokers = binding();
	const vaults = { ...binding(), companyId: brokers.companyId };
	const fake: ModelLoginSignInHelper = {
		beginSignIn: vi.fn(async () => ({ status: "awaiting_member" as const, userCode: "ABCD-12345" })),
		readSignIn: vi.fn(async () => ({ status: "completed" as const, authJson: '{"tokens":{}}' })),
		listCompletedSignIns: vi.fn(async () => [
			{ signInId: brokers.signInId, capabilitySha256: brokers.capabilitySha256 },
			{ signInId: vaults.signInId, capabilitySha256: vaults.capabilitySha256 },
		]),
		finishSignIn: vi.fn(async () => undefined),
	};
	expect(
		() =>
			new ModelLoginHelperService({ socketPath, token, vaultToken: token, renewer: { renew: vi.fn() }, signIns: fake }),
	).toThrow("Login helper token is invalid");
	const service = new ModelLoginHelperService({ socketPath, token, vaultToken, renewer: { renew: vi.fn() }, signIns: fake });
	await service.start();
	closers.push(() => service.close());
	const broker = new ModelLoginHelperClient({ socketPath, token });
	const vault = new ModelLoginHelperClient({ socketPath, token: vaultToken });
	await broker.beginSignIn(brokers, signal());
	await vault.beginSignIn(vaults, signal());
	const own = (entry: { signInId: string }) => ({ signInId: entry.signInId, companyId: entry.companyId });
	// Each sees only its own finished sign-ins, and reads the other's as unknown.
	await expect(broker.listCompletedSignIns({ companyId: brokers.companyId }, signal())).resolves.toEqual([
		{ signInId: brokers.signInId, capabilitySha256: brokers.capabilitySha256 },
	]);
	await expect(vault.listCompletedSignIns({ companyId: brokers.companyId }, signal())).resolves.toEqual([
		{ signInId: vaults.signInId, capabilitySha256: vaults.capabilitySha256 },
	]);
	await expect(vault.readSignIn(own(brokers), signal())).resolves.toEqual({ status: "unknown" });
	await expect(broker.readSignIn(own(vaults), signal())).resolves.toMatchObject({ status: "unknown" });
	expect(fake.readSignIn).not.toHaveBeenCalled();
	await expect(vault.readSignIn(own(vaults), signal())).resolves.toMatchObject({ status: "completed" });
	// Nor can one begin or finish the other's.
	await expect(vault.beginSignIn(brokers, signal())).rejects.toThrow();
	await expect(broker.finishSignIn(own(vaults), signal())).rejects.toThrow();
	expect(fake.beginSignIn).toHaveBeenCalledTimes(2);
	expect(fake.finishSignIn).not.toHaveBeenCalled();
	await vault.finishSignIn(own(vaults), signal());
	expect(fake.finishSignIn).toHaveBeenCalledOnce();
});
