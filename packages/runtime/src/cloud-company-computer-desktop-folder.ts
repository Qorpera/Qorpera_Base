import { constants } from "node:fs";
import { type FileHandle, open, realpath } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import type { CompanyComputerScreenBinding } from "@qorpera/cloud-client/cloud-company-computer-contract";
import { isUuid } from "@qorpera/contracts";
import { isCompanyComputerFolderMount, parseCompanyComputerMountinfo } from "./cloud-company-computer-folder-helper.ts";
import {
	askCompanyComputerFolderHelper,
	COMPANY_COMPUTER_FOLDER_BOUNDARY_MS,
	COMPANY_COMPUTER_FOLDER_ROOT,
	type CompanyComputerFolderAnswer,
	type CompanyComputerFolderRequest,
	type CompanyComputerFolderView,
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
			)
				return { name: folder.name, epoch: folder.epoch };
			if (!(await this.#unmount(folder))) return UNAVAILABLE;
		}
		const view = await openCompanyComputerDesktopFolderView(
			this.#registry,
			{ environmentId: binding.environmentId, screenId: binding.screenId, holder },
			signal,
			until,
		);
		if (!("viewId" in view)) return view;
		// The newer view ended the screen's older ones (C1b-3 §3): a mount keeps running and moves to it.
		let mounted = folder.mounted;
		// At most: a mount answered `held`, its switch `closed`, and the mount made again.
		for (let attempt = 0; attempt < 3; attempt++) {
			if (mounted) {
				const answer = (await this.#helper({ op: "switch", name: folder.name, view }, MOUNT_WAIT_MS))?.answer;
				if (answer === "switched" || answer === "pending") {
					// A mount this record did not know of (`held` below) is new to every desktop.
					if (!folder.mounted) folder.epoch++;
					Object.assign(folder, { mounted: true, view, holder });
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
		const view = folder.view;
		Object.assign(folder, { mounted: false, view: undefined, holder: undefined });
		if (view) await closeCompanyComputerFolderView(this.#registry, view);
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
				const view = folder.view;
				Object.assign(folder, { view: undefined, holder: undefined });
				await closeCompanyComputerFolderView(this.#registry, view);
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
	 * answer, or refused in a way a retry gets past (QRC01, the run check), is asked again until `until`
	 * (performance.now()); then the drain fails, and the mount stays for the stop control. Every other answer is final,
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
					(answer.answer === "refused" && answer.report.refused === "run_ended")
				) {
					await pause(Math.min(BOUNDARY_RETRY_MS, until - performance.now()), signal);
					continue;
				}
				answered = true;
				this.#log(`office-folder: drain ${folder.name}: ${JSON.stringify(drainLogged(answer))}`);
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
		const view = folder.view;
		Object.assign(folder, { mounted: false, view: undefined, holder: undefined, refused: undefined });
		if (view) await closeCompanyComputerFolderView(this.#registry, view);
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
}

function sameHolder(a: CompanyComputerScreenHolder | undefined, b: CompanyComputerScreenHolder): boolean {
	if (a?.kind === "run") return b.kind === "run" && a.runId === b.runId;
	return a?.kind === "member" && b.kind === "member" && a.userId === b.userId;
}

/** A drain's answer as the office logs it ("The report"): the commit and how many paths had each outcome. No path
 * and no reason, which are the company's; the helper's words pass only when they are plain names. */
function drainLogged(answer: CompanyComputerFolderAnswer<"unmount">): Record<string, unknown> {
	const report = "report" in answer ? answer.report : undefined;
	const outcomes = new Map<string, number>();
	for (const { outcome } of report?.paths ?? []) outcomes.set(word(outcome), (outcomes.get(word(outcome)) ?? 0) + 1);
	return {
		answer: answer.answer,
		...("unmounted" in answer ? { unmounted: answer.unmounted } : {}),
		...(report
			? {
					refused: report.refused === undefined ? null : word(report.refused),
					commitId: report.commitId === null || /^[\w-]{1,64}$/.test(report.commitId) ? report.commitId : "other",
					seq: report.seq,
					outcomes: Object.fromEntries(outcomes),
				}
			: {}),
	};
}

function word(value: string): string {
	return /^[a-z_]{1,32}$/.test(value) ? value : "other";
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
