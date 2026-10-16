import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { type FileHandle, open, realpath } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import type { CompanyComputerScreenBinding } from "@qorpera/cloud-client/cloud-company-computer-contract";
import { isUuid } from "@qorpera/contracts";
import type { CompanyComputerCommandNotSaved } from "./cloud-company-computer-command-folder.ts";
import { isCompanyComputerFolderMount, parseCompanyComputerMountinfo } from "./cloud-company-computer-folder-helper.ts";
import {
	askCompanyComputerFolderHelper,
	COMPANY_COMPUTER_FOLDER_BOUNDARY_MS,
	COMPANY_COMPUTER_FOLDER_ROOT,
	type CompanyComputerFolderAnswer,
	type CompanyComputerFolderNotice,
	type CompanyComputerFolderRequest,
	type CompanyComputerFolderView,
	companyComputerFolderAnswerLogged,
	companyComputerFolderName,
	companyComputerFolderPaths,
	isCompanyComputerFolderView,
} from "./cloud-company-computer-folder-helper-client.ts";
import { readCompanyComputerLinuxMetadata } from "./cloud-company-computer-linux-host.ts";
import {
	companyComputerRegistryRefusal,
	type HttpCloudCompanyComputerRegistry,
} from "./cloud-company-computer-registry-http.ts";
import {
	COMPANY_COMPUTER_FOLDER_UNAVAILABLE_MESSAGE,
	type CompanyComputerFolderRefusal,
} from "./cloud-company-computer-tools.ts";

/** Who holds a screen, as the core anchors a desktop's view: a run, or a member who took it over. */
export type CompanyComputerScreenHolder =
	| { readonly kind: "run"; readonly runId: string }
	| { readonly kind: "member"; readonly userId: string };

/** Told what each desktop is to be told of its folder, by screen ("Notifications"): plain text, a sentence a line. */
export type CompanyComputerDesktopFolderListener = (screenId: string, text: string) => void;

/**
 * What the company folder did with a run's desktop changes since the report the run was last shown
 * (RUNTIME-FOLDER-COMPANY-MACHINES.md, "How 4f-2 carries the report"). An erased path is "".
 */
export interface CompanyComputerDesktopFolderReport {
	/** How many paths it saved. */
	readonly saved: number;
	/** The paths it did not take, and why. */
	readonly notSaved?: readonly CompanyComputerCommandNotSaved[];
	/** Why it did not take a desktop's last changes at all. */
	readonly refused?: string;
	/** The rest comes in a later report. */
	readonly more?: true;
}

/** A desktop's mount, as its desktop binds it (`CompanyComputerLinuxDesktopLauncher`). */
export interface CompanyComputerDesktopCompany {
	/** The helper's name for the mount: `desktop-<screen id>`. */
	readonly name: string;
	/** Counts the screen's mounts in this service. A mount made again is a new parent bind, which a desktop started
	 * on an older one never sees (Q3, #1007): only a restarted program reaches a running desktop. */
	readonly epoch: number;
}

const UNAVAILABLE: CompanyComputerFolderRefusal = Object.freeze({
	code: "COMPANY_FOLDER_UNAVAILABLE",
	message: COMPANY_COMPUTER_FOLDER_UNAVAILABLE_MESSAGE,
});
/** Between two opens the core did not answer. */
const OPEN_RETRY_MS = 1000;
/** How long the office waits for the helper: its own mount and switch take at most 20 s. */
const MOUNT_WAIT_MS = 40000;
const LIST_WAIT_MS = 10000;
const DROP_WAIT_MS = 60000;
/** A mount made for a run whose screen was given back goes after this, unless a desktop or a holder came. */
const RELEASE_LATER_MS = 60000;
/** Between two boundaries a retry gets past (no answer, QRC01, the run check). */
const BOUNDARY_RETRY_MS = 1000;
/** The least time a drain's boundary is still asked with: the helper takes at least a second. */
const DRAIN_LAST_ASK_MS = 2000;
/** A run's report ("How 4f-2 carries the report") reads the core at most once a second, a page of this many units a
 * view, and only while fewer than `REPORT_KEPT` of its items wait to be shown. */
const REPORT_READ_MS = 1000;
const REPORT_READ_UNITS = 64;
const REPORT_KEPT = 64;
/** What one report shows of the paths not saved, in bytes as a tool result's JSON writes them. */
const REPORT_NOT_SAVED = 20;
const REPORT_NOT_SAVED_BYTES = 2048;
/** How long the office waits for a `notices` ask: the helper takes at most 10 s. */
const NOTICES_WAIT_MS = 15000;
/** The folder service keeps a closed view a minute: its notices are asked at most this long after the view's commits
 * were read to their end. */
const NOTICES_AFTER_CLOSE_MS = 90000;
/** A desktop's views are read for its notifications ("Notifications") at least this often while nothing asks for a
 * report; the same quiet refusal is told again only after `NOTIFY_SAME_MS`. */
const NOTIFY_READ_MS = 5000;
const NOTIFY_SAME_MS = 60000;

/** Why a drain's boundary did not take the desktop's last changes, for the report of the run that held it. */
const REPORT_PAUSED = "the company is paused, so the company folder did not take this desktop's last changes";
const REPORT_UNREADABLE =
	"the company folder refused this desktop's last changes: they used a read that is no longer readable";
const REPORT_UNPROVEN =
	"the company folder refused this desktop's last changes: the desktop's reads could not be shown complete";
const REPORT_CLOSED = "the company folder had closed this desktop's view, so it did not take its last changes";
const REPORT_REFUSED = "the company folder refused this desktop's last changes";

/** Why a capture is held back (RUNTIME-FOLDER-COMPANY-MACHINES.md, "Before output reaches a model"). */
const CAPTURE_UNANSWERED = "the company folder did not answer before the screenshot's deadline; take it again";
const CAPTURE_PAUSED = "the company is paused, so the company folder holds the screenshot back";
const CAPTURE_RUN_ENDED = "this run can no longer act in the company folder";
const CAPTURE_REFUSED = "the company folder refused the screen's view";
/** Also the guest's answer for a desktop that stopped or started again since the action began. */
export const COMPANY_COMPUTER_CAPTURE_RESTARTED =
	"the company folder was restarted on this screen; take the screenshot again";

