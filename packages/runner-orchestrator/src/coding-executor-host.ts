import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";
import {
	type CloudCodingCommandScope,
	type CloudCodingNasPolicy,
	type CloudCodingRepository,
	type CloudCodingStorageBinding,
	cloudCodingSessionLayout,
	parseCloudCodingNasPolicy,
} from "@qorpera/contracts";
import { LxdCodingCommandTransport } from "./coding-command-transport.ts";
import type {
	CodingExecutorHost,
	CodingExecutorPublication,
	CodingHousekeepingOutcome,
	CodingSessionClaim,
	CodingSubmission,
	CodingTurnState,
	CodingWorkspace,
} from "./coding-executor.ts";
import { CodingMachineUnavailable } from "./coding-executor.ts";
import { type CodingBrokerGitRunner, pushCloudCodingBundle } from "./coding-git.ts";
import { fetchCloudCodingSeed, resolveCloudCodingBase } from "./coding-git-seed.ts";
import { LxdCodingGitTransfer } from "./coding-git-transfer.ts";
import { LxdCodingLeaseTransport } from "./coding-lease-transport.ts";
import {
	assertLxdCodingMachineInstance,
	type CodingMachineAdmissionReceipt,
	type CodingMachineDesiredState,
	type CodingMachineIntent,
	type CodingMachineJournalPlan,
	type CodingMachineStorage,
	checkCodingMachineReceipt,
	type LxdCodingMachineBinding,
	lxdCodingMachineJournalPlan,
	lxdCodingMachineName,
	lxdCodingMachinePlan,
	lxdCodingSessionDevices,
	lxdCodingSessionStorage,
	reconcileCodingMachine,
} from "./coding-machine.ts";
import { type CodingNasStorage, createCodingNasStorage } from "./coding-storage.ts";
import { type LxdCodingVmBinding, lxdCodingVmPlan, lxdLegacyCodingMachineJournalPlan } from "./coding-vm.ts";
import { publishCloudCodingDraftPullRequest } from "./coding-workspace.ts";
import type { LxdInspectableClient, LxdInstanceDeviceClient, LxdTrackedClient } from "./lxd-client.ts";
import { checkDirectory, code, publish, readRecord } from "./lxd-office-journal-files.ts";

export const CODING_HOST_RPCS = [
	"qorpera_plan_coding_machine",
	"qorpera_authorize_coding_machine_run",
	"qorpera_authorize_coding_machine_custody",
	"qorpera_suspend_coding_machine",
	"qorpera_release_coding_machine",
	"qorpera_record_coding_machine_error",
	"qorpera_list_coding_machines",
] as const;

/** The leased session a repository token is asked for (bundle v88): the
 * company whose secret broker holds its GitHub connection, and the worker and
 * lease the kernel checks before the broker releases anything. */
export interface CodingRepositoryCredentialScope {
	readonly companyId: string;
	readonly workerId: string;
	readonly leaseToken: string;
}

export interface CodingRepositoryCredentials {
	/** Lends the repository token to `use` for the length of one Git broker or
	 * GitHub API step. The token never leaves the executor's own processes. */
	withRepositoryToken<T>(
		scope: CodingRepositoryCredentialScope,
		repository: CloudCodingRepository,
		use: (token: string) => Promise<T>,
		signal: AbortSignal,
	): Promise<T>;
}

type RepositoryTokenLender = <T>(
	repository: CloudCodingRepository,
	use: (token: string) => Promise<T>,
	signal: AbortSignal,
) => Promise<T>;

/** The environment's VM policy as the executor was configured with it; SQL
 * plans every member machine from the same values. */
export type CodingExecutorVmPolicy = Omit<
	LxdCodingMachineBinding,
	"schema" | "machineId" | "companyId" | "environmentId" | "memberUserId"
