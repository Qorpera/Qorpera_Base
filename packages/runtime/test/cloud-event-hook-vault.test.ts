import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import {
	type CompanyAccountFillIdentity,
	CompanyComputerFillKey,
} from "@qorpera/runtime/cloud-company-account-fill-box";
import {
	type EventHookAuthority,
	type EventHookCreate,
	type EventHookFillAnswer,
	type EventHookFillRequest,
	type EventHookOpening,
	type EventHookRequest,
	EventHookVault,
	parseEventHookAnswer,
	parseEventHookFillAnswer,
	parseEventHookFillRequest,
	parseEventHookRequest,
} from "@qorpera/runtime/cloud-event-hook-vault";
import { checkEventSignature } from "@qorpera/runtime/cloud-event-verification";
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

const keyrings: CloudSecretKeyring[] = [];
const services: HttpCloudSecretBrokerService[] = [];
afterEach(async () => {
	for (const service of services.splice(0)) await service.close();
	for (const keyring of keyrings.splice(0)) keyring.close();
});

const companyId = "98700000-0000-4000-8000-000000000010";
const environmentId = "98700000-0000-4000-8000-000000000020";
const secretId = "98700000-0000-4000-8000-000000000050";
const hookId = "98700000-0000-4000-8000-000000000060";
const receiptId = "98700000-0000-4000-8000-000000000070";
const sealedFor = { companyId, environmentId, secretId, version: 1, keyId: "company-kek-1" };
const companyComputerId = "98700000-0000-4000-8000-000000000090";
const fillReceiptId = "98700000-0000-4000-8000-0000000000a0";
/** The HMAC hook's secret the fixture's vault holds. */
const hookSecret = `whsec_${Buffer.alloc(32, 7).toString("base64")}`;
/** Who may open a fill's box: the run's computer, for the fill's call, of this hook's secret. */
const hookIdentity = {
	companyId,
	companyComputerId,
	computerGeneration: 3,
	receiptId: fillReceiptId,
	hookId,
	field: "signing_secret",
} as const;

/** One vault_fill of the hook's secret, as the native host began it. */
function fillRequest(): EventHookFillRequest {
	return {
		binding: nativeToolAuthorityFixture().binding,
		receiptId: fillReceiptId,
		idempotencyKey: "b".repeat(64),
		envelope: JSON.stringify({
			operation: {
				arguments: { action: "vault_fill", role: "textbox", name: "Secret", hook: hookId, field: "signing_secret" },
			},
		}),
	};
}

function hookRequest(overrides: Partial<EventHookCreate> = {}): EventHookRequest {
	return {
		binding: nativeToolAuthorityFixture().binding,
		request: {
			action: "create",
			kind: "hook",
			name: "repo-pushes",
			purpose: "Pushes to the website's repository",
			proof: "github",
			site: "github.com",
			operationKey: "hook-1",
			...overrides,
		},
	};
}

/** The database's answer to a signed create, as qorpera_folder_open_signed_hook gives it. */
function receipt(site = "github.com", proof = "github") {
	return {
		schema: "qorpera.agent-hook-receipt/v1",
		runId: "98700000-0000-4000-8000-000000000080",
		receiptId,
		action: "create",
		hook: {
			schema: "qorpera.event-hook/v1",
			id: hookId,
			name: "repo-pushes",
			proof,
			status: "active",
			signingSecret: { connectorId: "event_hook", secretName: `h${hookId.replaceAll("-", "")}`, ready: true },
		},
		secretSite: site,
	};
}

/** A database refusal as node-postgres raises it. */
function databaseError(code: string, message: string): Error {
	return Object.assign(new Error(message), { code });
}

function vaultFixture(authority: Partial<EventHookAuthority> = {}, random?: (bytes: number) => Uint8Array) {
	const keyring = new CloudSecretKeyring({ "company-kek-1": randomBytes(32) });
	keyrings.push(keyring);
	const computer = new CompanyComputerFillKey();
	const envelope = keyring.seal({ signing_secret: hookSecret }, sealedFor);
	/** The database's answer to a fill, as qorpera_fill_event_hook_secret gives it: PostgreSQL's base64 breaks lines
	 * every 76 characters. */
	const fillContext = (overrides: Record<string, unknown> = {}) => ({
		schema: "qorpera.event-hook-fill-context/v1",
		hookId,
		proof: "hmac-sha256",
		site: "app.example.com",
		secretId,
		version: 1,
		companyId,
		environmentId,
		keyId: "company-kek-1",
		encryptedEnvelopeBase64: (
			Buffer.from(envelope)
				.toString("base64")
				.match(/.{1,76}/g) ?? []
		).join("\n"),
		envelopeSha256: createHash("sha256").update(envelope).digest("hex"),
		receiptId: fillReceiptId,
		field: "signing_secret",
		companyComputerId,
		computerGeneration: 3,
		fillPublicKey: computer.publicKey,
		...overrides,
	});
	const openings: EventHookOpening[] = [];
	/** The buffers the vault handed over, by reference: zeroed once the call is over. */
	const sent: Uint8Array[] = [];
	const fake: EventHookAuthority = {
		describeSignedHook: vi.fn(async () => ({
			schema: "qorpera.folder-signed-hook-context/v1",
			companyId,
			environmentId,
			keyId: "company-kek-1",
		})),
		openSignedHook: vi.fn(async (_binding, request: EventHookCreate, opening: EventHookOpening) => {
			sent.push(opening.encryptedEnvelope);
			openings.push({ ...opening, encryptedEnvelope: Uint8Array.from(opening.encryptedEnvelope) });
			return receipt(request.site, request.proof);
		}),
		readEventHookFill: vi.fn(async () => fillContext()),
		...authority,
	};
	const vault = new EventHookVault({
		authority: fake,
		keys: keyring,
		newId: () => secretId,
		...(random ? { random } : {}),
	});
	return { keyring, computer, envelope, fillContext, openings, sent, authority: fake, vault };
}

