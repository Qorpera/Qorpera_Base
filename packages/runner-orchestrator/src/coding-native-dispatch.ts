import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { type FileHandle, open } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { type CloudCodingWorker, parseCloudCodingWorker } from "@qorpera/contracts";
import { FileRunnerOrchestratorControlTokenStore } from "./control-token-store.ts";
import type { ServiceHttpFetch } from "./http-transport.ts";
import {
	type CloudRunnerOrchestrationClaim,
	CloudRunnerOrchestrator,
	type CloudRunnerOrchestratorControlPlane,
	type CloudRunnerProviderAdapter,
	type CloudRunnerWork,
	SupabaseCloudRunnerOrchestratorControlPlane,
} from "./orchestrator.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const CODING_NATIVE_DISPATCH_RPCS = [
	"qorpera_prepare_coding_execution",
	"qorpera_materialize_wake_execution_runs",
	"qorpera_describe_coding_execution",
	"qorpera_claim_coding_execution",
] as const;
export interface CodingNativeDispatchControl {
	call(
		method: (typeof CODING_NATIVE_DISPATCH_RPCS)[number],
		args: Record<string, unknown>,
		signal: AbortSignal,
	): Promise<unknown>;
}
export interface CodingNativeTurnResult {
	worker: CloudCodingWorker;
	runId: string;
	jobId: string;
	occurrenceId: string;
	finish: {
		schema: "qorpera.coding-finish/v1";
		requestId: string;
		workerId: string;
		turn: number;
		state: "ready-to-publish";
		summary: string;
		headSha: string;
	};
}
export interface CodingNativeDispatchOptions {
	requestId: string;
	leaseToken: string;
	orchestratorId: string;
	controlPlaneConfig: {
		supabaseUrl: string;
		publishableKey: string;
		controlToken: string;
		controlStatePath: string;
		fetch?: ServiceHttpFetch;
	};
	providerAdapter: CloudRunnerProviderAdapter;
	codingControl: CodingNativeDispatchControl;
	signal: AbortSignal;
	pollIntervalMs?: number;
}
interface Descriptor {
	requestId: string;
	worker: CloudCodingWorker;
	runId: string | null;
	jobId: string | null;
	occurrenceId: string;
	admissionState: string;
	finish: CodingNativeTurnResult["finish"] | null;
}
function record(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Coding native descriptor invalid");
	return value as Record<string, unknown>;
}
function descriptor(value: unknown, requestId: string): Descriptor {
	const input = record(value);
	const worker = parseCloudCodingWorker(input.worker);
	if (
		input.schema !== "qorpera.coding-execution/v1" ||
		input.requestId !== requestId ||
		input.workerId !== worker.id ||
		input.turn !== worker.turn ||
		input.vmId !== worker.vmId ||
		worker.vmId === null ||
		typeof input.occurrenceId !== "string" ||
		!UUID.test(input.occurrenceId) ||
		!["queued", "materialized", "completed", "failed", "cancelled", "requires_review"].includes(
			String(input.admissionState),
		) ||
		![input.runId, input.jobId].every((id) => id === null || (typeof id === "string" && UUID.test(id))) ||
		(input.runId === null) !== (input.jobId === null)
	)
		throw new Error("Coding native descriptor differs");
	let finish: Descriptor["finish"] = null;
	if (input.finish !== null) {
		const f = record(input.finish);
		if (
			Object.keys(f).sort().join() !== "headSha,requestId,schema,state,summary,turn,workerId" ||
			f.schema !== "qorpera.coding-finish/v1" ||
			f.requestId !== requestId ||
			f.workerId !== worker.id ||
			f.turn !== worker.turn ||
			f.state !== "ready-to-publish" ||
			typeof f.summary !== "string" ||
			!f.summary.trim() ||
			Buffer.byteLength(f.summary) > 4000 ||
			typeof f.headSha !== "string" ||
			!/^[0-9a-f]{40}$/.test(f.headSha)
		)
			throw new Error("Coding native finish invalid");
		finish = Object.freeze({ ...f }) as unknown as Descriptor["finish"];
	}
	return {
		requestId,
		worker,
		occurrenceId: input.occurrenceId,
		runId: input.runId as string | null,
		jobId: input.jobId as string | null,
		admissionState: String(input.admissionState),
		finish,
	};
}
function sameDescriptor(first: Descriptor, next: Descriptor): void {
	if (
		first.occurrenceId !== next.occurrenceId ||
		first.worker.id !== next.worker.id ||
		first.worker.vmId !== next.worker.vmId ||
		first.worker.turn !== next.worker.turn ||
		first.worker.companyId !== next.worker.companyId ||
		first.worker.branch !== next.worker.branch ||
		JSON.stringify(first.worker.repository) !== JSON.stringify(next.worker.repository) ||
		(first.runId !== null && first.runId !== next.runId) ||
		(first.jobId !== null && first.jobId !== next.jobId)
	)
		throw new Error("Coding native identity changed");
}
function completed(value: Descriptor): CodingNativeTurnResult | undefined {
	if (["failed", "cancelled", "requires_review"].includes(value.admissionState))
		throw new Error("Coding native admission failed");
	if (value.admissionState !== "completed") return;
	if (!value.finish || !value.runId || !value.jobId)
		throw new Error("Coding native completion has no durable submission");
	return {
		worker: value.worker,
		runId: value.runId,
		jobId: value.jobId,
		occurrenceId: value.occurrenceId,
		finish: value.finish,
	};
}
async function retainDispatch(path: string, value: unknown): Promise<boolean> {
	const encoded = JSON.stringify(value);
	let file: FileHandle;
	try {
		file = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		const retained = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
		try {
			const stat = await retained.stat();
			if (
				!stat.isFile() ||
				stat.nlink !== 1 ||
				stat.uid !== process.getuid?.() ||
				(stat.mode & 0o077) !== 0 ||
				stat.size > 4096 ||
				(await retained.readFile("utf8")) !== encoded
			)
				throw new Error("Coding native dispatch intent differs");
		} finally {
			await retained.close();
		}
		return false;
	}
	try {
		await file.writeFile(encoded);
		await file.sync();
	} finally {
		await file.close();
	}
	const directory = await open(dirname(path), constants.O_RDONLY);
	try {
		await directory.sync();
	} finally {
		await directory.close();
	}
	return true;
}

