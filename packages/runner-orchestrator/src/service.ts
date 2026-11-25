import { isAbsolute, resolve } from "node:path";
import { UUID_ANY_CASE_PATTERN } from "@qorpera/contracts";
import { FileRunnerOrchestratorControlTokenStore } from "./control-token-store.ts";
import type { ServiceHttpFetch } from "./http-transport.ts";
import { nodeHttpFetch } from "./node-http-fetch.ts";
import { CloudRunnerOrchestrator, SupabaseCloudRunnerOrchestratorControlPlane } from "./orchestrator.ts";
import { RealtimeOrchestratorWake, type RealtimeOrchestratorWakeState } from "./orchestrator-wake.ts";
import { CloudRunnerProviderRequestError, HttpCloudRunnerProviderAdapter } from "./provider-http.ts";
import { createSurfaceExecutionHandlers, type SurfaceExecutionBridgePorts } from "./surface-execution-bridge.ts";
import { type SurfaceClaimLane, SurfaceWorkerLoop, type SurfaceWorkerLoopPorts } from "./surface-worker-loop.ts";

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const ADAPTER_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;

export interface CloudRunnerOrchestratorServiceConfig {
	supabaseUrl: string;
	supabasePublishableKey: string;
	orchestratorId: string;
	orchestratorControlToken: string;
	orchestratorControlStatePath: string;
	providerUrl: string;
	providerAdapterId: string;
	providerServiceToken: string;
	pollIntervalMs: number;
	/** Control renewal, reconcilers and retained claims; defaults to 2 s. */
	reconcileIntervalMs?: number;
	dispatchConcurrency: number;
	/** Push wake-ups over Supabase Realtime (off unless configured): the slow poll that backs them up. */
	wake?: { backstopMs: number };
	surfaceWorkerEnabled?: boolean;
}

export interface CloudRunnerOrchestratorSurfaceWorkerOptions {
	readonly lane?: SurfaceClaimLane;
	readonly spawnOverflowMachine?: SurfaceWorkerLoopPorts["spawnOverflowMachine"];
	readonly dispatchSessionTurn: SurfaceWorkerLoopPorts["dispatchSessionTurn"];
	readonly runPreviewJob: SurfaceWorkerLoopPorts["runPreviewJob"];
	readonly runMergeJob?: SurfaceWorkerLoopPorts["runMergeJob"];
	readonly runPublishJob?: SurfaceWorkerLoopPorts["runPublishJob"];
	readonly runAutomationJob?: SurfaceWorkerLoopPorts["runAutomationJob"];
	readonly onEvent?: SurfaceWorkerLoopPorts["onEvent"];
	readonly pollIntervalMs?: number;
	readonly batchLimit?: number;
}

export interface CloudRunnerOrchestratorSurfaceWorkerContext {
	readonly controlPlane: SupabaseCloudRunnerOrchestratorControlPlane;
	readonly providerAdapter: HttpCloudRunnerProviderAdapter;
	readonly orchestratorId: string;
}

export type CloudRunnerOrchestratorSurfaceWorkerOption =
	| CloudRunnerOrchestratorSurfaceWorkerOptions
	| ((context: CloudRunnerOrchestratorSurfaceWorkerContext) => CloudRunnerOrchestratorSurfaceWorkerOptions);

export interface CloudRunnerOrchestratorServiceOptions {
	config: CloudRunnerOrchestratorServiceConfig;
	signal: AbortSignal;
	fetchImplementation?: ServiceHttpFetch;
	onError?: (error: unknown) => void;
	surfaceWorker?: CloudRunnerOrchestratorSurfaceWorkerOption | null;
}

export type DefaultSurfaceWorkerOverrides = Partial<Omit<SurfaceExecutionBridgePorts, "controlPlane">> & {
	readonly lane?: SurfaceClaimLane;
	readonly spawnOverflowMachine?: SurfaceWorkerLoopPorts["spawnOverflowMachine"];
	readonly dispatchSessionTurn?: SurfaceWorkerLoopPorts["dispatchSessionTurn"];
	readonly runAutomationJob?: SurfaceWorkerLoopPorts["runAutomationJob"];
	readonly onEvent?: SurfaceWorkerLoopPorts["onEvent"];
	readonly pollIntervalMs?: number;
	readonly batchLimit?: number;
};

