import { timingSafeEqual } from "node:crypto";
import {
	createServer as createHttpServer,
	type Server as HttpServer,
	type IncomingMessage,
	type ServerResponse,
} from "node:http";
import { createServer as createHttpsServer, type Server as HttpsServer } from "node:https";
import { isIP } from "node:net";
import { NODE_OBSERVATIONS_PATH, type ProviderNodeObservability } from "./node-observability.ts";
import type { CloudRunnerAssignmentDelivery, CloudRunnerInstance, CloudRunnerWork } from "./orchestrator.ts";
import { validateCloudRunnerWork } from "./orchestrator.ts";

const REQUEST_SCHEMA = "qorpera.runner-provider/v1";
const REQUEST_PATH = "/v1/qorpera-runner-provider";
const ADAPTER_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_REQUEST_BYTES = 256 * 1024;

export interface CloudRunnerProviderServiceBackend {
	readonly adapterId: string;
	reconcile(signal?: AbortSignal): Promise<void>;
	acquire(acquisitionId: string, work: CloudRunnerWork, signal: AbortSignal): Promise<CloudRunnerInstance>;
	deliver(runner: CloudRunnerInstance, delivery: CloudRunnerAssignmentDelivery, signal?: AbortSignal): Promise<void>;
	stop(
		runner: CloudRunnerInstance,
		reason: "delivery_failed" | "idle" | "revoked",
		signal?: AbortSignal,
	): Promise<void>;
	close?(): Promise<void>;
}

export interface CloudRunnerProviderServiceTlsConfig {
	certificate: Buffer;
	privateKey: Buffer;
}

export interface CloudRunnerProviderServiceNetworkOptions {
	trustedSource?: string;
	tls?: CloudRunnerProviderServiceTlsConfig;
	nodeObservations?: ProviderNodeObservability;
}

type ProviderRequest =
	| { action: "reconcile" }
	| { action: "acquire"; acquisitionId: string; work: CloudRunnerWork }
	| { action: "deliver"; runner: CloudRunnerInstance; delivery: CloudRunnerAssignmentDelivery }
	| {
			action: "stop";
			runner: CloudRunnerInstance;
			reason: "delivery_failed" | "idle" | "revoked";
	  };

