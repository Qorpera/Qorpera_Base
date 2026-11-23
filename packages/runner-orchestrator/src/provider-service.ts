import { timingSafeEqual } from "node:crypto";
import {
	createServer as createHttpServer,
	type Server as HttpServer,
	type IncomingMessage,
	type ServerResponse,
} from "node:http";
import { createServer as createHttpsServer, type Server as HttpsServer } from "node:https";
import { isIP } from "node:net";
import { SURFACE_SOURCE_KINDS, type SurfaceSourceKind } from "@qorpera/contracts";
import { NODE_OBSERVATIONS_PATH, type ProviderNodeObservability } from "./node-observability.ts";
import type { CloudRunnerAssignmentDelivery, CloudRunnerInstance, CloudRunnerWork } from "./orchestrator.ts";
import { validateCloudRunnerWork } from "./orchestrator.ts";
import type { ClaimedSurfaceSessionJob, ClaimedSurfaceSessionSponsor } from "./surface-worker-loop.ts";

const REQUEST_SCHEMA = "qorpera.runner-provider/v1";
const REQUEST_PATH = "/v1/qorpera-runner-provider";
const ADAPTER_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_REQUEST_BYTES = 256 * 1024;
const DEFAULT_MAX_CONCURRENT_SURFACE_DELIVERIES = 32;
const MAX_CONCURRENT_SURFACE_DELIVERIES_LIMIT = 256;

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
	deliverSurfaceSession?(job: ClaimedSurfaceSessionJob, machineId: string, signal?: AbortSignal): Promise<void>;
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
	maxConcurrentSurfaceDeliveries?: number;
}

type ProviderRequest =
	| { action: "reconcile" }
	| { action: "acquire"; acquisitionId: string; work: CloudRunnerWork }
	| { action: "deliver"; runner: CloudRunnerInstance; delivery: CloudRunnerAssignmentDelivery }
	| {
			action: "stop";
			runner: CloudRunnerInstance;
			reason: "delivery_failed" | "idle" | "revoked";
	  }
	| {
			action: "surface_session";
			machineId: string;
			session: ClaimedSurfaceSessionJob;
	  };

const SURFACE_SOURCE_KIND_SET: ReadonlySet<string> = new Set(SURFACE_SOURCE_KINDS);

function optionalBoundedString(value: unknown, label: string, maximum: number): string | null {
	if (value === null || value === undefined) return null;
	if (typeof value !== "string" || value.length > maximum || value.includes("\0")) {
		throw new Error(`${label} is invalid`);
	}
	return value;
}