export function createDefaultSurfaceWorkerConfig(
	context: CloudRunnerOrchestratorSurfaceWorkerContext,
	overrides: DefaultSurfaceWorkerOverrides = {},
): CloudRunnerOrchestratorSurfaceWorkerOptions {
	const logEvent: (event: Record<string, unknown>) => void =
		overrides.onEvent ??
		((event) => {
			console.error(
				JSON.stringify({
					schema: "qorpera.surface-worker/v1",
					orchestratorId: context.orchestratorId,
					...event,
				}),
			);
		});
	const defaultRunOpsActionJob: NonNullable<SurfaceExecutionBridgePorts["runOpsActionJob"]> = async (job) => {
		const changes = job.approvedChanges ?? [];
		for (const change of changes) {
			const manifest =
				change.patchManifest && typeof change.patchManifest === "object" && !Array.isArray(change.patchManifest)
					? (change.patchManifest as Record<string, unknown>)
					: null;
			const actionKind = typeof manifest?.actionKind === "string" ? manifest.actionKind.trim() : "";
			if (!actionKind) {
				return { status: "failed", errorDetail: `Missing actionKind on ops change ${change.changeId}` };
			}
			if (actionKind === "noop") {
				continue;
			}
			return {
				status: "failed",
				errorDetail: `Ops action kind "${actionKind}" is not enabled on this orchestrator`,
			};
		}
		return { status: "landed" };
	};
	const handlers = createSurfaceExecutionHandlers({
		controlPlane: context.controlPlane,
		...(overrides.resolveRepository ? { resolveRepository: overrides.resolveRepository } : {}),
		...(overrides.resolveCodeHostJob ? { resolveCodeHostJob: overrides.resolveCodeHostJob } : {}),
		...(overrides.buildAndUploadPreview ? { buildAndUploadPreview: overrides.buildAndUploadPreview } : {}),
		...(overrides.onSessionChangesRebased ? { onSessionChangesRebased: overrides.onSessionChangesRebased } : {}),
		...(overrides.undoCodeRepoChange ? { undoCodeRepoChange: overrides.undoCodeRepoChange } : {}),
		...(overrides.folder ? { folder: overrides.folder } : {}),
		...(overrides.folderSnapshots ? { folderSnapshots: overrides.folderSnapshots } : {}),
		...(overrides.resolveProductFolderRoots
			? { resolveProductFolderRoots: overrides.resolveProductFolderRoots }
			: typeof context.controlPlane.resolveSharedProductFolderRoots === "function"
				? {
						resolveProductFolderRoots: async (profileId: string, signal?: AbortSignal) => {
							try {
								return await context.controlPlane.resolveSharedProductFolderRoots!(profileId, signal);
							} catch (error) {
								if (signal?.aborted) throw error;
								return [];
							}
						},
					}
				: {}),
		runOpsActionJob: overrides.runOpsActionJob ?? defaultRunOpsActionJob,
		...(overrides.publishSurface ? { publishSurface: overrides.publishSurface } : {}),
	});

	const lane = overrides.lane ?? (overrides.folder || overrides.resolveCodeHostJob ? undefined : "sessions");

	return {
		...(lane !== undefined ? { lane } : {}),
		...(overrides.spawnOverflowMachine ? { spawnOverflowMachine: overrides.spawnOverflowMachine } : {}),
		dispatchSessionTurn:
			overrides.dispatchSessionTurn ??
			(async (job, machineId, signal) => {
				if (typeof context.controlPlane.enqueueSurfaceSessionRun === "function" && job.leaseToken) {
					const enqueued = await context.controlPlane.enqueueSurfaceSessionRun(
						{ sessionId: job.sessionId, leaseToken: job.leaseToken },
						signal,
					);
					if (enqueued.status === "enqueued") {
						logEvent({
							kind: "session_enqueued",
							sessionId: job.sessionId,
							surfaceId: job.surfaceId,
							wakeId: enqueued.wakeId,
							runId: enqueued.runId,
							...(enqueued.workerId ? { workerId: enqueued.workerId } : {}),
						});
						return;
					}
					if (enqueued.status === "deferred") {
						logEvent({
							kind: "session_deferred",
							sessionId: job.sessionId,
							surfaceId: job.surfaceId,
							reason: enqueued.reason,
							retryAfterSeconds: enqueued.retryAfterSeconds,
						});
						return;
					}
					if (enqueued.reason === "lease_lost" || enqueued.reason === "surfaces_disabled") {
						return;
					}
					if (enqueued.reason === "no_sponsor") {
						throw new Error("Connect an AI model account in Settings to run this Surface session.");
					}
					throw new Error(`Surface session could not start (${enqueued.reason})`);
				}
				if (typeof context.providerAdapter.deliverSurfaceSession === "function") {
					let deliveryJob = job;
					if (
						deliveryJob.productFolderRoots === undefined &&
						typeof context.controlPlane.resolveSharedProductFolderRoots === "function"
					) {
						try {
							const productFolderRoots = await context.controlPlane.resolveSharedProductFolderRoots(
								deliveryJob.profileId,
								signal,
							);
							if (productFolderRoots.length > 0) {
								deliveryJob = { ...deliveryJob, productFolderRoots };
							}
						} catch (error) {
							if (signal?.aborted) throw error;
						}
					}
					try {
						await context.providerAdapter.deliverSurfaceSession(deliveryJob, machineId, signal);
						return;
					} catch (error) {
						if (error instanceof CloudRunnerProviderRequestError && error.status === 501) {
							logEvent({
								kind: "session_dispatch_unconfigured",
								sessionId: job.sessionId,
								surfaceId: job.surfaceId,
								machineId,
								providerAdapterId: context.providerAdapter.adapterId,
								status: error.status,
							});
							throw new Error(
								`Surface session execution is not enabled on provider ${context.providerAdapter.adapterId}`,
							);
						}
						throw error;
					}
				}
				logEvent({
					kind: "session_dispatch_unconfigured",
					sessionId: job.sessionId,
					surfaceId: job.surfaceId,
					machineId,
					providerAdapterId: context.providerAdapter.adapterId,
				});
				throw new Error(
					`Surface session dispatch is not configured for provider ${context.providerAdapter.adapterId}`,
				);
			}),
		runPreviewJob: handlers.runPreviewJob,
		runMergeJob: handlers.runMergeJob,
		runPublishJob: handlers.runPublishJob,
		runAutomationJob:
			overrides.runAutomationJob ??
			(async (job, signal) => {
				if (typeof context.controlPlane.triggerSurfaceAutomation === "function") {
					const triggered = await context.controlPlane.triggerSurfaceAutomation(job.automationId, signal);
					logEvent({
						kind: "automation_triggered",
						automationId: job.automationId,
						key: job.key,
						status: triggered.status,
						...(triggered.sessionId ? { sessionId: triggered.sessionId } : {}),
						...(triggered.reason ? { reason: triggered.reason } : {}),
					});
					return;
				}
				logEvent({
					kind: "automation_dispatch_unconfigured",
					automationId: job.automationId,
					key: job.key,
					outputMode: job.outputMode,
					profileId: job.profileId,
				});
			}),
		onEvent: logEvent,
		...(overrides.pollIntervalMs !== undefined ? { pollIntervalMs: overrides.pollIntervalMs } : {}),
		...(overrides.batchLimit !== undefined ? { batchLimit: overrides.batchLimit } : {}),
	};
}