>;
export interface LxdCodingExecutorHostOptions {
	control: { call(method: string, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown> };
	owner: string;
	machineIdSha256: string;
	vmPolicy: CodingExecutorVmPolicy;
	storagePolicy: CloudCodingNasPolicy;
	client: Pick<LxdTrackedClient, "getInstance" | "submitInstanceOperation" | "inspectInstanceOperation"> &
		Pick<LxdInspectableClient, "readInstanceFile" | "pushInstanceFile" | "execInstance"> &
		LxdInstanceDeviceClient;
	journalRoot: string;
	guest: {
		/** The image's own coding user: sessions whose NAS volume predates
		 * per-member machines run as it (their files carry it). Every other
		 * session runs as its own guest uid from SQL. */
		uid: number;
		gid: number;
		resourceProfile: {
			maxTimeoutMs: number;
			memoryBytes: number;
			tasksMax: number;
			cpuQuotaPercent: number;
			maxLogBytes: number;
		};
		storageHelperSha256: string;
		commandHelperSha256: string;
		gitHelperSha256: string;
		watchdogHelperSha256: string;
	};
	repositoryCredentials: CodingRepositoryCredentials;
	fetch?: typeof fetch;
	runGit?: CodingBrokerGitRunner;
	/** How long a freshly started guest may take to bring up its agent and
	 * watchdog timer (default 120 s). */
	guestReadyTimeoutMs?: number;
	/** How long LXD's agent may take to mount a hot-plugged session (default 30 s). */
	attachTimeoutMs?: number;
}
interface Prepared {
	claim: CodingSessionClaim;
	machine: Readonly<LxdCodingMachineBinding>;
	storage: Readonly<CloudCodingStorageBinding>;
	scope: CloudCodingCommandScope;
	bootId: string;
	guestConfigSha256: string;
	baseSha: string;
}
/** A machine as the executor's housekeeping list reports it. */
interface ListedMachine {
	machineId: string;
	kind: "member" | "session";
	binding: Record<string, unknown>;
	instanceSha256: string | null;
	live: boolean;
	reserved: boolean;
	asleep: boolean;
	released: boolean;
	sleepDue: boolean;
	removeDue: boolean;
	lastError: string | null;
}
const SHA = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/** Budget for one physical stop or delete, journal I/O included. Callers that
 * bound a whole step (lookup + effect) allow more than this. */
export const CODING_VM_STOP_BUDGET_MS = 30_000;
/** Part of a sleep for stopping every command slice and syncing the NAS
 * folders before the machine is powered off. */
const CODING_VM_QUIESCE_MS = 8_000;
/** Refusals a turn waits out in the queue instead of failing: the machine is
 * being removed, the node is full or not ready, or the session is still on
 * another machine. A misconfigured deployment is never waited out. */
const WAITABLE = new Set([
	"MACHINE_RETIRING",
	"NODE_CAPACITY_EXHAUSTED",
	"NODE_OBSERVATION_UNAVAILABLE",
	"NODE_DISABLED",
	"LEGACY_SESSION_BUSY",
	"PREVIOUS_MACHINE_AWAKE",
]);
/** A starting guest: its lxd-agent is not up yet, or systemd answered that
 * the timer is not active. Anything else (the VM gone, a refused or malformed
 * operation) fails the wait at once with its own cause. */
function guestStarting(error: unknown): boolean {
	return (
		error instanceof Error &&
		(error.message === "LXD instance agent not running" || error.message === "LXD instance command failed")
	);
}
function digest(value: string | Buffer): string {
	return createHash("sha256").update(value).digest("hex");
}
/** A stable identifier derived from a label and a source; the kernel derives
 * the turn id ("turn", `${workerId}:${sequence}`) the same way. */
export function codingHostId(label: string, source: string): string {
	const hash = digest(`qorpera.coding-host/${label}/${source}`);
	return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}
export function codingTurnScope(workerId: string, vmId: string, sequence: number): CloudCodingCommandScope {
	return Object.freeze({ workerId, vmId, requestId: codingHostId("turn", `${workerId}:${sequence}`), turn: sequence });
}
function record(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("CODING_HOST_RECEIPT_INVALID");
	return value as Record<string, unknown>;
}
/** A fixed identifier for an error: its code, or UNCLASSIFIED. */
function errorCodeOf(error: unknown): string {
	const message = error instanceof Error ? error.message : "";
	return /^[A-Z][A-Z0-9_:]{0,119}$/.test(message) ? message : "UNCLASSIFIED";
}
/** A custody refusal: not now (a turn uses the machine, it is awake, or not due). */
class CodingCustodyRefused extends Error {
	readonly reason: string;
	constructor(reason: string) {
		super(`CODING_MACHINE_CUSTODY_REFUSED:${reason}`);
		this.reason = reason;
	}
}

/** Concrete trusted composition. Only LXD fixed helpers touch the untrusted
 * checkout; repository credentials stay in the separate Git broker processes.
 * One coding machine per member carries all of that member's sessions; each
 * session is attached (its NAS folders hot-plugged, its guest user and
 * configuration installed) while its turn runs and detached at its end. The
 * machine sleeps when idle and is removed later (housekeep). No effect is
 * inferred from a label, a model statement or an assigned runner. */
export class LxdCodingExecutorHost implements CodingExecutorHost {
	readonly #options: LxdCodingExecutorHostOptions;
	readonly #storage: CodingNasStorage;
	readonly #placement: CodingMachineStorage;
	#storageWork: Promise<unknown> = Promise.resolve();
	readonly #machineWork = new Map<string, Promise<unknown>>();
	readonly #prepared = new Map<string, Prepared>();
	constructor(options: LxdCodingExecutorHostOptions) {
		if (
			!/^[A-Za-z0-9_.:-]{1,120}$/.test(options.owner) ||
			!SHA.test(options.machineIdSha256) ||
			resolve(options.journalRoot) !== options.journalRoot ||
			options.guest.uid === process.geteuid?.() ||
			![
				options.guest.commandHelperSha256,
				options.guest.gitHelperSha256,
				options.guest.watchdogHelperSha256,
				options.guest.storageHelperSha256,
			].every((hash) => SHA.test(hash)) ||
			![options.guest.uid, options.guest.gid].every((value) => Number.isSafeInteger(value) && value >= 1000) ||
			options.guest.resourceProfile.memoryBytes > options.vmPolicy.memoryBytes ||
			options.guest.resourceProfile.cpuQuotaPercent > options.vmPolicy.cpus * 100
		)
			throw new Error("CODING_HOST_CONFIGURATION_INVALID");
		// The policy must make a valid machine binding.
		lxdCodingMachinePlan({
			...options.vmPolicy,
			schema: "qorpera.lxd-coding-machine/v1",
			machineId: "11111111-1111-4111-8111-111111111111",
			companyId: "11111111-1111-4111-8111-111111111111",
			environmentId: "11111111-1111-4111-8111-111111111111",
			memberUserId: "11111111-1111-4111-8111-111111111111",
		});
		const storagePolicy = parseCloudCodingNasPolicy(options.storagePolicy);
		this.#storage = createCodingNasStorage(storagePolicy);
		if (options.journalRoot !== this.#storage.controlPath) throw new Error("CODING_HOST_JOURNAL_NOT_ON_NAS");
		this.#placement = Object.freeze({ policy: storagePolicy, machineIdSha256: options.machineIdSha256 });
		this.#options = {
			...options,
			storagePolicy,
			vmPolicy: Object.freeze({ ...options.vmPolicy }),
			guest: Object.freeze({
				...options.guest,
				resourceProfile: Object.freeze({ ...options.guest.resourceProfile }),
			}),
		};
	}
	#call(method: string, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
		signal.throwIfAborted();
		return this.#options.control.call(method, args, AbortSignal.any([signal, AbortSignal.timeout(30000)]));
	}
	/** One lifecycle step at a time per machine: create, start, attach, detach,
	 * stop, delete and release never overlap on one machine. Commands of its
	 * sessions run in parallel between them. */
	async #exclusive<T>(machineId: string, use: () => Promise<T>): Promise<T> {
		const previous = this.#machineWork.get(machineId) ?? Promise.resolve();
		const work = previous.catch(() => undefined).then(use);
		this.#machineWork.set(machineId, work);
		try {
			return await work;
		} finally {
			if (this.#machineWork.get(machineId) === work) this.#machineWork.delete(machineId);
		}
	}
	async #storageTask<T>(use: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
		const checked = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(5000)]);
		// Keep the real promise as custody even after the caller's timeout. Normal
		// heartbeat/command overlap queues; unresolved hard-NFS IO never overlaps.
		const work = this.#storageWork
			.catch(() => undefined)
			.then(() => {
				checked.throwIfAborted();
				return use(checked);
			});
		this.#storageWork = work;
		let abort: (() => void) | undefined;
		try {
			return await Promise.race([
				work,
				new Promise<never>((_resolve, reject) => {
					abort = () => reject(checked.reason);
					checked.addEventListener("abort", abort, { once: true });
					if (checked.aborted) abort();
				}),
			]);
		} finally {
			if (abort) checked.removeEventListener("abort", abort);
		}
	}
	async #directory(name: string, callerSignal?: AbortSignal): Promise<string> {
		return this.#storageTask(async (signal) => {
			await this.#storage.assertControl(signal);
			await checkDirectory(this.#options.journalRoot);
			const path = join(this.#options.journalRoot, name);
			signal.throwIfAborted();
			await mkdir(path, { mode: 0o700 }).catch((error) => {
				if (!code(error, "EEXIST")) throw error;
			});
			await checkDirectory(path);
			await this.#storage.assertControl(signal);
			return path;
		}, callerSignal);
	}
	/** Run authority for one effect of this turn on its member's machine: the
	 * live session lease, the exact machine and the session's NAS volume, a
	 * fresh node reservation. Valid for seconds. A refusal the turn can wait out
	 * throws CodingMachineUnavailable. */
	async #run(
		claim: CodingSessionClaim,
		machine: Readonly<LxdCodingMachineBinding>,
		storage: Readonly<CloudCodingStorageBinding>,
		signal: AbortSignal,
		prepareStorage = false,
	): Promise<CodingMachineAdmissionReceipt> {
		const started = performance.now();
		const plan = lxdCodingMachinePlan(machine);
		const value = record(
			await this.#call(
				"qorpera_authorize_coding_machine_run",
				{
					p_worker_id: claim.workerId,
					p_lease_token: claim.leaseToken,
					p_binding_text: plan.text,
					p_storage: storage,
					p_machine_id_sha256: this.#options.machineIdSha256,
				},
				signal,
			),
		);
		if (value.state === "refused") {
			const reason = String(value.reason ?? "");
			if (WAITABLE.has(reason)) throw new CodingMachineUnavailable(reason);
			throw new Error(`CODING_HOST_MACHINE_REFUSED:${/^[A-Z_]{1,64}$/.test(reason) ? reason : "UNKNOWN"}`);
		}
		const remaining = checkCodingMachineReceipt(
			value,
			{
				machineId: plan.binding.machineId,
				instanceSha256: plan.instanceSha256,
				intent: "run",
				workerId: claim.workerId,
			},
			performance.now() - started,
		);
		const guestUid = value.guestUid as number | null;
		if (guestUid !== null && guestUid < 200000) throw new Error("CODING_MACHINE_ADMISSION_UNCONFIRMED");
		await this.#storageTask(async (checked) => {
			if (prepareStorage) {
				await this.#storage.prepareControl(checked);
				await this.#storage.prepare(storage, checked);
			} else {
				await this.#storage.assertControl(checked);
				await this.#storage.assert(storage, checked);
			}
		}, signal);
		if (performance.now() - started >= remaining) throw new Error("CODING_MACHINE_ADMISSION_EXPIRED");
		signal.throwIfAborted();
		return value as unknown as CodingMachineAdmissionReceipt;
	}
	/** Custody of a machine this executor planned on this node: stop, detach or
	 * delete. Lease or no lease; SQL refuses while a turn needs the machine. */
	async #custody(
		journal: CodingMachineJournalPlan,
		text: string,
		intent: Exclude<CodingMachineIntent, "run">,
		signal: AbortSignal,
		session?: { workerId: string; leaseToken: string | null },
	): Promise<CodingMachineAdmissionReceipt> {
		const started = performance.now();
		const value = record(
			await this.#call(
				"qorpera_authorize_coding_machine_custody",
				{
					p_machine_id: journal.machineId,
					p_owner: this.#options.owner,
					p_binding_text: text,
					p_machine_id_sha256: this.#options.machineIdSha256,
					p_intent: intent,
					p_worker_id: session?.workerId ?? null,
					p_lease_token: session?.leaseToken ?? null,
				},
				signal,
			),
		);
		if (value.state === "refused") throw new CodingCustodyRefused(String(value.reason ?? "REFUSED"));
		checkCodingMachineReceipt(
			value,
			{
				machineId: journal.machineId,
				instanceSha256: journal.instanceSha256,
				intent,
				workerId: session?.workerId ?? null,
			},
			performance.now() - started,
		);
		return value as unknown as CodingMachineAdmissionReceipt;
	}
	/** Drives one machine's journal to the desired state, polling pending LXD
	 * operations, within its budget. */
	async #reconcile(
		journal: CodingMachineJournalPlan,
		desiredState: CodingMachineDesiredState,
		authorize: (intent: CodingMachineIntent, signal: AbortSignal) => Promise<unknown>,
		signal: AbortSignal,
	): Promise<"running" | "stopped" | "absent" | "deleted"> {
		const checked = AbortSignal.any([
			signal,
			AbortSignal.timeout(desiredState === "running" ? 300000 : CODING_VM_STOP_BUDGET_MS),
		]);
		for (;;) {
			checked.throwIfAborted();
			const journalRoot = await this.#directory("machines", checked);
			const result = await reconcileCodingMachine({
				plan: journal,
				journalRoot,
				desiredState,
				client: this.#options.client,
				authorize,
				signal: checked,
			});
			checked.throwIfAborted();
			if (result.state === "pending") {
				await setTimeout(500, undefined, { signal: checked });
				continue;
			}
			if (result.state === "recovery-required") throw new Error("CODING_HOST_VM_RECOVERY_REQUIRED");
			if (desiredState === "running" && result.state !== "running")
				throw new Error("CODING_HOST_VM_RECOVERY_REQUIRED");
			if (desiredState === "stopped" && result.state !== "stopped" && result.state !== "absent")
				throw new Error("CODING_HOST_VM_RECOVERY_REQUIRED");
			return result.state;
		}
	}
	/** The member's machine for this turn, as SQL planned it from the policy the
	 * executor itself runs with. */
	async #plan(claim: CodingSessionClaim, signal: AbortSignal): Promise<Readonly<LxdCodingMachineBinding>> {
		const value = record(
			await this.#call(
				"qorpera_plan_coding_machine",
				{
					p_worker_id: claim.workerId,
					p_lease_token: claim.leaseToken,
					p_machine_id_sha256: this.#options.machineIdSha256,
				},
				signal,
			),
		);
		if (value.state === "refused") {
			const reason = String(value.reason ?? "");
			if (WAITABLE.has(reason)) throw new CodingMachineUnavailable(reason);
			throw new Error("CODING_HOST_MACHINE_PLAN_REFUSED");
		}
		if (value.schema !== "qorpera.coding-machine-plan/v1" || value.state !== "planned")
			throw new Error("CODING_HOST_MACHINE_PLAN_INVALID");
		const machine = lxdCodingMachinePlan(value.binding as LxdCodingMachineBinding).binding;
		const { schema: _schema, machineId, companyId, environmentId, memberUserId, ...policy } = machine;
		if (
			machineId !== value.machineId ||
			companyId !== claim.profileId ||
			environmentId !== claim.environmentId ||
			memberUserId !== claim.ownerUserId ||
			!isDeepStrictEqual(policy, { ...this.#options.vmPolicy })
		)
			throw new Error("CODING_HOST_MACHINE_POLICY_DIFFERS");
		return machine;
	}
	/** Hot-plugs the session's two NAS folders into the running machine and
	 * waits until its agent has mounted both. An uncertain update is judged from
	 * the machine itself. */
	async #attach(
		claim: CodingSessionClaim,
		machine: Readonly<LxdCodingMachineBinding>,
		storage: Readonly<CloudCodingStorageBinding>,
		signal: AbortSignal,
	): Promise<void> {
		const client = this.#options.client,
			name = lxdCodingMachineName(machine.machineId),
			layout = cloudCodingSessionLayout(claim.workerId);
		const observe = async () => {
			const instance = await client.getInstance(machine.project, name, signal);
			if (!instance || instance.status !== "Running" || instance.statusCode !== 103)
				throw new Error("CODING_MACHINE_NOT_RUNNING");
			return { instance, sessions: assertLxdCodingMachineInstance(machine, this.#placement, instance) };
		};
		await this.#run(claim, machine, storage, signal);
		let { instance, sessions } = await observe();
		if (!sessions.includes(claim.workerId)) {
			await this.#run(claim, machine, storage, signal);
			try {
				await client.replaceInstanceDevices(
					machine.project,
					name,
					{ ...instance.devices, ...lxdCodingSessionDevices(storage) },
					signal,
				);
			} catch {
				/* Judged below from the machine. */
			}
			({ instance, sessions } = await observe());
			if (!sessions.includes(claim.workerId)) throw new Error("CODING_SESSION_ATTACH_UNCONFIRMED");
		}
		const ready = AbortSignal.any([signal, AbortSignal.timeout(this.#options.attachTimeoutMs ?? 30_000)]);
		for (const path of [layout.dataRoot, layout.custodyRoot]) {
			for (;;) {
				try {
					await client.execInstance(machine.project, name, ["/usr/bin/mountpoint", "--quiet", path], ready);
					break;
				} catch (error) {
					signal.throwIfAborted();
					if (ready.aborted) throw new Error("CODING_SESSION_ATTACH_UNCONFIRMED", { cause: error });
					if (!guestStarting(error)) throw error;
					await setTimeout(500, undefined, { signal: ready }).catch(() => undefined);
				}
			}
		}
	}
	/** Installs the attached session inside the guest: its configuration for
	 * this boot, its storage binding, its user and folders. */
	async #guest(
		claim: CodingSessionClaim,
		machine: Readonly<LxdCodingMachineBinding>,
		storage: Readonly<CloudCodingStorageBinding>,
		signal: AbortSignal,
	): Promise<{ bootId: string; guestConfigSha256: string }> {
		const client = this.#options.client,
			name = lxdCodingMachineName(machine.machineId),
			layout = cloudCodingSessionLayout(claim.workerId);
		const receipt = await this.#run(claim, machine, storage, signal);
		const instance = await client.getInstance(machine.project, name, signal);
		if (!instance || instance.status !== "Running" || instance.statusCode !== 103)
			throw new Error("CODING_HOST_VM_NOT_RUNNING");
		if (!assertLxdCodingMachineInstance(machine, this.#placement, instance).includes(claim.workerId))
			throw new Error("CODING_SESSION_DETACHED");
		// A machine that has just started answers before its agent and systemd are
		// up: the watchdog timer turns active a few seconds after the agent. Wait,
		// bounded, for both before trusting the boot; anything else still fails.
		const ready = AbortSignal.any([signal, AbortSignal.timeout(this.#options.guestReadyTimeoutMs ?? 120_000)]);
		for (let round = 0; ; round++) {
			try {
				// Every retry re-reads the machine: one deleted or stopped elsewhere
				// fails now instead of after the whole readiness window.
				if (round > 0) {
					const current = await client.getInstance(machine.project, name, ready);
					if (!current || current.status !== "Running" || current.statusCode !== 103)
						throw new Error("CODING_HOST_VM_NOT_RUNNING");
					assertLxdCodingMachineInstance(machine, this.#placement, current);
				}
				await client.execInstance(
					machine.project,
					name,
					["/usr/bin/systemctl", "is-active", "--quiet", "qorpera-coding-watchdog.timer"],
					ready,
				);
				break;
			} catch (error) {
				signal.throwIfAborted();
				if (ready.aborted) throw new Error("CODING_HOST_GUEST_NOT_READY", { cause: error });
				if (!guestStarting(error)) throw error;
				if (error instanceof Error && error.message === "LXD instance command failed") {
					// systemd answered: the timer is not active. A failed or disabled
					// timer never becomes active by waiting; one still starting does.
					try {
						await this.#watchdogStarting(machine, name, ready);
					} catch (probeError) {
						signal.throwIfAborted();
						if (ready.aborted) throw new Error("CODING_HOST_GUEST_NOT_READY", { cause: probeError });
						if (!guestStarting(probeError)) throw probeError;
					}
				}
				await setTimeout(1000, undefined, { signal: ready }).catch(() => undefined);
				// The caller's own abort wins over the readiness deadline.
				signal.throwIfAborted();
				if (ready.aborted) throw new Error("CODING_HOST_GUEST_NOT_READY", { cause: error });
			}
		}
		const boot = await client.readInstanceFile(machine.project, name, "/proc/sys/kernel/random/boot_id", 64, signal);
		const bootId = boot.content.toString("utf8").trim();
		if (boot.uid !== 0 || boot.gid !== 0 || boot.mode !== 0o444 || !UUID.test(bootId))
			throw new Error("CODING_HOST_BOOT_UNCONFIRMED");
		for (const [file, hash] of [
			["cloud-coding-command-guest.mjs", this.#options.guest.commandHelperSha256],
			["cloud-coding-git-guest.mjs", this.#options.guest.gitHelperSha256],
			["cloud-coding-watchdog.mjs", this.#options.guest.watchdogHelperSha256],
			["cloud-coding-storage-guest.mjs", this.#options.guest.storageHelperSha256],
		]) {
			const content = await client.readInstanceFile(
				machine.project,
				name,
				`/opt/qorpera-coding/${file}`,
				65536,
				signal,
			);
			if (content.uid !== 0 || content.gid !== 0 || content.mode !== 0o444 || digest(content.content) !== hash)
				throw new Error("CODING_HOST_GUEST_ARTIFACT_CHANGED");
		}
		// An image that can upgrade itself restarts the sessions' units under it,
		// then its shutdown inhibitor refuses the stop and the machine keeps its
		// node slot. The pinned storage helper refuses unless the apt units are masked.
		try {
			await client.execInstance(
				machine.project,
				name,
				["/usr/bin/node", "/opt/qorpera-coding/cloud-coding-storage-guest.mjs", "image"],
				signal,
			);
		} catch (error) {
			if (error instanceof Error && error.message === "LXD instance command failed")
				throw new Error("RUNNER_IMAGE_SELF_UPDATE_ENABLED", { cause: error });
			throw error;
		}
		await client.execInstance(
			machine.project,
			name,
			["/usr/bin/systemctl", "is-active", "--quiet", "qorpera-coding-watchdog.timer"],
			signal,
		);
		const configuration = {
			schema: "qorpera.coding-command-guest/v3",
			workerId: claim.workerId,
			vmId: machine.machineId,
			bootId,
			uid: receipt.guestUid ?? this.#options.guest.uid,
			gid: receipt.guestUid ?? this.#options.guest.gid,
			workspacePath: layout.workspacePath,
			homePath: layout.homePath,
			cachePath: layout.cachePath,
			outputRoot: layout.outputRoot,
			resourceProfile: this.#options.guest.resourceProfile,
		};
		const root = await this.#directory("guests"),
			journalName = `${claim.workerId}.${bootId}.json`;
		const encoded = JSON.stringify(configuration);
		await publish(root, journalName, Buffer.from(encoded));
		if (!isDeepStrictEqual((await readRecord(join(root, journalName))).value, configuration))
			throw new Error("CODING_HOST_GUEST_BINDING_CHANGED");
		// The host journal is an immutable intent, not proof of guest delivery.
		// Stage it on every retry; only the fixed installer may publish active
		// configuration, resume partial delivery, or advance an exact old boot.
		const packet = JSON.stringify({
			schema: "qorpera.coding-configuration-install/v1",
			guest: configuration,
			storage,
		});
		if (Buffer.byteLength(packet) > 16384) throw new Error("CODING_HOST_GUEST_CONFIGURATION_TOO_LARGE");
		const helper = (action: "prepare" | "install" | "initialize") =>
			client.execInstance(
				machine.project,
				name,
				["/usr/bin/node", "/opt/qorpera-coding/cloud-coding-storage-guest.mjs", action, claim.workerId],
				signal,
			);
		await this.#run(claim, machine, storage, signal);
		await helper("prepare");
		await this.#run(claim, machine, storage, signal);
		await client.pushInstanceFile(
			machine.project,
			name,
			`${layout.configurationRoot}/configuration-inbox.json`,
			packet,
			0o444,
			signal,
		);
		await this.#run(claim, machine, storage, signal);
		await helper("install");
		const storageEncoded = JSON.stringify(storage);
		const actualStorage = await client.readInstanceFile(
			machine.project,
			name,
			`${layout.configurationRoot}/storage.json`,
			8192,
			signal,
		);
		if (
			actualStorage.uid !== 0 ||
			actualStorage.gid !== 0 ||
			actualStorage.mode !== 0o444 ||
			actualStorage.content.toString("utf8") !== storageEncoded
		)
			throw new Error("CODING_HOST_GUEST_STORAGE_UNCONFIRMED");
		const actual = await client.readInstanceFile(
			machine.project,
			name,
			`${layout.configurationRoot}/guest.json`,
			8192,
			signal,
		);
		if (actual.uid !== 0 || actual.gid !== 0 || actual.mode !== 0o444 || actual.content.toString("utf8") !== encoded)
			throw new Error("CODING_HOST_GUEST_CONFIGURATION_UNCONFIRMED");
		await this.#run(claim, machine, storage, signal);
		await helper("initialize");
		return { bootId, guestConfigSha256: digest(encoded) };
	}
	/** The repository token for this claim's session only. */
	#repositoryToken(claim: CodingSessionClaim): RepositoryTokenLender {
		const scope: CodingRepositoryCredentialScope = Object.freeze({
			companyId: claim.profileId,
			workerId: claim.workerId,
			leaseToken: claim.leaseToken,
		});
		const credentials = this.#options.repositoryCredentials;
		return (repository, use, signal) => credentials.withRepositoryToken(scope, repository, use, signal);
	}
	#active(claim: CodingSessionClaim): Prepared {
		const ready = this.#prepared.get(claim.workerId);
		if (!ready || ready.claim.leaseToken !== claim.leaseToken || ready.scope.turn !== claim.sequence)
			throw new Error("CODING_HOST_TURN_NOT_PREPARED");
		return ready;
	}
	#transfer(ready: Prepared): LxdCodingGitTransfer {
		return new LxdCodingGitTransfer({
			machine: ready.machine,
			storage: this.#placement,
			repository: ready.claim.repository,
			scope: ready.scope,
			bootId: ready.bootId,
			guestConfigSha256: ready.guestConfigSha256,
			helperSha256: this.#options.guest.gitHelperSha256,
			client: this.#options.client,
			authorize: async (_action, scope, _transfer, _digest, signal) => {
				if (!isDeepStrictEqual(scope, ready.scope)) throw new Error("CODING_HOST_TRANSFER_SCOPE_CHANGED");
				await this.#run(ready.claim, ready.machine, ready.storage, signal);
			},
		});
	}
	async prepareWorkspace(
		claim: CodingSessionClaim,
		turn: CodingTurnState,
		signal: AbortSignal,
	): Promise<CodingWorkspace> {
		if (turn.workerId !== claim.workerId || turn.sequence !== claim.sequence)
			throw new Error("CODING_HOST_TURN_CHANGED");
		const machine = await this.#plan(claim, signal);
		const storage = lxdCodingSessionStorage(machine, this.#placement, claim.workerId);
		const journal = lxdCodingMachineJournalPlan(machine, this.#placement);
		await this.#exclusive(machine.machineId, async () => {
			await this.#run(claim, machine, storage, signal, true);
			await this.#reconcile(
				journal,
				"running",
				async (_intent, checked) => this.#run(claim, machine, storage, checked),
				signal,
			);
			await this.#attach(claim, machine, storage, signal);
		});
		const guest = await this.#guest(claim, machine, storage, signal),
			root = await this.#directory("git");
		const authorize = async () => {
			await this.#run(claim, machine, storage, signal);
		};
		const baseName = `${claim.workerId}.base.json`;
		let baseSha: string;
		try {
			baseSha = String(record((await readRecord(join(root, baseName))).value).baseSha);
		} catch (error) {
			if (!code(error, "ENOENT")) throw error;
			const sha = await resolveCloudCodingBase(claim.repository, {
				journalRoot: root,
				signal,
				assertAuthorized: authorize,
				withRepositoryToken: this.#repositoryToken(claim),
				runGit: this.#options.runGit,
			});
			await publish(
				root,
				baseName,
				Buffer.from(JSON.stringify({ workerId: claim.workerId, repository: claim.repository, baseSha: sha })),
			);
			baseSha = String(record((await readRecord(join(root, baseName))).value).baseSha);
		}
		const pinned = record((await readRecord(join(root, baseName))).value);
		if (
			pinned.workerId !== claim.workerId ||
			!isDeepStrictEqual(pinned.repository, claim.repository) ||
			!/^[0-9a-f]{40}$/.test(baseSha) ||
			(turn.baseSha !== null && turn.baseSha !== baseSha) ||
			(claim.baseSha !== null && claim.baseSha !== baseSha)
		)
			throw new Error("CODING_HOST_BASE_CHANGED");
		const ready: Prepared = {
			claim,
			machine,
			storage,
			scope: codingTurnScope(claim.workerId, machine.machineId, claim.sequence),
			...guest,
			baseSha,
		};
		if (ready.scope.requestId !== turn.turnId) throw new Error("CODING_HOST_TURN_ID_DIFFERS");
		// The checkout is seeded once into the session's NAS volume, which
		// outlives every machine the session runs on.
		const seededName = `${claim.workerId}.seeded.json`;
		try {
			const seeded = record((await readRecord(join(root, seededName))).value);
			if (seeded.workerId !== claim.workerId || seeded.headSha !== baseSha)
				throw new Error("CODING_HOST_SEED_CHANGED");
		} catch (error) {
			if (!code(error, "ENOENT")) throw error;
			const seed = await fetchCloudCodingSeed(
				{ repository: claim.repository, workerId: claim.workerId, baseSha },
				{
					journalRoot: root,
					signal,
					assertAuthorized: authorize,
					withRepositoryToken: this.#repositoryToken(claim),
					runGit: this.#options.runGit,
				},
			);
			await this.#transfer(ready).seed(codingHostId("seed", claim.workerId), baseSha, seed.bundle, signal);
			await publish(
				root,
				seededName,
				Buffer.from(JSON.stringify({ workerId: claim.workerId, vmId: machine.machineId, headSha: baseSha })),
			);
		}
		this.#prepared.set(claim.workerId, ready);
		return { vmId: machine.machineId, baseSha };
	}
	async refreshLease(claim: CodingSessionClaim, signal: AbortSignal): Promise<void> {
		const ready = this.#active(claim),
			leaseHash = digest(claim.leaseToken);
		const watchdog = await this.#options.client.readInstanceFile(
			ready.machine.project,
			lxdCodingMachineName(ready.machine.machineId),
			"/opt/qorpera-coding/cloud-coding-watchdog.mjs",
			65536,
			signal,
		);
		if (
			watchdog.uid !== 0 ||
			watchdog.gid !== 0 ||
			watchdog.mode !== 0o444 ||
			digest(watchdog.content) !== this.#options.guest.watchdogHelperSha256
		)
			throw new Error("CODING_HOST_WATCHDOG_CHANGED");
		const transport = new LxdCodingLeaseTransport({
			machine: ready.machine,
			storage: this.#placement,
			scope: ready.scope,
			bootId: ready.bootId,
			guestConfigSha256: ready.guestConfigSha256,
			helperSha256: this.#options.guest.commandHelperSha256,
			client: this.#options.client,
			authorize: async (scope, hash, ttl, checked) => {
				if (
					!isDeepStrictEqual(scope, ready.scope) ||
					hash !== leaseHash ||
					ttl > Date.parse(claim.leaseUntil) - Date.now()
				)
					throw new Error("CODING_HOST_LEASE_REFRESH_EXPIRED");
				await this.#run(ready.claim, ready.machine, ready.storage, checked);
			},
		});
		const ttl = Math.min(45000, Date.parse(claim.leaseUntil) - Date.now() - 5000);
		if (ttl < 1000) throw new Error("CODING_HOST_LEASE_REFRESH_EXPIRED");
		await transport.refresh(ready.scope, leaseHash, ttl, signal);
	}
	async publish(
		claim: CodingSessionClaim,
		submission: Extract<CodingSubmission, { kind: "finish" }>,
		signal: AbortSignal,
	): Promise<CodingExecutorPublication> {
		const ready = this.#active(claim);
		const exported = await this.#transfer(ready).export(
			codingHostId("export", `${claim.workerId}:${claim.sequence}`),
			submission.headSha,
			signal,
		);
		if (submission.headSha === ready.baseSha && !claim.pullRequest) return { pullRequest: null, noChange: true };
		const root = await this.#directory("git"),
			token = this.#repositoryToken(claim);
		const authorize = async (): Promise<void> => {
			await this.#run(claim, ready.machine, ready.storage, signal);
		};
		await pushCloudCodingBundle(
			{
				repository: claim.repository,
				workerId: claim.workerId,
				headSha: submission.headSha,
				baseSha: ready.baseSha,
				expectedRemoteHeadSha: claim.pullRequest?.headSha ?? null,
			},
			exported.bundle,
			{
				journalRoot: root,
				signal,
				assertAuthorized: authorize,
				withRepositoryToken: token,
				runGit: this.#options.runGit,
			},
		);
		const pullRequest = await publishCloudCodingDraftPullRequest(
			{
				repository: claim.repository,
				workerId: claim.workerId,
				headSha: submission.headSha,
				title: claim.title.slice(0, 200),
				body: submission.summary,
			},
			{
				journalRoot: root,
				signal,
				assertAuthorized: authorize,
				withRepositoryToken: token,
				fetch: this.#options.fetch,
			},
		);
		return { pullRequest, noChange: false };
	}
	/** The end of this session's turn on its member's machine: its commands are
	 * stopped and the guest flushed, its boot-local state removed, and its NAS
	 * folders unplugged. The machine keeps running for the member's other
	 * sessions and sleeps later (housekeep). A session this process never
	 * prepared is left to housekeeping, which unplugs everything when the
	 * machine sleeps. Works with or without the lease. */
	async detachSession(claim: CodingSessionClaim, signal: AbortSignal): Promise<void> {
		const ready = this.#prepared.get(claim.workerId);
		if (!ready || ready.claim.leaseToken !== claim.leaseToken) return;
		const machine = ready.machine,
			journal = lxdCodingMachineJournalPlan(machine, this.#placement),
			text = lxdCodingMachinePlan(machine).text,
			name = lxdCodingMachineName(machine.machineId),
			client = this.#options.client,
			session = { workerId: claim.workerId, leaseToken: claim.leaseToken };
		await this.#exclusive(machine.machineId, async () => {
			await this.#custody(journal, text, "detach", signal, session);
			const instance = await client.getInstance(machine.project, name, signal);
			if (!instance) {
				this.#prepared.delete(claim.workerId);
				return;
			}
			const sessions = assertLxdCodingMachineInstance(machine, this.#placement, instance);
			let guestFailure: unknown;
			if (instance.status === "Running" && instance.statusCode === 103)
				try {
					await client.execInstance(
						machine.project,
						name,
						["/usr/bin/node", "/opt/qorpera-coding/cloud-coding-storage-guest.mjs", "detach", claim.workerId],
						signal,
					);
				} catch (error) {
					// The folders are unplugged all the same; the watchdog stops a slice
					// whose lease is gone. The failure is still the caller's to report.
					guestFailure = error;
				}
			if (sessions.includes(claim.workerId)) {
				const devices = Object.fromEntries(
					Object.entries(instance.devices).filter(
						([deviceName]) => !Object.hasOwn(lxdCodingSessionDevices(ready.storage), deviceName),
					),
				);
				await this.#custody(journal, text, "detach", signal, session);
				try {
					await client.replaceInstanceDevices(machine.project, name, devices, signal);
				} catch {
					/* Judged below from the machine. */
				}
				const after = await client.getInstance(machine.project, name, signal);
				if (after && assertLxdCodingMachineInstance(machine, this.#placement, after).includes(claim.workerId))
					throw new Error("CODING_SESSION_DETACH_UNCONFIRMED");
			}
			this.#prepared.delete(claim.workerId);
			if (guestFailure) throw guestFailure;
		});
	}
	/** Throws CODING_HOST_GUEST_WATCHDOG_FAILED or _DISABLED for a timer that
	 * cannot become active; returns while it may still be starting. */
	async #watchdogStarting(
		machine: Readonly<LxdCodingMachineBinding>,
		name: string,
		signal: AbortSignal,
	): Promise<void> {
		// Only asked once systemd has answered; a probe that finds the agent
		// gone again returns to waiting instead of judging the timer.
		const holds = async (verb: "is-failed" | "is-enabled") => {
			try {
				await this.#options.client.execInstance(
					machine.project,
					name,
					["/usr/bin/systemctl", verb, "--quiet", "qorpera-coding-watchdog.timer"],
					signal,
				);
				return true;
			} catch (error) {
				if (error instanceof Error && error.message === "LXD instance command failed") return false;
				throw error;
			}
		};
		try {
			if (await holds("is-failed")) throw new Error("CODING_HOST_GUEST_WATCHDOG_FAILED");
			if (!(await holds("is-enabled"))) throw new Error("CODING_HOST_GUEST_WATCHDOG_DISABLED");
		} catch (error) {
			if (error instanceof Error && error.message === "LXD instance agent not running") return;
			throw error;
		}
	}
	async commandTransport(
		scope: CloudCodingCommandScope,
		authorize: ConstructorParameters<typeof LxdCodingCommandTransport>[0]["authorize"],
		signal: AbortSignal,
	): Promise<LxdCodingCommandTransport> {
		const ready = this.#prepared.get(scope.workerId);
		if (!ready || !isDeepStrictEqual(scope, ready.scope)) throw new Error("CODING_HOST_TURN_NOT_PREPARED");
		await this.#run(ready.claim, ready.machine, ready.storage, signal);
		return new LxdCodingCommandTransport({
			machine: ready.machine,
			storage: this.#placement,
			scope: ready.scope,
			bootId: ready.bootId,
			guestConfigSha256: ready.guestConfigSha256,
			helperSha256: this.#options.guest.commandHelperSha256,
			client: this.#options.client,
			authorize: async (action, checkedScope, commandId, inputSha256, checked) => {
				await this.#run(ready.claim, ready.machine, ready.storage, checked);
				await authorize(action, checkedScope, commandId, inputSha256, checked);
			},
		});
	}

	/** One pass over this executor's machines on this node: every idle member
	 * machine past the sleep delay goes to sleep; every machine due for removal
	 * (asleep past the removal delay, superseded by a new policy, or a kept
	 * per-session VM whose session has no turn) is stopped, deleted and
	 * released; a machine already released elsewhere is closed. A failed step
	 * is written to the machine (last_error) and returned, never hidden; a step
	 * that succeeds clears its earlier failure. SQL re-checks custody for every
	 * effect, so an entry that changed since the list is only refused. */
	async housekeep(signal: AbortSignal): Promise<CodingHousekeepingOutcome[]> {
		const listed = await this.#call(
			"qorpera_list_coding_machines",
			{ p_owner: this.#options.owner, p_machine_id_sha256: this.#options.machineIdSha256 },
			signal,
		);
		if (!Array.isArray(listed)) throw new Error("CODING_HOST_MACHINE_LIST_INVALID");
		const outcomes: CodingHousekeepingOutcome[] = [];
		for (const value of listed) {
			signal.throwIfAborted();
			const entry = this.#listed(value);
			const step: CodingHousekeepingOutcome["step"] | null =
				entry.released || entry.removeDue ? "delete" : entry.sleepDue ? "sleep" : null;
			if (!step) continue;
			try {
				await this.#exclusive(entry.machineId, async () => {
					if (step === "sleep") await this.#sleep(entry, signal);
					else await this.#remove(entry, signal);
				});
				outcomes.push({ machineId: entry.machineId, step, state: "done" });
				if (entry.lastError) await this.#recordError(entry.machineId, step, null, signal).catch(() => undefined);
			} catch (error) {
				if (error instanceof CodingCustodyRefused) {
					outcomes.push({ machineId: entry.machineId, step, state: "not-now", code: error.reason });
					continue;
				}
				signal.throwIfAborted();
				const failure = errorCodeOf(error);
				outcomes.push({ machineId: entry.machineId, step, state: "failed", code: failure });
				await this.#recordError(entry.machineId, step, failure, signal).catch(() => undefined);
			}
		}
		return outcomes;
	}
	#listed(value: unknown): ListedMachine {
		const entry = record(value);
		if (
			entry.schema !== "qorpera.coding-machine-state/v1" ||
			typeof entry.machineId !== "string" ||
			!UUID.test(entry.machineId) ||
			(entry.kind !== "member" && entry.kind !== "session") ||
			(entry.instanceSha256 !== null &&
				(typeof entry.instanceSha256 !== "string" || !SHA.test(entry.instanceSha256))) ||
			(entry.asleepSince !== null && typeof entry.asleepSince !== "string") ||
			![entry.live, entry.reserved, entry.released, entry.sleepDue, entry.removeDue].every(
				(flag) => typeof flag === "boolean",
			)
		)
			throw new Error("CODING_HOST_MACHINE_LIST_INVALID");
		return {
			machineId: entry.machineId,
			kind: entry.kind,
			binding: record(entry.binding),
			instanceSha256: entry.instanceSha256 as string | null,
			live: entry.live as boolean,
			reserved: entry.reserved as boolean,
			asleep: entry.asleepSince !== null,
			released: entry.released as boolean,
			sleepDue: entry.sleepDue as boolean,
			removeDue: entry.removeDue as boolean,
			lastError: typeof entry.lastError === "string" ? entry.lastError : null,
		};
	}
	/** The listed machine's journal plan and the exact binding text SQL pinned. */
	#journal(entry: ListedMachine): { journal: CodingMachineJournalPlan; text: string } {
		if (entry.kind === "member") {
			const plan = lxdCodingMachinePlan(entry.binding as unknown as LxdCodingMachineBinding);
			if (plan.binding.machineId !== entry.machineId) throw new Error("CODING_HOST_MACHINE_LIST_INVALID");
			return { journal: lxdCodingMachineJournalPlan(plan.binding, this.#placement), text: plan.text };
		}
		const plan = lxdCodingVmPlan(entry.binding as unknown as LxdCodingVmBinding);
		if (plan.binding.allocationId !== entry.machineId) throw new Error("CODING_HOST_MACHINE_LIST_INVALID");
		return { journal: lxdLegacyCodingMachineJournalPlan(plan.binding), text: JSON.stringify(plan.binding) };
	}
	/** Stop, with every session's commands stopped and the guest flushed first
	 * (best effort), the session folders unplugged while it is off, and the node
	 * demand suspended: asleep, it holds no node capacity. */
	async #sleep(entry: ListedMachine, signal: AbortSignal): Promise<void> {
		if (!entry.instanceSha256) return;
		const { journal, text } = this.#journal(entry);
		const client = this.#options.client;
		const budget = AbortSignal.any([signal, AbortSignal.timeout(CODING_VM_STOP_BUDGET_MS * 2)]);
		await this.#custody(journal, text, "stop", budget);
		const instance = await client.getInstance(journal.project, journal.name, budget);
		if (instance && instance.status === "Running" && instance.statusCode === 103) {
			const quiet = AbortSignal.any([budget, AbortSignal.timeout(CODING_VM_QUIESCE_MS)]);
			for (const command of [["/usr/bin/systemctl", "stop", "qorpera-coding.slice"], ["/usr/bin/sync"]])
				try {
					await client.execInstance(journal.project, journal.name, command, quiet);
				} catch (error) {
					if (quiet.aborted || (error instanceof Error && error.message === "LXD instance agent not running"))
						break;
				}
		}
		const state = await this.#reconcile(
			journal,
			"stopped",
			async (_intent, checked) => this.#custody(journal, text, "stop", checked),
			budget,
		);
		if (state === "stopped" && entry.kind === "member") {
			const stopped = await client.getInstance(journal.project, journal.name, budget);
			if (stopped) {
				const sessions = assertLxdCodingMachineInstance(
					entry.binding as unknown as LxdCodingMachineBinding,
					this.#placement,
					stopped,
				);
				if (sessions.length) {
					await this.#custody(journal, text, "stop", budget);
					const base = lxdCodingMachinePlan(entry.binding as unknown as LxdCodingMachineBinding).request.devices;
					try {
						await client.replaceInstanceDevices(journal.project, journal.name, base, budget);
					} catch {
						/* Judged below from the machine. */
					}
					const after = await client.getInstance(journal.project, journal.name, budget);
					if (
						after &&
						assertLxdCodingMachineInstance(
							entry.binding as unknown as LxdCodingMachineBinding,
							this.#placement,
							after,
						).length
					)
						throw new Error("CODING_MACHINE_SLEEP_DETACH_UNCONFIRMED");
				}
			}
		}
		const slept = record(
			await this.#call(
				"qorpera_suspend_coding_machine",
				{
					p_machine_id: entry.machineId,
					p_owner: this.#options.owner,
					p_binding_text: text,
					p_machine_id_sha256: this.#options.machineIdSha256,
				},
				budget,
			),
		);
		if (slept.state === "kept") throw new CodingCustodyRefused(String(slept.reason ?? "KEPT"));
		if (slept.state !== "suspended" || slept.machineId !== entry.machineId)
			throw new Error("CODING_MACHINE_SLEEP_UNCONFIRMED");
	}
	/** Asleep (or stopped and suspended first), then deleted under a journaled
	 * delete, then released with that deletion proof. A machine never admitted,
	 * never reserved, or already released elsewhere has nothing to delete. */
	async #remove(entry: ListedMachine, signal: AbortSignal): Promise<void> {
		const release = async (text: string) => {
			const released = record(
				await this.#call(
					"qorpera_release_coding_machine",
					{
						p_machine_id: entry.machineId,
						p_owner: this.#options.owner,
						p_binding_text: text,
						p_machine_id_sha256: this.#options.machineIdSha256,
					},
					signal,
				),
			);
			if (released.state !== "released" || released.machineId !== entry.machineId)
				throw new Error("CODING_MACHINE_RELEASE_UNCONFIRMED");
		};
		if (!entry.instanceSha256) {
			await release(JSON.stringify(entry.binding));
			return;
		}
		const { journal, text } = this.#journal(entry);
		// Released elsewhere, or never given node capacity (so never created): no
		// VM to delete; SQL refuses the release if either is not so.
		if (entry.released || (!entry.reserved && !entry.asleep)) {
			await release(text);
			return;
		}
		if (entry.reserved) await this.#sleep(entry, signal);
		const budget = AbortSignal.any([signal, AbortSignal.timeout(CODING_VM_STOP_BUDGET_MS * 2)]);
		const state = await this.#reconcile(
			journal,
			"deleted",
			async (_intent, checked) => this.#custody(journal, text, "delete", checked),
			budget,
		);
		if (state !== "deleted" && state !== "absent") throw new Error("CODING_HOST_VM_RECOVERY_REQUIRED");
		await release(text);
	}
	async #recordError(
		machineId: string,
		step: CodingHousekeepingOutcome["step"],
		failure: string | null,
		signal: AbortSignal,
	): Promise<void> {
		await this.#call(
			"qorpera_record_coding_machine_error",
			{
				p_machine_id: machineId,
				p_owner: this.#options.owner,
				p_machine_id_sha256: this.#options.machineIdSha256,
				p_stage: step,
				p_code: failure,
			},
			signal,
		);
	}
}
