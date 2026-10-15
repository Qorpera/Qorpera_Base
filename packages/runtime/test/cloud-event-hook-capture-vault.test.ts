import { createHash, randomBytes, randomUUID } from "node:crypto";
import { type EventHookCaptureIdentity, sealEventHookCapture } from "@qorpera/runtime/cloud-event-hook-capture-box";
import {
	type EventHookAuthority,
	type EventHookCaptureRequest,
	type EventHookCaptureVersion,
	type EventHookCreate,
	type EventHookRequest,
	type EventHookStripeOpening,
	EventHookVault,
	parseEventHookAnswer,
	parseEventHookCaptureAnswer,
	parseEventHookCaptureRequest,
	parseEventHookRequest,
} from "@qorpera/runtime/cloud-event-hook-vault";
import {
	CloudSecretBroker,
	type CloudSecretBrokerAuthority,
	PostgresCloudSecretBrokerAuthority,
} from "@qorpera/runtime/cloud-secret-broker";
import {
	HttpCloudSecretBrokerClient,
	HttpCloudSecretBrokerService,
	type NativeBindingProof,
} from "@qorpera/runtime/cloud-secret-broker-http";
import { CloudSecretKeyring } from "@qorpera/runtime/cloud-secret-crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { nativeToolAuthorityFixture } from "./fixtures/native-tool-authority-fixture.ts";

// E3c-2: a Stripe hook's signing secret is made by Stripe, read off dashboard.stripe.com by the Company Computer and
// sealed there to the hook's capture key; the vault opens it, seals it as every hook secret is sealed and stores it.

const keyrings: CloudSecretKeyring[] = [];
const services: HttpCloudSecretBrokerService[] = [];
afterEach(async () => {
	for (const service of services.splice(0)) await service.close();
	for (const keyring of keyrings.splice(0)) keyring.close();
});

const companyId = "98800000-0000-4000-8000-000000000010";
const environmentId = "98800000-0000-4000-8000-000000000020";
const secretId = "98800000-0000-4000-8000-000000000050";
const hookId = "98800000-0000-4000-8000-000000000060";
const companyComputerId = "98800000-0000-4000-8000-000000000090";
const captureReceiptId = "98800000-0000-4000-8000-0000000000a0";
const keyId = "company-kek-1";
const hookKey = { companyId, environmentId, secretId, keyId };
const now = 1_790_000_000_000;
const stripeSecret = "whsec_Ab12Cd34Ef56Gh78Ij90Kl12Mn34Op56";
/** Who may open a capture's box: the vault, for this call of this computer's boot, of this hook's secret. */
const captureIdentity = {
	companyId,
	companyComputerId,
	computerGeneration: 3,
	receiptId: captureReceiptId,
	hookId,
	field: "signing_secret",
} as const;

function stripeCreate(): EventHookRequest {
	return {
		binding: nativeToolAuthorityFixture().binding,
		request: {
			action: "create",
			kind: "hook",
			name: "stripe-payments",
			purpose: "Stripe's payment events",
			proof: "stripe",
			site: "dashboard.stripe.com",
			operationKey: "hook-1",
		},
	};
}

/** The database's answer to a Stripe create, as qorpera_folder_open_stripe_hook gives it. */
function stripeReceipt() {
	return {
		schema: "qorpera.agent-hook-receipt/v1",
		runId: "98800000-0000-4000-8000-000000000080",
		receiptId: "98800000-0000-4000-8000-000000000070",
		action: "create",
		hook: {
			schema: "qorpera.event-hook/v1",
			id: hookId,
			name: "stripe-payments",
			proof: "stripe",
			status: "pending",
		},
		secretSite: "dashboard.stripe.com",
	};
}

/** One vault_capture, as the native host relays it with the office's box. */
function captureRequest(box: Record<string, string>): EventHookCaptureRequest {
	return {
		binding: nativeToolAuthorityFixture().binding,
		receiptId: captureReceiptId,
		idempotencyKey: "c".repeat(64),
		envelope: JSON.stringify({
			operation: { arguments: { action: "vault_capture", hook: hookId, field: "signing_secret" } },
		}),
		box,
	};
}

/** A database refusal as node-postgres raises it. */
function databaseError(code: string, message: string): Error {
	return Object.assign(new Error(message), { code });
}