export function createSurfaceWorkerLoop(
	controlPlane: Pick<SupabaseCloudRunnerOrchestratorControlPlane, "claimSurfaceJobs"> &
		Partial<
			Pick<
				SupabaseCloudRunnerOrchestratorControlPlane,
				"completeSurfaceSessionTurn" | "renewSurfaceLease" | "releaseSurfaceSessionClaim"
			>
		>,
	options: CloudRunnerOrchestratorSurfaceWorkerOptions,
): SurfaceWorkerLoop {
	const reportSessionFailure = controlPlane.completeSurfaceSessionTurn
		? async (
				input: { readonly sessionId: string; readonly leaseToken?: string | null; readonly errorDetail: string },
				signal: AbortSignal,
			) => {
				await controlPlane.completeSurfaceSessionTurn!(
					{
						sessionId: input.sessionId,
						state: "failed",
						replyText: input.errorDetail,
						...(input.leaseToken !== undefined ? { leaseToken: input.leaseToken } : {}),
					},
					signal,
				);
			}
		: undefined;
	const releaseSessionClaim = controlPlane.releaseSurfaceSessionClaim
		? (input: { readonly sessionId: string; readonly leaseToken: string }, signal: AbortSignal) =>
				controlPlane.releaseSurfaceSessionClaim!(input, signal)
		: undefined;
	const renewLease = controlPlane.renewSurfaceLease
		? (
				input: {
					readonly kind: "session" | "preview" | "job";
					readonly id: string;
					readonly leaseToken: string;
					readonly extendSeconds?: number;
				},
				signal: AbortSignal,
			) => controlPlane.renewSurfaceLease!(input, signal)
		: undefined;
	return new SurfaceWorkerLoop(
		{
			claimPendingJobs: (limit, signal) => controlPlane.claimSurfaceJobs(limit, signal, options.lane),
			...(options.spawnOverflowMachine ? { spawnOverflowMachine: options.spawnOverflowMachine } : {}),
			dispatchSessionTurn: options.dispatchSessionTurn,
			runPreviewJob: options.runPreviewJob,
			...(options.runMergeJob ? { runMergeJob: options.runMergeJob } : {}),
			...(options.runPublishJob ? { runPublishJob: options.runPublishJob } : {}),
			...(options.runAutomationJob ? { runAutomationJob: options.runAutomationJob } : {}),
			...(reportSessionFailure ? { reportSessionFailure } : {}),
			...(releaseSessionClaim ? { releaseSessionClaim } : {}),
			...(renewLease ? { renewLease } : {}),
			...(options.onEvent ? { onEvent: options.onEvent } : {}),
		},
		{
			...(options.pollIntervalMs !== undefined ? { pollIntervalMs: options.pollIntervalMs } : {}),
			...(options.batchLimit !== undefined ? { batchLimit: options.batchLimit } : {}),
		},
	);
}

