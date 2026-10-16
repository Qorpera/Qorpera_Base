import { createHash, randomUUID } from "node:crypto";
import { posix } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { CODING_GUEST, type CodingGuestRequests, isUuid, normalizeUuid, parseClosedRecord } from "@qorpera/contracts";
import { CodingControlRefused } from "./coding-executor.ts";
import { type CodingFolderBoundary, codingFolderViewSaved } from "./coding-folder-control.ts";
import { CodingGuestRefused, LxdCodingGuestClient } from "./coding-guest-client.ts";
import { type LxdCodingMachineBinding, lxdCodingMachineName, lxdCodingMachinePlan } from "./coding-machine.ts";
import type { LxdInstanceExecStreamClient, LxdInstanceProgramClient } from "./lxd-client.ts";

// A coding session's view of its company's folder (F3 step 5g-4; RUNTIME-FOLDER-CODING-MACHINES.md, "Views"). Once
// the session is attached, the executor opens its view in the core with the attachment's token, and the guest agent
// shows it at the session's /company with the folder program; the view's pass goes only over the agent's stdin. When
// the session ends, the executor asks the folder service for the view's final boundary, which saves what the view has
// pending, and then closes it. The folder service renews a view while its program is connected; the executor never
// does. A pass lives only in this process's memory: after a restart, the session's next attach opens a new view,
// which supersedes the old one, and a view no program shows any more lapses with its lease.

