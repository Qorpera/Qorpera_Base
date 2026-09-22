import { execFile } from "node:child_process";
import { chmod, chown, mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import type { ServiceHttpFetch } from "./http-transport.ts";
import type { LxdNativeCompanyRuntimeConfig } from "./lxd-company-runtime.ts";
import { validateLxdNativeCompanyRuntime } from "./lxd-company-runtime.ts";
import type { CloudRunnerAssignmentDelivery, CloudRunnerInstance, CloudRunnerWork } from "./orchestrator.ts";
import { validateCloudRunnerWork } from "./orchestrator.ts";
import type { CloudRunnerProviderServiceBackend } from "./provider-service.ts";
import {
	canonical,
	exactRunner,
	ProviderAdmissionRefused,
	record,
	runAttemptAcquisitionId,
	sha256,
	supabaseServiceHeaders,
	token,
	workSha256,
} from "./provider-shared.ts";
import {
	readSharedExecutionIdentity,
	type SharedExecutionIdentityAuthority,
	supabaseSharedExecutionIdentityAuthority,
} from "./shared-execution-identity.ts";

/** Shared execution service: one long-lived execution host serves every
 * member run on its node. A run is a sandbox — a pair of one-run systemd units
 * (the member's native provider host and the single-lane runner) on a numbered
 * slot with its own accounts, loopback ports, tmpfs credentials and scratch
 * directories — started in about a second instead of a virtual machine booted
 * in seventeen. The member's login stays where it is: the Compute Identity
 * volume is attached to the host, its capsule master key is handed to that
 * run's native host as a systemd credential, and the credential capsule itself
 * is opened only inside the native host's private scratch root, as today.
 *
 * The control plane is unchanged: the same runner rows, the same company
 * ceiling reservation per sandbox, the same assignment protocol. The
 * orchestrator sees one provider with the node's native adapter id.
 *
 * Work this host cannot serve (another job type, another harness, a sandbox
 * still retiring) is answered as an admission deferral, never as a failure:
 * the control plane keeps the job queued and lets the right provider claim it. */

const JOURNAL_SCHEMA = "qorpera.shared-execution-journal/v1";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ADAPTER_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;
const IMAGE_PATTERN = /^[a-z0-9][a-z0-9._:/-]*@sha256:[0-9a-f]{64}$/;
const UNIT_PREFIX_PATTERN = /^[a-z][a-z0-9-]{0,48}@$/;
const ACCOUNT_PREFIX_PATTERN = /^[a-z][a-z0-9-]{0,24}$/;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const RESERVING_RETIREMENT_MS = 10 * 60_000;
const MAX_JOURNAL_BYTES = 64 * 1024;
/** After this many failed retirements a sandbox is recorded as lost and its
 * slot is handed back; the reason stays in the archived journal. */
const MAX_RETIRE_ATTEMPTS = 12;
/** The provider's own refusal reasons. `NODE_NOT_PREFERRED` is the control
 * plane's "defer this orchestrator only" reason: another provider on another
 * node can still take the job. The others defer every orchestrator briefly. */
const REFUSAL_JOB_UNSUPPORTED = "NODE_NOT_PREFERRED";
const REFUSAL_CAPACITY = "SANDBOX_CAPACITY_EXHAUSTED";
const REFUSAL_RETIRING = "SANDBOX_RETIRING";

export type SharedExecutionPhysicalState =
	| "reserving"
	| "starting"
	| "registered"
	| "assigned"
	| "stopping"
	| "stopped"
	| "lost";

export interface SharedExecutionProviderConfig {
	adapterId: string;
	/** Stable name of this execution host; part of every sandbox's instance digest. */
	hostId: string;
	supabaseUrl: string;
	supabaseServiceKey: string;
	supabasePublishableKey: string;
	/** Journals and per-slot scratch state (disk). */
	stateRoot: string;
	/** Per-slot credentials and environment for PID 1 (tmpfs). */
	runRoot: string;
	/** One mount per identity: `<identityRoot>/<computeIdentityId>`. */
	identityRoot: string;
	slotCount: number;
	/** Loopback ports: slot n uses portBase + 2n (native host) and portBase + 2n + 1 (assignment inbox). */
	portBase: number;
	hostUnitPrefix: string;
	runnerUnitPrefix: string;
	hostAccountPrefix: string;
	runnerAccountPrefix: string;
	runnerImage: string;
	runnerPodmanPath: string;
	runnerEntrypoint: string;
	runnerVersion: string;
	codexPath: string;
	claudePath: string;
	nativeCompanyRuntime: LxdNativeCompanyRuntimeConfig;
	startTimeoutMs?: number;
}

export interface SharedExecutionUnitControl {
	start(unit: string, signal?: AbortSignal): Promise<void>;
	stop(unit: string, signal?: AbortSignal): Promise<void>;
	active(unit: string, signal?: AbortSignal): Promise<boolean>;
	/** The subset of `units` that is active or activating, in one query. */
	activeSet(units: readonly string[], signal?: AbortSignal): Promise<Set<string>>;
}

export interface SharedExecutionAccount {
	uid: number;
	gid: number;
}

export interface SharedExecutionProviderDependencies {
	fetch?: ServiceHttpFetch;
	units?: SharedExecutionUnitControl;
	identityAuthority?: SharedExecutionIdentityAuthority;
	/** Resolve a slot account by name (defaults to `id -u` / `id -g`). */
	account?: (name: string) => Promise<SharedExecutionAccount>;
	now?: () => number;
	/** Tests only: skip the identity mount-point requirement. */
	requireIdentityMount?: boolean;
	/** Tests only: owner of the identity volume files (root in production). */
	identityOwnerUid?: number;
}

export interface SharedExecutionJournal {
	schema: typeof JOURNAL_SCHEMA;
	acquisitionId: string;
	runId: string;
	attempt: number;
	workSha256: string;
	jobType: string;
	profileId: string;
	computeIdentityId: string;
	slot: number;
	hostPort: number;
	inboxPort: number;
	instanceSha256: string;
	runner: CloudRunnerInstance;
	physicalState: SharedExecutionPhysicalState;
	credentials: { activationSha256: string; assignmentSha256: string; nativeBridgeSha256: string };
	/** The reservation call was sent; a release is owed even when the reply was lost. */
	capacityRequested?: boolean;
	/** The reservation was confirmed. */
	capacityRegistered?: boolean;
	capacityReleased?: boolean;
	retireAttempts?: number;
	assignmentId?: string;
	stopReason?: string;
	createdAt: string;
	updatedAt: string;
}

interface SlotCredentials {
	activationToken: string;
	assignmentToken: string;
	nativeBridgeToken: string;
}

const execFileAsync = promisify(execFile);

/** Same derivation as the LXD provider (see provider-shared). */
export const sharedExecutionAcquisitionId = runAttemptAcquisitionId;

/** Kept for callers that import the old name; the class is the shared one. */
export const SharedExecutionAdmissionRefused = ProviderAdmissionRefused;

class SystemctlUnitControl implements SharedExecutionUnitControl {
	async start(unit: string, signal?: AbortSignal): Promise<void> {
		await execFileAsync("/usr/bin/systemctl", ["start", "--no-block", unit], { signal, timeout: 30_000 });
	}
	/** Never block the service on a slow shutdown: request the stop, wait a
	 * bounded time, and let retire observe the unit later if it lingers. A
	 * one-run unit that ended non-zero stays "failed" until reset; the slot is
	 * free either way, so clear it before the next start. */
	async stop(unit: string, signal?: AbortSignal): Promise<void> {
		await execFileAsync("/usr/bin/systemctl", ["stop", "--no-block", unit], { signal, timeout: 30_000 });
		const deadline = Date.now() + 15_000;
		while (Date.now() < deadline && (await this.active(unit, signal))) await delay(250, signal);
		await execFileAsync("/usr/bin/systemctl", ["reset-failed", unit], { signal, timeout: 10_000 }).catch(
			() => undefined,
		);
	}
	async active(unit: string, signal?: AbortSignal): Promise<boolean> {
		return (await this.activeSet([unit], signal)).has(unit);
	}
	async activeSet(units: readonly string[], signal?: AbortSignal): Promise<Set<string>> {
		if (units.length === 0) return new Set();
		let stdout: string;
		try {
			({ stdout } = await execFileAsync("/usr/bin/systemctl", ["is-active", ...units], { signal, timeout: 10_000 }));
		} catch (error) {
			// `is-active` exits non-zero when any unit is inactive; the states are still printed, one per line.
			stdout = (error as { stdout?: string }).stdout ?? "";
		}
		const states = stdout.split("\n");
		const active = new Set<string>();
		units.forEach((unit, index) => {
			const state = states[index]?.trim();
			if (state === "active" || state === "activating" || state === "deactivating") active.add(unit);
		});
		return active;
	}
}

async function systemAccount(name: string): Promise<SharedExecutionAccount> {
	const [{ stdout: uid }, { stdout: gid }] = await Promise.all([
		execFileAsync("/usr/bin/id", ["-u", name]),
		execFileAsync("/usr/bin/id", ["-g", name]),
	]);
	const parsed = { uid: Number(uid.trim()), gid: Number(gid.trim()) };
	if (!Number.isSafeInteger(parsed.uid) || parsed.uid < 1 || !Number.isSafeInteger(parsed.gid) || parsed.gid < 1) {
		throw new Error(`The ${name} slot account is invalid`);
	}
	return parsed;
}

function validateConfig(config: SharedExecutionProviderConfig): void {
	if (!ADAPTER_PATTERN.test(config.adapterId)) throw new Error("Provider adapter id is invalid");
	if (!/^[a-z][a-z0-9-]{0,62}$/.test(config.hostId)) throw new Error("Execution host id is invalid");
	for (const [label, path] of [
		["State root", config.stateRoot],
		["Run root", config.runRoot],
		["Identity root", config.identityRoot],
		["Runner Podman path", config.runnerPodmanPath],
		["Codex path", config.codexPath],
		["Claude path", config.claudePath],
	] as const) {
		if (!isAbsolute(path) || resolve(path) !== path) throw new Error(`${label} must be an absolute physical path`);
	}
	if (!Number.isSafeInteger(config.slotCount) || config.slotCount < 1 || config.slotCount > 64)
		throw new Error("Slot count is outside the supported range");
	if (
		!Number.isSafeInteger(config.portBase) ||
		config.portBase < 1024 ||
		config.portBase + config.slotCount * 2 > 65_535
	)
		throw new Error("Slot port range is invalid");
	if (!UNIT_PREFIX_PATTERN.test(config.hostUnitPrefix) || !UNIT_PREFIX_PATTERN.test(config.runnerUnitPrefix))
		throw new Error("Slot unit prefixes must name systemd templates");
	if (config.hostUnitPrefix === config.runnerUnitPrefix) throw new Error("Slot unit prefixes must differ");
	if (
		!ACCOUNT_PREFIX_PATTERN.test(config.hostAccountPrefix) ||
		!ACCOUNT_PREFIX_PATTERN.test(config.runnerAccountPrefix) ||
		config.hostAccountPrefix === config.runnerAccountPrefix
	)
		throw new Error("Slot account prefixes are invalid");
	if (!IMAGE_PATTERN.test(config.runnerImage)) throw new Error("Runner image must be pinned by SHA-256 digest");
	if (!/^\/[A-Za-z0-9._/-]+$/.test(config.runnerEntrypoint)) throw new Error("Runner entrypoint is invalid");
	if (!config.runnerVersion.trim() || /[\0\r\n]/.test(config.runnerVersion))
		throw new Error("Runner version is invalid");
	validateLxdNativeCompanyRuntime(config.nativeCompanyRuntime);
	if (config.nativeCompanyRuntime.codexPath !== config.codexPath)
		throw new Error("The governed runtime fence must be the configured Codex path");
	if (
		config.startTimeoutMs !== undefined &&
		(!Number.isSafeInteger(config.startTimeoutMs) || config.startTimeoutMs < 1000 || config.startTimeoutMs > 600_000)
	)
		throw new Error("Start timeout is outside the supported range");
}

/** Work this host can run. Malformed work is an error; well-formed work this
 * host does not serve (another job type, another harness) is deferred so the
 * provider that does serve it can claim the job. */
function assertGovernedWork(work: CloudRunnerWork): asserts work is CloudRunnerWork & {
	computeIdentityId: string;
	computeTemplateKey: string;
	computeTemplateVersion: string;
	computePolicySha256: string;
} {
	validateCloudRunnerWork(work);
	if (!work.computeIdentityId || !work.computeTemplateKey || !work.computeTemplateVersion || !work.computePolicySha256)
		throw new Error("Shared execution requires immutable Compute Identity authority");
	if (
		work.sponsor.authenticationMode !== "native_subscription" ||
		work.sponsor.provider !== "openai" ||
		work.sponsor.nativeHarness !== "codex-cli"
	)
		throw new ProviderAdmissionRefused(
			"deferred",
			REFUSAL_JOB_UNSUPPORTED,
			"Shared execution serves the pinned Codex subscription harness only",
		);
	if (work.jobType === "proposal_review")
		throw new ProviderAdmissionRefused(
			"deferred",
			REFUSAL_JOB_UNSUPPORTED,
			"Shared execution serves live turn work; proposal review keeps its copy-isolated guest",
		);
}

async function writePrivateFile(path: string, content: string, owner?: SharedExecutionAccount): Promise<void> {
	const temporary = `${path}.${process.pid}.tmp`;
	const handle = await open(temporary, "wx", 0o600);
	try {
		await handle.writeFile(content);
		if (owner) await handle.chown(owner.uid, owner.gid);
		await handle.sync();
	} finally {
		await handle.close();
	}
	await rename(temporary, path);
}

async function emptyDirectory(path: string): Promise<void> {
	let entries: string[];
	try {
		entries = await readdir(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
	for (const entry of entries) await rm(join(path, entry), { recursive: true, force: true });
}

async function delay(ms: number, signal?: AbortSignal): Promise<void> {
	await new Promise<void>((resolveWait, reject) => {
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", abort);
			resolveWait();
		}, ms);
		const abort = (): void => {
			clearTimeout(timer);
			reject(signal?.reason ?? new Error("aborted"));
		};
		if (signal?.aborted) abort();
		else signal?.addEventListener("abort", abort, { once: true });
	});
}

function terminal(state: SharedExecutionPhysicalState): boolean {
	return state === "stopped" || state === "lost";
}

export class SharedExecutionProviderBackend implements CloudRunnerProviderServiceBackend {
	readonly adapterId: string;
	readonly #config: SharedExecutionProviderConfig;
	readonly #fetch: ServiceHttpFetch;
	readonly #units: SharedExecutionUnitControl;
	readonly #identityAuthority: SharedExecutionIdentityAuthority;
	readonly #account: (name: string) => Promise<SharedExecutionAccount>;
	readonly #now: () => number;
	readonly #requireIdentityMount: boolean | undefined;
	readonly #identityOwnerUid: number | undefined;
	readonly #accounts = new Map<string, SharedExecutionAccount>();
	/** Acquisitions whose retirement is in flight; a second retire of the same one is a no-op. */
	readonly #retiring = new Set<string>();
	#serial: Promise<void> = Promise.resolve();

	constructor(config: SharedExecutionProviderConfig, dependencies: SharedExecutionProviderDependencies = {}) {
		validateConfig(config);
		this.adapterId = config.adapterId;
		this.#config = { ...config, nativeCompanyRuntime: structuredClone(config.nativeCompanyRuntime) };
		this.#fetch = dependencies.fetch ?? fetch;
		this.#units = dependencies.units ?? new SystemctlUnitControl();
		this.#identityAuthority =
			dependencies.identityAuthority ??
			supabaseSharedExecutionIdentityAuthority(config.supabaseUrl, config.supabaseServiceKey, this.#fetch);
		this.#account = dependencies.account ?? systemAccount;
		this.#now = dependencies.now ?? Date.now;
		this.#requireIdentityMount = dependencies.requireIdentityMount;
		this.#identityOwnerUid = dependencies.identityOwnerUid;
	}

	get slotCount(): number {
		return this.#config.slotCount;
	}

	/** Every live journal is reconciled on every pass; one failing journal must
	 * not stop the retirement of finished sandboxes behind it. Unit states are
	 * read in one query, and no lock is held while units are stopped. */
	async reconcile(signal?: AbortSignal): Promise<void> {
		await this.#exclusive(() => this.#ensureRoots());
		const journals = await this.#journals();
		// Terminal journals still in the live directory (written before archiving
		// existed, or by an interrupted archive) move out of the live set here.
		for (const journal of journals.filter((journal) => terminal(journal.physicalState)))
			await this.#exclusive(() => this.#archive(journal));
		const live = journals.filter((journal) => !terminal(journal.physicalState));
		const active = await this.#units.activeSet(
			live.flatMap((journal) => [this.#unit("host", journal.slot), this.#unit("runner", journal.slot)]),
			signal,
		);
		const failures: unknown[] = [];
		for (const journal of live) {
			try {
				await this.#reconcileJournal(journal, active, signal);
			} catch (error) {
				if (signal?.aborted) throw error;
				failures.push(error);
			}
		}
		if (failures.length === 1) throw failures[0];
		if (failures.length > 1)
			throw new AggregateError(failures, "Shared execution reconcile failed for several sandboxes");
	}

	async close(): Promise<void> {
		// Sandboxes are systemd units: they outlive this process and are
		// reconciled by the next one from their journals.
	}

	async acquire(acquisitionKey: string, work: CloudRunnerWork, signal: AbortSignal): Promise<CloudRunnerInstance> {
		assertGovernedWork(work);
		if (acquisitionKey !== work.runId) throw new Error("Provider acquisition must use the immutable run id");
		const acquisitionId = runAttemptAcquisitionId(work.runId, work.attempt);
		const digest = workSha256(work);
		const journal = await this.#exclusive(async (): Promise<SharedExecutionJournal> => {
			await this.#ensureRoots();
			const current = await this.#readJournal(acquisitionId);
			if (current) {
				if (current.workSha256 !== digest)
					throw new Error("Shared execution acquisition id is bound to another immutable work request");
				if (current.physicalState === "stopping")
					throw new ProviderAdmissionRefused(
						"deferred",
						REFUSAL_RETIRING,
						"Shared execution sandbox for this acquisition is still retiring",
					);
				return current;
			}
			// A retired sandbox for this acquisition was archived; a retry of the
			// same attempt starts a fresh one. Prior attempts still holding a slot
			// must finish retiring first; a newer attempt never yields to an older one.
			for (const prior of await this.#journals()) {
				if (prior.runId !== work.runId || prior.acquisitionId === acquisitionId || terminal(prior.physicalState))
					continue;
				if (prior.attempt >= work.attempt) throw new Error("Shared execution refuses an older run attempt");
				throw new ProviderAdmissionRefused(
					"deferred",
					REFUSAL_RETIRING,
					"Shared execution prior run attempt has not retired its sandbox",
				);
			}
			const slot = await this.#freeSlot();
			if (slot === undefined)
				throw new ProviderAdmissionRefused("deferred", REFUSAL_CAPACITY, "Every sandbox slot is busy");
			const credentials = await this.#slotCredentials(slot, true);
			const runner = exactRunner(
				await this.#rpc(
					"qorpera_provision_execution_runner",
					{
						p_run_id: work.runId,
						p_client_runner_id: acquisitionId,
						p_provider_adapter: this.adapterId,
						p_activation_token_sha256: sha256(credentials.activationToken),
					},
					signal,
				),
				work,
				this.adapterId,
			);
			const now = new Date(this.#now()).toISOString();
			const created: SharedExecutionJournal = {
				schema: JOURNAL_SCHEMA,
				acquisitionId,
				runId: work.runId,
				attempt: work.attempt,
				workSha256: digest,
				jobType: work.jobType,
				profileId: work.profileId,
				computeIdentityId: work.computeIdentityId,
				slot,
				hostPort: this.#config.portBase + slot * 2,
				inboxPort: this.#config.portBase + slot * 2 + 1,
				instanceSha256: sha256(
					JSON.stringify(
						canonical({
							host: this.#config.hostId,
							adapter: this.adapterId,
							slot,
							work: digest,
							runtime: sha256(JSON.stringify(canonical(this.#config.nativeCompanyRuntime))),
						}),
					),
				),
				runner,
				physicalState: "reserving",
				credentials: {
					activationSha256: sha256(credentials.activationToken),
					assignmentSha256: sha256(credentials.assignmentToken),
					nativeBridgeSha256: sha256(credentials.nativeBridgeToken),
				},
				createdAt: now,
				updatedAt: now,
			};
			await this.#writeJournal(created);
			return created;
		});
		return this.#ensureReady(journal, work, signal);
	}

	async deliver(
		runner: CloudRunnerInstance,
		delivery: CloudRunnerAssignmentDelivery,
		signal?: AbortSignal,
	): Promise<void> {
		validateCloudRunnerWork(delivery.work);
		const acquisitionId = runAttemptAcquisitionId(delivery.work.runId, delivery.work.attempt);
		const current = await this.#exclusive(async () => {
			const journal = await this.#readJournal(acquisitionId);
			if (
				!journal ||
				journal.runner.runnerId !== runner.runnerId ||
				journal.runner.runnerId !== delivery.assignment.runnerId ||
				journal.workSha256 !== workSha256(delivery.work) ||
				(journal.physicalState !== "registered" && journal.physicalState !== "assigned")
			)
				throw new Error("Shared execution sandbox is unavailable for this assignment");
			if (journal.assignmentId && journal.assignmentId !== delivery.assignment.assignmentId)
				throw new Error("Shared execution sandbox is already fenced to another assignment");
			return journal;
		});
		const credentials = await this.#slotCredentials(current.slot, false);
		if (sha256(credentials.assignmentToken) !== current.credentials.assignmentSha256)
			throw new Error("Shared execution slot credentials differ from the sandbox journal");
		const response = await this.#fetch(`http://127.0.0.1:${current.inboxPort}/v1/assignment`, {
			method: "POST",
			headers: { authorization: `Bearer ${credentials.assignmentToken}`, "content-type": "application/json" },
			body: JSON.stringify({
				schema: "qorpera.runner-assignment-delivery/v1",
				assignment_id: delivery.assignment.assignmentId,
				job_id: delivery.assignment.jobId,
				capability: delivery.capability,
			}),
			signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000),
		});
		if (response.status !== 200 && response.status !== 202)
			throw new Error(`Shared execution sandbox rejected assignment delivery (${response.status})`);
		await this.#exclusive(async () => {
			const journal = await this.#readJournal(acquisitionId);
			if (journal && (journal.physicalState === "registered" || journal.physicalState === "assigned"))
				await this.#writeJournal({
					...journal,
					physicalState: "assigned",
					assignmentId: delivery.assignment.assignmentId,
				});
		});
	}

	async stop(
		runner: CloudRunnerInstance,
		reason: "delivery_failed" | "idle" | "revoked",
		signal?: AbortSignal,
	): Promise<void> {
		const current = (await this.#journals()).find((journal) => journal.runner.runnerId === runner.runnerId);
		if (!current || terminal(current.physicalState)) return;
		await this.#retire(current.acquisitionId, reason, signal);
	}

	async #ensureReady(
		journal: SharedExecutionJournal,
		work: CloudRunnerWork,
		signal: AbortSignal,
	): Promise<CloudRunnerInstance> {
		if (journal.physicalState === "registered" || journal.physicalState === "assigned") return journal.runner;
		const timeout = AbortSignal.any([signal, AbortSignal.timeout(this.#config.startTimeoutMs ?? 30_000)]);
		try {
			let current = journal;
			if (current.physicalState === "reserving") {
				await this.#reserveMachine(current, timeout);
				current = await this.#exclusive(async () => {
					const reserved = (await this.#readJournal(current.acquisitionId)) ?? current;
					await this.#writeMaterial(reserved, work, timeout);
					const next = { ...reserved, physicalState: "starting" as const };
					await this.#writeJournal(next);
					return next;
				});
			}
			// A replay after a restart may find either unit not yet started.
			if (!(await this.#units.active(this.#unit("host", current.slot), timeout)))
				await this.#units.start(this.#unit("host", current.slot), timeout);
			await this.#waitHealthy(current.hostPort, timeout, "native provider host");
			if (!(await this.#units.active(this.#unit("runner", current.slot), timeout)))
				await this.#units.start(this.#unit("runner", current.slot), timeout);
			await this.#waitHealthy(current.inboxPort, timeout, "runner assignment inbox");
			return this.#exclusive(async () => {
				const latest = (await this.#readJournal(current.acquisitionId)) ?? current;
				if (latest.physicalState === "starting")
					await this.#writeJournal({ ...latest, physicalState: "registered" });
				return latest.runner;
			});
		} catch (error) {
			await this.#retire(journal.acquisitionId, "delivery_failed").catch(() => undefined);
			throw error;
		}
	}

	async #waitHealthy(port: number, signal: AbortSignal, label: string): Promise<void> {
		for (;;) {
			signal.throwIfAborted();
			try {
				const response = await this.#fetch(`http://127.0.0.1:${port}/healthz`, {
					signal: AbortSignal.any([signal, AbortSignal.timeout(500)]),
				});
				void response.body?.cancel().catch(() => undefined);
				if (response.ok) return;
			} catch (error) {
				if (signal.aborted) throw new Error(`Shared execution ${label} did not become ready`, { cause: error });
			}
			await delay(100, signal).catch(() => {
				throw new Error(`Shared execution ${label} did not become ready`);
			});
		}
	}

	/** The reservation call is journaled before it is sent: if the reply is
	 * lost, retire still owes a release, and tolerates one that finds nothing. */
	async #reserveMachine(current: SharedExecutionJournal, signal: AbortSignal): Promise<void> {
		if (current.capacityReleased) throw new Error("Released sandbox capacity cannot be reserved again");
		if (!current.capacityRequested) {
			await this.#exclusive(async () => {
				const latest = (await this.#readJournal(current.acquisitionId)) ?? current;
				await this.#writeJournal({ ...latest, capacityRequested: true });
			});
		}
		const result = record(
			await this.#rpc(
				"qorpera_reserve_runtime_machine",
				{
					p_allocation_id: current.acquisitionId,
					p_provider_adapter: this.adapterId,
					p_instance_sha256: current.instanceSha256,
					p_run_id: current.runId,
					p_runner_id: current.runner.runnerId,
				},
				signal,
			),
			"Machine reservation",
		);
		if (
			(result.state === "refused" || result.state === "deferred") &&
			typeof result.reason === "string" &&
			/^[A-Z_]{3,64}$/.test(result.reason)
		) {
			// A committed refusal means no allocation exists: nothing is owed.
			await this.#exclusive(async () => {
				const latest = (await this.#readJournal(current.acquisitionId)) ?? current;
				await this.#writeJournal({ ...latest, capacityRequested: false });
			});
			throw new ProviderAdmissionRefused(
				result.state,
				result.reason,
				"Sandbox start was not admitted by the company ceiling",
			);
		}
		if (
			Object.keys(result).sort().join() !== "allocationId,instanceSha256,state" ||
			result.state !== "reserved" ||
			result.allocationId !== current.acquisitionId ||
			result.instanceSha256 !== current.instanceSha256
		)
			throw new Error("Sandbox start was not admitted by the company ceiling");
		await this.#exclusive(async () => {
			const latest = (await this.#readJournal(current.acquisitionId)) ?? current;
			await this.#writeJournal({ ...latest, capacityRegistered: true });
		});
	}

	/** Release exactly once. A confirmed reservation must be confirmed released;
	 * a reservation whose reply was lost is released on a best-effort basis. */
	async #releaseMachine(current: SharedExecutionJournal, signal?: AbortSignal): Promise<void> {
		if (current.capacityReleased || (!current.capacityRequested && !current.capacityRegistered)) return;
		let result: Record<string, unknown> | undefined;
		try {
			result = record(
				await this.#rpc(
					"qorpera_release_runtime_machine",
					{
						p_allocation_id: current.acquisitionId,
						p_provider_adapter: this.adapterId,
						p_instance_sha256: current.instanceSha256,
					},
					signal,
				),
				"Machine release",
			);
		} catch (error) {
			if (current.capacityRegistered) throw error;
			return;
		}
		const confirmed =
			Object.keys(result).sort().join() === "allocationId,instanceSha256,state" &&
			result.state === "released" &&
			result.allocationId === current.acquisitionId &&
			result.instanceSha256 === current.instanceSha256;
		if (!confirmed && current.capacityRegistered) throw new Error("Sandbox capacity release was not confirmed");
	}

	/** Stop both units, wipe the slot, release the company ceiling exactly once
	 * and record the terminal state. Runs in three phases so that no lock is
	 * held while units are stopping; a second retire of the same acquisition
	 * while one is in flight is a no-op. After MAX_RETIRE_ATTEMPTS failures the
	 * sandbox is recorded as lost: the slot returns to service and the archived
	 * journal keeps the reason. */
	async #retire(acquisitionId: string, reason: string, signal?: AbortSignal): Promise<void> {
		if (this.#retiring.has(acquisitionId)) return;
		this.#retiring.add(acquisitionId);
		try {
			const marked = await this.#exclusive(async () => {
				const current = await this.#readJournal(acquisitionId);
				if (!current || terminal(current.physicalState)) return undefined;
				const next = { ...current, physicalState: "stopping" as const, stopReason: current.stopReason ?? reason };
				await this.#writeJournal(next);
				return next;
			});
			if (!marked) return;
			await this.#units.stop(this.#unit("runner", marked.slot), signal).catch(() => undefined);
			await this.#units.stop(this.#unit("host", marked.slot), signal).catch(() => undefined);
			const stillActive = await this.#units.activeSet(
				[this.#unit("runner", marked.slot), this.#unit("host", marked.slot)],
				signal,
			);
			await this.#exclusive(async () => {
				const current = (await this.#readJournal(acquisitionId)) ?? marked;
				if (terminal(current.physicalState)) return;
				try {
					if (stillActive.size > 0) throw new Error("Sandbox units are still running; capacity remains occupied");
					await this.#wipeSlot(current.slot);
					await this.#releaseMachine(current, signal);
				} catch (error) {
					const attempts = (current.retireAttempts ?? 0) + 1;
					if (attempts < MAX_RETIRE_ATTEMPTS) {
						await this.#writeJournal({ ...current, retireAttempts: attempts });
						throw error;
					}
					await this.#archive({
						...current,
						physicalState: "lost",
						retireAttempts: attempts,
						stopReason: `${current.stopReason ?? reason}: ${error instanceof Error ? error.message : String(error)}`,
					});
					return;
				}
				await this.#archive({ ...current, physicalState: "stopped", capacityReleased: true });
			});
		} finally {
			this.#retiring.delete(acquisitionId);
		}
	}

	async #reconcileJournal(
		current: SharedExecutionJournal,
		active: ReadonlySet<string>,
		signal?: AbortSignal,
	): Promise<void> {
		switch (current.physicalState) {
			case "stopped":
			case "lost":
				return;
			case "stopping":
				await this.#retire(current.acquisitionId, current.stopReason ?? "idle", signal);
				return;
			case "reserving":
			case "starting": {
				const age = this.#now() - Date.parse(current.updatedAt);
				if (age > RESERVING_RETIREMENT_MS) await this.#retire(current.acquisitionId, "delivery_failed", signal);
				return;
			}
			case "registered":
			case "assigned": {
				// One sandbox serves exactly one run: when its runner unit has
				// exited (success or failure), the run is over and the slot is free.
				if (!active.has(this.#unit("runner", current.slot)))
					await this.#retire(current.acquisitionId, "idle", signal);
				return;
			}
		}
	}

	async #freeSlot(): Promise<number | undefined> {
		const busy = new Set<number>();
		for (const journal of await this.#journals()) if (!terminal(journal.physicalState)) busy.add(journal.slot);
		for (let slot = 0; slot < this.#config.slotCount; slot++) if (!busy.has(slot)) return slot;
		return undefined;
	}

	#unit(kind: "host" | "runner", slot: number): string {
		return `${kind === "host" ? this.#config.hostUnitPrefix : this.#config.runnerUnitPrefix}${slot}.service`;
	}

	#slotRun(slot: number): string {
		return join(this.#config.runRoot, "slots", String(slot));
	}

	#slotState(slot: number): string {
		return join(this.#config.stateRoot, "slots", String(slot));
	}

	#journalPath(acquisitionId: string): string {
		return join(this.#config.stateRoot, "journals", `${acquisitionId}.json`);
	}

	async #slotAccount(kind: "host" | "runner", slot: number): Promise<SharedExecutionAccount> {
		const name = `${kind === "host" ? this.#config.hostAccountPrefix : this.#config.runnerAccountPrefix}-${slot}`;
		let account = this.#accounts.get(name);
		if (!account) {
			account = await this.#account(name);
			this.#accounts.set(name, account);
		}
		return account;
	}

	/** The slot accounts traverse the state root to reach their own scratch
	 * (0711); journals and the tmpfs material stay root-only (0700). */
	async #ensureRoots(): Promise<void> {
		for (const [path, mode] of [
			[this.#config.stateRoot, 0o711],
			[join(this.#config.stateRoot, "journals"), 0o700],
			[join(this.#config.stateRoot, "journals", "archive"), 0o700],
			[join(this.#config.stateRoot, "slots"), 0o711],
			[this.#config.runRoot, 0o700],
			[join(this.#config.runRoot, "slots"), 0o700],
		] as const) {
			await mkdir(path, { recursive: true, mode });
			await chmod(path, mode);
		}
	}

	/** Slot credentials live on the tmpfs run root for the sandbox's lifetime.
	 * A fresh sandbox mints new ones; a replay reuses the journaled ones. */
	async #slotCredentials(slot: number, fresh: boolean): Promise<SlotCredentials> {
		const directory = join(this.#slotRun(slot), "credentials");
		await mkdir(directory, { recursive: true, mode: 0o700 });
		await chmod(directory, 0o700);
		const read = async (name: string): Promise<string> => {
			const path = join(directory, name);
			if (fresh) {
				const value = token();
				await rm(path, { force: true });
				await writePrivateFile(path, `${value}\n`);
				return value;
			}
			const value = (await readFile(path, "utf-8")).trim();
			if (!TOKEN_PATTERN.test(value)) throw new Error("Stored slot credential is invalid");
			return value;
		};
		return {
			activationToken: await read("qorpera-runner-activation"),
			assignmentToken: await read("qorpera-runner-assignment"),
			nativeBridgeToken: await read("qorpera-native-bridge"),
		};
	}

	/** Everything PID 1 hands to the two units: credentials (LoadCredential=)
	 * and the native host environment (EnvironmentFile=), plus the runner
	 * configuration written into the runner account's own state directory. */
	async #writeMaterial(current: SharedExecutionJournal, work: CloudRunnerWork, signal: AbortSignal): Promise<void> {
		const runtime = this.#config.nativeCompanyRuntime;
		const credentials = await this.#slotCredentials(current.slot, false);
		if (
			sha256(credentials.activationToken) !== current.credentials.activationSha256 ||
			sha256(credentials.assignmentToken) !== current.credentials.assignmentSha256 ||
			sha256(credentials.nativeBridgeToken) !== current.credentials.nativeBridgeSha256
		)
			throw new Error("Shared execution slot credentials differ from the sandbox journal");
		const office = runtime.offices?.find(
			(route) => route.companyId === work.profileId && route.environmentId === work.environmentId,
		);
		if (office && Object.values(credentials).includes(office.token))
			throw new Error("Governed native office credential must be independent");
		if (
			[runtime.objectGatewayToken, runtime.secretBroker.runtimeToken].some((value) =>
				Object.values(credentials).includes(value),
			)
		)
			throw new Error("Governed native runtime credentials must be independent");
		const identity = await readSharedExecutionIdentity({
			identityRoot: this.#config.identityRoot,
			computeIdentityId: current.computeIdentityId,
			authority: this.#identityAuthority,
			signal,
			...(this.#requireIdentityMount === undefined ? {} : { requireMount: this.#requireIdentityMount }),
			...(this.#identityOwnerUid === undefined ? {} : { expectedUid: this.#identityOwnerUid }),
		});
		if (identity.masterKey === credentials.nativeBridgeToken || identity.masterKey === credentials.activationToken)
			throw new Error("Native identity key must be independent of slot credentials");
		const hostAccount = await this.#slotAccount("host", current.slot);
		const runnerAccount = await this.#slotAccount("runner", current.slot);
		const hostState = join(this.#slotState(current.slot), "host");
		const runnerState = join(this.#slotState(current.slot), "runner");
		await mkdir(this.#slotState(current.slot), { recursive: true, mode: 0o711 });
		await chmod(this.#slotState(current.slot), 0o711);
		for (const [path, account] of [
			[hostState, hostAccount],
			[runnerState, runnerAccount],
			[join(runnerState, "state"), runnerAccount],
			[join(runnerState, "workspace"), runnerAccount],
		] as const) {
			await mkdir(path, { recursive: true, mode: 0o700 });
			await chmod(path, 0o700);
			await chown(path, account.uid, account.gid);
		}
		await emptyDirectory(hostState);
		await emptyDirectory(join(runnerState, "state"));
		await emptyDirectory(join(runnerState, "workspace"));
		const runnerConfig = JSON.stringify(
			{
				schema: "qorpera.ephemeral-runner-service/v1",
				base_url: this.#config.supabaseUrl,
				publishable_key: this.#config.supabasePublishableKey,
				runner_id: current.runner.runnerId,
				authority_state_path: join(runnerState, "state", "authority.json"),
				temporary_root: join(runnerState, "workspace"),
				image: this.#config.runnerImage,
				podman_path: this.#config.runnerPodmanPath,
				entrypoint: this.#config.runnerEntrypoint,
				capabilities: [...current.runner.capabilities],
				job_types: [work.jobType],
				platform: "linux-x64",
				runner_version: this.#config.runnerVersion,
				native_bridge_url: `http://127.0.0.1:${current.hostPort}/`,
				native_bridge_boundary: "virtual_machine",
				assignment_host: "127.0.0.1",
				assignment_port: current.inboxPort,
				max_assignments: 1,
				environment: {},
			},
			null,
			2,
		);
		const nativeProviderEnvironment = [
			`QORPERA_SUPABASE_URL=${this.#config.supabaseUrl}`,
			"QORPERA_NATIVE_PROVIDER_EXECUTION_BOUNDARY=virtual_machine",
			`QORPERA_NATIVE_PROVIDER_COMPUTE_IDENTITY_ID=${current.computeIdentityId}`,
			"QORPERA_NATIVE_PROVIDER_HOST=127.0.0.1",
			`QORPERA_NATIVE_PROVIDER_PORT=${current.hostPort}`,
			`QORPERA_NATIVE_PROVIDER_TEMPORARY_ROOT=${hostState}`,
			`QORPERA_CODEX_PATH=${this.#config.codexPath}`,
			`QORPERA_CLAUDE_PATH=${this.#config.claudePath}`,
			"QORPERA_NATIVE_RUNTIME=company-path-v1",
			`QORPERA_NATIVE_CODEX_FENCE_PATH=${runtime.codexPath}`,
			`QORPERA_NATIVE_CODEX_FENCE_SHA256=${runtime.binarySha256}`,
			`QORPERA_NATIVE_OBJECT_GATEWAY_URL=${runtime.objectGatewayUrl}`,
			`QORPERA_CLOUD_SECRET_BROKER_URL=${runtime.secretBroker.origin}`,
			...(office ? [`QORPERA_COMPANY_COMPUTER_URL=${office.url}`] : []),
			"",
		].join("\n");
		const slotRun = this.#slotRun(current.slot);
		const credentialDirectory = join(slotRun, "credentials");
		const files: Array<[string, string]> = [
			[join(slotRun, "native-provider.env"), nativeProviderEnvironment],
			[join(credentialDirectory, "qorpera-supabase-service-key"), `${this.#config.supabaseServiceKey}\n`],
			[join(credentialDirectory, "qorpera-native-object-token"), `${runtime.objectGatewayToken}\n`],
			[join(credentialDirectory, "qorpera-cloud-secret-runtime"), `${runtime.secretBroker.runtimeToken}\n`],
			[join(credentialDirectory, "qorpera-cloud-secret-ca"), runtime.secretBroker.caCertificate],
			// An unconfigured route has no authority; the credential source still exists and is empty.
			[join(credentialDirectory, "qorpera-office-native"), office ? `${office.token}\n` : ""],
			[join(credentialDirectory, "qorpera-native-provider-master-key"), `${identity.masterKey}\n`],
			[join(credentialDirectory, "qorpera-native-identity-epoch"), identity.epochCredential],
		];
		for (const [path, content] of files) {
			await rm(path, { force: true });
			await writePrivateFile(path, content);
		}
		// The runner reads its configuration from a file it owns, as the one-run
		// guest bootstrap installs it under the runner account.
		const runnerConfigPath = join(runnerState, "config.json");
		await rm(runnerConfigPath, { force: true });
		await writePrivateFile(runnerConfigPath, `${runnerConfig}\n`, runnerAccount);
	}

	async #wipeSlot(slot: number): Promise<void> {
		await rm(this.#slotRun(slot), { recursive: true, force: true });
		await emptyDirectory(join(this.#slotState(slot), "host"));
		await emptyDirectory(join(this.#slotState(slot), "runner", "state"));
		await emptyDirectory(join(this.#slotState(slot), "runner", "workspace"));
	}

	/** Live journals only: terminal ones move to `journals/archive/`. */
	async #journals(): Promise<SharedExecutionJournal[]> {
		const directory = join(this.#config.stateRoot, "journals");
		let entries: string[];
		try {
			entries = await readdir(directory);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
			throw error;
		}
		const journals: SharedExecutionJournal[] = [];
		for (const entry of entries.sort()) {
			if (!entry.endsWith(".json")) continue;
			const journal = await this.#readJournal(entry.slice(0, -".json".length));
			if (journal) journals.push(journal);
		}
		return journals;
	}

	async #readJournal(acquisitionId: string): Promise<SharedExecutionJournal | undefined> {
		if (!UUID_PATTERN.test(acquisitionId)) return undefined;
		const path = this.#journalPath(acquisitionId);
		let encoded: string;
		try {
			const metadata = await stat(path);
			if (!metadata.isFile() || metadata.size > MAX_JOURNAL_BYTES)
				throw new Error("Shared execution journal is invalid");
			encoded = await readFile(path, "utf-8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			throw error;
		}
		const journal = JSON.parse(encoded) as SharedExecutionJournal;
		if (journal.schema !== JOURNAL_SCHEMA || journal.acquisitionId !== acquisitionId)
			throw new Error("Shared execution journal is invalid");
		return journal;
	}

	async #writeJournal(journal: SharedExecutionJournal): Promise<void> {
		const next = { ...journal, updatedAt: new Date(this.#now()).toISOString() };
		const path = this.#journalPath(journal.acquisitionId);
		await mkdir(join(this.#config.stateRoot, "journals"), { recursive: true, mode: 0o700 });
		const temporary = `${path}.${process.pid}.tmp`;
		await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf-8", mode: 0o600, flag: "w" });
		await rename(temporary, path);
	}

	/** Record the terminal state and move the journal out of the live set. The
	 * archived file keeps the acquisition id and its retirement timestamp. */
	async #archive(journal: SharedExecutionJournal): Promise<void> {
		await this.#writeJournal(journal);
		const archive = join(this.#config.stateRoot, "journals", "archive");
		await mkdir(archive, { recursive: true, mode: 0o700 });
		await rename(
			this.#journalPath(journal.acquisitionId),
			join(archive, `${journal.acquisitionId}.${this.#now()}.${journal.physicalState}.json`),
		);
	}

	async #rpc(name: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
		const response = await this.#fetch(new URL(`/rest/v1/rpc/${name}`, this.#config.supabaseUrl), {
			method: "POST",
			redirect: "error",
			headers: { ...supabaseServiceHeaders(this.#config.supabaseServiceKey), "content-type": "application/json" },
			body: JSON.stringify(body),
			signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
		});
		if (!response.ok) {
			void response.body?.cancel().catch(() => undefined);
			throw new Error(`Runner provisioning failed (${response.status})`);
		}
		return response.json() as Promise<unknown>;
	}

	async #exclusive<T>(action: () => Promise<T>): Promise<T> {
		const previous = this.#serial;
		let release = (): void => undefined;
		this.#serial = new Promise<void>((resolveWait) => {
			release = resolveWait;
		});
		await previous;
		try {
			return await action();
		} finally {
			release();
		}
	}
}
