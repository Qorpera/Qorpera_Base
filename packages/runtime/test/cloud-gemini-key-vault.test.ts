import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
	CloudGeminiKeyVault,
	GeminiKeyInvalidError,
	type GeminiKeyVaultAuthority,
	geminiKeyHint,
	geminiNeonSpendMicrodollars,
	isGeminiApiKeyFormat,
	verifyGeminiApiKey,
} from "@qorpera/runtime/cloud-gemini-key-vault";
import type { ModelLoginRunBinding } from "@qorpera/runtime/cloud-model-login-vault";
import { CloudSecretBroker } from "@qorpera/runtime/cloud-secret-broker";
import { HttpCloudSecretBrokerService, openGeminiKeyForRun } from "@qorpera/runtime/cloud-secret-broker-http";
import type { CloudSecretBrokerCompanies } from "@qorpera/runtime/cloud-secret-broker-shared";
import { CloudSecretKeyring } from "@qorpera/runtime/cloud-secret-crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

const CANARY_KEY = "AIzaSyCanaryGeminiKeyTest0123456789abcdef";
const CANARY_AQ_KEY = "AQ.Ab8RN6CanaryGeminiKeyTest0123456789abcdef_ghij-aXtw";

function binding(): ModelLoginRunBinding {
	return {
		leaseId: randomUUID(),
		runId: randomUUID(),
		jobId: randomUUID(),
		runnerId: randomUUID(),
		assignmentId: randomUUID(),
		credentialCapsuleId: randomUUID(),
		computeIdentityId: randomUUID(),
	};
}

function digestHex(bytes: Uint8Array | string): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function standIn(verifyKey?: (apiKey: string, signal: AbortSignal) => Promise<void>) {
	const keyring = new CloudSecretKeyring({}, { "vault-root-1": randomBytes(32) });
	const state = {
		profileId: randomUUID(),
		ownerUserId: randomUUID(),
		geminiKeyId: randomUUID(),
		keyId: "vault-root-1",
		ticketId: randomUUID(),
		capability: randomBytes(32).toString("hex"),
		defaultForChats: true,
		monthlyCapCents: 10_000 as number | null,
		spendMonth: "2026-11",
		monthSpendMicrodollars: 250_000,
		version: 1,
		envelope: null as Buffer | null,
		keyHint: null as string | null,
		refusal: null as "REVOKED" | "CAP_REACHED" | null,
	};
	const authority: GeminiKeyVaultAuthority = {
		describeGeminiKeyTicket: vi.fn(async (request) => {
			if (request.ticketId !== state.ticketId || request.capabilitySha256 !== digestHex(state.capability)) {
				throw Object.assign(new Error("Gemini key ticket is unavailable"), { code: "42501" });
			}
			return {
				schema: "qorpera.gemini-key-ticket-description/v1",
				ticketId: state.ticketId,
				profileId: state.profileId,
				ownerUserId: state.ownerUserId,
				geminiKeyId: state.geminiKeyId,
				keyId: state.keyId,
				defaultForChats: state.defaultForChats,
				monthlyCapCents: state.monthlyCapCents,
				expiresAt: new Date(Date.now() + 600_000).toISOString(),
			};
		}),
		completeGeminiKeySave: vi.fn(async (completion) => {
			expect(completion.envelopeSha256).toBe(digestHex(completion.encryptedEnvelope));
			state.envelope = Buffer.from(completion.encryptedEnvelope);
			state.keyHint = completion.keyHint;
			return {
				schema: "qorpera.gemini-key-saved/v1",
				id: state.geminiKeyId,
				keyHint: completion.keyHint,
				defaultForChats: state.defaultForChats,
				monthlyCapCents: state.monthlyCapCents,
				version: state.version,
			};
		}),
		openGeminiKeyForRun: vi.fn(async () => {
			if (state.refusal === "REVOKED") {
				return { schema: "qorpera.gemini-key-for-run/v1", state: "refused", reason: "REVOKED" };
			}
			if (state.refusal === "CAP_REACHED") {
				return {
					schema: "qorpera.gemini-key-for-run/v1",
					state: "refused",
					reason: "CAP_REACHED",
					spendMonth: state.spendMonth,
					monthSpendMicrodollars: state.monthSpendMicrodollars,
					monthlyCapCents: state.monthlyCapCents ?? 10_000,
				};
			}
			if (!state.envelope) throw new Error("No Gemini key sealed");
			return {
				schema: "qorpera.gemini-key-for-run/v1",
				state: "open",
				geminiKeyId: state.geminiKeyId,
				ownerUserId: state.ownerUserId,
				keyId: state.keyId,
				version: state.version,
				envelopeSha256: digestHex(state.envelope),
				encryptedEnvelopeBase64: state.envelope.toString("base64"),
				spendMonth: state.spendMonth,
				monthSpendMicrodollars: state.monthSpendMicrodollars,
				monthlyCapCents: state.monthlyCapCents,
			};
		}),
	};
	const verify = verifyKey ?? vi.fn(async () => undefined);
	return {
		keyring,
		state,
		authority,
		verify,
		vault: new CloudGeminiKeyVault({ authority, keyring, verifyKey: verify }),
	};
}

