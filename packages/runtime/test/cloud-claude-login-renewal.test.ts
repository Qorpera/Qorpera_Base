import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type ClaudeLoginCheck,
	type ClaudeLoginRenewalAuthority,
	CloudClaudeLoginRenewer,
	checkClaudeLogin,
	claudeLoginCheckFiles,
	claudeStatusLoggedIn,
	parseClaudeLoginCheck,
} from "@qorpera/runtime/cloud-claude-login-renewal";
import { type ClaudeLoginRunAuthority, CloudClaudeLoginVault } from "@qorpera/runtime/cloud-claude-login-vault";
import { ModelLoginHelperClient, ModelLoginHelperService } from "@qorpera/runtime/cloud-model-login-helper";
import { CLAUDE_LOGIN_FILES_SCHEMA } from "@qorpera/runtime/cloud-model-login-sign-in";
import type { ModelLoginRunBinding } from "@qorpera/runtime/cloud-model-login-vault";
import { CLAUDE_LOGIN_FIELD } from "@qorpera/runtime/cloud-model-login-vault-sign-in";
import { OfficialCliNativeHarnessDriver } from "@qorpera/runtime/cloud-native-provider-host";
import { CloudSecretKeyring } from "@qorpera/runtime/cloud-secret-crypto";
import { afterEach, describe, expect, it } from "vitest";

const CANARY = `CANARY-PARALLEL-${randomUUID()}`;
const credentials = (tag: string) =>
	`{"claudeAiOauth":{"accessToken":"${CANARY}-${tag}","refreshToken":"${CANARY}-r-${tag}"}}`;
const SETTINGS = '{"hasCompletedOnboarding":true}';
const b64 = (text: string) => Buffer.from(text).toString("base64");
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

const output: string[] = [];
for (const name of ["log", "error", "warn", "info"] as const) {
	const original = console[name];
	console[name] = (...args: unknown[]) => {
		output.push(args.map(String).join(" "));
		original(...args);
	};
}
afterEach(() => {
	expect(output.join("\n")).not.toContain(CANARY);
});

