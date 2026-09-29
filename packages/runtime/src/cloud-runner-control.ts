import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { readBoundedCloudResponse, withCloudDeadline } from "@qorpera/cloud-client/cloud-request";
import {
	type CloudRunner,
	type CloudRunnerAssignmentAcceptance,
	type CloudRunnerAuthorityStore,
	type CloudRunnerControlRequest,
	CloudRunnerControlRequestError,
	type CloudRunnerControlTransport,
	type CloudRunnerJob,
	CONTROL_REQUEST_TIMEOUT_MS,
	cloudRunnerControlRequestStatus,
	createToken,
	deterministicCompletionUuid,
	MAX_JSON_BYTES,
	objectJson,
	optionalUuid,
	parseCloudRunner,
	parseCloudRunnerJob,
	record,
	requiredToken,
	runnerActivationTokenSha256,
	SHA256_PATTERN,
	UUID_PATTERN,
	uuid,
} from "@qorpera/cloud-client/node/cloud-runner-protocol";
import type { JsonValue } from "@qorpera/contracts";
import { type CloudRunnerBrokerTransport, CloudRunnerJobBroker, type CloudRunnerStart } from "./cloud-runner-broker.ts";

/** How long a runner accepts alone after the control plane showed it has no start action. */
const START_RETRY_MS = 10 * 60_000;

interface PendingHeartbeat {
	nextToken: string;
	renewalId: string;
}

interface PendingAssignment {
	assignmentId: string;
	jobId: string;
	capability: string;
}

interface ActiveRunnerLease {
	job: CloudRunnerJob;
	leaseToken: string;
	pendingCompletion?: CloudRunnerCompletion;
	pendingFailure?: CloudRunnerFailure;
	executionStarted: boolean;
}

export interface CloudRunnerFailure {
	error: string;
	retryable: boolean;
}

export interface CloudRunnerRecovery {
	job: CloudRunnerJob;
	reason: "authority-unavailable" | "interrupted";
	completion?: CloudRunnerCompletion;
	failure?: CloudRunnerFailure;
}

export interface CloudRunnerCompletion {
	result: JsonValue;
	outputSnapshotId?: string;
}

interface RestoredRunnerAuthority {
	activationToken?: string;
	sessionToken?: string;
	pendingActivationToken?: string;
	pendingHeartbeat?: PendingHeartbeat;
	pendingAssignment?: PendingAssignment;
	runner?: CloudRunner;
	leases: ActiveRunnerLease[];
	recoveries: CloudRunnerRecovery[];
	consumedRepairSha256?: string;
}

function optionalToken(value: unknown, label: string): string | undefined {
	if (value === null || value === undefined) return undefined;
	return stateToken(value, label);
}

function stateToken(value: unknown, label: string): string {
	if (typeof value !== "string") throw new Error(`Runner authority state contains invalid ${label}`);
	requiredToken(value, `Runner authority ${label}`);
	return value;
}

function storedRunner(runner: CloudRunner): JsonValue {
	return {
		runner_id: runner.runnerId,
		profile_id: runner.profileId,
		client_runner_id: runner.clientRunnerId,
		display_name: runner.displayName,
		runner_kind: runner.runnerKind,
		capabilities: [...runner.capabilities],
		max_concurrency: runner.maxConcurrency,
		status: runner.status,
		online: runner.online,
		platform: runner.platform ?? null,
		runner_version: runner.runnerVersion ?? null,
		activation_expires_at: runner.activationExpiresAt,
		session_expires_at: runner.sessionExpiresAt ?? null,
		registered_by_user_id: runner.registeredByUserId,
		created_at: runner.createdAt,
		activated_at: runner.activatedAt ?? null,
		last_seen_at: runner.lastSeenAt ?? null,
		revoked_by_user_id: runner.revokedByUserId ?? null,
		revoked_at: runner.revokedAt ?? null,
		active_lease_count: runner.activeLeaseCount,
	};
}

function storedJob(job: CloudRunnerJob): JsonValue {
	return {
		job_id: job.jobId,
		run_id: job.runId ?? null,
		assignment_id: job.assignmentId ?? null,
		profile_id: job.profileId,
		environment_id: job.environmentId,
		session_id: job.sessionId ?? null,
		substrate_version_id: job.substrateVersionId,
		client_job_id: job.clientJobId,
		required_capability: job.requiredCapability,
		job_type: job.jobType,
		payload: structuredClone(job.payload),
		status: job.status,
		attempt_count: job.attemptCount,
		runner_id: job.runnerId ?? null,
		result: job.result !== undefined ? structuredClone(job.result) : null,
		output_artifact_count: job.outputArtifactCount,
		output_artifact_index_id: job.outputArtifactIndexId ?? null,
		output_substrate_version_id: job.outputSubstrateVersionId ?? null,
		last_error: job.lastError ?? null,
		created_by_user_id: job.createdByUserId,
		created_at: job.createdAt,
		started_at: job.startedAt ?? null,
		lease_expires_at: job.leaseExpiresAt ?? null,
		finished_at: job.finishedAt ?? null,
		cancelled_by_user_id: job.cancelledByUserId ?? null,
		cancelled_at: job.cancelledAt ?? null,
	};
}

