import { createHash, randomUUID } from "node:crypto";
import {
	isUuid,
	parseBoundedText,
	parseClosedRecord,
	parseInteger,
	parseRecord,
	parseSha256Hex,
	parseUuid,
} from "@qorpera/contracts";
import { codingValueMatches, codingValuePattern } from "./cloud-coding-value-capture-box.ts";
import { type CloudNativeToolBinding, parseCloudNativeToolBinding } from "./cloud-native-tool-authority.ts";
import type { CloudSecretKeyring } from "./cloud-secret-crypto.ts";
import {
	type HeldVersion,
	heldValueIs,
	parseHeldVersion,
	VAULT_CAPTURE_REFUSALS,
	vaultCaptureRefusal,
	vaultRefused,
	withCaptureRetries,
} from "./cloud-vault-capture.ts";

/* Coding values an agent takes into the vault itself (20260930695000): the environment variable its coding sessions get
 * (an npm token, a Stripe key), which the agent makes on the service's own website in its company computer's browser
 * and the office reads off that page. E3c's capture (cloud-event-hook-vault.ts) for a value of the `environment`
 * connector instead of a hook's secret. One computer_browser vault_capture with a codingValue comes here twice, both
 * times as the native host began it (its receipt, its idempotency key and its operation envelope):
 * - prepare, before the office acts: the value's capture key, made under the company's current key for the id the
 *   database names (qorpera_folder_prepare_coding_value_capture). The broker derives the key pair from the company's key
 *   and stores nothing; the database keeps the public half, and the office reads it from there itself.
 * - capture, after it, with the office's sealed box: the vault opens it, checks the value against the service's pattern
 *   and its site, seals it as the next version of the value (`{value}`, as a member's coding value is sealed) and
 *   stores it, which also grants it to the call's repository in the run requester's name
 *   (qorpera_folder_store_coding_value_capture). A value equal to the version the vault holds is stored all the same:
 *   the store is the only call that records this call's capture and issues the repository's grant, and the database,
 *   which never sees a value, cannot tell the two apart. The answer says it was unchanged.
 * The value never leaves the vault but sealed into it; the answers carry its name, repository and version only. */

export const CODING_VALUE_PREPARE_REQUEST_SCHEMA = "qorpera.coding-value-prepare-request/v1";
export const CODING_VALUE_CAPTURE_REQUEST_SCHEMA = "qorpera.coding-value-capture-request/v1";
const REFUSAL_SCHEMA = "qorpera.coding-value-refusal/v1";
const PREPARE_ANSWER_SCHEMA = "qorpera.coding-value-prepare-answer/v1";
const CAPTURE_ANSWER_SCHEMA = "qorpera.coding-value-capture-answer/v1";
const KEY_SCHEMA = "qorpera.coding-value-capture-key/v1";
const CONTEXT_SCHEMA = "qorpera.coding-value-capture-context/v1";
const STORED_SCHEMA = "qorpera.coding-value-capture-stored/v1";
const OPERATION_SCHEMA = "qorpera.cloud-tool-operation/v2";
/** The one field a coding value's envelope holds (cloud-secret-broker.ts, environmentValue). */
const VALUE_FIELD = "value";
const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const VARIABLE = /^[a-z][a-z0-9_]{0,63}$/;
const SERVICE = /^[a-z][a-z0-9-]{0,31}$/;
const HOST = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;
const REPOSITORY = /^[a-z0-9]([a-z0-9-]{0,37}[a-z0-9])?\/[a-z0-9_][a-z0-9_.-]{0,99}$/;
/** The database's words when the key id the broker sealed under is not the company's current one. */
const OTHER_KEY = "coding value capture key is unavailable";
/** How many times a prepare follows the id the database names before it is left unconfirmed. */
const PREPARE_IDS = 3;

/** One `computer_browser` `vault_capture` of a coding value, as the native host began it. */
export interface CodingValueCaptureCall {
	readonly binding: CloudNativeToolBinding;
	readonly receiptId: string;
	/** The receipt's downstream idempotency key; the database keeps its SHA-256. */
	readonly idempotencyKey: string;
	/** The call's operation envelope, exactly as the receipt's input digest was taken of it. */
	readonly envelope: string;
}