function database() {
	const keyring = new CloudSecretKeyring({}, { "vault-root-1": randomBytes(32) });
	const login = {
		id: randomUUID(),
		owner: randomUUID(),
		keyId: "vault-root-1",
		version: 1,
		status: "active" as "active" | "revoked",
		token: null as string | null,
		checkedAt: Number.NEGATIVE_INFINITY,
		refusedVersion: null as number | null,
		live: true,
	};
	const seal = (credentialsText: string, version: number) =>
		Buffer.from(
			keyring.sealMember(
				{
					[CLAUDE_LOGIN_FIELD]: JSON.stringify({
						schema: CLAUDE_LOGIN_FILES_SCHEMA,
						files: { ".credentials.json": b64(credentialsText), ".claude.json": b64(SETTINGS) },
					}),
				},
				{ memberId: login.owner, loginId: login.id, version, keyId: login.keyId },
			),
		);
	let envelope = seal(credentials("v1"), 1);
	const calls: string[] = [];
	const taken = () => {
		login.token = randomUUID();
		return {
			schema: "qorpera.claude-login-renewal/v1",
			claudeLoginId: login.id,
			ownerUserId: login.owner,
			keyId: login.keyId,
			version: login.version,
			envelopeSha256: sha(envelope),
			encryptedEnvelopeBase64: envelope.toString("base64"),
			renewal: { token: login.token, baseVersion: login.version },
		};
	};
	const none = { schema: "qorpera.claude-login-renewal/v1", renewal: null };
	const authority: ClaudeLoginRenewalAuthority = {
		takeClaudeLoginRenewal: async (request) => {
			calls.push(`take:${request.purpose}`);
			return login.status === "active" && login.live && login.token === null && request.claudeLoginId === login.id
				? taken()
				: none;
		},
		takeIdleClaudeLoginRenewal: async () => {
			calls.push("idle");
			return login.status === "active" && login.token === null && login.checkedAt < 0 ? taken() : none;
		},
		commitClaudeLoginRenewal: async (commit) => {
			calls.push("commit");
			if (commit.token !== login.token) return { schema: "qorpera.claude-login-renewal-commit/v1", state: "stale" };
			if (commit.baseVersion !== login.version || commit.baseEnvelopeSha256 !== sha(envelope)) {
				login.token = null;
				return { schema: "qorpera.claude-login-renewal-commit/v1", state: "stale" };
			}
			envelope = Buffer.from(commit.encryptedEnvelope);
			login.version += 1;
			login.token = null;
			login.checkedAt = Date.now();
			return {
				schema: "qorpera.claude-login-renewal-commit/v1",
				state: "sealed",
				claudeLoginId: login.id,
				version: login.version,
				envelopeSha256: sha(envelope),
			};
		},
		releaseClaudeLoginRenewal: async (release) => {
			calls.push(`release:${release.outcome}`);
			if (release.token !== login.token)
				return { schema: "qorpera.claude-login-renewal-release/v1", state: "stale" };
			login.token = null;
			login.checkedAt = Date.now();
			if (release.outcome === "refused") {
				if (login.refusedVersion === login.version) {
					login.status = "revoked";
					return { schema: "qorpera.claude-login-renewal-release/v1", state: "signed_out" };
				}
				login.refusedVersion = login.version;
			}
			return { schema: "qorpera.claude-login-renewal-release/v1", state: "released" };
		},
	};
	const opened = async (): Promise<Record<string, string>> =>
		keyring.useMember(
			envelope,
			{ memberId: login.owner, loginId: login.id, version: login.version, keyId: login.keyId },
			async (fields) => {
				const files = (JSON.parse(fields[CLAUDE_LOGIN_FIELD] as string) as { files: Record<string, string> }).files;
				return Object.fromEntries(
					Object.entries(files).map(([name, text]) => [name, Buffer.from(text, "base64").toString()]),
				);
			},
		);
	const runAuthority: ClaudeLoginRunAuthority = {
		openClaudeLoginForRun: async (_binding, _signal, knownVersion) => {
			calls.push(`open:${knownVersion ?? "-"}`);
			if (login.status !== "active")
				return { schema: "qorpera.claude-login-for-run/v1", state: "refused", reason: "SIGNED_OUT" };
			if (knownVersion === login.version)
				return {
					schema: "qorpera.claude-login-for-run/v1",
					state: "current",
					claudeLoginId: login.id,
					version: login.version,
				};
			return {
				schema: "qorpera.claude-login-for-run/v1",
				state: "open",
				claudeLoginId: login.id,
				ownerUserId: login.owner,
				keyId: login.keyId,
				version: login.version,
				envelopeSha256: sha(envelope),
				encryptedEnvelopeBase64: envelope.toString("base64"),
			};
		},
		openClaudeLoginForSealBack: async () => {
			throw new Error("not in these tests");
		},
		sealClaudeLoginBack: async () => {
			throw new Error("not in these tests");
		},
	};
	return { keyring, login, authority, runAuthority, calls, opened };
}

function checker(answers: ClaudeLoginCheck[]) {
	const sent: Record<string, string>[] = [];
	return {
		sent,
		checkClaudeLogin: async (files: Readonly<Record<string, string | undefined>>) => {
			sent.push(
				Object.fromEntries(
					Object.entries(files).map(([name, text]) => [name, Buffer.from(text as string, "base64").toString()]),
				),
			);
			return answers.shift() ?? { outcome: "unchanged" };
		},
	};
}

const binding = (): ModelLoginRunBinding => ({
	leaseId: randomUUID(),
	runId: randomUUID(),
	jobId: randomUUID(),
	runnerId: randomUUID(),
	assignmentId: randomUUID(),
	credentialCapsuleId: randomUUID(),
	computeIdentityId: randomUUID(),
});