const output: string[] = [];
function captureOutput(): void {
	for (const method of ["log", "info", "warn", "error", "debug"] as const) {
		vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
			output.push(args.map(String).join(" "));
		});
	}
	vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
		output.push(String(chunk));
		return true;
	});
}

afterEach(() => {
	vi.restoreAllMocks();
	expect(output.join("\n")).not.toContain(CANARY_KEY);
	output.length = 0;
});

describe("Gemini Neon pricing and key formatting", () => {
	it("computes microdollars at Neon rates with conservative cached rounding", () => {
		expect(geminiNeonSpendMicrodollars({ inputTokens: 1_000_000, cachedTokens: 0, outputTokens: 0 })).toBe(3_000_000);
		expect(geminiNeonSpendMicrodollars({ inputTokens: 1_000_000, cachedTokens: 1_000_000, outputTokens: 0 })).toBe(
			150_000,
		);
		expect(geminiNeonSpendMicrodollars({ inputTokens: 0, cachedTokens: 0, outputTokens: 1_000_000 })).toBe(
			15_000_000,
		);
		expect(geminiNeonSpendMicrodollars({ inputTokens: 1, cachedTokens: 1, outputTokens: 0 })).toBe(1);
		expect(geminiNeonSpendMicrodollars({ inputTokens: 100, cachedTokens: 100, outputTokens: 0 })).toBe(15);
		expect(geminiNeonSpendMicrodollars({ inputTokens: 101, cachedTokens: 101, outputTokens: 0 })).toBe(16);
		expect(geminiNeonSpendMicrodollars({ inputTokens: 100_000, cachedTokens: 80_000, outputTokens: 2_000 })).toBe(
			20_000 * 3 + 12_000 + 2_000 * 15,
		);
	});

	it("validates Gemini API key format and masks hints", () => {
		expect(isGeminiApiKeyFormat(CANARY_KEY)).toBe(true);
		expect(isGeminiApiKeyFormat(CANARY_AQ_KEY)).toBe(true);
		expect(isGeminiApiKeyFormat("sk-openai-12345678901234567890")).toBe(false);
		expect(isGeminiApiKeyFormat("AIzaShort")).toBe(false);
		expect(isGeminiApiKeyFormat("AQ.Short")).toBe(false);
		expect(isGeminiApiKeyFormat("AQ.has space 01234567890123456789")).toBe(false);
		expect(geminiKeyHint(CANARY_KEY)).toBe("AIza...cdef");
		expect(geminiKeyHint(CANARY_AQ_KEY)).toBe("AQ...aXtw");
	});

	it("verifies a Gemini API key against Google using the header, never a query parameter", async () => {
		const seen: { url: string; header: string | null }[] = [];
		const okFetch = (async (input: string | URL | Request, init?: RequestInit) => {
			seen.push({ url: String(input), header: new Headers(init?.headers).get("x-goog-api-key") });
			return Response.json({ models: [] });
		}) as typeof fetch;
		await verifyGeminiApiKey(CANARY_KEY, AbortSignal.timeout(5_000), okFetch);
		expect(seen[0]?.url).not.toContain(CANARY_KEY);
		expect(seen[0]?.header).toBe(CANARY_KEY);

		const badFetch = (async () =>
			Response.json({ error: { message: "API key not valid" } }, { status: 400 })) as typeof fetch;
		await expect(verifyGeminiApiKey(CANARY_KEY, AbortSignal.timeout(5_000), badFetch)).rejects.toBeInstanceOf(
			GeminiKeyInvalidError,
		);
	});
});

