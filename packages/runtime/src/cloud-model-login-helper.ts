import { timingSafeEqual } from "node:crypto";
import { chmod, rm } from "node:fs/promises";
import { createServer, request as httpRequest, type IncomingMessage, type Server } from "node:http";
import { isAbsolute, resolve } from "node:path";
import { CODEX_RENEWAL_BUDGET_MS } from "./cloud-model-login-renewal.ts";
import type { ModelLoginRenewal, ModelLoginRenewer } from "./cloud-model-login-vault.ts";

/**
 * The vault's login helper: a separate process beside the cloud secret broker that runs the
 * official Codex for the vault (renewal today, sign-in next). The broker keeps the key that
 * opens a login; the helper sees a login only for one operation and keeps nothing.
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
	readonly #concurrency: number;
	#running = 0;
	#server?: Server;

	constructor(options: { socketPath: string; token: string; renewer: ModelLoginRenewer; concurrency?: number }) {
		if (!isAbsolute(options.socketPath) || resolve(options.socketPath) !== options.socketPath)
			throw new Error("Login helper socket path must be absolute");
		if (!TOKEN.test(options.token)) throw new Error("Login helper token is invalid");
		this.#socketPath = options.socketPath;
		this.#token = options.token;
		this.#renewer = options.renewer;
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
		if (
			request.method !== "POST" ||
			request.url !== "/v1/renew" ||
			request.headers["content-type"] !== "application/json" ||
			!tokenMatches(this.#token, request.headers.authorization)
		)
			return { status: 404, body: { schema: "qorpera.model-login-helper-error/v1", error: "not_found" } };
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

/** The broker's side: asks the helper to renew one login over the helper's Unix socket. */
export class ModelLoginHelperClient implements ModelLoginRenewer {
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
		const body = JSON.stringify({ schema: "qorpera.model-login-renewal-request/v1", authJson });
		return new Promise((resolveRenewal, reject) => {
			const outgoing = httpRequest(
				{
					socketPath: this.#socketPath,
					path: "/v1/renew",
					method: "POST",
					headers: {
						authorization: `Bearer ${this.#token}`,
						"content-type": "application/json",
						"content-length": Buffer.byteLength(body),
					},
					signal: AbortSignal.any([signal, AbortSignal.timeout(CLIENT_WAIT_MS)]),
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
							if (response.statusCode !== 200) throw new Error("Login helper refused the renewal");
							resolveRenewal(parseRenewal(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(text))));
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
