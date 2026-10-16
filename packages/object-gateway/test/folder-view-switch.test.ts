import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NasObjects } from "../src/folder-service/objects.ts";
import { type BridgeInfo, type Hello, parseHello } from "../src/folder-service/protocol.ts";
import { FolderService, type ViewHandle } from "../src/folder-service/service.ts";
import { FolderStaging } from "../src/folder-service/staging.ts";
import {
	ALLOCATION,
	companyGrants,
	ENV,
	FakeCore,
	FakeUploads,
	folder,
	hashOf,
	OFFICE,
	storeFile,
	v,
} from "./folder-service-fixtures.ts";

const PASS = "readpass_0123456789-abcdefghijklmnopqrstuvw";
const OLD = v(701);
const NEXT = v(702);
const AT_OFFICE: BridgeInfo = { cid: 90, lookup: "found", machine: OFFICE };
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const done of cleanup.splice(0).reverse()) await done();
});

async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "qorpera-folder-switch-"));
	const core = new FakeCore();
	core.checkViewPossession = true;
	const clock = { now: Date.now() };
	core.now = () => clock.now;
	core.seed([folder("docs"), await storeFile(root, "docs/plan.md", "old bytes", 1, 4 * 1024 * 1024)]);
	for (const id of [OLD, NEXT]) core.openView(id, PASS, { kind: "computer_desktop", machineId: ALLOCATION });
	const objects = new NasObjects({ root, cacheBytes: 1024 * 1024 });
	const uploads = new FakeUploads(root, core);
	const service = new FolderService({
		core,
		objects,
		staging: new FolderStaging(core, uploads, objects),
		grants: companyGrants(),
		now: () => clock.now,
		log: () => {},
	});
	const handles: ViewHandle[] = [];
	const hello = (id = OLD): Hello => ({ protocol: 3, environmentId: ENV, viewId: id, pass: PASS, role: "io" });
	const open = async (request = hello(), bridge = AT_OFFICE): Promise<ViewHandle> => {
		const handle = await service.open(request, bridge);
		handles.push(handle);
		return handle;
	};
	const move = (extra: Partial<Hello> = {}) =>
		open({ ...hello(NEXT), previous: { viewId: OLD, pass: PASS }, ...extra });
	cleanup.push(async () => {
		service.stop();
		for (const view of core.views.values()) view.state = "closed";
		await service.renewLeases();
		for (const handle of handles) handle.release();
		await rm(root, { recursive: true, force: true });
	});
	return { core, service, root, uploads, clock, open, move, hello };
}
async function chunk(view: ViewHandle, handle: number, text: string): Promise<void> {
	const data = Buffer.from(text);
	await view.chunk({ handle, index: 0, sha256: hashOf(data), bytes: data.length, offset: 0, data });
}
async function save(view: ViewHandle, path: string, text: string): Promise<string> {
	const opened = await view.open({ path, create: true, exclusive: false, truncate: true });
	await chunk(view, opened.handle, text);
	return (await view.close(opened.handle, text.length)).version;
}
const log = (lost = false) => ({ log: v(800), lost, reads: [{ seq: 1, path: "docs/plan.md", version: v(1) }] });
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("atomic company-desktop view handoff", () => {
	it("restages closed and abandoned fixed saves under the successor's own upload scope", async () => {
		for (const reopen of [false, true]) {
			const f = await fixture();
			const old = await f.open();
			await save(old, "docs/scoped.md", "fixed new bytes");
			expect([...f.core.sealedIntents.values()].some((seal) => seal.viewId === OLD)).toBe(true);
			if (reopen) {
				const opened = await old.open({ path: "docs/scoped.md", create: false, exclusive: false, truncate: false });
				await chunk(old, opened.handle, "unfixed bytes");
			}
			f.core.views.get(OLD)!.state = "closed";
			await f.service.renewLeases();
			const next = await f.move(reopen ? { abandon: true } : {});
			expect((await next.publish()).paths).toEqual([{ path: "docs/scoped.md", outcome: "saved" }]);
			const file = f.core.entries.get("docs/scoped.md");
			expect(file?.fileSha256).toBe(hashOf("fixed new bytes"));
			expect(
				[...f.core.sealedIntents.values()].some(
					(seal) => seal.viewId === NEXT && seal.manifestSha256 === file?.manifestSha256,
				),
			).toBe(true);
		}
	});

	it("moves open write handles and their original conflict base, and fences every old pooled connection", async () => {
		const f = await fixture();
		const old = await f.open();
		const pooled = await f.open();
		const { handle } = await old.open({
			path: "docs/plan.md",
			base: v(1),
			create: false,
			exclusive: false,
			truncate: true,
		});
		await chunk(old, handle, "first buffer");
		await old.reads(log());
		f.core.write(await storeFile(f.root, "docs/plan.md", "someone else's save", 2));
		f.core.views.get(OLD)!.state = "closed";
		await f.service.renewLeases();
		const next = await f.move();
		await expect(
			pooled.chunk({ handle, index: 0, bytes: 1, sha256: hashOf("x"), offset: 0, data: Buffer.from("x") }),
		).rejects.toMatchObject({ code: "VIEW_CLOSED" });
		await expect(old.reads(log())).rejects.toMatchObject({ code: "VIEW_CLOSED" });
		await chunk(next, handle, "my later buffer");
		await next.close(handle, 15);
		const report = await next.publish();
		expect(report.paths).toEqual([
			expect.objectContaining({ path: "docs/plan.md", outcome: "conflict", receipt: report.commitId }),
		]);
		expect(f.core.entries.get("docs/plan.md")?.fileSha256).toBe(hashOf("someone else's save"));
		expect(f.core.readSets.get(NEXT)?.get("docs/plan.md")?.version).toBe(v(1));
	});

	it("keeps handles across total stream loss, then a proven-dead publisher abandons only unfixed writes", async () => {
		const f = await fixture();
		const old = await f.open();
		await save(old, "docs/draft.md", "fixed");
		const opened = await old.open({ path: "docs/draft.md", create: false, exclusive: false, truncate: false });
		await chunk(old, opened.handle, "not closed");
		old.release();
		await tick();
		const reconnected = await f.open();
		expect((await reconnected.getChunk(opened.handle, 0)).toString()).toBe("not closed");
		await reconnected.close(opened.handle, 10);
		const second = await reconnected.open({
			path: "docs/draft.md",
			create: false,
			exclusive: false,
			truncate: false,
		});
		await chunk(reconnected, second.handle, "discard me");
		reconnected.release();
		const publisher = await f.open({ ...f.hello(), abandon: true });
		await expect(publisher.close(second.handle, 10)).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect((await publisher.publish()).paths).toEqual([{ path: "docs/draft.md", outcome: "saved" }]);
		expect(f.core.entries.get("docs/draft.md")?.fileSha256).toBe(hashOf("not closed"));
	});

	it("refuses wrong previous passes, machines and view kinds without altering the source", async () => {
		const f = await fixture();
		const old = await f.open();
		await save(old, "docs/kept.md", "kept");
		await expect(f.move({ previous: { viewId: OLD, pass: "wrong" } })).rejects.toMatchObject({
			code: "VIEW_REFUSED",
		});
		await expect(
			f.open(
				{ ...f.hello(NEXT), previous: { viewId: OLD, pass: PASS } },
				{ ...AT_OFFICE, machine: { ...OFFICE, name: `qorpera-office-${"f".repeat(32)}` } },
			),
		).rejects.toMatchObject({ code: "VIEW_REFUSED" });
		const command = v(703);
		f.core.openView(command, PASS, { kind: "computer_shell_command", machineId: ALLOCATION });
		await expect(f.open({ ...f.hello(command), previous: { viewId: OLD, pass: PASS } })).rejects.toMatchObject({
			code: "VIEW_REFUSED",
		});
		expect((await old.list("docs", undefined)).entries.map((entry) => entry.name)).toContain("kept.md");
		expect((await old.publish()).paths).toEqual([{ path: "docs/kept.md", outcome: "saved" }]);
	});

	it("waits for an accepted chunk's final store before moving and rejects new old-view requests during the fence", async () => {
		const f = await fixture();
		const old = await f.open();
		const { handle } = await old.open({ path: "docs/live.md", create: true, exclusive: false, truncate: true });
		let release!: () => void;
		f.uploads.endGate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const writing = chunk(old, handle, "in flight");
		await tick();
		let moved = false;
		const moving = f.move().then((view) => {
			moved = true;
			return view;
		});
		await tick();
		expect(moved).toBe(false);
		await expect(old.mkdir("blocked")).rejects.toMatchObject({ code: "BUSY" });
		release();
		await writing;
		const next = await moving;
		await next.close(handle, 9);
		expect((await next.publish()).paths).toEqual([{ path: "docs/live.md", outcome: "saved" }]);
	});

	it("repeats a handoff after a lost hello answer without moving or clearing the successor twice", async () => {
		const f = await fixture();
		const old = await f.open();
		await save(old, "docs/a.md", "a");
		const next = await f.move();
		await save(next, "docs/b.md", "b");
		const replay = await f.move();
		expect((await replay.publish()).paths.map((path) => path.path).sort()).toEqual(["docs/a.md", "docs/b.md"]);
		// A second file replacement before the first acknowledgement was checkpointed still proves OLD.
		const third = v(704);
		f.core.openView(third, PASS, { kind: "computer_desktop", machineId: ALLOCATION });
		await save(next, "docs/c.md", "c");
		const latest = await f.open({ ...f.hello(third), previous: { viewId: OLD, pass: PASS } });
		expect((await latest.publish()).paths).toEqual([{ path: "docs/c.md", outcome: "saved" }]);
	});

	it("replays an uncertain applied commit with the original actor and key before publishing any new work", async () => {
		const f = await fixture();
		const old = await f.open();
		await save(old, "docs/once.md", "once");
		f.core.commitFailures = { mode: "lost", count: 3 };
		expect((await old.publish()).paths[0]?.outcome).toBe("not_applied");
		const seq = f.core.seq;
		const key = f.core.commits[0]!.key;
		f.core.views.get(OLD)!.state = "closed";
		await f.service.renewLeases();
		const next = await f.move();
		expect((await next.publish()).paths).toEqual([{ path: "docs/once.md", outcome: "saved" }]);
		expect(f.core.commits.map((commit) => commit.key)).toEqual([key, key, key, key]);
		expect(f.core.seq).toBe(seq);
	});

	it("replans an uncertain unapplied old commit only after its exact replay proves the old view ended", async () => {
		const f = await fixture();
		const old = await f.open();
		await save(old, "docs/later.md", "later");
		f.core.commitFailures = { mode: "down", count: 3 };
		await old.publish();
		const oldKey = f.core.commits[0]!.key;
		f.core.views.get(OLD)!.state = "closed";
		await f.service.renewLeases();
		const next = await f.move();
		expect((await next.publish()).paths).toEqual([{ path: "docs/later.md", outcome: "saved" }]);
		expect(f.core.commits.slice(0, 4).map((commit) => commit.key)).toEqual([oldKey, oldKey, oldKey, oldKey]);
		expect(f.core.commits[4]?.key).not.toBe(oldKey);
	});

	it("carries unacknowledged releases and lost-log refusal, and never releases a lost log's save", async () => {
		for (const lost of [false, true]) {
			const f = await fixture();
			const old = await f.open();
			await save(old, "docs/result.md", "from old reads");
			await old.reads(log(lost));
			f.core.releaseFailures = { mode: "down", count: 3 };
			await old.publish();
			f.core.releaseFailures.count = 0;
			f.core.views.get(OLD)!.state = "closed";
			await f.service.renewLeases();
			const next = await f.move();
			const answer = await next.publish();
			if (lost) {
				expect(answer.refused).toBe("unproven");
				expect(f.core.commits).toHaveLength(0);
			} else {
				expect(answer.paths).toEqual([{ path: "docs/result.md", outcome: "saved" }]);
				expect(f.core.releases.at(-1)?.viewId).toBe(NEXT);
				expect(f.core.releases.at(-1)?.releaseId).not.toBe(f.core.releases[0]?.releaseId);
			}
		}
	});

	it("keeps a closed desktop for a fixed minute without renewing it, and expires pending state after the grace", async () => {
		for (const elapsed of [59_999, 60_001]) {
			const f = await fixture();
			const old = await f.open();
			await save(old, "docs/grace.md", "grace");
			f.core.views.get(OLD)!.state = "closed";
			await f.service.renewLeases();
			const renewals = f.core.views.get(OLD)!.renewals;
			old.release();
			f.clock.now += elapsed;
			await f.service.renewLeases();
			expect(f.core.views.get(OLD)!.renewals).toBe(renewals);
			if (elapsed < 60_000) expect((await (await f.move()).publish()).paths[0]?.path).toBe("docs/grace.md");
			else {
				await expect(f.move()).rejects.toMatchObject({ code: "VIEW_CLOSED" });
				await f.service.poll();
				expect((await (await f.move()).publish()).paths).toEqual([]);
				expect(f.core.entries.has("docs/grace.md")).toBe(false);
			}
		}
	});

	it("validates previous and abandoned-program hello fields strictly", () => {
		const hello = { protocol: 3, environmentId: ENV, viewId: NEXT, pass: PASS, role: "io" };
		const parse = (extra: object) => parseHello(Buffer.from(JSON.stringify({ ...hello, ...extra })));
		expect(parse({ previous: { viewId: OLD, pass: PASS }, abandon: true }).abandon).toBe(true);
		// Protocol 4 (links) keeps both fields.
		expect(parse({ protocol: 4, previous: { viewId: OLD, pass: PASS }, abandon: true })).toMatchObject({
			protocol: 4,
			previous: { viewId: OLD, pass: PASS },
			abandon: true,
		});
		for (const extra of [
			{ previous: null },
			{ previous: { viewId: NEXT, pass: PASS } },
			{ previous: { viewId: OLD, pass: PASS, extra: true } },
			{ previous: { viewId: OLD } },
			{ abandon: false },
			{ abandon: true, role: "feed" },
			{ abandon: true, protocol: 2 },
			{ protocol: 2, previous: { viewId: OLD, pass: PASS } },
		])
			expect(() => parse(extra)).toThrow();
	});
});
