import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isUuid } from "@qorpera/contracts";
import type { ClaudeLoginReads } from "@qorpera/runtime/cloud-claude-login-reader";
import type { ClaudeLoginUsage } from "@qorpera/runtime/cloud-claude-login-usage";
import { ModelLoginHelperClient, ModelLoginHelperService } from "@qorpera/runtime/cloud-model-login-helper";
import { CLAUDE_LOGIN_FILES_SCHEMA } from "@qorpera/runtime/cloud-model-login-sign-in";
import { CLAUDE_LOGIN_FIELD } from "@qorpera/runtime/cloud-model-login-vault-sign-in";
import { CloudModelLoginUsage, type ModelLoginUsageAuthority } from "@qorpera/runtime/cloud-model-login-vault-usage";
import { CloudSecretKeyring } from "@qorpera/runtime/cloud-secret-crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

const CREDENTIALS = `{"claudeAiOauth":{"accessToken":"CANARY-USAGE-${randomUUID()}","refreshToken":"CANARY-USAGE-REFRESH"}}`;
const SETTINGS = `{"oauthAccount":{"emailAddress":"canary-usage@example.test"}}`;
const b64 = (text: string) => Buffer.from(text).toString("base64");
const USAGE: ClaudeLoginUsage = {
	observedAt: "2026-11-17T11:00:00.000Z",
	windows: [{ id: "seven_day", label: "Weekly", usedPercent: 28, resetAt: "2026-11-21T13:00:00.000Z" }],
};
const RESETS = {
	observedAt: "2026-11-17T11:00:00.000Z",
	entries: [
		{
			kind: "full" as const,
			left: 3,
			refills: "5-hour and weekly limits",
			weekStays: null,
			useBy: "2026-12-01T00:00:00.000Z",
			usable: "now" as const,
		},
	],
};

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function helper(reads: ClaudeLoginReads) {
	const directory = await mkdtemp(join(tmpdir(), "claude-reads-"));
	const socketPath = join(directory, "helper.sock");
	const token = randomBytes(32).toString("base64url");
	const vaultToken = randomBytes(32).toString("base64url");
	const service = new ModelLoginHelperService({
		socketPath,
		token,
		vaultToken,
		renewer: { renew: vi.fn() },
		claudeReads: reads,
	});
	await service.start();
	cleanups.push(async () => {
		await service.close();
		await rm(directory, { recursive: true, force: true });
	});
	return {
		vault: new ModelLoginHelperClient({ socketPath, token: vaultToken }),
		brokers: new ModelLoginHelperClient({ socketPath, token }),
	};
}

