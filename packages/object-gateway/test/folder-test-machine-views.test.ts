import { chmod, mkdtemp, realpath, rm } from "node:fs/promises";
import { connect, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createControlServer } from "../src/folder-service/control.ts";
import { DESKTOP_QUIET_MS, MountGrants } from "../src/folder-service/mounts.ts";
import { NasObjects } from "../src/folder-service/objects.ts";
import { CHUNK_BYTES } from "../src/folder-service/pending.ts";
import type { BridgeInfo, Hello } from "../src/folder-service/protocol.ts";
import { FolderService, type ViewHandle } from "../src/folder-service/service.ts";
import { FolderStaging } from "../src/folder-service/staging.ts";
import { type CommandWindow, type CreditedUnit, CreditTags, STARTER } from "../src/folder-service/windows.ts";
import {
	CODING,
	CODING_PROJECT,
	ENV,
	EXEC_HOST,
	FakeCore,
	FakeUploads,
	folder,
	hashOf,
	MEMBER,
	OFFICE,
	OFFICE_PROJECT,
	PLACEMENT,
	PROFILE,
	storeFile,
	TEST_MACHINE,
	TEST_PROJECT,
	testGrants,
} from "./folder-service-fixtures.ts";

/** Test machine views on the folder (F3 step 6, slice 6b: deploy/first-node/RUNTIME-FOLDER-TEST-MACHINES.md): a test
 * machine's view is served to its own instance alone, named after its placement, and publishes after a quiet period.
 * The executor opens and closes the machine's command windows over the control socket: what the machine changes while
 * windows are open is credited to their commands, and what it changes while none is open is the starter's. Closing a
 * window answers once the machine's boundary did; the view's last boundary is final. */
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const TEST_VIEW = "7e57f1e0-0001-4a00-8b00-000000000001";
const PASS = "testpass_0123456789-abcdefghijklmnopqrstuvw";
const AT_TEST: BridgeInfo = { cid: 95, lookup: "found", machine: TEST_MACHINE };
const FIRST = "c0aa0001-0000-4a00-8b00-000000000001";
const SECOND = "c0aa0002-0000-4a00-8b00-000000000002";
const RUN = "a0aa0000-0000-4a00-8b00-000000000001";
const AGENT = "a6e70000-0000-4a00-8b00-000000000001";
const REFUSED = "This socket admits only the executor of the coding and test machines";

const windowOf = (commandId: string): CommandWindow => ({
	commandId,
	runId: RUN,
	staffAgentId: AGENT,
	requestedByUserId: MEMBER,
});

/** A company folder with one file, a test machine's view, and the node's service with its test machine project
 * configured. */
async function company() {
	const root = await mkdtemp(join(tmpdir(), "qorpera-folder-test-machine-"));
	const core = new FakeCore();
	core.seed([folder("docs"), await storeFile(root, "docs/plan.md", "the plan", 1)]);
	core.openView(TEST_VIEW, PASS, { kind: "test_machine", machineId: PLACEMENT });
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
	const open = async (bridge: BridgeInfo = AT_TEST) => {
		const hello: Hello = { protocol: 3, environmentId: ENV, viewId: TEST_VIEW, pass: PASS, role: "io" };
		const handle = await service.open(hello, bridge);
		handles.push(handle);
		return handle;
	};
	return { root, core, objects, service, open };
}

/** A small file, written as the folder program writes it: opened with truncate, its one chunk, closed. */
async function write(view: ViewHandle, path: string, text: string): Promise<void> {
	const { handle } = await view.open({ path, create: true, exclusive: false, truncate: true });
	const data = Buffer.from(text);
	await view.chunk({ handle, index: 0, sha256: hashOf(data), bytes: data.byteLength, offset: 0, data });
	await view.close(handle, data.byteLength);
}

/** Each unit of a commit: the path it publishes, and the commands it is credited to. */
const creditsOf = (commit: FakeCore["commits"][number] | undefined) =>
	commit?.units.map((u) => [u.op === "move" ? u.to : u.path, (u as CreditedUnit).credits]);
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(done: () => boolean, ms = 3_000): Promise<void> {
	for (const end = Date.now() + ms; !done() && Date.now() < end; ) await wait(10);
	expect(done()).toBe(true);
}

