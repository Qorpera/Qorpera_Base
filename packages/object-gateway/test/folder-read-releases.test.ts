import { mkdtemp, rm } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	CoreAnswerError,
	type CoreReceipt,
	CoreRefusal,
	MEMBER_HELD_READS,
	type ReleasedRead,
	SupabaseFolderCore,
} from "../src/folder-service/core.ts";
import type { Transport } from "../src/folder-service/https-request.ts";
import { DESKTOP_QUIET_MS } from "../src/folder-service/mounts.ts";
import { NasObjects } from "../src/folder-service/objects.ts";
import {
	type BridgeInfo,
	encodeJson,
	type Frame,
	FrameReader,
	type Hello,
	Kind,
	parseReads,
	type ReadLogEntry,
} from "../src/folder-service/protocol.ts";
import { createFolderServer } from "../src/folder-service/server.ts";
import { FolderService, type ViewHandle } from "../src/folder-service/service.ts";
import { FolderStaging } from "../src/folder-service/staging.ts";
import {
	ALLOCATION,
	BRIDGE,
	companyGrants,
	ENV,
	FakeCore,
	FakeUploads,
	folder,
	hashOf,
	OFFICE,
	PASS as OPERATOR_PASS,
	storeFile,
	v,
	writableGrants,
} from "./folder-service-fixtures.ts";

/** Reads released before the saves they may have made (F3 step 4, slice 4c: deploy/first-node/
 * RUNTIME-FOLDER-COMPANY-MACHINES.md, "Reads"): a company machine on protocol 3 sends its view the entries of its read
 * log, and each boundary of the view first releases the reads the core does not have yet, under the view, into its
 * read set. A boundary whose release is refused, or gets no answer, publishes nothing; a machine that cannot show its
 * log complete has every later boundary refused. */
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const VIEW = "6f708192-a3b4-4c5d-8e6f-708192a3b4c5";
const PASS = "readpass_0123456789-abcdefghijklmnopqrstuvw";
const LOG = "7a8b9c0d-1e2f-4a3b-8c4d-5e6f7a8b9c0d";
const OTHER = "8b9c0d1e-2f3a-4b4c-9d5e-6f7a8b9c0d1e";
const hello: Hello = { protocol: 3, environmentId: ENV, viewId: VIEW, pass: PASS, role: "io" };
const AT_OFFICE: BridgeInfo = { cid: 90, lookup: "found", machine: OFFICE };
/** The receipt a read with none is released under: it names nothing, so the core refuses it while the path is not
 * readable. */
const NONE = {
	resourceId: "00000000-0000-0000-0000-000000000000",
	resourceRevision: 0,
	grantId: null,
	grantRevision: null,
};
const receipt = (n: number): CoreReceipt => ({
	resourceId: v(60),
	resourceRevision: n,
	grantId: v(61),
	grantRevision: 1,
});
const entry = (
	seq: number,
	path = "docs/plan.md",
	version: string | null = v(1),
	authority: CoreReceipt = receipt(1),
): ReadLogEntry => ({ seq, path, version, authority });

/** A company folder with one plan and one view the core opened (a desktop of the company machine, unless said
 * otherwise), and the node's service with the office project configured (forgetting views idle for `idleMs`, if
 * given). */
