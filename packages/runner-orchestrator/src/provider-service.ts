import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
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

export class HttpCloudRunnerProviderService {
	readonly #backend: CloudRunnerProviderServiceBackend;
	readonly #token: string;
	readonly #host: string;
	readonly #port: number;
	#server?: Server;

	constructor(backend: CloudRunnerProviderServiceBackend, token: string, host = "127.0.0.1", port = 0) {
		if (!ADAPTER_PATTERN.test(backend.adapterId)) throw new Error("Provider adapter id is invalid");
		if (!token.trim() || token.length > 4096 || /[\0\r\n]/.test(token)) throw new Error("Provider token is invalid");
		if (!host.trim() || host.length > 255 || /[\0\r\n]/.test(host)) throw new Error("Provider host is invalid");
		if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) throw new Error("Provider port is invalid");
		this.#backend = backend;
		this.#token = token;
		this.#host = host;
		this.#port = port;
	}

	async start(): Promise<number> {
		if (this.#server) throw new Error("Runner provider service is already started");
		const server = createServer((request, response) => {
			void this.#handle(request, response);
		});
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
		return address.port;
	}

	async close(): Promise<void> {
		const server = this.#server;
		this.#server = undefined;
		if (!server) return;
		await new Promise<void>((resolve, reject) => {
			server.close((error) => (error ? reject(error) : resolve()));
		});
		await this.#backend.close?.();
	}

	async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
		response.setHeader("cache-control", "no-store");
		if (request.method === "GET" && request.url === "/healthz") {
			response.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}\n');
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
		request.once("aborted", abort);
		try {
			let encoded = "";
			for await (const chunk of request) {
				encoded += Buffer.isBuffer(chunk) ? chunk.toString("utf-8") : String(chunk);
				if (Buffer.byteLength(encoded) > MAX_REQUEST_BYTES) throw new Error("Provider request is too large");
			}
			const value = await executeCloudRunnerProviderRequest(
				this.#backend,
				JSON.parse(encoded) as unknown,
				controller.signal,
			);
			response.writeHead(200, { "content-type": "application/json" }).end(`${JSON.stringify({ value })}\n`);
		} catch (error) {
			if (controller.signal.aborted) return;
			const status = error instanceof SyntaxError ? 400 : 422;
			response.writeHead(status, { "content-type": "application/json" }).end('{"error":"request rejected"}\n');
		} finally {
			request.off("aborted", abort);
		}
	}
}