describe("the vault's Claude renewer", () => {
	it("seals what Claude Code renewed as the next version, under the member's key, with the files it did not touch", async () => {
		const db = database();
		const check = checker([{ outcome: "renewed", credentials: b64(credentials("v2")) }]);
		const renewer = new CloudClaudeLoginRenewer({ authority: db.authority, checker: check, keyring: db.keyring });
		expect(await renewer.check(db.login.id, "open")).toBe("renewed");
		expect(check.sent).toEqual([{ ".credentials.json": credentials("v1"), ".claude.json": SETTINGS }]);
		expect(db.login.version).toBe(2);
		expect(await db.opened()).toEqual({ ".credentials.json": credentials("v2"), ".claude.json": SETTINGS });
		expect(db.calls).toEqual(["take:open", "commit"]);
	});

	it("releases a check that renewed nothing, and one Claude Code refused; a second refusal signs out", async () => {
		const db = database();
		const check = checker([
			{ outcome: "unchanged" },
			{ outcome: "failed" },
			{ outcome: "refused" },
			{ outcome: "refused" },
		]);
		const renewer = new CloudClaudeLoginRenewer({ authority: db.authority, checker: check, keyring: db.keyring });
		expect(await renewer.check(db.login.id, "poll")).toBe("unchanged");
		expect(await renewer.check(db.login.id, "poll")).toBe("failed");
		expect(await renewer.check(db.login.id, "poll")).toBe("refused");
		expect(db.login.status).toBe("active");
		expect(await renewer.check(db.login.id, "poll")).toBe("signed_out");
		expect(db.login.status).toBe("revoked");
		expect(await renewer.check(db.login.id, "poll")).toBe("none");
		expect(db.login.version).toBe(1);
		expect(db.calls).toEqual([
			"take:poll",
			"release:unchanged",
			"take:poll",
			"release:failed",
			"take:poll",
			"release:refused",
			"take:poll",
			"release:refused",
			"take:poll",
		]);
	});

	it("checks one login once at a time on this vault host, and a check that throws releases as failed", async () => {
		const db = database();
		let finish: (check: ClaudeLoginCheck) => void = () => undefined;
		let checks = 0;
		const renewer = new CloudClaudeLoginRenewer({
			authority: db.authority,
			checker: {
				checkClaudeLogin: () => {
					checks += 1;
					return new Promise((resolve) => {
						finish = resolve;
					});
				},
			},
			keyring: db.keyring,
		});
		const first = renewer.check(db.login.id, "poll");
		const second = renewer.check(db.login.id, "open");
		for (let i = 0; i < 50 && checks === 0; i++) await new Promise((r) => setTimeout(r, 2));
		finish({ outcome: "renewed", credentials: b64(credentials("v2")) });
		expect(await first).toBe("renewed");
		expect(await second).toBe("renewed");
		expect(checks).toBe(1);
		const failing = new CloudClaudeLoginRenewer({
			authority: db.authority,
			checker: {
				checkClaudeLogin: async () => {
					throw new Error("helper away");
				},
			},
			keyring: db.keyring,
		});
		expect(await failing.check(db.login.id, "poll")).toBe("failed");
		expect(db.calls.slice(-2)).toEqual(["take:poll", "release:failed"]);
	});

	it("leaves a commit that lost its lock or its base as no renewal, and tries a commit the database did not answer again", async () => {
		const db = database();
		const commit = db.authority.commitClaudeLoginRenewal;
		let failures = 1;
		db.authority.commitClaudeLoginRenewal = async (request, signal) => {
			if (failures-- > 0) throw new Error("database away");
			return commit(request, signal);
		};
		const renewer = new CloudClaudeLoginRenewer({
			authority: db.authority,
			checker: checker([
				{ outcome: "renewed", credentials: b64(credentials("v2")) },
				{ outcome: "renewed", credentials: b64(credentials("v3")) },
			]),
			keyring: db.keyring,
		});
		expect(await renewer.check(db.login.id, "poll")).toBe("renewed");
		expect(db.login.version).toBe(2);
		db.authority.commitClaudeLoginRenewal = async (request, signal) => {
			db.login.version += 1;
			return commit(request, signal);
		};
		expect(await renewer.check(db.login.id, "poll")).toBe("none");
		expect(db.login.version).toBe(3);
	});

	it("gives an open no longer than its wait, and goes on renewing after it", async () => {
		const db = database();
		let finish: (check: ClaudeLoginCheck) => void = () => undefined;
		const renewer = new CloudClaudeLoginRenewer({
			authority: db.authority,
			checker: {
				checkClaudeLogin: () =>
					new Promise((resolve) => {
						finish = resolve;
					}),
			},
			keyring: db.keyring,
			openWaitMs: 20,
		});
		expect(await renewer.checkForRun(db.login.id, "open")).toBe("not_renewed");
		const later = renewer.check(db.login.id, "open");
		finish({ outcome: "renewed", credentials: b64(credentials("v2")) });
		expect(await later).toBe("renewed");
		expect(db.login.version).toBe(2);
	});

	it("lets an open wait for another vault host's renewal of the same login, then open again", async () => {
		const db = database();
		let busy = 2;
		db.authority.takeClaudeLoginRenewal = async () => {
			db.calls.push("take");
			if (busy-- > 0) return { schema: "qorpera.claude-login-renewal/v1", renewal: null, busy: true };
			return { schema: "qorpera.claude-login-renewal/v1", renewal: null, busy: false };
		};
		const renewer = new CloudClaudeLoginRenewer({
			authority: db.authority,
			checker: checker([]),
			keyring: db.keyring,
			openWaitMs: 5000,
		});
		expect(await renewer.checkForRun(db.login.id, "open")).toBe("renewed");
		expect(db.calls).toEqual(["take", "take", "take"]);
		db.calls.length = 0;
		busy = 100;
		const short = new CloudClaudeLoginRenewer({
			authority: db.authority,
			checker: checker([]),
			keyring: db.keyring,
			openWaitMs: 600,
		});
		const started = Date.now();
		expect(await short.checkForRun(db.login.id, "open")).toBe("renewed");
		expect(Date.now() - started).toBeLessThan(2000);
		db.authority.takeClaudeLoginRenewal = async () => ({
			schema: "qorpera.claude-login-renewal/v1",
			renewal: null,
			busy: false,
		});
		expect(await short.checkForRun(db.login.id, "poll")).toBe("not_renewed");
	});

	it("checks idle logins in the upkeep pass, a few at a time", async () => {
		const db = database();
		const renewer = new CloudClaudeLoginRenewer({
			authority: db.authority,
			checker: checker([{ outcome: "unchanged" }]),
			keyring: db.keyring,
		});
		expect(await renewer.idle()).toBe(1);
		expect(await renewer.idle()).toBe(0);
		expect(db.calls).toEqual(["idle", "release:unchanged", "idle", "idle"]);
	});

	it("refuses a taken renewal out of shape", async () => {
		const db = database();
		db.authority.takeClaudeLoginRenewal = async () => ({
			schema: "qorpera.claude-login-renewal/v1",
			renewal: null,
			x: 1,
		});
		const renewer = new CloudClaudeLoginRenewer({
			authority: db.authority,
			checker: checker([]),
			keyring: db.keyring,
		});
		await expect(renewer.check(db.login.id, "open")).rejects.toThrow("Claude login renewal is invalid");
	});
});

