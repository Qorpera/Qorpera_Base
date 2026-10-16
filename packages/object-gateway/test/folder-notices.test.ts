import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NOTICE_PATHS, NOTICES_KEPT, noticeOf, pageOfNotices } from "../src/folder-service/notices.ts";
import { NasObjects } from "../src/folder-service/objects.ts";
import { type BridgeInfo, type Hello, type Notice, parseHello, parseNotices } from "../src/folder-service/protocol.ts";
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
	v,
} from "./folder-service-fixtures.ts";

/** A view's notices (F3 4f-2b-2: deploy/first-node/RUNTIME-FOLDER-COMPANY-MACHINES.md, "How 4f-2 carries the
 * report"): what came of the boundaries no machine asked for, which the office's folder helper asks after on a
 * `notices` connection. The connection's side is in folder-service.test.ts. */
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const VIEW = "4d5e6f70-8192-4a3b-8c4d-5e6f708192a3";
const PASS = "deskpass_0123456789-abcdefghijklmnopqrstuvw";
const OTHER_PASS = "wrongpass_123456789-abcdefghijklmnopqrstuvw";
const hello: Hello = { protocol: 2, environmentId: ENV, viewId: VIEW, pass: PASS, role: "io" };
const noticesHello: Hello = { protocol: 4, environmentId: ENV, viewId: VIEW, pass: PASS, role: "notices" };
const AT_OFFICE: BridgeInfo = { cid: 90, lookup: "found", machine: OFFICE };
const AT_EXEC: BridgeInfo = { cid: 77, lookup: "found", machine: EXEC_HOST };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** The answer for a view the service does not hold. */
const NONE = { nonce: null, notices: [], last: 0, more: false };
const FIRST = { after: 0, nonce: null };

/** A company folder with a desktop the core opened for the company machine, the node's service, and the office's
 * folder helper asking for the desktop's notices. */
async function company(seed = [folder("docs")]) {
	const root = await mkdtemp(join(tmpdir(), "qorpera-folder-notices-"));
	const core = new FakeCore();
	core.seed(seed);
	core.openView(VIEW, PASS, { kind: "computer_desktop", machineId: ALLOCATION });
	const objects = new NasObjects({ root, cacheBytes: 64 * 1024 * 1024 });
	const service = new FolderService({
		core,
		objects,
		grants: companyGrants(),
		staging: new FolderStaging(core, new FakeUploads(root, core), objects),
		log: () => undefined,
	});
	const handles: ViewHandle[] = [];
	cleanups.push(async () => {
		for (const h of handles) h.release();
		service.stop();
		await rm(root, { recursive: true, force: true });
	});
	const open = async () => {
		const handle = await service.open(hello, AT_OFFICE);
		handles.push(handle);
		return handle;
	};
	const notices = (bridge: BridgeInfo = AT_OFFICE, pass = PASS) => service.notices({ ...noticesHello, pass }, bridge);
	return { core, open, notices };
}

/** A small file, written as the folder program writes it: opened with truncate, its one chunk, closed. */
async function write(view: ViewHandle, path: string, text: string): Promise<void> {
	const { handle } = await view.open({ path, create: true, exclusive: false, truncate: true });
	const data = Buffer.from(text);
	await view.chunk({ handle, index: 0, sha256: hashOf(data), bytes: data.byteLength, offset: 0, data });
	await view.close(handle, data.byteLength);
}

async function until(done: () => boolean, ms = 5_000): Promise<void> {
	for (const end = Date.now() + ms; !done() && Date.now() < end; )
		await new Promise((resolve) => setTimeout(resolve, 10));
	expect(done()).toBe(true);
}

/** The error code an ask is refused with. */
function refused(ask: () => unknown): string | undefined {
	try {
		ask();
	} catch (error) {
		return (error as { code?: string }).code;
	}
	return undefined;
}