/** The sealed fields, opened with the identity the database stores beside them. */
function opened(keyring: CloudSecretKeyring, opening: EventHookOpening, identity = sealedFor) {
	return keyring.use(opening.encryptedEnvelope, identity, async (fields) => ({ ...fields }));
}

describe("event hook vault", () => {
	it("makes a GitHub hook's secret as GitHub signs with it, sealed for its own id, company and environment", async () => {
		const drawn: Uint8Array[] = [];
		const f = vaultFixture({}, (bytes) => {
			const made = randomBytes(bytes);
			drawn.push(made);
			return made;
		});
		const request = hookRequest();
		const answer = await f.vault.handle(request, AbortSignal.timeout(5000));
		expect(answer).toEqual(receipt());
		expect(JSON.stringify(answer)).not.toMatch(/whsec_|envelope|[0-9a-f]{64}/i);
		expect(f.authority.openSignedHook).toHaveBeenCalledWith(
			request.binding,
			request.request,
			expect.anything(),
			expect.anything(),
		);
		const [opening] = f.openings;
		expect(opening).toMatchObject({ secretId, companyId, environmentId, keyId: "company-kek-1" });
		expect(opening?.envelopeSha256).toBe(createHash("sha256").update(opening!.encryptedEnvelope).digest("hex"));
		// The envelope holds the secret and nothing else, in the field the event verification reads.
		const fields = await opened(f.keyring, opening!);
		expect(Object.keys(fields)).toEqual(["signing_secret"]);
		const secret = fields.signing_secret!;
		expect(secret).toMatch(/^[0-9a-f]{64}$/);
		// GitHub keys its HMAC with the secret's text: a delivery it signs checks out.
		const body = Buffer.from(JSON.stringify({ action: "opened" }));
		expect(
			checkEventSignature({
				proof: "github",
				headers: {
					"x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
					"x-github-event": "pull_request",
				},
				body,
				secret,
				receivedAt: 0,
			}),
		).toMatchObject({ ok: true, type: "pull_request.opened" });
		// The envelope opens only with the identity the database stores.
		for (const other of [
			{ secretId: randomUUID() },
			{ companyId: randomUUID() },
			{ environmentId: randomUUID() },
			{ version: 2 },
		])
			await expect(opened(f.keyring, opening!, { ...sealedFor, ...other }), JSON.stringify(other)).rejects.toThrow();
		// The random bytes and the vault's own copy of the sealed bytes are wiped once the database has answered.
		expect(drawn[0]?.every((byte) => byte === 0)).toBe(true);
		expect(f.sent[0]?.every((byte) => byte === 0)).toBe(true);
	});

	it("makes an HMAC hook's secret as Standard Webhooks reads it", async () => {
		const f = vaultFixture();
		const request = hookRequest({ proof: "hmac-sha256", site: "app.example.com", maxBodyBytes: 4096 });
		expect(await f.vault.handle(request, AbortSignal.timeout(5000))).toEqual(
			receipt("app.example.com", "hmac-sha256"),
		);
		const secret = (await opened(f.keyring, f.openings[0]!)).signing_secret!;
		expect(secret).toMatch(/^whsec_[A-Za-z0-9+/]{43}=$/);
		const key = Buffer.from(secret.slice("whsec_".length), "base64");
		expect(key).toHaveLength(32);
		const body = Buffer.from(JSON.stringify({ type: "invoice.paid" }));
		const at = 1_800_000_000;
		const signature = createHmac("sha256", key).update(`msg_1.${at}.`).update(body).digest("base64");
		expect(
			checkEventSignature({
				proof: "hmac-sha256",
				headers: { "webhook-id": "msg_1", "webhook-timestamp": String(at), "webhook-signature": `v1,${signature}` },
				body,
				secret,
				receivedAt: at,
			}),
		).toEqual({ ok: true, key: "msg_1", type: "invoice.paid" });
	});

	it("draws a new secret and a new id for every attempt; a repeat answers the hook the first opened", async () => {
		const f = vaultFixture();
		const vault = new EventHookVault({ authority: f.authority, keys: f.keyring });
		await vault.handle(hookRequest(), AbortSignal.timeout(5000));
		await vault.handle(hookRequest(), AbortSignal.timeout(5000));
		expect(f.openings).toHaveLength(2);
		const [first, second] = f.openings;
		expect(first?.secretId).not.toBe(second?.secretId);
		const secrets = await Promise.all(
			f.openings.map((opening) =>
				f.keyring.use(opening.encryptedEnvelope, { ...sealedFor, secretId: opening.secretId }, async (fields) =>
					String(fields.signing_secret),
				),
			),
		);
		expect(secrets[0]).not.toBe(secrets[1]);
	});

	it("passes the database's refusals on in their own words, and nothing else", async () => {
		const refusing = (code: string, message: string) =>
			vaultFixture({
				openSignedHook: vi.fn(async () => {
					throw databaseError(code, message);
				}),
			});
		for (const [code, message] of [
			["22023", "An HMAC hook names the site its secret is typed into"],
			["22023", "A site is a host name such as github.com"],
			["23505", "operation key is already used for different hook work"],
			["0A000", "A Stripe hook comes later: its secret is taken from Stripe's screen"],
			["54000", "A company has at most 50 hooks"],
			["55000", "Company execution is paused"],
			["42501", "hook secret envelope is unavailable"],
			["QRC01", "hook authority changed"],
			["40P01", "deadlock detected"],
			["55P03", "canceling statement due to lock timeout"],
		]) {
			expect(await refusing(code!, message!).vault.handle(hookRequest(), AbortSignal.timeout(5000))).toEqual({
				schema: "qorpera.event-hook-refusal/v1",
				code,
				message,
			});
		}
		expect(
			await refusing("22023", "x".repeat(600)).vault.handle(hookRequest(), AbortSignal.timeout(5000)),
		).toMatchObject({ message: "x".repeat(512) });
		// The run's authority is read first: a run the broker does not serve is refused before anything is made.
		const elsewhere = vaultFixture({
			describeSignedHook: vi.fn(async () => {
				throw databaseError("42501", "cloud secret broker does not serve this company");
			}),
		});
		expect(await elsewhere.vault.handle(hookRequest(), AbortSignal.timeout(5000))).toEqual({
			schema: "qorpera.event-hook-refusal/v1",
			code: "42501",
			message: "cloud secret broker does not serve this company",
		});
		expect(elsewhere.authority.openSignedHook).not.toHaveBeenCalled();
		for (const error of [
			databaseError("XX000", "internal error"),
			databaseError("57014", "canceling statement due to statement timeout"),
			new Error("connection reset"),
			Object.assign(new Error("odd"), { code: 22023 }),
		]) {
			const f = vaultFixture({
				openSignedHook: vi.fn(async () => {
					throw error;
				}),
			});
			await expect(f.vault.handle(hookRequest(), AbortSignal.timeout(5000))).rejects.toThrow(
				"Event hook outcome unconfirmed",
			);
		}
	});

	it("never seals under a key it does not hold, for a malformed context or id, or with short randomness", async () => {
		const contexts = [
			{ schema: "qorpera.folder-signed-hook-context/v1", companyId, environmentId, keyId: "company-kek-9" },
			{ schema: "qorpera.folder-signed-hook-context/v1", companyId: "x", environmentId, keyId: "company-kek-1" },
			{ schema: "qorpera.folder-signed-hook-context/v1", companyId, environmentId: 1, keyId: "company-kek-1" },
			{
				schema: "qorpera.folder-signed-hook-context/v1",
				companyId,
				environmentId,
				keyId: "company-kek-1",
				extra: 1,
			},
			{ schema: "qorpera.company-account-context/v1", companyId, environmentId, keyId: "company-kek-1" },
			{ schema: "qorpera.folder-signed-hook-context/v1", companyId, environmentId, keyId: " bad" },
		];
		for (const context of contexts) {
			const f = vaultFixture({ describeSignedHook: vi.fn(async () => context) });
			await expect(
				f.vault.handle(hookRequest(), AbortSignal.timeout(5000)),
				JSON.stringify(context),
			).rejects.toThrow("Event hook outcome unconfirmed");
			expect(f.authority.openSignedHook).not.toHaveBeenCalled();
		}
		const f = vaultFixture();
		for (const vault of [
			new EventHookVault({ authority: f.authority, keys: f.keyring, newId: () => "not-a-uuid" }),
			new EventHookVault({ authority: f.authority, keys: f.keyring, random: () => new Uint8Array(16) }),
		])
			await expect(vault.handle(hookRequest(), AbortSignal.timeout(5000))).rejects.toThrow(
				"Event hook outcome unconfirmed",
			);
		expect(f.authority.openSignedHook).not.toHaveBeenCalled();
	});

	it("refuses a database answer that is not a create's receipt", async () => {
		for (const odd of [
			{ ...receipt(), signingSecret: "x" },
			{ ...receipt(), action: "pause" },
			{ ...receipt(), hook: "repo-pushes" },
			{ ...receipt(), schema: "qorpera.event-hook/v1" },
			null,
		]) {
			const f = vaultFixture({ openSignedHook: vi.fn(async () => odd) });
			await expect(f.vault.handle(hookRequest(), AbortSignal.timeout(5000)), JSON.stringify(odd)).rejects.toThrow(
				"Event hook outcome unconfirmed",
			);
		}
	});
});

