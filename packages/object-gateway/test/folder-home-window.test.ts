import { chmod, mkdtemp, realpath, rm } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createControlServer } from "../src/folder-service/control.ts";
import { DESKTOP_QUIET_MS } from "../src/folder-service/mounts.ts";
import { NasObjects } from "../src/folder-service/objects.ts";
import type { BridgeInfo, Hello } from "../src/folder-service/protocol.ts";
import type { SecretSet } from "../src/folder-service/secret-scan.ts";
import { FolderService, type MachineBoundary, type ViewHandle } from "../src/folder-service/service.ts";
import { FolderStaging } from "../src/folder-service/staging.ts";
import type { CommandWindow, CreditedUnit } from "../src/folder-service/windows.ts";
import {
	CODING,
	ENV,
	EXEC_HOST,
	FakeCore,
	FakeUploads,
	folder,
	hashOf,
	MEMBER,
	OFFICE,
	PLACEMENT,
	PROFILE,
	storeFile,
	TEST_MACHINE,
	testGrants,
} from "./folder-service-fixtures.ts";

/** Home windows on the folder (20260930754000, the agent's home slice 3: lanes/agent-box-20261113/HOME-PLAN.md). A home
 * machine mounts a window that belongs to one run. The relay opens and closes a call on a window over the control
 * socket, and what that window saves while the call is open is credited to the call, and so carries the call's own
 * receipt. The core holds one open window per machine, but this service may hold two views of one home at once (the
 * window a new open superseded keeps what it had pending until its last boundary), so a call on one must credit
 * nothing of the other's: its windows are kept under the view's own id, never the machine's. */
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const WINDOW_A = "40bb0001-0000-4a00-8b00-000000000001";
const PASS_A = "homepass_0123456789-abcdefghijklmnopqrstuvw";
const WINDOW_B = "40bb0002-0000-4a00-8b00-000000000002";
const PASS_B = "homepass_9876543210-zyxwvutsrqponmlkjihgfed";
const AT_HOME: BridgeInfo = { cid: 95, lookup: "found", machine: TEST_MACHINE };
const CALL_ONE = "ca110001-0000-4a00-8b00-000000000001";
const CALL_TWO = "ca110002-0000-4a00-8b00-000000000002";
const CALL_B = "ca110003-0000-4a00-8b00-000000000003";
const RUN_A = "a0aa0000-0000-4a00-8b00-00000000000a";
const RUN_B = "a0aa0000-0000-4a00-8b00-00000000000b";
const AGENT = "a6e70000-0000-4a00-8b00-000000000001";

const callOf = (callId: string, runId = RUN_A): CommandWindow => ({
	commandId: callId,
	runId,
	staffAgentId: AGENT,
	requestedByUserId: MEMBER,
});

/** A company folder with one file and two home windows on one home machine: the one a new open superseded, and the new
 * one, as the service holds them between the open and that window's last boundary. */
async function home() {
	const root = await mkdtemp(join(tmpdir(), "qorpera-folder-home-window-"));
	const core = new FakeCore();
	core.seed([folder("docs"), await storeFile(root, "docs/plan.md", "the plan", 1)]);
	core.openView(WINDOW_A, PASS_A, { kind: "home_window", machineId: PLACEMENT });
	core.openView(WINDOW_B, PASS_B, { kind: "home_window", machineId: PLACEMENT });
	const objects = new NasObjects({ root, cacheBytes: 64 * 1024 * 1024 });
	const service = new FolderService({
		core,
		objects,
		grants: testGrants(),
		staging: new FolderStaging(core, new FakeUploads(root, core), objects),
		log: () => undefined,
	});
	const handles: ViewHandle[] = [];
	cleanups.push(async () => {
		for (const h of handles) h.release();
		service.stop();
		await rm(root, { recursive: true, force: true });
	});
	const open = async (viewId: string, pass: string, bridge: BridgeInfo = AT_HOME) => {
		const hello: Hello = { protocol: 3, environmentId: ENV, viewId, pass, role: "io" };
		const handle = await service.open(hello, bridge);
		handles.push(handle);
		return handle;
	};
	return { root, core, service, open };
}

