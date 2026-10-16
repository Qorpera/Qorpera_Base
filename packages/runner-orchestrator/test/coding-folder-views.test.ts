import { createHash } from "node:crypto";
import {
	chmodSync,
	linkSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CODING_GUEST, type CodingGuestRequests } from "@qorpera/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { CodingControlBusy, CodingControlRefused } from "../src/coding-executor.ts";
import type { CodingFolderBoundary } from "../src/coding-folder-control.ts";
import { CodingFolderViewRefused, CodingFolderViews } from "../src/coding-folder-views.ts";
import { CodingGuestRefused } from "../src/coding-guest-client.ts";
import { lxdCodingMachineName } from "../src/coding-machine.ts";
import type { LxdExecStreamRequest, LxdInstanceExecStreamClient, LxdInstanceProgramClient } from "../src/lxd-client.ts";
import { codingMachineFixture } from "./helpers/coding-machine.ts";

const MACHINE = "12345678-1234-4234-8234-0000000000a1";
const OTHER_MACHINE = "12345678-1234-4234-8234-0000000000a2";
const COMPANY = "12345678-1234-4234-8234-0000000000c1";
const ENVIRONMENT = "12345678-1234-4234-8234-0000000000e1";
const MEMBER = "12345678-1234-4234-8234-0000000000f1";
const WORKER = "12345678-1234-4234-8234-0000000000b1";
const WORKER_2 = "12345678-1234-4234-8234-0000000000b2";
const WORKER_3 = "12345678-1234-4234-8234-0000000000b3";
const TOKEN = "12345678-1234-4234-8234-0000000000d1";
const TOKEN_2 = "12345678-1234-4234-8234-0000000000d2";
const TOKEN_3 = "12345678-1234-4234-8234-0000000000d3";
const BOOT = "12345678-1234-4234-8234-0000000000a9";
const BOOT_2 = "12345678-1234-4234-8234-0000000000aa";
/** The views the core opens, in turn, and their passes (fake, never real). */
const VIEWS = [
	"12345678-1234-4234-8234-00000000ee01",
	"12345678-1234-4234-8234-00000000ee02",
	"12345678-1234-4234-8234-00000000ee03",
	"12345678-1234-4234-8234-00000000ee04",
] as const;
const PASSES = ["A".repeat(43), `${"b".repeat(21)}-_${"B".repeat(20)}`, "C".repeat(43), "D".repeat(43)] as const;
const AGENT_PATH = "/opt/qorpera-guest/agent.mjs";
const PROGRAM_PATH = "/opt/qorpera-folder/qorpera-folder";
const AGENT = Buffer.from("// the guest agent\n");
const PROGRAM = Buffer.from("the folder program");
const NAME = lxdCodingMachineName(MACHINE);
const CLOSED = { schema: "qorpera.folder-view-close/v1", state: "closed", reason: "closed" };
const INSTALL_UNCONFIRMED = "CODING_FOLDER_GUEST_INSTALL_UNCONFIRMED";
const RECORD_FAILED = "CODING_FOLDER_VIEW_RECORD_FAILED";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const binding = (machineId: string) =>
	codingMachineFixture({ machineId, companyId: COMPANY, environmentId: ENVIRONMENT, memberUserId: MEMBER });
const MACHINE_BINDING = binding(MACHINE);
const OTHER_MACHINE_BINDING = binding(OTHER_MACHINE);

type Session = Parameters<CodingFolderViews["attach"]>[0];
type MountScript = "mounted" | "closed" | "unanswered" | { refusal: string } | { exitCode: number } | Error;
type Scripted<T> = T | (() => T);
type Boundary = (machine: string, final: readonly string[]) => CodingFolderBoundary;

const released: Boundary = (machine, final) => ({
	machine,
	reads: "released",
	views: final.map((viewId) => ({ viewId, unsaved: 0 })),
});
const live = () => new AbortController().signal;
const later = () => Date.now() + 60_000;
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const line = (value: unknown) => `${JSON.stringify(value)}\n`;
const mounted = (asked: CodingGuestRequests["mount"], mount: string) =>
	line({ schema: "qorpera.coding-guest-mounted/v1", workerId: asked.workerId, viewId: asked.view.viewId, mount });
const refused = (code: string) => line({ schema: "qorpera.coding-guest-refusal/v1", code });
/** A program's file written beside its place, to be renamed over it. */
const beside = (path: string) => new RegExp(`^${path.replaceAll(".", "\\.")}\\.[0-9a-f-]{36}\\.new$`);

function session(scope: Partial<Session> = {}): Session {
	return {
		workerId: WORKER,
		environmentId: ENVIRONMENT,
		attachmentToken: TOKEN,
		bootId: BOOT,
		machine: MACHINE_BINDING,
		uid: 200001,
		...scope,
	};
}
function openAnswer(index: number) {
	return {
		schema: "qorpera.folder-view/v1",
		viewId: VIEWS[index]!,
		pass: PASSES[index]!,
		leaseUntil: "2026-10-16T01:00:00Z",
	};
}
function take<T>(queue: Scripted<T>[], after: Scripted<T>): T {
	const next = queue.length > 0 ? queue.shift() : after;
	return typeof next === "function" ? (next as () => T)() : (next as T);
}
/** The work's rejection. No error may quote a view's pass. */
async function rejection(work: Promise<unknown>): Promise<Error> {
	const error = await work.then(
		() => undefined,
		(caught: unknown) => caught,
	);
	expect(error).toBeInstanceOf(Error);
	const text = `${(error as Error).message} ${JSON.stringify(error)}`;
	for (const pass of PASSES) expect(text).not.toContain(pass);
	return error as Error;
}
async function failure(work: Promise<unknown>): Promise<string> {
	return (await rejection(work)).message;
}

