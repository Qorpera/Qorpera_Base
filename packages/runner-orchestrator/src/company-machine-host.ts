import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout } from "node:timers/promises";
import {
	CLOUD_MACHINE_FOLDER_LIMITS,
	CLOUD_MACHINE_FOLDER_LOST,
	CLOUD_MACHINE_GUEST_PATHS,
	type CloudCodingCommandRead,
	type CloudCodingNasPolicy,
	type CloudMachineCommandFolder,
	type CloudMachineCommandReceipt,
	type CloudMachineFolderNotSaved,
	cloudMachineFolderBytes,
	type IdleRuleSample,
	idleRuleBusy,
	isCloudMachineFolderLost,
	parseCloudCodingNasPolicy,
	parseCloudMachineCommandFolder,
	parseCloudMachineCommandReceipt,
} from "@qorpera/contracts";
import { withAbortScope } from "./abort-scope.ts";
import type { AgentPlug } from "./agent-plug.ts";
import { CodingControlBusy, CodingControlRefused } from "./coding-executor.ts";
import { type CodingMachineIntent, reconcileCodingMachine } from "./coding-machine.ts";
import { type CodingNasStorage, createCodingNasStorage } from "./coding-storage.ts";
import {
	type CompanyMachinePolicy,
	type LxdCompanyMachineBinding,
	lxdCompanyMachineJournalPlan,
	lxdCompanyMachineName,
	parseCompanyMachinePolicy,
} from "./company-machine.ts";
import type { FolderCommandWindow, FolderControl, MachineBoundary } from "./folder-control.ts";
import type { LxdInstanceExecStreamClient, LxdTrackedClient } from "./lxd-client.ts";
import { checkDirectory, code } from "./lxd-office-journal-files.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA = /^[0-9a-f]{64}$/;
/** A view's pass, as the folder core makes it. */
const PASS = /^[A-Za-z0-9_-]{43}$/;
const PATHS = CLOUD_MACHINE_GUEST_PATHS;
/** Long on purpose: jobs of hours must outlive an executor restart or a
 * release cut. It stops the commands of a machine the control plane lost. */
export const COMPANY_MACHINE_LEASE_MS = 900000;
/** How long a start waits for its boot's folder: the gateway's request to the executor is bounded at 30 s. */
const FOLDER_WAIT_MS = 20000;
/** A boundary before a command's output leaves. */
const BOUNDARY_MS = 15000;
/** The windows of one pass's ended commands, all of them. */
const WINDOWS_MS = 30000;
/** A boot's final boundary: what an unanswered final held is not applied, and the stop goes on. */
const FINAL_BOUNDARY_MS = 60000;
/** folder-mount: the guest waits up to 60 s for a mount still settling, then up to 100 × 200 ms for readiness. */
const FOLDER_MOUNT_MS = 100000;
/** Views one boot is opened, while its guest answers that the node closed them. */
const FOLDER_OPENS = 3;
/** How long a boot's own view may be missing from the service before its guest restarts: the folder program takes 45 s
 * without a frame for a dead link and connects again (a restarted service, say), and the service renews each view it
 * serves every 40 s. A view the core closed (a narrowing, or a crashed service's) does not come back. */
const FOLDER_GONE_MS = 90000;
/** The guest's own reboot, asked without waiting for it. */
const REBOOT_MS = 30000;
/** A start's delivery, which a restart waits for: the gateway's request to the executor is bounded at 30 s. */
const DELIVERY_MS = 30000;
/** A start on a machine with a folder runs in its guest only on the boot it was let in on (`$0`): the guest's shell
 * compares the kernel's boot id at the exec, then runs the helper (`$@`). The helper's own start takes no boot. */
const ON_BOOT = 'read -r boot < /proc/sys/kernel/random/boot_id && [ "$boot" = "$0" ] && exec "$@"';
/** A command's log limit in the guest (the helper's MACHINE_GUEST_MAX_LOG_BYTES), as a held receipt states it. */
const LOG_LIMIT_BYTES = 67108864;
/** One NAS storage check's own bound, as the coding host's. It runs from the check's start: the wait for the checks
 * before it is bounded only by its caller's own signal (a start's 300 s, a stop's 120 s). */
const STORAGE_TASK_MS = 5000;
/** Between passes, how often the guests still starting are asked whether they are up (#lookAtStarting). */
const STARTING_LOOK_MS = 1000;
/** One look at a starting guest answers within this, or counts as not yet. */
const STARTING_LOOK_LIMIT_MS = 5000;
/** A boot that reached these runs commands: systemd's basic system is up (sockets too, so a first `docker` waits for its
 * daemon instead of failing) and the network answers. */
const BOOT_USABLE = ["/usr/bin/systemctl", "is-active", "--quiet", "basic.target", "network-online.target"];

/** Why a boot whose folder ended (6d-2) has no /company, by the cause its ending keeps (#endings). */
const FOLDER_ENDED: Readonly<Record<string, string>> = Object.freeze({
	restart_unproven:
		"the executor is restarting the machine because it could not prove what the machine read in /company",
	restart_view_closed: "the executor is restarting the machine because its /company view was closed",
	restart_view_gone:
		"the executor is restarting the machine because the company folder service lost its /company view",
	moved_unchecked: "the machine is moving to a new disk because a command ran on this one before /company was checked",
	moved_starter:
		"the machine is moving to a new disk because the agent or member who started it no longer reads the whole company folder",
	moved_unreadable: "the machine is moving to a new disk because something it read in /company is no longer readable",
	stale: "this boot of the machine is no longer the current one",
});
/** Why a boot without a view of its own has no /company (#viewless). */
const FOLDER_VIEWLESS = Object.freeze({
	"old-helper":
		"this machine runs an earlier image without the company folder; it gets /company once it sleeps and wakes again",
	refused: "the company folder refused this machine's view",
	closed: "the machine could not mount /company: the company folder closed each view it was handed",
});
/** The core's refusal of a view of a machine that is stopping, moving or on another boot (20260928549400). */
const VIEW_NOT_CURRENT = "Folder view machine is not current";
/** Why a receipt's output is held back. */
const HELD = Object.freeze({
	ended: "this boot's output stays on the machine: the boot no longer has /company, as `why` says",
	start: "a start shows no output: machine_read shows it once the company folder has released what the machine read",
	unanswered: "the company folder has not said yet whether what the machine read may be shown; read again",
	unproven:
		"the executor cannot prove what the machine read in /company: it restarts the machine, and this boot's output stays on it",
	unreadable:
		"something the machine read in /company is no longer readable: this boot's output stays on it, and the machine moves to a new disk",
	paused: "the company folder is paused; read again later",
	unreleased: "the company folder did not release what the machine read; read again",
	// As SQL tells a woken run (qorpera_folder_test_machine_event_report).
	refused:
		"this run could not take in what the machine read in /company: a read is no longer readable to it, or it does not read the whole company folder",
	untaken: "the company folder did not answer this run's take-in of what the machine read; read again",
});

export const COMPANY_MACHINE_HOST_RPCS = [
	"qorpera_admit_executor_machines",
	"qorpera_list_executor_machines",
	"qorpera_authorize_executor_machine",
	"qorpera_mark_company_machine_running",
	"qorpera_suspend_company_machine",
	"qorpera_release_company_machine",
	"qorpera_record_company_machine_error",
	"qorpera_record_company_machine_commands",
	"qorpera_record_company_machine_stop",
	"qorpera_folder_view_open",
	"qorpera_folder_view_close",
	"qorpera_retire_company_machine",
	"qorpera_folder_test_machine_inherit_reads",
	"qorpera_mark_company_machine_folder_restart",
] as const;