/** One exact coding request enters the canonical orchestrator. The private
 * intent is retained before dispatch; a lost assignment/delivery never causes
 * this adapter to dispatch again, including after process replacement. */
export async function runCodingNativeTurn(options: CodingNativeDispatchOptions): Promise<CodingNativeTurnResult> {
	if (![options.requestId, options.leaseToken, options.orchestratorId].every((id) => UUID.test(id)))
		throw new Error("Invalid coding native identity");
	const pollMs = options.pollIntervalMs ?? 1000;
	if (!Number.isSafeInteger(pollMs) || pollMs < 10 || pollMs > 60000)
		throw new Error("Invalid coding native poll interval");
	const signal = AbortSignal.any([options.signal, AbortSignal.timeout(1800000)]);
	const args = { p_request_id: options.requestId, p_lease_token: options.leaseToken };
	const call = (method: (typeof CODING_NATIVE_DISPATCH_RPCS)[number], parameters: Record<string, unknown> = args) =>
		options.codingControl.call(method, parameters, AbortSignal.any([signal, AbortSignal.timeout(30000)]));
	const admission = record(await call("qorpera_prepare_coding_execution"));
	if (
		admission.schema !== "qorpera.coding-execution-admission/v1" ||
		admission.requestId !== options.requestId ||
		typeof admission.occurrenceId !== "string" ||
		!UUID.test(admission.occurrenceId)
	)
		throw new Error("Coding native admission differs");
	let current = descriptor(await call("qorpera_describe_coding_execution"), options.requestId);
	if (current.occurrenceId !== admission.occurrenceId) throw new Error("Coding native occurrence differs");
	const initial = current;
	for (;;) {
		signal.throwIfAborted();
		const result = completed(current);
		if (result) return result;
		if (current.admissionState === "materialized" && current.runId && current.jobId) break;
		await call("qorpera_materialize_wake_execution_runs", { p_limit: 32 });
		await setTimeout(pollMs, undefined, { signal });
		current = descriptor(await call("qorpera_describe_coding_execution"), options.requestId);
		sameDescriptor(initial, current);
	}
	const pinned = current;
	const assertWork = (work: CloudRunnerWork): void => {
		const payload = record(work.payload);
		if (
			work.runId !== pinned.runId ||
			work.jobId !== pinned.jobId ||
			work.profileId !== pinned.worker.companyId ||
			work.sourceKind !== "wake" ||
			work.sourceId !== pinned.occurrenceId ||
			Object.keys(payload).sort().join() !== "occurrenceId,requestId,schema" ||
			payload.schema !== "qorpera.coding-run/v1" ||
			payload.requestId !== options.requestId ||
			payload.occurrenceId !== pinned.occurrenceId
		)
			throw new Error("Coding native claim is outside exact request");
	};
	const config = options.controlPlaneConfig;
	const store = new FileRunnerOrchestratorControlTokenStore(config.controlStatePath);
	const tokens = await store.load(config.controlToken);
	const clientClaimId = createHash("sha256")
		.update(`qorpera.coding-native-claim/v1:${options.orchestratorId}:${options.requestId}`)
		.digest("hex");
	const claimId = `${clientClaimId.slice(0, 8)}-${clientClaimId.slice(8, 12)}-4${clientClaimId.slice(13, 16)}-8${clientClaimId.slice(17, 20)}-${clientClaimId.slice(20, 32)}`;
	const transport = config.fetch ?? fetch;
	const targetedFetch: ServiceHttpFetch = async (url, init) => {
		const request = record(JSON.parse(String(init?.body)));
		if (request.action !== "claim") return transport(url, init);
		if (request.orchestratorId !== options.orchestratorId || request.clientClaimId !== claimId)
			throw new Error("Coding native claim target changed");
		const value = await call("qorpera_claim_coding_execution", {
			...args,
			p_orchestrator_id: options.orchestratorId,
			p_client_claim_id: claimId,
		});
		return new Response(JSON.stringify({ value }), { status: 200 });
	};
	const base = new SupabaseCloudRunnerOrchestratorControlPlane(
		config.supabaseUrl,
		config.publishableKey,
		options.orchestratorId,
		tokens.current,
		targetedFetch,
		{ pendingControlToken: tokens.pending, persistControlTokens: (value) => store.save(value) },
	);
	const checked = (claim: CloudRunnerOrchestrationClaim): CloudRunnerOrchestrationClaim => {
		if (claim.claimId !== claimId || claim.orchestratorId !== options.orchestratorId)
			throw new Error("Coding native claim identity changed");
		assertWork(claim.work);
		return claim;
	};
	const control: CloudRunnerOrchestratorControlPlane = {
		renewControl: (s) => base.renewControl(s),
		listRoutineScheduleHeads: async () => ({ items: [], hasMore: false }),
		enqueueRoutineWake: async () => {
			throw new Error("Coding native adapter cannot enqueue unrelated wakes");
		},
		reconcileExpired: async () => undefined,
		retainedClaims: async () => [],
		claimNext: async (id, client, seconds, s) => {
			const claim = await base.claimNext(id, client, seconds, s);
			if (!claim) throw new Error("Coding native claim missing");
			return checked(claim);
		},
		renewClaim: async (claim, seconds, s) => checked(await base.renewClaim(checked(claim), seconds, s)),
		assign: (claim, runner, assignmentId, hash, seconds, s) =>
			base.assign(checked(claim), runner, assignmentId, hash, seconds, s),
		releaseClaim: (claim, assignmentId, error, s) => base.releaseClaim(checked(claim), assignmentId, error, s),
	};
	const provider: CloudRunnerProviderAdapter = {
		adapterId: options.providerAdapter.adapterId,
		reconcile: async () => undefined,
		acquire: (work, s) => {
			assertWork(work);
			return options.providerAdapter.acquire(work, s);
		},
		deliver: (runner, delivery, s) => {
			assertWork(delivery.work);
			return options.providerAdapter.deliver(runner, delivery, s);
		},
		stop: (runner, reason, s) => options.providerAdapter.stop(runner, reason, s),
	};
	const dispatch = await retainDispatch(
		join(dirname(config.controlStatePath), `coding-native-${options.requestId}.json`),
		{
			schema: "qorpera.coding-native-dispatch-intent/v1",
			requestId: options.requestId,
			leaseToken: options.leaseToken,
			orchestratorId: options.orchestratorId,
			workerId: pinned.worker.id,
			vmId: pinned.worker.vmId,
			turn: pinned.worker.turn,
			runId: pinned.runId,
			jobId: pinned.jobId,
			occurrenceId: pinned.occurrenceId,
		},
	);
	if (dispatch) {
		const result = await new CloudRunnerOrchestrator({
			orchestratorId: options.orchestratorId,
			controlPlane: control,
			providerAdapter: provider,
			clientClaimId: () => claimId,
		}).runOnce(signal);
		if (result.status === "idle") throw new Error("Coding native dispatch unconfirmed");
	}
	for (;;) {
		signal.throwIfAborted();
		current = descriptor(await call("qorpera_describe_coding_execution"), options.requestId);
		sameDescriptor(pinned, current);
		const result = completed(current);
		if (result) return result;
		await setTimeout(pollMs, undefined, { signal });
	}
}