/** A small file, written as the folder program writes it: opened with truncate, its one chunk, closed. */
async function write(view: ViewHandle, path: string, text: string): Promise<void> {
	const { handle } = await view.open({ path, create: true, exclusive: false, truncate: true });
	const data = Buffer.from(text);
	await view.chunk({ handle, index: 0, sha256: hashOf(data), bytes: data.byteLength, offset: 0, data });
	await view.close(handle, data.byteLength);
}

/** One connection to the control socket: the lines sent, then each answer (folder-coding-views.test.ts). */
const ask = (path: string, text: string) =>
	new Promise<unknown[]>((resolve, reject) => {
		const socket = connect(path);
		let answer = "";
		const done = () =>
			resolve(
				answer
					.split("\n")
					.filter((line) => line !== "")
					.map((line) => JSON.parse(line)),
			);
		socket.setEncoding("utf8");
		socket.on("data", (part: string) => {
			answer += part;
		});
		socket.on("end", done);
		socket.on("error", (error) => (answer === "" ? reject(error) : done()));
		socket.end(text);
	});

/** Each unit of a commit: the path it publishes, and the calls it is credited to. */
const creditsOf = (commit: FakeCore["commits"][number] | undefined) =>
	commit?.units.map((u) => [u.op === "move" ? u.to : u.path, (u as CreditedUnit).credits]);