describe("the login helper's Claude routes", () => {
	it("reads and resets for the shared vault's own token only, and hands the credentials over unread", async () => {
		const reads = {
			readClaudeLogin: vi.fn(async () => ({ usage: USAGE, resets: RESETS })),
			useClaudeReset: vi.fn(async () => ({ outcome: "reset" as const, left: 2 })),
		};
		const { vault, brokers } = await helper(reads);
		const credentials = b64(CREDENTIALS);
		expect(
			await vault.readClaudeLogin({ credentials, usage: true, resets: true }, AbortSignal.timeout(5_000)),
		).toEqual({
			usage: USAGE,
			resets: RESETS,
		});
		expect(reads.readClaudeLogin).toHaveBeenCalledWith(
			{ credentials, usage: true, resets: true },
			expect.any(AbortSignal),
		);
		expect(await vault.useClaudeReset({ credentials, kind: "full" }, AbortSignal.timeout(5_000))).toEqual({
			outcome: "reset",
			left: 2,
		});
		await expect(
			brokers.readClaudeLogin({ credentials, usage: true, resets: false }, AbortSignal.timeout(5_000)),
		).rejects.toThrow();
		await expect(
			vault.useClaudeReset({ credentials, kind: "lunar" as "full" }, AbortSignal.timeout(5_000)),
		).rejects.toThrow();
		expect(reads.useClaudeReset).toHaveBeenCalledTimes(1);
	});

	it("says nothing was read, or that a reset is unconfirmed, when the reader fails", async () => {
		const { vault } = await helper({
			readClaudeLogin: vi.fn(async () => {
				throw new Error("Claude Code did not start");
			}),
			useClaudeReset: vi.fn(async () => {
				throw new Error("the claim's answer was lost");
			}),
		});
		const credentials = b64(CREDENTIALS);
		expect(
			await vault.readClaudeLogin({ credentials, usage: true, resets: true }, AbortSignal.timeout(5_000)),
		).toEqual({
			usage: null,
			resets: null,
		});
		expect(await vault.useClaudeReset({ credentials, kind: "session" }, AbortSignal.timeout(5_000))).toEqual({
			outcome: "unconfirmed",
		});
	});

	it("drops a 5-hour window an older helper still reads, and keeps no reading made only of one", async () => {
		const five = {
			id: "five_hour",
			label: "5 hours",
			usedPercent: 0,
		} as unknown as ClaudeLoginUsage["windows"][number];
		const reads = {
			readClaudeLogin: vi.fn(async () => ({ usage: { ...USAGE, windows: [five, ...USAGE.windows] }, resets: null })),
			useClaudeReset: vi.fn(),
		};
		const { vault } = await helper(reads);
		const request = { credentials: b64(CREDENTIALS), usage: true, resets: false };
		expect(await vault.readClaudeLogin(request, AbortSignal.timeout(5_000))).toEqual({ usage: USAGE, resets: null });
		reads.readClaudeLogin.mockResolvedValueOnce({ usage: { ...USAGE, windows: [five] }, resets: null });
		expect(await vault.readClaudeLogin(request, AbortSignal.timeout(5_000))).toEqual({ usage: null, resets: null });
	});

	it("refuses a reader's answer out of shape", async () => {
		const { vault } = await helper({
			readClaudeLogin: vi.fn(async () => ({
				usage: { ...USAGE, windows: [{ ...USAGE.windows[0]!, usedPercent: 140 }] },
				resets: null,
			})),
			useClaudeReset: vi.fn(),
		});
		await expect(
			vault.readClaudeLogin(
				{ credentials: b64(CREDENTIALS), usage: true, resets: false },
				AbortSignal.timeout(5_000),
			),
		).rejects.toThrow();
	});
});

function vaultWorld(options: { reset?: "full" | null; resetState?: string | null; status?: string } = {}) {
	const keyring = new CloudSecretKeyring({}, { "vault-root-1": randomBytes(32) });
	cleanups.push(async () => keyring.close());
	const companyId = randomUUID();
	const computeIdentityId = randomUUID();
	const memberId = randomUUID();
	const requestId = randomUUID();
	const claudeLoginId = randomUUID();
	const capability = randomBytes(32).toString("base64url");
	const capabilitySha256 = createHash("sha256").update(capability).digest("hex");
	const expiresAt = new Date(Date.now() + 5 * 60_000).toISOString();
	const envelope = keyring.sealMember(
		{
			[CLAUDE_LOGIN_FIELD]: JSON.stringify({
				schema: CLAUDE_LOGIN_FILES_SCHEMA,
				files: { ".credentials.json": b64(CREDENTIALS), ".claude.json": b64(SETTINGS) },
			}),
		},
		{ memberId, loginId: claudeLoginId, version: 2, keyId: "vault-root-1" },
	);
	const state = {
		resetState: options.resetState ?? (options.reset ? "asked" : null),
		status: options.status ?? "pending",
		claim: "",
		claimLost: false,
		claimThrows: 0,
		recordFails: 0,
	};
	const authority = {
		describeModelLoginAccountRefresh: vi.fn(async () => ({
			schema: "qorpera.model-login-account-refresh/v1",
			requestId,
			profileId: companyId,
			computeIdentityId,
			requestedByUserId: memberId,
			status: state.status,
			expiresAt,
			logins: [],
		})),
		recordModelLoginAccountMetadata: vi.fn(async () => true),
		completeModelLoginAccountRefresh: vi.fn(async () => {
			state.status = "completed";
			return true;
		}),
		describeClaudeLoginRead: vi.fn(async () => ({
			schema: "qorpera.claude-login-read-description/v1",
			state: "open",
			claudeLoginId,
			ownerUserId: memberId,
			keyId: "vault-root-1",
			version: 2,
			envelopeSha256: createHash("sha256").update(envelope).digest("hex"),
			encryptedEnvelopeBase64: Buffer.from(envelope).toString("base64"),
			usage: !options.reset,
			resets: !options.reset,
			reset: options.reset ?? null,
			resetState: state.resetState,
		})),
		claimClaudeLoginReset: vi.fn(async (request: { claim: string }) => {
			if (state.claimLost) {
				state.claimLost = false;
				state.resetState = "using";
				state.claim = request.claim;
				throw new Error("the answer was lost");
			}
			if (state.claimThrows > 0) {
				state.claimThrows -= 1;
				throw new Error("the database did not answer");
			}
			if (state.resetState === "using") return state.claim === request.claim;
			if (state.resetState !== "asked") return false;
			state.resetState = "using";
			state.claim = request.claim;
			return true;
		}),
		recordClaudeLoginRead: vi.fn(
			async (record: Parameters<NonNullable<ModelLoginUsageAuthority["recordClaudeLoginRead"]>>[0]) => {
				if (state.recordFails > 0) {
					state.recordFails -= 1;
					throw new Error("the database did not answer");
				}
				if (record.reset) state.resetState = record.reset.outcome;
				return true;
			},
		),
	} satisfies ModelLoginUsageAuthority;
	const request = {
		companyId,
		capability,
		body: {
			schema: "qorpera.native-account-refresh/v1",
			request_id: requestId,
			compute_identity_id: computeIdentityId,
			requested_by_user_id: memberId,
			expires_at: expiresAt,
			refresh_capability: capability,
		},
	};
	return { keyring, authority, request, requestId, capabilitySha256, state, claudeLoginId };
}