describe("event hook fills in the vault", () => {
	const now = 1_790_000_000_000;

	it("seals the hook's secret to the computer's key, for this call and the hook's site alone", async () => {
		const f = vaultFixture();
		const use = vi.spyOn(f.keyring, "use");
		const vault = new EventHookVault({ authority: f.authority, keys: f.keyring, now: () => now });
		const call = fillRequest();
		const answer = await vault.fill(call, AbortSignal.timeout(5000));
		expect(answer.schema).toBe("qorpera.event-hook-fill-answer/v1");
		expect(JSON.stringify(answer)).not.toMatch(/whsec_|example/);
		expect(f.authority.readEventHookFill).toHaveBeenCalledWith(call, expect.anything());
		const { box } = answer as EventHookFillAnswer;
		expect(f.computer.open(box, hookIdentity, now)).toMatchObject({
			field: "signing_secret",
			value: hookSecret,
			hosts: ["app.example.com"],
		});
		// Not in another computer, nor for another hook, generation or call, nor as an account's value.
		expect(() => new CompanyComputerFillKey().open(box, hookIdentity, now)).toThrow(
			"Company account fill box does not open here",
		);
		for (const other of [
			{ ...hookIdentity, hookId: "98700000-0000-4000-8000-000000000061" },
			{ ...hookIdentity, computerGeneration: 4 },
			{ ...hookIdentity, receiptId: "98700000-0000-4000-8000-0000000000a1" },
			{
				companyId,
				companyComputerId,
				computerGeneration: 3,
				receiptId: fillReceiptId,
				accountId: hookId,
				field: "password",
			},
		] as CompanyAccountFillIdentity[])
			expect(() => f.computer.open(box, other, now), JSON.stringify(other)).toThrow(
				"Company account fill box does not open here",
			);
		// The vault's copy of the sealed bytes is wiped once the box is sealed.
		expect(use).toHaveBeenCalledTimes(1);
		expect(use.mock.calls[0]?.[0].every((byte) => byte === 0)).toBe(true);
	});

	it("reads the envelope in PostgreSQL's spelling and in one line alike", async () => {
		const f = vaultFixture();
		expect(f.fillContext().encryptedEnvelopeBase64).toContain("\n");
		vi.mocked(f.authority.readEventHookFill).mockResolvedValueOnce(
			f.fillContext({ encryptedEnvelopeBase64: Buffer.from(f.envelope).toString("base64") }),
		);
		const answer = await f.vault.fill(fillRequest(), AbortSignal.timeout(5000));
		expect(f.computer.open((answer as EventHookFillAnswer).box, hookIdentity, Date.now()).value).toBe(hookSecret);
	});

	it("passes the database's refusals on in their own words, and nothing else", async () => {
		for (const [code, message] of [
			["P0002", "No hook has this id"],
			["55000", "This hook was removed"],
			["0A000", "This hook has no secret the vault types"],
			["42501", "Only owners and admins can open hooks; ask one of them"],
			["42501", "company computer lease is unavailable"],
			["22023", "hook secret fill call is malformed"],
			["55000", "This hook's secret is gone from the vault"],
			["42501", "hook secret fill receipt is unavailable"],
			[
				"0A000",
				"The computer cannot type account values right now: it is still starting, or it needs a restart on a newer version",
			],
		]) {
			const f = vaultFixture({
				readEventHookFill: vi.fn(async () => {
					throw databaseError(code!, message!);
				}),
			});
			expect(await f.vault.fill(fillRequest(), AbortSignal.timeout(5000))).toEqual({
				schema: "qorpera.event-hook-refusal/v1",
				code,
				message,
			});
		}
		for (const error of [
			databaseError("XX000", "internal error"),
			databaseError("57014", "canceling statement due to statement timeout"),
			new Error("connection reset"),
		]) {
			const f = vaultFixture({
				readEventHookFill: vi.fn(async () => {
					throw error;
				}),
			});
			await expect(f.vault.fill(fillRequest(), AbortSignal.timeout(5000)), error.message).rejects.toThrow(
				"Event hook fill unconfirmed",
			);
		}
	});

	it("seals nothing for an answer that does not hold together", async () => {
		for (const context of [
			{ receiptId: "98700000-0000-4000-8000-0000000000a1" },
			{ envelopeSha256: "0".repeat(64) },
			{ encryptedEnvelopeBase64: "AQI" },
			{ encryptedEnvelopeBase64: "@@@@" },
			{ keyId: "company-kek-9" },
			{ version: 2 },
			{ secretId: "98700000-0000-4000-8000-000000000051" },
			{ companyId: "98700000-0000-4000-8000-000000000011" },
			{ fillPublicKey: Buffer.alloc(32).toString("base64url") },
			{ fillPublicKey: "short" },
			{ field: "password" },
			{ proof: "address" },
			{ proof: "stripe" },
			{ site: "App.example.com" },
			{ site: 1 },
			{ schema: "qorpera.company-account-fill-context/v1" },
			{ hookId: "repo-pushes" },
			{ computerGeneration: 0 },
			{ extra: 1 },
		]) {
			const f = vaultFixture();
			vi.mocked(f.authority.readEventHookFill).mockResolvedValueOnce(f.fillContext(context));
			await expect(f.vault.fill(fillRequest(), AbortSignal.timeout(5000)), JSON.stringify(context)).rejects.toThrow(
				"Event hook fill unconfirmed",
			);
		}
		// An envelope without the hook's secret in it.
		const f = vaultFixture();
		const other = f.keyring.seal({ password: "x" }, sealedFor);
		vi.mocked(f.authority.readEventHookFill).mockResolvedValueOnce(
			f.fillContext({
				encryptedEnvelopeBase64: Buffer.from(other).toString("base64"),
				envelopeSha256: createHash("sha256").update(other).digest("hex"),
			}),
		);
		await expect(f.vault.fill(fillRequest(), AbortSignal.timeout(5000))).rejects.toThrow(
			"Event hook fill unconfirmed",
		);
	});
});

