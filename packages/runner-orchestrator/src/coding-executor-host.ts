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
	CODING_GUEST,
	cloudCodingSessionLayout,
	type IdleRuleSample,
	idleRuleBusy,
	isUuid,
	parseCloudCodingNasPolicy,
} from "@qorpera/contracts";
import { withAbortScope } from "./abort-scope.ts";
import type { AgentPlug } from "./agent-plug.ts";
import {
	type CodingCommandSecrets,
	type CodingEnvironmentSource,
	CodingMachineCommandSecrets,
} from "./coding-command-secrets.ts";
import { LxdCodingCommandTransport } from "./coding-command-transport.ts";
import type {
	CodingExecutorHost,
	CodingExecutorPublication,
	CodingHousekeepingOutcome,
	CodingKeepOutcome,
	CodingSessionClaim,
	CodingSubmission,
	CodingTurnState,
	CodingWorkspace,
} from "./coding-executor.ts";
import {
	CodingMachineUnavailable,
	CodingPushRefused,
	CodingSaveRefused,
	CodingWorkspaceFailed,
} from "./coding-executor.ts";
import { codingFolderKeptCommand, LxdCodingFolderCommandTransport } from "./coding-folder-command-transport.ts";
import {
	type CodingFolderControl,
	codingFolderBoundaryChecking,
	codingFolderBoundaryHeld,
	codingFolderBoundaryUnreadable,
	codingFolderSaveRefused,
} from "./coding-folder-control.ts";
import {
	type CodingFolderRepositories,
	type CodingFolderRepositorySession,
	codingFolderNoRepositories,
} from "./coding-folder-repositories.ts";
import {
	CodingFolderRestartRequired,
	type CodingFolderViewEnd,
	type CodingFolderViews,
} from "./coding-folder-views.ts";
import { type CodingBrokerGitRunner, pushCloudCodingBundle } from "./coding-git.ts";
import { fetchCloudCodingSeed, resolveCloudCodingBase } from "./coding-git-seed.ts";
import { LxdCodingGitTransfer } from "./coding-git-transfer.ts";
import { LxdCodingGuestClient } from "./coding-guest-client.ts";
import { CodingHostLeases } from "./coding-host-lease.ts";
import { LxdCodingLeaseTransport } from "./coding-lease-transport.ts";
import {
	assertLxdCodingMachineInstance,
	type CodingMachineAdmissionReceipt,
	type CodingMachineDesiredState,
	type CodingMachineIntent,
	type CodingMachineJournalPlan,
	type CodingMachineReconcileOptions,
	type CodingMachineStorage,
	checkCodingMachineReceipt,
	codingMachineDisk,
	codingMachineLastStart,
	codingMachineStartDropped,
	codingMachineStartOperation,
	dropCodingMachineStart,
	type LxdCodingMachineBinding,
	lxdCodingMachineJournalPlan,
	lxdCodingMachineName,
	lxdCodingMachinePlan,
	lxdCodingSessionDevices,
	lxdCodingSessionStorage,
	reconcileCodingMachine,
	recordCodingMachineDisk,
	undropCodingMachineStart,
} from "./coding-machine.ts";
import { type CodingNasStorage, createCodingNasStorage } from "./coding-storage.ts";
import { type LxdCodingVmBinding, lxdCodingVmPlan, lxdLegacyCodingMachineJournalPlan } from "./coding-vm.ts";
import { publishCloudCodingDraftPullRequest } from "./coding-workspace.ts";
import type {
	LxdImageClient,
	LxdInspectableClient,
	LxdInstanceDeviceClient,
	LxdInstanceExecStreamClient,
	LxdInstanceFile,
	LxdProjectClient,
	LxdTrackedClient,
} from "./lxd-client.ts";
import { checkDirectory, code, publish, readRecord } from "./lxd-office-journal-files.ts";

export const CODING_HOST_RPCS = [
	"qorpera_plan_coding_machine",
	"qorpera_authorize_coding_machine_run",
	"qorpera_attach_coding_session",
	"qorpera_keep_coding_attachments",
	"qorpera_record_coding_session_detached",
	"qorpera_record_coding_machine_stopped",
	"qorpera_archive_quiet_coding_sessions",
	"qorpera_authorize_coding_machine_custody",
	"qorpera_suspend_coding_machine",
	"qorpera_release_coding_machine",
	"qorpera_record_coding_machine_error",
	"qorpera_list_coding_machines",
	// A session's coding view on the folder model (coding-folder-views.ts).
	"qorpera_folder_view_open",
	"qorpera_folder_view_close",
	// A machine restarted for the company folder (the folder model's rule 4).
	"qorpera_mark_coding_machine_folder_restart",
	"qorpera_record_coding_machine_folder_restart",
	// A machine given a new disk from its image (rule 4, `unreadable`): its disk holds a read no longer readable.
	"qorpera_mark_coding_machine_new_disk",
	"qorpera_record_coding_machine_new_disk",
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
		LxdInstanceDeviceClient &
		LxdImageClient &
		LxdProjectClient;
	journalRoot: string;
	guest: {
		/** The image's own coding user: sessions whose NAS volume predates
		 * per-member machines run as it (their files carry it). Every other
		 * session runs as its own guest uid from SQL. */
		uid: number;
		gid: number;
		/** Only the log bound: a command has no time, memory, CPU or task limit of its own. */
		resourceProfile: {
			maxLogBytes: number;
		};
		storageHelperSha256: string;
		commandHelperSha256: string;
		gitHelperSha256: string;
		watchdogHelperSha256: string;
	};
	repositoryCredentials: CodingRepositoryCredentials;
	/** On the folder model, where each session's vault environment comes from: the company's secret broker (5j-4). Each
	 * command gets it, and its output is masked. Absent, a command gets no secrets. */
	commandEnvironment?: CodingEnvironmentSource;
	/** Or the secrets built on that source, shared with the folder control's save check (5j-5 a): their `values` for a
	 * machine are what its views may not save. Given, it is used in place of `commandEnvironment`. */
	commandSecrets?: CodingMachineCommandSecrets;
	fetch?: typeof fetch;
	runGit?: CodingBrokerGitRunner;
	/** How long a freshly started guest may take to bring up its agent and
	 * watchdog timer (default 120 s; on the folder model, its agent, 300 s). */
	guestReadyTimeoutMs?: number;
	/** On the folder model, how long a turn waits at most for a boot of its machine to finish before it attaches the
	 * session (default 180 s). */
	bootSettleTimeoutMs?: number;
	/** How long LXD's agent may take to mount a hot-plugged session (default 30 s). */
	attachTimeoutMs?: number;
	/** How long one machine's keeper step (observe, keep, renew) may take (default 15 s). */
	keepDeadlineMs?: number;
	/** How long one step on the NAS may take, its wait for the step before it included (default 5 s). */
	storageStepTimeoutMs?: number;
	/** The node's agent plug (default: its plug tool, deploy/agent-exit). */
	agentPlug?: AgentPlug;
	/** The leases that let this node's member machines run, read by the host
	 * watchdog (default: /run/qorpera-coding-host). */
	hostLeases?: CodingHostLeases;
	/** The folder model (F3 step 5g-6a): each session sees the company folder through a view its attachment opens,
	 * runs as its own user, and runs its commands through the guest agent; nothing is hot-plugged, installed or seeded.
	 * Absent, the NAS model. */
	folder?: {
		views: Pick<CodingFolderViews, "attach" | "held" | "end" | "endMachine">;
		control: Pick<CodingFolderControl, "boundary" | "restarted" | "secrets">;
		/** The guest agent's exec client (the executor's LXD client). */
		client: LxdInstanceExecStreamClient;
		/** Where a session's commands start and what its finished turn exports (default: none, at /company). */
		repositories?: CodingFolderRepositories;
		/** Each view the guest mounted for a session, and how the view it replaced ended, if it replaced one. */
		onMount?(mount: { workerId: string; machineId: string; viewId: string; replaced?: CodingFolderViewEnd }): void;
	};
}
type FolderOptions = NonNullable<LxdCodingExecutorHostOptions["folder"]>;
/** A session this process hot-plugged into its member's machine during a turn,
 * before the turn recorded its attachment in SQL: a failure until then
 * unplugs it again (detachSession). */
interface Attached {
	claim: CodingSessionClaim;
	machine: Readonly<LxdCodingMachineBinding>;
	storage: Readonly<CloudCodingStorageBinding>;
}
interface Prepared extends Attached {
	scope: CloudCodingCommandScope;
	bootId: string;
	guestConfigSha256: string;
	baseSha: string;
	/** On the folder model: the session's user, and where its commands start. */
	folder?: { uid: number; cwd: string };
}
/** A session attached to one of this executor's machines under its SQL
 * attachment, standing by or in a turn: what renewing its guest lease needs. */
interface Attachment {
	workerId: string;
	machine: Readonly<LxdCodingMachineBinding>;
	storage: Readonly<CloudCodingStorageBinding>;
	bootId: string;
	guestConfigSha256: string;
	token: string;
	turn: { sequence: number; turnId: string; open: boolean };
	/** When this process took it on (performance clock). */
	since: number;
}
/** The guest a session attaches on: its boot and its configuration's digest, and on the folder model its user. */
interface AttachedGuest {
	bootId: string;
	guestConfigSha256: string;
	folder?: { uid: number };
}
/** One observation of a session's work (its slice's processor time and the bytes its processes moved, on the boot's
 * clock), to tell busy commands from waiting ones. */
interface SessionSample extends IdleRuleSample {
	bootId: string;
}
/** A command whose processes still run, as the guest names it. */
interface ObservedCommand {
	commandId: string;
	turn: number;
	command: string;
}
/** What the guest's observe action published (cloud-coding-guest-observation.ts), or the guest agent's status of each
 * session on the folder model. */
interface Observed {
	bootId: string;
	sessions: Map<
		string,
		{
			/** When its processor time and bytes were read, on the boot's clock. */
			uptimeMs: number;
			cpuUsageUsec: number;
			ioBytes: number;
			/** False when the guest read only some of the machine's processes, so `ioBytes` may leave some out. */
			ioComplete: boolean;
			running: ObservedCommand[];
			/** The watchdog's lease: its generation (the attachment token's digest) and how long it stays live. */
			lease: { tokenSha256: string; expiresInMs: number } | null;
		}
	>;
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
	superseded: boolean;
	removing: boolean;
	lastError: string | null;
	/** Sessions attached to it in SQL, with their attachment's generation. */
	attached: { workerId: string; attachmentToken: string }[];
}
const SHA = /^[0-9a-f]{64}$/;
/** Guest uids from here on belong to one session each (SQL assigns them). */
const CODING_SESSION_UID_BASE = 200000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/** Budget for one physical stop or delete, journal I/O included. Callers that
 * bound a whole step (lookup + effect) allow more than this. */
export const CODING_VM_STOP_BUDGET_MS = 30_000;
/** Part of a sleep for stopping every command slice and syncing the NAS
 * folders before the machine is powered off. */
const CODING_VM_QUIESCE_MS = 8_000;
/** How long one step on the NAS may take (the control path's checks, a session volume's), its wait for the step
 * before it included. One that runs out of it fails with CODING_HOST_STORAGE_TIMEOUT. */
const CODING_STORAGE_STEP_MS = 5_000;
/** How many times in all a folder check (#directory) that ran out of that time is tried, and the pause before its
 * second try, doubled before each next one: at most about 16 s for a NAS that does not answer. */
const CODING_STORAGE_CHECK_TRIES = 3;
const CODING_STORAGE_CHECK_PAUSE_MS = 250;
/** The failures of a turn's workspace that the host can name, by their code, with what the member and the agent read:
 * the turn fails at once with it (CodingWorkspaceFailed). */
const NAMED_WORKSPACE_FAILURES = new Map<string, string>([
	[
		"CODING_HOST_STORAGE_TIMEOUT",
		"The coding machine's storage did not answer in time, so the turn could not start. The workspace is kept; a follow-up tries again.",
	],
	[
		"CODING_MACHINE_PROJECT_REFUSES_AGENT_CARD",
		"No computer could start for this session: its node does not allow the machine's network card yet, and an operator must allow it there. The workspace is kept; a follow-up tries again once that is done.",
	],
]);
/** Part of a sleep or a detach for cancelling a session's running commands and
 * taking the session off the machine inside the guest, before the power-off or
 * the unplug that stop everything anyway. */
const CODING_SESSION_QUIESCE_MS = 20_000;
/** Git's settings for every command of a folder session (RUNTIME-COMPANY-FOLDER.md §6 "Git on the mount", as
 * RUNTIME-FOLDER-CODING-MACHINES.md "Code areas and git" sets them), as GIT_CONFIG_*: the
 * company folder is a network folder many sessions share, so Git waits for its locks, never collects, packs or prunes
 * on its own, trusts no change time, split index or monitor there, and reaches a remote only through ssh or Git's own
 * transports. */
const CODING_FOLDER_GIT_SETTINGS: readonly (readonly [string, string])[] = [
	["core.filesRefLockTimeout", "10000"],
	["core.packedRefsTimeout", "10000"],
	["gc.auto", "0"],
	["maintenance.auto", "false"],
	["gc.worktreePruneExpire", "never"],
	["core.symlinks", "true"],
	["core.checkStat", "minimal"],
	["core.trustctime", "false"],
	["core.splitIndex", "false"],
	["index.sparse", "false"],
	["core.fsmonitor", "false"],
	["core.sshCommand", "/usr/bin/ssh"],
	["protocol.ext.allow", "never"],
];
export const CODING_FOLDER_GIT_ENVIRONMENT: Readonly<Record<string, string>> = Object.freeze(
	Object.fromEntries([
		["GIT_CONFIG_COUNT", String(CODING_FOLDER_GIT_SETTINGS.length)],
		...CODING_FOLDER_GIT_SETTINGS.flatMap(([key, value], index) => [
			[`GIT_CONFIG_KEY_${index}`, key],
			[`GIT_CONFIG_VALUE_${index}`, value],
		]),
	]),
);
/** The most of a running command's text the keeper reports (qorpera_keep_coding_attachments). */
const CODING_OBSERVED_COMMAND_BYTES = 300;
/** How often quiet sessions are looked for (qorpera_archive_quiet_coding_sessions). */
const CODING_ARCHIVE_SCAN_MS = 600_000;
/** The guest publishes its observation here (root 0444, boot-local), each
 * session's running commands beside it (observation-<workerId>.json). */
const CODING_GUEST_OBSERVATION = "/run/qorpera-coding/observation.json";
/** A turn keeps its session's attachment generation only while the guest's
 * lease of it has at least this long left: a renewal must still reach it. */