describe("the vault's Claude read and reset", () => {
	it("opens the member's sign-in for the read, gives the reader only its credentials, and records what came back", async () => {
		const w = vaultWorld();
		const reads = {
			readClaudeLogin: vi.fn(async () => ({ usage: USAGE, resets: RESETS })),
			useClaudeReset: vi.fn(),
		};
		const usage = new CloudModelLoginUsage({ authority: w.authority, keyring: w.keyring, claude: reads });
		expect((await usage.refresh(w.request, AbortSignal.timeout(5_000))).status).toBe("completed");
		expect(reads.readClaudeLogin).toHaveBeenCalledWith(
			{ credentials: b64(CREDENTIALS), usage: true, resets: true },
			expect.any(AbortSignal),
		);
		expect(w.authority.recordClaudeLoginRead).toHaveBeenCalledWith(
			{ requestId: w.requestId, capabilitySha256: w.capabilitySha256, usage: USAGE, resets: RESETS, reset: null },
			expect.any(AbortSignal),
		);
		expect(w.authority.completeModelLoginAccountRefresh).toHaveBeenCalledTimes(1);
		expect(reads.useClaudeReset).not.toHaveBeenCalled();
	});

	it("has the vault renew the login before the read, and reads the renewed sign-in when it was renewed", async () => {
		const w = vaultWorld();
		const renewedCredentials = '{"claudeAiOauth":{"accessToken":"renewed-fixture"}}';
		const renewedEnvelope = w.keyring.sealMember(
			{
				[CLAUDE_LOGIN_FIELD]: JSON.stringify({
					schema: CLAUDE_LOGIN_FILES_SCHEMA,
					files: { ".credentials.json": b64(renewedCredentials), ".claude.json": b64(SETTINGS) },
				}),
			},
			{ memberId: w.request.body.requested_by_user_id, loginId: w.claudeLoginId, version: 3, keyId: "vault-root-1" },
		);
		const first = (await w.authority.describeClaudeLoginRead()) as Record<string, unknown>;
		const renewClaude = vi.fn(async () => {
			w.authority.describeClaudeLoginRead.mockResolvedValue({
				...first,
				version: 3,
				envelopeSha256: createHash("sha256").update(renewedEnvelope).digest("hex"),
				encryptedEnvelopeBase64: Buffer.from(renewedEnvelope).toString("base64"),
			} as Awaited<ReturnType<typeof w.authority.describeClaudeLoginRead>>);
			return "reopen" as const;
		});
		w.authority.describeClaudeLoginRead.mockClear();
		const reads = {
			readClaudeLogin: vi.fn(async () => ({ usage: USAGE, resets: RESETS })),
			useClaudeReset: vi.fn(),
		};
		const usage = new CloudModelLoginUsage({ authority: w.authority, keyring: w.keyring, claude: reads, renewClaude });
		expect((await usage.refresh(w.request, AbortSignal.timeout(5_000))).status).toBe("completed");
		expect(renewClaude).toHaveBeenCalledExactlyOnceWith(w.claudeLoginId);
		expect(w.authority.describeClaudeLoginRead).toHaveBeenCalledTimes(2);
		expect(reads.readClaudeLogin).toHaveBeenCalledExactlyOnceWith(
			{ credentials: b64(renewedCredentials), usage: true, resets: true },
			expect.any(AbortSignal),
		);
		expect(w.authority.recordClaudeLoginRead).toHaveBeenCalledTimes(1);

		const kept = vaultWorld();
		const keep = vi.fn(async () => "keep" as const);
		const keptReads = { readClaudeLogin: vi.fn(async () => ({ usage: USAGE, resets: RESETS })), useClaudeReset: vi.fn() };
		await new CloudModelLoginUsage({
			authority: kept.authority,
			keyring: kept.keyring,
			claude: keptReads,
			renewClaude: keep,
		}).refresh(kept.request, AbortSignal.timeout(5_000));
		expect(keep).toHaveBeenCalledTimes(1);
		expect(kept.authority.describeClaudeLoginRead).toHaveBeenCalledTimes(1);
		expect(keptReads.readClaudeLogin).toHaveBeenCalledWith(
			{ credentials: b64(CREDENTIALS), usage: true, resets: true },
			expect.any(AbortSignal),
		);

		const failing = vaultWorld();
		const failingReads = {
			readClaudeLogin: vi.fn(async () => ({ usage: USAGE, resets: RESETS })),
			useClaudeReset: vi.fn(),
		};
		expect(
			(
				await new CloudModelLoginUsage({
					authority: failing.authority,
					keyring: failing.keyring,
					claude: failingReads,
					renewClaude: vi.fn(async () => {
						throw new Error("the renewal could not be taken");
					}),
				}).refresh(failing.request, AbortSignal.timeout(5_000))
			).status,
		).toBe("completed");
		expect(failingReads.readClaudeLogin).toHaveBeenCalledTimes(1);
	});

	it("still completes the refresh when the read fails", async () => {
		const w = vaultWorld();
		const usage = new CloudModelLoginUsage({
			authority: w.authority,
			keyring: w.keyring,
			claude: {
				readClaudeLogin: vi.fn(async () => {
					throw new Error("helper unreachable");
				}),
				useClaudeReset: vi.fn(),
			},
		});
		expect((await usage.refresh(w.request, AbortSignal.timeout(5_000))).status).toBe("completed");
		expect(w.authority.recordClaudeLoginRead).not.toHaveBeenCalled();
		expect(w.authority.completeModelLoginAccountRefresh).toHaveBeenCalledTimes(1);
	});

	it("uses a reset once for the member's click, answers preparing meanwhile and completes with the outcome", async () => {
		const w = vaultWorld({ reset: "full" });
		let finish: (value: { outcome: "reset"; left: number }) => void = () => undefined;
		const reads = {
			readClaudeLogin: vi.fn(),
			useClaudeReset: vi.fn(
				() =>
					new Promise<{ outcome: "reset"; left: number }>((resolve) => {
						finish = resolve;
					}),
			),
		};
		const usage = new CloudModelLoginUsage({ authority: w.authority, keyring: w.keyring, claude: reads });
		expect((await usage.refresh(w.request, AbortSignal.timeout(5_000))).status).toBe("preparing");
		expect((await usage.refresh(w.request, AbortSignal.timeout(5_000))).status).toBe("preparing");
		await vi.waitFor(() => expect(reads.useClaudeReset).toHaveBeenCalledTimes(1));
		expect(reads.useClaudeReset).toHaveBeenCalledWith(
			{ credentials: b64(CREDENTIALS), kind: "full" },
			expect.any(AbortSignal),
		);
		expect(w.authority.claimClaudeLoginReset).toHaveBeenCalledTimes(1);
		finish({ outcome: "reset", left: 2 });
		await vi.waitFor(() => expect(w.authority.completeModelLoginAccountRefresh).toHaveBeenCalledTimes(1));
		expect(w.authority.recordClaudeLoginRead).toHaveBeenCalledWith(
			{
				requestId: w.requestId,
				capabilitySha256: w.capabilitySha256,
				usage: null,
				resets: null,
				reset: { outcome: "reset", left: 2 },
			},
			expect.any(AbortSignal),
		);
		expect((await usage.refresh(w.request, AbortSignal.timeout(5_000))).status).toBe("completed");
		expect(reads.useClaudeReset).toHaveBeenCalledTimes(1);
		expect(reads.readClaudeLogin).not.toHaveBeenCalled();
	});

	it("never presses a reset another host is using, and completes one whose outcome is recorded", async () => {
		const using = vaultWorld({ reset: "full", resetState: "using" });
		const reads = { readClaudeLogin: vi.fn(), useClaudeReset: vi.fn() };
		const usage = new CloudModelLoginUsage({ authority: using.authority, keyring: using.keyring, claude: reads });
		expect((await usage.refresh(using.request, AbortSignal.timeout(5_000))).status).toBe("preparing");
		expect(reads.useClaudeReset).not.toHaveBeenCalled();
		const done = vaultWorld({ reset: "full", resetState: "unconfirmed" });
		const after = new CloudModelLoginUsage({ authority: done.authority, keyring: done.keyring, claude: reads });
		expect((await after.refresh(done.request, AbortSignal.timeout(5_000))).status).toBe("completed");
		expect(done.authority.completeModelLoginAccountRefresh).toHaveBeenCalledTimes(1);
		expect(reads.useClaudeReset).not.toHaveBeenCalled();
	});

	it("records a reset as failed when the sign-in could not be opened, before anything was pressed", async () => {
		const w = vaultWorld({ reset: "full" });
		const other = new CloudSecretKeyring({}, { "vault-root-1": randomBytes(32) });
		cleanups.push(async () => other.close());
		const reads = { readClaudeLogin: vi.fn(), useClaudeReset: vi.fn() };
		const usage = new CloudModelLoginUsage({ authority: w.authority, keyring: other, claude: reads });
		expect((await usage.refresh(w.request, AbortSignal.timeout(5_000))).status).toBe("preparing");
		await vi.waitFor(() => expect(w.authority.completeModelLoginAccountRefresh).toHaveBeenCalledTimes(1));
		expect(reads.useClaudeReset).not.toHaveBeenCalled();
		expect(w.state.resetState).toBe("failed");
	});

	it("never completes a request while its reset runs, even when a later look at it fails", async () => {
		const w = vaultWorld({ reset: "full" });
		let finish: (value: { outcome: "reset"; left: number }) => void = () => undefined;
		const reads = {
			readClaudeLogin: vi.fn(),
			useClaudeReset: vi.fn(
				() =>
					new Promise<{ outcome: "reset"; left: number }>((resolve) => {
						finish = resolve;
					}),
			),
		};
		const usage = new CloudModelLoginUsage({ authority: w.authority, keyring: w.keyring, claude: reads });
		expect((await usage.refresh(w.request, AbortSignal.timeout(5_000))).status).toBe("preparing");
		await vi.waitFor(() => expect(reads.useClaudeReset).toHaveBeenCalledTimes(1));
		w.authority.describeClaudeLoginRead.mockRejectedValueOnce(new Error("the database did not answer"));
		expect((await usage.refresh(w.request, AbortSignal.timeout(5_000))).status).toBe("preparing");
		w.authority.describeClaudeLoginRead.mockRejectedValueOnce(Object.assign(new Error("refused"), { code: "42501" }));
		expect((await usage.refresh(w.request, AbortSignal.timeout(5_000))).status).toBe("preparing");
		expect(w.authority.completeModelLoginAccountRefresh).not.toHaveBeenCalled();
		finish({ outcome: "reset", left: 1 });
		await vi.waitFor(() => expect(w.authority.completeModelLoginAccountRefresh).toHaveBeenCalledTimes(1));
		expect(w.state.resetState).toBe("reset");
	});

	it("fails a refresh whose Claude description could not be read for another reason than a refusal", async () => {
		const w = vaultWorld();
		w.authority.describeClaudeLoginRead.mockRejectedValueOnce(new Error("the database did not answer"));
		const usage = new CloudModelLoginUsage({
			authority: w.authority,
			keyring: w.keyring,
			claude: { readClaudeLogin: vi.fn(), useClaudeReset: vi.fn() },
		});
		await expect(usage.refresh(w.request, AbortSignal.timeout(5_000))).rejects.toThrow("the database did not answer");
		expect(w.authority.completeModelLoginAccountRefresh).not.toHaveBeenCalled();
	});

	it("takes back a claim whose answers were all lost on a later look, and runs the reset once", async () => {
		const w = vaultWorld({ reset: "full" });
		w.state.claimLost = true;
		w.state.claimThrows = 5;
		const reads = {
			readClaudeLogin: vi.fn(),
			useClaudeReset: vi.fn(async () => ({ outcome: "reset" as const, left: 1 })),
		};
		const usage = new CloudModelLoginUsage({ authority: w.authority, keyring: w.keyring, claude: reads });
		expect((await usage.refresh(w.request, AbortSignal.timeout(10_000))).status).toBe("preparing");
		expect(reads.useClaudeReset).not.toHaveBeenCalled();
		expect(w.state.resetState).toBe("using");
		expect((await usage.refresh(w.request, AbortSignal.timeout(10_000))).status).toBe("preparing");
		await vi.waitFor(() => expect(w.authority.completeModelLoginAccountRefresh).toHaveBeenCalledTimes(1));
		expect((await usage.refresh(w.request, AbortSignal.timeout(10_000))).status).toBe("completed");
		expect(reads.useClaudeReset).toHaveBeenCalledTimes(1);
		const other = vaultWorld({ reset: "full", resetState: "using" });
		const another = new CloudModelLoginUsage({ authority: other.authority, keyring: other.keyring, claude: reads });
		other.state.claim = "someone-else";
		expect((await another.refresh(other.request, AbortSignal.timeout(10_000))).status).toBe("preparing");
		expect(reads.useClaudeReset).toHaveBeenCalledTimes(1);
	});

	it("goes on with the refresh when the database no longer lets the vault read the Claude login", async () => {
		const w = vaultWorld();
		w.authority.describeClaudeLoginRead.mockRejectedValueOnce(Object.assign(new Error("refused"), { code: "42501" }));
		const reads = { readClaudeLogin: vi.fn(), useClaudeReset: vi.fn() };
		const usage = new CloudModelLoginUsage({ authority: w.authority, keyring: w.keyring, claude: reads });
		expect((await usage.refresh(w.request, AbortSignal.timeout(5_000))).status).toBe("completed");
		expect(reads.readClaudeLogin).not.toHaveBeenCalled();
		expect(w.authority.completeModelLoginAccountRefresh).toHaveBeenCalledTimes(1);
	});

	it("claims again with the same token after a lost answer, and records an outcome again until the database takes it", async () => {
		const w = vaultWorld({ reset: "full" });
		w.state.claimLost = true;
		w.state.recordFails = 1;
		const reads = {
			readClaudeLogin: vi.fn(),
			useClaudeReset: vi.fn(async () => ({ outcome: "reset" as const, left: 1 })),
		};
		const usage = new CloudModelLoginUsage({ authority: w.authority, keyring: w.keyring, claude: reads });
		expect((await usage.refresh(w.request, AbortSignal.timeout(5_000))).status).toBe("preparing");
		expect(w.authority.claimClaudeLoginReset).toHaveBeenCalledTimes(2);
		const [first, second] = w.authority.claimClaudeLoginReset.mock.calls.map(([request]) => request.claim);
		expect(first).toBe(second);
		expect(isUuid(first)).toBe(true);
		await vi.waitFor(() => expect(w.authority.completeModelLoginAccountRefresh).toHaveBeenCalledTimes(1), {
			timeout: 8_000,
		});
		expect(reads.useClaudeReset).toHaveBeenCalledTimes(1);
		expect(w.authority.recordClaudeLoginRead).toHaveBeenCalledTimes(2);
		expect(w.state.resetState).toBe("reset");
	});
});
