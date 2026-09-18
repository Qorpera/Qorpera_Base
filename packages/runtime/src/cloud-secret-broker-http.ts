import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readBoundedCloudResponse, withCloudDeadline } from "@qorpera/cloud-client/cloud-request";
import type { JsonValue } from "@qorpera/contracts";
import { parseCloudNativeToolBinding } from "./cloud-native-tool-authority.ts";
import { type CloudToolContent, cloudToolJsonText } from "./cloud-native-tool-boundary.ts";
import type {
	CloudSecretBroker,
	CloudSecretCaptureRequest,
	CloudSecretDescriptor,
	CloudSecretOperationRequest,
} from "./cloud-secret-broker.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA = /^[0-9a-f]{64}$/;
const IDENTIFIER = /^[a-z][a-z0-9_-]{0,63}$/;
const OPERATION_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const MAX_REQUEST_BYTES = 96 * 1024;
const MAX_RESPONSE_BYTES = 48 * 1024;

function record(value: unknown, label: string): Record<string, unknown> {
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		Object.getPrototypeOf(value) !== Object.prototype
	) {
		throw new Error(`${label} is invalid`);
	}
	return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, keys: readonly string[], label: string): void {
	if (Object.keys(value).sort().join() !== [...keys].sort().join()) throw new Error(`${label} is invalid`);
}

function tokenMatches(expected: string, authorization: string | undefined): boolean {
	if (!authorization?.startsWith("Bearer ")) return false;
	const left = Buffer.from(expected, "utf8");
	const right = Buffer.from(authorization.slice("Bearer ".length), "utf8");
	return left.byteLength === right.byteLength && timingSafeEqual(left, right);
}

function parseFields(value: unknown): Record<string, string> {
	const input = record(value, "Cloud secret fields");
	if (Object.keys(input).length < 1 || Object.keys(input).length > 16)
		throw new Error("Cloud secret fields are invalid");
	const output: Record<string, string> = {};
	for (const [name, field] of Object.entries(input)) {
		if (!IDENTIFIER.test(name) || typeof field !== "string" || !field || Buffer.byteLength(field) > 32 * 1024) {
			throw new Error("Cloud secret fields are invalid");
		}
		output[name] = field;
	}
	return output;
}

function parseCapture(value: unknown, ticketId: string): CloudSecretCaptureRequest {
	const input = record(value, "Cloud secret capture request");
	exact(input, ["schema", "captureCapability", "fields"], "Cloud secret capture request");
	if (
		input.schema !== "qorpera.cloud-secret-capture-request/v1" ||
		typeof input.captureCapability !== "string" ||
		!/^[A-Za-z0-9_-]{32,256}$/.test(input.captureCapability)
	)
		throw new Error("Cloud secret capture request is invalid");
	return { ticketId, captureCapability: input.captureCapability, fields: parseFields(input.fields) };
}

function parseOperation(value: unknown): CloudSecretOperationRequest {
	const input = record(value, "Cloud secret operation request");
	exact(
		input,
		[
			"schema",
			"binding",
			"receiptId",
			"inputSha256",
			"grantId",
			"connectorId",
			"operationId",
			"operationVersion",
			"adapterSha256",
			"destinationOrigin",
			"idempotencyKey",
			"arguments",
		],
		"Cloud secret operation request",
	);
	if (
		input.schema !== "qorpera.cloud-secret-operation-request/v1" ||
		typeof input.receiptId !== "string" ||
		!UUID.test(input.receiptId) ||
		typeof input.inputSha256 !== "string" ||
		!SHA.test(input.inputSha256) ||
		typeof input.grantId !== "string" ||
		!UUID.test(input.grantId) ||
		typeof input.connectorId !== "string" ||
		!IDENTIFIER.test(input.connectorId) ||
		typeof input.operationId !== "string" ||
		!IDENTIFIER.test(input.operationId) ||
		!Number.isSafeInteger(input.operationVersion) ||
		(input.operationVersion as number) < 1 ||
		typeof input.adapterSha256 !== "string" ||
		!SHA.test(input.adapterSha256) ||
		typeof input.destinationOrigin !== "string" ||
		new URL(input.destinationOrigin).origin !== input.destinationOrigin ||
		!input.destinationOrigin.startsWith("https://") ||
		typeof input.idempotencyKey !== "string" ||
		!OPERATION_KEY.test(input.idempotencyKey)
	)
		throw new Error("Cloud secret operation request is invalid");
	cloudToolJsonText(input.arguments, 64 * 1024);
	return {
		binding: parseCloudNativeToolBinding(input.binding),
		receiptId: input.receiptId,
		inputSha256: input.inputSha256,
		grantId: input.grantId,
		connectorId: input.connectorId,
		operationId: input.operationId,
		operationVersion: input.operationVersion as number,
		adapterSha256: input.adapterSha256,
		destinationOrigin: input.destinationOrigin,
		idempotencyKey: input.idempotencyKey,
		arguments: structuredClone(input.arguments) as JsonValue,
	};
}

