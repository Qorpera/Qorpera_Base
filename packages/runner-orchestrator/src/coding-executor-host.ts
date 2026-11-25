import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";
import {
	type CloudCodingCommandReceipt,
	type CloudCodingCommandScope,
	type CloudCodingNasPolicy,
	type CloudCodingRepository,
	type CloudCodingStorageBinding,
	CODING_CHECK_CACHES,
	CODING_GUEST,
	CODING_GUEST_HELPER_MAX_BYTES,
	CODING_PACKAGE_CACHE_ENVIRONMENT,
	cloudCodingSessionLayout,
	type IdleRuleSample,
	idleRuleBusy,
	isRecord,
	isUuid,
	parseCloudCodingNasPolicy,
	UUID_PATTERN,
} from "@qorpera/contracts";
import { withAbortScope, withAbortScopes, withTimeoutScope } from "./abort-scope.ts";
import type { AgentPlug } from "./agent-plug.ts";
import {
	CODE_CHECKS_EARLIER_RUN_NOT_STOPPED,
	type CodeCheck,
	type CodeCheckArtifactFormat,
	type CodeCheckCache,
	type CodeCheckPassedEntry,
	type CodeChecksRun,
	type CodeSiteRecipe,
	codeChecksGateMetadata,
	codeChecksPlan,
	codeChecksTail,
	codeChecksWallBudget,
	type FailedTestCase,
	filterCodeChecksByPaths,
	MAX_PARALLEL_CHECKS,
	parseCheckFailureArtifacts,
} from "./code-checks.ts";
import { codeAreaPath } from "./code-host-jobs.ts";
import {
	CODE_CHECKS_NEWER_RUN,
	CODE_SITE_APP_COLLECT,
	CODE_SITE_COLLECT,
	CODE_SITE_DROP,
	type CodeSiteCollected,
	type CodeSiteProblem,
	codeSiteCollectAnswer,
	codeSiteDropAnswer,
} from "./code-site.ts";
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
	CodingPreviewBuild,
	CodingSessionClaim,
	CodingSubmission,
	CodingTurnState,
	CodingWorkspace,
} from "./coding-executor.ts";
import {
	CodingControlRefused,
	CodingMachineUnavailable,
	CodingPushRefused,
	CodingSaveRefused,
	CodingWorkspaceFailed,
} from "./coding-executor.ts";
import {
	codingFolderKeptCommand,
	LxdCodingFolderCommandTransport,
	type LxdCodingFolderCommandTransportOptions,
} from "./coding-folder-command-transport.ts";
import {
	type CodingFolderBoundary,
	type CodingFolderControl,
	codingFolderBoundaryChecking,
	codingFolderBoundaryHeld,
	codingFolderBoundaryUnreadable,
	codingFolderSaveRefused,
} from "./coding-folder-control.ts";
import {
	CODING_FOLDER_COMPANY_ROOT,
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
import { CodingGuestRefused, LxdCodingGuestClient } from "./coding-guest-client.ts";
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
	settleAcceptedCodingMachine,
	undropCodingMachineStart,
	waitPendingLxdOperation,
} from "./coding-machine.ts";
import { EMPTY_CODING_SETUP_DIGEST, type ParsedCodingSetup } from "./coding-setup.ts";
import {
	type CodingSetupCommandRunner,
	CodingSetupLifecycle,
	CodingSetupLifecycleError,
} from "./coding-setup-lifecycle.ts";
import type { CodingSnapshotBuilder } from "./coding-snapshots.ts";
import type { CodingStandbyPool } from "./coding-standby-pool.ts";
import { type CodingNasStorage, createCodingNasStorage } from "./coding-storage.ts";
import { type LxdCodingVmBinding, lxdCodingVmPlan, lxdLegacyCodingMachineJournalPlan } from "./coding-vm.ts";
import { publishCloudCodingDraftPullRequest } from "./coding-workspace.ts";
import type {
	LxdCodingMemoryClient,
	LxdImageClient,
	LxdInspectableClient,
	LxdInstanceDeviceClient,
	LxdInstanceExecStreamClient,
	LxdInstanceFile,
	LxdProjectClient,
	LxdTrackedClient,
} from "./lxd-client.ts";
import { checkDirectory, code, publish, readRecord } from "./lxd-office-journal-files.ts";
import { previewBuildOutcome, type SurfacePreviewBuildOutcome } from "./surface-preview-runner.ts";

export const CODING_HOST_RPCS = [
	"qorpera_plan_coding_machine",
	"qorpera_authorize_coding_machine_run",
	"qorpera_attach_coding_session",
	"qorpera_keep_coding_attachments",
	"qorpera_record_coding_machine_load",
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
	"qorpera_record_code_change",
	"qorpera_code_checks_switch",
	"qorpera_fallback_coding_machine_base_image",
	"qorpera_record_coding_worktree_created",
] as const;

export const CODING_BOOT_READY_COMMAND: readonly string[] = Object.freeze([
	"/usr/bin/sh",
	"-c",
	'systemctl is-active --quiet basic.target && [ "$(systemctl is-active systemd-networkd.service 2>/dev/null || true)" != "activating" ] && [ "$(systemctl is-active qorpera-coding.slice 2>/dev/null || true)" != "activating" ]',
]);

const POLL_BACKOFF_MS = [100, 200, 500] as const;
const CODING_KEPT_COMMAND_CACHE_MAX = 4096;

function pollBackoffMs(attempt: number): number {
	return POLL_BACKOFF_MS[Math.min(attempt, POLL_BACKOFF_MS.length - 1)]!;
}

export interface CodingCommandTurnContext {
	readonly inputSha256: string;
	readonly runAuthority?: unknown;
	readonly rebuildDue?: boolean;
	readonly diskEpoch?: string | null;
	readonly vaultEnvVersion?: string;
	readonly startedAt?: number;
	postAuthority?: {
		readonly inputSha256: string;
		readonly runAuthority?: unknown;
		readonly rebuildDue?: boolean;
		readonly diskEpoch?: string | null;
		readonly vaultEnvVersion?: string;
		readonly startedAt?: number;
	};
}

export interface CodingLocalRunBinding {
	readonly workerId: string;
	readonly leaseToken: string;
	readonly bindingText: string;
	readonly storage: Readonly<CloudCodingStorageBinding>;
	readonly machineIdSha256: string;
}

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
		LxdCodingMemoryClient &
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
	autoRedeploy?: CodingExecutorHost["autoRedeploy"];
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
		control: Pick<CodingFolderControl, "boundary" | "restarted" | "secrets"> &
			Partial<Pick<CodingFolderControl, "releaseReads">>;
		/** The guest agent's exec client (the executor's LXD client). */
		client: LxdInstanceExecStreamClient;
		/** Where a session's commands start and what its finished turn exports (default: none, at /company). */
		repositories?: CodingFolderRepositories;
		/** Each view the guest mounted for a session, how the view it replaced ended, if it replaced one, and whether the
		 * agent said the machine's package caches are ready at this mount (the turn's commands get them only then). */
		onMount?(mount: {
			workerId: string;
			machineId: string;
			viewId: string;
			replaced?: CodingFolderViewEnd;
			packageCaches: boolean;
		}): void;
		/** The log lines of a landing's checks (own code storage, step 3): `code-checks` (each command `started` and
		 * `ended`, the site's collect and drop among them, each `boundary` after the collect, what the drop `dropped`, and
		 * the `run`) and `code-checks-error` (whose `error` is the error itself, for the log to redact). Never a check's
		 * output, a site's file or a secret's value. */
		report?(event: Record<string, unknown>): void;
		/** How often a running check is read (default 3 s), the wall budget of a whole run of the checks (default: 300 s
		 * for the copy, and each check's own limit and 60 s more; and 240 s for a run that takes a site), and how long a
		 * check is cancelled and read for until its end is confirmed (default 20 s). */
		checksPollMs?: number;
		checksBudgetMs?: number;
		checksStopMs?: number;
		/** How long the boundary after a site's collect is asked for at most (default 120 s): again each second, or at the
		 * read's pace (`checksPollMs`) when that is shorter. */
		checksBoundaryMs?: number;
	};
	snapshotBuilder?: CodingSnapshotBuilder;
	standbyPool?: CodingStandbyPool;
	setupLifecycle?: CodingSetupLifecycle;
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
	/** On the folder model: the session's user, where its commands start, and whether its machine's agent said the
	 * machine's package caches are ready at this turn's mount (own code storage, step 6). */
	folder?: { uid: number; cwd: string; packageCaches: boolean };
}
/** A run of the checks that takes the site its checks left (own code storage, step 4): the recipe, the commit, whether
 * links from `/` are let through (step 5), the run's folder, the environment every command of the run gets, the
 * repository's storage, the host's authority, the run's wall budget, its commands' ids, the collect's place after the
 * checks (the drop's is the next), and its log lines' names. */