function parseRunnerAuthorityState(value: unknown, runnerId: string): RestoredRunnerAuthority {
	const input = record(value, "authority state");
	if (input.schema !== "qorpera.runner-authority/v3" || uuid(input.runner_id, "authority runner id") !== runnerId) {
		throw new Error("Runner authority state has an invalid identity");
	}
	const activationToken = optionalToken(input.activation_token, "activation token");
	const sessionToken = optionalToken(input.session_token, "session token");
	const pendingActivationToken = optionalToken(input.pending_activation_token, "pending activation token");
	let pendingHeartbeat: PendingHeartbeat | undefined;
	if (input.pending_heartbeat !== null && input.pending_heartbeat !== undefined) {
		const pending = record(input.pending_heartbeat, "pending heartbeat");
		pendingHeartbeat = {
			nextToken: stateToken(pending.next_token, "pending heartbeat token"),
			renewalId: uuid(pending.renewal_id, "pending heartbeat renewal id"),
		};
	}
	let pendingAssignment: PendingAssignment | undefined;
	if (input.pending_assignment !== null && input.pending_assignment !== undefined) {
		const pending = record(input.pending_assignment, "pending assignment");
		pendingAssignment = {
			assignmentId: uuid(pending.assignment_id, "pending assignment id"),
			jobId: uuid(pending.job_id, "pending assignment job id"),
			capability: stateToken(pending.capability, "pending assignment capability"),
		};
	}
	let consumedRepairSha256: string | undefined;
	if (input.consumed_repair_sha256 !== null && input.consumed_repair_sha256 !== undefined) {
		if (typeof input.consumed_repair_sha256 !== "string" || !SHA256_PATTERN.test(input.consumed_repair_sha256)) {
			throw new Error("Runner authority state has an invalid repair record");
		}
		consumedRepairSha256 = input.consumed_repair_sha256;
	}
	const runner = input.runner === null || input.runner === undefined ? undefined : parseCloudRunner(input.runner);
	if (!Array.isArray(input.leases)) throw new Error("Runner authority state contains invalid leases");
	const leases = input.leases.map((value): ActiveRunnerLease => {
		const lease = record(value, "stored lease");
		const job = parseCloudRunnerJob(lease.job);
		let pendingCompletion: CloudRunnerCompletion | undefined;
		if (lease.pending_completion !== null && lease.pending_completion !== undefined) {
			const pending = record(lease.pending_completion, "stored completion");
			pendingCompletion = {
				result: objectJson(pending.result, "stored completion result"),
				...(optionalUuid(pending.output_snapshot_id, "stored completion snapshot id")
					? { outputSnapshotId: uuid(pending.output_snapshot_id, "stored completion snapshot id") }
					: {}),
			};
		}
		return {
			job,
			leaseToken: stateToken(lease.lease_token, "stored lease token"),
			...(pendingCompletion ? { pendingCompletion } : {}),
			...(lease.pending_failure !== null && lease.pending_failure !== undefined
				? { pendingFailure: parseFailure(lease.pending_failure) }
				: {}),
			// Missing execution evidence from an older record is uncertain, never permission to rerun.
			executionStarted: lease.execution_started !== false,
		};
	});
	const recoveries = input.recoveries === undefined ? [] : input.recoveries;
	if (!Array.isArray(recoveries)) throw new Error("Runner recovery state is invalid");
	const parsedRecoveries = recoveries.map((value): CloudRunnerRecovery => {
		const recovery = record(value, "recovery record");
		const job = parseCloudRunnerJob(recovery.job);
		if (
			job.runnerId !== runnerId ||
			job.status !== "leased" ||
			(runner !== undefined && job.profileId !== runner.profileId) ||
			(recovery.completion != null && recovery.failure != null) ||
			(recovery.reason !== "authority-unavailable" && recovery.reason !== "interrupted")
		)
			throw new Error("Runner recovery identity is invalid");
		let completion: CloudRunnerCompletion | undefined;
		if (recovery.completion !== null && recovery.completion !== undefined) {
			const pending = record(recovery.completion, "recovery completion");
			const snapshot = optionalUuid(pending.outputSnapshotId, "recovery snapshot");
			completion = {
				result: objectJson(pending.result, "recovery result"),
				...(snapshot ? { outputSnapshotId: snapshot } : {}),
			};
		}
		return {
			job,
			reason: recovery.reason,
			...(completion ? { completion } : {}),
			...(recovery.failure !== null && recovery.failure !== undefined
				? { failure: parseFailure(recovery.failure) }
				: {}),
		};
	});
	if (
		Boolean(activationToken) === Boolean(sessionToken) ||
		(Boolean(pendingActivationToken) && !activationToken) ||
		(Boolean(pendingHeartbeat) || Boolean(pendingAssignment) || Boolean(runner) || leases.length > 0) !==
			Boolean(sessionToken) ||
		(runner !== undefined && runner.runnerId !== runnerId) ||
		new Set(leases.map((lease) => lease.job.jobId)).size !== leases.length ||
		new Set(parsedRecoveries.map((recovery) => recovery.job.jobId)).size !== parsedRecoveries.length ||
		new Set(parsedRecoveries.map((recovery) => recovery.job.profileId)).size > 1 ||
		leases.some((lease) => parsedRecoveries.some((recovery) => recovery.job.jobId === lease.job.jobId)) ||
		leases.some(
			(lease) =>
				lease.job.status !== "leased" ||
				lease.job.runnerId !== runnerId ||
				(runner !== undefined && lease.job.profileId !== runner.profileId) ||
				!lease.job.leaseExpiresAt ||
				Boolean(lease.pendingCompletion && lease.pendingFailure) ||
				(lease.pendingCompletion !== undefined && !lease.job.leaseExpiresAt),
		)
	) {
		throw new Error("Runner authority state is inconsistent");
	}
	return {
		...(activationToken ? { activationToken } : {}),
		...(sessionToken ? { sessionToken } : {}),
		...(pendingActivationToken ? { pendingActivationToken } : {}),
		...(pendingHeartbeat ? { pendingHeartbeat } : {}),
		...(pendingAssignment ? { pendingAssignment } : {}),
		...(runner ? { runner } : {}),
		leases,
		recoveries: parsedRecoveries,
		...(consumedRepairSha256 ? { consumedRepairSha256 } : {}),
	};
}

