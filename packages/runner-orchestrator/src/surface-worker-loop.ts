export interface SurfaceMachinePlacementHint {
	readonly strategy: "reuse_machine" | "spawn_overflow_machine";
	readonly machineId: string | null;
	readonly activeTurns: number;
	readonly targetDensity: number;
}

export interface ClaimedSurfaceSessionJob {
	readonly sessionId: string;
	readonly surfaceId: string;
	readonly profileId: string;
	readonly state: "queued" | "reconciling";
	readonly prompt: string;
	readonly originKind: string;
	readonly originRef: unknown;
	readonly repositoryKey: string | null;
	readonly folderRoot?: string | null;
	readonly surfaceSlug?: string;
	readonly surfaceTitle?: string;
	readonly surfaceArchetype?: string;
	readonly briefSummary?: string | null;
	readonly placement: SurfaceMachinePlacementHint;
}

export interface ClaimedSurfacePreviewJob {
	readonly previewId: string;
	readonly surfaceId: string;
	readonly profileId: string;
	readonly shortHostId: string;
	readonly baseSha: string;
	readonly selectedChangeIds: readonly string[];
	readonly repositoryKey: string | null;
}

export interface ClaimedSurfaceMergeJob {
	readonly jobId: string;
	readonly kind: "land_change" | "undo_change";
	readonly surfaceId: string;
	readonly sessionId: string | null;
	readonly profileId: string;
	readonly repositoryKey: string | null;
	readonly folderRoot: string | null;
	readonly payload: Readonly<Record<string, unknown>>;
}

export interface ClaimedSurfacePublishJob {
	readonly jobId: string;
	readonly surfaceId: string;
	readonly profileId: string;
	readonly repositoryKey: string | null;
	readonly siteId: string | null;
	readonly payload: Readonly<Record<string, unknown>>;
}

export interface ClaimedSurfaceJobs {
	readonly sessions: readonly ClaimedSurfaceSessionJob[];
	readonly previews: readonly ClaimedSurfacePreviewJob[];
	readonly merges?: readonly ClaimedSurfaceMergeJob[];
	readonly publishes?: readonly ClaimedSurfacePublishJob[];
}

export interface SurfaceWorkerWakeSource {
	readonly listening?: boolean;
	subscribe(listener: () => void): () => void;
}

export interface SurfaceWorkerTickResult {
	readonly startedSessions: number;
	readonly startedPreviews: number;
	readonly startedMerges: number;
	readonly startedPublishes: number;
}

export interface SurfaceWorkerLoopPorts {
	claimPendingJobs(limit: number, signal: AbortSignal): Promise<ClaimedSurfaceJobs>;
	spawnOverflowMachine(profileId: string, signal: AbortSignal): Promise<{ readonly machineId: string }>;
	dispatchSessionTurn(job: ClaimedSurfaceSessionJob, machineId: string, signal: AbortSignal): Promise<void>;
	runPreviewJob(job: ClaimedSurfacePreviewJob, signal: AbortSignal): Promise<void>;
	runMergeJob?: (job: ClaimedSurfaceMergeJob, signal: AbortSignal) => Promise<void>;
	runPublishJob?: (job: ClaimedSurfacePublishJob, signal: AbortSignal) => Promise<void>;
	onEvent?: (event: Record<string, unknown>) => void;
}

export interface SurfaceWorkerLoopOptions {
	readonly pollIntervalMs?: number;
	readonly batchLimit?: number;
}

// WHY: Drains pending Surface sessions, previews, merges, and publishes while scaling horizontally via overflow VMs when running machines hit turn density.
export class SurfaceWorkerLoop {
	readonly #ports: SurfaceWorkerLoopPorts;
	readonly #pollIntervalMs: number;
	readonly #batchLimit: number;
	readonly #inFlightSessions = new Set<string>();
	readonly #inFlightPreviews = new Set<string>();
	readonly #inFlightMerges = new Set<string>();
	readonly #inFlightPublishes = new Set<string>();

	constructor(ports: SurfaceWorkerLoopPorts, options: SurfaceWorkerLoopOptions = {}) {
		this.#ports = ports;
		this.#pollIntervalMs = Math.max(50, options.pollIntervalMs ?? 1500);
		this.#batchLimit = Math.min(Math.max(1, options.batchLimit ?? 16), 64);
	}

	get inFlightSessionCount(): number {
		return this.#inFlightSessions.size;
	}

	get inFlightPreviewCount(): number {
		return this.#inFlightPreviews.size;
	}

	get inFlightMergeCount(): number {
		return this.#inFlightMerges.size;
	}

	get inFlightPublishCount(): number {
		return this.#inFlightPublishes.size;
	}