/** The same call after the office read the value, with the box it sealed it in. */
export interface CodingValueCaptureRequest extends CodingValueCaptureCall {
	readonly box: Readonly<Record<string, string>>;
}

/** A capture key the broker made: the id it is for, the company key it is derived under, and its public half. */
export interface CodingValueCaptureKey {
	readonly secretId: string;
	readonly keyId: string;
	readonly publicKey: string;
}

/** The version a capture sealed, as the vault stores it for this call. */
export interface CodingValueCaptureVersion {
	readonly secretId: string;
	readonly version: number;
	readonly companyId: string;
	readonly environmentId: string;
	readonly keyId: string;
	readonly encryptedEnvelope: Uint8Array;
	readonly envelopeSha256: string;
}

export interface CodingValueRefusal {
	readonly schema: typeof REFUSAL_SCHEMA;
	readonly code: string;
	readonly message: string;
}

/** The value's capture key is ready for the office. */
export interface CodingValuePrepareAnswer {
	readonly schema: typeof PREPARE_ANSWER_SCHEMA;
	readonly variable: string;
	/** A key made under an older authority or company key, or for an id the value no longer keeps, was made again. */
	readonly replaced: boolean;
}

/** Which version of the value the vault holds after the capture, and the repository its sessions get it in. */
export interface CodingValueCaptureAnswer {
	readonly schema: typeof CAPTURE_ANSWER_SCHEMA;
	readonly variable: string;
	readonly repository: string;
	readonly version: number;
	/** The page showed the value the vault already held; it was stored again for this call's grant. */
	readonly unchanged: boolean;
}

/** The broker-role database calls (20260930695000). */
export interface CodingValueAuthority {
	prepareCodingValueCapture(
		call: CodingValueCaptureCall,
		key: CodingValueCaptureKey,
		signal: AbortSignal,
	): Promise<unknown>;
	readCodingValueCapture(call: CodingValueCaptureCall, signal: AbortSignal): Promise<unknown>;
	storeCodingValueCapture(
		call: CodingValueCaptureCall,
		stored: CodingValueCaptureVersion,
		signal: AbortSignal,
	): Promise<unknown>;
}

function parseCall(input: Record<string, unknown>): CodingValueCaptureCall {
	return {
		binding: parseCloudNativeToolBinding(input.binding),
		receiptId: parseUuid(input.receiptId, "Coding value capture receipt"),
		idempotencyKey: parseSha256Hex(input.idempotencyKey, "Coding value capture idempotency key"),
		envelope: parseBoundedText(input.envelope, "Coding value capture call", 65_536),
	};
}

/** A prepare or a capture, as the native host sends it; anything else is refused. The box is opened, and checked, by
 * the vault. */
export function parseCodingValueRequest(
	value: unknown,
): { readonly prepare: CodingValueCaptureCall } | { readonly capture: CodingValueCaptureRequest } {
	const schema = parseRecord(value, "Coding value request").schema;
	if (schema === CODING_VALUE_PREPARE_REQUEST_SCHEMA)
		return {
			prepare: parseCall(
				parseClosedRecord(value, "Coding value request", [
					"schema",
					"binding",
					"receiptId",
					"idempotencyKey",
					"envelope",
				]),
			),
		};
	if (schema !== CODING_VALUE_CAPTURE_REQUEST_SCHEMA) throw new Error("Coding value request is malformed");
	const input = parseClosedRecord(value, "Coding value request", [
		"schema",
		"binding",
		"receiptId",
		"idempotencyKey",
		"envelope",
		"box",
	]);
	const box = parseClosedRecord(input.box, "Coding value capture box", [
		"schema",
		"ephemeralPublicKey",
		"iv",
		"tag",
		"ciphertext",
	]);
	const parts: Record<string, string> = {};
	for (const [name, part] of Object.entries(box))
		parts[name] = parseBoundedText(part, "Coding value capture box", 8192);
	return { capture: { ...parseCall(input), box: parts } };
}

