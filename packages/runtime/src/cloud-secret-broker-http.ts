import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readBoundedCloudResponse, withCloudDeadline } from "@qorpera/cloud-client/cloud-request";
import type { JsonValue } from "@qorpera/contracts";
import { CHATGPT_PLAN_CONFIRM_ROUTE_MS, ChatGptPlanSignInError } from "./cloud-chatgpt-plan-sign-in.ts";
import {
	COMPANY_ACCOUNT_FILL_REQUEST_SCHEMA,
	COMPANY_ACCOUNT_REQUEST_SCHEMA,
	type CompanyAccountAnswer,
	type CompanyAccountFillAnswer,
	type CompanyAccountFillRequest,
	type CompanyAccountRefusal,
	type CompanyAccountRequest,
	parseCompanyAccountAnswer,
	parseCompanyAccountFillAnswer,
	parseCompanyAccountFillRequest,
	parseCompanyAccountRequest,
} from "./cloud-company-account-vault.ts";
import {
	CloudConnectorOAuthError,
	type CloudConnectorOAuthFlows,
	connectorReturnLocation,
} from "./cloud-connector-oauth.ts";
import {
	type CloudModelLoginVault,
	type ModelLoginIssue,
	type ModelLoginIssueRequest,
	parseModelLoginRunBinding,
} from "./cloud-model-login-vault.ts";
import type { CloudModelLoginSignIns } from "./cloud-model-login-vault-sign-in.ts";
import type { CloudModelLoginUsage } from "./cloud-model-login-vault-usage.ts";
import { parseCloudNativeToolBinding } from "./cloud-native-tool-authority.ts";
import { type CloudToolContent, cloudToolJsonText } from "./cloud-native-tool-boundary.ts";
import {
	CloudSecretBroker,
	type CloudSecretCaptureRequest,
	type CloudSecretDescriptor,
	type CloudSecretOperationRequest,
	type CodingRepositoryCredentialRequest,
	parseCloudSecretAccountLabel,
	parseCodingRepositoryCredentialRequest,
} from "./cloud-secret-broker.ts";
import type { CloudSecretBrokerCompanies } from "./cloud-secret-broker-shared.ts";

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

function parseModelLoginRequest(value: unknown): ModelLoginIssueRequest {
	const input = record(value, "Model login request");
	exact(input, ["schema", "binding", "knownVersion"], "Model login request");
	if (
		input.schema !== "qorpera.model-login-request/v1" ||
		(input.knownVersion !== null &&
			(typeof input.knownVersion !== "number" ||
				!Number.isSafeInteger(input.knownVersion) ||
				input.knownVersion < 1))
	)
		throw new Error("Model login request is invalid");
	return { binding: parseModelLoginRunBinding(input.binding), knownVersion: input.knownVersion };
}

