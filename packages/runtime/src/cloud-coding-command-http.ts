import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readBoundedCloudResponse, withCloudDeadline } from "@qorpera/cloud-client/cloud-request";
import { type CloudCodingCommandScope, parseCloudCodingCommandReceipt } from "@qorpera/contracts";
import type { CloudCodingCommandGateway } from "./cloud-coding-command-tools.ts";
import { type CloudNativeToolBinding, parseCloudNativeToolBinding } from "./cloud-native-tool-authority.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const REQUEST_LIMIT = 128 * 1024;
const RESULT_LIMIT = 32 * 1024;
const ERROR = "Coding command gateway unavailable";
type CommandInput = { commandId: string; inputSha256: string; command: string; timeoutMs: number };
export type CloudCodingCommandHttpRequest = Readonly<
	{
		schema: "qorpera.coding-command-http/v1";
		binding: CloudNativeToolBinding;
		scope: CloudCodingCommandScope;
	} & ({ action: "start"; input: CommandInput } | { action: "read" | "cancel"; input: { commandId: string } })
>;

function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		Object.keys(value).sort().join() !== [...keys].sort().join()
	)
		throw new Error(ERROR);
	return value as Record<string, unknown>;
}
function scope(value: unknown): CloudCodingCommandScope {
	const input = record(value, ["workerId", "vmId", "requestId", "turn"]);
	if (
		![input.workerId, input.vmId, input.requestId].every((id) => typeof id === "string" && UUID.test(id)) ||
		!Number.isSafeInteger(input.turn) ||
		Number(input.turn) < 1
	)
		throw new Error(ERROR);
	return Object.freeze({ ...input }) as unknown as CloudCodingCommandScope;
}
function parseRequest(value: unknown, action: string): CloudCodingCommandHttpRequest {
	const valueRecord = record(value, ["schema", "binding", "scope", "action", "input"]);
	if (
		valueRecord.schema !== "qorpera.coding-command-http/v1" ||
		valueRecord.action !== action ||
		!["start", "read", "cancel"].includes(action)
	)
		throw new Error(ERROR);
	const input = record(
		valueRecord.input,
		action === "start" ? ["commandId", "inputSha256", "command", "timeoutMs"] : ["commandId"],
	);
	if (typeof input.commandId !== "string" || !UUID.test(input.commandId)) throw new Error(ERROR);
	if (
		action === "start" &&
		(typeof input.inputSha256 !== "string" ||
			!HASH.test(input.inputSha256) ||
			typeof input.command !== "string" ||
			!input.command.trim() ||
			input.command.includes("\0") ||
			Buffer.from(input.command).toString("utf8") !== input.command ||
			Buffer.byteLength(input.command) > 16384 ||
			Buffer.byteLength(JSON.stringify(input.command)) > 60000 ||
			!Number.isSafeInteger(input.timeoutMs) ||
			Number(input.timeoutMs) < 1000 ||
			Number(input.timeoutMs) > 1800000)
	)
		throw new Error(ERROR);
	return Object.freeze({
		schema: "qorpera.coding-command-http/v1",
		binding: parseCloudNativeToolBinding(valueRecord.binding),
		scope: scope(valueRecord.scope),
		action,
		input: Object.freeze({ ...input }),
	}) as CloudCodingCommandHttpRequest;
}
export function parseCloudCodingCommandUrl(value: string, allowLoopback = false): string {
	const url = new URL(value);
	if (
		(url.protocol !== "https:" &&
			!(allowLoopback && url.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(url.hostname))) ||
		url.username ||
		url.password ||
		url.search ||
		url.hash ||
		url.pathname !== "/"
	)
		throw new Error(ERROR);
	return url.origin;
}
function validToken(value: string): boolean {
	return (
		TOKEN.test(value) &&
		Buffer.from(value, "base64url").length === 32 &&
		Buffer.from(value, "base64url").toString("base64url") === value
	);
}

/** Credential and binding are host-only; no model argument chooses a host,
 * route, VM or cloud authority. There are no automatic effect retries. */
