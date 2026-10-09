import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DESKTOP_QUIET_MS } from "../src/folder-service/mounts.ts";
import { NasObjects } from "../src/folder-service/objects.ts";
import { type BridgeInfo, type Hello, parsePublish } from "../src/folder-service/protocol.ts";
import { FolderService, type ReportEntry, type ViewHandle } from "../src/folder-service/service.ts";
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

/** Shell commands on the folder (F3 step 4, slice 4b: deploy/first-node/RUNTIME-FOLDER-COMPANY-MACHINES.md, C1B §8): a
 * command's view the core opened is served to its own company machine alone and writes. It publishes only when asked,
 * or before a change that needs what is pending published first, never says it has changes unsaved, and is kept, with
 * what it has pending, when its last connection leaves: the command's last call publishes it final, and the core closes
 * the view with that change set. */
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const VIEW = "5e6f7081-92a3-4b4c-8d5e-6f708192a3b4";
const PASS = "cmdpass_0123456789-abcdefghijklmnopqrstuvwx";
const hello: Hello = { protocol: 2, environmentId: ENV, viewId: VIEW, pass: PASS, role: "io" };
const AT_OFFICE: BridgeInfo = { cid: 90, lookup: "found", machine: OFFICE };
const AT_EXEC: BridgeInfo = { cid: 77, lookup: "found", machine: EXEC_HOST };

/** A company folder with one view the core opened (a shell command's on the company machine, unless said otherwise),
 * and the node's service with the office project configured. */
async function company(kind = "computer_shell_command") {
	const root = await mkdtemp(join(tmpdir(), "qorpera-folder-commands-"));
	const core = new FakeCore();
	core.seed([folder("docs")]);
	core.openView(VIEW, PASS, { kind, machineId: ALLOCATION });
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
	const open = async (bridge: BridgeInfo = AT_OFFICE) => {
		const handle = await service.open(hello, bridge);
		handles.push(handle);
		return handle;
	};
	return { core, service, open, cmd: core.views.get(VIEW)! };
}

/** A small file, written as the folder program writes it: opened with truncate, its one chunk, closed. */
async function write(view: ViewHandle, path: string, text: string): Promise<void> {
	const { handle } = await view.open({ path, create: true, exclusive: false, truncate: true });
	const data = Buffer.from(text);
	await view.chunk({ handle, index: 0, sha256: hashOf(data), bytes: data.byteLength, offset: 0, data });
	await view.close(handle, data.byteLength);
}

const names = async (view: ViewHandle, path: string) => (await view.list(path, undefined)).entries.map((e) => e.name);
const byPath = (paths: readonly ReportEntry[]) => [...paths].sort((a, b) => (a.path < b.path ? -1 : 1));
const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

