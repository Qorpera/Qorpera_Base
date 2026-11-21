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

export interface ClaimedSurfaceJobs {
	readonly sessions: readonly ClaimedSurfaceSessionJob[];
	readonly previews: readonly ClaimedSurfacePreviewJob[];
}

export interface SurfaceWorkerLoopPorts {
	claimPendingJobs(limit: number, signal: AbortSignal): Promise<ClaimedSurfaceJobs>;
	spawnOverflowMachine(profileId: string, signal: AbortSignal): Promise<{ readonly machineId: string }>;
	dispatchSessionTurn(job: ClaimedSurfaceSessionJob, machineId: string, signal: AbortSignal): Promise<void>;
	runPreviewJob(job: ClaimedSurfacePreviewJob, signal: AbortSignal): Promise<void>;
	onEvent?: (event: Record<string, unknown>) => void;
}

export interface SurfaceWorkerLoopOptions {
	readonly pollIntervalMs?: number;
	readonly batchLimit?: number;
}

// WHY: Drains pending Surface sessions and previews while scaling horizontally via overflow VMs when running machines hit turn density.
export class SurfaceWorkerLoop {
	readonly #ports: SurfaceWorkerLoopPorts;
	readonly #pollIntervalMs: number;
	readonly #batchLimit: number;
	readonly #inFlightSessions = new Set<string>();
	readonly #inFlightPreviews = new Set<string>();

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

	#emit(event: Record<string, unknown>): void {
		try {
			this.#ports.onEvent?.(event);
		} catch {
			/* WHY: Observability callbacks must never interrupt background work draining. */
		}
	}

	async tick(signal: AbortSignal): Promise<{ readonly startedSessions: number; readonly startedPreviews: number }> {
		signal.throwIfAborted();
		const claimed = await this.#ports.claimPendingJobs(this.#batchLimit, signal);
		const tasks: Promise<void>[] = [];
		let startedSessions = 0;
		let startedPreviews = 0;

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
		return { startedSessions, startedPreviews };
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

	async run(signal: AbortSignal): Promise<void> {
		while (!signal.aborted) {
			try {
				await this.tick(signal);
			} catch (error) {
				if (signal.aborted) return;
				this.#emit({ kind: "tick_failed", error: error instanceof Error ? error.message : String(error) });
			}
			await new Promise<void>((resolve) => {
				if (signal.aborted) {
					resolve();
					return;
				}
				const onAbort = () => {
					clearTimeout(timer);
					resolve();
				};
				const timer = setTimeout(() => {
					signal.removeEventListener("abort", onAbort);
					resolve();
				}, this.#pollIntervalMs);
				signal.addEventListener("abort", onAbort, { once: true });
			});
		}
	}
}