function parseContent(value: unknown): CloudToolContent {
	const input = record(value, "Cloud secret broker response");
	exact(input, ["kind", "value"], "Cloud secret broker response");
	if ((input.kind !== "text" && input.kind !== "json") || (input.kind === "text" && typeof input.value !== "string"))
		throw new Error("Cloud secret broker response is invalid");
	cloudToolJsonText(input, 32 * 1024);
	return structuredClone(input) as CloudToolContent;
}

function parseDescriptor(value: unknown): CloudSecretDescriptor {
	const input = record(value, "Cloud secret descriptor");
	exact(
		input,
		["schema", "secretId", "version", "connectorId", "secretName", "purpose", "ownerKind", "ownerUserId", "status"],
		"Cloud secret descriptor",
	);
	if (
		input.schema !== "qorpera.cloud-secret-descriptor/v1" ||
		typeof input.secretId !== "string" ||
		!UUID.test(input.secretId) ||
		!Number.isSafeInteger(input.version) ||
		(input.version as number) < 1 ||
		typeof input.connectorId !== "string" ||
		!IDENTIFIER.test(input.connectorId) ||
		typeof input.secretName !== "string" ||
		!IDENTIFIER.test(input.secretName) ||
		typeof input.purpose !== "string" ||
		!input.purpose.trim() ||
		input.purpose.length > 512 ||
		(input.ownerKind !== "company" && input.ownerKind !== "member") ||
		(input.ownerKind === "company" ? input.ownerUserId !== null : typeof input.ownerUserId !== "string") ||
		(typeof input.ownerUserId === "string" && !UUID.test(input.ownerUserId)) ||
		input.status !== "active"
	)
		throw new Error("Cloud secret descriptor is invalid");
	return {
		schema: "qorpera.cloud-secret-descriptor/v1",
		secretId: input.secretId,
		version: input.version as number,
		connectorId: input.connectorId,
		secretName: input.secretName,
		purpose: input.purpose,
		ownerKind: input.ownerKind,
		ownerUserId: input.ownerUserId as string | null,
		status: "active",
	};
}

async function readRequest(request: IncomingMessage): Promise<unknown> {
	const chunks: Buffer[] = [];
	let bytes = 0;
	const timeout = setTimeout(() => request.destroy(new Error("Cloud secret broker request timed out")), 10_000);
	let body: Buffer | undefined;
	try {
		for await (const chunkValue of request) {
			const chunk = Buffer.isBuffer(chunkValue) ? Buffer.from(chunkValue) : Buffer.from(chunkValue);
			bytes += chunk.byteLength;
			if (bytes > MAX_REQUEST_BYTES) throw new Error("Cloud secret broker request is too large");
			chunks.push(chunk);
		}
		body = Buffer.concat(chunks);
		return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)) as unknown;
	} finally {
		clearTimeout(timeout);
		body?.fill(0);
		for (const chunk of chunks) chunk.fill(0);
	}
}

function response(reply: ServerResponse, status: number, value: JsonValue): void {
	const body = JSON.stringify(value);
	reply.writeHead(status, {
		"content-type": "application/json",
		"content-length": Buffer.byteLength(body),
		"cache-control": "no-store",
		"x-content-type-options": "nosniff",
	});
	reply.end(body);
}

/**
 * Separate-process broker surface. Capture is authorized only by the one-time
 * member ticket; operation execution additionally requires a private service
 * token and the database's current run/grant/receipt authorization.
 */
export class HttpCloudSecretBrokerService {
	readonly #broker: CloudSecretBroker;
	readonly #runtimeToken: string;
	readonly #host: string;
	readonly #port: number;
	#server?: Server;

	constructor(broker: CloudSecretBroker, runtimeToken: string, host = "127.0.0.1", port = 0) {
		if (
			!TOKEN.test(runtimeToken) ||
			!["127.0.0.1", "::1"].includes(host) ||
			!Number.isSafeInteger(port) ||
			port < 0 ||
			port > 65_535
		) {
			throw new Error("Cloud secret broker service configuration is invalid");
		}
		this.#broker = broker;
		this.#runtimeToken = runtimeToken;
		this.#host = host;
		this.#port = port;
	}

