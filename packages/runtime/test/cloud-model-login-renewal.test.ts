import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelLoginHelperClient, ModelLoginHelperService } from "@qorpera/runtime/cloud-model-login-helper";
import { CodexLoginRenewer, classifyCodexRenewalFailure } from "@qorpera/runtime/cloud-model-login-renewal";
import {
	CloudModelLoginVault,
	MODEL_LOGIN_FIELD,
	type ModelLoginAuthority,
	type ModelLoginRenewer,
} from "@qorpera/runtime/cloud-model-login-vault";
import { CloudSecretKeyring, withCloudSecretFields } from "@qorpera/runtime/cloud-secret-crypto";
import { afterEach, expect, it, vi } from "vitest";

const roots: string[] = [];
const services: ModelLoginHelperService[] = [];
afterEach(async () => {
	for (const service of services.splice(0)) await service.close();
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function temporary(prefix: string): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), prefix));
	roots.push(root);
	return root;
}

const LOGIN = `${JSON.stringify({
	OPENAI_API_KEY: null,
	tokens: { id_token: "id", access_token: "at-old", refresh_token: "rt-old", account_id: "account-1" },
	last_refresh: "2026-09-20T00:00:00Z",
})}\n`;

/** A stand-in for `codex app-server`: answers initialize and account/read, and on the forced
 * renewal does what the mode says, as the official Codex would. */
async function fakeCodex(
	mode: "renew" | "renew-jwt" | "reused" | "unauthorized" | "outage" | "exit" | "silent" | "close-stdin" | "flood",
): Promise<string> {
	const directory = await temporary("qorpera-fake-codex-");
	const path = join(directory, "codex");
	await writeFile(
		path,
		`#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
if (process.argv[2] !== "app-server") process.exit(64);
const login = path.join(process.env.CODEX_HOME, "auth.json");
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
let buffered = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
	buffered += chunk;
	let end;
	while ((end = buffered.indexOf("\\n")) >= 0) {
		const message = JSON.parse(buffered.slice(0, end));
		buffered = buffered.slice(end + 1);
		if (${JSON.stringify(mode)} === "silent") continue;
		if (message.method === "initialize") {
			send({ method: "configWarning", params: {} });
			send({ id: message.id, result: { userAgent: "fake" } });
			if (${JSON.stringify(mode)} === "close-stdin") {
				process.stdin.destroy();
				setTimeout(() => process.exit(0), 300);
			}
			if (${JSON.stringify(mode)} === "flood") {
				const line = JSON.stringify({ method: "noise", params: { text: "x".repeat(8192) } }) + "\\n";
				const flood = () => { while (process.stdout.write(line)) {} process.stdout.once("drain", flood); };
				flood();
			}
		} else if (message.method === "account/read") {
			if (message.params.refreshToken !== true) process.exit(65);
			const mode = ${JSON.stringify(mode)};
			if (mode === "renew-jwt") {
				const auth = JSON.parse(fs.readFileSync(login, "utf8"));
				const part = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
				const now = Math.floor(Date.now() / 1000);
				auth.tokens.access_token = part({ alg: "RS256" }) + "." + part({ iat: now, exp: now + 864000 }) + ".c2ln";
				auth.tokens.refresh_token = "rt-renewed-by-codex";
				auth.last_refresh = new Date().toISOString();
				fs.writeFileSync(login, JSON.stringify(auth));
			} else if (mode === "renew") {
				const auth = JSON.parse(fs.readFileSync(login, "utf8"));
				auth.tokens.access_token = "at-new";
				auth.tokens.refresh_token = "rt-new";
				fs.writeFileSync(login, JSON.stringify(auth));
			} else if (mode === "reused") {
				process.stderr.write('ERROR codex_login::auth::manager: Failed to refresh token: 401 Unauthorized: {"error":{"code":"refresh_token_reused"}}\\n');
			} else if (mode === "unauthorized") {
				process.stderr.write("ERROR codex_login::auth::manager: Failed to refresh token: 401 Unauthorized: {}\\n");
			} else if (mode === "outage") {
				process.stderr.write("ERROR codex_login::auth::manager: Failed to refresh token: 503 Service Unavailable: busy\\n");
			} else if (mode === "exit") {
				process.exit(3);
			}
			send({ id: message.id, result: { account: null, requiresOpenaiAuth: true } });
		}
	}
});
`,
	);
	await chmod(path, 0o755);
	return path;
}