/** Open a desktop's view for whoever now holds its screen, as `openCompanyComputerFolderView` opens one. */
export function openCompanyComputerDesktopFolderView(
	registry: Pick<HttpCloudCompanyComputerRegistry, "call">,
	request: { environmentId: string; screenId: string; holder: CompanyComputerScreenHolder },
	signal: AbortSignal,
	until: number,
): Promise<CompanyComputerFolderView | CompanyComputerFolderRefusal> {
	const anchor: Readonly<Record<string, string>> =
		request.holder.kind === "run"
			? { screenId: request.screenId, holderRunId: request.holder.runId }
			: { screenId: request.screenId, holderUserId: request.holder.userId };
	return openCompanyComputerFolderView(
		registry,
		{ environmentId: request.environmentId, kind: "computer_desktop", anchor },
		signal,
		until,
	);
}

/**
 * Open a desktop's or a shell command's view (RUNTIME-FOLDER-COMPANY-MACHINES.md, "Views and machines"). A core that
 * does not answer is asked again until `until` (performance.now()); then the folder is unavailable. A refusal is
 * final, with the core's reason when it is one the registry passes on. The pass is never logged.
 */
export async function openCompanyComputerFolderView(
	registry: Pick<HttpCloudCompanyComputerRegistry, "call">,
	request: {
		environmentId: string;
		kind: "computer_desktop" | "computer_shell_command";
		anchor: Readonly<Record<string, string>>;
	},
	signal: AbortSignal,
	until: number,
): Promise<CompanyComputerFolderView | CompanyComputerFolderRefusal> {
	for (;;) {
		signal.throwIfAborted();
		const remaining = Math.floor(until - performance.now());
		if (remaining < 1) return UNAVAILABLE;
		let answer: unknown;
		try {
			answer = await registry.call(
				"qorpera_folder_view_open",
				{
					p_environment_id: request.environmentId,
					p_opener: { kind: "platform" },
					p_kind: request.kind,
					p_anchor: request.anchor,
				},
				AbortSignal.any([signal, AbortSignal.timeout(remaining)]),
			);
		} catch (error) {
			signal.throwIfAborted();
			const refusal = companyComputerRegistryRefusal(error);
			if (refusal)
				return {
					code: "COMPANY_FOLDER_REFUSED",
					message: refusal.reason ?? COMPANY_COMPUTER_FOLDER_UNAVAILABLE_MESSAGE,
				};
			await pause(Math.min(OPEN_RETRY_MS, until - performance.now()), signal);
			continue;
		}
		if (typeof answer !== "object" || answer === null || Array.isArray(answer)) return UNAVAILABLE;
		const { schema, viewId, pass } = answer as Record<string, unknown>;
		const view = { environmentId: request.environmentId, viewId, pass };
		if (schema !== "qorpera.folder-view/v1" || !isUuid(viewId) || !isCompanyComputerFolderView(view))
			return UNAVAILABLE;
		return view;
	}
}

/** Close a view the office no longer mounts. Best effort: an open view also ends with its lease, and a desktop's at
 * the screen's next open. */
export async function closeCompanyComputerFolderView(
	registry: Pick<HttpCloudCompanyComputerRegistry, "call">,
	view: CompanyComputerFolderView,
): Promise<void> {
	await registry
		.call("qorpera_folder_view_close", { p_view_id: view.viewId, p_pass: view.pass }, AbortSignal.timeout(10000))
		.catch(() => undefined);
}

/**
 * Whether an open directory is a mount's parent as the helper made it, seen from the office's own mount namespace:
 * the fd is on the parent's bind (its `mnt_id`), that bind takes the helper's mounts (a slave or peer of them, so a
 * restarted program's mount reaches it), and its only child is the stack at `company`, topped by the folder
 * program's mount. A desktop binds that whole tree (bwrap binds recursively), and finds `/company` in it. While the
 * program restarts nothing is at `company`: its next mount reaches the desktop the same way.
 */
export function checkCompanyComputerFolderParent(mountinfo: string, fdinfo: string, parent: string): boolean {
	const ids = [...fdinfo.matchAll(/^mnt_id:\s+([1-9][0-9]*)$/gm)];
	if (ids.length !== 1) return false;
	let entries: ReturnType<typeof parseCompanyComputerMountinfo>;
	try {
		entries = parseCompanyComputerMountinfo(mountinfo);
	} catch {
		return false;
	}
	const bind = entries.filter((entry) => entry.id === Number(ids[0][1]));
	if (
		bind.length !== 1 ||
		bind[0].mountpoint !== parent ||
		!bind[0].optional.some((field) => field.startsWith("master:") || field.startsWith("shared:"))
	)
		return false;
	const mountpoint = `${parent}/company`;
	if (entries.some((entry) => entry.parent === bind[0].id && entry.mountpoint !== mountpoint)) return false;
	// Mounts stacked at one mountpoint: each upper one's parent is the one below it.
	let top: (typeof entries)[number] | undefined;
	for (let below = bind[0].id; ; ) {
		const above = entries.filter((entry) => entry.parent === below && entry.mountpoint === mountpoint);
		if (above.length > 1) return false;
		if (!above.length) break;
		top = above[0];
		below = top.id;
	}
	return !top || isCompanyComputerFolderMount(top);
}

/**
 * Open a mount's parent for a desktop's bwrap (`--bind-fd`). The helper's folders are root's and no one else may
 * write them; the check is on the fd the desktop binds, not on the path.
 */
