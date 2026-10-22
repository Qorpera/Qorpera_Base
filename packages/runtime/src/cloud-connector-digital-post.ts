import { createPrivateKey, X509Certificate } from "node:crypto";
import { request as httpsRequest } from "node:https";
import { POSTGRES_UUID_PATTERN as UUID_PATTERN } from "@qorpera/contracts";
import { ConnectorRequestError, decodeUtf8 } from "./cloud-connector-http.ts";
import { DIGITAL_POST_LETTER_MAX_BYTES } from "./digital-post-memo.ts";

/**
 * The Digital Post client the company vault uses for a company's Digital Post connection: the company's public post
 * (Skattestyrelsen, Erhvervsstyrelsen, the municipality, ...) fetched from Digital Post's recipient system API
 * (Technical Integration v1.51, sections 2.6.1, 10.6.2 and 12.4).
 *
 * Qorpera is the company's system supplier. A member with Digital Post's system administrator right sets up a
 * recipient system for the company in Administrativ Adgang, with the REST PULL protocol, the vault's IP addresses, and
 * Qorpera's CVR as the supplier with power of attorney ("Giv din systemleverandør fuldmagt"). Digital Post then shows
 * the system's API key, which the member saves in the company vault. Every call carries Qorpera's own OCES3
 * certificate (mutual TLS) and that company's key: Digital Post finds the company's system by the key and checks that
 * the certificate's CVR is the system's supplier and that the call comes from a listed address.
 *
 * Letters are read only. A letter Digital Post hands over is the company's only copy once it is receipted (Digital
 * Post deletes it then), so the caller receipts a letter only after it is kept. A letter never receipted is offered
 * again, and after seven days goes to the company's mailbox on Virk.
 *
 * The certificate's key lives only in the vault's systemd credential; a company's API key is sealed like any other
 * company credential and is opened only for a pass. Nothing here logs a key or a letter.
 */

export type DigitalPostEnvironment = "test" | "production";

export const DIGITAL_POST_ORIGINS: Readonly<Record<DigitalPostEnvironment, string>> = Object.freeze({
	test: "https://api.test.digitalpost.dk",
	production: "https://api.digitalpost.dk",
});

/** Letters asked for in one list call; a pass takes at most this many, and the next pass the rest. */
export const DIGITAL_POST_LIST_SIZE = 50;
const LIST_MAX_BYTES = 256 * 1024;
const LIST_DEADLINE_MS = 30_000;
const LETTER_DEADLINE_MS = 3 * 60_000;
const RECEIPT_DEADLINE_MS = 30_000;

/** Qorpera as Digital Post's system supplier: its OCES3 organisation or system certificate. */
export interface DigitalPostApp {
	readonly environment: DigitalPostEnvironment;
	/** The certificate (PEM), the leaf first; intermediate certificates may follow. */
	readonly certificatePem: string;
	readonly privateKeyPem: string;
}

/** A company's recipient system: its id, and the header Digital Post finds it by. */
export interface DigitalPostKey {
	readonly systemId: string;
	readonly authorization: string;
}

/** The key was refused (401): the system was removed or deactivated, or its key replaced. The member connects again. */
export class DigitalPostKeyRefused extends Error {
	constructor() {
		super("Digital Post refused the company's key.");
		this.name = "DigitalPostKeyRefused";
	}
}

/** The text is not a Digital Post API key. */
export class DigitalPostKeyInvalid extends Error {
	constructor() {
		super("This is not a Digital Post API key.");
		this.name = "DigitalPostKeyInvalid";
	}
}

/**
 * Reads the API key as Administrativ Adgang shows it: the Basic credential of the system's id and its key's value,
 * base64-encoded (Technical Integration 2.6.1, "API key"). A leading `Basic ` and whitespace are allowed.
 */
export function parseDigitalPostKey(text: string): DigitalPostKey {
	const compact = text.replace(/^\s*Basic\s+/i, "").replace(/\s+/g, "");
	if (
		compact.length < 8 ||
		compact.length > 1024 ||
		compact.length % 4 !== 0 ||
		!/^[A-Za-z0-9+/]+={0,2}$/.test(compact)
	)
		throw new DigitalPostKeyInvalid();
	const decoded = Buffer.from(compact, "base64").toString("utf8");
	const colon = decoded.indexOf(":");
	const systemId = decoded.slice(0, colon).toLowerCase();
	const value = decoded.slice(colon + 1);
	if (colon < 0 || !UUID_PATTERN.test(systemId) || !/^[\x21-\x7e]{8,512}$/.test(value))
		throw new DigitalPostKeyInvalid();
	return Object.freeze({
		systemId,
		authorization: `Basic ${Buffer.from(`${systemId}:${value}`, "utf8").toString("base64")}`,
	});
}

