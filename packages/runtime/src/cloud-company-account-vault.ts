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
import {
	type CompanyAccountPasswordPolicy,
	companyAccountFields,
	generateCompanyAccountPassword,
} from "./cloud-company-accounts.ts";
import { type CloudNativeToolBinding, parseCloudNativeToolBinding } from "./cloud-native-tool-authority.ts";
import type { CloudSecretKeyring } from "./cloud-secret-crypto.ts";

/* Company website accounts in the vault (A1-2; deploy/first-node/RUNTIME-COMPANY-ACCOUNTS.md). The runtime
 * sends one company_account tool call of an agent's run, already begun as an effect receipt; the vault opens
 * an account (a password it makes, sealed under the company's key) or records what the website did. No value
 * ever leaves the vault here: the answer is the account's facts, or the database's refusal in its own words,
 * which the agent can act on ("use it", "an open todo"). Every other failure is the broker's plain refusal. */

export const COMPANY_ACCOUNT_REQUEST_SCHEMA = "qorpera.company-account-request/v1";
const DESCRIPTOR_SCHEMA = "qorpera.company-account/v1";
const REFUSAL_SCHEMA = "qorpera.company-account-refusal/v1";
const CONTEXT_SCHEMA = "qorpera.company-account-context/v1";
const HOST = /^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?)+$/;
const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
/** The database's own refusals an agent can act on; their messages hold no value. The agent reads the
 * message, never a meaning keyed by the code. 55000 is not one: from these calls it only means the
 * company's work is paused, which the runtime retries like any unconfirmed outcome. */
const REFUSALS = new Set(["0A000", "22023", "23505", "54000"]);

/** One company_account tool call as the runtime begun it. */
export interface CompanyAccountCall {
	readonly binding: CloudNativeToolBinding;
	readonly receiptId: string;
	readonly inputSha256: string;
	/** The receipt's downstream idempotency key; the database keeps its SHA-256. */
	readonly idempotencyKey: string;
}

export type CompanyAccountState = "connected" | "needs_person" | "closed";

export type CompanyAccountRequest =
	| (CompanyAccountCall & {
			readonly action: "open";
			readonly site: string;
			readonly signInHosts: readonly string[];
			readonly login: string;
			readonly purpose: string;
			readonly todoId: string;
			readonly password: CompanyAccountPasswordPolicy;
	  })
	| (CompanyAccountCall & {
			readonly action: "state";
			readonly accountId: string;
			readonly status: CompanyAccountState;
	  });

/** An account's facts; never a value. */
export interface CompanyAccountDescriptor {
	readonly schema: typeof DESCRIPTOR_SCHEMA;
	readonly accountId: string;
	readonly site: string;
	readonly signInHosts: readonly string[];
	readonly login: string;
	readonly twoStep: "none" | "authenticator" | "email" | "sms";
	readonly status: "pending" | CompanyAccountState;
	readonly version: number;
}

export interface CompanyAccountRefusal {
	readonly schema: typeof REFUSAL_SCHEMA;
	readonly code: string;
	readonly message: string;
}

export type CompanyAccountAnswer = CompanyAccountDescriptor | CompanyAccountRefusal;

/** What the opening seals into the envelope's associated data and stores beside it. */
export interface CompanyAccountOpening {
	readonly secretId: string;
	readonly companyId: string;
	readonly environmentId: string;
	readonly site: string;
	readonly signInHosts: readonly string[];
	readonly login: string;
	readonly purpose: string;
	readonly todoId: string;
	readonly keyId: string;
	readonly encryptedEnvelope: Uint8Array;
	readonly envelopeSha256: string;
}

/** The broker-role database calls (supabase migration 20260929999700). */
export interface CompanyAccountAuthority {
	describeCompanyAccountOpen(call: CompanyAccountCall, signal: AbortSignal): Promise<unknown>;
	openCompanyAccount(call: CompanyAccountCall, opening: CompanyAccountOpening, signal: AbortSignal): Promise<unknown>;
	setCompanyAccountState(
		call: CompanyAccountCall,
		accountId: string,
		status: CompanyAccountState,
		signal: AbortSignal,
	): Promise<unknown>;
}