describe("a view's notices", () => {
	it("keeps what came of a quiet boundary: a change set refused whole, with its paths, or committed", async () => {
		const { core, open, notices } = await company();
		const view = await open();
		const asks = notices();
		core.commitRefusal = "denied";
		await write(view, "docs/b.md", "b");
		await write(view, "docs/a.md", "a");
		// The quiet period's boundary: refused whole, it made no commit, so only its notice says so.
		await until(() => asks.page(FIRST).notices.length === 1);
		const first = asks.page(FIRST);
		expect(first).toEqual({
			nonce: expect.stringMatching(UUID),
			notices: [
				{ n: 1, at: expect.any(Number), refused: "denied", paths: ["docs/a.md", "docs/b.md"], pathCount: 2 },
			],
			last: 1,
			more: false,
		});
		expect(core.entries.has("docs/a.md")).toBe(false);
		const nonce = first.nonce;
		core.commitRefusal = undefined;
		await write(view, "docs/c.md", "c");
		await until(() => asks.page({ after: 1, nonce }).notices.length === 1);
		expect(asks.page({ after: 1, nonce })).toEqual({
			nonce,
			notices: [{ n: 2, at: expect.any(Number), commitId: expect.stringMatching(UUID), seq: expect.any(Number) }],
			last: 2,
			more: false,
		});
		expect(core.entries.has("docs/c.md")).toBe(true);
		// Asked after the last: nothing new. Asked about another series: from the view's first.
		expect(asks.page({ after: 2, nonce })).toEqual({ nonce, notices: [], last: 2, more: false });
		expect(asks.page({ after: 2, nonce: randomUUID() }).notices.map((n) => n.n)).toEqual([1, 2]);
		// A boundary the machine asked for is not kept: its answer reached the machine.
		await write(view, "docs/d.md", "d");
		core.commitRefusal = "denied";
		expect((await view.publish()).refused).toBe("denied");
		expect(asks.page({ after: 2, nonce }).notices).toEqual([]);
	});

	it("never opens, holds or keeps a view, and answers only its own machine, with its pass", async () => {
		const { core, open, notices } = await company();
		// No view held: none to give, and nothing listed for the asking.
		expect(notices().page(FIRST)).toEqual(NONE);
		expect(core.listCalls).toBe(0);
		// Nor while the core has not checked the view's pass yet.
		let listed!: () => void;
		core.listGate = new Promise((resolve) => {
			listed = resolve;
		});
		const opening = open();
		await until(() => core.listCalls > 0);
		const asks = notices();
		expect(asks.page(FIRST)).toEqual(NONE);
		listed();
		core.listGate = undefined;
		const view = await opening;
		const { nonce } = asks.page(FIRST);
		expect(nonce).toMatch(UUID);
		// Checked at each ask as a machine joining the view is: another company machine, the execution host, or another
		// pass of the view's shape, is refused; LXD not answering is "try again".
		const otherOffice: BridgeInfo = {
			cid: 91,
			lookup: "found",
			machine: { ...OFFICE, name: `qorpera-office-${"f".repeat(32)}` },
		};
		expect(refused(() => notices(otherOffice).page(FIRST))).toBe("VIEW_REFUSED");
		expect(refused(() => notices(AT_EXEC).page(FIRST))).toBe("VIEW_REFUSED");
		expect(refused(() => notices(AT_OFFICE, OTHER_PASS).page(FIRST))).toBe("VIEW_REFUSED");
		expect(refused(() => notices(AT_OFFICE, "not-a-view-pass"))).toBe("VIEW_REFUSED");
		expect(refused(() => notices({ cid: 90, lookup: "unavailable" }))).toBe("UNAVAILABLE");
		// The machine lets go with nothing pending: the view goes, its notices with it, whoever still asks.
		view.release();
		await until(() => asks.page(FIRST).nonce === null);
		const lists = core.listCalls;
		await open();
		expect(core.listCalls).toBeGreaterThan(lists);
		// The view opened again under the same key is another series.
		expect(asks.page(FIRST).nonce).toMatch(UUID);
		expect(asks.page(FIRST).nonce).not.toBe(nonce);
	});

	it("keeps a refusal that may lift at the last connection's leaving, with the view; one that may not goes with it", async () => {
		const { core, open, notices } = await company();
		const asks = notices();
		const view = await open();
		await write(view, "docs/a.md", "a");
		core.commitRefusal = "stopped";
		view.release();
		await until(() => asks.page(FIRST).notices.length === 1);
		expect(asks.page(FIRST).notices).toEqual([
			{ n: 1, at: expect.any(Number), refused: "stopped", paths: ["docs/a.md"], pathCount: 1 },
		]);
		// Kept for a later publish from its machine (F3 4c): joined again without listing, its notices still there.
		const lists = core.listCalls;
		const again = await open();
		expect(core.listCalls).toBe(lists);
		core.commitRefusal = undefined;
		expect((await again.publish()).paths).toEqual([{ path: "docs/a.md", outcome: "saved" }]);
		expect(asks.page(FIRST).notices.map((n) => n.n)).toEqual([1]);
		// Refused for good as the machine lets go: the view is let go, and its notices with it (the office asks for them
		// before it drains a desktop).
		await write(again, "docs/b.md", "b");
		core.commitRefusal = "denied";
		again.release();
		await until(() => asks.page(FIRST).nonce === null);
		expect(core.entries.has("docs/b.md")).toBe(false);
	});

	it("keeps the refusal of a boundary a change needed first", async () => {
		const { core, open, notices } = await company();
		const view = await open();
		const asks = notices();
		await view.rename({ from: "docs", to: "papers", noReplace: false });
		core.commitRefusal = "denied";
		// A change inside the moved folder publishes the move first. Refused whole, the move is let go, and the change
		// finds no folder to land in.
		await expect(write(view, "papers/a.md", "a")).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(asks.page(FIRST).notices).toEqual([
			{ n: 1, at: expect.any(Number), refused: "denied", paths: ["papers"], pathCount: 1 },
		]);
		expect((await view.list("", undefined)).entries.map((e) => e.name)).toEqual(["docs"]);
	});

	it("keeps the refusal of a change set asked again, whatever comes of the boundary's own after it", async () => {
		const { core, open, notices } = await company();
		const view = await open();
		const asks = notices();
		// The quiet period's change set gets no answer (asked three times): it is asked again before the next change.
		core.commitFailures = { mode: "down", count: 3 };
		await write(view, "docs/a.md", "a");
		await until(() => core.commits.length === 3);
		// Asked again, the pause refuses it, which holds it: the boundary plans it again as its own change set, which gets
		// no answer, and the change waits (BUSY). The refusal heard is kept all the same.
		core.commitRefusal = "stopped";
		core.commitHook = (asked) => {
			if (asked === 4) {
				core.commitRefusal = undefined;
				core.commitFailures = { mode: "down", count: 3 };
			}
			return undefined;
		};
		await expect(write(view, "docs/b.md", "b")).rejects.toMatchObject({ code: "BUSY" });
		const first = core.commits[0]!.key;
		expect(core.commits.map((c) => c.key === first)).toEqual([true, true, true, true, false, false, false]);
		expect(asks.page(FIRST).notices).toEqual([
			{ n: 1, at: expect.any(Number), refused: "stopped", paths: ["docs/a.md"], pathCount: 1 },
		]);
		// Asked again once more, it is saved before the change lands.
		await write(view, "docs/b.md", "b");
		expect(asks.page(FIRST).notices.at(-1)).toEqual({
			n: 2,
			at: expect.any(Number),
			commitId: expect.stringMatching(UUID),
			seq: expect.any(Number),
		});
		expect(core.entries.has("docs/a.md")).toBe(true);
	});

	it("makes each change set's notice from its own outcomes: the one asked again, then the boundary's own", async () => {
		const { core, open, notices } = await company([folder("docs"), folder("old")]);
		const view = await open();
		const asks = notices();
		// The quiet period's change set, a move and a new file, gets no answer (asked three times).
		core.commitFailures = { mode: "down", count: 3 };
		await view.rename({ from: "old", to: "archive", noReplace: false });
		await write(view, "docs/a.md", "a");
		await until(() => core.commits.length === 3);
		// Asked again before the next change, it is refused whole: the move is let go and the file's bytes stay pending.
		// The boundary's own change set, the file alone, is refused too: its notice names the file alone.
		core.commitRefusal = "denied";
		await write(view, "docs/b.md", "b");
		expect(core.commits.map((c) => c.units.length)).toEqual([2, 2, 2, 2, 1]);
		expect(asks.page(FIRST).notices.slice(0, 2)).toEqual([
			{ n: 1, at: expect.any(Number), refused: "denied", paths: ["archive", "docs/a.md"], pathCount: 2 },
			{ n: 2, at: expect.any(Number), refused: "denied", paths: ["docs/a.md"], pathCount: 1 },
		]);
	});

	it(`keeps a view's last ${NOTICES_KEPT}, each naming at most ${NOTICE_PATHS} paths`, async () => {
		const { core, open, notices } = await company();
		const asks = notices();
		core.commitRefusal = "stopped";
		// Each time the machine lets go, what is pending is refused again, all of it: the pause holds it (F3 4c).
		const written: string[] = [];
		for (let i = 1; i <= NOTICES_KEPT + 1; i++) {
			const view = await open();
			written.push(`docs/${i}.md`);
			await write(view, `docs/${i}.md`, `${i}`);
			view.release();
			await until(() => asks.page(FIRST).notices.at(-1)?.n === i);
		}
		const kept = asks.page(FIRST);
		expect(kept.notices.map((n) => n.n)).toEqual(Array.from({ length: NOTICES_KEPT }, (_, i) => i + 2));
		expect(kept).toMatchObject({ last: NOTICES_KEPT + 1, more: false });
		expect(kept.notices.at(-1)).toEqual({
			n: NOTICES_KEPT + 1,
			at: expect.any(Number),
			refused: "stopped",
			paths: [...written].sort().slice(0, NOTICE_PATHS),
			pathCount: NOTICES_KEPT + 1,
		});
		// After one the view no longer keeps: from its oldest kept.
		expect(asks.page({ after: 1, nonce: kept.nonce }).notices[0]?.n).toBe(2);
		expect(asks.page({ after: NOTICES_KEPT, nonce: kept.nonce }).notices.map((n) => n.n)).toEqual([NOTICES_KEPT + 1]);
	});

	it("makes a boundary's notice from its report", () => {
		expect(noticeOf({ commitId: v(5), seq: 7, paths: [{ path: "a", outcome: "saved" }] }, 3, 100)).toEqual({
			n: 3,
			at: 100,
			commitId: v(5),
			seq: 7,
		});
		// A commit some units of which were refused is a commit: the core's change set says what each did.
		expect(
			noticeOf({ commitId: v(5), seq: 7, paths: [{ path: "a", outcome: "refused", reason: "denied" }] }, 1, 0),
		).toMatchObject({ commitId: v(5) });
		// A refusal names the paths refused for its reason, once each, sorted.
		const paths = [
			{ path: "b", outcome: "refused", reason: "denied" },
			{ path: "a", outcome: "refused", reason: "denied" },
			{ path: "a", outcome: "refused", reason: "denied" },
			{ path: "c", outcome: "not_applied", reason: "still open for writing" },
			{ path: "d", outcome: "saved" },
		];
		expect(noticeOf({ commitId: null, seq: null, refused: "denied", paths }, 2, 50)).toEqual({
			n: 2,
			at: 50,
			refused: "denied",
			paths: ["a", "b"],
			pathCount: 2,
		});
		const many = Array.from({ length: NOTICE_PATHS + 5 }, (_, i) => ({
			path: `f${String(NOTICE_PATHS + 5 - i).padStart(2, "0")}`,
			outcome: "refused",
			reason: "unproven",
		}));
		expect(noticeOf({ commitId: null, seq: null, refused: "unproven", paths: many }, 1, 0)).toMatchObject({
			paths: many
				.map((p) => p.path)
				.sort()
				.slice(0, NOTICE_PATHS),
			pathCount: NOTICE_PATHS + 5,
		});
		// A boundary that neither committed nor was refused (nothing to publish, or no answer yet) has none.
		expect(noticeOf({ commitId: null, seq: null, paths: [] }, 1, 0)).toBeUndefined();
	});

	it("pages notices after the last one asked, at least one an answer", () => {
		const kept: Notice[] = [1, 2, 3].map((n) => ({ n, at: 0, commitId: v(n), seq: n }));
		const size = Buffer.byteLength(JSON.stringify(kept[0]));
		const nonce = randomUUID();
		expect(pageOfNotices(kept, 0, nonce, 2 * size)).toEqual({
			nonce,
			notices: kept.slice(0, 2),
			last: 2,
			more: true,
		});
		expect(pageOfNotices(kept, 2, nonce, 2 * size)).toEqual({ nonce, notices: kept.slice(2), last: 3, more: false });
		expect(pageOfNotices(kept, 3, nonce)).toEqual({ nonce, notices: [], last: 3, more: false });
		expect(pageOfNotices(kept, 0, nonce, 1)).toEqual({ nonce, notices: kept.slice(0, 1), last: 1, more: true });
		expect(pageOfNotices([], 0, nonce)).toEqual({ nonce, notices: [], last: 0, more: false });
	});

	it("reads a notices hello and ask", () => {
		const json = (value: unknown) => Buffer.from(JSON.stringify(value));
		const base = { protocol: 4, environmentId: ENV, viewId: VIEW, pass: PASS, role: "notices" };
		expect(parseHello(json(base))).toEqual(base);
		// Protocol 4 only, and it joins no mount: no previous view, no abandoned program.
		for (const bad of [{ protocol: 3 }, { previous: { viewId: "old", pass: PASS } }, { abandon: true }])
			expect(() => parseHello(json({ ...base, ...bad }))).toThrow("Bad notices request");
		expect(() => parseHello(json({ ...base, role: "relay" }))).toThrow("Bad role");
		const nonce = randomUUID();
		expect(parseNotices(json({ after: 3, nonce }))).toEqual({ after: 3, nonce });
		expect(parseNotices(json({ after: 0, nonce: null }))).toEqual({ after: 0, nonce: null });
		for (const bad of [
			{ after: -1, nonce: null },
			{ after: 1.5, nonce: null },
			{ after: "1", nonce: null },
			{ after: 0 },
			{ after: 0, nonce: "x" },
			{ after: 0, nonce: null, more: true },
		])
			expect(() => parseNotices(json(bad))).toThrow();
	});
});
