import type { IncomingMessage } from "node:http";
import { Readable } from "node:stream";
import { readBoundedCloudResponse } from "../../packages/cloud-client/src/cloud-request.ts";
import {
	CODE_IMPORT_CONNECT_MS,
	CODE_IMPORT_HEADERS_MS,
	CODE_IMPORT_IDLE_MS,
	type CodeImportAnswer,
	type CodeImportTransport,
	type CodeImportTransports,
	CodeImportStop,
	codeImportGitHubOf,
} from "../../packages/runner-orchestrator/src/code-import.ts";
import {
	CLOUD_SECRET_RELAY_TRANSPORT,
	type CloudSecretRelayTransport,
	openCloudSecretRelay,
} from "../../packages/runtime/src/cloud-secret-broker-relay.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OWNER = /^[A-Za-z0-9_.:-]{1,120}$/;
/** The executor's own broker token: 32 random bytes, base64url (as `repository-credentials.ts`). */
const EXECUTOR_TOKEN = /^[A-Za-z0-9_-]{43}$/;
/** The relay's own refusal is one small JSON (`qorpera.cloud-secret-error/v1`). */
const RELAY_ERROR_BYTES = 4096;
const RELAY_ERROR_WORD = /^[a-z][a-z_]{0,63}$/;
/** How long the broker may take to the answer's headers: the executor's connect to it, the kernel's check (10 s,
 * `cloud-secret-broker-http.ts`), and the relay's own connect (10 s) and headers (30 s) to GitHub. */
const BROKER_ANSWER_MS = CODE_IMPORT_CONNECT_MS + 10_000 + CODE_IMPORT_CONNECT_MS + CODE_IMPORT_HEADERS_MS;
const GITHUB = "https://github.com";
const USER_AGENT = "qorpera-coding-executor";
const REQUEST_TYPE = "application/x-git-upload-pack-request";
const RESULT_TYPE = "application/x-git-upload-pack-result";

/** An answer's type without its parameters, lower case; null when it has none. */
function typeOf(value: string | string[] | null | undefined): string | null {
	if (typeof value !== "string") return null;
	const type = value.split(";", 1)[0]?.trim().toLowerCase();
	return type ? type : null;
}

/** A fetch answer's body, read as it is taken: a read that fails is a cut, with no word of the answer's. When its reader
 * stops before the end, the request ends. */
async function* responseBody(response: Response, call: AbortController): AsyncGenerator<Uint8Array, void, undefined> {
	const reader = response.body?.getReader();
	if (!reader) return;
	let ended = false;
	try {
		for (;;) {
			let next: Awaited<ReturnType<typeof reader.read>>;
			try {
				next = await reader.read();
			} catch {
				throw new Error("CODE_IMPORT_TRANSFER_CUT");
			}
			if (next.done) {
				ended = true;
				return;
			}
			yield next.value;
		}
	} finally {
		if (!ended) {
			call.abort();
			void reader.cancel().catch(() => undefined);
		}
	}
}

/** The same for an answer the relay's connection gave. */
async function* messageBody(answer: IncomingMessage): AsyncGenerator<Uint8Array, void, undefined> {
	const pieces = answer[Symbol.asyncIterator]();
	let ended = false;
	try {
		for (;;) {
			let next: IteratorResult<Buffer>;
			try {
				next = await pieces.next();
			} catch {
				throw new Error("CODE_IMPORT_TRANSFER_CUT");
			}
			if (next.done) {
				ended = true;
				return;
			}
			yield next.value;
		}
	} finally {
		if (!ended) answer.destroy();
	}
}

/**
 * An import's fetch through the company's GitHub connection (own code storage, step 6): the secret broker's relay
 * (5j-6b), `GET <origin>/v1/coding-repository-fetch/refs?company=<id>` and `POST …/upload-pack?company=<id>`, with the
 * executor's own broker token and the import named in the headers as a session's turn is (`x-qorpera-coding-worker`
 * the request's id, `-lease` its lease token, `-executor` this executor's owner, `-repository` the GitHub
 * `Owner/Name`). The broker asks the kernel (`qorpera_authorize_code_import_fetch` for a request id), adds GitHub's
 * header and streams GitHub's answer back: the token never reaches the executor. Redirects are errors, never followed.
 *
 * The answers: GitHub's own (its status and type, the body streamed), or the relay's own refusal, the small JSON of
 * `qorpera.cloud-secret-error/v1` (403 refused or not now, 503 busy, 404 not routed), read and closed here. What they
 * end in is part C1's (`codeImportAnswerStop`, `codeImportRelayRefusals`). A request that fails, or whose answer's
 * headers do not come within a minute, rejects with a fixed code and nothing of the request or the answer: never the
 * executor's token, never a body. `public` fetches a public project straight from github.com
 * (`publicGitHubTransport`), with no credential.
 */