/** PostgreSQL's encode(…, 'base64'): a line break every 76 characters. */
function postgresBase64(bytes: Uint8Array): string {
	return (
		Buffer.from(bytes)
			.toString("base64")
			.match(/.{1,76}/g) ?? []
	).join("\n");
}

function stripeFixture(authority: Partial<EventHookAuthority> = {}, at = now + 1000) {
	const keyring = new CloudSecretKeyring({ [keyId]: randomBytes(32) });
	keyrings.push(keyring);
	const capturePublicKey = keyring.capturePublicKey(hookKey);
	/** The database's answer to a capture's read, as qorpera_folder_read_hook_capture gives it. */
	const captureContext = (overrides: Record<string, unknown> = {}) => ({
		schema: "qorpera.event-hook-capture-context/v1",
		hookId,
		secretId,
		version: 1,
		companyId,
		environmentId,
		keyId,
		capturePublicKey,
		receiptId: captureReceiptId,
		field: "signing_secret",
		companyComputerId,
		computerGeneration: 3,
		...overrides,
	});
	/** The version the vault holds, as the read carries it. */
	const held = (value: string, version = 1) => {
		const envelope = keyring.seal({ signing_secret: value }, { ...hookKey, version });
		return {
			version,
			keyId,
			encryptedEnvelopeBase64: postgresBase64(envelope),
			envelopeSha256: createHash("sha256").update(envelope).digest("hex"),
		};
	};
	const box = (
		value = stripeSecret,
		site = "dashboard.stripe.com",
		identity: EventHookCaptureIdentity = captureIdentity,
	) => sealEventHookCapture({ value, site }, capturePublicKey, identity, now);
	const openings: EventHookStripeOpening[] = [];
	const stored: EventHookCaptureVersion[] = [];
	/** The buffers the vault handed over, by reference: zeroed once the call is over. */
	const sent: Uint8Array[] = [];
	const read = vi.fn<NonNullable<EventHookAuthority["readHookCapture"]>>(async () => captureContext());
	const fake: EventHookAuthority = {
		describeSignedHook: vi.fn(async () => ({
			schema: "qorpera.folder-signed-hook-context/v1",
			companyId,
			environmentId,
			keyId,
		})),
		openSignedHook: vi.fn(async () => {
			throw new Error("a Stripe hook seals no secret");
		}),
		readEventHookFill: vi.fn(),
		openStripeHook: vi.fn(async (_binding, _request: EventHookCreate, opening: EventHookStripeOpening) => {
			openings.push(opening);
			return stripeReceipt();
		}),
		describeHookCaptureKey: vi.fn(async () => ({
			schema: "qorpera.event-hook-capture-key/v1",
			hookId,
			...hookKey,
			current: true,
		})),
		replaceHookCaptureKey: vi.fn(async () => ({
			schema: "qorpera.event-hook-capture-key/v1",
			hookId,
			...hookKey,
			current: true,
			replaced: true,
		})),
		readHookCapture: read,
		storeHookCapture: vi.fn(async (_request, version: EventHookCaptureVersion) => {
			sent.push(version.encryptedEnvelope);
			stored.push({ ...version, encryptedEnvelope: Uint8Array.from(version.encryptedEnvelope) });
			return {
				schema: "qorpera.event-hook-capture-stored/v1",
				hookId,
				secretId,
				version: version.version,
				replayed: false,
			};
		}),
		...authority,
	};
	const random = vi.fn((bytes: number) => randomBytes(bytes));
	const vault = new EventHookVault({ authority: fake, keys: keyring, newId: () => secretId, random, now: () => at });
	return {
		keyring,
		capturePublicKey,
		captureContext,
		held,
		box,
		openings,
		stored,
		sent,
		random,
		read,
		authority: fake,
		vault,
	};
}

/** The stored version's fields, opened as a hook's verification opens them. */
function opened(keyring: CloudSecretKeyring, version: EventHookCaptureVersion) {
	return keyring.use(version.encryptedEnvelope, { ...hookKey, version: version.version }, async (fields) => ({
		...fields,
	}));
}

