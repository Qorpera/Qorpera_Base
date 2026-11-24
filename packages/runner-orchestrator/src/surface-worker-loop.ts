import type {
	SurfaceAutomationOutputMode,
	SurfaceChangeStatus,
	SurfaceSessionState,
	SurfaceSourceKind,
} from "@qorpera/contracts";

export type SurfaceClaimLane = "all" | "sessions" | "folder" | "code_repo";

export interface SurfaceMachinePlacementHint {
	readonly strategy: "reuse_machine" | "spawn_overflow_machine";
	readonly machineId: string | null;
	readonly activeTurns: number;
	readonly targetDensity: number;
}

export interface ClaimedSurfaceSessionSponsor {
	readonly sponsorBindingId: string;
	readonly sponsorVersion: number;
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
	readonly surfaceSourceKind?: SurfaceSourceKind;
	readonly surfaceKind?: string;
	readonly explorationId?: string | null;
	readonly explorationVariantLabel?: string | null;
	readonly siteSlug?: string | null;
	readonly identityFolderRoot?: string | null;
	readonly productFolderRoots?: readonly string[];
	readonly briefSummary?: string | null;
	readonly retryCount?: number;
	readonly sponsor?: ClaimedSurfaceSessionSponsor | null;
	readonly leaseToken?: string | null;
	readonly placement: SurfaceMachinePlacementHint;
}

export interface ClaimedSurfacePreviewExploration {
	readonly sessionId: string;
	readonly baseSha: string;
	readonly headSha: string;
}

export interface ClaimedSurfaceChangeRange {
	readonly changeId: string;
	readonly parentSha: string;
	readonly headSha: string;
	readonly title: string;
	readonly optionGroupKey?: string | null;
}

export interface ClaimedSurfacePreviewJob {
	readonly previewId: string;
	readonly surfaceId: string;
	readonly profileId: string;
	readonly environmentId?: string | null;
	readonly shortHostId: string;
	readonly baseSha: string;
	readonly selectedChangeIds: readonly string[];
	readonly repositoryKey: string | null;
	readonly leaseToken?: string | null;
	readonly reconciledCommitSha?: string | null;
	readonly exploration?: ClaimedSurfacePreviewExploration | null;
	readonly changes?: readonly ClaimedSurfaceChangeRange[];
}

export interface ClaimedSurfaceApprovedChange {
	readonly changeId: string;
	readonly kind: string;
	readonly parentSha: string | null;
	readonly headSha: string | null;
	readonly title: string;
	readonly summary: string;
	readonly patchManifest: unknown;
	readonly baseFiles?: Readonly<Record<string, string | null>> | null;
	readonly affectedPaths: readonly string[];
}

export interface ClaimedSurfacePeerSession {
	readonly sessionId: string;
	readonly workerId: string;
	readonly recordedChangeHeadShas?: readonly string[];
	readonly remainingChanges: readonly ClaimedSurfaceChangeRange[];
}

export interface ClaimedSurfaceMergeJob {
	readonly jobId: string;
	readonly kind: "land_change" | "undo_change";
	readonly surfaceId: string;
	readonly sessionId: string | null;
	readonly profileId: string;
	readonly environmentId?: string | null;
	readonly leaseToken?: string | null;
	readonly sourceKind?: SurfaceSourceKind;
	readonly repositoryKey: string | null;
	readonly folderRoot: string | null;
	readonly autoPublish?: boolean;
	readonly expectMainSha?: string | null;
	readonly sessionWorkerId?: string | null;
	readonly sessionBranchHeadSha?: string | null;
	readonly sessionRecordedChangeHeadShas?: readonly string[];
	readonly sessionState?: SurfaceSessionState | null;
	readonly sessionHasActiveChat?: boolean;
	readonly payload: Readonly<Record<string, unknown>>;
	readonly preMergeSnapshot?: Readonly<Record<string, unknown>> | null;
	readonly reconciledPatchManifest?: unknown;
	readonly reconciledConflictPaths?: readonly string[] | null;
	readonly reconciledCommitSha?: string | null;
	readonly allSessionChangeStatuses?: readonly {
		readonly changeId: string;
		readonly status: SurfaceChangeStatus;
	}[];
	readonly approvedChanges?: readonly ClaimedSurfaceApprovedChange[];
	readonly siblingRemainingChanges?: readonly ClaimedSurfaceChangeRange[];
	readonly peerSessions?: readonly ClaimedSurfacePeerSession[];
}

