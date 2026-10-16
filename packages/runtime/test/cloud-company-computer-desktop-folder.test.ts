import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import {
	CompanyComputerDesktopFolders,
	checkCompanyComputerFolderParent,
	closeCompanyComputerDesktopFolderView,
	openCompanyComputerDesktopFolderView,
	openCompanyComputerFolderParent,
} from "@qorpera/runtime/cloud-company-computer-desktop-folder";
import type {
	askCompanyComputerFolderHelper,
	CompanyComputerFolderRequest,
} from "@qorpera/runtime/cloud-company-computer-folder-helper-client";
import { HttpCloudCompanyComputerRegistry } from "@qorpera/runtime/cloud-company-computer-registry-http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { computerBinding, computerDeferred, computerId } from "./fixtures/company-computer.ts";

const binding = computerBinding();
const name = `desktop-${binding.screenId}`;
const parent = `/run/qorpera-folder/mounts/${name}`;
const run = { kind: "run", runId: computerId(20) } as const;
const member = { kind: "member", userId: computerId(21) } as const;
const unavailable = { code: "COMPANY_FOLDER_UNAVAILABLE", message: "company folder is unavailable" };
const temporary: string[] = [];

afterEach(async () => {
	vi.useRealTimers();
	for (const directory of temporary.splice(0)) await rm(directory, { recursive: true, force: true });
});

/** The core's folder views as `qorpera_folder_view_open` and `_close` answer them. */
function core() {
	const opened: Record<string, unknown>[] = [];
	const closed: unknown[] = [];
	const call = vi.fn(async (method: string, args: Record<string, unknown>): Promise<unknown> => {
		if (method === "qorpera_folder_view_open") {
			opened.push(args);
			return {
				schema: "qorpera.folder-view/v1",
				viewId: computerId(100 + opened.length),
				pass: `pass-${opened.length}`,
			};
		}
		if (method === "qorpera_folder_view_close") {
			closed.push(args);
			return {};
		}
		throw new Error(`Unexpected fixture RPC ${method}`);
	});
	const view = (n: number) => ({
		environmentId: binding.environmentId,
		viewId: computerId(100 + n),
		pass: `pass-${n}`,
	});
	return { call, opened, closed, view };
}

/** The folder helper: each request takes the next answer queued for its op (a function is called for it). */
function helper() {
	const asked: CompanyComputerFolderRequest[] = [];
	const options: unknown[] = [];
	const queued = new Map<string, unknown[]>();
	const ask = vi.fn(async (request: CompanyComputerFolderRequest, given: unknown) => {
		asked.push(request);
		options.push(given);
		const next = queued.get(request.op)?.shift();
		return typeof next === "function" ? next() : next;
	});
	return {
		asked,
		options,
		ask: ask as unknown as typeof askCompanyComputerFolderHelper,
		answer: (op: CompanyComputerFolderRequest["op"], ...answers: unknown[]) => {
			queued.set(op, [...(queued.get(op) ?? []), ...answers]);
		},
		ops: () => asked.map((request) => request.op),
	};
}

function fixture(options: { socket?: string } = {}) {
	const c = core();
	const h = helper();
	const logged: string[] = [];
	const folders = new CompanyComputerDesktopFolders({
		registry: { call: c.call },
		ask: h.ask,
		log: (line) => logged.push(line),
		...options,
	});
	const hold = (
		holder: typeof run | typeof member,
		until = performance.now() + 5000,
		signal = new AbortController().signal,
	) => folders.hold(binding, holder, signal, until);
	return { ...c, ...h, folders, hold, logged };
}

function http(...responses: (Response | (() => Response))[]) {
	const fetcher = vi.fn<typeof fetch>(async () => {
		const next = responses.shift();
		return typeof next === "function" ? next() : (next ?? Response.json({}));
	});
	return {
		fetcher,
		registry: new HttpCloudCompanyComputerRegistry({
			supabaseUrl: "https://control.example.test",
			serviceRoleKey: "sb_secret_fixture",
			fetch: fetcher,
		}),
		body: (index: number) => JSON.parse(fetcher.mock.calls[index][1]!.body as string) as Record<string, unknown>,
	};
}
const answered = (viewId = computerId(30), pass = "a-pass") =>
	Response.json({ schema: "qorpera.folder-view/v1", viewId, pass });
const refused = (message: string, code = "42501") =>
	Response.json({ message, code, details: "secret" }, { status: 403 });
const busy = () => Response.json({ message: "Folder view holder is not current", code: "55P03" }, { status: 403 });