const CODING_ATTACH_LEASE_MARGIN_MS = 15_000;
/** One machine's keeper step (observe, keep, renew) ends by then, so a slow or
 * stuck machine never holds up a pass: with a pass every 10 s, every guest lease
 * (45 s) is renewed at least every 30 s. */
const CODING_KEEP_MACHINE_MS = 15_000;
/** A session's first mount has less than its attachment's minute, and a machine still booting (a fresh machine's
 * first boot starts the image's services and sets up its new machine id) can take longer than that just to start the
 * guest agent: a turn waits this long at most for the boot to finish before it attaches. */
const CODING_BOOT_SETTLE_MS = 180_000;
/** On the folder model, how long a turn waits by default for a started machine's LXD agent: in a loaded nested VM a
 * fresh machine took 2 min 40 s from running to its agent answering. */
const CODING_FOLDER_GUEST_READY_MS = 300_000;
/** How long a publication waits before it asks for a boundary again while one left paths waiting for save checks that
 * had not ended (the service answers within the control's timeout, and goes on checking). */
const CODING_FOLDER_CHECK_RETRY_MS = 1_000;
/** Refusals a turn waits out in the queue instead of failing: the machine is
 * being removed, the node is full or not ready, the session is still on
 * another machine, the machine's plan followed a new policy after this turn
 * planned it, or the company is out of computer hours (until hours are added).
 * A misconfigured deployment is never waited out. */