/** Checks Qorpera's certificate and key once, when the vault reads its configuration. Never the key's text in an error. */
export function parseDigitalPostApp(value: unknown): DigitalPostApp | undefined {
	if (value === undefined) return undefined;
	const input = value as Record<string, unknown>;
	if (
		!input ||
		typeof input !== "object" ||
		Array.isArray(input) ||
		Object.keys(input).sort().join() !== "certificatePem,environment,privateKeyPem" ||
		(input.environment !== "test" && input.environment !== "production") ||
		typeof input.certificatePem !== "string" ||
		input.certificatePem.length > 65_536 ||
		typeof input.privateKeyPem !== "string" ||
		input.privateKeyPem.length > 16_384
	)
		throw new Error("Digital Post certificate is invalid");
	let matches = false;
	try {
		matches = new X509Certificate(input.certificatePem).checkPrivateKey(createPrivateKey(input.privateKeyPem));
	} catch {
		matches = false;
	}
	if (!matches) throw new Error("Digital Post certificate is invalid");
	return Object.freeze({
		environment: input.environment,
		certificatePem: input.certificatePem,
		privateKeyPem: input.privateKeyPem,
	});
}

export interface DigitalPostRequest {
	readonly method: "GET" | "POST";
	/** The path and query under the API's origin. */
	readonly path: string;
	readonly headers: Readonly<Record<string, string>>;
	readonly body?: Uint8Array;
}

export interface DigitalPostAnswer {
	readonly status: number;
	readonly body: Uint8Array;
}

/** One request to Digital Post. Tests give their own. */
export type DigitalPostTransport = (
	request: DigitalPostRequest,
	maximumBytes: number,
	deadlineMs: number,
	signal: AbortSignal,
) => Promise<DigitalPostAnswer>;

/** HTTPS to the environment's API origin with the certificate presented (mutual TLS), never pooled, never
 * redirected, the answer bounded in bytes and time. `target` is for tests: another host, port and trusted CA. */
export function digitalPostTransport(
	app: DigitalPostApp,
	target?: { readonly host: string; readonly port: number; readonly ca: string },
): DigitalPostTransport {
	const host = target?.host ?? new URL(DIGITAL_POST_ORIGINS[app.environment]).hostname;
	return (request, maximumBytes, deadlineMs, signal) =>
		new Promise((resolve, reject) => {
			const stop = AbortSignal.any([signal, AbortSignal.timeout(deadlineMs)]);
			if (stop.aborted) return reject(new Error("Digital Post request ended"));
			const body = request.body ? Buffer.from(request.body) : undefined;
			const outgoing = httpsRequest(
				{
					host,
					port: target?.port ?? 443,
					servername: host,
					...(target ? { ca: target.ca } : {}),
					method: request.method,
					path: request.path,
					headers: { ...request.headers, ...(body ? { "content-length": String(body.byteLength) } : {}) },
					cert: app.certificatePem,
					key: app.privateKeyPem,
					minVersion: "TLSv1.2",
					agent: false,
				},
				(response) => {
					const chunks: Buffer[] = [];
					let bytes = 0;
					response.on("data", (chunk: Buffer) => {
						bytes += chunk.byteLength;
						if (bytes > maximumBytes) response.destroy(new Error("Digital Post answer is too large"));
						else chunks.push(chunk);
					});
					response.once("error", reject);
					response.once("end", () =>
						resolve({ status: response.statusCode ?? 0, body: new Uint8Array(Buffer.concat(chunks, bytes)) }),
					);
				},
			);
			const end = (): void => {
				outgoing.destroy(new Error("Digital Post request ended"));
			};
			stop.addEventListener("abort", end, { once: true });
			outgoing.once("close", () => stop.removeEventListener("abort", end));
			outgoing.once("error", reject);
			outgoing.end(body);
		});
}

function refusal(status: number): Error {
	if (status === 401) return new DigitalPostKeyRefused();
	if (status === 403)
		return new ConnectorRequestError(
			"forbidden",
			"Digital Post refused the call: the system's IP addresses or its supplier (Qorpera's CVR) do not match.",
		);
	if (status === 404) return new ConnectorRequestError("not_found", "Digital Post has no such letter.");
	if (status === 429) return new ConnectorRequestError("rate_limited", "Digital Post asked us to wait.");
	if (status === 400 || status === 409 || status === 422)
		return new ConnectorRequestError("invalid_request", `Digital Post refused the request (${status}).`);
	return new ConnectorRequestError("provider_error", `Digital Post answered ${status}.`);
}