describe("a desktop's folder view", () => {
	it("opens it as the platform for the screen's holder: a run, or a member who took the screen over", async () => {
		const f = http(answered(), answered(computerId(31), "b-pass"));
		await expect(
			openCompanyComputerDesktopFolderView(
				f.registry,
				{ environmentId: binding.environmentId, screenId: binding.screenId, holder: run },
				new AbortController().signal,
				performance.now() + 5000,
			),
		).resolves.toEqual({ environmentId: binding.environmentId, viewId: computerId(30), pass: "a-pass" });
		expect(f.fetcher.mock.calls[0][0]).toBe("https://control.example.test/rest/v1/rpc/qorpera_folder_view_open");
		expect(f.body(0)).toEqual({
			p_environment_id: binding.environmentId,
			p_opener: { kind: "platform" },
			p_kind: "computer_desktop",
			p_anchor: { screenId: binding.screenId, holderRunId: run.runId },
		});
		await openCompanyComputerDesktopFolderView(
			f.registry,
			{ environmentId: binding.environmentId, screenId: binding.screenId, holder: member },
			new AbortController().signal,
			performance.now() + 5000,
		);
		expect(f.body(1).p_anchor).toEqual({ screenId: binding.screenId, holderUserId: member.userId });
	});

	it("asks again while the core does not answer, and is unavailable once the deadline passes", async () => {
		const request = { environmentId: binding.environmentId, screenId: binding.screenId, holder: run };
		const f = http(busy(), answered());
		await expect(
			openCompanyComputerDesktopFolderView(
				f.registry,
				request,
				new AbortController().signal,
				performance.now() + 5000,
			),
		).resolves.toMatchObject({ viewId: computerId(30) });
		expect(f.fetcher).toHaveBeenCalledTimes(2);

		const g = http(busy, busy, busy, busy);
		const started = performance.now();
		await expect(
			openCompanyComputerDesktopFolderView(g.registry, request, new AbortController().signal, started + 300),
		).resolves.toEqual(unavailable);
		expect(performance.now() - started).toBeLessThan(2000);
		await expect(
			openCompanyComputerDesktopFolderView(g.registry, request, new AbortController().signal, performance.now()),
		).resolves.toEqual(unavailable);
	});

	it("passes on the core's refusal, with its reason only when it is one of the known ones", async () => {
		const request = { environmentId: binding.environmentId, screenId: binding.screenId, holder: run };
		const f = http(refused("Folder view holder is not current"), refused("secret profile contents"));
		await expect(
			openCompanyComputerDesktopFolderView(
				f.registry,
				request,
				new AbortController().signal,
				performance.now() + 5000,
			),
		).resolves.toEqual({ code: "COMPANY_FOLDER_REFUSED", message: "Folder view holder is not current" });
		const other = await openCompanyComputerDesktopFolderView(
			f.registry,
			request,
			new AbortController().signal,
			performance.now() + 5000,
		);
		expect(other).toEqual({ code: "COMPANY_FOLDER_REFUSED", message: "company folder is unavailable" });
		expect(JSON.stringify(other)).not.toContain("secret");
		// A refusal is final: nothing is asked again.
		expect(f.fetcher).toHaveBeenCalledTimes(2);
	});

	it.each([
		["another schema", { schema: "qorpera.folder-view/v2", viewId: computerId(30), pass: "a-pass" }],
		["a view that is no uuid", { schema: "qorpera.folder-view/v1", viewId: "view", pass: "a-pass" }],
		["a pass the program would refuse", { schema: "qorpera.folder-view/v1", viewId: computerId(30), pass: "a pass" }],
		["no pass", { schema: "qorpera.folder-view/v1", viewId: computerId(30) }],
		["no answer", null],
	])("takes %s as unavailable", async (_case, answer) => {
		await expect(
			openCompanyComputerDesktopFolderView(
				{ call: async () => answer },
				{ environmentId: binding.environmentId, screenId: binding.screenId, holder: run },
				new AbortController().signal,
				performance.now() + 5000,
			),
		).resolves.toEqual(unavailable);
	});

	it("stops with its caller", async () => {
		const stop = new AbortController();
		stop.abort(new Error("stopped"));
		await expect(
			openCompanyComputerDesktopFolderView(
				{ call: vi.fn() },
				{ environmentId: binding.environmentId, screenId: binding.screenId, holder: run },
				stop.signal,
				performance.now() + 5000,
			),
		).rejects.toThrow("stopped");
	});

	it("closes a view with its pass and never fails the caller", async () => {
		const f = http(refused("Folder view is invalid"));
		await expect(
			closeCompanyComputerDesktopFolderView(f.registry, {
				environmentId: binding.environmentId,
				viewId: computerId(30),
				pass: "a-pass",
			}),
		).resolves.toBeUndefined();
		expect(f.fetcher.mock.calls[0][0]).toBe("https://control.example.test/rest/v1/rpc/qorpera_folder_view_close");
		expect(f.body(0)).toEqual({ p_view_id: computerId(30), p_pass: "a-pass" });
	});
});