/** An in-memory guest behind the LXD client, a scripted core and a scripted folder service, all logging to `events`. */
function fixture({ installed = true }: { installed?: boolean } = {}) {
	const events: string[] = [];
	const files = new Map<string, { bytes: Buffer; mode: number }>();
	const folders = new Set<string>();
	if (installed) {
		files.set(AGENT_PATH, { bytes: AGENT, mode: 0o444 });
		files.set(PROGRAM_PATH, { bytes: PROGRAM, mode: 0o555 });
		folders.add("/opt/qorpera-guest").add("/opt/qorpera-folder");
	}
	/** Each exec, and whether its signal had already stopped it. */
	const execs: { project: string; name: string; request: LxdExecStreamRequest; stopped: boolean }[] = [];
	const pushes: { project: string; name: string; path: string; mode: number }[] = [];
	const mounts: CodingGuestRequests["mount"][] = [];
	const opens: Record<string, unknown>[] = [];
	const closes: Record<string, unknown>[] = [];
	const boundaries: { machine: string; final: string[] }[] = [];
	let opened = 0;
	const script = {
		/** sha256sum prints a digest that matches nothing. */
		lie: false,
		sha256Exit: undefined as number | undefined,
		sha256Stdout: undefined as string | undefined,
		/** The push writes its file and then fails, after stopping this caller if there is one. */
		pushError: undefined as Error | undefined,
		pushStops: undefined as AbortController | undefined,
		mvExit: 0,
		/** Each mount's answer in turn, then `mountAfter` for every later one; likewise the core's opens and closes. */
		mount: [] as Scripted<MountScript>[],
		mountAfter: "mounted" as Scripted<MountScript>,
		open: [] as Scripted<unknown>[],
		openAfter: (() => openAnswer(opened++)) as Scripted<unknown>,
		close: [] as Scripted<unknown>[],
		closeAfter: CLOSED as Scripted<unknown>,
		boundary: released,
		/** Whether the node's coding storage is unmounted, as each use of the records checks before and after. */
		unmounted: (() => false) as () => boolean,
	};
	const done = (exitCode: number, stdout = "") => ({ exitCode, stdout: Buffer.from(stdout), stderr: Buffer.alloc(0) });
	const client: LxdInstanceExecStreamClient & LxdInstanceProgramClient = {
		async execInstanceStream(project, name, request, signal) {
			execs.push({ project, name, request, stopped: signal?.aborted ?? false });
			const [program, ...rest] = request.command;
			if (program === "/usr/bin/sha256sum") {
				events.push("sha256sum");
				const paths = rest.slice(1);
				const present = paths.filter((path) => files.has(path));
				const stdout = present
					.map((path) => `${script.lie ? "0".repeat(64) : digest(files.get(path)!.bytes)}  ${path}\n`)
					.join("");
				return done(script.sha256Exit ?? (present.length === paths.length ? 0 : 1), script.sha256Stdout ?? stdout);
			}
			if (program === "/usr/bin/install") {
				events.push("install");
				folders.add(rest.at(-1)!);
				return done(0);
			}
			if (program === "/usr/bin/mv") {
				events.push("mv");
				const [from, to] = rest.slice(-2) as [string, string];
				const file = files.get(from);
				if (script.mvExit !== 0 || !file) return done(script.mvExit || 1);
				files.set(to, file);
				files.delete(from);
				return done(0);
			}
			if (program === "/usr/bin/rm") {
				events.push("rm");
				files.delete(rest.at(-1)!);
				return done(0);
			}
			if (program === CODING_GUEST.node && rest.join(" ") === `${CODING_GUEST.agent} mount`) {
				const asked = JSON.parse(request.stdin.toString("utf8")) as CodingGuestRequests["mount"];
				events.push("mount");
				mounts.push(asked);
				const next = take(script.mount, script.mountAfter);
				if (next instanceof Error) throw next;
				if (typeof next === "string") return done(0, mounted(asked, next));
				return "refusal" in next ? done(0, refused(next.refusal)) : done(next.exitCode);
			}
			throw new Error(`Unexpected command ${request.command.join(" ")}`);
		},
		async pushInstanceProgram(project, name, path, content, mode) {
			events.push("push");
			pushes.push({ project, name, path, mode });
			// Like LXD, only into a folder that exists.
			if (!folders.has(path.slice(0, path.lastIndexOf("/")))) throw new Error("No such folder");
			files.set(path, { bytes: Buffer.from(content), mode });
			script.pushStops?.abort(new Error("the executor is stopping"));
			if (script.pushError) throw script.pushError;
		},
	};
	const control = {
		async call(method: string, args: Record<string, unknown>) {
			const open = method === "qorpera_folder_view_open";
			if (!open && method !== "qorpera_folder_view_close") throw new Error(`Unexpected method ${method}`);
			events.push(open ? "open" : "close");
			(open ? opens : closes).push(structuredClone(args));
			const next = open ? take(script.open, script.openAfter) : take(script.close, script.closeAfter);
			if (next instanceof Error) throw next;
			return next;
		},
	};
	const folder = {
		async boundary(machine: string, final: readonly string[]) {
			events.push("boundary");
			boundaries.push({ machine, final: [...final] });
			return script.boundary(machine, final);
		},
	};
	// The records' folder is made in a parent that exists, as on the storage.
	const parent = realpathSync(mkdtempSync(join(tmpdir(), "coding-folder-views-")));
	roots.push(parent);
	const records = {
		root: join(parent, "folder-views"),
		async assert() {
			if (script.unmounted()) throw new Error("CODING_STORAGE_UNMOUNTED");
		},
	};
	const options = { control, folder, client, agent: AGENT, program: PROGRAM, records, retryMs: 1 };
	return {
		views: new CodingFolderViews(options),
		options,
		root: records.root,
		script,
		events,
		files,
		execs,
		pushes,
		mounts,
		opens,
		closes,
		boundaries,
	};
}