export function createHttpCloudCodingCommandGateway(options: {
	url: string;
	token: string;
	binding: CloudNativeToolBinding;
	authorize: CloudCodingCommandGateway["authorize"];
	allowLoopback?: boolean;
	fetch?: typeof fetch;
}): CloudCodingCommandGateway {
	const origin = parseCloudCodingCommandUrl(options.url, options.allowLoopback);
	if (!validToken(options.token)) throw new Error(ERROR);
	const token = options.token;
	const binding = parseCloudNativeToolBinding(options.binding);
	const transport = options.fetch ?? fetch;
	const request = async (
		action: "start" | "read" | "cancel",
		admittedScope: CloudCodingCommandScope,
		input: CommandInput | { commandId: string },
		signal: AbortSignal,
	): Promise<unknown> => {
		try {
			const admitted = parseRequest(
				{ schema: "qorpera.coding-command-http/v1", binding, scope: admittedScope, action, input },
				action,
			);
			const body = JSON.stringify(admitted);
			if (Buffer.byteLength(body) > REQUEST_LIMIT) throw new Error(ERROR);
			return await withCloudDeadline(
				async (requestSignal) => {
					const response = await transport(`${origin}/v1/coding-commands/${action}`, {
						method: "POST",
						redirect: "error",
						signal: requestSignal,
						headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
						body,
					});
					if (!response.ok || response.status !== 200) {
						void response.body?.cancel().catch(() => undefined);
						throw new Error(ERROR);
					}
					const bytes = await readBoundedCloudResponse(response, RESULT_LIMIT, requestSignal);
					const receipt = parseCloudCodingCommandReceipt(
						JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(bytes)),
					);
					if (
						receipt.workerId !== admitted.scope.workerId ||
						receipt.commandId !== admitted.input.commandId ||
						(admitted.action === "start" && receipt.inputSha256 !== admitted.input.inputSha256)
					)
						throw new Error(ERROR);
					return receipt;
				},
				30000,
				signal,
			);
		} catch {
			throw new Error(ERROR);
		}
	};
	return Object.freeze<CloudCodingCommandGateway>({
		authorize: options.authorize,
		start: (s, input, signal) => request("start", s, input, signal),
		read: (s, commandId, signal) => request("read", s, { commandId }, signal),
		cancel: (s, commandId, signal) => request("cancel", s, { commandId }, signal),
	});
}

export interface CloudCodingCommandServiceOptions {
	token: string;
	/** Recheck the current native binding, request lease, worker/VM/turn and
	 * original command receipt. For start also compare command+timeout against
	 * its canonical admitted arguments. Return the original command input hash. */
	authorize(request: CloudCodingCommandHttpRequest, signal: AbortSignal): Promise<{ inputSha256: string }>;
	/** Trusted host composition constructs the fixed LXD guest transport after
	 * SQL authority checks; never execute a shell on the host. */
	execute(request: CloudCodingCommandHttpRequest, signal: AbortSignal): Promise<unknown>;
	host?: "127.0.0.1" | "::1";
	port?: number;
}

async function readRequest(request: IncomingMessage, signal: AbortSignal): Promise<unknown> {
	const declared = request.headers["content-length"];
	if (declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) > REQUEST_LIMIT)) throw new Error(ERROR);
	const chunks: Buffer[] = [];
	let count = 0;
	const abort = (): void => {
		request.destroy();
	};
	signal.addEventListener("abort", abort, { once: true });
	try {
		for await (const value of request) {
			signal.throwIfAborted();
			const bytes = Buffer.from(value);
			count += bytes.length;
			if (count > REQUEST_LIMIT) throw new Error(ERROR);
			chunks.push(bytes);
		}
		return JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(Buffer.concat(chunks, count)));
	} finally {
		signal.removeEventListener("abort", abort);
	}
}
function replyJson(reply: ServerResponse, status: number, value: unknown): void {
	const body = JSON.stringify(value);
	if (Buffer.byteLength(body) > RESULT_LIMIT) throw new Error(ERROR);
	reply.writeHead(status, {
		"content-type": "application/json",
		"content-length": Buffer.byteLength(body),
		"cache-control": "no-store",
		"x-content-type-options": "nosniff",
	});
	reply.end(body);
}
/** Loopback-only backend for a separately configured TLS proxy; the bearer
 * credential comes from private systemd credential provisioning. */