async function company(kind = "computer_desktop", idleMs?: number) {
	const root = await mkdtemp(join(tmpdir(), "qorpera-folder-reads-"));
	const core = new FakeCore();
	core.seed([folder("docs"), await storeFile(root, "docs/plan.md", "the plan", 1)]);
	core.openView(VIEW, PASS, { kind, machineId: ALLOCATION });
	const objects = new NasObjects({ root, cacheBytes: 64 * 1024 * 1024 });
	const service = new FolderService({
		core,
		objects,
		grants: companyGrants(),
		staging: new FolderStaging(core, new FakeUploads(root, core), objects),
		log: () => undefined,
		...(idleMs === undefined ? {} : { idleMs }),
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
	return { core, service, open, root, coreView: core.views.get(VIEW)! };
}

/** A small file, written as the folder program writes it: opened with truncate, its one chunk, closed. The version
 * the close gave it. */
async function write(view: ViewHandle, path: string, text: string): Promise<string> {
	const { handle } = await view.open({ path, create: true, exclusive: false, truncate: true });
	const data = Buffer.from(text);
	await view.chunk({ handle, index: 0, sha256: hashOf(data), bytes: data.byteLength, offset: 0, data });
	return (await view.close(handle, data.byteLength)).version;
}

const take = (view: ViewHandle, log: string, reads: ReadLogEntry[], lost = false) => view.reads({ log, reads, lost });

async function until(done: () => boolean, ms = 3_000): Promise<void> {
	for (const end = Date.now() + ms; !done() && Date.now() < end; )
		await new Promise((resolve) => setTimeout(resolve, 10));
	expect(done()).toBe(true);
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

/** The core client over a transport that answers every request with `status` and `answer`, and what it was asked. A
 * client of its own each time: an answer of the wrong shape counts against the dependency. */
function coreAnswering(status: number, answer: unknown) {
	const asked: { path: string; body: unknown }[] = [];
	const transport: Transport = async (url, request) => {
		asked.push({ path: url.pathname, body: JSON.parse(request.body ?? "null") });
		return { status, body: Buffer.from(JSON.stringify(answer)) };
	};
	return {
		asked,
		core: new SupabaseFolderCore({ projectUrl: "https://cloud.test", secretKey: "sb_secret_fixture", transport }),
	};
}

describe("the core's releases", () => {
	const actor = { kind: "view", viewId: VIEW, pass: PASS } as const;
	const RELEASE = v(70);
	const reads: ReleasedRead[] = [{ path: "docs/plan.md", version: v(1), authority: receipt(1) }];
	const release = (status: number, answer: unknown) =>
		coreAnswering(status, answer).core.releaseReads(ENV, actor, RELEASE, reads);

	it("releases a view's reads with the view as the actor, and reads the answer", async () => {
		const ok = { schema: "qorpera.folder-release/v1", releaseId: RELEASE, reads: 1, replay: false };
		const { asked, core } = coreAnswering(200, ok);
		expect(await core.releaseReads(ENV, actor, RELEASE, reads)).toEqual({ releaseId: RELEASE, replay: false });
		expect(asked).toEqual([
			{
				path: "/rest/v1/rpc/qorpera_folder_record_release",
				body: {
					p_environment_id: ENV,
					p_actor: { kind: "view", viewId: VIEW, pass: PASS },
					p_release_id: RELEASE,
					p_reads: reads,
					p_output_sha256: "0".repeat(64),
				},
			},
		]);
		expect(await release(200, { ...ok, replay: true })).toEqual({ releaseId: RELEASE, replay: true });
		// An answer of another shape, for another release or another count of reads, is no answer.
		for (const bad of [
			{ ...ok, schema: "qorpera.folder-release/v2" },
			{ ...ok, releaseId: v(71) },
			{ ...ok, reads: 2 },
			{ ...ok, replay: "no" },
			[],
			null,
		])
			await expect(release(200, bad)).rejects.toBeInstanceOf(CoreAnswerError);
	});

	it("tells the core's refusals of a release apart, with what it said, from a release it could not take now", async () => {
		for (const [status, code, message, reason] of [
			[403, "42501", "A released read is no longer readable", "unreadable"],
			[403, "42501", "Run is unavailable", "run_ended"],
			[403, "42501", "Folder view is unavailable", "denied"],
			[409, "55000", "Company is paused", "stopped"],
			[400, "22023", MEMBER_HELD_READS, "invalid"],
		] as const) {
			const error = await release(status, { code, message }).catch((e: unknown) => e);
			expect(error).toBeInstanceOf(CoreRefusal);
			expect(error).toMatchObject({ reason, said: message });
		}
		// A lock conflict is asked again, as is a core that did not answer.
		const changed = { code: "QRC01", message: "Company folder changed while the erasure began; retry" };
		const conflict = await release(409, changed).catch((e: unknown) => e);
		expect(conflict).not.toBeInstanceOf(CoreRefusal);
		expect(conflict).toMatchObject({ status: 409 });
		await expect(release(503, { message: "down" })).rejects.toMatchObject({ status: 503 });
	});
});

describe("a machine's read log", () => {
	it("reads a batch of the log, and refuses one that is not consecutive or not well formed", () => {
		const json = (value: unknown) => Buffer.from(JSON.stringify(value));
		const noGrant = { ...receipt(2), grantId: null, grantRevision: null };
		const good = {
			log: LOG,
			reads: [entry(1), entry(2, "docs", null, noGrant), { seq: 3, path: "docs/a.md", version: null }],
		};
		expect(parseReads(json(good))).toEqual({ ...good, lost: false });
		expect(parseReads(json({ ...good, lost: true })).lost).toBe(true);
		expect(parseReads(json({ log: LOG, reads: [] }))).toEqual({ log: LOG, reads: [], lost: false });
		for (const bad of [
			{ ...good, reads: [entry(1), entry(3)] },
			{ ...good, reads: [entry(2), entry(1)] },
			{ ...good, reads: [entry(0)] },
			// The folder's root is not logged.
			{ ...good, reads: [entry(1, "", null)] },
			{ ...good, reads: [entry(1, "docs/plan.md", "V1")] },
			{ ...good, reads: [entry(1, "docs/plan.md", v(1), { ...receipt(1), resourceId: "r1" })] },
			{ ...good, reads: [entry(1, "docs/plan.md", v(1), { ...receipt(1), grantId: null })] },
			{ ...good, reads: [{ ...entry(1), at: 1 }] },
			{ ...good, reads: [{ seq: 1, path: "docs/plan.md" }] },
			{ ...good, reads: [null] },
			{ ...good, reads: {} },
			{ ...good, lost: "yes" },
			{ ...good, extra: true },
			{ ...good, log: "log-1" },
		])
			expect(() => parseReads(json(bad))).toThrow();
	});

	it("releases each read at the version the core made that the view showed it, or at none", async () => {
		const { core, service, open, root } = await company();
		const view = await open();
		// A file the view has not published yet is its own; a file the core made, at the version the view shows.
		const made = await write(view, "docs/new.md", "new");
		await take(view, LOG, [entry(1, "docs/new.md", made, receipt(1)), entry(2, "docs/plan.md", v(1), receipt(2))]);
		// The core makes another version: the one the view showed before is still placed, as is the new one; one it
		// never showed, and a folder's listing, go as none.
		core.write(await storeFile(root, "docs/plan.md", "the new plan", 2));
		await service.poll();
		await service.settled();
		await take(view, LOG, [
			entry(3, "docs/plan.md", v(1), receipt(3)),
			entry(4, "docs/plan.md", v(2), receipt(4)),
			entry(5, "docs/plan.md", v(99), receipt(5)),
			entry(6, "docs", null, receipt(6)),
		]);
		expect((await view.publish()).paths).toEqual([{ path: "docs/new.md", outcome: "saved" }]);
		expect(core.releases.map((r) => r.reads)).toEqual([
			[
				{ path: "docs/new.md", version: null, authority: receipt(1) },
				{ path: "docs/plan.md", version: v(1), authority: receipt(2) },
				{ path: "docs/plan.md", version: v(1), authority: receipt(3) },
				{ path: "docs/plan.md", version: v(2), authority: receipt(4) },
				{ path: "docs/plan.md", version: null, authority: receipt(5) },
				{ path: "docs", version: null, authority: receipt(6) },
			],
		]);
		// Published, the version the save made is the one its change set gave the path.
		await take(view, LOG, [entry(7, "docs/new.md", made, receipt(7))]);
		expect(await view.publish()).toEqual({ commitId: null, seq: null, paths: [] });
		expect(core.releases[1]?.reads).toEqual([
			{ path: "docs/new.md", version: core.entries.get("docs/new.md")!.version, authority: receipt(7) },
		]);
	});

	it("releases the reads before the save they may have made, a read with no receipt under none", async () => {
		const { core, open } = await company();
		const view = await open();
		const released: number[] = [];
		core.commitHook = () => {
			released.push(core.releases.length);
			return undefined;
		};
		await take(view, LOG, [entry(1), { seq: 2, path: "docs", version: null }]);
		await write(view, "docs/out.md", "out");
		expect((await view.publish()).paths).toEqual([{ path: "docs/out.md", outcome: "saved" }]);
		expect(released).toEqual([1]);
		expect(core.releases).toEqual([
			{
				viewId: VIEW,
				releaseId: expect.any(String),
				reads: [
					{ path: "docs/plan.md", version: v(1), authority: receipt(1) },
					{ path: "docs", version: null, authority: NONE },
				],
			},
		]);
		expect([...core.readSets.get(VIEW)!.keys()]).toEqual(["docs/plan.md", "docs"]);
	});

	it("releases the reads at a boundary with nothing to save, and says when every entry taken is released", async () => {
		const { core, open } = await company();
		const view = await open();
		expect(await take(view, LOG, [entry(1)])).toEqual({ log: LOG, taken: 1, released: 0 });
		expect(await view.publish()).toEqual({ commitId: null, seq: null, paths: [] });
		expect(core.releases).toHaveLength(1);
		expect(core.commits).toEqual([]);
		expect(core.readSets.get(VIEW)?.get("docs/plan.md")).toEqual({
			path: "docs/plan.md",
			version: v(1),
			authority: receipt(1),
		});
		expect(await take(view, LOG, [])).toEqual({ log: LOG, taken: 1, released: 1 });
	});

	it("takes each entry once, releases each read once, and leaves a batch with a gap to be sent again", async () => {
		const { core, open } = await company();
		const view = await open();
		expect(await take(view, LOG, [entry(1), entry(2)])).toEqual({ log: LOG, taken: 2, released: 0 });
		// Sent again from an entry it took: those are skipped.
		expect(await take(view, LOG, [entry(2), entry(3, "docs", null, receipt(2))])).toEqual({
			log: LOG,
			taken: 3,
			released: 0,
		});
		// A batch after a gap takes nothing: the machine sends again from what the view took.
		expect(await take(view, LOG, [entry(5)])).toEqual({ log: LOG, taken: 3, released: 0 });
		// Another log (the mount made again) starts where its batch does; a log not known with no entries is no log.
		expect(await take(view, OTHER, [entry(7)])).toEqual({ log: OTHER, taken: 7, released: 6 });
		expect(await take(view, v(80), [])).toEqual({ log: v(80), taken: 0, released: 0 });
		expect(await view.publish()).toEqual({ commitId: null, seq: null, paths: [] });
		expect(core.releases.map((r) => r.reads)).toEqual([
			[
				{ path: "docs/plan.md", version: v(1), authority: receipt(1) },
				{ path: "docs", version: null, authority: receipt(2) },
			],
		]);
		expect(await take(view, LOG, [])).toEqual({ log: LOG, taken: 3, released: 3 });
		expect(await take(view, OTHER, [])).toEqual({ log: OTHER, taken: 7, released: 7 });
	});

	it("releases at most 10,000 reads at a time", async () => {
		const { core, open } = await company();
		const view = await open();
		const many: ReadLogEntry[] = [];
		for (let seq = 1; seq <= 10_001; seq++) many.push({ seq, path: `docs/n${seq - 1}`, version: null });
		expect(await take(view, LOG, many)).toEqual({ log: LOG, taken: 10_001, released: 0 });
		expect(await view.publish()).toEqual({ commitId: null, seq: null, paths: [] });
		expect(core.releases.map((r) => r.reads.length)).toEqual([10_000, 1]);
		expect(core.releases[1]?.reads).toEqual([{ path: "docs/n10000", version: null, authority: NONE }]);
		expect(new Set(core.releases.map((r) => r.releaseId)).size).toBe(2);
		expect(await take(view, LOG, [])).toEqual({ log: LOG, taken: 10_001, released: 10_001 });
	});

	it("counts a member-held view's reads as released: such a view records none", async () => {
		const { core, open } = await company();
		core.memberHeld.add(VIEW);
		const view = await open();
		await take(view, LOG, [entry(1)]);
		await write(view, "docs/out.md", "out");
		expect((await view.publish()).paths).toEqual([{ path: "docs/out.md", outcome: "saved" }]);
		expect(core.readSets.has(VIEW)).toBe(false);
		expect(await take(view, LOG, [])).toEqual({ log: LOG, taken: 1, released: 1 });
	});

	it("counts an operator mount's reads as released at once: its view keeps no read set", async () => {
		const root = await mkdtemp(join(tmpdir(), "qorpera-folder-reads-operator-"));
		const core = new FakeCore();
		core.seed([folder("docs"), await storeFile(root, "docs/plan.md", "the plan", 1)]);
		const objects = new NasObjects({ root, cacheBytes: 64 * 1024 * 1024 });
		const service = new FolderService({
			core,
			objects,
			grants: writableGrants(),
			staging: new FolderStaging(core, new FakeUploads(root, core), objects),
			log: () => undefined,
		});
		const handles: ViewHandle[] = [];
		cleanups.push(async () => {
			for (const h of handles) h.release();
			service.stop();
			await rm(root, { recursive: true, force: true });
		});
		const view = await service.open(
			{ protocol: 3, environmentId: ENV, viewId: "proof", pass: OPERATOR_PASS, role: "io" },
			BRIDGE,
		);
		handles.push(view);
		expect(view).toMatchObject({ core: false, writable: true });
		expect(await take(view, LOG, [entry(1)])).toEqual({ log: LOG, taken: 1, released: 1 });
		await write(view, "docs/out.md", "out");
		expect((await view.publish()).paths).toEqual([{ path: "docs/out.md", outcome: "saved" }]);
		expect(core.releases).toEqual([]);
	});

	it("refuses every later boundary of a view whose machine lost its log, and lets the view go", async () => {
		const { core, open, coreView } = await company();
		const view = await open();
		expect(await take(view, LOG, [entry(1)], true)).toEqual({ log: LOG, taken: 1, released: 0 });
		await write(view, "docs/out.md", "out");
		await until(() => coreView.unsaved.length === 2);
		const refused = {
			commitId: null,
			seq: null,
			refused: "unproven",
			paths: [{ path: "docs/out.md", outcome: "refused", reason: "unproven", kept: true }],
		};
		expect(await view.publish()).toEqual(refused);
		expect(await view.publish()).toEqual(refused);
		expect(core.commits).toEqual([]);
		expect(core.releases).toEqual([]);
		// No machine holds it: it is let go, and the core hears at once that nothing is unsaved.
		view.release();
		await until(() => coreView.unsaved.length === 3);
		expect(coreView.unsaved.at(-1)).toBeNull();
		await settle();
		// A machine that comes back lists the view again, as new.
		const listed = core.listCalls;
		const again = await open();
		expect(core.listCalls).toBeGreaterThan(listed);
		expect(await again.publish()).toEqual({ commitId: null, seq: null, paths: [] });
	});
});

describe("a boundary whose release is not taken", () => {
	it("keeps a desktop's changes when its release gets no answer, asks the same release again, and lets it go once saved", async () => {
		const { core, service, open, coreView } = await company();
		const view = await open();
		await take(view, LOG, [entry(1)]);
		await write(view, "docs/out.md", "out");
		await until(() => coreView.unsaved.length === 2);
		core.releaseFailures = { mode: "down", count: 3 };
		expect(await view.publish()).toEqual({
			commitId: null,
			seq: null,
			paths: [
				{ path: "docs/out.md", outcome: "not_applied", reason: "the save did not get through yet", kept: true },
			],
		});
		expect(core.releases).toHaveLength(3);
		expect(new Set(core.releases.map((r) => r.releaseId)).size).toBe(1);
		expect(core.commits).toEqual([]);
		// No machine holds it: it is kept, and renewed, for its machine's next publish; its quiet period publishes nothing.
		view.release();
		await new Promise((resolve) => setTimeout(resolve, DESKTOP_QUIET_MS + 200));
		expect(core.releases).toHaveLength(3);
		const renewals = coreView.renewals;
		await service.renewLeases();
		expect(coreView.renewals).toBe(renewals + 1);
		const again = await open();
		expect((await again.publish()).paths).toEqual([{ path: "docs/out.md", outcome: "saved" }]);
		expect(core.releases).toHaveLength(4);
		expect(new Set(core.releases.map((r) => r.releaseId)).size).toBe(1);
		// Published, it is let go when its machine lets go: the core hears at once that nothing is unsaved, and it is no
		// longer renewed.
		again.release();
		await until(() => coreView.unsaved.at(-1) === null);
		await settle();
		const after = coreView.renewals;
		await service.renewLeases();
		expect(coreView.renewals).toBe(after);
	});

	it("decides what to do with a view whose last connection left during a boundary once that boundary ends", async () => {
		// A desktop kept for a release with no answer: its machine lets go while its next publish is being asked, and it
		// saves.
		const desk = await company();
		const view = await desk.open();
		await take(view, LOG, [entry(1)]);
		await write(view, "docs/out.md", "out");
		await until(() => desk.coreView.unsaved.length === 2);
		desk.core.releaseFailures = { mode: "down", count: 3 };
		expect((await view.publish()).paths).toEqual([
			{ path: "docs/out.md", outcome: "not_applied", reason: "the save did not get through yet", kept: true },
		]);
		let go = (): void => undefined;
		let asked = false;
		desk.core.commitHook = () => {
			asked = true;
			return new Promise<void>((resolve) => {
				go = resolve;
			});
		};
		const saving = view.publish();
		await until(() => asked);
		view.release();
		go();
		expect((await saving).paths).toEqual([{ path: "docs/out.md", outcome: "saved" }]);
		// Saved with no machine holding it: let go, the core hearing first that nothing is unsaved, so a machine that
		// comes back lists the view again, as new.
		await until(() => desk.coreView.unsaved.at(-1) === null);
		await settle();
		const renewals = desk.coreView.renewals;
		await desk.service.renewLeases();
		expect(desk.coreView.renewals).toBe(renewals);
		const lists = desk.core.listCalls;
		await desk.open();
		expect(desk.core.listCalls).toBeGreaterThan(lists);

		// A command's view, kept when its machine lets go while a publish is being asked that the core then refuses for
		// good: let go, so a machine that comes back lists the view again, as new.
		const cmd = await company("computer_shell_command");
		const first = await cmd.open();
		await take(first, LOG, [entry(1)]);
		await write(first, "docs/out.md", "out");
		let answer = (): void => undefined;
		let held = false;
		cmd.core.commitHook = () => {
			held = true;
			return new Promise<void>((resolve) => {
				answer = resolve;
			});
		};
		const refusing = first.publish();
		await until(() => held);
		first.release();
		cmd.core.commitRefusal = "denied";
		answer();
		expect(await refusing).toMatchObject({
			refused: "denied",
			paths: [{ path: "docs/out.md", outcome: "refused", reason: "denied", kept: true }],
		});
		await settle();
		const before = cmd.coreView.renewals;
		await cmd.service.renewLeases();
		expect(cmd.coreView.renewals).toBe(before);
		cmd.core.commitHook = undefined;
		const listed = cmd.core.listCalls;
		await cmd.open();
		expect(cmd.core.listCalls).toBeGreaterThan(listed);
	});

	it("leaves a view whose last connection left during a boundary to that boundary, not to the idle sweep", async () => {
		// A service that forgets a view as soon as it is idle (idleMs 0), swept while the boundary runs. Saved, the view is
		// let go then: the core hears at once that nothing is unsaved.
		const saves = await company("computer_desktop", 0);
		const view = await saves.open();
		await take(view, LOG, [entry(1)]);
		await write(view, "docs/out.md", "out");
		await until(() => saves.coreView.unsaved.length === 2);
		let go = (): void => undefined;
		let asked = false;
		saves.core.commitHook = (earlier) => {
			if (earlier > 0) return undefined;
			asked = true;
			return new Promise<void>((resolve) => {
				go = resolve;
			});
		};
		const saving = view.publish();
		await until(() => asked);
		view.release();
		await saves.service.poll();
		go();
		expect((await saving).paths).toEqual([{ path: "docs/out.md", outcome: "saved" }]);
		await until(() => saves.coreView.unsaved.at(-1) === null);

		// With no answer (that boundary's, and the one its last connection left asks again), the view is kept: past any
		// sweep, renewed, and found again by its machine, whose next publish saves it.
		const waits = await company("computer_desktop", 0);
		const first = await waits.open();
		await take(first, LOG, [entry(1)]);
		await write(first, "docs/out.md", "out");
		await until(() => waits.coreView.unsaved.length === 2);
		waits.core.commitFailures = { mode: "down", count: 6 };
		let answer = (): void => undefined;
		let held = false;
		waits.core.commitHook = (earlier) => {
			if (earlier > 0) return undefined;
			held = true;
			return new Promise<void>((resolve) => {
				answer = resolve;
			});
		};
		const unanswered = first.publish();
		await until(() => held);
		first.release();
		await waits.service.poll();
		answer();
		expect((await unanswered).paths).toEqual([
			{ path: "docs/out.md", outcome: "not_applied", reason: "the save did not get through yet", kept: true },
		]);
		await until(() => waits.core.commits.length === 6);
		await settle();
		await waits.service.poll();
		const renewals = waits.coreView.renewals;
		await waits.service.renewLeases();
		expect(waits.coreView.renewals).toBe(renewals + 1);
		const lists = waits.core.listCalls;
		const again = await waits.open();
		expect(waits.core.listCalls).toBe(lists);
		expect((await again.publish()).paths).toEqual([{ path: "docs/out.md", outcome: "saved" }]);
	});

	it("takes a release the core filed, whose answer was lost, as released when it replays", async () => {
		const { core, open } = await company();
		const view = await open();
		await take(view, LOG, [entry(1)]);
		await write(view, "docs/out.md", "out");
		core.releaseFailures = { mode: "lost", count: 1 };
		expect((await view.publish()).paths).toEqual([{ path: "docs/out.md", outcome: "saved" }]);
		expect(core.releases).toHaveLength(2);
		expect(core.releases[1]?.releaseId).toBe(core.releases[0]?.releaseId);
	});

	it("keeps a desktop's changes while its release is refused in a way that may lift, and saves them after", async () => {
		for (const reason of ["stopped", "run_ended"] as const) {
			const { core, service, open, coreView } = await company();
			const view = await open();
			await take(view, LOG, [entry(1)]);
			await write(view, "docs/out.md", "out");
			await until(() => coreView.unsaved.length === 2);
			core.releaseRefusal = reason;
			expect(await view.publish()).toEqual({
				commitId: null,
				seq: null,
				refused: reason,
				paths: [{ path: "docs/out.md", outcome: "refused", reason, kept: true }],
			});
			view.release();
			const renewals = coreView.renewals;
			await service.renewLeases();
			expect(coreView.renewals).toBe(renewals + 1);
			core.releaseRefusal = undefined;
			const again = await open();
			expect((await again.publish()).paths).toEqual([{ path: "docs/out.md", outcome: "saved" }]);
			const id = core.releases[0]!.releaseId;
			expect(core.releases.map((r) => r.releaseId)).toEqual([id, id]);
		}
	});

	it("lets a desktop go when its release is refused for good", async () => {
		const { core, service, open, coreView } = await company();
		const view = await open();
		await take(view, LOG, [entry(1)]);
		await write(view, "docs/out.md", "out");
		await until(() => coreView.unsaved.length === 2);
		core.releaseRefusal = "denied";
		expect(await view.publish()).toEqual({
			commitId: null,
			seq: null,
			refused: "denied",
			paths: [{ path: "docs/out.md", outcome: "refused", reason: "denied", kept: true }],
		});
		// No machine holds it: its last publish is refused again, and it is let go with nothing unsaved.
		view.release();
		await until(() => coreView.unsaved.length === 3);
		expect(coreView.unsaved.at(-1)).toBeNull();
		await settle();
		const renewals = coreView.renewals;
		await service.renewLeases();
		expect(coreView.renewals).toBe(renewals);
		expect(core.releases).toHaveLength(2);
		expect(core.commits).toEqual([]);
	});

	it("keeps a desktop's change set the pause refused, and saves it once the pause lifts", async () => {
		const { core, service, open, coreView } = await company();
		const view = await open();
		await write(view, "docs/out.md", "out");
		await until(() => coreView.unsaved.length === 2);
		core.commitRefusal = "stopped";
		expect(await view.publish()).toEqual({
			commitId: null,
			seq: null,
			refused: "stopped",
			paths: [{ path: "docs/out.md", outcome: "refused", reason: "stopped", kept: true }],
		});
		view.release();
		const renewals = coreView.renewals;
		await service.renewLeases();
		expect(coreView.renewals).toBe(renewals + 1);
		core.commitRefusal = undefined;
		const again = await open();
		expect((await again.publish()).paths).toEqual([{ path: "docs/out.md", outcome: "saved" }]);
		expect(core.commits).toHaveLength(2);
	});

	it("keeps a command's view while its release may be refused for a while, and lets it go when refused for good", async () => {
		const held = await company("computer_shell_command");
		const view = await held.open();
		await take(view, LOG, [entry(1)]);
		await write(view, "docs/out.md", "out");
		held.core.releaseRefusal = "run_ended";
		expect(await view.publish()).toEqual({
			commitId: null,
			seq: null,
			refused: "run_ended",
			paths: [{ path: "docs/out.md", outcome: "refused", reason: "run_ended", kept: true }],
		});
		view.release();
		const renewals = held.coreView.renewals;
		await held.service.renewLeases();
		expect(held.coreView.renewals).toBe(renewals + 1);
		held.core.releaseRefusal = undefined;
		const last = await held.open();
		expect(await last.publish(true)).toEqual({
			commitId: expect.any(String),
			seq: expect.any(Number),
			paths: [{ path: "docs/out.md", outcome: "saved" }],
			closed: true,
		});

		const gone = await company("computer_shell_command");
		const other = await gone.open();
		await take(other, LOG, [entry(1)]);
		await write(other, "docs/out.md", "out");
		gone.core.releaseRefusal = "denied";
		expect(await other.publish()).toEqual({
			commitId: null,
			seq: null,
			refused: "denied",
			paths: [{ path: "docs/out.md", outcome: "refused", reason: "denied", kept: true }],
		});
		// Refused for good, a command's view is let go as it is, and nothing publishes it.
		other.release();
		await settle();
		const before = gone.coreView.renewals;
		await gone.service.renewLeases();
		expect(gone.coreView.renewals).toBe(before);
		expect(gone.core.releases).toHaveLength(1);
		expect(gone.core.commits).toEqual([]);
	});

	it("takes a read log's entries on a command's view closed while its final had no answer, and keeps none", async () => {
		const { core, service, open, coreView } = await company("computer_shell_command");
		const first = await open();
		await take(first, LOG, [entry(1)]);
		await write(first, "docs/end.txt", "e");
		// The core applies the final, which closes the view, and no try gets its answer.
		core.commitFailures = { mode: "lost", count: 3 };
		expect((await first.publish(true)).commitId).toBeNull();
		expect(coreView.state).toBe("closed");
		expect(core.releases).toHaveLength(1);
		first.release();
		await settle();
		await service.renewLeases();
		// The dead program's last call hands its log over, a lost one too, and the connection stays: the core answers the
		// view nothing but the final's replay, so nothing comes of those reads.
		const last = await open();
		expect(await take(last, LOG, [entry(1), entry(2, "docs/end.txt")], true)).toEqual({
			log: LOG,
			taken: 2,
			released: 2,
		});
		expect(await take(last, OTHER, [])).toEqual({ log: OTHER, taken: 0, released: 0 });
		expect(await last.publish(true)).toEqual({
			commitId: expect.any(String),
			seq: expect.any(Number),
			paths: [{ path: "docs/end.txt", outcome: "saved" }],
			closed: true,
		});
		expect(core.releases).toHaveLength(1);
		expect(new Set(core.commits.map((c) => c.key)).size).toBe(1);
		// Answered, the view takes nothing more.
		await expect(take(last, LOG, [entry(3)])).rejects.toMatchObject({ code: "VIEW_CLOSED" });
	});
});

describe("access narrowed past a read", () => {
	it("refuses every save once a released read is no longer readable", async () => {
		const { core, open } = await company();
		const view = await open();
		await take(view, LOG, [entry(1)]);
		await write(view, "docs/out.md", "one");
		expect((await view.publish()).paths).toEqual([{ path: "docs/out.md", outcome: "saved" }]);
		core.authority((path) => path === "docs/plan.md");
		await write(view, "docs/out.md", "two");
		const refused = {
			commitId: null,
			seq: null,
			refused: "denied",
			paths: [{ path: "docs/out.md", outcome: "refused", reason: "denied", kept: true }],
		};
		expect(await view.publish()).toEqual(refused);
		expect(await view.publish()).toEqual(refused);
	});

	it("refuses every boundary while a read not released is no longer readable, and lets the view go", async () => {
		const { core, service, open, coreView } = await company();
		const view = await open();
		await take(view, LOG, [entry(1)]);
		core.authority((path) => path === "docs/plan.md");
		expect(await view.publish()).toEqual({ commitId: null, seq: null, refused: "unreadable", paths: [] });
		await write(view, "docs/out.md", "out");
		await until(() => coreView.unsaved.length === 2);
		expect(await view.publish()).toEqual({
			commitId: null,
			seq: null,
			refused: "unreadable",
			paths: [{ path: "docs/out.md", outcome: "refused", reason: "unreadable", kept: true }],
		});
		expect(core.releases).toHaveLength(2);
		expect(core.releases[1]?.releaseId).toBe(core.releases[0]?.releaseId);
		expect(core.commits).toEqual([]);
		view.release();
		await until(() => coreView.unsaved.length === 3);
		expect(coreView.unsaved.at(-1)).toBeNull();
		await settle();
		const renewals = coreView.renewals;
		await service.renewLeases();
		expect(coreView.renewals).toBe(renewals);
		expect(core.commits).toEqual([]);
	});
});

describe("the read log over the socket", () => {
	it("takes a core view's read log, and its writes, from a machine on protocol 3 alone", async () => {
		const { service } = await company();
		const dir = await mkdtemp(join(tmpdir(), "qorpera-folder-reads-socket-"));
		const server = createFolderServer(service, () => undefined);
		const path = join(dir, "service.sock");
		await new Promise<void>((resolve) => server.listen(path, resolve));
		cleanups.push(async () => {
			await new Promise<void>((resolve) => server.close(() => resolve()));
			await rm(dir, { recursive: true, force: true });
		});
		const client = async (protocol: number, role: "io" | "feed" = "io") => {
			const socket = connect(path);
			await new Promise<void>((resolve) => socket.once("connect", () => resolve()));
			cleanups.push(async () => {
				socket.destroy();
			});
			const reader = new FrameReader();
			const frames: Frame[] = [];
			const waiters: ((frame: Frame) => void)[] = [];
			socket.on("data", (data: Buffer) => {
				for (const frame of reader.push(data)) {
					const waiter = waiters.shift();
					if (waiter) waiter(frame);
					else frames.push(frame);
				}
			});
			const next = (): Promise<Frame> =>
				frames.length > 0 ? Promise.resolve(frames.shift()!) : new Promise((resolve) => waiters.push(resolve));
			const ask = async (kind: number, payload: Record<string, unknown>) => {
				socket.write(encodeJson(kind, payload));
				const frame = await next();
				return { kind: frame.kind, body: JSON.parse(frame.payload.toString()) as Record<string, unknown> };
			};
			socket.write(encodeJson(Kind.bridge, AT_OFFICE));
			const greeted = await ask(Kind.hello, { protocol, environmentId: ENV, viewId: VIEW, pass: PASS, role });
			return { hello: greeted, ask };
		};
		const v3 = await client(3);
		expect(v3.hello.body).toMatchObject({ protocol: 3, readOnly: false });
		expect(await v3.ask(Kind.reads, { log: LOG, reads: [entry(1)] })).toEqual({
			kind: Kind.readsOk,
			body: { log: LOG, taken: 1, released: 0 },
		});
		// The feed's hello says the view takes writes; the feed itself takes only acknowledgements.
		const feed = await client(3, "feed");
		expect(feed.hello.body).toMatchObject({ protocol: 3, readOnly: false });
		expect(await feed.ask(Kind.reads, { log: LOG, reads: [] })).toMatchObject({
			kind: Kind.error,
			body: { code: "BAD_REQUEST" },
		});
		// A machine on protocol 2 logs no reads: it reads a core view and writes nothing, and knows no read log.
		const v2 = await client(2);
		expect(v2.hello.body).toMatchObject({ protocol: 2, readOnly: true });
		expect(await v2.ask(Kind.mkdir, { path: "docs/x" })).toMatchObject({
			kind: Kind.error,
			body: { code: "READ_ONLY" },
		});
		expect(await v2.ask(Kind.reads, { log: LOG, reads: [] })).toMatchObject({
			kind: Kind.error,
			body: { code: "BAD_REQUEST", message: "Unknown request" },
		});
	});
});