export class BrokerRepositoryFetch implements CodeImportTransports {
	readonly #origin: string;
	readonly #executorToken: string;
	readonly #owner: string;
	readonly #fetch: typeof fetch;
	readonly #relay: CloudSecretRelayTransport | undefined;
	readonly #answerMs: number;
	constructor(options: {
		origin: string;
		executorToken: string;
		executorOwner: string;
		fetch?: typeof fetch;
		/** For `public` only (tests): the relay's connection to github.com. */
		relay?: CloudSecretRelayTransport;
		/** How long the broker may take to an answer's headers (tests); a minute by default, at most that. */
		answerMs?: number;
	}) {
		const url = new URL(options.origin);
		const answerMs = options.answerMs ?? BROKER_ANSWER_MS;
		if (
			url.protocol !== "https:" ||
			url.username ||
			url.password ||
			url.pathname !== "/" ||
			url.search ||
			url.hash ||
			!EXECUTOR_TOKEN.test(options.executorToken) ||
			!OWNER.test(options.executorOwner) ||
			!Number.isSafeInteger(answerMs) ||
			answerMs < 1 ||
			answerMs > BROKER_ANSWER_MS
		)
			throw new Error("CODING_REPOSITORY_BROKER_CONFIG_INVALID");
		this.#origin = url.origin;
		this.#executorToken = options.executorToken;
		this.#owner = options.executorOwner;
		this.#fetch = options.fetch ?? fetch;
		this.#relay = options.relay;
		this.#answerMs = answerMs;
	}

	connection(
		scope: { companyId: string; requestId: string; leaseToken: string },
		repository: { owner: string; name: string },
	): CodeImportTransport {
		if (![scope?.companyId, scope?.requestId, scope?.leaseToken].every((id) => typeof id === "string" && UUID.test(id)))
			throw new Error("CODE_IMPORT_FETCH_SCOPE_INVALID");
		const { owner, name } = codeImportGitHubOf(`${repository?.owner}/${repository?.name}`);
		const route = (path: string) =>
			`${this.#origin}/v1/coding-repository-fetch/${path}?company=${scope.companyId.toLowerCase()}`;
		const headers = {
			authorization: `Bearer ${this.#executorToken}`,
			"x-qorpera-coding-worker": scope.requestId.toLowerCase(),
			"x-qorpera-coding-lease": scope.leaseToken.toLowerCase(),
			"x-qorpera-coding-executor": this.#owner,
			"x-qorpera-coding-repository": `${owner}/${name}`,
			"git-protocol": "version=2",
		};
		return Object.freeze({
			refs: (signal: AbortSignal) => this.#ask(route("refs"), "GET", headers, undefined, signal),
			uploadPack: (body: Uint8Array, signal: AbortSignal) =>
				this.#ask(
					route("upload-pack"),
					"POST",
					{ ...headers, "content-type": REQUEST_TYPE, accept: RESULT_TYPE },
					body,
					signal,
				),
		});
	}

	public(repository: { owner: string; name: string }): CodeImportTransport {
		return publicGitHubTransport(repository, this.#relay ? { relay: this.#relay } : {});
	}

	async #ask(
		url: string,
		method: "GET" | "POST",
		headers: Record<string, string>,
		body: Uint8Array | undefined,
		signal: AbortSignal,
	): Promise<CodeImportAnswer> {
		// The request's own end: the caller's signal, or no headers within the broker's time (that bound ends with them).
		const call = new AbortController();
		const end = () => call.abort();
		signal.addEventListener("abort", end, { once: true });
		if (signal.aborted) end();
		const timer = setTimeout(end, this.#answerMs);
		let response: Response;
		try {
			response = await this.#fetch(url, {
				method,
				redirect: "error",
				headers,
				...(body === undefined ? {} : { body }),
				signal: call.signal,
			});
		} catch {
			throw new Error("CODE_IMPORT_RELAY_UNREACHED");
		} finally {
			clearTimeout(timer);
		}
		const status = response.status;
		const contentType = typeOf(response.headers.get("content-type"));
		if (status === 200 || contentType !== "application/json")
			return { by: "source", status, contentType, body: responseBody(response, call) };
		// A JSON refusal: the relay's own, when it is exactly one; GitHub's never comes so, and is passed on unread.
		let error: string | null | undefined;
		try {
			const value = JSON.parse(
				new TextDecoder("utf-8", { fatal: true }).decode(
					await readBoundedCloudResponse(response, RELAY_ERROR_BYTES, call.signal),
				),
			) as unknown;
			if (
				value !== null &&
				typeof value === "object" &&
				!Array.isArray(value) &&
				Object.keys(value).sort().join() === "error,schema" &&
				(value as { schema: unknown }).schema === "qorpera.cloud-secret-error/v1"
			) {
				const word = (value as { error: unknown }).error;
				error = typeof word === "string" && RELAY_ERROR_WORD.test(word) ? word : null;
			}
		} catch {
			// Not the relay's.
		}
		call.abort();
		if (error !== undefined) return { by: "relay", status, error };
		return { by: "source", status, contentType, body: (async function* () {})() };
	}
}