describe("CloudGeminiKeyVault sealing and opening", () => {
	it("verifies, seals, opens, and still opens after settings version increments", async () => {
		captureOutput();
		const f = standIn();
		const saved = await f.vault.saveFromTicket(
			{ ticketId: f.state.ticketId, capability: f.state.capability, apiKey: CANARY_KEY },
			AbortSignal.timeout(5_000),
		);
		expect(saved).toEqual({
			schema: "qorpera.gemini-key-saved/v1",
			id: f.state.geminiKeyId,
			keyHint: "AIza...cdef",
			defaultForChats: true,
			monthlyCapCents: 10_000,
			version: 1,
		});
		expect(f.verify).toHaveBeenCalledWith(CANARY_KEY, expect.any(AbortSignal));

		f.state.version = 5;
		f.state.monthlyCapCents = 25_000;
		const opened = await f.vault.open(binding(), AbortSignal.timeout(5_000));
		expect(opened).toEqual({
			schema: "qorpera.gemini-key-for-run/v1",
			state: "open",
			geminiKeyId: f.state.geminiKeyId,
			apiKey: CANARY_KEY,
			spendMonth: "2026-11",
			monthSpendMicrodollars: 250_000,
			monthlyCapCents: 25_000,
		});
	});

	it("rejects invalid keys before sealing and passes through CAP_REACHED and REVOKED refusals", async () => {
		captureOutput();
		const f = standIn(async () => {
			throw new GeminiKeyInvalidError();
		});
		await expect(
			f.vault.saveFromTicket(
				{ ticketId: f.state.ticketId, capability: f.state.capability, apiKey: CANARY_KEY },
				AbortSignal.timeout(5_000),
			),
		).rejects.toBeInstanceOf(GeminiKeyInvalidError);
		expect(f.authority.completeGeminiKeySave).not.toHaveBeenCalled();

		f.state.refusal = "CAP_REACHED";
		f.state.monthSpendMicrodollars = 100_000_000;
		expect(await f.vault.open(binding(), AbortSignal.timeout(5_000))).toEqual({
			schema: "qorpera.gemini-key-for-run/v1",
			state: "refused",
			reason: "CAP_REACHED",
			spendMonth: "2026-11",
			monthSpendMicrodollars: 100_000_000,
			monthlyCapCents: 10_000,
		});

		f.state.refusal = "REVOKED";
		expect(await f.vault.open(binding(), AbortSignal.timeout(5_000))).toEqual({
			schema: "qorpera.gemini-key-for-run/v1",
			state: "refused",
			reason: "REVOKED",
		});
	});
});