function parseModelLogin(value: unknown): ModelLoginIssue {
	const input = record(value, "Model login");
	// A ChatGPT plan login: the access token alone (null while the host holds this version).
	if (input.loginKind !== undefined) {
		exact(input, ["schema", "loginKind", "version", "accessExpiresAt", "accessToken"], "Model login");
		if (
			input.schema !== "qorpera.model-login/v1" ||
			input.loginKind !== "chatgpt_plan" ||
			typeof input.version !== "number" ||
			!Number.isSafeInteger(input.version) ||
			input.version < 1 ||
			typeof input.accessExpiresAt !== "string" ||
			!Number.isFinite(Date.parse(input.accessExpiresAt)) ||
			(input.accessToken !== null &&
				(typeof input.accessToken !== "string" || !/^[\x21-\x7e]{1,16384}$/.test(input.accessToken)))
		)
			throw new Error("Model login is invalid");
		return {
			schema: "qorpera.model-login/v1",
			loginKind: "chatgpt_plan",
			version: input.version,
			accessExpiresAt: input.accessExpiresAt,
			accessToken: input.accessToken,
		};
	}
	exact(input, ["schema", "version", "accessExpiresAt", "authJson"], "Model login");
	if (
		input.schema !== "qorpera.model-login/v1" ||
		typeof input.version !== "number" ||
		!Number.isSafeInteger(input.version) ||
		input.version < 1 ||
		typeof input.accessExpiresAt !== "string" ||
		!Number.isFinite(Date.parse(input.accessExpiresAt)) ||
		(input.authJson !== null && typeof input.authJson !== "string")
	)
		throw new Error("Model login is invalid");
	return {
		schema: "qorpera.model-login/v1",
		version: input.version,
		accessExpiresAt: input.accessExpiresAt,
		authJson: input.authJson,
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
	/** Model logins in the vault (Stateless Compute step 1): `/v1/model-logins` hands a live
	 * run its login under the runtime token and the database's check of the run's exact native
	 * lease. Absent means the route answers 404. */
	readonly modelLogins?: CloudModelLoginVault;
	/** A member's sign-in to the vault (Stateless Compute step 1, change 2B):
	 * `/v1/model-logins/<company>/login` under the sign-in's own capability. Absent means the
	 * route answers 404. */
	readonly modelLoginSignIns?: CloudModelLoginSignIns;
	/** Usage of the logins the vault keeps (change 2C): `/v1/model-logins/<company>/account-refresh`
	 * under the account refresh's own capability. Absent means the route answers 404. */
	readonly modelLoginUsage?: CloudModelLoginUsage;
}

/** What a request's company gets: a single-company broker's own services (some may be off), or one
 * company's on the shared vault. */
interface RequestScope {
	/** A shared vault's company; a one-company broker's scope names none. */
	readonly companyId?: string;
	readonly broker: CloudSecretBroker;
	readonly modelLogins: CloudModelLoginVault | undefined;
	readonly modelLoginSignIns: CloudModelLoginSignIns | undefined;
	readonly modelLoginUsage: CloudModelLoginUsage | undefined;
}

/**
 * Separate-process broker surface. Capture is authorized only by the one-time
 * member ticket; operation execution additionally requires a private service
 * token and the database's current run/grant/receipt authorization; a coding
 * executor's repository token requires the executor's own separate token and
 * the database's current session lease, repository grant and connection grant.
 */
export class HttpCloudSecretBrokerService {
	/** One company's broker, or the shared vault's companies (Vault By Default). */
	readonly #broker: CloudSecretBroker | undefined;
	readonly #companies: CloudSecretBrokerCompanies | undefined;
	readonly #runtimeToken: string;
	readonly #host: string;
	readonly #port: number;
	readonly #memberOrigins: ReadonlySet<string>;
	readonly #oauth: CloudConnectorOAuthFlows | undefined;
	readonly #codingExecutorToken: string | undefined;
	readonly #modelLogins: CloudModelLoginVault | undefined;
	readonly #modelLoginSignIns: CloudModelLoginSignIns | undefined;
	readonly #modelLoginUsage: CloudModelLoginUsage | undefined;
	#server?: Server;

	constructor(
		target: CloudSecretBroker | CloudSecretBrokerCompanies,
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
		if (target instanceof CloudSecretBroker) this.#broker = target;
		else {
			// The shared vault gets each company's login vault, sign-ins and usage from its own list.
			if (options.modelLogins || options.modelLoginSignIns || options.modelLoginUsage)
				throw new Error("Cloud secret broker service configuration is invalid");
			this.#companies = target;
		}
		this.#runtimeToken = runtimeToken;
		this.#host = host;
		this.#port = listenPort;
		this.#memberOrigins = new Set(origins.map(parseMemberOrigin));
		this.#oauth = options.oauth;
		this.#codingExecutorToken = options.codingExecutorToken;
		this.#modelLogins = options.modelLogins;
		this.#modelLoginSignIns = options.modelLoginSignIns;
		this.#modelLoginUsage = options.modelLoginUsage;
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

	/** The services a request's company gets: this broker's own, or its company's on the shared vault
	 * (the company from the path or the `?company=` every client adds; unknown means not served here). */
	async #scope(companyId: string | undefined): Promise<RequestScope | undefined> {
		const companies = this.#companies;
		if (!companies) {
			return {
				broker: this.#broker as CloudSecretBroker,
				modelLogins: this.#modelLogins,
				modelLoginSignIns: this.#modelLoginSignIns,
				modelLoginUsage: this.#modelLoginUsage,
			};
		}
		if (companyId === undefined || !UUID.test(companyId)) return undefined;
		return companies.resolve(companyId, AbortSignal.timeout(10_000));
	}

	async #handle(request: IncomingMessage, reply: ServerResponse): Promise<void> {
		const url = new URL(request.url ?? "/", "http://cloud-secret-broker.invalid");
		const path = url.pathname;
		const capture = /^\/v1\/captures\/([0-9a-f-]{36})$/i.exec(path);
		const emailDraft = /^\/v1\/email-drafts\/([0-9a-f-]{36})$/i.exec(path);
		const oauthStart = /^\/v1\/oauth\/([0-9a-f-]{36})\/start$/i.exec(path);
		const oauthConfirm = /^\/v1\/oauth\/([0-9a-f-]{36})\/confirm$/i.exec(path);
		const signIn = /^\/v1\/model-logins\/([0-9a-f-]{36})\/login$/i.exec(path);
		const planCallback = /^\/v1\/model-logins\/([0-9a-f-]{36})\/chatgpt-plan\/callback$/i.exec(path);
		const planConfirm = /^\/v1\/model-logins\/([0-9a-f-]{36})\/chatgpt-plan\/confirm$/i.exec(path);
		const accountRefresh = /^\/v1\/model-logins\/([0-9a-f-]{36})\/account-refresh$/i.exec(path);
		const memberRoute = Boolean(
			(capture && UUID.test(capture[1])) ||
				(emailDraft && UUID.test(emailDraft[1])) ||
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
			const companyId = (
				signIn?.[1] ??
				planCallback?.[1] ??
				planConfirm?.[1] ??
				accountRefresh?.[1] ??
				url.searchParams.get("company") ??
				undefined
			)?.toLowerCase();
			const scope = await this.#scope(companyId);
			if (!scope) {
				response(reply, 404, { schema: "qorpera.cloud-secret-error/v1", error: "not_found" }, cors);
				return;
			}
			if (capture && UUID.test(capture[1])) {
				const descriptor = await scope.broker.capture(
					parseCapture(await readRequest(request), capture[1]),
					AbortSignal.timeout(15_000),
				);
				response(reply, 200, descriptor as unknown as JsonValue, cors);
				return;
			}
			if (emailDraft && UUID.test(emailDraft[1])) {
				const input = record(await readRequest(request), "Email draft action");
				exact(input, ["schema", "capability"], "Email draft action");
				if (input.schema !== "qorpera.email-draft-action/v1" || typeof input.capability !== "string")
					throw new Error("Email draft action invalid");
				const state = await scope.broker.executeEmailDraft(
					emailDraft[1],
					input.capability,
					AbortSignal.timeout(60_000),
				);
				response(reply, 200, state, cors);
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
					const summary = await scope.broker.describeCapture(
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
						{
							ticketId: (oauthConfirm as RegExpExecArray)[1],
							...confirm,
							...(scope.companyId === undefined ? {} : { companyId: scope.companyId }),
						},
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
					await scope.broker.capture(
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
				const result = await scope.broker.execute(
					parseOperation(await readRequest(request)),
					AbortSignal.timeout(35_000),
				);
				response(reply, 200, result as unknown as JsonValue);
				return;
			}
			// An agent's company_account tool call (company accounts A1): an account's facts or the
			// database's refusal; a value never leaves here. Same token and company routing as operations.
			if (path === "/v1/company-accounts" && tokenMatches(this.#runtimeToken, request.headers.authorization)) {
				const answer = await scope.broker.companyAccount(
					parseCompanyAccountRequest(await readRequest(request)),
					AbortSignal.timeout(35_000),
				);
				response(reply, 200, answer as unknown as JsonValue);
				return;
			}
			// An agent's vault_fill of the Company Computer's browser (A1-3): the value sealed to that computer's boot
			// key, which only its office service opens; the host only carries the box. Same token and routing.
			if (path === "/v1/company-account-fills" && tokenMatches(this.#runtimeToken, request.headers.authorization)) {
				const answer = await scope.broker.companyAccountFill(
					parseCompanyAccountFillRequest(await readRequest(request)),
					AbortSignal.timeout(35_000),
				);
				response(reply, 200, answer as unknown as JsonValue);
				return;
			}
			// A member's sign-in to the vault (Stateless Compute step 1, change 2B). The login
			// gateway chooser names `<origin>/v1/model-logins/<company>/`; the web client's edge
			// function posts its unchanged sign-in request there, server to server, with the
			// sign-in's capability as bearer (never the runtime token). The database decides
			// whether that capability names a pending sign-in of this broker's company.
			if (signIn && UUID.test(signIn[1]) && scope.modelLoginSignIns !== undefined) {
				const authorization = request.headers.authorization;
				if (typeof authorization !== "string" || !authorization.startsWith("Bearer "))
					throw new Error("Vault sign-in capability is missing");
				const answer = await scope.modelLoginSignIns.signIn(
					{
						companyId: signIn[1],
						capability: authorization.slice("Bearer ".length),
						body: await readRequest(request),
					},
					AbortSignal.timeout(25_000),
				);
				// Only a sign-in the database accepted puts its company on the frequent collection.
				this.#companies?.signingIn(signIn[1]);
				response(reply, 200, { ...answer });
				return;
			}
			// Sign in with ChatGPT: OpenAI's callback for a plan sign-in, forwarded server to server by the
			// callback Edge Function. The state is the only authority; the answer is a one-time confirmation
			// id the Edge Function hands the returning browser (in the page fragment), never a code or token.
			if (planCallback && UUID.test(planCallback[1]) && scope.modelLoginSignIns !== undefined) {
				const input = record(await readRequest(request), "ChatGPT plan callback");
				exact(input, ["schema", "state", "code", "error", "clientId"], "ChatGPT plan callback");
				if (input.schema !== "qorpera.chatgpt-plan-callback/v1")
					throw new Error("ChatGPT plan callback is invalid");
				let answer: JsonValue;
				try {
					const received = scope.modelLoginSignIns.receiveChatGptPlan({
						companyId: planCallback[1],
						state: input.state,
						code: input.code,
						error: input.error,
						clientId: input.clientId,
					});
					answer = {
						schema: "qorpera.chatgpt-plan-callback-result/v1",
						status: "confirm",
						...received,
						reason: null,
					};
				} catch (error) {
					answer = {
						schema: "qorpera.chatgpt-plan-callback-result/v1",
						status: "failed",
						confirmation: null,
						reason: error instanceof ChatGptPlanSignInError ? error.reason : "provider_error",
					};
				}
				response(reply, 200, answer);
				return;
			}
			// The web client's confirmation of a plan sign-in, through its edge function, with the sign-in's
			// capability as bearer: only then is OpenAI's code exchanged and the login sealed.
			if (planConfirm && UUID.test(planConfirm[1]) && scope.modelLoginSignIns !== undefined) {
				const authorization = request.headers.authorization;
				if (typeof authorization !== "string" || !authorization.startsWith("Bearer "))
					throw new Error("Vault sign-in capability is missing");
				let answer: JsonValue;
				try {
					answer = {
						...(await scope.modelLoginSignIns.confirmChatGptPlan(
							{
								companyId: planConfirm[1],
								capability: authorization.slice("Bearer ".length),
								body: await readRequest(request),
							},
							AbortSignal.timeout(CHATGPT_PLAN_CONFIRM_ROUTE_MS),
						)),
					};
				} catch (error) {
					if (!(error instanceof ChatGptPlanSignInError)) throw error;
					answer = { schema: "qorpera.chatgpt-plan-confirm-failed/v1", reason: error.reason };
					response(reply, 403, answer);
					return;
				}
				response(reply, 200, answer);
				return;
			}
			// The usage of the logins the vault keeps (change 2C): the account refresh chooser names
			// the same base; the edge function posts its unchanged refresh with the refresh's own
			// capability as bearer.
			if (accountRefresh && UUID.test(accountRefresh[1]) && scope.modelLoginUsage !== undefined) {
				const authorization = request.headers.authorization;
				if (typeof authorization !== "string" || !authorization.startsWith("Bearer "))
					throw new Error("Vault account refresh capability is missing");
				const answer = await scope.modelLoginUsage.refresh(
					{
						companyId: accountRefresh[1],
						capability: authorization.slice("Bearer ".length),
						body: await readRequest(request),
					},
					AbortSignal.timeout(25_000),
				);
				response(reply, 200, { ...answer });
				return;
			}
			// A live run's model login, without its renewal token (Stateless Compute step 1). The
			// runtime token every native host holds, plus the database's check of the run's exact
			// native lease; never cached. Like operations, the router picks the company's broker by
			// `?company=`; the broker ignores the query.
			if (
				path === "/v1/model-logins" &&
				scope.modelLogins !== undefined &&
				tokenMatches(this.#runtimeToken, request.headers.authorization)
			) {
				const login = await scope.modelLogins.issue(
					parseModelLoginRequest(await readRequest(request)),
					AbortSignal.timeout(60_000),
				);
				response(reply, 200, { ...login });
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
				const credential = await scope.broker.repositoryCredential(
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

	/** One vault_fill (A1-3): a box only the computer's office service opens, or the database's refusal. */
	async companyAccountFill(
		request: CompanyAccountFillRequest,
		signal: AbortSignal,
	): Promise<CompanyAccountFillAnswer | CompanyAccountRefusal> {
		return withCloudDeadline(
			async (requestSignal) => {
				const responseValue = await this.#fetch(
					`${this.#origin}/v1/company-account-fills?company=${this.#companyId}`,
					{
						method: "POST",
						redirect: "error",
						headers: {
							authorization: `Bearer ${this.#runtimeToken}`,
							"content-type": "application/json",
						},
						body: cloudToolJsonText({ schema: COMPANY_ACCOUNT_FILL_REQUEST_SCHEMA, ...request }),
						signal: requestSignal,
					},
				);
				if (!responseValue.ok) {
					void responseValue.body?.cancel().catch(() => undefined);
					throw new Error("Cloud secret broker rejected the company account fill");
				}
				const bytes = await readBoundedCloudResponse(responseValue, MAX_RESPONSE_BYTES, requestSignal);
				try {
					return parseCompanyAccountFillAnswer(
						JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
					);
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

	/** One company_account tool call (A1): the account's facts, or the database's refusal in its own words. */
	async companyAccount(request: CompanyAccountRequest, signal: AbortSignal): Promise<CompanyAccountAnswer> {
		return withCloudDeadline(
			async (requestSignal) => {
				const responseValue = await this.#fetch(`${this.#origin}/v1/company-accounts?company=${this.#companyId}`, {
					method: "POST",
					redirect: "error",
					headers: {
						authorization: `Bearer ${this.#runtimeToken}`,
						"content-type": "application/json",
					},
					body: cloudToolJsonText({ schema: COMPANY_ACCOUNT_REQUEST_SCHEMA, ...request }),
					signal: requestSignal,
				});
				if (!responseValue.ok) {
					void responseValue.body?.cancel().catch(() => undefined);
					throw new Error("Cloud secret broker rejected the company account call");
				}
				const bytes = await readBoundedCloudResponse(responseValue, MAX_RESPONSE_BYTES, requestSignal);
				try {
					return parseCompanyAccountAnswer(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
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

/** The run host's model login client (Stateless Compute step 1). Same origin, token and
 * company routing as operations; the answer is never cached and holds no renewal token. */
export async function issueModelLogin(
	options: { origin: string; runtimeToken: string; companyId: string; allowLoopback?: boolean; fetch?: typeof fetch },
	request: ModelLoginIssueRequest,
	signal: AbortSignal,
): Promise<ModelLoginIssue> {
	const origin = brokerOrigin(options.origin, options.allowLoopback);
	if (!TOKEN.test(options.runtimeToken) || typeof options.companyId !== "string" || !UUID.test(options.companyId))
		throw new Error("Model login client is invalid");
	const body = JSON.stringify({
		schema: "qorpera.model-login-request/v1",
		binding: parseModelLoginRunBinding(request.binding),
		knownVersion: request.knownVersion,
	});
	return withCloudDeadline(
		async (requestSignal) => {
			const responseValue = await (options.fetch ?? fetch)(
				`${origin}/v1/model-logins?company=${options.companyId.toLowerCase()}`,
				{
					method: "POST",
					redirect: "error",
					headers: { authorization: `Bearer ${options.runtimeToken}`, "content-type": "application/json" },
					body,
					signal: requestSignal,
				},
			);
			if (!responseValue.ok) {
				void responseValue.body?.cancel().catch(() => undefined);
				throw new Error("Cloud secret broker refused the model login");
			}
			const bytes = await readBoundedCloudResponse(responseValue, MAX_RESPONSE_BYTES, requestSignal);
			try {
				return parseModelLogin(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
			} catch {
				throw new Error("Cloud secret broker returned an invalid model login");
			} finally {
				bytes.fill(0);
			}
		},
		65_000,
		signal,
	);
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