describe("the open for a run", () => {
	it("checks at the open and at each poll, answers current to a run that holds the newest, and the newer files else", async () => {
		const db = database();
		const renewer = new CloudClaudeLoginRenewer({
			authority: db.authority,
			checker: checker([{ outcome: "unchanged" }, { outcome: "renewed", credentials: b64(credentials("v2")) }]),
			keyring: db.keyring,
		});
		const vault = new CloudClaudeLoginVault({ authority: db.runAuthority, keyring: db.keyring, renewer });
		const run = binding();
		const first = await vault.open({ binding: run }, AbortSignal.timeout(5000));
		expect(first).toMatchObject({ state: "open", version: 1 });
		const polled = await vault.open({ binding: run, knownVersion: 1 }, AbortSignal.timeout(5000));
		expect(polled.state).toBe("open");
		if (polled.state !== "open") throw new Error("open expected");
		expect(polled.version).toBe(2);
		expect(Buffer.from(polled.files[".credentials.json"] as string, "base64").toString()).toBe(credentials("v2"));
		expect(await vault.open({ binding: run, knownVersion: 2 }, AbortSignal.timeout(5000))).toEqual({
			schema: "qorpera.claude-login-files-for-run/v1",
			state: "current",
			claudeLoginId: db.login.id,
			version: 2,
		});
		expect(db.calls).toEqual([
			"open:-",
			"take:open",
			"release:unchanged",
			"open:1",
			"take:poll",
			"commit",
			"open:1",
			"open:2",
			"take:poll",
			"release:unchanged",
		]);
	});

	it("answers a signed-out login's refusal and checks nothing", async () => {
		const db = database();
		db.login.status = "revoked";
		const vault = new CloudClaudeLoginVault({
			authority: db.runAuthority,
			keyring: db.keyring,
			renewer: new CloudClaudeLoginRenewer({ authority: db.authority, checker: checker([]), keyring: db.keyring }),
		});
		expect(await vault.open({ binding: binding(), knownVersion: 3 }, AbortSignal.timeout(5000))).toEqual({
			schema: "qorpera.claude-login-files-for-run/v1",
			state: "refused",
			reason: "SIGNED_OUT",
		});
		expect(db.calls).toEqual(["open:3"]);
	});
});