export interface ClaimedSurfacePublishJob {
	readonly jobId: string;
	readonly surfaceId: string;
	readonly profileId: string;
	readonly environmentId?: string | null;
	readonly sourceKind?: SurfaceSourceKind;
	readonly liveHeadSha?: string | null;
	readonly leaseToken?: string | null;
	readonly repositoryKey: string | null;
	readonly siteId: string | null;
	readonly payload: Readonly<Record<string, unknown>>;
}

export interface ClaimedSurfaceAutomationJob {
	readonly automationId: string;
	readonly profileId: string;
	readonly key: string;
	readonly title: string;
	readonly prompt: string;
	readonly targetSurfaceSlug: string | null;
	readonly outputMode: SurfaceAutomationOutputMode;
	readonly sessionId: string | null;
	readonly surfaceId: string | null;
}

export interface ClaimedSurfaceJobs {
	readonly sessions: readonly ClaimedSurfaceSessionJob[];
	readonly previews: readonly ClaimedSurfacePreviewJob[];
	readonly merges?: readonly ClaimedSurfaceMergeJob[];
	readonly publishes?: readonly ClaimedSurfacePublishJob[];
	readonly automations?: readonly ClaimedSurfaceAutomationJob[];
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
	readonly startedAutomations: number;
}

export interface SurfaceWorkerLoopPorts {
	claimPendingJobs(limit: number, signal: AbortSignal): Promise<ClaimedSurfaceJobs>;
	spawnOverflowMachine?: (profileId: string, signal: AbortSignal) => Promise<{ readonly machineId: string }>;
	dispatchSessionTurn(job: ClaimedSurfaceSessionJob, machineId: string, signal: AbortSignal): Promise<void>;
	runPreviewJob(job: ClaimedSurfacePreviewJob, signal: AbortSignal): Promise<void>;
	runMergeJob?: (job: ClaimedSurfaceMergeJob, signal: AbortSignal) => Promise<void>;
	runPublishJob?: (job: ClaimedSurfacePublishJob, signal: AbortSignal) => Promise<void>;
	runAutomationJob?: (job: ClaimedSurfaceAutomationJob, signal: AbortSignal) => Promise<void>;
	reportSessionFailure?: (
		input: { readonly sessionId: string; readonly leaseToken?: string | null; readonly errorDetail: string },
		signal: AbortSignal,
	) => Promise<void>;
	releaseSessionClaim?: (
		input: { readonly sessionId: string; readonly leaseToken: string },
		signal: AbortSignal,
	) => Promise<unknown>;
	renewLease?: (
		input: {
			readonly kind: "session" | "preview" | "job";
			readonly id: string;
			readonly leaseToken: string;
			readonly extendSeconds?: number;
		},
		signal: AbortSignal,
	) => Promise<{ readonly renewed: boolean } | undefined>;
	onEvent?: (event: Record<string, unknown>) => void;
}

export interface SurfaceWorkerLoopOptions {
	readonly pollIntervalMs?: number;
	readonly batchLimit?: number;
	readonly leaseRenewIntervalMs?: number;
	readonly leaseExtendSeconds?: number;
	readonly maxInFlight?: number;
}

// WHY: Drains pending Surface sessions, previews, merges, publishes, and due automations without blocking claim ticks on long-running work.
export class SurfaceWorkerLoop {
	readonly #ports: SurfaceWorkerLoopPorts;
	readonly #pollIntervalMs: number;
	readonly #batchLimit: number;
	readonly #leaseRenewIntervalMs: number;
	readonly #leaseExtendSeconds: number;
	readonly #maxInFlight: number;
	readonly #inFlightSessions = new Set<string>();
	readonly #inFlightPreviews = new Set<string>();
	readonly #inFlightMerges = new Set<string>();
	readonly #inFlightPublishes = new Set<string>();
	readonly #inFlightAutomations = new Set<string>();
	readonly #activeTasks = new Set<Promise<void>>();
	#capacityBackoffUntil = 0;