/**
 * A public project's fetch, straight from `https://github.com/<Owner>/<Name>.git` with no credential, under the relay's
 * own rules (`openCloudSecretRelay`): github.com resolved once and refused unless every address is public, TLS
 * verified for github.com, no redirect followed (a 3xx is GitHub's answer, `IMPORT_SOURCE_MOVED`), 10 s to connect,
 * 30 s more to the headers, and the connection ended after `idleMs` (2 minutes) with no byte either way. One
 * connection a request. An answer with a content encoding is `IMPORT_SOURCE_PROTOCOL`; any other failure rejects with a
 * fixed code and nothing of the answer.
 */
export function publicGitHubTransport(
	repository: { owner: string; name: string },
	options: { relay?: CloudSecretRelayTransport; idleMs?: number } = {},
): CodeImportTransport {
	const { owner, name } = codeImportGitHubOf(`${repository?.owner}/${repository?.name}`);
	const relay = options.relay ?? CLOUD_SECRET_RELAY_TRANSPORT;
	const idleMs = options.idleMs ?? CODE_IMPORT_IDLE_MS;
	if (!Number.isSafeInteger(idleMs) || idleMs < 1 || idleMs > CODE_IMPORT_IDLE_MS)
		throw new Error("CODE_IMPORT_FETCH_IDLE_INVALID");
	const ask = async (
		method: "GET" | "POST",
		path: string,
		headers: Record<string, string>,
		body: Uint8Array | undefined,
		signal: AbortSignal,
	): Promise<CodeImportAnswer> => {
		let answer: IncomingMessage;
		try {
			answer = await openCloudSecretRelay(
				relay,
				{
					origin: GITHUB,
					method,
					path: `/${owner}/${name}.git${path}`,
					headers: { ...headers, "git-protocol": "version=2", "user-agent": USER_AGENT },
					...(body === undefined ? {} : { body: Readable.from([Buffer.from(body)], { objectMode: false }) }),
					idleMs,
				},
				signal,
			);
		} catch {
			throw new Error("CODE_IMPORT_SOURCE_UNREACHED");
		}
		const encoding = answer.headers["content-encoding"];
		if (encoding !== undefined && encoding !== "identity") {
			answer.destroy();
			throw new CodeImportStop("failed", "IMPORT_SOURCE_PROTOCOL");
		}
		return {
			by: "source",
			status: answer.statusCode ?? 0,
			contentType: typeOf(answer.headers["content-type"]),
			body: messageBody(answer),
		};
	};
	return Object.freeze({
		refs: (signal: AbortSignal) => ask("GET", "/info/refs?service=git-upload-pack", {}, undefined, signal),
		uploadPack: (body: Uint8Array, signal: AbortSignal) =>
			ask(
				"POST",
				"/git-upload-pack",
				{ "content-type": REQUEST_TYPE, accept: RESULT_TYPE, "content-length": String(body.byteLength) },
				body,
				signal,
			),
	});
}
