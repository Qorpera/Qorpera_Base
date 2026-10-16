import { chmod, mkdtemp, realpath, rm } from "node:fs/promises";
import { connect, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createControlServer, socketRefusal } from "../src/folder-service/control.ts";
import { DESKTOP_QUIET_MS } from "../src/folder-service/mounts.ts";
import { NasObjects } from "../src/folder-service/objects.ts";
import type { BridgeInfo, Hello } from "../src/folder-service/protocol.ts";
import { FolderService, type MachineBoundary, type ViewHandle } from "../src/folder-service/service.ts";
import { FolderStaging } from "../src/folder-service/staging.ts";
import {
	CODE_HOST,
	CODING,
	CODING_MACHINE_ID,
	codingGrants,
	ENV,
	EXEC_HOST,
	FakeCore,
	FakeUploads,
	folder,
	hashOf,
	OFFICE,
	PROFILE,
	storeFile,
	v,
} from "./folder-service-fixtures.ts";

/** Coding views on the folder (F3 step 5, slice 5c: deploy/first-node/RUNTIME-FOLDER-CODING-MACHINES.md, "Reads" and
 * "Boundaries"): a coding session's view is served to its own coding machine alone, and a code host's to its company's
 * code host. The service records every read it serves a coding machine before the answer leaves, and releases every
 * read of the machine before any of its saves and before it answers a boundary the executor asks over the control
 * socket. A read a machine was served that went unreleased leaves the machine unproven, its views gone or not, until
 * the executor says it restarted the machine. A clean stop clears `served_by`; a run that did not stop cleanly leaves
 * it, and the core refuses its views to the next. */
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const SESSION = "c0d1e5e5-0001-4a00-8b00-000000000001";
const SECOND = "c0d1e5e5-0002-4a00-8b00-000000000002";
const HOST_VIEW = "c0d1e5e5-0003-4a00-8b00-000000000003";
/** A session's view the executor opens on the machine after it restarted it (open in the core only once a test does). */
const THIRD = "c0d1e5e5-0004-4a00-8b00-000000000004";
const PASSES: Record<string, string> = {
	[SESSION]: "codepass_0123456789-abcdefghijklmnopqrstuvw",
	[SECOND]: "codepass_0123456789-bcdefghijklmnopqrstuvwx",
	[HOST_VIEW]: "hostpass_0123456789-abcdefghijklmnopqrstuvw",
	[THIRD]: "codepass_0123456789-cdefghijklmnopqrstuvwxy",
};
const AT_CODING: BridgeInfo = { cid: 95, lookup: "found", machine: CODING };
const AT_HOST: BridgeInfo = { cid: 96, lookup: "found", machine: CODE_HOST };
const MACHINE_SET = `machine:${CODING_MACHINE_ID}`;
const PLAN = { path: "docs/plan.md", version: v(1), offset: 0, length: 16 };
const NOTES = { path: "docs/notes.md", version: v(2), offset: 0, length: 16 };

/** A company folder with two files, two sessions' views on one coding machine and a code host's view, and the node's
 * service with its coding project configured. `serve` starts another run of the service on the same core. */
async function company() {
	const root = await mkdtemp(join(tmpdir(), "qorpera-folder-coding-"));
	const core = new FakeCore();
	core.seed([
		folder("docs"),
		await storeFile(root, "docs/plan.md", "the plan", 1),
		await storeFile(root, "docs/notes.md", "the notes", 2),
	]);
	for (const viewId of [SESSION, SECOND])
		core.openView(viewId, PASSES[viewId] as string, { kind: "coding_session", codingMachineId: CODING_MACHINE_ID });
	core.openView(HOST_VIEW, PASSES[HOST_VIEW] as string, { kind: "code_host" });
	const objects = new NasObjects({ root, cacheBytes: 64 * 1024 * 1024 });
	const services: FolderService[] = [];
	const handles: ViewHandle[] = [];
	const serve = (): FolderService => {
		const service = new FolderService({
			core,
			objects,
			grants: codingGrants(),
			staging: new FolderStaging(core, new FakeUploads(root, core), objects),
			log: () => undefined,
		});
		services.push(service);
		return service;
	};
	const service = serve();
	cleanups.push(async () => {
		for (const h of handles) h.release();
		for (const s of services) s.stop();
		await rm(root, { recursive: true, force: true });
	});
	const open = async (viewId = SESSION, bridge: BridgeInfo = AT_CODING, on = service) => {
		const hello: Hello = { protocol: 3, environmentId: ENV, viewId, pass: PASSES[viewId] as string, role: "io" };
		const handle = await on.open(hello, bridge);
		handles.push(handle);
		return handle;
	};
	return { core, service, serve, open, session: core.views.get(SESSION)! };
}

