import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readBoundedCloudResponse, withCloudDeadline } from "@qorpera/cloud-client/cloud-request";
import type { JsonValue } from "@qorpera/contracts";
import {
	CloudConnectorOAuthError,
	type CloudConnectorOAuthFlows,
	connectorReturnLocation,
} from "./cloud-connector-oauth.ts";
import { parseCloudNativeToolBinding } from "./cloud-native-tool-authority.ts";
import { type CloudToolContent, cloudToolJsonText } from "./cloud-native-tool-boundary.ts";
import {
	type CloudSecretBroker,
	type CloudSecretCaptureRequest,
	type CloudSecretDescriptor,
	type CloudSecretOperationRequest,
	type CodingRepositoryCredentialRequest,
	parseCloudSecretAccountLabel,
	parseCodingRepositoryCredentialRequest,
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

function parseRepositoryCredentialRequest(value: unknown): CodingRepositoryCredentialRequest {
	const input = record(value, "Coding repository credential request");
	exact(
		input,
		["schema", "workerId", "leaseToken", "executorOwner", "repository"],
		"Coding repository credential request",
	);
	if (input.schema !== "qorpera.coding-repository-credential-request/v1")
		throw new Error("Coding repository credential request is invalid");
	return parseCodingRepositoryCredentialRequest({
		workerId: input.workerId,
		leaseToken: input.leaseToken,
		executorOwner: input.executorOwner,
		repository: input.repository,
	});
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
	const keys = [
		"schema",
		"secretId",
		"version",
		"connectorId",
		"secretName",
		"purpose",
		"ownerKind",
		"ownerUserId",
		"status",
	];
	exact(input, Object.hasOwn(input, "accountLabel") ? [...keys, "accountLabel"] : keys, "Cloud secret descriptor");
	const accountLabel = parseCloudSecretAccountLabel(input.accountLabel);
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
		...(Object.hasOwn(input, "accountLabel") ? { accountLabel } : {}),
	};
}

function parseOAuthStart(value: unknown): { captureCapability: string; returnTo: string; browserProofSha256: string } {
	const input = record(value, "Connector authorization start");
	exact(input, ["schema", "captureCapability", "returnTo", "browserProofSha256"], "Connector authorization start");
	if (
		input.schema !== "qorpera.cloud-connector-oauth-start/v2" ||
		typeof input.captureCapability !== "string" ||
		!/^[A-Za-z0-9_-]{32,256}$/.test(input.captureCapability) ||
		typeof input.returnTo !== "string" ||
		input.returnTo.length > 2048 ||
		typeof input.browserProofSha256 !== "string" ||
		!/^[0-9a-f]{64}$/.test(input.browserProofSha256)
	)
		throw new Error("Connector authorization start is invalid");
	return {
		captureCapability: input.captureCapability,
		returnTo: input.returnTo,
		browserProofSha256: input.browserProofSha256,
	};
}