export async function openCompanyComputerFolderParent(
	name: string,
	root = COMPANY_COMPUTER_FOLDER_ROOT,
): Promise<FileHandle> {
	const { parent } = companyComputerFolderPaths(name, root);
	const directory = await open(parent, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
	try {
		const info = await directory.stat();
		if (
			!info.isDirectory() ||
			info.uid !== 0 ||
			(info.mode & 0o022) !== 0 ||
			(await realpath(`/proc/self/fd/${directory.fd}`)) !== parent ||
			!checkCompanyComputerFolderParent(
				await readCompanyComputerLinuxMetadata("/proc/self/mountinfo", 1_048_576),
				await readCompanyComputerLinuxMetadata(`/proc/self/fdinfo/${directory.fd}`, 4096),
				parent,
			)
		)
			throw new Error("COMPANY_COMPUTER_FOLDER_UNCONFIRMED");
		return directory;
	} catch (error) {
		await directory.close();
		throw error;
	}
}

interface Folder {
	readonly screenId: string;
	readonly name: string;
	/** The holder whose view the mount has, and that view. A view outlives its mount until it is closed. */
	holder?: CompanyComputerScreenHolder;
	view?: CompanyComputerFolderView;
	mounted: boolean;
	epoch: number;
	/** Rule 4's way out began on the mount: no desktop starts on it again. `stopped` once no desktop runs on it; then it
	 * goes without a boundary. */
	refused?: { stopped: boolean };
	/** This screen's helper requests, one at a time. */
	chain: Promise<unknown>;
	later?: ReturnType<typeof setTimeout>;
}

/** A change set the folder service refused whole at a boundary no machine asked for, and how often it came. */
interface QuietRefusal {
	readonly viewId: string;
	readonly reason: string;
	readonly paths: readonly string[];
	readonly pathCount: number;
	readonly times: number;
}

/** One thing a run's report says, numbered in the order it was kept. */
type ReportItem = { readonly n: number } & (
	| { readonly saved: number }
	| { readonly notSaved: CompanyComputerCommandNotSaved }
	| { readonly refused: string }
	| { readonly quiet: QuietRefusal }
);

/** A desktop view opened for a run, as its report reads it, or for a member, read for its desktop's notifications. */
interface ReportView {
	readonly view: CompanyComputerFolderView;
	/** The screen whose desktop is told of what is read. */
	readonly screenId: string;
	/** The last quiet refusal told, and when (performance.now()). */
	told?: { key: string; at: number };
	/** The core's commits: read after the last one read (`after`), until the view is closed and read to its end. */
	after?: string;
	more: boolean;
	done: boolean;
	/** The folder service's notices ("Refusals come from the folder service"): asked after the last one (`after`, in
	 * the series `nonce`), one ask at a time, until the service no longer holds the view once its commits are done, or
	 * `until` (performance.now()) passed. */
	readonly notices: {
		after: number;
		nonce: string | null;
		more: boolean;
		done: boolean;
		until: number;
		asking: Promise<void>;
	};
}

/** A run's report until the run is shown it, kept while one of the run's sessions lives. A member's view has one too,
 * never shown to anybody: its reads only tell the desktop. */
interface RunReport {
	/** Names the record in its marks: a mark of the run's earlier record drops nothing. */
	readonly id: string;
	/** False for a member's view: what its reads keep is dropped after each. */
	readonly reported: boolean;
	/** The desktop views opened for the run. */
	views: ReportView[];
	items: ReportItem[];
	next: number;
	/** The last item a report was given: the run may have been shown it, so nothing is counted on it or before it. */
	given: number;
	readonly signals: Set<AbortSignal>;
	reading?: Promise<void>;
	readAt: number;
	/** Ends the record's reads when its last session ends. */
	readonly stop: AbortController;
}

/**
 * Each desktop's mount of the company folder (F3 4d, "A desktop's mount"): made through the folder helper before the
 * desktop starts, moved to the newer view at each change of holder (`switch`), and unmounted when the desktop ends.
 * One record per screen for the service's life; every helper request of a screen runs after the one before.
 */
export class CompanyComputerDesktopFolders {
	readonly #registry: Pick<HttpCloudCompanyComputerRegistry, "call">;
	readonly #ask: typeof askCompanyComputerFolderHelper;
	readonly #socket?: string;
	readonly #log: (line: string) => void;
	readonly #folders = new Map<string, Folder>();
	readonly #runs = new Map<string, RunReport>();
	/** A member's views, by view id, read until each is read to its end. */
	readonly #members = new Map<string, RunReport>();
	readonly #listeners = new Set<CompanyComputerDesktopFolderListener>();

	constructor(options: {
		registry: Pick<HttpCloudCompanyComputerRegistry, "call">;
		/** The helper's socket; the image's by default. */
		socket?: string;
		/** Test seam for the helper. */
		ask?: typeof askCompanyComputerFolderHelper;
		/** Where a drain's answers are logged; stderr by default. */
		log?: (line: string) => void;
	}) {
		this.#registry = options.registry;
		this.#ask = options.ask ?? askCompanyComputerFolderHelper;
		this.#socket = options.socket;
		this.#log = options.log ?? ((line) => console.error(line));
	}

	/** Tell `listener` what each desktop is to be told of its folder ("Notifications"), until the answer is called. */
	listen(listener: CompanyComputerDesktopFolderListener): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	#tell(screenId: string, text: string | undefined): void {
		if (!text) return;
		for (const listener of this.#listeners)
			try {
				listener(screenId, text);
			} catch {
				// A listener's failure is its own.
			}
	}

	#helper<Request extends Exclude<CompanyComputerFolderRequest, { op: "run" }>>(
		request: Request,
		timeoutMs?: number,
		signal?: AbortSignal,
	) {
		return this.#ask(request, {
			...(this.#socket ? { socket: this.#socket } : {}),
			...(timeoutMs ? { timeoutMs } : {}),
			...(signal ? { signal } : {}),
		});
	}

	#folder(screenId: string): Folder {
		let folder = this.#folders.get(screenId);
		if (!folder) {
			folder = {
				screenId,
				name: companyComputerFolderName("desktop", screenId),
				mounted: false,
				epoch: 0,
				chain: Promise.resolve(),
			};
			this.#folders.set(screenId, folder);
		}
		return folder;
	}

	#queue<T>(folder: Folder, work: () => Promise<T>): Promise<T> {
		const result = folder.chain.then(work);
		folder.chain = result.catch(() => undefined);
		return result;
	}

	/**
	 * Give the screen's mount the holder's view, mounting it if none runs. Answers the mount to bind, or why the
	 * holder has no `/company`. The caller waits until `until` (performance.now()); the work goes on after that, so
	 * the screen's next request finds the mount as it ended.
	 */
	hold(
		binding: CompanyComputerScreenBinding,
		holder: CompanyComputerScreenHolder,
		signal: AbortSignal,
		until: number,
	): Promise<CompanyComputerDesktopCompany | CompanyComputerFolderRefusal> {
		const folder = this.#folder(binding.screenId);
		clearTimeout(folder.later);
		folder.later = undefined;
		const work = this.#queue(folder, () =>
			this.#hold(folder, binding, holder, signal, until).catch(() => {
				signal.throwIfAborted();
				return UNAVAILABLE;
			}),
		);
		return within(work, signal, until, UNAVAILABLE);
	}

	async #hold(
		folder: Folder,
		binding: CompanyComputerScreenBinding,
		holder: CompanyComputerScreenHolder,
		signal: AbortSignal,
		until: number,
	): Promise<CompanyComputerDesktopCompany | CompanyComputerFolderRefusal> {
		// Rule 4's way out that a capture began: once the mount's desktop has stopped, it goes, and the holder gets a new
		// one. Until then no holder gets it.
		if (folder.refused && !(folder.refused.stopped && (await this.#drop(folder, signal)))) return UNAVAILABLE;
		if (folder.mounted && folder.view && sameHolder(folder.holder, holder)) {
			// The holder's view already: unless its program has ended, the mount serves it as it is.
			const listed = await this.#helper({ op: "list" }, LIST_WAIT_MS);
			const mount =
				listed?.answer === "list" ? listed.mounts.find((entry) => entry.name === folder.name) : undefined;
			if (
				listed?.answer !== "list" ||
				(mount?.viewId === folder.view.viewId && (mount.program === "running" || mount.program === "restarting"))
			) {
				this.#opened(holder, folder.view, folder.screenId);
				return { name: folder.name, epoch: folder.epoch };
			}
			if (!(await this.#unmount(folder))) return UNAVAILABLE;
		}
		const view = await openCompanyComputerDesktopFolderView(
			this.#registry,
			{ environmentId: binding.environmentId, screenId: binding.screenId, holder },
			signal,
			until,
		);
		if (!("viewId" in view)) return view;
		// The newer view ended the screen's older ones (C1b-3 §3): a mount keeps running and moves to it. The older view's
		// notices are asked once more when the switch is answered.
		let older = folder.mounted ? { holder: folder.holder, view: folder.view } : undefined;
		let mounted = folder.mounted;
		// At most: a mount answered `held`, its switch `closed`, and the mount made again.
		for (let attempt = 0; attempt < 3; attempt++) {
			if (mounted) {
				const answer = (await this.#helper({ op: "switch", name: folder.name, view }, MOUNT_WAIT_MS))?.answer;
				if (older) this.#lastNotices(older.holder, older.view);
				older = undefined;
				if (answer === "switched" || answer === "pending") {
					// A mount this record did not know of (`held` below) is new to every desktop.
					if (!folder.mounted) folder.epoch++;
					Object.assign(folder, { mounted: true, view, holder });
					this.#opened(holder, view, folder.screenId);
					return { name: folder.name, epoch: folder.epoch };
				}
				if (answer === "closed" && !(await this.#unmount(folder))) break;
				if (answer !== "closed" && answer !== "unknown") break;
				Object.assign(folder, { mounted: false, view: undefined, holder: undefined });
				mounted = false;
				continue;
			}
			const answer = (await this.#helper({ op: "mount", name: folder.name, view }, MOUNT_WAIT_MS))?.answer;
			if (answer === "mounted") {
				folder.epoch++;
				Object.assign(folder, { mounted: true, view, holder });
				this.#opened(holder, view, folder.screenId);
				return { name: folder.name, epoch: folder.epoch };
			}
			if (answer !== "held") break;
			mounted = true;
		}
		await closeCompanyComputerFolderView(this.#registry, view);
		return UNAVAILABLE;
	}

	/** The mount goes after a boundary that ends it; its view is closed. False when the helper kept it (4d-2b). */
	async #unmount(folder: Folder): Promise<boolean> {
		const answer = await this.#helper({
			op: "unmount",
			name: folder.name,
			final: false,
			timeoutMs: COMPANY_COMPUTER_FOLDER_BOUNDARY_MS,
		});
		if (answer?.answer !== "unknown" && !(answer && "unmounted" in answer && answer.unmounted)) return false;
		const { view, holder } = folder;
		Object.assign(folder, { mounted: false, view: undefined, holder: undefined });
		if (view) await this.#close(holder, view);
		return true;
	}

	/** The mount goes without a boundary, and its view closes. False when the helper kept it. */
	async #drop(folder: Folder, signal?: AbortSignal): Promise<boolean> {
		const dropped = (await this.#helper({ op: "drop", name: folder.name }, DROP_WAIT_MS, signal))?.answer;
		if (dropped !== "dropped" && dropped !== "unknown") return false;
		await this.#gone(folder);
		return true;
	}

	/** The screen's mount as it is, for a desktop that starts with nobody new holding it. None while rule 4's way out
	 * is on it. */
	mounted(screenId: string): CompanyComputerDesktopCompany | undefined {
		const folder = this.#folders.get(screenId);
		return folder?.mounted && !folder.refused ? { name: folder.name, epoch: folder.epoch } : undefined;
	}

	/** The screen's desktop ended, or never started: its mount goes, and its view closes. `still` is asked when the
	 * request's turn comes. Never rejects. */
	release(screenId: string, still: () => boolean = () => true): Promise<void> {
		const folder = this.#folders.get(screenId);
		if (!folder) return Promise.resolve();
		clearTimeout(folder.later);
		folder.later = undefined;
		return this.#queue(folder, async () => {
			if (!still()) return;
			if (folder.refused) {
				// Rule 4's way out: no desktop runs on the mount now, and it has no boundary to give.
				folder.refused.stopped = true;
				if (folder.mounted) await this.#drop(folder);
			} else if (folder.mounted) await this.#unmount(folder);
			else if (folder.view) {
				const { view, holder } = folder;
				Object.assign(folder, { view: undefined, holder: undefined });
				await this.#close(holder, view);
			}
		}).catch(() => undefined);
	}

	/** Release after a minute, unless the screen is held again first. */
	releaseLater(screenId: string, still: () => boolean): void {
		const folder = this.#folders.get(screenId);
		if (!folder) return;
		clearTimeout(folder.later);
		folder.later = setTimeout(() => {
			folder.later = undefined;
			void this.release(screenId, still);
		}, RELEASE_LATER_MS);
		folder.later.unref?.();
	}

	/**
	 * A drain's boundary on the screen's mount, after its desktop stopped and before the drain's acknowledgement
	 * ("Drains and stops"): the mount's last changes are published, then it goes and its view closes. A boundary with no
	 * answer, refused in a way a retry gets past (QRC01, the run check), or refused with no reason while it keeps a path
	 * (the core did not answer the commit, or a path still waits) is asked again until `until` (performance.now()); then
	 * the drain fails, and the mount stays for the stop control. Every other answer is final,
	 * the pause's included: a mount still there after it goes without another boundary, and none of its refused changes
	 * carry into the next holder's view. The answer is logged with the drain. `still` is asked when the request's turn
	 * comes: a desktop started meanwhile keeps the mount.
	 */
	drain(screenId: string, signal: AbortSignal, until: number, still: () => boolean = () => true): Promise<void> {
		const folder = this.#folders.get(screenId);
		if (!folder) return Promise.resolve();
		clearTimeout(folder.later);
		folder.later = undefined;
		return this.#queue(folder, () => (still() ? this.#drain(folder, signal, until) : Promise.resolve()));
	}

	async #drain(folder: Folder, signal: AbortSignal, until: number): Promise<void> {
		// No desktop runs on the mount now: a mount rule 4's way out began on may go at the screen's next hold.
		if (folder.refused) folder.refused.stopped = true;
		const holder = folder.holder;
		let answered = false;
		while (folder.mounted) {
			signal.throwIfAborted();
			const remaining = Math.floor(until - performance.now());
			if (remaining < DRAIN_LAST_ASK_MS) {
				const late = answered ? "the mount did not go" : "no final answer";
				this.#log(`office-folder: drain ${folder.name}: ${late} by the drain's deadline`);
				throw new Error("OFFICE_FOLDER_DRAIN_UNANSWERED");
			}
			if (!answered) {
				const answer = await this.#helper(
					{
						op: "unmount",
						name: folder.name,
						final: false,
						timeoutMs: Math.min(COMPANY_COMPUTER_FOLDER_BOUNDARY_MS, remaining - 1000),
					},
					remaining,
					signal,
				);
				signal.throwIfAborted();
				if (
					!answer ||
					answer.answer === "invalid" ||
					answer.answer === "unanswered" ||
					(answer.answer === "refused" &&
						(answer.report.refused === "run_ended" ||
							(answer.report.refused === undefined && answer.report.paths.some((entry) => entry.kept))))
				) {
					await pause(Math.min(BOUNDARY_RETRY_MS, until - performance.now()), signal);
					continue;
				}
				answered = true;
				this.#log(
					`office-folder: drain ${folder.name}: ${JSON.stringify(companyComputerFolderAnswerLogged(answer))}`,
				);
				this.#drained(holder, answer, folder.screenId);
				if (answer.answer === "unknown" || answer.unmounted) {
					folder.mounted = false;
					break;
				}
			}
			// A final answer that left the mount: it goes without a boundary.
			const dropped = (
				await this.#helper({ op: "drop", name: folder.name }, Math.min(DROP_WAIT_MS, remaining), signal)
			)?.answer;
			signal.throwIfAborted();
			if (dropped === "dropped" || dropped === "unknown") folder.mounted = false;
			else await pause(Math.min(BOUNDARY_RETRY_MS, until - performance.now()), signal);
		}
		await this.#gone(folder);
	}

	/**
	 * The boundary before a screen capture reaches the holding run ("Before output reaches a model"): the desktop's
	 * reads are released, and its changes published, first. Answers why the capture is held back, or nothing when it
	 * may go on. A desktop started without `/company` (no `epoch`) needs none. Only a release refused because a read is
	 * no longer readable, a read log that cannot be shown complete, and a closed view take rule 4's way out: the mount's
	 * users stop first (`stop`: its desktop, with the apps that hold what it read, never the capture's own session),
	 * then the mount goes and its view closes, so the screen's next action starts its desktop on a new mount under a new
	 * view. A stop or a drop that fails holds the capture back, and no desktop starts on the mount again: the screen's
	 * next hold drops it once its desktop has stopped. Every other refusal, and no answer by `until` (performance.now()),
	 * holds the capture back and stops nothing.
	 */
	capture(
		screenId: string,
		epoch: number | undefined,
		signal: AbortSignal,
		until: number,
		stop: () => Promise<void>,
	): Promise<string | undefined> {
		if (epoch === undefined) return Promise.resolve(undefined);
		const folder = this.#folders.get(screenId);
		if (!folder) return Promise.resolve(COMPANY_COMPUTER_CAPTURE_RESTARTED);
		const work = this.#queue(folder, () =>
			this.#capture(folder, epoch, signal, until, stop).catch(() => {
				signal.throwIfAborted();
				return CAPTURE_UNANSWERED;
			}),
		);
		return within(work, signal, until, CAPTURE_UNANSWERED);
	}

	async #capture(
		folder: Folder,
		epoch: number,
		signal: AbortSignal,
		until: number,
		stop: () => Promise<void>,
	): Promise<string | undefined> {
		// The desktop runs on a mount that is gone, or that rule 4's way out is on: the next action starts it on the
		// screen's new one.
		if (!folder.mounted || folder.epoch !== epoch || folder.refused) return COMPANY_COMPUTER_CAPTURE_RESTARTED;
		const timeoutMs = Math.min(COMPANY_COMPUTER_FOLDER_BOUNDARY_MS, Math.floor(until - performance.now()) - 1000);
		if (timeoutMs < 1000) return CAPTURE_UNANSWERED;
		const answer = await this.#helper(
			{ op: "boundary", name: folder.name, final: false, timeoutMs },
			timeoutMs + 1000,
			signal,
		);
		signal.throwIfAborted();
		// Saved, or refused only for some paths (refused or conflicting saves): the reads were released.
		if (answer?.answer === "saved" || (answer?.answer === "refused" && answer.report.refused === undefined))
			return undefined;
		if (answer?.answer === "unknown") {
			await this.#gone(folder);
			return COMPANY_COMPUTER_CAPTURE_RESTARTED;
		}
		if (
			answer?.answer === "closed" ||
			(answer?.answer === "refused" &&
				(answer.report.refused === "unreadable" || answer.report.refused === "unproven"))
		) {
			// Rule 4's way out: the mount's users stop before it goes. A stop that fails drains the screen.
			const refused = { stopped: false };
			folder.refused = refused;
			try {
				await stop();
			} catch {
				return CAPTURE_REFUSED;
			}
			refused.stopped = true;
			// The way out ends even when the capture's action does not wait for it.
			return (await this.#drop(folder)) ? COMPANY_COMPUTER_CAPTURE_RESTARTED : CAPTURE_REFUSED;
		}
		if (answer?.answer !== "refused") return CAPTURE_UNANSWERED;
		if (answer.report.refused === "stopped") return CAPTURE_PAUSED;
		if (answer.report.refused === "run_ended") return CAPTURE_RUN_ENDED;
		return CAPTURE_REFUSED;
	}

	/** The mount is no longer the helper's: its view closes. */
	async #gone(folder: Folder): Promise<void> {
		const { view, holder } = folder;
		Object.assign(folder, { mounted: false, view: undefined, holder: undefined, refused: undefined });
		if (view) await this.#close(holder, view);
	}

	/** A view the screen no longer has closes. */
	async #close(holder: CompanyComputerScreenHolder | undefined, view: CompanyComputerFolderView): Promise<void> {
		this.#lastNotices(holder, view);
		await closeCompanyComputerFolderView(this.#registry, view);
	}

	/**
	 * At start, after the startup check admitted this activation: every mount the helper still holds belongs to an
	 * ended view, and goes without a boundary (`drop`; "The office's stop publishes the mounts left"). Answers whether
	 * all went.
	 */
	async dropLeftovers(signal: AbortSignal): Promise<boolean> {
		const listed = await this.#helper({ op: "list" }, LIST_WAIT_MS, signal);
		if (listed?.answer !== "list") return false;
		let all = true;
		for (const mount of listed.mounts) {
			const answer = (await this.#helper({ op: "drop", name: mount.name }, DROP_WAIT_MS, signal))?.answer;
			if (answer !== "dropped" && answer !== "unknown") all = false;
		}
		return all;
	}

	/**
	 * Keep the run's report ("How 4f-2 carries the report") while `signal`, one of the run's sessions, lives: the commits
	 * of the views opened for the run, the change sets the folder service refused whole at their quiet boundaries, and
	 * its drains' refusals. The report goes when the last of its sessions ends.
	 */
	follow(runId: string, signal: AbortSignal): void {
		if (signal.aborted) return;
		let record = this.#runs.get(runId);
		if (!record) {
			record = this.#record(true);
			this.#runs.set(runId, record);
		}
		if (record.signals.has(signal)) return;
		const current = record;
		current.signals.add(signal);
		signal.addEventListener(
			"abort",
			() => {
				current.signals.delete(signal);
				if (current.signals.size > 0) return;
				current.stop.abort();
				if (this.#runs.get(runId) === current) this.#runs.delete(runId);
			},
			{ once: true },
		);
	}

	/**
	 * The run's report since the one it was last shown, or nothing when nothing is new. `shown` is that report's mark,
	 * or "": only what it names is dropped, so a report whose tool result was never built comes again. The views'
	 * commits since the last read are read from the core first, and their notices from the folder service (through the
	 * helper), at most once a second; the caller waits for that read
	 * until `until` (performance.now()), and it goes on after that for the next ask. A report shows at most
	 * `REPORT_NOT_SAVED` paths not saved, in `REPORT_NOT_SAVED_BYTES` (one at least), and one refusal; `more` says the
	 * rest follows.
	 */
	async report(
		runId: string,
		shown: string,
		signal: AbortSignal,
		until: number,
	): Promise<{ mark: string; report: CompanyComputerDesktopFolderReport } | undefined> {
		const record = this.#runs.get(runId);
		if (!record) return undefined;
		const mark = /^([0-9a-f-]{36}):([0-9]{1,15})$/.exec(shown);
		if (mark?.[1] === record.id) {
			const last = Number(mark[2]);
			record.items = record.items.filter((item) => item.n > last);
		}
		const reading = this.#readNow(record);
		if (reading) await within(reading, signal, until, undefined);
		return reportOf(record);
	}

	/** A record whose views are read at least every `NOTIFY_READ_MS` until it stops, for their desktops' notifications. */
	#record(reported: boolean): RunReport {
		const record: RunReport = {
			id: randomUUID(),
			reported,
			views: [],
			items: [],
			next: 0,
			given: 0,
			signals: new Set(),
			readAt: Number.NEGATIVE_INFINITY,
			stop: new AbortController(),
		};
		const pump = setInterval(() => void this.#readNow(record), NOTIFY_READ_MS);
		pump.unref?.();
		record.stop.signal.addEventListener("abort", () => clearInterval(pump), { once: true });
		return record;
	}

	/** The record's read now, unless one runs, none is due (at most once a second), its views are read to their end, or
	 * a report holds `REPORT_KEPT` items not shown. */
	#readNow(record: RunReport): Promise<void> | undefined {
		if (
			!record.reading &&
			!record.stop.signal.aborted &&
			record.views.some((entry) => !entry.done || !entry.notices.done) &&
			record.items.length < REPORT_KEPT &&
			performance.now() - record.readAt >= REPORT_READ_MS
		)
			record.reading = this.#read(record)
				.catch(() => undefined)
				.finally(() => {
					record.reading = undefined;
					record.readAt = performance.now();
					if (record.reported) return;
					// A member's view: nobody is shown the items, and one read to its end stops.
					record.items = [];
					if (record.views.every((entry) => entry.done && entry.notices.done)) record.stop.abort();
				});
		return record.reading;
	}

	/** A page of each view's commits since the last one read, and of its notices, into the run's report. */
	async #read(record: RunReport): Promise<void> {
		for (const entry of record.views) {
			if (record.stop.signal.aborted) return;
			if (!entry.done) await this.#commits(record, entry);
			if (!entry.notices.done) await this.#notices(record, entry);
		}
	}

	/** A refusal, or an answer that is not a page, ends a view's reads; a call with no answer is made again at the next
	 * read. */
	async #commits(record: RunReport, entry: ReportView): Promise<void> {
		const ended = (): void => {
			Object.assign(entry, { more: false, done: true });
			entry.notices.until = performance.now() + NOTICES_AFTER_CLOSE_MS;
		};
		let answer: unknown;
		try {
			answer = await this.#registry.call(
				"qorpera_folder_view_commits",
				{
					p_view_id: entry.view.viewId,
					p_pass: entry.view.pass,
					p_after_commit_id: entry.after ?? null,
					p_limit: REPORT_READ_UNITS,
				},
				AbortSignal.any([record.stop.signal, AbortSignal.timeout(LIST_WAIT_MS)]),
			);
		} catch (error) {
			if (companyComputerRegistryRefusal(error)) ended();
			return;
		}
		const page = viewCommits(answer, entry.view.viewId);
		if (!page) return ended();
		for (const commit of page.commits) {
			const saved = commit.units.filter((unit) => unit.outcome === "saved").length;
			if (saved > 0) record.items.push({ n: ++record.next, saved });
			for (const unit of commit.units)
				if (unit.outcome !== "saved") record.items.push({ n: ++record.next, notSaved: reportNotSaved(unit) });
			entry.after = commit.commitId;
		}
		this.#tell(
			entry.screenId,
			folderNotice(page.commits.flatMap((commit) => commit.units.map((unit) => unit.outcome))),
		);
		entry.more = page.more;
		if (page.closed && !page.more) ended();
	}

	/**
	 * One ask of a view's notices after the last one, into the run's report: each change set the folder service refused
	 * whole at a boundary no machine asked for (a commit's paths come with the view's commits). No answer is asked again
	 * at the next read. Asks of a view go one at a time.
	 */
	#notices(record: RunReport, entry: ReportView): Promise<void> {
		const notices = entry.notices;
		notices.asking = notices.asking
			.then(async () => {
				if (notices.done || record.stop.signal.aborted) return;
				const answer = await this.#helper(
					{ op: "notices", view: entry.view, after: notices.after, nonce: notices.nonce },
					NOTICES_WAIT_MS,
					record.stop.signal,
				);
				const page = answer?.answer === "notices" ? answer : undefined;
				if (page?.nonce) {
					for (const notice of page.notices)
						if ("refused" in notice) {
							this.#quiet(record, entry.view.viewId, notice);
							this.#toldQuiet(entry, notice);
						}
					Object.assign(notices, { after: page.last, nonce: page.nonce, more: page.more });
				} else notices.more = false;
				// The service let the view go once it closed, or has kept it past the minute.
				if (entry.done && ((page && page.nonce === null) || (!notices.more && performance.now() >= notices.until)))
					notices.done = true;
			})
			.catch(() => undefined);
		return notices.asking;
	}

	/** A change set refused whole, once with its paths; the same refusal again (the same reason and paths) before a report
	 * gave the run the first is counted on it, in its place, not kept twice. */
	#quiet(record: RunReport, viewId: string, notice: Extract<CompanyComputerFolderNotice, { refused: string }>): void {
		const quiet = { viewId, reason: notice.refused, paths: notice.paths, pathCount: notice.pathCount };
		const index = record.items.findIndex(
			(item) =>
				item.n > record.given &&
				"quiet" in item &&
				item.quiet.viewId === viewId &&
				item.quiet.reason === quiet.reason &&
				item.quiet.pathCount === quiet.pathCount &&
				item.quiet.paths.length === quiet.paths.length &&
				item.quiet.paths.every((path, at) => path === quiet.paths[at]),
		);
		const earlier = record.items[index];
		if (earlier && "quiet" in earlier) {
			record.items[index] = { n: earlier.n, quiet: { ...quiet, times: earlier.quiet.times + 1 } };
			return;
		}
		record.items.push({ n: ++record.next, quiet: { ...quiet, times: 1 } });
		for (const path of quiet.paths)
			record.items.push({
				n: ++record.next,
				notSaved: reportNotSaved({ path, outcome: "refused" }),
			});
	}

	/** The desktop is told of a quiet refusal once: the same one again (the same reason and paths) only after
	 * `NOTIFY_SAME_MS`. */
	#toldQuiet(entry: ReportView, notice: Extract<CompanyComputerFolderNotice, { refused: string }>): void {
		const key = JSON.stringify([notice.refused, notice.pathCount, notice.paths]);
		const now = performance.now();
		if (entry.told?.key === key && now - entry.told.at < NOTIFY_SAME_MS) return;
		entry.told = { key, at: now };
		const { viewId } = entry.view;
		this.#tell(
			entry.screenId,
			sentence(
				quietRefusal({
					viewId,
					reason: notice.refused,
					paths: notice.paths,
					pathCount: notice.pathCount,
					times: 1,
				}),
			),
		);
	}

	/** The holder no longer has the view (the mount moved to a newer one, or went): its notices are asked once more,
	 * while the folder service still keeps them, so the run's report has them whenever it is asked for. (A member's
	 * view is read on by its own record.) */
	#lastNotices(holder: CompanyComputerScreenHolder | undefined, view: CompanyComputerFolderView | undefined): void {
		const record = holder?.kind === "run" ? this.#runs.get(holder.runId) : undefined;
		const entry = record?.views.find((entry) => entry.view.viewId === view?.viewId);
		if (record && entry) void this.#notices(record, entry);
	}

	/** A view the run now holds: its commits go into the run's report. A view it held before keeps its place, read or
	 * done, so no commit is reported twice. A member's view gets a record of its own, read until it is read to its end,
	 * so the desktop is told of it too. */
	#opened(holder: CompanyComputerScreenHolder, view: CompanyComputerFolderView, screenId: string): void {
		let record = holder.kind === "run" ? this.#runs.get(holder.runId) : this.#members.get(view.viewId);
		if (!record && holder.kind === "member") {
			const member = this.#record(false);
			member.stop.signal.addEventListener(
				"abort",
				() => {
					if (this.#members.get(view.viewId) === member) this.#members.delete(view.viewId);
				},
				{ once: true },
			);
			this.#members.set(view.viewId, member);
			record = member;
		}
		if (record && !record.views.some((entry) => entry.view.viewId === view.viewId))
			record.views.push({
				view,
				screenId,
				more: false,
				done: false,
				notices: {
					after: 0,
					nonce: null,
					more: false,
					done: false,
					until: Number.POSITIVE_INFINITY,
					asking: Promise.resolve(),
				},
			});
	}

	/** A drain's final answer, for the desktop and the report of the run that held it: why its last changes were not
	 * taken, and the paths of a change set that made no commit (a commit's paths come with its units). */
	#drained(
		holder: CompanyComputerScreenHolder | undefined,
		answer: CompanyComputerFolderAnswer<"unmount">,
		screenId: string,
	): void {
		if (answer.answer === "closed") this.#tell(screenId, sentence(REPORT_CLOSED));
		else if (answer.answer === "refused" && answer.report.refused !== undefined)
			this.#tell(screenId, sentence(reportRefusal(answer.report.refused)));
		else if (answer.answer === "refused" && answer.report.commitId === null)
			this.#tell(screenId, folderNotice(answer.report.paths.map((entry) => entry.outcome)));
		const record = holder?.kind === "run" ? this.#runs.get(holder.runId) : undefined;
		if (!record) return;
		if (answer.answer === "closed") record.items.push({ n: ++record.next, refused: REPORT_CLOSED });
		if (answer.answer !== "refused") return;
		const { report } = answer;
		if (report.refused !== undefined) record.items.push({ n: ++record.next, refused: reportRefusal(report.refused) });
		if (report.commitId === null)
			for (const entry of report.paths)
				if (entry.outcome !== "saved") record.items.push({ n: ++record.next, notSaved: reportNotSaved(entry) });
	}
}

