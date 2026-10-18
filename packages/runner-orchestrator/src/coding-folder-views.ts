import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, unlink } from "node:fs/promises";
import { posix } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { CODING_GUEST, type CodingGuestRequests, isUuid, normalizeUuid, parseClosedRecord } from "@qorpera/contracts";
import { CodingControlRefused } from "./coding-executor.ts";
import {
	type CodingFolderBoundary,
	type CodingFolderReads,
	codingFolderBoundaryChecking,
	codingFolderBoundaryUnreadable,
	codingFolderViewSaved,
} from "./coding-folder-control.ts";
import { CodingGuestRefused, LxdCodingGuestClient } from "./coding-guest-client.ts";
import { type LxdCodingMachineBinding, lxdCodingMachineName, lxdCodingMachinePlan } from "./coding-machine.ts";
import type { LxdInstanceExecStreamClient, LxdInstanceProgramClient } from "./lxd-client.ts";
import { checkDirectory, code, publish, readRecord, syncDirectory } from "./lxd-office-journal-files.ts";

// A coding session's view of its company's folder (F3 step 5g-4; RUNTIME-FOLDER-CODING-MACHINES.md, "Views"). Once
// the session is attached, the executor opens its view in the core with the attachment's token, and the guest agent
// shows it at the session's /company with the folder program; the view's pass goes only over the agent's stdin. When
// the session ends, the executor asks the folder service for the view's final boundary, which saves what the view has
// pending, and then closes it. The folder service renews a view while its program is connected; the executor never
// does. Each view the executor holds is recorded on the node's coding storage, its pass and the attachment and boot it
// was opened under included, from before it is shown until it has ended: an executor that restarted still ends it,
// with its boundary and its close, or attaches the session under the same attachment again.

/** The core's refusals of an open, by its own words (deploy/coding-worker/control.ts keeps exactly these). */
const OPEN_REFUSALS: ReadonlyMap<string, string> = new Map([
	["Folder view attachment is not current", "ATTACHMENT_NOT_CURRENT"],
	["Company folder is unavailable", "FOLDER_UNAVAILABLE"],
	["Folder view principals are unavailable", "PRINCIPALS_UNAVAILABLE"],
	["Folder core authority is required", "AUTHORITY_REQUIRED"],
	["Folder view is invalid", "VIEW_INVALID"],
	["Folder view opener is invalid", "VIEW_INVALID"],
	["Folder view anchor is invalid", "VIEW_INVALID"],
	["Coding machine must restart first", "MACHINE_RESTART_REQUIRED"],
]);
/** The guest's refusals that pass: another call holds the session's or the machine's lock. */
const GUEST_BUSY = new Set(["CODING_GUEST_SESSION_BUSY", "CODING_GUEST_MACHINE_BUSY"]);
const FINAL_GUEST_ERRORS = new Set(["CODING_GUEST_REQUEST_INVALID", "CODING_GUEST_ANSWER_INVALID"]);
/** A view's pass: 32 random bytes, base64url (qorpera_folder_view_new_pass). */
const PASS = /^[A-Za-z0-9_-]{43}$/;
const SHA256_LINE = /^([0-9a-f]{64}) {2}(\/[^\n]+)$/;
const RETRY_MS = 1000;
/** A close is worth a few tries: a view nobody closes lapses with its lease anyway. */
const CLOSE_MS = 10_000;
/** sha256sum, install, mv and rm in the machine. */
const EXEC_MS = 30_000;
/** One use of the view records on the storage, which a hard NFS mount can hang. */
const RECORD_MS = 5000;
const RECORD_SCHEMA = "qorpera.coding-folder-view-held/v1";
const RECORD_FAILED = "CODING_FOLDER_VIEW_RECORD_FAILED";
/** The longest a Node timer waits; past it, it fires at once. */
const TIMER_MAX_MS = 2 ** 31 - 1;

/** The session whose view this is, as the executor attached it. */
export interface CodingFolderViewSession {
	readonly workerId: string;
	readonly environmentId: string;
	/** The attachment's token (qorpera_attach_coding_session). A new attachment needs a new view. */
	readonly attachmentToken: string;
	readonly machine: LxdCodingMachineBinding;
	/** The machine's boot the attachment was made on (its boot_id): the view's record names it, so an executor that
	 * restarted knows whether the attachment it held is still the machine's. */
	readonly bootId: string;
	/** The session's own user in the machine; its group has the same id. */
	readonly uid: number;
}