/** The core's refusals of an open, by its own words (deploy/coding-worker/control.ts keeps exactly these). */
const OPEN_REFUSALS: ReadonlyMap<string, string> = new Map([
	["Folder view attachment is not current", "ATTACHMENT_NOT_CURRENT"],
	["Company folder is unavailable", "FOLDER_UNAVAILABLE"],
	["Folder view principals are unavailable", "PRINCIPALS_UNAVAILABLE"],
	["Folder core authority is required", "AUTHORITY_REQUIRED"],
	["Folder view is invalid", "VIEW_INVALID"],
	["Folder view opener is invalid", "VIEW_INVALID"],
	["Folder view anchor is invalid", "VIEW_INVALID"],
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

/** The session whose view this is, as the executor attached it. */
export interface CodingFolderViewSession {
	readonly workerId: string;
	readonly environmentId: string;
	/** The attachment's token (qorpera_attach_coding_session). A new attachment needs a new view. */
	readonly attachmentToken: string;
	readonly machine: LxdCodingMachineBinding;
	/** The session's own user in the machine; its group has the same id. */
	readonly uid: number;
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

/** The core refused the session's view (its code is one of OPEN_REFUSALS' or VIEW_CLOSED, the node closed the view
 * under the mount): the attach fails with it, and the same attach would fail the same way. */
export class CodingFolderViewRefused extends Error {
	readonly code: string;
	constructor(code: string) {
		super(`CODING_FOLDER_VIEW_REFUSED:${code}`);
		this.code = code;
	}
}

export interface CodingFolderViewsOptions {
	readonly control: { call(method: string, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown> };
	readonly folder: {
		boundary(machine: string, final: readonly string[], signal: AbortSignal): Promise<CodingFolderBoundary>;
	};
	readonly client: LxdInstanceExecStreamClient & LxdInstanceProgramClient;
	/** The guest agent (scripts/package-coding-guest-agent.mjs) and the folder program (5d's build or later: the agent
	 * gives it --local-dir), as the executor checked them against its pins. */
	readonly agent: Buffer;
	readonly program: Buffer;
	/** Between tries of an open, a mount or a close, and how long a close is tried; tests shorten them. */
	readonly retryMs?: number;
	readonly closeMs?: number;
}

interface HeldView {
	readonly workerId: string;
	readonly machineId: string;
	readonly attachmentToken: string;
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
	readonly #views = new Map<string, HeldView>();
	constructor(options: CodingFolderViewsOptions) {
		const program = (path: string, mode: number, bytes: Buffer): Program => {
			if (!Buffer.isBuffer(bytes) || bytes.byteLength < 1) throw new Error("Invalid coding folder program");
			return { path, mode, bytes, sha256: createHash("sha256").update(bytes).digest("hex") };
		};
		this.#programs = [
			program(CODING_GUEST.agent, 0o444, options.agent),
			program(CODING_GUEST.folderProgram, 0o555, options.program),
		];
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
	 * Before a new view, the old one's final boundary saves what it has pending and it closes; with no old view held
	 * (this executor restarted), a boundary saves what the machine's views have pending. Invalid ids, a uid outside the
	 * sessions' range or an invalid `until` reject with CODING_FOLDER_VIEW_REQUEST_INVALID before anything; a refused
	 * open with CodingFolderViewRefused; a guest's refusal with CodingGuestRefused, and an agent's answer that is not
	 * one with CODING_GUEST_ANSWER_INVALID; an open or a mount with no answer is tried again until `until`, and then
	 * rejects with CODING_FOLDER_VIEW_UNCONFIRMED or CODING_FOLDER_MOUNT_UNANSWERED. */
	async attach(session: CodingFolderViewSession, until: number, signal: AbortSignal): Promise<{ viewId: string }> {
		const workerId = normalizeUuid(session.workerId);
		const environmentId = normalizeUuid(session.environmentId);
		const attachmentToken = normalizeUuid(session.attachmentToken);
		if (
			!workerId ||
			!environmentId ||
			!attachmentToken ||
			!Number.isSafeInteger(session.uid) ||
			session.uid < CODING_GUEST.minUid ||
			session.uid > CODING_GUEST.maxUid ||
			!Number.isFinite(until)
		)
			throw new Error("CODING_FOLDER_VIEW_REQUEST_INVALID");
		const { machineId } = lxdCodingMachinePlan(session.machine).binding;
		const deadline = AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, until - Date.now()))]);
		const asked = { ...session, workerId, environmentId, attachmentToken };
		try {
			await this.install(session.machine, deadline);
		} catch (error) {
			throw stopped(signal, deadline, error, "CODING_FOLDER_GUEST_INSTALL_UNCONFIRMED");
		}
		const held = this.#views.get(workerId);
		if (held?.machineId === machineId && held.attachmentToken === attachmentToken) {
			// One the node closed since gives way to a new one.
			if ((await this.#mount(asked, held, until, signal, deadline)) === "mounted") return { viewId: held.viewId };
		}
		await this.#finish(held?.machineId ?? machineId, held ? [held] : [], deadline);
		const view = await this.#open(asked, machineId, until, signal, deadline);
		this.#views.set(workerId, view);
		// A failed mount leaves the view held: the session's end closes it, and its next attach tries it again.
		if ((await this.#mount(asked, view, until, signal, deadline)) === "mounted") return { viewId: view.viewId };
		throw new CodingFolderViewRefused("VIEW_CLOSED");
	}

	/** The session's view ends, before the guest stops the session and once its commands are stopped: its final
	 * boundary, then its close. Undefined when the session holds no view. Never rejects. */
	async end(workerId: string, signal: AbortSignal): Promise<CodingFolderViewEnd | undefined> {
		const view = this.#views.get(normalizeUuid(workerId) ?? "");
		return view && (await this.#finish(view.machineId, [view], signal))[0];
	}

	/** Every view on the machine ends, before the machine stops: one final boundary for them all, then each close. */
	async endMachine(machineId: string, signal: AbortSignal): Promise<CodingFolderViewEnd[]> {
		const machine = normalizeUuid(machineId);
		const views = [...this.#views.values()].filter((view) => view.machineId === machine);
		return views.length > 0 ? this.#finish(views[0].machineId, views, signal) : [];
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
				// A refusal without a message the control keeps (a 42501 of another kind) is final too: UNKNOWN.
				if (error instanceof CodingControlRefused)
					throw new CodingFolderViewRefused(OPEN_REFUSALS.get(error.reason ?? "") ?? "UNKNOWN");
				// Busy or unconfirmed: a view the lost answer opened gives way to the next, which supersedes it.
				await this.#pause(until, signal, deadline, "CODING_FOLDER_VIEW_UNCONFIRMED");
				continue;
			}
			const view = readView(answer);
			return { ...view, workerId: session.workerId, machineId, attachmentToken: session.attachmentToken };
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

	/** The views' final boundary, then their closes; a boundary with no views only saves what the machine's views have
	 * pending. */
	async #finish(machineId: string, views: readonly HeldView[], signal: AbortSignal): Promise<CodingFolderViewEnd[]> {
		let boundary: CodingFolderBoundary | undefined;
		try {
			boundary = await this.#folder.boundary(
				machineId,
				views.map((view) => view.viewId),
				signal,
			);
		} catch {
			// Unsaved: the view still closes.
		}
		return Promise.all(
			views.map(async (view) => {
				const report =
					boundary?.machine === machineId ? boundary.views.find((v) => v.viewId === view.viewId) : undefined;
				const closed = await this.#close(view, signal);
				if (this.#views.get(view.workerId) === view) this.#views.delete(view.workerId);
				return {
					workerId: view.workerId,
					viewId: view.viewId,
					saved: boundary?.reads === "released" && codingFolderViewSaved(report),
					closed,
				};
			}),
		);
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