/** The answer of a list call: the letters waiting, and whether that is all of them. */
export interface DigitalPostAvailable {
	readonly ids: readonly string[];
	readonly complete: boolean;
}

export class DigitalPostClient {
	readonly #transport: DigitalPostTransport;

	constructor(app: DigitalPostApp, transport: DigitalPostTransport = digitalPostTransport(app)) {
		this.#transport = transport;
	}

	/** The letters waiting for the company's system (`GET /apis/v1/memos/`), at most `DIGITAL_POST_LIST_SIZE`. */
	async available(key: DigitalPostKey, signal: AbortSignal): Promise<DigitalPostAvailable> {
		const answer = await this.#transport(
			{
				method: "GET",
				path: `/apis/v1/memos/?page=0&size=${DIGITAL_POST_LIST_SIZE}`,
				headers: { accept: "application/json", authorization: key.authorization },
			},
			LIST_MAX_BYTES,
			LIST_DEADLINE_MS,
			signal,
		);
		if (answer.status !== 200) throw refusal(answer.status);
		let page: Record<string, unknown>;
		try {
			page = JSON.parse(decodeUtf8(answer.body)) as Record<string, unknown>;
		} catch {
			throw new ConnectorRequestError("provider_error", "Digital Post's letter list is not JSON.");
		}
		const content = page && typeof page === "object" ? page.content : undefined;
		if (
			!Array.isArray(content) ||
			content.length > DIGITAL_POST_LIST_SIZE ||
			content.some((id) => typeof id !== "string" || !UUID_PATTERN.test(id.toLowerCase()))
		)
			throw new ConnectorRequestError("provider_error", "Digital Post's letter list is not readable.");
		const ids = [...new Set((content as string[]).map((id) => id.toLowerCase()))];
		const totalPages = page.totalPages;
		const complete =
			content.length < DIGITAL_POST_LIST_SIZE ||
			(typeof totalPages === "number" && Number.isSafeInteger(totalPages) && totalPages <= 1);
		return { ids, complete };
	}

	/** One letter's MeMo XML (`GET /apis/v1/memos/{id}`); null when Digital Post no longer has it. */
	async letter(key: DigitalPostKey, id: string, signal: AbortSignal): Promise<Uint8Array | null> {
		if (!UUID_PATTERN.test(id)) throw new Error("Digital Post letter id is invalid");
		const answer = await this.#transport(
			{
				method: "GET",
				path: `/apis/v1/memos/${id}`,
				headers: { accept: "application/xml", authorization: key.authorization },
			},
			DIGITAL_POST_LETTER_MAX_BYTES,
			LETTER_DEADLINE_MS,
			signal,
		);
		if (answer.status === 404) return null;
		if (answer.status !== 200) throw refusal(answer.status);
		return answer.body;
	}

	/**
	 * The business receipt that tells Digital Post the letter is kept (`POST /apis/v1/memos/{id}/receipt`): Digital Post
	 * deletes it then. A letter Digital Post no longer has (404) was receipted before or moved to Virk; either way it is
	 * settled. Digital Post judges a receipt by its empty error message, never by its status.
	 */
	async receipt(
		key: DigitalPostKey,
		id: string,
		messageUuid: string,
		now: Date,
		signal: AbortSignal,
	): Promise<"receipted" | "gone"> {
		if (!UUID_PATTERN.test(id) || !UUID_PATTERN.test(messageUuid))
			throw new Error("Digital Post letter id is invalid");
		const answer = await this.#transport(
			{
				method: "POST",
				path: `/apis/v1/memos/${id}/receipt`,
				headers: {
					accept: "application/json",
					"content-type": "application/json",
					authorization: key.authorization,
				},
				body: Buffer.from(
					JSON.stringify({ messageUUID: messageUuid, receiptStatus: "COMPLETED", timeStamp: now.toISOString() }),
					"utf8",
				),
			},
			64 * 1024,
			RECEIPT_DEADLINE_MS,
			signal,
		);
		if (answer.status === 404) return "gone";
		if (answer.status < 200 || answer.status > 299) throw refusal(answer.status);
		return "receipted";
	}
}