describe("a mount's parent, as a desktop binds it", () => {
	const fdinfo = "pos:\t0\nflags:\t02200000\nmnt_id:\t412\nino:\t9\n";
	const bind = (optional = "master:5") =>
		`412 30 0:40 /qorpera-folder/mounts/${name} ${parent} rw,nosuid,nodev ${optional} - tmpfs tmpfs rw,mode=755\n`;
	// As the kernel lists the folder program's direct mount (#1007): `fuse qorpera-company`.
	const fuse = (id = 413, under = 412, fstype = "fuse", source = "qorpera-company") =>
		`${id} ${under} 0:51 / ${parent}/company rw,nosuid,nodev master:7 - ${fstype} ${source} rw,user_id=0\n`;
	const root =
		"29 1 252:1 / / rw,relatime shared:1 - ext4 /dev/vda1 rw\n30 29 0:26 / /run rw,nosuid shared:5 - tmpfs tmpfs rw\n";

	it("accepts the helper's bind with the folder program's mount on top, or nothing at `company` while it restarts", () => {
		expect(checkCompanyComputerFolderParent(root + bind() + fuse(), fdinfo, parent)).toBe(true);
		expect(checkCompanyComputerFolderParent(root + bind("shared:9 master:5") + fuse(), fdinfo, parent)).toBe(true);
		expect(checkCompanyComputerFolderParent(root + bind(), fdinfo, parent)).toBe(true);
		// A mount made through fusermount keeps the subtype.
		expect(checkCompanyComputerFolderParent(root + bind() + fuse(413, 412, "fuse.qorpera"), fdinfo, parent)).toBe(
			true,
		);
		// Mounts stacked at `company`: the top one counts.
		expect(
			checkCompanyComputerFolderParent(
				root + bind() + fuse(413, 412, "tmpfs", "tmpfs") + fuse(414, 413),
				fdinfo,
				parent,
			),
		).toBe(true);
	});

	it.each([
		["a parent that takes no mounts from the helper", root + bind("") + fuse()],
		[
			"another mount under the parent",
			`${root}${bind()}${fuse()}414 412 0:52 / ${parent}/other rw - tmpfs tmpfs rw\n`,
		],
		["two mounts side by side at `company`", root + bind() + fuse() + fuse(414, 412)],
		["something other than the folder program on top", root + bind() + fuse() + fuse(414, 413, "tmpfs", "tmpfs")],
		["a program of another source", root + bind() + fuse(413, 412, "fuse", "elsewhere")],
		["another FUSE type", root + bind() + fuse(413, 412, "fuse.sshfs")],
		["no mount at the fd's place", root + fuse()],
		["unreadable mounts", `${root}412 30 0:40\n`],
	])("refuses %s", (_case, mountinfo) => {
		expect(checkCompanyComputerFolderParent(mountinfo, fdinfo, parent)).toBe(false);
	});

	it("refuses an fd that is not on the parent's bind", () => {
		expect(checkCompanyComputerFolderParent(root + bind() + fuse(), "pos:\t0\nflags:\t02200000\n", parent)).toBe(
			false,
		);
		expect(checkCompanyComputerFolderParent(root + bind() + fuse(), "mnt_id:\t412\nmnt_id:\t412\n", parent)).toBe(
			false,
		);
		expect(checkCompanyComputerFolderParent(root + bind() + fuse(), "mnt_id:\t30\n", parent)).toBe(false);
		expect(checkCompanyComputerFolderParent(root + bind() + fuse(), fdinfo, `${parent}-other`)).toBe(false);
	});

	it("opens no parent that is not root's own bind, nor one behind a link", async () => {
		const top = await mkdtemp(join(tmpdir(), "qorpera-folder-parent-"));
		temporary.push(top);
		await mkdir(join(top, "mounts", name), { recursive: true });
		await expect(openCompanyComputerFolderParent(name, top)).rejects.toThrow();
		const other = `desktop-${computerId(40)}`;
		await symlink(join(top, "mounts", name), join(top, "mounts", other));
		await expect(openCompanyComputerFolderParent(other, top)).rejects.toThrow();
		await expect(openCompanyComputerFolderParent(`desktop-${computerId(41)}`, top)).rejects.toThrow();
		await expect(openCompanyComputerFolderParent("desktop-..", top)).rejects.toThrow(
			"INVALID_COMPANY_COMPUTER_FOLDER_NAME",
		);
	});
});

