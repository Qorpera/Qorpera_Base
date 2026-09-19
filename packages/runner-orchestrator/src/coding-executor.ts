import { setTimeout } from "node:timers/promises";
import {
	type CloudCodingDispatch,
	type CloudCodingPullRequest,
	type CloudCodingWorker,
	parseCloudCodingDispatch,
	parseCloudCodingWorker,
} from "@qorpera/contracts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const CODING_EXECUTOR_RPCS = [
	"qorpera_claim_coding_request",
	"qorpera_heartbeat_coding_request",
	"qorpera_prepare_coding_execution",
	"qorpera_describe_coding_execution",
	"qorpera_describe_coding_cancellation",
	"qorpera_record_coding_progress",
	"qorpera_complete_coding_request",
] as const;
export interface CodingExecutorControl {
	call(
		method: (typeof CODING_EXECUTOR_RPCS)[number],
		args: Record<string, unknown>,
		signal: AbortSignal,
	): Promise<unknown>;
}
export interface CodingExecutorClaim {
	requestId: string;
	leaseToken: string;
	leaseUntil: string;
	environmentId: string;
	worker: CloudCodingWorker;
	dispatch: CloudCodingDispatch;
	kind: "dispatch" | "followup" | "cancel";
	goal: string;
}
export interface CodingExecutorPublication {
	readonly summary: string;
	readonly pullRequest: CloudCodingPullRequest | null;
	/** True only after a trusted comparison against the pinned original head. */
	readonly noChange: boolean;
}
export interface CodingExecutorHost {
	/** Reserve genuine company/node capacity, reconcile retained LXD VM and
	 * initialize a credential-free checkout from a pinned seed exactly once.
	 * Return current SQL worker after machine assignment (which increments CAS).
	 * Implementations must never call the model before this resolves. */
	prepareWorkspace(claim: CodingExecutorClaim, signal: AbortSignal): Promise<CloudCodingWorker>;
	/** Refresh the guest monotonic lease only from this confirmed SQL deadline.
	 * A host must never extend it beyond the remaining queue lease. */
	refreshLease(claim: CodingExecutorClaim, signal: AbortSignal): Promise<void>;
	/** Uses the separately admitted coding-dispatch native run, canonical
	 * orchestrator claim, assignment and credential lease. Resolves only after
	 * the native job is complete, never when merely delivered to a runner. */
	runNative(claim: CodingExecutorClaim, signal: AbortSignal): Promise<void>;
	/** Quiesce and verify guest command cgroups, read durable native submission,
	 * export exact commit bundle, push and verify the same worker draft PR.
	 * Must retain its own effect journals across process restarts. */
	publish(claim: CodingExecutorClaim, signal: AbortSignal): Promise<CodingExecutorPublication>;
	/** Independent cleanup custody. Must stop the actual VM/cgroups and verify
	 * stopped state even if work authorization was revoked. Retains disk and
	 * never releases capacity merely because a request lease expired. */
	stopWorkspace(claim: CodingExecutorClaim, signal: AbortSignal): Promise<void>;
}

function parseClaim(value: unknown): CodingExecutorClaim {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid coding claim");
	const item = value as Record<string, unknown>;
	if (
		Object.keys(item).sort().join() !== "dispatch,environmentId,goal,kind,leaseToken,leaseUntil,requestId,worker" ||
		![item.requestId, item.leaseToken, item.environmentId].every((id) => typeof id === "string" && UUID.test(id)) ||
		typeof item.leaseUntil !== "string" ||
		!Number.isFinite(Date.parse(item.leaseUntil)) ||
		Date.parse(item.leaseUntil) <= Date.now() ||
		!["dispatch", "followup", "cancel"].includes(String(item.kind)) ||
		typeof item.goal !== "string" ||
		!item.goal.trim() ||
		Buffer.byteLength(item.goal) > 8192
	)
		throw new Error("Invalid coding claim");
	const worker = parseCloudCodingWorker(item.worker);
	const dispatch = parseCloudCodingDispatch(item.dispatch);
	if (JSON.stringify(worker.repository) !== JSON.stringify(dispatch.repository))
		throw new Error("Coding claim repository differs");
	return {
		requestId: String(item.requestId),
		leaseToken: String(item.leaseToken),
		leaseUntil: item.leaseUntil,
		environmentId: String(item.environmentId),
		worker,
		dispatch,
		kind: item.kind as CodingExecutorClaim["kind"],
		goal: item.goal,
	};
}

/** Serial owner of one request at a time. Native model activity, VM custody,
 * Git publication and completion delivery have different receipts; none is
 * inferred from another. The host composes the real LXD/Git/native adapters.
 * A lost lease aborts work and independently requests physical stop. */
