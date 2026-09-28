import { randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelLoginHelperClient, ModelLoginHelperService } from "@qorpera/runtime/cloud-model-login-helper";
import { CodexSignIns, type ModelLoginSignInHelper } from "@qorpera/runtime/cloud-model-login-sign-in";
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

/** A stand-in for the official `codex login --device-auth` and `codex login status`: prints the
 * link and code, then saves the member's login once they "finish", as Codex would. */
async function fakeCodex(finishAfterMs: number): Promise<string> {
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

async function signIns(options: { finishAfterMs?: number; limit?: number; beforeLaunch?: () => Promise<void> } = {}) {
	const temporaryRoot = await temporary("qorpera-sign-in-root-");
	const service = new CodexSignIns({
		driver: new OfficialCliNativeHarnessDriver(await fakeCodex(options.finishAfterMs ?? 300), "/nonexistent/claude"),
		temporaryRoot,
		promptWaitMs: 5000,
		...(options.limit ? { limit: options.limit } : {}),
		...(options.beforeLaunch ? { beforeLaunch: options.beforeLaunch } : {}),
	});
	closers.push(() => service.close());
	return { service, temporaryRoot };
}

const soon = () => new Date(Date.now() + 10 * 60_000).toISOString();

it("runs the official device sign-in, shows the link and code, and hands the finished login over once", async () => {
	const { service, temporaryRoot } = await signIns({ finishAfterMs: 400 });
	const signInId = randomUUID();
	const signal = new AbortController().signal;
	const first = await service.beginSignIn({ signInId, expiresAt: soon() }, signal);
	expect(first).toEqual({
		status: "awaiting_member",
		interactionUrl: "https://auth.openai.com/codex/device",
		userCode: "ABCD-12345",
	});
	// The same sign-in answers its state; it never starts a second Codex.
	await vi.waitFor(
		async () => expect((await service.beginSignIn({ signInId, expiresAt: soon() }, signal)).status).toBe("completed"),
		{ timeout: 5000 },
	);
	const done = await service.beginSignIn({ signInId, expiresAt: soon() }, signal);
	if (done.status !== "completed") throw new Error("expected a completed sign-in");
	expect(JSON.parse(done.authJson).tokens.refresh_token).toBe("rt-signed-in");
	expect(done.providerAccountEmail).toBe("member@example.test");
	expect(done.providerAccountReference).toMatch(/^codex-cli:[0-9a-f]{64}$/);
	// Codex has stopped: its private home is gone, the login lives only in memory until finish.
	await vi.waitFor(async () => expect(await readdir(temporaryRoot)).toEqual([]), { timeout: 2000 });
	await service.finishSignIn(signInId, signal);
	// Finished: a new begin would be a new sign-in, and nothing of the old one remains.
	expect(await readdir(temporaryRoot)).toEqual([]);
});

it("refuses an ended sign-in, stays inside its limit, and stops when the pinned binary changed", async () => {
	const signal = new AbortController().signal;
	const limited = await signIns({ finishAfterMs: 60_000, limit: 1 });
	expect(
		await limited.service.beginSignIn(
			{ signInId: randomUUID(), expiresAt: new Date(Date.now() - 1000).toISOString() },
			signal,
		),
	).toEqual({ status: "failed", reason: "sign_in_expired" });
	const held = randomUUID();
	expect((await limited.service.beginSignIn({ signInId: held, expiresAt: soon() }, signal)).status).toBe(
		"awaiting_member",
	);
	expect(await limited.service.beginSignIn({ signInId: randomUUID(), expiresAt: soon() }, signal)).toEqual({
		status: "preparing",
	});
	await limited.service.finishSignIn(held, signal);
	expect(await readdir(limited.temporaryRoot)).toEqual([]);
	const changed = await signIns({
		beforeLaunch: async () => {
			throw new Error("binary changed");
		},
	});
	expect(await changed.service.beginSignIn({ signInId: randomUUID(), expiresAt: soon() }, signal)).toEqual({
		status: "failed",
		reason: "codex_launch_failed",
	});
	await expect(changed.service.beginSignIn({ signInId: "not-a-sign-in", expiresAt: soon() }, signal)).rejects.toThrow(
		"Sign-in id is invalid",
	);
});

it("serves sign-ins over the helper socket to the broker only", async () => {
	const directory = await temporary("qorpera-sign-in-socket-");
	const socketPath = join(directory, "helper.sock");
	const token = randomBytes(32).toString("base64url");
	const signInId = randomUUID();
	const fake: ModelLoginSignInHelper = {
		beginSignIn: vi.fn(async () => ({
			status: "completed" as const,
			authJson: '{"tokens":{}}',
			providerAccountEmail: "member@example.test",
		})),
		finishSignIn: vi.fn(async () => undefined),
	};
	const service = new ModelLoginHelperService({
		socketPath,
		token,
		renewer: { renew: vi.fn() },
		signIns: fake,
	});
	await service.start();
	closers.push(() => service.close());
	expect((await stat(socketPath)).mode & 0o777).toBe(0o660);
	const client = new ModelLoginHelperClient({ socketPath, token });
	const signal = new AbortController().signal;
	const expiresAt = soon();
	await expect(client.beginSignIn({ signInId, expiresAt }, signal)).resolves.toEqual({
		status: "completed",
		authJson: '{"tokens":{}}',
		providerAccountEmail: "member@example.test",
	});
	expect(fake.beginSignIn).toHaveBeenCalledWith({ signInId, expiresAt }, expect.any(AbortSignal));
	await client.finishSignIn(signInId, signal);
	expect(fake.finishSignIn).toHaveBeenCalledWith(signInId, expect.any(AbortSignal));
	const stranger = new ModelLoginHelperClient({ socketPath, token: randomBytes(32).toString("base64url") });
	await expect(stranger.beginSignIn({ signInId, expiresAt }, signal)).rejects.toThrow();
	// A helper without sign-ins has no such route.
	const plainSocket = join(directory, "plain.sock");
	const plain = new ModelLoginHelperService({ socketPath: plainSocket, token, renewer: { renew: vi.fn() } });
	await plain.start();
	closers.push(() => plain.close());
	await expect(
		new ModelLoginHelperClient({ socketPath: plainSocket, token }).beginSignIn({ signInId, expiresAt }, signal),
	).rejects.toThrow();
});