/** The attachment a session's view was opened under, by its record. */
export interface CodingFolderViewHeld {
	readonly machineId: string;
	readonly bootId: string;
	readonly attachmentToken: string;
}

/** How a view ended: whether its final boundary released the machine's reads and saved all the view had (a report with
 * every changed path saved and nothing refused: the close loses what was not), and whether the core confirmed its
 * close. */
export interface CodingFolderViewEnd {
	readonly workerId: string;
	readonly viewId: string;
	readonly saved: boolean;
	readonly closed: boolean;
}

/** The core refused the session's view (its code is one of OPEN_REFUSALS'): the attach fails with it, and the same
 * attach would fail the same way. */
export class CodingFolderViewRefused extends Error {
	readonly code: string;
	constructor(code: string) {
		super(`CODING_FOLDER_VIEW_REFUSED:${code}`);
		this.code = code;
	}
}

/** The machine must restart before a view opens on it (RUNTIME-FOLDER-CODING-MACHINES.md, rule 4): the node closed the
 * view the session holds, or the one just opened, under its mount (VIEW_CLOSED), the boundary before a new view
 * answered the machine's reads unproven (READS_UNPROVEN), or the core marked the machine (MACHINE_RESTART_REQUIRED, the
 * open's refusal). The executor stops and starts it, the folder service hearing `restarted` between, and attaches the
 * session again. READS_UNREADABLE: that boundary said the machine holds a read no longer readable, so it gets a new disk
 * on the way (rule 4, `unreadable`). */
export class CodingFolderRestartRequired extends CodingFolderViewRefused {}

export interface CodingFolderViewsOptions {
	readonly control: { call(method: string, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown> };
	readonly folder: {
		boundary(machine: string, final: readonly string[], signal: AbortSignal): Promise<CodingFolderBoundary>;
	};
	readonly client: LxdInstanceExecStreamClient & LxdInstanceProgramClient;
	/** The guest agent (scripts/package-coding-guest-agent.mjs) and the folder program (MC3a's build or later: the agent
	 * gives it --local-dir and --cache-dir), as the executor checked them against its pins. */
	readonly agent: Buffer;
	readonly program: Buffer;
	/** Where the views it holds are recorded: a folder of this process's user (made with mode 0700 in its parent, which
	 * must exist) on the node's coding storage, and a check that the storage is mounted, run around each use. */
	readonly records: { readonly root: string; readonly assert?: (signal: AbortSignal) => Promise<void> };
	/** Between tries of an open, a mount or a close, and how long a close is tried; tests shorten them. */
	readonly retryMs?: number;
	readonly closeMs?: number;
}

interface HeldView extends CodingFolderViewHeld {
	readonly workerId: string;
	readonly viewId: string;
	readonly pass: string;
}

interface Program {
	readonly path: string;
	readonly mode: number;
	readonly bytes: Buffer;
	readonly sha256: string;
}

/** Opens, shows and ends coding sessions' views. The executor calls it for one session at a time, and for a machine's
 * end only while none of its sessions attaches. */
export class CodingFolderViews {
	readonly #control: CodingFolderViewsOptions["control"];
	readonly #folder: CodingFolderViewsOptions["folder"];
	readonly #client: CodingFolderViewsOptions["client"];
	readonly #programs: readonly Program[];
	readonly #retryMs: number;
	readonly #closeMs: number;
	readonly #root: string;
	readonly #assert: (signal: AbortSignal) => Promise<void>;
	/** The last use of the records, settled: the next waits for it, even once its caller gave up. */
	#recordWork: Promise<unknown> = Promise.resolve();
	constructor(options: CodingFolderViewsOptions) {
		const program = (path: string, mode: number, bytes: Buffer): Program => {
			if (!Buffer.isBuffer(bytes) || bytes.byteLength < 1) throw new Error("Invalid coding folder program");
			return { path, mode, bytes, sha256: createHash("sha256").update(bytes).digest("hex") };
		};
		this.#programs = [
			program(CODING_GUEST.agent, 0o444, options.agent),
			program(CODING_GUEST.folderProgram, 0o555, options.program),
		];
		const root = options.records?.root;
		if (typeof root !== "string" || !posix.isAbsolute(root) || posix.normalize(root) !== root || root.endsWith("/"))
			throw new Error("Invalid coding folder view records");
		this.#root = root;
		this.#assert = options.records.assert ?? (async () => undefined);
		this.#control = options.control;
		this.#folder = options.folder;
		this.#client = options.client;
		this.#retryMs = options.retryMs ?? RETRY_MS;
		this.#closeMs = options.closeMs ?? CLOSE_MS;
	}