describe("CodingFolderViews", () => {
	describe("install", () => {
		it("writes each missing program beside its place and renames it over, then checks both again", async () => {
			const at = fixture({ installed: false });
			await at.views.install(MACHINE_BINDING, live());
			const writeBoth = ["sha256sum", "install", "push", "mv", "install", "push", "mv", "sha256sum"];
			expect(at.events.splice(0)).toEqual(writeBoth);
			expect(at.pushes).toEqual([
				{ project: "coding", name: NAME, path: expect.stringMatching(beside(AGENT_PATH)), mode: 0o444 },
				{ project: "coding", name: NAME, path: expect.stringMatching(beside(PROGRAM_PATH)), mode: 0o555 },
			]);
			const [agent, program] = at.pushes;
			expect(at.execs.map(({ request }) => request.command)).toEqual([
				["/usr/bin/sha256sum", "--", AGENT_PATH, PROGRAM_PATH],
				["/usr/bin/install", "-d", "-m", "0755", "-o", "root", "-g", "root", "--", "/opt/qorpera-guest"],
				["/usr/bin/mv", "-f", "-T", "--", agent!.path, AGENT_PATH],
				["/usr/bin/install", "-d", "-m", "0755", "-o", "root", "-g", "root", "--", "/opt/qorpera-folder"],
				["/usr/bin/mv", "-f", "-T", "--", program!.path, PROGRAM_PATH],
				["/usr/bin/sha256sum", "--", AGENT_PATH, PROGRAM_PATH],
			]);
			for (const { project, name, request } of at.execs) {
				expect([project, name]).toEqual(["coding", NAME]);
				expect(request).toMatchObject({ maxStdoutBytes: 4096, maxStderrBytes: 4096, timeoutMs: 30000 });
				expect(request.stdin.byteLength).toBe(0);
			}
			expect(Object.fromEntries(at.files)).toEqual({
				[AGENT_PATH]: { bytes: AGENT, mode: 0o444 },
				[PROGRAM_PATH]: { bytes: PROGRAM, mode: 0o555 },
			});
			// Both match now: one check, nothing written.
			await at.views.install(MACHINE_BINDING, live());
			expect(at.events).toEqual(["sha256sum"]);
			expect(at.pushes).toHaveLength(2);
		});

		it("writes only the program whose file differs", async () => {
			const at = fixture();
			at.files.set(PROGRAM_PATH, { bytes: Buffer.from("an older folder program"), mode: 0o555 });
			await at.views.install(MACHINE_BINDING, live());
			expect(at.events).toEqual(["sha256sum", "install", "push", "mv", "sha256sum"]);
			expect(at.pushes.map(({ path, mode }) => [path, mode])).toEqual([
				[expect.stringMatching(beside(PROGRAM_PATH)), 0o555],
			]);
			expect(at.files.get(PROGRAM_PATH)).toEqual({ bytes: PROGRAM, mode: 0o555 });
		});

		it("fails unconfirmed when the files still differ after writing, or sha256sum fails or misprints", async () => {
			const lying = fixture({ installed: false });
			lying.script.lie = true;
			expect(await failure(lying.views.install(MACHINE_BINDING, live()))).toBe(INSTALL_UNCONFIRMED);
			expect(lying.events).toEqual(["sha256sum", "install", "push", "mv", "install", "push", "mv", "sha256sum"]);
			const failing = fixture();
			failing.script.sha256Exit = 2;
			expect(await failure(failing.views.install(MACHINE_BINDING, live()))).toBe(INSTALL_UNCONFIRMED);
			expect(failing.events).toEqual(["sha256sum"]);
			for (const stdout of [
				`${"A".repeat(64)}  ${AGENT_PATH}\n`,
				`${"a".repeat(64)} ${AGENT_PATH}\n`,
				`${"a".repeat(64)}  agent.mjs\n`,
			]) {
				const at = fixture();
				at.script.sha256Stdout = stdout;
				expect(await failure(at.views.install(MACHINE_BINDING, live()))).toBe(INSTALL_UNCONFIRMED);
				expect(at.pushes).toEqual([]);
			}
		});

		it("removes the file beside its place when the push or the rename fails", async () => {
			const pushing = fixture({ installed: false });
			const cut = new Error("LXD push was cut off");
			pushing.script.pushError = cut;
			expect(await rejection(pushing.views.install(MACHINE_BINDING, live()))).toBe(cut);
			expect(pushing.events).toEqual(["sha256sum", "install", "push", "rm"]);
			expect(pushing.execs.at(-1)!.request.command).toEqual(["/usr/bin/rm", "-f", "--", pushing.pushes[0]!.path]);
			expect(pushing.files.size).toBe(0);
			const renaming = fixture({ installed: false });
			renaming.script.mvExit = 1;
			expect(await failure(renaming.views.install(MACHINE_BINDING, live()))).toBe(INSTALL_UNCONFIRMED);
			expect(renaming.events).toEqual(["sha256sum", "install", "push", "mv", "rm"]);
			expect(renaming.files.size).toBe(0);
			// A caller that stopped during the push still has the file removed, under a signal of its own.
			const stopping = fixture({ installed: false });
			const stop = new AbortController();
			stopping.script.pushError = cut;
			stopping.script.pushStops = stop;
			expect(await rejection(stopping.views.install(MACHINE_BINDING, stop.signal))).toBe(cut);
			expect(stopping.events).toEqual(["sha256sum", "install", "push", "rm"]);
			expect(stopping.execs.at(-1)!.stopped).toBe(false);
			expect(stopping.files.size).toBe(0);
		});
	});

	describe("attach", () => {
		it("opens a fresh session's view after its machine's boundary and mounts it with lower-cased ids", async () => {
			const at = fixture();
			const upper = session({
				workerId: WORKER.toUpperCase(),
				environmentId: ENVIRONMENT.toUpperCase(),
				attachmentToken: TOKEN.toUpperCase(),
			});
			await expect(at.views.attach(upper, later(), live())).resolves.toEqual({ viewId: VIEWS[0] });
			expect(at.events).toEqual(["sha256sum", "boundary", "open", "mount"]);
			expect(at.boundaries).toEqual([{ machine: MACHINE, final: [] }]);
			expect(at.opens).toEqual([
				{
					p_environment_id: ENVIRONMENT,
					p_opener: { kind: "platform" },
					p_kind: "coding_session",
					p_anchor: { workerId: WORKER, attachmentToken: TOKEN },
				},
			]);
			expect(at.mounts).toEqual([
				{
					schema: "qorpera.coding-guest-mount/v1",
					workerId: WORKER,
					uid: 200001,
					gid: 200001,
					view: { environmentId: ENVIRONMENT, viewId: VIEWS[0], pass: PASSES[0] },
				},
			]);
			const mount = at.execs.at(-1)!;
			expect([mount.project, mount.name, mount.request.command]).toEqual([
				"coding",
				NAME,
				["/usr/bin/node", "/opt/qorpera-guest/agent.mjs", "mount"],
			]);
		});

		it("still opens the view when the boundary before it fails", async () => {
			const at = fixture();
			at.script.boundary = () => {
				throw new Error("CODING_FOLDER_CONTROL_UNANSWERED");
			};
			await expect(at.views.attach(session(), later(), live())).resolves.toEqual({ viewId: VIEWS[0] });
			expect(at.events).toEqual(["sha256sum", "boundary", "open", "mount"]);
		});

		it("fails before any view when the programs can't be installed", async () => {
			const at = fixture();
			at.script.sha256Exit = 2;
			expect(await failure(at.views.attach(session(), later(), live()))).toBe(INSTALL_UNCONFIRMED);
			expect(at.events).toEqual(["sha256sum"]);
		});

		it("refuses invalid ids or an invalid deadline before calling anything", async () => {
			const cases: [Session, number][] = [
				[session({ workerId: "not-a-uuid" }), later()],
				[session({ environmentId: "" }), later()],
				[session({ attachmentToken: "00000000-0000-0000-0000-000000000000" }), later()],
				[session(), Number.NaN],
			];
			for (const [asked, until] of cases) {
				const at = fixture();
				expect(await failure(at.views.attach(asked, until, live()))).toBe("CODING_FOLDER_VIEW_REQUEST_INVALID");
				expect(at.events).toEqual([]);
			}
		});

		it("takes a deadline in a fraction of a millisecond, or past a timer's range", async () => {
			for (const until of [later() + 0.5, Date.now() + 2 ** 33]) {
				const at = fixture();
				await expect(at.views.attach(session(), until, live())).resolves.toEqual({ viewId: VIEWS[0] });
				expect(at.events).toEqual(["sha256sum", "boundary", "open", "mount"]);
			}
		});

		it("shows the same view again on a later turn of the same attachment", async () => {
			const at = fixture();
			await at.views.attach(session(), later(), live());
			at.events.splice(0);
			await expect(at.views.attach(session(), later(), live())).resolves.toEqual({ viewId: VIEWS[0] });
			expect(at.events).toEqual(["sha256sum", "mount"]);
			expect(at.mounts).toHaveLength(2);
			expect(at.mounts[1]).toEqual(at.mounts[0]);
			expect(at.opens).toHaveLength(1);
			expect(at.closes).toEqual([]);
		});

		it("replaces a view the node closed since: its final boundary and close, then a new view", async () => {
			const at = fixture();
			await at.views.attach(session(), later(), live());
			at.events.splice(0);
			at.script.mount.push("closed");
			await expect(at.views.attach(session(), later(), live())).resolves.toEqual({
				viewId: VIEWS[1],
				replaced: { workerId: WORKER, viewId: VIEWS[0], saved: true, closed: true },
			});
			expect(at.events).toEqual(["sha256sum", "mount", "boundary", "close", "open", "mount"]);
			expect(at.boundaries.at(-1)).toEqual({ machine: MACHINE, final: [VIEWS[0]] });
			expect(at.closes).toEqual([{ p_view_id: VIEWS[0], p_pass: PASSES[0] }]);
			expect(at.mounts.map(({ view }) => view)).toEqual([
				{ environmentId: ENVIRONMENT, viewId: VIEWS[0], pass: PASSES[0] },
				{ environmentId: ENVIRONMENT, viewId: VIEWS[0], pass: PASSES[0] },
				{ environmentId: ENVIRONMENT, viewId: VIEWS[1], pass: PASSES[1] },
			]);
			// The session holds the new view now.
			await expect(at.views.end(WORKER, live())).resolves.toMatchObject({ viewId: VIEWS[1], closed: true });
			expect(at.closes.at(-1)).toEqual({ p_view_id: VIEWS[1], p_pass: PASSES[1] });
		});

		it("replaces the view of an earlier attachment", async () => {
			const at = fixture();
			await at.views.attach(session(), later(), live());
			at.events.splice(0);
			await expect(at.views.attach(session({ attachmentToken: TOKEN_2 }), later(), live())).resolves.toEqual({
				viewId: VIEWS[1],
				replaced: { workerId: WORKER, viewId: VIEWS[0], saved: true, closed: true },
			});
			expect(at.events).toEqual(["sha256sum", "boundary", "close", "open", "mount"]);
			expect(at.boundaries.at(-1)).toEqual({ machine: MACHINE, final: [VIEWS[0]] });
			expect(at.closes).toEqual([{ p_view_id: VIEWS[0], p_pass: PASSES[0] }]);
			expect(at.opens.at(-1)).toMatchObject({ p_anchor: { workerId: WORKER, attachmentToken: TOKEN_2 } });
			expect(at.mounts.at(-1)!.view).toEqual({ environmentId: ENVIRONMENT, viewId: VIEWS[1], pass: PASSES[1] });
		});

		it("replaces the view of an earlier boot of the machine, under the same attachment too", async () => {
			const at = fixture();
			await at.views.attach(session(), later(), live());
			at.events.splice(0);
			await expect(at.views.attach(session({ bootId: BOOT_2 }), later(), live())).resolves.toEqual({
				viewId: VIEWS[1],
				replaced: { workerId: WORKER, viewId: VIEWS[0], saved: true, closed: true },
			});
			expect(at.events).toEqual(["sha256sum", "boundary", "close", "open", "mount"]);
			expect(at.boundaries.at(-1)).toEqual({ machine: MACHINE, final: [VIEWS[0]] });
			expect(at.closes).toEqual([{ p_view_id: VIEWS[0], p_pass: PASSES[0] }]);
			await expect(at.views.held(WORKER, live())).resolves.toEqual({
				machineId: MACHINE,
				bootId: BOOT_2,
				attachmentToken: TOKEN,
			});
		});

		it("ends a moved session's old view on its old machine", async () => {
			const at = fixture();
			await at.views.attach(session(), later(), live());
			at.events.splice(0);
			await expect(at.views.attach(session({ machine: OTHER_MACHINE_BINDING }), later(), live())).resolves.toEqual({
				viewId: VIEWS[1],
				replaced: { workerId: WORKER, viewId: VIEWS[0], saved: true, closed: true },
			});
			expect(at.events).toEqual(["sha256sum", "boundary", "close", "open", "mount"]);
			expect(at.boundaries.at(-1)).toEqual({ machine: MACHINE, final: [VIEWS[0]] });
			expect(at.execs.at(-1)!.name).toBe(lxdCodingMachineName(OTHER_MACHINE));
			await expect(at.views.endMachine(MACHINE, live())).resolves.toEqual([]);
			await expect(at.views.endMachine(OTHER_MACHINE, live())).resolves.toEqual([
				{ workerId: WORKER, viewId: VIEWS[1], saved: true, closed: true },
			]);
		});

		it("maps each refusal of the open to its code, and does not try again", async () => {
			const refusals: [string, string][] = [
				["Folder view attachment is not current", "ATTACHMENT_NOT_CURRENT"],
				["Company folder is unavailable", "FOLDER_UNAVAILABLE"],
				["Folder view principals are unavailable", "PRINCIPALS_UNAVAILABLE"],
				["Folder core authority is required", "AUTHORITY_REQUIRED"],
				["Folder view is invalid", "VIEW_INVALID"],
				["Folder view opener is invalid", "VIEW_INVALID"],
				["Folder view anchor is invalid", "VIEW_INVALID"],
				["Something the core never says", "UNKNOWN"],
			];
			for (const [reason, code] of refusals) {
				const at = fixture();
				at.script.open.push(new CodingControlRefused(reason));
				const error = await rejection(at.views.attach(session(), later(), live()));
				expect(error, reason).toBeInstanceOf(CodingFolderViewRefused);
				expect((error as CodingFolderViewRefused).code, reason).toBe(code);
				expect(error.message, reason).toBe(`CODING_FOLDER_VIEW_REFUSED:${code}`);
				expect(at.events, reason).toEqual(["sha256sum", "boundary", "open"]);
				await expect(at.views.end(WORKER, live())).resolves.toBeUndefined();
			}
		});

		it("tries a busy or unconfirmed open again with the same arguments", async () => {
			const at = fixture();
			at.script.open.push(new CodingControlBusy(), new Error("CODING_CONTROL_UNCONFIRMED"));
			await expect(at.views.attach(session(), later(), live())).resolves.toEqual({ viewId: VIEWS[0] });
			expect(at.events).toEqual(["sha256sum", "boundary", "open", "open", "open", "mount"]);
			expect(at.opens[1]).toEqual(at.opens[0]);
			expect(at.opens[2]).toEqual(at.opens[0]);
		});

		it("gives up on an open that stays unconfirmed past `until`", async () => {
			const at = fixture();
			at.script.openAfter = new Error("CODING_CONTROL_UNCONFIRMED");
			expect(await failure(at.views.attach(session(), Date.now() + 30, live()))).toBe(
				"CODING_FOLDER_VIEW_UNCONFIRMED",
			);
			expect(at.mounts).toEqual([]);
			await expect(at.views.end(WORKER, live())).resolves.toBeUndefined();
		});

		it("refuses every open answer that is not exactly a view, without trying again", async () => {
			const valid = openAnswer(0);
			const { leaseUntil: _, ...unleased } = valid;
			for (const answer of [
				{ ...valid, schema: "qorpera.folder-view/v2" },
				{ ...valid, extra: true },
				unleased,
				{ ...valid, leaseUntil: 1 },
				{ ...valid, pass: "A".repeat(42) },
				{ ...valid, pass: `${"A".repeat(42)}+` },
				{ ...valid, viewId: "not-a-uuid" },
				{ ...valid, viewId: VIEWS[0].toUpperCase() },
				null,
				[valid],
				"view",
			]) {
				const at = fixture();
				at.script.open.push(answer);
				const label = JSON.stringify(answer);
				expect(await failure(at.views.attach(session(), later(), live())), label).toBe(
					"CODING_FOLDER_VIEW_ANSWER_INVALID",
				);
				expect(at.events, label).toEqual(["sha256sum", "boundary", "open"]);
			}
		});

		it("tries an unanswered, busy or failed mount again with the same request", async () => {
			const at = fixture();
			at.script.mount.push(
				"unanswered",
				{ refusal: "CODING_GUEST_SESSION_BUSY" },
				{ refusal: "CODING_GUEST_MACHINE_BUSY" },
				{ exitCode: 1 },
				new Error("LXD exec stream failed"),
			);
			await expect(at.views.attach(session(), later(), live())).resolves.toEqual({ viewId: VIEWS[0] });
			expect(at.events).toEqual(["sha256sum", "boundary", "open", ...Array.from({ length: 6 }, () => "mount")]);
			for (const asked of at.mounts) expect(asked).toEqual(at.mounts[0]);
		});

		it("fails on the guest's other refusals, never quoting the pass, and keeps the view for the end", async () => {
			const at = fixture();
			at.script.mount.push({ refusal: "CODING_GUEST_SESSION_USER_CHANGED" });
			const error = await rejection(at.views.attach(session(), later(), live()));
			expect(error).toBeInstanceOf(CodingGuestRefused);
			expect((error as CodingGuestRefused).code).toBe("CODING_GUEST_SESSION_USER_CHANGED");
			expect(at.mounts).toHaveLength(1);
			await expect(at.views.end(WORKER, live())).resolves.toEqual({
				workerId: WORKER,
				viewId: VIEWS[0],
				saved: true,
				closed: true,
			});
		});

		it("fails at once on an agent's answer that is not one, and keeps the view for the end", async () => {
			const at = fixture();
			at.script.mount.push({ exitCode: 0 });
			expect(await failure(at.views.attach(session(), later(), live()))).toBe("CODING_GUEST_ANSWER_INVALID");
			expect(at.mounts).toHaveLength(1);
			await expect(at.views.end(WORKER, live())).resolves.toMatchObject({ viewId: VIEWS[0], closed: true });
		});

		it("gives up on a mount that stays unanswered past `until`", async () => {
			const at = fixture();
			at.script.mountAfter = "unanswered";
			expect(await failure(at.views.attach(session(), Date.now() + 30, live()))).toBe(
				"CODING_FOLDER_MOUNT_UNANSWERED",
			);
			expect(at.opens).toHaveLength(1);
		});

		it("refuses VIEW_CLOSED when the node closed a fresh view, which stays held for the end", async () => {
			const at = fixture();
			at.script.mount.push("closed");
			const error = await rejection(at.views.attach(session(), later(), live()));
			expect(error).toBeInstanceOf(CodingFolderViewRefused);
			expect((error as CodingFolderViewRefused).code).toBe("VIEW_CLOSED");
			expect(error.message).toBe("CODING_FOLDER_VIEW_REFUSED:VIEW_CLOSED");
			expect(at.events).toEqual(["sha256sum", "boundary", "open", "mount"]);
			await expect(at.views.end(WORKER, live())).resolves.toEqual({
				workerId: WORKER,
				viewId: VIEWS[0],
				saved: true,
				closed: true,
			});
			expect(at.closes).toEqual([{ p_view_id: VIEWS[0], p_pass: PASSES[0] }]);
		});

		it("refuses a uid outside the session range before calling anything", async () => {
			for (const uid of [199999, 524288, 0, 200000.5, Number.NaN]) {
				const at = fixture();
				expect(await failure(at.views.attach(session({ uid }), later(), live())), String(uid)).toBe(
					"CODING_FOLDER_VIEW_REQUEST_INVALID",
				);
				expect(at.events).toEqual([]);
			}
			for (const uid of [200000, 524287]) {
				const at = fixture();
				await expect(at.views.attach(session({ uid }), later(), live())).resolves.toEqual({ viewId: VIEWS[0] });
				expect(at.mounts[0]).toMatchObject({ uid, gid: uid });
			}
		});

		it("rejects with the caller's reason when the caller stops it between tries", async () => {
			const reason = new Error("the executor is stopping");
			const opening = fixture();
			const stopOpen = new AbortController();
			opening.script.openAfter = () => {
				if (opening.opens.length === 2) stopOpen.abort(reason);
				throw new CodingControlBusy();
			};
			await expect(opening.views.attach(session(), later(), stopOpen.signal)).rejects.toBe(reason);
			expect(opening.opens).toHaveLength(2);

			const mounting = fixture();
			const stopMount = new AbortController();
			mounting.script.mountAfter = () => {
				if (mounting.mounts.length === 2) stopMount.abort(reason);
				return "unanswered";
			};
			await expect(mounting.views.attach(session(), later(), stopMount.signal)).rejects.toBe(reason);
			expect(mounting.mounts).toHaveLength(2);

			// The exec failed because the caller stopped: the caller's reason, not the exec's error.
			const execing = fixture();
			const stopExec = new AbortController();
			execing.script.mount.push(() => {
				stopExec.abort(reason);
				return new Error("LXD exec stream was stopped");
			});
			await expect(execing.views.attach(session(), later(), stopExec.signal)).rejects.toBe(reason);
		});
	});

	describe("end", () => {
		it("ends the session's view with its final boundary and then its close, once", async () => {
			const at = fixture();
			await at.views.attach(session(), later(), live());
			at.events.splice(0);
			await expect(at.views.end(WORKER.toUpperCase(), live())).resolves.toEqual({
				workerId: WORKER,
				viewId: VIEWS[0],
				saved: true,
				closed: true,
			});
			expect(at.events.splice(0)).toEqual(["boundary", "close"]);
			expect(at.boundaries.at(-1)).toEqual({ machine: MACHINE, final: [VIEWS[0]] });
			expect(at.closes).toEqual([{ p_view_id: VIEWS[0], p_pass: PASSES[0] }]);
			await expect(at.views.end(WORKER, live())).resolves.toBeUndefined();
			await expect(at.views.end("not-a-uuid", live())).resolves.toBeUndefined();
			expect(at.events).toEqual([]);
			// The same attachment's next turn opens a new view.
			await expect(at.views.attach(session(), later(), live())).resolves.toEqual({ viewId: VIEWS[1] });
			expect(at.events).toEqual(["sha256sum", "boundary", "open", "mount"]);
			expect(at.boundaries.at(-1)).toEqual({ machine: MACHINE, final: [] });
		});

		it("reports the view unsaved without a released boundary and a report that saved all of it, and still closes it", async () => {
			const boundaries: [string, Boundary][] = [
				["unproven reads", (machine, final) => ({ ...released(machine, final), reads: "unproven" })],
				[
					"released reads, but paths not saved (a save with no answer yet, a denial)",
					(machine, final) => ({
						machine,
						reads: "released",
						views: final.map((viewId) => ({ viewId, unsaved: 2 })),
					}),
				],
				[
					"released reads, but a change set refused whole",
					(machine, final) => ({
						machine,
						reads: "released",
						views: final.map((viewId) => ({ viewId, unsaved: 0, refused: "denied" })),
					}),
				],
				[
					"released reads, but a view with neither a report nor an error",
					(machine, final) => ({ machine, reads: "released", views: final.map((viewId) => ({ viewId })) }),
				],
				[
					"an error instead of a report",
					(machine, final) => ({
						machine,
						reads: "released",
						views: final.map((viewId) => ({ viewId, error: "VIEW_CLOSED" })),
					}),
				],
				["no report", (machine) => ({ machine, reads: "released", views: [] })],
				["another machine's boundary", (_machine, final) => released(OTHER_MACHINE, final)],
				[
					"no answer",
					() => {
						throw new Error("CODING_FOLDER_CONTROL_UNANSWERED");
					},
				],
			];
			for (const [label, boundary] of boundaries) {
				const at = fixture();
				await at.views.attach(session(), later(), live());
				at.script.boundary = boundary;
				await expect(at.views.end(WORKER, live()), label).resolves.toEqual({
					workerId: WORKER,
					viewId: VIEWS[0],
					saved: false,
					closed: true,
				});
				expect(at.closes, label).toEqual([{ p_view_id: VIEWS[0], p_pass: PASSES[0] }]);
			}
		});

		it("reports whether the core confirmed the close, and forgets the view either way", async () => {
			const cases: [Scripted<unknown>[], number, boolean][] = [
				[[new CodingControlBusy()], 2, true],
				[[new Error("CODING_CONTROL_UNCONFIRMED")], 2, true],
				[[new CodingControlRefused("Folder view is unavailable")], 1, true],
				[[new CodingControlRefused("Folder core authority is required")], 1, false],
			];
			for (const [answers, tries, closed] of cases) {
				const at = fixture();
				await at.views.attach(session(), later(), live());
				at.script.close.push(...answers);
				await expect(at.views.end(WORKER, live())).resolves.toEqual({
					workerId: WORKER,
					viewId: VIEWS[0],
					saved: true,
					closed,
				});
				expect(at.closes).toHaveLength(tries);
				await expect(at.views.end(WORKER, live())).resolves.toBeUndefined();
			}
			// A close answer that is not one is tried again until the close's own bound, then reported unconfirmed.
			const misanswered = fixture();
			const bounded = new CodingFolderViews({ ...misanswered.options, closeMs: 50 });
			await bounded.attach(session(), later(), live());
			misanswered.script.closeAfter = { ...CLOSED, state: "open" };
			await expect(bounded.end(WORKER, live())).resolves.toMatchObject({ viewId: VIEWS[0], closed: false });
			expect(misanswered.closes.length).toBeGreaterThan(1);
			await expect(bounded.end(WORKER, live())).resolves.toBeUndefined();
		});

		it("rejects with the caller's reason once the caller stopped, keeping the view's record for a later end", async () => {
			const reason = new Error("the executor is stopping");
			const at = fixture();
			await at.views.attach(session(), later(), live());
			at.events.splice(0);
			const stopped = new AbortController();
			stopped.abort(reason);
			await expect(at.views.end(WORKER, stopped.signal)).rejects.toBe(reason);
			expect(at.events).toEqual([]);
			// Stopped during its close: one try, and the record stays.
			const stopping = new AbortController();
			at.script.close.push(() => {
				stopping.abort(reason);
				return new CodingControlBusy();
			});
			await expect(at.views.end(WORKER, stopping.signal)).rejects.toBe(reason);
			expect(at.events.splice(0)).toEqual(["boundary", "close"]);
			expect(readdirSync(at.root)).toEqual([`${WORKER}.json`]);
			await expect(at.views.end(WORKER, live())).resolves.toEqual({
				workerId: WORKER,
				viewId: VIEWS[0],
				saved: true,
				closed: true,
			});
			expect(at.events).toEqual(["boundary", "close"]);
			expect(readdirSync(at.root)).toEqual([]);
		});
	});

	describe("endMachine", () => {
		it("ends every view of the machine with one boundary and leaves other machines' views", async () => {
			const at = fixture();
			await at.views.attach(session(), later(), live());
			await at.views.attach(session({ workerId: WORKER_2, attachmentToken: TOKEN_2, uid: 200002 }), later(), live());
			await at.views.attach(
				session({ workerId: WORKER_3, attachmentToken: TOKEN_3, uid: 200003, machine: OTHER_MACHINE_BINDING }),
				later(),
				live(),
			);
			expect(at.mounts.map(({ uid }) => uid)).toEqual([200001, 200002, 200003]);
			at.events.splice(0);
			at.boundaries.splice(0);
			at.script.boundary = (machine, final) => ({
				machine,
				reads: "released",
				views: final.map((viewId) =>
					viewId === VIEWS[1] ? { viewId, error: "VIEW_CLOSED" } : { viewId, unsaved: 0 },
				),
			});
			await expect(at.views.endMachine(MACHINE.toUpperCase(), live())).resolves.toEqual([
				{ workerId: WORKER, viewId: VIEWS[0], saved: true, closed: true },
				{ workerId: WORKER_2, viewId: VIEWS[1], saved: false, closed: true },
			]);
			expect(at.events).toEqual(["boundary", "close", "close"]);
			expect(at.boundaries).toEqual([{ machine: MACHINE, final: [VIEWS[0], VIEWS[1]] }]);
			expect(at.closes.map((args) => args.p_view_id).sort()).toEqual([VIEWS[0], VIEWS[1]]);
			await expect(at.views.endMachine(MACHINE, live())).resolves.toEqual([]);
			expect(at.boundaries).toHaveLength(1);
			at.script.boundary = released;
			await expect(at.views.end(WORKER_3, live())).resolves.toEqual({
				workerId: WORKER_3,
				viewId: VIEWS[2],
				saved: true,
				closed: true,
			});
			expect(at.boundaries.at(-1)).toEqual({ machine: OTHER_MACHINE, final: [VIEWS[2]] });
		});

		it("ends nothing on a machine without views", async () => {
			const at = fixture();
			await at.views.attach(session(), later(), live());
			at.events.splice(0);
			await expect(at.views.endMachine(OTHER_MACHINE, live())).resolves.toEqual([]);
			await expect(at.views.endMachine("not-a-uuid", live())).resolves.toEqual([]);
			expect(at.events).toEqual([]);
		});
	});

	describe("records", () => {
		it("records each view it holds, until it ends: a restarted executor shows it again, or ends it", async () => {
			const at = fixture();
			await at.views.attach(session(), later(), live());
			await at.views.attach(session({ workerId: WORKER_2, attachmentToken: TOKEN_2, uid: 200002 }), later(), live());
			expect(statSync(at.root).mode & 0o7777).toBe(0o700);
			expect(readdirSync(at.root).sort()).toEqual([`${WORKER}.json`, `${WORKER_2}.json`]);
			const record = join(at.root, `${WORKER}.json`);
			expect(statSync(record).mode & 0o7777).toBe(0o600);
			expect(JSON.parse(readFileSync(record, "utf8"))).toEqual({
				schema: "qorpera.coding-folder-view-held/v1",
				workerId: WORKER,
				machineId: MACHINE,
				bootId: BOOT,
				attachmentToken: TOKEN,
				viewId: VIEWS[0],
				pass: PASSES[0],
			});
			at.events.splice(0);
			// The executor restarts: its next instance has only the records.
			const restarted = new CodingFolderViews(at.options);
			await expect(restarted.attach(session(), later(), live())).resolves.toEqual({ viewId: VIEWS[0] });
			expect(at.events.splice(0)).toEqual(["sha256sum", "mount"]);
			expect(at.mounts.at(-1)?.view).toEqual({ environmentId: ENVIRONMENT, viewId: VIEWS[0], pass: PASSES[0] });
			await expect(new CodingFolderViews(at.options).end(WORKER, live())).resolves.toEqual({
				workerId: WORKER,
				viewId: VIEWS[0],
				saved: true,
				closed: true,
			});
			expect(at.events.splice(0)).toEqual(["boundary", "close"]);
			expect(at.boundaries.at(-1)).toEqual({ machine: MACHINE, final: [VIEWS[0]] });
			expect(at.closes.at(-1)).toEqual({ p_view_id: VIEWS[0], p_pass: PASSES[0] });
			expect(readdirSync(at.root)).toEqual([`${WORKER_2}.json`]);
			await expect(new CodingFolderViews(at.options).endMachine(MACHINE, live())).resolves.toEqual([
				{ workerId: WORKER_2, viewId: VIEWS[1], saved: true, closed: true },
			]);
			expect(at.events).toEqual(["boundary", "close"]);
			expect(at.boundaries.at(-1)).toEqual({ machine: MACHINE, final: [VIEWS[1]] });
			expect(at.closes.at(-1)).toEqual({ p_view_id: VIEWS[1], p_pass: PASSES[1] });
			expect(readdirSync(at.root)).toEqual([]);
		});

		it("ends a restarted executor's old view before a new attachment's", async () => {
			const at = fixture();
			await at.views.attach(session(), later(), live());
			at.events.splice(0);
			const restarted = new CodingFolderViews(at.options);
			await expect(restarted.attach(session({ attachmentToken: TOKEN_2 }), later(), live())).resolves.toEqual({
				viewId: VIEWS[1],
				replaced: { workerId: WORKER, viewId: VIEWS[0], saved: true, closed: true },
			});
			expect(at.events).toEqual(["sha256sum", "boundary", "close", "open", "mount"]);
			expect(at.boundaries.at(-1)).toEqual({ machine: MACHINE, final: [VIEWS[0]] });
			expect(at.closes).toEqual([{ p_view_id: VIEWS[0], p_pass: PASSES[0] }]);
			expect(JSON.parse(readFileSync(join(at.root, `${WORKER}.json`), "utf8"))).toMatchObject({
				attachmentToken: TOKEN_2,
				viewId: VIEWS[1],
				pass: PASSES[1],
			});
		});

		it("names the attachment and boot a session's view was opened under, also to a restarted executor", async () => {
			const at = fixture();
			await expect(at.views.held(WORKER, live())).resolves.toBeUndefined();
			await at.views.attach(session(), later(), live());
			await at.views.attach(session({ workerId: WORKER_2, attachmentToken: TOKEN_2, uid: 200002 }), later(), live());
			at.events.splice(0);
			const restarted = new CodingFolderViews(at.options);
			await expect(restarted.held(WORKER.toUpperCase(), live())).resolves.toEqual({
				machineId: MACHINE,
				bootId: BOOT,
				attachmentToken: TOKEN,
			});
			await expect(restarted.held(WORKER_2, live())).resolves.toEqual({
				machineId: MACHINE,
				bootId: BOOT,
				attachmentToken: TOKEN_2,
			});
			await expect(restarted.held(WORKER_3, live())).resolves.toBeUndefined();
			await expect(restarted.held("not-a-uuid", live())).resolves.toBeUndefined();
			expect(at.events).toEqual([]);
			await restarted.end(WORKER, live());
			await expect(restarted.held(WORKER, live())).resolves.toBeUndefined();
			at.script.unmounted = () => true;
			expect(await failure(restarted.held(WORKER_2, live()))).toBe(RECORD_FAILED);
		});

		it("clears what a write that died left behind: a second link of its record, a half-written one", async () => {
			const at = fixture();
			await at.views.attach(session(), later(), live());
			await at.views.attach(session({ workerId: WORKER_2, attachmentToken: TOKEN_2, uid: 200002 }), later(), live());
			at.events.splice(0);
			// The executor died between a record's link and its temporary file's unlink, and in another write's middle.
			linkSync(join(at.root, `${WORKER}.json`), join(at.root, ".write-12345678-1234-4234-8234-0000000000f7"));
			writeFileSync(join(at.root, ".write-12345678-1234-4234-8234-0000000000f8"), '{"schema":"qorpera.cod');
			expect(statSync(join(at.root, `${WORKER}.json`)).nlink).toBe(2);
			const restarted = new CodingFolderViews(at.options);
			await expect(restarted.attach(session(), later(), live())).resolves.toEqual({ viewId: VIEWS[0] });
			expect(at.events.splice(0)).toEqual(["sha256sum", "mount"]);
			expect(readdirSync(at.root).sort()).toEqual([`${WORKER}.json`, `${WORKER_2}.json`]);
			expect(statSync(join(at.root, `${WORKER}.json`)).nlink).toBe(1);
			// So does a restart's end.
			linkSync(join(at.root, `${WORKER_2}.json`), join(at.root, ".write-12345678-1234-4234-8234-0000000000f9"));
			await expect(new CodingFolderViews(at.options).end(WORKER_2, live())).resolves.toEqual({
				workerId: WORKER_2,
				viewId: VIEWS[1],
				saved: true,
				closed: true,
			});
			expect(readdirSync(at.root)).toEqual([`${WORKER}.json`]);
		});

		it("closes a view it could not record, never showing it", async () => {
			const at = fixture();
			at.script.unmounted = () => at.opens.length > 0;
			expect(await failure(at.views.attach(session(), later(), live()))).toBe(RECORD_FAILED);
			expect(at.events).toEqual(["sha256sum", "boundary", "open", "close"]);
			expect(at.closes).toEqual([{ p_view_id: VIEWS[0], p_pass: PASSES[0] }]);
			expect(at.mounts).toEqual([]);
		});

		it("fails closed while the storage is unmounted, and ends the view once it is back", async () => {
			const at = fixture();
			await at.views.attach(session(), later(), live());
			at.events.splice(0);
			at.boundaries.splice(0);
			at.script.unmounted = () => true;
			expect(await failure(at.views.attach(session(), later(), live()))).toBe(RECORD_FAILED);
			expect(at.events.splice(0)).toEqual(["sha256sum"]);
			expect(await failure(at.views.end(WORKER, live()))).toBe(RECORD_FAILED);
			expect(at.events.splice(0)).toEqual([]);
			// A machine's end still saves what its views have pending, before it rejects.
			expect(await failure(at.views.endMachine(MACHINE, live()))).toBe(RECORD_FAILED);
			expect(at.events.splice(0)).toEqual(["boundary"]);
			expect(at.boundaries).toEqual([{ machine: MACHINE, final: [] }]);
			expect(at.closes).toEqual([]);
			at.script.unmounted = () => false;
			await expect(at.views.end(WORKER, live())).resolves.toMatchObject({ viewId: VIEWS[0], closed: true });
		});

		it("fails closed on a record that is not one", async () => {
			const valid = {
				schema: "qorpera.coding-folder-view-held/v1",
				workerId: WORKER,
				machineId: MACHINE,
				bootId: BOOT,
				attachmentToken: TOKEN,
				viewId: VIEWS[0],
				pass: PASSES[0],
			};
			const { pass: _, ...passless } = valid;
			const { bootId: __, ...bootless } = valid;
			const records: [string, string, number][] = [
				["not JSON", "{", 0o600],
				["another schema", JSON.stringify({ ...valid, schema: "qorpera.coding-folder-view-held/v2" }), 0o600],
				["another session's", JSON.stringify({ ...valid, workerId: WORKER_2 }), 0o600],
				["an extra key", JSON.stringify({ ...valid, extra: true }), 0o600],
				["no pass", JSON.stringify(passless), 0o600],
				["no boot", JSON.stringify(bootless), 0o600],
				["a pass that is not one", JSON.stringify({ ...valid, pass: "A".repeat(42) }), 0o600],
				["an id not in lower case", JSON.stringify({ ...valid, viewId: VIEWS[0].toUpperCase() }), 0o600],
				["readable by others", JSON.stringify(valid), 0o644],
			];
			for (const [label, text, mode] of records) {
				const at = fixture();
				await at.views.endMachine(OTHER_MACHINE, live());
				writeFileSync(join(at.root, `${WORKER}.json`), text);
				chmodSync(join(at.root, `${WORKER}.json`), mode);
				expect(await failure(at.views.end(WORKER, live())), label).toBe(RECORD_FAILED);
				expect(await failure(at.views.attach(session(), later(), live())), label).toBe(RECORD_FAILED);
				expect(await failure(at.views.endMachine(MACHINE, live())), label).toBe(RECORD_FAILED);
				expect(at.events, label).toEqual(["sha256sum", "boundary"]);
				expect(at.opens, label).toEqual([]);
				expect(at.closes, label).toEqual([]);
			}
		});

		it("refuses records anywhere but an absolute, normal folder below /", () => {
			const { options } = fixture();
			for (const root of ["", "relative/folder-views", "/srv/../folder-views", "/srv/folder-views/", "/", 7])
				expect(
					() => new CodingFolderViews({ ...options, records: { root: root as string } }),
					String(root),
				).toThrow("Invalid coding folder view records");
		});
	});

	it("refuses an empty agent or folder program", () => {
		const { options } = fixture();
		for (const scope of [
			{ agent: Buffer.alloc(0) },
			{ program: Buffer.alloc(0) },
			{ program: "the folder program" as unknown as Buffer },
		])
			expect(() => new CodingFolderViews({ ...options, ...scope })).toThrow("Invalid coding folder program");
	});
});