function requiredEnvironmentValue(environment: Readonly<Record<string, string | undefined>>, name: string): string {
	const value = environment[name];
	if (!value || value !== value.trim() || /[\0\r\n]/.test(value)) {
		throw new Error(`${name} is required`);
	}
	return value;
}

function serviceUrl(value: string, label: string): string {
	const url = new URL(value);
	if (
		url.protocol !== "https:" &&
		!(url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost"))
	) {
		throw new Error(`${label} must use HTTPS`);
	}
	return url.href;
}

export function cloudRunnerOrchestratorServiceConfigFromEnvironment(
	environment: Readonly<Record<string, string | undefined>>,
): CloudRunnerOrchestratorServiceConfig {
	const orchestratorId = requiredEnvironmentValue(environment, "QORPERA_RUNNER_ORCHESTRATOR_ID");
	const orchestratorControlToken = requiredEnvironmentValue(environment, "QORPERA_RUNNER_ORCHESTRATOR_CONTROL_TOKEN");
	const orchestratorControlStatePath = requiredEnvironmentValue(
		environment,
		"QORPERA_RUNNER_ORCHESTRATOR_CONTROL_STATE",
	);
	const providerAdapterId = requiredEnvironmentValue(environment, "QORPERA_RUNNER_PROVIDER_ADAPTER");
	const pollValue = environment.QORPERA_RUNNER_ORCHESTRATOR_POLL_MS?.trim() || "250";
	const pollIntervalMs = Number(pollValue);
	const reconcileIntervalMs = Number(environment.QORPERA_RUNNER_ORCHESTRATOR_RECONCILE_MS?.trim() || "2000");
	const dispatchConcurrency = Number(environment.QORPERA_RUNNER_ORCHESTRATOR_CONCURRENCY?.trim() || "8");
	if (!UUID_ANY_CASE_PATTERN.test(orchestratorId)) throw new Error("QORPERA_RUNNER_ORCHESTRATOR_ID is invalid");
	if (!TOKEN_PATTERN.test(orchestratorControlToken)) {
		throw new Error("QORPERA_RUNNER_ORCHESTRATOR_CONTROL_TOKEN is invalid");
	}
	if (!isAbsolute(orchestratorControlStatePath)) {
		throw new Error("QORPERA_RUNNER_ORCHESTRATOR_CONTROL_STATE must be an absolute path");
	}
	if (!ADAPTER_PATTERN.test(providerAdapterId)) {
		throw new Error("QORPERA_RUNNER_PROVIDER_ADAPTER is invalid");
	}
	if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 10 || pollIntervalMs > 60_000) {
		throw new Error("QORPERA_RUNNER_ORCHESTRATOR_POLL_MS is outside the supported range");
	}
	if (!Number.isSafeInteger(reconcileIntervalMs) || reconcileIntervalMs < 10 || reconcileIntervalMs > 60_000) {
		throw new Error("QORPERA_RUNNER_ORCHESTRATOR_RECONCILE_MS is outside the supported range");
	}
	if (!Number.isSafeInteger(dispatchConcurrency) || dispatchConcurrency < 1 || dispatchConcurrency > 64) {
		throw new Error("QORPERA_RUNNER_ORCHESTRATOR_CONCURRENCY is outside the supported range");
	}
	const wakeMode = environment.QORPERA_RUNNER_ORCHESTRATOR_WAKE?.trim() || "off";
	if (wakeMode !== "off" && wakeMode !== "realtime") {
		throw new Error("QORPERA_RUNNER_ORCHESTRATOR_WAKE must be off or realtime");
	}
	// A backstop equal to the poll interval keeps the claim cadence as without wake-ups (the runtime contract's
	// 250 ms poll); wake-ups then only bring claims and reconcile passes forward.
	const wakeBackstopMs = Number(environment.QORPERA_RUNNER_ORCHESTRATOR_WAKE_BACKSTOP_MS?.trim() || "5000");
	if (
		wakeMode === "realtime" &&
		(!Number.isSafeInteger(wakeBackstopMs) || wakeBackstopMs > 60_000 || wakeBackstopMs < pollIntervalMs)
	) {
		throw new Error("QORPERA_RUNNER_ORCHESTRATOR_WAKE_BACKSTOP_MS is outside the supported range");
	}
	return {
		supabaseUrl: serviceUrl(requiredEnvironmentValue(environment, "QORPERA_SUPABASE_URL"), "QORPERA_SUPABASE_URL"),
		supabasePublishableKey: requiredEnvironmentValue(environment, "QORPERA_SUPABASE_PUBLISHABLE_KEY"),
		orchestratorId,
		orchestratorControlToken,
		orchestratorControlStatePath: resolve(orchestratorControlStatePath),
		providerUrl: serviceUrl(
			requiredEnvironmentValue(environment, "QORPERA_RUNNER_PROVIDER_URL"),
			"QORPERA_RUNNER_PROVIDER_URL",
		),
		providerAdapterId,
		providerServiceToken: requiredEnvironmentValue(environment, "QORPERA_RUNNER_PROVIDER_TOKEN"),
		pollIntervalMs,
		reconcileIntervalMs,
		dispatchConcurrency,
		...(wakeMode === "realtime" ? { wake: { backstopMs: wakeBackstopMs } } : {}),
		surfaceWorkerEnabled: environment.QORPERA_SURFACE_WORKER?.trim() === "1",
	};
}