interface SiteRun {
	recipe: CodeSiteRecipe;
	commit: string;
	rootLinks: boolean;
	dir: string;
	base: Readonly<Record<string, string>>;
	repository: string;
	authorize: LxdCodingFolderCommandTransportOptions["authorize"];
	budget: AbortSignal;
	commandId: (index: "site" | "drop") => string;
	index: number;
	step: Record<string, unknown>;
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
	folder?: { uid: number };
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
	cpuUsageUsec: number;
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
/** A folder session's environment: Git's settings, and who its commits are by. Until 10 Nov 2026 the platform set no
 * author, and sessions' commits carried names the model made up ("Qorpera Coding", "Codex"): nothing in a commit said
 * which session made it. Now author and committer name the session by its worker id, which the kernel maps to its
 * agent, its member and its turns. Git reads these before any setting a command writes; only an explicit `--author`
 * overrides the author, and nothing a command passes overrides the committer. */
export function codingFolderGitEnvironment(workerId: string): Readonly<Record<string, string>> {
	const who = { name: "Qorpera coding session", email: `${workerId}@coding.qorpera.com` };
	return Object.freeze({
		...CODING_FOLDER_GIT_ENVIRONMENT,
		GIT_AUTHOR_NAME: who.name,
		GIT_AUTHOR_EMAIL: who.email,
		GIT_COMMITTER_NAME: who.name,
		GIT_COMMITTER_EMAIL: who.email,
	});
}
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
const CODING_LOAD_MAX_CPU_MILLIS = 999_999_999;
const CODING_LOAD_MAX_MEMORY_BYTES = 1_099_511_627_776;
const CODING_LOAD_CPU_FULL_PERCENT = 85;
const CODING_LOAD_MEMORY_FULL_PERCENT = 80;
const CODING_LOAD_MEMINFO_AVAILABLE_MIN_PERCENT = 15;
const CODING_LOAD_CPU_HYSTERESIS_SAMPLES = 3;
const CODING_LOAD_UID_LOOKUP_MS = 2_000;
const CGROUP_MEMORY_STAT_PATTERNS = [
	/^anon ([0-9]{1,15})$/m,
	/^shmem ([0-9]{1,15})$/m,
	/^kernel ([0-9]{1,15})$/m,
] as const;

function validGuestUid(value: unknown): number | null {
	return typeof value === "number" &&
		Number.isSafeInteger(value) &&
		value >= CODING_GUEST.minUid &&
		value <= CODING_GUEST.maxUid
		? value
		: null;
}

function sessionCpuMillis(
	sample: SessionSample | undefined,
	bootId: string,
	uptimeMs: number,
	cpuUsageUsec: number,
): number {
	if (!sample || sample.bootId !== bootId || uptimeMs <= sample.at || cpuUsageUsec < sample.cpuUsageUsec) return 0;
	return Math.min(
		CODING_LOAD_MAX_CPU_MILLIS,
		Math.max(0, Math.round((cpuUsageUsec - sample.cpuUsageUsec) / (uptimeMs - sample.at))),
	);
}

function cgroupMemoryStatBytes(content: string): number {
	// WHY: Count anon, shmem, and kernel from memory.stat so reclaimable file page cache never inflates fullness.
	let total = 0;
	for (const pattern of CGROUP_MEMORY_STAT_PATTERNS) {
		const match = pattern.exec(content);
		if (!match) continue;
		const bytes = Number(match[1]);
		if (Number.isSafeInteger(bytes) && bytes > 0) total += bytes;
	}
	return Math.min(CODING_LOAD_MAX_MEMORY_BYTES, total);
}

function meminfoMemoryFull(content: string): boolean {
	const total = /^MemTotal:\s+([0-9]+)\s+kB$/m.exec(content);
	const available = /^MemAvailable:\s+([0-9]+)\s+kB$/m.exec(content);
	if (!total || !available) return false;
	const totalKb = Number(total[1]);
	const availableKb = Number(available[1]);
	if (!Number.isSafeInteger(totalKb) || totalKb <= 0 || !Number.isSafeInteger(availableKb) || availableKb < 0)
		return false;
	return availableKb * 100 < totalKb * CODING_LOAD_MEMINFO_AVAILABLE_MIN_PERCENT;
}
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
/** A run of a repository's checks (own code storage, step 3; STEP3-CHECKS-PLAN.md 6.2). Each run has a folder of its
 * own, `$QORPERA_CHECKS_ROOT/$QORPERA_CHECKS_NAME`, named `<the turn's sequence, 10 digits>-<the run's attempt, 4 digits>`
 * (codeChecksRunName): the session user's home is one session's (SQL gives each session its own uid, never another's),
 * so the names sort by time, the newest run's last. A process left of an earlier run holds paths into another folder,
 * never the newest run's (release review r1, F1). And a command of a run that is not the newest does nothing, by these
 * scripts' own rule on the machine (review round 4, F1): a start the transport never saw acknowledged may land at any
 * time after the host moved on, so its copy or check finds a higher name and exits 91 before it removes, makes or runs
 * anything. Names compare as bytes (`LC_ALL=C`, in a subshell of its own: nothing a check runs gets it). The rule's lines
 * are `CODE_CHECKS_NEWER_RUN` (code-site.ts), which the site's collect and drop begin with too (step 4).
 *
 * The copy: a clean copy of exactly the candidate on the machine's own disk, read from the repository's storage in the
 * company folder (no untracked or ignored file of any worktree), after waiting for a merge commit job A just wrote to
 * reach the session's view. Its values come in the environment. In this order (review round 5, F1):
 * 1. A root that is a link or a file is taken away, so nothing is made or removed through it.
 * 2. A copy of a run that is not the newest exits 91, having removed and made nothing (CODE_CHECKS_NEWER_RUN).
 * 3. The fence: its own folder is made at once (one that is a link or a file is taken away first), and stands from here
 *    on, never removed and made again. From this step on any start of an earlier run that lands finds a higher name
 *    and does nothing.
 * 4. What earlier runs left running ends: every process of this user whose working folder is inside a run folder with
 *    a lower name (`/proc/<pid>/cwd`, also when its folder is gone, " (deleted)") is killed (KILL), and they are looked
 *    for again after a short wait, at most five times. That ends a check that landed before the fence stood, and one
 *    left running by a turn that was given up or by an executor that restarted. Nothing else is killed: not a process in
 *    this run's folder, not one elsewhere in the home, not another user's (its `/proc` entry cannot be read). It cannot
 *    reach a process that left its folder (a server that changed its working folder, a daemon that went to `/`), nor one
 *    in a container under another uid.
 * 5. The run folders with a lower name are removed, as far as they can be (what a check left that its user cannot
 *    remove, a container's files, never stops a copy), and no other entry: two copies that land at once never remove
 *    each other's newer folder.
 * 6. Its own folder is emptied (only what is in it), and the copy is made in it. */
const CODE_CHECKS_COPY = [
	"set -eu",
	'r="$QORPERA_CHECKS_ROOT"',
	'n="$QORPERA_CHECKS_NAME"',
	'd="$r/$n"',
	'if [ -L "$r" ] || { [ -e "$r" ] && [ ! -d "$r" ]; }; then rm -f -- "$r"; fi',
	'mkdir -p -- "$r"',
	...CODE_CHECKS_NEWER_RUN,
	'if [ -L "$d" ] || { [ -e "$d" ] && [ ! -d "$d" ]; }; then rm -f -- "$d"; fi',
	'mkdir -p -- "$d"',
	"(",
	"\tLC_ALL=C",
	"\tfor t in 1 2 3 4 5; do",
	"\t\tk=0",
	"\t\twhile IFS= read -r -d '' h && IFS= read -r -d '' c; do",
	`\t\t\tc="\${c% (deleted)}"`,
	'\t\t\tcase "$c" in "$r"/*) ;; *) continue ;; esac',
	`\t\t\tm="\${c#"$r"/}"; m="\${m%%/*}"`,
	"\t\t\tif [[ $m =~ ^[0-9]{10}-[0-9]{4}$ && $m < $n ]]; then",
	`\t\t\t\tkill -KILL "\${h#/proc/}" 2>/dev/null || true; k=1`,
	"\t\t\tfi",
	"\t\tdone < <(find /proc -mindepth 2 -maxdepth 2 -name cwd -printf '%h\\0%l\\0' 2>/dev/null)",
	'\t\t[ "$k" -eq 1 ] || break',
	"\t\tsleep 0.2",
	"\tdone",
	")",
	"(",
	"\tLC_ALL=C",
	'\tfor e in "$r"/*; do',
	'\t\tm="$(basename -- "$e")"',
	'\t\tif [[ $m =~ ^[0-9]{10}-[0-9]{4}$ && $m < $n ]]; then rm -rf -- "$e" || true; fi',
	"\tdone",
	")",
	'find "$d" -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +',
	'mkdir -p -- "$d/out"',
	"b=(0.1 0.2 0.5 1 2)",
	"i=0",
	'until git -C "$QORPERA_CHECKS_REPOSITORY" cat-file -e "$QORPERA_CHECKS_COMMIT^{commit}" 2>/dev/null; do',
	'\t[ "$i" -lt 33 ] || exit 90',
	`\tif [ "$i" -lt 5 ]; then sleep "\${b[$i]}"; else sleep 2; fi`,
	"\ti=$((i + 1))",
	"done",
	'git clone --quiet --shared --no-checkout -- "$QORPERA_CHECKS_REPOSITORY" "$d/src"',
	'git -C "$d/src" -c advice.detachedHead=false checkout --quiet --detach "$QORPERA_CHECKS_COMMIT"',
	'test "$(git -C "$d/src" rev-parse HEAD)" = "$QORPERA_CHECKS_COMMIT"',
	`if [ -n "\${QORPERA_CHECKS_CACHES:-}" ] && [ -n "\${QORPERA_CHECKS_CACHE_ROOT:-}" ]; then`,
	'python3 -I - "$d/src" <<\x27QORPERA_CACHE_RESTORE_EOF\x27 || true',
	"import hashlib,json,os,re,stat,subprocess,sys",
	"TOK=re.compile(r\"\\$\\{hash\\('([^']*)'\\)\\}|hash\\('([^']*)'\\)\")",
	'KEY=re.compile(r"[A-Za-z0-9._:-]{1,200}")',
	"def safe_rel(p):",
	'\tif not isinstance(p,str) or not p or p=="." or p.startswith("/") or p.endswith("/") or "\\\\" in p or "\\0" in p:return False',
	"\tif any(ord(c)<32 or ord(c)==127 for c in p):return False",
	'\treturn all(x not in ("",".","..") and x.lower()!=".git" for x in p.split("/"))',
	"def safe_cache_path(p):",
	'\treturn safe_rel(p) and p.split("/")[0].lower()!=".qorpera"',
	"def no_link(root,rel):",
	"\tcur=root",
	'\tfor part in rel.split("/"):',
	"\t\tcur=os.path.join(cur,part)",
	"\t\tif os.path.islink(cur):return None",
	"\treturn cur",
	"def parent_ok(root,rel):",
	"\tcur=root",
	'\tfor part in rel.split("/")[:-1]:',
	"\t\tcur=os.path.join(cur,part)",
	"\t\tif os.path.islink(cur):return False",
	"\t\tif os.path.lexists(cur) and not os.path.isdir(cur):return False",
	"\treturn True",
	"def is_tracked(repo,commit,rel):",
	"\tif not repo or not commit:return True",
	'\tenv={"PATH":os.environ.get("PATH","/usr/bin:/bin"),"GIT_CONFIG_NOSYSTEM":"1","GIT_CONFIG_GLOBAL":"/dev/null","GIT_TERMINAL_PROMPT":"0"}',
	'\tr=subprocess.run(["git","--git-dir",repo,"-c","core.fsmonitor=false","-c","core.hooksPath=/dev/null","ls-tree","-r","--name-only",commit,"--",rel],stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,env=env,check=False)',
	"\treturn r.returncode!=0 or len(r.stdout)>0",
	"def open_rel_file(src_fd,rel):",
	'\tparts=rel.split("/")',
	"\tcur=os.dup(src_fd)",
	"\ttry:",
	"\t\tfor part in parts[:-1]:",
	"\t\t\tnxt=os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=cur)",
	"\t\t\tos.close(cur);cur=nxt",
	'\t\treturn os.open(parts[-1],os.O_RDONLY|os.O_NOFOLLOW|getattr(os,"O_NONBLOCK",0),dir_fd=cur)',
	"\texcept OSError:return -1",
	"\tfinally:os.close(cur)",
	"def eval_key(tpl,src_fd):",
	"\tdef rep(m):",
	"\t\trel=m.group(1) if m.group(1) is not None else m.group(2)",
	'\t\tif not safe_rel(rel):raise ValueError("bad")',
	"\t\tfd=open_rel_file(src_fd,rel)",
	'\t\tif fd<0:return "missing"',
	"\t\th=hashlib.sha256();rem=16*1024*1024",
	"\t\twith os.fdopen(fd,'rb') as f:",
	"\t\t\tif not stat.S_ISREG(os.fstat(f.fileno()).st_mode):return 'missing'",
	"\t\t\twhile rem>0:",
	"\t\t\t\tc=f.read(min(65536,rem))",
	"\t\t\t\tif not c:break",
	"\t\t\t\th.update(c);rem-=len(c)",
	"\t\treturn h.hexdigest()[:16]",
	"\tout=TOK.sub(rep,tpl)",
	'\treturn out if KEY.fullmatch(out) and not out.startswith(".") else None',
	"def valid_entry(ed):",
	'\tm=os.path.join(ed,".complete")',
	"\treturn not os.path.islink(ed) and os.path.isdir(ed) and os.path.isfile(m) and not os.path.islink(m)",
	"def used_t(ed):",
	'\tlu=os.path.join(ed,".last-used")',
	"\ttry:return os.lstat(lu).st_mtime if os.path.isfile(lu) and not os.path.islink(lu) else os.lstat(ed).st_mtime",
	"\texcept OSError:return 0.0",
	"try:",
	'\tsrc=sys.argv[1];root=os.environ.get("QORPERA_CHECKS_CACHE_ROOT","")',
	'\trepo=os.environ.get("QORPERA_CHECKS_REPOSITORY","");commit=os.environ.get("QORPERA_CHECKS_COMMIT","")',
	'\tspecs=json.loads(os.environ.get("QORPERA_CHECKS_CACHES","[]"))',
	"\tif root and not os.path.islink(root) and os.path.isdir(root) and isinstance(specs,list):",
	"\t\tsrc_fd=os.open(src,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)",
	"\t\ttry:",
	"\t\t\tfor spec in specs:",
	'\t\t\t\tkey=eval_key(spec.get("key",""),src_fd)',
	"\t\t\t\tif not key:continue",
	"\t\t\t\thit=os.path.join(root,key)",
	"\t\t\t\tif not valid_entry(hit):",
	"\t\t\t\t\thit=None",
	"\t\t\t\t\ttry:names=os.listdir(root)",
	"\t\t\t\t\texcept OSError:names=[]",
	'\t\t\t\t\tfor rk in spec.get("restoreKeys") or []:',
	"\t\t\t\t\t\tpref=eval_key(rk,src_fd)",
	"\t\t\t\t\t\tif not pref:continue",
	"\t\t\t\t\t\tms=[os.path.join(root,n) for n in names if n.startswith(pref) and valid_entry(os.path.join(root,n))]",
	"\t\t\t\t\t\tif ms:",
	"\t\t\t\t\t\t\tms.sort(key=used_t,reverse=True);hit=ms[0];break",
	"\t\t\t\tif not hit:continue",
	'\t\t\t\tfor rel in spec.get("paths") or []:',
	"\t\t\t\t\tif not safe_cache_path(rel):continue",
	'\t\t\t\t\tsp=no_link(os.path.join(hit,"data"),rel)',
	"\t\t\t\t\tif not sp or not os.path.lexists(sp):continue",
	"\t\t\t\t\tdp=no_link(src,rel)",
	"\t\t\t\t\tif not dp or os.path.lexists(dp) or not parent_ok(src,rel) or is_tracked(repo,commit,rel):continue",
	"\t\t\t\t\tos.makedirs(os.path.dirname(dp),exist_ok=True)",
	'\t\t\t\t\tsubprocess.run(["cp","-R","-P","--preserve=mode,timestamps","--reflink=auto","--",sp,dp],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,check=False)',
	"\t\tfinally:os.close(src_fd)",
	"except Exception:",
	"\tpass",
	"QORPERA_CACHE_RESTORE_EOF",
	"fi",
].join("\n");

const CODE_CHECKS_DIFF = [
	"set -eu",
	...CODE_CHECKS_NEWER_RUN,
	"printf 'QORPERA_DIFF_OK\\n'",
	'git -C "$QORPERA_CHECKS_REPOSITORY" diff -z --name-only --no-renames "refs/heads/$QORPERA_CHECKS_BASE_BRANCH" "$QORPERA_CHECKS_COMMIT"',
].join("\n");

const CODE_CHECKS_CACHE_TRACKED = [
	"set -eu",
	...CODE_CHECKS_NEWER_RUN,
	"python3 -I - <<'QORPERA_CACHE_TRACKED_EOF'",
	"import json,os,subprocess,sys",
	"def safe_cache_path(p):",
	'\tif not isinstance(p,str) or not p or p=="." or p.startswith("/") or p.endswith("/") or "\\\\" in p or "\\0" in p:return False',
	"\tif any(ord(c)<32 or ord(c)==127 for c in p):return False",
	'\tparts=p.split("/")',
	'\treturn parts[0].lower()!=".qorpera" and all(x not in ("",".","..") and x.lower()!=".git" for x in parts)',
	'repo=os.environ.get("QORPERA_CHECKS_REPOSITORY","");commit=os.environ.get("QORPERA_CHECKS_COMMIT","")',
	'nonce=os.environ.get("QORPERA_CHECKS_TRACKED_NONCE","")',
	'paths=json.loads(os.environ.get("QORPERA_CHECKS_CACHE_PATHS","[]"))',
	'env={"PATH":os.environ.get("PATH","/usr/bin:/bin"),"GIT_CONFIG_NOSYSTEM":"1","GIT_CONFIG_GLOBAL":"/dev/null","GIT_TERMINAL_PROMPT":"0"}',
	"untracked=[]",
	"if repo and commit and nonce and isinstance(paths,list):",
	"\tfor rel in paths:",
	"\t\tif not safe_cache_path(rel):continue",
	'\t\tr=subprocess.run(["git","--git-dir",repo,"-c","core.fsmonitor=false","-c","core.hooksPath=/dev/null","ls-tree","-r","--name-only",commit,"--",rel],stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,env=env,check=False)',
	"\t\tif r.returncode==0 and len(r.stdout)==0:untracked.append(rel)",
	'\tsys.stdout.write(f"QORPERA_CACHE_UNTRACKED:{nonce}:"+json.dumps(untracked)+"\\n")',
	"QORPERA_CACHE_TRACKED_EOF",
].join("\n");

const CODE_CHECKS_CACHE_SAVE = [
	"set -eu",
	'if [ "$(id -u)" -eq 0 ]; then',
	`\tcase "\${QORPERA_CHECKS_UID:-}" in ""|*[!0-9]*) exit 2;; esac`,
	`\tcase "\${QORPERA_CHECKS_GID:-}" in ""|*[!0-9]*) exit 2;; esac`,
	'\t[ "$QORPERA_CHECKS_UID" -ge 200000 ] && [ "$QORPERA_CHECKS_GID" -ge 200000 ] || exit 2',
	'\tsetpriv --reuid="$QORPERA_CHECKS_UID" --regid="$QORPERA_CHECKS_GID" --clear-groups -- bash --noprofile --norc -eu <<\x27QORPERA_NEWER_EOF\x27',
	...CODE_CHECKS_NEWER_RUN,
	"QORPERA_NEWER_EOF",
	"else",
	...CODE_CHECKS_NEWER_RUN,
	"fi",
	"python3 -I - <<'QORPERA_CACHE_SAVE_EOF'",
	"import json,os,re,secrets,shutil,subprocess,sys,tarfile,time",
	'KEY=re.compile(r"[A-Za-z0-9._:-]{1,200}")',
	"def safe_rel(p):",
	'\tif not isinstance(p,str) or not p or p=="." or p.startswith("/") or p.endswith("/") or "\\\\" in p or "\\0" in p:return False',
	"\tif any(ord(c)<32 or ord(c)==127 for c in p):return False",
	'\treturn all(x not in ("",".","..") and x.lower()!=".git" for x in p.split("/"))',
	"def safe_cache_path(p):",
	'\treturn safe_rel(p) and p.split("/")[0].lower()!=".qorpera"',
	"def ensure_dir(base,parts):",
	"\tcur=base",
	"\tfor part in parts:",
	"\t\tcur=os.path.join(cur,part)",
	'\t\tif os.path.islink(cur):raise ValueError("link")',
	"\t\tif not os.path.exists(cur):os.mkdir(cur,0o755)",
	'\t\telif not os.path.isdir(cur):raise ValueError("notdir")',
	"\t\tos.chmod(cur,0o755)",
	"\treturn cur",
	"EVAL_PY=r'''",
	"import hashlib,json,os,re,stat,sys",
	"TOK=re.compile(r\"\\$\\{hash\\('([^']*)'\\)\\}|hash\\('([^']*)'\\)\")",
	'KEY=re.compile(r"[A-Za-z0-9._:-]{1,200}")',
	"def safe_rel(p):",
	'\tif not isinstance(p,str) or not p or p=="." or p.startswith("/") or p.endswith("/") or "\\\\" in p or "\\0" in p:return False',
	"\tif any(ord(c)<32 or ord(c)==127 for c in p):return False",
	'\treturn all(x not in ("",".","..") and x.lower()!=".git" for x in p.split("/"))',
	"def safe_cache_path(p):",
	'\treturn safe_rel(p) and p.split("/")[0].lower()!=".qorpera"',
	"def open_chain(base_fd,parts):",
	"\tcur=os.dup(base_fd)",
	"\ttry:",
	"\t\tfor part in parts:",
	"\t\t\tnxt=os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=cur)",
	"\t\t\tos.close(cur);cur=nxt",
	"\t\treturn cur",
	"\texcept OSError:",
	"\t\tos.close(cur);return -1",
	"def open_file(src_fd,rel):",
	'\tparts=rel.split("/")',
	"\tpfd=open_chain(src_fd,parts[:-1])",
	"\tif pfd<0:return -1",
	"\ttry:return os.open(parts[-1],os.O_RDONLY|os.O_NOFOLLOW|getattr(os,'O_NONBLOCK',0),dir_fd=pfd)",
	"\texcept OSError:return -1",
	"\tfinally:os.close(pfd)",
	"def eval_key(tpl,src_fd):",
	"\tdef rep(m):",
	"\t\trel=m.group(1) if m.group(1) is not None else m.group(2)",
	'\t\tif not safe_rel(rel):raise ValueError("bad")',
	"\t\tfd=open_file(src_fd,rel)",
	'\t\tif fd<0:return "missing"',
	"\t\th=hashlib.sha256();rem=16*1024*1024",
	"\t\twith os.fdopen(fd,'rb') as f:",
	"\t\t\tif not stat.S_ISREG(os.fstat(f.fileno()).st_mode):return 'missing'",
	"\t\t\twhile rem>0:",
	"\t\t\t\tc=f.read(min(65536,rem))",
	"\t\t\t\tif not c:break",
	"\t\t\t\th.update(c);rem-=len(c)",
	"\t\treturn h.hexdigest()[:16]",
	"\tout=TOK.sub(rep,tpl)",
	'\treturn out if KEY.fullmatch(out) and not out.startswith(".") else None',
	"chk_root,chk_name,specs_raw=sys.argv[1],sys.argv[2],sys.argv[3]",
	"specs=json.loads(specs_raw)",
	"try:",
	"\trfd=os.open(chk_root,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)",
	"except OSError:",
	'\tprint("[]");sys.exit(0)',
	"try:",
	'\tsrc_fd=open_chain(rfd,[chk_name,"src"])',
	"finally:os.close(rfd)",
	"if src_fd<0:",
	'\tprint("[]");sys.exit(0)',
	"out=[]",
	"try:",
	"\tfor i,spec in enumerate(specs):",
	'\t\ttry:key=eval_key(spec.get("key",""),src_fd)',
	"\t\texcept Exception:key=None",
	"\t\tif not key:continue",
	"\t\texisting=[]",
	'\t\tfor rel in spec.get("paths") or []:',
	"\t\t\tif not safe_cache_path(rel):continue",
	'\t\t\tparts=rel.split("/")',
	"\t\t\tpfd=open_chain(src_fd,parts[:-1])",
	"\t\t\tif pfd<0:continue",
	"\t\t\ttry:",
	"\t\t\t\tst=os.lstat(parts[-1],dir_fd=pfd)",
	"\t\t\t\tif stat.S_ISREG(st.st_mode) or stat.S_ISDIR(st.st_mode):existing.append(rel)",
	"\t\t\texcept OSError:pass",
	"\t\t\tfinally:os.close(pfd)",
	"\t\tif existing:out.append({'index':i,'key':key,'paths':existing})",
	"finally:os.close(src_fd)",
	"print(json.dumps(out))",
	"'''",
	"STREAM_PY=r'''",
	"import json,os,stat,sys,tarfile",
	"def open_chain(base_fd,parts):",
	"\tcur=os.dup(base_fd)",
	"\ttry:",
	"\t\tfor part in parts:",
	"\t\t\tnxt=os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=cur)",
	"\t\t\tos.close(cur);cur=nxt",
	"\t\treturn cur",
	"\texcept OSError:",
	"\t\tos.close(cur);return -1",
	"chk_root,chk_name,paths_raw=sys.argv[1],sys.argv[2],sys.argv[3]",
	"paths=json.loads(paths_raw)",
	"rfd=os.open(chk_root,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)",
	"try:src_fd=open_chain(rfd,[chk_name,'src'])",
	"finally:os.close(rfd)",
	"if src_fd<0:sys.exit(1)",
	"tar=tarfile.open(fileobj=sys.stdout.buffer,mode='w|')",
	"def add_reg(dfd,name,rel_path):",
	"\ttry:fd=os.open(name,os.O_RDONLY|os.O_NOFOLLOW|getattr(os,'O_NONBLOCK',0),dir_fd=dfd)",
	"\texcept OSError:return",
	"\ttry:",
	"\t\tst=os.fstat(fd)",
	"\t\tif not stat.S_ISREG(st.st_mode):return",
	"\t\tti=tarfile.TarInfo(name=rel_path)",
	"\t\tti.type=tarfile.REGTYPE;ti.size=st.st_size;ti.mode=st.st_mode&0o777;ti.mtime=int(st.st_mtime)",
	"\t\twith os.fdopen(fd,'rb') as f:",
	"\t\t\tfd=-1;tar.addfile(ti,f)",
	"\tfinally:",
	"\t\tif fd>=0:os.close(fd)",
	"def walk_dir(dfd,prefix):",
	"\tti=tarfile.TarInfo(name=prefix);ti.type=tarfile.DIRTYPE;ti.mode=0o755",
	"\ttar.addfile(ti)",
	"\tfor entry in sorted(os.listdir(dfd)):",
	'\t\tif entry in ("",".","..") or entry.lower()==".git" or "/" in entry or "\\0" in entry:continue',
	'\t\tchild=prefix+"/"+entry',
	"\t\ttry:st=os.lstat(entry,dir_fd=dfd)",
	"\t\texcept OSError:continue",
	"\t\tif stat.S_ISDIR(st.st_mode):",
	"\t\t\ttry:sfd=os.open(entry,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=dfd)",
	"\t\t\texcept OSError:continue",
	"\t\t\ttry:walk_dir(sfd,child)",
	"\t\t\tfinally:os.close(sfd)",
	"\t\telif stat.S_ISREG(st.st_mode):add_reg(dfd,entry,child)",
	"\t\telif stat.S_ISLNK(st.st_mode):",
	"\t\t\ttry:tgt=os.readlink(entry,dir_fd=dfd)",
	"\t\t\texcept OSError:continue",
	'\t\t\tif tgt and not tgt.startswith("/") and "\\0" not in tgt:',
	"\t\t\t\tnorm=os.path.normpath(os.path.join(os.path.dirname(child),tgt))",
	'\t\t\t\tif norm!=".." and not norm.startswith("../") and not norm.startswith("/"):',
	"\t\t\t\t\tti=tarfile.TarInfo(name=child);ti.type=tarfile.SYMTYPE;ti.linkname=tgt;tar.addfile(ti)",
	"try:",
	"\tfor rel in paths:",
	'\t\tparts=rel.split("/")',
	"\t\tpfd=open_chain(src_fd,parts[:-1])",
	"\t\tif pfd<0:continue",
	"\t\ttry:",
	"\t\t\tst=os.lstat(parts[-1],dir_fd=pfd)",
	"\t\t\tif stat.S_ISREG(st.st_mode):add_reg(pfd,parts[-1],rel)",
	"\t\t\telif stat.S_ISDIR(st.st_mode):",
	"\t\t\t\tsfd=os.open(parts[-1],os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=pfd)",
	"\t\t\t\ttry:walk_dir(sfd,rel)",
	"\t\t\t\tfinally:os.close(sfd)",
	"\t\texcept OSError:pass",
	"\t\tfinally:os.close(pfd)",
	"finally:",
	"\ttar.close();os.close(src_fd)",
	"'''",
	'chk_root=os.environ.get("QORPERA_CHECKS_ROOT","");chk_name=os.environ.get("QORPERA_CHECKS_NAME","")',
	'root=os.environ.get("QORPERA_CHECKS_CACHE_ROOT","")',
	'groot=os.environ.get("QORPERA_CHECKS_CACHE_GLOBAL_ROOT","")',
	'limit=int(os.environ.get("QORPERA_CHECKS_CACHE_LIMIT_BYTES","8589934592"))',
	'specs=json.loads(os.environ.get("QORPERA_CHECKS_CACHES","[]"))',
	"is_root=(os.geteuid()==0)",
	"if is_root:",
	'\tuid=int(os.environ.get("QORPERA_CHECKS_UID","-1"));gid=int(os.environ.get("QORPERA_CHECKS_GID","-1"))',
	"\tif uid<200000 or gid<200000:sys.exit(2)",
	'\tdrop_kw={"user":uid,"group":gid,"extra_groups":[]}',
	"else:drop_kw={}",
	"if not chk_root or not chk_name or not root or not groot or os.path.islink(groot) or not os.path.isdir(groot):sys.exit(0)",
	"if is_root and os.lstat(groot).st_uid!=0:sys.exit(0)",
	'if os.path.dirname(root)!=groot or os.path.basename(root) in ("",".","..") or os.path.basename(root).startswith(".") or os.path.islink(root):sys.exit(0)',
	"if is_root:",
	"\tos.chown(groot,0,0);os.chmod(groot,0o755)",
	"os.makedirs(root,mode=0o755,exist_ok=True)",
	"if is_root:",
	"\tos.chown(root,0,0);os.chmod(root,0o755)",
	'clean_env={"PATH":"/usr/bin:/bin","LANG":"C.UTF-8"}',
	'ev=subprocess.run([sys.executable,"-I","-c",EVAL_PY,chk_root,chk_name,json.dumps(specs)],stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,env=clean_env,check=False,**drop_kw)',
	"plan=json.loads(ev.stdout.decode('utf-8')) if ev.returncode==0 and ev.stdout else []",
	"for item in plan:",
	'\tidx=item.get("index",-1);key=item.get("key","")',
	'\tif not isinstance(idx,int) or idx<0 or idx>=len(specs) or not isinstance(key,str) or not KEY.fullmatch(key) or key.startswith("."):continue',
	'\tspec_paths=set(p for p in (specs[idx].get("paths") or []) if safe_cache_path(p))',
	'\tallowed=[p for p in (item.get("paths") or []) if isinstance(p,str) and p in spec_paths]',
	"\tif not allowed:continue",
	"\tdest=os.path.join(root,key)",
	'\tif os.path.isfile(os.path.join(dest,".complete")) and not os.path.islink(dest):',
	'\t\tlu=os.path.join(dest,".last-used")',
	"\t\tif not os.path.islink(lu):",
	'\t\t\ttry:open(lu,"wb").close();os.utime(lu,None);os.chmod(lu,0o644)',
	"\t\t\texcept OSError:pass",
	"\t\tcontinue",
	'\tstaging=os.path.join(root,f".staging-{os.getpid()}-{secrets.token_hex(6)}")',
	'\tdata_dir=os.path.join(staging,"data")',
	"\tos.makedirs(staging,mode=0o700,exist_ok=True);os.chmod(staging,0o700)",
	"\tos.makedirs(data_dir,mode=0o755,exist_ok=True);os.chmod(data_dir,0o755)",
	"\tproc=None",
	"\ttry:",
	'\t\tproc=subprocess.Popen([sys.executable,"-I","-c",STREAM_PY,chk_root,chk_name,json.dumps(allowed)],stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,env=clean_env,**drop_kw)',
	"\t\textracted_b=0;entries_n=0",
	"\t\twith tarfile.open(fileobj=proc.stdout,mode='r|') as tar:",
	"\t\t\tfor m in tar:",
	"\t\t\t\tentries_n+=1",
	'\t\t\t\tif entries_n>250000:raise ValueError("too_many")',
	"\t\t\t\tnm=m.name",
	'\t\t\t\tif not safe_cache_path(nm) or not any(nm==p or nm.startswith(p+"/") for p in allowed):raise ValueError("bad_path")',
	'\t\t\t\tparts=nm.split("/")',
	"\t\t\t\tparent=ensure_dir(data_dir,parts[:-1])",
	"\t\t\t\tdst=os.path.join(parent,parts[-1])",
	'\t\t\t\tif os.path.islink(dst):raise ValueError("dup_link")',
	"\t\t\t\tif m.isdir():",
	"\t\t\t\t\tif not os.path.exists(dst):os.mkdir(dst,0o755)",
	'\t\t\t\t\telif not os.path.isdir(dst):raise ValueError("notdir")',
	"\t\t\t\t\tos.chmod(dst,0o755)",
	"\t\t\t\telif m.isfile():",
	'\t\t\t\t\tif m.size<0 or extracted_b+m.size>limit:raise ValueError("too_big")',
	"\t\t\t\t\tfsrc=tar.extractfile(m)",
	"\t\t\t\t\tmode=0o755 if (m.mode&0o100) else 0o644",
	"\t\t\t\t\tfd=os.open(dst,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,mode)",
	"\t\t\t\t\twith os.fdopen(fd,'wb') as fout:",
	"\t\t\t\t\t\twhile fsrc is not None:",
	"\t\t\t\t\t\t\tchunk=fsrc.read(65536)",
	"\t\t\t\t\t\t\tif not chunk:break",
	"\t\t\t\t\t\t\textracted_b+=len(chunk)",
	'\t\t\t\t\t\t\tif extracted_b>limit:raise ValueError("too_big")',
	"\t\t\t\t\t\t\tfout.write(chunk)",
	"\t\t\t\t\tos.chmod(dst,mode)",
	"\t\t\t\telif m.issym():",
	"\t\t\t\t\ttgt=m.linkname",
	'\t\t\t\t\tif not isinstance(tgt,str) or not tgt or tgt.startswith("/") or "\\0" in tgt:raise ValueError("bad_link")',
	"\t\t\t\t\tnorm=os.path.normpath(os.path.join(os.path.dirname(nm),tgt))",
	'\t\t\t\t\tif norm==".." or norm.startswith("../") or norm.startswith("/"):raise ValueError("escape_link")',
	"\t\t\t\t\tos.symlink(tgt,dst)",
	'\t\t\t\telse:raise ValueError("bad_type")',
	"\t\trc=proc.wait()",
	'\t\tif rc!=0 or entries_n==0:raise RuntimeError("stream_failed")',
	'\t\tfor mf in (".complete",".last-used"):',
	"\t\t\tmp=os.path.join(staging,mf)",
	'\t\t\topen(mp,"wb").close();os.chmod(mp,0o644)',
	"\t\tos.chmod(staging,0o755)",
	"\t\ttry:os.rename(staging,dest)",
	"\t\texcept OSError:shutil.rmtree(staging,ignore_errors=True)",
	"\texcept Exception:",
	"\t\tif proc is not None and proc.poll() is None:",
	"\t\t\ttry:proc.kill();proc.wait()",
	"\t\t\texcept Exception:pass",
	"\t\tshutil.rmtree(staging,ignore_errors=True)",
	"now=time.time();held={};entries=[]",
	"for repo in os.listdir(groot):",
	"\trp=os.path.join(groot,repo)",
	"\ttry:rs=os.lstat(rp)",
	"\texcept OSError:continue",
	'\tif repo.startswith(".staging-"):',
	"\t\tif now-max(rs.st_mtime,rs.st_ctime)>3600:shutil.rmtree(rp,ignore_errors=True)",
	"\t\tcontinue",
	"\tif os.path.islink(rp) or not os.path.isdir(rp):continue",
	"\tfor kn in os.listdir(rp):",
	"\t\tep=os.path.join(rp,kn)",
	"\t\ttry:es=os.lstat(ep)",
	"\t\texcept OSError:continue",
	'\t\tif kn.startswith(".staging-"):',
	"\t\t\tif now-max(es.st_mtime,es.st_ctime)>3600:shutil.rmtree(ep,ignore_errors=True)",
	"\t\t\tcontinue",
	"\t\tseen=set();eb=0;stack=[ep]",
	"\t\twhile stack:",
	"\t\t\tc=stack.pop()",
	"\t\t\ttry:cs=os.lstat(c)",
	"\t\t\texcept OSError:continue",
	"\t\t\tik=(cs.st_dev,cs.st_ino)",
	"\t\t\tif ik not in seen:",
	"\t\t\t\tseen.add(ik);b=cs.st_blocks*512;eb+=b",
	"\t\t\t\tif ik in held:held[ik][1]+=1",
	"\t\t\t\telse:held[ik]=[b,1]",
	"\t\t\tif os.path.isdir(c) and not os.path.islink(c):",
	"\t\t\t\ttry:",
	"\t\t\t\t\tfor ch in os.listdir(c):stack.append(os.path.join(c,ch))",
	"\t\t\t\texcept OSError:pass",
	'\t\tlu=os.path.join(ep,".last-used")',
	"\t\ttry:ut=os.lstat(lu).st_mtime if os.path.isfile(lu) and not os.path.islink(lu) else es.st_mtime",
	"\t\texcept OSError:ut=0.0",
	"\t\tentries.append((ut,ep,rp,seen,eb))",
	"total=sum(v[0] for v in held.values())",
	"entries.sort(key=lambda x:(x[0],x[1]))",
	"for ut,ep,rp,seen,eb in entries:",
	"\tif total<=limit:break",
	"\tif eb==0:continue",
	"\tshutil.rmtree(ep,ignore_errors=True)",
	"\tfor ik in seen:",
	"\t\theld[ik][1]-=1",
	"\t\tif held[ik][1]==0:total-=held[ik][0]",
	"\ttry:",
	"\t\tif not os.listdir(rp):os.rmdir(rp)",
	"\texcept OSError:pass",
	"QORPERA_CACHE_SAVE_EOF",
].join("\n");

const CODE_CHECKS_PERSIST = [
	"set -eu",
	...CODE_CHECKS_NEWER_RUN,
	'python3 -I - "$QORPERA_CHECKS_ROOT/$QORPERA_CHECKS_NAME/src" <<\x27QORPERA_PERSIST_EOF\x27',
	"import fnmatch,json,os,re,shutil,sys",
	"E=os.environb",
	'src=sys.argv[1];pdir=os.environ["QORPERA_CHECKS_PERSIST_DIR"];prel=os.environ["QORPERA_CHECKS_PERSIST_REL"]',
	'nonce=os.environ["QORPERA_CHECKS_ARTIFACT_NONCE"];spec=json.loads(os.environ["QORPERA_CHECKS_PERSIST_SPEC"])',
	'NAME=re.compile(rb"[A-Za-z_][A-Za-z0-9_]{0,127}");WHSEC=re.compile(rb"whsec_[A-Za-z0-9_-]{8,}")',
	"SECRETS=[]",
	'for nm in E.get(b"QORPERA_CHECKS_SECRET_NAMES",b"").split():',
	"\tv=E.get(nm) if NAME.fullmatch(nm) else None",
	"\tif v is not None and len(v)>=8:SECRETS.append(v)",
	"SECRETS.sort(key=len,reverse=True)",
	"def scrub(b):",
	'\tfor v in SECRETS:b=b.replace(v,b"***")',
	'\treturn WHSEC.sub(b"***",b)',
	"def exp_braces(p):",
	'\to=p.find("{")',
	"\tif o<0:return [p]",
	'\tc=p.find("}",o+1)',
	"\tif c<0:return [p]",
	"\tout=[]",
	'\tfor a in p[o+1:c].split(","):',
	"\t\tfor t in exp_braces(p[c+1:]):",
	"\t\t\tout.append(p[:o]+a+t)",
	"\t\t\tif len(out)>=32:return out",
	"\treturn out",
	"def match_one(pat,rel):",
	'\tpp=pat.split("/");sp=rel.split("/");memo={}',
	"\tdef dp(i,j):",
	"\t\tif (i,j) in memo:return memo[(i,j)]",
	"\t\tif i==len(pp):r=(j==len(sp))",
	'\t\telif pp[i]=="**":r=dp(i+1,j) or (j<len(sp) and dp(i,j+1))',
	"\t\telif j<len(sp):r=fnmatch.fnmatchcase(sp[j],pp[i]) and dp(i+1,j+1)",
	"\t\telse:r=False",
	"\t\tmemo[(i,j)]=r;return r",
	"\treturn dp(0,0)",
	"def match_glob(pat,rel):return any(match_one(e,rel) for e in exp_braces(pat))",
	"def safe_rel(p):",
	'\treturn isinstance(p,str) and p and p!="." and not p.startswith("/") and not p.endswith("/") and "\\\\" not in p and "\\0" not in p and all(x not in ("",".","..") and x.lower()!=".git" for x in p.split("/"))',
	"rem=10*1024*1024;written=0;total_b=0;first_log=None;emitted=0;emitted_cap=512*1024",
	"def put(dst,data):",
	"\tglobal rem,written,total_b",
	"\tif rem<=0:return False",
	"\tif len(data)>rem:data=data[-rem:]",
	"\tos.makedirs(os.path.dirname(dst),exist_ok=True)",
	'\twith open(dst,"wb") as f:f.write(data)',
	"\trem-=len(data);total_b+=len(data);written+=1;return True",
	'for lg in spec.get("logs") or []:',
	'\tfp=lg.get("src","");nm=lg.get("name","")',
	"\tif not fp or not safe_rel(nm) or os.path.islink(fp) or not os.path.isfile(fp):continue",
	"\ttry:",
	"\t\tsz=os.lstat(fp).st_size",
	'\t\twith open(fp,"rb") as f:',
	"\t\t\tif sz>rem and rem>0:f.seek(sz-rem)",
	"\t\t\tdata=scrub(f.read(max(0,rem)))",
	'\t\tif put(os.path.join(pdir,nm),data) and first_log is None:first_log=prel+"/"+nm',
	"\texcept OSError:pass",
	'arts=spec.get("artifacts") or []',
	"if arts and os.path.isdir(src):",
	"\tfiles=[]",
	"\tfor dp,dns,fns in os.walk(src,followlinks=False):",
	'\t\tdns[:]=[d for d in sorted(dns) if d.lower()!=".git" and not os.path.islink(os.path.join(dp,d))]',
	"\t\tfor fn in sorted(fns):",
	"\t\t\tfp=os.path.join(dp,fn)",
	"\t\t\tif os.path.islink(fp) or not os.path.isfile(fp):continue",
	'\t\t\trel=os.path.relpath(fp,src).replace(os.sep,"/")',
	"\t\t\tfiles.append((rel,fp))",
	"\tfor art in arts:",
	'\t\tchk=art.get("check","");fmt=art.get("format","raw");pats=art.get("paths") or [];ext=bool(art.get("extract"))',
	"\t\tif not safe_rel(chk):continue",
	"\t\tcount=0",
	"\t\tfor rel,fp in files:",
	"\t\t\tif count>=100:break",
	"\t\t\tif not any(match_glob(p,rel) for p in pats):continue",
	"\t\t\tcount+=1",
	"\t\t\ttry:",
	'\t\t\t\twith open(fp,"rb") as f:raw=scrub(f.read(min(2*1024*1024,max(rem,emitted_cap))))',
	'\t\t\t\tif rem>0:put(os.path.join(pdir,"artifacts",chk,rel),raw)',
	'\t\t\t\tif ext and fmt in ("junit","tap","vitest-json") and emitted<emitted_cap:',
	"\t\t\t\t\tchunk=raw[:emitted_cap-emitted]",
	"\t\t\t\t\temitted+=len(chunk)",
	'\t\t\t\t\tsys.stdout.write(f"QORPERA_ARTIFACT_BEGIN:{nonce}:{fmt}\\n")',
	'\t\t\t\t\tsys.stdout.write(chunk.decode("utf-8",errors="replace"))',
	'\t\t\t\t\tsys.stdout.write(f"\\nQORPERA_ARTIFACT_END:{nonce}\\n")',
	"\t\t\texcept OSError:pass",
	"if written>0:",
	"\ttry:",
	'\t\tkeep=max(1,int(os.environ.get("QORPERA_CHECKS_PERSIST_KEEP_RUNS","20")))',
	"\t\truns_root=os.path.dirname(pdir);cur=os.path.basename(pdir)",
	"\t\tif not os.path.islink(runs_root) and os.path.isdir(runs_root):",
	"\t\t\told=[]",
	"\t\t\tfor nm in os.listdir(runs_root):",
	"\t\t\t\tif nm==cur:continue",
	"\t\t\t\tep=os.path.join(runs_root,nm)",
	"\t\t\t\ttry:old.append((os.lstat(ep).st_mtime,nm,ep))",
	"\t\t\t\texcept OSError:pass",
	"\t\t\told.sort(key=lambda x:(x[0],x[1]),reverse=True)",
	"\t\t\tfor _,_,ep in old[keep-1:]:",
	"\t\t\t\tif os.path.islink(ep) or not os.path.isdir(ep):",
	"\t\t\t\t\ttry:os.unlink(ep)",
	"\t\t\t\t\texcept OSError:pass",
	"\t\t\t\telse:shutil.rmtree(ep,ignore_errors=True)",
	"\texcept Exception:pass",
	'\tsys.stdout.write(f"QORPERA_PERSISTED:{nonce}:"+json.dumps({"dir":prel,"log":first_log,"files":written,"bytes":total_b})+"\\n")',
	"QORPERA_PERSIST_EOF",
].join("\n");

const CODE_CHECKS_PERSIST_DROP = [
	"set -eu",
	...CODE_CHECKS_NEWER_RUN,
	`if [ -n "\${QORPERA_CHECKS_PERSIST_DIR:-}" ]; then rm -rf -- "$QORPERA_CHECKS_PERSIST_DIR"; fi`,
].join("\n");
/** One check: its own command from its folder of the copy, stdin closed, its whole output also kept on the machine's
 * disk, and its own exit code. A check of a run that is not the newest exits 91 and runs nothing. Its folder is most
 * often gone by then (the newer copy removed it, and the guest agent cannot start a command in a folder that is not
 * there), but the removal is best effort, and a start may land before the newer copy ran: the rule holds either way. */
const CODE_CHECKS_CHECK = [
	...CODE_CHECKS_NEWER_RUN,
	'cd -- "$QORPERA_CHECK_CWD" || exit 2',
	'bash --noprofile --norc -c "$QORPERA_CHECK_RUN" </dev/null 2>&1 | tee -- "$QORPERA_CHECK_LOG"',
	// bash's own placeholder, not the template's.
	`exit "\${PIPESTATUS[0]}"`,
].join("\n");
/** The folder name of a run of a session's checks: its turn's sequence and its attempt, zero-padded so that names sort
 * by time as bytes; null for numbers that do not fit. */
function codeChecksRunName(sequence: number, attempt: number): string | null {
	if (!Number.isSafeInteger(sequence) || sequence < 0 || sequence > 9_999_999_999) return null;
	if (!Number.isSafeInteger(attempt) || attempt < 0 || attempt > 9_999) return null;
	return `${String(sequence).padStart(10, "0")}-${String(attempt).padStart(4, "0")}`;
}
/** What the machine's boundary after a site's collect says of it, as `publish` judges a boundary (every view of the
 * machine; STEP4-BUILD.md 2's table): `saved` (every read released, every view saved); `carries` (the save check
 * refused paths for one of the machine's secret values, and nothing else held them); or why it was not saved, as the
 * code of a missed site: still checking, refused only as not checked, or held otherwise. */
function siteBoundaryJudged(boundary: CodingFolderBoundary): string {
	if (codingFolderBoundaryChecking(boundary)) return "CODE_SITE_BOUNDARY_CHECKING";
	const held = codingFolderBoundaryHeld(boundary);
	if (held === undefined) return "saved";
	const refusal = codingFolderSaveRefused(boundary);
	if (refusal === "carries") return "carries";
	return refusal === "unchecked" ? "CODE_SITE_BOUNDARY_UNCHECKED" : `CODE_SITE_BOUNDARY_HELD:${held}`;
}
/** The copy's own time limit. */
const CODE_CHECKS_COPY_MS = 300_000;
const PREVIEW_BUILD_CHECK_NAME = "preview";
const CODE_CHECKS_WAIT_MS = 5_000;
const CODE_CHECKS_DIFF_MS = 30_000;
const CODE_CHECKS_CACHE_SAVE_MS = 120_000;
const CODE_CHECKS_PERSIST_MS = 60_000;
const CODE_CHECKS_PERSIST_DROP_MS = 30_000;

function parsePersistedChecksOutput(
	output: string,
	nonce: string,
	expectedRel: string,
): {
	readonly artifacts: readonly { readonly format: CodeCheckArtifactFormat; readonly content: string }[];
	readonly persistedDir?: string;
	readonly persistedLog?: string;
} {
	const artifacts: { format: CodeCheckArtifactFormat; content: string }[] = [];
	const beginPrefix = `QORPERA_ARTIFACT_BEGIN:${nonce}:`;
	const endMarker = `\nQORPERA_ARTIFACT_END:${nonce}`;
	let cursor = 0;
	for (;;) {
		const start = output.indexOf(beginPrefix, cursor);
		if (start < 0) break;
		const lineEnd = output.indexOf("\n", start);
		if (lineEnd < 0) break;
		const format = output.slice(start + beginPrefix.length, lineEnd).trim();
		const end = output.indexOf(endMarker, lineEnd + 1);
		if (end < 0) break;
		if (format === "junit" || format === "tap" || format === "vitest-json") {
			artifacts.push({ format, content: output.slice(lineEnd + 1, end) });
		}
		cursor = end + endMarker.length;
	}
	const persistedPrefix = `QORPERA_PERSISTED:${nonce}:`;
	const markerIndex = output.lastIndexOf(persistedPrefix);
	let persistedDir: string | undefined;
	let persistedLog: string | undefined;
	if (markerIndex >= 0) {
		const lineEnd = output.indexOf("\n", markerIndex);
		const rawJson = output.slice(markerIndex + persistedPrefix.length, lineEnd < 0 ? undefined : lineEnd).trim();
		try {
			const parsed = JSON.parse(rawJson) as { dir?: unknown; log?: unknown };
			if (parsed && typeof parsed === "object") {
				if (typeof parsed.dir === "string" && parsed.dir === expectedRel) persistedDir = parsed.dir;
				if (typeof parsed.log === "string" && parsed.log.startsWith(`${expectedRel}/`)) persistedLog = parsed.log;
			}
		} catch {
			persistedDir = undefined;
			persistedLog = undefined;
		}
	}
	return { artifacts, persistedDir, persistedLog };
}
/** What the wall budget gives each check beyond its own limit. */
const CODE_CHECKS_SLACK_MS = 60_000;
const CODE_CHECKS_POLL_STEPS_MS: readonly number[] = [250, 500, 1_000, 2_000];
const CODE_CHECKS_UNANSWERED_READS = 20;
const CODE_CHECKS_UNANSWERED_WINDOW_MS = 60_000;
function codeChecksPollDelayMs(attempt: number, configuredPollMs: number | undefined): number {
	if (configuredPollMs !== undefined) return configuredPollMs;
	return CODE_CHECKS_POLL_STEPS_MS[Math.min(attempt, CODE_CHECKS_POLL_STEPS_MS.length - 1)] as number;
}
/** How long a running check is cancelled and read for, once the turn gave up, the budget passed or its calls went
 * unanswered, until its end is confirmed; and how long an earlier run's command left unconfirmed is cancelled and read
 * again before a new run. Within the executor's stop (TimeoutStopSec 75 s, its cleanup 45 s). */
const CODE_CHECKS_STOP_MS = 20_000;
/** A check's command in its run's answer and the change record, at most this many bytes. */
const CODE_CHECKS_RUN_BYTES = 200;
/** The site's collect's own time limit (own code storage, step 4; STEP4-BUILD.md 2). */
const CODE_SITE_COLLECT_MS = 120_000;
/** How long the boundary after the collect is asked for at most, while it is checking or does not answer. */
const CODE_SITE_BOUNDARY_MS = 120_000;
/** The drop's own time limit: it removes at most a site's objects. */
const CODE_SITE_DROP_MS = 60_000;
/** What the wall budget of a run that takes a site gives it beyond its checks': the collect's 120 s, and 120 s for the
 * boundary and the drop. */
const CODE_SITE_BUDGET_MS = 240_000;
/** The names the folder command transport sets in every command's environment after its secrets
 * (coding-folder-command-transport.ts, `sessionEnvironment`): a secret of one of these names never reaches a command
 * with its own value, so the collect is not given it to look for. The machine's package caches are not among them: a
 * run gets them only on a machine whose agent made them (packageCacheEnvironment), and then they are in the run's own
 * environment, whose names the collect leaves out too; on any other machine a company value of such a name reaches the
 * command, and the collect looks for it. */
const CODING_FOLDER_SESSION_NAMES: ReadonlySet<string> = new Set([
	"HOME",
	"USER",
	"LOGNAME",
	"SHELL",
	"PATH",
	"LANG",
	"TMPDIR",
	"XDG_RUNTIME_DIR",
	"DBUS_SESSION_BUS_ADDRESS",
	"DOCKER_HOST",
]);
/** The machine's package caches for a session's commands (CODING_PACKAGE_CACHE_ENVIRONMENT; own code storage, step 6),
 * only when its machine's agent said at this turn's mount that it made them: an agent from before, or one that could
 * not make them, leaves every command as it was before the caches. They win over a company value of the same name. */
function packageCacheEnvironment(ready: Prepared): Readonly<Record<string, string>> {
	return ready.folder?.packageCaches ? CODING_PACKAGE_CACHE_ENVIRONMENT : {};
}
/** A refusal of a check's run authority: the turn's, the machine's or its disk's. */
class CodingChecksUnauthorized extends Error {
	constructor(cause: unknown) {
		super(errorCodeOf(cause), { cause });
	}
}
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
function receiptRecord(value: unknown): Record<string, unknown> {
	if (!isRecord(value)) throw new Error("CODING_HOST_RECEIPT_INVALID");
	return value;
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
const CODING_OBSERVE_CONCURRENCY = 4;
const CODING_HOUSEKEEP_CONCURRENCY = 4;

async function mapBounded<T, R>(
	items: readonly T[],
	concurrency: number,
	signal: AbortSignal,
	work: (item: T, signal: AbortSignal) => Promise<R>,
): Promise<R[]> {
	if (items.length === 0) return [];
	signal.throwIfAborted();
	const scope = new AbortController();
	const forward = (): void => scope.abort(signal.reason);
	signal.addEventListener("abort", forward, { once: true });
	const results = new Array<R>(items.length);
	let cursor = 0;
	let firstError: { value: unknown } | undefined;
	const worker = async (): Promise<void> => {
		while (!firstError && !scope.signal.aborted) {
			const index = cursor++;
			if (index >= items.length) return;
			try {
				results[index] = await work(items[index]!, scope.signal);
			} catch (error) {
				if (!firstError) {
					firstError = { value: error };
					scope.abort(error);
				}
				return;
			}
		}
	};
	try {
		await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
	} finally {
		signal.removeEventListener("abort", forward);
	}
	if (firstError) throw firstError.value;
	signal.throwIfAborted();
	return results;
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
	readonly autoRedeploy?: CodingExecutorHost["autoRedeploy"];
	// WHY: unresolved hard-NFS syscalls keep libuv workers after caller timeout; one chain caps stuck workers at 1.
	#storageWork: Promise<unknown> = Promise.resolve();
	readonly #machineWork = new Map<string, Promise<unknown>>();
	readonly #keptCommands = new Map<string, { turn: number; command: string }>();
	readonly #prepared = new Map<string, Prepared>();
	readonly #attached = new Map<string, Attached>();
	readonly #attachments = new Map<string, Attachment>();
	readonly #samples = new Map<string, SessionSample>();
	readonly #cpuHighSamples = new Map<string, { bootId: string; count: number }>();
	readonly #folderUidCache = new Map<string, { bootId: string; uid: number | null }>();
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
	// The two memories of the commands of a session's runs of its checks (release review r1 and review rounds 5 and 6,
	// F1), by one rule: every command the host did not see end for certain is cancelled and read again after the next
	// run's fence stands, before that run's first check. For certain: its start was answered, and a later receipt showed
	// it ended (succeeded, failed, cancelled, machine_stopped). They live in this process: an executor that restarts
	// forgets them, and then only the scripts' own rules and the copy's end of earlier runs' processes hold.
	readonly #checksMayRun = new Map<string, Set<string>>();
	/** Per session, every command not seen to end for certain: a start never answered (its `cancelled` may be
	 * provisional, and the start may land at any time), a stop not confirmed, a receipt or a `hidden` that says
	 * `unconfirmed`. Looked at again after the next run's fence stands, before its first check (#checksLookAgain). */
	readonly #checksUncertain = new Map<string, Set<string>>();
	readonly #setupLifecycle: CodingSetupLifecycle;
	readonly #sessionSetups = new Map<string, { env: Readonly<Record<string, string>>; digest: string }>();
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
		if (options.autoRedeploy) this.autoRedeploy = options.autoRedeploy;
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
		this.#setupLifecycle = options.setupLifecycle ?? new CodingSetupLifecycle();
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
	#exclusive<T>(machineId: string, signal: AbortSignal, use: () => Promise<T>, cancel?: AbortSignal): Promise<T> {
		const previous = this.#machineWork.get(machineId) ?? Promise.resolve();
		const queueAbort = cancel ? new AbortController() : undefined;
		const onCancel = queueAbort ? () => queueAbort.abort(cancel?.reason) : undefined;
		if (cancel && onCancel) {
			if (cancel.aborted) onCancel();
			else cancel.addEventListener("abort", onCancel, { once: true });
		}
		const clearCancel = () => {
			if (cancel && onCancel) cancel.removeEventListener("abort", onCancel);
		};
		const work = previous
			.catch(() => undefined)
			.then(() => {
				clearCancel();
				signal.throwIfAborted();
				cancel?.throwIfAborted();
				return use();
			});
		this.#machineWork.set(machineId, work);
		void work
			.catch(() => undefined)
			.finally(() => {
				clearCancel();
				if (this.#machineWork.get(machineId) === work) this.#machineWork.delete(machineId);
			});
		if (!queueAbort) return abortable(work, signal);
		return withAbortScopes([signal, queueAbort.signal], (wait) => abortable(work, wait));
	}
	async #storageTask<T>(use: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
		const limit = AbortSignal.timeout(this.#options.storageStepTimeoutMs ?? CODING_STORAGE_STEP_MS);
		const checked = AbortSignal.any([...(signal ? [signal] : []), limit]);
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
			if (limit.aborted && !signal?.aborted) throw new Error("CODING_HOST_STORAGE_TIMEOUT", { cause: error });
			throw error;
		} finally {
			if (abort) checked.removeEventListener("abort", abort);
		}
	}
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
	async #run(
		claim: CodingSessionClaim,
		machine: Readonly<LxdCodingMachineBinding>,
		storage: Readonly<CloudCodingStorageBinding>,
		signal: AbortSignal,
		prepareStorage = false,
	): Promise<CodingMachineAdmissionReceipt> {
		const started = performance.now();
		const plan = lxdCodingMachinePlan(machine);
		const raw = await this.#call(
			"qorpera_authorize_coding_machine_run",
			{
				p_worker_id: claim.workerId,
				p_lease_token: claim.leaseToken,
				p_binding_text: plan.text,
				p_storage: storage,
				p_machine_id_sha256: this.#options.machineIdSha256,
			},
			signal,
		);
		return this.#verifyRunAuthority(claim, machine, storage, raw, started, signal, prepareStorage);
	}
	async #verifyRunAuthority(
		claim: CodingSessionClaim,
		machine: Readonly<LxdCodingMachineBinding>,
		storage: Readonly<CloudCodingStorageBinding>,
		raw: unknown,
		started: number,
		signal: AbortSignal,
		prepareStorage = false,
	): Promise<CodingMachineAdmissionReceipt> {
		const plan = lxdCodingMachinePlan(machine);
		const value = receiptRecord(raw);
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
		const value = receiptRecord(
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
		extra?: {
			claimStandby?: CodingMachineReconcileOptions["claimStandby"];
			cancel?: AbortSignal;
		},
	): Promise<"running" | "stopped" | "absent" | "deleted"> {
		const checked = AbortSignal.any([
			signal,
			AbortSignal.timeout(desiredState === "running" ? 300000 : CODING_VM_STOP_BUDGET_MS),
		]);
		let sawPending = false;
		for (let attempt = 0; ; attempt++) {
			checked.throwIfAborted();
			if (!sawPending) extra?.cancel?.throwIfAborted();
			const journalRoot = sawPending
				? await this.#directory("machines", checked)
				: await withAbortScopes([checked, extra?.cancel], (beforeDispatch) =>
						this.#directory("machines", beforeDispatch),
					);
			if (!sawPending) extra?.cancel?.throwIfAborted();
			let result: Awaited<ReturnType<typeof reconcileCodingMachine>>;
			try {
				result = await reconcileCodingMachine({
					plan: journal,
					journalRoot,
					desiredState,
					client: this.#options.client,
					authorize,
					signal: checked,
					cancel: extra?.cancel,
					plug: this.#options.agentPlug,
					stoppedFromOutside,
					starting,
					claimStandby: extra?.claimStandby,
					projectAllowsAgentCard: (project, read) => this.#options.client.allowsAgentCard(project, read),
				});
			} catch (error) {
				if (sawPending && error instanceof CodingMachineUnavailable && !checked.aborted) {
					await this.#settleAccepted(journal, checked);
				}
				throw error;
			}
			checked.throwIfAborted();
			if (result.state === "pending") {
				sawPending = true;
				if (
					!(await waitPendingLxdOperation(
						this.#options.client,
						{ project: journal.project, instanceName: journal.name, operationId: result.pendingOperationId },
						checked,
					))
				) {
					await setTimeout(pollBackoffMs(attempt), undefined, { signal: checked });
				}
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
	async #settleAccepted(journal: CodingMachineJournalPlan, signal: AbortSignal): Promise<void> {
		await withTimeoutScope(signal, 30000, async (budget) => {
			for (let attempt = 0; ; attempt++) {
				if (budget.aborted) return;
				try {
					const journalRoot = await this.#directory("machines", budget);
					const state = await settleAcceptedCodingMachine({
						plan: journal,
						journalRoot,
						client: this.#options.client,
						signal: budget,
					});
					if (state !== "pending") return;
					await setTimeout(pollBackoffMs(attempt), undefined, { signal: budget });
				} catch {
					return;
				}
			}
		});
	}
	/** The member's machine for this turn, as SQL planned it from the policy the
	 * executor itself runs with. */
	async #plan(
		claim: CodingSessionClaim,
		signal: AbortSignal,
		setupDigest?: string,
	): Promise<{
		machine: Readonly<LxdCodingMachineBinding>;
		snapshotId: string | null;
		snapshotImageFingerprint: string | null;
		snapshotBuildNeeded: boolean;
	}> {
		const planArgs: Record<string, unknown> = {
			p_worker_id: claim.workerId,
			p_lease_token: claim.leaseToken,
			p_machine_id_sha256: this.#options.machineIdSha256,
		};
		if (setupDigest !== undefined) planArgs.p_setup_digest = setupDigest;
		const value = receiptRecord(await this.#call("qorpera_plan_coding_machine", planArgs, signal));
		if (value.state === "refused") {
			const reason = String(value.reason ?? "");
			if (WAITABLE.has(reason)) throw new CodingMachineUnavailable(reason);
			throw new Error("CODING_HOST_MACHINE_PLAN_REFUSED");
		}
		if (value.schema !== "qorpera.coding-machine-plan/v1" || value.state !== "planned")
			throw new Error("CODING_HOST_MACHINE_PLAN_INVALID");
		const parsed = this.#validatePlannedMachine(claim, value, true);
		if (parsed.snapshotImageFingerprint !== null) {
			const hasLocalImage = this.#options.client.hasImage
				? await this.#options.client.hasImage(parsed.machine.project, parsed.snapshotImageFingerprint, signal)
				: false;
			if (!hasLocalImage) {
				const existing = await this.#options.client.getInstance(
					parsed.machine.project,
					lxdCodingMachineName(parsed.machine.machineId),
					signal,
				);
				if (!existing) {
					// WHY: Fail closed to the pinned base image when a SQL-selected snapshot image is absent from local LXD.
					const fallbackRaw = receiptRecord(
						await this.#call(
							"qorpera_fallback_coding_machine_base_image",
							{
								p_worker_id: claim.workerId,
								p_lease_token: claim.leaseToken,
								p_machine_id: parsed.machine.machineId,
								p_machine_id_sha256: this.#options.machineIdSha256,
							},
							signal,
						),
					);
					if (fallbackRaw.schema !== "qorpera.coding-machine-plan/v1" || fallbackRaw.state !== "planned")
						throw new Error("CODING_HOST_MACHINE_PLAN_INVALID");
					return this.#validatePlannedMachine(claim, fallbackRaw, false);
				}
			}
		}
		return parsed;
	}
	#validatePlannedMachine(
		claim: CodingSessionClaim,
		value: Record<string, unknown>,
		allowSnapshot: boolean,
	): {
		machine: Readonly<LxdCodingMachineBinding>;
		snapshotId: string | null;
		snapshotImageFingerprint: string | null;
		snapshotBuildNeeded: boolean;
	} {
		const machine = lxdCodingMachinePlan(value.binding as LxdCodingMachineBinding).binding;
		const {
			schema: _schema,
			machineId,
			companyId,
			environmentId,
			memberUserId,
			imageFingerprint,
			...restPolicy
		} = machine;
		const { imageFingerprint: baseImageFingerprint, ...restVmPolicy } = this.#options.vmPolicy;
		const snapshotId =
			typeof value.snapshotId === "string" && UUID_PATTERN.test(value.snapshotId) ? value.snapshotId : null;
		const snapshotImageFingerprint =
			typeof value.snapshotImageFingerprint === "string" && SHA.test(value.snapshotImageFingerprint)
				? value.snapshotImageFingerprint
				: null;
		const isValidBase = imageFingerprint === baseImageFingerprint;
		const isValidSnapshot =
			allowSnapshot &&
			snapshotId !== null &&
			snapshotImageFingerprint !== null &&
			imageFingerprint === snapshotImageFingerprint;
		if (
			machineId !== value.machineId ||
			companyId !== claim.profileId ||
			environmentId !== claim.environmentId ||
			memberUserId !== claim.ownerUserId ||
			!isDeepStrictEqual(restPolicy, restVmPolicy) ||
			(!isValidBase && !isValidSnapshot)
		)
			throw new Error("CODING_HOST_MACHINE_POLICY_DIFFERS");
		return {
			machine,
			snapshotId: isValidSnapshot ? snapshotId : null,
			snapshotImageFingerprint: isValidSnapshot ? snapshotImageFingerprint : null,
			snapshotBuildNeeded: value.snapshotBuildNeeded === true,
		};
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
		if (boot.uid !== 0 || boot.gid !== 0 || boot.mode !== 0o444 || !UUID_PATTERN.test(bootId))
			throw new Error("CODING_HOST_BOOT_UNCONFIRMED");
		// WHY: Read and verify all four immutable guest helpers concurrently to cut cold boot LXD RTTs from 4 to 1.
		const helperFiles = [
			["cloud-coding-command-guest.mjs", this.#options.guest.commandHelperSha256],
			["cloud-coding-git-guest.mjs", this.#options.guest.gitHelperSha256],
			["cloud-coding-watchdog.mjs", this.#options.guest.watchdogHelperSha256],
			["cloud-coding-storage-guest.mjs", this.#options.guest.storageHelperSha256],
		] as const;
		const verified = await Promise.all(
			helperFiles.map(([file]) =>
				client.readInstanceFile(
					machine.project,
					name,
					`/opt/qorpera-coding/${file}`,
					CODING_GUEST_HELPER_MAX_BYTES,
					signal,
				),
			),
		);
		for (let i = 0; i < helperFiles.length; i++) {
			const content = verified[i]!;
			const [, hash] = helperFiles[i]!;
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
		const root = await this.#directory("guests", signal),
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
		const folder = this.#options.folder;
		let discoveredSetup: ParsedCodingSetup | null = null;
		if (
			folder?.repositories?.readSetup &&
			typeof claim.baseSha === "string" &&
			/^[0-9a-f]{40}$/.test(claim.baseSha)
		) {
			discoveredSetup = await folder.repositories.readSetup(
				{
					claim,
					assertAuthorized: async (checked) => {
						await this.#assertSessionAuthorized(claim, checked);
					},
				},
				claim.baseSha,
				signal,
			);
			if (discoveredSetup.refused) {
				const detail = discoveredSetup.problems
					.filter((problem) => problem.effect === "refused")
					.slice(0, 5)
					.map((problem) => `${problem.at || "/"}: ${problem.message}`)
					.join("; ");
				throw new CodingWorkspaceFailed(
					"CODING_SETUP_REFUSED",
					`Repository environment setup file (${discoveredSetup.file ?? "environment.json"}) is invalid: ${detail || "refused"}`,
				);
			}
		}
		const planned = await this.#plan(claim, signal, discoveredSetup?.setupDigest);
		const machine = planned.machine;
		const storage = lxdCodingSessionStorage(machine, this.#placement, claim.workerId);
		const journal = lxdCodingMachineJournalPlan(machine, this.#placement);
		if (folder) {
			const workspace = await this.#prepareFolder(folder, claim, turn, machine, storage, journal, signal);
			try {
				await this.#afterFolderAttach(folder, claim, planned, journal, discoveredSetup, signal);
			} catch (error) {
				if (this.#prepared.get(claim.workerId)?.claim.leaseToken === claim.leaseToken) {
					this.#prepared.delete(claim.workerId);
				}
				this.#sessionSetups.delete(claim.workerId);
				throw error;
			}
			return workspace;
		}
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
			const seeded = receiptRecord((await readRecord(join(root, seededName))).value);
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
		const root = await this.#directory("git", signal);
		const baseName = `${claim.workerId}.base.json`;
		let baseSha: string;
		try {
			baseSha = String(receiptRecord((await readRecord(join(root, baseName))).value).baseSha);
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
			baseSha = String(receiptRecord((await readRecord(join(root, baseName))).value).baseSha);
		}
		const pinned = receiptRecord((await readRecord(join(root, baseName))).value);
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
	async #prepareFolder(
		folder: FolderOptions,
		claim: CodingSessionClaim,
		turn: CodingTurnState,
		machine: Readonly<LxdCodingMachineBinding>,
		storage: Readonly<CloudCodingStorageBinding>,
		journal: CodingMachineJournalPlan,
		signal: AbortSignal,
	): Promise<CodingWorkspace> {
		const scope = codingTurnScope(claim.workerId, machine.machineId, claim.sequence);
		if (scope.requestId !== turn.turnId) throw new Error("CODING_HOST_TURN_ID_DIFFERS");
		const initialReceipt = await this.#run(claim, machine, storage, signal, true);
		const initialUid = initialReceipt.guestUid;
		if (initialUid === null || initialUid < CODING_GUEST.minUid || initialUid > CODING_GUEST.maxUid)
			throw new Error("CODING_FOLDER_SESSION_UID_MISSING");
		const overlap = new AbortController();
		const overlapSignal = AbortSignal.any([signal, overlap.signal]);
		const authorize = async () => {
			await this.#run(claim, machine, storage, overlapSignal);
		};
		const startPromise = this.#startFolder(
			folder,
			claim,
			machine,
			storage,
			journal,
			signal,
			undefined,
			true,
			overlap.signal,
		);
		const repoPromise = (async (): Promise<{ root: string; baseSha: string; cwd: string }> => {
			const { root, baseSha } = await this.#base(claim, turn, authorize, overlapSignal);
			const { cwd } = await (folder.repositories ?? codingFolderNoRepositories).prepare(
				this.#repositorySession(claim, machine, storage, initialUid, baseSha, root),
				overlapSignal,
			);
			return { root, baseSha, cwd };
		})();
		let started: { bootId: string; uid: number; starts: number };
		let repo: { root: string; baseSha: string; cwd: string };
		try {
			[started, repo] = await Promise.all([
				startPromise.catch((error: unknown) => {
					overlap.abort(error);
					throw error;
				}),
				repoPromise.catch((error: unknown) => {
					overlap.abort(error);
					throw error;
				}),
			]);
		} catch (error) {
			await Promise.allSettled([startPromise, repoPromise]);
			throw error;
		}
		const { baseSha, cwd } = repo;
		if (folder.repositories && !claim.worktreeCreatedAt) {
			await this.#call(
				"qorpera_record_coding_worktree_created",
				{ p_worker_id: claim.workerId, p_lease_token: claim.leaseToken },
				signal,
			).catch(() => undefined);
		}
		let packageCaches = false;
		const attach = async ({ bootId, uid }: { bootId: string; uid: number }) => {
			if (await this.#newDiskDue(machine, signal)) throw new CodingFolderRestartRequired("READS_UNREADABLE");
			const guest = { bootId, guestConfigSha256: this.#folderSessionSha(claim.workerId, machine.machineId, bootId) };
			packageCaches = await this.#attachSession(
				claim,
				machine,
				storage,
				{ ...guest, folder: { uid } },
				scope,
				signal,
			);
			return guest;
		};
		let guest: { bootId: string; guestConfigSha256: string };
		try {
			guest = await attach(started);
		} catch (error) {
			if (!(error instanceof CodingFolderRestartRequired)) throw error;
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
			folder: { uid: started.uid, cwd, packageCaches },
		};
		this.#prepared.set(claim.workerId, ready);
		return { vmId: machine.machineId, baseSha };
	}
	#startFolder(
		folder: FolderOptions,
		claim: CodingSessionClaim,
		machine: Readonly<LxdCodingMachineBinding>,
		storage: Readonly<CloudCodingStorageBinding>,
		journal: CodingMachineJournalPlan,
		signal: AbortSignal,
		restart?: { starts: number; newDisk: boolean },
		storagePrepared = false,
		cancel?: AbortSignal,
	): Promise<{ bootId: string; uid: number; starts: number }> {
		return withAbortScopes([signal, cancel], (waitSignal) =>
			this.#exclusive(
				machine.machineId,
				signal,
				async () => {
					waitSignal.throwIfAborted();
					if (!storagePrepared) await this.#run(claim, machine, storage, waitSignal, true);
					if (
						restart !== undefined &&
						(restart.newDisk || (this.#folderStarts.get(machine.machineId) ?? 0) === restart.starts)
					)
						await this.#stopForFolder(folder, machine, journal, signal, restart.newDisk);
					await this.#runFolder(folder, claim, machine, storage, journal, signal, cancel);
					waitSignal.throwIfAborted();
					const receipt = await this.#run(claim, machine, storage, waitSignal);
					const uid = receipt.guestUid;
					if (uid === null || uid < CODING_GUEST.minUid || uid > CODING_GUEST.maxUid)
						throw new Error("CODING_FOLDER_SESSION_UID_MISSING");
					const bootId = await this.#folderReady(machine, waitSignal);
					return { bootId, uid, starts: this.#folderStarts.get(machine.machineId) ?? 0 };
				},
				cancel,
			),
		);
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
		cancel?: AbortSignal,
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
			this.#options.standbyPool || cancel
				? {
						...(this.#options.standbyPool
							? {
									claimStandby: (project, request, checked) =>
										this.#options.standbyPool!.claim(project, request, checked),
								}
							: {}),
						...(cancel ? { cancel } : {}),
					}
				: undefined,
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
		for (let attempt = 0; ; attempt++) {
			try {
				const instance = await client.getInstance(machine.project, name, ready);
				if (!instance || instance.status !== "Running" || instance.statusCode !== 103)
					throw new Error("CODING_HOST_VM_NOT_RUNNING");
				assertLxdCodingMachineInstance(machine, this.#placement, instance);
				await client.execInstance(machine.project, name, ["/usr/bin/true"], ready);
				boot = await client.readInstanceFile(machine.project, name, "/proc/sys/kernel/random/boot_id", 64, ready);
				break;
			} catch (error) {
				signal.throwIfAborted();
				if (ready.aborted) throw new Error("CODING_HOST_GUEST_NOT_READY", { cause: error });
				const unread = error instanceof Error && error.message === "LXD_INSTANCE_FILE_UNCONFIRMED";
				if (!folderGuestStarting(error) && !unread) throw error;
				await setTimeout(pollBackoffMs(attempt), undefined, { signal: ready }).catch(() => undefined);
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
		for (let attempt = 0; ; attempt++) {
			try {
				await this.#options.client.execInstance(machine.project, name, [...CODING_BOOT_READY_COMMAND], settled);
				break;
			} catch (error) {
				signal.throwIfAborted();
				if (settled.aborted) return;
				const notReadyYet = error instanceof Error && error.message === "LXD instance command failed";
				if (!notReadyYet && !folderGuestStarting(error)) throw error;
				await setTimeout(pollBackoffMs(attempt), undefined, { signal: settled }).catch(() => undefined);
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
			// The kernel takes the report only from the executor that holds the turn's lease, and takes the row's words
			// (title, summary, what a customer will notice) from its own rows.
			recordChange: async (report, checked) => {
				const answer = receiptRecord(
					await this.#call(
						"qorpera_record_code_change",
						{ p_worker_id: claim.workerId, p_lease_token: claim.leaseToken, p_change: report },
						checked,
					),
				);
				const change = answer.change;
				if (
					answer.schema !== "qorpera.code-change-recorded/v1" ||
					typeof answer.state !== "string" ||
					!["recorded", "adopted", "replayed", "known", "late", "nothing"].includes(answer.state) ||
					!(change === null || (Number.isSafeInteger(change) && (change as number) >= 1))
				)
					throw new Error("CODING_HOST_CODE_CHANGE_UNCONFIRMED");
				return { state: answer.state, change: change as number | null };
			},
			// Asked of the executor that holds the turn's lease. An answer lost, or not the switch's, reads as on: the
			// landing is then checked, never let in unchecked, and its site taken. A kernel from before step 4 says
			// nothing of the site: on. Only the kernel's refusal ends it. From step 5 (migration 20260930756000) the
			// answer says `rootLinks` while sites have hosts of their own, and hands over an operator's drill once: each is
			// read only when said, so a kernel before that, an answer lost or sites' hosts off leave links from / refused
			// and no drill (a drill in an answer lost is spent: the operator sets it again).
			checksSwitch: async (checked) => {
				try {
					const answer = receiptRecord(
						await this.#call(
							"qorpera_code_checks_switch",
							{ p_worker_id: claim.workerId, p_lease_token: claim.leaseToken },
							checked,
						),
					);
					if (
						answer.schema !== "qorpera.code-checks-switch/v1" ||
						typeof answer.enabled !== "boolean" ||
						!(answer.site === undefined || typeof answer.site === "boolean") ||
						!(answer.rootLinks === undefined || typeof answer.rootLinks === "boolean") ||
						!(answer.drill === undefined || answer.drill === "check" || answer.drill === "site")
					)
						throw new Error("CODING_HOST_CODE_CHECKS_SWITCH_UNCONFIRMED");
					return {
						checks: answer.enabled,
						site: typeof answer.site === "boolean" ? answer.site : true,
						...(answer.rootLinks === true ? { rootLinks: true as const } : {}),
						...(answer.drill === "check" || answer.drill === "site" ? { drill: answer.drill } : {}),
					};
				} catch (error) {
					if (checked.aborted || error instanceof CodingControlRefused) throw error;
					this.#checksReport({
						event: "code-checks-error",
						step: "switch",
						workerId: claim.workerId,
						sequence: claim.sequence,
						error,
					});
					return { checks: true, site: true };
				}
			},
			runChecks: (input, checked) => this.#runChecks(claim, input, checked),
		};
	}
	/** A line of the checks' log; the log never changes what happens. */
	#checksReport(event: Record<string, unknown>): void {
		try {
			this.#options.folder?.report?.(event);
		} catch {
			/* not heard */
		}
	}
	async buildPreview(
		claim: CodingSessionClaim,
		build: CodingPreviewBuild,
		signal: AbortSignal,
	): Promise<SurfacePreviewBuildOutcome> {
		const run = await this.#runChecks(
			claim,
			{
				commit: build.commitSha,
				checks: [
					{
						name: PREVIEW_BUILD_CHECK_NAME,
						run: build.recipe.run,
						cwd: build.recipe.cwd,
						timeoutSeconds: build.recipe.timeoutSeconds,
						secrets: [],
					},
				],
				attempt: build.attempt,
				site: { folder: build.recipe.folder, name: null, title: null },
				rootLinks: true,
				maxParallel: 1,
				failFast: true,
				caches: [],
			},
			signal,
		);
		return previewBuildOutcome(run, build.recipe);
	}
	/** One run of a repository's checks on a clean copy of `commit` in the turn's session's machine (own code storage,
	 * step 3; STEP3-CHECKS-PLAN.md 6.2 to 6.4). Each command (the copy, then each check in the file's order) is one of the
	 * session's own commands, through the folder command transport its model's commands take: as the session's user, with
	 * its environment and secrets, its output masked and kept in its custody only once the machine's reads are released.
	 * Its authority is the host's own part of a command's (the turn still prepared, a fresh run authority, no machine
	 * marked for a new disk), never the model's: the turn has handed in, and the model's commands are refused. Each
	 * command gets `CI=true`, `QORPERA_CHECKS=1` and the machine's package caches when its agent made them, as every
	 * session command does (packageCacheEnvironment; own code storage, step 6). The copy holds exactly the candidate's tracked files
	 * and installs run fresh in it. Packages may come from this machine's cache; npm checks each against the lockfile's
	 * integrity, other tools check less. No build output is carried. The run works in a folder of its own,
	 * `~/.qorpera-checks/<its turn's sequence>-<its attempt>` (codeChecksRunName), and its copy removes the earlier runs'
	 * folders; a command of a run that is not the newest does nothing (CODE_CHECKS_NEWER_RUN). The copy makes that folder
	 * first (the fence) and ends what earlier runs left running in theirs; after it, before the first check, every command
	 * of an earlier run the host did not see end for certain is cancelled and read once more (#checksLookAgain; review
	 * rounds 5 and 6, F1).
	 * The first check that fails ends the run. It never throws for a check's or the machine's sake: what could not run,
	 * or ran past the run's wall budget, is `not_run` with why, a running command stopped first (#stopChecksCommand). A
	 * command whose stop could not be confirmed (its cancels rejected, or still `running`) holds every later run of the
	 * session's checks: each is `not_run` (`machine`, CODE_CHECKS_EARLIER_RUN_NOT_STOPPED) until a cancel and a read
	 * before it see it end, and touches no folder (#checksMayRun; release review r1, F1). The turn's abort stops the
	 * running command with time of its own and is thrown on.
	 *
	 * When `site` is a recipe and every check passed, the run takes the site the checks left (own code storage, step 4;
	 * #takeSite): its collect and, when needed, its drop are two more commands of the run, under every rule above, and
	 * the run's wall budget gains 240 s for them. A site the code made wrong is `site_refused`; a run that passed says
	 * what became of its site (null without a recipe). Its `ms` is the checks' own, the site's time aside. `rootLinks`
	 * true lets the site's links from `/` through (step 5: the collect's QORPERA_SITE_ROOT_LINKS is `allowed`); else they
	 * are refused as before (`refused`, always set, so no value of the session's of that name reaches the collect). */
	async #runChecks(
		claim: CodingSessionClaim,
		input: {
			commit: string;
			checks: readonly CodeCheck[];
			attempt: number;
			site: CodeSiteRecipe | null;
			rootLinks?: boolean;
			maxParallel?: number;
			failFast?: boolean;
			caches?: readonly CodeCheckCache[];
			changedPaths?: readonly string[];
			checksChanged?: boolean;
		},
		signal: AbortSignal,
	): Promise<CodeChecksRun> {
		signal.throwIfAborted();
		const began = performance.now();
		const said = { workerId: claim.workerId, sequence: claim.sequence, attempt: input.attempt, commit: input.commit };
		const elapsed = (since: number) => Math.round(performance.now() - since);
		const recipe = input.site ?? null;
		const meta = codeChecksGateMetadata(input.checks);
		const maxParallel = Math.max(1, Math.min(8, input.maxParallel ?? meta?.maxParallel ?? MAX_PARALLEL_CHECKS));
		const failFast = input.failFast ?? meta?.failFast ?? true;
		const caches = input.caches ?? meta?.caches ?? [];
		const checksChanged = input.checksChanged ?? meta?.checksChanged ?? false;
		const allowCacheSave = meta?.allowCacheSave ?? true;
		const answer = (run: CodeChecksRun): CodeChecksRun => {
			this.#checksReport({
				event: "code-checks",
				step: "run",
				...said,
				state: run.state,
				...(run.state === "not_run" ? { why: run.why, code: run.code } : { ms: run.ms }),
				...(run.state === "passed" && run.site !== null
					? { site: run.site.state, ...(run.site.state === "missed" ? { siteCode: run.site.code } : {}) }
					: {}),
				...(run.state === "site_refused" ? { problem: run.problem.code, variable: run.problem.variable } : {}),
			});
			return run;
		};
		const folder = this.#options.folder;
		let ready: Prepared;
		try {
			ready = this.#active(claim);
		} catch (error) {
			this.#checksReport({ event: "code-checks-error", step: "run", ...said, error });
			return answer({ state: "not_run", why: "authority", code: errorCodeOf(error) });
		}
		let areaPath: string;
		let repository: string;
		try {
			areaPath = codeAreaPath(claim.repository);
			repository = `${CODING_FOLDER_COMPANY_ROOT}/${areaPath}/repo.git`;
		} catch (error) {
			this.#checksReport({ event: "code-checks-error", step: "run", ...said, error });
			return answer({ state: "not_run", why: "transport", code: errorCodeOf(error) });
		}
		if (!folder || !ready.folder)
			return answer({ state: "not_run", why: "transport", code: "CODING_HOST_CHECKS_UNAVAILABLE" });
		const { uid } = ready.folder;
		const name = codeChecksRunName(claim.sequence, input.attempt);
		if (name === null) return answer({ state: "not_run", why: "transport", code: "CODE_CHECKS_RUN_NAME_INVALID" });
		const home = `/home/qorpera-${uid}`,
			root = `${home}/.qorpera-checks`,
			dir = `${root}/${name}`,
			commandId = (index: number | string) =>
				codingHostId("checks", `${claim.workerId}:${claim.sequence}:${input.attempt}:${index}`);
		const base = {
			...codingFolderGitEnvironment(claim.workerId),
			...packageCacheEnvironment(ready),
			CI: "true",
			QORPERA_CHECKS: "1",
			QORPERA_CHECKS_ROOT: root,
			QORPERA_CHECKS_NAME: name,
		};
		const authorize = this.#commandAuthority(ready);
		const checked: LxdCodingFolderCommandTransportOptions["authorize"] = async (...call) => {
			try {
				await authorize(...call);
			} catch (error) {
				throw new CodingChecksUnauthorized(error);
			}
		};
		const dependencies = codeChecksPlan(input.checks);
		if (dependencies === null)
			return answer({ state: "not_run", why: "transport", code: "CODE_CHECKS_PLAN_INVALID" });
		const earlierCommands = this.#checksMayRun.get(claim.workerId);
		for (const earlier of [...(earlierCommands ?? [])]) {
			let end: "ended" | "lost" | "unkept" | "running" = "running";
			try {
				end = await this.#stopChecksCommand(
					this.#folderTransport(folder, ready, { cwd: home, environment: base, authorize: checked }),
					ready.scope,
					earlier,
					folder,
					signal,
				);
			} catch (error) {
				if (signal.aborted) throw signal.reason;
				this.#checksReport({ event: "code-checks-error", step: "earlier", ...said, error });
			}
			this.#checksReport({ event: "code-checks", step: "earlier", ...said, commandId: earlier, end });
			if (end === "running")
				return answer({ state: "not_run", why: "machine", code: CODE_CHECKS_EARLIER_RUN_NOT_STOPPED });
			earlierCommands?.delete(earlier);
			if (earlierCommands?.size === 0) this.#checksMayRun.delete(claim.workerId);
		}
		const planBudget = codeChecksWallBudget(input.checks, dependencies, maxParallel);
		const budget = AbortSignal.timeout(
			folder.checksBudgetMs ??
				planBudget.wallSeconds * 1000 +
					planBudget.criticalPathNodes * CODE_CHECKS_SLACK_MS +
					CODE_CHECKS_COPY_MS +
					(recipe === null ? 0 : CODE_SITE_BUDGET_MS),
		);
		const cacheEnabled = caches.length > 0 && ready.folder.packageCaches;
		const repoCacheRoot = `${CODING_CHECK_CACHES.root}/${digest(areaPath).slice(0, 24)}`;
		let copyTransport: LxdCodingFolderCommandTransport;
		try {
			copyTransport = this.#folderTransport(folder, ready, {
				cwd: home,
				environment: {
					...base,
					QORPERA_CHECKS_REPOSITORY: repository,
					QORPERA_CHECKS_COMMIT: input.commit,
					...(cacheEnabled
						? {
								QORPERA_CHECKS_CACHES: JSON.stringify(caches),
								QORPERA_CHECKS_CACHE_ROOT: repoCacheRoot,
							}
						: {}),
				},
				authorize: checked,
			});
		} catch (error) {
			this.#checksReport({ event: "code-checks-error", step: "run", ...said, error });
			return answer({ state: "not_run", why: "transport", code: errorCodeOf(error) });
		}
		const copyCommand = {
			commandId: commandId(0),
			inputSha256: digest(
				JSON.stringify({
					schema: "qorpera.code-checks-command/v1",
					commit: input.commit,
					index: 0,
					run: CODE_CHECKS_COPY,
				}),
			),
			command: CODE_CHECKS_COPY,
			timeoutMs: CODE_CHECKS_COPY_MS,
		};
		const copyStep = { ...said, folder: name, index: 0 };
		this.#checksReport({ event: "code-checks", step: "started", ...copyStep });
		const copyStarted = performance.now();
		const copyEnded = await this.#checksCommand(
			copyTransport,
			ready.scope,
			copyCommand,
			true,
			budget,
			signal,
			folder,
		);
		const copyMs = elapsed(copyStarted);
		if ("cancelled" in copyEnded) return answer({ state: "not_run", why: "machine", code: "CODE_CHECKS_CANCELLED" });
		if ("why" in copyEnded) {
			this.#checksReport({
				event: "code-checks",
				step: "ended",
				...copyStep,
				ms: copyMs,
				state: "not_run",
				...(copyEnded.stopped === undefined ? {} : { stopped: copyEnded.stopped }),
			});
			if (copyEnded.error !== undefined)
				this.#checksReport({ event: "code-checks-error", step: "command", ...copyStep, error: copyEnded.error });
			return answer({ state: "not_run", why: copyEnded.why, code: copyEnded.code });
		}
		if (copyEnded.error !== undefined)
			this.#checksReport({ event: "code-checks-error", step: "tail", ...copyStep, error: copyEnded.error });
		this.#checksReport({
			event: "code-checks",
			step: "ended",
			...copyStep,
			ms: copyMs,
			state: copyEnded.receipt.state,
			exitCode: copyEnded.receipt.exitCode,
		});
		if (copyEnded.receipt.state !== "succeeded")
			return answer(
				copyEnded.receipt.state === "failed"
					? { state: "not_run", why: "copy", code: `CODE_CHECKS_COPY_EXIT_${copyEnded.receipt.exitCode}` }
					: { state: "not_run", why: "machine", code: `CODE_CHECKS_${copyEnded.receipt.state.toUpperCase()}` },
			);
		const running = await this.#checksLookAgain(claim, ready, folder, home, base, checked, said, signal);
		if (running !== undefined) {
			this.#markChecksMayRun(claim.workerId, running);
			return answer({ state: "not_run", why: "machine", code: CODE_CHECKS_EARLIER_RUN_NOT_STOPPED });
		}
		const hasPathFilters =
			!checksChanged && input.checks.some((c) => c.paths !== undefined || c.pathsIgnore !== undefined);
		const changedPaths =
			input.changedPaths !== undefined
				? input.changedPaths
				: hasPathFilters
					? await this.#readChangedPaths(
							ready,
							folder,
							{
								home,
								base,
								repository,
								baseBranch: claim.repository.baseBranch,
								commit: input.commit,
								authorize: checked,
								budget,
								commandId: commandId("diff"),
								step: { ...said, folder: name },
							},
							signal,
						)
					: undefined;
		const pathSkippedNames = filterCodeChecksByPaths(input.checks, changedPaths, checksChanged);
		const pathSkippedIndices = new Set<number>();
		for (let i = 0; i < input.checks.length; i++) {
			if (pathSkippedNames.has((input.checks[i] as CodeCheck).name)) pathSkippedIndices.add(i);
		}
		const totalChecks = input.checks.length;
		const remainingDeps = dependencies.map((deps) => deps.length);
		const dependents: number[][] = Array.from({ length: totalChecks }, () => []);
		for (let i = 0; i < totalChecks; i++) {
			for (const dep of dependencies[i] as readonly number[]) dependents[dep]?.push(i);
		}
		const readyQueue: number[] = [];
		const passedByIndex = new Map<number, CodeCheckPassedEntry>();
		const failedIndices = new Set<number>();
		const logByIndex = new Map<number, { src: string; name: string }>();
		const unblockDependents = (completedIndex: number) => {
			const queue = [completedIndex];
			while (queue.length > 0) {
				const current = queue.shift() as number;
				for (const next of dependents[current] as readonly number[]) {
					remainingDeps[next] = (remainingDeps[next] as number) - 1;
					if (remainingDeps[next] === 0) {
						if (pathSkippedIndices.has(next)) {
							const skippedCheck = input.checks[next] as CodeCheck;
							passedByIndex.set(next, {
								name: skippedCheck.name,
								run: clipped(skippedCheck.run, CODE_CHECKS_RUN_BYTES),
								ms: 0,
								skipped: "paths_unmatched",
							});
							queue.push(next);
						} else {
							readyQueue.push(next);
						}
					}
				}
			}
		};
		const initialSkipped: number[] = [];
		for (let i = 0; i < totalChecks; i++) {
			if (remainingDeps[i] === 0) {
				if (pathSkippedIndices.has(i)) {
					const skippedCheck = input.checks[i] as CodeCheck;
					passedByIndex.set(i, {
						name: skippedCheck.name,
						run: clipped(skippedCheck.run, CODE_CHECKS_RUN_BYTES),
						ms: 0,
						skipped: "paths_unmatched",
					});
					initialSkipped.push(i);
				} else {
					readyQueue.push(i);
				}
			}
		}
		for (const skippedIdx of initialSkipped) unblockDependents(skippedIdx);
		const runAbort = new AbortController();
		type TerminalOutcome =
			| {
					readonly kind: "failed";
					readonly checkIndex: number;
					readonly failed: Extract<CodeChecksRun, { state: "failed" }>["failed"];
			  }
			| {
					readonly kind: "not_run";
					readonly why: Extract<CodeChecksRun, { state: "not_run" }>["why"];
					readonly code: string;
			  };
		let claimant: number | undefined;
		let terminal: TerminalOutcome | undefined;
		let abortedError: unknown;
		let hasAbortedError = false;
		let activeExclusive = false;
		const inFlight = new Set<Promise<void>>();
		const claimStop = (checkIndex: number) => {
			claimant ??= checkIndex;
			runAbort.abort();
		};
		const stopRun = (checkIndex: number, outcome: TerminalOutcome) => {
			if (claimant !== undefined && claimant !== checkIndex) return;
			claimant ??= checkIndex;
			if (terminal === undefined) {
				terminal = outcome;
				runAbort.abort();
			}
		};
		const launch = (checkIndex: number) => {
			const check = input.checks[checkIndex] as CodeCheck;
			const isExclusive = check.exclusive === true;
			const index = checkIndex + 1;
			const logFileName = `${index}-${check.name}.log`;
			const log = `.qorpera-checks/${name}/out/${logFileName}`;
			const step = { ...said, folder: name, index, check: check.name };
			const maxRetries = check.retries ?? 0;
			const task = (async () => {
				try {
					let totalCheckMs = 0;
					for (let retry = 0; retry <= maxRetries; retry++) {
						const attemptCommandId = retry === 0 ? commandId(index) : commandId(`${index}:r${retry}`);
						let transport: LxdCodingFolderCommandTransport;
						try {
							transport = this.#folderTransport(folder, ready, {
								cwd: `${dir}/src`,
								environment: {
									...(check.env ?? {}),
									...base,
									QORPERA_CHECK_CWD: check.cwd,
									QORPERA_CHECK_RUN: check.run,
									QORPERA_CHECK_LOG: `${home}/${log}`,
								},
								...(check.secrets !== undefined ? { allowedSecrets: check.secrets } : {}),
								authorize: checked,
							});
						} catch (error) {
							this.#checksReport({ event: "code-checks-error", step: "run", ...said, error });
							stopRun(checkIndex, { kind: "not_run", why: "transport", code: errorCodeOf(error) });
							return;
						}
						const command = {
							commandId: attemptCommandId,
							inputSha256: digest(
								JSON.stringify({
									schema: "qorpera.code-checks-command/v1",
									commit: input.commit,
									index,
									run: check.run,
									...(retry > 0 ? { retry } : {}),
								}),
							),
							command: CODE_CHECKS_CHECK,
							timeoutMs: check.timeoutSeconds * 1000,
						};
						this.#checksReport({
							event: "code-checks",
							step: "started",
							...step,
							...(retry > 0 ? { retry } : {}),
						});
						const started = performance.now();
						const isFinalAttempt = retry === maxRetries;
						const ended = await this.#checksCommand(
							transport,
							ready.scope,
							command,
							false,
							budget,
							signal,
							folder,
							runAbort.signal,
							failFast && isFinalAttempt ? () => claimStop(checkIndex) : undefined,
						);
						const ms = elapsed(started);
						totalCheckMs += ms;
						if ("cancelled" in ended) {
							this.#checksReport({
								event: "code-checks",
								step: "ended",
								...step,
								ms,
								state: "cancelled",
								stopped: ended.stopped,
							});
							return;
						}
						if ("why" in ended) {
							this.#checksReport({
								event: "code-checks",
								step: "ended",
								...step,
								ms,
								state: "not_run",
								...(ended.stopped === undefined ? {} : { stopped: ended.stopped }),
							});
							if (ended.error !== undefined)
								this.#checksReport({
									event: "code-checks-error",
									step: "command",
									...step,
									error: ended.error,
								});
							stopRun(checkIndex, { kind: "not_run", why: ended.why, code: ended.code });
							return;
						}
						const { receipt } = ended;
						if (ended.error !== undefined)
							this.#checksReport({ event: "code-checks-error", step: "tail", ...step, error: ended.error });
						this.#checksReport({
							event: "code-checks",
							step: "ended",
							...step,
							ms,
							state: receipt.state,
							exitCode: receipt.exitCode,
							...(retry > 0 ? { retry } : {}),
						});
						logByIndex.set(checkIndex, { src: `${home}/${log}`, name: logFileName });
						const run = clipped(check.run, CODE_CHECKS_RUN_BYTES);
						if (receipt.state === "succeeded") {
							passedByIndex.set(checkIndex, { name: check.name, run, ms: totalCheckMs });
							unblockDependents(checkIndex);
							return;
						}
						if (receipt.state !== "failed") {
							stopRun(checkIndex, {
								kind: "not_run",
								why: "machine",
								code: `CODE_CHECKS_${receipt.state.toUpperCase()}`,
							});
							return;
						}
						if (
							retry < maxRetries &&
							receipt.exitCode !== 91 &&
							!runAbort.signal.aborted &&
							!budget.aborted &&
							!signal.aborted
						) {
							this.#checksReport({
								event: "code-checks",
								step: "retry",
								...step,
								retry: retry + 1,
								exitCode: receipt.exitCode,
							});
							continue;
						}
						const failureEntry = {
							name: check.name,
							run,
							ms: totalCheckMs,
							exitCode: receipt.exitCode,
							atLimit: receipt.exitCode === 124 && ms >= check.timeoutSeconds * 1000,
							tail: ended.tail,
							log: `~/${log}`,
						};
						failedIndices.add(checkIndex);
						if (failFast) {
							stopRun(checkIndex, { kind: "failed", checkIndex, failed: failureEntry });
						} else if (terminal === undefined) {
							terminal = { kind: "failed", checkIndex, failed: failureEntry };
						}
						return;
					}
				} catch (error) {
					if (!hasAbortedError) {
						hasAbortedError = true;
						abortedError = error;
					}
					runAbort.abort();
				}
			})().finally(() => {
				if (isExclusive) activeExclusive = false;
				inFlight.delete(task);
			});
			inFlight.add(task);
		};
		while (!runAbort.signal.aborted && !signal.aborted && (readyQueue.length > 0 || inFlight.size > 0)) {
			readyQueue.sort((a, b) => a - b);
			if (!activeExclusive) {
				for (let pos = 0; pos < readyQueue.length; ) {
					if (runAbort.signal.aborted || signal.aborted) break;
					const candidate = readyQueue[pos] as number;
					const isExclusive = input.checks[candidate]?.exclusive === true;
					if (isExclusive) {
						if (inFlight.size === 0) {
							readyQueue.splice(pos, 1);
							activeExclusive = true;
							launch(candidate);
							break;
						}
						pos++;
						continue;
					}
					if (inFlight.size >= maxParallel) break;
					readyQueue.splice(pos, 1);
					launch(candidate);
				}
			}
			if (inFlight.size > 0) await Promise.race(inFlight);
		}
		if (inFlight.size > 0) await Promise.allSettled([...inFlight]);
		if (signal.aborted) throw signal.reason;
		if (hasAbortedError) throw abortedError;
		const runId = `${name}-${input.commit.slice(0, 12)}`;
		if (terminal !== undefined) {
			if (terminal.kind === "not_run") return answer({ state: "not_run", why: terminal.why, code: terminal.code });
			const persistLogs: { src: string; name: string }[] = [];
			const primaryLog = logByIndex.get(terminal.checkIndex);
			if (primaryLog) persistLogs.push(primaryLog);
			for (const [idx, entry] of logByIndex.entries()) {
				if (idx !== terminal.checkIndex) persistLogs.push(entry);
			}
			const persistArtifacts: {
				check: string;
				format: CodeCheckArtifactFormat;
				paths: readonly string[];
				extract: boolean;
			}[] = [];
			for (let i = 0; i < totalChecks; i++) {
				const check = input.checks[i] as CodeCheck;
				if (!check.artifacts) continue;
				const failedCheck = failedIndices.has(i);
				const ranAndPassed = passedByIndex.has(i) && passedByIndex.get(i)?.skipped === undefined;
				if (failedCheck || (ranAndPassed && check.artifacts.when === "always")) {
					persistArtifacts.push({
						check: check.name,
						format: check.artifacts.format,
						paths: check.artifacts.paths,
						extract: i === terminal.checkIndex,
					});
				}
			}
			const persisted = await this.#persistCheckRun(
				ready,
				folder,
				{
					dir,
					base,
					areaPath,
					runId,
					logs: persistLogs,
					artifacts: persistArtifacts,
					authorize: checked,
					budget,
					commandId: commandId("persist"),
					dropCommandId: commandId("persist-drop"),
					step: { ...said, folder: name },
				},
				signal,
			);
			const passedChecks: { name: string; ms: number; skipped?: "paths_unmatched" }[] = [];
			const notRun: string[] = [];
			for (let i = 0; i < totalChecks; i++) {
				const done = passedByIndex.get(i);
				if (done !== undefined) {
					passedChecks.push({
						name: done.name,
						ms: done.ms,
						...(done.skipped !== undefined ? { skipped: done.skipped } : {}),
					});
				} else if (i !== terminal.checkIndex) {
					notRun.push((input.checks[i] as CodeCheck).name);
				}
			}
			return answer({
				state: "failed",
				ms: elapsed(began),
				passed: passedChecks,
				failed: {
					...terminal.failed,
					...(persisted.failedTests && persisted.failedTests.length > 0
						? { failedTests: persisted.failedTests }
						: {}),
					...(persisted.persistedLog !== undefined ? { persistedLog: persisted.persistedLog } : {}),
					...(persisted.artifactsDir !== undefined ? { artifactsDir: persisted.artifactsDir } : {}),
				},
				notRun,
			});
		}
		const passed: CodeCheckPassedEntry[] = [];
		for (let i = 0; i < totalChecks; i++) {
			const done = passedByIndex.get(i);
			if (done === undefined)
				return answer({ state: "not_run", why: "transport", code: "CODE_CHECKS_PLAN_INVALID" });
			passed.push(done);
		}
		const ms = elapsed(began);
		let siteResult: CodeSiteCollected | null = null;
		if (recipe !== null) {
			const site = await this.#takeSite(
				ready,
				folder,
				{
					recipe,
					commit: input.commit,
					rootLinks: input.rootLinks === true,
					dir,
					base,
					repository,
					authorize: checked,
					budget,
					commandId,
					index: input.checks.length + 1,
					step: { ...said, folder: name },
				},
				signal,
			);
			if ("problem" in site) {
				return answer({ state: "site_refused", ms, checks: passed, problem: site.problem });
			}
			siteResult = site;
		}
		let passedArtifactsDir: string | undefined;
		const alwaysArtifacts = input.checks
			.map((check, idx) => ({ check, idx }))
			.filter(
				({ check, idx }) => check.artifacts?.when === "always" && passedByIndex.get(idx)?.skipped === undefined,
			)
			.map(({ check }) => ({
				check: check.name,
				format: check.artifacts!.format,
				paths: check.artifacts!.paths,
				extract: false,
			}));
		if (alwaysArtifacts.length > 0) {
			const persisted = await this.#persistCheckRun(
				ready,
				folder,
				{
					dir,
					base,
					areaPath,
					runId,
					logs: [],
					artifacts: alwaysArtifacts,
					authorize: checked,
					budget,
					commandId: commandId("persist"),
					dropCommandId: commandId("persist-drop"),
					step: { ...said, folder: name },
				},
				signal,
			);
			passedArtifactsDir = persisted.artifactsDir;
		}
		if (cacheEnabled && allowCacheSave) {
			await this.#saveCheckCaches(
				ready,
				folder,
				{
					home,
					base,
					repository,
					commit: input.commit,
					caches,
					repoCacheRoot,
					authorize: checked,
					budget,
					trackedCommandId: commandId("cache-tracked"),
					commandId: commandId("cache-save"),
					step: { ...said, folder: name },
				},
				signal,
			);
		}
		return answer({
			state: "passed",
			ms,
			copyMs,
			checks: passed,
			site: siteResult,
			...(passedArtifactsDir !== undefined ? { artifactsDir: passedArtifactsDir } : {}),
		});
	}
	async #readChecksOutput(
		transport: LxdCodingFolderCommandTransport,
		scope: CloudCodingCommandScope,
		commandId: string,
		initial: CloudCodingCommandReceipt,
		maxBytes: number,
		signal: AbortSignal,
	): Promise<{ text: string; truncated: boolean }> {
		if (initial.log.offset === 0 && !initial.truncated) {
			return { text: initial.output, truncated: false };
		}
		if (initial.log.totalBytes > maxBytes) {
			return { text: "", truncated: true };
		}
		let offset = 0;
		let text = "";
		while (offset < initial.log.totalBytes) {
			const page = await transport.read(scope, { commandId, offset, limit: 65536 }, signal);
			if (page.log.nextOffset <= offset) break;
			text += page.output;
			offset = page.log.nextOffset;
			if (Buffer.byteLength(text, "utf8") > maxBytes) return { text: "", truncated: true };
		}
		return { text, truncated: false };
	}
	async #readChangedPaths(
		ready: Prepared,
		folder: FolderOptions,
		run: {
			home: string;
			base: Readonly<Record<string, string>>;
			repository: string;
			baseBranch: string;
			commit: string;
			authorize: LxdCodingFolderCommandTransportOptions["authorize"];
			budget: AbortSignal;
			commandId: string;
			step: Record<string, unknown>;
		},
		signal: AbortSignal,
	): Promise<readonly string[] | undefined> {
		if (run.budget.aborted || signal.aborted) return undefined;
		try {
			const transport = this.#folderTransport(folder, ready, {
				cwd: run.home,
				environment: {
					...run.base,
					QORPERA_CHECKS_REPOSITORY: run.repository,
					QORPERA_CHECKS_BASE_BRANCH: run.baseBranch,
					QORPERA_CHECKS_COMMIT: run.commit,
				},
				authorize: run.authorize,
			});
			const command = {
				commandId: run.commandId,
				inputSha256: digest(
					JSON.stringify({
						schema: "qorpera.code-checks-diff/v1",
						commit: run.commit,
						baseBranch: run.baseBranch,
					}),
				),
				command: CODE_CHECKS_DIFF,
				timeoutMs: CODE_CHECKS_DIFF_MS,
			};
			const bounded = AbortSignal.any([run.budget, AbortSignal.timeout(CODE_CHECKS_DIFF_MS + 15_000)]);
			const ended = await this.#checksCommand(transport, ready.scope, command, true, bounded, signal, folder);
			if ("cancelled" in ended || "why" in ended || ended.receipt.state !== "succeeded") return undefined;
			const full = await this.#readChecksOutput(
				transport,
				ready.scope,
				command.commandId,
				ended.receipt,
				256 * 1024,
				AbortSignal.any([signal, bounded]),
			);
			if (full.truncated) return undefined;
			const marker = "QORPERA_DIFF_OK\n";
			if (!full.text.startsWith(marker)) return undefined;
			const body = full.text.slice(marker.length);
			if (body.length === 0) return [];
			if (!body.endsWith("\0")) return undefined;
			return body.split("\0").filter((entry) => entry.length > 0);
		} catch (error) {
			if (signal.aborted) throw signal.reason;
			this.#checksReport({ event: "code-checks-error", step: "diff", ...run.step, error });
			return undefined;
		}
	}
	async #saveCheckCaches(
		ready: Prepared,
		folder: FolderOptions,
		run: {
			home: string;
			base: Readonly<Record<string, string>>;
			repository: string;
			commit: string;
			caches: readonly CodeCheckCache[];
			repoCacheRoot: string;
			authorize: LxdCodingFolderCommandTransportOptions["authorize"];
			budget: AbortSignal;
			trackedCommandId: string;
			commandId: string;
			step: Record<string, unknown>;
		},
		signal: AbortSignal,
	): Promise<void> {
		if (run.budget.aborted || signal.aborted || !ready.folder) return;
		try {
			const candidatePaths = [...new Set(run.caches.flatMap((spec) => spec.paths))];
			if (candidatePaths.length === 0) return;
			const nonce = randomBytes(12).toString("hex");
			const bounded = AbortSignal.any([signal, run.budget, AbortSignal.timeout(CODE_CHECKS_CACHE_SAVE_MS + 30_000)]);
			// WHY: Query tracked paths as the session user against platform-owned repo.git so root never runs git on session files.
			const trackedTransport = this.#folderTransport(folder, ready, {
				cwd: run.home,
				environment: {
					...run.base,
					QORPERA_CHECKS_REPOSITORY: run.repository,
					QORPERA_CHECKS_COMMIT: run.commit,
					QORPERA_CHECKS_CACHE_PATHS: JSON.stringify(candidatePaths),
					QORPERA_CHECKS_TRACKED_NONCE: nonce,
				},
				authorize: run.authorize,
			});
			const trackedCommand = {
				commandId: run.trackedCommandId,
				inputSha256: digest(
					JSON.stringify({
						schema: "qorpera.code-checks-cache-tracked/v1",
						commit: run.commit,
						paths: candidatePaths,
					}),
				),
				command: CODE_CHECKS_CACHE_TRACKED,
				timeoutMs: CODE_CHECKS_DIFF_MS,
			};
			const trackedEnded = await this.#checksCommand(
				trackedTransport,
				ready.scope,
				trackedCommand,
				true,
				bounded,
				signal,
				folder,
			);
			if ("cancelled" in trackedEnded || "why" in trackedEnded || trackedEnded.receipt.state !== "succeeded") return;
			const trackedOut = await this.#readChecksOutput(
				trackedTransport,
				ready.scope,
				trackedCommand.commandId,
				trackedEnded.receipt,
				64 * 1024,
				bounded,
			);
			if (trackedOut.truncated) return;
			const prefix = `QORPERA_CACHE_UNTRACKED:${nonce}:`;
			const line = trackedOut.text.split("\n").find((entry) => entry.startsWith(prefix));
			if (!line) return;
			const parsedUntracked: unknown = JSON.parse(line.slice(prefix.length));
			if (!Array.isArray(parsedUntracked)) return;
			const untracked = new Set(parsedUntracked.filter((entry): entry is string => typeof entry === "string"));
			const filteredCaches = run.caches
				.map((spec) => ({ ...spec, paths: spec.paths.filter((rel) => untracked.has(rel)) }))
				.filter((spec) => spec.paths.length > 0);
			if (filteredCaches.length === 0) return;

			const inputSha256 = digest(
				JSON.stringify({
					schema: "qorpera.code-checks-cache-save/v1",
					caches: filteredCaches,
					root: run.repoCacheRoot,
				}),
			);
			await run.authorize("start", ready.scope, run.commandId, inputSha256, bounded);
			// WHY: Root exec drops to ready.folder.uid to stream session files via dir_fd+O_NOFOLLOW while writing 0755 root:root caches.
			const result = await folder.client.execInstanceStream(
				ready.machine.project,
				lxdCodingMachineName(ready.machine.machineId),
				{
					command: [
						"/usr/bin/env",
						`QORPERA_CHECKS_ROOT=${run.base.QORPERA_CHECKS_ROOT ?? ""}`,
						`QORPERA_CHECKS_NAME=${run.base.QORPERA_CHECKS_NAME ?? ""}`,
						`QORPERA_CHECKS_UID=${ready.folder.uid}`,
						`QORPERA_CHECKS_GID=${ready.folder.uid}`,
						`QORPERA_CHECKS_CACHES=${JSON.stringify(filteredCaches)}`,
						`QORPERA_CHECKS_CACHE_ROOT=${run.repoCacheRoot}`,
						`QORPERA_CHECKS_CACHE_GLOBAL_ROOT=${CODING_CHECK_CACHES.root}`,
						`QORPERA_CHECKS_CACHE_LIMIT_BYTES=${CODING_CHECK_CACHES.limitBytes}`,
						"/bin/bash",
						"--noprofile",
						"--norc",
						"-s",
					],
					stdin: Buffer.from(CODE_CHECKS_CACHE_SAVE),
					maxStdoutBytes: 16384,
					maxStderrBytes: 16384,
					timeoutMs: CODE_CHECKS_CACHE_SAVE_MS,
				},
				bounded,
			);
			if (result.exitCode !== 0 && result.exitCode !== 91) {
				this.#checksReport({
					event: "code-checks-error",
					step: "cache-save",
					...run.step,
					exitCode: result.exitCode,
				});
			}
		} catch (error) {
			if (signal.aborted) throw signal.reason;
			this.#checksReport({ event: "code-checks-error", step: "cache-save", ...run.step, error });
		}
	}
	async #persistCheckRun(
		ready: Prepared,
		folder: FolderOptions,
		run: {
			dir: string;
			base: Readonly<Record<string, string>>;
			areaPath: string;
			runId: string;
			logs: readonly { src: string; name: string }[];
			artifacts: readonly {
				check: string;
				format: CodeCheckArtifactFormat;
				paths: readonly string[];
				extract: boolean;
			}[];
			authorize: LxdCodingFolderCommandTransportOptions["authorize"];
			budget: AbortSignal;
			commandId: string;
			dropCommandId: string;
			step: Record<string, unknown>;
		},
		signal: AbortSignal,
	): Promise<{
		readonly failedTests?: readonly FailedTestCase[];
		readonly persistedLog?: string;
		readonly artifactsDir?: string;
	}> {
		if (run.budget.aborted || signal.aborted || (run.logs.length === 0 && run.artifacts.length === 0)) return {};
		// WHY: _check-runs/ is advisory diagnostic storage (sessions may write there; landing gates never read it); retains the latest 20 runs.
		const persistRel = `${run.areaPath}/_check-runs/${run.runId}`;
		const persistDir = `${CODING_FOLDER_COMPANY_ROOT}/${persistRel}`;
		const nonce = randomBytes(12).toString("hex");
		const specJson = JSON.stringify({ logs: run.logs, artifacts: run.artifacts });
		const own: Record<string, string> = {
			...run.base,
			QORPERA_CHECKS_PERSIST_DIR: persistDir,
			QORPERA_CHECKS_PERSIST_REL: persistRel,
			QORPERA_CHECKS_PERSIST_SPEC: specJson,
			QORPERA_CHECKS_PERSIST_KEEP_RUNS: "20",
			QORPERA_CHECKS_ARTIFACT_NONCE: nonce,
		};
		let secretNames: string[] = [];
		try {
			const secrets = this.#sessionSecrets(ready);
			if (secrets) {
				const resolved = await secrets.resolve(
					{
						companyId: ready.machine.companyId,
						workerId: ready.claim.workerId,
						machineId: ready.machine.machineId,
						commandId: run.commandId,
						kind: "command",
					},
					AbortSignal.any([signal, run.budget]),
				);
				secretNames = Object.keys(resolved.environment)
					.filter(
						(entryName) =>
							!Object.hasOwn(own, entryName) &&
							entryName !== "QORPERA_CHECKS_SECRET_NAMES" &&
							!CODING_FOLDER_SESSION_NAMES.has(entryName),
					)
					.sort();
			}
		} catch (error) {
			if (signal.aborted) throw signal.reason;
			this.#checksReport({ event: "code-checks-error", step: "persist-secrets", ...run.step, error });
			return {};
		}
		try {
			const transport = this.#folderTransport(folder, ready, {
				cwd: `${run.dir}/src`,
				environment: {
					...own,
					QORPERA_CHECKS_SECRET_NAMES: secretNames.join(" "),
				},
				authorize: run.authorize,
			});
			const command = {
				commandId: run.commandId,
				inputSha256: digest(
					JSON.stringify({
						schema: "qorpera.code-checks-persist/v1",
						rel: persistRel,
						spec: specJson,
					}),
				),
				command: CODE_CHECKS_PERSIST,
				timeoutMs: CODE_CHECKS_PERSIST_MS,
			};
			const bounded = AbortSignal.any([run.budget, AbortSignal.timeout(CODE_CHECKS_PERSIST_MS + 30_000)]);
			const ended = await this.#checksCommand(transport, ready.scope, command, true, bounded, signal, folder);
			if ("cancelled" in ended || "why" in ended) return {};
			const full = await this.#readChecksOutput(
				transport,
				ready.scope,
				command.commandId,
				ended.receipt,
				640 * 1024,
				AbortSignal.any([signal, bounded]),
			);
			const parsed = parsePersistedChecksOutput(full.text, nonce, persistRel);
			const failedTests = parsed.artifacts.length > 0 ? parseCheckFailureArtifacts(parsed.artifacts) : undefined;
			let persistedDir: string | undefined;
			let persistedLog: string | undefined;
			if (ended.receipt.state === "succeeded" && parsed.persistedDir !== undefined) {
				const boundary = this.#folderBoundary(folder, ready.machine);
				const judged = await this.#siteBoundary(boundary, ready, folder, run.budget, run.step, false, signal);
				if (judged === "saved") {
					persistedDir = parsed.persistedDir;
					persistedLog = parsed.persistedLog;
				} else {
					await this.#dropPersistedCheckRun(ready, folder, { ...run, persistDir }, signal);
					await this.#siteBoundary(boundary, ready, folder, run.budget, run.step, true, signal);
				}
			} else if (ended.receipt.state === "failed" && ended.receipt.exitCode !== 91) {
				await this.#dropPersistedCheckRun(ready, folder, { ...run, persistDir }, signal);
			}
			return {
				...(failedTests && failedTests.length > 0 ? { failedTests } : {}),
				...(persistedLog !== undefined ? { persistedLog } : {}),
				...(persistedDir !== undefined ? { artifactsDir: persistedDir } : {}),
			};
		} catch (error) {
			if (signal.aborted) throw signal.reason;
			this.#checksReport({ event: "code-checks-error", step: "persist", ...run.step, error });
			return {};
		}
	}
	async #dropPersistedCheckRun(
		ready: Prepared,
		folder: FolderOptions,
		run: {
			dir: string;
			base: Readonly<Record<string, string>>;
			persistDir: string;
			authorize: LxdCodingFolderCommandTransportOptions["authorize"];
			budget: AbortSignal;
			dropCommandId: string;
			step: Record<string, unknown>;
		},
		signal: AbortSignal,
	): Promise<void> {
		if (run.budget.aborted || signal.aborted) return;
		try {
			const transport = this.#folderTransport(folder, ready, {
				cwd: `${run.dir}/src`,
				environment: {
					...run.base,
					QORPERA_CHECKS_PERSIST_DIR: run.persistDir,
				},
				authorize: run.authorize,
			});
			const command = {
				commandId: run.dropCommandId,
				inputSha256: digest(
					JSON.stringify({
						schema: "qorpera.code-checks-persist-drop/v1",
						dir: run.persistDir,
					}),
				),
				command: CODE_CHECKS_PERSIST_DROP,
				timeoutMs: CODE_CHECKS_PERSIST_DROP_MS,
			};
			const bounded = AbortSignal.any([run.budget, AbortSignal.timeout(CODE_CHECKS_PERSIST_DROP_MS + 15_000)]);
			await this.#checksCommand(transport, ready.scope, command, true, bounded, signal, folder);
		} catch (error) {
			if (signal.aborted) throw signal.reason;
			this.#checksReport({ event: "code-checks-error", step: "persist-drop", ...run.step, error });
		}
	}
	/** The site the checks of a run left, once every one of them passed (own code storage, step 4; STEP4-BUILD.md 2).
	 * 1. The names of the session's secrets the collect looks for: the keys of the vault's environment for the collect's
	 *    own command id (`resolve` keeps that answer for the id, so its start asks nothing again), but those the command's
	 *    own environment or the session's (CODING_FOLDER_SESSION_NAMES) sets, whose values win in the command. Never a
	 *    value.
	 * 2. The collect (`CODE_SITE_COLLECT`), one more command of the run: its own command id, at the copy's `src` (so a
	 *    newer run's copy ends it by its working folder), within the run's budget, through #checksCommand, so that every
	 *    rule of the run's commands holds for it (the two memories, the look again, the stop, `hidden`). Its ending is
	 *    read from its receipt's output (`codeSiteCollectAnswer`): a problem the code made is the site refused; anything
	 *    but its own ending is the site missed, with a code.
	 * 3. The machine's boundary, through the wrapper a command's transport asks it through (#folderBoundary), asked again
	 *    while it is checking or does not answer, for at most CODE_SITE_BOUNDARY_MS, and judged as `publish` judges it
	 *    (every view of the machine): saved with nothing held, the site is made.
	 * 4. Saved, the site is made; not saved, it is refused when the save check found one of the machine's secret values
	 *    in what the collect wrote (`SITE_HOLDS_SECRET`, no variable named), and missed for anything else.
	 * 5. Whenever the collect started and the site is not made and saved, the drop (`CODE_SITE_DROP`), a command of the
	 *    run as the collect is, removes the objects the collect wrote (`site.wrote` stands before its first write), so that
	 *    nothing of it stays pending in the session's view for a later boundary to hold on: after a refused or missed
	 *    boundary, after the code's refusal, and after a collect that failed, ended at its limit, was stopped or was lost
	 *    by the guest. Only once the collect is known to have ended (#checksCommand's `ended`): never beside one that may
	 *    still write (a start never answered, a stop not confirmed), which the memories and the next run's look again
	 *    end, and never after its exit 91 (a newer run's folder stood: it wrote nothing, and the drop would find the
	 *    same). When a boundary was asked and did not save, it is asked once more after the drop; when none was asked,
	 *    none is asked for the drop. What the drop came to changes nothing of the site.
	 * The collect and the drop each run within their own limit and a minute more, and within what is left of the run's
	 * budget (review, F1: a command whose reads are never released shows `running` until its bound): once the budget
	 * passed, the drop cannot start. Each command starts once; the boundary is asked again while it checks or does not
	 * answer, for at most CODE_SITE_BOUNDARY_MS. It throws only the turn's abort, as a check's command does, and starts
	 * nothing after it: no drop either. */
	async #takeSite(
		ready: Prepared,
		folder: FolderOptions,
		run: SiteRun,
		signal: AbortSignal,
	): Promise<CodeSiteCollected | { problem: CodeSiteProblem }> {
		const { recipe, budget } = run;
		const missed = (code: string): CodeSiteCollected => ({ state: "missed", code });
		const isServerOnly = recipe.kind === "server";
		const own: Record<string, string> = {
			...run.base,
			QORPERA_CHECKS_REPOSITORY: run.repository,
			QORPERA_SITE_FOLDER: recipe.folder,
			QORPERA_SITE_ROOT_LINKS: run.rootLinks ? "allowed" : "refused",
			...(recipe.dockerfile ? { QORPERA_SITE_DOCKERFILE: recipe.dockerfile } : {}),
		};
		let names: string[];
		try {
			const secrets = this.#sessionSecrets(ready);
			const { environment } = secrets
				? await secrets.resolve(
						{
							companyId: ready.machine.companyId,
							workerId: ready.claim.workerId,
							machineId: ready.machine.machineId,
							commandId: run.commandId("site"),
							kind: "command",
						},
						AbortSignal.any([signal, budget]),
					)
				: { environment: {} };
			names = Object.keys(environment)
				.filter(
					(name) =>
						!Object.hasOwn(own, name) &&
						name !== "QORPERA_SITE_SECRET_NAMES" &&
						!CODING_FOLDER_SESSION_NAMES.has(name),
				)
				.sort();
		} catch (error) {
			if (signal.aborted) throw signal.reason;
			this.#checksReport({ event: "code-checks-error", step: "secrets", ...run.step, error });
			return missed(budget.aborted ? "CODE_CHECKS_BUDGET" : errorCodeOf(error));
		}
		const collected = await this.#siteCommand(
			ready,
			folder,
			run,
			"collect",
			{ ...own, QORPERA_SITE_SECRET_NAMES: names.join(" ") },
			signal,
		);
		let site: CodeSiteCollected | { problem: CodeSiteProblem };
		let boundary: Pick<CodingFolderControl, "boundary"> | undefined;
		if ("code" in collected) site = missed(collected.code);
		else if (collected.receipt.state !== "succeeded" && collected.receipt.state !== "failed")
			site = missed(`CODE_SITE_COLLECT_${collected.receipt.state.toUpperCase()}`);
		else {
			const { receipt } = collected;
			const ending = codeSiteCollectAnswer(receipt.output, receipt.exitCode, { allowEmpty: isServerOnly });
			if (ending === null)
				site = missed(
					receipt.exitCode === 0 || receipt.exitCode === 3
						? "CODE_SITE_COLLECT_ANSWER_INVALID"
						: `CODE_SITE_COLLECT_EXIT_${receipt.exitCode}`,
				);
			else if ("problem" in ending)
				site = { problem: await this.#siteProblemMasked(ready, run, ending.problem, signal) };
			else {
				const extra = {
					...(recipe.kind !== undefined ? { kind: recipe.kind } : {}),
					...(recipe.dockerfile !== undefined ? { dockerfile: recipe.dockerfile } : {}),
					...(recipe.port !== undefined ? { port: recipe.port } : {}),
					...(recipe.healthPath !== undefined ? { healthPath: recipe.healthPath } : {}),
					...(recipe.idleTimeoutSec !== undefined ? { idleTimeoutSec: recipe.idleTimeoutSec } : {}),
					...(recipe.memoryMb !== undefined ? { memoryMb: recipe.memoryMb } : {}),
					...(recipe.vcpuLimit !== undefined ? { vcpuLimit: recipe.vcpuLimit } : {}),
					...(recipe.spaFallback !== undefined ? { spaFallback: recipe.spaFallback } : {}),
				};
				if (isServerOnly)
					return {
						state: "made",
						...ending.made,
						folder: recipe.folder,
						name: recipe.name,
						title: recipe.title,
						...extra,
					};
				boundary = this.#folderBoundary(folder, ready.machine);
				const judged = await this.#siteBoundary(boundary, ready, folder, budget, run.step, false, signal);
				if (judged === "saved")
					return {
						state: "made",
						...ending.made,
						folder: recipe.folder,
						name: recipe.name,
						title: recipe.title,
						...extra,
					};
				site =
					judged === "carries"
						? { problem: { code: "SITE_HOLDS_SECRET", path: null, variable: null } }
						: missed(judged);
			}
		}
		// The drop, once the collect is known to have ended, and not after its exit 91 (it wrote nothing).
		if (
			("code" in collected && !collected.ended) ||
			(!("code" in collected) && collected.receipt.state === "failed" && collected.receipt.exitCode === 91)
		)
			return site;
		if (signal.aborted) throw signal.reason;
		const dropped = await this.#siteCommand(
			ready,
			folder,
			run,
			"drop",
			{ ...run.base, QORPERA_CHECKS_REPOSITORY: run.repository },
			signal,
		);
		this.#checksReport({
			event: "code-checks",
			step: "dropped",
			...run.step,
			dropped: "code" in dropped ? null : codeSiteDropAnswer(dropped.receipt.output, dropped.receipt.exitCode),
		});
		if (boundary) await this.#siteBoundary(boundary, ready, folder, budget, run.step, true, signal);
		return site;
	}
	/** A refused site's problem as the turn's words may show it (release review, F1): the path the collect named, which
	 * its answer spells `\xHH` for a byte outside printable ASCII and for a backslash, was masked by the transport before
	 * the parser decoded it, so a secret value holding such a byte passed. The decoded path is masked again here with the
	 * mask of the collect's own output (every value the machine's masks cover: the session's, the machine's other
	 * sessions' and their older ones, beyond the collect's own environment). No mask to be had (the session released
	 * meanwhile, or the guest never took the start with these values): the path is not shown. Without secrets (no
	 * broker) nothing is masked, as the transport masks nothing. The variable is a name the answer spells as itself,
	 * already masked; a count of links is a number; every other part of a problem is a fixed word. No part is ever a
	 * byte of a file's content (review round 3 of #1691). The turn's abort is thrown on. */
	async #siteProblemMasked(
		ready: Prepared,
		run: SiteRun,
		problem: CodeSiteProblem,
		signal: AbortSignal,
	): Promise<CodeSiteProblem> {
		const secrets = this.#sessionSecrets(ready);
		if (problem.path === null || !secrets) return problem;
		try {
			const masks = await secrets.output(
				{
					companyId: ready.machine.companyId,
					workerId: ready.claim.workerId,
					machineId: ready.machine.machineId,
					commandId: run.commandId("site"),
					kind: "command",
				},
				signal,
			);
			if (masks === null) return { ...problem, path: null };
			const mask = masks();
			const masked = Buffer.concat([mask.push(Buffer.from(problem.path, "utf8")), mask.end()]);
			return { ...problem, path: masked.toString("utf8") };
		} catch (error) {
			if (signal.aborted) throw signal.reason;
			this.#checksReport({ event: "code-checks-error", step: "mask", ...run.step, error });
			return { ...problem, path: null };
		}
	}
	/** The site's collect or drop as a command of the run (#takeSite), to its end through #checksCommand, with its log
	 * lines: its receipt, or the code of why it did not end on its own and whether it has ended all the same
	 * (#checksCommand's `ended`; not for a command that never started). */
	async #siteCommand(
		ready: Prepared,
		folder: FolderOptions,
		run: SiteRun,
		which: "collect" | "drop",
		environment: Readonly<Record<string, string>>,
		signal: AbortSignal,
	): Promise<{ receipt: CloudCodingCommandReceipt } | { code: string; ended: boolean }> {
		const step = { ...run.step, index: run.index + (which === "drop" ? 1 : 0), site: which };
		let transport: LxdCodingFolderCommandTransport;
		try {
			transport = this.#folderTransport(folder, ready, {
				cwd: `${run.dir}/src`,
				environment,
				authorize: run.authorize,
			});
		} catch (error) {
			this.#checksReport({ event: "code-checks-error", step: "command", ...step, error });
			return { code: errorCodeOf(error), ended: false };
		}
		const command =
			which === "collect"
				? {
						commandId: run.commandId("site"),
						inputSha256: digest(
							JSON.stringify({
								schema: "qorpera.code-site-command/v1",
								commit: run.commit,
								folder: run.recipe.folder,
								// Step 5: said only when links from / are let through, so the input is as before otherwise.
								...(run.rootLinks ? { rootLinks: true } : {}),
							}),
						),
						command: run.recipe.kind === "server" ? CODE_SITE_APP_COLLECT : CODE_SITE_COLLECT,
						timeoutMs: CODE_SITE_COLLECT_MS,
					}
				: {
						commandId: run.commandId("drop"),
						inputSha256: digest(JSON.stringify({ schema: "qorpera.code-site-drop/v1", commit: run.commit })),
						command: CODE_SITE_DROP,
						timeoutMs: CODE_SITE_DROP_MS,
					};
		this.#checksReport({ event: "code-checks", step: "started", ...step });
		const started = performance.now();
		// As the copy's: its output is its answer's lines, read from its receipt, and no failed check's tail is read. Its
		// deadline is its own limit and a minute more, within the run's budget: the transport shows `running` for as long
		// as the machine's reads are not released, also for a command the guest has ended (review, F1). Both signals are
		// the run's own, never the turn's or the process's.
		const bounded = AbortSignal.any([run.budget, AbortSignal.timeout(command.timeoutMs + CODE_CHECKS_SLACK_MS)]);
		const ended = await this.#checksCommand(transport, ready.scope, command, true, bounded, signal, folder);
		const ms = Math.round(performance.now() - started);
		if ("cancelled" in ended) return { code: "CODE_CHECKS_CANCELLED", ended: ended.ended };
		if ("why" in ended) {
			this.#checksReport({
				event: "code-checks",
				step: "ended",
				...step,
				ms,
				state: "not_run",
				...(ended.stopped === undefined ? {} : { stopped: ended.stopped }),
			});
			if (ended.error !== undefined)
				this.#checksReport({ event: "code-checks-error", step: "command", ...step, error: ended.error });
			return { code: ended.code, ended: ended.ended };
		}
		this.#checksReport({
			event: "code-checks",
			step: "ended",
			...step,
			ms,
			state: ended.receipt.state,
			exitCode: ended.receipt.exitCode,
		});
		return { receipt: ended.receipt };
	}
	/** The machine's boundary after the site's collect (#takeSite), judged as `publish` judges it, over every view of the
	 * machine: `saved` when every read was released and every view saved; `carries` when the save check refused paths for
	 * one of the machine's secret values (and nothing else held them); else why not, as a code. Asked again each second
	 * while it is checking or does not answer, for at most CODE_SITE_BOUNDARY_MS (`once`: asked once). The turn's abort
	 * is thrown on. */
	async #siteBoundary(
		control: Pick<CodingFolderControl, "boundary">,
		ready: Prepared,
		folder: FolderOptions,
		budget: AbortSignal,
		step: Record<string, unknown>,
		once: boolean,
		signal: AbortSignal,
	): Promise<string> {
		const live = AbortSignal.any([
			signal,
			budget,
			AbortSignal.timeout(folder.checksBoundaryMs ?? CODE_SITE_BOUNDARY_MS),
		]);
		const pace = Math.min(CODING_FOLDER_CHECK_RETRY_MS, folder.checksPollMs ?? CODING_FOLDER_CHECK_RETRY_MS);
		let boundary: CodingFolderBoundary | undefined;
		let asked = 0;
		for (;;) {
			asked++;
			try {
				boundary = await control.boundary(ready.machine.machineId, [], live);
			} catch (error) {
				if (signal.aborted) throw signal.reason;
				boundary = undefined;
				this.#checksReport({ event: "code-checks-error", step: "boundary", ...step, error });
			}
			if (once || (boundary !== undefined && !codingFolderBoundaryChecking(boundary))) break;
			try {
				await setTimeout(pace, undefined, { signal: live });
			} catch {
				if (signal.aborted) throw signal.reason;
				break;
			}
		}
		const judged = boundary === undefined ? "CODE_SITE_BOUNDARY_UNANSWERED" : siteBoundaryJudged(boundary);
		this.#checksReport({ event: "code-checks", step: "boundary", ...step, again: once, asked, answer: judged });
		return judged;
	}
	/** After a run's copy made its folder (the fence), each command of an earlier run of the session's checks not seen to
	 * end for certain (#checksUncertain) is cancelled and read once more, within CODE_CHECKS_STOP_MS. Any answer but
	 * `running` forgets it: it ended, or the host never kept it, or it is still absent (its provisional `cancelled`
	 * again) or lost, and from now on the fence refuses it if it lands, and the copy has ended whatever of it ran in an
	 * earlier run's folder. Answers the first one that still runs (it stays uncertain), or undefined. The turn's abort
	 * is thrown on, the memory as it was. */
	async #checksLookAgain(
		claim: CodingSessionClaim,
		ready: Prepared,
		folder: FolderOptions,
		home: string,
		environment: Readonly<Record<string, string>>,
		authorize: LxdCodingFolderCommandTransportOptions["authorize"],
		said: Record<string, unknown>,
		signal: AbortSignal,
	): Promise<string | undefined> {
		const uncertain = this.#checksUncertain.get(claim.workerId);
		for (const commandId of [...(uncertain ?? [])]) {
			let end: "ended" | "lost" | "unkept" | "running" = "running";
			try {
				end = await this.#stopChecksCommand(
					this.#folderTransport(folder, ready, { cwd: home, environment, authorize }),
					ready.scope,
					commandId,
					folder,
					signal,
				);
			} catch (error) {
				if (signal.aborted) throw signal.reason;
				this.#checksReport({ event: "code-checks-error", step: "looked", ...said, error });
			}
			this.#checksReport({ event: "code-checks", step: "looked", ...said, commandId, end });
			if (end === "running") return commandId;
			uncertain?.delete(commandId);
			if (uncertain?.size === 0) this.#checksUncertain.delete(claim.workerId);
		}
		return undefined;
	}
	#markChecksMayRun(workerId: string, commandId: string): void {
		const commands = this.#checksMayRun.get(workerId) ?? new Set<string>();
		this.#checksMayRun.set(workerId, commands.add(commandId));
	}
	async #checksCommand(
		transport: LxdCodingFolderCommandTransport,
		scope: CloudCodingCommandScope,
		command: { commandId: string; inputSha256: string; command: string; timeoutMs: number },
		copy: boolean,
		budget: AbortSignal,
		signal: AbortSignal,
		folder: FolderOptions,
		cancel?: AbortSignal,
		onNonSuccess?: () => void,
	): Promise<
		| { receipt: CloudCodingCommandReceipt; tail: string; error?: unknown }
		| { cancelled: true; stopped: boolean; ended: boolean }
		| {
				why: "machine" | "transport" | "authority" | "budget";
				code: string;
				error?: unknown;
				stopped?: boolean;
				ended: boolean;
		  }
	> {
		const live = AbortSignal.any([signal, budget]);
		const pollLive = cancel ? AbortSignal.any([signal, budget, cancel]) : live;
		const unansweredLimitMs =
			folder.checksPollMs === undefined
				? CODE_CHECKS_UNANSWERED_WINDOW_MS
				: CODE_CHECKS_UNANSWERED_READS * folder.checksPollMs;
		const { commandId } = command;
		// The command's last receipt: none while its start was never answered.
		let receipt: CloudCodingCommandReceipt | undefined;
		// Not seen to end for certain: looked at again after the next run's fence.
		const uncertain = () => {
			const commands = this.#checksUncertain.get(scope.workerId) ?? new Set<string>();
			this.#checksUncertain.set(scope.workerId, commands.add(commandId));
		};
		// Whatever runs of it stops, with time of its own: once the turn has given up (its abort is thrown on after, the
		// memories already written), the budget passed, or its calls went unanswered. A stop not confirmed holds every
		// later run of the session's checks before anything. A start never answered is uncertain whatever its stop said
		// (a `cancelled` may be provisional, and the start may land later); one the host never kept is not.
		const stopped = async <T extends object>(then: T): Promise<T & { stopped: boolean; ended: boolean }> => {
			const end = await this.#stopChecksCommand(transport, scope, commandId, folder);
			if (end === "running") this.#markChecksMayRun(scope.workerId, commandId);
			if (end !== "unkept" && (receipt === undefined || end !== "ended")) uncertain();
			if (signal.aborted) throw signal.reason;
			return {
				...then,
				stopped: end !== "running",
				ended: receipt !== undefined && (end === "ended" || end === "lost"),
			};
		};
		const overBudget = { why: "budget" as const, code: "CODE_CHECKS_BUDGET" };
		const siblingCancelled = { cancelled: true as const };
		const failed = (error: unknown) => ({
			why: error instanceof CodingChecksUnauthorized ? ("authority" as const) : ("transport" as const),
			code: errorCodeOf(error),
			error,
		});
		let unanswered: number | undefined;
		let pollAttempt = 0;
		const readWaitMs = folder.checksPollMs === undefined ? CODE_CHECKS_WAIT_MS : 0;
		for (;;) {
			const callStarted = performance.now();
			const wasRunning = receipt !== undefined;
			let callElapsedMs = 0;
			try {
				receipt = receipt
					? await transport.read(
							scope,
							{ commandId, tail: true, limit: 4096 },
							pollLive,
							readWaitMs > 0 ? { waitMs: readWaitMs } : undefined,
						)
					: await transport.start(scope, command, pollLive);
				callElapsedMs = performance.now() - callStarted;
				unanswered = undefined;
				if (receipt.state !== "running") break;
			} catch (error) {
				// Given up (`stopped` throws the turn's abort on), or past the budget.
				if (signal.aborted || budget.aborted) return await stopped(overBudget);
				if (cancel?.aborted) return await stopped(siblingCancelled);
				unanswered ??= performance.now();
				if (performance.now() - unanswered >= unansweredLimitMs) {
					onNonSuccess?.();
					return await stopped(failed(error));
				}
			}
			const delayMs =
				wasRunning && readWaitMs > 0 && callElapsedMs >= 200
					? 50
					: codeChecksPollDelayMs(pollAttempt++, folder.checksPollMs);
			try {
				await setTimeout(delayMs, undefined, {
					signal: pollLive,
				});
			} catch {
				if (signal.aborted || budget.aborted) return await stopped(overBudget);
				if (cancel?.aborted) return await stopped(siblingCancelled);
				return await stopped(overBudget);
			}
		}
		const alreadyCancelled = cancel?.aborted ?? false;
		if (receipt.state !== "succeeded" && !alreadyCancelled) onNonSuccess?.();
		// Ended without a word of how (the guest lost it: its unit is no longer live). The host did not see how, so it is
		// not an end for certain: looked at again after the next run's fence.
		if (receipt.state === "unconfirmed") uncertain();
		let tail = "",
			unread: unknown;
		if (receipt.state === "failed" && !copy && !alreadyCancelled)
			try {
				const end = await transport.read(scope, { commandId, tail: true, limit: 16384 }, live);
				// A read that starts inside the output may start inside a line: from its first whole line, unless it is all
				// one line. The tail's own rule is the words' (codeChecksTail).
				const first = end.log.offset > 0 ? end.output.indexOf("\n") : -1;
				tail = codeChecksTail(
					first >= 0 && first < end.output.length - 1 ? end.output.slice(first + 1) : end.output,
				);
			} catch (error) {
				if (signal.aborted) throw signal.reason;
				unread = error;
			}
		try {
			// Shown as a model's command is, or not at all: the machine may hold a read it no longer may show.
			const hidden = await transport.hidden(commandId, live);
			// The machine shows nothing of its commands now (`unconfirmed`): its receipt said it ended, but nothing of the
			// machine's is believed until it shows its commands again, so it is looked at again after the next run's fence.
			// A machine that stopped, or a disk it no longer has, ended it for certain. Either way it has ended (review, F2).
			if (hidden === "unconfirmed") uncertain();
			if (hidden !== undefined) return { why: "machine", code: `CODE_CHECKS_${hidden.toUpperCase()}`, ended: true };
		} catch (error) {
			if (signal.aborted) throw signal.reason;
			// Its receipt said it ended.
			return { ...(budget.aborted ? overBudget : failed(error)), ended: true };
		}
		return { receipt, tail, ...(unread === undefined ? {} : { error: unread }) };
	}
	/** Cancels one command of a run of the checks and reads it until it has ended, within CODE_CHECKS_STOP_MS: a cancel
	 * that is rejected, or whose receipt still says `running`, is asked again at the next read. Answers whether its end
	 * was confirmed: a receipt in any state but `running` (`machine_stopped` for a machine that stopped or was rebuilt
	 * under it), no start of it the host ever kept (`CODING_COMMAND_UNKNOWN`), or `hidden` saying the machine it ran on
	 * stopped or lost its disk. A cancel's own signal is the bound's, never the turn's: a turn that gave up still stops
	 * what it started. `turn`, when given, is the turn's signal, whose abort is thrown on.
	 *
	 * One `cancelled` is not an end for certain (review round 4, F1): a start the guest never acknowledged may still land
	 * after it, at any time or never, and nothing the host waits for can say which (the transport stops it when it next
	 * reads it, and nothing may read it again). It is believed all the same, and the next run goes on, because such a
	 * command is harmless by the scripts' own rule on the machine: it belongs to a run that is no longer the newest, and
	 * its copy or check finds the newer run's folder (a higher name) and exits 91 having removed, made and run nothing
	 * (CODE_CHECKS_NEWER_RUN). The host also keeps such a command as uncertain (#checksUncertain) and looks at it once
	 * more after the next run's fence stands: a start that landed in the moment before the fence is stopped then,
	 * besides the copy ending every process left in an earlier run's folder. Which answer is certain is the caller's
	 * to judge: it alone knows whether the start was answered.
	 *
	 * Answers `ended` (a receipt in any state but `running` and `unconfirmed`, or `hidden` saying `machine_stopped`),
	 * `lost` (a receipt `unconfirmed`: ended with no word of how), `unkept` (the host never kept a start of it: nothing
	 * of it reached the guest), or `running` (the bound passed: it may still run). */
	async #stopChecksCommand(
		transport: LxdCodingFolderCommandTransport,
		scope: CloudCodingCommandScope,
		commandId: string,
		folder: FolderOptions,
		turn?: AbortSignal,
	): Promise<"ended" | "lost" | "unkept" | "running"> {
		const bound = AbortSignal.timeout(folder.checksStopMs ?? CODE_CHECKS_STOP_MS);
		const checked = turn ? AbortSignal.any([turn, bound]) : bound;
		let pollAttempt = 0;
		for (;;) {
			try {
				const { state } = await transport.cancel(scope, commandId, checked);
				if (state === "unconfirmed") return "lost";
				if (state !== "running") return "ended";
			} catch (error) {
				if (turn?.aborted) throw turn.reason;
				if (error instanceof Error && error.message === "CODING_COMMAND_UNKNOWN") return "unkept";
				try {
					if ((await transport.hidden(commandId, checked)) === "machine_stopped") return "ended";
				} catch {
					if (turn?.aborted) throw turn.reason;
				}
			}
			try {
				await setTimeout(codeChecksPollDelayMs(pollAttempt++, folder.checksPollMs), undefined, { signal: checked });
			} catch {
				if (turn?.aborted) throw turn.reason;
				return "running";
			}
		}
	}
	/** One guest lease step of the session, so the keeper never renews it
	 * between this attach and its first renewal. Resolves with whether, on the folder model, the machine's agent said its
	 * package caches are ready at the mount (#attachSessionNow). */
	#attachSession(
		claim: CodingSessionClaim,
		machine: Readonly<LxdCodingMachineBinding>,
		storage: Readonly<CloudCodingStorageBinding>,
		guest: AttachedGuest,
		scope: CloudCodingCommandScope,
		signal: AbortSignal,
	): Promise<boolean> {
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
	): Promise<boolean> {
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
		const attached = receiptRecord(
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
			!UUID_PATTERN.test(attached.attachmentToken) ||
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
			...(guest.folder ? { folder: guest.folder } : {}),
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
			const { viewId, replaced, packageCaches } = await this.#exclusive(machine.machineId, signal, () =>
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
				packageCaches,
			});
			// What the agent said of the machine's package caches at this mount: the turn's commands get them only then.
			return packageCaches;
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
		return false;
	}
	/** A turn as SQL names it in an attachment: its sequence, its turn id and whether it may start commands. */
	#attachedTurn(value: unknown): Attachment["turn"] {
		const turn = receiptRecord(value);
		if (
			!Number.isSafeInteger(turn.sequence) ||
			Number(turn.sequence) < 1 ||
			typeof turn.turnId !== "string" ||
			!UUID_PATTERN.test(turn.turnId) ||
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
			CODING_GUEST_HELPER_MAX_BYTES,
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
		const root = await this.#directory("git", signal),
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
				if (claim.surfaceSession) {
					if (!repositories?.verifyStaged) throw new Error("CODING_REPOSITORY_NOT_HERE");
					const staged = await repositories.verifyStaged(
						this.#repositorySession(claim, ready.machine, ready.storage, ready.folder.uid, ready.baseSha, root),
						submission.headSha,
						signal,
					);
					return {
						pullRequest: null,
						noChange: !staged.changed,
						staged: {
							branch: staged.branch,
							baseSha: staged.baseSha,
							headSha: staged.headSha,
							filesChanged: staged.filesChanged,
						},
					};
				}
				if (!repositories?.land) throw new Error("CODING_REPOSITORY_NOT_HERE");
				if (submission.headSha === ready.baseSha) return { pullRequest: null, noChange: true };
				// The picture the session named with its hand-in is checked by the landing, in the commit that lands.
				const landed = await repositories.land(
					this.#repositorySession(claim, ready.machine, ready.storage, ready.folder.uid, ready.baseSha, root),
					submission.headSha,
					signal,
					submission.picture === undefined ? {} : { picture: submission.picture },
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
		this.#sessionSetups.delete(claim.workerId);
		try {
			await this.#takeOff(
				attached.machine,
				attached.storage,
				{ workerId: claim.workerId, leaseToken: claim.leaseToken },
				[],
				signal,
			);
		} finally {
			this.#setupLifecycle.forgetSession(attached.machine.machineId, claim.workerId);
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
		folderUid?: number,
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
					const uid =
						folderUid ??
						this.#attachments.get(session.workerId)?.folder?.uid ??
						this.#prepared.get(session.workerId)?.folder?.uid;
					if (
						uid !== undefined &&
						this.#setupLifecycle.trackedTerminals(machine.machineId, session.workerId).length > 0
					) {
						await this.#setupLifecycle
							.onDetach(
								machine.machineId,
								session.workerId,
								this.#guestDetachRunner(guest, session.workerId, uid),
							)
							.catch(() => undefined);
					}
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
				this.#setupLifecycle.forgetSession(machine.machineId, session.workerId);
				this.#sessionSetups.delete(session.workerId);
				this.#commandSecrets?.release(machine.machineId, session.workerId);
				return;
			}
			if (!instance) {
				this.#commandSecrets?.release(machine.machineId, session.workerId);
				return;
			}
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
			this.#commandSecrets?.release(machine.machineId, session.workerId);
		});
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
		const value = receiptRecord(
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
		const current = this.#attachments.get(workerId);
		if (current?.token === token) {
			this.#attachments.delete(workerId);
			this.#attachSerials.delete(workerId);
		}
		if (!current || current.token === token || current.machine.machineId !== machine.machineId) {
			this.#commandSecrets?.release(machine.machineId, workerId);
		}
		this.#samples.delete(workerId);
		this.#folderUidCache.delete(workerId);
		this.#sessionSetups.delete(workerId);
		this.#setupLifecycle.forgetSession(machine.machineId, workerId);
		this.#deleteKeptCommandsForWorker(workerId);
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
		const value = receiptRecord(
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
		this.#forgetDetached(machine.machineId, ended);
		this.#commandSecrets?.releaseMachine(machine.machineId);
		this.#helperBoots.delete(machine.machineId);
		this.#settledBoots.delete(machine.machineId);
		this.#folderStartOperations.delete(machine.machineId);
		this.#cpuHighSamples.delete(machine.machineId);
		this.#setupLifecycle.onMachineStopped(machine.machineId);
	}
	/** SQL marks the machine to restart for the company folder (rule 4), or with `newDisk` for a new disk (rule 4,
	 * `unreadable`), which marks it to restart too. From then on no coding view opens on it. A mark already there stays. */
	async #markForFolder(
		machine: Readonly<LxdCodingMachineBinding>,
		newDisk: boolean,
		signal: AbortSignal,
	): Promise<void> {
		const value = receiptRecord(
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
		const value = receiptRecord(
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
		this.#forgetDetached(machine.machineId, ended);
		if (value.state !== "unmarked") this.#commandSecrets?.releaseMachine(machine.machineId);
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
		const value = receiptRecord(
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
		this.#forgetDetached(machine.machineId, ended);
		this.#commandSecrets?.releaseMachine(machine.machineId);
		this.#helperBoots.delete(machine.machineId);
		this.#settledBoots.delete(machine.machineId);
		this.#folderStartOperations.delete(machine.machineId);
		this.#cpuHighSamples.delete(machine.machineId);
		this.#setupLifecycle.onMachineNewDisk(machine.machineId);
		await this.#recordError(machine.machineId, "wake", null, signal).catch(() => undefined);
	}
	/** The sessions SQL detached are no longer attached here. */
	#forgetDetached(machineId: string, ended: readonly { workerId: string; attachmentToken: string }[]): void {
		for (const { workerId, attachmentToken } of ended) {
			const current = this.#attachments.get(workerId);
			if (current?.token === attachmentToken) {
				this.#attachments.delete(workerId);
				this.#attachSerials.delete(workerId);
			}
			if (!current || current.token === attachmentToken || current.machine.machineId !== machineId) {
				this.#commandSecrets?.release(machineId, workerId);
				this.#setupLifecycle.forgetSession(machineId, workerId);
				this.#sessionSetups.delete(workerId);
			}
			this.#samples.delete(workerId);
			this.#folderUidCache.delete(workerId);
			this.#checksMayRun.delete(workerId);
			this.#checksUncertain.delete(workerId);
			this.#deleteKeptCommandsForWorker(workerId);
		}
	}
	#deleteKeptCommandsForWorker(workerId: string): void {
		const prefix = `${workerId}:`;
		for (const key of this.#keptCommands.keys()) {
			if (key.startsWith(prefix)) this.#keptCommands.delete(key);
		}
	}
	async #keptCommand(
		custody: string,
		workerId: string,
		commandId: string,
		signal: AbortSignal,
	): Promise<{ turn: number; command: string } | undefined> {
		const cacheKey = `${workerId}:${commandId}`;
		const cached = this.#keptCommands.get(cacheKey);
		if (cached) {
			this.#keptCommands.delete(cacheKey);
			this.#keptCommands.set(cacheKey, cached);
			return cached;
		}
		const kept = await this.#storageTask(() => codingFolderKeptCommand(custody, workerId, commandId), signal);
		if (!kept) return undefined;
		const entry = { turn: kept.turn, command: clipped(kept.command, CODING_OBSERVED_COMMAND_BYTES) };
		if (this.#keptCommands.size >= CODING_KEPT_COMMAND_CACHE_MAX) {
			const oldest = this.#keptCommands.keys().next().value;
			if (oldest !== undefined) this.#keptCommands.delete(oldest);
		}
		this.#keptCommands.set(cacheKey, entry);
		return entry;
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
		const outcomes = (await Promise.all(entries.map((entry) => this.#keepMachine(entry, signal, lasting)))).flat();
		const activeMachines = new Set(entries.map((entry) => entry.machineId));
		for (const machineId of this.#cpuHighSamples.keys())
			if (!activeMachines.has(machineId)) this.#cpuHighSamples.delete(machineId);
		// Forget what no machine carries any more, unless a turn took it on during this pass.
		for (const [workerId, attachment] of this.#attachments)
			if (!kept.has(workerId) && attachment.since < pass) {
				this.#attachments.delete(workerId);
				this.#attachSerials.delete(workerId);
				this.#samples.delete(workerId);
				this.#folderUidCache.delete(workerId);
				if (!this.#releasing.has(workerId)) {
					this.#setupLifecycle.forgetSession(attachment.machine.machineId, workerId);
					this.#sessionSetups.delete(workerId);
				}
				this.#commandSecrets?.release(attachment.machine.machineId, workerId);
			}
		for (const workerId of this.#folderUidCache.keys())
			if (!kept.has(workerId) && !this.#attachments.has(workerId)) this.#folderUidCache.delete(workerId);
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
	async #keepMachine(
		entry: ListedMachine,
		passSignal: AbortSignal,
		signal: AbortSignal,
	): Promise<CodingKeepOutcome[]> {
		let machine: LxdCodingMachineBinding;
		let bindingText: string;
		try {
			const plan = lxdCodingMachinePlan(entry.binding as unknown as LxdCodingMachineBinding);
			machine = plan.binding;
			if (machine.machineId !== entry.machineId) throw new Error("CODING_HOST_MACHINE_LIST_INVALID");
			bindingText = plan.text;
		} catch (error) {
			passSignal.throwIfAborted();
			return [
				{ machineId: entry.machineId, workerId: null, step: "keep", state: "failed", code: errorCodeOf(error) },
			];
		}
		const keepMs = this.#options.keepDeadlineMs ?? CODING_KEEP_MACHINE_MS;
		const keepDeadline = AbortSignal.any([passSignal, AbortSignal.timeout(keepMs)]);
		let observedBootId: string | null = null;
		let activeCpu: { workerId: string; cpuMillis: number }[] | null = null;
		let keepFailed = false;
		let keepTimedOut = false;
		let keepOutcomes: CodingKeepOutcome[];
		try {
			keepOutcomes = await abortable(
				(async (): Promise<CodingKeepOutcome[]> => {
					const attaches = new Map(
						entry.attached.map(({ workerId }) => [workerId, this.#attachSerials.get(workerId)]),
					);
					const generations = new Map(
						entry.attached.map(({ workerId, attachmentToken }) => [workerId, digest(attachmentToken)]),
					);
					const folder = this.#options.folder;
					const secrets = folder?.control.secrets(machine.machineId, keepDeadline).then(
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
							const code = keepDeadline.aborted ? "CODING_HOST_KEEP_DEADLINE" : errorCodeOf(error);
							return [{ machineId: machine.machineId, workerId: null, step: "secrets", state: "failed", code }];
						},
					);
					const observed = folder
						? await this.#observeFolder(
								folder,
								machine,
								entry.attached.map(({ workerId }) => workerId),
								keepDeadline,
							)
						: await this.#observe(machine, keepDeadline);
					const lost = new Set<string>();
					const sessions: { workerId: string; busy: boolean; running: ObservedCommand[] }[] = [];
					const sessionCpu: { workerId: string; cpuMillis: number }[] = [];
					for (const [workerId, seen] of observed.sessions) {
						if (seen.lease?.expiresInMs === 0 && seen.lease.tokenSha256 === generations.get(workerId)) {
							lost.add(workerId);
							continue;
						}
						const sample = this.#samples.get(workerId);
						const now: SessionSample = {
							bootId: observed.bootId,
							cpuSeconds: seen.cpuUsageUsec / 1e6,
							cpuUsageUsec: seen.cpuUsageUsec,
							ioBytes: seen.ioBytes,
							at: seen.uptimeMs,
						};
						const busy =
							!seen.ioComplete ||
							(sample !== undefined && sample.bootId === observed.bootId && idleRuleBusy(sample, now));
						const cpuMillis = sessionCpuMillis(sample, observed.bootId, seen.uptimeMs, seen.cpuUsageUsec);
						this.#samples.set(workerId, now);
						sessions.push({ workerId, busy, running: seen.running });
						sessionCpu.push({ workerId, cpuMillis });
					}
					const started = performance.now();
					const kept = receiptRecord(
						await this.#call(
							"qorpera_keep_coding_attachments",
							{
								p_machine_id: machine.machineId,
								p_owner: this.#options.owner,
								p_binding_text: bindingText,
								p_machine_id_sha256: this.#options.machineIdSha256,
								p_observation: {
									schema: "qorpera.coding-machine-observation/v1",
									busy: sessions.some((session) => session.busy),
									sessions,
								},
							},
							keepDeadline,
						),
					);
					if (
						kept.schema !== "qorpera.coding-attachments/v1" ||
						kept.machineId !== machine.machineId ||
						!Array.isArray(kept.sessions)
					)
						throw new Error("CODING_HOST_ATTACHMENTS_INVALID");
					const items = kept.sessions.map((value) => {
						const item = receiptRecord(value);
						const workerId =
							typeof item.workerId === "string" && UUID_PATTERN.test(item.workerId) ? item.workerId : null;
						if (!workerId || typeof item.attachmentToken !== "string" || !UUID_PATTERN.test(item.attachmentToken))
							throw new Error("CODING_HOST_ATTACHMENTS_INVALID");
						return { workerId, item };
					});
					const renewals: Promise<CodingKeepOutcome>[] = [];
					const keptWorkers = new Set<string>();
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
								renewals.push(Promise.resolve(outcome("not-now", "GUEST_LEASE_EXPIRED")));
								continue;
							}
							keptWorkers.add(workerId);
							renewals.push(
								abortable(
									this.#leaseTask(workerId, async () => {
										keepDeadline.throwIfAborted();
										if (this.#attachSerials.get(workerId) !== attaches.get(workerId)) return false;
										const attachment = await this.#attachmentOn(
											machine,
											workerId,
											item,
											observed.bootId,
											keepDeadline,
										);
										if (!folder)
											await this.#refreshGuestLease(
												attachment,
												started + Number(item.validForMs),
												keepDeadline,
											);
										return true;
									}),
									keepDeadline,
								).then(
									(renewed) => (renewed ? outcome("done") : outcome("not-now", "TURN_ATTACHED")),
									(error: unknown) => {
										signal.throwIfAborted();
										return outcome(
											"failed",
											keepDeadline.aborted ? "CODING_HOST_KEEP_DEADLINE" : errorCodeOf(error),
										);
									},
								),
							);
						} else if (
							item.state === "release" &&
							typeof item.reason === "string" &&
							/^[A-Z_]{1,64}$/.test(item.reason)
						)
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
					// WHY: Wait for renewals so adopted attachments recover folder.uid before #recordMachineLoad queries user-<uid>.slice.
					const renewalOutcomes = await Promise.all(renewals);
					observedBootId = observed.bootId;
					activeCpu = sessionCpu.filter(({ workerId }) => keptWorkers.has(workerId));
					return [...renewalOutcomes, ...((await secrets) ?? [])];
				})(),
				keepDeadline,
			);
		} catch (error) {
			passSignal.throwIfAborted();
			keepFailed = true;
			keepTimedOut = keepDeadline.aborted;
			keepOutcomes = [
				{
					machineId: machine.machineId,
					workerId: null,
					step: "keep",
					state: "failed",
					code: keepTimedOut ? "CODING_HOST_KEEP_DEADLINE" : errorCodeOf(error),
				},
			];
		}
		// WHY: Run load reporting under its own deadline so a slow or timed-out observation never suppresses fullness reporting.
		const loadDeadline = AbortSignal.any([passSignal, AbortSignal.timeout(keepMs)]);
		const loadSessions: readonly { workerId: string; cpuMillis: number | null }[] =
			activeCpu ?? entry.attached.map(({ workerId }) => ({ workerId, cpuMillis: null }));
		const loadOutcomes = await abortable(
			this.#recordMachineLoad(machine, bindingText, observedBootId, loadSessions, activeCpu !== null, loadDeadline),
			loadDeadline,
		).then(
			(): CodingKeepOutcome[] => [],
			(error: unknown): CodingKeepOutcome[] => {
				if (signal.aborted || passSignal.aborted) return [];
				if (keepFailed && !keepTimedOut) return [];
				const code = loadDeadline.aborted ? "CODING_HOST_KEEP_DEADLINE" : errorCodeOf(error);
				return [{ machineId: machine.machineId, workerId: null, step: "load", state: "failed", code }];
			},
		);
		return [...keepOutcomes, ...loadOutcomes];
	}
	async #recordMachineLoad(
		machine: Readonly<LxdCodingMachineBinding>,
		bindingText: string,
		bootId: string | null,
		sessions: readonly { workerId: string; cpuMillis: number | null }[],
		cpuObserved: boolean,
		signal: AbortSignal,
	): Promise<void> {
		const name = lxdCodingMachineName(machine.machineId);
		const folder = this.#options.folder;
		const resolvedUids = new Map<string, number>();
		if (folder) {
			const missingUidWorkers: string[] = [];
			for (const { workerId } of sessions) {
				const attachment = this.#attachments.get(workerId);
				const knownUid =
					attachment && (bootId === null || attachment.bootId === bootId) && attachment.folder
						? attachment.folder.uid
						: null;
				if (knownUid !== null) resolvedUids.set(workerId, knownUid);
				else missingUidWorkers.push(workerId);
			}
			if (missingUidWorkers.length > 0) {
				const lookedUp = await Promise.all(
					missingUidWorkers.map(async (workerId) => ({
						workerId,
						uid: await this.#adoptedFolderUid(machine, workerId, undefined, bootId, signal),
					})),
				);
				for (const { workerId, uid } of lookedUp) if (uid !== null) resolvedUids.set(workerId, uid);
			}
		}
		const groupsByWorker = new Map<string, string[]>();
		const allGroups: string[] = [];
		for (const { workerId } of sessions) {
			const worker32 = workerId.replaceAll("-", "");
			const paths = [
				`/sys/fs/cgroup/qorpera.slice/qorpera-coding.slice/qorpera-coding-${worker32}.slice/memory.stat`,
			];
			if (folder) {
				paths.push(
					`/sys/fs/cgroup/qorpera-folder.slice/qorpera-folder-${worker32}.service/memory.stat`,
					`/sys/fs/cgroup/system.slice/qorpera-folder-${worker32}.service/memory.stat`,
				);
				const uid = resolvedUids.get(workerId);
				if (uid !== undefined) paths.push(`/sys/fs/cgroup/user.slice/user-${uid}.slice/memory.stat`);
			}
			groupsByWorker.set(workerId, paths);
			allGroups.push(...paths);
		}
		const { meminfo, stats } = await this.#options.client.readCodingMachineMemory(
			machine.project,
			name,
			allGroups,
			signal,
		);
		const meminfoFull = meminfoMemoryFull(meminfo);
		let totalCpuMillis = 0;
		let totalMemoryBytes = 0;
		const measured = sessions.map(({ workerId, cpuMillis }) => {
			let memoryBytes = 0;
			for (const path of groupsByWorker.get(workerId) ?? [])
				memoryBytes += cgroupMemoryStatBytes(stats.get(path) ?? "");
			memoryBytes = Math.min(CODING_LOAD_MAX_MEMORY_BYTES, memoryBytes);
			if (cpuMillis !== null) totalCpuMillis += cpuMillis;
			totalMemoryBytes += memoryBytes;
			return { workerId, cpuMillis, memoryBytes };
		});
		const cpuHigh = cpuObserved && totalCpuMillis * 100 >= machine.cpus * 1000 * CODING_LOAD_CPU_FULL_PERCENT;
		let cpuFull = false;
		if (cpuObserved && bootId !== null) {
			if (cpuHigh) {
				const prior = this.#cpuHighSamples.get(machine.machineId);
				const count = prior && prior.bootId === bootId ? prior.count + 1 : 1;
				this.#cpuHighSamples.set(machine.machineId, { bootId, count });
				cpuFull = count >= CODING_LOAD_CPU_HYSTERESIS_SAMPLES;
			} else {
				this.#cpuHighSamples.delete(machine.machineId);
			}
		}
		const memoryFull = totalMemoryBytes * 100 >= machine.memoryBytes * CODING_LOAD_MEMORY_FULL_PERCENT;
		const full: boolean | null = cpuObserved
			? meminfoFull || memoryFull || cpuFull
			: meminfoFull || memoryFull
				? true
				: null;
		const recorded = receiptRecord(
			await this.#call(
				"qorpera_record_coding_machine_load",
				{
					p_machine_id: machine.machineId,
					p_owner: this.#options.owner,
					p_binding_text: bindingText,
					p_machine_id_sha256: this.#options.machineIdSha256,
					p_load: {
						schema: "qorpera.coding-machine-load/v1",
						full,
						sessions: measured,
					},
				},
				signal,
			),
		);
		if (
			recorded.schema !== "qorpera.coding-machine-load-recorded/v1" ||
			recorded.machineId !== machine.machineId ||
			!Number.isSafeInteger(recorded.sessions) ||
			Number(recorded.sessions) < 0
		)
			throw new Error("CODING_HOST_MACHINE_LOAD_INVALID");
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
		const folderUid = this.#attachments.get(workerId)?.folder?.uid ?? prepared?.folder?.uid;
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
				folderUid,
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
			const folder =
				known.folder ??
				(this.#options.folder
					? await this.#adoptedFolderUid(machine, workerId, item, bootId, signal).then((uid) =>
							uid !== null ? { uid } : undefined,
						)
					: undefined);
			const next: Attachment =
				known.token === token && known.turn.sequence === turn.sequence
					? { ...known, ...(folder ? { folder } : {}), turn: { ...turn, open: turn.open && known.turn.open } }
					: { ...known, ...(folder ? { folder } : {}), token, turn };
			this.#attachments.set(workerId, next);
			return next;
		}
		const folderUid = this.#options.folder
			? await this.#adoptedFolderUid(machine, workerId, item, bootId, signal)
			: null;
		const adopted: Attachment = {
			workerId,
			machine,
			storage: lxdCodingSessionStorage(machine, this.#placement, workerId),
			bootId,
			guestConfigSha256: this.#options.folder
				? this.#folderSessionSha(workerId, machine.machineId, bootId)
				: await this.#installedConfiguration(machine, workerId, bootId, signal),
			token,
			turn,
			since: performance.now(),
			...(folderUid !== null ? { folder: { uid: folderUid } } : {}),
		};
		this.#attachments.set(workerId, adopted);
		return adopted;
	}
	async #adoptedFolderUid(
		machine: Readonly<LxdCodingMachineBinding>,
		workerId: string,
		item: Record<string, unknown> | undefined,
		bootId: string | null,
		signal: AbortSignal,
	): Promise<number | null> {
		const fromSql = validGuestUid(item?.guestUid);
		if (fromSql !== null) {
			if (bootId !== null) this.#folderUidCache.set(workerId, { bootId, uid: fromSql });
			return fromSql;
		}
		if (bootId !== null) {
			const cached = this.#folderUidCache.get(workerId);
			if (cached && cached.bootId === bootId) return cached.uid;
		}
		// WHY: Bound fallback guest file reads so slow lookups cannot exhaust loadDeadline before readCodingMachineMemory runs.
		const lookupMs = Math.min(
			CODING_LOAD_UID_LOOKUP_MS,
			Math.max(10, Math.floor((this.#options.keepDeadlineMs ?? CODING_KEEP_MACHINE_MS) / 4)),
		);
		const lookupDeadline = AbortSignal.any([signal, AbortSignal.timeout(lookupMs)]);
		try {
			const file = await abortable(
				this.#options.client.readInstanceFile(
					machine.project,
					lxdCodingMachineName(machine.machineId),
					`${CODING_GUEST.state}/sessions/${workerId.replaceAll("-", "")}/user.json`,
					1024,
					lookupDeadline,
				),
				lookupDeadline,
			);
			const uid =
				file.uid === 0 && file.gid === 0
					? (() => {
							const parsed = receiptRecord(JSON.parse(file.content.toString("utf8")));
							return parsed.schema === "qorpera.coding-guest-session-user/v1" ? validGuestUid(parsed.uid) : null;
						})()
					: null;
			if (bootId !== null) this.#folderUidCache.set(workerId, { bootId, uid });
			return uid;
		} catch (error) {
			if (signal.aborted) throw error;
			if (bootId !== null && !lookupDeadline.aborted) this.#folderUidCache.set(workerId, { bootId, uid: null });
			return null;
		}
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
		const configuration = receiptRecord(JSON.parse(content));
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
		if (boot.uid !== 0 || boot.gid !== 0 || !UUID_PATTERN.test(bootId))
			throw new Error("CODING_HOST_BOOT_UNCONFIRMED");
		// The helper this process runs as root in the guest is the pinned one, checked once per boot.
		if (this.#helperBoots.get(machine.machineId) !== bootId) {
			const helper = await client.readInstanceFile(
				machine.project,
				name,
				"/opt/qorpera-coding/cloud-coding-storage-guest.mjs",
				CODING_GUEST_HELPER_MAX_BYTES,
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
			return receiptRecord(JSON.parse(file.content.toString("utf8")));
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
			const session = receiptRecord(entry);
			const lease = session.lease === null ? null : receiptRecord(session.lease);
			if (
				typeof session.workerId !== "string" ||
				!UUID_PATTERN.test(session.workerId) ||
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
					const c = receiptRecord(command);
					if (
						typeof c.commandId !== "string" ||
						!UUID_PATTERN.test(c.commandId) ||
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
		if (workerIds.length === 0) return { bootId, sessions: new Map() };
		const guest = new LxdCodingGuestClient({ machine, client: folder.client });
		let batched: Awaited<ReturnType<LxdCodingGuestClient["statusAll"]>> | undefined;
		if (typeof guest.statusAll === "function") {
			try {
				batched = await guest.statusAll({ schema: "qorpera.coding-guest-status-all/v1", workerIds }, signal);
			} catch (error) {
				if (
					!(
						error instanceof CodingGuestRefused &&
						(error.code === "CODING_GUEST_ARGUMENTS_INVALID" || error.code === "CODING_GUEST_REQUEST_INVALID")
					)
				)
					throw error;
			}
		}
		if (batched) {
			if (batched.bootId !== bootId) throw new Error("CODING_HOST_OBSERVATION_UNCONFIRMED");
			const entries = await mapBounded(
				batched.sessions,
				CODING_OBSERVE_CONCURRENCY,
				signal,
				async (
					session,
					itemSignal,
				): Promise<readonly [string, Observed["sessions"] extends Map<string, infer V> ? V : never]> => {
					if (session.usage.bootId !== bootId) throw new Error("CODING_HOST_OBSERVATION_UNCONFIRMED");
					const custody = lxdCodingSessionStorage(machine, this.#placement, session.workerId).custodySource;
					const running: ObservedCommand[] = [];
					for (const { commandId, state } of session.commands) {
						if (state !== "running" || running.length >= 64) continue;
						const kept = await this.#keptCommand(custody, session.workerId, commandId, itemSignal);
						if (kept) running.push({ commandId, turn: kept.turn, command: kept.command });
					}
					const { uptimeMs, cpuUsageUsec, ioBytes, ioComplete } = session.usage;
					return [session.workerId, { uptimeMs, cpuUsageUsec, ioBytes, ioComplete, running, lease: null }];
				},
			);
			return { bootId, sessions: new Map(entries) };
		}
		const entries = await mapBounded(
			workerIds,
			CODING_OBSERVE_CONCURRENCY,
			signal,
			async (
				workerId,
				itemSignal,
			): Promise<readonly [string, Observed["sessions"] extends Map<string, infer V> ? V : never]> => {
				const status = await guest.status({ schema: "qorpera.coding-guest-session/v1", workerId }, itemSignal);
				if (status.usage.bootId !== bootId) throw new Error("CODING_HOST_OBSERVATION_UNCONFIRMED");
				const custody = lxdCodingSessionStorage(machine, this.#placement, workerId).custodySource;
				const running: ObservedCommand[] = [];
				for (const { commandId, state } of status.commands) {
					if (state !== "running" || running.length >= 64) continue;
					const kept = await this.#keptCommand(custody, workerId, commandId, itemSignal);
					if (kept) running.push({ commandId, turn: kept.turn, command: kept.command });
				}
				const { uptimeMs, cpuUsageUsec, ioBytes, ioComplete } = status.usage;
				return [workerId, { uptimeMs, cpuUsageUsec, ioBytes, ioComplete, running, lease: null }];
			},
		);
		return { bootId, sessions: new Map(entries) };
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
	localRunBinding(scope: CloudCodingCommandScope): CodingLocalRunBinding | undefined {
		const ready = this.#prepared.get(scope.workerId);
		if (!ready || !isDeepStrictEqual(scope, ready.scope)) return undefined;
		return {
			workerId: ready.claim.workerId,
			leaseToken: ready.claim.leaseToken,
			bindingText: lxdCodingMachinePlan(ready.machine).text,
			storage: ready.storage,
			machineIdSha256: this.#options.machineIdSha256,
		};
	}
	async commandTransport(
		scope: CloudCodingCommandScope,
		authorize: ConstructorParameters<typeof LxdCodingCommandTransport>[0]["authorize"],
		signal: AbortSignal,
		preAuthorized?: CodingCommandTurnContext,
	): Promise<LxdCodingCommandTransport | LxdCodingFolderCommandTransport> {
		const ready = this.#prepared.get(scope.workerId);
		if (!ready || !isDeepStrictEqual(scope, ready.scope)) throw new Error("CODING_HOST_TURN_NOT_PREPARED");
		const folder = this.#options.folder;
		const hasPreRun = preAuthorized?.runAuthority !== undefined && preAuthorized.runAuthority !== null;
		if (hasPreRun) {
			await this.#verifyRunAuthority(
				ready.claim,
				ready.machine,
				ready.storage,
				preAuthorized.runAuthority,
				preAuthorized.startedAt ?? performance.now(),
				signal,
			);
		} else {
			await this.#run(ready.claim, ready.machine, ready.storage, signal);
		}
		const host = this.#commandAuthority(ready);
		let preConsumed = false;
		const checkedAuthorize: typeof authorize = async (action, checkedScope, commandId, inputSha256, checked) => {
			if (hasPreRun && !preConsumed) {
				preConsumed = true;
				this.#current(ready);
				if (folder && ready.folder && action !== "cancel" && preAuthorized.rebuildDue)
					throw new Error("CODING_HOST_MACHINE_REFUSED:MACHINE_NEW_DISK");
				return;
			}
			if (hasPreRun) {
				this.#current(ready);
				await authorize(action, checkedScope, commandId, inputSha256, checked);
				const post = preAuthorized.postAuthority;
				if (post?.runAuthority !== undefined && post.runAuthority !== null) {
					await this.#verifyRunAuthority(
						ready.claim,
						ready.machine,
						ready.storage,
						post.runAuthority,
						post.startedAt ?? performance.now(),
						checked,
					);
					if (folder && ready.folder && action !== "cancel" && post.rebuildDue)
						throw new Error("CODING_HOST_MACHINE_REFUSED:MACHINE_NEW_DISK");
					return;
				}
				await host(action, checkedScope, commandId, inputSha256, checked);
				return;
			}
			await host(action, checkedScope, commandId, inputSha256, checked);
			await authorize(action, checkedScope, commandId, inputSha256, checked);
		};
		if (folder && ready.folder) {
			const setupEnv = this.#sessionSetups.get(ready.claim.workerId)?.env;
			return this.#folderTransport(folder, ready, {
				cwd: ready.folder.cwd,
				environment: {
					...setupEnv,
					...codingFolderGitEnvironment(ready.claim.workerId),
					...packageCacheEnvironment(ready),
				},
				authorize: checkedAuthorize,
				...(preAuthorized ? { context: preAuthorized } : {}),
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
	#commandAuthority(ready: Prepared): LxdCodingFolderCommandTransportOptions["authorize"] {
		const folder = this.#options.folder;
		return async (action, _scope, _commandId, _inputSha256, checked) => {
			this.#current(ready);
			await this.#run(ready.claim, ready.machine, ready.storage, checked);
			if (folder && ready.folder && action !== "cancel" && (await this.#newDiskDue(ready.machine, checked)))
				throw new Error("CODING_HOST_MACHINE_REFUSED:MACHINE_NEW_DISK");
		};
	}
	#folderTransport(
		folder: FolderOptions,
		ready: Prepared,
		session: {
			cwd: string;
			environment: Readonly<Record<string, string>>;
			allowedSecrets?: readonly string[];
			authorize: LxdCodingFolderCommandTransportOptions["authorize"];
			context?: CodingCommandTurnContext;
		},
	): LxdCodingFolderCommandTransport {
		if (!ready.folder) throw new Error("CODING_HOST_TURN_NOT_PREPARED");
		const { machineId } = ready.machine;
		const context = session.context;
		let unreadableSeen = false;
		return new LxdCodingFolderCommandTransport({
			machine: ready.machine,
			scope: ready.scope,
			currentStart: () => this.#folderStartOperations.get(machineId),
			session: {
				uid: ready.folder.uid,
				gid: ready.folder.uid,
				cwd: session.cwd,
				environment: session.environment,
				...(session.allowedSecrets === undefined ? {} : { allowedSecrets: session.allowedSecrets }),
			},
			custody: ready.storage.custodySource,
			limitBytes: this.#options.guest.resourceProfile.maxLogBytes,
			guest: new LxdCodingGuestClient({ machine: ready.machine, client: folder.client }),
			control: this.#folderBoundary(folder, ready.machine, () => {
				unreadableSeen = true;
			}),
			withheld: async (checked) => {
				if (unreadableSeen) return true;
				if (context?.postAuthority?.rebuildDue !== undefined) return context.postAuthority.rebuildDue;
				if (context?.rebuildDue !== undefined) return context.rebuildDue;
				return this.#newDiskDue(ready.machine, checked);
			},
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
			authorize: session.authorize,
			secrets: this.#sessionSecrets(ready),
			...(context?.vaultEnvVersion === undefined ? {} : { vaultEnvVersion: context.vaultEnvVersion }),
		});
	}
	#folderBoundary(
		folder: FolderOptions,
		machine: Readonly<LxdCodingMachineBinding>,
		onUnreadable?: () => void,
	): Pick<CodingFolderControl, "boundary"> & Partial<Pick<CodingFolderControl, "releaseReads">> {
		let marked = false;
		const markUnreadable = async (unreadable: boolean, checked: AbortSignal) => {
			if (unreadable) onUnreadable?.();
			if (!marked && unreadable)
				marked = await this.#markForFolder(machine, true, checked).then(
					() => true,
					() => false,
				);
		};
		const releaseReads = folder.control.releaseReads;
		return {
			boundary: async (id, final, checked) => {
				const boundary = await folder.control.boundary(id, final, checked);
				await markUnreadable(codingFolderBoundaryUnreadable(boundary), checked);
				return boundary;
			},
			...(releaseReads
				? {
						releaseReads: async (id, checked) => {
							const released = await releaseReads.call(folder.control, id, checked);
							await markUnreadable(released.reads === "unreadable", checked);
							return released;
						},
					}
				: {}),
		};
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
		signal.throwIfAborted();
		const steps = listed
			.map((value) => this.#listed(value))
			.flatMap((entry) => {
				const step: "sleep" | "delete" | null =
					entry.released || entry.removeDue ? "delete" : entry.sleepDue ? "sleep" : null;
				return step ? [{ entry, step }] : [];
			});
		const stepOutcomes = await mapBounded(
			steps,
			CODING_HOUSEKEEP_CONCURRENCY,
			signal,
			async ({ entry, step }, stepSignal): Promise<CodingHousekeepingOutcome> => {
				try {
					await this.#exclusive(entry.machineId, stepSignal, async () => {
						if (step === "sleep") await this.#sleep(entry, stepSignal);
						else await this.#remove(entry, stepSignal);
					});
					if (entry.lastError)
						await this.#recordError(entry.machineId, step, null, stepSignal).catch(() => undefined);
					return { machineId: entry.machineId, step, state: "done" };
				} catch (error) {
					if (error instanceof CodingCustodyRefused) {
						return { machineId: entry.machineId, step, state: "not-now", code: error.reason };
					}
					stepSignal.throwIfAborted();
					// A release that failed after the delete is its own step: the machine is gone, its capacity is not.
					const failed = error instanceof CodingReleaseFailed ? "release" : step;
					const failure = errorCodeOf(error);
					await this.#recordError(entry.machineId, failed, failure, stepSignal).catch(() => undefined);
					return { machineId: entry.machineId, step: failed, state: "failed", code: failure };
				}
			},
		);
		outcomes.push(...stepOutcomes);
		return outcomes;
	}
	#listed(value: unknown): ListedMachine {
		const entry = receiptRecord(value);
		if (
			entry.schema !== "qorpera.coding-machine-state/v1" ||
			typeof entry.machineId !== "string" ||
			!UUID_PATTERN.test(entry.machineId) ||
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
			const session = receiptRecord(value);
			if (
				typeof session.workerId !== "string" ||
				!UUID_PATTERN.test(session.workerId) ||
				typeof session.attachmentToken !== "string" ||
				!UUID_PATTERN.test(session.attachmentToken)
			)
				throw new Error("CODING_HOST_MACHINE_LIST_INVALID");
			return { workerId: session.workerId, attachmentToken: session.attachmentToken };
		});
		return {
			machineId: entry.machineId,
			kind: entry.kind,
			binding: receiptRecord(entry.binding),
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
		const slept = receiptRecord(
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
		this.#commandSecrets?.releaseMachine(entry.machineId);
		this.#helperBoots.delete(entry.machineId);
		this.#settledBoots.delete(entry.machineId);
		this.#folderStartOperations.delete(entry.machineId);
		this.#cpuHighSamples.delete(entry.machineId);
		this.#setupLifecycle.onMachineStopped(entry.machineId);
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
				released = receiptRecord(
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
			this.#forgetMachine(entry.machineId);
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
	#forgetMachine(machineId: string): void {
		this.#commandSecrets?.releaseMachine(machineId);
		this.#helperBoots.delete(machineId);
		this.#settledBoots.delete(machineId);
		this.#folderStarts.delete(machineId);
		this.#folderStartOperations.delete(machineId);
		this.#cpuHighSamples.delete(machineId);
		this.#setupLifecycle.forgetMachine(machineId);
	}
	async #afterFolderAttach(
		folder: FolderOptions,
		claim: CodingSessionClaim,
		planned: {
			machine: Readonly<LxdCodingMachineBinding>;
			snapshotId: string | null;
			snapshotImageFingerprint: string | null;
			snapshotBuildNeeded: boolean;
		},
		journal: CodingMachineJournalPlan,
		discovered: ParsedCodingSetup | null,
		signal: AbortSignal,
	): Promise<void> {
		const ready = this.#prepared.get(claim.workerId);
		if (!ready?.folder) return;
		let setup = discovered;
		if (!setup && folder.repositories?.readSetup && /^[0-9a-f]{40}$/.test(ready.baseSha)) {
			setup = await folder.repositories.readSetup(
				{
					claim,
					assertAuthorized: async (checked) => {
						await this.#run(claim, ready.machine, ready.storage, checked);
					},
				},
				ready.baseSha,
				signal,
			);
			if (setup.refused) {
				const detail = setup.problems
					.filter((problem) => problem.effect === "refused")
					.slice(0, 5)
					.map((problem) => `${problem.at || "/"}: ${problem.message}`)
					.join("; ");
				throw new CodingWorkspaceFailed(
					"CODING_SETUP_REFUSED",
					`Repository environment setup file (${setup.file ?? "environment.json"}) is invalid: ${detail || "refused"}`,
				);
			}
		}
		if (!setup || setup.file === null) {
			this.#sessionSetups.delete(claim.workerId);
			return;
		}
		const diskId = (await codingMachineDisk(await this.#directory("machines", signal), journal)) ?? "initial";
		const bootId = this.#folderStartOperations.get(planned.machine.machineId) ?? ready.bootId;
		const runner = this.#setupCommandRunner(folder, ready);
		try {
			const attached = await this.#setupLifecycle.onAttach(
				{
					machineId: planned.machine.machineId,
					workerId: claim.workerId,
					diskId,
					bootId,
					cwd: ready.folder.cwd,
					setupDigest: setup.setupDigest,
					setupSpec: setup.setupSpec,
					runner,
				},
				signal,
			);
			this.#sessionSetups.set(claim.workerId, { env: attached.env, digest: setup.setupDigest });
		} catch (error) {
			if (error instanceof CodingSetupLifecycleError) {
				throw new CodingWorkspaceFailed(error.code, error.message, { cause: error });
			}
			throw error;
		}
		if (
			this.#options.snapshotBuilder &&
			setup.setupDigest !== EMPTY_CODING_SETUP_DIGEST &&
			/^[0-9a-f]{40}$/.test(ready.baseSha) &&
			(planned.snapshotBuildNeeded || planned.snapshotImageFingerprint === null)
		) {
			const repositories = folder.repositories;
			const commitSha = ready.baseSha;
			const repositoryKey = `${claim.repository.owner}/${claim.repository.name}`.toLowerCase();
			this.#options.snapshotBuilder.enqueue({
				workerId: claim.workerId,
				leaseToken: claim.leaseToken,
				profileId: claim.profileId,
				environmentId: claim.environmentId,
				memberUserId: claim.ownerUserId,
				repository: repositoryKey,
				setupDigest: setup.setupDigest,
				commitSha,
				setupSpec: setup.setupSpec,
				readArchive: repositories?.archiveCommit
					? (archiveSignal) =>
							repositories.archiveCommit!(
								{
									claim,
									assertAuthorized: async (checked) => {
										await this.#assertSessionAuthorized(claim, checked);
									},
								},
								commitSha,
								archiveSignal,
							)
					: undefined,
			});
		}
	}
	async #assertSessionAuthorized(claim: CodingSessionClaim, signal: AbortSignal): Promise<void> {
		await this.#call(
			"qorpera_heartbeat_coding_session",
			{
				p_worker_id: claim.workerId,
				p_lease_token: claim.leaseToken,
				p_lease_seconds: 60,
			},
			signal,
		);
	}
	#setupCommandRunner(folder: FolderOptions, ready: Prepared): CodingSetupCommandRunner {
		return {
			exec: async (input, signal) => {
				const shellCommand =
					input.argv.length === 3 && input.argv[0] === "/bin/sh" && input.argv[1] === "-lc"
						? input.argv[2]
						: input.argv.map((arg) => `'${arg.replaceAll("'", "'\\''")}'`).join(" ");
				const commandId = randomUUID();
				const inputSha256 = digest(shellCommand);
				const transport = this.#folderTransport(folder, ready, {
					cwd: input.cwd,
					environment: {
						...input.env,
						...codingFolderGitEnvironment(ready.claim.workerId),
						...packageCacheEnvironment(ready),
					},
					authorize: this.#commandAuthority(ready),
				});
				const timeoutMs = Math.max(1000, Math.min(input.timeoutMs, 3_600_000));
				let receipt: CloudCodingCommandReceipt;
				let collected = "";
				const append = (chunk: string) => {
					if (!chunk) return;
					collected += chunk;
					if (collected.length > 65536) collected = collected.slice(-65536);
				};
				try {
					receipt = await transport.start(
						ready.scope,
						{ commandId, inputSha256, command: shellCommand, timeoutMs },
						signal,
					);
					append(receipt.output);
					let delay = 150;
					while (receipt.state === "running") {
						await setTimeout(delay, undefined, { signal });
						delay = Math.min(500, delay + 100);
						receipt = await transport.read(
							ready.scope,
							{ commandId, offset: receipt.log.nextOffset, limit: 8192 },
							signal,
						);
						append(receipt.output);
					}
				} catch (error) {
					await transport.cancel(ready.scope, commandId, AbortSignal.timeout(10_000)).catch(() => undefined);
					throw error;
				}
				return {
					exitCode: receipt.state === "succeeded" ? 0 : (receipt.exitCode ?? 1),
					stdout: collected,
					stderr: "",
				};
			},
		};
	}
	#guestDetachRunner(guest: LxdCodingGuestClient, workerId: string, uid: number): CodingSetupCommandRunner {
		return {
			exec: async (input, signal) => {
				const shellCommand =
					input.argv.length === 3 && input.argv[0] === "/bin/sh" && input.argv[1] === "-lc"
						? input.argv[2]
						: input.argv.map((arg) => `'${arg.replaceAll("'", "'\\''")}'`).join(" ");
				const commandId = randomUUID();
				const answer = await guest.run(
					{
						schema: "qorpera.coding-guest-run/v1",
						workerId,
						commandId,
						uid,
						gid: uid,
						cwd: input.cwd,
						environment: {},
						command: shellCommand,
						timeoutMs: Math.max(1000, Math.min(input.timeoutMs, 10_000)),
					},
					signal,
				);
				if (answer.state === "running") {
					await guest
						.output(
							{
								schema: "qorpera.coding-guest-output/v1",
								workerId,
								commandId,
								offset: 0,
								maxBytes: 1024,
								waitMs: 2000,
							},
							signal,
						)
						.catch(() => undefined);
				}
				return {
					exitCode: answer.state === "exited" ? (answer.exit?.code ?? 0) : 0,
					stdout: "",
					stderr: "",
				};
			},
		};
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