describe("event hook requests", () => {
	const wire = (request: Record<string, unknown> = {}, outer: Record<string, unknown> = {}) => ({
		schema: "qorpera.event-hook-request/v1",
		...hookRequest(),
		...outer,
		request: { ...hookRequest().request, ...request },
	});

	it("reads a signed create, and refuses anything else", () => {
		const request = wire();
		expect(parseEventHookRequest(request)).toEqual({ binding: request.binding, request: request.request });
		const { site: _site, ...siteless } = hookRequest().request;
		expect(parseEventHookRequest({ ...request, request: siteless }).request).toEqual(siteless);
		expect(
			parseEventHookRequest(
				wire({ proof: "hmac-sha256", site: "app.example.com", maxBodyBytes: 4096, perMinute: 10 }),
			).request,
		).toMatchObject({ proof: "hmac-sha256", site: "app.example.com", maxBodyBytes: 4096, perMinute: 10 });
		for (const bad of [
			wire({}, { schema: "qorpera.company-account-request/v1" }),
			wire({}, { extra: 1 }),
			wire({}, { binding: { runId: "x" } }),
			wire({ action: "pause" }),
			wire({ kind: "mailbox" }),
			wire({ proof: "address" }),
			wire({ proof: "stripe" }),
			wire({ operationKey: "-bad" }),
			wire({ operationKey: "k".repeat(193) }),
			wire({ name: "n".repeat(65) }),
			wire({ purpose: "" }),
			wire({ site: `${"a".repeat(250)}.com` }),
			wire({ site: 1 }),
			wire({ maxBodyBytes: -1 }),
			wire({ perMinute: 1.5 }),
			wire({ hook: "repo-pushes" }),
		])
			expect(() => parseEventHookRequest(bad), JSON.stringify(bad.request)).toThrow();
	});

	it("reads an answer as a create's receipt or a refusal, never anything carrying more", () => {
		expect(parseEventHookAnswer(receipt())).toEqual(receipt());
		const { secretSite: _site, ...plain } = receipt();
		expect(parseEventHookAnswer(plain)).toEqual(plain);
		expect(
			parseEventHookAnswer({ schema: "qorpera.event-hook-refusal/v1", code: "22023", message: "Name a site" }),
		).toEqual({ schema: "qorpera.event-hook-refusal/v1", code: "22023", message: "Name a site" });
		for (const bad of [
			{ ...receipt(), secret: "x" },
			{ ...receipt(), action: "remove" },
			{ ...receipt(), schema: "qorpera.agent-worker-receipt/v1" },
			{ ...receipt(), hook: null },
			{ schema: "qorpera.event-hook-refusal/v1", code: "XX000", message: "internal" },
			{ schema: "qorpera.event-hook-refusal/v1", code: "22023", message: "x".repeat(513) },
			{ schema: "qorpera.event-hook-refusal/v1", code: "22023", message: "no", extra: 1 },
			[],
		])
			expect(() => parseEventHookAnswer(bad), JSON.stringify(bad)).toThrow();
	});

	it("reads a fill request, and a fill's answer as a sealed box or a refusal, and refuses anything else", () => {
		const call = fillRequest();
		const wire = { schema: "qorpera.event-hook-fill-request/v1", ...call };
		expect(parseEventHookFillRequest(wire)).toEqual(call);
		for (const bad of [
			{ ...wire, schema: "qorpera.company-account-fill-request/v1" },
			{ ...wire, schema: "qorpera.event-hook-request/v1" },
			{ ...wire, extra: 1 },
			{ ...wire, envelope: "" },
			{ ...wire, envelope: "x".repeat(65_537) },
			{ ...wire, receiptId: "x" },
			{ ...wire, idempotencyKey: "short" },
			{ ...wire, binding: { runId: "x" } },
		])
			expect(() => parseEventHookFillRequest(bad), JSON.stringify(bad).slice(0, 120)).toThrow();
		const box = { schema: "s", ephemeralPublicKey: "e", iv: "i", tag: "t", ciphertext: "c" };
		expect(parseEventHookFillAnswer({ schema: "qorpera.event-hook-fill-answer/v1", box })).toEqual({
			schema: "qorpera.event-hook-fill-answer/v1",
			box,
		});
		const refused = { schema: "qorpera.event-hook-refusal/v1", code: "P0002", message: "No hook has this id" };
		expect(parseEventHookFillAnswer(refused)).toEqual(refused);
		for (const bad of [
			{ schema: "qorpera.event-hook-fill-answer/v1", box, value: "x" },
			{ schema: "qorpera.event-hook-fill-answer/v1", box: { ...box, value: "x" } },
			{ schema: "qorpera.event-hook-fill-answer/v1", box: { ...box, iv: 1 } },
			{ schema: "qorpera.company-account-fill-answer/v1", box },
			{ schema: "qorpera.company-account-refusal/v1", code: "55000", message: "paused" },
			{ ...refused, code: "XX000" },
			{ ...refused, extra: 1 },
			receipt(),
			null,
		])
			expect(() => parseEventHookFillAnswer(bad), JSON.stringify(bad)).toThrow();
	});
});