function record(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} is invalid`);
	return value as Record<string, unknown>;
}

function exactKeys(input: Record<string, unknown>, allowed: readonly string[], label: string): void {
	const allowedKeys = new Set(allowed);
	if (Object.keys(input).some((key) => !allowedKeys.has(key))) throw new Error(`${label} has unknown fields`);
}

function uuid(value: unknown, label: string): string {
	if (typeof value !== "string" || !UUID_PATTERN.test(value)) throw new Error(`${label} is invalid`);
	return value;
}

function parseRunner(value: unknown, adapterId: string): CloudRunnerInstance {
	const input = record(value, "Runner instance");
	exactKeys(
		input,
		[
			"runnerId",
			"logicalComputerId",
			"computeIdentityId",
			"workerClass",
			"providerAdapter",
			"capabilities",
			"templateKey",
			"templateVersion",
			"policySha256",
		],
		"Runner instance",
	);
	if (
		input.providerAdapter !== adapterId ||
		(input.workerClass !== "managed_sandbox" && input.workerClass !== "company_computer") ||
		!Array.isArray(input.capabilities) ||
		input.capabilities.length < 1 ||
		input.capabilities.length > 3 ||
		new Set(input.capabilities).size !== input.capabilities.length ||
		!input.capabilities.every(
			(value) => value === "agent_turn" || value === "git_worktree" || value === "company_substrate",
		) ||
		typeof input.templateKey !== "string" ||
		!/^[a-z][a-z0-9._-]{0,119}$/.test(input.templateKey) ||
		typeof input.templateVersion !== "string" ||
		input.templateVersion !== input.templateVersion.trim() ||
		input.templateVersion.length < 1 ||
		input.templateVersion.length > 120 ||
		typeof input.policySha256 !== "string" ||
		!/^[0-9a-f]{64}$/.test(input.policySha256)
	) {
		throw new Error("Runner instance is invalid");
	}
	return {
		runnerId: uuid(input.runnerId, "Runner id"),
		...(input.logicalComputerId === null || input.logicalComputerId === undefined
			? {}
			: { logicalComputerId: uuid(input.logicalComputerId, "Logical computer id") }),
		...(input.computeIdentityId === null || input.computeIdentityId === undefined
			? {}
			: { computeIdentityId: uuid(input.computeIdentityId, "Compute identity id") }),
		workerClass: input.workerClass,
		providerAdapter: adapterId,
		capabilities: input.capabilities,
		templateKey: input.templateKey,
		templateVersion: input.templateVersion,
		policySha256: input.policySha256,
	};
}

function parseDelivery(value: unknown): CloudRunnerAssignmentDelivery {
	const input = record(value, "Assignment delivery");
	exactKeys(input, ["assignment", "capability", "work"], "Assignment delivery");
	const assignment = record(input.assignment, "Assignment");
	exactKeys(
		assignment,
		["assignmentId", "claimId", "runId", "jobId", "runnerId", "capabilitySha256", "expiresAt"],
		"Assignment",
	);
	if (
		typeof input.capability !== "string" ||
		!/^[A-Za-z0-9_-]{43}$/.test(input.capability) ||
		typeof assignment.capabilitySha256 !== "string" ||
		!/^[0-9a-f]{64}$/.test(assignment.capabilitySha256) ||
		typeof assignment.expiresAt !== "string" ||
		!Number.isFinite(Date.parse(assignment.expiresAt))
	) {
		throw new Error("Assignment delivery is invalid");
	}
	const work = input.work as CloudRunnerWork;
	validateCloudRunnerWork(work);
	return {
		assignment: {
			assignmentId: uuid(assignment.assignmentId, "Assignment id"),
			claimId: uuid(assignment.claimId, "Claim id"),
			runId: uuid(assignment.runId, "Assignment run id"),
			jobId: uuid(assignment.jobId, "Assignment job id"),
			runnerId: uuid(assignment.runnerId, "Assignment runner id"),
			capabilitySha256: assignment.capabilitySha256,
			expiresAt: new Date(assignment.expiresAt).toISOString(),
		},
		capability: input.capability,
		work,
	};
}

function runnerResponse(runner: CloudRunnerInstance): Record<string, unknown> {
	return {
		runner_id: runner.runnerId,
		logical_computer_id: runner.logicalComputerId ?? null,
		compute_identity_id: runner.computeIdentityId ?? null,
		worker_class: runner.workerClass,
		provider_adapter: runner.providerAdapter,
		capabilities: [...runner.capabilities],
		template_key: runner.templateKey,
		template_version: runner.templateVersion,
		policy_sha256: runner.policySha256,
	};
}

export async function executeCloudRunnerProviderRequest(
	backend: CloudRunnerProviderServiceBackend,
	value: unknown,
	signal?: AbortSignal,
): Promise<unknown> {
	const parsed = parseRequest(value, backend.adapterId);
	return executeParsedRequest(backend, parsed, signal);
}

async function executeParsedRequest(
	backend: CloudRunnerProviderServiceBackend,
	parsed: ProviderRequest,
	signal?: AbortSignal,
): Promise<unknown> {
	switch (parsed.action) {
		case "reconcile":
			await backend.reconcile(signal);
			return null;
		case "acquire":
			return runnerResponse(
				await backend.acquire(parsed.acquisitionId, parsed.work, signal ?? new AbortController().signal),
			);
		case "deliver":
			await backend.deliver(parsed.runner, parsed.delivery, signal);
			return null;
		case "stop":
			await backend.stop(parsed.runner, parsed.reason, signal);
			return null;
	}
}

function parseRequest(value: unknown, adapterId: string): ProviderRequest {
	const input = record(value, "Provider request");
	if (input.schema !== REQUEST_SCHEMA || input.adapter_id !== adapterId) {
		throw new Error("Provider request authority is invalid");
	}
	switch (input.action) {
		case "reconcile":
			exactKeys(input, ["schema", "action", "adapter_id"], "Provider reconcile request");
			return { action: "reconcile" };
		case "acquire": {
			exactKeys(input, ["schema", "action", "adapter_id", "acquisition_id", "work"], "Provider acquire request");
			const acquisitionId = uuid(input.acquisition_id, "Acquisition id");
			const work = input.work as CloudRunnerWork;
			validateCloudRunnerWork(work);
			if (acquisitionId !== work.runId) throw new Error("Acquisition id does not name the immutable run");
			return { action: "acquire", acquisitionId, work };
		}
		case "deliver": {
			exactKeys(input, ["schema", "action", "adapter_id", "runner", "delivery"], "Provider delivery request");
			const runner = parseRunner(input.runner, adapterId);
			const delivery = parseDelivery(input.delivery);
			if (
				delivery.assignment.runnerId !== runner.runnerId ||
				delivery.assignment.runId !== delivery.work.runId ||
				delivery.assignment.jobId !== delivery.work.jobId
			) {
				throw new Error("Assignment delivery names inconsistent authority");
			}
			return { action: "deliver", runner, delivery };
		}
		case "stop": {
			exactKeys(input, ["schema", "action", "adapter_id", "runner", "reason"], "Provider stop request");
			if (input.reason !== "delivery_failed" && input.reason !== "idle" && input.reason !== "revoked") {
				throw new Error("Provider stop reason is invalid");
			}
			return { action: "stop", runner: parseRunner(input.runner, adapterId), reason: input.reason };
		}
		default:
			throw new Error("Provider request action is invalid");
	}
}

function tokenMatches(expected: string, authorization: string | undefined): boolean {
	if (!authorization?.startsWith("Bearer ")) return false;
	const received = Buffer.from(authorization.slice("Bearer ".length), "utf-8");
	const wanted = Buffer.from(expected, "utf-8");
	return received.length === wanted.length && timingSafeEqual(received, wanted);
}

function sourceMatches(expected: string, received: string | undefined): boolean {
	return received === expected || received === `::ffff:${expected}`;
}

/** A typed admission refusal (ceiling or node chooser) carries only a fixed reason code; anything
 * else stays an opaque rejection so backend exceptions never reach the journal or the caller. */
function admissionRefusal(error: unknown): { state: "refused" | "deferred"; reason: string } | undefined {
	if (typeof error !== "object" || error === null) return undefined;
	const candidate = error as { category?: unknown; state?: unknown; reason?: unknown };
	if (
		candidate.category !== "admission_refused" ||
		(candidate.state !== "refused" && candidate.state !== "deferred") ||
		typeof candidate.reason !== "string" ||
		!/^[A-Z_]{3,64}$/.test(candidate.reason)
	)
		return undefined;
	return { state: candidate.state, reason: candidate.reason };
}

/** The step a failed request stopped at, as fixed names and codes only (see ProviderStepFailed). */
function stepFailure(error: unknown): Record<string, string | number> | undefined {
	if (typeof error !== "object" || error === null) return undefined;
	const candidate = error as {
		category?: unknown;
		stage?: unknown;
		rpc?: unknown;
		rpcStatus?: unknown;
		rpcCode?: unknown;
	};
	if (
		candidate.category !== "provider_step" ||
		typeof candidate.stage !== "string" ||
		!/^[a-z][a-z_]{1,39}$/.test(candidate.stage)
	)
		return undefined;
	return {
		stage: candidate.stage,
		...(typeof candidate.rpc === "string" && /^qorpera_[a-z0-9_]{1,80}$/.test(candidate.rpc)
			? { rpc: candidate.rpc }
			: {}),
		...(typeof candidate.rpcStatus === "number" &&
		Number.isSafeInteger(candidate.rpcStatus) &&
		candidate.rpcStatus >= 100 &&
		candidate.rpcStatus <= 599
			? { rpcStatus: candidate.rpcStatus }
			: {}),
		...(typeof candidate.rpcCode === "string" && /^(?:[0-9A-Z]{5}|PGRST[0-9X][0-9]{2})$/.test(candidate.rpcCode)
			? { rpcCode: candidate.rpcCode }
			: {}),
	};
}

export class HttpCloudRunnerProviderService {
	readonly #backend: CloudRunnerProviderServiceBackend;
	readonly #token: string;
	readonly #host: string;
	readonly #port: number;
	readonly #trustedSource?: string;
	readonly #tls?: CloudRunnerProviderServiceTlsConfig;
	readonly #nodeObservations?: ProviderNodeObservability;
	#nodeObservationsStarted = false;
	#server?: HttpServer | HttpsServer;

	constructor(
		backend: CloudRunnerProviderServiceBackend,
		token: string,
		host = "127.0.0.1",
		port = 0,
		options: CloudRunnerProviderServiceNetworkOptions = {},
	) {
		if (!ADAPTER_PATTERN.test(backend.adapterId)) throw new Error("Provider adapter id is invalid");
		if (!token.trim() || token.length > 4096 || /[\0\r\n]/.test(token)) throw new Error("Provider token is invalid");
		if (!host.trim() || host.length > 255 || /[\0\r\n]/.test(host)) throw new Error("Provider host is invalid");
		if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) throw new Error("Provider port is invalid");
		if (options.trustedSource !== undefined && isIP(options.trustedSource) !== 4) {
			throw new Error("Provider trusted source must be an IPv4 address");
		}
		if (
			options.tls &&
			(options.tls.certificate.byteLength < 1 ||
				options.tls.certificate.byteLength > 1024 * 1024 ||
				options.tls.privateKey.byteLength < 1 ||
				options.tls.privateKey.byteLength > 1024 * 1024)
		) {
			throw new Error("Provider TLS material is invalid");
		}
		this.#backend = backend;
		this.#token = token;
		this.#host = host;
		this.#port = port;
		this.#trustedSource = options.trustedSource;
		this.#tls = options.tls;
		this.#nodeObservations = options.nodeObservations;
	}

	async start(): Promise<number> {
		if (this.#server) throw new Error("Runner provider service is already started");
		const handle = (request: IncomingMessage, response: ServerResponse): void => {
			void this.#handle(request, response);
		};
		const server = this.#tls
			? createHttpsServer({ cert: this.#tls.certificate, key: this.#tls.privateKey }, handle)
			: createHttpServer(handle);
		this.#server = server;
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(this.#port, this.#host, () => {
				server.off("error", reject);
				resolve();
			});
		});
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("Runner provider address is unavailable");
		try {
			this.#nodeObservations?.start();
			this.#nodeObservationsStarted = this.#nodeObservations !== undefined;
		} catch {
			// Optional diagnostics must never turn a working provider into an outage.
			this.#nodeObservationsStarted = false;
		}
		return address.port;
	}

	async close(): Promise<void> {
		const server = this.#server;
		this.#server = undefined;
		this.#nodeObservationsStarted = false;
		try {
			this.#nodeObservations?.stop();
		} catch {
			// No raw diagnostic error (or error-derived digest) is exported or logged.
		}
		if (!server) return;
		await new Promise<void>((resolve, reject) => {
			server.close((error) => (error ? reject(error) : resolve()));
		});
		await this.#backend.close?.();
	}

	async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
		response.setHeader("cache-control", "no-store");
		if (this.#trustedSource && !sourceMatches(this.#trustedSource, request.socket.remoteAddress)) {
			response.writeHead(403).end();
			return;
		}
		if (request.method === "GET" && request.url === "/healthz") {
			response.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}\n');
			return;
		}
		if (request.method === "GET" && request.url === NODE_OBSERVATIONS_PATH) {
			if (!tokenMatches(this.#token, request.headers.authorization)) {
				response.writeHead(401).end();
				return;
			}
			try {
				if (!this.#nodeObservations || !this.#nodeObservationsStarted) throw new Error("Observations unavailable");
				const encoded = `${JSON.stringify(this.#nodeObservations.snapshot())}\n`;
				response.writeHead(200, { "content-type": "application/json" }).end(encoded);
			} catch {
				response.writeHead(503, { "content-type": "application/json" }).end(
					`${JSON.stringify({
						schema: "qorpera.node-observation-error/v1",
						status: this.#nodeObservations ? "unavailable" : "unknown",
						reason: this.#nodeObservations ? "observation_failed" : "not_configured",
					})}\n`,
				);
			}
			return;
		}
		if (request.method !== "POST" || request.url !== REQUEST_PATH) {
			response.writeHead(404).end();
			return;
		}
		if (!tokenMatches(this.#token, request.headers.authorization)) {
			response.writeHead(401).end();
			return;
		}
		const controller = new AbortController();
		const abort = (): void => controller.abort(new Error("Provider request disconnected"));
		const responseClosed = (): void => {
			if (!response.writableFinished) abort();
		};
		request.once("aborted", abort);
		response.once("close", responseClosed);
		let action: ProviderRequest["action"] | "validation" = "validation";
		try {
			let encoded = "";
			for await (const chunk of request) {
				encoded += Buffer.isBuffer(chunk) ? chunk.toString("utf-8") : String(chunk);
				if (Buffer.byteLength(encoded) > MAX_REQUEST_BYTES) throw new Error("Provider request is too large");
			}
			const parsed = parseRequest(JSON.parse(encoded) as unknown, this.#backend.adapterId);
			action = parsed.action;
			const value = await executeParsedRequest(this.#backend, parsed, controller.signal);
			response.writeHead(200, { "content-type": "application/json" }).end(`${JSON.stringify({ value })}\n`);
		} catch (error) {
			if (controller.signal.aborted) return;
			// The operator journal is telemetry too. Never log a backend exception,
			// which can contain request bodies, private host paths or credentials.
			const refusal = admissionRefusal(error);
			// Which step failed, by its fixed name (and a failed database call's function and code).
			const step = refusal ? undefined : stepFailure(error);
			console.error(
				JSON.stringify({
					schema: "qorpera.provider-request-error/v1",
					providerAdapter: this.#backend.adapterId,
					status: "rejected",
					action,
					errorCategory:
						error instanceof SyntaxError ? "invalid_arguments" : refusal ? "admission_refused" : "unknown",
					...(refusal ? { state: refusal.state, reason: refusal.reason } : {}),
					...step,
				}),
			);
			const status = error instanceof SyntaxError ? 400 : 422;
			response
				.writeHead(status, { "content-type": "application/json" })
				.end(
					refusal
						? `${JSON.stringify({ error: "request rejected", category: "admission_refused", state: refusal.state, reason: refusal.reason })}\n`
						: '{"error":"request rejected"}\n',
				);
		} finally {
			request.off("aborted", abort);
			response.off("close", responseClosed);
		}
	}
}
