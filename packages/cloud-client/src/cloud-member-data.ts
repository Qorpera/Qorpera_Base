import { isUuid } from "@qorpera/contracts";
import { cloudFileBytesSha256 } from "./cloud-file-bytes.ts";
import { readBoundedCloudResponse, withCloudDeadline } from "./cloud-request.ts";

/*
 * A member's questions to the company's databases (deploy/first-node/RUNTIME-COMPANY-DATABASES.md §3 and §5): named
 * reads kept as files, `data/<database>/queries/<question>.sql`, asked through the member gateway with the member's own
 * token. The data gateway reads each question's entry as the member, so the member's rights decide. When it does not
 * hold a question's text yet it names the file and its hash (`need`): the file is read here as the member, checked
 * against that hash, and the call is sent once more with it. Every answer is parsed with closed key sets. A watch is
 * held by the gateway until an answer differs from the one the caller holds, or for 20 s. Browser-safe.
 */

export const CLOUD_MEMBER_DATA_DATABASE = /^[a-z][a-z0-9_]{0,39}$/;
export const CLOUD_MEMBER_DATA_QUESTION = /^(?=.{1,60}$)[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** Questions one watch call holds, at most: the gateway's limit. */
export const CLOUD_MEMBER_DATA_WATCHES = 24;
/** A question's file, at most. */
export const CLOUD_MEMBER_DATA_TEXT_BYTES = 16 * 1024;
/** How long the gateway holds a watch call, in seconds, and how long the client waits for it: past the 30 s the member
 * gateway gives the route. */
const WATCH_WAIT_S = 20;
const WATCH_DEADLINE_MS = 35_000;
const QUERY_DEADLINE_MS = 15_000;
/** An answer, at most; a refusal's body, at most. */
const MAX_ANSWER_BYTES = 1024 * 1024;
const MAX_REFUSAL_BYTES = 16 * 1024;
/** Calls sent again with the texts the gateway asked for, at most. */
const NEED_ROUNDS = 2;
const SHA = /^[0-9a-f]{64}$/;
const ETAG = /^[A-Za-z0-9_-]{1,128}$/;

export class CloudMemberDataError extends Error {
	/** The HTTP status that refused the call, or null when no answer did. */
	readonly status: number | null;
	constructor(message: string, status: number | null = null) {
		super(message);
		this.status = status;
	}
}

/** One question with its parameters. */
export interface CloudMemberDataQuestion {
	readonly database: string;
	readonly question: string;
	readonly params: Readonly<Record<string, string | number | boolean | null>>;
}

/** A question with the answer's etag the caller holds. */
export interface CloudMemberDataWatch extends CloudMemberDataQuestion {
	readonly etag: string;
}

/** An answer: rows are arrays in the columns' order. */
export interface CloudMemberDataAnswer {
	readonly columns: readonly string[];
	readonly rows: readonly (readonly unknown[])[];
	readonly more: boolean;
	readonly etag: string;
	readonly asOf: string;
}

export type CloudMemberDataWatchAnswer =
	| { readonly changed: readonly { readonly index: number; readonly answer: CloudMemberDataAnswer }[] }
	| { readonly same: true };

/** A company file's text, read as the member, with the sha256 of its bytes; null when the member may not read it or
 * it is not there or not text. */
export type CloudMemberDataTextReader = (
	path: string,
	maximumBytes: number,
	signal: AbortSignal,
) => Promise<{ readonly text: string; readonly sha256: string } | null>;

function invalid(): never {
	throw new CloudMemberDataError("The company's databases gave an answer this page does not know");
}

/** Exactly `keys`. */
function closed(value: unknown, keys: readonly string[]): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
	const own = Object.keys(value);
	if (own.length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) invalid();
	return value as Record<string, unknown>;
}

export function parseCloudMemberDataAnswer(value: unknown): CloudMemberDataAnswer {
	const answer = closed(value, ["columns", "rows", "more", "etag", "asOf"]);
	const { columns, rows, more, etag, asOf } = answer;
	if (
		!Array.isArray(columns) ||
		columns.some((column) => typeof column !== "string" || column.length > 1024) ||
		!Array.isArray(rows) ||
		rows.some((row) => !Array.isArray(row) || row.length !== columns.length) ||
		typeof more !== "boolean" ||
		typeof etag !== "string" ||
		!ETAG.test(etag) ||
		typeof asOf !== "string" ||
		!Number.isFinite(Date.parse(asOf))
	)
		invalid();
	return { columns: columns as string[], rows: rows as unknown[][], more, etag, asOf };
}