function parseRefusal(input: Record<string, unknown>): CodingValueRefusal {
	parseClosedRecord(input, "Coding value refusal", ["schema", "code", "message"]);
	if (typeof input.code !== "string" || !VAULT_CAPTURE_REFUSALS.has(input.code))
		throw new Error("Coding value refusal is malformed");
	return {
		schema: REFUSAL_SCHEMA,
		code: input.code,
		message: parseBoundedText(input.message, "Coding value refusal", 512),
	};
}

/** The vault's answer to a prepare, as the runtime reads it: the key is ready, or a refusal. */
export function parseCodingValuePrepareAnswer(value: unknown): CodingValuePrepareAnswer | CodingValueRefusal {
	const input = parseRecord(value, "Coding value prepare answer");
	if (input.schema === REFUSAL_SCHEMA) return parseRefusal(input);
	parseClosedRecord(input, "Coding value prepare answer", ["schema", "variable", "replaced"]);
	if (
		input.schema !== PREPARE_ANSWER_SCHEMA ||
		typeof input.variable !== "string" ||
		!VARIABLE.test(input.variable) ||
		typeof input.replaced !== "boolean"
	)
		throw new Error("Coding value prepare answer is malformed");
	return { schema: PREPARE_ANSWER_SCHEMA, variable: input.variable, replaced: input.replaced };
}

/** The vault's answer to a capture, as the runtime reads it: the version it holds, or a refusal. */
export function parseCodingValueCaptureAnswer(value: unknown): CodingValueCaptureAnswer | CodingValueRefusal {
	const input = parseRecord(value, "Coding value capture answer");
	if (input.schema === REFUSAL_SCHEMA) return parseRefusal(input);
	parseClosedRecord(input, "Coding value capture answer", [
		"schema",
		"variable",
		"repository",
		"version",
		"unchanged",
	]);
	if (
		input.schema !== CAPTURE_ANSWER_SCHEMA ||
		typeof input.variable !== "string" ||
		!VARIABLE.test(input.variable) ||
		typeof input.repository !== "string" ||
		!REPOSITORY.test(input.repository) ||
		typeof input.unchanged !== "boolean"
	)
		throw new Error("Coding value capture answer is malformed");
	return {
		schema: CAPTURE_ANSWER_SCHEMA,
		variable: input.variable,
		repository: input.repository,
		version: parseInteger(input.version, "Coding value version", 1, Number.MAX_SAFE_INTEGER),
		unchanged: input.unchanged,
	};
}

/** The answer of this file's refusal schema, or none. */
export function isCodingValueRefusal(answer: { readonly schema: string }): answer is CodingValueRefusal {
	return answer.schema === REFUSAL_SCHEMA;
}

/** Whose value the call takes: the run's company and environment, as the envelope's principals name them (the
 * database's begin held them to the run, and the receipt's input digest is this envelope's), and the variable. */
interface CallTarget {
	readonly companyId: string;
	readonly environmentId: string;
	readonly variable: string;
}

function callTarget(envelope: string): CallTarget {
	const input = parseRecord(JSON.parse(envelope), "Coding value capture call");
	const principals = parseRecord(input.principals, "Coding value capture call");
	const operation = parseRecord(input.operation, "Coding value capture call");
	const value = parseRecord(parseRecord(operation.arguments, "Coding value capture call").codingValue, "Coding value");
	if (input.schema !== OPERATION_SCHEMA || typeof value.variable !== "string" || !VARIABLE.test(value.variable))
		throw new Error("Coding value capture call is malformed");
	return {
		companyId: parseUuid(principals.companyId, "Coding value company"),
		environmentId: parseUuid(principals.environmentId, "Coding value environment"),
		variable: value.variable,
	};
}

interface PreparedKey {
	readonly secretId: string;
	readonly current: boolean;
	readonly replaced?: boolean;
	readonly capturePublicKey?: string;
}