	/** Makes sure the machine has this executor's guest agent and folder program, writing whichever differs beside its
	 * place and renaming it over, so a program running from the old file keeps it. */
	async install(machine: LxdCodingMachineBinding, signal: AbortSignal): Promise<void> {
		const { project, machineId } = lxdCodingMachinePlan(machine).binding;
		const name = lxdCodingMachineName(machineId);
		const differing = await this.#differing(project, name, signal);
		for (const program of differing) await this.#write(project, name, program, signal);
		if (differing.length > 0 && (await this.#differing(project, name, signal)).length > 0)
			throw new Error("CODING_FOLDER_GUEST_INSTALL_UNCONFIRMED");
	}

	/** Shows the session its view at /company: the one it has, on a later turn of the same attachment, or a new one.
	 * Before a new view, the old one's final boundary saves what it has pending and it closes; with no old view held, a
	 * boundary saves what the machine's views have pending. A new view is recorded before it is shown, or closed. Resolves
	 * with the view shown and, when it replaced one the session held, how that one ended: the caller ends a view it means
	 * to replace before its attachment does, so one replaced here is a view whose attachment SQL already gave up. Invalid
	 * ids, a uid outside the sessions' range or an invalid `until` reject with CODING_FOLDER_VIEW_REQUEST_INVALID before
	 * anything; a refused open with CodingFolderViewRefused; a machine that must restart first (the node closed the
	 * session's view, held or new, under its mount; the boundary before a new view answered its reads unproven, or said it
	 * holds a read no longer readable; or the core refused the open so) with CodingFolderRestartRequired, before any other
	 * view opens; a guest's refusal with
	 * CodingGuestRefused, and an agent's answer that is not one with CODING_GUEST_ANSWER_INVALID; records it can't read,
	 * write or remove with CODING_FOLDER_VIEW_RECORD_FAILED; an open or a mount with no answer is tried again until
	 * `until`, and then rejects with CODING_FOLDER_VIEW_UNCONFIRMED or CODING_FOLDER_MOUNT_UNANSWERED. */
	async attach(
		session: CodingFolderViewSession,
		until: number,
		signal: AbortSignal,
	): Promise<{ viewId: string; replaced?: CodingFolderViewEnd }> {
		const workerId = normalizeUuid(session.workerId);
		const environmentId = normalizeUuid(session.environmentId);
		const attachmentToken = normalizeUuid(session.attachmentToken);
		const bootId = normalizeUuid(session.bootId);
		if (
			!workerId ||
			!environmentId ||
			!attachmentToken ||
			!bootId ||
			!Number.isSafeInteger(session.uid) ||
			session.uid < CODING_GUEST.minUid ||
			session.uid > CODING_GUEST.maxUid ||
			!Number.isFinite(until)
		)
			throw new Error("CODING_FOLDER_VIEW_REQUEST_INVALID");
		const { machineId } = lxdCodingMachinePlan(session.machine).binding;
		// A whole number of milliseconds within a timer's range: `until` may be any time, a fraction of one too.
		const left = Math.min(TIMER_MAX_MS, Math.max(1, Math.floor(until - Date.now())));
		const deadline = AbortSignal.any([signal, AbortSignal.timeout(left)]);
		const asked = { ...session, workerId, environmentId, attachmentToken, bootId };
		try {
			await this.install(session.machine, deadline);
		} catch (error) {
			throw stopped(signal, deadline, error, "CODING_FOLDER_GUEST_INSTALL_UNCONFIRMED");
		}
		const recorded = <T>(work: Promise<T>) =>
			work.catch((error: unknown) => {
				throw stopped(signal, deadline, error, RECORD_FAILED);
			});
		const held = await recorded(this.#held(workerId, deadline));
		if (held?.machineId === machineId && held.bootId === bootId && held.attachmentToken === attachmentToken) {
			if ((await this.#mount(asked, held, until, signal, deadline)) === "mounted") return { viewId: held.viewId };
			// The node closed it: what it read may still be in the machine. It stays held, for the restart to end.
			throw new CodingFolderRestartRequired("VIEW_CLOSED");
		}
		const finished = held?.machineId ?? machineId;
		const {
			reads,
			unreadable,
			ends: [replaced],
		} = await recorded(this.#finish(finished, held ? [held] : [], deadline));
		// A view opened now would answer unproven until the machine restarted, or be refused until it got a new disk.
		if (finished === machineId && unreadable) throw new CodingFolderRestartRequired("READS_UNREADABLE");
		if (finished === machineId && reads === "unproven") throw new CodingFolderRestartRequired("READS_UNPROVEN");
		const view = await this.#open(asked, machineId, until, signal, deadline);
		await recorded(this.#keep(view, deadline)).catch(async (error: unknown) => {
			// Unrecorded, it would outlive a restart unended: it closes, never shown.
			await this.#close(view, signal);
			throw error;
		});
		// A failed mount leaves the view held: the session's end closes it, and its next attach tries it again. One the
		// node closed under the mount stays held too, for the restart to end.
		if ((await this.#mount(asked, view, until, signal, deadline)) === "mounted")
			return replaced ? { viewId: view.viewId, replaced } : { viewId: view.viewId };
		throw new CodingFolderRestartRequired("VIEW_CLOSED");
	}

	/** The attachment the session's view was opened under, by its record: an executor that restarted attaches under it
	 * again while the machine's boot is the same. Undefined when the session holds no view; rejects like `end`. */
	async held(workerId: string, signal: AbortSignal): Promise<CodingFolderViewHeld | undefined> {
		const worker = normalizeUuid(workerId);
		const view = worker ? await this.#held(worker, signal) : undefined;
		return view && { machineId: view.machineId, bootId: view.bootId, attachmentToken: view.attachmentToken };
	}

	/** The session's view ends, once nothing of the session runs any more and before the guest unmounts it: its final
	 * boundary, then its close, and its record goes (a close the core did not confirm leaves the view to lapse with its
	 * lease). Undefined when the session holds no view. Rejects with the caller's reason, or with
	 * CODING_FOLDER_VIEW_RECORD_FAILED when its record can't be read or removed: a record that stays is ended again. */
	async end(workerId: string, signal: AbortSignal): Promise<CodingFolderViewEnd | undefined> {
		const worker = normalizeUuid(workerId);
		const view = worker ? await this.#held(worker, signal) : undefined;
		return view && (await this.#finish(view.machineId, [view], signal)).ends[0];
	}

	/** Every view on the machine ends, before the machine stops: one final boundary for them all, then each close. Rejects
	 * like `end`; with the records unread, after a boundary that saves what the machine's views have pending. */
	async endMachine(machineId: string, signal: AbortSignal): Promise<CodingFolderViewEnd[]> {
		const machine = normalizeUuid(machineId);
		if (!machine) return [];
		let views: HeldView[];
		try {
			views = await this.#heldOn(machine, signal);
		} catch (error) {
			await this.#finish(machine, [], signal);
			throw error;
		}
		return views.length > 0 ? (await this.#finish(machine, views, signal)).ends : [];
	}

	async #open(
		session: CodingFolderViewSession,
		machineId: string,
		until: number,
		signal: AbortSignal,
		deadline: AbortSignal,
	): Promise<HeldView> {
		for (;;) {
			let answer: unknown;
			try {
				answer = await this.#control.call(
					"qorpera_folder_view_open",
					{
						p_environment_id: session.environmentId,
						p_opener: { kind: "platform" },
						p_kind: "coding_session",
						p_anchor: { workerId: session.workerId, attachmentToken: session.attachmentToken },
					},
					deadline,
				);
			} catch (error) {
				// A refusal without a message the control keeps (a 42501 of another kind) is final too: UNKNOWN. A machine
				// the core marked must restart first.
				if (error instanceof CodingControlRefused) {
					const code = OPEN_REFUSALS.get(error.reason ?? "") ?? "UNKNOWN";
					throw code === "MACHINE_RESTART_REQUIRED"
						? new CodingFolderRestartRequired(code)
						: new CodingFolderViewRefused(code);
				}
				// Busy or unconfirmed: a view the lost answer opened gives way to the next, which supersedes it.
				await this.#pause(until, signal, deadline, "CODING_FOLDER_VIEW_UNCONFIRMED");
				continue;
			}
			const view = readView(answer);
			const { workerId, bootId, attachmentToken } = session;
			return { ...view, workerId, machineId, bootId, attachmentToken };
		}
	}

	async #mount(
		session: CodingFolderViewSession,
		view: HeldView,
		until: number,
		signal: AbortSignal,
		deadline: AbortSignal,
	): Promise<"mounted" | "closed"> {
		const guest = new LxdCodingGuestClient({ machine: session.machine, client: this.#client });
		const request: CodingGuestRequests["mount"] = {
			schema: "qorpera.coding-guest-mount/v1",
			workerId: session.workerId,
			uid: session.uid,
			gid: session.uid,
			view: { environmentId: session.environmentId, viewId: view.viewId, pass: view.pass },
		};
		for (;;) {
			try {
				const { mount } = await guest.mount(request, deadline);
				if (mount !== "unanswered") return mount;
			} catch (error) {
				if (signal.aborted) throw signal.reason;
				if (error instanceof CodingGuestRefused && !GUEST_BUSY.has(error.code)) throw error;
				// A request the client refuses, or an answer from the agent this executor just installed that is not
				// one: trying again would hide it.
				if (error instanceof Error && FINAL_GUEST_ERRORS.has(error.message)) throw error;
			}
			// The same request again, after a busy agent, a failed exec or one that crashed: the agent starts the
			// program only if it is not running.
			await this.#pause(until, signal, deadline, "CODING_FOLDER_MOUNT_UNANSWERED");
		}
	}

	/** The views' final boundary, asked again while one of their paths waits for a save check still running, then their
	 * closes, and then their records go; a boundary with no views only saves what the machine's views have pending.
	 * Resolves with how each view ended and the boundary's reads, and whether it said the machine holds a read no longer
	 * readable (none when it had no answer). Rejects when a record stays. */
	async #finish(
		machineId: string,
		views: readonly HeldView[],
		signal: AbortSignal,
	): Promise<{ reads?: CodingFolderReads; unreadable?: boolean; ends: CodingFolderViewEnd[] }> {
		let boundary: CodingFolderBoundary | undefined;
		const ids = views.map((view) => view.viewId);
		try {
			boundary = await this.#folder.boundary(machineId, ids, signal);
			// A save check the boundary did not wait for to end (a large git pack's, 5j-5 a) goes on in the service: the
			// views close once each such path is saved or refused, or when the caller gives up.
			while (ids.length > 0 && boundary.machine === machineId && codingFolderBoundaryChecking(boundary, ids)) {
				await delay(this.#retryMs, undefined, { signal });
				boundary = await this.#folder.boundary(machineId, ids, signal);
			}
		} catch {
			// Unsaved: the view still closes.
		}
		const ends = await Promise.all(
			views.map(async (view) => {
				const report =
					boundary?.machine === machineId ? boundary.views.find((v) => v.viewId === view.viewId) : undefined;
				return {
					workerId: view.workerId,
					viewId: view.viewId,
					saved: boundary?.reads === "released" && codingFolderViewSaved(report),
					closed: await this.#close(view, signal),
				};
			}),
		);
		let failure: unknown;
		for (const view of views)
			await this.#forget(view, signal).catch((error: unknown) => {
				failure ??= error;
			});
		if (failure) throw failure;
		return boundary?.machine === machineId
			? { reads: boundary.reads, unreadable: codingFolderBoundaryUnreadable(boundary), ends }
			: { ends };
	}

	/** The view the session holds, by its record. */
	#held(workerId: string, signal: AbortSignal): Promise<HeldView | undefined> {
		return this.#records(async () => {
			try {
				return readHeld(await readRecord(posix.join(this.#root, `${workerId}.json`)), workerId);
			} catch (error) {
				if (code(error, "ENOENT")) return undefined;
				throw error;
			}
		}, signal);
	}

	/** The views held on the machine, by their records. */
	#heldOn(machineId: string, signal: AbortSignal): Promise<HeldView[]> {
		return this.#records(async (checked) => {
			const views: HeldView[] = [];
			for (const name of (await readdir(this.#root)).sort()) {
				checked.throwIfAborted();
				const view = readHeld(await readRecord(posix.join(this.#root, name)), name.slice(0, -".json".length));
				if (view.machineId === machineId) views.push(view);
			}
			return views;
		}, signal);
	}

	/** Records the view, once (the session's old one is gone by now). */
	#keep(view: HeldView, signal: AbortSignal): Promise<void> {
		const { workerId, machineId, bootId, attachmentToken, viewId, pass } = view;
		const bytes = Buffer.from(
			JSON.stringify({ schema: RECORD_SCHEMA, workerId, machineId, bootId, attachmentToken, viewId, pass }),
		);
		return this.#records(async () => {
			if (!(await publish(this.#root, `${workerId}.json`, bytes))) throw new Error(RECORD_FAILED);
		}, signal);
	}

	/** Removes the view's record, unless the session holds another view since. */
	#forget(view: HeldView, signal: AbortSignal): Promise<void> {
		return this.#records(async () => {
			const path = posix.join(this.#root, `${view.workerId}.json`);
			try {
				if (readHeld(await readRecord(path), view.workerId).viewId !== view.viewId) return;
				await unlink(path);
			} catch (error) {
				if (code(error, "ENOENT")) return;
				throw error;
			}
			await syncDirectory(this.#root);
		}, signal);
	}

	/** One use of the records, once the last one ended: IO a hard NFS mount hangs never overlaps. The storage is checked
	 * mounted before and after it, the folder made if it is missing, and what an interrupted write left removed first.
	 * Rejects with the caller's reason, or with CODING_FOLDER_VIEW_RECORD_FAILED for anything else, past RECORD_MS too. */
	async #records<T>(use: (signal: AbortSignal) => Promise<T>, signal: AbortSignal): Promise<T> {
		const checked = AbortSignal.any([signal, AbortSignal.timeout(RECORD_MS)]);
		const work = this.#recordWork.then(async () => {
			checked.throwIfAborted();
			await this.#assert(checked);
			await mkdir(this.#root, { mode: 0o700 }).then(
				() => syncDirectory(posix.dirname(this.#root)),
				(error: unknown) => {
					if (!code(error, "EEXIST")) throw error;
				},
			);
			await checkDirectory(this.#root);
			// A write's temporary file is gone once its use ends, unless the process died in it: half written, or a second
			// link of the record it became, which no read takes. The folder is this executor's alone (a private rootPath,
			// deploy/coding-worker/README.md) and its uses never overlap, so any one here now is a dead write's.
			let swept = false;
			for (const name of await readdir(this.#root))
				if (name.startsWith(".write-")) {
					checked.throwIfAborted();
					await unlink(posix.join(this.#root, name));
					swept = true;
				}
			if (swept) await syncDirectory(this.#root);
			const result = await use(checked);
			await this.#assert(checked);
			return result;
		});
		// Settled either way: a caller that stopped first leaves no rejection unhandled.
		this.#recordWork = work.catch(() => undefined);
		try {
			return await abortable(work, checked);
		} catch {
			if (signal.aborted) throw signal.reason;
			throw new Error(RECORD_FAILED);
		}
	}

	async #close(view: HeldView, signal: AbortSignal): Promise<boolean> {
		const bounded = AbortSignal.any([signal, AbortSignal.timeout(this.#closeMs)]);
		for (;;) {
			try {
				readClosed(
					await this.#control.call(
						"qorpera_folder_view_close",
						{ p_view_id: view.viewId, p_pass: view.pass },
						bounded,
					),
				);
				return true;
			} catch (error) {
				// The core holds no such view: it is gone.
				if (error instanceof CodingControlRefused) return error.reason === "Folder view is unavailable";
				if (bounded.aborted) return false;
			}
			if (!(await delay(this.#retryMs, true, { signal: bounded }).catch(() => false))) return false;
		}
	}

	/** Waits to try again, or rejects with `code` once the next try would start past `until`. */
	async #pause(until: number, signal: AbortSignal, deadline: AbortSignal, code: string): Promise<void> {
		if (signal.aborted) throw signal.reason;
		if (deadline.aborted || Date.now() + this.#retryMs >= until) throw new Error(code);
		try {
			await delay(this.#retryMs, undefined, { signal: deadline });
		} catch (error) {
			throw stopped(signal, deadline, error, code);
		}
	}

	/** The programs whose file in the machine is missing or differs. */
	async #differing(project: string, name: string, signal: AbortSignal): Promise<Program[]> {
		const { exitCode, stdout } = await this.#exec(
			project,
			name,
			["/usr/bin/sha256sum", "--", ...this.#programs.map((program) => program.path)],
			signal,
		);
		// 1: a file is missing (its line is on stderr).
		if (exitCode !== 0 && exitCode !== 1) throw new Error("CODING_FOLDER_GUEST_INSTALL_UNCONFIRMED");
		const found = new Map<string, string>();
		for (const line of stdout.toString("utf8").split("\n").slice(0, -1)) {
			const match = SHA256_LINE.exec(line);
			if (!match) throw new Error("CODING_FOLDER_GUEST_INSTALL_UNCONFIRMED");
			found.set(match[2], match[1]);
		}
		return this.#programs.filter((program) => found.get(program.path) !== program.sha256);
	}

	async #write(project: string, name: string, program: Program, signal: AbortSignal): Promise<void> {
		const beside = `${program.path}.${randomUUID()}.new`;
		const run = async (command: string[]) => {
			if ((await this.#exec(project, name, command, signal)).exitCode !== 0)
				throw new Error("CODING_FOLDER_GUEST_INSTALL_UNCONFIRMED");
		};
		await run([
			"/usr/bin/install",
			"-d",
			"-m",
			"0755",
			"-o",
			"root",
			"-g",
			"root",
			"--",
			posix.dirname(program.path),
		]);
		try {
			await this.#client.pushInstanceProgram(project, name, beside, program.bytes, program.mode, signal);
			await run(["/usr/bin/mv", "-f", "-T", "--", beside, program.path]);
		} catch (error) {
			// Even once the caller stopped: the file's name is random, and nothing else would find it.
			await this.#exec(project, name, ["/usr/bin/rm", "-f", "--", beside], AbortSignal.timeout(EXEC_MS)).catch(
				() => undefined,
			);
			throw error;
		}
	}

	#exec(project: string, name: string, command: string[], signal: AbortSignal) {
		return this.#client.execInstanceStream(
			project,
			name,
			{ command, stdin: Buffer.alloc(0), maxStdoutBytes: 4096, maxStderrBytes: 4096, timeoutMs: EXEC_MS },
			signal,
		);
	}
}

/** The caller's abort with its reason; past the deadline, `code`; anything else as it is. */
function stopped(signal: AbortSignal, deadline: AbortSignal, error: unknown, code: string): unknown {
	if (signal.aborted) return signal.reason;
	return deadline.aborted ? new Error(code) : error;
}

/** The work, or the signal's reason once it stops first; the work goes on. */
function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted) return Promise.reject(signal.reason);
	return new Promise<T>((resolve, reject) => {
		const abort = () => reject(signal.reason);
		signal.addEventListener("abort", abort, { once: true });
		work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
	});
}

/** A view record, which must be the named session's. */
function readHeld(record: { value: unknown }, workerId: string): HeldView {
	try {
		const held = parseClosedRecord(record.value, "Folder view record", [
			"schema",
			"workerId",
			"machineId",
			"bootId",
			"attachmentToken",
			"viewId",
			"pass",
		]);
		const { machineId, bootId, attachmentToken, viewId, pass } = held;
		if (
			held.schema === RECORD_SCHEMA &&
			held.workerId === workerId &&
			[workerId, machineId, bootId, attachmentToken, viewId].every(
				(id) => typeof id === "string" && normalizeUuid(id) === id,
			) &&
			typeof pass === "string" &&
			PASS.test(pass)
		)
			return { workerId, machineId, bootId, attachmentToken, viewId, pass } as HeldView;
	} catch {
		// Below.
	}
	throw new Error(RECORD_FAILED);
}

function readView(value: unknown): { viewId: string; pass: string } {
	try {
		const view = parseClosedRecord(value, "Folder view", ["schema", "viewId", "pass", "leaseUntil"]);
		if (
			view.schema === "qorpera.folder-view/v1" &&
			isUuid(view.viewId) &&
			typeof view.pass === "string" &&
			PASS.test(view.pass) &&
			typeof view.leaseUntil === "string"
		)
			return { viewId: view.viewId, pass: view.pass };
	} catch {
		// Below.
	}
	throw new Error("CODING_FOLDER_VIEW_ANSWER_INVALID");
}

function readClosed(value: unknown): void {
	try {
		const closed = parseClosedRecord(value, "Folder view close", ["schema", "state", "reason"]);
		if (closed.schema === "qorpera.folder-view-close/v1" && closed.state === "closed") return;
	} catch {
		// Below.
	}
	throw new Error("CODING_FOLDER_VIEW_ANSWER_INVALID");
}