describe("event hooks over the broker", () => {
	it("calls only its two broker-role functions, with the run's binding, the request and the opening", async () => {
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
		const { binding, request } = hookRequest({ proof: "hmac-sha256", site: "app.example.com", perMinute: 10 });
		await authority.describeSignedHook(binding, AbortSignal.timeout(5000));
		await authority.openSignedHook(
			binding,
			request,
			{
				secretId,
				companyId,
				environmentId,
				keyId: "company-kek-1",
				encryptedEnvelope: Buffer.from("sealed"),
				envelopeSha256: "c".repeat(64),
			},
			AbortSignal.timeout(5000),
		);
		expect(queries.map((query) => query.text)).toEqual([
			"select public.qorpera_folder_describe_signed_hook($1::uuid,$2::text,$3::jsonb) as result",
			"select public.qorpera_folder_open_signed_hook($1::uuid,$2::text,$3::jsonb,$4::jsonb,$5::uuid,$6::uuid,$7::uuid,$8::text,$9::bytea,$10::text) as result",
		]);
		const head = [
			brokerAuthorityId,
			createHash("sha256").update(brokerCapability).digest("hex"),
			JSON.stringify(binding),
		];
		for (const query of queries) expect(query.values.slice(0, 3)).toEqual(head);
		expect(queries[1]?.values.slice(3)).toEqual([
			JSON.stringify(request),
			secretId,
			companyId,
			environmentId,
			"company-kek-1",
			Buffer.from("sealed"),
			"c".repeat(64),
		]);
		expect(sent).toHaveLength(1);
		expect(sent[0]?.every((byte) => byte === 0)).toBe(true);
	});

	it("reads a fill with only its broker-role function, with the call's own envelope", async () => {
		const queries: Array<{ text: string; values: readonly unknown[] }> = [];
		const brokerAuthorityId = randomUUID();
		const brokerCapability = randomBytes(32).toString("base64url");
		const authority = new PostgresCloudSecretBrokerAuthority({
			database: {
				async query<Row extends Record<string, unknown>>(text: string, values: readonly unknown[]) {
					queries.push({ text, values });
					return { rowCount: 1, rows: [{ result: {} } as unknown as Row] };
				},
			},
			brokerAuthorityId,
			brokerCapability,
		});
		const call = fillRequest();
		await authority.readEventHookFill(call, AbortSignal.timeout(5000));
		expect(queries).toEqual([
			{
				text: "select public.qorpera_fill_event_hook_secret($1::uuid,$2::text,$3::jsonb,$4::uuid,$5::text,$6::text) as result",
				values: [
					brokerAuthorityId,
					createHash("sha256").update(brokerCapability).digest("hex"),
					JSON.stringify(call.binding),
					fillReceiptId,
					call.envelope,
					createHash("sha256").update(call.idempotencyKey).digest("hex"),
				],
			},
		]);
	});

	it("serves the runtime's calls with its token only, and a broker without the database calls has none", async () => {
		let opening: (() => Promise<unknown>) | undefined;
		const f = vaultFixture({
			openSignedHook: vi.fn(async (...args: Parameters<EventHookAuthority["openSignedHook"]>) =>
				opening ? opening() : receipt(args[1].site, args[1].proof),
			),
		});
		const authority: CloudSecretBrokerAuthority = {
			describeCapture: vi.fn(),
			completeCapture: vi.fn(),
			authorizeOperation: vi.fn(),
			authorizeRepositoryCredential: vi.fn(),
			describeSignedHook: f.authority.describeSignedHook,
			openSignedHook: f.authority.openSignedHook,
			readEventHookFill: f.authority.readEventHookFill,
		};
		const runtimeToken = randomBytes(32).toString("base64url");
		const codingExecutorToken = randomBytes(32).toString("base64url");
		// G2-6a: the database's lease proof stands in here (its own test is 986): only the run's own lease token, as
		// `job.<the binding's job>.<lease token>`, proves a request's binding.
		const lease = randomBytes(32).toString("base64url");
		const holderOf = (request: { binding: object }) =>
			`job.${(request.binding as { jobId: string }).jobId.toLowerCase()}.${lease}`;
		const proveBinding = vi.fn<NativeBindingProof>(async (binding, presented) => {
			if (presented !== holderOf({ binding })) throw new Error("native binding proof is refused");
		});
		const service = new HttpCloudSecretBrokerService(
			new CloudSecretBroker({ authority, keyring: f.keyring, adapters: [] }),
			runtimeToken,
			{ codingExecutorToken, proveBinding },
		);
		services.push(service);
		const port = await service.start();
		const request = hookRequest();
		const client = (holder = holderOf(request), token = runtimeToken) =>
			new HttpCloudSecretBrokerClient({
				origin: `http://127.0.0.1:${port}`,
				runtimeToken: token,
				companyId,
				holder: () => holder,
				allowLoopback: true,
			});
		expect(await client().eventHook(request, AbortSignal.timeout(5000))).toEqual(receipt());
		expect(proveBinding).toHaveBeenCalledWith(
			expect.objectContaining({ jobId: request.binding.jobId, runId: request.binding.runId }),
			holderOf(request),
		);
		expect(f.authority.openSignedHook).toHaveBeenCalledWith(
			request.binding,
			request.request,
			expect.anything(),
			expect.anything(),
		);
		opening = async () => {
			throw databaseError("23505", "operation key is already used for different hook work");
		};
		expect(await client().eventHook(request, AbortSignal.timeout(5000))).toEqual({
			schema: "qorpera.event-hook-refusal/v1",
			code: "23505",
			message: "operation key is already used for different hook work",
		});
		// An outcome the vault cannot confirm is the broker's plain refusal; the runtime asks again with the same key.
		opening = async () => {
			throw new Error("connection reset");
		};
		await expect(client().eventHook(request, AbortSignal.timeout(5000))).rejects.toThrow(
			"Cloud secret broker rejected the event hook call",
		);
		opening = undefined;
		const calls = vi.mocked(f.authority.openSignedHook).mock.calls.length;
		for (const token of [randomBytes(32).toString("base64url"), codingExecutorToken])
			await expect(client(holderOf(request), token).eventHook(request, AbortSignal.timeout(5000))).rejects.toThrow(
				"Cloud secret broker rejected the event hook call",
			);
		// Without the run's own lease (a malformed holder, another run's, or another lease token for this run's job), a
		// signed hook is refused before the database is asked anything, so no secret is made.
		for (const holder of [
			"",
			lease,
			`identity.${lease}`,
			`${holderOf(request)}x`,
			`job.${randomUUID()}.${lease}`,
			`job.${request.binding.jobId.toLowerCase()}.${"W".repeat(43)}`,
		])
			await expect(client(holder).eventHook(request, AbortSignal.timeout(5000))).rejects.toThrow(
				"Cloud secret broker rejected the event hook call",
			);
		expect(f.authority.openSignedHook).toHaveBeenCalledTimes(calls);
		const raw = await fetch(`http://127.0.0.1:${port}/v1/event-hooks?company=${companyId}`, {
			method: "POST",
			headers: { authorization: `Bearer ${runtimeToken}`, "content-type": "application/json" },
			body: JSON.stringify({
				schema: "qorpera.event-hook-request/v1",
				...request,
				request: { ...request.request, proof: "address" },
			}),
		});
		expect(raw.status).toBe(403);
		expect(await raw.json()).toEqual({ schema: "qorpera.cloud-secret-error/v1", error: "unavailable" });
		expect(f.authority.describeSignedHook).toHaveBeenCalledTimes(calls);

		const plain = new CloudSecretBroker({
			authority: { ...authority, openSignedHook: undefined },
			keyring: f.keyring,
			adapters: [],
		});
		await expect(plain.eventHook(request, AbortSignal.timeout(5000))).rejects.toThrow("Event hooks unavailable");
		await expect(plain.eventHookFill(fillRequest(), AbortSignal.timeout(5000))).rejects.toThrow(
			"Event hooks unavailable",
		);
		// The database's three hook calls come together, or the broker serves none of them.
		const fillless = new CloudSecretBroker({
			authority: { ...authority, readEventHookFill: undefined },
			keyring: f.keyring,
			adapters: [],
		});
		await expect(fillless.eventHook(request, AbortSignal.timeout(5000))).rejects.toThrow("Event hooks unavailable");
	});

	it("serves the runtime's fills with its token and the run's own lease only", async () => {
		const f = vaultFixture();
		const authority: CloudSecretBrokerAuthority = {
			describeCapture: vi.fn(),
			completeCapture: vi.fn(),
			authorizeOperation: vi.fn(),
			authorizeRepositoryCredential: vi.fn(),
			...f.authority,
		};
		const runtimeToken = randomBytes(32).toString("base64url");
		const codingExecutorToken = randomBytes(32).toString("base64url");
		// G2-6a: the database's lease proof stands in here (its own test is 986).
		const fill = fillRequest();
		const lease = randomBytes(32).toString("base64url");
		const own = `job.${fill.binding.jobId.toLowerCase()}.${lease}`;
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
		const answer = await client().eventHookFill(fill, AbortSignal.timeout(5000));
		expect(f.computer.open((answer as EventHookFillAnswer).box, hookIdentity, Date.now()).value).toBe(hookSecret);
		expect(f.authority.readEventHookFill).toHaveBeenCalledWith(fill, expect.anything());
		expect(proveBinding).toHaveBeenCalledWith(
			expect.objectContaining({ jobId: fill.binding.jobId, runId: fill.binding.runId }),
			own,
		);
		vi.mocked(f.authority.readEventHookFill).mockRejectedValueOnce(databaseError("55000", "This hook was removed"));
		expect(await client().eventHookFill(fill, AbortSignal.timeout(5000))).toEqual({
			schema: "qorpera.event-hook-refusal/v1",
			code: "55000",
			message: "This hook was removed",
		});
		// An outcome the vault cannot confirm is the broker's plain refusal: nothing is typed.
		vi.mocked(f.authority.readEventHookFill).mockRejectedValueOnce(new Error("connection reset"));
		await expect(client().eventHookFill(fill, AbortSignal.timeout(5000))).rejects.toThrow(
			"Cloud secret broker rejected the event hook fill",
		);
		const calls = vi.mocked(f.authority.readEventHookFill).mock.calls.length;
		for (const token of [randomBytes(32).toString("base64url"), codingExecutorToken])
			await expect(client(own, token).eventHookFill(fill, AbortSignal.timeout(5000))).rejects.toThrow(
				"Cloud secret broker rejected the event hook fill",
			);
		// Without the run's own lease (a malformed holder, another run's, or another lease token for this run's job), the
		// fill is refused before the database is asked anything.
		for (const holder of [
			"",
			lease,
			`identity.${lease}`,
			`${own}x`,
			`job.${randomUUID()}.${lease}`,
			`job.${fill.binding.jobId.toLowerCase()}.${"W".repeat(43)}`,
		])
			await expect(client(holder).eventHookFill(fill, AbortSignal.timeout(5000))).rejects.toThrow(
				"Cloud secret broker rejected the event hook fill",
			);
		// The route reads only a hook's fill: an account's fill request there is refused before the database too.
		const raw = await fetch(`http://127.0.0.1:${port}/v1/event-hook-fills?company=${companyId}`, {
			method: "POST",
			headers: {
				authorization: `Bearer ${runtimeToken}`,
				"x-qorpera-identity": own,
				"content-type": "application/json",
			},
			body: JSON.stringify({ schema: "qorpera.company-account-fill-request/v1", ...fill }),
		});
		expect(raw.status).toBe(403);
		expect(await raw.json()).toEqual({ schema: "qorpera.cloud-secret-error/v1", error: "unavailable" });
		expect(f.authority.readEventHookFill).toHaveBeenCalledTimes(calls);
	});
});