describe("test machine views", () => {
	it("serves a test machine's view to its own instance alone", async () => {
		const test = { kind: "test_machine", companyId: PROFILE, codingMachineId: null };
		expect(testGrants().coreAccess({ ...test, machineId: PLACEMENT })).toMatchObject({
			write: true,
			quietMs: DESKTOP_QUIET_MS,
			machine: PLACEMENT,
			testMachine: true,
		});
		expect(testGrants().coreAccess({ ...test, machineId: null })).toBeUndefined();
		// A project listed as a test machine project and as an office or coding project too is refused at start.
		expect(() => new MountGrants([], [EXEC_HOST], [TEST_PROJECT], [], [TEST_PROJECT])).toThrow(/too/);
		expect(() => new MountGrants([], [EXEC_HOST], [OFFICE_PROJECT], [TEST_PROJECT], [TEST_PROJECT])).toThrow(/too/);
		expect(() => new MountGrants([], [EXEC_HOST], [OFFICE_PROJECT], [CODING_PROJECT], [TEST_PROJECT])).not.toThrow();
		const { open } = await company();
		const at = (machine: BridgeInfo["machine"], cid: number): BridgeInfo => ({ cid, lookup: "found", machine });
		const otherMachine = at({ ...TEST_MACHINE, name: `qorpera-machine-${"f".repeat(32)}` }, 97);
		const builder = at({ ...TEST_MACHINE, name: `qorpera-machine-build-${"a".repeat(32)}` }, 98);
		const unlisted = at({ ...TEST_MACHINE, project: "qn25b2-machines-old" }, 99);
		// Not another test machine, an office, a coding machine, an image builder, a test machine of that name in a
		// project the node does not list, or the execution host.
		for (const bridge of [otherMachine, at(OFFICE, 90), at(CODING, 91), builder, unlisted, at(EXEC_HOST, 77)])
			await expect(open(bridge)).rejects.toMatchObject({ code: "VIEW_REFUSED" });
		const view = await open();
		expect(view.writable).toBe(true);
		await expect(open(otherMachine)).rejects.toMatchObject({ code: "VIEW_REFUSED" });
	});

	it("credits a change made in one window to its command, in two to both, and in none to the starter", async () => {
		const { core, service, open } = await company();
		const view = await open();
		service.openWindow(PLACEMENT, windowOf(FIRST));
		// Opened again, it changes nothing.
		service.openWindow(PLACEMENT, windowOf(FIRST));
		expect(() => service.openWindow(PLACEMENT, { ...windowOf(FIRST), runId: AGENT })).toThrow(/open with other ids/);
		await write(view, "docs/one.txt", "1");
		service.openWindow(PLACEMENT, windowOf(SECOND));
		await write(view, "docs/two.txt", "2");
		// Closing a window answers once what the machine changed until then is published.
		expect(await service.closeWindow(PLACEMENT, FIRST)).toMatchObject({
			machine: PLACEMENT,
			reads: "released",
			views: [
				{
					viewId: TEST_VIEW,
					report: {
						commitId: expect.any(String),
						paths: [
							{ path: "docs/one.txt", outcome: "saved" },
							{ path: "docs/two.txt", outcome: "saved" },
						],
					},
				},
			],
		});
		expect(core.commits).toHaveLength(1);
		expect(creditsOf(core.commits[0])).toEqual([
			["docs/one.txt", [FIRST]],
			["docs/two.txt", [FIRST, SECOND]],
		]);
		await write(view, "docs/three.txt", "3");
		await service.closeWindow(PLACEMENT, SECOND);
		expect(creditsOf(core.commits[1])).toEqual([["docs/three.txt", [SECOND]]]);
		// No window is open: the change is the starter's, and its unit names no command.
		await write(view, "docs/four.txt", "4");
		await service.boundary(PLACEMENT);
		expect(creditsOf(core.commits[2])).toEqual([["docs/four.txt", undefined]]);
		expect(core.commits[2]?.units[0]).not.toHaveProperty("credits");
		expect(core.commits.map((c) => c.final)).toEqual([false, false, false]);
	});

	it("keeps a renamed path's credits; a unit mixing the starter's changes with a command's is the command's", async () => {
		const { core, service, open } = await company();
		const view = await open();
		service.openWindow(PLACEMENT, windowOf(FIRST));
		await write(view, "docs/draft.txt", "d");
		// The pause refuses the window's boundary whole: what it carried stays pending.
		core.commitRefusal = "stopped";
		expect(await service.closeWindow(PLACEMENT, FIRST)).toMatchObject({
			views: [
				{ report: { refused: "stopped", paths: [{ path: "docs/draft.txt", outcome: "refused", kept: true }] } },
			],
		});
		core.commitRefusal = undefined;
		// Renamed with no window open: the starter's rename of the command's file.
		await view.rename({ from: "docs/draft.txt", to: "docs/final.txt", noReplace: false });
		await service.boundary(PLACEMENT);
		expect(creditsOf(core.commits.at(-1))).toEqual([["docs/final.txt", [FIRST]]]);
		expect(core.entries.get("docs/final.txt")?.fileSha256).toBe(hashOf("d"));
	});

	it("sends a unit asked again with the credits it was first asked with", async () => {
		const { core, service, open } = await company();
		const view = await open();
		service.openWindow(PLACEMENT, windowOf(FIRST));
		await write(view, "docs/once.txt", "o");
		// Every answer is lost: the boundary is asked again, under its key, at the next.
		core.commitFailures = { mode: "lost", count: 3 };
		const lost = await service.closeWindow(PLACEMENT, FIRST);
		expect(lost.views[0]?.report?.commitId).toBeNull();
		service.openWindow(PLACEMENT, windowOf(SECOND));
		expect(await service.boundary(PLACEMENT)).toMatchObject({
			views: [{ report: { paths: [{ path: "docs/once.txt", outcome: "saved" }] } }],
		});
		expect(core.commits).toHaveLength(4);
		expect(new Set(core.commits.map((c) => c.key)).size).toBe(1);
		for (const commit of core.commits) expect(creditsOf(commit)).toEqual([["docs/once.txt", [FIRST]]]);
	});

	it("refuses a unit credited to an ended command as any other, and never credits it to the starter", async () => {
		const { core, service, open } = await company();
		const view = await open();
		service.openWindow(PLACEMENT, windowOf(FIRST));
		await write(view, "docs/late.txt", "l");
		core.endedCommands.add(FIRST);
		expect(await service.closeWindow(PLACEMENT, FIRST)).toMatchObject({
			views: [{ report: { paths: [{ path: "docs/late.txt", outcome: "refused", reason: "command_ended" }] } }],
		});
		// Its bytes stay pending, so the next boundary sends it again, credited the same, and it is refused again.
		await service.boundary(PLACEMENT);
		expect(core.commits.map(creditsOf)).toEqual([[["docs/late.txt", [FIRST]]], [["docs/late.txt", [FIRST]]]]);
		expect(core.entries.has("docs/late.txt")).toBe(false);
	});

	it("credits the removal of a renamed file, published at its origin, to the command that removed it", async () => {
		const { root, core, service, open } = await company();
		core.seed([await storeFile(root, "docs/notes.md", "the notes", 2)]);
		const view = await open();
		service.openWindow(PLACEMENT, windowOf(FIRST));
		// Renamed, then unlinked before the boundary: what is published is the removal of the origin.
		await view.rename({ from: "docs/plan.md", to: "docs/moved.md", noReplace: false });
		await view.unlink("docs/moved.md", undefined);
		// Renamed, then replaced by a rename over it: likewise.
		await view.rename({ from: "docs/notes.md", to: "docs/old.md", noReplace: false });
		await write(view, "docs/new.md", "n");
		await view.rename({ from: "docs/new.md", to: "docs/old.md", noReplace: false });
		await service.closeWindow(PLACEMENT, FIRST);
		expect(core.commits.map(creditsOf)).toEqual([
			[
				["docs/plan.md", [FIRST]],
				["docs/notes.md", [FIRST]],
				["docs/old.md", [FIRST]],
			],
		]);
		expect([...core.entries.keys()].sort()).toEqual(["docs", "docs/old.md"]);
	});

	it("credits a cut to the windows open as the machine closed the file, not as its origin's bytes came", async () => {
		const { root, core, objects, service, open } = await company();
		core.seed([await storeFile(root, "docs/log.txt", "lines", 2, CHUNK_BYTES)]);
		const view = await open();
		service.openWindow(PLACEMENT, windowOf(FIRST));
		const { handle } = await view.open({ path: "docs/log.txt", create: false, exclusive: false, truncate: false });
		// Cut to nothing, the file takes its origin's bytes first; their manifest is held while the windows change.
		let reached!: () => void;
		const reading = new Promise<void>((resolve) => {
			reached = resolve;
		});
		let release!: () => void;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		const read = objects.manifestChunks.bind(objects);
		objects.manifestChunks = async (...args) => {
			objects.manifestChunks = read;
			reached();
			await held;
			return read(...args);
		};
		const closing = view.close(handle, 0);
		await reading;
		service.openWindow(PLACEMENT, windowOf(SECOND));
		await service.closeWindow(PLACEMENT, FIRST);
		release();
		await closing;
		await service.closeWindow(PLACEMENT, SECOND);
		expect(core.commits.map(creditsOf)).toEqual([[["docs/log.txt", [FIRST]]]]);
		expect(core.entries.get("docs/log.txt")?.fileSha256).toBe(hashOf(""));
	});

	it("forgets an undone change's credits, so what is made there next is credited to its maker alone", async () => {
		const { core, service, open } = await company();
		const view = await open();
		service.openWindow(PLACEMENT, windowOf(FIRST));
		// A file made and removed again, and a rename moved back: nothing is left to publish.
		await write(view, "docs/scratch.txt", "s");
		await view.unlink("docs/scratch.txt", undefined);
		await view.rename({ from: "docs/plan.md", to: "docs/tmp.md", noReplace: false });
		await view.rename({ from: "docs/tmp.md", to: "docs/plan.md", noReplace: false });
		await service.closeWindow(PLACEMENT, FIRST);
		expect(core.commits).toEqual([]);
		// The command ended; the next makes both paths again, and its units name it alone.
		core.endedCommands.add(FIRST);
		service.openWindow(PLACEMENT, windowOf(SECOND));
		await write(view, "docs/scratch.txt", "t");
		await write(view, "docs/plan.md", "v2");
		await service.closeWindow(PLACEMENT, SECOND);
		expect(core.commits.map(creditsOf)).toEqual([
			[
				["docs/plan.md", [SECOND]],
				["docs/scratch.txt", [SECOND]],
			],
		]);
		expect(core.entries.get("docs/scratch.txt")?.fileSha256).toBe(hashOf("t"));
		expect(core.entries.get("docs/plan.md")?.fileSha256).toBe(hashOf("v2"));
	});

	it("publishes a test machine's view about 2 s after its last change", async () => {
		const { core, open } = await company();
		const view = await open();
		await write(view, "docs/quiet.txt", "q");
		await wait(DESKTOP_QUIET_MS / 2);
		await write(view, "docs/again.txt", "a");
		// The second change started the quiet period again.
		await wait(DESKTOP_QUIET_MS / 2 + 300);
		expect(core.commits).toEqual([]);
		await until(() => core.commits.length === 1, DESKTOP_QUIET_MS * 2);
		expect(creditsOf(core.commits[0])).toEqual([
			["docs/quiet.txt", undefined],
			["docs/again.txt", undefined],
		]);
		expect(core.commits[0]?.final).toBe(false);
	});

	it("sends a test machine's last boundary final, which closes its view, and no quiet boundary after it", async () => {
		const { core, service, open } = await company();
		const view = await open();
		service.openWindow(PLACEMENT, windowOf(FIRST));
		await write(view, "docs/last.txt", "l");
		expect(await service.boundary(PLACEMENT, [TEST_VIEW])).toMatchObject({
			machine: PLACEMENT,
			views: [
				{
					viewId: TEST_VIEW,
					report: {
						commitId: expect.any(String),
						closed: true,
						paths: [{ path: "docs/last.txt", outcome: "saved" }],
					},
				},
			],
		});
		expect(core.commits.map((c) => c.final)).toEqual([true]);
		expect(creditsOf(core.commits[0])).toEqual([["docs/last.txt", [FIRST]]]);
		expect(core.views.get(TEST_VIEW)?.state).toBe("closed");
		await wait(DESKTOP_QUIET_MS + 500);
		expect(core.commits).toHaveLength(1);
	});
});