/** A small file, written as the folder program writes it: opened with truncate, its one chunk, closed. */
async function write(view: ViewHandle, path: string, text: string): Promise<void> {
	const { handle } = await view.open({ path, create: true, exclusive: false, truncate: true });
	const data = Buffer.from(text);
	await view.chunk({ handle, index: 0, sha256: hashOf(data), bytes: data.byteLength, offset: 0, data });
	await view.close(handle, data.byteLength);
}

/** Each release the core heard: the view it came under, and the path and version of each read. */
const releasesOf = (core: FakeCore) =>
	core.releases.map((r) => [r.viewId, r.reads.map((read) => [read.path, read.version])]);
const settle = () => new Promise((resolve) => setTimeout(resolve, 50));
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(done: () => boolean, ms = 3_000): Promise<void> {
	for (const end = Date.now() + ms; !done() && Date.now() < end; ) await wait(10);
	expect(done()).toBe(true);
}

describe("coding views", () => {
	it("serves a coding session's view to its own coding machine alone, and a code host's to its company's code host", async () => {
		const coding = { kind: "coding_session", machineId: null, companyId: PROFILE };
		expect(codingGrants().coreAccess({ ...coding, codingMachineId: CODING_MACHINE_ID })).toMatchObject({
			write: true,
			quietMs: DESKTOP_QUIET_MS,
			machine: CODING_MACHINE_ID,
		});
		expect(codingGrants().coreAccess({ ...coding, codingMachineId: null })).toBeUndefined();
		const { open } = await company();
		const at = (machine: BridgeInfo["machine"], cid: number): BridgeInfo => ({ cid, lookup: "found", machine });
		const otherMachine = at({ ...CODING, name: `qorpera-coding-machine-${"f".repeat(32)}` }, 97);
		const unlisted = at({ ...CODING, project: "qn25b2-coding-old" }, 98);
		const otherHost = at({ ...CODE_HOST, project: `qorpera-codehost-${"e".repeat(32)}` }, 99);
		// Not another coding machine, an office, the execution host, a coding machine of that name in a project the node
		// does not list, or the code host.
		for (const bridge of [otherMachine, at(OFFICE, 90), at(EXEC_HOST, 77), unlisted, AT_HOST])
			await expect(open(SESSION, bridge)).rejects.toMatchObject({ code: "VIEW_REFUSED" });
		const view = await open();
		expect(view.writable).toBe(true);
		await expect(open(SESSION, otherMachine)).rejects.toMatchObject({ code: "VIEW_REFUSED" });
		// A code host's view: not another company's code host, nor a coding machine or an office.
		for (const bridge of [otherHost, AT_CODING, at(OFFICE, 90)])
			await expect(open(HOST_VIEW, bridge)).rejects.toMatchObject({ code: "VIEW_REFUSED" });
		expect((await open(HOST_VIEW, AT_HOST)).writable).toBe(true);
	});

	it("records each read it serves a coding machine before the answer leaves, and takes nothing from the machine's log", async () => {
		const { core, service, open } = await company();
		const view = await open();
		expect((await view.list("docs", undefined)).entries.map((e) => e.name).sort()).toEqual(["notes.md", "plan.md"]);
		expect((await view.read(PLAN)).toString()).toBe("the plan");
		// The log the machine sends counts for nothing, its loss included: root on the machine could rewrite it.
		const log = v(80);
		const reads = [{ seq: 1, path: "docs/notes.md", version: v(2) }];
		expect(await view.reads({ log, reads, lost: true })).toEqual({ log, taken: 1, released: 1 });
		expect(core.releases).toEqual([]);
		// The service's own record is released, under the view, into the machine's read set, before the answer.
		expect(await service.boundary(CODING_MACHINE_ID)).toMatchObject({
			machine: CODING_MACHINE_ID,
			reads: "released",
			views: [{ viewId: SESSION, report: { commitId: null, paths: [] } }],
		});
		expect(releasesOf(core)).toEqual([
			[
				SESSION,
				[
					["docs", null],
					["docs/plan.md", v(1)],
				],
			],
		]);
		expect([...core.readSets.get(MACHINE_SET)!.keys()].sort()).toEqual(["docs", "docs/plan.md"]);
		// A read released already is not recorded again.
		await view.read(PLAN);
		await service.boundary(CODING_MACHINE_ID);
		expect(core.releases).toHaveLength(1);
		// A view that closes with a read it served and never released leaves the machine unable to show its reads
		// released: the record was made when the read was answered.
		const second = await open(SECOND);
		await second.read(NOTES);
		await write(view, "docs/out.txt", "o");
		core.views.get(SECOND)!.state = "closed";
		await service.renewLeases();
		await expect(second.list("docs", undefined)).rejects.toMatchObject({ code: "VIEW_CLOSED" });
		expect(await service.boundary(CODING_MACHINE_ID)).toMatchObject({
			reads: "unproven",
			views: [
				{
					viewId: SESSION,
					report: {
						commitId: null,
						refused: "unproven",
						paths: [{ path: "docs/out.txt", outcome: "refused", reason: "unproven", kept: true }],
					},
				},
			],
		});
		expect(core.commits).toEqual([]);
	});

	it("answers a machine's boundary only after every read of the machine is released, each before any save", async () => {
		const { core, service, open } = await company();
		const first = await open();
		const second = await open(SECOND);
		await write(first, "docs/out.txt", "o");
		await second.read(PLAN);
		let lift!: () => void;
		core.releaseGate = new Promise((resolve) => {
			lift = resolve;
		});
		const order: string[] = [];
		// A read the second view serves while the first's save is asked: released before the answer too.
		core.commitHook = (asked) => {
			order.push(`commit after ${core.releases.length} release(s)`);
			return asked === 0 ? second.list("docs", undefined).then(() => undefined) : undefined;
		};
		let answered: MachineBoundary | undefined;
		const boundary = service.boundary(CODING_MACHINE_ID).then((answer) => {
			answered = answer;
			return answer;
		});
		await settle();
		expect(answered).toBeUndefined();
		expect(core.commits).toEqual([]);
		core.releaseGate = undefined;
		lift();
		const answer = await boundary;
		expect(answer).toMatchObject({
			machine: CODING_MACHINE_ID,
			reads: "released",
			views: [
				{
					viewId: SESSION,
					report: { commitId: expect.any(String), paths: [{ path: "docs/out.txt", outcome: "saved" }] },
				},
				{ viewId: SECOND, report: { commitId: null, paths: [] } },
			],
		});
		expect(order).toEqual(["commit after 1 release(s)"]);
		expect(releasesOf(core)).toEqual([
			[SECOND, [["docs/plan.md", v(1)]]],
			[SECOND, [["docs", null]]],
		]);
		expect(core.entries.get("docs/out.txt")?.fileSha256).toBe(hashOf("o"));
		// A view of the machine this service does not hold, named final, has no report.
		expect((await service.boundary(CODING_MACHINE_ID, [HOST_VIEW])).views).toContainEqual({
			viewId: HOST_VIEW,
			error: { code: "VIEW_CLOSED", message: "This service holds no open view of the machine by that id" },
		});
	});

	it("answers a machine's boundary only once none of its views holds a read unreleased, one served during the last release included", async () => {
		const { core, service, open } = await company();
		const first = await open();
		const second = await open(SECOND);
		await write(first, "docs/out.txt", "o");
		// While the first view's save is asked, the second is served a listing. While that listing is released, after
		// the release that found nothing in the first view, the first is served a file.
		let armed = false;
		core.commitHook = (asked) => {
			if (asked !== 0) return undefined;
			armed = true;
			return second.list("docs", undefined).then(() => undefined);
		};
		core.releaseHook = (viewId) => {
			if (viewId !== SECOND || !armed) return undefined;
			armed = false;
			return first.read(NOTES).then(() => undefined);
		};
		expect(await service.boundary(CODING_MACHINE_ID)).toMatchObject({
			reads: "released",
			views: [
				{ viewId: SESSION, report: { paths: [{ path: "docs/out.txt", outcome: "saved" }] } },
				{ viewId: SECOND, report: { commitId: null, paths: [] } },
			],
		});
		expect(armed).toBe(false);
		expect(releasesOf(core)).toEqual([
			[SECOND, [["docs", null]]],
			[SESSION, [["docs/notes.md", v(2)]]],
		]);
	});

	it("keeps a read a coding machine lost once its last view has gone, until the executor says it restarted the machine", async () => {
		const { core, service, open } = await company();
		// The machine's last view closes with a read it was served and never released: the machine holds the read still.
		const first = await open();
		await first.read(PLAN);
		core.views.get(SESSION)!.state = "closed";
		await service.renewLeases();
		expect(await service.boundary(CODING_MACHINE_ID)).toEqual({
			machine: CODING_MACHINE_ID,
			reads: "unproven",
			views: [],
		});
		// A view opened on it cannot show its reads released either.
		const second = await open(SECOND);
		await write(second, "docs/b.txt", "b");
		expect(await service.boundary(CODING_MACHINE_ID)).toMatchObject({
			reads: "unproven",
			views: [{ viewId: SECOND, report: { commitId: null, refused: "unproven" } }],
		});
		// The executor closes the machine's views, restarts it and says so: a view opened after is served as any.
		core.views.get(SECOND)!.state = "closed";
		await service.renewLeases();
		service.restarted(CODING_MACHINE_ID);
		core.openView(THIRD, PASSES[THIRD] as string, { kind: "coding_session", codingMachineId: CODING_MACHINE_ID });
		const third = await open(THIRD);
		await third.read(PLAN);
		await write(third, "docs/c.txt", "c");
		expect(await service.boundary(CODING_MACHINE_ID)).toMatchObject({
			reads: "released",
			views: [{ viewId: THIRD, report: { paths: [{ path: "docs/c.txt", outcome: "saved" }] } }],
		});
		expect(releasesOf(core)).toEqual([[THIRD, [["docs/plan.md", v(1)]]]]);
		// A restart while a view of the machine is still open with a read unreleased: the read is forgotten with the
		// machine it was served to, the view is unproven, and its closing later makes nothing lost.
		await third.read(NOTES);
		service.restarted(CODING_MACHINE_ID);
		await write(third, "docs/d.txt", "d");
		expect(await service.boundary(CODING_MACHINE_ID)).toMatchObject({
			reads: "released",
			views: [{ viewId: THIRD, report: { commitId: null, refused: "unproven" } }],
		});
		core.views.get(THIRD)!.state = "closed";
		await service.renewLeases();
		expect(await service.boundary(CODING_MACHINE_ID)).toEqual({
			machine: CODING_MACHINE_ID,
			reads: "released",
			views: [],
		});
		expect(releasesOf(core)).toHaveLength(1);
		expect(core.commits).toHaveLength(1);
	});

	it("answers a boundary the machine's restart crossed unproven, though the read lost before it was cleared", async () => {
		const { core, service, open } = await company();
		const first = await open();
		const second = await open(SECOND);
		await write(first, "docs/out.txt", "o");
		// While the first view's save is asked, the second is served a listing. While that listing is released, in the
		// boundary's last release, the first view is served a file and goes with it unreleased, and the executor says it
		// restarted the machine (on another connection), which clears the loss.
		let armed = false;
		core.commitHook = (asked) => {
			if (asked !== 0) return undefined;
			armed = true;
			return second.list("docs", undefined).then(() => undefined);
		};
		core.releaseHook = (viewId) => {
			if (viewId !== SECOND || !armed) return undefined;
			armed = false;
			return (async () => {
				await first.read(PLAN);
				core.views.get(SESSION)!.state = "closed";
				await service.renewLeases();
				service.restarted(CODING_MACHINE_ID);
			})();
		};
		expect(await service.boundary(CODING_MACHINE_ID)).toMatchObject({
			reads: "unproven",
			views: [
				{ viewId: SESSION, report: { paths: [{ path: "docs/out.txt", outcome: "saved" }] } },
				{ viewId: SECOND, report: { commitId: null, paths: [] } },
			],
		});
		expect(armed).toBe(false);
		// The core never heard the read that went.
		expect(releasesOf(core)).toEqual([[SECOND, [["docs", null]]]]);
		// A boundary begun after the restart answers for the machine as it is now; the view open across it stays unproven.
		expect(await service.boundary(CODING_MACHINE_ID)).toMatchObject({
			reads: "released",
			views: [{ viewId: SECOND, report: { commitId: null, refused: "unproven" } }],
		});
	});

	it("publishes a coding view after its quiet period, every read of its machine released first", async () => {
		const { core, open } = await company();
		const first = await open();
		const second = await open(SECOND);
		const released: number[] = [];
		core.commitHook = () => {
			released.push(core.releases.length);
			return undefined;
		};
		await second.read(NOTES);
		await write(first, "docs/quiet.txt", "q");
		await wait(DESKTOP_QUIET_MS / 2);
		expect(core.commits).toEqual([]);
		await until(() => core.commits.length === 1, DESKTOP_QUIET_MS * 2);
		expect(released).toEqual([1]);
		expect(releasesOf(core)).toEqual([[SECOND, [["docs/notes.md", v(2)]]]]);
		expect(core.entries.get("docs/quiet.txt")?.fileSha256).toBe(hashOf("q"));
	});

	it("holds a boundary whose release is refused or not answered, and publishes once the reads go", async () => {
		const { core, service, open } = await company();
		const view = await open();
		await view.read(PLAN);
		await write(view, "docs/out.txt", "o");
		core.releaseRefusal = "stopped";
		const kept = { path: "docs/out.txt", kept: true };
		expect(await service.boundary(CODING_MACHINE_ID)).toMatchObject({
			reads: "stopped",
			views: [{ report: { commitId: null, refused: "stopped", paths: [{ ...kept, outcome: "refused" }] } }],
		});
		core.releaseRefusal = undefined;
		core.releaseFailures = { mode: "down", count: 1_000 };
		expect(await service.boundary(CODING_MACHINE_ID)).toMatchObject({
			reads: "unanswered",
			views: [{ report: { commitId: null, paths: [{ ...kept, outcome: "not_applied" }] } }],
		});
		expect(core.commits).toEqual([]);
		core.releaseFailures = { mode: "down", count: 0 };
		expect(await service.boundary(CODING_MACHINE_ID)).toMatchObject({
			reads: "released",
			views: [{ report: { commitId: expect.any(String), paths: [{ path: "docs/out.txt", outcome: "saved" }] } }],
		});
		expect(releasesOf(core).at(-1)).toEqual([SESSION, [["docs/plan.md", v(1)]]]);
	});

	it("refuses a save whose machine read something no longer readable, under any of its views, and holds a denied one until the view's final boundary", async () => {
		const { core, service, open } = await company();
		const first = await open();
		const second = await open(SECOND);
		await first.read(PLAN);
		await service.boundary(CODING_MACHINE_ID);
		const reportOf = (boundary: MachineBoundary) => boundary.views.find((view) => view.viewId === SECOND)?.report;
		const byPath = (boundary: MachineBoundary) =>
			[...(reportOf(boundary)?.paths ?? [])].sort((a, b) => (a.path < b.path ? -1 : 1));
		// The second view read nothing, but its machine did: its save is refused, and the executor moves the machine
		// (rule 4). Nothing of it is let go.
		core.hidden = (path) => path === "docs/plan.md";
		await write(second, "docs/b.txt", "b");
		await second.mkdir("docs/new");
		const unreadable = await service.boundary(CODING_MACHINE_ID);
		expect(reportOf(unreadable)?.refused).toBe("unreadable");
		expect(byPath(unreadable)).toEqual([
			{ path: "docs/b.txt", outcome: "refused", reason: "unreadable", kept: true },
			{ path: "docs/new", outcome: "refused", reason: "unreadable", kept: true },
		]);
		core.hidden = () => false;
		core.commitRefusal = "denied";
		const denied = await service.boundary(CODING_MACHINE_ID);
		expect(reportOf(denied)?.refused).toBe("denied");
		expect(byPath(denied)).toEqual([
			{ path: "docs/b.txt", outcome: "refused", reason: "denied", kept: true },
			{ path: "docs/new", outcome: "refused", reason: "denied", kept: true },
		]);
		// At the view's final boundary a denial is final: what it refused is let go, as a desktop's is, but for bytes the
		// core never had.
		const last = await service.boundary(CODING_MACHINE_ID, [SECOND]);
		expect(reportOf(last)?.refused).toBe("denied");
		expect(byPath(last)).toEqual([
			{ path: "docs/b.txt", outcome: "refused", reason: "denied", kept: true },
			{ path: "docs/new", outcome: "refused", reason: "denied" },
		]);
		core.commitRefusal = undefined;
		expect(reportOf(await service.boundary(CODING_MACHINE_ID))?.paths).toEqual([
			{ path: "docs/b.txt", outcome: "saved" },
		]);
		expect(core.entries.has("docs/new")).toBe(false);
	});

	it("clears served_by at a clean stop, after every read is released and every change published; another run's views are refused", async () => {
		const { core, service, serve, open, session } = await company();
		const view = await open();
		await view.read(PLAN);
		await write(view, "docs/out.txt", "o");
		const host = await open(HOST_VIEW, AT_HOST);
		await write(host, "docs/host.txt", "h");
		expect(session.servedBy).not.toBeNull();
		expect(core.views.get(HOST_VIEW)?.servedBy).toBe(session.servedBy);
		expect(await service.stopCleanly()).toBe(true);
		expect(releasesOf(core)).toEqual([[SESSION, [["docs/plan.md", v(1)]]]]);
		expect(core.entries.get("docs/out.txt")?.fileSha256).toBe(hashOf("o"));
		expect(core.entries.get("docs/host.txt")?.fileSha256).toBe(hashOf("h"));
		expect(core.stopped).toHaveLength(1);
		expect(session.servedBy).toBeNull();
		expect(core.views.get(HOST_VIEW)?.servedBy).toBeNull();
		// It serves nothing more.
		await expect(view.list("docs", undefined)).rejects.toMatchObject({ code: "UNAVAILABLE" });
		await expect(service.boundary(CODING_MACHINE_ID)).rejects.toMatchObject({ code: "UNAVAILABLE" });
		// The next run serves the view; a run after that one, which did not stop cleanly, is refused it, and the core
		// closes it (the executor restarts the machine).
		const next = serve();
		expect((await (await open(SESSION, AT_CODING, next)).list("docs", undefined)).entries.length).toBe(4);
		await expect(open(SESSION, AT_CODING, serve())).rejects.toMatchObject({ code: "VIEW_CLOSED" });
		expect(session.state).toBe("closed");
		expect(core.stopped).toHaveLength(1);
	});

	it("does not stop cleanly while a read of a coding machine is unreleased: served_by stays", async () => {
		const { core, service, open, session } = await company();
		const view = await open();
		await view.read(PLAN);
		core.releaseRefusal = "stopped";
		expect(await service.stopCleanly()).toBe(false);
		expect(core.stopped).toEqual([]);
		expect(session.servedBy).not.toBeNull();
	});

	it("does not stop cleanly while a coding machine holds a read it lost, though none of its views is open", async () => {
		const { core, service, open } = await company();
		const view = await open();
		await view.read(PLAN);
		core.views.get(SESSION)!.state = "closed";
		await service.renewLeases();
		expect(await service.stopCleanly()).toBe(false);
		expect(core.stopped).toEqual([]);
	});
});