describe("the helper's check, with Claude Code's own status", () => {
	const roots: string[] = [];
	afterEach(async () => {
		for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
	});

	async function fakeClaude(script: string): Promise<{ path: string; temporaryRoot: string }> {
		const root = await mkdtemp(join(tmpdir(), "claude-check-"));
		roots.push(root);
		const path = join(root, "claude");
		await writeFile(path, `#!/bin/sh\n${script}\n`, { mode: 0o755 });
		await chmod(path, 0o755);
		const temporaryRoot = join(root, "tmp");
		await mkdir(temporaryRoot, { mode: 0o700 });
		return { path, temporaryRoot };
	}

	const files = { ".credentials.json": b64(credentials("v1")), ".claude.json": b64(SETTINGS) };

	it("answers renewed with the file Claude Code rewrote, unchanged, refused or failed, and leaves nothing", async () => {
		const cases: [string, ClaudeLoginCheck["outcome"]][] = [
			[
				`[ "$*" = "auth status --json" ] || exit 9\nprintf '%s' '${credentials("v2")}' > "$CLAUDE_CONFIG_DIR/.credentials.json.new" && mv "$CLAUDE_CONFIG_DIR/.credentials.json.new" "$CLAUDE_CONFIG_DIR/.credentials.json"\necho '{"loggedIn": true, "authMethod": "claude.ai"}'`,
				"renewed",
			],
			[`echo '{"loggedIn": true}'`, "unchanged"],
			[`echo '{"loggedIn": false, "authMethod": "none"}'; exit 1`, "refused"],
			[`echo 'not json'`, "failed"],
			[`echo '{"loggedIn": true}'; exit 3`, "failed"],
			[`rm "$CLAUDE_CONFIG_DIR/.credentials.json"; echo '{"loggedIn": true}'`, "failed"],
		];
		for (const [script, outcome] of cases) {
			const fake = await fakeClaude(script);
			const driver = new OfficialCliNativeHarnessDriver("/nonexistent/codex", fake.path, undefined);
			const check = await checkClaudeLogin(
				{ driver, temporaryRoot: fake.temporaryRoot },
				files,
				AbortSignal.timeout(10_000),
			);
			expect(check.outcome).toBe(outcome);
			if (check.outcome === "renewed")
				expect(Buffer.from(check.credentials, "base64").toString()).toBe(credentials("v2"));
			expect(await readdir(fake.temporaryRoot)).toEqual([]);
		}
	});

	it("serves the check over the helper's socket, for an authenticated client only", async () => {
		const root = await mkdtemp(join(tmpdir(), "claude-check-socket-"));
		roots.push(root);
		const socketPath = join(root, "helper.sock");
		const token = randomBytes(32).toString("base64url").slice(0, 43);
		const seen: Record<string, string | undefined>[] = [];
		const service = new ModelLoginHelperService({
			socketPath,
			token,
			renewer: { renew: async () => ({ outcome: "transient", reason: "unused" }) },
			claude: {
				checkClaudeLogin: async (sent) => {
					seen.push({ ...sent });
					return { outcome: "renewed", credentials: b64(credentials("v2")) };
				},
			},
		});
		await service.start();
		try {
			const client = new ModelLoginHelperClient({ socketPath, token });
			expect(await client.checkClaudeLogin(files, AbortSignal.timeout(5000))).toEqual({
				outcome: "renewed",
				credentials: b64(credentials("v2")),
			});
			expect(seen).toEqual([files]);
			const stranger = new ModelLoginHelperClient({
				socketPath,
				token: randomBytes(32).toString("base64url").slice(0, 43),
			});
			await expect(stranger.checkClaudeLogin(files, AbortSignal.timeout(5000))).rejects.toThrow();
			await expect(
				client.checkClaudeLogin({ ".claude.json": b64(SETTINGS) }, AbortSignal.timeout(5000)),
			).rejects.toThrow();
			expect(seen).toHaveLength(1);
		} finally {
			await service.close();
		}
	});

	it("reads loggedIn from Claude Code's output and nothing else", () => {
		expect(claudeStatusLoggedIn('warn\n{\n  "loggedIn": true,\n  "email": "a@b.c"\n}\n')).toBe(true);
		expect(claudeStatusLoggedIn('{"loggedIn": false}')).toBe(false);
		expect(claudeStatusLoggedIn('{"loggedIn": "yes"}')).toBeUndefined();
		expect(claudeStatusLoggedIn("")).toBeUndefined();
		expect(parseClaudeLoginCheck({ schema: "qorpera.claude-login-check/v1", outcome: "unchanged" })).toEqual({
			outcome: "unchanged",
		});
		expect(() => parseClaudeLoginCheck({ schema: "qorpera.claude-login-check/v1", outcome: "renewed" })).toThrow();
		expect(() => claudeLoginCheckFiles({ ".credentials.json": b64("x"), "notes.txt": b64("y") })).toThrow();
	});
});