const WAITABLE = new Set([
	"MACHINE_RETIRING",
	"COMPUTER_HOURS_EXHAUSTED",
	"NODE_CAPACITY_EXHAUSTED",
	"NODE_OBSERVATION_UNAVAILABLE",
	"NODE_DISABLED",
	"NODE_NOT_PREFERRED",
	"NODE_AGENT_EXIT_UNHEALTHY",
	"LEGACY_SESSION_BUSY",
	"PREVIOUS_MACHINE_AWAKE",
	"MACHINE_PLAN_CHANGED",
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
/** On the folder model, also an exec whose LXD operation failed or whose wait ended first: just after a guest's
 * lxd-agent comes up, LXD can time out connecting to it before the command runs. The folder model's checks
 * (`/usr/bin/true`, the boot wait) are safe to run again, and a machine that stopped fails the next exec at once. */
function folderGuestStarting(error: unknown): boolean {
	return guestStarting(error) || (error instanceof Error && error.message === "LXD operation failed");
}
function digest(value: string | Buffer): string {
	return createHash("sha256").update(value).digest("hex");
}
/** The longest start of `text`, in whole characters, that fits in `bytes` bytes of UTF-8. */
function clipped(text: string, bytes: number): string {
	let size = 0,
		end = 0;
	for (const character of text) {
		size += Buffer.byteLength(character);
		if (size > bytes) break;
		end += character.length;
	}
	return text.slice(0, end);
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
/** A record's `detached`: each session SQL detached, by its attachment; null when it is not a list of them. */
function detachedSessions(value: unknown): { workerId: string; attachmentToken: string }[] | null {
	if (!Array.isArray(value)) return null;
	const ended = value.flatMap((item) => {
		if (!item || typeof item !== "object" || Array.isArray(item)) return [];
		const { workerId, attachmentToken } = item as Record<string, unknown>;
		return isUuid(workerId) && isUuid(attachmentToken) ? [{ workerId, attachmentToken }] : [];
	});
	return ended.length === value.length ? ended : null;
}
/** A fixed identifier for an error: its code, or UNCLASSIFIED. */
function errorCodeOf(error: unknown): string {
	const message = error instanceof Error ? error.message : "";
	return /^[A-Z][A-Z0-9_:]{0,119}$/.test(message) ? message : "UNCLASSIFIED";
}
/** Resolves with the work, or rejects with the caller's abort reason as soon as
 * the caller gives up; the work itself runs on. */
function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted) return Promise.reject(signal.reason);
	return new Promise<T>((resolve, reject) => {
		const abort = () => reject(signal.reason);
		signal.addEventListener("abort", abort, { once: true });
		work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
	});
}
/** A release that failed after its machine was deleted: recorded as `release`. */
class CodingReleaseFailed extends Error {}
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
 * One coding machine per member carries all of that member's sessions. A
 * session is attached (its NAS folders hot-plugged, its guest user and
 * configuration installed) by its first turn and stays attached between turns,
 * with whatever its commands left running, under an attachment this executor
 * renews (keep), until it is archived, its attachment ends or the machine
 * sleeps. The machine sleeps when quiet and is removed once its member has no
 * open session (housekeep). No effect is inferred from a label, a model
 * statement or an assigned runner. */
export class LxdCodingExecutorHost implements CodingExecutorHost {
	readonly #options: LxdCodingExecutorHostOptions;
	readonly #storage: CodingNasStorage;
	readonly #placement: CodingMachineStorage;
	readonly #hostLeases: CodingHostLeases;
	#storageWork: Promise<unknown> = Promise.resolve();
	readonly #machineWork = new Map<string, Promise<unknown>>();
	readonly #prepared = new Map<string, Prepared>();
	readonly #attached = new Map<string, Attached>();
	readonly #attachments = new Map<string, Attachment>();
	readonly #samples = new Map<string, SessionSample>();
	readonly #leaseWork = new Map<string, Promise<unknown>>();
	/** Per session, the serial of the last attach this process recorded: a
	 * keeper pass leaves a session a turn attached during the pass to that turn. */
	readonly #attachSerials = new Map<string, number>();
	#attachSerial = 0;
	/** Take-offs (and new attachments for a turn that lost its guest lease) the
	 * keeper started, at most one per session; they run beside its passes. */
	readonly #releasing = new Map<string, Promise<void>>();
	/** Their outcomes, reported by the next pass. */
	#released: CodingKeepOutcome[] = [];
	/** Per machine, the boot whose storage helper this process has checked against its pin. */
	readonly #helperBoots = new Map<string, string>();
	/** Per machine, the boot this process has seen finish (the folder model). */
	readonly #settledBoots = new Map<string, string>();
	/** Per machine, how many times this process started it on the folder model: a turn that found the machine must
	 * restart for the folder leaves it running if it started since that turn's start, another turn's restart included. */
	readonly #folderStarts = new Map<string, number>();
	/** Per machine on the folder model, the LXD operation that started it as it runs now, read each time a turn found it
	 * running or started it: every session's commands on it start and are read under that start as it is at that moment,
	 * whenever the session was prepared or its transport made. None from right before it starts again until that start
	 * is read. */
	readonly #folderStartOperations = new Map<string, string>();
	/** The vault environments this process asked for the sessions attached to its machines (5j-4). */
	readonly #commandSecrets: CodingMachineCommandSecrets | undefined;
	#archiveScanAt = Number.NEGATIVE_INFINITY;
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
			![options.guest.uid, options.guest.gid].every(
				(value) => Number.isSafeInteger(value) && value >= 1000 && value < CODING_SESSION_UID_BASE,
			)
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
		this.#hostLeases = options.hostLeases ?? new CodingHostLeases();
		this.#options = {
			...options,
			storagePolicy,
			vmPolicy: Object.freeze({ ...options.vmPolicy }),
			guest: Object.freeze({
				...options.guest,
				resourceProfile: Object.freeze({ ...options.guest.resourceProfile }),
			}),
		};
		this.#commandSecrets =
			options.commandSecrets ??
			(options.commandEnvironment ? new CodingMachineCommandSecrets(options.commandEnvironment) : undefined);
	}
	#call(method: string, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
		signal.throwIfAborted();
		return this.#options.control.call(method, args, AbortSignal.any([signal, AbortSignal.timeout(30000)]));
	}
	/** One lifecycle step at a time per machine: create, start, attach, detach,
	 * stop, delete and release never overlap on one machine. Commands of its
	 * sessions run in parallel between them. A caller that gives up while
	 * waiting (its signal aborts) leaves at once and its step never starts; a
	 * step that has started holds the machine until it settles. */
	#exclusive<T>(machineId: string, signal: AbortSignal, use: () => Promise<T>): Promise<T> {
		const previous = this.#machineWork.get(machineId) ?? Promise.resolve();
		const work = previous
			.catch(() => undefined)
			.then(() => {
				signal.throwIfAborted();
				return use();
			});
		this.#machineWork.set(machineId, work);
		void work
			.catch(() => undefined)
			.finally(() => {
				if (this.#machineWork.get(machineId) === work) this.#machineWork.delete(machineId);
			});
		return abortable(work, signal);
	}
	async #storageTask<T>(use: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
		const limit = AbortSignal.timeout(this.#options.storageStepTimeoutMs ?? CODING_STORAGE_STEP_MS);
		const checked = AbortSignal.any([...(signal ? [signal] : []), limit]);
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
		} catch (error) {
			// The step's own time ran out, not its caller's: the NAS did not answer in time.
			if (limit.aborted && !signal?.aborted) throw new Error("CODING_HOST_STORAGE_TIMEOUT", { cause: error });
			throw error;
		} finally {
			if (abort) checked.removeEventListener("abort", abort);
		}
	}
	/** The folder `name` under the NAS control path, made if it is not there, and checked with the control path before
	 * and after. A check that ran out of its time is tried again, after a short pause, up to CODING_STORAGE_CHECK_TRIES
	 * times in all: the NAS answering slowly for a moment does not fail the step (C8 C4-1, 26 Oct 2026: a wake's first
	 * step ran out of its 5 s and its turn ended). Each try waits for the one before it (#storageTask), so a NAS that
	 * does not answer still gets one request at a time, and the step fails with CODING_HOST_STORAGE_TIMEOUT after the
	 * last. Any other failure, and the caller giving up, fail it at once. */
	async #directory(name: string, callerSignal?: AbortSignal): Promise<string> {
		for (let attempt = 1; ; attempt++) {
			try {
				return await this.#storageTask(async (signal) => {
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
			} catch (error) {
				if (
					!(error instanceof Error && error.message === "CODING_HOST_STORAGE_TIMEOUT") ||
					attempt >= CODING_STORAGE_CHECK_TRIES
				)
					throw error;
				await setTimeout(CODING_STORAGE_CHECK_PAUSE_MS * 2 ** (attempt - 1), undefined, { signal: callerSignal });
			}
		}
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
		checkCodingMachineReceipt(
			value,
			{
				machineId: plan.binding.machineId,
				instanceSha256: plan.instanceSha256,
				intent: "run",
				workerId: claim.workerId,
			},
			performance.now() - started,
		);
		// Counted from before the request: the receipt's seconds include the NAS checks below.
		const deadline = started + Number(value.validForMs);
		const guestUid = value.guestUid as number | null;
		if (guestUid !== null && guestUid < CODING_SESSION_UID_BASE)
			throw new Error("CODING_MACHINE_ADMISSION_UNCONFIRMED");
		await this.#storageTask(async (checked) => {
			if (prepareStorage) {
				await this.#storage.prepareControl(checked);
				await this.#storage.prepare(storage, checked);
			} else {
				await this.#storage.assertControl(checked);
				await this.#storage.assert(storage, checked);
			}
		}, signal);
		if (performance.now() >= deadline) throw new Error("CODING_MACHINE_ADMISSION_EXPIRED");
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
	 * operations, within its budget. A member's machine found stopped from
	 * outside is handed to `stoppedFromOutside` before anything else is done to it,
	 * and a stopped one to `starting` right before each start (which may answer
	 * that a rebuild goes out instead). */
	async #reconcile(
		journal: CodingMachineJournalPlan,
		desiredState: CodingMachineDesiredState,
		authorize: (intent: CodingMachineIntent, signal: AbortSignal) => Promise<unknown>,
		signal: AbortSignal,
		stoppedFromOutside?: (startOperationId: string, signal: AbortSignal) => Promise<void>,
		starting?: CodingMachineReconcileOptions["starting"],
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
				plug: this.#options.agentPlug,
				stoppedFromOutside,
				starting,
				// Read before a create with the agent card, so a node not set up for it fails that create, not its machine.
				projectAllowsAgentCard: (project, read) => this.#options.client.allowsAgentCard(project, read),
			});
			checked.throwIfAborted();
			if (result.state === "pending") {
				await setTimeout(500, undefined, { signal: checked });
				continue;
			}
			// An effect LXD refused at its submission names LXD's status, which the log shows (and a failed
			// housekeeping step's last_error).
			if (result.state === "recovery-required")
				throw new Error(
					result.lxdStatus
						? `CODING_HOST_VM_RECOVERY_REQUIRED:LXD_REFUSED_${result.lxdStatus}`
						: "CODING_HOST_VM_RECOVERY_REQUIRED",
				);
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
	/** The machine's guest is up and trustworthy for this boot: its agent and
	 * watchdog timer answer, its helpers are the pinned ones, and its image
	 * cannot update itself. Runs before any session folder is hot-plugged, so a
	 * machine that has just started is never asked to mount anything first.
	 * Returns the boot id. */
	async #ready(machine: Readonly<LxdCodingMachineBinding>, signal: AbortSignal): Promise<string> {
		const client = this.#options.client,
			name = lxdCodingMachineName(machine.machineId);
		const instance = await client.getInstance(machine.project, name, signal);
		if (!instance || instance.status !== "Running" || instance.statusCode !== 103)
			throw new Error("CODING_HOST_VM_NOT_RUNNING");
		assertLxdCodingMachineInstance(machine, this.#placement, instance);
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
		return bootId;
	}
	/** Installs the attached session inside the guest: its configuration for
	 * this boot, its storage binding, its user and folders. */
	async #install(
		claim: CodingSessionClaim,
		machine: Readonly<LxdCodingMachineBinding>,
		storage: Readonly<CloudCodingStorageBinding>,
		bootId: string,
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
		// The configuration names the boot the readiness checks saw.
		const boot = await client.readInstanceFile(machine.project, name, "/proc/sys/kernel/random/boot_id", 64, signal);
		if (boot.content.toString("utf8").trim() !== bootId) throw new Error("CODING_MACHINE_BOOT_CHANGED");
		const configuration = {
			schema: "qorpera.coding-command-guest/v4",
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
	/** The command secrets of this turn's session on its machine, asked for under its claim; none without a broker. On the
	 * folder model, the folder service has the machine's values (5j-5 (a)) before a command starts with them. */
	#sessionSecrets(ready: Prepared): CodingCommandSecrets | undefined {
		const { machineId } = ready.machine;
		const secrets = this.#commandSecrets?.session(machineId, {
			companyId: ready.claim.profileId,
			workerId: ready.claim.workerId,
			leaseToken: ready.claim.leaseToken,
		});
		const control = this.#options.folder?.control;
		if (!secrets || !control) return secrets;
		return {
			...secrets,
			resolve: async (request, signal) => {
				const resolved = await secrets.resolve(request, signal);
				await control.secrets(machineId, signal);
				return resolved;
			},
		};
	}
	/** The turn is still prepared: once its detach begins, nothing new starts. */
	#current(ready: Prepared): void {
		if (this.#prepared.get(ready.claim.workerId) !== ready) throw new Error("CODING_HOST_TURN_NOT_PREPARED");
	}
	#active(claim: CodingSessionClaim): Prepared {
		const ready = this.#prepared.get(claim.workerId);
		if (!ready || ready.claim.leaseToken !== claim.leaseToken || ready.scope.turn !== claim.sequence)
			throw new Error("CODING_HOST_TURN_NOT_PREPARED");
		return ready;
	}
	/** The seed runs inside prepareWorkspace, before the turn counts as
	 * prepared (the executor detaches only after that settles); an export runs
	 * only while the turn is still prepared. */
	#transfer(ready: Prepared, seeding = false): LxdCodingGitTransfer {
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
				if (!seeding) this.#current(ready);
				await this.#run(ready.claim, ready.machine, ready.storage, signal);
			},
		});
	}
	/** A failure the host can name (NAMED_WORKSPACE_FAILURES) is a CodingWorkspaceFailed, unless the caller gave up. */
	async prepareWorkspace(
		claim: CodingSessionClaim,
		turn: CodingTurnState,
		signal: AbortSignal,
	): Promise<CodingWorkspace> {
		try {
			return await this.#prepareWorkspace(claim, turn, signal);
		} catch (error) {
			const summary = error instanceof Error ? NAMED_WORKSPACE_FAILURES.get(error.message) : undefined;
			if (!(error instanceof Error) || summary === undefined || signal.aborted) throw error;
			throw new CodingWorkspaceFailed(error.message, summary, { cause: error });
		}
	}
	async #prepareWorkspace(
		claim: CodingSessionClaim,
		turn: CodingTurnState,
		signal: AbortSignal,
	): Promise<CodingWorkspace> {
		if (turn.workerId !== claim.workerId || turn.sequence !== claim.sequence)
			throw new Error("CODING_HOST_TURN_CHANGED");
		const machine = await this.#plan(claim, signal);
		const storage = lxdCodingSessionStorage(machine, this.#placement, claim.workerId);
		const journal = lxdCodingMachineJournalPlan(machine, this.#placement);
		if (this.#options.folder)
			return this.#prepareFolder(this.#options.folder, claim, turn, machine, storage, journal, signal);
		const bootId = await this.#exclusive(machine.machineId, signal, async () => {
			await this.#run(claim, machine, storage, signal, true);
			// SQL reserves it on this node now: its lease comes before its start, and the keeper renews it.
			await this.#hostLeases.renew(journal);
			const authorize = async (checked: AbortSignal) => this.#run(claim, machine, storage, checked);
			await this.#reconcile(
				journal,
				"running",
				async (_intent, checked) => authorize(checked),
				signal,
				// Stopped from outside: its sessions are told, and their folders come off before it starts again.
				async (startOperationId, checked) => {
					await this.#recordMachineStopped(machine, startOperationId, checked);
					await this.#unplugStopped(machine, authorize, "CODING_MACHINE_STOP_DETACH_UNCONFIRMED", checked);
				},
			);
			await this.#run(claim, machine, storage, signal);
			const boot = await this.#ready(machine, signal);
			// From here on the session may be attached: detachSession unplugs it
			// whatever happens next, a deferral or a failure included.
			this.#attached.set(claim.workerId, { claim, machine, storage });
			await this.#attach(claim, machine, storage, signal);
			return boot;
		});
		const guest = await this.#install(claim, machine, storage, bootId, signal);
		const authorize = async () => {
			await this.#run(claim, machine, storage, signal);
		};
		const { root, baseSha } = await this.#base(claim, turn, authorize, signal);
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
			await this.#transfer(ready, true).seed(codingHostId("seed", claim.workerId), baseSha, seed.bundle, signal);
			await publish(
				root,
				seededName,
				Buffer.from(JSON.stringify({ workerId: claim.workerId, vmId: machine.machineId, headSha: baseSha })),
			);
		}
		// The session is on its machine: record its attachment and take the guest
		// lease under it with this turn open. A session standing by since an
		// earlier turn keeps its attachment's generation, and so whatever its
		// commands left running, while the guest still holds that generation.
		await this.#attachSession(claim, machine, storage, guest, ready.scope, signal);
		this.#prepared.set(claim.workerId, ready);
		return { vmId: machine.machineId, baseSha };
	}
	/** The commit the session started from: resolved and pinned in the Git journal by its first turn, the same for
	 * every later one. */
	async #base(
		claim: CodingSessionClaim,
		turn: CodingTurnState,
		authorize: () => Promise<void>,
		signal: AbortSignal,
	): Promise<{ root: string; baseSha: string }> {
		const root = await this.#directory("git");
		const baseName = `${claim.workerId}.base.json`;
		let baseSha: string;
		try {
			baseSha = String(record((await readRecord(join(root, baseName))).value).baseSha);
		} catch (error) {
			if (!code(error, "ENOENT")) throw error;
			const sha =
				claim.repository.host === "qorpera"
					? await this.#startRepository(claim, authorize, signal)
					: await resolveCloudCodingBase(claim.repository, {
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
		return { root, baseSha };
	}
	/** The base of a session on a repository kept in Qorpera (own code storage, slice 1): the repository made empty when
	 * it is not there yet, by the company's code host, and its default branch's commit. Only the folder model with code
	 * hosts keeps repositories; without them the turn fails before the model runs, saying so. No token is asked for. */
	async #startRepository(
		claim: CodingSessionClaim,
		authorize: () => Promise<void>,
		signal: AbortSignal,
	): Promise<string> {
		const repositories = this.#options.folder?.repositories;
		if (!repositories?.start)
			throw new CodingWorkspaceFailed(
				"CODING_REPOSITORY_NOT_HERE",
				"This coding service keeps no repositories in the company folder, so the session could not start. Nothing was changed.",
			);
		return (await repositories.start({ claim, assertAuthorized: () => authorize() }, signal)).baseSha;
	}
	/** A turn on the folder model (5g-6a): the machine runs and its LXD agent answers, the session's repositories are
	 * made ready in the company folder and published there, and then the session is attached in SQL and its view mounted
	 * at /company under that attachment, so a view mounted now lists the session's worktree from its first listing.
	 * Nothing is hot-plugged, installed or seeded in the machine, and no guest lease is taken: the session's view is held
	 * under its attachment, which the keeper renews. A machine that must restart for the folder before its view opens
	 * (rule 4) restarts, and the session attaches again, once; one SQL holds marked for a new disk gets it so too. */
	async #prepareFolder(
		folder: FolderOptions,
		claim: CodingSessionClaim,
		turn: CodingTurnState,
		machine: Readonly<LxdCodingMachineBinding>,
		storage: Readonly<CloudCodingStorageBinding>,
		journal: CodingMachineJournalPlan,
		signal: AbortSignal,
	): Promise<CodingWorkspace> {
		let started = await this.#startFolder(folder, claim, machine, storage, journal, signal);
		const authorize = async () => {
			await this.#run(claim, machine, storage, signal);
		};
		const { root, baseSha } = await this.#base(claim, turn, authorize, signal);
		const scope = codingTurnScope(claim.workerId, machine.machineId, claim.sequence);
		if (scope.requestId !== turn.turnId) throw new Error("CODING_HOST_TURN_ID_DIFFERS");
		const { cwd } = await (folder.repositories ?? codingFolderNoRepositories).prepare(
			this.#repositorySession(claim, machine, storage, started.uid, baseSha, root),
			signal,
		);
		const attach = async ({ bootId, uid }: { bootId: string; uid: number }) => {
			// A machine SQL holds marked for a new disk gets it before a view opens on it, or one held since an earlier turn
			// is kept: that view would stay mounted until its next renewal.
			if (await this.#newDiskDue(machine, signal)) throw new CodingFolderRestartRequired("READS_UNREADABLE");
			const guest = { bootId, guestConfigSha256: this.#folderSessionSha(claim.workerId, machine.machineId, bootId) };
			await this.#attachSession(claim, machine, storage, { ...guest, folder: { uid } }, scope, signal);
			return guest;
		};
		let guest: { bootId: string; guestConfigSha256: string };
		try {
			guest = await attach(started);
		} catch (error) {
			if (!(error instanceof CodingFolderRestartRequired)) throw error;
			// No view opened: the machine stops, unless it started since this turn's start, and starts again (on a new disk
			// when it holds a read no longer readable, or SQL marked it for one: then it stops all the same), and its
			// restart's record detached the session, which attaches anew on the new boot.
			started = await this.#startFolder(folder, claim, machine, storage, journal, signal, {
				starts: started.starts,
				newDisk: error.code === "READS_UNREADABLE",
			});
			guest = await attach(started);
		}
		const ready: Prepared = {
			claim,
			machine,
			storage,
			scope,
			...guest,
			baseSha,
			folder: { uid: started.uid, cwd },
		};
		this.#prepared.set(claim.workerId, ready);
		return { vmId: machine.machineId, baseSha };
	}
	/** One lifecycle step on the folder model: the machine runs this plan and its LXD agent answers, and the session's
	 * user and the boot are read, with how many times this process started the machine so far. With `restart` (that
	 * count when a turn found the machine must restart for the folder), it stops first, unless it started since. One that
	 * must get a new disk is marked for it and stops all the same: a start since may not have given it one, and the
	 * turn's view does not open on it until it has. */
	#startFolder(
		folder: FolderOptions,
		claim: CodingSessionClaim,
		machine: Readonly<LxdCodingMachineBinding>,
		storage: Readonly<CloudCodingStorageBinding>,
		journal: CodingMachineJournalPlan,
		signal: AbortSignal,
		restart?: { starts: number; newDisk: boolean },
	): Promise<{ bootId: string; uid: number; starts: number }> {
		return this.#exclusive(machine.machineId, signal, async () => {
			await this.#run(claim, machine, storage, signal, true);
			if (
				restart !== undefined &&
				(restart.newDisk || (this.#folderStarts.get(machine.machineId) ?? 0) === restart.starts)
			)
				await this.#stopForFolder(folder, machine, journal, signal, restart.newDisk);
			await this.#runFolder(folder, claim, machine, storage, journal, signal);
			const receipt = await this.#run(claim, machine, storage, signal);
			// Each session runs as its own user, which SQL assigns in the guest agent's range.
			const uid = receipt.guestUid;
			if (uid === null || uid < CODING_GUEST.minUid || uid > CODING_GUEST.maxUid)
				throw new Error("CODING_FOLDER_SESSION_UID_MISSING");
			const bootId = await this.#folderReady(machine, signal);
			return { bootId, uid, starts: this.#folderStarts.get(machine.machineId) ?? 0 };
		});
	}
	/** The folder model's machine runs, started if it was stopped, under the turn's run authority (a new disk under
	 * custody's), and the start it runs under is read (#folderStartOperations). Called under #exclusive. */
	async #runFolder(
		folder: FolderOptions,
		claim: CodingSessionClaim,
		machine: Readonly<LxdCodingMachineBinding>,
		storage: Readonly<CloudCodingStorageBinding>,
		journal: CodingMachineJournalPlan,
		signal: AbortSignal,
	): Promise<void> {
		// SQL reserves it on this node now: its lease comes before its start, and the keeper renews it.
		await this.#hostLeases.renew(journal);
		const text = lxdCodingMachinePlan(machine).text;
		await this.#reconcile(
			journal,
			"running",
			async (intent, checked) =>
				intent === "rebuild"
					? this.#custody(journal, text, "rebuild", checked)
					: this.#run(claim, machine, storage, checked),
			signal,
			// Stopped from outside: its views end while their attachments are still the live ones, so their final
			// boundary saves what they had pending, and then SQL ends every attachment on it, all before it starts
			// again. A view that ended unsaved or not confirmed closed is reported once the stop is recorded.
			async (startOperationId, checked) => {
				const ends = await folder.views.endMachine(machine.machineId, checked);
				await this.#recordMachineStopped(machine, startOperationId, checked);
				if (ends.some((end) => !end.saved)) throw new Error("CODING_FOLDER_VIEW_UNSAVED");
				if (ends.some((end) => !end.closed)) throw new Error("CODING_FOLDER_VIEW_CLOSE_UNCONFIRMED");
			},
			// Stopped, right before each start: the folder service hears the machine restarted (the plan's rule 4), so a
			// read it was served on its last boot and never released no longer leaves the views it opens unproven, and
			// then SQL records a restart for the folder, if the machine was marked for one, named by the effect the start
			// follows. Either not confirmed, the machine does not start. Whether a read of its last boot may have gone
			// unreleased (F3 5g-5) is written down first, against that boot's start, and taken back only when the service
			// answers no to the call after that write: an answer unheard may have been yes, and no later call says so
			// again. The boot's commands then keep nothing more of what it left on the machine's disk. Before all that,
			// no session's command starts, or is read, under that boot's start any more. A machine marked for a new disk
			// (rule 4, `unreadable`) is rebuilt first, and the start after the rebuild comes here again and records the
			// new disk: next to the journal first, so the old disk's commands show nothing from then on, and then in SQL,
			// which clears the marks that withheld them until then.
			async (afterOperationId, checked, after) => {
				this.#folderStartOperations.delete(machine.machineId);
				const journalRoot = await this.#directory("machines", checked);
				const boot = await codingMachineLastStart(journalRoot, journal);
				const marked = boot !== null && (await dropCodingMachineStart(journalRoot, journal, boot));
				const dropped = await folder.control.restarted(machine.machineId, checked);
				if (boot !== null && marked && !dropped) await undropCodingMachineStart(journalRoot, journal, boot);
				if (after === "rebuild") {
					await recordCodingMachineDisk(journalRoot, journal, afterOperationId);
					await this.#recordNewDisk(machine, afterOperationId, checked);
				} else if (await this.#recordFolderRestart(machine, afterOperationId, checked)) return "rebuild";
				this.#folderStarts.set(machine.machineId, (this.#folderStarts.get(machine.machineId) ?? 0) + 1);
			},
		).catch(async (error: unknown) => {
			// The machine's image is no longer on the node: it stays stopped and marked, with its own error, and each turn
			// on it fails so until the image is back or the machine is removed.
			if (error instanceof Error && error.message === "CODING_MACHINE_IMAGE_GONE")
				await this.#recordError(machine.machineId, "wake", error.message, signal).catch(() => undefined);
			throw error;
		});
		// The start this boot came from: a command's start names it, so a read after a restart knows its boot.
		this.#folderStartOperations.set(
			machine.machineId,
			await codingMachineStartOperation(await this.#directory("machines", signal), journal),
		);
	}
	/** Rule 4 (RUNTIME-FOLDER-CODING-MACHINES.md): the machine's reads can't be proven released, so it stops before any
	 * view opens on it again. SQL marks it first: from then on no coding view opens on it, its open ones close at their
	 * next renewal, and its stop is granted while a turn uses it; the start's record clears the mark. Its views end, their
	 * final boundary saving what it still can: a machine whose reads are unproven saves nothing, and a view whose record
	 * stays is ended by its session's next attach. With `newDisk` (rule 4, `unreadable`) it is marked for a new disk,
	 * which marks it to restart too: its start is then a rebuild first. Called under #exclusive. */
	async #stopForFolder(
		folder: FolderOptions,
		machine: Readonly<LxdCodingMachineBinding>,
		journal: CodingMachineJournalPlan,
		signal: AbortSignal,
		newDisk = false,
	): Promise<void> {
		const text = lxdCodingMachinePlan(machine).text;
		await this.#markForFolder(machine, newDisk, signal);
		await folder.views.endMachine(machine.machineId, signal).catch(() => undefined);
		await this.#reconcile(
			journal,
			"stopped",
			async (_intent, checked) => this.#custody(journal, text, "stop", checked),
			signal,
			// Stopped from outside meanwhile: each attachment ends as MACHINE_STOPPED, and the restart's record finds none.
			(startOperationId, checked) => this.#recordMachineStopped(machine, startOperationId, checked),
		);
	}
	/** The folder model's readiness: the machine runs this plan and its LXD agent answers, waited for (bounded) while
	 * it starts, and its boot has finished (#bootSettled). Returns the boot id. The session's view writes the guest agent
	 * and folder program the executor carries when it attaches (coding-folder-views.ts); the image's own checks (its
	 * helpers, watchdog timer and self-update) are step 5h's. */
	async #folderReady(machine: Readonly<LxdCodingMachineBinding>, signal: AbortSignal): Promise<string> {
		const client = this.#options.client,
			name = lxdCodingMachineName(machine.machineId);
		const ready = AbortSignal.any([
			signal,
			AbortSignal.timeout(this.#options.guestReadyTimeoutMs ?? CODING_FOLDER_GUEST_READY_MS),
		]);
		let boot: LxdInstanceFile;
		for (;;) {
			try {
				// Every try re-reads the machine: one deleted or stopped elsewhere fails now.
				const instance = await client.getInstance(machine.project, name, ready);
				if (!instance || instance.status !== "Running" || instance.statusCode !== 103)
					throw new Error("CODING_HOST_VM_NOT_RUNNING");
				assertLxdCodingMachineInstance(machine, this.#placement, instance);
				await client.execInstance(machine.project, name, ["/usr/bin/true"], ready);
				// The boot id comes through the same agent, which can still fail a read in its first seconds.
				boot = await client.readInstanceFile(machine.project, name, "/proc/sys/kernel/random/boot_id", 64, ready);
				break;
			} catch (error) {
				signal.throwIfAborted();
				if (ready.aborted) throw new Error("CODING_HOST_GUEST_NOT_READY", { cause: error });
				// Reading the boot id changes nothing in the guest, so a read that went unconfirmed is tried again.
				const unread = error instanceof Error && error.message === "LXD_INSTANCE_FILE_UNCONFIRMED";
				if (!folderGuestStarting(error) && !unread) throw error;
				await setTimeout(1000, undefined, { signal: ready }).catch(() => undefined);
				// The caller's own abort wins over the readiness deadline.
				signal.throwIfAborted();
				if (ready.aborted) throw new Error("CODING_HOST_GUEST_NOT_READY", { cause: error });
			}
		}
		const bootId = boot.content.toString("utf8").trim();
		if (boot.uid !== 0 || boot.gid !== 0 || boot.mode !== 0o444 || !isUuid(bootId))
			throw new Error("CODING_HOST_BOOT_UNCONFIRMED");
		await this.#bootSettled(machine, name, bootId, signal);
		return bootId;
	}
	/** Waits until systemd in the machine has finished this boot (`systemctl is-system-running --wait`), once per boot
	 * and for at most CODING_BOOT_SETTLE_MS, so the session's attachment starts its minute on a machine that answers in
	 * time. A boot that finished degraded (a unit failed) has finished too. A wait that ends without an answer (LXD's
	 * operation limit, an agent not up) is run again. Past the limit the session is attached anyway, and the next turn
	 * on this boot waits again. */
	async #bootSettled(
		machine: Readonly<LxdCodingMachineBinding>,
		name: string,
		bootId: string,
		signal: AbortSignal,
	): Promise<void> {
		if (this.#settledBoots.get(machine.machineId) === bootId) return;
		const settled = AbortSignal.any([
			signal,
			AbortSignal.timeout(this.#options.bootSettleTimeoutMs ?? CODING_BOOT_SETTLE_MS),
		]);
		for (;;) {
			try {
				await this.#options.client.execInstance(
					machine.project,
					name,
					["/usr/bin/systemctl", "is-system-running", "--wait"],
					settled,
				);
				break;
			} catch (error) {
				signal.throwIfAborted();
				if (settled.aborted) return;
				// It exits non-zero once the boot has finished in any state but running (degraded, maintenance).
				if (error instanceof Error && error.message === "LXD instance command failed") break;
				// LXD's own wait for the exec ends first (its operation limit, 120 s by default), or the exec failed
				// before it ran: wait again.
				if (!folderGuestStarting(error)) throw error;
				await setTimeout(1000, undefined, { signal: settled }).catch(() => undefined);
				signal.throwIfAborted();
				if (settled.aborted) return;
			}
		}
		this.#settledBoots.set(machine.machineId, bootId);
	}
	/** A folder session on one boot, where the NAS model names the configuration it installed: the folder model
	 * installs none. */
	#folderSessionSha(workerId: string, machineId: string, bootId: string): string {
		return digest(JSON.stringify({ schema: "qorpera.coding-folder-session/v1", workerId, vmId: machineId, bootId }));
	}
	/** The session as its folder repositories see it, with fresh run authority for each step. */
	#repositorySession(
		claim: CodingSessionClaim,
		machine: Readonly<LxdCodingMachineBinding>,
		storage: Readonly<CloudCodingStorageBinding>,
		uid: number,
		baseSha: string,
		journalRoot: string,
	): CodingFolderRepositorySession {
		return {
			claim,
			machine,
			uid,
			baseSha,
			journalRoot,
			assertAuthorized: async (checked) => {
				await this.#run(claim, machine, storage, checked);
			},
			withRepositoryToken: this.#repositoryToken(claim),
			runGit: this.#options.runGit,
		};
	}
	/** One guest lease step of the session, so the keeper never renews it
	 * between this attach and its first renewal. */
	#attachSession(
		claim: CodingSessionClaim,
		machine: Readonly<LxdCodingMachineBinding>,
		storage: Readonly<CloudCodingStorageBinding>,
		guest: AttachedGuest,
		scope: CloudCodingCommandScope,
		signal: AbortSignal,
	): Promise<void> {
		return this.#leaseTask(claim.workerId, () =>
			this.#attachSessionNow(claim, machine, storage, guest, scope, signal),
		);
	}
	async #attachSessionNow(
		claim: CodingSessionClaim,
		machine: Readonly<LxdCodingMachineBinding>,
		storage: Readonly<CloudCodingStorageBinding>,
		guest: AttachedGuest,
		scope: CloudCodingCommandScope,
		signal: AbortSignal,
		fresh = false,
	): Promise<void> {
		const folder = this.#options.folder;
		let generation: string | null;
		if (folder) {
			// The generation the session's view was opened under on this boot of the machine, by its record, so also after
			// this process restarted: the view stays, with whatever its commands left running, if SQL keeps it. One from
			// an earlier boot ends first, while its attachment is still the live one, so its final boundary saves what it
			// has pending before a new generation leaves it nothing to save under. A view on another machine is left to
			// SQL, which attaches nothing here while that machine's attachment lives.
			const held = await folder.views.held(claim.workerId, signal);
			const onMachine = held !== undefined && held.machineId === machine.machineId;
			generation = !fresh && onMachine && held.bootId === guest.bootId ? digest(held.attachmentToken) : null;
			if (generation === null && onMachine) {
				const end = await this.#exclusive(machine.machineId, signal, () =>
					folder.views.end(claim.workerId, signal),
				);
				if (end && !end.saved) throw new Error("CODING_FOLDER_VIEW_UNSAVED");
				if (end && !end.closed) throw new Error("CODING_FOLDER_VIEW_CLOSE_UNCONFIRMED");
			}
		} else {
			// The generation the guest still holds, if a renewal can still reach it:
			// SQL keeps it only if it is also the live attachment on this machine.
			const lease = fresh
				? undefined
				: (await this.#observe(machine, signal, false)).sessions.get(claim.workerId)?.lease;
			generation = lease && lease.expiresInMs >= CODING_ATTACH_LEASE_MARGIN_MS ? lease.tokenSha256 : null;
		}
		const started = performance.now();
		const attached = record(
			await this.#call(
				"qorpera_attach_coding_session",
				{
					p_worker_id: claim.workerId,
					p_lease_token: claim.leaseToken,
					p_binding_text: lxdCodingMachinePlan(machine).text,
					p_storage: storage,
					p_machine_id_sha256: this.#options.machineIdSha256,
					p_guest_generation: generation,
				},
				signal,
			),
		);
		if (attached.state === "refused") {
			const reason = String(attached.reason ?? "");
			if (WAITABLE.has(reason)) throw new CodingMachineUnavailable(reason);
			throw new Error(`CODING_HOST_MACHINE_REFUSED:${/^[A-Z_]{1,64}$/.test(reason) ? reason : "UNKNOWN"}`);
		}
		const turnState = this.#attachedTurn(attached.turn);
		if (
			attached.schema !== "qorpera.coding-attachment/v1" ||
			attached.state !== "attached" ||
			attached.workerId !== claim.workerId ||
			attached.machineId !== machine.machineId ||
			typeof attached.attachmentToken !== "string" ||
			!UUID.test(attached.attachmentToken) ||
			turnState.sequence !== claim.sequence ||
			turnState.turnId !== scope.requestId ||
			!turnState.open ||
			!Number.isSafeInteger(attached.validForMs) ||
			Number(attached.validForMs) < 1
		)
			throw new Error("CODING_HOST_ATTACHMENT_UNCONFIRMED");
		const attachment: Attachment = {
			workerId: claim.workerId,
			machine,
			storage,
			bootId: guest.bootId,
			guestConfigSha256: guest.guestConfigSha256,
			token: attached.attachmentToken,
			turn: turnState,
			since: started,
		};
		this.#attachments.set(claim.workerId, attachment);
		this.#attachSerials.set(claim.workerId, ++this.#attachSerial);
		// From here on the session is the attachment's: a failure no longer unplugs it.
		if (this.#attached.get(claim.workerId)?.claim.leaseToken === claim.leaseToken)
			this.#attached.delete(claim.workerId);
		if (folder) {
			if (!guest.folder) throw new Error("CODING_FOLDER_SESSION_UID_MISSING");
			const session = {
				workerId: claim.workerId,
				environmentId: claim.environmentId,
				attachmentToken: attachment.token,
				machine,
				bootId: guest.bootId,
				uid: guest.folder.uid,
			};
			// Its view, under the attachment and while SQL keeps it, never beside the machine's lifecycle steps. A view it
			// replaces is one whose attachment SQL let lapse: how that one ended is reported. One the node closed is not
			// replaced: the machine must restart first (CodingFolderRestartRequired, #prepareFolder). The folder service
			// has the machine's secret values first (5j-5 (a)), with the session's asked now, so they are known before a
			// command starts, none too: none of its views saves before.
			await this.#commandSecrets?.attached(
				machine.machineId,
				{ companyId: claim.profileId, workerId: claim.workerId, leaseToken: claim.leaseToken },
				signal,
			);
			await folder.control.secrets(machine.machineId, signal);
			const { viewId, replaced } = await this.#exclusive(machine.machineId, signal, () =>
				folder.views.attach(
					session,
					Date.now() + (started + Number(attached.validForMs) - performance.now()),
					signal,
				),
			);
			folder.onMount?.({
				workerId: claim.workerId,
				machineId: machine.machineId,
				viewId,
				...(replaced && { replaced }),
			});
			return;
		}
		try {
			await this.#refreshGuestLease(attachment, started + Number(attached.validForMs), signal);
		} catch (error) {
			// The generation SQL kept ran out in the guest while the attach was on its
			// way: it can never be renewed. Attach once more under a new one.
			if (fresh || generation !== digest(attachment.token)) throw error;
			const now = (await this.#observe(machine, signal, false)).sessions.get(claim.workerId)?.lease;
			if (now?.tokenSha256 !== generation || now.expiresInMs > 0) throw error;
			await this.#attachSessionNow(claim, machine, storage, guest, scope, signal, true);
		}
	}
	/** A turn as SQL names it in an attachment: its sequence, its turn id and whether it may start commands. */
	#attachedTurn(value: unknown): Attachment["turn"] {
		const turn = record(value);
		if (
			!Number.isSafeInteger(turn.sequence) ||
			Number(turn.sequence) < 1 ||
			typeof turn.turnId !== "string" ||
			!UUID.test(turn.turnId) ||
			typeof turn.open !== "boolean"
		)
			throw new Error("CODING_HOST_ATTACHMENT_UNCONFIRMED");
		return { sequence: Number(turn.sequence), turnId: turn.turnId, open: turn.open };
	}
	/** One guest lease step at a time per session: the turn that attaches it and
	 * the keeper never race each other in SQL's attachment or in the guest. */
	#leaseTask<T>(workerId: string, use: () => Promise<T>): Promise<T> {
		const work = (this.#leaseWork.get(workerId) ?? Promise.resolve()).catch(() => undefined).then(use);
		this.#leaseWork.set(workerId, work);
		void work
			.catch(() => undefined)
			.finally(() => {
				if (this.#leaseWork.get(workerId) === work) this.#leaseWork.delete(workerId);
			});
		return work;
	}
	/** Renews the session's guest lease under its attachment, never beyond the
	 * attachment's SQL deadline (`validUntil`, performance clock), with its
	 * current turn open or closed. The watchdog stops the session's commands
	 * when renewals stop. */
	async #refreshGuestLease(attachment: Attachment, validUntil: number, signal: AbortSignal): Promise<void> {
		const machine = attachment.machine,
			leaseHash = digest(attachment.token);
		const watchdog = await this.#options.client.readInstanceFile(
			machine.project,
			lxdCodingMachineName(machine.machineId),
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
		const scope = codingTurnScope(attachment.workerId, machine.machineId, attachment.turn.sequence);
		if (scope.requestId !== attachment.turn.turnId) throw new Error("CODING_HOST_TURN_ID_DIFFERS");
		const transport = new LxdCodingLeaseTransport({
			machine,
			storage: this.#placement,
			scope,
			open: attachment.turn.open,
			bootId: attachment.bootId,
			guestConfigSha256: attachment.guestConfigSha256,
			helperSha256: this.#options.guest.commandHelperSha256,
			client: this.#options.client,
			authorize: async (checked, hash, ttl) => {
				if (
					!isDeepStrictEqual(checked, scope) ||
					hash !== leaseHash ||
					ttl > validUntil - performance.now() ||
					this.#attachments.get(attachment.workerId)?.token !== attachment.token
				)
					throw new Error("CODING_HOST_LEASE_REFRESH_EXPIRED");
			},
		});
		const ttl = Math.min(45000, Math.floor(validUntil - performance.now()) - 5000);
		if (ttl < 1000) throw new Error("CODING_HOST_LEASE_REFRESH_EXPIRED");
		await transport.refresh(scope, leaseHash, ttl, signal);
	}
	async publish(
		claim: CodingSessionClaim,
		submission: Extract<CodingSubmission, { kind: "finish" }>,
		signal: AbortSignal,
	): Promise<CodingExecutorPublication> {
		const ready = this.#active(claim);
		const root = await this.#directory("git"),
			token = this.#repositoryToken(claim);
		const folder = this.#options.folder;
		// Only the folder model keeps repositories in Qorpera (its base came from the code host): never a push to GitHub.
		if (claim.repository.host === "qorpera" && !(folder && ready.folder))
			throw new Error("CODING_REPOSITORY_NOT_HERE");
		let bundle: Buffer;
		if (folder && ready.folder) {
			// What the machine's views have pending is saved first: the export reads the session's work from the folder, so
			// a path any view left unsaved holds the publication. The error's reason says why, without a path.
			const { machine, storage } = ready;
			const starts = this.#folderStarts.get(machine.machineId) ?? 0;
			let boundary = await folder.control.boundary(machine.machineId, [], signal);
			// A save check the boundary did not wait for to end (a large git pack's, 5j-5 a) goes on in the service: the
			// publication asks again until each has saved its path or refused it.
			while (codingFolderBoundaryChecking(boundary)) {
				await setTimeout(CODING_FOLDER_CHECK_RETRY_MS, undefined, { signal });
				boundary = await folder.control.boundary(machine.machineId, [], signal);
			}
			const held = codingFolderBoundaryHeld(boundary),
				unreadable = codingFolderBoundaryUnreadable(boundary);
			if (held === "READS_UNPROVEN" || unreadable)
				// What the machine read can't be proven released (rule 4): it restarts before a view opens on it again,
				// unless it started since this boundary was asked. One that holds a read no longer readable gets a new disk
				// (rule 4, `unreadable`), and is marked for it even if it started since: that start may not have given it one. The
				// session attaches anew at its next turn.
				await this.#exclusive(machine.machineId, signal, async () => {
					if ((this.#folderStarts.get(machine.machineId) ?? 0) !== starts) {
						if (unreadable) await this.#markForFolder(machine, true, signal);
						return;
					}
					const journal = lxdCodingMachineJournalPlan(machine, this.#placement);
					await this.#run(claim, machine, storage, signal);
					await this.#stopForFolder(folder, machine, journal, signal, unreadable);
					await this.#runFolder(folder, claim, machine, storage, journal, signal);
				});
			// Paths the folder's save check refused (5j-5 a), because they carry a secret value or it could not finish
			// checking them, stay refused until the session changes them (or, for a check the node was too busy for, until
			// the next boundary), so its turn fails with what to do and the session stays attached. Any other refusal holds
			// the publication as before.
			const refusal = codingFolderSaveRefused(boundary);
			if (refusal) throw new CodingSaveRefused(refusal === "unchecked");
			if (held !== undefined) throw new Error(`CODING_FOLDER_BOUNDARY_HELD:${held}`);
			this.#current(ready);
			// A repository kept in Qorpera (own code storage, slice 1): the commit lands on its default branch in the
			// company folder. Nothing is pushed, no token is asked for, and there is no pull request. What the session
			// saved was checked for its secret values by the folder's save check above.
			if (claim.repository.host === "qorpera") {
				const repositories = folder.repositories;
				if (!repositories?.land) throw new Error("CODING_REPOSITORY_NOT_HERE");
				if (submission.headSha === ready.baseSha) return { pullRequest: null, noChange: true };
				const landed = await repositories.land(
					this.#repositorySession(claim, ready.machine, ready.storage, ready.folder.uid, ready.baseSha, root),
					submission.headSha,
					signal,
				);
				return { pullRequest: null, noChange: false, landed };
			}
			const exported = await (folder.repositories ?? codingFolderNoRepositories).export(
				this.#repositorySession(claim, ready.machine, ready.storage, ready.folder.uid, ready.baseSha, root),
				submission.headSha,
				signal,
			);
			if (exported === null || (submission.headSha === ready.baseSha && !claim.pullRequest)) {
				if (!claim.pullRequest) return { pullRequest: null, noChange: true };
				// The open pull request's branch is the session's: nothing to push to it is no publication.
				throw new Error("CODING_FOLDER_EXPORT_EMPTY");
			}
			bundle = exported;
		} else {
			const exported = await this.#transfer(ready).export(
				codingHostId("export", `${claim.workerId}:${claim.sequence}`),
				submission.headSha,
				signal,
			);
			if (submission.headSha === ready.baseSha && !claim.pullRequest) return { pullRequest: null, noChange: true };
			bundle = exported.bundle;
		}
		const authorize = async (): Promise<void> => {
			await this.#run(claim, ready.machine, ready.storage, signal);
		};
		// The session's secret values, those its commands were given and its environment now (5j-5 b): a push or a pull
		// request that carries one goes nowhere. No broker, no values to check.
		const secrets = await this.#commandSecrets?.publication(
			ready.machine.machineId,
			{ companyId: claim.profileId, workerId: claim.workerId, leaseToken: claim.leaseToken },
			signal,
		);
		const title = claim.title.slice(0, 200);
		if (
			secrets &&
			[title, submission.summary].some((text) => {
				const stream = secrets.stream();
				stream.push(Buffer.from(text));
				stream.end();
				return stream.matched;
			})
		)
			throw new CodingPushRefused({ kind: "pull-request" });
		await pushCloudCodingBundle(
			{
				repository: claim.repository,
				workerId: claim.workerId,
				headSha: submission.headSha,
				baseSha: ready.baseSha,
				expectedRemoteHeadSha: claim.pullRequest?.headSha ?? null,
			},
			bundle,
			{
				journalRoot: root,
				signal,
				assertAuthorized: authorize,
				withRepositoryToken: token,
				runGit: this.#options.runGit,
				...(secrets ? { secrets } : {}),
			},
		);
		const pullRequest = await publishCloudCodingDraftPullRequest(
			{
				repository: claim.repository,
				workerId: claim.workerId,
				headSha: submission.headSha,
				title,
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
	/** The end of a turn, whatever its outcome: nothing more starts, publishes
	 * or seeds for it. Its session stays attached, with whatever its commands
	 * left running; the keeper closes the turn in the guest lease at its next
	 * pass, and SQL refuses the turn's commands from now on. */
	endTurn(claim: CodingSessionClaim): void {
		if (this.#prepared.get(claim.workerId)?.claim.leaseToken === claim.leaseToken)
			this.#prepared.delete(claim.workerId);
		const attachment = this.#attachments.get(claim.workerId);
		if (attachment?.turn.sequence === claim.sequence && attachment.turn.open)
			this.#attachments.set(claim.workerId, { ...attachment, turn: { ...attachment.turn, open: false } });
	}
	/** A turn that failed, or must wait for its machine, after hot-plugging its
	 * session but before recording its attachment: unplug it again. A session
	 * already attached (this turn's or an earlier one's) is the keeper's. Works
	 * with or without the lease. */
	async detachSession(claim: CodingSessionClaim, signal: AbortSignal): Promise<void> {
		const attached = this.#attached.get(claim.workerId);
		if (!attached || attached.claim.leaseToken !== claim.leaseToken) return;
		// No new command, lease refresh or publication for this turn from here on.
		if (this.#prepared.get(claim.workerId)?.claim.leaseToken === claim.leaseToken)
			this.#prepared.delete(claim.workerId);
		try {
			await this.#takeOff(
				attached.machine,
				attached.storage,
				{ workerId: claim.workerId, leaseToken: claim.leaseToken },
				[],
				signal,
			);
		} finally {
			if (this.#attached.get(claim.workerId) === attached) this.#attached.delete(claim.workerId);
		}
	}
	/** Takes a session off its member's machine under detach custody: its named
	 * running commands are cancelled first (so a later read says cancelled),
	 * then the guest stops its slice, flushes, and removes its boot-local state
	 * and user, and its NAS folders are unplugged. The folders themselves stay.
	 * On the folder model, its view ends in between (below). Once it is off,
	 * the vault environments asked for its commands go (5j-4). */
	async #takeOff(
		machine: Readonly<LxdCodingMachineBinding>,
		storage: Readonly<CloudCodingStorageBinding>,
		session: { workerId: string; leaseToken: string | null },
		running: readonly string[],
		signal: AbortSignal,
	): Promise<void> {
		const journal = lxdCodingMachineJournalPlan(machine, this.#placement),
			text = lxdCodingMachinePlan(machine).text,
			name = lxdCodingMachineName(machine.machineId),
			client = this.#options.client;
		const folder = this.#options.folder;
		await this.#exclusive(machine.machineId, signal, async () => {
			await this.#custody(journal, text, "detach", signal, session);
			const instance = await client.getInstance(machine.project, name, signal);
			if (folder) {
				// Nothing is plugged on the folder model. The session's commands are cancelled, and then nothing of it
				// runs any more (its commands, its user manager) while its view stays mounted; a session the guest can't
				// confirm so keeps its view, and the take-off fails. Its view ends (its final boundary saves what it has
				// pending, then it closes), and the guest agent stops the session and unmounts it. A machine that is not
				// running has nothing of it left to stop, only its view to end.
				if (instance) assertLxdCodingMachineInstance(machine, this.#placement, instance);
				const awake = instance?.status === "Running" && instance.statusCode === 103;
				const guest = new LxdCodingGuestClient({ machine, client: folder.client });
				const request = { schema: "qorpera.coding-guest-session/v1", workerId: session.workerId } as const;
				if (awake) {
					await this.#cancelCommands(machine, session.workerId, running, signal);
					await this.#custody(journal, text, "detach", signal, session);
					await guest.quiesce(request, signal);
				}
				const end = await folder.views.end(session.workerId, signal);
				let guestFailure: unknown;
				if (awake)
					try {
						await this.#custody(journal, text, "detach", signal, session);
						await guest.stopSession(request, signal);
					} catch (error) {
						guestFailure = error;
					}
				if (end && !end.saved) throw new Error("CODING_FOLDER_VIEW_UNSAVED");
				if (end && !end.closed) throw new Error("CODING_FOLDER_VIEW_CLOSE_UNCONFIRMED");
				if (guestFailure) throw guestFailure;
				return;
			}
			if (!instance) return;
			const sessions = assertLxdCodingMachineInstance(machine, this.#placement, instance);
			let guestFailure: unknown;
			if (instance.status === "Running" && instance.statusCode === 103) {
				await this.#cancelCommands(machine, session.workerId, running, signal);
				try {
					await client.execInstance(
						machine.project,
						name,
						["/usr/bin/node", "/opt/qorpera-coding/cloud-coding-storage-guest.mjs", "detach", session.workerId],
						signal,
					);
				} catch (error) {
					// The folders are unplugged all the same; the watchdog stops a slice
					// whose lease is gone. The failure is still the caller's to report.
					guestFailure = error;
				}
			}
			if (sessions.includes(session.workerId)) {
				const devices = Object.fromEntries(
					Object.entries(instance.devices).filter(
						([deviceName]) => !Object.hasOwn(lxdCodingSessionDevices(storage), deviceName),
					),
				);
				await this.#custody(journal, text, "detach", signal, session);
				try {
					await client.replaceInstanceDevices(machine.project, name, devices, signal);
				} catch {
					/* Judged below from the machine. */
				}
				const after = await client.getInstance(machine.project, name, signal);
				if (after && assertLxdCodingMachineInstance(machine, this.#placement, after).includes(session.workerId))
					throw new Error("CODING_SESSION_DETACH_UNCONFIRMED");
			}
			if (guestFailure) throw guestFailure;
		});
		this.#commandSecrets?.release(machine.machineId, session.workerId);
	}
	/** Best effort, bounded: cancels each named command through the pinned
	 * command helper, which records it cancelled once systemd has stopped it. A
	 * command it cannot cancel is stopped with its slice right after. */
	async #cancelCommands(
		machine: Readonly<LxdCodingMachineBinding>,
		workerId: string,
		commandIds: readonly string[],
		signal: AbortSignal,
	): Promise<void> {
		const quiet = AbortSignal.any([signal, AbortSignal.timeout(CODING_SESSION_QUIESCE_MS)]);
		const folder = this.#options.folder;
		// On the folder model the guest agent cancels it and records it so.
		const guest = folder && new LxdCodingGuestClient({ machine, client: folder.client });
		for (const commandId of commandIds) {
			if (quiet.aborted) break;
			try {
				if (guest) await guest.cancel({ schema: "qorpera.coding-guest-cancel/v1", workerId, commandId }, quiet);
				else
					await this.#options.client.execInstance(
						machine.project,
						lxdCodingMachineName(machine.machineId),
						[
							"/usr/bin/node",
							"/opt/qorpera-coding/cloud-coding-command-guest.mjs",
							"cancel",
							workerId,
							commandId,
						],
						quiet,
					);
			} catch {
				/* The slice stop that follows ends it. */
			}
		}
	}
	/** The detach is recorded against the attachment's generation, with what it stopped. */
	async #recordDetached(
		machine: Readonly<LxdCodingMachineBinding>,
		workerId: string,
		token: string,
		reason: string,
		stopped: readonly ObservedCommand[],
		signal: AbortSignal,
	): Promise<void> {
		const value = record(
			await this.#call(
				"qorpera_record_coding_session_detached",
				{
					p_machine_id: machine.machineId,
					p_owner: this.#options.owner,
					p_binding_text: lxdCodingMachinePlan(machine).text,
					p_machine_id_sha256: this.#options.machineIdSha256,
					p_worker_id: workerId,
					p_attachment_token: token,
					p_reason: reason,
					p_stopped: stopped,
				},
				signal,
			),
		);
		if (
			value.schema !== "qorpera.coding-detached/v1" ||
			value.workerId !== workerId ||
			(value.state !== "detached" && value.state !== "unchanged")
		)
			throw new Error("CODING_HOST_DETACH_RECORD_UNCONFIRMED");
		if (this.#attachments.get(workerId)?.token === token) {
			this.#attachments.delete(workerId);
			this.#attachSerials.delete(workerId);
		}
		this.#samples.delete(workerId);
	}
	/** A member's machine LXD shows stopped after its settled start (the
	 * reconcile has just written that stop down) lost every session's boot: each
	 * attachment on it ends in SQL with the commands last seen running there,
	 * stopped for MACHINE_STOPPED, and its next boot installs the helpers again.
	 * SQL keeps each stop once, by the start it ended: a retry, or an abandoned
	 * try's request that reaches SQL only after the machine started again and
	 * sessions attached anew, gets the first record's answer and ends nothing. */
	async #recordMachineStopped(
		machine: Readonly<LxdCodingMachineBinding>,
		startOperationId: string,
		signal: AbortSignal,
	): Promise<void> {
		const value = record(
			await this.#call(
				"qorpera_record_coding_machine_stopped",
				{
					p_machine_id: machine.machineId,
					p_start_operation_id: startOperationId,
					p_owner: this.#options.owner,
					p_binding_text: lxdCodingMachinePlan(machine).text,
					p_machine_id_sha256: this.#options.machineIdSha256,
				},
				signal,
			),
		);
		const ended = detachedSessions(value.detached);
		if (value.schema !== "qorpera.coding-machine-stopped/v1" || value.machineId !== machine.machineId || !ended)
			throw new Error("CODING_HOST_MACHINE_STOPPED_UNCONFIRMED");
		this.#forgetDetached(ended);
		this.#helperBoots.delete(machine.machineId);
	}
	/** SQL marks the machine to restart for the company folder (rule 4), or with `newDisk` for a new disk (rule 4,
	 * `unreadable`), which marks it to restart too. From then on no coding view opens on it. A mark already there stays. */
	async #markForFolder(
		machine: Readonly<LxdCodingMachineBinding>,
		newDisk: boolean,
		signal: AbortSignal,
	): Promise<void> {
		const value = record(
			await this.#call(
				newDisk ? "qorpera_mark_coding_machine_new_disk" : "qorpera_mark_coding_machine_folder_restart",
				{
					p_machine_id: machine.machineId,
					p_owner: this.#options.owner,
					p_binding_text: lxdCodingMachinePlan(machine).text,
					p_machine_id_sha256: this.#options.machineIdSha256,
				},
				signal,
			),
		);
		if (
			value.schema !== "qorpera.coding-machine-folder-restart/v1" ||
			value.machineId !== machine.machineId ||
			value.state !== "marked"
		)
			throw new Error("CODING_HOST_FOLDER_RESTART_UNCONFIRMED");
	}
	/** Whether SQL holds the machine marked for a new disk (rule 4, `unreadable`): a boundary said so, or a turn's take-in
	 * found a read on it that turn can no longer place (20260930505000), which a view held since an earlier turn hears of
	 * only at its next renewal. Asked as rebuild custody, which SQL grants for exactly such a machine and which changes
	 * nothing: one not so marked is refused it (MACHINE_IN_USE under a leased turn, MACHINE_NO_NEW_DISK otherwise). */
	async #newDiskDue(machine: Readonly<LxdCodingMachineBinding>, signal: AbortSignal): Promise<boolean> {
		try {
			await this.#custody(
				lxdCodingMachineJournalPlan(machine, this.#placement),
				lxdCodingMachinePlan(machine).text,
				"rebuild",
				signal,
			);
			return true;
		} catch (error) {
			if (
				error instanceof CodingCustodyRefused &&
				(error.reason === "MACHINE_IN_USE" || error.reason === "MACHINE_NO_NEW_DISK")
			)
				return false;
			throw error;
		}
	}
	/** A stopped machine is about to start: if SQL marked it to restart for the company folder (the folder model's rule
	 * 4), the restart is recorded, each attachment on it ending as FOLDER_RESTART (not an outside stop: its sessions
	 * attach again on the new boot) and the mark cleared, so views open on it again. An unmarked machine changes
	 * nothing. One marked for a new disk (rule 4, `unreadable`) answers true: each attachment on it ends as
	 * MACHINE_NEW_DISK and both marks stay, and the machine is rebuilt before it starts (#recordNewDisk clears them).
	 * `afterOperationId` names the start (the LXD operation of the effect it follows): SQL answers a second record of the
	 * same start, however late, what it answered the first and changes nothing. */
	async #recordFolderRestart(
		machine: Readonly<LxdCodingMachineBinding>,
		afterOperationId: string,
		signal: AbortSignal,
	): Promise<boolean> {
		const value = record(
			await this.#call(
				"qorpera_record_coding_machine_folder_restart",
				{
					p_machine_id: machine.machineId,
					p_operation_id: afterOperationId,
					p_owner: this.#options.owner,
					p_binding_text: lxdCodingMachinePlan(machine).text,
					p_machine_id_sha256: this.#options.machineIdSha256,
				},
				signal,
			),
		);
		const ended = detachedSessions(value.detached);
		if (
			value.schema !== "qorpera.coding-machine-folder-restart/v1" ||
			value.machineId !== machine.machineId ||
			(value.state !== "restarted" && value.state !== "unmarked" && value.state !== "new-disk") ||
			!ended
		)
			throw new Error("CODING_HOST_FOLDER_RESTART_UNCONFIRMED");
		this.#forgetDetached(ended);
		return value.state === "new-disk";
	}
	/** The machine marked for a new disk was rebuilt from its image and is about to start: SQL records the new disk,
	 * named by the rebuild's LXD operation. Its read set goes (the disk that held those reads is gone), each attachment
	 * still on it ends as MACHINE_NEW_DISK, and both marks are cleared, so views open on it again. A second record of the
	 * same rebuild answers what the first did. Then the error a rebuild whose image was gone left is cleared. */
	async #recordNewDisk(
		machine: Readonly<LxdCodingMachineBinding>,
		rebuildOperationId: string,
		signal: AbortSignal,
	): Promise<void> {
		const value = record(
			await this.#call(
				"qorpera_record_coding_machine_new_disk",
				{
					p_machine_id: machine.machineId,
					p_operation_id: rebuildOperationId,
					p_owner: this.#options.owner,
					p_binding_text: lxdCodingMachinePlan(machine).text,
					p_machine_id_sha256: this.#options.machineIdSha256,
				},
				signal,
			),
		);
		const ended = detachedSessions(value.detached);
		if (
			value.schema !== "qorpera.coding-machine-folder-restart/v1" ||
			value.machineId !== machine.machineId ||
			value.state !== "replaced" ||
			!ended
		)
			throw new Error("CODING_HOST_NEW_DISK_UNCONFIRMED");
		this.#forgetDetached(ended);
		this.#helperBoots.delete(machine.machineId);
		this.#settledBoots.delete(machine.machineId);
		await this.#recordError(machine.machineId, "wake", null, signal).catch(() => undefined);
	}
	/** The sessions SQL detached are no longer attached here. */
	#forgetDetached(ended: readonly { workerId: string; attachmentToken: string }[]): void {
		for (const { workerId, attachmentToken } of ended) {
			if (this.#attachments.get(workerId)?.token === attachmentToken) {
				this.#attachments.delete(workerId);
				this.#attachSerials.delete(workerId);
			}
			this.#samples.delete(workerId);
		}
	}
	/** A stopped member machine's session folders unplugged under `authorize`:
	 * the base devices, with the machine's own agent card (its plug MAC is not in
	 * the plan). An uncertain update is judged from the machine. */
	async #unplugStopped(
		machine: Readonly<LxdCodingMachineBinding>,
		authorize: (signal: AbortSignal) => Promise<unknown>,
		unconfirmed: string,
		signal: AbortSignal,
	): Promise<void> {
		const client = this.#options.client,
			name = lxdCodingMachineName(machine.machineId);
		const stopped = await client.getInstance(machine.project, name, signal);
		if (!stopped || !assertLxdCodingMachineInstance(machine, this.#placement, stopped).length) return;
		await authorize(signal);
		const base = { ...lxdCodingMachinePlan(machine).request.devices, network: stopped.devices.network };
		try {
			await client.replaceInstanceDevices(machine.project, name, base, signal);
		} catch {
			/* Judged below from the machine. */
		}
		const after = await client.getInstance(machine.project, name, signal);
		if (after && assertLxdCodingMachineInstance(machine, this.#placement, after).length) throw new Error(unconfirmed);
	}

	/** One keeper pass: first the host lease of every member machine SQL reserves
	 * on this node, then this executor's awake machines that carry attached
	 * sessions: observe what runs inside, renew each session's attachment in SQL
	 * with that observation, and renew its guest lease under the renewed deadline.
	 * The machines are kept side by side, each within its own deadline, and the
	 * sessions SQL releases (archived, revoked, expired) are taken off beside the
	 * passes: a slow or stuck machine or take-off never holds up another's
	 * renewals. Every failure is returned, never hidden; a take-off's outcome
	 * with the next pass. */
	keep(signal: AbortSignal): Promise<CodingKeepOutcome[]> {
		return withAbortScope(signal, (scoped) => this.#keep(scoped, signal));
	}
	/** `lasting` outlasts this pass: a take-off started here goes on under it. */
	async #keep(signal: AbortSignal, lasting: AbortSignal): Promise<CodingKeepOutcome[]> {
		const pass = performance.now();
		const listed = await this.#call(
			"qorpera_list_coding_machines",
			{ p_owner: this.#options.owner, p_machine_id_sha256: this.#options.machineIdSha256 },
			signal,
		);
		if (!Array.isArray(listed)) throw new Error("CODING_HOST_MACHINE_LIST_INVALID");
		const reserved = listed
			.map((value) => this.#listed(value))
			.filter((entry) => entry.kind === "member" && entry.reserved && entry.instanceSha256);
		// Every member machine SQL still reserves on this node may run another 90 seconds, attached or not: the
		// host watchdog stops the rest. A lease that cannot be written is that machine's failure.
		const unplanned: CodingKeepOutcome[] = [],
			holders: CodingMachineJournalPlan[] = [];
		for (const entry of reserved)
			try {
				holders.push(this.#journal(entry).journal);
			} catch (error) {
				unplanned.push({
					machineId: entry.machineId,
					workerId: null,
					step: "keep",
					state: "failed",
					code: errorCodeOf(error),
				});
			}
		const held = (await this.#hostLeases.hold(holders)).map(
			({ machineId, error }): CodingKeepOutcome => ({
				machineId,
				workerId: null,
				step: "keep",
				state: "failed",
				code: errorCodeOf(error),
			}),
		);
		// A machine with no plan would fail its sessions' keep the same way: it is reported once.
		const entries = reserved.filter(
			(entry) => entry.attached.length && !unplanned.some(({ machineId }) => machineId === entry.machineId),
		);
		const kept = new Set(entries.flatMap((entry) => entry.attached.map(({ workerId }) => workerId)));
		const outcomes = (
			await Promise.all(
				entries.map((entry) => {
					const deadline = AbortSignal.any([
						signal,
						AbortSignal.timeout(this.#options.keepDeadlineMs ?? CODING_KEEP_MACHINE_MS),
					]);
					// The pass stops waiting at the deadline even for a call that does not.
					return abortable(this.#keepMachine(entry, deadline, lasting), deadline).catch(
						(error): CodingKeepOutcome[] => {
							signal.throwIfAborted();
							return [
								{
									machineId: entry.machineId,
									workerId: null,
									step: "keep",
									state: "failed",
									code: deadline.aborted ? "CODING_HOST_KEEP_DEADLINE" : errorCodeOf(error),
								},
							];
						},
					);
				}),
			)
		).flat();
		// Forget what no machine carries any more, unless a turn took it on during this pass.
		for (const [workerId, attachment] of this.#attachments)
			if (!kept.has(workerId) && attachment.since < pass) {
				this.#attachments.delete(workerId);
				this.#attachSerials.delete(workerId);
				this.#samples.delete(workerId);
			}
		const released = this.#released;
		this.#released = [];
		return [...released, ...unplanned, ...held, ...outcomes];
	}
	/** Waits for every take-off the keeper started, and returns the outcomes no
	 * pass has reported yet. */
	async settled(): Promise<CodingKeepOutcome[]> {
		await Promise.allSettled([...this.#releasing.values()]);
		const released = this.#released;
		this.#released = [];
		return released;
	}
	/** One machine's keeper step, within `deadline`. It runs beside the machine's
	 * turns and lifecycle steps. A session a turn attached during the step is that
	 * turn's to renew, and SQL keeps a session attached in the last 30 seconds that
	 * the observation may predate. Released sessions are handed to #release. */
	async #keepMachine(entry: ListedMachine, deadline: AbortSignal, signal: AbortSignal): Promise<CodingKeepOutcome[]> {
		const machine = lxdCodingMachinePlan(entry.binding as unknown as LxdCodingMachineBinding).binding;
		if (machine.machineId !== entry.machineId) throw new Error("CODING_HOST_MACHINE_LIST_INVALID");
		const attaches = new Map(entry.attached.map(({ workerId }) => [workerId, this.#attachSerials.get(workerId)]));
		const generations = new Map(
			entry.attached.map(({ workerId, attachmentToken }) => [workerId, digest(attachmentToken)]),
		);
		const folder = this.#options.folder;
		// The folder service holds the machine's secret values in memory only (5j-5 (a)): given again each pass, one that
		// restarted has them back within a pass. Beside the renewals, which a failure here never holds up; it never rejects.
		// A service from before the check is reported each pass: until it is replaced, no save is checked.
		const secrets = folder?.control.secrets(machine.machineId, deadline).then(
			(held): CodingKeepOutcome[] =>
				held === "unsupported"
					? [
							{
								machineId: machine.machineId,
								workerId: null,
								step: "secrets",
								state: "not-now",
								code: "CODING_FOLDER_SECRETS_UNSUPPORTED",
							},
						]
					: [],
			(error: unknown): CodingKeepOutcome[] => {
				if (signal.aborted) return [];
				const code = deadline.aborted ? "CODING_HOST_KEEP_DEADLINE" : errorCodeOf(error);
				return [{ machineId: machine.machineId, workerId: null, step: "secrets", state: "failed", code }];
			},
		);
		const observed = folder
			? await this.#observeFolder(
					folder,
					machine,
					entry.attached.map(({ workerId }) => workerId),
					deadline,
				)
			: await this.#observe(machine, deadline);
		// A guest lease of the listed generation that ran out can never be renewed,
		// and the watchdog has stopped the session's commands. Left out of the
		// observation, the session is released (EXPIRED) with the commands SQL last
		// saw running: its next turn, or its turn still running here, attaches it
		// under a new generation.
		const lost = new Set<string>();
		const sessions: { workerId: string; busy: boolean; running: ObservedCommand[] }[] = [];
		for (const [workerId, seen] of observed.sessions) {
			if (seen.lease?.expiresInMs === 0 && seen.lease.tokenSha256 === generations.get(workerId)) {
				lost.add(workerId);
				continue;
			}
			const sample = this.#samples.get(workerId);
			const now = {
				bootId: observed.bootId,
				cpuSeconds: seen.cpuUsageUsec / 1e6,
				ioBytes: seen.ioBytes,
				at: seen.uptimeMs,
			};
			// Busy by the one idle rule since the last look of this boot (`@qorpera/contracts` idle-rule): at least 5% of
			// one core, or 512 KiB read or written in 30 seconds. A server that only waits does neither. A look that read
			// only some of the machine's processes is busy: bytes it could not see never let the machine sleep.
			const busy =
				!seen.ioComplete ||
				(sample !== undefined && sample.bootId === observed.bootId && idleRuleBusy(sample, now));
			this.#samples.set(workerId, now);
			sessions.push({ workerId, busy, running: seen.running });
		}
		const started = performance.now();
		const kept = record(
			await this.#call(
				"qorpera_keep_coding_attachments",
				{
					p_machine_id: machine.machineId,
					p_owner: this.#options.owner,
					p_binding_text: lxdCodingMachinePlan(machine).text,
					p_machine_id_sha256: this.#options.machineIdSha256,
					p_observation: {
						schema: "qorpera.coding-machine-observation/v1",
						busy: sessions.some((session) => session.busy),
						sessions,
					},
				},
				deadline,
			),
		);
		if (
			kept.schema !== "qorpera.coding-attachments/v1" ||
			kept.machineId !== machine.machineId ||
			!Array.isArray(kept.sessions)
		)
			throw new Error("CODING_HOST_ATTACHMENTS_INVALID");
		const items = kept.sessions.map((value) => {
			const item = record(value);
			const workerId = typeof item.workerId === "string" && UUID.test(item.workerId) ? item.workerId : null;
			if (!workerId || typeof item.attachmentToken !== "string" || !UUID.test(item.attachmentToken))
				throw new Error("CODING_HOST_ATTACHMENTS_INVALID");
			return { workerId, item };
		});
		const renewals: Promise<CodingKeepOutcome>[] = [];
		for (const { workerId, item } of items) {
			const outcome = (state: CodingKeepOutcome["state"], code?: string): CodingKeepOutcome => ({
				machineId: machine.machineId,
				workerId,
				step: "keep",
				state,
				...(code ? { code } : {}),
			});
			if (item.state === "kept") {
				if (lost.has(workerId) && generations.get(workerId) === digest(String(item.attachmentToken))) {
					// Attached too recently for SQL to judge it by this observation: released at a later pass.
					renewals.push(Promise.resolve(outcome("not-now", "GUEST_LEASE_EXPIRED")));
					continue;
				}
				// Each session's renewal on its own, one guest lease step at a time per session.
				renewals.push(
					abortable(
						this.#leaseTask(workerId, async () => {
							deadline.throwIfAborted();
							if (this.#attachSerials.get(workerId) !== attaches.get(workerId)) return false;
							const attachment = await this.#attachmentOn(machine, workerId, item, observed.bootId, deadline);
							// On the folder model the renewed attachment is all: its view is the folder service's to renew.
							if (!folder)
								await this.#refreshGuestLease(attachment, started + Number(item.validForMs), deadline);
							return true;
						}),
						deadline,
					).then(
						(renewed) => (renewed ? outcome("done") : outcome("not-now", "TURN_ATTACHED")),
						(error: unknown) => {
							signal.throwIfAborted();
							return outcome("failed", deadline.aborted ? "CODING_HOST_KEEP_DEADLINE" : errorCodeOf(error));
						},
					),
				);
			} else if (item.state === "release" && typeof item.reason === "string" && /^[A-Z_]{1,64}$/.test(item.reason))
				this.#release(
					machine,
					workerId,
					String(item.attachmentToken),
					item.reason,
					observed.sessions.get(workerId)?.running ?? [],
					signal,
				);
			else throw new Error("CODING_HOST_ATTACHMENTS_INVALID");
		}
		return [...(await Promise.all(renewals)), ...((await secrets) ?? [])];
	}
	/** Takes a released session off, beside the keeper's passes, and records it
	 * detached with what it stopped. A session whose turn this process still runs
	 * and whose guest lease ran out (renewals did not reach it in time) is instead
	 * attached again under the turn's own authority, as a new generation, so the
	 * turn goes on; what the old one ran is recorded stopped. At most one per
	 * session at a time; the outcome is reported by the next pass. */
	#release(
		machine: Readonly<LxdCodingMachineBinding>,
		workerId: string,
		token: string,
		reason: string,
		running: readonly ObservedCommand[],
		signal: AbortSignal,
	): void {
		if (this.#releasing.has(workerId)) return;
		const prepared = this.#prepared.get(workerId);
		const again = reason === "EXPIRED" && prepared?.machine.machineId === machine.machineId ? prepared : undefined;
		const step: CodingKeepOutcome["step"] = again ? "keep" : "detach";
		const report = (state: CodingKeepOutcome["state"], code: string) =>
			this.#released.push({ machineId: machine.machineId, workerId, step, state, code });
		// Under a scope of its own: `signal` lasts as long as the process (abort-scope.ts).
		const work = withAbortScope(signal, async (scoped) => {
			if (again) {
				// Only while that turn is still prepared here: an ended turn's lease is never opened again.
				const attached = await this.#leaseTask(workerId, async () => {
					if (this.#prepared.get(workerId) !== again) return false;
					await this.#attachSessionNow(again.claim, again.machine, again.storage, again, again.scope, scoped);
					return true;
				});
				if (attached) report("done", "REATTACHED");
				return;
			}
			await this.#takeOff(
				machine,
				lxdCodingSessionStorage(machine, this.#placement, workerId),
				{ workerId, leaseToken: null },
				running.map((command) => command.commandId),
				scoped,
			);
			await this.#recordDetached(machine, workerId, token, reason, running, scoped);
			report("done", reason);
		})
			.catch((error: unknown) => {
				if (signal.aborted) return;
				if (error instanceof CodingCustodyRefused) report("not-now", error.reason);
				else report("failed", errorCodeOf(error));
			})
			.finally(() => {
				if (this.#releasing.get(workerId) === work) this.#releasing.delete(workerId);
			});
		this.#releasing.set(workerId, work);
	}
	/** The attachment as SQL renewed it, on this machine and boot. SQL moves the
	 * turn only through an attach, and a turn this process has closed stays
	 * closed. One this process has not taken on yet (it restarted, or the machine
	 * rebooted under a turn) is adopted from the guest's active configuration,
	 * which must be the one this executor journaled for that boot. */
	async #attachmentOn(
		machine: Readonly<LxdCodingMachineBinding>,
		workerId: string,
		item: Record<string, unknown>,
		bootId: string,
		signal: AbortSignal,
	): Promise<Attachment> {
		const turn = this.#attachedTurn(item.turn),
			token = String(item.attachmentToken);
		if (!Number.isSafeInteger(item.validForMs) || Number(item.validForMs) < 1)
			throw new Error("CODING_HOST_ATTACHMENTS_INVALID");
		const known = this.#attachments.get(workerId);
		if (known && known.machine.machineId === machine.machineId && known.bootId === bootId) {
			const next =
				known.token === token && known.turn.sequence === turn.sequence
					? { ...known, turn: { ...turn, open: turn.open && known.turn.open } }
					: { ...known, token, turn };
			this.#attachments.set(workerId, next);
			return next;
		}
		const adopted: Attachment = {
			workerId,
			machine,
			storage: lxdCodingSessionStorage(machine, this.#placement, workerId),
			bootId,
			// On the folder model the guest holds no configuration of the session's: its view is under the attachment.
			guestConfigSha256: this.#options.folder
				? this.#folderSessionSha(workerId, machine.machineId, bootId)
				: await this.#installedConfiguration(machine, workerId, bootId, signal),
			token,
			turn,
			since: performance.now(),
		};
		this.#attachments.set(workerId, adopted);
		return adopted;
	}
	/** The digest of the session's active configuration in the guest, which must be the one this executor journaled
	 * for the boot. */
	async #installedConfiguration(
		machine: Readonly<LxdCodingMachineBinding>,
		workerId: string,
		bootId: string,
		signal: AbortSignal,
	): Promise<string> {
		const layout = cloudCodingSessionLayout(workerId),
			name = lxdCodingMachineName(machine.machineId);
		const file = await this.#options.client.readInstanceFile(
			machine.project,
			name,
			`${layout.configurationRoot}/guest.json`,
			8192,
			signal,
		);
		if (file.uid !== 0 || file.gid !== 0 || file.mode !== 0o444)
			throw new Error("CODING_HOST_GUEST_CONFIGURATION_UNCONFIRMED");
		const content = file.content.toString("utf8");
		const configuration = record(JSON.parse(content));
		const journal = await readRecord(join(await this.#directory("guests", signal), `${workerId}.${bootId}.json`));
		if (
			!isDeepStrictEqual(journal.value, configuration) ||
			configuration.workerId !== workerId ||
			configuration.vmId !== machine.machineId ||
			configuration.bootId !== bootId
		)
			throw new Error("CODING_HOST_GUEST_BINDING_CHANGED");
		return digest(content);
	}
	/** Runs the pinned storage helper's observe action and reads back what it
	 * published: per attached session, its slice's processor time and the bytes
	 * its processes moved, its guest lease and (unless `named` is false) the
	 * commands still running. */
	async #observe(machine: Readonly<LxdCodingMachineBinding>, signal: AbortSignal, named = true): Promise<Observed> {
		const client = this.#options.client,
			name = lxdCodingMachineName(machine.machineId);
		const boot = await client.readInstanceFile(machine.project, name, "/proc/sys/kernel/random/boot_id", 64, signal);
		const bootId = boot.content.toString("utf8").trim();
		if (boot.uid !== 0 || boot.gid !== 0 || !UUID.test(bootId)) throw new Error("CODING_HOST_BOOT_UNCONFIRMED");
		// The helper this process runs as root in the guest is the pinned one, checked once per boot.
		if (this.#helperBoots.get(machine.machineId) !== bootId) {
			const helper = await client.readInstanceFile(
				machine.project,
				name,
				"/opt/qorpera-coding/cloud-coding-storage-guest.mjs",
				65536,
				signal,
			);
			if (
				helper.uid !== 0 ||
				helper.gid !== 0 ||
				helper.mode !== 0o444 ||
				digest(helper.content) !== this.#options.guest.storageHelperSha256
			)
				throw new Error("CODING_HOST_GUEST_ARTIFACT_CHANGED");
			this.#helperBoots.set(machine.machineId, bootId);
		}
		await client.execInstance(
			machine.project,
			name,
			["/usr/bin/node", "/opt/qorpera-coding/cloud-coding-storage-guest.mjs", "observe"],
			signal,
		);
		const published = async (path: string) => {
			const file = await client.readInstanceFile(machine.project, name, path, 65536, signal);
			if (file.uid !== 0 || file.gid !== 0 || file.mode !== 0o444)
				throw new Error("CODING_HOST_OBSERVATION_UNCONFIRMED");
			return record(JSON.parse(file.content.toString("utf8")));
		};
		const value = await published(CODING_GUEST_OBSERVATION);
		if (
			value.schema !== "qorpera.coding-guest-observation/v3" ||
			value.bootId !== bootId ||
			!Number.isSafeInteger(value.uptimeMs) ||
			!Array.isArray(value.sessions)
		)
			throw new Error("CODING_HOST_OBSERVATION_UNCONFIRMED");
		const sessions: Observed["sessions"] = new Map();
		for (const entry of value.sessions) {
			const session = record(entry);
			const lease = session.lease === null ? null : record(session.lease);
			if (
				typeof session.workerId !== "string" ||
				!UUID.test(session.workerId) ||
				![session.cpuUsageUsec, session.ioBytes].every(
					(count) => Number.isSafeInteger(count) && Number(count) >= 0,
				) ||
				!Number.isSafeInteger(session.running) ||
				Number(session.running) < 0 ||
				(lease !== null &&
					(typeof lease.tokenSha256 !== "string" ||
						!SHA.test(lease.tokenSha256) ||
						!Number.isSafeInteger(lease.expiresInMs) ||
						Number(lease.expiresInMs) < 0))
			)
				throw new Error("CODING_HOST_OBSERVATION_UNCONFIRMED");
			let running: ObservedCommand[] = [];
			if (named && Number(session.running) > 0) {
				const commands = await published(`/run/qorpera-coding/observation-${session.workerId}.json`);
				if (
					commands.schema !== "qorpera.coding-guest-running/v1" ||
					commands.bootId !== bootId ||
					commands.workerId !== session.workerId ||
					!Array.isArray(commands.running) ||
					commands.running.length > 64
				)
					throw new Error("CODING_HOST_OBSERVATION_UNCONFIRMED");
				running = commands.running.map((command: unknown) => {
					const c = record(command);
					if (
						typeof c.commandId !== "string" ||
						!UUID.test(c.commandId) ||
						!Number.isSafeInteger(c.turn) ||
						Number(c.turn) < 1 ||
						typeof c.command !== "string" ||
						Buffer.byteLength(c.command) > 300
					)
						throw new Error("CODING_HOST_OBSERVATION_UNCONFIRMED");
					return { commandId: c.commandId, turn: Number(c.turn), command: c.command };
				});
			}
			sessions.set(session.workerId, {
				uptimeMs: Number(value.uptimeMs),
				cpuUsageUsec: Number(session.cpuUsageUsec),
				ioBytes: Number(session.ioBytes),
				ioComplete: true,
				running,
				lease: lease && { tokenSha256: String(lease.tokenSha256), expiresInMs: Number(lease.expiresInMs) },
			});
		}
		return { bootId, sessions };
	}
	/** The folder model's observation (5g-6a): the machine's boot, and for each of `workerIds` the commands the guest
	 * agent still runs, as the host kept them when they started (one the host kept no start of is not reported), and
	 * the session's processor time and bytes so far on this boot's clock, for the one idle rule. The agent lists every
	 * command it still runs, however old, or refuses (CODING_GUEST_STATUS_OVERFLOW), and reports a session it does not
	 * carry with none. Every session is in it: one left out would be released. Guest leases are not read. */
	async #observeFolder(
		folder: FolderOptions,
		machine: Readonly<LxdCodingMachineBinding>,
		workerIds: readonly string[],
		signal: AbortSignal,
	): Promise<Observed> {
		const boot = await this.#options.client.readInstanceFile(
			machine.project,
			lxdCodingMachineName(machine.machineId),
			"/proc/sys/kernel/random/boot_id",
			64,
			signal,
		);
		const bootId = boot.content.toString("utf8").trim();
		if (boot.uid !== 0 || boot.gid !== 0 || !isUuid(bootId)) throw new Error("CODING_HOST_BOOT_UNCONFIRMED");
		const guest = new LxdCodingGuestClient({ machine, client: folder.client });
		const sessions: Observed["sessions"] = new Map();
		for (const workerId of workerIds) {
			const status = await guest.status({ schema: "qorpera.coding-guest-session/v1", workerId }, signal);
			// Read on another boot's clock, it compares with nothing this boot's samples hold.
			if (status.usage.bootId !== bootId) throw new Error("CODING_HOST_OBSERVATION_UNCONFIRMED");
			const custody = lxdCodingSessionStorage(machine, this.#placement, workerId).custodySource;
			const running: ObservedCommand[] = [];
			for (const { commandId, state } of status.commands) {
				if (state !== "running" || running.length >= 64) continue;
				const kept = await this.#storageTask(() => codingFolderKeptCommand(custody, workerId, commandId), signal);
				if (kept)
					running.push({
						commandId,
						turn: kept.turn,
						command: clipped(kept.command, CODING_OBSERVED_COMMAND_BYTES),
					});
			}
			const { uptimeMs, cpuUsageUsec, ioBytes, ioComplete } = status.usage;
			sessions.set(workerId, { uptimeMs, cpuUsageUsec, ioBytes, ioComplete, running, lease: null });
		}
		return { bootId, sessions };
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
	): Promise<LxdCodingCommandTransport | LxdCodingFolderCommandTransport> {
		const ready = this.#prepared.get(scope.workerId);
		if (!ready || !isDeepStrictEqual(scope, ready.scope)) throw new Error("CODING_HOST_TURN_NOT_PREPARED");
		await this.#run(ready.claim, ready.machine, ready.storage, signal);
		const folder = this.#options.folder;
		const checkedAuthorize: typeof authorize = async (action, checkedScope, commandId, inputSha256, checked) => {
			this.#current(ready);
			await this.#run(ready.claim, ready.machine, ready.storage, checked);
			// On the folder model, a machine SQL holds marked for a new disk (this run's take-in may just have marked it)
			// starts no command and shows none until it has one: its disk may hold what it read. A cancel still goes, and
			// keeps and shows nothing of the command (the transport's `withheld` below, asked before anything is kept, and
			// by its `hidden` after the command service's final authorization).
			if (folder && ready.folder && action !== "cancel" && (await this.#newDiskDue(ready.machine, checked)))
				throw new Error("CODING_HOST_MACHINE_REFUSED:MACHINE_NEW_DISK");
			await authorize(action, checkedScope, commandId, inputSha256, checked);
		};
		if (folder && ready.folder) {
			// The session's own user runs each command through the guest agent, at its worktree, with Git's settings for
			// the company folder, under the start the machine runs at that moment (none while it starts again), whichever
			// start it was prepared under; the host keeps each command's start and output in the session's custody folder.
			// That folder outlives a new disk, and goes with the session to another machine: what a command printed on a disk
			// the machine no longer has, or on another machine, is never shown, whichever turn asks (the transport's `hidden`,
			// by its `disk` from next to the machine's journal).
			const { machineId } = ready.machine;
			// A boundary that says the machine holds a read no longer readable marks it for a new disk (rule 4,
			// `unreadable`), once: until it has one, a command's outcome waits for a release that does not come.
			let marked = false;
			const control: Pick<CodingFolderControl, "boundary"> = {
				boundary: async (id, final, checked) => {
					const boundary = await folder.control.boundary(id, final, checked);
					if (!marked && codingFolderBoundaryUnreadable(boundary))
						marked = await this.#markForFolder(ready.machine, true, checked).then(
							() => true,
							() => false,
						);
					return boundary;
				},
			};
			return new LxdCodingFolderCommandTransport({
				machine: ready.machine,
				scope: ready.scope,
				currentStart: () => this.#folderStartOperations.get(machineId),
				session: {
					uid: ready.folder.uid,
					gid: ready.folder.uid,
					cwd: ready.folder.cwd,
					environment: CODING_FOLDER_GIT_ENVIRONMENT,
				},
				custody: ready.storage.custodySource,
				limitBytes: this.#options.guest.resourceProfile.maxLogBytes,
				guest: new LxdCodingGuestClient({ machine: ready.machine, client: folder.client }),
				control,
				withheld: (checked) => this.#newDiskDue(ready.machine, checked),
				disk: async (checked) =>
					codingMachineDisk(
						await this.#directory("machines", checked),
						lxdCodingMachineJournalPlan(ready.machine, this.#placement),
					),
				dropped: async (startOperationId, checked) =>
					codingMachineStartDropped(
						await this.#directory("machines", checked),
						lxdCodingMachineJournalPlan(ready.machine, this.#placement),
						startOperationId,
					),
				authorize: checkedAuthorize,
				secrets: this.#sessionSecrets(ready),
			});
		}
		return new LxdCodingCommandTransport({
			machine: ready.machine,
			storage: this.#placement,
			scope: ready.scope,
			bootId: ready.bootId,
			guestConfigSha256: ready.guestConfigSha256,
			helperSha256: this.#options.guest.commandHelperSha256,
			client: this.#options.client,
			authorize: checkedAuthorize,
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
	housekeep(signal: AbortSignal): Promise<CodingHousekeepingOutcome[]> {
		return withAbortScope(signal, (scoped) => this.#housekeep(scoped));
	}
	async #housekeep(signal: AbortSignal): Promise<CodingHousekeepingOutcome[]> {
		const outcomes: CodingHousekeepingOutcome[] = [];
		// Now and then: archive the sessions of this executor's environments that
		// have had no turn and no busy command for the environment's archive delay.
		if (performance.now() - this.#archiveScanAt >= CODING_ARCHIVE_SCAN_MS) {
			this.#archiveScanAt = performance.now();
			try {
				const archived = await this.#call(
					"qorpera_archive_quiet_coding_sessions",
					{ p_owner: this.#options.owner },
					signal,
				);
				if (!Number.isSafeInteger(archived)) throw new Error("CODING_HOST_ARCHIVE_UNCONFIRMED");
				if (Number(archived) > 0)
					outcomes.push({ machineId: null, step: "archive", state: "done", code: `ARCHIVED:${archived}` });
			} catch (error) {
				signal.throwIfAborted();
				outcomes.push({ machineId: null, step: "archive", state: "failed", code: errorCodeOf(error) });
			}
		}
		const listed = await this.#call(
			"qorpera_list_coding_machines",
			{ p_owner: this.#options.owner, p_machine_id_sha256: this.#options.machineIdSha256 },
			signal,
		);
		if (!Array.isArray(listed)) throw new Error("CODING_HOST_MACHINE_LIST_INVALID");
		for (const value of listed) {
			signal.throwIfAborted();
			const entry = this.#listed(value);
			const step: "sleep" | "delete" | null =
				entry.released || entry.removeDue ? "delete" : entry.sleepDue ? "sleep" : null;
			if (!step) continue;
			try {
				await this.#exclusive(entry.machineId, signal, async () => {
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
				// A release that failed after the delete is its own step: the machine is gone, its capacity is not.
				const failed = error instanceof CodingReleaseFailed ? "release" : step;
				const failure = errorCodeOf(error);
				outcomes.push({ machineId: entry.machineId, step: failed, state: "failed", code: failure });
				await this.#recordError(entry.machineId, failed, failure, signal).catch(() => undefined);
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
			![
				entry.live,
				entry.reserved,
				entry.released,
				entry.sleepDue,
				entry.removeDue,
				entry.superseded,
				entry.removing,
			].every((flag) => typeof flag === "boolean") ||
			!Array.isArray(entry.attached)
		)
			throw new Error("CODING_HOST_MACHINE_LIST_INVALID");
		const attached = entry.attached.map((value) => {
			const session = record(value);
			if (
				typeof session.workerId !== "string" ||
				!UUID.test(session.workerId) ||
				typeof session.attachmentToken !== "string" ||
				!UUID.test(session.attachmentToken)
			)
				throw new Error("CODING_HOST_MACHINE_LIST_INVALID");
			return { workerId: session.workerId, attachmentToken: session.attachmentToken };
		});
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
			superseded: entry.superseded as boolean,
			removing: entry.removing as boolean,
			lastError: typeof entry.lastError === "string" ? entry.lastError : null,
			attached,
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
	/** Stop, with every attached session taken off first (its running commands
	 * cancelled, its slice stopped, its boot-local state removed; best effort),
	 * every other command slice stopped and the guest flushed, the session
	 * folders unplugged while it is off, and the node demand suspended: asleep,
	 * it holds no node capacity. Each attached session's detach is recorded with
	 * what it stopped (SLEEP, or RETIRED for a machine being removed). On the
	 * folder model nothing is plugged: nothing of an attached session runs any
	 * more (its user manager too) while its view stays mounted, and then the
	 * machine's views end before it stops. */
	async #sleep(entry: ListedMachine, signal: AbortSignal): Promise<void> {
		if (!entry.instanceSha256) return;
		const { journal, text } = this.#journal(entry);
		const client = this.#options.client;
		const budget = AbortSignal.any([
			signal,
			AbortSignal.timeout(CODING_VM_STOP_BUDGET_MS * 2 + CODING_SESSION_QUIESCE_MS * 2),
		]);
		await this.#custody(journal, text, "stop", budget);
		const instance = await client.getInstance(journal.project, journal.name, budget);
		const member =
			entry.kind === "member"
				? lxdCodingMachinePlan(entry.binding as unknown as LxdCodingMachineBinding).binding
				: null;
		const folder = this.#options.folder;
		let observed: Observed | null = null;
		// The first failure, reported once the machine is asleep.
		let failure: unknown;
		if (member && entry.attached.length && instance && instance.status === "Running" && instance.statusCode === 103) {
			const quiet = AbortSignal.any([budget, AbortSignal.timeout(CODING_SESSION_QUIESCE_MS)]);
			try {
				observed = folder
					? await this.#observeFolder(
							folder,
							member,
							entry.attached.map((session) => session.workerId),
							quiet,
						)
					: await this.#observe(member, quiet);
			} catch {
				/* The power-off below stops every command all the same. */
			}
			for (const { workerId } of entry.attached) {
				await this.#cancelCommands(
					member,
					workerId,
					(observed?.sessions.get(workerId)?.running ?? []).map((command) => command.commandId),
					quiet,
				);
				// Nothing is plugged on the folder model: below, nothing of the session runs any more before its view's
				// final boundary, and the power-off ends the guest's session.
				if (folder) continue;
				try {
					await client.execInstance(
						journal.project,
						journal.name,
						["/usr/bin/node", "/opt/qorpera-coding/cloud-coding-storage-guest.mjs", "detach", workerId],
						quiet,
					);
				} catch {
					/* The slice stop and the power-off below end it. */
				}
			}
			if (folder) {
				// Each session's commands and user manager, all at once: the slice stop below stops only the commands.
				const settle = AbortSignal.any([budget, AbortSignal.timeout(CODING_SESSION_QUIESCE_MS)]);
				const guest = new LxdCodingGuestClient({ machine: member, client: folder.client });
				for (const quiesced of await Promise.allSettled(
					entry.attached.map(({ workerId }) =>
						guest.quiesce({ schema: "qorpera.coding-guest-session/v1", workerId }, settle),
					),
				))
					if (quiesced.status === "rejected") failure ??= quiesced.reason;
			}
		}
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
		// The machine's views end before it powers off: their final boundary saves what its stopped sessions left (the
		// mount program is outside the command slices), then each closes, saved or not. One not saved or not confirmed
		// closed, or views whose records can't be read or removed, are reported once the machine is asleep.
		if (folder && member)
			try {
				for (const end of await folder.views.endMachine(member.machineId, budget))
					if (!end.saved) failure ??= new Error("CODING_FOLDER_VIEW_UNSAVED");
					else if (!end.closed) failure ??= new Error("CODING_FOLDER_VIEW_CLOSE_UNCONFIRMED");
			} catch (error) {
				failure ??= error;
			}
		const state = await this.#reconcile(
			journal,
			"stopped",
			async (_intent, checked) => this.#custody(journal, text, "stop", checked),
			budget,
			// Stopped from outside: each attachment ends as MACHINE_STOPPED, so the SLEEP records below find none.
			member ? (start, checked) => this.#recordMachineStopped(member, start, checked) : undefined,
		);
		if (state === "stopped" && member) {
			// Stopped, it needs no lease; one left behind lapses all the same.
			await this.#hostLeases.drop(journal).catch(() => undefined);
			await this.#unplugStopped(
				member,
				(checked) => this.#custody(journal, text, "stop", checked),
				"CODING_MACHINE_SLEEP_DETACH_UNCONFIRMED",
				budget,
			);
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
		this.#helperBoots.delete(entry.machineId);
		this.#settledBoots.delete(entry.machineId);
		// Asleep, no session is attached: each ends with what it stopped. All are recorded; the first failure is reported.
		for (const { workerId, attachmentToken } of member ? entry.attached : [])
			try {
				await this.#recordDetached(
					member as Readonly<LxdCodingMachineBinding>,
					workerId,
					attachmentToken,
					entry.superseded || entry.removing ? "RETIRED" : "SLEEP",
					observed?.sessions.get(workerId)?.running ?? [],
					budget,
				);
			} catch (error) {
				failure ??= error;
			}
		if (failure) throw failure;
	}
	/** Asleep (or stopped and suspended first), then deleted under a journaled
	 * delete, then released with that deletion proof. A machine never admitted,
	 * never reserved, or already released elsewhere has nothing to delete. */
	async #remove(entry: ListedMachine, signal: AbortSignal): Promise<void> {
		const release = async (text: string) => {
			let released: Record<string, unknown>;
			try {
				released = record(
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
			} catch (error) {
				throw new CodingReleaseFailed(errorCodeOf(error), { cause: error });
			}
			if (released.state !== "released" || released.machineId !== entry.machineId)
				throw new CodingReleaseFailed("CODING_MACHINE_RELEASE_UNCONFIRMED");
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
		const member =
			entry.kind === "member"
				? lxdCodingMachinePlan(entry.binding as unknown as LxdCodingMachineBinding).binding
				: null;
		const state = await this.#reconcile(
			journal,
			"deleted",
			async (_intent, checked) => this.#custody(journal, text, "delete", checked),
			budget,
			member ? (start, checked) => this.#recordMachineStopped(member, start, checked) : undefined,
		);
		if (state !== "deleted" && state !== "absent") throw new Error("CODING_HOST_VM_RECOVERY_REQUIRED");
		if (entry.kind === "member") await this.#hostLeases.drop(journal).catch(() => undefined);
		await release(text);
	}
	async #recordError(
		machineId: string,
		step: CodingHousekeepingOutcome["step"] | "wake",
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