/** The report from a run's items not yet shown, with the mark of the last item it holds (from then on given). */
function reportOf(record: RunReport): { mark: string; report: CompanyComputerDesktopFolderReport } | undefined {
	let saved = 0;
	const shown: CompanyComputerCommandNotSaved[] = [];
	let bytes = 0;
	let refused: string | undefined;
	let last: number | undefined;
	let index = 0;
	for (; index < record.items.length; index++) {
		const item = record.items[index];
		if ("refused" in item || "quiet" in item) {
			if (refused !== undefined) break;
			refused = "refused" in item ? item.refused : quietRefusal(item.quiet);
		} else if ("notSaved" in item) {
			const size = resultBytes(JSON.stringify(item.notSaved)) + 1;
			if (shown.length === REPORT_NOT_SAVED || (shown.length > 0 && bytes + size > REPORT_NOT_SAVED_BYTES)) break;
			shown.push(item.notSaved);
			bytes += size;
		} else saved += item.saved;
		last = item.n;
	}
	if (last === undefined) return undefined;
	record.given = Math.max(record.given, last);
	const more = index < record.items.length || record.views.some((entry) => entry.more || entry.notices.more);
	return {
		mark: `${record.id}:${last}`,
		report: {
			saved,
			...(shown.length > 0 ? { notSaved: shown } : {}),
			...(refused !== undefined ? { refused } : {}),
			...(more ? { more: true as const } : {}),
		},
	};
}