export class HttpCloudCodingCommandService {
	readonly #options: CloudCodingCommandServiceOptions;
	readonly #token: Buffer;
	readonly #controllers = new Set<AbortController>();
	#server?: Server;
	constructor(options: CloudCodingCommandServiceOptions) {
		if (
			!validToken(options.token) ||
			(options.host !== undefined && !["127.0.0.1", "::1"].includes(options.host)) ||
			!Number.isSafeInteger(options.port ?? 0) ||
			(options.port ?? 0) < 0 ||
			(options.port ?? 0) > 65535
		)
			throw new Error(ERROR);
		this.#options = Object.freeze({ ...options });
		this.#token = Buffer.from(`Bearer ${options.token}`);
	}
	async start(signal?: AbortSignal): Promise<number> {
		if (this.#server) throw new Error(ERROR);
		signal?.throwIfAborted();
		const server = createServer((request, reply) => {
			void this.#handle(request, reply);
		});
		this.#server = server;
		server.requestTimeout = 15000;
		server.headersTimeout = 10000;
		server.keepAliveTimeout = 1000;
		server.maxRequestsPerSocket = 10;
		try {
			await new Promise<void>((resolve, reject) => {
				const onError = (error: Error): void => {
					reject(error);
				};
				server.once("error", onError);
				server.listen(this.#options.port ?? 0, this.#options.host ?? "127.0.0.1", () => {
					server.off("error", onError);
					resolve();
				});
			});
			const address = server.address();
			if (!address || typeof address === "string") throw new Error(ERROR);
			const abort = (): void => {
				void this.close();
			};
			signal?.addEventListener("abort", abort, { once: true });
			server.once("close", () => signal?.removeEventListener("abort", abort));
			if (signal?.aborted) {
				await this.close();
				throw new Error(ERROR);
			}
			return address.port;
		} catch {
			this.#server = undefined;
			server.close();
			throw new Error(ERROR);
		}
	}
	async close(): Promise<void> {
		const server = this.#server;
		this.#server = undefined;
		for (const controller of this.#controllers) controller.abort();
		if (!server) return;
		await new Promise<void>((resolve) => {
			server.close(() => resolve());
			server.closeAllConnections();
		});
	}
	async #handle(request: IncomingMessage, reply: ServerResponse): Promise<void> {
		const controller = new AbortController();
		this.#controllers.add(controller);
		const timeout = setTimeout(() => controller.abort(), 30000);
		const disconnect = (): void => {
			if (!reply.writableFinished) controller.abort();
		};
		reply.once("close", disconnect);
		try {
			const authorization = Buffer.from(request.headers.authorization ?? "");
			const route = /^\/v1\/coding-commands\/(start|read|cancel)$/.exec(request.url ?? "");
			if (
				request.method !== "POST" ||
				!route ||
				request.headers["content-type"] !== "application/json" ||
				authorization.length !== this.#token.length ||
				!timingSafeEqual(authorization, this.#token)
			)
				throw new Error(ERROR);
			const admitted = parseRequest(await readRequest(request, controller.signal), route[1]);
			const authority = await this.#options.authorize(admitted, controller.signal);
			if (
				!HASH.test(authority.inputSha256) ||
				(admitted.action === "start" && authority.inputSha256 !== admitted.input.inputSha256)
			)
				throw new Error(ERROR);
			controller.signal.throwIfAborted();
			const receipt = parseCloudCodingCommandReceipt(await this.#options.execute(admitted, controller.signal));
			const after = await this.#options.authorize(admitted, controller.signal);
			controller.signal.throwIfAborted();
			if (
				after.inputSha256 !== authority.inputSha256 ||
				receipt.inputSha256 !== authority.inputSha256 ||
				receipt.workerId !== admitted.scope.workerId ||
				receipt.commandId !== admitted.input.commandId
			)
				throw new Error(ERROR);
			replyJson(reply, 200, receipt);
		} catch {
			if (!reply.headersSent && !reply.destroyed) replyJson(reply, 403, { error: "coding_command_unavailable" });
			else reply.destroy();
		} finally {
			clearTimeout(timeout);
			reply.off("close", disconnect);
			this.#controllers.delete(controller);
		}
	}
}