describe("each desktop's mount of the company folder", () => {
	it("mounts the first holder's view, and keeps the mount while the same holder's program runs", async () => {
		const f = fixture({ socket: "/run/fixture/helper.sock" });
		f.answer("mount", { answer: "mounted" });
		await expect(f.hold(run)).resolves.toEqual({ name, epoch: 1 });
		expect(f.opened[0]).toMatchObject({ p_anchor: { screenId: binding.screenId, holderRunId: run.runId } });
		expect(f.asked).toEqual([{ op: "mount", name, view: f.view(1) }]);
		expect(f.options[0]).toEqual({ socket: "/run/fixture/helper.sock", timeoutMs: 40000 });
		expect(f.folders.mounted(binding.screenId)).toEqual({ name, epoch: 1 });

		f.answer(
			"list",
			{ answer: "list", mounts: [{ name, viewId: computerId(101), program: "running" }] },
			{ answer: "list", mounts: [{ name, viewId: computerId(101), program: "restarting" }] },
			// A helper that cannot list changes nothing.
			{ answer: "failed" },
		);
		for (let n = 0; n < 3; n++) await expect(f.hold(run)).resolves.toEqual({ name, epoch: 1 });
		expect(f.ops()).toEqual(["mount", "list", "list", "list"]);
		expect(f.opened).toHaveLength(1);
		expect(f.closed).toEqual([]);
	});

	it("moves the mount to a new holder's view without making it again", async () => {
		const f = fixture();
		f.answer("mount", { answer: "mounted" });
		await f.hold(run);
		f.answer("switch", { answer: "switched" }, { answer: "pending" });
		await expect(f.hold(member)).resolves.toEqual({ name, epoch: 1 });
		expect(f.opened[1]).toMatchObject({ p_anchor: { screenId: binding.screenId, holderUserId: member.userId } });
		expect(f.asked[1]).toEqual({ op: "switch", name, view: f.view(2) });
		// The program has not said hello with the newer view yet: it keeps trying, the mount stays.
		await expect(f.hold(run)).resolves.toEqual({ name, epoch: 1 });
		expect(f.asked[2]).toEqual({ op: "switch", name, view: f.view(3) });
		// The core ended the older views itself; the office closes none of them.
		expect(f.closed).toEqual([]);
		f.answer("list", { answer: "list", mounts: [{ name, viewId: computerId(103), program: "running" }] });
		await expect(f.hold(run)).resolves.toEqual({ name, epoch: 1 });
	});

	it("makes the mount again when its program ended or its view closed: a new epoch", async () => {
		const f = fixture();
		f.answer("mount", { answer: "mounted" }, { answer: "mounted" }, { answer: "mounted" });
		await f.hold(run);
		f.answer("list", { answer: "list", mounts: [{ name, viewId: computerId(101), program: "closed" }] });
		f.answer("unmount", { answer: "closed", unmounted: true });
		await expect(f.hold(run)).resolves.toEqual({ name, epoch: 2 });
		expect(f.ops()).toEqual(["mount", "list", "unmount", "mount"]);
		expect(f.asked[2]).toEqual({ op: "unmount", name, final: false, timeoutMs: 30000 });
		expect(f.closed).toEqual([{ p_view_id: computerId(101), p_pass: "pass-1" }]);
		expect(f.asked[3]).toEqual({ op: "mount", name, view: f.view(2) });

		// A switch the node refused: the mount goes and comes again with the newer view.
		f.answer("switch", { answer: "closed" });
		f.answer("unmount", { answer: "closed", unmounted: true });
		await expect(f.hold(member)).resolves.toEqual({ name, epoch: 3 });
		expect(f.ops().slice(4)).toEqual(["switch", "unmount", "mount"]);
		expect(f.asked[6]).toEqual({ op: "mount", name, view: f.view(3) });
		// A mount the helper no longer knows of is simply made again.
		f.answer("list", { answer: "list", mounts: [] });
		f.answer("unmount", { answer: "unknown" });
		f.answer("mount", { answer: "mounted" });
		await expect(f.hold(member)).resolves.toEqual({ name, epoch: 4 });
	});

	it("takes over a mount an earlier activation left: it is new to every desktop", async () => {
		const f = fixture();
		f.answer("mount", { answer: "held" });
		f.answer("switch", { answer: "pending" });
		await expect(f.hold(run)).resolves.toEqual({ name, epoch: 1 });
		expect(f.asked).toEqual([
			{ op: "mount", name, view: f.view(1) },
			{ op: "switch", name, view: f.view(1) },
		]);
		// Held, but its program's view was closed: it goes and comes again.
		const g = fixture();
		g.answer("mount", { answer: "held" }, { answer: "mounted" });
		g.answer("switch", { answer: "closed" });
		g.answer("unmount", { answer: "closed", unmounted: true });
		await expect(g.hold(run)).resolves.toEqual({ name, epoch: 1 });
		expect(g.ops()).toEqual(["mount", "switch", "unmount", "mount"]);
	});

	it.each([
		["a mount that failed", { mount: [{ answer: "failed" }] }],
		["a mount that came too late", { mount: [{ answer: "unanswered" }] }],
		["a node that closed the view", { mount: [{ answer: "closed" }] }],
		["no helper", { mount: [undefined] }],
		["a held mount the helper refuses to switch", { mount: [{ answer: "held" }], switch: [{ answer: "refused" }] }],
	] as const)("leaves the screen without a mount after %s, and closes the view it opened", async (_case, answers) => {
		const f = fixture();
		for (const [op, list] of Object.entries(answers)) f.answer(op as CompanyComputerFolderRequest["op"], ...list);
		await expect(f.hold(run)).resolves.toEqual(unavailable);
		expect(f.closed).toEqual([{ p_view_id: computerId(101), p_pass: "pass-1" }]);
		expect(f.folders.mounted(binding.screenId)).toBeUndefined();
	});

	it("keeps a mount whose program ended but would not go, and has no folder for its holder (4d-2b drops it)", async () => {
		const f = fixture();
		f.answer("mount", { answer: "mounted" });
		await f.hold(run);
		f.answer("list", { answer: "list", mounts: [{ name, viewId: computerId(101), program: "stopped" }] });
		f.answer("unmount", { answer: "unanswered", unmounted: false });
		await expect(f.hold(run)).resolves.toEqual(unavailable);
		expect(f.opened).toHaveLength(1);
		expect(f.folders.mounted(binding.screenId)).toEqual({ name, epoch: 1 });
	});

	it("passes on the core's refusal and asks the helper nothing", async () => {
		const f = http(refused("Folder view holder is not current"));
		const h = helper();
		const folders = new CompanyComputerDesktopFolders({ registry: f.registry, ask: h.ask });
		await expect(folders.hold(binding, run, new AbortController().signal, performance.now() + 5000)).resolves.toEqual(
			{
				code: "COMPANY_FOLDER_REFUSED",
				message: "Folder view holder is not current",
			},
		);
		expect(h.asked).toEqual([]);
	});

	it("answers unavailable at the caller's deadline, and the mount goes on for the screen's next request", async () => {
		const f = fixture();
		const mount = computerDeferred<unknown>();
		f.answer("mount", () => mount.promise);
		await expect(f.hold(run, performance.now() + 50)).resolves.toEqual(unavailable);
		const next = f.hold(run);
		mount.resolve({ answer: "mounted" });
		f.answer("list", { answer: "list", mounts: [{ name, viewId: computerId(101), program: "running" }] });
		await expect(next).resolves.toEqual({ name, epoch: 1 });
		expect(f.ops()).toEqual(["mount", "list"]);
	});

	it("stops with its caller", async () => {
		const f = fixture();
		const stop = new AbortController();
		stop.abort(new Error("stopped"));
		await expect(f.hold(run, performance.now() + 5000, stop.signal)).rejects.toThrow("stopped");
		expect(f.asked).toEqual([]);
	});

	it("takes the mount away and closes its view when the desktop ended, unless a new desktop took it", async () => {
		const f = fixture();
		f.answer("mount", { answer: "mounted" }, { answer: "mounted" });
		await f.hold(run);
		await expect(f.folders.release(binding.screenId, () => false)).resolves.toBeUndefined();
		expect(f.ops()).toEqual(["mount"]);
		f.answer("unmount", { answer: "saved", report: { commitId: null, seq: null, paths: [] }, unmounted: true });
		await f.folders.release(binding.screenId);
		expect(f.asked[1]).toEqual({ op: "unmount", name, final: false, timeoutMs: 30000 });
		expect(f.closed).toEqual([{ p_view_id: computerId(101), p_pass: "pass-1" }]);
		expect(f.folders.mounted(binding.screenId)).toBeUndefined();
		// The next holder mounts it again.
		await expect(f.hold(run)).resolves.toEqual({ name, epoch: 2 });
		// A boundary that did not save keeps the mount (4d-2b decides what then).
		f.answer("unmount", { answer: "unanswered", unmounted: false });
		await f.folders.release(binding.screenId);
		expect(f.folders.mounted(binding.screenId)).toEqual({ name, epoch: 2 });
		expect(f.closed).toHaveLength(1);
		// A screen the office never mounted has nothing to release.
		await expect(f.folders.release(computerId(50))).resolves.toBeUndefined();
	});

	it("releases a given-back run's mount after a minute, unless the screen was held again first", async () => {
		const f = fixture();
		f.answer("mount", { answer: "mounted" });
		await f.hold(run);
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		f.folders.releaseLater(binding.screenId, () => true);
		await vi.advanceTimersByTimeAsync(59000);
		f.answer("list", { answer: "list", mounts: [{ name, viewId: computerId(101), program: "running" }] });
		await expect(f.hold(run)).resolves.toEqual({ name, epoch: 1 });
		await vi.advanceTimersByTimeAsync(5000);
		expect(f.ops()).toEqual(["mount", "list"]);

		f.answer("unmount", { answer: "closed", unmounted: true });
		f.folders.releaseLater(binding.screenId, () => true);
		await vi.advanceTimersByTimeAsync(60000);
		await vi.waitFor(() => expect(f.ops()).toEqual(["mount", "list", "unmount"]));
		expect(f.folders.mounted(binding.screenId)).toBeUndefined();
	});

	it("drops every mount an earlier activation left at start, and says whether all went", async () => {
		const f = fixture();
		const other = `desktop-${computerId(60)}`;
		f.answer("list", {
			answer: "list",
			mounts: [
				{ name, viewId: computerId(61), program: "running" },
				{ name: other, viewId: computerId(62), program: "stopped" },
			],
		});
		f.answer("drop", { answer: "dropped" }, { answer: "unknown" });
		await expect(f.folders.dropLeftovers(new AbortController().signal)).resolves.toBe(true);
		expect(f.asked).toEqual([{ op: "list" }, { op: "drop", name }, { op: "drop", name: other }]);
		// Nothing of the core is asked: those views ended with the activation that opened them.
		expect(f.call).not.toHaveBeenCalled();

		f.answer("list", { answer: "list", mounts: [{ name, viewId: computerId(61), program: "unknown" }] });
		f.answer("drop", { answer: "failed" });
		await expect(f.folders.dropLeftovers(new AbortController().signal)).resolves.toBe(false);
		f.answer("list", { answer: "failed" });
		await expect(f.folders.dropLeftovers(new AbortController().signal)).resolves.toBe(false);
	});
});