/** What the database answers for a prepare under `keyId`: the key it keeps (current), or the id to derive for. */
function preparedKey(value: unknown, target: CallTarget, keyId: string): PreparedKey {
	const input = parseClosedRecord(
		value,
		"Coding value capture key",
		["schema", "companyId", "environmentId", "variable", "keyId", "secretId", "current"],
		["replaced", "capturePublicKey"],
	);
	const current = input.current === true;
	if (
		input.schema !== KEY_SCHEMA ||
		parseUuid(input.companyId, "Coding value company") !== target.companyId ||
		parseUuid(input.environmentId, "Coding value environment") !== target.environmentId ||
		input.variable !== target.variable ||
		input.keyId !== keyId ||
		typeof input.current !== "boolean" ||
		(current
			? typeof input.replaced !== "boolean" || typeof input.capturePublicKey !== "string"
			: input.replaced !== undefined || input.capturePublicKey !== undefined)
	)
		throw new Error("Coding value capture key is malformed");
	return {
		secretId: parseUuid(input.secretId, "Coding value secret"),
		current,
		...(current ? { replaced: input.replaced as boolean, capturePublicKey: input.capturePublicKey as string } : {}),
	};
}

interface CaptureContext {
	readonly secretId: string;
	/** The version a new value is stored as. */
	readonly version: number;
	readonly service: string;
	readonly site: string;
	readonly valuePattern: string;
	readonly variable: string;
	readonly repository: string;
	readonly companyId: string;
	readonly environmentId: string;
	readonly keyId: string;
	readonly receiptId: string;
	readonly companyComputerId: string;
	readonly computerGeneration: number;
	/** The version the vault holds, sealed under this broker's key; none before the first. */
	readonly current?: HeldVersion;
	/** This call stored its value already. */
	readonly captured?: { readonly version: number };
}

/** What the database answers for a capture; a held version's envelope is checked against its digest. */
function captureContext(value: unknown): CaptureContext {
	const input = parseClosedRecord(
		value,
		"Coding value capture context",
		[
			"schema",
			"secretId",
			"version",
			"service",
			"site",
			"valuePattern",
			"variable",
			"repository",
			"companyId",
			"environmentId",
			"keyId",
			"capturePublicKey",
			"receiptId",
			"companyComputerId",
			"computerGeneration",
		],
		["current", "captured"],
	);
	const { service, site, valuePattern, variable, repository, keyId } = input;
	if (
		input.schema !== CONTEXT_SCHEMA ||
		typeof service !== "string" ||
		!SERVICE.test(service) ||
		typeof site !== "string" ||
		site.length > 253 ||
		!HOST.test(site) ||
		typeof valuePattern !== "string" ||
		typeof variable !== "string" ||
		!VARIABLE.test(variable) ||
		typeof repository !== "string" ||
		!REPOSITORY.test(repository) ||
		typeof keyId !== "string" ||
		!KEY_ID.test(keyId) ||
		typeof input.capturePublicKey !== "string"
	)
		throw new Error("Coding value capture context is malformed");
	const captured =
		input.captured === undefined
			? undefined
			: parseClosedRecord(input.captured, "Coding value capture context", ["version"]);
	const context: CaptureContext = {
		secretId: parseUuid(input.secretId, "Coding value secret"),
		version: parseInteger(input.version, "Coding value version", 1, Number.MAX_SAFE_INTEGER),
		service,
		site,
		valuePattern,
		variable,
		repository,
		companyId: parseUuid(input.companyId, "Coding value company"),
		environmentId: parseUuid(input.environmentId, "Coding value environment"),
		keyId,
		receiptId: parseUuid(input.receiptId, "Coding value capture receipt"),
		companyComputerId: parseUuid(input.companyComputerId, "Company Computer"),
		computerGeneration: parseInteger(
			input.computerGeneration,
			"Company Computer generation",
			1,
			Number.MAX_SAFE_INTEGER,
		),
		...(captured === undefined
			? {}
			: {
					captured: {
						version: parseInteger(captured.version, "Coding value version", 1, Number.MAX_SAFE_INTEGER),
					},
				}),
	};
	return input.current === undefined
		? context
		: { ...context, current: parseHeldVersion(input.current, "Coding value capture context") };
}

