import { timingSafeEqual } from "node:crypto";
import { chmod, rm } from "node:fs/promises";
import { createServer, request as httpRequest, type IncomingMessage, type Server } from "node:http";
import { isAbsolute, resolve } from "node:path";
import { CODEX_RENEWAL_BUDGET_MS } from "./cloud-model-login-budget.ts";
import type { ModelLoginSignInHelper, ModelLoginSignInState } from "./cloud-model-login-sign-in.ts";
import type { ModelLoginRenewal, ModelLoginRenewer } from "./cloud-model-login-vault.ts";

/**
 * The vault's login helper: a separate process beside the cloud secret broker that runs the
 * official Codex for the vault: renewal, and a member's sign-in. The broker keeps the key that
 * opens a login; the helper sees a login only for one operation (a sign-in: until the broker
 * has read it) and keeps nothing.
 *
 * Broker and helper talk over a Unix socket that only their two service accounts can reach,
 * with a bearer token as well. There is no network listener.
 */

const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const MAX_REQUEST_BYTES = 48 * 1024;
const MAX_RESPONSE_BYTES = 48 * 1024;
const REASON = /^[a-z][a-z0-9_]{0,63}$/;
/** The helper answers inside this, and the broker waits a little longer: both stay well inside
 * the vault's 35 s renewal budget, so a renewal the provider made is never answered too late. */
const HELPER_ANSWER_MS = CODEX_RENEWAL_BUDGET_MS + 3_000;
const CLIENT_WAIT_MS = HELPER_ANSWER_MS + 2_000;
/** A sign-in answer waits at most this long for Codex's link and code; the broker's caller (the
 * member's browser, through the edge function's 30 s budget) asks again. */
const SIGN_IN_ANSWER_MS = 15_000;
const SIGN_IN_CLIENT_WAIT_MS = SIGN_IN_ANSWER_MS + 3_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function tokenMatches(expected: string, authorization: string | undefined): boolean {
	if (!authorization?.startsWith("Bearer ")) return false;
	const left = Buffer.from(expected, "utf8");
	const right = Buffer.from(authorization.slice("Bearer ".length), "utf8");
	return left.byteLength === right.byteLength && timingSafeEqual(left, right);
}

async function readBody(request: IncomingMessage): Promise<unknown> {
	const chunks: Buffer[] = [];
	let total = 0;
	for await (const chunk of request) {
		total += (chunk as Buffer).byteLength;
		if (total > MAX_REQUEST_BYTES) throw new Error("Login helper request is too large");
		chunks.push(chunk as Buffer);
	}
	const body = Buffer.concat(chunks);
	try {
		return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
	} finally {
		body.fill(0);
		for (const chunk of chunks) chunk.fill(0);
	}
}

function parseRenewalRequest(value: unknown): string {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Login helper request is invalid");
	const input = value as Record<string, unknown>;
	if (
		Object.keys(input).sort().join() !== "authJson,schema" ||
		input.schema !== "qorpera.model-login-renewal-request/v1" ||
		typeof input.authJson !== "string" ||
		input.authJson.length < 2
	)
		throw new Error("Login helper request is invalid");
	return input.authJson;
}

function parseSignInRequest(value: unknown): { signInId: string; expiresAt: string } {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Login helper request is invalid");
	const input = value as Record<string, unknown>;
	if (
		Object.keys(input).sort().join() !== "expiresAt,schema,signInId" ||
		input.schema !== "qorpera.model-login-sign-in-request/v1" ||
		typeof input.signInId !== "string" ||
		!UUID.test(input.signInId) ||
		typeof input.expiresAt !== "string" ||
		!Number.isFinite(Date.parse(input.expiresAt))
	)
		throw new Error("Login helper request is invalid");
	return { signInId: input.signInId, expiresAt: input.expiresAt };
}

function parseSignInFinish(value: unknown): string {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Login helper request is invalid");
	const input = value as Record<string, unknown>;
	if (
		Object.keys(input).sort().join() !== "schema,signInId" ||
		input.schema !== "qorpera.model-login-sign-in-finish/v1" ||
		typeof input.signInId !== "string" ||
		!UUID.test(input.signInId)
	)
		throw new Error("Login helper request is invalid");
	return input.signInId;
}

function optionalText(value: unknown, maximum: number): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string" || value.length < 1 || value.length > maximum || /[\0\r\n]/.test(value))
		throw new Error("Login helper answer is invalid");
	return value;
}