describe("home windows", () => {
	it("serves a run's window to its own home machine alone", async () => {
		const window = { kind: "home_window", companyId: PROFILE, codingMachineId: null };
		expect(testGrants().coreAccess({ ...window, machineId: PLACEMENT })).toMatchObject({
			write: true,
			quietMs: DESKTOP_QUIET_MS,
			machine: PLACEMENT,
			homeWindow: true,
		});
		// A window of no machine is served nowhere, and no window is a test machine's company-wide view.
		expect(testGrants().coreAccess({ ...window, machineId: null })).toBeUndefined();
		expect(testGrants().coreAccess({ ...window, machineId: PLACEMENT })).not.toMatchObject({ testMachine: true });
		const { open } = await home();
		const at = (machine: BridgeInfo["machine"], cid: number): BridgeInfo => ({ cid, lookup: "found", machine });
		const otherMachine = at({ ...TEST_MACHINE, name: `qorpera-machine-${"f".repeat(32)}` }, 97);
		for (const bridge of [otherMachine, at(OFFICE, 90), at(CODING, 91), at(EXEC_HOST, 77)])
			await expect(open(WINDOW_A, PASS_A, bridge)).rejects.toMatchObject({ code: "VIEW_REFUSED" });
		const view = await open(WINDOW_A, PASS_A);
		expect(view.writable).toBe(true);
	});

	it("credits what a window saves while a call is open to that call, and nothing of the other window's", async () => {
		const { core, service, open } = await home();
		const a = await open(WINDOW_A, PASS_A);
		const b = await open(WINDOW_B, PASS_B);
		service.openCall(WINDOW_A, callOf(CALL_ONE));
		// Opened again it changes nothing; the same call with other ids is refused.
		service.openCall(WINDOW_A, callOf(CALL_ONE));
		expect(() => service.openCall(WINDOW_A, { ...callOf(CALL_ONE), runId: RUN_B })).toThrow(/open with other ids/);
		// The other window has its own call: it credits nothing of this window's changes.
		service.openCall(WINDOW_B, callOf(CALL_B, RUN_B));
		await write(a, "docs/one.txt", "1");
		await write(b, "docs/b.txt", "b");
		service.openCall(WINDOW_A, callOf(CALL_TWO));
		await write(a, "docs/two.txt", "2");
		// Closing the call answers once what the home published; the window's own changes carry its own calls.
		const boundary = await service.closeCall(WINDOW_A, CALL_ONE);
		expect(boundary.machine).toBe(PLACEMENT);
		expect(boundary.reads).toBe("released");
		// The commits are told apart by what they publish: each window saves its own changes.
		const commitWith = (path: string) =>
			core.commits.find((commit) => commit.units.some((unit) => unit.op !== "move" && unit.path === path));
		expect(creditsOf(commitWith("docs/one.txt"))).toEqual([
			["docs/one.txt", [CALL_ONE]],
			["docs/two.txt", [CALL_ONE, CALL_TWO]],
		]);
		expect(creditsOf(commitWith("docs/b.txt"))).toEqual([["docs/b.txt", [CALL_B]]]);
		// With no call open, the change is the run's own alone and credits nothing.
		await service.closeCall(WINDOW_A, CALL_TWO);
		await write(a, "docs/three.txt", "3");
		await service.boundary(PLACEMENT, []);
		expect(creditsOf(commitWith("docs/three.txt"))).toEqual([["docs/three.txt", undefined]]);
	});

	it("takes the relay's call-open and call-close over the control socket, and says what a bad one is", async () => {
		// Under /tmp (root's, sticky), not $TMPDIR: every folder above the socket counts (folder-coding-views.test.ts).
		const dir = await realpath(await mkdtemp("/tmp/qhw-"));
		cleanups.push(() => rm(dir, { recursive: true, force: true }));
		const path = join(dir, "control.sock");
		const uid = process.getuid?.() ?? 0;
		const opened: [string, CommandWindow][] = [];
		const closed: [string, string][] = [];
		const target = {
			boundary: async (machine: string): Promise<MachineBoundary> => ({ machine, reads: "released", views: [] }),
			restarted: () => false,
			openWindow: () => undefined,
			closeWindow: async (machine: string): Promise<MachineBoundary> => ({ machine, reads: "released", views: [] }),
			openCall: (viewId: string, window: CommandWindow) => {
				opened.push([viewId, window]);
			},
			closeCall: async (viewId: string, callId: string): Promise<MachineBoundary> => {
				closed.push([viewId, callId]);
				return { machine: PLACEMENT, reads: "released", views: [] };
			},
			secrets: (_machine: string, set: SecretSet) => set.size,
		};
		const server = createControlServer({ target, path, executorUid: uid, log: () => undefined });
		await new Promise<void>((resolve) => server.listen(path, resolve));
		cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
		await chmod(path, 0o600);
		const call = { callId: CALL_ONE, runId: RUN_A, staffAgentId: AGENT, requestedByUserId: MEMBER };
		const answers = await ask(
			path,
			[
				{ op: "call-open", window: WINDOW_A, ...call },
				{ op: "call-close", window: WINDOW_A, callId: CALL_ONE },
				{ op: "call-open", window: "not-a-view", ...call },
				{ op: "call-close", window: WINDOW_A, callId: "not-a-call" },
				{ op: "call-open", window: WINDOW_A, callId: CALL_ONE, runId: RUN_A },
				{ op: "call-open", window: WINDOW_A, ...call, extra: 1 },
			]
				.map((request) => `${JSON.stringify(request)}\n`)
				.join(""),
		);
		expect(answers).toEqual([
			{ opened: { window: WINDOW_A, callId: CALL_ONE } },
			{ boundary: { machine: PLACEMENT, reads: "released", views: [] } },
			{ error: { code: "BAD_REQUEST", message: "window is a home window's view id" } },
			{ error: { code: "BAD_REQUEST", message: "callId is a call's id" } },
			{ error: { code: "BAD_REQUEST", message: "staffAgentId is an agent's id" } },
			{
				error: {
					code: "BAD_REQUEST",
					message: "A call-open request is {op, window, callId, runId, staffAgentId, requestedByUserId}",
				},
			},
		]);
		expect(opened).toEqual([[WINDOW_A, callOf(CALL_ONE)]]);
		expect(closed).toEqual([[WINDOW_A, CALL_ONE]]);
	});

	it("refuses a call on a view that is no open window of this service", async () => {
		const { service, open } = await home();
		await open(WINDOW_A, PASS_A);
		const unknown = "40bb0009-0000-4a00-8b00-000000000009";
		expect(() => service.openCall(unknown, callOf(CALL_ONE))).toThrow(/no open home window/);
		await expect(service.closeCall(unknown, CALL_ONE)).rejects.toMatchObject({ code: "VIEW_CLOSED" });
	});
});
