import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import {
	CompanyComputerDesktopFolders,
	checkCompanyComputerFolderParent,
	closeCompanyComputerFolderView,
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

/** The core's folder views as `qorpera_folder_view_open`, `_close` and `_commits` answer them. A read of a view's
 * commits takes the next page queued (a function is called for it), or a view's last page with none. */
function core() {
	const opened: Record<string, unknown>[] = [];
	const closed: unknown[] = [];
	const commits: Record<string, unknown>[] = [];
	const reads: AbortSignal[] = [];
	const pages: unknown[] = [];
	const call = vi.fn(async (method: string, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown> => {
		if (method === "qorpera_folder_view_commits") {
			commits.push(args);
			reads.push(signal);
			const next = pages.shift();
			if (typeof next === "function") return next(args, signal);
			return (
				next ?? {
					schema: "qorpera.folder-view-commits/v1",
					viewId: args.p_view_id,
					state: "closed",
					more: false,
					commits: [],
				}
			);
		}
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
	return { call, opened, closed, view, commits, reads, pages };
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
			closeCompanyComputerFolderView(f.registry, {
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

describe("a run's report of its desktop changes", () => {
	const PAUSED = "the company is paused, so the company folder did not take this desktop's last changes";
	const CLOSED = "the company folder had closed this desktop's view, so it did not take its last changes";
	const REFUSED = "the company folder refused this desktop's last changes";

	afterEach(() => {
		vi.restoreAllMocks();
	});

	/** A page of a view's commits, as `qorpera_folder_view_commits` answers it. */
	const page = (
		n: number,
		commits: { id: number; units: unknown[] }[],
		{ more = false, state = "open" }: { more?: boolean; state?: string } = {},
	) => ({
		schema: "qorpera.folder-view-commits/v1",
		viewId: computerId(100 + n),
		state,
		more,
		commits: commits.map(({ id, units }) => ({ commitId: computerId(id), units })),
	});
	/** The office's clock, moved on past the report's read throttle (or further). */
	function clock() {
		const now = performance.now.bind(performance);
		let skipped = 0;
		vi.spyOn(performance, "now").mockImplementation(() => now() + skipped);
		return {
			skip: (ms = 1000) => {
				skipped += ms;
			},
		};
	}
	const NONCE = "7d1c2b3a-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
	/** A page of a view's notices as the helper answers the folder service's: change sets refused whole (the paths
	 * given, `pathCount` of them in all) from `n` on, then a commit's, which the report takes from the core. */
	const noticed = (
		n: number,
		refused: { reason: string; paths: string[]; pathCount?: number }[],
		{ more = false }: { more?: boolean } = {},
	) => ({
		answer: "notices",
		nonce: NONCE,
		notices: [
			...refused.map(({ reason, paths, pathCount = paths.length }, at) => ({
				n: n + at,
				at: 1760000000000,
				refused: reason,
				paths,
				pathCount,
			})),
			{ n: n + refused.length, at: 1760000001000, commitId: computerId(70), seq: 7 },
		],
		last: n + refused.length,
		more,
	});
	const asks = (f: ReturnType<typeof fixture>) => f.asked.filter((request) => request.op === "notices");
	async function followed(signal = new AbortController().signal) {
		const f = fixture();
		f.folders.follow(run.runId, signal);
		f.answer("mount", { answer: "mounted" });
		await f.hold(run);
		return f;
	}
	const report = (f: ReturnType<typeof fixture>, shown = "", until = performance.now() + 1000) =>
		f.folders.report(run.runId, shown, new AbortController().signal, until);
	const drain = (f: ReturnType<typeof fixture>) =>
		f.folders.drain(binding.screenId, new AbortController().signal, performance.now() + 19000);

	it("reports the commits of the views opened for the run, and drops only what the mark it was shown names", async () => {
		const t = clock();
		const f = await followed();
		f.pages.push(
			page(1, [
				{
					id: 60,
					units: [
						{ path: "docs/a.md", outcome: "saved" },
						{ path: "docs/b.md", outcome: "saved" },
						{ path: "docs/c.md", outcome: "conflict", reason: "it changed in the company folder meanwhile" },
						// An erased path.
						{ outcome: "refused" },
					],
				},
			]),
		);
		const first = await report(f);
		expect(f.commits).toEqual([
			{ p_view_id: computerId(101), p_pass: "pass-1", p_after_commit_id: null, p_limit: 64 },
		]);
		expect(first).toEqual({
			mark: expect.stringMatching(/^[0-9a-f-]{36}:3$/),
			report: {
				saved: 2,
				notSaved: [
					{ path: "docs/c.md", outcome: "conflict", reason: "it changed in the company folder meanwhile" },
					{ path: "", outcome: "refused" },
				],
			},
		});
		// A report whose result was never shown comes again, and so it does past another record's mark. The core is read
		// at most once a second.
		await expect(report(f)).resolves.toEqual(first);
		await expect(report(f, `${computerId(99)}:3`)).resolves.toEqual(first);
		await expect(report(f, first!.mark)).resolves.toBeUndefined();
		expect(f.commits).toHaveLength(1);
		t.skip();
		f.pages.push(page(1, [{ id: 61, units: [{ path: "docs/d.md", outcome: "saved" }] }]));
		await expect(report(f, first!.mark)).resolves.toEqual({
			mark: first!.mark.replace(/:3$/, ":4"),
			report: { saved: 1 },
		});
		expect(f.commits[1]).toMatchObject({ p_view_id: computerId(101), p_after_commit_id: computerId(60) });
		// A run that is not followed has no report.
		await expect(
			f.folders.report(computerId(22), "", new AbortController().signal, performance.now() + 1000),
		).resolves.toBeUndefined();
	});

	it("reads each of the run's views on from its last commit, page by page, until it is closed and read to its end", async () => {
		const t = clock();
		const f = await followed();
		// A member takes the screen over: their view is not the run's.
		f.answer("switch", { answer: "switched" });
		await f.hold(member);
		f.pages.push(page(1, [{ id: 60, units: [{ path: "docs/a.md", outcome: "saved" }] }], { more: true }));
		const first = await report(f);
		expect(first?.report).toEqual({ saved: 1, more: true });
		t.skip();
		f.pages.push(
			page(
				1,
				[
					{
						id: 61,
						units: [
							{ path: "docs/b.md", outcome: "saved" },
							{ path: "docs/c.md", outcome: "saved" },
						],
					},
				],
				{
					state: "closed",
				},
			),
		);
		const second = await report(f, first!.mark);
		expect(second?.report).toEqual({ saved: 2 });
		t.skip();
		await expect(report(f, second!.mark)).resolves.toBeUndefined();
		expect(f.commits.map((args) => [args.p_view_id, args.p_after_commit_id])).toEqual([
			[computerId(101), null],
			[computerId(101), computerId(60)],
		]);
	});

	it("shows at most twenty paths not saved a report, in 2 KiB but one at least, and the rest in the next", async () => {
		const f = await followed();
		const short = Array.from({ length: 25 }, (_, n) => ({ path: `docs/${n}.md`, outcome: "conflict" }));
		const long = Array.from({ length: 8 }, (_, n) => ({ path: `${n}`.padEnd(400, "a"), outcome: "conflict" }));
		const escaped = { path: "<".repeat(300), outcome: "refused", reason: "&".repeat(200) };
		f.pages.push(
			page(1, [
				{ id: 60, units: short },
				{ id: 61, units: long },
				{ id: 62, units: [escaped] },
			]),
		);
		const cut = long.map(({ path, outcome }) => ({ path: `${path.slice(0, 300)}…`, outcome }));
		const first = await report(f);
		expect(first?.report).toEqual({ saved: 0, notSaved: short.slice(0, 20), more: true });
		// Five short paths take 215 bytes; each cut long path takes 336.
		const second = await report(f, first!.mark);
		expect(second?.report).toEqual({ saved: 0, notSaved: [...short.slice(20), ...cut.slice(0, 5)], more: true });
		const third = await report(f, second!.mark);
		expect(third?.report).toEqual({ saved: 0, notSaved: cut.slice(5), more: true });
		const fourth = await report(f, third!.mark);
		expect(fourth?.report).toEqual({ saved: 0, notSaved: [escaped] });
		await expect(report(f, fourth!.mark)).resolves.toBeUndefined();
	});

	it("reports a drain's refusal of the desktop's last changes, one a report, and the paths of one that made no commit", async () => {
		const f = await followed();
		f.answer("unmount", {
			answer: "refused",
			report: {
				commitId: null,
				seq: null,
				paths: [
					{ path: "docs/a.md", outcome: "not_applied", reason: "the save did not get through" },
					{ path: "docs/b.md", outcome: "saved" },
				],
				refused: "stopped",
			},
			unmounted: false,
		});
		f.answer("drop", { answer: "dropped" });
		await drain(f);
		f.answer("mount", { answer: "mounted" });
		await f.hold(run);
		f.answer("unmount", { answer: "closed", unmounted: true });
		await drain(f);
		// A boundary that made a commit: its paths come with the commit's units.
		f.answer("mount", { answer: "mounted" });
		await f.hold(run);
		f.answer("unmount", {
			answer: "refused",
			report: { commitId: computerId(60), seq: 7, paths: [{ path: "docs/c.md", outcome: "conflict" }] },
			unmounted: false,
		});
		f.answer("drop", { answer: "dropped" });
		await drain(f);
		// A member's drain is not the run's.
		f.answer("mount", { answer: "mounted" });
		await f.hold(member);
		f.answer("unmount", { answer: "closed", unmounted: true });
		await drain(f);

		const first = await report(f);
		expect(first?.report).toEqual({
			saved: 0,
			notSaved: [{ path: "docs/a.md", outcome: "not_applied", reason: "the save did not get through" }],
			refused: PAUSED,
			more: true,
		});
		const second = await report(f, first!.mark);
		expect(second?.report).toEqual({ saved: 0, refused: CLOSED });
		await expect(report(f, second!.mark)).resolves.toBeUndefined();
		// Each of the run's views was read to its end; the member's was not read.
		expect(f.commits.map((args) => args.p_view_id)).toEqual([computerId(101), computerId(102), computerId(103)]);
	});

	it.each([
		["stopped", PAUSED],
		[
			"unreadable",
			"the company folder refused this desktop's last changes: they used a read that is no longer readable",
		],
		[
			"unproven",
			"the company folder refused this desktop's last changes: the desktop's reads could not be shown complete",
		],
		["denied", REFUSED],
		["invalid", REFUSED],
	])("words a boundary refused %s in its own words", async (refused, words) => {
		const f = await followed();
		f.answer("unmount", {
			answer: "refused",
			report: { commitId: null, seq: null, paths: [], refused },
			unmounted: false,
		});
		f.answer("drop", { answer: "dropped" });
		await drain(f);
		await expect(report(f)).resolves.toMatchObject({ report: { saved: 0, refused: words } });
	});

	it("tells the screen's desktop what each read finds, and the same quiet refusal again only after a minute", async () => {
		const t = clock();
		const f = await followed();
		const told: [string, string][] = [];
		const unlisten = f.folders.listen((screenId, text) => told.push([screenId, text]));
		f.folders.listen(() => {
			throw new Error("a listener's own failure");
		});
		f.pages.push(
			page(1, [
				{
					id: 60,
					units: [
						{ path: "docs/a.md", outcome: "saved" },
						{ path: "docs/b.md", outcome: "saved" },
						{ path: "docs/c.md", outcome: "conflict", reason: "it changed in the company folder meanwhile" },
						{ path: "docs/d.md", outcome: "waiting_for_review" },
						{ path: "docs/e.md", outcome: "denied" },
					],
				},
			]),
		);
		f.answer("notices", noticed(1, [{ reason: "refused", paths: ["docs/f.md"] }]));
		await report(f);
		expect(told).toEqual([
			[
				binding.screenId,
				"2 changes saved to the company folder.\n1 change waiting for a member's approval.\n" +
					"1 change not saved: the company folder had a newer version.\n1 change not saved.",
			],
			[binding.screenId, "The company folder refused a change on this desktop."],
		]);
		// The same refusal within the minute is counted on the report, not told again; another one is.
		t.skip();
		f.answer(
			"notices",
			noticed(3, [
				{ reason: "refused", paths: ["docs/f.md"] },
				{ reason: "stopped", paths: [], pathCount: 3 },
			]),
		);
		await report(f);
		expect(told.slice(2)).toEqual([
			[binding.screenId, "The company is paused, so the company folder did not take 3 changes on this desktop."],
		]);
		t.skip(60000);
		f.answer("notices", noticed(6, [{ reason: "stopped", paths: [], pathCount: 3 }]));
		await report(f);
		expect(told.slice(3)).toEqual([
			[binding.screenId, "The company is paused, so the company folder did not take 3 changes on this desktop."],
		]);
		// No longer told once the listener goes.
		unlisten();
		t.skip(60000);
		f.answer("notices", noticed(8, [{ reason: "refused", paths: ["docs/g.md"] }]));
		await report(f);
		expect(told).toHaveLength(4);
	});

	it("tells the desktop why a drain did not take its last changes, whoever held it", async () => {
		const f = await followed();
		const told: string[] = [];
		f.folders.listen((screenId, text) => told.push(`${screenId === binding.screenId}: ${text}`));
		f.answer("unmount", {
			answer: "refused",
			report: {
				commitId: null,
				seq: null,
				paths: [
					{ path: "docs/a.md", outcome: "not_applied", reason: "the save did not get through" },
					{ path: "docs/b.md", outcome: "saved" },
				],
				refused: "stopped",
			},
			unmounted: false,
		});
		f.answer("drop", { answer: "dropped" });
		await drain(f);
		// A boundary that made no commit and has no refusal of its own: what became of the paths.
		f.answer("mount", { answer: "mounted" });
		await f.hold(run);
		f.answer("unmount", {
			answer: "refused",
			report: {
				commitId: null,
				seq: null,
				paths: [
					{ path: "docs/c.md", outcome: "conflict" },
					{ path: "docs/d.md", outcome: "conflict" },
				],
			},
			unmounted: false,
		});
		f.answer("drop", { answer: "dropped" });
		await drain(f);
		// A boundary that made a commit: the desktop is told of it when the view's commits are read.
		f.answer("mount", { answer: "mounted" });
		await f.hold(run);
		f.answer("unmount", {
			answer: "refused",
			report: { commitId: computerId(60), seq: 7, paths: [{ path: "docs/e.md", outcome: "conflict" }] },
			unmounted: false,
		});
		f.answer("drop", { answer: "dropped" });
		await drain(f);
		// A member's desktop is told too.
		f.answer("mount", { answer: "mounted" });
		await f.hold(member);
		f.answer("unmount", { answer: "closed", unmounted: true });
		await drain(f);
		expect(told).toEqual([
			"true: The company is paused, so the company folder did not take this desktop's last changes.",
			"true: 2 changes not saved: the company folder had a newer version.",
			"true: The company folder had closed this desktop's view, so it did not take its last changes.",
		]);
	});

	it("reads a member's view for their desktop every five seconds until it is read to its end", async () => {
		/** The reads' answers, which the fake timers do not wait for. */
		const settle = async () => {
			for (let turn = 0; turn < 10; turn++) await new Promise((resolve) => setImmediate(resolve));
		};
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
		try {
			const t = clock();
			const f = fixture();
			const told: string[] = [];
			f.folders.listen((_screenId, text) => told.push(text));
			f.answer("mount", { answer: "mounted" });
			await f.hold(member);
			expect(f.commits).toEqual([]);
			f.pages.push(page(1, [{ id: 60, units: [{ path: "docs/a.md", outcome: "saved" }] }]));
			f.answer("notices", noticed(1, [{ reason: "unproven", paths: ["docs/b.md", "docs/c.md"] }]));
			await vi.advanceTimersByTimeAsync(5000);
			await settle();
			expect(f.commits).toEqual([
				{ p_view_id: computerId(101), p_pass: "pass-1", p_after_commit_id: null, p_limit: 64 },
			]);
			expect(told).toEqual([
				"1 change saved to the company folder.",
				"The company folder refused 2 changes on this desktop: the desktop's reads could not be shown complete.",
			]);
			// The view closed and was read to its end, and the folder service no longer keeps it: the reads stop.
			t.skip();
			f.answer("notices", { answer: "notices", nonce: null, notices: [], last: 0, more: false });
			await vi.advanceTimersByTimeAsync(5000);
			await settle();
			expect(f.commits).toHaveLength(2);
			expect(asks(f)).toHaveLength(2);
			t.skip(60000);
			await vi.advanceTimersByTimeAsync(30000);
			await settle();
			expect(f.commits).toHaveLength(2);
			expect(asks(f)).toHaveLength(2);
			expect(told).toHaveLength(2);
		} finally {
			vi.useRealTimers();
		}
	});

	it("keeps the report while one of the run's sessions lives, and reports no commit twice when a view is held again", async () => {
		const t = clock();
		const one = new AbortController();
		const two = new AbortController();
		const f = await followed(one.signal);
		f.folders.follow(run.runId, two.signal);
		f.folders.follow(run.runId, two.signal);
		f.pages.push(page(1, [{ id: 60, units: [{ path: "docs/a.md", outcome: "saved" }] }]));
		const first = await report(f);
		expect(first?.report).toEqual({ saved: 1 });
		one.abort();
		// The same view held again keeps its place: it is read on from its last commit.
		f.answer("list", { answer: "list", mounts: [{ name, viewId: computerId(101), program: "running" }] });
		await f.hold(run);
		t.skip();
		f.pages.push(page(1, []));
		await expect(report(f, first!.mark)).resolves.toBeUndefined();
		expect(f.commits.map((args) => args.p_after_commit_id)).toEqual([null, computerId(60)]);
		// The last session ends: the read on its way stops, and the report goes.
		t.skip();
		f.pages.push(
			(_args: unknown, signal: AbortSignal) =>
				new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason))),
		);
		await expect(report(f, first!.mark, performance.now() + 50)).resolves.toBeUndefined();
		two.abort();
		expect(f.reads[2].aborted).toBe(true);
		t.skip();
		await expect(report(f)).resolves.toBeUndefined();
		expect(f.commits).toHaveLength(3);
		// A report followed anew starts again; the old record's mark drops nothing of it.
		f.folders.follow(run.runId, new AbortController().signal);
		f.answer("list", { answer: "list", mounts: [{ name, viewId: computerId(101), program: "running" }] });
		await f.hold(run);
		f.pages.push(page(1, [{ id: 61, units: [{ path: "docs/b.md", outcome: "saved" }] }]));
		const again = await report(f, first!.mark);
		expect(again?.report).toEqual({ saved: 1 });
		expect(again?.mark.split(":")[0]).not.toBe(first!.mark.split(":")[0]);
	});

	it("ends a view's reads at a refusal or an answer that is no page, and asks again past no answer", async () => {
		const t = clock();
		const f = await followed();
		// The program ended: the mount is made again with the run's second view.
		f.answer("list", { answer: "list", mounts: [{ name, viewId: computerId(101), program: "closed" }] });
		f.answer("unmount", { answer: "closed", unmounted: true });
		f.answer("mount", { answer: "mounted" });
		await expect(f.hold(run)).resolves.toEqual({ name, epoch: 2 });
		f.pages.push(
			() => {
				throw new Error("fetch failed");
			},
			{ ...page(2, []), viewId: computerId(101) },
			(args: Record<string, unknown>) =>
				http(refused("Folder view is invalid")).registry.call(
					"qorpera_folder_view_commits",
					args,
					new AbortController().signal,
				),
		);
		await expect(report(f)).resolves.toBeUndefined();
		t.skip();
		await expect(report(f)).resolves.toBeUndefined();
		t.skip();
		await expect(report(f)).resolves.toBeUndefined();
		expect(f.commits.map((args) => args.p_view_id)).toEqual([computerId(101), computerId(102), computerId(101)]);
	});

	it("reports a change set the folder service refused whole at a quiet boundary, once with its paths, then counted", async () => {
		const t = clock();
		const f = await followed();
		const denied = { reason: "denied", paths: ["docs/a.md", "docs/b.md"], pathCount: 3 };
		const stopped = { reason: "stopped", paths: ["docs/c.md"] };
		// The same refusal again before a report gave the run the first: counted on it, in its place, its paths not given
		// twice.
		f.answer("notices", noticed(1, [denied, stopped, denied]));
		const notSaved = [
			{ path: "docs/a.md", outcome: "refused" },
			{ path: "docs/b.md", outcome: "refused" },
		];
		const first = await report(f);
		expect(first?.report).toEqual({
			saved: 0,
			notSaved,
			refused: "the company folder refused 3 changes on this desktop (2 times)",
			more: true,
		});
		expect(asks(f)).toEqual([{ op: "notices", view: f.view(1), after: 0, nonce: null }]);
		// The run was given that report, and the read its next ask starts runs past its wait: the same refusal this read
		// brings may come after the run was shown the first, so it is not counted on it; it comes as new, with its paths.
		t.skip();
		const late = computerDeferred<unknown>();
		f.answer("notices", () => late.promise);
		await expect(report(f, "", performance.now() + 50)).resolves.toEqual(first);
		// The service has more pages of this view's notices than it gave.
		late.resolve(noticed(5, [denied], { more: true }));
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(asks(f)[1]).toEqual({ op: "notices", view: f.view(1), after: 4, nonce: NONCE });
		const second = await report(f, first!.mark);
		expect(second?.report).toEqual({
			saved: 0,
			notSaved: [{ path: "docs/c.md", outcome: "refused" }],
			refused: "the company is paused, so the company folder did not take a change on this desktop",
			more: true,
		});
		// Every item is given, and the service's further pages still say more comes.
		expect((await report(f, second!.mark))?.report).toEqual({
			saved: 0,
			notSaved,
			refused: "the company folder refused 3 changes on this desktop",
			more: true,
		});
	});

	it.each([
		["stopped", 1, "the company is paused, so the company folder did not take a change on this desktop"],
		[
			"unreadable",
			2,
			"the company folder refused 2 changes on this desktop: they used a read that is no longer readable",
		],
		[
			"unproven",
			0,
			"the company folder refused changes on this desktop: the desktop's reads could not be shown complete",
		],
		["denied", 1, "the company folder refused a change on this desktop"],
	])("words a change set refused %s at a quiet boundary in its own words", async (reason, count, words) => {
		const f = await followed();
		f.answer("notices", noticed(1, [{ reason, paths: ["docs/a.md", "docs/b.md"].slice(0, count) }]));
		await expect(report(f)).resolves.toMatchObject({ report: { saved: 0, refused: words } });
	});

	it("asks the run's older view's notices once more when its mount moves on, until the service let the view go", async () => {
		const t = clock();
		const f = await followed();
		// A member takes the screen over: the mount moves to their view, and the run's is asked once more.
		f.answer("switch", { answer: "switched" });
		f.answer("notices", noticed(1, [{ reason: "stopped", paths: ["docs/a.md"] }]));
		await f.hold(member);
		await vi.waitFor(() => expect(asks(f)).toEqual([{ op: "notices", view: f.view(1), after: 0, nonce: null }]));
		// The view's commits are read to their end, and the service no longer keeps it: neither is asked again.
		f.pages.push(page(1, [], { state: "closed" }));
		f.answer("notices", { answer: "notices", nonce: null, notices: [], last: 0, more: false });
		const first = await report(f);
		expect(first?.report).toEqual({
			saved: 0,
			notSaved: [{ path: "docs/a.md", outcome: "refused" }],
			refused: "the company is paused, so the company folder did not take a change on this desktop",
		});
		expect(asks(f)[1]).toEqual({ op: "notices", view: f.view(1), after: 2, nonce: NONCE });
		t.skip();
		await expect(report(f, first!.mark)).resolves.toBeUndefined();
		expect(f.commits).toHaveLength(1);
		expect(asks(f)).toHaveLength(2);
		// The member's view is not the run's.
		expect(asks(f).some((request) => request.op === "notices" && request.view.viewId === computerId(102))).toBe(
			false,
		);
	});

	it("asks a view's notices when the run's drain closes it, and one no service answers a minute and a half on", async () => {
		const t = clock();
		const f = await followed();
		f.answer("unmount", { answer: "closed", unmounted: true });
		await drain(f);
		await vi.waitFor(() => expect(asks(f)).toHaveLength(1));
		// A service without the notices role gives no answer: the view's notices are asked at each read.
		f.pages.push(page(1, [], { state: "closed" }));
		const first = await report(f);
		expect(first?.report).toEqual({ saved: 0, refused: CLOSED });
		expect(asks(f)).toHaveLength(2);
		t.skip();
		await expect(report(f, first!.mark)).resolves.toBeUndefined();
		expect(asks(f)).toHaveLength(3);
		t.skip(90000);
		await expect(report(f, first!.mark)).resolves.toBeUndefined();
		expect(asks(f)).toHaveLength(4);
		t.skip();
		await expect(report(f, first!.mark)).resolves.toBeUndefined();
		expect(asks(f)).toHaveLength(4);
		expect(f.commits).toHaveLength(1);
		expect(f.options.at(-1)).toMatchObject({ timeoutMs: 15000 });
	});

	it("waits for a read until its deadline, and the read goes on for the next ask", async () => {
		const f = await followed();
		const answer = computerDeferred<unknown>();
		f.pages.push(() => answer.promise);
		await expect(report(f, "", performance.now() + 50)).resolves.toBeUndefined();
		const next = report(f);
		answer.resolve(page(1, [{ id: 60, units: [{ path: "docs/a.md", outcome: "saved" }] }]));
		await expect(next).resolves.toMatchObject({ report: { saved: 1 } });
		expect(f.commits).toHaveLength(1);
	});
});