describe("a drain's and a capture's boundary", () => {
	const report = { commitId: "commit-1", seq: 7, paths: [] };
	const refusal = (refused: string) => ({
		answer: "refused",
		report: { commitId: null, seq: null, paths: [], refused },
	});
	const UNANSWERED = "the company folder did not answer before the screenshot's deadline; take it again";
	const PAUSED = "the company is paused, so the company folder holds the screenshot back";
	const RUN_ENDED = "this run can no longer act in the company folder";
	const REFUSED = "the company folder refused the screen's view";
	const RESTARTED = "the company folder was restarted on this screen; take the screenshot again";

	async function mounted() {
		const f = fixture();
		f.answer("mount", { answer: "mounted" });
		await f.hold(run);
		// Rule 4's way out stops the mount's desktop: what the helper had been asked by then.
		const stopped: string[][] = [];
		const stop = vi.fn(async () => {
			stopped.push(f.ops());
		});
		return { ...f, stop, stopped };
	}
	const drain = (
		f: ReturnType<typeof fixture>,
		until = performance.now() + 19000,
		signal = new AbortController().signal,
	) => f.folders.drain(binding.screenId, signal, until);
	const capture = (
		f: Awaited<ReturnType<typeof mounted>>,
		epoch: number | undefined = 1,
		until = performance.now() + 15000,
		signal = new AbortController().signal,
		stop: () => Promise<void> = f.stop,
	) => f.folders.capture(binding.screenId, epoch, signal, until, stop);
	const failedStop = async (): Promise<void> => {
		throw new Error("OFFICE_DESKTOP_STOP_FAILED");
	};

	it("publishes the mount's last changes at a drain, then the mount goes and its view closes", async () => {
		const f = await mounted();
		f.answer("unmount", {
			answer: "saved",
			report: {
				...report,
				paths: [
					{ path: "docs/plan.md", outcome: "saved" },
					{ path: "docs/old.md", outcome: "refused", reason: "a reason of the company's" },
					{ path: "docs/new.md", outcome: "Not A Word" },
				],
			},
			unmounted: true,
		});
		await drain(f);
		expect(f.asked[1]).toMatchObject({ op: "unmount", name, final: false });
		const { timeoutMs } = f.asked[1] as { timeoutMs: number };
		expect(timeoutMs).toBeGreaterThan(17000);
		expect(timeoutMs).toBeLessThanOrEqual(18000);
		expect(f.options[1]).toEqual({ timeoutMs: expect.any(Number), signal: expect.any(AbortSignal) });
		expect(f.closed).toEqual([{ p_view_id: computerId(101), p_pass: "pass-1" }]);
		expect(f.folders.mounted(binding.screenId)).toBeUndefined();
		// The commit and how many paths had each outcome: no path, no reason.
		expect(f.logged).toEqual([
			`office-folder: drain ${name}: {"answer":"saved","unmounted":true,"refused":null,"commitId":"commit-1","seq":7,"outcomes":{"saved":1,"refused":1,"other":1}}`,
		]);
		f.answer("mount", { answer: "mounted" });
		await expect(f.hold(run)).resolves.toEqual({ name, epoch: 2 });
	});

	it("logs only the helper's words that are plain names", async () => {
		const f = await mounted();
		f.answer("unmount", {
			answer: "refused",
			report: {
				commitId: "not a commit",
				seq: 3,
				paths: [{ path: "a", outcome: "refused", reason: "secret" }],
				refused: "Something Else",
			},
			unmounted: true,
		});
		await drain(f);
		expect(f.logged).toEqual([
			`office-folder: drain ${name}: {"answer":"refused","unmounted":true,"refused":"other","commitId":"other","seq":3,"outcomes":{"refused":1}}`,
		]);
	});

	it("asks again past no answer, an invalid one, one too late, the run check and a change kept, until a final answer", async () => {
		const f = await mounted();
		f.answer(
			"unmount",
			undefined,
			{ answer: "invalid" },
			{ answer: "unanswered", unmounted: false },
			{ ...refusal("run_ended"), unmounted: false },
			// Refused with no reason while it keeps a path: the core did not answer the commit.
			{
				answer: "refused",
				report: {
					commitId: null,
					seq: null,
					paths: [
						{ path: "docs/a.md", outcome: "conflict" },
						{ path: "docs/b.md", outcome: "not_applied", reason: "the save did not get through yet", kept: true },
					],
				},
				unmounted: false,
			},
			{ answer: "closed", unmounted: true },
		);
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const drained = drain(f);
		await vi.advanceTimersByTimeAsync(6000);
		await drained;
		expect(f.ops()).toEqual(["mount", "unmount", "unmount", "unmount", "unmount", "unmount", "unmount"]);
		expect(f.logged).toEqual([`office-folder: drain ${name}: {"answer":"closed","unmounted":true}`]);
		expect(f.closed).toHaveLength(1);
		expect(f.folders.mounted(binding.screenId)).toBeUndefined();
	});

	it.each(["stopped", "denied", "unreadable", "unproven", "invalid"])(
		"takes a boundary refused %s as final: the mount it left goes without another one",
		async (refused) => {
			const f = await mounted();
			f.answer("unmount", { ...refusal(refused), unmounted: false });
			f.answer("drop", { answer: "failed" }, { answer: "dropped" });
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
			const drained = drain(f);
			await vi.advanceTimersByTimeAsync(1000);
			await drained;
			expect(f.ops()).toEqual(["mount", "unmount", "drop", "drop"]);
			expect(f.asked[2]).toEqual({ op: "drop", name });
			expect(f.logged).toEqual([
				`office-folder: drain ${name}: {"answer":"refused","unmounted":false,"refused":"${refused}","commitId":null,"seq":null,"outcomes":{}}`,
			]);
			expect(f.closed).toEqual([{ p_view_id: computerId(101), p_pass: "pass-1" }]);
			expect(f.folders.mounted(binding.screenId)).toBeUndefined();
		},
	);

	it("takes a boundary that settled every path it planned as final, though it did not save them all", async () => {
		const f = await mounted();
		f.answer("unmount", {
			answer: "refused",
			report: { ...report, paths: [{ path: "docs/a.md", outcome: "conflict" }] },
			unmounted: false,
		});
		f.answer("drop", { answer: "dropped" });
		await drain(f);
		expect(f.ops()).toEqual(["mount", "unmount", "drop"]);
		expect(f.logged).toEqual([
			`office-folder: drain ${name}: {"answer":"refused","unmounted":false,"refused":null,"commitId":"commit-1","seq":7,"outcomes":{"conflict":1}}`,
		]);
		expect(f.closed).toHaveLength(1);
		expect(f.folders.mounted(binding.screenId)).toBeUndefined();
	});

	it("takes a mount the helper no longer knows of as gone", async () => {
		const f = await mounted();
		f.answer("unmount", { answer: "unknown" });
		await drain(f);
		expect(f.ops()).toEqual(["mount", "unmount"]);
		expect(f.logged).toEqual([`office-folder: drain ${name}: {"answer":"unknown"}`]);
		expect(f.closed).toHaveLength(1);
		expect(f.folders.mounted(binding.screenId)).toBeUndefined();
	});

	it("fails the drain at its deadline, and the mount stays for the stop control", async () => {
		const f = await mounted();
		await expect(drain(f, performance.now() + 1500)).rejects.toThrow("OFFICE_FOLDER_DRAIN_UNANSWERED");
		expect(f.ops()).toEqual(["mount"]);
		expect(f.logged).toEqual([`office-folder: drain ${name}: no final answer by the drain's deadline`]);
		// A final answer whose mount would not go: dropped again until the deadline, one real second here.
		f.answer("unmount", { ...refusal("stopped"), unmounted: false });
		f.answer("drop", { answer: "failed" });
		await expect(drain(f, performance.now() + 2700)).rejects.toThrow("OFFICE_FOLDER_DRAIN_UNANSWERED");
		expect(f.ops()).toEqual(["mount", "unmount", "drop"]);
		expect(f.logged).toHaveLength(3);
		expect(f.logged[2]).toBe(`office-folder: drain ${name}: the mount did not go by the drain's deadline`);
		expect(f.folders.mounted(binding.screenId)).toEqual({ name, epoch: 1 });
		expect(f.closed).toEqual([]);
	});

	it("does nothing for a screen the office never mounted, an ended mount, or one a new desktop took meanwhile", async () => {
		const f = await mounted();
		await expect(
			f.folders.drain(computerId(50), new AbortController().signal, performance.now() + 19000),
		).resolves.toBeUndefined();
		await expect(
			f.folders.drain(binding.screenId, new AbortController().signal, performance.now() + 19000, () => false),
		).resolves.toBeUndefined();
		expect(f.ops()).toEqual(["mount"]);
		expect(f.folders.mounted(binding.screenId)).toEqual({ name, epoch: 1 });
		f.answer("unmount", { answer: "saved", report, unmounted: true });
		await f.folders.release(binding.screenId);
		await drain(f);
		expect(f.ops()).toEqual(["mount", "unmount"]);
		expect(f.logged).toEqual([]);
	});

	it("stops a drain with its caller", async () => {
		const f = await mounted();
		f.answer("unmount", { answer: "unanswered", unmounted: false });
		const stop = new AbortController();
		const drained = drain(f, performance.now() + 19000, stop.signal);
		await vi.waitFor(() => expect(f.ops()).toEqual(["mount", "unmount"]));
		stop.abort(new Error("stopped"));
		await expect(drained).rejects.toThrow("stopped");
		expect(f.folders.mounted(binding.screenId)).toEqual({ name, epoch: 1 });
	});

	it("asks nothing before a capture of a desktop without `/company`, and lets one go once its reads are released", async () => {
		const f = await mounted();
		// Not through `capture`: an explicit undefined would take its default epoch.
		await expect(
			f.folders.capture(
				binding.screenId,
				undefined,
				new AbortController().signal,
				performance.now() + 15000,
				f.stop,
			),
		).resolves.toBeUndefined();
		expect(f.ops()).toEqual(["mount"]);
		f.answer(
			"boundary",
			{ answer: "saved", report },
			// Refused only for some paths (a refused or conflicting save): the reads were released.
			{ answer: "refused", report: { ...report, paths: [{ path: "a", outcome: "conflict" }] } },
		);
		await expect(capture(f)).resolves.toBeUndefined();
		await expect(capture(f)).resolves.toBeUndefined();
		expect(f.asked[1]).toMatchObject({ op: "boundary", name, final: false });
		const { timeoutMs } = f.asked[1] as { timeoutMs: number };
		expect(timeoutMs).toBeGreaterThan(13000);
		expect(timeoutMs).toBeLessThanOrEqual(14000);
		expect(f.options[1]).toEqual({ timeoutMs: timeoutMs + 1000, signal: expect.any(AbortSignal) });
		expect(f.closed).toEqual([]);
		expect(f.folders.mounted(binding.screenId)).toEqual({ name, epoch: 1 });
		expect(f.stop).not.toHaveBeenCalled();
	});

	it.each([
		["the pause", refusal("stopped"), PAUSED],
		["the run check", refusal("run_ended"), RUN_ENDED],
		["a superseded view, or another denial", refusal("denied"), REFUSED],
		["an invalid request", refusal("invalid"), REFUSED],
		["no answer from the core (QRC01 included)", { answer: "unanswered" }, UNANSWERED],
		["an invalid answer", { answer: "invalid" }, UNANSWERED],
		["no helper", undefined, UNANSWERED],
	])("holds a capture back after %s, and stops nothing", async (_case, answer, message) => {
		const f = await mounted();
		f.answer("boundary", answer);
		await expect(capture(f)).resolves.toBe(message);
		expect(f.ops()).toEqual(["mount", "boundary"]);
		expect(f.stop).not.toHaveBeenCalled();
		expect(f.closed).toEqual([]);
		expect(f.folders.mounted(binding.screenId)).toEqual({ name, epoch: 1 });
	});

	it.each([
		["a closed view", { answer: "closed" }],
		["a read no longer readable", refusal("unreadable")],
		["a read log that cannot be shown complete", refusal("unproven")],
	])("takes rule 4's way out after %s: the desktop stops, then the mount goes", async (_case, answer) => {
		const f = await mounted();
		f.answer("boundary", answer);
		f.answer("drop", { answer: "dropped" });
		await expect(capture(f)).resolves.toBe(RESTARTED);
		// The mount's desktop stopped after the boundary and before the drop.
		expect(f.stopped).toEqual([["mount", "boundary"]]);
		expect(f.asked.slice(1)).toEqual([
			{ op: "boundary", name, final: false, timeoutMs: expect.any(Number) },
			{ op: "drop", name },
		]);
		expect(f.closed).toEqual([{ p_view_id: computerId(101), p_pass: "pass-1" }]);
		expect(f.folders.mounted(binding.screenId)).toBeUndefined();
		// The old desktop's captures are held back until it starts again on the new mount.
		await expect(capture(f)).resolves.toBe(RESTARTED);
		f.answer("mount", { answer: "mounted" });
		await expect(f.hold(run)).resolves.toEqual({ name, epoch: 2 });
		expect(f.asked.at(-1)).toEqual({ op: "mount", name, view: f.view(2) });
		await expect(capture(f, 1)).resolves.toBe(RESTARTED);
		f.answer("boundary", { answer: "saved", report });
		await expect(capture(f, 2)).resolves.toBeUndefined();
		expect(f.ops()).toEqual(["mount", "boundary", "drop", "mount", "boundary"]);
		expect(f.stop).toHaveBeenCalledTimes(1);
	});

	it("holds the capture back when the way out's drop fails, and the screen's next hold drops the mount first", async () => {
		const f = await mounted();
		f.answer("boundary", refusal("unreadable"));
		f.answer("drop", { answer: "failed" }, { answer: "failed" }, { answer: "unknown" });
		await expect(capture(f)).resolves.toBe(REFUSED);
		expect(f.stopped).toEqual([["mount", "boundary"]]);
		// No desktop starts on it again, and the stopped desktop's captures are held back.
		expect(f.folders.mounted(binding.screenId)).toBeUndefined();
		await expect(capture(f)).resolves.toBe(RESTARTED);
		expect(f.closed).toEqual([]);
		// While the helper keeps it, nobody holds it.
		await expect(f.hold(run)).resolves.toEqual(unavailable);
		f.answer("mount", { answer: "mounted" });
		await expect(f.hold(run)).resolves.toEqual({ name, epoch: 2 });
		expect(f.ops()).toEqual(["mount", "boundary", "drop", "drop", "drop", "mount"]);
		expect(f.closed).toEqual([{ p_view_id: computerId(101), p_pass: "pass-1" }]);
		expect(f.asked.at(-1)).toEqual({ op: "mount", name, view: f.view(2) });
		expect(f.stop).toHaveBeenCalledTimes(1);
	});

	it("holds the capture back when the way out's stop fails, and the mount goes once its desktop has stopped", async () => {
		const f = await mounted();
		f.answer("boundary", refusal("unproven"));
		await expect(capture(f, 1, undefined, undefined, failedStop)).resolves.toBe(REFUSED);
		// Nothing dropped while its desktop may still run, and nobody holds it.
		expect(f.ops()).toEqual(["mount", "boundary"]);
		expect(f.folders.mounted(binding.screenId)).toBeUndefined();
		await expect(capture(f)).resolves.toBe(RESTARTED);
		await expect(f.hold(run)).resolves.toEqual(unavailable);
		expect(f.ops()).toEqual(["mount", "boundary"]);
		expect(f.closed).toEqual([]);
		// The screen's drain stopped its desktop: the mount goes without a boundary.
		f.answer("drop", { answer: "dropped" });
		await f.folders.release(binding.screenId);
		expect(f.ops()).toEqual(["mount", "boundary", "drop"]);
		expect(f.closed).toEqual([{ p_view_id: computerId(101), p_pass: "pass-1" }]);
		f.answer("mount", { answer: "mounted" });
		await expect(f.hold(run)).resolves.toEqual({ name, epoch: 2 });
		expect(f.folders.mounted(binding.screenId)).toEqual({ name, epoch: 2 });
	});

	it("lets the screen's drain end a mount the way out began on", async () => {
		const f = await mounted();
		f.answer("boundary", refusal("unreadable"));
		await expect(capture(f, 1, undefined, undefined, failedStop)).resolves.toBe(REFUSED);
		f.answer("unmount", { ...refusal("unreadable"), unmounted: false });
		f.answer("drop", { answer: "dropped" });
		await drain(f);
		expect(f.ops()).toEqual(["mount", "boundary", "unmount", "drop"]);
		expect(f.closed).toHaveLength(1);
		f.answer("mount", { answer: "mounted" });
		await expect(f.hold(run)).resolves.toEqual({ name, epoch: 2 });
	});

	it("takes a mount the helper no longer knows of as gone at a capture", async () => {
		const f = await mounted();
		f.answer("boundary", { answer: "unknown" });
		await expect(capture(f)).resolves.toBe(RESTARTED);
		expect(f.ops()).toEqual(["mount", "boundary"]);
		expect(f.closed).toHaveLength(1);
		expect(f.folders.mounted(binding.screenId)).toBeUndefined();
		// A screen the office has no record of: its desktop did not start on a mount this service made.
		await expect(
			f.folders.capture(computerId(50), 1, new AbortController().signal, performance.now() + 15000, f.stop),
		).resolves.toBe(RESTARTED);
		expect(f.stop).not.toHaveBeenCalled();
	});

	it("holds a capture back at its deadline, and the boundary goes on for the screen's next request", async () => {
		const f = await mounted();
		// Too little time left to ask.
		await expect(capture(f, 1, performance.now() + 1500)).resolves.toBe(UNANSWERED);
		expect(f.ops()).toEqual(["mount"]);
		const boundary = computerDeferred<unknown>();
		f.answer("boundary", () => boundary.promise, { answer: "saved", report });
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const late = capture(f, 1, performance.now() + 2500);
		await vi.advanceTimersByTimeAsync(2500);
		await expect(late).resolves.toBe(UNANSWERED);
		const next = capture(f);
		boundary.resolve({ answer: "saved", report });
		await expect(next).resolves.toBeUndefined();
		expect(f.ops()).toEqual(["mount", "boundary", "boundary"]);
	});

	it("stops a capture with its caller", async () => {
		const f = await mounted();
		const stop = new AbortController();
		stop.abort(new Error("stopped"));
		await expect(capture(f, 1, performance.now() + 15000, stop.signal)).rejects.toThrow("stopped");
		expect(f.folders.mounted(binding.screenId)).toEqual({ name, epoch: 1 });
	});
});