	async start(): Promise<number> {
		if (this.#server) throw new Error("Cloud secret broker service is already running");
		this.#server = createServer((request, reply) => {
			void this.#handle(request, reply).catch(() => reply.destroy());
		});
		this.#server.requestTimeout = 15_000;
		this.#server.headersTimeout = 10_000;
		this.#server.keepAliveTimeout = 5000;
		this.#server.maxRequestsPerSocket = 10;
		await new Promise<void>((resolve, reject) => {
			this.#server?.once("error", reject);
			this.#server?.listen(this.#port, this.#host, () => resolve());
		});
		const address = this.#server.address();
		if (!address || typeof address === "string") throw new Error("Cloud secret broker service address is invalid");
		return address.port;
	}

	async close(): Promise<void> {
		const server = this.#server;
		this.#server = undefined;
		if (!server) return;
		await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
	}

	async #handle(request: IncomingMessage, reply: ServerResponse): Promise<void> {
		try {
			if (request.method !== "POST" || request.headers["content-type"]?.split(";", 1)[0] !== "application/json") {
				response(reply, 404, { schema: "qorpera.cloud-secret-error/v1", error: "not_found" });
				return;
			}
			const path = new URL(request.url ?? "/", "http://cloud-secret-broker.invalid").pathname;
			const capture = /^\/v1\/captures\/([0-9a-f-]{36})$/i.exec(path);
			if (capture && UUID.test(capture[1])) {
				const descriptor = await this.#broker.capture(
					parseCapture(await readRequest(request), capture[1]),
					AbortSignal.timeout(15_000),
				);
				response(reply, 200, descriptor as unknown as JsonValue);
				return;
			}
			if (path === "/v1/operations" && tokenMatches(this.#runtimeToken, request.headers.authorization)) {
				const result = await this.#broker.execute(
					parseOperation(await readRequest(request)),
					AbortSignal.timeout(35_000),
				);
				response(reply, 200, result as unknown as JsonValue);
				return;
			}
			response(reply, 404, { schema: "qorpera.cloud-secret-error/v1", error: "not_found" });
		} catch {
			if (!reply.headersSent && !reply.destroyed) {
				response(reply, 403, { schema: "qorpera.cloud-secret-error/v1", error: "unavailable" });
			} else {
				reply.destroy();
			}
		}
	}
}

function brokerOrigin(value: string, allowLoopback = false): string {
	const url = new URL(value);
	if (
		(url.protocol !== "https:" &&
			!(allowLoopback && url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname))) ||
		url.username ||
		url.password ||
		url.search ||
		url.hash ||
		url.pathname !== "/"
	)
		throw new Error("Cloud secret broker URL is invalid");
	return url.origin;
}

export class HttpCloudSecretBrokerClient {
	readonly #origin: string;
	readonly #runtimeToken: string;
	readonly #fetch: typeof fetch;

	constructor(options: { origin: string; runtimeToken: string; allowLoopback?: boolean; fetch?: typeof fetch }) {
		this.#origin = brokerOrigin(options.origin, options.allowLoopback);
		if (!TOKEN.test(options.runtimeToken)) throw new Error("Cloud secret broker client token is invalid");
		this.#runtimeToken = options.runtimeToken;
		this.#fetch = options.fetch ?? fetch;
	}

	async execute(request: CloudSecretOperationRequest, signal: AbortSignal): Promise<CloudToolContent> {
		return withCloudDeadline(
			async (requestSignal) => {
				const responseValue = await this.#fetch(`${this.#origin}/v1/operations`, {
					method: "POST",
					redirect: "error",
					headers: {
						authorization: `Bearer ${this.#runtimeToken}`,
						"content-type": "application/json",
					},
					body: cloudToolJsonText({ schema: "qorpera.cloud-secret-operation-request/v1", ...request }),
					signal: requestSignal,
				});
				if (!responseValue.ok) {
					void responseValue.body?.cancel().catch(() => undefined);
					throw new Error("Cloud secret broker rejected the operation");
				}
				const bytes = await readBoundedCloudResponse(responseValue, MAX_RESPONSE_BYTES, requestSignal);
				try {
					return parseContent(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
				} catch {
					throw new Error("Cloud secret broker returned invalid data");
				} finally {
					bytes.fill(0);
				}
			},
			35_000,
			signal,
		);
	}
}

/** Typed member capture path. The plaintext body goes to the broker origin,
 * never to Supabase, the Company File, a transcript, or the native runner. */
export async function captureCloudSecret(
	serviceOrigin: string,
	request: CloudSecretCaptureRequest,
	signal: AbortSignal,
	fetchImplementation: typeof fetch = fetch,
): Promise<CloudSecretDescriptor> {
	const origin = brokerOrigin(serviceOrigin);
	return withCloudDeadline(
		async (requestSignal) => {
			const body = Buffer.from(
				JSON.stringify({
					schema: "qorpera.cloud-secret-capture-request/v1",
					captureCapability: request.captureCapability,
					fields: request.fields,
				}),
				"utf8",
			);
			try {
				const responseValue = await fetchImplementation(`${origin}/v1/captures/${request.ticketId}`, {
					method: "POST",
					redirect: "error",
					headers: { "content-type": "application/json" },
					body,
					signal: requestSignal,
				});
				if (!responseValue.ok) {
					void responseValue.body?.cancel().catch(() => undefined);
					throw new Error("Cloud secret capture was not confirmed");
				}
				const bytes = await readBoundedCloudResponse(responseValue, MAX_RESPONSE_BYTES, requestSignal);
				try {
					return parseDescriptor(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
				} catch {
					throw new Error("Cloud secret capture returned invalid data");
				} finally {
					bytes.fill(0);
				}
			} finally {
				body.fill(0);
			}
		},
		15_000,
		signal,
	);
}