/** Logs a wake-up channel's state when it changes (a refused join retries every 30 s; it is logged once). */
function wakeStateLogger(): (state: RealtimeOrchestratorWakeState, reason?: string) => void {
	let last: string | undefined;
	return (state, reason) => {
		const line = JSON.stringify({ schema: "qorpera.orchestrator-wake/v1", state, ...(reason ? { reason } : {}) });
		if (line === last) return;
		last = line;
		console.error(line);
	};
}

export async function runCloudRunnerOrchestratorService(options: CloudRunnerOrchestratorServiceOptions): Promise<void> {
	const transport = options.fetchImplementation ?? nodeHttpFetch;
	const controlTokenStore = new FileRunnerOrchestratorControlTokenStore(options.config.orchestratorControlStatePath);
	const controlTokens = await controlTokenStore.load(options.config.orchestratorControlToken);
	let wake: RealtimeOrchestratorWake | undefined;
	const controlPlane = new SupabaseCloudRunnerOrchestratorControlPlane(
		options.config.supabaseUrl,
		options.config.supabasePublishableKey,
		options.config.orchestratorId,
		controlTokens.current,
		transport,
		{
			...(controlTokens.pending ? { pendingControlToken: controlTokens.pending } : {}),
			persistControlTokens: (state) => controlTokenStore.save(state),
			// Every start rotates the control token on its first reconcile pass: follow it to its new topic.
			onControlRotated: () => wake?.refresh(),
		},
	);
	const providerAdapter = new HttpCloudRunnerProviderAdapter(
		options.config.providerUrl,
		options.config.providerAdapterId,
		options.config.providerServiceToken,
		transport,
	);
	const orchestrator = new CloudRunnerOrchestrator({
		orchestratorId: options.config.orchestratorId,
		controlPlane,
		providerAdapter,
		dispatchConcurrency: options.config.dispatchConcurrency,
	});
	wake = options.config.wake
		? new RealtimeOrchestratorWake({
				supabaseUrl: options.config.supabaseUrl,
				publishableKey: options.config.supabasePublishableKey,
				topic: () => controlPlane.wakeTopic(),
				onState: wakeStateLogger(),
			})
		: undefined;
	const surfaceWorkerContext: CloudRunnerOrchestratorSurfaceWorkerContext = {
		controlPlane,
		providerAdapter,
		orchestratorId: options.config.orchestratorId,
	};
	const surfaceWorkerConfig =
		options.surfaceWorker === null
			? undefined
			: typeof options.surfaceWorker === "function"
				? options.surfaceWorker(surfaceWorkerContext)
				: options.surfaceWorker !== undefined
					? options.surfaceWorker
					: options.config.surfaceWorkerEnabled === true
						? createDefaultSurfaceWorkerConfig(surfaceWorkerContext)
						: undefined;
	const surfaceWorkerLoop = surfaceWorkerConfig
		? createSurfaceWorkerLoop(controlPlane, {
				...surfaceWorkerConfig,
				...(surfaceWorkerConfig.pollIntervalMs === undefined && options.config.wake
					? { pollIntervalMs: options.config.wake.backstopMs }
					: {}),
				...(!surfaceWorkerConfig.onEvent && options.onError
					? {
							onEvent: (event) => {
								if (event.kind === "tick_failed") {
									options.onError?.(new Error(String(event.error ?? "Surface worker tick failed")));
								}
							},
						}
					: {}),
			})
		: undefined;
	const orchestratorLoopOptions = {
		pollIntervalMs: options.config.pollIntervalMs,
		...(options.config.reconcileIntervalMs !== undefined
			? { reconcileIntervalMs: options.config.reconcileIntervalMs }
			: {}),
		...(wake && options.config.wake ? { wake, wakeBackstopMs: options.config.wake.backstopMs } : {}),
		...(options.onError ? { onError: options.onError } : {}),
	};
	wake?.start();
	try {
		if (surfaceWorkerLoop) {
			const runAbort = new AbortController();
			const runSignal = AbortSignal.any([options.signal, runAbort.signal]);
			const orchestratorTask = orchestrator.run(runSignal, orchestratorLoopOptions).finally(() => runAbort.abort());
			const surfaceTask = surfaceWorkerLoop.run(runSignal, wake).finally(() => runAbort.abort());
			const results = await Promise.allSettled([orchestratorTask, surfaceTask]);
			const rejected = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
			if (rejected) throw rejected.reason;
		} else {
			await orchestrator.run(options.signal, orchestratorLoopOptions);
		}
	} finally {
		wake?.stop();
	}
}