async function renewer(mode: Parameters<typeof fakeCodex>[0], timeoutMs?: number) {
	const temporaryRoot = await temporary("qorpera-renewal-root-");
	return {
		temporaryRoot,
		renewer: new CodexLoginRenewer({
			codexPath: await fakeCodex(mode),
			temporaryRoot,
			...(timeoutMs ? { timeoutMs } : {}),
		}),
	};
}

it("returns the login the official Codex saved after its renewal, and keeps nothing", async () => {
	const { renewer: codex, temporaryRoot } = await renewer("renew");
	const result = await codex.renew(LOGIN, new AbortController().signal);
	expect(result.outcome).toBe("renewed");
	expect(result.outcome === "renewed" && JSON.parse(result.authJson).tokens).toMatchObject({
		access_token: "at-new",
		refresh_token: "rt-new",
	});
	expect(await readdir(temporaryRoot)).toEqual([]);
});

it("reads a refused renewal from Codex's own error line", async () => {
	for (const [mode, reason] of [
		["reused", "refresh_token_reused"],
		["unauthorized", "refresh_token_unauthorized"],
	] as const) {
		const { renewer: codex, temporaryRoot } = await renewer(mode);
		await expect(codex.renew(LOGIN, new AbortController().signal)).resolves.toEqual({ outcome: "refused", reason });
		expect(await readdir(temporaryRoot)).toEqual([]);
	}
});

it("treats an outage, a crash or no answer as a renewal to try again", async () => {
	for (const mode of ["outage", "exit"] as const) {
		const { renewer: codex } = await renewer(mode);
		await expect(codex.renew(LOGIN, new AbortController().signal)).resolves.toEqual({
			outcome: "transient",
			reason: "renewal_unchanged",
		});
	}
	const { renewer: silent, temporaryRoot } = await renewer("silent", 500);
	const started = Date.now();
	await expect(silent.renew(LOGIN, new AbortController().signal)).resolves.toEqual({
		outcome: "transient",
		reason: "renewal_unchanged",
	});
	expect(Date.now() - started).toBeLessThan(10_000);
	expect(await readdir(temporaryRoot)).toEqual([]);
});

it("classifies Codex's renewal errors the way Codex does", () => {
	expect(classifyCodexRenewalFailure('Failed to refresh token: 400 Bad Request: {"error":"invalid_grant"}')).toBe(
		"refresh_token_invalid_grant",
	);
	expect(
		classifyCodexRenewalFailure(
			'Failed to refresh token: 400 Bad Request: {"error":{"code":"refresh_token_expired"}}',
		),
	).toBe("refresh_token_expired");
	expect(
		classifyCodexRenewalFailure('Failed to refresh token: 400 Bad Request: {"code":"refresh_token_invalidated"}'),
	).toBe("refresh_token_invalidated");
	expect(classifyCodexRenewalFailure("Failed to refresh token: 500 Internal Server Error: x")).toBeUndefined();
	expect(classifyCodexRenewalFailure("Failed to refresh token: 400 Bad Request: rate limited")).toBeUndefined();
});

async function helper(renew: ModelLoginRenewer["renew"], concurrency?: number) {
	const directory = await temporary("qlh-");
	const socketPath = join(directory, "helper.sock");
	const token = randomBytes(32).toString("base64url");
	const service = new ModelLoginHelperService({
		socketPath,
		token,
		renewer: { renew },
		...(concurrency ? { concurrency } : {}),
	});
	services.push(service);
	await service.start();
	return { socketPath, token, service };
}

it("serves renewals over its socket to the holder of its token only", async () => {
	const renew = vi.fn<ModelLoginRenewer["renew"]>(async (authJson) => ({
		outcome: "renewed",
		authJson: authJson.replace("rt-old", "rt-new"),
	}));
	const h = await helper(renew);
	expect((await stat(h.socketPath)).mode & 0o777).toBe(0o660);
	const client = new ModelLoginHelperClient({ socketPath: h.socketPath, token: h.token });
	const result = await client.renew(LOGIN, new AbortController().signal);
	expect(result).toEqual({ outcome: "renewed", authJson: LOGIN.replace("rt-old", "rt-new") });
	expect(renew).toHaveBeenCalledWith(LOGIN, expect.any(AbortSignal));
	const stranger = new ModelLoginHelperClient({
		socketPath: h.socketPath,
		token: randomBytes(32).toString("base64url"),
	});
	await expect(stranger.renew(LOGIN, new AbortController().signal)).rejects.toThrow();
	expect(renew).toHaveBeenCalledTimes(1);
});