/** A page of a view's commits, with each unit's path and outcome, or nothing for an answer that is not one. */
function viewCommits(
	answer: unknown,
	viewId: string,
):
	| {
			commits: { commitId: string; units: { path: string; outcome: string; reason?: string }[] }[];
			closed: boolean;
			more: boolean;
	  }
	| undefined {
	if (typeof answer !== "object" || answer === null || Array.isArray(answer)) return undefined;
	const page = answer as Record<string, unknown>;
	if (
		page.schema !== "qorpera.folder-view-commits/v1" ||
		page.viewId !== viewId ||
		(page.state !== "open" && page.state !== "closed") ||
		typeof page.more !== "boolean" ||
		!Array.isArray(page.commits)
	)
		return undefined;
	const commits: { commitId: string; units: { path: string; outcome: string; reason?: string }[] }[] = [];
	for (const commit of page.commits as unknown[]) {
		if (typeof commit !== "object" || commit === null) return undefined;
		const { commitId, units } = commit as Record<string, unknown>;
		if (!isUuid(commitId) || !Array.isArray(units)) return undefined;
		const read: { path: string; outcome: string; reason?: string }[] = [];
		for (const unit of units as unknown[]) {
			if (typeof unit !== "object" || unit === null) return undefined;
			const { path = "", outcome, reason } = unit as Record<string, unknown>;
			if (
				typeof path !== "string" ||
				typeof outcome !== "string" ||
				(reason !== undefined && typeof reason !== "string")
			)
				return undefined;
			read.push({ path, outcome, ...(reason ? { reason } : {}) });
		}
		commits.push({ commitId, units: read });
	}
	return { commits, closed: page.state === "closed", more: page.more };
}

