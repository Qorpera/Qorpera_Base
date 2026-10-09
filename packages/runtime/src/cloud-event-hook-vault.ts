import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
	isUuid,
	parseBoundedText,
	parseClosedRecord,
	parseInteger,
	parseRecord,
	parseSha256Hex,
	parseUuid,
} from "@qorpera/contracts";
import { sealCompanyAccountFill } from "./cloud-company-account-fill-box.ts";
import { EVENT_HOOK_SECRET_FIELD } from "./cloud-event-verification.ts";
import { type CloudNativeToolBinding, parseCloudNativeToolBinding } from "./cloud-native-tool-authority.ts";
import type { CloudSecretKeyring } from "./cloud-secret-crypto.ts";

/* Signed hooks' secrets in the vault (E3b-2; deploy/first-node/RUNTIME-COMPANY-FOLDER-EVENTS.md §5.7). The runtime
 * sends an agent's manage_hook create of a GitHub or HMAC hook here, with the run's binding; the vault makes the
 * hook's signing secret, seals it under the company's key and opens the hook with it in one database step
 * (qorpera_folder_open_signed_hook, 20260930160000). The secret never leaves the vault: the answer is the hook's
 * receipt, as manage_hook's host path gives it, or the database's refusal in its own words. Every other failure is
 * the broker's plain refusal, which the runtime asks again with the same operation key (a replay answers from the
 * receipt and stores nothing).
 *
 * The secret goes to the sender's settings page only as A1's account values go (E3b-3): an agent's computer_browser
 * vault_fill of the hook, already begun as an effect receipt, has the vault read the secret
 * (qorpera_fill_event_hook_secret) and seal it to the boot key of the computer the run's screen lease holds, for that
 * one call and the hook's site alone (cloud-company-account-fill-box.ts). */

export const EVENT_HOOK_REQUEST_SCHEMA = "qorpera.event-hook-request/v1";
export const EVENT_HOOK_FILL_REQUEST_SCHEMA = "qorpera.event-hook-fill-request/v1";
const REFUSAL_SCHEMA = "qorpera.event-hook-refusal/v1";
const CONTEXT_SCHEMA = "qorpera.folder-signed-hook-context/v1";
const RECEIPT_SCHEMA = "qorpera.agent-hook-receipt/v1";
const FILL_CONTEXT_SCHEMA = "qorpera.event-hook-fill-context/v1";
const FILL_ANSWER_SCHEMA = "qorpera.event-hook-fill-answer/v1";
const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA256 = /^[0-9a-f]{64}$/;
/** As manage_hook takes it (E3a). */
const OPERATION_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
/** SQL's answers the runtime reads, as manage_hook's host path raises them: the request's rules, the company's state,
 * the run's authority and the wake's (refused in the model's words, or asked again: 40P01, QRC01, 55P03). Their
 * messages hold no value. */
const REFUSALS = new Set(["0A000", "22023", "23505", "42501", "54000", "55000", "55P03", "40P01", "QRC01", "P0002"]);

/** One manage_hook create of a signed hook, as the runtime checked it. The database checks it again. */
export interface EventHookCreate {
	readonly action: "create";
	readonly kind: "hook";
	readonly name: string;
	readonly purpose: string;
	readonly proof: "github" | "hmac-sha256";
	/** Where the vault may type the secret: github.com for a GitHub hook unless named, and named for an HMAC hook. */
	readonly site?: string;
	readonly maxBodyBytes?: number;
	readonly perMinute?: number;
	readonly operationKey: string;
}

export interface EventHookRequest {
	readonly binding: CloudNativeToolBinding;
	readonly request: EventHookCreate;
}

export interface EventHookRefusal {
	readonly schema: typeof REFUSAL_SCHEMA;
	readonly code: string;
	readonly message: string;
}

/** The hook's receipt, as manage_hook's host path answers it; the runtime checks it as it checks that path's. */
export type EventHookReceipt = Readonly<Record<string, unknown>>;

export type EventHookAnswer = EventHookReceipt | EventHookRefusal;

/** What the opening sealed into the envelope's associated data and stores beside it. */
export interface EventHookOpening {
	readonly secretId: string;
	readonly companyId: string;
	readonly environmentId: string;
	readonly keyId: string;
	readonly encryptedEnvelope: Uint8Array;
	readonly envelopeSha256: string;
}

/** One `computer_browser` `vault_fill` of a hook's secret in an agent's run, as the native host began it (E3b-3). */
export interface EventHookFillRequest {
	readonly binding: CloudNativeToolBinding;
	readonly receiptId: string;
	/** The receipt's downstream idempotency key; the database keeps its SHA-256. */
	readonly idempotencyKey: string;
	/** The call's operation envelope, exactly as the receipt's input digest was taken of it. */
	readonly envelope: string;
}