it("answers busy past its limit and a failed renewer as a renewal to try again", async () => {
	let release!: () => void;
	const held = new Promise<void>((resolveHeld) => {
		release = resolveHeld;
	});
	const h = await helper(async () => {
		await held;
		throw new Error("codex crashed");
	}, 1);
	const client = new ModelLoginHelperClient({ socketPath: h.socketPath, token: h.token });
	const first = client.renew(LOGIN, new AbortController().signal);
	await new Promise((resolveWait) => setTimeout(resolveWait, 100));
	await expect(client.renew(LOGIN, new AbortController().signal)).resolves.toEqual({
		outcome: "transient",
		reason: "helper_busy",
	});
	release();
	await expect(first).resolves.toEqual({ outcome: "transient", reason: "helper_failed" });
});

it("renews end to end: vault, helper socket, official Codex, next version sealed", async () => {
	const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
	const now = Math.floor(Date.now() / 1000);
	const stored = `${JSON.stringify({
		OPENAI_API_KEY: null,
		tokens: {
			id_token: `${part({ alg: "RS256" })}.${part({ email: "member@example.test" })}.c2ln`,
			access_token: `${part({ alg: "RS256" })}.${part({ iat: now - 500_000, exp: now + 364_000 })}.c2ln`,
			refresh_token: "rt-stored",
			account_id: "account-1",
		},
		last_refresh: new Date((now - 500_000) * 1000).toISOString(),
	})}\n`;
	const keyId = "company-kek-1";
	const wrappingKey = randomBytes(32);
	const keyring = new CloudSecretKeyring({ [keyId]: wrappingKey });
	const run = {
		leaseId: randomUUID(),
		runId: randomUUID(),
		jobId: randomUUID(),
		runnerId: randomUUID(),
		assignmentId: randomUUID(),
		credentialCapsuleId: randomUUID(),
		computeIdentityId: randomUUID(),
	};
	const identity = { companyId: randomUUID(), environmentId: run.computeIdentityId, secretId: randomUUID(), keyId };
	const envelope = keyring.seal({ [MODEL_LOGIN_FIELD]: stored }, { ...identity, version: 7 });
	const commit = vi.fn(async (renewal: { baseVersion: number }) => ({
		schema: "qorpera.model-login-renewal/v1",
		version: renewal.baseVersion + 1,
	}));
	const authority: ModelLoginAuthority = {
		issueModelLogin: async () => ({
			schema: "qorpera.model-login-issue/v1",
			loginId: identity.secretId,
			companyId: identity.companyId,
			computeIdentityId: run.computeIdentityId,
			version: 7,
			keyId,
			encryptedEnvelopeBase64: Buffer.from(envelope).toString("base64"),
			envelopeSha256: createHash("sha256").update(envelope).digest("hex"),
			accessIssuedAt: new Date((now - 500_000) * 1000).toISOString(),
			accessExpiresAt: new Date((now + 364_000) * 1000).toISOString(),
			renewing: false,
			unchanged: false,
			renewal: { token: randomUUID(), baseVersion: 7, keyId },
		}),
		commitModelLoginRenewal: commit,
		releaseModelLoginRenewal: vi.fn(),
		takeIdleModelLoginRenewal: vi.fn(),
		listModelLoginsWithoutAccount: vi.fn(),
		recordModelLoginAccount: vi.fn(),
		switchOffReplacedNodeLogins: vi.fn(),
	};
	const { renewer: codex } = await renewer("renew-jwt");
	const h = await helper((authJson, signal) => codex.renew(authJson, signal));
	const vault = new CloudModelLoginVault({
		authority,
		keyring,
		renewer: new ModelLoginHelperClient({ socketPath: h.socketPath, token: h.token }),
	});
	const login = await vault.issue({ binding: run, knownVersion: 7 }, new AbortController().signal);
	expect(login.version).toBe(8);
	expect(login.authJson).not.toContain("rt-renewed-by-codex");
	expect(JSON.parse(login.authJson as string).tokens.refresh_token).toBe("");
	const saved = commit.mock.calls[0]?.[0] as unknown as { encryptedEnvelope: Uint8Array };
	await expect(
		withCloudSecretFields(saved.encryptedEnvelope, wrappingKey, { ...identity, version: 8 }, async (fields) =>
			JSON.parse(fields[MODEL_LOGIN_FIELD] as string),
		),
	).resolves.toMatchObject({ tokens: { refresh_token: "rt-renewed-by-codex", account_id: "account-1" } });
	expect(authority.releaseModelLoginRenewal).not.toHaveBeenCalled();
	keyring.close();
});