describe("shell commands' views", () => {
	it("reads a publish's final flag", () => {
		expect(parsePublish(Buffer.from("{}"))).toEqual({ final: false });
		expect(parsePublish(Buffer.from('{"final":true}'))).toEqual({ final: true });
		expect(parsePublish(Buffer.from('{"final":false}'))).toEqual({ final: false });
		for (const bad of ['{"final":"true"}', '{"final":1}', '{"final":null}', '{"last":true}'])
			expect(() => parsePublish(Buffer.from(bad))).toThrow();
	});

	it("serves a command's view to its own company machine alone, and publishes it only when asked", async () => {
		const access = companyGrants().coreAccess({ kind: "computer_shell_command", machineId: ALLOCATION });
		expect(access).toMatchObject({ write: true, command: true });
		expect(access?.quietMs).toBeUndefined();
		expect(companyGrants().coreAccess({ kind: "computer_shell_command", machineId: null })).toBeUndefined();
		const { core, open, cmd } = await company();
		const otherOffice: BridgeInfo = {
			cid: 91,
			lookup: "found",
			machine: { ...OFFICE, name: `qorpera-office-${"f".repeat(32)}` },
		};
		const notOffice: BridgeInfo = { cid: 92, lookup: "found", machine: { ...OFFICE, project: "qn25b2" } };
		// Not the execution host, another company machine, or a machine of that name outside the office project.
		for (const bridge of [AT_EXEC, otherOffice, notOffice])
			await expect(open(bridge)).rejects.toMatchObject({ code: "VIEW_REFUSED" });
		const view = await open();
		expect(view.writable).toBe(true);
		await expect(open(otherOffice)).rejects.toMatchObject({ code: "VIEW_REFUSED" });
		await write(view, "docs/out.txt", "o");
		// No quiet period publishes it.
		await new Promise((resolve) => setTimeout(resolve, DESKTOP_QUIET_MS + 500));
		expect(core.commits).toEqual([]);
		expect((await view.publish()).paths).toEqual([{ path: "docs/out.txt", outcome: "saved" }]);
		expect(core.commits.map((c) => c.final)).toEqual([false]);
		expect(cmd.state).toBe("open");
	});

	it("closes a command's view whose kind or machine changed, kept or not, and publishes nothing", async () => {
		for (const change of [{ machineId: "c0ffee00-1111-4222-8333-777777777777" }, { kind: "computer_desktop" }])
			for (const kept of [false, true]) {
				const { core, service, open, cmd } = await company();
				const view = await open();
				await write(view, "docs/lost.txt", "l");
				if (kept) {
					view.release();
					await settle();
				}
				Object.assign(cmd, change);
				await service.renewLeases();
				if (!kept)
					await expect(view.list("", undefined)).rejects.toMatchObject({
						code: "VIEW_CLOSED",
						message: "The view's kind or machine changed",
					});
				// Closed: neither renewed nor kept any more, and nothing was published.
				const renewals = cmd.renewals;
				await service.renewLeases();
				expect(cmd.renewals).toBe(renewals);
				expect(core.commits).toEqual([]);
			}
	});

	it("never tells the core a command's view has changes unsaved: no seat waits on it", async () => {
		const { service, open, cmd } = await company();
		const view = await open();
		await write(view, "docs/a.txt", "a");
		await settle();
		await service.renewLeases();
		expect(cmd.unsaved).toEqual([null, null]);
	});

	it("keeps a command's view when its last connection leaves, and publishes it final from the next", async () => {
		const { core, service, open, cmd } = await company();
		const view = await open();
		await write(view, "docs/result.txt", "r");
		view.release();
		await settle();
		// Nothing is published when the command's program lets go, and the view is still renewed with no connection.
		expect(core.commits).toEqual([]);
		const renewals = cmd.renewals;
		await service.renewLeases();
		expect(cmd.renewals).toBe(renewals + 1);
		const last = await open();
		expect(await names(last, "docs")).toContain("result.txt");
		expect(await last.publish(true)).toEqual({
			commitId: expect.any(String),
			seq: expect.any(Number),
			paths: [{ path: "docs/result.txt", outcome: "saved" }],
			closed: true,
		});
		expect(core.commits.map((c) => c.final)).toEqual([true]);
		expect(core.entries.get("docs/result.txt")?.fileSha256).toBe(hashOf("r"));
		expect(cmd.state).toBe("closed");
		await expect(last.list("", undefined)).rejects.toMatchObject({
			code: "VIEW_CLOSED",
			message: "The command's final change set was published",
		});
		// A closed view is neither renewed nor kept.
		const closedRenewals = cmd.renewals;
		await service.renewLeases();
		expect(cmd.renewals).toBe(closedRenewals);
	});

	it("publishes a final with nothing pending as an empty change set, which closes the view", async () => {
		const { core, open, cmd } = await company();
		const view = await open();
		expect(await view.publish(true)).toEqual({ commitId: expect.any(String), seq: null, paths: [], closed: true });
		expect(core.commits).toEqual([{ key: expect.any(String), units: [], final: true }]);
		expect(cmd.state).toBe("closed");
	});

	it("keeps a change set the core refuses once the command has ended, for the final to carry", async () => {
		const { core, open, cmd } = await company();
		const view = await open();
		await write(view, "docs/late.txt", "l");
		core.endCommand(VIEW);
		expect(await view.publish()).toEqual({
			commitId: null,
			seq: null,
			paths: [{ path: "docs/late.txt", outcome: "refused", reason: "denied", kept: true }],
			refused: "denied",
		});
		expect(await names(view, "docs")).toContain("late.txt");
		expect(await view.publish(true)).toMatchObject({
			paths: [{ path: "docs/late.txt", outcome: "saved" }],
			closed: true,
		});
		expect(core.commits.map((c) => c.final)).toEqual([false, true]);
		expect(core.entries.has("docs/late.txt")).toBe(true);
		expect(cmd.state).toBe("closed");
	});

	it("asks a final whose answer did not come again, final, under its key", async () => {
		// The answer lost after the core applied it: the replay answers though the view is closed now.
		const lost = await company();
		const view = await lost.open();
		await write(view, "docs/end.txt", "e");
		lost.core.commitFailures = { mode: "lost", count: 1 };
		expect(await view.publish(true)).toMatchObject({
			paths: [{ path: "docs/end.txt", outcome: "saved" }],
			closed: true,
		});
		expect(lost.core.commits.map((c) => c.final)).toEqual([true, true]);
		// No answer at all: the next boundary asks it again first, final, and the view closes with its answer.
		const down = await company();
		const again = await down.open();
		await write(again, "docs/end.txt", "e");
		down.core.commitFailures = { mode: "down", count: 3 };
		expect(await again.publish(true)).toEqual({
			commitId: null,
			seq: null,
			paths: [
				{ path: "docs/end.txt", outcome: "not_applied", reason: "the save did not get through yet", kept: true },
			],
		});
		expect(down.cmd.state).toBe("open");
		expect(await again.publish()).toMatchObject({
			paths: [{ path: "docs/end.txt", outcome: "saved" }],
			closed: true,
		});
		expect(new Set(down.core.commits.map((c) => c.key)).size).toBe(1);
		expect(down.core.commits.every((c) => c.final)).toBe(true);
		expect(down.cmd.state).toBe("closed");
	});

	it("gets a final's lost answer from its replay, after a renewal has closed the view the final closed", async () => {
		const { core, service, open, cmd } = await company();
		const view = await open();
		await write(view, "docs/end.txt", "e");
		// The core applies the final, which closes the view, and no try gets its answer.
		core.commitFailures = { mode: "lost", count: 3 };
		expect(await view.publish(true)).toEqual({
			commitId: null,
			seq: null,
			paths: [
				{ path: "docs/end.txt", outcome: "not_applied", reason: "the save did not get through yet", kept: true },
			],
		});
		expect(cmd.state).toBe("closed");
		await service.renewLeases();
		await expect(view.list("", undefined)).rejects.toMatchObject({
			code: "VIEW_CLOSED",
			message: "The view was ended",
		});
		// The machine asks again: the replay's answer is the report.
		expect(await view.publish(true)).toEqual({
			commitId: expect.any(String),
			seq: expect.any(Number),
			paths: [{ path: "docs/end.txt", outcome: "saved" }],
			closed: true,
		});
		expect(core.commits).toHaveLength(4);
		expect(new Set(core.commits.map((c) => c.key)).size).toBe(1);
		expect(core.commits.every((c) => c.final)).toBe(true);
		expect(core.entries.get("docs/end.txt")?.fileSha256).toBe(hashOf("e"));
		await expect(view.publish(true)).rejects.toMatchObject({
			code: "VIEW_CLOSED",
			message: "The command's final change set was published",
		});
		// The same when the command's program let go first: its last call joins the closed view, with its pass, to ask
		// the final again, and nothing else.
		const again = await company();
		const first = await again.open();
		await write(first, "docs/end.txt", "e");
		again.core.commitFailures = { mode: "lost", count: 3 };
		expect((await first.publish(true)).commitId).toBeNull();
		first.release();
		await settle();
		await again.service.renewLeases();
		const stranger: Hello = { ...hello, pass: `${PASS.slice(0, -1)}y` };
		await expect(again.service.open(stranger, AT_OFFICE)).rejects.toMatchObject({ code: "VIEW_REFUSED" });
		const last = await again.open();
		await expect(last.list("", undefined)).rejects.toMatchObject({ code: "VIEW_CLOSED" });
		await expect(last.mkdir("docs/more")).rejects.toMatchObject({ code: "VIEW_CLOSED" });
		expect(await last.publish(true)).toMatchObject({
			paths: [{ path: "docs/end.txt", outcome: "saved" }],
			closed: true,
		});
		expect(new Set(again.core.commits.map((c) => c.key)).size).toBe(1);
		// Answered, the view is gone: a machine that comes back hears it closed.
		await expect(again.open()).rejects.toMatchObject({ code: "VIEW_CLOSED" });
	});

	it("reports a final the core refuses whole, and why: the view stays open, with what it has pending", async () => {
		const { core, open, cmd } = await company();
		const view = await open();
		// An empty final: refused while the company is paused, or when the view may no longer save.
		for (const reason of ["stopped", "denied"] as const) {
			core.commitRefusal = reason;
			expect(await view.publish(true)).toEqual({ commitId: null, seq: null, paths: [], refused: reason });
			expect(cmd.state).toBe("open");
		}
		// One with changes the core takes for invalid (over its 1000 units, say): each path stays pending.
		await write(view, "docs/big.txt", "b");
		core.commitRefusal = "invalid";
		expect(await view.publish(true)).toEqual({
			commitId: null,
			seq: null,
			paths: [{ path: "docs/big.txt", outcome: "refused", reason: "invalid", kept: true }],
			refused: "invalid",
		});
		expect(await names(view, "docs")).toContain("big.txt");
		core.commitRefusal = undefined;
		expect(await view.publish(true)).toMatchObject({
			paths: [{ path: "docs/big.txt", outcome: "saved" }],
			closed: true,
		});
		expect(core.commits.map((c) => c.final)).toEqual([true, true, true, true]);
		expect(new Set(core.commits.map((c) => c.key)).size).toBe(4);
		expect(cmd.state).toBe("closed");
	});

	it("holds a final back while a file is still open for writing", async () => {
		const { core, open, cmd } = await company();
		const view = await open();
		await write(view, "docs/done.txt", "d");
		const { handle } = await view.open({ path: "docs/open.txt", create: true, exclusive: false, truncate: true });
		const data = Buffer.from("o");
		await view.chunk({ handle, index: 0, sha256: hashOf(data), bytes: data.byteLength, offset: 0, data });
		const held = await view.publish(true);
		expect(held.commitId).toBeNull();
		expect(byPath(held.paths)).toEqual([
			{
				path: "docs/done.txt",
				outcome: "not_applied",
				reason: "the final waits until every change can go",
				kept: true,
			},
			{ path: "docs/open.txt", outcome: "waiting", reason: "still open for writing", kept: true },
		]);
		expect(core.commits).toEqual([]);
		expect(cmd.state).toBe("open");
		await view.close(handle, data.byteLength);
		expect(byPath((await view.publish(true)).paths)).toEqual([
			{ path: "docs/done.txt", outcome: "saved" },
			{ path: "docs/open.txt", outcome: "saved" },
		]);
		expect(cmd.state).toBe("closed");
	});

	it("refuses a final from a desktop, and tells a final on a view the core closed why it closed", async () => {
		const desk = await company("computer_desktop");
		await expect((await desk.open()).publish(true)).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(desk.cmd.state).toBe("open");
		const { core, service, open, cmd } = await company();
		const view = await open();
		cmd.state = "closed";
		await service.renewLeases();
		await expect(view.publish(true)).rejects.toMatchObject({ code: "VIEW_CLOSED", message: "The view was ended" });
		expect(core.commits).toEqual([]);
		// A final with no answer the core never applied: asked again on the closed view, it is refused, so it did not
		// close the view, and the machine hears why the view closed.
		const unapplied = await company();
		const last = await unapplied.open();
		await write(last, "docs/end.txt", "e");
		unapplied.core.commitFailures = { mode: "down", count: 3 };
		expect((await last.publish(true)).commitId).toBeNull();
		unapplied.cmd.state = "closed";
		await unapplied.service.renewLeases();
		await expect(last.publish(true)).rejects.toMatchObject({ code: "VIEW_CLOSED", message: "The view was ended" });
		expect(unapplied.core.commits).toHaveLength(4);
		expect(unapplied.core.entries.has("docs/end.txt")).toBe(false);
		await expect(unapplied.open()).rejects.toMatchObject({ code: "VIEW_CLOSED" });
	});
});