/** A path the company folder did not take, as a report shows it (a command's tool result shows its own so). */
function reportNotSaved(entry: {
	readonly path: string;
	readonly outcome: string;
	readonly reason?: string;
}): CompanyComputerCommandNotSaved {
	return {
		path: head(entry.path, 300),
		outcome: head(entry.outcome, 64),
		...(entry.reason ? { reason: head(entry.reason, 200) } : {}),
	};
}

/** Why a drain's boundary refused the desktop's last changes whole, in the report's words. */
function reportRefusal(reason: string): string {
	if (reason === "stopped") return REPORT_PAUSED;
	if (reason === "unreadable") return REPORT_UNREADABLE;
	if (reason === "unproven") return REPORT_UNPROVEN;
	return REPORT_REFUSED;
}

/** Why the company folder did not take a change set of the desktop's at a quiet boundary, in the report's words. */
function quietRefusal({ reason, pathCount, times }: QuietRefusal): string {
	const changes =
		pathCount === 0
			? "changes on this desktop"
			: pathCount === 1
				? "a change on this desktop"
				: `${pathCount} changes on this desktop`;
	const text =
		reason === "stopped"
			? `the company is paused, so the company folder did not take ${changes}`
			: reason === "unreadable"
				? `the company folder refused ${changes}: they used a read that is no longer readable`
				: reason === "unproven"
					? `the company folder refused ${changes}: the desktop's reads could not be shown complete`
					: `the company folder refused ${changes}`;
	return times > 1 ? `${text} (${times} times)` : text;
}