export interface DisposableCloudRunnerSnapshot {
	runnerId: string;
	active: boolean;
	sessionExpiresAt?: string;
	activeJobIds: string[];
	recoveryJobIds: string[];
}

function parseFailure(value: unknown): CloudRunnerFailure {
	const failure = record(value, "staged failure");
	if (
		typeof failure.error !== "string" ||
		!failure.error.trim() ||
		failure.error.length > 1000 ||
		typeof failure.retryable !== "boolean"
	)
		throw new Error("Runner staged failure is invalid");
	return { error: failure.error, retryable: failure.retryable };
}

export class DisposableCloudRunner {
	readonly #transport: CloudRunnerControlTransport;
	readonly #runnerId: string;
	readonly #authorityStore?: CloudRunnerAuthorityStore;
	#activationToken?: string;
	#sessionToken?: string;
	#pendingActivationToken?: string;
	#pendingHeartbeat?: PendingHeartbeat;
	#pendingAssignment?: PendingAssignment;
	#runner?: CloudRunner;
	#consumedRepairSha256?: string;
	/** Until this time the runner accepts alone: the control plane refused the start action
	 * before doing anything (400: an Edge Function without it; 501: a database without it). */
	#startUnavailableUntil = 0;
	readonly #leases = new Map<string, ActiveRunnerLease>();
	readonly #recoveries = new Map<string, CloudRunnerRecovery>();
	#persistTail: Promise<void> = Promise.resolve();

	constructor(
		transport: CloudRunnerControlTransport,
		runnerId: string,
		activationToken: string,
		authorityStore?: CloudRunnerAuthorityStore,
	) {
		if (!UUID_PATTERN.test(runnerId)) throw new Error("Runner id is invalid");
		requiredToken(activationToken, "Runner activation token");
		this.#transport = transport;
		this.#runnerId = runnerId;
		this.#activationToken = activationToken;
		this.#authorityStore = authorityStore;
	}

	static async open(
		transport: CloudRunnerControlTransport,
		runnerId: string,
		authorityStore: CloudRunnerAuthorityStore,
		activationToken?: string,
	): Promise<DisposableCloudRunner> {
		if (!UUID_PATTERN.test(runnerId)) throw new Error("Runner id is invalid");
		const stored = await authorityStore.load();
		if (stored === undefined) {
			if (!activationToken) throw new Error("Runner activation token is required for initial setup");
			const created = new DisposableCloudRunner(transport, runnerId, activationToken, authorityStore);
			await created.#persist();
			return created;
		}
		if (activationToken) throw new Error("Runner authority is already initialized");
		const restored = parseRunnerAuthorityState(stored, runnerId);
		const instance = new DisposableCloudRunner(
			transport,
			runnerId,
			restored.activationToken ?? createToken(),
			authorityStore,
		);
		instance.#activationToken = restored.activationToken;
		instance.#sessionToken = restored.sessionToken;
		instance.#pendingActivationToken = restored.pendingActivationToken;
		instance.#pendingHeartbeat = restored.pendingHeartbeat;
		instance.#pendingAssignment = restored.pendingAssignment;
		instance.#runner = restored.runner;
		instance.#consumedRepairSha256 = restored.consumedRepairSha256;
		for (const lease of restored.leases) instance.#leases.set(lease.job.jobId, lease);
		for (const recovery of restored.recoveries) instance.#recoveries.set(recovery.job.jobId, recovery);
		return instance;
	}