function refusal(error: unknown): CodingValueRefusal | null {
	const refused = vaultCaptureRefusal(error);
	return refused && { schema: REFUSAL_SCHEMA, ...refused };
}

function captureAnswer(context: CaptureContext, version: number, unchanged: boolean): CodingValueCaptureAnswer {
	return {
		schema: CAPTURE_ANSWER_SCHEMA,
		variable: context.variable,
		repository: context.repository,
		version,
		unchanged,
	};
}

/** The store's answer: this call's version, stored now or by its first attempt. */
function storedVersion(value: unknown, context: CaptureContext): number {
	const input = parseClosedRecord(value, "Coding value capture", [
		"schema",
		"variable",
		"repository",
		"secretId",
		"version",
		"replayed",
	]);
	if (
		input.schema !== STORED_SCHEMA ||
		input.variable !== context.variable ||
		input.repository !== context.repository ||
		input.secretId !== context.secretId ||
		typeof input.replayed !== "boolean"
	)
		throw new Error("Coding value capture is malformed");
	return parseInteger(input.version, "Coding value version", 1, Number.MAX_SAFE_INTEGER);
}

export class CodingValueVault {
	readonly #authority: CodingValueAuthority;
	readonly #keys: CloudSecretKeyring;
	readonly #newId: () => string;
	readonly #now: () => number;
	/** The company key id the database last took: tried first, so a prepare usually asks once. */
	#keyId: string | undefined;

	constructor(options: {
		authority: CodingValueAuthority;
		keys: CloudSecretKeyring;
		newId?: () => string;
		now?: () => number;
	}) {
		this.#authority = options.authority;
		this.#keys = options.keys;
		this.#newId = options.newId ?? randomUUID;
		this.#now = options.now ?? Date.now;
	}