function parseOAuthConfirm(value: unknown): { confirmation: string; browserProof: string } {
	const input = record(value, "Connector authorization confirmation");
	exact(input, ["schema", "confirmation", "browserProof"], "Connector authorization confirmation");
	if (
		input.schema !== "qorpera.cloud-connector-oauth-confirm/v1" ||
		typeof input.confirmation !== "string" ||
		!/^[A-Za-z0-9_-]{43}$/.test(input.confirmation) ||
		typeof input.browserProof !== "string" ||
		!/^[A-Za-z0-9_-]{43}$/.test(input.browserProof)
	)
		throw new Error("Connector authorization confirmation is invalid");
	return { confirmation: input.confirmation, browserProof: input.browserProof };
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

function response(reply: ServerResponse, status: number, value: JsonValue, headers: Record<string, string> = {}): void {
	const body = JSON.stringify(value);
	reply.writeHead(status, {
		"content-type": "application/json",
		"content-length": Buffer.byteLength(body),
		"cache-control": "no-store",
		"x-content-type-options": "nosniff",
		...headers,
	});
	reply.end(body);
}

function redirect(reply: ServerResponse, location: string): void {
	reply.writeHead(303, {
		location,
		"cache-control": "no-store",
		"content-length": 0,
		"referrer-policy": "no-referrer",
	});
	reply.end();
}

function plainPage(reply: ServerResponse, status: number, text: string): void {
	const body = `${text}\n`;
	reply.writeHead(status, {
		"content-type": "text/plain; charset=utf-8",
		"content-length": Buffer.byteLength(body),
		"cache-control": "no-store",
		"x-content-type-options": "nosniff",
		"referrer-policy": "no-referrer",
	});
	reply.end(body);
}

/** A member app origin the capture route answers to: https, origin only. */
export function parseMemberOrigin(value: unknown): string {
	if (typeof value !== "string") throw new Error("Cloud secret broker member origin is invalid");
	const url = new URL(value);
	if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/")
		throw new Error("Cloud secret broker member origin is invalid");
	return url.origin;
}

/** The member routes (capture, connector sign-in start) are called from the
 * member's browser on another origin. The plaintext crosses only to this
 * service, so the answer names the one origin that asked, never a wildcard,
 * and only when it is on the configured list. */
function corsHeaders(origin: string): Record<string, string> {
	return {
		"access-control-allow-origin": origin,
		"access-control-allow-methods": "POST",
		"access-control-allow-headers": "content-type",
		"access-control-max-age": "600",
		vary: "origin",
	};
}

export interface HttpCloudSecretBrokerServiceOptions {
	readonly host?: string;
	readonly port?: number;
	/** Member app origins allowed to call the member routes from a browser
	 * (config v2 `memberOrigins`). The runtime operation route never receives
	 * CORS headers. */
	readonly memberOrigins?: readonly string[];
	/** Connector OAuth flows (Step 7); absent means the OAuth routes answer 404. */
	readonly oauth?: CloudConnectorOAuthFlows;
	/** The coding executor's own bearer for `/v1/repository-credentials`
	 * (bundle v88; credential `qorpera-cloud-secret-coding-executor`). Distinct
	 * from the runtime token every guest holds; absent means the route answers
	 * 404. The runtime token never opens that route, and this token never opens
	 * `/v1/operations`. */
	readonly codingExecutorToken?: string;
}

/**
 * Separate-process broker surface. Capture is authorized only by the one-time
 * member ticket; operation execution additionally requires a private service
 * token and the database's current run/grant/receipt authorization; a coding
 * executor's repository token requires the executor's own separate token and
 * the database's current session lease, repository grant and connection grant.
 */
export class HttpCloudSecretBrokerService {
	readonly #broker: CloudSecretBroker;
	readonly #runtimeToken: string;
	readonly #host: string;
	readonly #port: number;
	readonly #memberOrigins: ReadonlySet<string>;
	readonly #oauth: CloudConnectorOAuthFlows | undefined;
	readonly #codingExecutorToken: string | undefined;
	#server?: Server;

	constructor(
		broker: CloudSecretBroker,
		runtimeToken: string,
		hostOrOptions: string | HttpCloudSecretBrokerServiceOptions = "127.0.0.1",
		port = 0,
		memberOrigins: readonly string[] = [],
	) {
		const options: HttpCloudSecretBrokerServiceOptions =
			typeof hostOrOptions === "string" ? { host: hostOrOptions, port, memberOrigins } : hostOrOptions;
		const host = options.host ?? "127.0.0.1";
		const listenPort = options.port ?? 0;
		const origins = options.memberOrigins ?? [];
		if (
			!TOKEN.test(runtimeToken) ||
			!["127.0.0.1", "::1"].includes(host) ||
			!Number.isSafeInteger(listenPort) ||
			listenPort < 0 ||
			listenPort > 65_535 ||
			origins.length > 16 ||
			(options.codingExecutorToken !== undefined &&
				(!TOKEN.test(options.codingExecutorToken) || options.codingExecutorToken === runtimeToken))
		) {
			throw new Error("Cloud secret broker service configuration is invalid");
		}
		this.#broker = broker;
		this.#runtimeToken = runtimeToken;
		this.#host = host;
		this.#port = listenPort;
		this.#memberOrigins = new Set(origins.map(parseMemberOrigin));
		this.#oauth = options.oauth;
		this.#codingExecutorToken = options.codingExecutorToken;
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
		const url = new URL(request.url ?? "/", "http://cloud-secret-broker.invalid");
		const path = url.pathname;
		const capture = /^\/v1\/captures\/([0-9a-f-]{36})$/i.exec(path);
		const oauthStart = /^\/v1\/oauth\/([0-9a-f-]{36})\/start$/i.exec(path);
		const oauthConfirm = /^\/v1\/oauth\/([0-9a-f-]{36})\/confirm$/i.exec(path);
		const memberRoute = Boolean(
			(capture && UUID.test(capture[1])) ||
				(oauthStart && UUID.test(oauthStart[1])) ||
				(oauthConfirm && UUID.test(oauthConfirm[1])),
		);
		const origin = typeof request.headers.origin === "string" ? request.headers.origin : undefined;
		const allowedOrigin = origin !== undefined && this.#memberOrigins.has(origin) ? origin : undefined;
		const cors = memberRoute && allowedOrigin ? corsHeaders(allowedOrigin) : {};
		try {
			if (request.method === "OPTIONS") {
				// A browser preflight for a member route; every other route has no browser caller.
				if (memberRoute && allowedOrigin) {
					reply.writeHead(204, { ...cors, "cache-control": "no-store" });
					reply.end();
				} else response(reply, 404, { schema: "qorpera.cloud-secret-error/v1", error: "not_found" });
				return;
			}
			if (request.method === "GET" && path === "/v1/oauth/callback") {
				await this.#oauthCallback(url, reply);
				return;
			}
			if (request.method !== "POST" || request.headers["content-type"]?.split(";", 1)[0] !== "application/json") {
				response(reply, 404, { schema: "qorpera.cloud-secret-error/v1", error: "not_found" });
				return;
			}
			if (memberRoute && origin !== undefined && !allowedOrigin) {
				response(reply, 403, { schema: "qorpera.cloud-secret-error/v1", error: "unavailable" });
				return;
			}
			if (capture && UUID.test(capture[1])) {
				const descriptor = await this.#broker.capture(
					parseCapture(await readRequest(request), capture[1]),
					AbortSignal.timeout(15_000),
				);
				response(reply, 200, descriptor as unknown as JsonValue, cors);
				return;
			}
			if ((oauthStart && UUID.test(oauthStart[1])) || (oauthConfirm && UUID.test(oauthConfirm[1]))) {
				if (!this.#oauth) {
					response(reply, 404, { schema: "qorpera.cloud-secret-error/v1", error: "not_found" }, cors);
					return;
				}
				if (oauthStart) {
					const start = parseOAuthStart(await readRequest(request));
					const ticketId = oauthStart[1].toLowerCase();
					const summary = await this.#broker.describeCapture(
						{ ticketId, captureCapability: start.captureCapability },
						AbortSignal.timeout(10_000),
					);
					// Connectors are company first: a sign-in fills only a company-owned
					// connection, never a member's own secret.
					if (summary.ownerKind !== "company") throw new Error("Connector sign-in requires a company ticket");
					// The state starts with the ticket's company so the one shared public
					// origin can route the provider's callback to this company's broker.
					const started = this.#oauth.begin({
						ticketId,
						captureCapability: start.captureCapability,
						companyId: summary.companyId,
						connectorId: summary.connectorId,
						returnTo: start.returnTo,
						browserProofSha256: start.browserProofSha256,
					});
					response(
						reply,
						200,
						{
							schema: "qorpera.cloud-connector-oauth-started/v1",
							connectorId: summary.connectorId,
							authorizationUrl: started.authorizationUrl,
							expiresAt: started.expiresAt,
						},
						cors,
					);
					return;
				}
				const confirm = parseOAuthConfirm(await readRequest(request));
				// Worst case 20 s (exchange and account label) + 15 s (seal) = 35 s,
				// inside the web app's 45 s confirm deadline and nginx's 60 s read timeout.
				let completion: Awaited<ReturnType<CloudConnectorOAuthFlows["confirm"]>>;
				try {
					completion = await this.#oauth.confirm(
						{ ticketId: (oauthConfirm as RegExpExecArray)[1], ...confirm },
						AbortSignal.timeout(20_000),
					);
				} catch (error) {
					response(
						reply,
						403,
						{
							schema: "qorpera.cloud-connector-oauth-failed/v1",
							reason: error instanceof CloudConnectorOAuthError ? error.reason : "provider_error",
						},
						cors,
					);
					return;
				}
				try {
					await this.#broker.capture(
						{
							ticketId: completion.ticketId,
							captureCapability: completion.captureCapability,
							fields: completion.fields,
						},
						AbortSignal.timeout(15_000),
						completion.accountLabel,
					);
				} catch {
					response(reply, 403, { schema: "qorpera.cloud-connector-oauth-failed/v1", reason: "expired" }, cors);
					return;
				}
				response(
					reply,
					200,
					{
						schema: "qorpera.cloud-connector-oauth-confirmed/v1",
						connectorId: completion.connectorId,
						accountLabel: completion.accountLabel,
					},
					cors,
				);
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
			// The coding executor's repository token (bundle v88): only the
			// executor's own bearer (never the runtime token every guest holds), the
			// kernel's lease check behind it, and an answer that is never cached.
			// Like operations, the router picks the company's broker by
			// `?company=`; the broker ignores the query.
			if (
				path === "/v1/repository-credentials" &&
				this.#codingExecutorToken !== undefined &&
				tokenMatches(this.#codingExecutorToken, request.headers.authorization)
			) {
				const credential = await this.#broker.repositoryCredential(
					parseRepositoryCredentialRequest(await readRequest(request)),
					AbortSignal.timeout(10_000),
				);
				response(reply, 200, { schema: credential.schema, token: credential.token });
				return;
			}
			response(reply, 404, { schema: "qorpera.cloud-secret-error/v1", error: "not_found" });
		} catch {
			if (!reply.headersSent && !reply.destroyed) {
				response(reply, 403, { schema: "qorpera.cloud-secret-error/v1", error: "unavailable" }, cors);
			} else {
				reply.destroy();
			}
		}
	}

	/** The provider's redirect target. Nothing is sealed here: the browser
	 * leaves with a fragment naming the connector and a one-time confirmation
	 * id (or the failure), never a code or token, and only the browser that
	 * started the sign-in can confirm it. */
	async #oauthCallback(url: URL, reply: ServerResponse): Promise<void> {
		if (!this.#oauth) {
			plainPage(reply, 404, "Not found.");
			return;
		}
		const query = {
			state: url.searchParams.get("state") ?? undefined,
			code: url.searchParams.get("code") ?? undefined,
			error: url.searchParams.get("error") ?? undefined,
		};
		try {
			const receipt = this.#oauth.receive(query);
			redirect(
				reply,
				connectorReturnLocation(receipt.returnTo, receipt.connectorId, "confirm", {
					confirmation: receipt.confirmation,
				}),
			);
		} catch (error) {
			if (error instanceof CloudConnectorOAuthError && error.returnTo && error.connectorId) {
				redirect(
					reply,
					connectorReturnLocation(error.returnTo, error.connectorId, "failed", { reason: error.reason }),
				);
				return;
			}
			plainPage(
				reply,
				400,
				"This sign-in link is no longer valid. Go back to Qorpera and start the connection again.",
			);
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

/**
 * The runner's operation client. Several companies' brokers share one origin
 * (each its own process behind one router), so every request names the
 * company it is for in the query, as member captures do:
 * `/v1/operations?company=<profileId>`. The company is the provider host's own
 * (its compute identity's company, fixed at startup), never model input; the
 * router uses it only to pick a broker, and the broker ignores it and
 * authorizes every operation against the run's database claims, so a request
 * that reaches another company's broker is refused there.
 */
export class HttpCloudSecretBrokerClient {
	readonly #origin: string;
	readonly #runtimeToken: string;
	readonly #companyId: string;
	readonly #fetch: typeof fetch;

	constructor(options: {
		origin: string;
		runtimeToken: string;
		companyId: string;
		allowLoopback?: boolean;
		fetch?: typeof fetch;
	}) {
		this.#origin = brokerOrigin(options.origin, options.allowLoopback);
		if (!TOKEN.test(options.runtimeToken)) throw new Error("Cloud secret broker client token is invalid");
		if (typeof options.companyId !== "string" || !UUID.test(options.companyId))
			throw new Error("Cloud secret broker client company is invalid");
		this.#runtimeToken = options.runtimeToken;
		this.#companyId = options.companyId.toLowerCase();
		this.#fetch = options.fetch ?? fetch;
	}

	async execute(request: CloudSecretOperationRequest, signal: AbortSignal): Promise<CloudToolContent> {
		return withCloudDeadline(
			async (requestSignal) => {
				const responseValue = await this.#fetch(`${this.#origin}/v1/operations?company=${this.#companyId}`, {
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