function parseWatchAnswer(value: unknown, count: number): CloudMemberDataWatchAnswer {
	if (value && typeof value === "object" && Object.hasOwn(value, "same")) {
		if (closed(value, ["same"]).same !== true) invalid();
		return { same: true };
	}
	const changed = closed(value, ["changed"]).changed;
	if (!Array.isArray(changed) || changed.length === 0 || changed.length > count) invalid();
	const seen = new Set<number>();
	return {
		changed: changed.map((item) => {
			const one = closed(item, ["index", "answer"]);
			const index = one.index;
			if (
				!Number.isSafeInteger(index) ||
				(index as number) < 0 ||
				(index as number) >= count ||
				seen.has(index as number)
			)
				invalid();
			seen.add(index as number);
			return { index: index as number, answer: parseCloudMemberDataAnswer(one.answer) };
		}),
	};
}

/** The files the gateway asked for, each a question of this call: `{ path, sha256 }`. */
function parseNeed(value: unknown, paths: ReadonlySet<string>): { path: string; sha256: string }[] {
	const need = closed(value, ["need"]).need;
	if (!Array.isArray(need) || need.length === 0 || need.length > CLOUD_MEMBER_DATA_WATCHES) invalid();
	return need.map((item) => {
		const one = closed(item, ["path", "sha256"]);
		if (typeof one.sha256 !== "string" || !SHA.test(one.sha256)) invalid();
		// Only a question's own file of this call is read and sent: never another path the gateway names.
		if (typeof one.path !== "string" || !paths.has(one.path))
			throw new CloudMemberDataError("The company's databases asked for a file that is not this call's question");
		return { path: one.path, sha256: one.sha256 };
	});
}

const isNeed = (value: unknown) => !!value && typeof value === "object" && Object.hasOwn(value, "need");