describe("credit tags", () => {
	it("moves a renamed path's tags and those under it, and forgets what is no longer pending", () => {
		const tags = new CreditTags();
		tags.tag(["build/out.txt", "build/lib/a.js"], [FIRST]);
		tags.tag(["dist/old.txt"], [SECOND]);
		tags.rename("build", "dist", [STARTER]);
		expect(tags.credits(["dist/out.txt"])).toEqual([FIRST]);
		expect(tags.credits(["dist/lib/a.js"])).toEqual([FIRST]);
		// The renamed folder itself is the starter's alone; what it replaced is gone.
		expect(tags.credits(["dist"])).toBeUndefined();
		expect(tags.credits(["dist/old.txt", "build/out.txt"])).toBeUndefined();
		tags.tag(["dist/out.txt"], [SECOND]);
		expect(tags.credits(["dist/out.txt", "dist"])).toEqual([FIRST, SECOND]);
		tags.prune(["dist/out.txt"]);
		expect(tags.credits(["dist/lib/a.js"])).toBeUndefined();
		expect(tags.credits(["dist/out.txt"])).toEqual([FIRST, SECOND]);
	});

	it("gives a moved path's removal to its origin, and forgets a path left with nothing pending", () => {
		const tags = new CreditTags();
		tags.rename("docs/a.md", "docs/b.md", [FIRST]);
		// docs/b.md, moved from docs/a.md, is unlinked: its removal is docs/a.md's.
		tags.carry("docs/b.md", "docs/a.md", [SECOND]);
		tags.forget("docs/b.md", () => false);
		expect(tags.credits(["docs/a.md"])).toEqual([FIRST, SECOND]);
		expect(tags.credits(["docs/b.md"])).toBeUndefined();
		// A path still pending keeps its tags; so does one also tagged at another spelling, until a boundary prunes it.
		tags.tag(["docs/new.txt"], [FIRST]);
		tags.forget("docs/new.txt", () => true);
		expect(tags.credits(["docs/new.txt"])).toEqual([FIRST]);
		tags.tag(["docs/X.txt"], [FIRST]);
		tags.tag(["docs/x.txt"], [SECOND]);
		tags.forget("docs/x.txt", () => false);
		expect(tags.credits(["docs/X.txt"])).toEqual([FIRST, SECOND]);
		tags.prune(["docs/a.md"]);
		expect(tags.credits(["docs/new.txt", "docs/x.txt"])).toBeUndefined();
		expect(tags.credits(["docs/a.md"])).toEqual([FIRST, SECOND]);
		// A rename keeps the spelling its tags were taken at.
		tags.tag(["build/out.txt"], [SECOND]);
		tags.rename("build", "dist", [STARTER]);
		expect(tags.credits(["dist/out.txt"])).toEqual([SECOND]);
		tags.forget("dist/out.txt", () => false);
		expect(tags.credits(["dist/out.txt"])).toBeUndefined();
	});
});

