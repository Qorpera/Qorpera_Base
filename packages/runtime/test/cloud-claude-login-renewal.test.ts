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
import {
	CloudSecretBroker,
	PostgresCloudSecretBrokerAuthority,
	PostgresCloudSecretBrokerPrincipal,
} from "@qorpera/runtime/cloud-secret-broker";
import { HttpCloudSecretBrokerService, openClaudeLoginForRun } from "@qorpera/runtime/cloud-secret-broker-http";
import {
	type CloudSecretBrokerCompanies,
	SharedCloudSecretBrokerCompanies,
} from "@qorpera/runtime/cloud-secret-broker-shared";
import { CloudSecretKeyring } from "@qorpera/runtime/cloud-secret-crypto";
import { CloudSecretBrokerBusyError, cloudVaultDatabaseBusy } from "@qorpera/runtime/cloud-vault-database-failure";
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

	it("gives a poll no longer than its wait and a first open longer, and goes on renewing after either", async () => {
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
			firstOpenWaitMs: 60,
		});
		let started = Date.now();
		expect(await renewer.checkForRun(db.login.id, "poll")).toBe("pending");
		expect(Date.now() - started).toBeLessThan(55);
		started = Date.now();
		expect(await renewer.checkForRun(db.login.id, "open")).toBe("pending");
		expect(Date.now() - started).toBeGreaterThanOrEqual(55);
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
			firstOpenWaitMs: 5000,
		});
		expect(await renewer.checkForRun(db.login.id, "open")).toBe("reopen");
		expect(db.calls).toEqual(["take", "take", "take"]);
		db.calls.length = 0;
		busy = 100;
		const short = new CloudClaudeLoginRenewer({
			authority: db.authority,
			checker: checker([]),
			keyring: db.keyring,
			openWaitMs: 600,
			firstOpenWaitMs: 600,
		});
		const started = Date.now();
		expect(await short.checkForRun(db.login.id, "open")).toBe("pending");
		expect(Date.now() - started).toBeLessThan(2000);
		db.authority.takeClaudeLoginRenewal = async () => ({
			schema: "qorpera.claude-login-renewal/v1",
			renewal: null,
			busy: false,
		});
		expect(await short.checkForRun(db.login.id, "poll")).toBe("keep");
	});

	it("keeps a renewal it could not save and saves it before anything else, so the rotated token is never lost", async () => {
		const db = database();
		const commit = db.authority.commitClaudeLoginRenewal;
		let away = true;
		db.authority.commitClaudeLoginRenewal = async (request, signal) => {
			if (away) throw new Error("database away");
			return commit(request, signal);
		};
		const check = checker([{ outcome: "renewed", credentials: b64(credentials("v2")) }]);
		const renewer = new CloudClaudeLoginRenewer({
			authority: db.authority,
			checker: check,
			keyring: db.keyring,
			commitRetryMs: 30,
		});
		expect(await renewer.check(db.login.id, "poll")).toBe("failed");
		expect(db.login.version).toBe(1);
		expect(output.join("\n")).toContain("a renewed login is not saved yet");
		away = false;
		expect(await renewer.check(db.login.id, "poll")).toBe("renewed");
		expect(check.sent).toHaveLength(1);
		expect(db.login.version).toBe(2);
		expect(await db.opened()).toEqual({ ".credentials.json": credentials("v2"), ".claude.json": SETTINGS });
		const idle = new CloudClaudeLoginRenewer({
			authority: db.authority,
			checker: checker([{ outcome: "renewed", credentials: b64(credentials("v3")) }]),
			keyring: db.keyring,
			commitRetryMs: 30,
		});
		db.login.checkedAt = Number.NEGATIVE_INFINITY;
		away = true;
		expect(await idle.idle()).toBe(1);
		away = false;
		db.login.checkedAt = Date.now();
		await idle.idle();
		expect(db.login.version).toBe(3);
	});

	it("has the open read again when a kept renewal finds a newer version saved meanwhile", async () => {
		const db = database();
		const commit = db.authority.commitClaudeLoginRenewal;
		let away = true;
		db.authority.commitClaudeLoginRenewal = async (request, signal) => {
			if (away) throw new Error("database away");
			return commit(request, signal);
		};
		const renewer = new CloudClaudeLoginRenewer({
			authority: db.authority,
			checker: checker([{ outcome: "renewed", credentials: b64(credentials("v2")) }]),
			keyring: db.keyring,
			commitRetryMs: 20,
		});
		expect(await renewer.check(db.login.id, "poll")).toBe("failed");
		away = false;
		db.login.version = 2;
		db.login.token = null;
		expect(await renewer.checkForRun(db.login.id, "poll")).toBe("reopen");
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

	it("answers SIGNED_OUT at once when the open's own check signs the login out", async () => {
		const db = database();
		db.login.refusedVersion = 1;
		const vault = new CloudClaudeLoginVault({
			authority: db.runAuthority,
			keyring: db.keyring,
			renewer: new CloudClaudeLoginRenewer({
				authority: db.authority,
				checker: checker([{ outcome: "refused" }]),
				keyring: db.keyring,
			}),
		});
		expect(await vault.open({ binding: binding() }, AbortSignal.timeout(5000))).toEqual({
			schema: "qorpera.claude-login-files-for-run/v1",
			state: "refused",
			reason: "SIGNED_OUT",
		});
		expect(db.calls).toEqual(["open:-", "take:open", "release:refused", "open:-"]);
	});

	it("answers a first open busy while its renewal still runs, and a poll with what it has", async () => {
		const db = database();
		let finish: (check: ClaudeLoginCheck) => void = () => undefined;
		let checks = 0;
		const renewer = new CloudClaudeLoginRenewer({
			authority: db.authority,
			checker: {
				checkClaudeLogin: () =>
					checks++ === 0
						? new Promise((resolve) => {
								finish = resolve;
							})
						: Promise.resolve({ outcome: "unchanged" }),
			},
			keyring: db.keyring,
			openWaitMs: 20,
			firstOpenWaitMs: 40,
		});
		const vault = new CloudClaudeLoginVault({ authority: db.runAuthority, keyring: db.keyring, renewer });
		const error = await vault
			.open({ binding: binding() }, AbortSignal.timeout(5000))
			.catch((caught: unknown) => caught);
		expect(cloudVaultDatabaseBusy(error)).toBe(true);
		expect(await vault.open({ binding: binding(), knownVersion: 1 }, AbortSignal.timeout(5000))).toMatchObject({
			state: "current",
			version: 1,
		});
		finish({ outcome: "renewed", credentials: b64(credentials("v2")) });
		for (let i = 0; i < 100 && db.login.version === 1; i++) await new Promise((r) => setTimeout(r, 5));
		expect(await vault.open({ binding: binding() }, AbortSignal.timeout(5000))).toMatchObject({
			state: "open",
			version: 2,
		});
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
			[
				`printf '%s' '${credentials("v2")}' > "$CLAUDE_CONFIG_DIR/.credentials.json"; echo 'cut short'; exit 3`,
				"renewed",
			],
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

describe("the vault's database calls, its route and its upkeep", () => {
	function recording() {
		const queries: { text: string; values: readonly unknown[] }[] = [];
		return {
			queries,
			database: {
				async query<Row extends Record<string, unknown>>(text: string, values: readonly unknown[]) {
					queries.push({ text, values });
					return { rowCount: 1, rows: [{ result: { ok: true } } as unknown as Row] };
				},
			},
		};
	}

	it("calls migration 790000's functions with their arguments in order", async () => {
		const { queries, database } = recording();
		const principalId = randomUUID();
		const principal = new PostgresCloudSecretBrokerPrincipal({
			database,
			principalId,
			principalSecret: randomBytes(32).toString("base64url"),
		});
		const loginId = randomUUID();
		const token = randomUUID();
		const signal = AbortSignal.timeout(5000);
		await principal.takeClaudeLoginRenewal({ claudeLoginId: loginId, purpose: "poll" }, signal);
		await principal.takeIdleClaudeLoginRenewal(signal);
		await principal.commitClaudeLoginRenewal(
			{
				claudeLoginId: loginId,
				token,
				baseVersion: 3,
				baseEnvelopeSha256: "a".repeat(64),
				keyId: "vault-root-1",
				encryptedEnvelope: Buffer.from("sealed"),
				envelopeSha256: "b".repeat(64),
			},
			signal,
		);
		await principal.releaseClaudeLoginRenewal({ claudeLoginId: loginId, token, outcome: "refused" }, signal);
		const capability = queries[0]?.values[1];
		expect(queries.map((query) => query.text)).toEqual([
			"select public.qorpera_take_claude_login_renewal($1::uuid,$2::text,$3::uuid,$4::text) as result",
			"select public.qorpera_take_idle_claude_login_renewal($1::uuid,$2::text) as result",
			"select public.qorpera_commit_claude_login_renewal($1::uuid,$2::text,$3::uuid,$4::uuid,$5::bigint,$6::text,$7::text,$8::text,$9::text) as result",
			"select public.qorpera_release_claude_login_renewal($1::uuid,$2::text,$3::uuid,$4::uuid,$5::text) as result",
		]);
		expect(queries.map((query) => query.values)).toEqual([
			[principalId, capability, loginId, "poll"],
			[principalId, capability],
			[
				principalId,
				capability,
				loginId,
				token,
				3,
				"a".repeat(64),
				"vault-root-1",
				Buffer.from("sealed").toString("base64"),
				"b".repeat(64),
			],
			[principalId, capability, loginId, token, "refused"],
		]);
		expect(capability).toMatch(/^[0-9a-f]{64}$/);
		const run = recording();
		const authorityId = randomUUID();
		const authority = new PostgresCloudSecretBrokerAuthority({
			database: run.database,
			brokerAuthorityId: authorityId,
			brokerCapability: randomBytes(32).toString("base64url"),
		});
		const bound = binding();
		await authority.openClaudeLoginForRun(bound, signal);
		await authority.openClaudeLoginForRun(bound, signal, 4);
		expect(run.queries.map((query) => query.text)).toEqual([
			"select public.qorpera_open_claude_login_for_run($1::uuid,$2::text,$3::jsonb) as result",
			"select public.qorpera_open_claude_login_for_run($1::uuid,$2::text,$3::jsonb,$4::bigint) as result",
		]);
		expect(run.queries[1]?.values).toEqual([authorityId, run.queries[0]?.values[1], JSON.stringify(bound), 4]);
	});

	it("serves a poll its current version and a first open busy over the route, and the client reads both", async () => {
		const db = database();
		let first = true;
		const vault = new CloudClaudeLoginVault({
			authority: db.runAuthority,
			keyring: db.keyring,
			renewer: {
				checkForRun: async (_id, purpose) => {
					if (purpose === "open" && first) {
						first = false;
						return "pending";
					}
					return "keep";
				},
			},
		});
		const refuse = async () => {
			throw new Error("not in this test");
		};
		const companyId = randomUUID();
		const companies: CloudSecretBrokerCompanies = {
			resolve: async (id) =>
				id === companyId
					? {
							companyId,
							broker: new CloudSecretBroker({
								authority: {
									describeCapture: refuse,
									completeCapture: refuse,
									authorizeOperation: refuse,
									authorizeRepositoryCredential: refuse,
								},
								keyring: db.keyring,
								adapters: [],
							}),
							modelLogins: {} as never,
							modelLoginSignIns: undefined,
							modelLoginUsage: {} as never,
							claudeLogins: vault,
						}
					: undefined,
			signingIn: () => undefined,
		};
		const runtimeToken = randomBytes(32).toString("base64url");
		const service = new HttpCloudSecretBrokerService(companies, runtimeToken, {
			proveBinding: async () => undefined,
		});
		const port = await service.start();
		try {
			const run = binding();
			const holder = `job.${run.jobId}.${randomBytes(32).toString("base64url")}`;
			const client = {
				origin: `http://127.0.0.1:${port}`,
				runtimeToken,
				companyId,
				holder: () => holder,
				allowLoopback: true,
			};
			await expect(openClaudeLoginForRun(client, run, AbortSignal.timeout(5000))).rejects.toBeInstanceOf(
				CloudSecretBrokerBusyError,
			);
			const opened = await openClaudeLoginForRun(client, run, AbortSignal.timeout(5000));
			if ("refused" in opened) throw new Error("refused");
			expect(opened.version).toBe(1);
			expect(await openClaudeLoginForRun(client, run, AbortSignal.timeout(5000), 1)).toEqual({
				current: true,
				claudeLoginId: db.login.id,
				version: 1,
			});
			const newer = await openClaudeLoginForRun(client, run, AbortSignal.timeout(5000), 7);
			expect("files" in newer && newer.version === 1).toBe(true);
			expect(db.calls.filter((call) => call.startsWith("open:"))).toEqual(["open:-", "open:-", "open:1", "open:7"]);
			const raw = await fetch(`http://127.0.0.1:${port}/v1/claude-logins/open?company=${companyId}`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					authorization: `Bearer ${runtimeToken}`,
					"x-qorpera-identity": holder,
				},
				body: JSON.stringify({ schema: "qorpera.claude-login-open-request/v1", binding: run, knownVersion: 0 }),
			});
			expect(raw.status).toBe(403);
		} finally {
			await service.close();
		}
	});

	it("runs the Claude idle pass in the shared vault's upkeep only with a helper that checks Claude logins", async () => {
		const takes: string[] = [];
		const principal = {
			companies: async () => ({ schema: "qorpera.broker-principal-companies/v1", companies: [], register: [] }),
			register: async () => undefined,
			authority: () => ({}) as never,
			eventVerificationsDue: async () => ({ companies: [] }),
			bankSyncsDue: async () => ({ companies: [] }),
			digitalPostSyncsDue: async () => ({ companies: [] }),
			takeClaudeLoginRenewal: async () => ({ schema: "qorpera.claude-login-renewal/v1", renewal: null }),
			takeIdleClaudeLoginRenewal: async () => {
				takes.push("idle");
				return { schema: "qorpera.claude-login-renewal/v1", renewal: null };
			},
			commitClaudeLoginRenewal: async () => ({}),
			releaseClaudeLoginRenewal: async () => ({}),
		};
		const keyring = new CloudSecretKeyring({}, { "vault-root-1": randomBytes(32) });
		const helper = {
			renew: async () => ({ outcome: "transient" as const, reason: "unused" }),
			beginSignIn: async () => ({ status: "preparing" as const }),
			readSignIn: async () => ({ status: "unknown" as const }),
			listCompletedSignIns: async () => [],
			finishSignIn: async () => undefined,
		};
		await new SharedCloudSecretBrokerCompanies({
			principal: principal as never,
			keyring,
			adapters: [],
			helper,
		}).upkeep();
		expect(takes).toEqual([]);
		await new SharedCloudSecretBrokerCompanies({
			principal: principal as never,
			keyring,
			adapters: [],
			helper: { ...helper, checkClaudeLogin: async () => ({ outcome: "unchanged" as const }) },
		}).upkeep();
		expect(takes).toEqual(["idle"]);
	});
});