it("survives Codex closing its input, a missing binary, a caller's abort and runaway output", async () => {
	const closing = await renewer("close-stdin");
	await expect(closing.renewer.renew(LOGIN, new AbortController().signal)).resolves.toEqual({
		outcome: "transient",
		reason: "renewal_unchanged",
	});
	expect(await readdir(closing.temporaryRoot)).toEqual([]);

	const temporaryRoot = await temporary("qorpera-renewal-root-");
	const missing = new CodexLoginRenewer({ codexPath: join(temporaryRoot, "no-such-codex"), temporaryRoot });
	await expect(missing.renew(LOGIN, new AbortController().signal)).resolves.toEqual({
		outcome: "transient",
		reason: "codex_launch_failed",
	});
	expect(await readdir(temporaryRoot)).toEqual([]);
	// A binary that changed since the helper started is never launched.
	const changed = new CodexLoginRenewer({
		codexPath: await fakeCodex("renew"),
		temporaryRoot,
		beforeLaunch: async () => {
			throw new Error("changed since start");
		},
	});
	await expect(changed.renew(LOGIN, new AbortController().signal)).resolves.toEqual({
		outcome: "transient",
		reason: "codex_changed",
	});
	expect(await readdir(temporaryRoot)).toEqual([]);

	const silent = await renewer("silent", 20_000);
	const abort = new AbortController();
	setTimeout(() => abort.abort(), 200);
	const started = Date.now();
	await expect(silent.renewer.renew(LOGIN, abort.signal)).resolves.toMatchObject({ outcome: "transient" });
	expect(Date.now() - started).toBeLessThan(10_000);
	expect(await readdir(silent.temporaryRoot)).toEqual([]);

	const flood = await renewer("flood", 20_000);
	const floodStarted = Date.now();
	await expect(flood.renewer.renew(LOGIN, new AbortController().signal)).resolves.toMatchObject({
		outcome: "transient",
	});
	expect(Date.now() - floodStarted).toBeLessThan(10_000);
	expect(await readdir(flood.temporaryRoot)).toEqual([]);
});

it("reads Codex's error body as Codex does: the code field, any case, a multi-line body", () => {
	expect(
		classifyCodexRenewalFailure(
			'ERROR x: Failed to refresh token: 400 Bad Request: {"error":{"code":"REFRESH_TOKEN_EXPIRED"}}',
		),
	).toBe("refresh_token_expired");
	expect(
		classifyCodexRenewalFailure(
			'ERROR x: Failed to refresh token: 400 Bad Request: {\n  "error": "INVALID_GRANT"\n}\nINFO next line',
		),
	).toBe("refresh_token_invalid_grant");
	expect(
		classifyCodexRenewalFailure(
			'ERROR x: Failed to refresh token: 401 Unauthorized: {"code":"refresh_token_reused"}',
		),
	).toBe("refresh_token_reused");
	// A message that only mentions a code is not the code: Codex retries it, so does the vault.
	expect(
		classifyCodexRenewalFailure(
			'ERROR x: Failed to refresh token: 503 Service Unavailable: {"error":{"message":"refresh_token_reused is not the issue"}}',
		),
	).toBeUndefined();
	expect(
		classifyCodexRenewalFailure('ERROR x: Failed to refresh token: 400 Bad Request: {"error":"rate_limited"}'),
	).toBeUndefined();
	// The proactive-renewal log line carries no status and is not a provider answer.
	expect(
		classifyCodexRenewalFailure(
			"ERROR x: Failed to refresh token: Your refresh token was already used (refresh_token_reused)",
		),
	).toBeUndefined();
});

it("refuses a helper answer that is not a clean renewal result", async () => {
	for (const [status, body] of [
		[500, JSON.stringify({ schema: "qorpera.model-login-renewal/v1", outcome: "renewed", authJson: LOGIN })],
		[200, "not json"],
		[
			200,
			JSON.stringify({ schema: "qorpera.model-login-renewal/v1", outcome: "renewed", authJson: LOGIN, extra: 1 }),
		],
		[200, JSON.stringify({ schema: "qorpera.model-login-renewal/v1", outcome: "refused", reason: "Bad Reason" })],
		[200, "x".repeat(60 * 1024)],
	] as const) {
		const directory = await temporary("qlh-");
		const socketPath = join(directory, "fake.sock");
		const server = createServer((_request, reply) => {
			reply.writeHead(status, { "content-type": "application/json" });
			reply.end(body);
		});
		await new Promise<void>((resolveListen) => server.listen(socketPath, () => resolveListen()));
		try {
			const client = new ModelLoginHelperClient({ socketPath, token: randomBytes(32).toString("base64url") });
			await expect(client.renew(LOGIN, new AbortController().signal)).rejects.toThrow();
		} finally {
			await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
		}
	}
});