export interface CompanyMachineHostOptions {
	control: { call(method: string, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown> };
	owner: string;
	machineIdSha256: string;
	policy: CompanyMachinePolicy;
	client: Pick<
		LxdTrackedClient,
		| "getInstance"
		| "submitInstanceOperation"
		| "inspectInstanceOperation"
		| "readInstanceFile"
		| "pushInstanceFile"
		| "execInstance"
	> &
		Partial<LxdInstanceExecStreamClient>;
	/** The node's folder service (F3 6d): each boot of a test machine gets its own company folder view, its commands'
	 * windows and boundaries go through it, and their output leaves only once the machine's reads are released. Without
	 * it, machines run without /company. It needs the client's execInstanceStream (the view's hand-over). */
	folder?: FolderControl;
	/** The executor's NAS control root (createCodingNasStorage(...).prepareControl()). */
	journalRoot: string;
	/** The coding NAS: its control path holds the journals. */
	storagePolicy: CloudCodingNasPolicy;
	/** The sha-256 of the packaged machine guest helper the image carries. */
	helperSha256: string;
	/** Helpers of earlier images still on this node: their machines keep running until they sleep, and
	 * wake fresh from the current image (their placement's policy is no longer the node's). */
	previousHelperSha256s?: readonly string[];
	/** How long a started guest may take before its agent answers (default 180 s). */
	guestReadyTimeoutMs?: number;
	/** How long a pass waits for its placements' steps. One still running then goes on by itself, and no pass starts
	 * another for its placement until it ends, so one machine's slow guest holds up no other machine's wake. Its outcome
	 * comes with the next pass. Default: a pass waits for every step. */
	passHoldMs?: number;
	/** The node's agent plug (default: its plug tool, deploy/agent-exit). */
	agentPlug?: AgentPlug;
}

/** One placement of a machine as SQL lists it for this executor
 * (qorpera_list_executor_machines). A retired placement (its machine moved on
 * or was deleted) is only ever deleted. */
export interface CompanyMachineEntry {
	machineId: string;
	placementId: string;
	retired: boolean;
	binding: LxdCompanyMachineBinding;
	bindingText: string;
	instanceSha256: string;
	desiredState: "running" | "stopped" | "deleted";
	lifetime: "task" | "always-on";
	reserved: boolean;
	asleepSince: string | null;
	removing: boolean;
	released: boolean;
	runningAt: string | null;
	bootId: string | null;
	commands: string[];
	sleepDue: boolean;
	stopDue: boolean;
	removeDue: boolean;
}
export interface CompanyMachineOutcome {
	/** null for admission, which is not one placement's step. */
	placementId: string | null;
	step: "admit" | "start" | "guest" | "stop" | "delete" | "release" | "commands" | "wait";
	state: "done" | "pending" | "not-now" | "failed";
	code?: string;
	/** What came of the boot's folder this pass, when it was being settled (a code, or the error's). */
	folder?: string;
}
/** A command the gateway authorized in SQL for a machine placed on this node. */
export interface CompanyMachineCommandAuthority {
	machineId: string;
	placementId: string;
	commandId: string;
	inputSha256: string;
	/** The boot SQL knows the placement runs, and the command's run, staff agent and requesting user: a start on a
	 * machine with a folder waits for that boot's folder and opens the command's window with them. */
	bootId?: string | null;
	runId?: string;
	staffAgentId?: string;
	requestedByUserId?: string;
	/** Why the machine lost the command, when SQL ended it lost for the machine's folder (6e-2a): a key of CLOUD_MACHINE_FOLDER_LOST. */
	folderLost?: string | null;
}
/** A boot's company folder (F3 6d), in this process's memory only (the pass is never written anywhere). */
interface BootFolder {
	bootId: string;
	/** pending: not settled yet, and a start waits; open: the boot's commands are fenced, by their windows and the
	 * machine's boundaries, with or without a view; none: no pass can have reached the boot's guest (#viewless), which
	 * runs without /company. A boot whose folder ended (6d-2) is kept apart from its folder (#endings). */
	state: "pending" | "open" | "none";
	/** This process saw the boot start; false once it restarted, and then the service's views decide. */
	known: boolean;
	/** This process handed the guest a pass of the boot (answered or not): the boot is fenced for good. */
	handed: boolean;
	/** The view this process opened, with its pass. */
	view?: { viewId: string; pass: string };
	/** Every view of the boot the service may hold, which its final boundary closes. */
	views: Set<string>;
	opens: number;
	/** Whether the service was asked which views of the boot it holds (after a restart). */
	asked: boolean;
	/** Why the boot has no view of its own (#viewless), and for a refused open the core's words, when the control keeps
	 * them. */
	reason?: "old-helper" | "refused" | "closed";
	refusal?: string;
	/** The service listed a view of the boot's own: from then on, that view missing restarts the guest (#watch). */
	held: boolean;
	/** Since when the boot's own view is missing from the service's answers. */
	missing?: number;
	/** A run's take-in of the machine's reads was refused as no longer readable (#inherit): the boot's output stays
	 * held, and the next pass retires its placement. */
	unreadable?: boolean;
	/** The windows this process opened for the boot's commands, until their command ends: the service keeps them in
	 * memory, so each pass opens them again (#reopen). */
	windows: Map<string, FolderCommandWindow>;
	/** The paths the boot's boundaries said the company folder let go unsaved, for its next receipt whose output leaves
	 * (6e-2a, #noted), and how many more there were. */
	notSaved: CloudMachineFolderNotSaved[];
	moreNotSaved: number;
	/** The paths the folder did not save that each open view of the boot keeps pending, as the view's newest boundary
	 * reported them (#noted): every receipt whose output leaves says them while they last. */
	stillNotSaved: Map<string, StillNotSaved>;
}
/** One view's paths not saved that it keeps pending: at most 8, and a count of the rest (6e-2a). */
interface StillNotSaved {
	paths: CloudMachineFolderNotSaved[];
	more: number;
}
export type CompanyMachineCommand =
	| { action: "start"; commandId: string; inputSha256: string; command: string; timeoutMs: number | null }
	| { action: "read"; read: CloudCodingCommandRead }
	| { action: "cancel"; commandId: string };

function record(value: unknown, error: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(error);
	return value as Record<string, unknown>;
}
/** A receipt whose output is held back, made from the request alone: still running, and nothing printed past where
 * the reader stands (`offset`). No size, end or exit of the guest's is in it. */
function held(receipt: CloudMachineCommandReceipt, offset: number): CloudMachineCommandReceipt {
	const at = Math.min(offset, LOG_LIMIT_BYTES);
	const kept: CloudMachineCommandReceipt = {
		...receipt,
		state: "running",
		exitCode: null,
		output: "",
		truncated: false,
		log: Object.freeze({
			offset: at,
			nextOffset: at,
			totalBytes: at,
			limitBytes: LOG_LIMIT_BYTES,
			limitReached: false,
		}),
	};
	return Object.freeze(kept);
}
/** Why a boundary that did not release the machine's reads holds its output (6e-2a). */
function unreleased(boundary: MachineBoundary | undefined): string {
	switch (boundary?.reads) {
		case undefined:
		case "unanswered":
			return HELD.unanswered;
		case "unproven":
			return HELD.unproven;
		case "unreadable":
			return HELD.unreadable;
		case "stopped":
			return HELD.paused;
		default:
			return HELD.unreleased;
	}
}
/** What a boundary's reports say the company folder did not take (6e-2a), for the boot's receipts whose output leaves,
 * each path as the receipt's report checks it: at most 8, and a count of the rest. A path the folder let go unsaved is
 * said once, on the next such receipt (`notSaved`). A path its view keeps pending for the service to try again at each
 * boundary (a write the core refused, or a conflict whose bytes the receipt did not keep) is said on every such receipt
 * while the view's newest boundary still reports it so (`stillNotSaved`): one saved meanwhile (by a quiet publish, whose
 * outcome only the service's notices keep) is no longer said, and one refused again is. A path still on its way (kept
 * `waiting`, an open file, or `not_applied`, not sent or not answered yet), or kept by a change set refused whole in a
 * way that may lift (the pause, the run check), is said once it settles. */
function noted(boot: BootFolder | undefined, boundary: MachineBoundary | undefined): void {
	if (!boot || !boundary) return;
	// A view the boundary no longer lists, or says is closed, keeps nothing pending.
	for (const viewId of boot.stillNotSaved.keys())
		if (!boundary.views.some((view) => view.viewId === viewId && view.error?.code !== "VIEW_CLOSED"))
			boot.stillNotSaved.delete(viewId);
	for (const view of boundary.views) {
		const paths = view.report?.paths;
		// A view without a report this time keeps what its last one said.
		if (!Array.isArray(paths)) continue;
		const lifts = view.report?.refused === "stopped" || view.report?.refused === "run_ended";
		const still: StillNotSaved = { paths: [], more: 0 };
		for (const item of paths as unknown[]) {
			const entry = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
			if (entry.outcome === "saved") continue;
			const kept = entry.kept === true;
			if (kept && (lifts || entry.outcome === "waiting" || entry.outcome === "not_applied")) continue;
			const list = kept ? still.paths : boot.notSaved;
			const shown = list.length < CLOUD_MACHINE_FOLDER_LIMITS.notSaved ? notSavedOf(entry) : undefined;
			if (shown) list.push(shown);
			else if (kept) still.more++;
			else boot.moreNotSaved++;
		}
		if (still.paths.length || still.more) boot.stillNotSaved.set(view.viewId, still);
		else boot.stillNotSaved.delete(view.viewId);
	}
}
/** One path not saved as a receipt shows it, or none when it cannot be (its reason dropped first). */
function notSavedOf(entry: Record<string, unknown>): CloudMachineFolderNotSaved | undefined {
	const { path, outcome, reason } = entry;
	if (typeof path !== "string" || typeof outcome !== "string") return undefined;
	const tries = [
		...(typeof reason === "string"
			? [{ path, outcome, reason: reason.slice(0, CLOUD_MACHINE_FOLDER_LIMITS.reason) }]
			: []),
		{ path, outcome },
	];
	for (const shown of tries)
		try {
			return parseCloudMachineCommandFolder({ company: "pending", notSaved: [shown] }).notSaved?.[0];
		} catch {
			// The next try, or none.
		}
	return undefined;
}
function errorCode(error: unknown): string {
	const message = error instanceof Error ? error.message : "";
	return /^[A-Z][A-Z0-9_]{2,80}(:[A-Z][A-Z0-9_]{0,63})?$/.test(message) ? message : "UNCLASSIFIED";
}
/** The helper's answer in its reply file; its refusal throws its code. */
function guestAnswer(content: Buffer): Record<string, unknown> {
	const value = record(
		JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(content)),
		"COMPANY_MACHINE_GUEST_REPLY_INVALID",
	);
	if (value.schema === "qorpera.machine-guest-refusal/v1")
		throw new Error(
			typeof value.code === "string" && /^[A-Z][A-Z0-9_:]{2,120}$/.test(value.code)
				? value.code
				: "MACHINE_GUEST_REFUSED",
		);
	return value;
}
function entry(value: unknown): CompanyMachineEntry {
	const e = record(value, "COMPANY_MACHINE_LIST_INVALID");
	if (
		e.schema !== "qorpera.company-machine-state/v2" ||
		![e.machineId, e.placementId].every((id) => typeof id === "string" && UUID.test(id)) ||
		typeof e.bindingText !== "string" ||
		typeof e.instanceSha256 !== "string" ||
		!SHA.test(e.instanceSha256) ||
		!["running", "stopped", "deleted"].includes(e.desiredState as string) ||
		!["task", "always-on"].includes(e.lifetime as string) ||
		![e.retired, e.reserved, e.removing, e.released, e.sleepDue, e.stopDue, e.removeDue].every(
			(flag) => typeof flag === "boolean",
		) ||
		(e.bootId !== null && (typeof e.bootId !== "string" || !UUID.test(e.bootId))) ||
		!Array.isArray(e.commands) ||
		e.commands.length > 64 ||
		e.commands.some((id) => typeof id !== "string" || !UUID.test(id))
	)
		throw new Error("COMPANY_MACHINE_LIST_INVALID");
	return e as unknown as CompanyMachineEntry;
}

/** The machine workload of a node's executor: every pass it admits waiting
 * machines on this node, then brings each placement on it to the state SQL
 * wants (running, asleep or deleted) through the coding machine's journaled
 * lifecycle, keeps each running guest's lease, and records how the commands
 * it started ended. It also runs the commands the gateway authorized. */