	/**
	 * The value's capture key, before the office reads the page: ready (made, made again or kept), or the database's
	 * refusal. Nothing is stored here: the database keeps the public half of a pair the vault derives. The database
	 * names the company's current key only by taking it, so each key this vault holds is offered in turn (the one it
	 * took last first) until one is taken; one it does not hold leaves the call unconfirmed.
	 */
	async prepare(
		call: CodingValueCaptureCall,
		signal: AbortSignal,
	): Promise<CodingValuePrepareAnswer | CodingValueRefusal> {
		try {
			const target = callTarget(call.envelope);
			const last = this.#keyId;
			const keyIds = [
				...(last && this.#keys.has(last) ? [last] : []),
				...this.#keys.keyIds().filter((keyId) => keyId !== last),
			];
			for (const keyId of keyIds) {
				try {
					return await withCaptureRetries(() => this.#prepare(call, target, keyId, signal), signal);
				} catch (error) {
					const other = vaultCaptureRefusal(error);
					if (other?.code !== "42501" || other.message !== OTHER_KEY) throw error;
					signal.throwIfAborted();
				}
			}
			throw new Error("Coding value key is unavailable");
		} catch (error) {
			const refused = refusal(error);
			if (refused) return refused;
			throw new Error("Coding value capture unconfirmed");
		}
	}

	/** A prepare under one company key: for a new id, then for the id the database names (a value of that name it keeps
	 * already, or the key's reserved id), until it keeps the key. */
	async #prepare(
		call: CodingValueCaptureCall,
		target: CallTarget,
		keyId: string,
		signal: AbortSignal,
	): Promise<CodingValuePrepareAnswer> {
		const derive = (secretId: string) =>
			this.#keys.codingValueCapturePublicKey({
				companyId: target.companyId,
				environmentId: target.environmentId,
				secretId,
				keyId,
			});
		let secretId = this.#newId();
		if (!isUuid(secretId)) throw new Error("Coding value secret id is malformed");
		for (let asked = 1; ; asked += 1) {
			const publicKey = derive(secretId);
			const answer = preparedKey(
				await this.#authority.prepareCodingValueCapture(call, { secretId, keyId, publicKey }, signal),
				target,
				keyId,
			);
			this.#keyId = keyId;
			if (answer.current) {
				// The office seals to the key the database keeps: it must be this vault's own for that id, or the box
				// would never open here.
				if (answer.capturePublicKey !== derive(answer.secretId))
					throw new Error("Coding value capture key differs");
				return { schema: PREPARE_ANSWER_SCHEMA, variable: target.variable, replaced: answer.replaced === true };
			}
			if (asked >= PREPARE_IDS || answer.secretId === secretId)
				throw new Error("Coding value capture key is unsettled");
			secretId = answer.secretId;
		}
	}

	/**
	 * One vault_capture of a coding value: the version the vault holds after it, or the database's refusal. The box
	 * opens only for this call's computer, boot, service and variable; the value is never in an answer, a log or an
	 * error. A call asked again answers what it stored. A store that met another capture of the value (40003) reads
	 * again for the same receipt and box, a few times, never the page.
	 */
	async capture(
		request: CodingValueCaptureRequest,
		signal: AbortSignal,
	): Promise<CodingValueCaptureAnswer | CodingValueRefusal> {
		try {
			return await withCaptureRetries(() => this.#capture(request, signal), signal);
		} catch (error) {
			const refused = refusal(error);
			if (refused) return refused;
			throw new Error("Coding value capture unconfirmed");
		}
	}

	async #capture(request: CodingValueCaptureRequest, signal: AbortSignal): Promise<CodingValueCaptureAnswer> {
		const context = captureContext(await this.#authority.readCodingValueCapture(request, signal));
		try {
			if (context.receiptId !== request.receiptId) throw new Error("Coding value capture context is malformed");
			if (context.captured) return captureAnswer(context, context.captured.version, false);
			const pattern = codingValuePattern(context.valuePattern);
			const { companyId, environmentId, secretId, keyId, service, site } = context;
			return await this.#keys
				.openCodingValueCapture(
					{ companyId, environmentId, secretId, keyId },
					request.box,
					{
						companyId,
						companyComputerId: context.companyComputerId,
						computerGeneration: context.computerGeneration,
						receiptId: context.receiptId,
						service,
						variable: context.variable,
					},
					async (capture) => {
						// The office checked both; the vault checks them again against the database's own.
						if (capture.site !== site) throw vaultRefused("22023", `Values of ${service} are taken from ${site}`);
						const value = capture.value.toString("utf8");
						if (!codingValueMatches(value, pattern))
							throw vaultRefused("22023", `The value read is not a whole key of ${service}`);
						const unchanged =
							context.current !== undefined &&
							(await heldValueIs(this.#keys, context.current, context, VALUE_FIELD, capture.value));
						// Stored when unchanged too: the store records this call's capture and grants the value to the
						// call's repository, which no other call does.
						const encryptedEnvelope = this.#keys.seal(
							{ [VALUE_FIELD]: value },
							{ companyId, environmentId, secretId, version: context.version, keyId },
						);
						try {
							const version = storedVersion(
								await this.#authority.storeCodingValueCapture(
									request,
									{
										secretId,
										version: context.version,
										companyId,
										environmentId,
										keyId,
										encryptedEnvelope,
										envelopeSha256: createHash("sha256").update(encryptedEnvelope).digest("hex"),
									},
									signal,
								),
								context,
							);
							return captureAnswer(context, version, unchanged);
						} finally {
							encryptedEnvelope.fill(0);
						}
					},
					this.#now(),
				)
				.catch((error: unknown) => {
					// Read too long before it reached the vault: nothing was stored.
					if (error instanceof Error && error.message === "Coding value capture expired")
						throw vaultRefused(
							"55000",
							"The value was read too long ago and was not stored; capture it again, or make a new one if the page no longer shows it",
						);
					throw error;
				});
		} finally {
			context.current?.envelope.fill(0);
		}
	}
}