function parseSignInState(value: unknown): ModelLoginSignInState {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Login helper answer is invalid");
	const input = value as Record<string, unknown>;
	if (input.schema !== "qorpera.model-login-sign-in/v1") throw new Error("Login helper answer is invalid");
	const keys = Object.keys(input).filter((key) => key !== "schema" && key !== "status");
	if (input.status === "preparing" && keys.length === 0) return { status: "preparing" };
	if (input.status === "awaiting_member" && keys.every((key) => key === "interactionUrl" || key === "userCode")) {
		const interactionUrl = optionalText(input.interactionUrl, 2048);
		const userCode = optionalText(input.userCode, 64);
		if (interactionUrl !== undefined && !interactionUrl.startsWith("https://"))
			throw new Error("Login helper answer is invalid");
		return {
			status: "awaiting_member",
			...(interactionUrl ? { interactionUrl } : {}),
			...(userCode ? { userCode } : {}),
		};
	}
	if (
		input.status === "completed" &&
		typeof input.authJson === "string" &&
		input.authJson.length >= 2 &&
		keys.every((key) => ["authJson", "providerAccountReference", "providerAccountEmail"].includes(key))
	) {
		const providerAccountReference = optionalText(input.providerAccountReference, 512);
		const providerAccountEmail = optionalText(input.providerAccountEmail, 254);
		return {
			status: "completed",
			authJson: input.authJson,
			...(providerAccountReference ? { providerAccountReference } : {}),
			...(providerAccountEmail ? { providerAccountEmail } : {}),
		};
	}
	if (input.status === "failed" && typeof input.reason === "string" && REASON.test(input.reason) && keys.length === 1)
		return { status: "failed", reason: input.reason };
	throw new Error("Login helper answer is invalid");
}

function parseRenewal(value: unknown): ModelLoginRenewal {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Login helper answer is invalid");
	const input = value as Record<string, unknown>;
	if (input.schema !== "qorpera.model-login-renewal/v1") throw new Error("Login helper answer is invalid");
	if (input.outcome === "renewed" && typeof input.authJson === "string" && Object.keys(input).length === 3)
		return { outcome: "renewed", authJson: input.authJson };
	if (
		(input.outcome === "refused" || input.outcome === "transient") &&
		typeof input.reason === "string" &&
		REASON.test(input.reason) &&
		Object.keys(input).length === 3
	)
		return { outcome: input.outcome, reason: input.reason };
	throw new Error("Login helper answer is invalid");
}

export class ModelLoginHelperService {
	readonly #socketPath: string;
	readonly #token: string;
	readonly #renewer: ModelLoginRenewer;
	readonly #signIns: ModelLoginSignInHelper | undefined;
	readonly #concurrency: number;
	#running = 0;
	#server?: Server;

	constructor(options: {
		socketPath: string;
		token: string;
		renewer: ModelLoginRenewer;
		signIns?: ModelLoginSignInHelper;
		concurrency?: number;
	}) {
		if (!isAbsolute(options.socketPath) || resolve(options.socketPath) !== options.socketPath)
			throw new Error("Login helper socket path must be absolute");
		if (!TOKEN.test(options.token)) throw new Error("Login helper token is invalid");
		this.#socketPath = options.socketPath;
		this.#token = options.token;
		this.#renewer = options.renewer;
		this.#signIns = options.signIns;
		this.#concurrency = options.concurrency ?? 4;
	}