export class LxdCompanyMachineHost {
	readonly #options: CompanyMachineHostOptions;
	readonly #policy: Readonly<CompanyMachinePolicy>;
	readonly #storage: CodingNasStorage;
	readonly #work = new Map<string, Promise<unknown>>();
	/** The last NAS storage check (#storageTask). */
	#storageWork: Promise<unknown> = Promise.resolve();
	/** Per placement: the boot whose helper was checked and prepared, the whole machine's last sample, and whether it was
	 * busy since SQL last took that. */
	readonly #guests = new Map<string, { bootId: string; sample: IdleRuleSample; busy: boolean }>();
	/** When this process first saw the placement started and its guest not yet answering, and the placement as SQL last
	 * listed it. */
	readonly #starting = new Map<string, { since: number; entry: CompanyMachineEntry }>();
	/** The starting guests being looked at now (#lookAtStarting). */
	readonly #looking = new Set<string>();
	/** The placements whose step runs, in a pass or past the end of its hold. */
	readonly #stepping = new Set<string>();
	/** What steps that outlasted their pass came to, for the next pass to hand over. */
	readonly #late: CompanyMachineOutcome[] = [];
	/** A wake came: the next pass starts as soon as the one running ends (#pause). */
	#woken = false;
	/** Ends the wait before the next pass, while there is one. */
	#ending: (() => void) | undefined;
	/** Who waits to hear that a machine got somewhere (#changed), per machine. */
	readonly #listeners = new Map<string, Set<() => void>>();
	/** Per placement: its running boot's folder. */
	readonly #folders = new Map<string, BootFolder>();
	/** Per placement and boot (`placementId/bootId`): a boot whose folder ended (6d-2), and how: its guest restarts
	 * (asked again each pass until the next boot comes), or its placement was retired; and the code each pass reports.
	 * Kept apart from the boot's folder, which its end, a stop or the next boot removes, so nothing of the boot leaves
	 * it whatever came of its folder, a stop or a record (#ended). Dropped only with the placement (#remove). Its cause,
	 * a key of FOLDER_ENDED, says why in each receipt of the boot (6e-2a). */
	readonly #endings = new Map<string, { by: "restart" | "retirement"; code: string; cause: string }>();
	/** Per placement and command: the starts being delivered (from their window's open to the guest's answer). */
	readonly #delivering = new Map<string, number>();
	/** Per look inside a machine with a folder, until its ends are worked out: the commands whose start's delivery
	 * began or ended since the look began. What that look says of them is stale. */
	readonly #looks = new Set<Set<string>>();
	/** Per placement and command: a window close on its way, answered with the machine's boundary (or none). */
	readonly #closing = new Map<string, Promise<MachineBoundary | undefined>>();
	readonly #generation = Math.floor(Date.now() / 1000);
	constructor(options: CompanyMachineHostOptions) {
		if (
			!/^[A-Za-z0-9_.:-]{1,120}$/.test(options.owner) ||
			!SHA.test(options.machineIdSha256) ||
			!SHA.test(options.helperSha256) ||
			(options.previousHelperSha256s ?? []).some((sha) => !SHA.test(sha)) ||
			resolve(options.journalRoot) !== options.journalRoot ||
			(options.folder !== undefined && typeof options.client.execInstanceStream !== "function")
		)
			throw new Error("COMPANY_MACHINE_HOST_CONFIGURATION_INVALID");
		this.#policy = parseCompanyMachinePolicy(options.policy);
		this.#storage = createCodingNasStorage(parseCloudCodingNasPolicy(options.storagePolicy));
		if (options.journalRoot !== this.#storage.controlPath) throw new Error("COMPANY_MACHINE_JOURNAL_NOT_ON_NAS");
		this.#options = Object.freeze({ ...options });
	}

	async #call(method: string, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
		return this.#options.control.call(method, args, AbortSignal.any([signal, AbortSignal.timeout(10000)]));
	}
	/** Lifecycle steps of one placement never overlap. */
	async #exclusive<T>(placementId: string, use: () => Promise<T>): Promise<T> {
		const previous = this.#work.get(placementId) ?? Promise.resolve();
		const next = previous.catch(() => undefined).then(use);
		this.#work.set(placementId, next);
		try {
			return await next;
		} finally {
			if (this.#work.get(placementId) === next) this.#work.delete(placementId);
		}
	}
	/** NAS storage checks run one at a time, each once the one before it settled: the storage refuses a check while
	 * another runs (CODING_STORAGE_IO_PENDING), and a pass steps all its placements at once. Its caller leaves on its own
	 * signal, or on the check's bound once the check began; a check whose caller left before it began never runs. The
	 * chain keeps the real promise, so a check that outlives its caller (hard-NFS IO answers no signal) still holds off
	 * the next. */
	async #storageTask<T>(use: (signal: AbortSignal) => Promise<T>, signal: AbortSignal): Promise<T> {
		const bound = new AbortController();
		const left = AbortSignal.any([signal, bound.signal]);
		const work = this.#storageWork
			.catch(() => undefined)
			.then(() => {
				signal.throwIfAborted();
				const checked = AbortSignal.any([signal, AbortSignal.timeout(STORAGE_TASK_MS)]);
				checked.addEventListener("abort", () => bound.abort(checked.reason), { once: true });
				return use(checked);
			});
		this.#storageWork = work;
		let abort: (() => void) | undefined;
		try {
			return await Promise.race([
				work,
				new Promise<never>((_resolve, reject) => {
					abort = () => reject(left.reason);
					left.addEventListener("abort", abort, { once: true });
					if (left.aborted) abort();
				}),
			]);
		} finally {
			if (abort) left.removeEventListener("abort", abort);
		}
	}
	async #journalRoot(signal: AbortSignal): Promise<string> {
		return this.#storageTask(async (checked) => {
			await this.#storage.assertControl(checked);
			await checkDirectory(this.#options.journalRoot);
			const path = join(this.#options.journalRoot, "company-machines");
			await mkdir(path, { mode: 0o700 }).catch((error) => {
				if (!code(error, "EEXIST")) throw error;
			});
			await checkDirectory(path);
			return path;
		}, signal);
	}
	#plan(e: CompanyMachineEntry) {
		const plan = lxdCompanyMachineJournalPlan(e.binding);
		if (
			plan.text !== e.bindingText ||
			plan.instanceSha256 !== e.instanceSha256 ||
			e.binding.machineId !== e.machineId ||
			e.binding.placementId !== e.placementId ||
			e.binding.project !== this.#policy.project ||
			e.binding.providerId !== this.#policy.providerId
		)
			throw new Error("COMPANY_MACHINE_BINDING_DIFFERS");
		return plan;
	}
	#custody(e: CompanyMachineEntry, method: string, signal: AbortSignal, extra: Record<string, unknown> = {}) {
		return this.#call(
			method,
			{
				p_placement_id: e.placementId,
				p_owner: this.#options.owner,
				p_binding_text: e.bindingText,
				p_machine_id_sha256: this.#options.machineIdSha256,
				...extra,
			},
			signal,
		);
	}
	/** SQL's authority for one LXD effect; a refusal it can wait out throws COMPANY_MACHINE_REFUSED. */
	async #authorize(e: CompanyMachineEntry, intent: CodingMachineIntent, signal: AbortSignal): Promise<unknown> {
		const receipt = record(
			await this.#custody(e, "qorpera_authorize_executor_machine", signal, { p_intent: intent }),
			"COMPANY_MACHINE_AUTHORITY_INVALID",
		);
		if (receipt.state === "refused")
			throw new Error(
				`COMPANY_MACHINE_REFUSED:${
					String(receipt.reason)
						.replace(/[^A-Z0-9_]/g, "")
						.slice(0, 60) || "UNKNOWN"
				}`,
			);
		return receipt;
	}
	/** Drives the journaled LXD lifecycle to one state, re-fetching SQL
	 * authority before every effect. A refusal SQL can wait out is "not-now". */
	async #physical(
		e: CompanyMachineEntry,
		desiredState: "running" | "stopped" | "deleted",
		signal: AbortSignal,
	): Promise<"running" | "stopped" | "absent" | "deleted" | "not-now"> {
		const plan = this.#plan(e);
		let refused = false;
		const authorize = async (intent: CodingMachineIntent, checked: AbortSignal): Promise<unknown> => {
			try {
				return await this.#authorize(e, intent, checked);
			} catch (error) {
				// Refused, or the company's locks busy past SQL's short wait: no new run authority this
				// pass, but a machine that already runs keeps its lease (see #step).
				if (errorCode(error).startsWith("COMPANY_MACHINE_REFUSED:") || error instanceof CodingControlBusy)
					refused = true;
				throw error;
			}
		};
		const checked = AbortSignal.any([signal, AbortSignal.timeout(desiredState === "running" ? 300000 : 120000)]);
		for (;;) {
			checked.throwIfAborted();
			let result: Awaited<ReturnType<typeof reconcileCodingMachine>>;
			try {
				result = await reconcileCodingMachine({
					plan,
					journalRoot: await this.#journalRoot(checked),
					desiredState,
					client: this.#options.client,
					authorize,
					signal: checked,
					plug: this.#options.agentPlug,
				});
			} catch (error) {
				if (refused) return "not-now";
				throw error;
			}
			if (result.state === "pending") {
				await setTimeout(500, undefined, { signal: checked });
				continue;
			}
			if (result.state === "recovery-required") throw new Error("COMPANY_MACHINE_RECOVERY_REQUIRED");
			if (desiredState === "running" && result.state !== "running")
				throw new Error("COMPANY_MACHINE_RECOVERY_REQUIRED");
			if (desiredState === "stopped" && result.state !== "stopped" && result.state !== "absent")
				throw new Error("COMPANY_MACHINE_RECOVERY_REQUIRED");
			if (desiredState === "deleted" && result.state !== "deleted" && result.state !== "absent")
				throw new Error("COMPANY_MACHINE_RECOVERY_REQUIRED");
			return result.state;
		}
	}

	/** Runs the helper as root with a fresh reply file and reads its answer. */
	async #helper(
		e: CompanyMachineEntry,
		args: readonly string[],
		signal: AbortSignal,
	): Promise<Record<string, unknown>> {
		return guestAnswer(await this.#ask(e, args, signal));
	}
	/** Runs the helper as root with a fresh reply file and reads that file, unchecked. It throws only when no answer came
	 * back (LXD's exec failed, the helper could not write its reply, or the file could not be read). */
	async #ask(e: CompanyMachineEntry, args: readonly string[], signal: AbortSignal): Promise<Buffer> {
		const plan = this.#plan(e);
		const nonce = randomUUID();
		await this.#options.client.execInstance(
			plan.project,
			plan.name,
			["/usr/bin/node", PATHS.helper, nonce, ...args],
			signal,
		);
		return this.#reply(plan, nonce, signal);
	}
	/** The helper's reply file. */
	async #reply(plan: { project: string; name: string }, nonce: string, signal: AbortSignal): Promise<Buffer> {
		const file = await this.#options.client.readInstanceFile(
			plan.project,
			plan.name,
			`${PATHS.runtime}/replies/${nonce}.json`,
			65536,
			signal,
		);
		return file.content;
	}
	/** Until the guest agent answers both the boot's claim and its lease, the machine is still starting: early in a boot,
	 * or on a boot going down, LXD's agent may answer one and drop at the next (LXD ends the exec without a code). For
	 * `guestReadyTimeoutMs` at most from the first pass it did not answer; then the pass fails with the error. */
	#unready(e: CompanyMachineEntry, error: unknown): CompanyMachineOutcome {
		const since = this.#starting.get(e.placementId)?.since ?? Date.now();
		this.#starting.set(e.placementId, { since, entry: e });
		if (
			Date.now() - since < (this.#options.guestReadyTimeoutMs ?? 180000) &&
			errorCode(error) !== "COMPANY_MACHINE_HELPER_DIFFERS"
		)
			return { placementId: e.placementId, step: "guest", state: "pending" };
		throw error;
	}
	/** A started guest: its helper is the packaged one, this boot is claimed
	 * for the machine, SQL knows it runs, and its lease is renewed. */
	async #guest(e: CompanyMachineEntry, signal: AbortSignal): Promise<CompanyMachineOutcome> {
		const plan = this.#plan(e);
		let prepared: Record<string, unknown>;
		let helperSha256: string;
		try {
			const helper = await this.#options.client.readInstanceFile(
				plan.project,
				plan.name,
				PATHS.helper,
				65536,
				signal,
			);
			helperSha256 = createHash("sha256").update(helper.content).digest("hex");
			if (
				helperSha256 !== this.#options.helperSha256 &&
				!(this.#options.previousHelperSha256s ?? []).includes(helperSha256)
			)
				throw new Error("COMPANY_MACHINE_HELPER_DIFFERS");
			prepared = await this.#helper(e, ["prepare", e.machineId, String(this.#generation)], signal);
		} catch (error) {
			return this.#unready(e, error);
		}
		if (
			prepared.schema !== "qorpera.machine-guest/v1" ||
			prepared.machineId !== e.machineId ||
			typeof prepared.bootId !== "string" ||
			!UUID.test(prepared.bootId)
		)
			throw new Error("COMPANY_MACHINE_GUEST_REPLY_INVALID");
		const bootId = prepared.bootId;
		// A guest whose boot's folder ended (6d-2), whatever came of that folder: nothing of the boot is looked at,
		// recorded or marked running, nor is its lease renewed (its commands are lost, and its watchdog stops any still
		// running once the last lease runs out). The boot is the one the guest says it runs, so a guest that restarts is
		// asked again, its agent going down or not, until its next boot comes, and a retired placement waits for its stop.
		const over = this.#endings.get(`${e.placementId}/${bootId}`);
		if (over) {
			this.#starting.delete(e.placementId);
			if (over.by === "restart") {
				await this.#mark(e, bootId, over.cause, signal);
				await this.#reboot(e, signal);
			}
			return { placementId: e.placementId, step: "commands", state: "done", folder: over.code };
		}
		// Only a lease ask that got no answer is still starting; what the helper answered is checked at once, as on any
		// pass (an invalid reply or a refusal fails the pass).
		let leased: Buffer;
		try {
			leased = await this.#ask(e, ["refresh-lease", String(COMPANY_MACHINE_LEASE_MS)], signal);
		} catch (error) {
			return this.#unready(e, error);
		}
		this.#starting.delete(e.placementId);
		const lease = guestAnswer(leased);
		if (lease.schema !== "qorpera.machine-guest-lease-receipt/v1" || lease.bootId !== bootId)
			throw new Error("COMPANY_MACHINE_GUEST_REPLY_INVALID");
		const folder = this.#options.folder;
		if (e.bootId !== bootId) {
			// The boot before ends first: its views' final boundary, before the new boot is recorded.
			if (folder && e.runningAt !== null && e.bootId !== null) await this.#endFolder(e, e.bootId, signal, true);
			else if (folder) {
				// No boot before that SQL counts as running (a first boot, or one after a stop): the machine is said to have
				// restarted all the same, before the boot's view opens (F3 5g-5). A folder service run that started since its
				// boot before does not vouch for it otherwise, and its first boundary would answer unproven.
				const checked = AbortSignal.any([signal, AbortSignal.timeout(BOUNDARY_MS)]);
				await folder.restarted(e.placementId, checked).catch(() => undefined);
			}
			const marked = record(
				await this.#custody(e, "qorpera_mark_company_machine_running", signal, { p_boot_id: bootId }),
				"COMPANY_MACHINE_RUNNING_INVALID",
			);
			if (marked.state !== "running") return { placementId: e.placementId, step: "guest", state: "not-now" };
			this.#guests.delete(e.placementId);
			if (!folder) return { placementId: e.placementId, step: "start", state: "done" };
			// Then the boot's own view, opened once SQL knows the boot (the view's anchor), and handed to its guest.
			const f: BootFolder = {
				bootId,
				state: "pending",
				known: true,
				handed: false,
				views: new Set(),
				opens: 0,
				asked: true,
				held: false,
				windows: new Map(),
				notSaved: [],
				moreNotSaved: 0,
				stillNotSaved: new Map(),
			};
			this.#folders.set(e.placementId, f);
			return {
				placementId: e.placementId,
				step: "start",
				state: "done",
				folder: await this.#settle(e, f, helperSha256, signal),
			};
		}
		// A running machine of this boot: its folder settled, how its commands ended, and whether it is busy.
		let settled: string | undefined;
		let f: BootFolder | undefined;
		if (folder) {
			f = this.#folders.get(e.placementId);
			if (f?.bootId !== bootId) {
				// This process did not see the boot start (it restarted): the views the service holds decide.
				f = {
					bootId,
					state: "pending",
					known: false,
					handed: false,
					views: new Set(),
					opens: 0,
					asked: false,
					held: false,
					windows: new Map(),
					notSaved: [],
					moreNotSaved: 0,
					stillNotSaved: new Map(),
				};
				this.#folders.set(e.placementId, f);
			}
			if (f.state === "pending") {
				settled = await this.#settle(e, f, helperSha256, signal);
				// A settle that ended the boot (its new disk retired) leaves it as above.
				if (this.#ended(e.placementId, bootId))
					return { placementId: e.placementId, step: "commands", state: "done", folder: settled };
			}
		}
		// A boot settled before this pass is watched: its windows opened again first, then its reads and views checked.
		const watching = f?.state === "open" && settled === undefined ? f : undefined;
		if (watching) await this.#reopen(e, watching, signal);
		const look = await this.#ends(e, bootId, () => this.#look(e, bootId, signal), signal);
		// Checked again once the look's windows closed, as a read is after its boundary (#ended).
		if (this.#ended(e.placementId, bootId)) return { placementId: e.placementId, step: "commands", state: "done" };
		await this.#record(e, bootId, look, signal);
		// A run's take-in the core refused as no longer readable (#inherit) retires the placement, whatever the boot's
		// folder: the disk keeps what its views were served.
		let watched: string | undefined;
		if (f?.unreadable) watched = await this.#retire(e, f, "unreadable", signal);
		else if (watching) watched = await this.#watch(e, watching, look.boundary, signal);
		const said = watched ?? settled;
		return {
			placementId: e.placementId,
			step: "commands",
			state: "done",
			...(said === undefined ? {} : { folder: said }),
		};
	}
	/** One look inside a running machine of this boot: the listed commands that ended, and whether the whole machine,
	 * apart from its own control, was busy since the last look (the one idle rule: 5% of one core, or 512 KiB read or
	 * written in 30 seconds). Busy stays owed until SQL takes it. */
	async #look(
		e: CompanyMachineEntry,
		bootId: string,
		signal: AbortSignal,
	): Promise<{ ended: Record<string, unknown>[]; busy: boolean }> {
		const observed = await this.#helper(e, ["observe", e.commands.length ? e.commands.join(",") : "-"], signal);
		if (
			observed.schema !== "qorpera.machine-observation/v2" ||
			observed.bootId !== bootId ||
			![observed.at, observed.cpuUsec, observed.ioBytes].every(
				(value) => Number.isSafeInteger(value) && Number(value) >= 0,
			) ||
			!Array.isArray(observed.ended) ||
			observed.ended.length > 64
		)
			throw new Error("COMPANY_MACHINE_GUEST_REPLY_INVALID");
		const sample = {
			cpuSeconds: Number(observed.cpuUsec) / 1e6,
			ioBytes: Number(observed.ioBytes),
			at: Number(observed.at),
		};
		const previous = this.#guests.get(e.placementId);
		const same = previous?.bootId === bootId ? previous : undefined;
		const busy = !!same && (same.busy || idleRuleBusy(same.sample, sample));
		this.#guests.set(e.placementId, { bootId, sample, busy });
		const ended = observed.ended
			.map((item) => record(item, "COMPANY_MACHINE_GUEST_REPLY_INVALID"))
			.filter((item) => typeof item.commandId === "string" && e.commands.includes(item.commandId))
			.map((item) => ({
				commandId: item.commandId,
				state: item.state,
				...(item.state === "succeeded" || item.state === "failed" ? { exitCode: item.exitCode } : {}),
				outputTail: typeof item.outputTail === "string" ? item.outputTail.slice(-4000) : "",
			}));
		return { ended, busy };
	}
	/** What a look saw, recorded in SQL: the ended commands, and a busy machine, which moves its idle clock. */
	async #record(
		e: CompanyMachineEntry,
		bootId: string,
		look: { ended: unknown[]; busy: boolean },
		signal: AbortSignal,
	): Promise<void> {
		if (!look.ended.length && !look.busy) return;
		await this.#custody(e, "qorpera_record_company_machine_commands", signal, {
			p_boot_id: bootId,
			p_ended: look.ended,
			p_busy: look.busy,
		});
		const kept = this.#guests.get(e.placementId);
		if (kept?.bootId === bootId) kept.busy = false;
	}

	/** Settles a boot's folder (F3 6d) as far as it can this pass, and says what came of it. A boot this process saw
	 * start gets a view of its own: opened in SQL as the platform for this boot, then handed to the guest. After this
	 * process restarted, a view the service still holds keeps the boot's /company (a new one would take it away from the
	 * commands that run) and its boundaries keep fencing. A boot that gets no view of its own (a guest of an earlier
	 * image, a refused open, views the guest answers closed) is left to #viewless; a busy or unconfirmed open, or a
	 * hand-over without an answer, is tried again next pass, and starts wait meanwhile. */
	async #settle(e: CompanyMachineEntry, f: BootFolder, helperSha256: string, signal: AbortSignal): Promise<string> {
		const folder = this.#options.folder as FolderControl;
		// A guest of an earlier image is handed no view: whether its helper ever took one is not this image's to say.
		if (helperSha256 !== this.#options.helperSha256) return this.#viewless(e, f, "old-helper", signal);
		if (!f.asked) {
			let held: string[];
			try {
				const checked = AbortSignal.any([signal, AbortSignal.timeout(BOUNDARY_MS)]);
				const boundary = await folder.boundary(e.placementId, [], checked);
				noted(f, boundary);
				held = boundary.views.map((view) => view.viewId);
			} catch (error) {
				return errorCode(error);
			}
			f.asked = true;
			if (held.length) {
				for (const viewId of held) f.views.add(viewId);
				f.state = "open";
				f.held = true;
				return "FOLDER_HELD";
			}
		}
		if (!f.view) {
			let opened: Record<string, unknown>;
			try {
				opened = record(
					await this.#call(
						"qorpera_folder_view_open",
						{
							p_environment_id: e.binding.environmentId,
							p_opener: { kind: "platform" },
							p_kind: "test_machine",
							p_anchor: { companyMachineId: e.machineId, placementId: e.placementId, bootId: f.bootId },
						},
						signal,
					),
					"COMPANY_MACHINE_FOLDER_VIEW_INVALID",
				);
			} catch (error) {
				if (!(error instanceof CodingControlRefused)) return errorCode(error);
				// A disk the core cannot prove (a test machine's new disk) moves the machine to a new one (6d-2).
				if (error.detail === "qorpera.test-machine/new-disk") return this.#retire(e, f, "new-disk", signal);
				f.refusal = error.reason ?? undefined;
				return this.#viewless(e, f, "refused", signal);
			}
			if (
				opened.schema !== "qorpera.folder-view/v1" ||
				typeof opened.viewId !== "string" ||
				!UUID.test(opened.viewId) ||
				typeof opened.pass !== "string" ||
				!PASS.test(opened.pass)
			)
				return "COMPANY_MACHINE_FOLDER_VIEW_INVALID";
			f.view = { viewId: opened.viewId, pass: opened.pass };
			f.opens++;
		}
		// From here the guest may hold the pass, whatever it answers: the boot is fenced for good.
		f.handed = true;
		f.views.add(f.view.viewId);
		let mount: string;
		try {
			mount = await this.#mount(e, f.view, signal);
		} catch (error) {
			// The guest refused or did not answer: the view is handed over again next pass.
			return errorCode(error);
		}
		if (mount === "closed") {
			// The node closed or refused the view: another one, a few times.
			await this.#closeView(f.view, signal);
			f.view = undefined;
			if (f.opens < FOLDER_OPENS) return "MACHINE_FOLDER_CLOSED";
			return this.#viewless(e, f, "closed", signal);
		}
		f.state = "open";
		if (mount !== "mounted") return "FOLDER_UNANSWERED";
		f.held = true;
		return "FOLDER_MOUNTED";
	}
	/** A boot without a view of its own runs without /company only when no pass can have reached its guest: this
	 * process saw it start, handed it none, and the service holds no view of the machine and has its reads released.
	 * Any other boot stays fenced, by its windows and the machine's boundaries; reads that stay unproven then restart
	 * its guest (#watch). */
	async #viewless(
		e: CompanyMachineEntry,
		f: BootFolder,
		reason: NonNullable<BootFolder["reason"]>,
		signal: AbortSignal,
	): Promise<string> {
		const code = reason.toUpperCase().replace("-", "_");
		f.reason = reason;
		if (f.known && !f.handed) {
			let boundary: MachineBoundary;
			try {
				const checked = AbortSignal.any([signal, AbortSignal.timeout(BOUNDARY_MS)]);
				boundary = await (this.#options.folder as FolderControl).boundary(e.placementId, [], checked);
			} catch (error) {
				return errorCode(error);
			}
			noted(f, boundary);
			if (!boundary.views.length && boundary.reads === "released") {
				f.state = "none";
				return `FOLDER_NONE:${code}`;
			}
			for (const view of boundary.views) f.views.add(view.viewId);
		}
		f.state = "open";
		return `FOLDER_FENCED:${code}`;
	}
	/** A disk that may never be proven (6d-2): a new disk the open refuses, or reads on its view the core cannot read (a
	 * boundary's, or a run's take-in of them, 6d-3b).
	 * SQL checks the cause again: it retires the placement (its commands end lost, and admission starts the machine on a
	 * new disk once this one is stopped and removed), or keeps a disk that may still get a view, as the boot it is. A
	 * boot SQL no longer runs (stale) or a retired placement only waits for its stop: its starts are refused. */
	async #retire(
		e: CompanyMachineEntry,
		f: BootFolder,
		reason: "new-disk" | "unreadable",
		signal: AbortSignal,
	): Promise<string> {
		let retired: Record<string, unknown>;
		try {
			retired = record(
				await this.#custody(e, "qorpera_retire_company_machine", signal, { p_boot_id: f.bootId, p_reason: reason }),
				"COMPANY_MACHINE_RETIRE_INVALID",
			);
		} catch (error) {
			return errorCode(error);
		}
		if (retired.state === "kept" && retired.reason === "FOLDER_DISK_USABLE") return "FOLDER_DISK_USABLE";
		let code: string;
		let cause: string;
		if (retired.state === "stale") {
			code = "FOLDER_RETIRE_STALE";
			cause = "stale";
		} else if (
			retired.state === "retired" &&
			retired.placementId === e.placementId &&
			["unchecked", "starter", "unreadable"].includes(retired.reason as string)
		) {
			code = `FOLDER_RETIRED:${String(retired.reason).toUpperCase()}`;
			cause = `moved_${String(retired.reason)}`;
		} else return "COMPANY_MACHINE_RETIRE_INVALID";
		this.#endings.set(`${e.placementId}/${f.bootId}`, { by: "retirement", code, cause });
		return code;
	}
	/** A boot whose folder can never be proven again (6d-2): its reads stay unproven, or its own view was closed or is
	 * gone. Its guest restarts, and the next boot gets a view of its own; until then its starts are refused, and its
	 * output and its ends stay held. A start on its way into the guest goes in before the reboot is asked
	 * (#delivered), and SQL keeps why for the commands the restart loses (#mark). */
	async #restart(
		e: CompanyMachineEntry,
		f: BootFolder,
		why: "UNPROVEN" | "VIEW_CLOSED" | "VIEW_GONE",
		signal: AbortSignal,
	): Promise<string> {
		const code = `FOLDER_RESTART:${why}`;
		const cause = `restart_${why.toLowerCase()}`;
		this.#endings.set(`${e.placementId}/${f.bootId}`, { by: "restart", code, cause });
		await this.#delivered(e, signal);
		await this.#mark(e, f.bootId, cause, signal);
		await this.#reboot(e, signal);
		return code;
	}
	/** The commands still open on a boot the executor restarts end lost in its restart: SQL keeps why for their runs
	 * (6e-2a). Asked before each reboot, at best: a mark that fails, or a start let in after it, leaves a command lost
	 * without a cause. */
	async #mark(e: CompanyMachineEntry, bootId: string, cause: string, signal: AbortSignal): Promise<void> {
		await this.#custody(e, "qorpera_mark_company_machine_folder_restart", signal, {
			p_boot_id: bootId,
			p_reason: cause.slice("restart_".length),
		}).catch(() => undefined);
	}
	/** Waits until no start is being delivered to the machine, for at most a delivery's 30 s: one let in before its boot
	 * ended reaches its guest first (and is lost in the restart), and one not yet in is refused (#command). */
	async #delivered(e: CompanyMachineEntry, signal: AbortSignal): Promise<void> {
		const waited = AbortSignal.any([signal, AbortSignal.timeout(DELIVERY_MS)]);
		while (!waited.aborted && [...this.#delivering.keys()].some((key) => key.startsWith(`${e.placementId}/`)))
			await setTimeout(200, undefined, { signal: waited }).catch(() => undefined);
	}
	/** The guest reboots itself, unwaited: a stop from here would wait for its commands to end (SQL refuses a stop while
	 * one runs). A guest that does not reboot stays held until it does, or stops. */
	async #reboot(e: CompanyMachineEntry, signal: AbortSignal): Promise<void> {
		await this.#options.client
			.execInstance(
				e.binding.project,
				this.#plan(e).name,
				["/bin/sh", "-c", "systemctl --no-block reboot"],
				AbortSignal.any([signal, AbortSignal.timeout(REBOOT_MS)]),
			)
			.catch(() => undefined);
	}
	/** A boot whose folder ended (6d-2): nothing of it is looked at or recorded any more, by a pass or its stop, and
	 * nothing its commands printed, nor how they ended, leaves it (#command). Its starts are refused (#settled). */
	#ended(placementId: string, bootId: string): boolean {
		return this.#endings.has(`${placementId}/${bootId}`);
	}
	/** Hands a view to the guest's folder program (folder-mount, F3 6c) on exec stdin: its pass is never in an argument,
	 * a file on this host or a log. The newest view the guest is handed wins. */
	async #mount(
		e: CompanyMachineEntry,
		view: { viewId: string; pass: string },
		signal: AbortSignal,
	): Promise<"mounted" | "closed" | "unanswered"> {
		const plan = this.#plan(e);
		const nonce = randomUUID();
		const client = this.#options.client as LxdInstanceExecStreamClient;
		await client.execInstanceStream(
			plan.project,
			plan.name,
			{
				command: ["/usr/bin/node", PATHS.helper, nonce, "folder-mount"],
				stdin: Buffer.from(JSON.stringify({ environmentId: e.binding.environmentId, ...view })),
				maxStdoutBytes: 65536,
				maxStderrBytes: 65536,
				timeoutMs: FOLDER_MOUNT_MS,
			},
			signal,
		);
		const answer = guestAnswer(await this.#reply(plan, nonce, signal));
		if (
			answer.schema !== "qorpera.machine-guest-folder/v1" ||
			answer.viewId !== view.viewId ||
			(answer.mount !== "mounted" && answer.mount !== "closed" && answer.mount !== "unanswered")
		)
			throw new Error("COMPANY_MACHINE_GUEST_REPLY_INVALID");
		return answer.mount as "mounted" | "closed" | "unanswered";
	}
	/** The view's close in SQL (said again, it changes nothing). Not closed, it lapses with its lease. */
	async #closeView(view: { viewId: string; pass: string }, signal: AbortSignal): Promise<void> {
		await this.#call("qorpera_folder_view_close", { p_view_id: view.viewId, p_pass: view.pass }, signal).catch(
			() => undefined,
		);
	}
	/** A boot's folder ends (F3 6d), with its machine up: the final boundary of every view of the boot the service may
	 * hold, which closes them in the core (at most a minute: what an unanswered final held is not applied), then the
	 * view's close. A machine that restarted is then said to have (`restarted`): its command windows end, and a read it
	 * lost no longer makes its next views unproven. Nothing here holds up the stop or the next boot. A boot whose folder
	 * ended (6d-2) stays so once its folder is gone (#endings): a stop, or a next boot, that SQL did not take yet comes
	 * back to it. */
	async #endFolder(e: CompanyMachineEntry, bootId: string, signal: AbortSignal, restarted: boolean): Promise<void> {
		const folder = this.#options.folder as FolderControl;
		const kept = this.#folders.get(e.placementId);
		const f = kept?.bootId === bootId ? kept : undefined;
		if (f?.state !== "none") {
			const checked = AbortSignal.any([signal, AbortSignal.timeout(FINAL_BOUNDARY_MS)]);
			try {
				const views = new Set([...(f?.views ?? []), ...(f?.view ? [f.view.viewId] : [])]);
				// Unseen by this process, the boot's views are the ones the service holds for the machine.
				if (!f?.known)
					for (const view of (await folder.boundary(e.placementId, [], checked)).views) views.add(view.viewId);
				if (views.size) await folder.boundary(e.placementId, [...views].slice(0, 256), checked);
			} catch {
				// Unanswered: the service applies nothing it held for the final.
			}
			if (f?.view) await this.#closeView(f.view, signal);
		}
		if (restarted) {
			const checked = AbortSignal.any([signal, AbortSignal.timeout(BOUNDARY_MS)]);
			await folder.restarted(e.placementId, checked).catch(() => undefined);
		}
		this.#folders.delete(e.placementId);
	}
	/** A look (`looking`) and its ends, in the end order (F3 6d): each ended command's window closes first, and its end
	 * (how it ended, its exit and its output tail) is recorded only once that close answers the machine's reads
	 * released. Any other answer, or none, leaves the end for a later look. A start being delivered at any time from
	 * the look's beginning is not ended by it: its guest may have looked before it had the command, so its window stays
	 * open (or opens again, after the close), and a later look decides. The last boundary a close answered comes back
	 * too, for #watch. */
	async #ends(
		e: CompanyMachineEntry,
		bootId: string,
		looking: () => Promise<{ ended: Record<string, unknown>[]; busy: boolean }>,
		signal: AbortSignal,
	): Promise<{ ended: Record<string, unknown>[]; busy: boolean; boundary?: MachineBoundary }> {
		const folder = this.#options.folder;
		if (!folder) return looking();
		const touched = new Set<string>();
		this.#looks.add(touched);
		try {
			const look = await looking();
			const keyOf = (item: Record<string, unknown>) => `${e.placementId}/${item.commandId as string}`;
			const stale = (item: Record<string, unknown>) => touched.has(keyOf(item)) || this.#delivering.has(keyOf(item));
			// A boot without /company has no windows to close, but a start delivered meanwhile is not ended either.
			const f = this.#folders.get(e.placementId);
			if (f?.bootId === bootId && f.state === "none")
				return { ended: look.ended.filter((item) => !stale(item)), busy: look.busy };
			const checked = AbortSignal.any([signal, AbortSignal.timeout(WINDOWS_MS)]);
			const ended: Record<string, unknown>[] = [];
			let boundary: MachineBoundary | undefined;
			for (const item of look.ended) {
				if (stale(item)) continue;
				const commandId = item.commandId as string;
				const key = keyOf(item);
				// The command ended: its window is not opened again (#reopen), whatever its close answers.
				if (f?.bootId === bootId) f.windows.delete(commandId);
				// A start that comes meanwhile opens its window (again) only once this close is answered (#command).
				const closing = folder.closeWindow(e.placementId, commandId, checked).catch(() => undefined);
				this.#closing.set(key, closing);
				const answer = await closing;
				if (this.#closing.get(key) === closing) this.#closing.delete(key);
				if (f?.bootId === bootId) noted(f, answer);
				boundary = answer ?? boundary;
				if (answer?.reads === "released") ended.push(item);
			}
			// A start that came while the windows closed is not ended either: its window opens again after the close.
			return { ended: ended.filter((item) => !stale(item)), busy: look.busy, ...(boundary ? { boundary } : {}) };
		} finally {
			this.#looks.delete(touched);
		}
	}
	/** The boot's command windows, opened again (said again, it changes nothing): the service keeps them in memory, so
	 * after it restarted, what the machine changes is credited to the commands that run again. A start still being
	 * delivered opens its own, and a command SQL does not list now is left for its close (#ends). */
	async #reopen(e: CompanyMachineEntry, f: BootFolder, signal: AbortSignal): Promise<void> {
		const folder = this.#options.folder as FolderControl;
		const checked = AbortSignal.any([signal, AbortSignal.timeout(WINDOWS_MS)]);
		for (const [commandId, window] of f.windows) {
			if (!e.commands.includes(commandId) || this.#delivering.has(`${e.placementId}/${commandId}`)) continue;
			await folder.openWindow(e.placementId, window, checked).catch(() => undefined);
		}
	}
	/** A settled boot's folder, watched each pass (6d-2) at the boundary its ends' closes answered, or a plain one.
	 * Reads the core cannot read retire the placement (#retire): a read being released, or one released before that a
	 * view's publish found no longer readable (the view's report says so, with the machine's reads released). Reads
	 * that stay unproven (a read went unreleased, which only the machine's restart forgives), a view of the boot's own
	 * the core closed (a narrowing, or a crashed service's view refused to the next one), or that view missing from the
	 * service for longer than its folder program takes to connect again, restart its guest (#restart). Any other
	 * answer, or none, changes nothing. */
	async #watch(
		e: CompanyMachineEntry,
		f: BootFolder,
		given: MachineBoundary | undefined,
		signal: AbortSignal,
	): Promise<string | undefined> {
		let boundary = given;
		if (!boundary)
			try {
				const checked = AbortSignal.any([signal, AbortSignal.timeout(BOUNDARY_MS)]);
				boundary = await (this.#options.folder as FolderControl).boundary(e.placementId, [], checked);
				noted(f, boundary);
			} catch {
				return undefined;
			}
		// A view's publish the core refused for a read it can no longer read: a read released before, which its commit's
		// read set checked again, while no read was left to release (so the machine's reads answer released).
		if (boundary.reads === "unreadable" || boundary.views.some((view) => view.report?.refused === "unreadable"))
			return this.#retire(e, f, "unreadable", signal);
		if (boundary.reads === "unproven") return this.#restart(e, f, "UNPROVEN", signal);
		// The boot's own views: the one this process opened, or (after it restarted) the ones the service held.
		const own = f.view ? [f.view.viewId] : f.reason ? [] : [...f.views];
		const listed = boundary.views.filter((view) => own.includes(view.viewId));
		if (listed.some((view) => view.error?.code === "VIEW_CLOSED")) return this.#restart(e, f, "VIEW_CLOSED", signal);
		if (listed.length) {
			f.held = true;
			f.missing = undefined;
		} else if (f.held) {
			f.missing ??= Date.now();
			if (Date.now() - f.missing >= FOLDER_GONE_MS) return this.#restart(e, f, "VIEW_GONE", signal);
		}
		return undefined;
	}
	async #stop(e: CompanyMachineEntry, signal: AbortSignal): Promise<CompanyMachineOutcome> {
		// A last look first, when this boot was seen before, so a machine busy again since the last pass keeps running
		// (stop custody then refuses). A guest that does not answer still stops, once busy work seen earlier is recorded;
		// a record SQL does not take leaves the machine running until a later pass records it. A boot whose folder ended
		// (6d-2) is neither looked at nor recorded, before its windows close or after, and at every stop again after one
		// whose record or power-off failed (its folder gone by then): how its commands ended, and what they printed, stay
		// held whatever a boundary answers (#ended).
		const kept = this.#guests.get(e.placementId);
		const bootId = e.bootId;
		const ended = () => bootId !== null && this.#ended(e.placementId, bootId);
		if (bootId !== null && kept?.bootId === bootId && !ended()) {
			const checked = AbortSignal.any([signal, AbortSignal.timeout(30000)]);
			const looking = () => this.#look(e, bootId, checked).catch(() => ({ ended: [], busy: kept.busy }));
			const look = await this.#ends(e, bootId, looking, signal);
			if (!ended()) await this.#record(e, bootId, look, signal);
		}
		// SQL agrees first: an idle machine someone just used again keeps running, programs and all.
		try {
			await this.#authorize(e, "stop", signal);
		} catch (error) {
			if (errorCode(error).startsWith("COMPANY_MACHINE_REFUSED:"))
				return { placementId: e.placementId, step: "stop", state: "not-now" };
			throw error;
		}
		// Right before it stops the programs, the guest lists what runs (its command units, at most 32 oldest first,
		// and whether Docker ran containers); SQL ends those commands with the stop's cause and tells them, before the
		// machine is powered off (its disk stays). A guest without the helper's stop is stopped as before; a snapshot
		// that is not the listed shape, or of a boot SQL does not know, is left out. Either way what still runs is told
		// at the power-off. A power-off that then fails ends this stop: the next one takes its own snapshot.
		if (e.runningAt !== null) {
			const stopping = AbortSignal.any([signal, AbortSignal.timeout(30000)]);
			const stopped = await this.#helper(e, ["stop-commands"], stopping).catch(() => undefined);
			if (!stopped)
				await this.#options.client
					.execInstance(
						e.binding.project,
						this.#plan(e).name,
						["/bin/sh", "-c", `systemctl stop ${PATHS.slice} docker.service containerd.service; sync`],
						stopping,
					)
					.catch(() => undefined);
			// A boot whose folder ended lists none of its commands either: which still ran says how the others ended, so
			// SQL ends them all lost at the power-off (#ended). Its stopped containers are the stop's own.
			const silent = ended();
			// With its programs stopped and the machine still up, the boot's folder ends (F3 6d): the final boundary of
			// its views, then their close, before SQL ends the commands and the machine is powered off.
			if (this.#options.folder && e.bootId !== null) await this.#endFolder(e, e.bootId, signal, false);
			if (
				stopped &&
				stopped.schema === "qorpera.machine-commands-stopped/v1" &&
				stopped.bootId === e.bootId &&
				Array.isArray(stopped.commands) &&
				stopped.commands.length <= 32 &&
				stopped.commands.every((id) => typeof id === "string" && UUID.test(id)) &&
				typeof stopped.containers === "boolean"
			)
				// SQL takes the snapshot before the power-off; a record it does not take leaves the machine running.
				await this.#custody(e, "qorpera_record_company_machine_stop", signal, {
					p_boot_id: e.bootId,
					p_commands: silent ? [] : stopped.commands,
					p_containers: stopped.containers,
				});
			// What the stop ended is never measured as busy afterwards: a look after a failed power-off starts afresh.
			this.#guests.delete(e.placementId);
		}
		const state = await this.#physical(e, "stopped", signal);
		if (state === "not-now") return { placementId: e.placementId, step: "stop", state: "not-now" };
		this.#guests.delete(e.placementId);
		// Its next boot has its own time to come up.
		this.#starting.delete(e.placementId);
		if (this.#options.folder && e.bootId !== null) {
			// Powered off: the machine's command windows end, and what it was served is gone with it.
			const checked = AbortSignal.any([signal, AbortSignal.timeout(BOUNDARY_MS)]);
			await this.#options.folder.restarted(e.placementId, checked).catch(() => undefined);
			this.#folders.delete(e.placementId);
		}
		const suspended = record(
			await this.#custody(e, "qorpera_suspend_company_machine", signal),
			"COMPANY_MACHINE_SUSPEND_INVALID",
		);
		return { placementId: e.placementId, step: "stop", state: suspended.state === "suspended" ? "done" : "not-now" };
	}
	async #remove(e: CompanyMachineEntry, signal: AbortSignal): Promise<CompanyMachineOutcome> {
		if (!e.released) {
			// A machine SQL still counts as running (its VM powered off by itself; LXD deletes only a stopped
			// one) ends its boot's folder before it goes (F3 6d).
			if (this.#options.folder && e.runningAt !== null && e.bootId !== null)
				await this.#endFolder(e, e.bootId, signal, false);
			const state = await this.#physical(e, "deleted", signal);
			if (state === "not-now") return { placementId: e.placementId, step: "delete", state: "not-now" };
		}
		const released = record(
			await this.#custody(e, "qorpera_release_company_machine", signal),
			"COMPANY_MACHINE_RELEASE_INVALID",
		);
		if (released.state !== "released") throw new Error("COMPANY_MACHINE_RELEASE_INVALID");
		this.#guests.delete(e.placementId);
		this.#starting.delete(e.placementId);
		this.#folders.delete(e.placementId);
		// Its instance deleted and the placement released, no boot of it runs or is read again: its ends go with it. Only
		// here: after a power-off, or the next boot's mark, a read let in for the boot before may still come.
		for (const key of this.#endings.keys()) if (key.startsWith(`${e.placementId}/`)) this.#endings.delete(key);
		return { placementId: e.placementId, step: "release", state: "done" };
	}
	/** This placement's own instance exists, unchanged, and runs. */
	async #instanceRunning(e: CompanyMachineEntry, signal: AbortSignal): Promise<boolean> {
		const plan = this.#plan(e);
		const instance = await this.#options.client.getInstance(plan.project, plan.name, signal);
		if (!instance) return false;
		plan.assertInstance(instance);
		return instance.status === "Running";
	}
	async #step(e: CompanyMachineEntry, signal: AbortSignal): Promise<CompanyMachineOutcome> {
		if (e.released) return this.#remove(e, signal);
		if ((e.stopDue || e.sleepDue) && e.reserved) return this.#stop(e, signal);
		if (e.removeDue && !e.reserved) return this.#remove(e, signal);
		if (e.desiredState === "running" && e.reserved) {
			const state = await this.#physical(e, "running", signal);
			// Without new run authority (its node looks unavailable, or machines are switched off), a
			// machine that already runs keeps its lease and its commands are still watched: only
			// creating or starting it needs the node's room.
			if (state === "not-now" && !(e.runningAt !== null && (await this.#instanceRunning(e, signal))))
				return { placementId: e.placementId, step: "start", state: "not-now" };
			return this.#guest(e, signal);
		}
		return { placementId: e.placementId, step: "wait", state: "not-now" };
	}
	async #recordError(
		e: CompanyMachineEntry,
		stage: string,
		errorCodeValue: string | null,
		signal: AbortSignal,
	): Promise<void> {
		await this.#call(
			"qorpera_record_company_machine_error",
			{
				p_placement_id: e.placementId,
				p_owner: this.#options.owner,
				p_machine_id_sha256: this.#options.machineIdSha256,
				p_stage: stage,
				p_code: errorCodeValue,
			},
			signal,
		).catch(() => undefined);
	}

	/** One pass. Placements progress side by side; a failed step is recorded
	 * on its machine and retried at the next pass, never hidden. Admission
	 * takes one machine per call (one reservation per transaction) and never
	 * holds up the rest of the pass. */
	pass(signal: AbortSignal): Promise<CompanyMachineOutcome[]> {
		return withAbortScope(signal, (scoped) => this.#pass(scoped, signal));
	}
	/** `lasting` outlasts this pass: a step that outlasts it goes on under it, each step under a scope of its own. */
	async #pass(signal: AbortSignal, lasting: AbortSignal): Promise<CompanyMachineOutcome[]> {
		const admission: CompanyMachineOutcome[] = [];
		for (let admitted = 0; admitted < 8; admitted++) {
			let taken: unknown;
			try {
				taken = await this.#call(
					"qorpera_admit_executor_machines",
					{ p_owner: this.#options.owner, p_machine_id_sha256: this.#options.machineIdSha256, p_limit: 64 },
					signal,
				);
			} catch (error) {
				admission.push({ placementId: null, step: "admit", state: "failed", code: errorCode(error) });
				break;
			}
			if (!Array.isArray(taken) || taken.length === 0) break;
		}
		const listed = await this.#call(
			"qorpera_list_executor_machines",
			{ p_owner: this.#options.owner, p_machine_id_sha256: this.#options.machineIdSha256 },
			signal,
		);
		if (!Array.isArray(listed)) throw new Error("COMPANY_MACHINE_LIST_INVALID");
		const entries = listed.map(entry);
		const outcomes: (CompanyMachineOutcome | undefined)[] = [];
		let over = false;
		const steps = Promise.all(
			entries.map(async (e, index) => {
				if (this.#stepping.has(e.placementId)) return;
				this.#stepping.add(e.placementId);
				try {
					const outcome = await withAbortScope(lasting, (scoped) =>
						this.#exclusive(e.placementId, () => this.#stepped(e, scoped)),
					);
					this.#after(e, outcome);
					if (over) this.#late.push(outcome);
					else outcomes[index] = outcome;
				} finally {
					this.#stepping.delete(e.placementId);
				}
			}),
		);
		const hold = this.#options.passHoldMs;
		if (hold === undefined) await steps;
		else {
			const done = new AbortController();
			await Promise.race([
				steps.finally(() => done.abort()),
				setTimeout(hold, undefined, { signal: done.signal }).catch(() => undefined),
			]);
		}
		over = true;
		return [
			...this.#late.splice(0),
			...admission,
			...outcomes.filter((outcome): outcome is CompanyMachineOutcome => outcome !== undefined),
		];
	}
	/** One placement's step: what came of it. A failed step is recorded on its machine. */
	async #stepped(e: CompanyMachineEntry, signal: AbortSignal): Promise<CompanyMachineOutcome> {
		const stage = (step: CompanyMachineOutcome["step"]) =>
			step === "guest" || step === "commands"
				? step === "guest"
					? "guest"
					: "commands"
				: step === "wait"
					? "start"
					: step;
		try {
			const outcome = await this.#step(e, signal);
			if (outcome.state === "done" && outcome.step !== "commands")
				await this.#recordError(e, stage(outcome.step), null, signal);
			return outcome;
		} catch (error) {
			const step: CompanyMachineOutcome["step"] =
				e.released || (e.removeDue && !e.reserved)
					? "delete"
					: (e.stopDue || e.sleepDue) && e.reserved
						? "stop"
						: "start";
			// The company's locks were busy past SQL's short wait (lock_not_available): no fault
			// of the machine's, and nothing to show; the next pass tries again.
			if (error instanceof CodingControlBusy)
				return {
					placementId: e.placementId,
					step,
					state: "not-now" as const,
					code: "CODING_CONTROL_BUSY",
				};
			const failed = errorCode(error);
			await this.#recordError(e, stage(step), failed, signal);
			return { placementId: e.placementId, step, state: "failed" as const, code: failed };
		}
	}
	/** A step that took its machine somewhere tells who waits to hear it. A stop or a release may have freed the room a
	 * machine in line waits for, and only a pass admits it: the next one comes at once. */
	#after(e: CompanyMachineEntry, outcome: CompanyMachineOutcome): void {
		if (outcome.state !== "done" || outcome.step === "commands") return;
		for (const tell of [...(this.#listeners.get(e.machineId) ?? [])]) tell();
		if (outcome.step === "stop" || outcome.step === "release") this.wake();
	}

	/** Asks for the next pass now, instead of at the end of the wait before it (or right after the pass that runs). A wake
	 * carries no authority: each step of that pass asks SQL as ever. */
	wake(): void {
		this.#woken = true;
		this.#ending?.();
	}
	/** A wake, and the answer once a step took this machine somewhere: true when its start is done (its folder settled
	 * too) or it stopped or went, false when the signal ended first. The answer only says to look: what SQL says stands. */
	changed(machineId: string, signal: AbortSignal): Promise<boolean> {
		this.wake();
		return new Promise((settle) => {
			if (signal.aborted) return settle(false);
			const listeners = this.#listeners.get(machineId) ?? new Set<() => void>();
			this.#listeners.set(machineId, listeners);
			const finish = (answer: boolean): void => {
				signal.removeEventListener("abort", left);
				listeners.delete(told);
				if (!listeners.size && this.#listeners.get(machineId) === listeners) this.#listeners.delete(machineId);
				settle(answer);
			};
			const told = (): void => finish(true);
			const left = (): void => finish(false);
			listeners.add(told);
			signal.addEventListener("abort", left, { once: true });
		});
	}
	/** The wait before the next pass, `ms` at most. A wake ends it. So does a guest still starting whose boot became usable:
	 * each is asked every second, of LXD alone, so a boot costs SQL nothing more. A boot that never gets there is left to
	 * the passes, as it would be without this. */
	async pause(ms: number, signal: AbortSignal): Promise<void> {
		const deadline = Date.now() + ms;
		while (!this.#woken && !signal.aborted) {
			const left = deadline - Date.now();
			if (left <= 0) break;
			this.#lookAtStarting(signal);
			await new Promise<void>((settle) => {
				const end = (): void => {
					clearTimeout(timer);
					signal.removeEventListener("abort", end);
					this.#ending = undefined;
					settle();
				};
				const timer = globalThis.setTimeout(end, Math.min(STARTING_LOOK_MS, left));
				signal.addEventListener("abort", end, { once: true });
				this.#ending = end;
			});
		}
		this.#woken = false;
	}
	#lookAtStarting(signal: AbortSignal): void {
		const limit = this.#options.guestReadyTimeoutMs ?? 180000;
		for (const [placementId, { since, entry: e }] of this.#starting) {
			if (Date.now() - since >= limit || this.#looking.has(placementId) || this.#stepping.has(placementId)) continue;
			this.#looking.add(placementId);
			void withAbortScope(signal, (scoped) =>
				this.#bootUsable(e, AbortSignal.any([scoped, AbortSignal.timeout(STARTING_LOOK_LIMIT_MS)])),
			)
				.then((usable) => {
					if (usable) this.wake();
				})
				.finally(() => this.#looking.delete(placementId));
		}
	}
	/** Whether the guest's agent answers (a file read, which fails at once and leaves no operation behind) and its boot
	 * reached BOOT_USABLE. */
	async #bootUsable(e: CompanyMachineEntry, signal: AbortSignal): Promise<boolean> {
		try {
			const { project, name } = this.#plan(e);
			await this.#options.client.readInstanceFile(project, name, PATHS.helper, 65536, signal);
			await this.#options.client.execInstance(
				project,
				name,
				BOOT_USABLE,
				signal,
				Math.ceil(STARTING_LOOK_LIMIT_MS / 1000),
			);
			return true;
		} catch {
			return false;
		}
	}
	/** The steps still running, once they ended. */
	async settled(): Promise<void> {
		await Promise.allSettled([...this.#work.values()]);
	}

	/** Runs one authorized command action on a machine of this node. A start on a machine with a folder is delivered
	 * meanwhile: a look from before its guest had it, or from while it was delivered, leaves its window open (#ends),
	 * and a restart of its guest waits for it (#delivered). */
	async command(
		authority: CompanyMachineCommandAuthority,
		request: CompanyMachineCommand,
		signal: AbortSignal,
	): Promise<CloudMachineCommandReceipt> {
		if (request.action !== "start" || !this.#options.folder) return this.#command(authority, request, signal);
		const key = `${authority.placementId}/${authority.commandId}`;
		this.#delivery(key, 1);
		try {
			return await this.#command(authority, request, signal);
		} finally {
			this.#delivery(key, -1);
		}
	}
	/** A start's delivery begins (1) or ends (-1): every look on its way no longer speaks for its command. */
	#delivery(key: string, by: 1 | -1): void {
		const left = (this.#delivering.get(key) ?? 0) + by;
		if (left > 0) this.#delivering.set(key, left);
		else this.#delivering.delete(key);
		for (const touched of this.#looks) touched.add(key);
	}
	async #command(
		authority: CompanyMachineCommandAuthority,
		request: CompanyMachineCommand,
		signal: AbortSignal,
	): Promise<CloudMachineCommandReceipt> {
		const machine = { machineId: authority.machineId, project: this.#policy.project };
		if (!UUID.test(machine.machineId) || !UUID.test(authority.placementId) || !SHA.test(authority.inputSha256))
			throw new Error("COMPANY_MACHINE_COMMAND_INVALID");
		const name = lxdCompanyMachineName(authority.placementId);
		const commandId = request.action === "read" ? request.read.commandId : request.commandId;
		if (commandId !== authority.commandId) throw new Error("COMPANY_MACHINE_COMMAND_INVALID");
		const nonce = randomUUID();
		const folder = this.#options.folder;
		let args: string[];
		// The boot a start on a machine with a folder was let in on, which its guest checks at the start's exec.
		let on: string | undefined;
		if (request.action === "start") {
			if (request.inputSha256 !== authority.inputSha256) throw new Error("COMPANY_MACHINE_COMMAND_INVALID");
			// A machine with a folder starts a command only once its boot's folder settled, and with its window open: what
			// the machine changes from now on is credited to the command's run (F3 6d).
			const boot = folder ? await this.#settled(authority, signal) : undefined;
			// A pass can end the boot's folder (6d-2), or see its next boot, while the start waits: after each wait, up to
			// the guest's exec, the start goes on only on the boot it was let in on, and its folder not ended.
			const fenced = () => {
				if (
					boot &&
					(this.#folders.get(authority.placementId) !== boot || this.#ended(authority.placementId, boot.bootId))
				)
					throw new Error("COMPANY_MACHINE_FOLDER_ENDED");
			};
			if (folder && boot?.state === "open") {
				const { runId, staffAgentId, requestedByUserId } = authority;
				if (
					typeof runId !== "string" ||
					typeof staffAgentId !== "string" ||
					typeof requestedByUserId !== "string" ||
					![runId, staffAgentId, requestedByUserId].every((id) => UUID.test(id))
				)
					throw new Error("COMPANY_MACHINE_COMMAND_INVALID");
				const window = { commandId, runId, staffAgentId, requestedByUserId };
				// The service opens a window in memory: a few seconds are ample, and the start stays in the gateway's 30.
				const checked = AbortSignal.any([signal, AbortSignal.timeout(5000)]);
				// A pass that saw the command before its guest had it closes its window: that close is answered first, so
				// the open comes after it.
				const closing = this.#closing.get(`${authority.placementId}/${commandId}`);
				if (closing && !checked.aborted) await Promise.race([closing, once(checked, "abort")]);
				if (checked.aborted) throw new Error("FOLDER_CONTROL_UNANSWERED");
				fenced();
				await folder.openWindow(authority.placementId, window, checked);
				// Opened again each pass until the command ends (#reopen).
				boot.windows.set(commandId, window);
			}
			fenced();
			await this.#options.client.pushInstanceFile(
				machine.project,
				name,
				`${PATHS.state}/inbox/${commandId}.json`,
				JSON.stringify({
					schema: "qorpera.machine-command-request/v1",
					machineId: machine.machineId,
					commandId,
					inputSha256: request.inputSha256,
					command: request.command,
					timeoutMs: request.timeoutMs,
				}),
				0o400,
				signal,
			);
			fenced();
			on = boot?.bootId;
			args = ["start", commandId];
		} else if (request.action === "cancel") args = ["cancel", commandId];
		else
			args = [
				"read",
				commandId,
				...(request.read.tail
					? ["tail", String(request.read.limit ?? 4096)]
					: [String(request.read.offset ?? 0), String(request.read.limit ?? 4096)]),
			];
		const helper = ["/usr/bin/node", PATHS.helper, nonce, ...args];
		// A start that crosses its guest's restart (it was let in before, and reaches the next boot) fails in the guest's
		// shell, and nothing starts (ON_BOOT).
		await this.#options.client.execInstance(
			machine.project,
			name,
			on ? ["/bin/sh", "-c", ON_BOOT, on, ...helper] : helper,
			signal,
		);
		const file = await this.#options.client.readInstanceFile(
			machine.project,
			name,
			`${PATHS.runtime}/replies/${nonce}.json`,
			65536,
			signal,
		);
		const value = JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(file.content)) as Record<
			string,
			unknown
		>;
		if (value?.schema === "qorpera.machine-guest-refusal/v1")
			throw new Error(
				typeof value.code === "string" && /^[A-Z][A-Z0-9_:]{2,120}$/.test(value.code)
					? value.code
					: "MACHINE_GUEST_REFUSED",
			);
		const receipt = parseCloudMachineCommandReceipt(value);
		// The company folder's report is the executor's to make, never the guest's (6e-2a).
		if (
			receipt.machineId !== machine.machineId ||
			receipt.commandId !== commandId ||
			receipt.inputSha256 !== authority.inputSha256 ||
			receipt.companyFolder !== undefined
		)
			throw new Error("COMPANY_MACHINE_COMMAND_INVALID");
		if (!folder) return receipt;
		// What the command printed, and how it ended, leave only once every read the machine was served is released
		// (F3 6d): a boundary first. A start, whose wait took most of the gateway's time, holds them for the next read,
		// and a command still running with nothing printed has nothing to let out. Nothing leaves a boot whose folder
		// ended (6d-2), whatever a boundary answers (a crashed service's successor releases reads it never served) and
		// whatever came of its folder: its guest may still run, its reboot not taken yet. A boot can end while its guest
		// answers or the boundary is out, so it is checked after each. Only a boot without /company (none) skips the
		// boundary. Then the run that gets the output takes in the reads of the machine's views (6d-3b, "Reads" rule 3),
		// on a boot without /company too: the disk keeps what any boot of it was served. Each receipt says why what it
		// holds back is held (6e-2a, #told).
		const ended = () => !!authority.bootId && this.#ended(authority.placementId, authority.bootId);
		const f = this.#folders.get(authority.placementId);
		const boot = f?.bootId === authority.bootId ? f : undefined;
		const none = boot?.state === "none";
		const at = (request.action === "read" && !request.read.tail && request.read.offset) || 0;
		const holding = (heldBack?: string) => this.#told(authority, boot, held(receipt, at), heldBack, false);
		const over = () => holding(HELD.ended);
		if (ended()) return over();
		if (boot?.unreadable) return holding(HELD.unreadable);
		if (request.action === "start" && !none) return holding(HELD.start);
		if (receipt.state === "running" && receipt.log.totalBytes === 0) return holding();
		if (!none) {
			const checked = AbortSignal.any([signal, AbortSignal.timeout(BOUNDARY_MS)]);
			const answer = await folder.boundary(authority.placementId, [], checked).catch(() => undefined);
			noted(boot, answer);
			if (ended()) return over();
			if (answer?.reads !== "released") return holding(unreleased(answer));
		}
		const refused = await this.#inherit(authority, boot, signal);
		if (ended()) return over();
		return refused === undefined ? this.#told(authority, boot, receipt, undefined, true) : holding(refused);
	}
	/** Why a boot whose folder ended has no /company (6e-2a). */
	#endedWhy(authority: CompanyMachineCommandAuthority): string {
		const ending =
			typeof authority.bootId === "string"
				? this.#endings.get(`${authority.placementId}/${authority.bootId}`)
				: undefined;
		return (ending && FOLDER_ENDED[ending.cause]) || FOLDER_ENDED.stale;
	}
	/** A receipt with the company folder's report (6e-2a): whether the command's boot has /company, and why not; why
	 * its output is held back (`heldBack`); why the machine lost the command (`lost`, SQL's cause); and, on a receipt
	 * whose output leaves (`released`), the paths the folder let go unsaved since the boot's last such receipt, once
	 * (`notSaved`), and those it did not save that the boot's views still keep pending (`stillNotSaved`, #noted). The
	 * report fits the agent's tool result as it measures it: paths that do not are counted instead. */
	#told(
		authority: CompanyMachineCommandAuthority,
		boot: BootFolder | undefined,
		receipt: CloudMachineCommandReceipt,
		heldBack: string | undefined,
		released: boolean,
	): CloudMachineCommandReceipt {
		const ended = typeof authority.bootId === "string" && this.#ended(authority.placementId, authority.bootId);
		let why: string | undefined;
		if (ended) why = this.#endedWhy(authority);
		else if (boot?.reason === "refused" && boot.refusal !== undefined)
			why =
				boot.refusal === VIEW_NOT_CURRENT
					? `${FOLDER_VIEWLESS.refused} because the machine is stopping, moving or starting again`
					: `${FOLDER_VIEWLESS.refused}: ${boot.refusal}`;
		else if (boot?.reason) why = FOLDER_VIEWLESS[boot.reason];
		// Why the machine lost the command, by the authority's `folderLost`: the words SQL tells its run.
		const lost =
			receipt.state === "lost" && isCloudMachineFolderLost(authority.folderLost)
				? CLOUD_MACHINE_FOLDER_LOST[authority.folderLost]
				: undefined;
		const report: CloudMachineCommandFolder = {
			company: why !== undefined ? "none" : boot?.held ? "mounted" : "pending",
			...(why !== undefined ? { why } : {}),
			...(heldBack !== undefined ? { heldBack } : {}),
			...(lost !== undefined ? { lost } : {}),
		};
		// What was let go unsaved since the last such receipt, once; and what the boot's views still keep pending.
		const notSaved = released && boot ? boot.notSaved.splice(0) : [];
		let more = 0;
		const still: CloudMachineFolderNotSaved[] = [];
		let moreStill = 0;
		if (released && boot) {
			more = boot.moreNotSaved;
			boot.moreNotSaved = 0;
			for (const view of boot.stillNotSaved.values()) {
				moreStill += view.more;
				for (const item of view.paths)
					if (still.length < CLOUD_MACHINE_FOLDER_LIMITS.notSaved) still.push(item);
					else moreStill++;
			}
		}
		const shown = () => ({
			...report,
			...(notSaved.length ? { notSaved } : {}),
			...(more ? { moreNotSaved: more } : {}),
			...(still.length ? { stillNotSaved: still } : {}),
			...(moreStill ? { moreStillNotSaved: moreStill } : {}),
		});
		// Over the bytes, what the next receipt says again goes first.
		while (still.length && cloudMachineFolderBytes(shown()) > CLOUD_MACHINE_FOLDER_LIMITS.bytes) {
			still.pop();
			moreStill++;
		}
		while (notSaved.length && cloudMachineFolderBytes(shown()) > CLOUD_MACHINE_FOLDER_LIMITS.bytes) {
			notSaved.pop();
			more++;
		}
		return Object.freeze({ ...receipt, companyFolder: parseCloudMachineCommandFolder(shown()) });
	}
	/** The run a command's output goes to takes in the reads of its machine's newest view first (6d-3b): SQL builds the
	 * run's actor, and answers a placement that never had a view with nothing to take in. Each take-in has its own id:
	 * SQL checks the view's whole read set for the run each time, and copies only what the run has not taken in from
	 * that view (20260930498000). Any failure holds the output, and says why (6e-2a): undefined means taken in. The
	 * core's refusal of a read it can no longer read ("qorpera.test-machine/unreadable") marks the boot, which holds
	 * every later output of it, and the next pass retires the placement (rule 5). */
	async #inherit(
		authority: CompanyMachineCommandAuthority,
		boot: BootFolder | undefined,
		signal: AbortSignal,
	): Promise<string | undefined> {
		const { placementId, bootId, runId } = authority;
		if (typeof bootId !== "string" || typeof runId !== "string" || !UUID.test(bootId) || !UUID.test(runId))
			return HELD.untaken;
		const inheritId = randomUUID();
		try {
			const taken = record(
				await this.#call(
					"qorpera_folder_test_machine_inherit_reads",
					{ p_placement_id: placementId, p_boot_id: bootId, p_run_id: runId, p_inherit_id: inheritId },
					signal,
				),
				"COMPANY_MACHINE_INHERIT_INVALID",
			);
			return taken.schema === "qorpera.folder-inherit/v1" && taken.inheritId === inheritId
				? undefined
				: HELD.untaken;
		} catch (error) {
			if (!(error instanceof CodingControlRefused)) return HELD.untaken;
			if (boot && error.detail === "qorpera.test-machine/unreadable") boot.unreadable = true;
			return HELD.refused;
		}
	}
	/** A start waits for its boot's folder to settle (opened and handed over, or known to be none), for at most 20 s
	 * (the gateway's request is bounded at 30 s): a boot still unsettled refuses the start, which so never runs
	 * unfenced, and so does a boot whose folder ended (its guest restarts, or its placement was retired, 6d-2). */
	async #settled(authority: CompanyMachineCommandAuthority, signal: AbortSignal): Promise<BootFolder> {
		const deadline = Date.now() + FOLDER_WAIT_MS;
		for (;;) {
			if (typeof authority.bootId === "string" && this.#ended(authority.placementId, authority.bootId))
				throw new Error("COMPANY_MACHINE_FOLDER_ENDED");
			const f = this.#folders.get(authority.placementId);
			if (typeof authority.bootId === "string" && f?.bootId === authority.bootId && f.state !== "pending") return f;
			if (typeof authority.bootId !== "string" || Date.now() >= deadline)
				throw new Error("COMPANY_MACHINE_FOLDER_UNANSWERED");
			await setTimeout(200, undefined, { signal });
		}
	}
}