	static async repair(
		transport: CloudRunnerControlTransport,
		runnerId: string,
		authorityStore: CloudRunnerAuthorityStore,
		activationToken: string,
	): Promise<DisposableCloudRunner> {
		const stored = await authorityStore.load();
		if (stored === undefined) {
			throw new Error("Runner authority repair requires existing state");
		}
		// A repair credential can outlive the repair it authorized (the operator
		// deletes it out of band). Once its hash is recorded in the authority
		// state, the stored rotating authority is current and must not be wiped
		// again — re-running the wipe would regenerate the activation replay
		// token and permanently diverge from the server's consumed binding.
		const restored = parseRunnerAuthorityState(stored, runnerId);
		if (restored.consumedRepairSha256 === runnerActivationTokenSha256(activationToken)) {
			return DisposableCloudRunner.open(transport, runnerId, authorityStore);
		}
		const repaired = new DisposableCloudRunner(transport, runnerId, activationToken, authorityStore);
		repaired.#consumedRepairSha256 = runnerActivationTokenSha256(activationToken);
		for (const recovery of restored.recoveries) repaired.#recoveries.set(recovery.job.jobId, recovery);
		for (const lease of restored.leases) {
			if (!lease.executionStarted && !lease.pendingCompletion && !lease.pendingFailure) continue;
			repaired.#recoveries.set(lease.job.jobId, {
				job: lease.job,
				reason: "authority-unavailable",
				...(lease.pendingCompletion ? { completion: lease.pendingCompletion } : {}),
				...(lease.pendingFailure ? { failure: lease.pendingFailure } : {}),
			});
		}
		await repaired.#persist();
		return repaired;
	}

	async activate(platform: string, runnerVersion: string): Promise<CloudRunner> {
		if (!this.#activationToken) {
			if (!this.#runner) throw new Error("Runner activation is unavailable");
			return this.#runner;
		}
		if (!this.#pendingActivationToken) {
			this.#pendingActivationToken = createToken();
			await this.#persist();
		}
		const activationToken = this.#activationToken;
		const pendingActivationToken = this.#pendingActivationToken;
		const runner = parseCloudRunner(
			await this.#transport.request(activationToken, {
				action: "activate",
				runnerId: this.#runnerId,
				nextSessionToken: pendingActivationToken,
				platform,
				runnerVersion,
			}),
		);
		if (runner.runnerId !== this.#runnerId || runner.status !== "active") {
			throw new Error("Runner activation returned an inconsistent runner");
		}
		this.#sessionToken = pendingActivationToken;
		this.#pendingActivationToken = undefined;
		this.#activationToken = undefined;
		this.#runner = runner;
		try {
			await this.#persist();
		} catch (error) {
			this.#sessionToken = undefined;
			this.#pendingActivationToken = pendingActivationToken;
			this.#activationToken = activationToken;
			this.#runner = undefined;
			throw error;
		}
		return runner;
	}

	async heartbeat(): Promise<CloudRunner> {
		let recoverCommittedRotation = true;
		while (true) {
			const token = this.#sessionToken;
			if (!token) throw new Error("Runner is not active");
			if (!this.#pendingHeartbeat) {
				this.#pendingHeartbeat = { nextToken: createToken(), renewalId: randomUUID() };
				await this.#persist();
			}
			const pendingHeartbeat = this.#pendingHeartbeat;
			let value: unknown;
			try {
				value = await this.#transport.request(token, {
					action: "heartbeat",
					runnerId: this.#runnerId,
					nextSessionToken: pendingHeartbeat.nextToken,
					renewalId: pendingHeartbeat.renewalId,
				});
			} catch (error) {
				if (!recoverCommittedRotation || cloudRunnerControlRequestStatus(error) !== 401) throw error;
				const recoveryHeartbeat = { nextToken: createToken(), renewalId: randomUUID() };
				this.#sessionToken = pendingHeartbeat.nextToken;
				this.#pendingHeartbeat = recoveryHeartbeat;
				try {
					await this.#persist();
				} catch (persistError) {
					this.#sessionToken = token;
					this.#pendingHeartbeat = pendingHeartbeat;
					throw persistError;
				}
				recoverCommittedRotation = false;
				continue;
			}
			const runner = parseCloudRunner(value);
			if (runner.runnerId !== this.#runnerId || runner.status !== "active") {
				throw new Error("Runner heartbeat returned an inconsistent runner");
			}
			this.#sessionToken = pendingHeartbeat.nextToken;
			this.#pendingHeartbeat = undefined;
			const previousRunner = this.#runner;
			this.#runner = runner;
			try {
				await this.#persist();
			} catch (error) {
				this.#sessionToken = token;
				this.#pendingHeartbeat = pendingHeartbeat;
				this.#runner = previousRunner;
				throw error;
			}
			return runner;
		}
	}

	async acceptAssignment(assignment: CloudRunnerAssignmentAcceptance): Promise<CloudRunnerJob> {
		return (await this.#accept(assignment)).job;
	}

	/** Accepts exactly like acceptAssignment and, in the acceptance's own database transaction,
	 * reads the broker description and, with `nativeLeaseSeconds`, the native authority, so the
	 * job's broker needs no further round trip before execution. `start` is absent when the cloud
	 * deferred those reads (the broker then makes the separate calls) or does not offer the start
	 * action at all: a 400 or 501 proves nothing ran, and this runner then accepts alone for
	 * START_RETRY_MS before it asks for a start again (a rollout may deploy it meanwhile). */
	async startAssignment(
		assignment: CloudRunnerAssignmentAcceptance,
		nativeLeaseSeconds?: number,
	): Promise<{ job: CloudRunnerJob; start?: CloudRunnerStart }> {
		if (Date.now() >= this.#startUnavailableUntil) {
			try {
				return await this.#accept(assignment, { nativeLeaseSeconds });
			} catch (error) {
				const status = cloudRunnerControlRequestStatus(error);
				if (status !== 400 && status !== 501) throw error;
				this.#startUnavailableUntil = Date.now() + START_RETRY_MS;
			}
		}
		return this.#accept(assignment);
	}

	async #accept(
		assignment: CloudRunnerAssignmentAcceptance,
		start?: { nativeLeaseSeconds: number | undefined },
	): Promise<{ job: CloudRunnerJob; start?: CloudRunnerStart }> {
		if (this.#recoveries.has(assignment.jobId))
			throw new Error("Runner job requires outcome reconciliation before another execution");
		const token = this.#sessionToken;
		if (!token) throw new Error("Runner is not active");
		if (!UUID_PATTERN.test(assignment.assignmentId) || !UUID_PATTERN.test(assignment.jobId)) {
			throw new Error("Runner assignment is invalid");
		}
		requiredToken(assignment.capability, "Runner assignment capability");
		const received: PendingAssignment = {
			assignmentId: assignment.assignmentId,
			jobId: assignment.jobId,
			capability: assignment.capability,
		};
		if (this.#pendingAssignment && !isDeepStrictEqual(this.#pendingAssignment, received)) {
			throw new Error("Runner already has another assignment awaiting acceptance");
		}
		if (!this.#pendingAssignment) {
			this.#pendingAssignment = received;
			await this.#persist();
		}
		const acceptance = {
			runnerId: this.#runnerId,
			assignmentId: received.assignmentId,
			jobId: received.jobId,
			assignmentCapability: received.capability,
		};
		const value = await this.#transport.request(
			token,
			start
				? {
						action: "start",
						...acceptance,
						...(start.nativeLeaseSeconds === undefined ? {} : { nativeLeaseSeconds: start.nativeLeaseSeconds }),
					}
				: { action: "accept", ...acceptance },
		);
		let started: CloudRunnerStart | undefined;
		let accepted = value;
		if (start) {
			const receipt = record(value, "runner start");
			const description = receipt.description ?? undefined;
			const nativeAuthority = receipt.native_authority ?? undefined;
			if (
				Object.keys(receipt).some((key) => !["job", "description", "native_authority"].includes(key)) ||
				(nativeAuthority !== undefined && (description === undefined || start.nativeLeaseSeconds === undefined))
			) {
				throw new Error("Runner start returned an inconsistent receipt");
			}
			accepted = receipt.job;
			if (description !== undefined) {
				started = {
					description,
					...(nativeAuthority !== undefined && start.nativeLeaseSeconds !== undefined
						? { nativeAuthority: { value: nativeAuthority, leaseSeconds: start.nativeLeaseSeconds } }
						: {}),
				};
			}
		}
		const job = parseCloudRunnerJob(accepted);
		if (
			job.jobId !== received.jobId ||
			(job.assignmentId !== undefined && job.assignmentId !== received.assignmentId) ||
			job.runnerId !== this.#runnerId ||
			job.status !== "leased" ||
			(this.#runner && job.profileId !== this.#runner.profileId)
		) {
			throw new Error("Runner assignment returned an inconsistent lease");
		}
		const prior = this.#leases.get(job.jobId);
		if (
			prior &&
			(prior.leaseToken !== received.capability ||
				prior.job.runId !== job.runId ||
				prior.job.profileId !== job.profileId)
		) {
			throw new Error("Runner assignment conflicts with retained job authority");
		}
		this.#leases.set(
			job.jobId,
			prior ? { ...prior, job } : { job, leaseToken: received.capability, executionStarted: false },
		);
		this.#pendingAssignment = undefined;
		try {
			await this.#persist();
		} catch (error) {
			if (prior) this.#leases.set(job.jobId, prior);
			else this.#leases.delete(job.jobId);
			this.#pendingAssignment = received;
			throw error;
		}
		return { job, ...(started ? { start: started } : {}) };
	}

	async renew(jobId: string): Promise<CloudRunnerJob> {
		const active = this.#leases.get(jobId);
		if (!active) throw new Error("Runner job lease is unavailable");
		const previousJob = active.job;
		const job = await this.#jobRequest("renew", jobId);
		active.job = job;
		try {
			await this.#persist();
		} catch (error) {
			active.job = previousJob;
			throw error;
		}
		return job;
	}

	broker(
		job: CloudRunnerJob,
		transport: CloudRunnerBrokerTransport,
		signal?: AbortSignal,
		start?: CloudRunnerStart,
	): CloudRunnerJobBroker {
		if (job.runnerId !== this.#runnerId || job.status !== "leased" || !this.#leases.has(job.jobId)) {
			throw new Error("Runner job lease is unavailable");
		}
		return new CloudRunnerJobBroker({
			job,
			runnerId: this.#runnerId,
			transport,
			...(signal ? { signal } : {}),
			...(start ? { start } : {}),
			credentials: () => {
				const sessionToken = this.#sessionToken;
				const lease = this.#leases.get(job.jobId);
				if (!sessionToken || !lease) throw new Error("Runner job lease is unavailable");
				return { sessionToken, leaseToken: lease.leaseToken };
			},
		});
	}

	async stageCompletion(jobId: string, result: JsonValue, outputSnapshotId?: string): Promise<void> {
		const encoded = JSON.stringify(result);
		if (
			!result ||
			typeof result !== "object" ||
			Array.isArray(result) ||
			"output_substrate" in result ||
			"company_file" in result ||
			encoded === undefined ||
			Buffer.byteLength(encoded) > MAX_JSON_BYTES
		) {
			throw new Error("Runner job result is invalid");
		}
		if (outputSnapshotId !== undefined && !UUID_PATTERN.test(outputSnapshotId)) {
			throw new Error("Runner output Company File snapshot is invalid");
		}
		const active = this.#leases.get(jobId);
		if (!active) throw new Error("Runner job lease is unavailable");
		if (active.pendingFailure) throw new Error("Runner job already has a staged failure");
		const completion: CloudRunnerCompletion = {
			result: structuredClone(result),
			...(outputSnapshotId ? { outputSnapshotId } : {}),
		};
		if (active.pendingCompletion) {
			if (!isDeepStrictEqual(active.pendingCompletion, completion)) {
				throw new Error("Runner job completion changed after it was staged");
			}
		} else {
			active.pendingCompletion = completion;
			try {
				await this.#persist();
			} catch (error) {
				active.pendingCompletion = undefined;
				throw error;
			}
		}
	}

	async complete(jobId: string, result: JsonValue, outputSnapshotId?: string): Promise<CloudRunnerJob> {
		await this.stageCompletion(jobId, result, outputSnapshotId);
		const active = this.#leases.get(jobId);
		if (!active) throw new Error("Runner job lease is unavailable");
		const stagedCompletion = active.pendingCompletion;
		if (!stagedCompletion) throw new Error("Runner job completion could not be staged");
		const job = await this.#jobRequest("complete", jobId, stagedCompletion);
		this.#leases.delete(jobId);
		try {
			await this.#persist();
		} catch (error) {
			this.#leases.set(jobId, active);
			throw error;
		}
		return job;
	}

	async fail(jobId: string, error: string, retryable: boolean): Promise<CloudRunnerJob> {
		const message = error.trim();
		if (!message || message.length > 1000) throw new Error("Runner job failure is invalid");
		const active = this.#leases.get(jobId);
		if (!active) throw new Error("Runner job lease is unavailable");
		if (active.pendingCompletion) throw new Error("Runner job already has a staged completion");
		const failure = { error: message, retryable };
		if (active.pendingFailure && !isDeepStrictEqual(active.pendingFailure, failure))
			throw new Error("Runner job failure changed after it was staged");
		if (!active.pendingFailure) {
			active.pendingFailure = failure;
			try {
				await this.#persist();
			} catch (error) {
				active.pendingFailure = undefined;
				throw error;
			}
		}
		const job = await this.#jobRequest("fail", jobId, active.pendingFailure);
		this.#leases.delete(jobId);
		try {
			await this.#persist();
		} catch (error) {
			this.#leases.set(jobId, active);
			throw error;
		}
		return job;
	}

	leasedJobs(): CloudRunnerJob[] {
		return [...this.#leases.values()]
			.map((lease) => structuredClone(lease.job))
			.sort((left, right) => left.jobId.localeCompare(right.jobId, "en"));
	}

	pendingCompletion(jobId: string): JsonValue | undefined {
		const completion = this.#leases.get(jobId)?.pendingCompletion;
		return completion === undefined ? undefined : structuredClone(completion.result);
	}

	stagedCompletion(jobId: string): CloudRunnerCompletion | undefined {
		const completion = this.#leases.get(jobId)?.pendingCompletion;
		return completion === undefined ? undefined : structuredClone(completion);
	}

	stagedFailure(jobId: string): CloudRunnerFailure | undefined {
		const failure = this.#leases.get(jobId)?.pendingFailure;
		return failure ? structuredClone(failure) : undefined;
	}

	executionStarted(jobId: string): boolean {
		return this.#leases.get(jobId)?.executionStarted ?? false;
	}

	async markExecutionStarted(jobId: string): Promise<void> {
		const lease = this.#leases.get(jobId);
		if (!lease || lease.executionStarted || lease.pendingCompletion || lease.pendingFailure)
			throw new Error("Runner execution requires reconciliation");
		lease.executionStarted = true;
		try {
			await this.#persist();
		} catch (error) {
			lease.executionStarted = false;
			throw error;
		}
	}

	recoveryRecords(): CloudRunnerRecovery[] {
		return structuredClone([...this.#recoveries.values()]);
	}

	async discardJobAuthority(
		jobId: string,
		reason: CloudRunnerRecovery["reason"] = "authority-unavailable",
	): Promise<void> {
		const active = this.#leases.get(jobId);
		if (!active) return;
		const priorRecovery = this.#recoveries.get(jobId);
		if (active.executionStarted || active.pendingCompletion || active.pendingFailure) {
			this.#recoveries.set(jobId, {
				job: structuredClone(active.job),
				reason,
				...(active.pendingCompletion ? { completion: structuredClone(active.pendingCompletion) } : {}),
				...(active.pendingFailure ? { failure: structuredClone(active.pendingFailure) } : {}),
			});
		}
		this.#leases.delete(jobId);
		try {
			await this.#persist();
		} catch (error) {
			this.#leases.set(jobId, active);
			if (priorRecovery) this.#recoveries.set(jobId, priorRecovery);
			else this.#recoveries.delete(jobId);
			throw error;
		}
	}

	snapshot(): DisposableCloudRunnerSnapshot {
		return {
			runnerId: this.#runnerId,
			active: Boolean(this.#sessionToken),
			...(this.#runner?.sessionExpiresAt ? { sessionExpiresAt: this.#runner.sessionExpiresAt } : {}),
			activeJobIds: [...this.#leases.keys()].sort(),
			recoveryJobIds: [...this.#recoveries.keys()].sort(),
		};
	}

	async #jobRequest(
		action: "renew" | "complete" | "fail",
		jobId: string,
		extra: CloudRunnerCompletion | { error: string; retryable: boolean } | undefined = undefined,
	): Promise<CloudRunnerJob> {
		const token = this.#sessionToken;
		const lease = this.#leases.get(jobId);
		if (!token || !lease || !UUID_PATTERN.test(jobId)) throw new Error("Runner job lease is unavailable");
		const leaseToken = lease.leaseToken;
		let request: CloudRunnerControlRequest;
		if (action === "complete") {
			const completion = extra as CloudRunnerCompletion;
			request = {
				action,
				runnerId: this.#runnerId,
				jobId,
				leaseToken,
				clientArtifactIndexId: deterministicCompletionUuid("artifact-index", jobId),
				clientSubstrateVersionId: deterministicCompletionUuid("substrate-version", jobId),
				...(completion.outputSnapshotId ? { outputSnapshotId: completion.outputSnapshotId } : {}),
				result: completion.result,
			};
		} else if (action === "fail") {
			const failure = extra as { error: string; retryable: boolean };
			request = { action, runnerId: this.#runnerId, jobId, leaseToken, ...failure };
		} else {
			request = { action, runnerId: this.#runnerId, jobId, leaseToken };
		}
		const job = parseCloudRunnerJob(await this.#transport.request(token, request));
		if (this.#leases.get(jobId) !== lease) throw new Error("Runner job authority is no longer active");
		if (
			job.jobId !== jobId ||
			job.profileId !== lease.job.profileId ||
			job.runId !== lease.job.runId ||
			job.assignmentId !== lease.job.assignmentId ||
			(job.runnerId !== undefined && job.runnerId !== this.#runnerId)
		)
			throw new Error("Runner request returned another job or tenant");
		if (action === "complete") {
			// The server appends its own durable publication receipts. Compare
			// the exact submitted result, allowing only those two reserved fields.
			const echoed = { ...record(job.result, "completion result") };
			delete echoed.output_substrate;
			delete echoed.company_file;
			if (!isDeepStrictEqual(echoed, (extra as CloudRunnerCompletion).result)) {
				throw new Error("Runner request returned an inconsistent completion receipt");
			}
		}
		if (
			(action === "renew" && job.status !== "leased") ||
			(action === "complete" && job.status !== "completed") ||
			(action === "fail" && job.status !== "queued" && job.status !== "failed")
		) {
			throw new Error("Runner request returned an inconsistent job state");
		}
		return job;
	}

	async #persist(): Promise<void> {
		if (!this.#authorityStore) return;
		const state: JsonValue = {
			schema: "qorpera.runner-authority/v3",
			runner_id: this.#runnerId,
			activation_token: this.#activationToken ?? null,
			session_token: this.#sessionToken ?? null,
			pending_activation_token: this.#pendingActivationToken ?? null,
			pending_heartbeat: this.#pendingHeartbeat
				? {
						next_token: this.#pendingHeartbeat.nextToken,
						renewal_id: this.#pendingHeartbeat.renewalId,
					}
				: null,
			pending_assignment: this.#pendingAssignment
				? {
						assignment_id: this.#pendingAssignment.assignmentId,
						job_id: this.#pendingAssignment.jobId,
						capability: this.#pendingAssignment.capability,
					}
				: null,
			runner: this.#runner ? storedRunner(this.#runner) : null,
			consumed_repair_sha256: this.#consumedRepairSha256 ?? null,
			recoveries: [...this.#recoveries.values()].map((recovery) => ({
				job: storedJob(recovery.job),
				reason: recovery.reason,
				completion: recovery.completion
					? { result: recovery.completion.result, outputSnapshotId: recovery.completion.outputSnapshotId ?? null }
					: null,
				failure: recovery.failure ? { ...recovery.failure } : null,
			})),
			leases: [...this.#leases.values()]
				.sort((left, right) => left.job.jobId.localeCompare(right.job.jobId, "en"))
				.map((lease) => ({
					job: storedJob(lease.job),
					lease_token: lease.leaseToken,
					execution_started: lease.executionStarted,
					pending_failure: lease.pendingFailure ? { ...lease.pendingFailure } : null,
					pending_completion:
						lease.pendingCompletion !== undefined
							? {
									result: structuredClone(lease.pendingCompletion.result),
									output_snapshot_id: lease.pendingCompletion.outputSnapshotId ?? null,
								}
							: null,
				})),
		};
		const store = this.#authorityStore;
		const operation = this.#persistTail.then(
			() => store.save(state),
			() => store.save(state),
		);
		this.#persistTail = operation;
		await operation;
	}
}

export class SupabaseCloudRunnerControlTransport implements CloudRunnerControlTransport {
	readonly #url: string;
	readonly #publishableKey: string;
	readonly #fetch: typeof fetch;
	readonly #signal?: AbortSignal;
	readonly #requestTimeoutMs: number;

	constructor(
		baseUrl: string,
		publishableKey: string,
		fetchImplementation: typeof fetch = fetch,
		options: { signal?: AbortSignal; requestTimeoutMs?: number } = {},
	) {
		const url = new URL("/functions/v1/runner-control", baseUrl);
		if (
			url.protocol !== "https:" &&
			!(url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost"))
		) {
			throw new Error("Runner control URL must use HTTPS");
		}
		if (!publishableKey.trim()) throw new Error("Runner control publishable key is required");
		this.#url = url.href;
		this.#publishableKey = publishableKey;
		this.#fetch = fetchImplementation;
		this.#signal = options.signal;
		this.#requestTimeoutMs = options.requestTimeoutMs ?? CONTROL_REQUEST_TIMEOUT_MS;
		if (!Number.isSafeInteger(this.#requestTimeoutMs) || this.#requestTimeoutMs < 1) {
			throw new Error("Runner control request timeout is invalid");
		}
	}

	async request(token: string, body: CloudRunnerControlRequest): Promise<unknown> {
		requiredToken(token, "Runner token");
		return withCloudDeadline(
			async (signal) => {
				const response = await this.#fetch(this.#url, {
					method: "POST",
					headers: {
						accept: "application/json",
						"content-type": "application/json",
						apikey: this.#publishableKey,
						authorization: `Bearer ${token}`,
					},
					body: JSON.stringify(body),
					redirect: "error",
					signal,
				});
				if (!response.ok) {
					void response.body?.cancel().catch(() => undefined);
					throw new CloudRunnerControlRequestError(response.status);
				}
				const encoded = await readBoundedCloudResponse(response, 256 * 1024, signal);
				let value: unknown;
				try {
					value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(encoded));
				} catch {
					throw new Error("Runner control returned invalid JSON");
				}
				const envelope = record(value, "response");
				return envelope.value;
			},
			this.#requestTimeoutMs,
			this.#signal,
		);
	}
}