	constructor(ports: SurfaceWorkerLoopPorts, options: SurfaceWorkerLoopOptions = {}) {
		this.#ports = ports;
		this.#pollIntervalMs = Math.max(50, options.pollIntervalMs ?? 1500);
		this.#batchLimit = Math.min(Math.max(1, options.batchLimit ?? 16), 64);
		this.#leaseRenewIntervalMs = Math.max(20, options.leaseRenewIntervalMs ?? 60_000);
		this.#leaseExtendSeconds = Math.min(Math.max(30, options.leaseExtendSeconds ?? 300), 900);
		this.#maxInFlight = Math.min(Math.max(1, options.maxInFlight ?? 32), 256);
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

	get inFlightAutomationCount(): number {
		return this.#inFlightAutomations.size;
	}

	get inFlightTaskCount(): number {
		return this.#activeTasks.size;
	}

	async drain(): Promise<void> {
		while (this.#activeTasks.size > 0) {
			await Promise.allSettled([...this.#activeTasks]);
		}
	}

	#launch(task: Promise<void>): void {
		const tracked = task.finally(() => {
			this.#activeTasks.delete(tracked);
		});
		this.#activeTasks.add(tracked);
	}

	async #withLeaseRenewal<T>(
		kind: "session" | "preview" | "job",
		id: string,
		leaseToken: string | null | undefined,
		signal: AbortSignal,
		work: () => Promise<T>,
	): Promise<T> {
		const renew = this.#ports.renewLease;
		if (!renew || !leaseToken) {
			return await work();
		}
		let renewing = false;
		const timer = setInterval(() => {
			if (signal.aborted || renewing) return;
			renewing = true;
			void renew({ kind, id, leaseToken, extendSeconds: this.#leaseExtendSeconds }, signal)
				.catch((error) => {
					if (signal.aborted) return;
					this.#emit({
						kind: "lease_renewal_failed",
						leaseKind: kind,
						id,
						error: error instanceof Error ? error.message : String(error),
					});
				})
				.finally(() => {
					renewing = false;
				});
		}, this.#leaseRenewIntervalMs);
		try {
			return await work();
		} finally {
			clearInterval(timer);
		}
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
		const available = Math.max(0, this.#maxInFlight - this.#activeTasks.size);
		if (available === 0) {
			return {
				startedSessions: 0,
				startedPreviews: 0,
				startedMerges: 0,
				startedPublishes: 0,
				startedAutomations: 0,
			};
		}
		const claimed = await this.#ports.claimPendingJobs(Math.min(this.#batchLimit, available), signal);
		const merges = claimed.merges ?? [];
		const publishes = claimed.publishes ?? [];
		const automations = claimed.automations ?? [];
		let startedSessions = 0;
		let startedPreviews = 0;
		let startedMerges = 0;
		let startedPublishes = 0;
		let startedAutomations = 0;

		for (const merge of merges) {
			if (!this.#ports.runMergeJob || this.#inFlightMerges.has(merge.jobId)) continue;
			this.#inFlightMerges.add(merge.jobId);
			startedMerges += 1;
			this.#launch(
				this.#withLeaseRenewal("job", merge.jobId, merge.leaseToken, signal, () =>
					this.#ports.runMergeJob!(merge, signal),
				)
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
			this.#launch(
				this.#withLeaseRenewal("job", publish.jobId, publish.leaseToken, signal, () =>
					this.#ports.runPublishJob!(publish, signal),
				)
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
			this.#launch(
				this.#withLeaseRenewal("preview", preview.previewId, preview.leaseToken, signal, () =>
					this.#ports.runPreviewJob(preview, signal),
				)
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
			this.#launch(
				this.#withLeaseRenewal("session", session.sessionId, session.leaseToken, signal, () =>
					this.#runSession(session, signal),
				)
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

		for (const automation of automations) {
			if (automation.sessionId !== null) continue;
			if (!this.#ports.runAutomationJob || this.#inFlightAutomations.has(automation.automationId)) continue;
			this.#inFlightAutomations.add(automation.automationId);
			startedAutomations += 1;
			this.#launch(
				this.#ports
					.runAutomationJob(automation, signal)
					.then(() => {
						this.#emit({
							kind: "automation_completed",
							automationId: automation.automationId,
							key: automation.key,
							outputMode: automation.outputMode,
						});
					})
					.catch((error) => {
						this.#emit({
							kind: "automation_failed",
							automationId: automation.automationId,
							key: automation.key,
							outputMode: automation.outputMode,
							error: error instanceof Error ? error.message : String(error),
						});
					})
					.finally(() => {
						this.#inFlightAutomations.delete(automation.automationId);
					}),
			);
		}

		return { startedSessions, startedPreviews, startedMerges, startedPublishes, startedAutomations };
	}

	async #runSession(session: ClaimedSurfaceSessionJob, signal: AbortSignal): Promise<void> {
		try {
			let machineId = session.placement.machineId;
			if (session.placement.strategy === "spawn_overflow_machine" || !machineId) {
				if (this.#ports.spawnOverflowMachine) {
					const spawned = await this.#ports.spawnOverflowMachine(session.profileId, signal);
					machineId = spawned.machineId;
					this.#emit({
						kind: "overflow_machine_spawned",
						profileId: session.profileId,
						sessionId: session.sessionId,
						machineId,
					});
				} else {
					machineId = "managed-sandbox";
				}
			}
			await this.#ports.dispatchSessionTurn(session, machineId, signal);
			this.#emit({
				kind: "session_dispatched",
				sessionId: session.sessionId,
				surfaceId: session.surfaceId,
				machineId,
			});
		} catch (error) {
			const isCapacityBusy =
				typeof error === "object" && error !== null && (error as { status?: unknown }).status === 429;
			if (!signal.aborted && isCapacityBusy) {
				// WHY: Back off at least one poll interval after provider HTTP 429 so wakes cannot spin a tight retry loop while saturated.
				this.#capacityBackoffUntil = Math.max(this.#capacityBackoffUntil, Date.now() + this.#pollIntervalMs);
				if (this.#ports.releaseSessionClaim && session.leaseToken) {
					try {
						await this.#ports.releaseSessionClaim(
							{ sessionId: session.sessionId, leaseToken: session.leaseToken },
							signal,
						);
						this.#emit({
							kind: "session_deferred",
							sessionId: session.sessionId,
							surfaceId: session.surfaceId,
						});
						return;
					} catch (releaseError) {
						this.#emit({
							kind: "session_release_error",
							sessionId: session.sessionId,
							error: releaseError instanceof Error ? releaseError.message : String(releaseError),
						});
					}
				}
				throw error;
			}
			if (!signal.aborted && this.#ports.reportSessionFailure) {
				const raw = error instanceof Error ? error.message : String(error);
				const errorDetail = raw.replace(/\0/g, "").trim().slice(0, 1000).trim() || "Session dispatch failed";
				try {
					await this.#ports.reportSessionFailure(
						{
							sessionId: session.sessionId,
							...(session.leaseToken !== undefined ? { leaseToken: session.leaseToken } : {}),
							errorDetail,
						},
						signal,
					);
				} catch (reportError) {
					this.#emit({
						kind: "session_failure_report_error",
						sessionId: session.sessionId,
						error: reportError instanceof Error ? reportError.message : String(reportError),
					});
				}
			}
			throw error;
		}
	}

	async run(signal: AbortSignal, wake?: SurfaceWorkerWakeSource): Promise<void> {
		let woken = false;
		let releaseWait: (() => void) | undefined;
		const unsubscribe = wake?.subscribe(() => {
			if (Date.now() < this.#capacityBackoffUntil) return;
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
				const backoffRemaining = this.#capacityBackoffUntil - Date.now();
				const inBackoff = backoffRemaining > 0;
				if (!tickFailed && !inBackoff && woken) continue;
				const waitMs = inBackoff ? Math.max(backoffRemaining, this.#pollIntervalMs) : this.#pollIntervalMs;
				await new Promise<void>((resolve) => {
					if (signal.aborted || (!tickFailed && !inBackoff && woken)) {
						resolve();
						return;
					}
					const done = () => {
						clearTimeout(timer);
						signal.removeEventListener("abort", done);
						releaseWait = undefined;
						resolve();
					};
					const timer = setTimeout(done, waitMs);
					signal.addEventListener("abort", done, { once: true });
					releaseWait = done;
				});
			}
		} finally {
			unsubscribe?.();
			await this.drain();
		}
	}
}