describe("the control socket", () => {
	/** One connection: the lines sent, if any (then its side ends), and each answer until the service ended its side. A
	 * refusal closes the connection once it is out: an error after it is the close. */
	const ask = (path: string, text = "") =>
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
			if (text !== "") socket.end(text);
		});

	it("answers the coding executor's boundaries and restarts, and refuses every peer while the socket's file lets another connect", async () => {
		// Under /tmp (root's, sticky), not $TMPDIR: every folder above the socket counts.
		const dir = await realpath(await mkdtemp("/tmp/qfc-"));
		cleanups.push(() => rm(dir, { recursive: true, force: true }));
		const path = join(dir, "control.sock");
		const uid = process.getuid?.() ?? 0;
		const asked: [string, readonly string[]][] = [];
		const restarts: string[] = [];
		const target = {
			boundary: async (machine: string, final: readonly string[]): Promise<MachineBoundary> => {
				asked.push([machine, final]);
				return { machine, reads: "released", views: [] };
			},
			restarted: (machine: string) => {
				restarts.push(machine);
			},
			openWindow: () => undefined,
			closeWindow: async (machine: string): Promise<MachineBoundary> => ({ machine, reads: "released", views: [] }),
		};
		const close = (server: Server) => new Promise<void>((resolve) => server.close(() => resolve()));
		/** A control server on the socket, for an executor of `executorUid`, the socket's file made `mode`. */
		const listen = async (executorUid: number | undefined, mode: number) => {
			await rm(path, { force: true });
			const server = createControlServer({ target, path, executorUid, log: () => undefined });
			await new Promise<void>((resolve) => server.listen(path, resolve));
			cleanups.push(() => close(server));
			await chmod(path, mode);
			return server;
		};
		const REFUSED = "This socket admits only the executor of the coding and test machines";
		const refused = { error: { code: "VIEW_REFUSED", message: REFUSED } };
		const MACHINE = "machine is a coding machine's id or a test machine's placement id";

		// The kernel lets a uid connect only with write permission on the file, so a connection is served only while the
		// file is the executor's and no one else's: otherwise any peer may be calling, as this test's is.
		let server = await listen(uid + 1, 0o600);
		expect(socketRefusal(path, uid + 1)).toMatch(/not the executor's/);
		expect(await ask(path)).toEqual([refused]);
		await close(server);
		server = await listen(undefined, 0o600);
		expect(socketRefusal(path, undefined)).toMatch(/no executor uid/);
		expect(await ask(path)).toEqual([refused]);
		await close(server);
		server = await listen(uid, 0o660);
		expect(socketRefusal(path, uid)).toMatch(/lets other users connect/);
		expect(await ask(path)).toEqual([refused]);
		// Nor in a folder another user may change: they could put their own socket there.
		await chmod(path, 0o600);
		await chmod(dir, 0o777);
		expect(socketRefusal(path, uid)).toMatch(/may be changed by another user/);
		expect(await ask(path)).toEqual([refused]);
		await chmod(dir, 0o700);
		expect(socketRefusal(dir, uid)).toMatch(/is not a socket/);
		expect(asked).toEqual([]);
		expect(restarts).toEqual([]);

		// The executor's alone: each request answered in order, a bad one with why.
		expect(socketRefusal(path, uid)).toBeUndefined();
		const answers = await ask(
			path,
			[
				{ op: "boundary", machine: CODING_MACHINE_ID },
				{ op: "publish", machine: CODING_MACHINE_ID },
				{ op: "boundary", machine: "machine-1" },
				{ op: "boundary", machine: CODING_MACHINE_ID, final: [SESSION, SESSION] },
				{ op: "restarted", machine: CODING_MACHINE_ID, final: [] },
				{ op: "restarted", machine: "machine-1" },
				{ op: "restarted", machine: CODING_MACHINE_ID },
			]
				.map((line) => `${JSON.stringify(line)}\n`)
				.join(""),
		);
		expect(answers).toEqual([
			{ boundary: { machine: CODING_MACHINE_ID, reads: "released", views: [] } },
			{ error: { code: "BAD_REQUEST", message: "A request's op is boundary, restarted, open or close" } },
			{ error: { code: "BAD_REQUEST", message: MACHINE } },
			{ boundary: { machine: CODING_MACHINE_ID, reads: "released", views: [] } },
			{ error: { code: "BAD_REQUEST", message: "A restarted request is {op, machine}" } },
			{ error: { code: "BAD_REQUEST", message: MACHINE } },
			{ restarted: { machine: CODING_MACHINE_ID } },
		]);
		expect(asked).toEqual([
			[CODING_MACHINE_ID, []],
			[CODING_MACHINE_ID, [SESSION]],
		]);
		expect(restarts).toEqual([CODING_MACHINE_ID]);
	});
});
