import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseViewRenewal } from "../src/folder-service/core.ts";
import { DESKTOP_QUIET_MS } from "../src/folder-service/mounts.ts";
import { NasObjects } from "../src/folder-service/objects.ts";
import type { BridgeInfo, Hello } from "../src/folder-service/protocol.ts";
import { FolderService, type ViewHandle } from "../src/folder-service/service.ts";
import { FolderStaging } from "../src/folder-service/staging.ts";
import {
	ALLOCATION,
	companyGrants,
	ENV,
	EXEC_HOST,
	FakeCore,
	FakeUploads,
	folder,
	hashOf,
	OFFICE,
} from "./folder-service-fixtures.ts";

/** Company machines on the folder (F3 step 4, slice 4a: deploy/first-node/RUNTIME-FOLDER-COMPANY-MACHINES.md): a
 * desktop view the core opened is served to its own company machine alone, writes, and publishes after two quiet
 * seconds; the core hears since when it has had changes not published. */
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const VIEW = "4d5e6f70-8192-4a3b-8c4d-5e6f708192a3";
const PASS = "deskpass_0123456789-abcdefghijklmnopqrstuvw";
const hello: Hello = { protocol: 2, environmentId: ENV, viewId: VIEW, pass: PASS, role: "io" };
const AT_OFFICE: BridgeInfo = { cid: 90, lookup: "found", machine: OFFICE };
const AT_EXEC: BridgeInfo = { cid: 77, lookup: "found", machine: EXEC_HOST };

/** A company folder with one view the core opened (a desktop of the company machine, unless said otherwise), and the
 * node's service with the office project configured. */
async function company(view: { kind?: string; machineId?: string | null } = {}, now?: () => number) {
	const root = await mkdtemp(join(tmpdir(), "qorpera-folder-desktops-"));
	const core = new FakeCore();
	if (now) core.now = now;
	core.seed([folder("docs")]);
	core.openView(VIEW, PASS, {
		kind: view.kind ?? "computer_desktop",
		machineId: view.machineId === undefined ? ALLOCATION : view.machineId,
	});
	const objects = new NasObjects({ root, cacheBytes: 64 * 1024 * 1024 });
	const service = new FolderService({
		core,
		objects,
		grants: companyGrants(),
		staging: new FolderStaging(core, new FakeUploads(root, core), objects),
		log: () => undefined,
		...(now ? { now } : {}),
	});
	const handles: ViewHandle[] = [];
	cleanups.push(async () => {
		for (const h of handles) h.release();
		service.stop();
		await rm(root, { recursive: true, force: true });
	});
	const open = async (bridge: BridgeInfo = AT_OFFICE) => {
		const handle = await service.open(hello, bridge);
		handles.push(handle);
		return handle;
	};
	return { core, service, open, desk: core.views.get(VIEW)! };
}

/** A small file, written as the folder program writes it: opened with truncate, its one chunk, closed. */
async function write(view: ViewHandle, path: string, text: string): Promise<void> {
	const { handle } = await view.open({ path, create: true, exclusive: false, truncate: true });
	const data = Buffer.from(text);
	await view.chunk({ handle, index: 0, sha256: hashOf(data), bytes: data.byteLength, offset: 0, data });
	await view.close(handle, data.byteLength);
}

const names = async (view: ViewHandle, path: string) => (await view.list(path, undefined)).entries.map((e) => e.name);

async function until(done: () => boolean, ms = 3_000): Promise<void> {
	for (const end = Date.now() + ms; !done() && Date.now() < end; )
		await new Promise((resolve) => setTimeout(resolve, 10));
	expect(done()).toBe(true);
}

