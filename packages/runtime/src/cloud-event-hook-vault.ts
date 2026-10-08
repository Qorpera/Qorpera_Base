import { createHash, randomBytes, randomUUID } from "node:crypto";
import { isUuid, parseBoundedText, parseClosedRecord, parseInteger, parseRecord, parseUuid } from "@qorpera/contracts";
import { EVENT_HOOK_SECRET_FIELD } from "./cloud-event-verification.ts";
import { type CloudNativeToolBinding, parseCloudNativeToolBinding } from "./cloud-native-tool-authority.ts";
import type { CloudSecretKeyring } from "./cloud-secret-crypto.ts";

/* Signed hooks' secrets in the vault (E3b-2; deploy/first-node/RUNTIME-COMPANY-FOLDER-EVENTS.md §5.7). The runtime
 * sends an agent's manage_hook create of a GitHub or HMAC hook here, with the run's binding; the vault makes the
 * hook's signing secret, seals it under the company's key and opens the hook with it in one database step
 * (qorpera_folder_open_signed_hook, 20260930160000). The secret never leaves the vault: the answer is the hook's
 * receipt, as manage_hook's host path gives it, or the database's refusal in its own words. Every other failure is
 * the broker's plain refusal, which the runtime asks again with the same operation key (a replay answers from the
 * receipt and stores nothing). */

export const EVENT_HOOK_REQUEST_SCHEMA = "qorpera.event-hook-request/v1";
const REFUSAL_SCHEMA = "qorpera.event-hook-refusal/v1";
const CONTEXT_SCHEMA = "qorpera.folder-signed-hook-context/v1";
const RECEIPT_SCHEMA = "qorpera.agent-hook-receipt/v1";
const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
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

/** The broker-role database calls (supabase migration 20260930160000). */
export interface EventHookAuthority {
	describeSignedHook(binding: CloudNativeToolBinding, signal: AbortSignal): Promise<unknown>;
	openSignedHook(
		binding: CloudNativeToolBinding,
		request: EventHookCreate,
		opening: EventHookOpening,
		signal: AbortSignal,
	): Promise<unknown>;
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

	constructor(options: {
		authority: EventHookAuthority;
		keys: CloudSecretKeyring;
		random?: (bytes: number) => Uint8Array;
		newId?: () => string;
	}) {
		this.#authority = options.authority;
		this.#keys = options.keys;
		this.#random = options.random ?? ((bytes) => randomBytes(bytes));
		this.#newId = options.newId ?? randomUUID;
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