function origin(value: string): string {
	const url = new URL(value);
	if (
		(url.protocol !== "https:" && !(url.protocol === "http:" && url.hostname === "127.0.0.1")) ||
		url.username ||
		url.password ||
		url.search ||
		url.hash
	)
		throw new CloudMemberDataError("Invalid company data endpoint");
	return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

function checkQuestion(asked: CloudMemberDataQuestion): void {
	if (
		!asked ||
		typeof asked.database !== "string" ||
		!CLOUD_MEMBER_DATA_DATABASE.test(asked.database) ||
		typeof asked.question !== "string" ||
		!CLOUD_MEMBER_DATA_QUESTION.test(asked.question) ||
		!asked.params ||
		typeof asked.params !== "object" ||
		Array.isArray(asked.params)
	)
		throw new CloudMemberDataError("Name a question as <database>/<question>");
}

const pathOf = (asked: CloudMemberDataQuestion) => `data/${asked.database}/queries/${asked.question}.sql`;

export class CloudMemberData {
	readonly #environmentId: string;
	readonly #gateway: string;
	readonly #accessToken: (signal: AbortSignal) => Promise<string>;
	readonly #fetch: typeof fetch;
	readonly #readText: CloudMemberDataTextReader;

	/** `gatewayUrl`: the member gateway, an origin or the URL of the member gateway's function; calls go to
	 * `<gatewayUrl>/v1/company-data/<environmentId>/…`. `readText` reads a question's file as the member. */
	constructor(options: {
		environmentId: string;
		gatewayUrl: string;
		accessToken: (signal: AbortSignal) => Promise<string>;
		readText: CloudMemberDataTextReader;
		fetch?: typeof fetch;
	}) {
		if (!isUuid(options.environmentId)) throw new CloudMemberDataError("Invalid company data configuration");
		this.#environmentId = options.environmentId;
		this.#gateway = origin(options.gatewayUrl);
		this.#accessToken = options.accessToken;
		this.#readText = options.readText;
		this.#fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
	}

	/** One question's answer, with the member's own rights. */
	async query(asked: CloudMemberDataQuestion, signal: AbortSignal): Promise<CloudMemberDataAnswer> {
		checkQuestion(asked);
		const body = { database: asked.database, question: asked.question, params: asked.params };
		return parseCloudMemberDataAnswer(await this.#ask("query", body, [asked], QUERY_DEADLINE_MS, signal));
	}

	/** Held by the gateway until one of the answers differs from the etag the caller holds for it (`changed`, by its
	 * place in `watches`), or for 20 s (`same`). */
	async watch(watches: readonly CloudMemberDataWatch[], signal: AbortSignal): Promise<CloudMemberDataWatchAnswer> {
		if (!Array.isArray(watches) || watches.length < 1 || watches.length > CLOUD_MEMBER_DATA_WATCHES)
			throw new CloudMemberDataError(`A watch holds 1 to ${CLOUD_MEMBER_DATA_WATCHES} questions`);
		for (const watch of watches) {
			checkQuestion(watch);
			if (typeof watch.etag !== "string" || watch.etag.length > 128)
				throw new CloudMemberDataError("A watch holds the answer's etag");
		}
		const body = {
			watches: watches.map((watch) => ({
				database: watch.database,
				question: watch.question,
				params: watch.params,
				etag: watch.etag,
			})),
			wait: WATCH_WAIT_S,
		};
		return parseWatchAnswer(await this.#ask("watch", body, watches, WATCH_DEADLINE_MS, signal), watches.length);
	}

	/** A call, sent again with the texts the gateway asked for, at most NEED_ROUNDS times. */
	async #ask(
		verb: "query" | "watch",
		body: Record<string, unknown>,
		questions: readonly CloudMemberDataQuestion[],
		deadlineMs: number,
		signal: AbortSignal,
	): Promise<unknown> {
		const paths = new Set(questions.map(pathOf));
		const texts: Record<string, string> = {};
		for (let round = 0; ; round++) {
			const answer = await this.#post(
				verb,
				Object.keys(texts).length > 0 ? { ...body, texts } : body,
				deadlineMs,
				signal,
			);
			if (!isNeed(answer)) return answer;
			if (round === NEED_ROUNDS)
				throw new CloudMemberDataError("The company's databases could not take the question's text");
			for (const wanted of parseNeed(answer, paths)) texts[wanted.sha256] = await this.#text(wanted, signal);
		}
	}

	/** A question's file, read as the member, when its bytes are the ones the gateway named. */
	async #text(wanted: { path: string; sha256: string }, signal: AbortSignal): Promise<string> {
		const read = await this.#readText(wanted.path, CLOUD_MEMBER_DATA_TEXT_BYTES, signal);
		signal.throwIfAborted();
		if (read === null) throw new CloudMemberDataError(`${wanted.path} can't be read`);
		const bytes = new TextEncoder().encode(read.text);
		if (bytes.byteLength > CLOUD_MEMBER_DATA_TEXT_BYTES)
			throw new CloudMemberDataError(`${wanted.path} is larger than 16 KiB`);
		// The reader's word and the bytes themselves: both must be the file the gateway named.
		if (read.sha256 !== wanted.sha256 || (await cloudFileBytesSha256(bytes)) !== wanted.sha256)
			throw new CloudMemberDataError(`${wanted.path} changed while it was asked: try again`);
		return read.text;
	}

	async #token(signal: AbortSignal): Promise<string> {
		let token: string;
		try {
			token = await this.#accessToken(signal);
		} catch {
			throw new CloudMemberDataError("Sign in again to ask the company's databases", 401);
		}
		signal.throwIfAborted();
		if (typeof token !== "string" || !/^[A-Za-z0-9._~-]{1,8192}$/.test(token))
			throw new CloudMemberDataError("Sign in again to ask the company's databases", 401);
		return token;
	}

	#post(verb: string, body: Record<string, unknown>, deadlineMs: number, signal: AbortSignal): Promise<unknown> {
		return withCloudDeadline(
			async (requestSignal) => {
				const token = await this.#token(requestSignal);
				const response = await this.#fetch(`${this.#gateway}/v1/company-data/${this.#environmentId}/${verb}`, {
					method: "POST",
					headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
					body: JSON.stringify(body),
					signal: requestSignal,
					redirect: "error",
					credentials: "omit",
				});
				if (response.status !== 200) throw await refusal(response, requestSignal);
				let bytes: Uint8Array;
				try {
					bytes = await readBoundedCloudResponse(response, MAX_ANSWER_BYTES, requestSignal);
				} catch (error) {
					requestSignal.throwIfAborted();
					if (error instanceof Error && /byte limit/.test(error.message))
						throw new CloudMemberDataError("The answer is larger than 1 MiB");
					throw error;
				}
				try {
					return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
				} catch {
					invalid();
				}
			},
			deadlineMs,
			signal,
		);
	}
}

/** A refusal in plain words: the gateway's own for a 4xx, sign in again for a 401. */
async function refusal(response: Response, signal: AbortSignal): Promise<CloudMemberDataError> {
	const status = response.status;
	if (status === 401) {
		void response.body?.cancel().catch(() => undefined);
		return new CloudMemberDataError("Sign in again to ask the company's databases", 401);
	}
	if (status >= 400 && status < 500) {
		try {
			const value = JSON.parse(
				new TextDecoder("utf-8", { fatal: true }).decode(
					await readBoundedCloudResponse(response, MAX_REFUSAL_BYTES, signal),
				),
			) as unknown;
			const error = value && typeof value === "object" ? (value as Record<string, unknown>).error : undefined;
			if (
				typeof error === "string" &&
				error.length > 0 &&
				error.length <= 1000 &&
				!/[\0-\x08\x0b-\x1f\x7f]/.test(error)
			)
				return new CloudMemberDataError(error, status);
		} catch {
			signal.throwIfAborted();
		}
		return new CloudMemberDataError(`The company's databases refused the question (${status})`, status);
	}
	void response.body?.cancel().catch(() => undefined);
	return new CloudMemberDataError(`The company's databases did not answer (${status})`, status);
}