/** What a desktop is told of its changes the company folder settled ("Notifications"), a line an outcome, or nothing. */
function folderNotice(outcomes: readonly string[]): string | undefined {
	const saved = outcomes.filter((outcome) => outcome === "saved").length;
	const waiting = outcomes.filter((outcome) => outcome === "waiting_for_review").length;
	const conflict = outcomes.filter((outcome) => outcome === "conflict").length;
	const other = outcomes.length - saved - waiting - conflict;
	const lines = [
		...(saved > 0 ? [`${changes(saved)} saved to the company folder.`] : []),
		...(waiting > 0 ? [`${changes(waiting)} waiting for a member's approval.`] : []),
		...(conflict > 0 ? [`${changes(conflict)} not saved: the company folder had a newer version.`] : []),
		...(other > 0 ? [`${changes(other)} not saved.`] : []),
	];
	return lines.length > 0 ? lines.join("\n") : undefined;
}

function changes(count: number): string {
	return count === 1 ? "1 change" : `${count} changes`;
}

/** A report's words as a desktop's notice: a sentence. */
function sentence(text: string): string {
	return `${text.charAt(0).toUpperCase()}${text.slice(1)}.`;
}

/** A text's bytes in a tool result, whose JSON writes `<`, `>`, `&`, U+2028 and U+2029 as escapes (counted at six
 * bytes, at most what they take). */