function parseSurfaceSession(value: unknown): ClaimedSurfaceSessionJob {
	const input = record(value, "Surface session");
	exactKeys(
		input,
		[
			"sessionId",
			"surfaceId",
			"profileId",
			"state",
			"prompt",
			"originKind",
			"originRef",
			"repositoryKey",
			"folderRoot",
			"surfaceSlug",
			"surfaceTitle",
			"surfaceArchetype",
			"surfaceSourceKind",
			"surfaceKind",
			"explorationId",
			"explorationVariantLabel",
			"siteSlug",
			"identityFolderRoot",
			"productFolderRoots",
			"briefSummary",
			"retryCount",
			"sponsor",
			"leaseToken",
			"placement",
		],
		"Surface session",
	);
	if (input.state !== "queued" && input.state !== "reconciling") {
		throw new Error("Surface session state is invalid");
	}
	if (typeof input.prompt !== "string" || input.prompt.length > 32_000 || input.prompt.includes("\0")) {
		throw new Error("Surface session prompt is invalid");
	}
	if (
		typeof input.originKind !== "string" ||
		input.originKind.trim().length < 1 ||
		input.originKind.length > 64 ||
		/[\0\r\n]/.test(input.originKind)
	) {
		throw new Error("Surface session origin kind is invalid");
	}
	const placement = record(input.placement, "Surface session placement");
	exactKeys(placement, ["strategy", "machineId", "activeTurns", "targetDensity"], "Surface session placement");
	if (
		(placement.strategy !== "reuse_machine" && placement.strategy !== "spawn_overflow_machine") ||
		!Number.isSafeInteger(placement.activeTurns) ||
		(placement.activeTurns as number) < 0 ||
		(placement.activeTurns as number) > 100_000 ||
		!Number.isSafeInteger(placement.targetDensity) ||
		(placement.targetDensity as number) < 1 ||
		(placement.targetDensity as number) > 10_000
	) {
		throw new Error("Surface session placement is invalid");
	}
	const placementMachineId =
		placement.machineId === null || placement.machineId === undefined
			? null
			: uuid(placement.machineId, "Placement machine id");
	let surfaceSourceKind: SurfaceSourceKind | undefined;
	if (input.surfaceSourceKind !== undefined && input.surfaceSourceKind !== null) {
		if (typeof input.surfaceSourceKind !== "string" || !SURFACE_SOURCE_KIND_SET.has(input.surfaceSourceKind)) {
			throw new Error("Surface source kind is invalid");
		}
		surfaceSourceKind = input.surfaceSourceKind as SurfaceSourceKind;
	}
	const explorationId =
		input.explorationId === undefined
			? undefined
			: input.explorationId === null
				? null
				: uuid(input.explorationId, "Surface exploration id");
	let retryCount: number | undefined;
	if (input.retryCount !== undefined && input.retryCount !== null) {
		if (
			!Number.isSafeInteger(input.retryCount) ||
			(input.retryCount as number) < 0 ||
			(input.retryCount as number) > 10_000
		) {
			throw new Error("Surface session retry count is invalid");
		}
		retryCount = input.retryCount as number;
	}
	let sponsor: ClaimedSurfaceSessionSponsor | null | undefined;
	if (input.sponsor !== undefined) {
		if (input.sponsor === null) {
			sponsor = null;
		} else {
			const rawSponsor = record(input.sponsor, "Surface session sponsor");
			exactKeys(rawSponsor, ["sponsorBindingId", "sponsorVersion"], "Surface session sponsor");
			if (
				!Number.isSafeInteger(rawSponsor.sponsorVersion) ||
				(rawSponsor.sponsorVersion as number) < 1 ||
				(rawSponsor.sponsorVersion as number) > 1_000_000
			) {
				throw new Error("Surface session sponsor version is invalid");
			}
			sponsor = {
				sponsorBindingId: uuid(rawSponsor.sponsorBindingId, "Surface sponsor binding id"),
				sponsorVersion: rawSponsor.sponsorVersion as number,
			};
		}
	}
	const folderRoot =
		input.folderRoot === undefined ? undefined : optionalBoundedString(input.folderRoot, "Surface folder root", 256);
	const surfaceSlug =
		input.surfaceSlug === undefined || input.surfaceSlug === null
			? undefined
			: (optionalBoundedString(input.surfaceSlug, "Surface slug", 64) ?? undefined);
	const surfaceTitle =
		input.surfaceTitle === undefined || input.surfaceTitle === null
			? undefined
			: (optionalBoundedString(input.surfaceTitle, "Surface title", 160) ?? undefined);
	const surfaceArchetype =
		input.surfaceArchetype === undefined || input.surfaceArchetype === null
			? undefined
			: (optionalBoundedString(input.surfaceArchetype, "Surface archetype", 32) ?? undefined);
	const surfaceKind =
		input.surfaceKind === undefined || input.surfaceKind === null
			? undefined
			: (optionalBoundedString(input.surfaceKind, "Surface kind", 64) ?? undefined);
	const explorationVariantLabel =
		input.explorationVariantLabel === undefined
			? undefined
			: optionalBoundedString(input.explorationVariantLabel, "Surface exploration variant label", 120);
	const siteSlug =
		input.siteSlug === undefined ? undefined : optionalBoundedString(input.siteSlug, "Surface site slug", 64);
	const identityFolderRoot =
		input.identityFolderRoot === undefined
			? undefined
			: optionalBoundedString(input.identityFolderRoot, "Surface identity folder root", 256);
	let productFolderRoots: string[] | undefined;
	if (input.productFolderRoots !== undefined && input.productFolderRoots !== null) {
		if (!Array.isArray(input.productFolderRoots) || input.productFolderRoots.length > 32) {
			throw new Error("Surface product folder roots are invalid");
		}
		productFolderRoots = input.productFolderRoots.map((item) => {
			if (typeof item !== "string" || item.trim().length < 1 || item.length > 256 || /[\0\r\n]/.test(item)) {
				throw new Error("Surface product folder roots are invalid");
			}
			return item;
		});
	}
	const briefSummary =
		input.briefSummary === undefined
			? undefined
			: optionalBoundedString(input.briefSummary, "Surface brief summary", 4000);
	const leaseToken =
		input.leaseToken === undefined
			? undefined
			: input.leaseToken === null
				? null
				: uuid(input.leaseToken, "Surface lease token");
	return {
		sessionId: uuid(input.sessionId, "Surface session id"),
		surfaceId: uuid(input.surfaceId, "Surface id"),
		profileId: uuid(input.profileId, "Surface profile id"),
		state: input.state,
		prompt: input.prompt,
		originKind: input.originKind,
		originRef: input.originRef === undefined ? null : structuredClone(input.originRef),
		repositoryKey: optionalBoundedString(input.repositoryKey, "Surface repository key", 200),
		...(folderRoot !== undefined ? { folderRoot } : {}),
		...(surfaceSlug !== undefined ? { surfaceSlug } : {}),
		...(surfaceTitle !== undefined ? { surfaceTitle } : {}),
		...(surfaceArchetype !== undefined ? { surfaceArchetype } : {}),
		...(surfaceSourceKind !== undefined ? { surfaceSourceKind } : {}),
		...(surfaceKind !== undefined ? { surfaceKind } : {}),
		...(explorationId !== undefined ? { explorationId } : {}),
		...(explorationVariantLabel !== undefined ? { explorationVariantLabel } : {}),
		...(siteSlug !== undefined ? { siteSlug } : {}),
		...(identityFolderRoot !== undefined ? { identityFolderRoot } : {}),
		...(productFolderRoots !== undefined ? { productFolderRoots } : {}),
		...(briefSummary !== undefined ? { briefSummary } : {}),
		...(retryCount !== undefined ? { retryCount } : {}),
		...(sponsor !== undefined ? { sponsor } : {}),
		...(leaseToken !== undefined ? { leaseToken } : {}),
		placement: {
			strategy: placement.strategy,
			machineId: placementMachineId,
			activeTurns: placement.activeTurns as number,
			targetDensity: placement.targetDensity as number,
		},
	};
}

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
		case "surface_session":
			await backend.deliverSurfaceSession?.(parsed.session, parsed.machineId, signal);
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
		case "surface_session": {
			exactKeys(
				input,
				["schema", "action", "adapter_id", "machine_id", "session"],
				"Provider surface session request",
			);
			return {
				action: "surface_session",
				machineId: uuid(input.machine_id, "Machine id"),
				session: parseSurfaceSession(input.session),
			};
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
	readonly #maxConcurrentSurfaceDeliveries: number;
	readonly #surfaceDeliveries = new Set<Promise<void>>();
	#surfaceController = new AbortController();
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
		const maxSurface = options.maxConcurrentSurfaceDeliveries ?? DEFAULT_MAX_CONCURRENT_SURFACE_DELIVERIES;
		if (!Number.isSafeInteger(maxSurface) || maxSurface < 1 || maxSurface > MAX_CONCURRENT_SURFACE_DELIVERIES_LIMIT) {
			throw new Error("Provider maxConcurrentSurfaceDeliveries is invalid");
		}
		this.#backend = backend;
		this.#token = token;
		this.#host = host;
		this.#port = port;
		this.#trustedSource = options.trustedSource;
		this.#tls = options.tls;
		this.#nodeObservations = options.nodeObservations;
		this.#maxConcurrentSurfaceDeliveries = maxSurface;
	}

	async start(): Promise<number> {
		if (this.#server) throw new Error("Runner provider service is already started");
		this.#surfaceController = new AbortController();
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
		this.#surfaceController.abort(new Error("Provider service stopping"));
		try {
			this.#nodeObservations?.stop();
		} catch {
			// No raw diagnostic error (or error-derived digest) is exported or logged.
		}
		if (!server) return;
		await new Promise<void>((resolve, reject) => {
			server.close((error) => (error ? reject(error) : resolve()));
		});
		await Promise.allSettled([...this.#surfaceDeliveries]);
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
			const chunks: Buffer[] = [];
			let totalBytes = 0;
			for await (const chunk of request) {
				const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), "utf-8");
				totalBytes += buf.byteLength;
				if (totalBytes > MAX_REQUEST_BYTES) throw new Error("Provider request is too large");
				chunks.push(buf);
			}
			const encoded =
				chunks.length === 0
					? ""
					: chunks.length === 1
						? chunks[0]!.toString("utf-8")
						: Buffer.concat(chunks, totalBytes).toString("utf-8");
			const parsed = parseRequest(JSON.parse(encoded) as unknown, this.#backend.adapterId);
			action = parsed.action;
			if (parsed.action === "surface_session") {
				const deliver = this.#backend.deliverSurfaceSession;
				if (!deliver) {
					response
						.writeHead(501, { "content-type": "application/json" })
						.end(`${JSON.stringify({ error: "Surface session execution is not enabled on this provider" })}\n`);
					return;
				}
				if (this.#surfaceDeliveries.size >= this.#maxConcurrentSurfaceDeliveries) {
					response
						.writeHead(429, { "content-type": "application/json", "retry-after": "5" })
						.end(`${JSON.stringify({ error: "Provider surface session capacity reached" })}\n`);
					return;
				}
				// WHY: Acknowledge delivery immediately with 202 so a long surface turn never stalls orchestrator claim ticks.
				const deliverySignal = this.#surfaceController.signal;
				const delivery = Promise.resolve()
					.then(() => deliver(parsed.session, parsed.machineId, deliverySignal))
					.catch((error) => {
						if (deliverySignal.aborted) return;
						console.error(
							JSON.stringify({
								schema: "qorpera.provider-surface-error/v1",
								providerAdapter: this.#backend.adapterId,
								sessionId: parsed.session.sessionId,
								errorCategory: error instanceof Error ? error.name : "unknown",
							}),
						);
					})
					.finally(() => {
						this.#surfaceDeliveries.delete(delivery);
					});
				this.#surfaceDeliveries.add(delivery);
				response.writeHead(202, { "content-type": "application/json" }).end('{"ok":true}\n');
				return;
			}
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