	async start(): Promise<void> {
		if (this.#server) throw new Error("Login helper is already running");
		await rm(this.#socketPath, { force: true });
		const server = createServer((request, reply) => {
			void this.#handle(request)
				.then((result) => {
					const body = JSON.stringify(result.body);
					reply.writeHead(result.status, {
						"content-type": "application/json",
						"cache-control": "no-store",
						"content-length": Buffer.byteLength(body),
					});
					reply.end(body);
				})
				.catch(() => reply.destroy());
		});
		server.requestTimeout = 10_000;
		server.headersTimeout = 5000;
		this.#server = server;
		await new Promise<void>((resolveListen, reject) => {
			server.once("error", reject);
			server.listen(this.#socketPath, () => {
				server.removeListener("error", reject);
				resolveListen();
			});
		});
		// A later server error must not end the process with renewals in flight.
		server.on("error", () => undefined);
		// The broker's account reaches the socket through the helper's group; nobody else does.
		await chmod(this.#socketPath, 0o660);
	}

	async close(): Promise<void> {
		const server = this.#server;
		this.#server = undefined;
		if (!server) return;
		await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
		await rm(this.#socketPath, { force: true });
	}

	async #handle(request: IncomingMessage): Promise<{ status: number; body: Record<string, unknown> }> {
		const signIns = this.#signIns;
		if (
			request.method !== "POST" ||
			!(
				request.url === "/v1/renew" ||
				(signIns && (request.url === "/v1/sign-in" || request.url === "/v1/sign-in/finish"))
			) ||
			request.headers["content-type"] !== "application/json" ||
			!tokenMatches(this.#token, request.headers.authorization)
		)
			return { status: 404, body: { schema: "qorpera.model-login-helper-error/v1", error: "not_found" } };
		if (signIns && request.url === "/v1/sign-in") {
			let signIn: { signInId: string; expiresAt: string };
			try {
				signIn = parseSignInRequest(await readBody(request));
			} catch {
				return { status: 400, body: { schema: "qorpera.model-login-helper-error/v1", error: "invalid" } };
			}
			try {
				const state = await signIns.beginSignIn(signIn, AbortSignal.timeout(SIGN_IN_ANSWER_MS));
				return { status: 200, body: { schema: "qorpera.model-login-sign-in/v1", ...state } };
			} catch {
				return {
					status: 200,
					body: { schema: "qorpera.model-login-sign-in/v1", status: "failed", reason: "helper_failed" },
				};
			}
		}
		if (signIns && request.url === "/v1/sign-in/finish") {
			let signInId: string;
			try {
				signInId = parseSignInFinish(await readBody(request));
			} catch {
				return { status: 400, body: { schema: "qorpera.model-login-helper-error/v1", error: "invalid" } };
			}
			await signIns.finishSignIn(signInId, AbortSignal.timeout(10_000)).catch(() => undefined);
			return { status: 200, body: { schema: "qorpera.model-login-sign-in-finished/v1", signInId } };
		}
		let authJson: string;
		try {
			authJson = parseRenewalRequest(await readBody(request));
		} catch {
			return { status: 400, body: { schema: "qorpera.model-login-helper-error/v1", error: "invalid" } };
		}
		if (this.#running >= this.#concurrency)
			return {
				status: 200,
				body: { schema: "qorpera.model-login-renewal/v1", outcome: "transient", reason: "helper_busy" },
			};
		this.#running += 1;
		try {
			const result = await this.#renewer.renew(authJson, AbortSignal.timeout(HELPER_ANSWER_MS));
			return { status: 200, body: { schema: "qorpera.model-login-renewal/v1", ...result } };
		} catch {
			return {
				status: 200,
				body: { schema: "qorpera.model-login-renewal/v1", outcome: "transient", reason: "helper_failed" },
			};
		} finally {
			this.#running -= 1;
		}
	}
}

/** The broker's side: asks the helper to renew a login, or to run a member's sign-in, over the
 * helper's Unix socket. */
export class ModelLoginHelperClient implements ModelLoginRenewer, ModelLoginSignInHelper {
	readonly #socketPath: string;
	readonly #token: string;

	constructor(options: { socketPath: string; token: string }) {
		if (!isAbsolute(options.socketPath) || resolve(options.socketPath) !== options.socketPath)
			throw new Error("Login helper socket path must be absolute");
		if (!TOKEN.test(options.token)) throw new Error("Login helper token is invalid");
		this.#socketPath = options.socketPath;
		this.#token = options.token;
	}

	renew(authJson: string, signal: AbortSignal): Promise<ModelLoginRenewal> {
		return this.#post(
			"/v1/renew",
			{ schema: "qorpera.model-login-renewal-request/v1", authJson },
			parseRenewal,
			AbortSignal.any([signal, AbortSignal.timeout(CLIENT_WAIT_MS)]),
		);
	}

	beginSignIn(request: { signInId: string; expiresAt: string }, signal: AbortSignal): Promise<ModelLoginSignInState> {
		return this.#post(
			"/v1/sign-in",
			{ schema: "qorpera.model-login-sign-in-request/v1", signInId: request.signInId, expiresAt: request.expiresAt },
			parseSignInState,
			AbortSignal.any([signal, AbortSignal.timeout(SIGN_IN_CLIENT_WAIT_MS)]),
		);
	}

	async finishSignIn(signInId: string, signal: AbortSignal): Promise<void> {
		await this.#post(
			"/v1/sign-in/finish",
			{ schema: "qorpera.model-login-sign-in-finish/v1", signInId },
			(value) => {
				const input = value as Record<string, unknown> | null;
				if (input?.schema !== "qorpera.model-login-sign-in-finished/v1" || input.signInId !== signInId)
					throw new Error("Login helper answer is invalid");
				return undefined;
			},
			AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
		);
	}

	#post<T>(
		path: string,
		message: Record<string, unknown>,
		parse: (value: unknown) => T,
		signal: AbortSignal,
	): Promise<T> {
		const body = JSON.stringify(message);
		return new Promise((resolveAnswer, reject) => {
			const outgoing = httpRequest(
				{
					socketPath: this.#socketPath,
					path,
					method: "POST",
					headers: {
						authorization: `Bearer ${this.#token}`,
						"content-type": "application/json",
						"content-length": Buffer.byteLength(body),
					},
					signal,
				},
				(response) => {
					const chunks: Buffer[] = [];
					let total = 0;
					response.on("data", (chunk: Buffer) => {
						total += chunk.byteLength;
						if (total > MAX_RESPONSE_BYTES) {
							response.destroy();
							reject(new Error("Login helper answer is too large"));
							return;
						}
						chunks.push(chunk);
					});
					response.on("end", () => {
						const text = Buffer.concat(chunks);
						try {
							if (response.statusCode !== 200) throw new Error("Login helper refused the request");
							resolveAnswer(parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(text))));
						} catch (error) {
							reject(error);
						} finally {
							text.fill(0);
							for (const chunk of chunks) chunk.fill(0);
						}
					});
					response.on("error", reject);
				},
			);
			outgoing.on("error", reject);
			outgoing.end(body);
		});
	}
}