function resultBytes(text: string): number {
	return Buffer.byteLength(text) + 5 * (text.match(/[<>&\u2028\u2029]/g)?.length ?? 0);
}

/** At most `length` characters, never half of one. */
function head(text: string, length: number): string {
	const characters = Array.from(text);
	return characters.length > length ? `${characters.slice(0, length).join("")}…` : text;
}

function sameHolder(a: CompanyComputerScreenHolder | undefined, b: CompanyComputerScreenHolder): boolean {
	if (a?.kind === "run") return b.kind === "run" && a.runId === b.runId;
	return a?.kind === "member" && b.kind === "member" && a.userId === b.userId;
}

/** The work's answer, or `late` once `until` (performance.now()) passes; the work goes on either way. */
function within<T>(work: Promise<T>, signal: AbortSignal, until: number, late: T): Promise<T> {
	return new Promise((resolve, reject) => {
		const done = (): void => {
			clearTimeout(timer);
			signal.removeEventListener("abort", abort);
		};
		const abort = (): void => {
			done();
			reject(signal.reason);
		};
		const timer = setTimeout(
			() => {
				done();
				resolve(late);
			},
			Math.max(0, until - performance.now()),
		);
		if (signal.aborted) return abort();
		signal.addEventListener("abort", abort, { once: true });
		work.then(
			(value) => {
				done();
				resolve(value);
			},
			(error: unknown) => {
				done();
				reject(error);
			},
		);
	});
}

function pause(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (ms <= 0) return resolve();
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", abort);
			resolve();
		}, ms);
		const abort = (): void => {
			clearTimeout(timer);
			reject(signal.reason);
		};
		signal.addEventListener("abort", abort, { once: true });
	});
}

export { within as companyComputerFolderWithin };