	#emit(event: Record<string, unknown>): void {
		try {
			this.#ports.onEvent?.(event);
		} catch {
			/* WHY: Observability callbacks must never interrupt background work draining. */
		}
	}

	async tick(signal: AbortSignal): Promise<SurfaceWorkerTickResult> {
		signal.throwIfAborted();
		const claimed = await this.#ports.claimPendingJobs(this.#batchLimit, signal);
		const merges = claimed.merges ?? [];
		const publishes = claimed.publishes ?? [];
		const tasks: Promise<void>[] = [];
		let startedSessions = 0;
		let startedPreviews = 0;
		let startedMerges = 0;
		let startedPublishes = 0;

		for (const merge of merges) {
			if (!this.#ports.runMergeJob || this.#inFlightMerges.has(merge.jobId)) continue;
			this.#inFlightMerges.add(merge.jobId);
			startedMerges += 1;
			tasks.push(
				this.#ports
					.runMergeJob(merge, signal)
					.then(() => {
						this.#emit({
							kind: "merge_completed",
							jobId: merge.jobId,
							mergeKind: merge.kind,
							surfaceId: merge.surfaceId,
						});
					})
					.catch((error) => {
						this.#emit({
							kind: "merge_failed",
							jobId: merge.jobId,
							mergeKind: merge.kind,
							surfaceId: merge.surfaceId,
							error: error instanceof Error ? error.message : String(error),
						});
					})
					.finally(() => {
						this.#inFlightMerges.delete(merge.jobId);
					}),
			);
		}

		for (const publish of publishes) {
			if (!this.#ports.runPublishJob || this.#inFlightPublishes.has(publish.jobId)) continue;
			this.#inFlightPublishes.add(publish.jobId);
			startedPublishes += 1;
			tasks.push(
				this.#ports
					.runPublishJob(publish, signal)
					.then(() => {
						this.#emit({
							kind: "publish_completed",
							jobId: publish.jobId,
							surfaceId: publish.surfaceId,
						});
					})
					.catch((error) => {
						this.#emit({
							kind: "publish_failed",
							jobId: publish.jobId,
							surfaceId: publish.surfaceId,
							error: error instanceof Error ? error.message : String(error),
						});
					})
					.finally(() => {
						this.#inFlightPublishes.delete(publish.jobId);
					}),
			);
		}

		for (const preview of claimed.previews) {
			if (this.#inFlightPreviews.has(preview.previewId)) continue;
			this.#inFlightPreviews.add(preview.previewId);
			startedPreviews += 1;
			tasks.push(
				this.#ports
					.runPreviewJob(preview, signal)
					.then(() => {
						this.#emit({ kind: "preview_completed", previewId: preview.previewId, surfaceId: preview.surfaceId });
					})
					.catch((error) => {
						this.#emit({
							kind: "preview_failed",
							previewId: preview.previewId,
							error: error instanceof Error ? error.message : String(error),
						});
					})
					.finally(() => {
						this.#inFlightPreviews.delete(preview.previewId);
					}),
			);
		}

		for (const session of claimed.sessions) {
			if (this.#inFlightSessions.has(session.sessionId)) continue;
			this.#inFlightSessions.add(session.sessionId);
			startedSessions += 1;
			tasks.push(
				this.#runSession(session, signal)
					.catch((error) => {
						this.#emit({
							kind: "session_failed",
							sessionId: session.sessionId,
							error: error instanceof Error ? error.message : String(error),
						});
					})
					.finally(() => {
						this.#inFlightSessions.delete(session.sessionId);
					}),
			);
		}

		await Promise.all(tasks);
		return { startedSessions, startedPreviews, startedMerges, startedPublishes };
	}

	async #runSession(session: ClaimedSurfaceSessionJob, signal: AbortSignal): Promise<void> {
		let machineId = session.placement.machineId;
		if (session.placement.strategy === "spawn_overflow_machine" || !machineId) {
			const spawned = await this.#ports.spawnOverflowMachine(session.profileId, signal);
			machineId = spawned.machineId;
			this.#emit({
				kind: "overflow_machine_spawned",
				profileId: session.profileId,
				sessionId: session.sessionId,
				machineId,
			});
		}
		await this.#ports.dispatchSessionTurn(session, machineId, signal);
		this.#emit({
			kind: "session_dispatched",
			sessionId: session.sessionId,
			surfaceId: session.surfaceId,
			machineId,
		});
	}

	async run(signal: AbortSignal, wake?: SurfaceWorkerWakeSource): Promise<void> {
		let woken = false;
		let releaseWait: (() => void) | undefined;
		const unsubscribe = wake?.subscribe(() => {
			if (releaseWait) {
				releaseWait();
			} else {
				woken = true;
			}
		});
		try {
			while (!signal.aborted) {
				woken = false;
				let tickFailed = false;
				try {
					await this.tick(signal);
				} catch (error) {
					if (signal.aborted) return;
					tickFailed = true;
					this.#emit({ kind: "tick_failed", error: error instanceof Error ? error.message : String(error) });
				}
				if (signal.aborted) return;
				if (!tickFailed && woken) continue;
				await new Promise<void>((resolve) => {
					if (signal.aborted || (!tickFailed && woken)) {
						resolve();
						return;
					}
					const done = () => {
						clearTimeout(timer);
						signal.removeEventListener("abort", done);
						releaseWait = undefined;
						resolve();
					};
					const timer = setTimeout(done, this.#pollIntervalMs);
					signal.addEventListener("abort", done, { once: true });
					releaseWait = done;
				});
			}
		} finally {
			unsubscribe?.();
		}
	}
}