describe("Stripe hooks in the vault", () => {
	it("opens a Stripe hook with no secret, only the id it will have and its capture key's public half", async () => {
		const f = stripeFixture();
		const create = stripeCreate();
		expect(await f.vault.handle(create, AbortSignal.timeout(5000))).toEqual(stripeReceipt());
		expect(f.openings).toEqual([{ ...hookKey, capturePublicKey: f.capturePublicKey }]);
		expect(f.capturePublicKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(f.authority.openSignedHook).not.toHaveBeenCalled();
		expect(f.random).not.toHaveBeenCalled();
		expect(f.authority.openStripeHook).toHaveBeenCalledWith(
			create.binding,
			create.request,
			{ ...hookKey, capturePublicKey: f.capturePublicKey },
			expect.anything(),
		);
		// The database's refusal in its own words.
		const refused = stripeFixture({
			openStripeHook: vi.fn(async () => {
				throw databaseError("22023", "A Stripe hook's secret is taken from dashboard.stripe.com");
			}),
		});
		expect(await refused.vault.handle(stripeCreate(), AbortSignal.timeout(5000))).toEqual({
			schema: "qorpera.event-hook-refusal/v1",
			code: "22023",
			message: "A Stripe hook's secret is taken from dashboard.stripe.com",
		});
		// A key it does not hold, or a broker without the Stripe calls: nothing is opened.
		const other = stripeFixture({
			describeSignedHook: vi.fn(async () => ({
				schema: "qorpera.folder-signed-hook-context/v1",
				companyId,
				environmentId,
				keyId: "company-kek-2",
			})),
		});
		await expect(other.vault.handle(stripeCreate(), AbortSignal.timeout(5000))).rejects.toThrow(
			"Event hook outcome unconfirmed",
		);
		expect(other.authority.openStripeHook).not.toHaveBeenCalled();
		const bare = stripeFixture({ openStripeHook: undefined });
		await expect(bare.vault.handle(stripeCreate(), AbortSignal.timeout(5000))).rejects.toThrow(
			"Event hook outcome unconfirmed",
		);
	});

	it("makes a hook's capture key again only when the one stored is not this broker's current key", async () => {
		const binding = nativeToolAuthorityFixture().binding;
		const rekey: EventHookRequest = { binding, request: { action: "rekey", hook: hookId } };
		const current = stripeFixture();
		expect(await current.vault.handle(rekey, AbortSignal.timeout(5000))).toEqual({
			schema: "qorpera.event-hook-rekey-answer/v1",
			hook: hookId,
			replaced: false,
		});
		expect(current.authority.replaceHookCaptureKey).not.toHaveBeenCalled();

		const stale = { schema: "qorpera.event-hook-capture-key/v1", hookId, ...hookKey, current: false };
		const f = stripeFixture({ describeHookCaptureKey: vi.fn(async () => stale) });
		expect(await f.vault.handle(rekey, AbortSignal.timeout(5000))).toEqual({
			schema: "qorpera.event-hook-rekey-answer/v1",
			hook: hookId,
			replaced: true,
		});
		expect(f.authority.replaceHookCaptureKey).toHaveBeenCalledWith(
			binding,
			hookId,
			keyId,
			f.capturePublicKey,
			expect.anything(),
		);

		// The database's refusal in its own words; a key it does not hold or an answer for another hook is unconfirmed.
		const taken = stripeFixture({
			describeHookCaptureKey: vi.fn(async () => stale),
			replaceHookCaptureKey: vi.fn(async () => {
				throw databaseError("55000", "This hook's secret was already taken under the current key");
			}),
		});
		expect(await taken.vault.handle(rekey, AbortSignal.timeout(5000))).toEqual({
			schema: "qorpera.event-hook-refusal/v1",
			code: "55000",
			message: "This hook's secret was already taken under the current key",
		});
		for (const answer of [
			{ ...stale, keyId: "company-kek-2" },
			{ ...stale, hookId: randomUUID() },
			{ ...stale, extra: true },
		]) {
			const bad = stripeFixture({ describeHookCaptureKey: vi.fn(async () => answer) });
			await expect(bad.vault.handle(rekey, AbortSignal.timeout(5000))).rejects.toThrow(
				"Event hook outcome unconfirmed",
			);
			expect(bad.authority.replaceHookCaptureKey).not.toHaveBeenCalled();
		}
		const unsaid = stripeFixture({
			describeHookCaptureKey: vi.fn(async () => stale),
			replaceHookCaptureKey: vi.fn(async () => stale),
		});
		await expect(unsaid.vault.handle(rekey, AbortSignal.timeout(5000))).rejects.toThrow(
			"Event hook outcome unconfirmed",
		);
	});

	it("stores a captured secret as the next version, sealed as every hook secret is, and wipes what it sent", async () => {
		const f = stripeFixture();
		const request = captureRequest(f.box());
		expect(await f.vault.capture(request, AbortSignal.timeout(5000))).toEqual({
			schema: "qorpera.event-hook-capture-answer/v1",
			hook: hookId,
			version: 1,
			unchanged: false,
		});
		expect(f.authority.readHookCapture).toHaveBeenCalledWith(request, expect.anything());
		expect(f.stored).toHaveLength(1);
		const version = f.stored[0] as EventHookCaptureVersion;
		expect(version).toMatchObject({ ...hookKey, version: 1 });
		expect(version.envelopeSha256).toBe(createHash("sha256").update(version.encryptedEnvelope).digest("hex"));
		await expect(opened(f.keyring, version)).resolves.toEqual({ signing_secret: stripeSecret });
		expect(Buffer.from(version.encryptedEnvelope).toString("utf8")).not.toContain("whsec_");
		expect(f.sent[0]?.every((byte) => byte === 0)).toBe(true);
	});

	it("answers the version it holds when the page shows the same secret, and stores a changed one as the next", async () => {
		const same = stripeFixture();
		same.read.mockResolvedValue(same.captureContext({ version: 2, current: same.held(stripeSecret) }));
		expect(await same.vault.capture(captureRequest(same.box()), AbortSignal.timeout(5000))).toEqual({
			schema: "qorpera.event-hook-capture-answer/v1",
			hook: hookId,
			version: 1,
			unchanged: true,
		});
		expect(same.authority.storeHookCapture).not.toHaveBeenCalled();

		const changed = stripeFixture();
		changed.read.mockResolvedValue(
			changed.captureContext({ version: 2, current: changed.held(`${stripeSecret}Qr`) }),
		);
		expect(await changed.vault.capture(captureRequest(changed.box()), AbortSignal.timeout(5000))).toEqual({
			schema: "qorpera.event-hook-capture-answer/v1",
			hook: hookId,
			version: 2,
			unchanged: false,
		});
		expect(changed.stored.map((version) => version.version)).toEqual([2]);
		await expect(opened(changed.keyring, changed.stored[0] as EventHookCaptureVersion)).resolves.toEqual({
			signing_secret: stripeSecret,
		});

		// A held version whose envelope is not the one its digest names is never compared.
		const forged = stripeFixture();
		forged.read.mockResolvedValue(
			forged.captureContext({
				version: 2,
				current: { ...forged.held(stripeSecret), envelopeSha256: "d".repeat(64) },
			}),
		);
		await expect(forged.vault.capture(captureRequest(forged.box()), AbortSignal.timeout(5000))).rejects.toThrow(
			"Event hook capture unconfirmed",
		);
		expect(forged.authority.storeHookCapture).not.toHaveBeenCalled();
	});

	it("answers a call asked again with what it stored, without opening its box again", async () => {
		const f = stripeFixture();
		f.read.mockResolvedValue(f.captureContext({ version: 2, captured: { version: 1 } }));
		// Sealed for another call: it would not open.
		const box = f.box(stripeSecret, "dashboard.stripe.com", { ...captureIdentity, receiptId: randomUUID() });
		expect(await f.vault.capture(captureRequest(box), AbortSignal.timeout(5000))).toEqual({
			schema: "qorpera.event-hook-capture-answer/v1",
			hook: hookId,
			version: 1,
			unchanged: false,
		});
		expect(f.authority.storeHookCapture).not.toHaveBeenCalled();
		// The database answers a store it already made with the same version.
		const replayed = stripeFixture({
			storeHookCapture: vi.fn(async () => ({
				schema: "qorpera.event-hook-capture-stored/v1",
				hookId,
				secretId,
				version: 1,
				replayed: true,
			})),
		});
		expect(await replayed.vault.capture(captureRequest(replayed.box()), AbortSignal.timeout(5000))).toMatchObject({
			version: 1,
			unchanged: false,
		});
	});

	it("passes the database's refusals on in their own words, and a store it cannot confirm as unconfirmed", async () => {
		for (const [code, message] of [
			["55000", "The hook's capture key must be made again"],
			["42501", "company computer lease is unavailable"],
			["55000", "This hook's secret is gone from the vault"],
		] as const) {
			const f = stripeFixture({
				readHookCapture: vi.fn(async () => {
					throw databaseError(code, message);
				}),
			});
			expect(await f.vault.capture(captureRequest(f.box()), AbortSignal.timeout(5000))).toEqual({
				schema: "qorpera.event-hook-refusal/v1",
				code,
				message,
			});
		}
		// 40003: the store's outcome is unknown, so the native host asks the same call again.
		for (const error of [
			databaseError("40003", "hook secret capture outcome is unconfirmed"),
			new Error("connection terminated"),
		]) {
			const sent: Uint8Array[] = [];
			const f = stripeFixture({
				storeHookCapture: vi.fn(async (_request, version: EventHookCaptureVersion) => {
					sent.push(version.encryptedEnvelope);
					throw error;
				}),
			});
			await expect(f.vault.capture(captureRequest(f.box()), AbortSignal.timeout(5000))).rejects.toThrow(
				"Event hook capture unconfirmed",
			);
			expect(sent).toHaveLength(1);
			expect(sent[0]?.every((byte) => byte === 0)).toBe(true);
		}
	});

	it("refuses a secret read off another site or too long ago, and stores nothing from a box not for this call", async () => {
		const elsewhere = stripeFixture();
		expect(
			await elsewhere.vault.capture(
				captureRequest(elsewhere.box(stripeSecret, "evil.example.com")),
				AbortSignal.timeout(5000),
			),
		).toEqual({
			schema: "qorpera.event-hook-refusal/v1",
			code: "22023",
			message: "A Stripe hook's secret is taken from dashboard.stripe.com",
		});
		const late = stripeFixture({}, now + 90_001);
		expect(await late.vault.capture(captureRequest(late.box()), AbortSignal.timeout(5000))).toEqual({
			schema: "qorpera.event-hook-refusal/v1",
			code: "55000",
			message: "The signing secret was read too long ago; read it off the page again",
		});
		for (const f of [elsewhere, late]) expect(f.authority.storeHookCapture).not.toHaveBeenCalled();

		const f = stripeFixture();
		const boxes = [
			f.box(stripeSecret, "dashboard.stripe.com", { ...captureIdentity, computerGeneration: 4 }),
			f.box(stripeSecret, "dashboard.stripe.com", { ...captureIdentity, hookId: randomUUID() }),
			sealEventHookCapture(
				{ value: stripeSecret, site: "dashboard.stripe.com" },
				stripeFixture().capturePublicKey,
				captureIdentity,
				now,
			),
		];
		for (const box of boxes)
			await expect(f.vault.capture(captureRequest(box), AbortSignal.timeout(5000))).rejects.toThrow(
				"Event hook capture unconfirmed",
			);
		// A context for another call, or a store's answer for another secret.
		const other = stripeFixture();
		other.read.mockResolvedValue(other.captureContext({ receiptId: randomUUID() }));
		await expect(other.vault.capture(captureRequest(other.box()), AbortSignal.timeout(5000))).rejects.toThrow(
			"Event hook capture unconfirmed",
		);
		const elsewhereStored = stripeFixture({
			storeHookCapture: vi.fn(async () => ({
				schema: "qorpera.event-hook-capture-stored/v1",
				hookId,
				secretId: randomUUID(),
				version: 1,
				replayed: false,
			})),
		});
		await expect(
			elsewhereStored.vault.capture(captureRequest(elsewhereStored.box()), AbortSignal.timeout(5000)),
		).rejects.toThrow("Event hook capture unconfirmed");
		expect(f.authority.storeHookCapture).not.toHaveBeenCalled();
	});
});

describe("Stripe hook requests", () => {
	const binding = nativeToolAuthorityFixture().binding;
	const wire = (request: unknown) => ({ schema: "qorpera.event-hook-request/v1", binding, request });

	it("reads a Stripe create and a rekey, and refuses a rekey carrying anything else", () => {
		expect(parseEventHookRequest(wire(stripeCreate().request))).toEqual({ binding, request: stripeCreate().request });
		expect(parseEventHookRequest(wire({ action: "rekey", hook: hookId.toUpperCase() }))).toEqual({
			binding,
			request: { action: "rekey", hook: hookId },
		});
		for (const request of [
			{ action: "rekey" },
			{ action: "rekey", hook: "hook-1" },
			{ action: "rekey", hook: hookId, proof: "stripe" },
		])
			expect(() => parseEventHookRequest(wire(request)), JSON.stringify(request)).toThrow();
		expect(
			parseEventHookAnswer({ schema: "qorpera.event-hook-rekey-answer/v1", hook: hookId, replaced: true }),
		).toEqual({ schema: "qorpera.event-hook-rekey-answer/v1", hook: hookId, replaced: true });
		for (const answer of [
			{ schema: "qorpera.event-hook-rekey-answer/v1", hook: hookId },
			{ schema: "qorpera.event-hook-rekey-answer/v1", hook: hookId, replaced: "yes" },
			{ schema: "qorpera.event-hook-rekey-answer/v1", hook: hookId, replaced: true, key: "x" },
		])
			expect(() => parseEventHookAnswer(answer), JSON.stringify(answer)).toThrow();
	});

	it("reads a capture request and its answer, and refuses anything else", () => {
		const box = sealEventHookCapture(
			{ value: stripeSecret, site: "dashboard.stripe.com" },
			Buffer.alloc(32, 9).toString("base64url"),
			captureIdentity,
			now,
		);
		const request = captureRequest(box);
		const wired = { schema: "qorpera.event-hook-capture-request/v1", ...request };
		expect(parseEventHookCaptureRequest(wired)).toEqual(request);
		for (const bad of [
			{ ...wired, schema: "qorpera.event-hook-fill-request/v1" },
			{ ...wired, box: undefined },
			{ ...wired, box: { ...box, extra: "x" } },
			{ ...wired, box: { ...box, ciphertext: "a".repeat(8193) } },
			{ ...wired, box: { ...box, iv: 12 } },
			{ ...wired, idempotencyKey: "short" },
			{ ...wired, value: stripeSecret },
		])
			expect(() => parseEventHookCaptureRequest(bad)).toThrow();

		const answer = { schema: "qorpera.event-hook-capture-answer/v1", hook: hookId, version: 2, unchanged: false };
		expect(parseEventHookCaptureAnswer(answer)).toEqual(answer);
		const refusal = { schema: "qorpera.event-hook-refusal/v1", code: "55000", message: "This hook was removed" };
		expect(parseEventHookCaptureAnswer(refusal)).toEqual(refusal);
		for (const bad of [
			{ ...answer, version: 0 },
			{ ...answer, unchanged: "no" },
			{ ...answer, value: stripeSecret },
			{ ...refusal, code: "40003" },
			{ schema: "qorpera.agent-hook-receipt/v1" },
		])
			expect(() => parseEventHookCaptureAnswer(bad), JSON.stringify(bad)).toThrow();
	});
});

describe("Stripe hooks over the broker", () => {
	it("calls only its broker-role functions, with the run's binding and the call's own envelope", async () => {
		const queries: Array<{ text: string; values: readonly unknown[] }> = [];
		const sent: Buffer[] = [];
		const brokerAuthorityId = randomUUID();
		const brokerCapability = randomBytes(32).toString("base64url");
		const authority = new PostgresCloudSecretBrokerAuthority({
			database: {
				async query<Row extends Record<string, unknown>>(text: string, values: readonly unknown[]) {
					// A copy of each buffer as sent: the authority wipes its own afterwards.
					queries.push({
						text,
						values: values.map((value) => (Buffer.isBuffer(value) ? Buffer.from(value) : value)),
					});
					sent.push(...values.filter((value) => Buffer.isBuffer(value)));
					return { rowCount: 1, rows: [{ result: { accepted: true } } as unknown as Row] };
				},
			},
			brokerAuthorityId,
			brokerCapability,
		});
		const signal = AbortSignal.timeout(5000);
		const { binding, request } = stripeCreate();
		const capture = {
			...captureRequest({ schema: "x", ephemeralPublicKey: "x", iv: "x", tag: "x", ciphertext: "x" }),
			binding,
		};
		await authority.openStripeHook(
			binding,
			request as EventHookCreate,
			{ ...hookKey, capturePublicKey: "k" },
			signal,
		);
		await authority.describeHookCaptureKey(binding, hookId, signal);
		await authority.replaceHookCaptureKey(binding, hookId, keyId, "k", signal);
		await authority.readHookCapture(capture, signal);
		await authority.storeHookCapture(
			capture,
			{ ...hookKey, version: 2, encryptedEnvelope: Buffer.from("sealed"), envelopeSha256: "e".repeat(64) },
			signal,
		);
		expect(queries.map((query) => query.text)).toEqual([
			"select public.qorpera_folder_open_stripe_hook($1::uuid,$2::text,$3::jsonb,$4::jsonb,$5::uuid,$6::uuid,$7::uuid,$8::text,$9::text) as result",
			"select public.qorpera_folder_describe_hook_capture_key($1::uuid,$2::text,$3::jsonb,$4::uuid) as result",
			"select public.qorpera_folder_replace_hook_capture_key($1::uuid,$2::text,$3::jsonb,$4::uuid,$5::text,$6::text) as result",
			"select public.qorpera_folder_read_hook_capture($1::uuid,$2::text,$3::jsonb,$4::uuid,$5::text,$6::text) as result",
			"select public.qorpera_folder_store_hook_capture($1::uuid,$2::text,$3::jsonb,$4::uuid,$5::text,$6::text,$7::uuid,$8::bigint,$9::uuid,$10::uuid,$11::text,$12::bytea,$13::text) as result",
		]);
		const head = [
			brokerAuthorityId,
			createHash("sha256").update(brokerCapability).digest("hex"),
			JSON.stringify(binding),
		];
		for (const query of queries) expect(query.values.slice(0, 3)).toEqual(head);
		const call = [captureReceiptId, capture.envelope, createHash("sha256").update("c".repeat(64)).digest("hex")];
		expect(queries.map((query) => query.values.slice(3))).toEqual([
			[JSON.stringify(request), secretId, companyId, environmentId, keyId, "k"],
			[hookId],
			[hookId, keyId, "k"],
			call,
			[...call, secretId, 2, companyId, environmentId, keyId, Buffer.from("sealed"), "e".repeat(64)],
		]);
		// The box never reaches the database: only the vault opens it.
		expect(JSON.stringify(queries)).not.toContain("ephemeralPublicKey");
		expect(sent).toHaveLength(1);
		expect(sent[0]?.every((byte) => byte === 0)).toBe(true);
	});

	it("serves Stripe hooks through the broker, and a broker without the Stripe calls takes none", async () => {
		const f = stripeFixture();
		const base: CloudSecretBrokerAuthority = {
			describeCapture: vi.fn(),
			completeCapture: vi.fn(),
			authorizeOperation: vi.fn(),
			authorizeRepositoryCredential: vi.fn(),
			describeSignedHook: f.authority.describeSignedHook,
			openSignedHook: f.authority.openSignedHook,
			readEventHookFill: f.authority.readEventHookFill,
		};
		const broker = new CloudSecretBroker({
			authority: {
				...base,
				openStripeHook: f.authority.openStripeHook,
				describeHookCaptureKey: f.authority.describeHookCaptureKey,
				replaceHookCaptureKey: f.authority.replaceHookCaptureKey,
				readHookCapture: f.authority.readHookCapture,
				storeHookCapture: f.authority.storeHookCapture,
			},
			keyring: f.keyring,
			adapters: [],
		});
		expect(await broker.eventHook(stripeCreate(), AbortSignal.timeout(5000))).toEqual(stripeReceipt());
		// The broker's vault keeps the real clock, so the box is read now.
		const box = sealEventHookCapture(
			{ value: stripeSecret, site: "dashboard.stripe.com" },
			f.capturePublicKey,
			captureIdentity,
			Date.now(),
		);
		expect(await broker.eventHookCapture(captureRequest(box), AbortSignal.timeout(5000))).toEqual({
			schema: "qorpera.event-hook-capture-answer/v1",
			hook: hookId,
			version: 1,
			unchanged: false,
		});
		const bare = new CloudSecretBroker({ authority: base, keyring: f.keyring, adapters: [] });
		await expect(bare.eventHook(stripeCreate(), AbortSignal.timeout(5000))).rejects.toThrow(
			"Event hook outcome unconfirmed",
		);
		await expect(bare.eventHookCapture(captureRequest(f.box()), AbortSignal.timeout(5000))).rejects.toThrow(
			"Event hook capture unconfirmed",
		);
		expect(f.stored).toHaveLength(1);
	});

	it("serves the runtime's captures with its token and the run's own lease only", async () => {
		const f = stripeFixture();
		const authority: CloudSecretBrokerAuthority = {
			describeCapture: vi.fn(),
			completeCapture: vi.fn(),
			authorizeOperation: vi.fn(),
			authorizeRepositoryCredential: vi.fn(),
			...f.authority,
		};
		const runtimeToken = randomBytes(32).toString("base64url");
		const codingExecutorToken = randomBytes(32).toString("base64url");
		// G2-6a: the database's lease proof stands in here (its own test is 986). The broker's vault keeps the real clock.
		const request = captureRequest(
			sealEventHookCapture(
				{ value: stripeSecret, site: "dashboard.stripe.com" },
				f.capturePublicKey,
				captureIdentity,
				Date.now(),
			),
		);
		const lease = randomBytes(32).toString("base64url");
		const own = `job.${request.binding.jobId.toLowerCase()}.${lease}`;
		const proveBinding = vi.fn<NativeBindingProof>(async (binding, presented) => {
			if (presented !== `job.${(binding as { jobId: string }).jobId.toLowerCase()}.${lease}`)
				throw new Error("native binding proof is refused");
		});
		const service = new HttpCloudSecretBrokerService(
			new CloudSecretBroker({ authority, keyring: f.keyring, adapters: [] }),
			runtimeToken,
			{ codingExecutorToken, proveBinding },
		);
		services.push(service);
		const port = await service.start();
		const client = (holder = own, token = runtimeToken) =>
			new HttpCloudSecretBrokerClient({
				origin: `http://127.0.0.1:${port}`,
				runtimeToken: token,
				companyId,
				holder: () => holder,
				allowLoopback: true,
			});
		expect(await client().eventHookCapture(request, AbortSignal.timeout(5000))).toEqual({
			schema: "qorpera.event-hook-capture-answer/v1",
			hook: hookId,
			version: 1,
			unchanged: false,
		});
		expect(f.read).toHaveBeenCalledWith(request, expect.anything());
		expect(proveBinding).toHaveBeenCalledWith(
			expect.objectContaining({ jobId: request.binding.jobId, runId: request.binding.runId }),
			own,
		);
		f.read.mockRejectedValueOnce(databaseError("55000", "This hook was removed"));
		expect(await client().eventHookCapture(request, AbortSignal.timeout(5000))).toEqual({
			schema: "qorpera.event-hook-refusal/v1",
			code: "55000",
			message: "This hook was removed",
		});
		// An outcome the vault cannot confirm is the broker's plain refusal; the native host's call fails, and asks again.
		f.read.mockRejectedValueOnce(new Error("connection reset"));
		await expect(client().eventHookCapture(request, AbortSignal.timeout(5000))).rejects.toThrow(
			"Cloud secret broker rejected the event hook capture",
		);
		const calls = f.read.mock.calls.length;
		for (const token of [randomBytes(32).toString("base64url"), codingExecutorToken])
			await expect(client(own, token).eventHookCapture(request, AbortSignal.timeout(5000))).rejects.toThrow(
				"Cloud secret broker rejected the event hook capture",
			);
		// Without the run's own lease (a malformed holder, another run's, or another lease token for this run's job), the
		// capture is refused before the database is asked anything.
		for (const holder of [
			"",
			lease,
			`identity.${lease}`,
			`${own}x`,
			`job.${randomUUID()}.${lease}`,
			`job.${request.binding.jobId.toLowerCase()}.${"W".repeat(43)}`,
		])
			await expect(client(holder).eventHookCapture(request, AbortSignal.timeout(5000))).rejects.toThrow(
				"Cloud secret broker rejected the event hook capture",
			);
		// The route reads only a capture: a fill request there is refused before the database too.
		const { box: _box, ...fill } = request;
		const raw = await fetch(`http://127.0.0.1:${port}/v1/event-hook-captures?company=${companyId}`, {
			method: "POST",
			headers: {
				authorization: `Bearer ${runtimeToken}`,
				"x-qorpera-identity": own,
				"content-type": "application/json",
			},
			body: JSON.stringify({ schema: "qorpera.event-hook-fill-request/v1", ...fill }),
		});
		expect(raw.status).toBe(403);
		expect(await raw.json()).toEqual({ schema: "qorpera.cloud-secret-error/v1", error: "unavailable" });
		expect(f.read).toHaveBeenCalledTimes(calls);
		expect(f.stored).toHaveLength(1);
	});
});