function host(value: unknown, label: string): string {
	if (typeof value !== "string" || value.length > 253 || !HOST.test(value)) throw new Error(`${label} is malformed`);
	return value;
}

function hosts(value: unknown): string[] {
	if (!Array.isArray(value) || value.length > 4) throw new Error("Company account sign-in hosts are malformed");
	const parsed = value.map((item) => host(item, "Company account sign-in host"));
	if (new Set(parsed).size !== parsed.length) throw new Error("Company account sign-in hosts are malformed");
	return parsed;
}

function login(value: unknown): string {
	const parsed = parseBoundedText(value, "Company account login", 254);
	if (parsed !== parsed.trim() || /[\0-\x1f\x7f]/.test(parsed)) throw new Error("Company account login is malformed");
	return parsed;
}

function call(input: Record<string, unknown>): CompanyAccountCall {
	return {
		binding: parseCloudNativeToolBinding(input.binding),
		receiptId: parseUuid(input.receiptId, "Company account receipt"),
		inputSha256: parseSha256Hex(input.inputSha256, "Company account input digest"),
		idempotencyKey: parseSha256Hex(input.idempotencyKey, "Company account idempotency key"),
	};
}

/** A company_account request as the runtime sends it; anything else is refused. */
export function parseCompanyAccountRequest(value: unknown): CompanyAccountRequest {
	const input = parseRecord(value, "Company account request");
	if (input.schema !== COMPANY_ACCOUNT_REQUEST_SCHEMA) throw new Error("Company account request is malformed");
	const base = ["schema", "action", "binding", "receiptId", "inputSha256", "idempotencyKey"];
	if (input.action === "open") {
		parseClosedRecord(input, "Company account request", [
			...base,
			"site",
			"signInHosts",
			"login",
			"purpose",
			"todoId",
			"password",
		]);
		const policy = parseClosedRecord(input.password, "Company account password policy", [], ["length", "symbols"]);
		if (policy.symbols !== undefined && typeof policy.symbols !== "boolean")
			throw new Error("Company account password policy is malformed");
		const purpose = parseBoundedText(input.purpose, "Company account reason", 512);
		if (purpose !== purpose.trim()) throw new Error("Company account reason is malformed");
		const site = host(input.site, "Company account website");
		const signInHosts = hosts(input.signInHosts);
		if (signInHosts.includes(site)) throw new Error("Company account sign-in hosts are malformed");
		return {
			...call(input),
			action: "open",
			site,
			signInHosts,
			login: login(input.login),
			purpose,
			todoId: parseUuid(input.todoId, "Company account todo"),
			password: {
				...(policy.length === undefined
					? {}
					: { length: parseInteger(policy.length, "Company account password length", 12, 64) }),
				...(policy.symbols === undefined ? {} : { symbols: policy.symbols as boolean }),
			},
		};
	}
	if (input.action === "state") {
		parseClosedRecord(input, "Company account request", [...base, "accountId", "status"]);
		if (input.status !== "connected" && input.status !== "needs_person" && input.status !== "closed")
			throw new Error("Company account status is malformed");
		return {
			...call(input),
			action: "state",
			accountId: parseUuid(input.accountId, "Company account"),
			status: input.status,
		};
	}
	throw new Error("Company account request is malformed");
}

/** The vault's answer, as the runtime reads it: an account's facts or a refusal, nothing else. */
export function parseCompanyAccountAnswer(value: unknown): CompanyAccountAnswer {
	const input = parseRecord(value, "Company account answer");
	if (input.schema === REFUSAL_SCHEMA) {
		parseClosedRecord(input, "Company account refusal", ["schema", "code", "message"]);
		if (typeof input.code !== "string" || !REFUSALS.has(input.code))
			throw new Error("Company account refusal is malformed");
		return {
			schema: REFUSAL_SCHEMA,
			code: input.code,
			message: parseBoundedText(input.message, "Company account refusal", 512),
		};
	}
	parseClosedRecord(input, "Company account", [
		"schema",
		"accountId",
		"site",
		"signInHosts",
		"login",
		"twoStep",
		"status",
		"version",
	]);
	if (input.schema !== DESCRIPTOR_SCHEMA) throw new Error("Company account is malformed");
	if (!["none", "authenticator", "email", "sms"].includes(input.twoStep as string))
		throw new Error("Company account two-step is malformed");
	if (!["pending", "connected", "needs_person", "closed"].includes(input.status as string))
		throw new Error("Company account status is malformed");
	return {
		schema: DESCRIPTOR_SCHEMA,
		accountId: parseUuid(input.accountId, "Company account"),
		site: host(input.site, "Company account website"),
		signInHosts: hosts(input.signInHosts),
		// The login as the database keeps it; requests are checked more strictly than answers.
		login: parseBoundedText(input.login, "Company account login", 254),
		twoStep: input.twoStep as CompanyAccountDescriptor["twoStep"],
		status: input.status as CompanyAccountDescriptor["status"],
		version: parseInteger(input.version, "Company account version", 1, Number.MAX_SAFE_INTEGER),
	};
}

