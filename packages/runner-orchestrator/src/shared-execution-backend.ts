import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
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
 * orchestrator sees one provider with the node's native adapter id. */

const JOURNAL_SCHEMA = "qorpera.shared-execution-journal/v1";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ADAPTER_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;
const IMAGE_PATTERN = /^[a-z0-9][a-z0-9._:/-]*@sha256:[0-9a-f]{64}$/;
const UNIT_PREFIX_PATTERN = /^[a-z][a-z0-9-]{0,48}@$/;
const ACCOUNT_PREFIX_PATTERN = /^[a-z][a-z0-9-]{0,24}$/;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const RESERVING_RETIREMENT_MS = 10 * 60_000;
const MAX_JOURNAL_BYTES = 64 * 1024;

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
	capacityRegistered?: boolean;
	capacityReleased?: boolean;
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

function record(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} is invalid`);
	return value as Record<string, unknown>;
}

function canonical(value: unknown): unknown {
	if (Array.isArray(value)) return value.map((entry) => canonical(entry));
	if (!value || typeof value !== "object") return value;
	const output: Record<string, unknown> = {};
	for (const key of Object.keys(value).sort()) {
		const entry = (value as Record<string, unknown>)[key];
		if (entry !== undefined) output[key] = canonical(entry);
	}
	return output;
}

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function uuid(value: unknown, label: string): string {
	if (typeof value !== "string" || !UUID_PATTERN.test(value)) throw new Error(`${label} is invalid`);
	return value;
}

function token(): string {
	return randomBytes(32).toString("base64url");
}

function supabaseServiceHeaders(serviceKey: string): Record<string, string> {
	const headers: Record<string, string> = { apikey: serviceKey };
	if (serviceKey.startsWith("eyJ") && serviceKey.split(".").length === 3) {
		headers.authorization = `Bearer ${serviceKey}`;
	}
	return headers;
}

/** The control plane annotates each dispatch with attempt-scoped fields; a
 * retry is the same immutable run, so the journal digest must not vary with them. */
function workSha256(work: CloudRunnerWork): string {
	const { attempt: _attempt, ...immutable } = work as CloudRunnerWork & { attempt?: unknown };
	return sha256(JSON.stringify(canonical(immutable)));
}

/** Same derivation as the LXD provider: a control-plane continuation gets a
 * new sandbox, never a replay of the prior attempt's credentials or activation. */
export function sharedExecutionAcquisitionId(runId: string, attempt: number): string {
	if (attempt === 1) return runId;
	const digest = sha256(`qorpera.lxd-run-attempt/v1:${runId}:${attempt}`);
	const variant = ((Number.parseInt(digest[16] ?? "0", 16) & 0x3) | 0x8).toString(16);
	return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-8${digest.slice(13, 16)}-${variant}${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

function exactRunner(value: unknown, work: CloudRunnerWork, adapterId: string): CloudRunnerInstance {
	const input = record(value, "Provisioned runner");
	if (
		input.runner_kind !== "qorpera_computer" ||
		input.provider_adapter !== adapterId ||
		input.status === "revoked" ||
		input.compute_identity_id !== work.computeIdentityId ||
		input.logical_computer_id !== (work.logicalComputerId ?? null) ||
		input.worker_class !== work.workerClass ||
		input.template_key !== work.computeTemplateKey ||
		input.template_version !== work.computeTemplateVersion ||
		input.compute_policy_sha256 !== work.computePolicySha256 ||
		!Array.isArray(input.capabilities) ||
		!input.capabilities.includes(work.requiredCapability)
	) {
		throw new Error("Provisioned runner does not match immutable compute authority");
	}
	return {
		runnerId: uuid(input.runner_id, "Provisioned runner id"),
		...(work.logicalComputerId ? { logicalComputerId: work.logicalComputerId } : {}),
		...(work.computeIdentityId ? { computeIdentityId: work.computeIdentityId } : {}),
		workerClass: work.workerClass,
		providerAdapter: adapterId,
		capabilities: input.capabilities as CloudRunnerInstance["capabilities"],
		templateKey: work.computeTemplateKey as string,
		templateVersion: work.computeTemplateVersion as string,
		policySha256: work.computePolicySha256 as string,
	};
}

export class SharedExecutionAdmissionRefused extends Error {
	readonly category = "admission_refused" as const;
	readonly state: "refused" | "deferred";
	readonly reason: string;

	constructor(state: "refused" | "deferred", reason: string) {
		super("Sandbox start was not admitted");
		this.name = "SharedExecutionAdmissionRefused";
		this.state = state;
		this.reason = reason;
	}
}

class SystemctlUnitControl implements SharedExecutionUnitControl {
	async start(unit: string, signal?: AbortSignal): Promise<void> {
		await execFileAsync("/usr/bin/systemctl", ["start", "--no-block", unit], { signal, timeout: 30_000 });
	}
	async stop(unit: string, signal?: AbortSignal): Promise<void> {
		await execFileAsync("/usr/bin/systemctl", ["stop", unit], { signal, timeout: 90_000 });
	}
	async active(unit: string, signal?: AbortSignal): Promise<boolean> {
		try {
			const { stdout } = await execFileAsync("/usr/bin/systemctl", ["is-active", unit], { signal, timeout: 10_000 });
			return stdout.trim() === "active" || stdout.trim() === "activating";
		} catch (error) {
			// `is-active` exits non-zero for inactive and failed units.
			const output = (error as { stdout?: string }).stdout?.trim();
			if (output === "active" || output === "activating") return true;
			return false;
		}
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
		throw new Error("Governed native runtime requires the pinned Codex subscription harness");
	if (work.jobType === "proposal_review")
		throw new Error("Shared execution serves live turn work; proposal review keeps its copy-isolated guest");
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

	/** Every journal is reconciled on every pass; one failing journal must not
	 * stop the retirement of finished sandboxes behind it. */
	async reconcile(signal?: AbortSignal): Promise<void> {
		await this.#exclusive(async () => {
			await this.#ensureRoots();
			const failures: unknown[] = [];
			for (const journal of await this.#journals()) {
				try {
					await this.#reconcileJournal(journal, signal);
				} catch (error) {
					if (signal?.aborted) throw error;
					failures.push(error);
				}
			}
			if (failures.length === 1) throw failures[0];
			if (failures.length > 1)
				throw new AggregateError(failures, "Shared execution reconcile failed for several sandboxes");
		});
	}

	async close(): Promise<void> {
		// Sandboxes are systemd units: they outlive this process and are
		// reconciled by the next one from their journals.
	}

	async acquire(acquisitionKey: string, work: CloudRunnerWork, signal: AbortSignal): Promise<CloudRunnerInstance> {
		assertGovernedWork(work);
		if (acquisitionKey !== work.runId) throw new Error("Provider acquisition must use the immutable run id");
		const acquisitionId = sharedExecutionAcquisitionId(work.runId, work.attempt);
		const digest = workSha256(work);
		const journal = await this.#exclusive(async (): Promise<SharedExecutionJournal> => {
			await this.#ensureRoots();
			const current = await this.#readJournal(acquisitionId);
			if (current) {
				if (current.workSha256 !== digest)
					throw new Error("Shared execution acquisition id is bound to another immutable work request");
				if (
					current.physicalState === "stopping" ||
					current.physicalState === "stopped" ||
					current.physicalState === "lost"
				)
					throw new Error(`Shared execution acquisition is ${current.physicalState} and cannot be replayed`);
				return current;
			}
			for (const prior of await this.#journals()) {
				if (prior.runId !== work.runId || prior.acquisitionId === acquisitionId) continue;
				if (prior.attempt >= work.attempt) throw new Error("Shared execution refuses an older run attempt");
				if (prior.physicalState !== "stopped" && prior.physicalState !== "lost")
					throw new Error("Shared execution prior run attempt has not retired its sandbox");
			}
			const slot = await this.#freeSlot();
			if (slot === undefined) throw new SharedExecutionAdmissionRefused("deferred", "SANDBOX_CAPACITY_EXHAUSTED");
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
		const acquisitionId = sharedExecutionAcquisitionId(delivery.work.runId, delivery.work.attempt);
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
		await this.#exclusive(async () => {
			const current = (await this.#journals()).find((journal) => journal.runner.runnerId === runner.runnerId);
			if (!current || current.physicalState === "stopped" || current.physicalState === "lost") return;
			await this.#retire(current, reason, signal);
		});
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
					const material = await this.#writeMaterial(reserved, work, timeout);
					const next = { ...reserved, physicalState: "starting" as const, ...material };
					await this.#writeJournal(next);
					return next;
				});
				await this.#units.start(this.#unit("host", current.slot), timeout);
			}
			await this.#waitHealthy(current.hostPort, timeout, "native provider host");
			if (!(await this.#units.active(this.#unit("runner", current.slot), timeout))) {
				await this.#units.start(this.#unit("runner", current.slot), timeout);
			}
			await this.#waitHealthy(current.inboxPort, timeout, "runner assignment inbox");
			return this.#exclusive(async () => {
				const latest = (await this.#readJournal(current.acquisitionId)) ?? current;
				if (latest.physicalState === "starting")
					await this.#writeJournal({ ...latest, physicalState: "registered" });
				return latest.runner;
			});
		} catch (error) {
			await this.#exclusive(async () => {
				const latest = await this.#readJournal(journal.acquisitionId);
				if (latest && latest.physicalState !== "stopped" && latest.physicalState !== "lost")
					await this.#retire(latest, "delivery_failed");
			}).catch(() => undefined);
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

	async #reserveMachine(current: SharedExecutionJournal, signal: AbortSignal): Promise<void> {
		if (current.capacityReleased) throw new Error("Released sandbox capacity cannot be reserved again");
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
		)
			throw new SharedExecutionAdmissionRefused(result.state, result.reason);
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

	async #releaseMachine(current: SharedExecutionJournal, signal?: AbortSignal): Promise<void> {
		if (current.capacityReleased || !current.capacityRegistered) return;
		const result = record(
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
		if (
			Object.keys(result).sort().join() !== "allocationId,instanceSha256,state" ||
			result.state !== "released" ||
			result.allocationId !== current.acquisitionId ||
			result.instanceSha256 !== current.instanceSha256
		)
			throw new Error("Sandbox capacity release was not confirmed");
	}

	/** Stop both units, wipe the slot, release the company ceiling exactly once
	 * and record the terminal state. Safe to repeat. */
	async #retire(current: SharedExecutionJournal, reason: string, signal?: AbortSignal): Promise<void> {
		await this.#writeJournal({ ...current, physicalState: "stopping", stopReason: reason });
		await this.#units.stop(this.#unit("runner", current.slot), signal).catch(() => undefined);
		await this.#units.stop(this.#unit("host", current.slot), signal).catch(() => undefined);
		if (
			(await this.#units.active(this.#unit("runner", current.slot), signal)) ||
			(await this.#units.active(this.#unit("host", current.slot), signal))
		)
			throw new Error("Sandbox units are still running; capacity remains occupied");
		await this.#wipeSlot(current.slot);
		await this.#releaseMachine(current, signal);
		await this.#writeJournal({ ...current, physicalState: "stopped", stopReason: reason, capacityReleased: true });
	}

	async #reconcileJournal(current: SharedExecutionJournal, signal?: AbortSignal): Promise<void> {
		switch (current.physicalState) {
			case "stopped":
			case "lost":
				return;
			case "stopping":
				await this.#retire(current, current.stopReason ?? "idle", signal);
				return;
			case "reserving":
			case "starting": {
				const age = this.#now() - Date.parse(current.updatedAt);
				if (age > RESERVING_RETIREMENT_MS) await this.#retire(current, "delivery_failed", signal);
				return;
			}
			case "registered":
			case "assigned": {
				// One sandbox serves exactly one run: when its runner unit has
				// exited (success or failure), the run is over and the slot is free.
				if (!(await this.#units.active(this.#unit("runner", current.slot), signal)))
					await this.#retire(current, "idle", signal);
				return;
			}
		}
	}

	async #freeSlot(): Promise<number | undefined> {
		const busy = new Set<number>();
		for (const journal of await this.#journals()) {
			if (journal.physicalState !== "stopped" && journal.physicalState !== "lost") busy.add(journal.slot);
		}
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

	async #slotAccount(kind: "host" | "runner", slot: number): Promise<SharedExecutionAccount> {
		const name = `${kind === "host" ? this.#config.hostAccountPrefix : this.#config.runnerAccountPrefix}-${slot}`;
		let account = this.#accounts.get(name);
		if (!account) {
			account = await this.#account(name);
			this.#accounts.set(name, account);
		}
		return account;
	}

	async #ensureRoots(): Promise<void> {
		for (const path of [
			this.#config.stateRoot,
			join(this.#config.stateRoot, "journals"),
			join(this.#config.stateRoot, "slots"),
			this.#config.runRoot,
			join(this.#config.runRoot, "slots"),
		]) {
			await mkdir(path, { recursive: true, mode: 0o700 });
			await chmod(path, 0o700);
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
	 * and the native host environment (EnvironmentFile=). The runner's
	 * configuration travels as a credential too, so it arrives owned by the
	 * runner account without any shared directory. */
	async #writeMaterial(
		current: SharedExecutionJournal,
		work: CloudRunnerWork,
		signal: AbortSignal,
	): Promise<Partial<SharedExecutionJournal>> {
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
			[join(credentialDirectory, "qorpera-runner-config"), `${runnerConfig}\n`],
		];
		for (const [path, content] of files) {
			await rm(path, { force: true });
			await writePrivateFile(path, content);
		}
		return {};
	}

	async #wipeSlot(slot: number): Promise<void> {
		await rm(this.#slotRun(slot), { recursive: true, force: true });
		await emptyDirectory(join(this.#slotState(slot), "host"));
		await emptyDirectory(join(this.#slotState(slot), "runner", "state"));
		await emptyDirectory(join(this.#slotState(slot), "runner", "workspace"));
	}

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
		const path = join(this.#config.stateRoot, "journals", `${acquisitionId}.json`);
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
		const path = join(this.#config.stateRoot, "journals", `${journal.acquisitionId}.json`);
		await mkdir(join(this.#config.stateRoot, "journals"), { recursive: true, mode: 0o700 });
		const temporary = `${path}.${process.pid}.tmp`;
		await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf-8", mode: 0o600, flag: "w" });
		await rename(temporary, path);
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