describe("the control socket's command windows", () => {
	/** One connection: the lines sent, then its side ends, and each answer until the service ended its side. */
	const ask = (path: string, lines: readonly unknown[]) =>
		new Promise<unknown[]>((resolve, reject) => {
			const socket = connect(path);
			let answer = "";
			const done = () =>
				resolve(
					answer
						.split("\n")
						.filter((l) => l !== "")
						.map((l) => JSON.parse(l)),
				);
			socket.setEncoding("utf8");
			socket.on("data", (part: string) => {
				answer += part;
			});
			socket.on("end", done);
			socket.on("error", (error) => (answer === "" ? reject(error) : done()));
			socket.end(lines.map((line) => `${JSON.stringify(line)}\n`).join(""));
		});
	const bad = (message: string) => ({ error: { code: "BAD_REQUEST", message } });

	it("opens and closes a test machine's windows for the executor alone, and refuses a malformed request", async () => {
		const { core, service, open } = await company();
		const view = await open();
		// Under /tmp (root's, sticky), not $TMPDIR: every folder above the socket counts.
		const dir = await realpath(await mkdtemp("/tmp/qft-"));
		cleanups.push(() => rm(dir, { recursive: true, force: true }));
		const path = join(dir, "control.sock");
		const uid = process.getuid?.() ?? 0;
		const close = (server: Server) => new Promise<void>((resolve) => server.close(() => resolve()));
		const listen = async (executorUid: number) => {
			await rm(path, { force: true });
			const server = createControlServer({ target: service, path, executorUid, log: () => undefined });
			await new Promise<void>((resolve) => server.listen(path, resolve));
			cleanups.push(() => close(server));
			await chmod(path, 0o600);
			return server;
		};
		const opening = { op: "open", machine: PLACEMENT, ...windowOf(FIRST) };
		const closing = { op: "close", machine: PLACEMENT, commandId: FIRST };

		// A peer that is not the executor opens and closes nothing.
		const server = await listen(uid + 1);
		const refused = { error: { code: "VIEW_REFUSED", message: REFUSED } };
		expect(await ask(path, [opening, closing])).toEqual([refused]);
		await write(view, "docs/before.txt", "b");
		await service.boundary(PLACEMENT);
		expect(creditsOf(core.commits.at(-1))).toEqual([["docs/before.txt", undefined]]);
		await close(server);

		await listen(uid);
		const opened = { opened: { machine: PLACEMENT, commandId: FIRST } };
		const answers = await ask(path, [
			opening,
			opening,
			{ ...opening, runId: AGENT },
			{ op: "open", machine: PLACEMENT, commandId: FIRST },
			{ ...opening, final: [] },
			{ ...opening, machine: TEST_MACHINE.name },
			{ ...opening, staffAgentId: "agent-1" },
		]);
		expect(answers).toEqual([
			opened,
			opened,
			bad(`The command ${FIRST} is open with other ids`),
			bad("runId is a run's id"),
			bad("An open request is {op, machine, commandId, runId, staffAgentId, requestedByUserId}"),
			bad("machine is a coding machine's id or a test machine's placement id"),
			bad("staffAgentId is an agent's id"),
		]);
		await write(view, "docs/during.txt", "d");
		const [closed, ...rest] = await ask(path, [
			closing,
			closing,
			{ ...closing, commandId: "command-1" },
			{ ...closing, runId: RUN },
			{ op: "close", machine: PLACEMENT },
		]);
		// The window's boundary published what the machine changed in it before the answer came.
		expect(closed).toMatchObject({
			boundary: {
				machine: PLACEMENT,
				reads: "released",
				views: [{ viewId: TEST_VIEW, report: { paths: [{ path: "docs/during.txt", outcome: "saved" }] } }],
			},
		});
		expect(creditsOf(core.commits.at(-1))).toEqual([["docs/during.txt", [FIRST]]]);
		// Closed again: one more boundary, with nothing left to publish.
		expect(rest[0]).toMatchObject({ boundary: { machine: PLACEMENT, views: [{ viewId: TEST_VIEW }] } });
		expect(rest.slice(1)).toEqual([
			bad("commandId is a command's id"),
			bad("A close request is {op, machine, commandId}"),
			bad("commandId is a command's id"),
		]);
		expect(core.commits).toHaveLength(2);
	});
});