/** The secret sealed to the computer's boot key; only that office service opens it. */
export interface EventHookFillAnswer {
	readonly schema: typeof FILL_ANSWER_SCHEMA;
	readonly box: Readonly<Record<string, string>>;
}

/** The broker-role database calls (supabase migration 20260930160000). */
export interface EventHookAuthority {
	describeSignedHook(binding: CloudNativeToolBinding, signal: AbortSignal): Promise<unknown>;
	openSignedHook(
		binding: CloudNativeToolBinding,
		request: EventHookCreate,
		opening: EventHookOpening,
		signal: AbortSignal,
	): Promise<unknown>;
	readEventHookFill(request: EventHookFillRequest, signal: AbortSignal): Promise<unknown>;
}

/** A signed hook's create as the runtime sends it; anything else is refused. The bounds are loose: the database
 * refuses what breaks its rules, in words the model reads. */
export function parseEventHookRequest(value: unknown): EventHookRequest {
	const input = parseClosedRecord(value, "Event hook request", ["schema", "binding", "request"]);
	if (input.schema !== EVENT_HOOK_REQUEST_SCHEMA) throw new Error("Event hook request is malformed");
	const request = parseClosedRecord(
		input.request,
		"Event hook request",
		["action", "kind", "name", "purpose", "proof", "operationKey"],
		["site", "maxBodyBytes", "perMinute"],
	);
	if (
		request.action !== "create" ||
		request.kind !== "hook" ||
		(request.proof !== "github" && request.proof !== "hmac-sha256") ||
		typeof request.operationKey !== "string" ||
		!OPERATION_KEY.test(request.operationKey)
	)
		throw new Error("Event hook request is malformed");
	const limit = (key: "maxBodyBytes" | "perMinute") =>
		request[key] === undefined ? {} : { [key]: parseInteger(request[key], "Event hook limit", 0, 999_999_999) };
	return {
		binding: parseCloudNativeToolBinding(input.binding),
		request: {
			action: "create",
			kind: "hook",
			name: parseBoundedText(request.name, "Event hook name", 64),
			purpose: parseBoundedText(request.purpose, "Event hook purpose", 1024),
			proof: request.proof,
			...(request.site === undefined ? {} : { site: parseBoundedText(request.site, "Event hook site", 253) }),
			...limit("maxBodyBytes"),
			...limit("perMinute"),
			operationKey: request.operationKey,
		},
	};
}

/** The vault's answer, as the runtime reads it: a create's receipt or a refusal, nothing else. */
export function parseEventHookAnswer(value: unknown): EventHookAnswer {
	const input = parseRecord(value, "Event hook answer");
	if (input.schema === REFUSAL_SCHEMA) {
		parseClosedRecord(input, "Event hook refusal", ["schema", "code", "message"]);
		if (typeof input.code !== "string" || !REFUSALS.has(input.code))
			throw new Error("Event hook refusal is malformed");
		return {
			schema: REFUSAL_SCHEMA,
			code: input.code,
			message: parseBoundedText(input.message, "Event hook refusal", 512),
		};
	}
	parseClosedRecord(input, "Event hook receipt", ["schema", "runId", "receiptId", "action", "hook"], ["secretSite"]);
	if (input.schema !== RECEIPT_SCHEMA || input.action !== "create") throw new Error("Event hook receipt is malformed");
	parseRecord(input.hook, "Event hook");
	return input;
}

/** The answer of this file's refusal schema, or none. */
export function isEventHookRefusal(answer: EventHookAnswer): answer is EventHookRefusal {
	return answer.schema === REFUSAL_SCHEMA;
}

/** A fill request as the runtime sends it; anything else is refused. */
export function parseEventHookFillRequest(value: unknown): EventHookFillRequest {
	const input = parseClosedRecord(value, "Event hook fill request", [
		"schema",
		"binding",
		"receiptId",
		"idempotencyKey",
		"envelope",
	]);
	if (input.schema !== EVENT_HOOK_FILL_REQUEST_SCHEMA) throw new Error("Event hook fill request is malformed");
	return {
		binding: parseCloudNativeToolBinding(input.binding),
		receiptId: parseUuid(input.receiptId, "Event hook fill receipt"),
		idempotencyKey: parseSha256Hex(input.idempotencyKey, "Event hook fill idempotency key"),
		envelope: parseBoundedText(input.envelope, "Event hook fill call", 65_536),
	};
}