function refusal(error: unknown): CompanyAccountRefusal | null {
	if (!error || typeof error !== "object") return null;
	const { code, message } = error as { code?: unknown; message?: unknown };
	if (typeof code !== "string" || !REFUSALS.has(code) || typeof message !== "string") return null;
	return { schema: REFUSAL_SCHEMA, code, message: message.slice(0, 512) };
}

export class CompanyAccountVault {
	readonly #authority: CompanyAccountAuthority;
	readonly #keys: CloudSecretKeyring;
	readonly #random: (bytes: number) => Uint8Array;
	readonly #newId: () => string;

	constructor(options: {
		authority: CompanyAccountAuthority;
		keys: CloudSecretKeyring;
		random?: (bytes: number) => Uint8Array;
		newId?: () => string;
	}) {
		this.#authority = options.authority;
		this.#keys = options.keys;
		this.#random = options.random ?? ((bytes) => randomBytes(bytes));
		this.#newId = options.newId ?? randomUUID;
	}

	/** One company_account call: the account's facts, or the database's refusal an agent can act on. */
	async handle(request: CompanyAccountRequest, signal: AbortSignal): Promise<CompanyAccountAnswer> {
		try {
			if (request.action === "state")
				return parseCompanyAccountAnswer(
					await this.#authority.setCompanyAccountState(request, request.accountId, request.status, signal),
				);
			return await this.#open(request, signal);
		} catch (error) {
			const refused = refusal(error);
			if (refused) return refused;
			throw new Error("Company account outcome unconfirmed");
		}
	}

	async #open(request: Extract<CompanyAccountRequest, { action: "open" }>, signal: AbortSignal) {
		// The run's company, environment and the company's key: the envelope's associated data needs them first.
		const context = parseClosedRecord(
			await this.#authority.describeCompanyAccountOpen(request, signal),
			"Company account context",
			["schema", "companyId", "environmentId", "keyId"],
		);
		if (context.schema !== CONTEXT_SCHEMA || typeof context.keyId !== "string" || !KEY_ID.test(context.keyId))
			throw new Error("Company account context is malformed");
		const keyId = context.keyId;
		if (!this.#keys.has(keyId)) throw new Error("Company account key is unavailable");
		const companyId = parseUuid(context.companyId, "Company account company");
		const environmentId = parseUuid(context.environmentId, "Company account environment");
		const secretId = this.#newId();
		if (!isUuid(secretId)) throw new Error("Company account id is malformed");
		const fields = companyAccountFields({ password: generateCompanyAccountPassword(request.password, this.#random) });
		const encryptedEnvelope = this.#keys.seal(fields, { companyId, environmentId, secretId, version: 1, keyId });
		try {
			const answer = parseCompanyAccountAnswer(
				await this.#authority.openCompanyAccount(
					request,
					{
						secretId,
						companyId,
						environmentId,
						site: request.site,
						signInHosts: request.signInHosts,
						login: request.login,
						purpose: request.purpose,
						todoId: request.todoId,
						keyId,
						encryptedEnvelope,
						envelopeSha256: createHash("sha256").update(encryptedEnvelope).digest("hex"),
					},
					signal,
				),
			);
			// A repeat of the same tool call answers the account its first attempt opened; this attempt's
			// envelope was never stored and goes with the buffer below.
			return answer;
		} finally {
			encryptedEnvelope.fill(0);
		}
	}
}
