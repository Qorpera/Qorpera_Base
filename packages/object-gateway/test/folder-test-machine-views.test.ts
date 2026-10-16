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
import { FolderService, type MachineBoundary, type ViewHandle } from "../src/folder-service/service.ts";
import { FolderStaging } from "../src/folder-service/staging.ts";
import { type CommandWindow, type CreditedUnit, STARTER } from "../src/folder-service/windows.ts";
import {
	CODING,
	CODING_PROJECT,
	ENV,
	EXEC_HOST,
	FakeCore,
	FakeUploads,
	folder,
	hashOf,
	link,
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
	/** A connection of the machine's, at `protocol` (4 makes links). */
	const open = async (bridge: BridgeInfo = AT_TEST, protocol = 3) => {
		const hello: Hello = { protocol, environmentId: ENV, viewId: TEST_VIEW, pass: PASS, role: "io" };
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

/** Holds the core's next commit until `release`: `reached` once the commit is asked. */
function holdCommit(core: FakeCore): { reached: Promise<void>; release: () => void } {
	let reach!: () => void;
	let release!: () => void;
	const reached = new Promise<void>((resolve) => {
		reach = resolve;
	});
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	core.commitHook = () => {
		core.commitHook = undefined;
		reach();
		return held;
	};
	return { reached, release };
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

	it("keeps a renamed file's credits; a unit with starter and command changes is the command's", async () => {
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

	it("credits a moved file's removal to its command when a new file made at its origin replaces it", async () => {
		const { root, core, service, open } = await company();
		core.seed([await storeFile(root, "docs/a.md", "a", 2)]);
		const view = await open();
		service.openWindow(PLACEMENT, windowOf(FIRST));
		// docs/a.md moved to docs/b.md; a new docs/a.md, moved over it: what is published is the removal of docs/a.md
		// (the moved file's origin) and the new file at docs/b.md, both the command's.
		await view.rename({ from: "docs/a.md", to: "docs/b.md", noReplace: false });
		await write(view, "docs/a.md", "new");
		await view.rename({ from: "docs/a.md", to: "docs/b.md", noReplace: false });
		await service.closeWindow(PLACEMENT, FIRST);
		expect(core.commits.map(creditsOf)).toEqual([
			[
				["docs/a.md", [FIRST]],
				["docs/b.md", [FIRST]],
			],
		]);
		expect(core.entries.has("docs/a.md")).toBe(false);
		expect(core.entries.get("docs/b.md")?.fileSha256).toBe(hashOf("new"));
	});

	it("credits a file removed and made again to its maker alone, not a command whose refused file it was", async () => {
		const { root, core, service, open } = await company();
		core.seed([await storeFile(root, "docs/a.md", "a", 2)]);
		const view = await open();
		// The starter moved docs/a.md away; the first command made a new docs/a.md, and its boundary was refused whole.
		await view.rename({ from: "docs/a.md", to: "docs/b.md", noReplace: false });
		service.openWindow(PLACEMENT, windowOf(FIRST));
		await write(view, "docs/a.md", "first");
		core.commitRefusal = "stopped";
		const refused = await service.closeWindow(PLACEMENT, FIRST);
		expect(refused).toMatchObject({ views: [{ report: { refused: "stopped" } }] });
		core.commitRefusal = undefined;
		core.endedCommands.add(FIRST);
		// The second removes the first's file (the live docs/a.md, moved away, stays hidden) and makes its own.
		service.openWindow(PLACEMENT, windowOf(SECOND));
		await view.unlink("docs/a.md", undefined);
		await write(view, "docs/a.md", "second");
		const answer = await service.closeWindow(PLACEMENT, SECOND);
		expect(core.commits.map(creditsOf)).toEqual([
			[
				["docs/b.md", undefined],
				["docs/a.md", [FIRST]],
			],
			[
				["docs/b.md", undefined],
				["docs/a.md", [SECOND]],
			],
		]);
		expect(answer.views[0]?.report?.paths.every((p) => p.outcome === "saved")).toBe(true);
		expect(core.entries.get("docs/a.md")?.fileSha256).toBe(hashOf("second"));
		expect(core.entries.get("docs/b.md")?.fileSha256).toBe(hashOf("a"));
	});

	it("credits a file's bytes to their command when it is closed and removed behind a running boundary", async () => {
		const { root, core, service, open } = await company();
		core.seed([await storeFile(root, "docs/a.md", "a", 2)]);
		const view = await open();
		// The first command writes docs/a.md, not cut, and its window closes with the file still open: nothing goes.
		service.openWindow(PLACEMENT, windowOf(FIRST));
		const { handle } = await view.open({ path: "docs/a.md", create: false, exclusive: false, truncate: false });
		const data = Buffer.from("first");
		await view.chunk({ handle, index: 0, sha256: hashOf(data), bytes: data.byteLength, offset: 0, data });
		await service.closeWindow(PLACEMENT, FIRST);
		expect(core.commits).toEqual([]);
		// The starter's boundary is held at its commit while the file is closed and removed, both of which wait for it.
		await write(view, "docs/other.md", "o");
		const { reached, release } = holdCommit(core);
		const running = service.boundary(PLACEMENT);
		await reached;
		const closing = view.close(handle, data.byteLength);
		const unlinking = view.unlink("docs/a.md", undefined);
		release();
		await running;
		await closing;
		await unlinking;
		// The removal takes the bytes the close fixed, and so the command they came under.
		await service.boundary(PLACEMENT);
		expect(core.commits.map(creditsOf)).toEqual([[["docs/other.md", undefined]], [["docs/a.md", [FIRST]]]]);
		expect(core.commits[1]?.units.map((u) => u.op)).toEqual(["delete"]);
		expect(core.entries.has("docs/a.md")).toBe(false);
	});

	it("keeps a refused replacement's credits, the removal's it took in, at each boundary it goes again", async () => {
		const { root, core, service, open } = await company();
		core.seed([await storeFile(root, "docs/a.md", "a", 2)]);
		const view = await open();
		// The first command removes docs/a.md, and its boundary is refused whole; then the command ends.
		service.openWindow(PLACEMENT, windowOf(FIRST));
		await view.unlink("docs/a.md", undefined);
		core.commitRefusal = "stopped";
		const refused = await service.closeWindow(PLACEMENT, FIRST);
		expect(refused).toMatchObject({ views: [{ report: { refused: "stopped" } }] });
		core.commitRefusal = undefined;
		core.endedCommands.add(FIRST);
		// The starter makes a new docs/a.md: the file's next version, which carries the removal and so the command.
		await write(view, "docs/a.md", "new");
		for (let i = 0; i < 3; i++)
			expect(await service.boundary(PLACEMENT)).toMatchObject({
				views: [
					{
						report: {
							paths: [{ path: "docs/a.md", outcome: "refused", reason: "command_ended", kept: true }],
						},
					},
				],
			});
		expect(core.commits.map(creditsOf)).toEqual(Array.from({ length: 4 }, () => [["docs/a.md", [FIRST]]]));
		expect(core.commits.map((c) => c.units.map((u) => u.op))).toEqual([["delete"], ["write"], ["write"], ["write"]]);
		expect(core.entries.get("docs/a.md")?.fileSha256).toBe(hashOf("a"));
	});

	it("keeps a removal's credits in the new file or link renamed over it, until it is renamed on", async () => {
		const { root, core, service, open } = await company();
		core.seed([await storeFile(root, "docs/a.md", "a", 2), link("docs/latest", "v1.md", 3)]);
		const view = await open(AT_TEST, 4);
		// The first command removes a file and a link, and its boundary is refused whole; then the command ends.
		service.openWindow(PLACEMENT, windowOf(FIRST));
		await view.unlink("docs/a.md", undefined);
		await view.unlink("docs/latest", undefined);
		core.commitRefusal = "stopped";
		await service.closeWindow(PLACEMENT, FIRST);
		core.commitRefusal = undefined;
		core.endedCommands.add(FIRST);
		// The starter saves a new docs/a.md as an editor does, and makes a new link as `ln -sf` does: each holds the
		// removal of the one it replaces, and so the command, through the boundary that refuses it and keeps it.
		await write(view, "docs/new.md", "new");
		await view.rename({ from: "docs/new.md", to: "docs/a.md", noReplace: false });
		await view.symlink("docs/CuXXXXXX", "v2.md");
		await view.rename({ from: "docs/CuXXXXXX", to: "docs/latest", noReplace: false });
		await service.boundary(PLACEMENT);
		// Renamed on, each lets the removal go again, its credits with it; what it publishes now is the starter's.
		await view.rename({ from: "docs/a.md", to: "docs/b.md", noReplace: false });
		await view.rename({ from: "docs/latest", to: "docs/next", noReplace: false });
		await service.boundary(PLACEMENT);
		expect(core.commits.map(creditsOf)).toEqual([
			[
				["docs/a.md", [FIRST]],
				["docs/latest", [FIRST]],
			],
			[
				["docs/a.md", [FIRST]],
				["docs/latest", [FIRST]],
			],
			[
				["docs/a.md", [FIRST]],
				["docs/latest", [FIRST]],
				["docs/b.md", undefined],
				["docs/next", undefined],
			],
		]);
		expect(core.commits.map((c) => c.units.map((u) => u.op))).toEqual([
			["delete", "delete"],
			["write", "symlink"],
			["delete", "delete", "write", "symlink"],
		]);
		expect(core.entries.get("docs/a.md")?.fileSha256).toBe(hashOf("a"));
		expect(core.entries.get("docs/latest")).toMatchObject({ kind: "symlink", target: "v1.md" });
		expect(core.entries.get("docs/b.md")?.fileSha256).toBe(hashOf("new"));
		expect(core.entries.get("docs/next")).toMatchObject({ kind: "symlink", target: "v2.md" });
	});

	it("credits a symlink and a hard link made in a window to its command, a hard link at its new name", async () => {
		const { core, service, open } = await company();
		const view = await open(AT_TEST, 4);
		await write(view, "docs/fresh.md", "fresh");
		service.openWindow(PLACEMENT, windowOf(FIRST));
		await view.symlink("docs/latest", "plan.md");
		// The source, the starter's, stays so: the link is a file of its own at its new name.
		await view.link({ from: "docs/fresh.md", to: "docs/copy.md" });
		await service.closeWindow(PLACEMENT, FIRST);
		expect(core.commits.map(creditsOf)).toEqual([
			[
				["docs/fresh.md", undefined],
				["docs/copy.md", [FIRST]],
				["docs/latest", [FIRST]],
			],
		]);
		expect(core.commits[0]?.units.map((u) => u.op)).toEqual(["write", "write", "symlink"]);
		expect(core.entries.get("docs/copy.md")?.fileSha256).toBe(hashOf("fresh"));
		expect(core.entries.get("docs/latest")).toMatchObject({ kind: "symlink", target: "plan.md" });
	});

	it("credits a link's removal and rename to the command whose window was open", async () => {
		const { core, service, open } = await company();
		core.seed([link("docs/old", "plan.md", 2), link("docs/here", "plan.md", 3)]);
		const view = await open(AT_TEST, 4);
		service.openWindow(PLACEMENT, windowOf(FIRST));
		await view.unlink("docs/old", undefined);
		await view.rename({ from: "docs/here", to: "docs/there", noReplace: false });
		await service.closeWindow(PLACEMENT, FIRST);
		expect(core.commits.map(creditsOf)).toEqual([
			[
				["docs/old", [FIRST]],
				["docs/there", [FIRST]],
			],
		]);
		expect(core.commits[0]?.units.map((u) => u.op)).toEqual(["delete", "move"]);
		expect(core.entries.has("docs/old")).toBe(false);
		expect(core.entries.get("docs/there")).toMatchObject({ kind: "symlink", target: "plan.md" });
	});
});

/** A seeded generator (mulberry32): a seed gives the same sequence at every run. */
function seeded(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

interface ModelFile {
	/** The live path it was opened or moved from; none for a new file. */
	origin: string | undefined;
	/** It has bytes of its own. */
	dirty: boolean;
	/** The tags of the changes made to it since it last had nothing to publish. */
	readonly tags: Set<string>;
	/** A new file's: the tags of the removal of the live file at its path, which it replaces. */
	replaces?: ReadonlySet<string> | undefined;
}

/** A unit as a commit names it: its op, the path it publishes (a move's target), and its credits. */
type ModelUnit = readonly [string, string, readonly string[] | undefined];

/** The credit rule, on a model of a test machine's pending files kept apart from PendingView: a unit is credited to
 * the commands whose windows were open when a change now in it was made. A pending file has the tags of the changes
 * made to it since it last had nothing to publish; a pending removal of a live path has those of the change that
 * removed it and of the file it took. A new file made or renamed where a live file was removed holds that removal, and
 * its tags, until it is removed or renamed on, which lets it go again. */
class CreditModel {
	live: ReadonlySet<string> = new Set();
	readonly files = new Map<string, ModelFile>();
	readonly hidden = new Set<string>();
	readonly removals = new Map<string, ReadonlySet<string>>();

	shows(path: string): boolean {
		return this.files.has(path) || (this.live.has(path) && !this.hidden.has(path));
	}

	/** A write is made at once but to a file the view moved, which publishes first (the model leaves that out). */
	canWrite(path: string): boolean {
		const origin = this.files.get(path)?.origin;
		return origin === undefined || origin === path;
	}

	write(path: string, tags: readonly string[]): void {
		const shown = this.shows(path);
		const file = this.files.get(path) ?? {
			origin: shown ? path : undefined,
			dirty: false,
			tags: new Set<string>(),
			replaces: shown ? undefined : this.#take(path),
		};
		file.dirty = true;
		for (const tag of tags) file.tags.add(tag);
		this.files.set(path, file);
	}

	remove(path: string, tags: readonly string[]): void {
		const file = this.files.get(path);
		const at = file === undefined ? path : file.origin;
		if (at !== undefined) this.removals.set(at, new Set([...(file?.tags ?? []), ...tags]));
		else if (file !== undefined) this.#release(path, file);
		this.files.delete(path);
		if (this.live.has(path)) this.hidden.add(path);
	}

	/** A rename is made at once but for a changed file with an origin, or moves that take each other's places. */
	canRename(from: string, to: string): boolean {
		if (from === to || !this.shows(from)) return false;
		const file = this.files.get(from);
		if (file?.origin !== undefined && file.dirty) return false;
		const origin = file === undefined ? from : file.origin;
		return this.shows(to) || origin === undefined || !this.#cycle(origin, to);
	}

	rename(from: string, to: string, tags: readonly string[]): void {
		const file: ModelFile = this.files.get(from) ?? { origin: from, dirty: false, tags: new Set<string>() };
		const fresh = file.origin === undefined;
		// A new file renamed lets the removal it held go, and holds what it replaces at its new path: a pending file not
		// moved there goes with what that one replaced (its removal, or its origin's, removed now), else the removal there.
		if (fresh) this.#release(from, file);
		const target = this.files.get(to);
		if (fresh && target !== undefined && (target.origin === undefined || target.origin === to)) {
			file.replaces = target.origin === undefined ? target.replaces : new Set([...target.tags, ...tags]);
			this.files.delete(to);
		} else {
			if (this.shows(to)) this.remove(to, tags);
			if (fresh) file.replaces = this.#take(to);
		}
		this.files.delete(from);
		if (this.live.has(from)) this.hidden.add(from);
		for (const tag of tags) file.tags.add(tag);
		// Moved back to its origin with nothing of its own, it has nothing to publish: the live file shows again.
		if (file.origin === to && !file.dirty) this.hidden.delete(to);
		else this.files.set(to, file);
	}

	/** The units a boundary publishes: one per pending file (a new file's, the next version of the live one it replaces,
	 * credited with that one's removal too), and one per removal. */
	units(): ModelUnit[] {
		const credits = (tags: Iterable<string>): readonly string[] | undefined => {
			const ids = [...new Set(tags)].filter((tag) => tag !== STARTER).sort();
			return ids.length === 0 ? undefined : ids;
		};
		const units: ModelUnit[] = [];
		for (const [path, file] of this.files) {
			const op = file.origin === undefined || file.origin === path ? "write" : "move";
			units.push([op, path, credits([...file.tags, ...(file.replaces ?? [])])]);
		}
		for (const [at, tags] of this.removals) units.push(["delete", at, credits(tags)]);
		return sortUnits(units);
	}

	/** After a boundary the core answered: what it kept pending stays, with its tags, and a new file kept keeps the
	 * removal it holds, and so its tags; the rest is live now, or gone. */
	settle(kept: ReadonlySet<string>, live: ReadonlySet<string>): void {
		for (const path of [...this.files.keys()]) if (!kept.has(path)) this.files.delete(path);
		this.removals.clear();
		this.hidden.clear();
		this.live = live;
	}

	/** The removal at `path`, which a new file made there takes. */
	#take(path: string): ReadonlySet<string> | undefined {
		const tags = this.removals.get(path);
		this.removals.delete(path);
		return tags;
	}

	/** A new file lets the removal it holds go: it is pending again at the file's path. */
	#release(path: string, file: ModelFile): void {
		if (file.replaces !== undefined) this.removals.set(path, file.replaces);
		file.replaces = undefined;
	}

	#cycle(origin: string, target: string): boolean {
		const seen = new Set<string>();
		for (let at = target; ; ) {
			const next = [...this.files].find(([path, file]) => file.origin === at && path !== at)?.[0];
			if (next === undefined) return false;
			if (next === origin) return true;
			if (seen.has(next)) return false;
			seen.add(next);
			at = next;
		}
	}
}

function sortUnits(units: ModelUnit[]): ModelUnit[] {
	return units.sort((a, b) => `${a[1]} ${a[0]}`.localeCompare(`${b[1]} ${b[0]}`));
}

describe("test machine credits against a model", () => {
	const THIRD = "c0aa0003-0000-4a00-8b00-000000000003";
	const COMMANDS = [FIRST, SECOND, THIRD];
	const PATHS = ["docs/a.md", "docs/b.md", "docs/c.md"];
	const STEPS = 18;

	/** One seeded sequence of changes, windows and boundaries (accepted, or refused whole as `stopped`; a unit credited
	 * to a command that ended is refused, and kept), with every boundary's units and credits checked against the
	 * model's, and each unit a boundary kept pending, nothing changed since, sent again as it was. Some boundaries are
	 * held at their commit while the machine closes a file it wrote before and makes other changes, which wait. */
	async function sequence(seed: number): Promise<void> {
		const random = seeded(seed);
		const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;
		const { root, core, service, open } = await company();
		core.seed([await storeFile(root, "docs/a.md", "a", 2), await storeFile(root, "docs/b.md", "b", 3)]);
		const view = await open();
		const model = new CreditModel();
		model.live = new Set(["docs/a.md", "docs/b.md"]);
		const windows = new Set<string>();
		const ended = new Set<string>();
		const steps: string[] = [];
		const tags = (): string[] => (windows.size === 0 ? [STARTER] : [...windows]);
		// The units the last boundary left pending, by op and path, and the paths changed since.
		let kept = new Map<string, ModelUnit>();
		const touched = new Set<string>();
		const boundary = async (run: () => Promise<MachineBoundary>, stopped: boolean): Promise<void> => {
			steps.push(stopped ? "boundary (stopped)" : "boundary");
			const why = `seed ${seed}: ${steps.join(", ")}`;
			const expected = model.units();
			const before = core.commits.length;
			core.commitRefusal = stopped ? "stopped" : undefined;
			const answer = await run();
			core.commitRefusal = undefined;
			const commits = core.commits.slice(before);
			expect(commits.length, why).toBe(expected.length === 0 ? 0 : 1);
			const units: ModelUnit[] = [];
			for (const u of commits[0]?.units ?? [])
				units.push([u.op, u.op === "move" ? u.to : u.path, (u as CreditedUnit).credits]);
			// A unit kept pending goes again as it went, credits and all, until a change is made to it.
			for (const [key, unit] of kept) {
				if (touched.has(unit[1])) continue;
				const again = units.find((u) => `${u[0]} ${u[1]}` === key);
				expect(again, `${why}: ${key} again`).toEqual(unit);
			}
			kept = new Map();
			touched.clear();
			if (expected.length === 0) return;
			expect(sortUnits(units), why).toEqual(expected);
			const report = answer.views[0]?.report;
			expect(report?.refused, why).toBe(stopped ? "stopped" : undefined);
			const keep = new Set(report?.paths.filter((p) => p.kept).map((p) => p.path));
			for (const unit of units) if (stopped || keep.has(unit[1])) kept.set(`${unit[0]} ${unit[1]}`, unit);
			if (stopped) return;
			model.settle(keep, new Set(PATHS.filter((p) => core.entries.get(p)?.kind === "file")));
		};
		/** A boundary held at its commit (the executor's, or a window's close) while the machine closes a file it wrote
		 * before, perhaps removes it, and makes another change: each waits for the boundary to settle, then is made in
		 * turn. Each is on a path the boundary publishes nothing at, or a write, which any outcome leaves free to make;
		 * so the model makes them once it settled. */
		const held = async (step: number): Promise<void> => {
			// Neither pending nor hidden: the boundary leaves these as they are.
			const alone = PATHS.filter((p) => !model.files.has(p) && !model.hidden.has(p));
			const used = new Set<string>();
			const changes: { label: string; made: () => Promise<unknown>; model: () => void }[] = [];
			let file: { path: string; handle: number; bytes: number; tags: readonly string[] } | undefined;
			if (alone.length > 0 && random() < 0.7) {
				const path = pick(alone);
				steps.push(`hold ${path}`);
				const create = !model.shows(path);
				const { handle } = await view.open({ path, create, exclusive: false, truncate: false });
				const data = Buffer.from(`${seed}.${step}`);
				await view.chunk({ handle, index: 0, sha256: hashOf(data), bytes: data.byteLength, offset: 0, data });
				file = { path, handle, bytes: data.byteLength, tags: tags() };
				used.add(path);
			}
			const command = windows.size > 0 && random() < 0.5 ? pick([...windows]) : undefined;
			if (command !== undefined) windows.delete(command);
			const stopped = random() < 0.2;
			const now = tags();
			if (file !== undefined) {
				const { path, handle, bytes, tags: wrote } = file;
				// Its bytes are those of the windows open as they came; the close, which cuts nothing, adds none.
				changes.push({
					label: `close ${path}`,
					made: () => view.close(handle, bytes),
					model: () => model.write(path, wrote),
				});
				if (random() < 0.5)
					changes.push({
						label: `unlink ${path}`,
						made: () => view.unlink(path, undefined),
						model: () => model.remove(path, now),
					});
			}
			for (let i = file === undefined ? 0 : 1; i < 2; i++) {
				const roll = random();
				const free = PATHS.filter((p) => !used.has(p));
				const shown = free.filter((p) => alone.includes(p) && model.live.has(p));
				if (roll < 0.4) {
					const writable = free.filter((p) => model.canWrite(p));
					if (writable.length === 0) continue;
					const path = pick(writable);
					const text = `${seed}.${step}.${i}`;
					used.add(path);
					changes.push({
						label: `write ${path}`,
						made: () => write(view, path, text),
						model: () => model.write(path, now),
					});
				} else if (roll < 0.7) {
					if (shown.length === 0) continue;
					const path = pick(shown);
					used.add(path);
					changes.push({
						label: `unlink ${path}`,
						made: () => view.unlink(path, undefined),
						model: () => model.remove(path, now),
					});
				} else {
					if (shown.length === 0) continue;
					const from = pick(shown);
					const targets = free.filter((p) => alone.includes(p) && p !== from);
					if (targets.length === 0) continue;
					const to = pick(targets);
					if (!model.canRename(from, to)) continue;
					used.add(from);
					used.add(to);
					changes.push({
						label: `rename ${from} ${to}`,
						made: () => view.rename({ from, to, noReplace: false }),
						model: () => model.rename(from, to, now),
					});
				}
			}
			steps.push(command === undefined ? "held" : `close ${COMMANDS.indexOf(command) + 1} held`);
			const run = async (): Promise<MachineBoundary> => {
				const { reached, release } = holdCommit(core);
				const answering = command ? service.closeWindow(PLACEMENT, command) : service.boundary(PLACEMENT);
				// A boundary with nothing to publish asks no commit: what is changed meanwhile then waits for nothing.
				await Promise.race([reached, answering]);
				const made = changes.map((change) => change.made());
				release();
				const answer = await answering;
				core.commitHook = undefined;
				await Promise.all(made);
				return answer;
			};
			await boundary(run, stopped);
			for (const change of changes) {
				steps.push(`then ${change.label}`);
				change.model();
			}
			for (const path of used) touched.add(path);
		};
		for (let step = 0; step < STEPS; step++) {
			const roll = random();
			const path = pick(PATHS);
			const other = pick(PATHS);
			if (roll < 0.26) {
				if (!model.canWrite(path)) continue;
				steps.push(`write ${path}`);
				await write(view, path, `${seed}.${step}`);
				model.write(path, tags());
				touched.add(path);
			} else if (roll < 0.47) {
				if (!model.canRename(path, other)) continue;
				steps.push(`rename ${path} ${other}`);
				await view.rename({ from: path, to: other, noReplace: false });
				model.rename(path, other, tags());
				touched.add(path);
				touched.add(other);
			} else if (roll < 0.57) {
				if (!model.shows(path)) continue;
				steps.push(`unlink ${path}`);
				await view.unlink(path, undefined);
				model.remove(path, tags());
				touched.add(path);
			} else if (roll < 0.65) {
				const free = COMMANDS.filter((c) => !windows.has(c) && !ended.has(c));
				if (free.length === 0) continue;
				const command = pick(free);
				steps.push(`open ${COMMANDS.indexOf(command) + 1}`);
				service.openWindow(PLACEMENT, windowOf(command));
				windows.add(command);
			} else if (roll < 0.76) {
				if (windows.size === 0) continue;
				const command = pick([...windows]);
				steps.push(`close ${COMMANDS.indexOf(command) + 1}`);
				windows.delete(command);
				await boundary(() => service.closeWindow(PLACEMENT, command), random() < 0.3);
				// The command ended: the core refuses what is credited to it from now on.
				if (random() < 0.5) {
					steps.push(`end ${COMMANDS.indexOf(command) + 1}`);
					ended.add(command);
					core.endedCommands.add(command);
				}
			} else if (roll < 0.84) {
				// Boundaries in a row, nothing changed between them: what one keeps pending goes again as it went.
				for (let times = 2 + Math.floor(random() * 2); times > 0; times--)
					await boundary(() => service.boundary(PLACEMENT), random() < 0.2);
			} else if (roll < 0.93) await held(step);
			else await boundary(() => service.boundary(PLACEMENT), random() < 0.3);
		}
		await boundary(() => service.boundary(PLACEMENT), false);
		for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	}

	for (const first of [1, 101, 201, 301])
		it(`credits each unit as the model does, seeds ${first} to ${first + 99}`, { timeout: 60_000 }, async () => {
			for (let seed = first; seed < first + 100; seed++) await sequence(seed);
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