/** The vault's answer to a fill, as the runtime reads it: a sealed box or a refusal. */
export function parseEventHookFillAnswer(value: unknown): EventHookFillAnswer | EventHookRefusal {
	const input = parseRecord(value, "Event hook fill answer");
	if (input.schema === REFUSAL_SCHEMA) return parseEventHookAnswer(input) as EventHookRefusal;
	parseClosedRecord(input, "Event hook fill answer", ["schema", "box"]);
	if (input.schema !== FILL_ANSWER_SCHEMA) throw new Error("Event hook fill answer is malformed");
	const box = parseClosedRecord(input.box, "Event hook fill box", [
		"schema",
		"ephemeralPublicKey",
		"iv",
		"tag",
		"ciphertext",
	]);
	const out: Record<string, string> = {};
	for (const [name, part] of Object.entries(box)) out[name] = parseBoundedText(part, "Event hook fill box", 8192);
	return { schema: FILL_ANSWER_SCHEMA, box: out };
}

interface FillContext {
	readonly hookId: string;
	readonly site: string;
	readonly secretId: string;
	readonly version: number;
	readonly companyId: string;
	readonly environmentId: string;
	readonly keyId: string;
	readonly envelope: Buffer;
	readonly receiptId: string;
	readonly companyComputerId: string;
	readonly computerGeneration: number;
	readonly fillPublicKey: string;
}

/** What the database answers for a fill; the envelope is checked against its digest. */
function fillContext(value: unknown): FillContext {
	const input = parseClosedRecord(value, "Event hook fill context", [
		"schema",
		"hookId",
		"proof",
		"site",
		"secretId",
		"version",
		"companyId",
		"environmentId",
		"keyId",
		"encryptedEnvelopeBase64",
		"envelopeSha256",
		"receiptId",
		"field",
		"companyComputerId",
		"computerGeneration",
		"fillPublicKey",
	]);
	const { site, keyId, encryptedEnvelopeBase64, envelopeSha256, fillPublicKey } = input;
	// PostgreSQL's encode(…, 'base64') breaks lines every 76 characters; the line breaks carry nothing.
	const base64 = typeof encryptedEnvelopeBase64 === "string" ? encryptedEnvelopeBase64.replace(/\n/g, "") : null;
	if (
		input.schema !== FILL_CONTEXT_SCHEMA ||
		input.field !== EVENT_HOOK_SECRET_FIELD ||
		(input.proof !== "github" && input.proof !== "hmac-sha256") ||
		typeof site !== "string" ||
		typeof keyId !== "string" ||
		!KEY_ID.test(keyId) ||
		base64 === null ||
		!/^[A-Za-z0-9+/]+={0,2}$/.test(base64) ||
		typeof envelopeSha256 !== "string" ||
		!SHA256.test(envelopeSha256) ||
		typeof fillPublicKey !== "string"
	)
		throw new Error("Event hook fill context is malformed");
	const envelope = Buffer.from(base64, "base64");
	if (
		envelope.toString("base64") !== base64 ||
		createHash("sha256").update(envelope).digest("hex") !== envelopeSha256
	) {
		envelope.fill(0);
		throw new Error("Event hook fill envelope is malformed");
	}
	try {
		return {
			hookId: parseUuid(input.hookId, "Event hook"),
			site,
			secretId: parseUuid(input.secretId, "Event hook secret"),
			version: parseInteger(input.version, "Event hook secret version", 1, Number.MAX_SAFE_INTEGER),
			companyId: parseUuid(input.companyId, "Event hook company"),
			environmentId: parseUuid(input.environmentId, "Event hook environment"),
			keyId,
			envelope,
			receiptId: parseUuid(input.receiptId, "Event hook fill receipt"),
			companyComputerId: parseUuid(input.companyComputerId, "Company Computer"),
			computerGeneration: parseInteger(
				input.computerGeneration,
				"Company Computer generation",
				1,
				Number.MAX_SAFE_INTEGER,
			),
			fillPublicKey,
		};
	} catch (error) {
		envelope.fill(0);
		throw error;
	}
}

function refusal(error: unknown): EventHookRefusal | null {
	if (!error || typeof error !== "object") return null;
	const { code, message } = error as { code?: unknown; message?: unknown };
	if (typeof code !== "string" || !REFUSALS.has(code) || typeof message !== "string") return null;
	return { schema: REFUSAL_SCHEMA, code, message: message.slice(0, 512) };
}

export class EventHookVault {
	readonly #authority: EventHookAuthority;
	readonly #keys: CloudSecretKeyring;
	readonly #random: (bytes: number) => Uint8Array;
	readonly #newId: () => string;
	readonly #now: () => number;

	constructor(options: {
		authority: EventHookAuthority;
		keys: CloudSecretKeyring;
		random?: (bytes: number) => Uint8Array;
		newId?: () => string;
		now?: () => number;
	}) {
		this.#authority = options.authority;
		this.#keys = options.keys;
		this.#random = options.random ?? ((bytes) => randomBytes(bytes));
		this.#newId = options.newId ?? randomUUID;
		this.#now = options.now ?? Date.now;
	}