describe("company machines' desktops", () => {
	it("reads the view's kind and machine from an open renewal, and refuses an open one without them", () => {
		const open = { schema: "qorpera.folder-view-renew/v1", state: "open", leaseUntil: "2026-10-06T12:02:00.000Z" };
		expect(parseViewRenewal({ ...open, kind: "computer_desktop", machineId: ALLOCATION })).toEqual({
			state: "open",
			leaseUntil: open.leaseUntil,
			kind: "computer_desktop",
			machineId: ALLOCATION,
		});
		expect(parseViewRenewal({ ...open, kind: "run_box", machineId: null })).toMatchObject({ machineId: null });
		for (const bad of [{}, { kind: "run_box" }, { kind: "", machineId: null }, { kind: "x", machineId: "office-1" }])
			expect(() => parseViewRenewal({ ...open, ...bad })).toThrow();
		// A closed answer is as it was.
		expect(
			parseViewRenewal({ schema: "qorpera.folder-view-renew/v1", state: "closed", reason: "superseded" }),
		).toEqual({ state: "closed", reason: "superseded" });
	});

	it("serves a desktop to its own company machine alone, and takes its writes", async () => {
		const { core, open } = await company();
		const otherOffice: BridgeInfo = {
			cid: 91,
			lookup: "found",
			machine: { ...OFFICE, name: `qorpera-office-${"f".repeat(32)}` },
		};
		const notOffice: BridgeInfo = { cid: 92, lookup: "found", machine: { ...OFFICE, project: "qn25b2" } };
		// Not the execution host, another company machine, or a machine of that name outside the office project.
		for (const bridge of [AT_EXEC, otherOffice, notOffice])
			await expect(open(bridge)).rejects.toMatchObject({ code: "VIEW_REFUSED" });
		await expect(open({ cid: 90, lookup: "unavailable" })).rejects.toMatchObject({ code: "UNAVAILABLE" });
		const view = await open();
		expect(view.writable).toBe(true);
		// Joining the open view with its pass is refused to another machine all the same.
		await expect(open(otherOffice)).rejects.toMatchObject({ code: "VIEW_REFUSED" });
		await write(view, "docs/a.md", "a");
		expect((await view.publish()).paths).toEqual([{ path: "docs/a.md", outcome: "saved" }]);
		expect(core.entries.get("docs/a.md")?.fileSha256).toBe(hashOf("a"));
	});

	it("serves a run box to the execution host alone, read-only, and other views to no machine yet", async () => {
		const box = await company({ kind: "run_box", machineId: null });
		await expect(box.open()).rejects.toMatchObject({ code: "VIEW_REFUSED" });
		expect((await box.open(AT_EXEC)).writable).toBe(false);
		// A coding session's view (step 5), and a desktop the core names no machine for.
		for (const view of [{ kind: "coding_session" }, { machineId: null }]) {
			const { open } = await company(view);
			for (const bridge of [AT_OFFICE, AT_EXEC])
				await expect(open(bridge)).rejects.toMatchObject({ code: "VIEW_REFUSED" });
		}
	});

	it("closes a desktop the core says changed kind or machine, with what it had pending", async () => {
		for (const change of [{ machineId: "c0ffee00-1111-4222-8333-777777777777" }, { kind: "coding_session" }]) {
			const { core, service, open, desk } = await company();
			const view = await open();
			await write(view, "docs/lost.md", "l");
			Object.assign(desk, change);
			await service.renewLeases();
			await expect(view.list("", undefined)).rejects.toMatchObject({
				code: "VIEW_CLOSED",
				message: "The view's kind or machine changed",
			});
			expect(core.commits).toEqual([]);
		}
	});

	it("publishes a desktop's changes two quiet seconds after the last one", async () => {
		expect(DESKTOP_QUIET_MS).toBe(2_000);
		const { core, open } = await company();
		const view = await open();
		await write(view, "docs/quiet.md", "q");
		await new Promise((resolve) => setTimeout(resolve, 1_000));
		expect(core.commits).toEqual([]);
		await until(() => core.entries.has("docs/quiet.md"));
	});

	it("tells the core since when a desktop has had changes not published, at once from the first", async () => {
		const clock = { now: Date.parse("2026-10-06T12:00:00.000Z") };
		const { service, open, desk } = await company({}, () => clock.now);
		const view = await open();
		expect(desk.unsaved).toEqual([null]);
		clock.now += 5_000;
		const since = new Date(clock.now).toISOString();
		// The first change renews the lease at once, without waiting for the round.
		await write(view, "docs/one.md", "1");
		await until(() => desk.unsaved.length === 2);
		expect(desk.unsaved).toEqual([null, since]);
		// Later changes keep the first one's time.
		clock.now += 5_000;
		await write(view, "docs/two.md", "2");
		await service.renewLeases();
		expect(desk.unsaved).toEqual([null, since, since]);
		// Published: nothing is unsaved.
		await view.publish();
		await service.renewLeases();
		expect(desk.unsaved).toEqual([null, since, since, null]);
	});

	it("counts no lock name a program still holds as unsaved, before or after the save", async () => {
		const clock = { now: Date.parse("2026-10-06T12:00:00.000Z") };
		const { core, service, open, desk } = await company({}, () => clock.now);
		const view = await open();
		// The program's lock file alone renews nothing early, and the round says nothing is unsaved.
		await write(view, "docs/.~lock.report.odt#", "lock");
		await service.renewLeases();
		expect(desk.unsaved).toEqual([null, null]);
		clock.now += 5_000;
		const since = new Date(clock.now).toISOString();
		await write(view, "docs/report.odt", "r");
		await until(() => desk.unsaved.length === 3);
		expect(desk.unsaved[2]).toBe(since);
		// Saved: the lock file stays in the view while the document is open, and the core hears nothing is unsaved.
		await view.publish();
		expect(core.entries.has("docs/report.odt")).toBe(true);
		expect(await names(view, "docs")).toContain(".~lock.report.odt#");
		await service.renewLeases();
		expect(desk.unsaved[3]).toBeNull();
	});

	it("tells the core nothing is unsaved when its machine lets go, then forgets the view", async () => {
		const { core, open, desk } = await company();
		const view = await open();
		await write(view, "docs/last.md", "l");
		await until(() => desk.unsaved.length === 2);
		expect(desk.unsaved[1]).not.toBeNull();
		view.release();
		// Published, then one renewal says so before the view goes: the seat is free now, not when the lease ends.
		await until(() => core.entries.has("docs/last.md") && desk.unsaved.length === 3);
		expect(desk.unsaved[2]).toBeNull();
		// A view the core last heard nothing unsaved of goes without one.
		const again = await open();
		const renewals = desk.unsaved.length;
		again.release();
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(desk.unsaved.length).toBe(renewals);
	});

	it("publishes what a desktop has pending when its machine lets go, then forgets the view", async () => {
		const { core, open } = await company();
		const view = await open();
		await write(view, "docs/last.md", "l");
		view.release();
		await until(() => core.entries.has("docs/last.md"));
		await new Promise((resolve) => setTimeout(resolve, 50));
		// Forgotten with its pass: a machine that comes back lists it again.
		const lists = core.listCalls;
		await open();
		expect(core.listCalls).toBeGreaterThan(lists);
	});

	it("lets go of a change the core parked for review, and shows the live folder", async () => {
		const { core, service, open, desk } = await company();
		core.park = (path) => path === "docs/idea.md";
		const view = await open();
		await write(view, "docs/idea.md", "idea");
		await write(view, "docs/ok.md", "ok");
		const report = await view.publish();
		expect([...report.paths].sort((a, b) => (a.path < b.path ? -1 : 1))).toEqual([
			{ path: "docs/idea.md", outcome: "waiting_for_review", reason: "parked" },
			{ path: "docs/ok.md", outcome: "saved" },
		]);
		// The proposal is the agent's next run's to review (P40): the view shows the live folder, with nothing pending.
		expect(await names(view, "docs")).toEqual(["ok.md"]);
		expect((await view.publish()).paths).toEqual([]);
		await service.renewLeases();
		expect(desk.unsaved.at(-1)).toBeNull();
	});
});