describe("HttpCloudSecretBrokerService Gemini key routes", () => {
	it("saves from browser CORS route and opens for a proven run", async () => {
		captureOutput();
		const rejectOnce = { invalid: true };
		const f = standIn(async () => {
			if (rejectOnce.invalid) {
				rejectOnce.invalid = false;
				throw new GeminiKeyInvalidError();
			}
		});
		const refuse = vi.fn(async () => {
			throw new Error("not used");
		});
		const broker = new CloudSecretBroker({
			authority: {
				describeCapture: refuse,
				completeCapture: refuse,
				authorizeOperation: refuse,
				authorizeRepositoryCredential: refuse,
			},
			keyring: f.keyring,
			adapters: [],
		});
		const runtimeToken = randomBytes(32).toString("base64url");
		const run = binding();
		const holder = `job.${run.jobId}.${randomBytes(32).toString("base64url")}`;
		const proveBinding = vi.fn(async () => undefined);
		const companyId = f.state.profileId;
		const companies: CloudSecretBrokerCompanies = {
			resolve: async (id) =>
				id === companyId
					? {
							companyId,
							broker,
							modelLogins: {} as never,
							modelLoginSignIns: undefined,
							modelLoginUsage: {} as never,
							geminiKeys: f.vault,
						}
					: undefined,
			signingIn: () => undefined,
		};
		const service = new HttpCloudSecretBrokerService(companies, runtimeToken, {
			memberOrigins: ["https://app.qorpera.example"],
			proveBinding,
		});
		const port = await service.start();
		try {
			const invalidResponse = await fetch(
				`http://127.0.0.1:${port}/v1/gemini-keys/${f.state.ticketId}?company=${companyId}`,
				{
					method: "POST",
					headers: {
						origin: "https://app.qorpera.example",
						"content-type": "application/json",
					},
					body: JSON.stringify({
						schema: "qorpera.gemini-key-save-request/v1",
						capability: f.state.capability,
						apiKey: CANARY_KEY,
					}),
				},
			);
			expect(invalidResponse.status).toBe(403);
			expect(invalidResponse.headers.get("access-control-allow-origin")).toBe("https://app.qorpera.example");
			expect(await invalidResponse.json()).toEqual({
				schema: "qorpera.gemini-key-error/v1",
				reason: "invalid_key",
			});

			const saveResponse = await fetch(
				`http://127.0.0.1:${port}/v1/gemini-keys/${f.state.ticketId}?company=${companyId}`,
				{
					method: "POST",
					headers: {
						origin: "https://app.qorpera.example",
						"content-type": "application/json",
					},
					body: JSON.stringify({
						schema: "qorpera.gemini-key-save-request/v1",
						capability: f.state.capability,
						apiKey: CANARY_KEY,
					}),
				},
			);
			expect(saveResponse.status).toBe(200);
			expect(await saveResponse.json()).toMatchObject({
				schema: "qorpera.gemini-key-saved/v1",
				keyHint: "AIza...cdef",
			});

			const opened = await openGeminiKeyForRun(
				{
					origin: `http://127.0.0.1:${port}`,
					runtimeToken,
					companyId,
					holder: () => holder,
					allowLoopback: true,
				},
				run,
				AbortSignal.timeout(5_000),
			);
			expect(opened).toEqual({
				schema: "qorpera.gemini-key-for-run/v1",
				state: "open",
				geminiKeyId: f.state.geminiKeyId,
				apiKey: CANARY_KEY,
				spendMonth: "2026-11",
				monthSpendMicrodollars: 250_000,
				monthlyCapCents: 10_000,
			});
			expect(proveBinding).toHaveBeenCalledWith(run, holder);

			const aqSaveResponse = await fetch(
				`http://127.0.0.1:${port}/v1/gemini-keys/${f.state.ticketId}?company=${companyId}`,
				{
					method: "POST",
					headers: {
						origin: "https://app.qorpera.example",
						"content-type": "application/json",
					},
					body: JSON.stringify({
						schema: "qorpera.gemini-key-save-request/v1",
						capability: f.state.capability,
						apiKey: CANARY_AQ_KEY,
					}),
				},
			);
			expect(aqSaveResponse.status).toBe(200);
			expect(await aqSaveResponse.json()).toMatchObject({
				schema: "qorpera.gemini-key-saved/v1",
				keyHint: "AQ...aXtw",
			});
			const openedAq = await openGeminiKeyForRun(
				{
					origin: `http://127.0.0.1:${port}`,
					runtimeToken,
					companyId,
					holder: () => holder,
					allowLoopback: true,
				},
				run,
				AbortSignal.timeout(5_000),
			);
			expect(openedAq).toMatchObject({
				schema: "qorpera.gemini-key-for-run/v1",
				state: "open",
				apiKey: CANARY_AQ_KEY,
			});
		} finally {
			await service.close();
		}
	});
});