	/**
	 * One vault_fill of a hook's secret (E3b-3): the secret sealed to the boot key of the computer the run's screen
	 * lease holds, for this tool call and the hook's site; or the database's refusal. The secret is never in an
	 * answer, a log or an error.
	 */
	async fill(request: EventHookFillRequest, signal: AbortSignal): Promise<EventHookFillAnswer | EventHookRefusal> {
		try {
			return await this.#fill(request, signal);
		} catch (error) {
			const refused = refusal(error);
			if (refused) return refused;
			throw new Error("Event hook fill unconfirmed");
		}
	}

	async #fill(request: EventHookFillRequest, signal: AbortSignal): Promise<EventHookFillAnswer> {
		const context = fillContext(await this.#authority.readEventHookFill(request, signal));
		try {
			if (context.receiptId !== request.receiptId) throw new Error("Event hook fill context is malformed");
			const box = await this.#keys.use(
				context.envelope,
				{
					companyId: context.companyId,
					environmentId: context.environmentId,
					secretId: context.secretId,
					version: context.version,
					keyId: context.keyId,
				},
				async (fields) => {
					const secret = Object.hasOwn(fields, EVENT_HOOK_SECRET_FIELD)
						? fields[EVENT_HOOK_SECRET_FIELD]
						: undefined;
					if (typeof secret !== "string") throw new Error("Event hook secret is malformed");
					// Typed only on the hook's own site: the sender's settings page.
					return sealCompanyAccountFill(
						{ value: secret, hosts: [context.site] },
						context.fillPublicKey,
						{
							companyId: context.companyId,
							companyComputerId: context.companyComputerId,
							computerGeneration: context.computerGeneration,
							receiptId: context.receiptId,
							hookId: context.hookId,
							field: EVENT_HOOK_SECRET_FIELD,
						},
						this.#now(),
					);
				},
			);
			return { schema: FILL_ANSWER_SCHEMA, box };
		} finally {
			context.envelope.fill(0);
		}
	}

	/** One signed manage_hook create: the hook's receipt, or the database's refusal the runtime reads. */
	async handle(request: EventHookRequest, signal: AbortSignal): Promise<EventHookAnswer> {
		try {
			return await this.#open(request, signal);
		} catch (error) {
			const refused = refusal(error);
			if (refused) return refused;
			throw new Error("Event hook outcome unconfirmed");
		}
	}

	async #open({ binding, request }: EventHookRequest, signal: AbortSignal): Promise<EventHookAnswer> {
		// The run's company, environment and the company's key: the envelope's associated data needs them first.
		const context = parseClosedRecord(
			await this.#authority.describeSignedHook(binding, signal),
			"Event hook context",
			["schema", "companyId", "environmentId", "keyId"],
		);
		if (context.schema !== CONTEXT_SCHEMA || typeof context.keyId !== "string" || !KEY_ID.test(context.keyId))
			throw new Error("Event hook context is malformed");
		const keyId = context.keyId;
		if (!this.#keys.has(keyId)) throw new Error("Event hook key is unavailable");
		const companyId = parseUuid(context.companyId, "Event hook company");
		const environmentId = parseUuid(context.environmentId, "Event hook environment");
		const secretId = this.#newId();
		if (!isUuid(secretId)) throw new Error("Event hook secret id is malformed");
		// 32 random bytes in the form each sender's verification reads (cloud-event-verification.ts): GitHub keys its
		// HMAC with the secret's text, so hex; Standard Webhooks' secret is whsec_ and the base64 of the key.
		const bytes = this.#random(32);
		if (bytes.byteLength !== 32) throw new Error("Event hook secret is malformed");
		const key = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
		const secret = request.proof === "github" ? key.toString("hex") : `whsec_${key.toString("base64")}`;
		bytes.fill(0);
		const encryptedEnvelope = this.#keys.seal(
			{ [EVENT_HOOK_SECRET_FIELD]: secret },
			{ companyId, environmentId, secretId, version: 1, keyId },
		);
		try {
			// A repeat of the same create answers the hook its first attempt opened; this attempt's envelope was never
			// stored and goes with the buffer below.
			return parseEventHookAnswer(
				await this.#authority.openSignedHook(
					binding,
					request,
					{
						secretId,
						companyId,
						environmentId,
						keyId,
						encryptedEnvelope,
						envelopeSha256: createHash("sha256").update(encryptedEnvelope).digest("hex"),
					},
					signal,
				),
			);
		} finally {
			encryptedEnvelope.fill(0);
		}
	}
}