export class CloudCodingExecutor {
	readonly #control: CodingExecutorControl;
	readonly #host: CodingExecutorHost;
	readonly #owner: string;
	#active = false;
	constructor(options: { control: CodingExecutorControl; host: CodingExecutorHost; owner: string }) {
		if (!/^[A-Za-z0-9_.:-]{1,120}$/.test(options.owner)) throw new Error("Invalid coding executor owner");
		this.#control = options.control;
		this.#host = options.host;
		this.#owner = options.owner;
	}
	async runOnce(signal: AbortSignal): Promise<"idle" | "completed" | "cancelled" | "recovery-required"> {
		if (this.#active) throw new Error("Coding executor already active");
		this.#active = true;
		let claim: CodingExecutorClaim | undefined;
		const stop = new AbortController();
		const heartbeatStop = new AbortController();
		const active = AbortSignal.any([signal, stop.signal]);
		let heartbeat: Promise<void> | undefined;
		let workspaceReady = false;
		let leaseRefresh = Promise.resolve();
		let watchdog: ReturnType<typeof globalThis.setTimeout> | undefined;
		const arm = (deadline: string) => {
			const milliseconds = Date.parse(deadline) - Date.now();
			if (!Number.isFinite(milliseconds) || milliseconds < 1 || milliseconds > 305000)
				throw new Error("Invalid coding lease deadline");
			clearTimeout(watchdog);
			watchdog = globalThis.setTimeout(() => stop.abort(), milliseconds);
		};
		const call = (method: (typeof CODING_EXECUTOR_RPCS)[number], args: Record<string, unknown>, checked = active) =>
			this.#control.call(method, args, AbortSignal.any([checked, AbortSignal.timeout(10000)]));
		try {
			const value = await call("qorpera_claim_coding_request", { p_owner: this.#owner, p_lease_seconds: 60 });
			if (value === null) return "idle";
			claim = parseClaim(value);
			const claimed = claim;
			const args = { p_request_id: claim.requestId, p_lease_token: claim.leaseToken };
			const refresh = () => {
				leaseRefresh = leaseRefresh.then(async () => {
					if (workspaceReady) await this.#host.refreshLease(claimed, active);
				});
				return leaseRefresh;
			};
			arm(claim.leaseUntil);
			heartbeat = (async () => {
				const checked = AbortSignal.any([active, heartbeatStop.signal]);
				try {
					while (!checked.aborted) {
						await setTimeout(15000, undefined, { signal: checked });
						const until = await call(
							"qorpera_heartbeat_coding_request",
							{ ...args, p_lease_seconds: 60 },
							checked,
						);
						if (typeof until !== "string") throw new Error("Coding heartbeat unconfirmed");
						arm(until);
						claimed.leaseUntil = until;
						if (workspaceReady) await refresh();
					}
				} catch {
					if (!heartbeatStop.signal.aborted) stop.abort();
				}
			})();
			const sameWorker = (value: unknown): CloudCodingWorker => {
				const worker = parseCloudCodingWorker(value);
				if (
					worker.id !== claimed.worker.id ||
					worker.companyId !== claimed.worker.companyId ||
					worker.parentAgentId !== claimed.worker.parentAgentId ||
					worker.parentRunId !== claimed.worker.parentRunId ||
					worker.branch !== claimed.worker.branch ||
					worker.turn !== claimed.worker.turn ||
					JSON.stringify(worker.repository) !== JSON.stringify(claimed.worker.repository) ||
					(claimed.worker.vmId !== null && worker.vmId !== claimed.worker.vmId)
				)
					throw new Error("Coding worker continuity differs");
				return worker;
			};
			const complete = async (state: "completed" | "cancelled", publication: CodingExecutorPublication) => {
				active.throwIfAborted();
				const result = {
					summary: publication.summary,
					...(publication.noChange ? { noChange: true } : {}),
					...(publication.pullRequest ? { draftPrVerified: true } : {}),
				};
				const worker = sameWorker(
					await call("qorpera_complete_coding_request", {
						...args,
						p_expected_version: claimed.worker.version,
						p_state: state,
						p_result: result,
						p_pull_request: publication.pullRequest,
					}),
				);
				if (worker.state !== state) throw new Error("Coding completion unconfirmed");
			};
			if (claim.kind === "cancel") {
				await this.#host.stopWorkspace(claim, active);
				claimed.worker = sameWorker(await call("qorpera_describe_coding_cancellation", args));
				await complete("cancelled", {
					summary: "Coding execution stopped; workspace retained.",
					pullRequest: null,
					noChange: false,
				});
				return "cancelled";
			}
			await call("qorpera_prepare_coding_execution", args);
			claimed.worker = sameWorker(await this.#host.prepareWorkspace(claimed, active));
			if (claimed.worker.vmId === null) throw new Error("Coding workspace has no admitted VM");
			workspaceReady = true;
			await refresh();
			const progress = async (state: "provisioning" | "ready" | "running") => {
				active.throwIfAborted();
				claimed.worker = sameWorker(
					await call("qorpera_record_coding_progress", {
						...args,
						p_expected_version: claimed.worker.version,
						p_state: state,
						p_vm_id: claimed.worker.vmId,
					}),
				);
				if (claimed.worker.state !== state) throw new Error("Coding progress unconfirmed");
			};
			if (claimed.worker.state === "queued") await progress("provisioning");
			if (claimed.worker.state === "provisioning") await progress("ready");
			if (claimed.worker.state === "ready") await progress("running");
			if (claimed.worker.state !== "running") throw new Error("Coding worker not runnable");
			await this.#host.runNative(claimed, active);
			active.throwIfAborted();
			const publication = await this.#host.publish(claimed, active);
			if (
				!publication.summary.trim() ||
				Buffer.byteLength(publication.summary) > 4000 ||
				(!publication.pullRequest && !publication.noChange)
			)
				throw new Error("Coding publication unconfirmed");
			workspaceReady = false;
			await leaseRefresh;
			await this.#host.stopWorkspace(claimed, active);
			await complete("completed", publication);
			return "completed";
		} catch (error) {
			workspaceReady = false;
			stop.abort();
			await leaseRefresh.catch(() => undefined);
			if (!claim) throw error;
			// A separate cleanup lease must permit physical stop after work
			// authority disappears. Never claim capacity released or completion.
			try {
				await this.#host.stopWorkspace(claim, AbortSignal.timeout(30000));
			} catch {
				/* recovery still required */
			}
			return "recovery-required";
		} finally {
			heartbeatStop.abort();
			clearTimeout(watchdog);
			await heartbeat;
			this.#active = false;
		}
	}
}
