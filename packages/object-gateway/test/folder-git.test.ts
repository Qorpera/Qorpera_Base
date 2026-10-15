import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CoreAnswerError, SupabaseFolderCore } from "../src/folder-service/core.ts";
import {
	type GitUnit,
	gitLockTarget,
	gitPlace,
	gitReflog,
	gitRefused,
	gitShared,
	gitUnpublished,
} from "../src/folder-service/git.ts";
import type { Transport } from "../src/folder-service/https-request.ts";
import { NasObjects } from "../src/folder-service/objects.ts";
import {
	type BridgeInfo,
	type CoreReceipt,
	type Hello,
	ProtocolError,
	type ReadLogEntry,
} from "../src/folder-service/protocol.ts";
import { FolderService, type ViewHandle } from "../src/folder-service/service.ts";
import { FolderStaging } from "../src/folder-service/staging.ts";
import {
	ALLOCATION,
	codeHostGrants,
	companyGrants,
	ENV,
	FakeCore,
	FakeUploads,
	folder,
	hashOf,
	OFFICE,
	PASS,
	storeFile,
	v,
} from "./folder-service-fixtures.ts";

const R = "code/acme/app/repo.git";

describe("git paths", () => {
	it("places a path in a code area", () => {
		expect(gitPlace("code/acme/app")).toEqual({ kind: "other" });
		expect(gitPlace("notes/repo.git/HEAD")).toEqual({ kind: "other" });
		expect(gitPlace(R)).toEqual({ kind: "git", area: "code/acme/app", rest: "" });
		expect(gitPlace(`${R}/refs/heads/main`)).toEqual({ kind: "git", area: "code/acme/app", rest: "refs/heads/main" });
		expect(gitPlace("code/acme/app/worktrees")).toEqual({ kind: "other" });
		expect(gitPlace("code/acme/app/worktrees/w1")).toEqual({
			kind: "worktree",
			area: "code/acme/app",
			worker: "w1",
			rest: "",
		});
		expect(gitPlace("code/acme/app/worktrees/w1/src/a.ts")).toMatchObject({ worker: "w1", rest: "src/a.ts" });
	});

	it("takes leases on refs, HEAD, packed-refs and shallow only", () => {
		expect(gitLockTarget(`${R}/refs/heads/main.lock`)).toBe(`${R}/refs/heads/main`);
		expect(gitLockTarget(`${R}/HEAD.lock`)).toBe(`${R}/HEAD`);
		expect(gitLockTarget(`${R}/packed-refs.lock`)).toBe(`${R}/packed-refs`);
		expect(gitLockTarget(`${R}/shallow.lock`)).toBe(`${R}/shallow`);
		expect(gitLockTarget(`${R}/config.lock`)).toBeNull();
		expect(gitLockTarget(`${R}/worktrees/w1/index.lock`)).toBeNull();
		expect(gitLockTarget(`${R}/refs/heads/main`)).toBeNull();
		expect(gitLockTarget("code/acme/app/worktrees/w1/refs/heads/main.lock")).toBeNull();
		expect(gitReflog(`${R}/refs/heads/main`)).toBe(`${R}/logs/refs/heads/main`);
	});

	it("shares everything in the git directory but objects, workers' files and the session's own", () => {
		for (const rest of ["HEAD", "refs/heads/main", "packed-refs", "logs/HEAD", "FETCH_HEAD"])
			expect(gitShared(rest), rest).toBe(true);
		for (const rest of [
			"",
			"objects/ab/cd",
			"worktrees",
			"worktrees/w1/HEAD",
			"config",
			"hooks/pre-commit",
			"info/exclude",
		])
			expect(gitShared(rest), rest).toBe(false);
	});

	it("refuses the session's own files and alternates, and in the code host's view only alternates", () => {
		for (const rest of [
			"config",
			"config.lock",
			"hooks/pre-commit",
			"info/exclude",
			"worktrees/w1/config.worktree",
			"objects/info/alternates",
			"objects/info/http-alternates.lock",
		])
			expect(gitRefused(`${R}/${rest}`), rest).toBe(true);
		for (const rest of ["HEAD", "objects/info/packs", "worktrees/w1/index", "worktrees/w1/HEAD"])
			expect(gitRefused(`${R}/${rest}`), rest).toBe(false);
		expect(gitRefused("code/acme/app/worktrees/w1/hooks/x")).toBe(false);
		for (const rest of ["config", "config.lock", "hooks/pre-commit", "info/exclude", "worktrees/w1/config.worktree"])
			expect(gitRefused(`${R}/${rest}`, true), rest).toBe(false);
		expect(gitRefused(`${R}/objects/info/alternates`, true)).toBe(true);
	});

	it("never publishes what git has not finished", () => {
		for (const rest of [
			"refs/heads/main.lock",
			"worktrees/w1/index.lock",
			"objects/ab/tmp_obj_Xy12",
			"objects/pack/tmp_pack_Ab12",
			"objects/pack/tmp_idx_Ab12",
			"objects/incoming-Q1/pack/pack-1.pack",
			"objects/pack/pack-1.keep",
		])
			expect(gitUnpublished(`${R}/${rest}`), rest).toBe(true);
		for (const rest of ["objects/ab/cdef", "objects/pack/pack-1.pack", "refs/heads/main", "worktrees/w1/index"])
			expect(gitUnpublished(`${R}/${rest}`), rest).toBe(false);
		expect(gitUnpublished("code/acme/app/worktrees/w1/yarn.lock")).toBe(false);
	});
});

describe("the core's git leases", () => {
	const actor = { kind: "view", viewId: "git-view", pass: PASS } as const;
	const MAIN = `${R}/refs/heads/main`;

	function coreAnswering(answer: unknown) {
		const asked: { path: string; body: unknown }[] = [];
		const transport: Transport = async (url, request) => {
			asked.push({ path: url.pathname, body: JSON.parse(request.body ?? "null") });
			return { status: 200, body: Buffer.from(JSON.stringify(answer)) };
		};
		return {
			asked,
			core: new SupabaseFolderCore({ projectUrl: "https://cloud.test", secretKey: "sb_secret_fixture", transport }),
		};
	}

	it("takes a lease and reads each of its answers", async () => {
		const held = {
			schema: "qorpera.folder-git-lease/v1",
			state: "held",
			leaseId: v(5),
			path: MAIN,
			versions: { file: v(1), reflog: null, packedRefs: v(2) },
		};
		const { asked, core } = coreAnswering(held);
		expect(await core.gitLeaseTake(ENV, actor, MAIN)).toEqual({
			state: "held",
			leaseId: v(5),
			path: MAIN,
			versions: { file: v(1), reflog: null, packedRefs: v(2) },
		});
		expect(asked).toEqual([
			{
				path: "/rest/v1/rpc/qorpera_folder_git_lease_take",
				body: { p_environment_id: ENV, p_actor: { kind: "view", viewId: "git-view", pass: PASS }, p_path: MAIN },
			},
		]);
		const take = (answer: unknown) => coreAnswering(answer).core.gitLeaseTake(ENV, actor, MAIN);
		const busy = { schema: "qorpera.folder-git-lease/v1", state: "busy", leaseUntil: "2026-10-15T10:00:00Z" };
		expect(await take(busy)).toEqual({ state: "busy", leaseUntil: "2026-10-15T10:00:00Z", reason: null });
		expect(await take({ ...busy, reason: "maintenance" })).toMatchObject({ reason: "maintenance" });
		expect(await take({ schema: "qorpera.folder-git-lease/v1", state: "refused", reason: "git_stash" })).toEqual({
			state: "refused",
			reason: "git_stash",
		});
		for (const bad of [
			{ ...held, schema: "qorpera.folder-git-lease/v2" },
			{ ...held, path: `${R}/HEAD` },
			{ ...held, versions: { file: "1", reflog: null, packedRefs: null } },
			{ ...busy, leaseUntil: 7 },
			{ ...held, state: "taken" },
		])
			await expect(take(bad)).rejects.toBeInstanceOf(CoreAnswerError);
	});

	it("publishes whole, releases and drops", async () => {
		const units: GitUnit[] = [{ op: "delete", path: MAIN, expectedVersion: v(1) }];
		const answer = {
			schema: "qorpera.folder-commit/v1",
			commitId: v(9),
			seq: 4,
			units: [{ unit: 1, outcome: "saved", version: null }],
			published: true,
		};
		const { asked, core } = coreAnswering(answer);
		expect(await core.gitPublish(ENV, actor, v(5), "key-1", units)).toMatchObject({ seq: 4, published: true });
		expect(await core.gitLeaseRelease(ENV, actor, v(5), units)).toMatchObject({ published: true });
		expect(await core.gitLeaseRelease(ENV, actor, v(5), null)).toBeNull();
		expect(asked.map((a) => a.path)).toEqual([
			"/rest/v1/rpc/qorpera_folder_git_publish",
			"/rest/v1/rpc/qorpera_folder_git_lease_release",
			"/rest/v1/rpc/qorpera_folder_git_lease_release",
		]);
		expect(asked[0]?.body).toMatchObject({ p_lease_id: v(5), p_operation_key: "key-1", p_units: units });
		expect(asked[2]?.body).toMatchObject({ p_lease_id: v(5), p_units: null });
		const { published: _, ...unmarked } = answer;
		await expect(coreAnswering(unmarked).core.gitPublish(ENV, actor, v(5), "k", units)).rejects.toBeInstanceOf(
			CoreAnswerError,
		);
		expect(await coreAnswering([MAIN]).core.gitLeasesDrop(ENV, actor)).toEqual([MAIN]);
		await expect(coreAnswering([7]).core.gitLeasesDrop(ENV, actor)).rejects.toBeInstanceOf(CoreAnswerError);
	});

	it("the stand-in core holds one lease per file and publishes all or nothing", async () => {
		const core = new FakeCore();
		core.openView("git-view", PASS);
		core.openView("other-view", PASS);
		const other = { kind: "view", viewId: "other-view", pass: PASS } as const;
		const lease = await core.gitLeaseTake(ENV, actor, MAIN);
		expect(lease).toMatchObject({ state: "held", versions: { file: null, reflog: null, packedRefs: null } });
		expect(await core.gitLeaseTake(ENV, other, MAIN)).toMatchObject({ state: "busy" });
		core.gitRefusals.set(`${R}/refs/stash`, "git_stash");
		expect(await core.gitLeaseTake(ENV, other, `${R}/refs/stash`)).toEqual({ state: "refused", reason: "git_stash" });
		if (lease.state !== "held") throw new Error("not held");
		const ref = {
			manifestSha256: "a".repeat(64),
			fileSha256: "b".repeat(64),
			bytes: 41,
			mediaType: "text/plain",
			executable: false,
		};
		const stale = await core.gitPublish(ENV, actor, lease.leaseId, "k1", [
			{ op: "write", path: MAIN, file: ref, expectedVersion: v(3) },
		]);
		expect(stale).toMatchObject({
			published: false,
			seq: null,
			units: [{ outcome: "conflict", reason: "version_changed" }],
		});
		expect(core.gitLeases.has(MAIN)).toBe(true);
		const saved = await core.gitPublish(ENV, actor, lease.leaseId, "k2", [
			{ op: "write", path: `${R}/objects/ab/cdef`, file: ref },
			{ op: "write", path: MAIN, file: ref, expectedVersion: null },
		]);
		expect(saved).toMatchObject({ published: true, units: [{ outcome: "saved" }, { outcome: "saved" }] });
		expect(core.entries.get(`${R}/refs/heads`)?.kind).toBe("folder");
		expect(core.gitLeases.has(MAIN)).toBe(false);
		const again = await core.gitLeaseTake(ENV, other, MAIN);
		expect(again).toMatchObject({ state: "held", versions: { file: core.entries.get(MAIN)?.version } });
		expect(await core.gitLeasesDrop(ENV, other)).toEqual([MAIN]);
		expect(await core.gitLeasesDrop(ENV, other)).toEqual([]);
	});
});

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const AT_OFFICE: BridgeInfo = { cid: 90, lookup: "found", machine: OFFICE };
const SESSIONS = {
	first: { viewId: "5e6f7081-92a3-4b4c-8d5e-6f708192a3b4", pass: "cmdpass_0123456789-abcdefghijklmnopqrstuvwx" },
	second: { viewId: "6f708192-a3b4-4c5d-8e6f-708192a3b4c5", pass: "cmdpass_1123456789-abcdefghijklmnopqrstuvwx" },
} as const;
const CODE_HOST = {
	viewId: "708192a3-b4c5-4d6e-8f70-8192a3b4c5d6",
	pass: "cmdpass_2123456789-abcdefghijklmnopqrstuvwx",
};
const MAIN = `${R}/refs/heads/main`;
const MAIN_LOG = `${R}/logs/refs/heads/main`;
const TOPIC = `${R}/refs/heads/topic`;
const TOPIC_LOG = `${R}/logs/refs/heads/topic`;
const OBJECT = `${R}/objects/ab/cdef01`;
const LOG = "7a8b9c0d-1e2f-4a3b-8c4d-5e6f7a8b9c0d";
const receipt = (n: number): CoreReceipt => ({
	resourceId: v(60),
	resourceRevision: n,
	grantId: v(61),
	grantRevision: 1,
});
/** A read of `main` the machine logged, as its read log hands it over. */
const readOfMain = (seq: number): ReadLogEntry => ({ seq, path: MAIN, version: v(101), authority: receipt(1) });

/** A code area's git directory with two branches, two shell commands' views on it (two sessions, as the core opens
 * them), and the node's service. */
async function repo(grants = companyGrants()) {
	const root = await mkdtemp(join(tmpdir(), "qorpera-folder-git-"));
	const core = new FakeCore();
	const folders = ["code", "code/acme", "code/acme/app", R, `${R}/objects`, `${R}/objects/ab`, `${R}/refs`];
	const more = [`${R}/refs/heads`, `${R}/logs`, `${R}/logs/refs`, `${R}/logs/refs/heads`];
	core.seed([
		...[...folders, ...more].map((path) => folder(path)),
		await storeFile(root, MAIN, "1111\n", 101),
		await storeFile(root, MAIN_LOG, "0000 1111\n", 102),
		await storeFile(root, TOPIC, "2222\n", 103),
		await storeFile(root, TOPIC_LOG, "0000 2222\n", 104),
	]);
	for (const { viewId, pass } of Object.values(SESSIONS))
		core.openView(viewId, pass, { kind: "computer_shell_command", machineId: ALLOCATION });
	const objects = new NasObjects({ root, cacheBytes: 64 * 1024 * 1024 });
	const service = new FolderService({
		core,
		objects,
		grants,
		staging: new FolderStaging(core, new FakeUploads(root, core), objects),
		log: () => undefined,
	});
	const handles: ViewHandle[] = [];
	cleanups.push(async () => {
		for (const h of handles) h.release();
		service.stop();
		await rm(root, { recursive: true, force: true });
	});
	const openAs = async (view: { viewId: string; pass: string }) => {
		const hello: Hello = { protocol: 2, environmentId: ENV, ...view, role: "io" };
		const handle = await service.open(hello, AT_OFFICE);
		handles.push(handle);
		return handle;
	};
	const open = (session: keyof typeof SESSIONS) => openAs(SESSIONS[session]);
	return { core, service, open, openAs };
}

/** A small file, written as the folder program writes it: opened (exclusively, as git takes a lock), its one chunk,
 * closed. */
async function write(view: ViewHandle, path: string, text: string, exclusive = false): Promise<void> {
	const { handle } = await view.open({ path, create: true, exclusive, truncate: true });
	const data = Buffer.from(text);
	if (data.byteLength > 0)
		await view.chunk({ handle, index: 0, sha256: hashOf(data), bytes: data.byteLength, offset: 0, data });
	await view.close(handle, data.byteLength);
}

async function refused(promise: Promise<unknown>, code: string): Promise<void> {
	await expect(promise).rejects.toBeInstanceOf(ProtocolError);
	await expect(promise).rejects.toMatchObject({ code });
}

const names = async (view: ViewHandle, path: string) => (await view.list(path, undefined)).entries.map((e) => e.name);

describe("the lock protocol in the folder service", () => {
	it("takes the lease on a lock's create and publishes the ref, its log and new objects at its rename", async () => {
		const { core, open } = await repo();
		const view = await open("first");
		await write(view, OBJECT, "blob");
		await write(view, `${MAIN}.lock`, "3333\n", true);
		expect(core.gitLeases.get(MAIN)?.viewId).toBe(SESSIONS.first.viewId);
		await write(view, MAIN_LOG, "0000 1111\n1111 3333\n");
		await view.rename({ from: `${MAIN}.lock`, to: MAIN, noReplace: false });
		expect(core.gitPublishes).toEqual([
			{
				leaseId: expect.any(String),
				units: [
					{ op: "write", path: OBJECT, file: expect.objectContaining({ fileSha256: hashOf("blob") }) },
					{
						op: "write",
						path: MAIN,
						file: expect.objectContaining({ fileSha256: hashOf("3333\n") }),
						expectedVersion: v(101),
					},
					{
						op: "write",
						path: MAIN_LOG,
						file: expect.objectContaining({ fileSha256: hashOf("0000 1111\n1111 3333\n") }),
						expectedVersion: v(102),
					},
				],
				published: true,
			},
		]);
		expect(core.gitLeases.size).toBe(0);
		expect(core.entries.get(MAIN)?.fileSha256).toBe(hashOf("3333\n"));
		expect(await names(view, `${R}/refs/heads`)).toEqual(["main", "topic"]);
		const listed = (await view.list(`${R}/refs/heads`, undefined)).entries.find((e) => e.name === "main");
		expect(listed?.version).toBe(core.entries.get(MAIN)?.version);
		const other = await open("second");
		expect((await other.list(`${R}/refs/heads`, undefined)).entries.find((e) => e.name === "main")?.version).toBe(
			core.entries.get(MAIN)?.version,
		);
		expect(core.entries.has(`${MAIN}.lock`)).toBe(false);
	});

	it("refuses a lock another session holds, a shared file written without its lock, and session-local files", async () => {
		const { core, open } = await repo();
		const first = await open("first");
		const second = await open("second");
		await write(first, `${MAIN}.lock`, "3333\n", true);
		await refused(write(second, `${MAIN}.lock`, "4444\n", true), "EXISTS");
		await refused(write(second, MAIN, "4444\n"), "NOT_PERMITTED");
		await refused(write(second, `${R}/packed-refs`, "4444 refs/heads/main\n"), "NOT_PERMITTED");
		await write(second, "code/acme/app/notes.txt", "4444\n");
		await refused(second.rename({ from: "code/acme/app/notes.txt", to: TOPIC, noReplace: false }), "NOT_PERMITTED");
		await refused(second.unlink(TOPIC, undefined), "NOT_PERMITTED");
		await refused(write(first, `${R}/config`, "[core]\n"), "NOT_PERMITTED");
		await refused(write(first, `${R}/hooks/pre-commit`, "#!/bin/sh\n"), "NOT_PERMITTED");
		await refused(write(first, `${R}/objects/info/alternates`, "/elsewhere\n"), "NOT_PERMITTED");
		expect(core.gitLeases.get(MAIN)?.viewId).toBe(SESSIONS.first.viewId);
		expect(core.gitPublishes).toEqual([]);
	});

	it("answers a rename over a ref that changed since its lock with BUSY, and gives the lease back at the unlink", async () => {
		const { core, open } = await repo();
		const view = await open("first");
		await write(view, `${MAIN}.lock`, "3333\n", true);
		await write(view, MAIN_LOG, "0000 1111\n1111 3333\n");
		const live = core.entries.get(MAIN)!;
		core.entries.set(MAIN, { ...live, version: v(150) });
		await refused(view.rename({ from: `${MAIN}.lock`, to: MAIN, noReplace: false }), "BUSY");
		expect(core.gitPublishes.map((p) => p.published)).toEqual([false]);
		expect(core.gitLeases.has(MAIN)).toBe(true);
		await view.unlink(`${MAIN}.lock`, undefined);
		expect(core.gitLeases.size).toBe(0);
		expect(core.gitPublishes).toHaveLength(1);
		expect(await names(view, `${R}/refs/heads`)).toEqual(["main", "topic"]);
		const log = (await view.list(`${R}/logs/refs/heads`, undefined)).entries.find((e) => e.name === "main");
		expect(log?.version).toBe(v(102));
	});

	it("publishes a log git rewrote under the ref's lock when the lock is removed", async () => {
		const { core, open } = await repo();
		const view = await open("first");
		await write(view, `${MAIN}.lock`, "", true);
		await write(view, `${MAIN_LOG}.lock`, "1111 1111\n");
		await view.rename({ from: `${MAIN_LOG}.lock`, to: MAIN_LOG, noReplace: false });
		await view.unlink(`${MAIN}.lock`, undefined);
		expect(core.gitPublishes).toEqual([
			{
				leaseId: expect.any(String),
				units: [
					{
						op: "write",
						path: MAIN_LOG,
						file: expect.objectContaining({ fileSha256: hashOf("1111 1111\n") }),
						expectedVersion: v(102),
					},
				],
				published: true,
			},
		]);
		expect(core.entries.get(MAIN_LOG)?.fileSha256).toBe(hashOf("1111 1111\n"));
		expect(core.entries.get(MAIN)?.version).toBe(v(101));
		expect(await names(view, `${R}/logs/refs/heads`)).toEqual(["main", "topic"]);
	});

	it("shows the objects a publish put in a new objects folder once the view catches up", async () => {
		const { core, service, open } = await repo();
		const view = await open("first");
		await view.mkdir(`${R}/objects/cd`);
		await write(view, `${R}/objects/cd/ef0123`, "commit");
		await write(view, `${MAIN}.lock`, "3333\n", true);
		await view.rename({ from: `${MAIN}.lock`, to: MAIN, noReplace: false });
		expect(core.entries.get(`${R}/objects/cd/ef0123`)?.fileSha256).toBe(hashOf("commit"));
		await service.poll();
		await service.settled();
		expect(await names(view, `${R}/objects`)).toEqual(["ab", "cd"]);
		const listed = (await view.list(`${R}/objects/cd`, undefined)).entries;
		expect(listed.map((e) => [e.name, e.version])).toEqual([
			["ef0123", core.entries.get(`${R}/objects/cd/ef0123`)?.version],
		]);
	});

	it("shows a ref published in a new ref folder once the view catches up", async () => {
		const { core, service, open } = await repo();
		const view = await open("first");
		const feature = `${R}/refs/heads/feature`;
		await view.mkdir(feature);
		await write(view, `${feature}/foo.lock`, "3333\n", true);
		await view.rename({ from: `${feature}/foo.lock`, to: `${feature}/foo`, noReplace: false });
		expect(core.entries.get(`${feature}/foo`)?.fileSha256).toBe(hashOf("3333\n"));
		await service.poll();
		await service.settled();
		const listed = (await view.list(feature, undefined)).entries;
		expect(listed.map((e) => [e.name, e.version])).toEqual([["foo", core.entries.get(`${feature}/foo`)?.version]]);
	});

	it("publishes the code host's config and hooks as plain files at its boundary, and no session's", async () => {
		const { core, open, openAs } = await repo(codeHostGrants());
		core.openView(CODE_HOST.viewId, CODE_HOST.pass, { kind: "code_host", machineId: null });
		const host = await openAs(CODE_HOST);
		expect(host.codeHost).toBe(true);
		await write(host, `${R}/config`, "[core]\n\tbare = true\n");
		await host.mkdir(`${R}/hooks`);
		await write(host, `${R}/hooks/post-checkout`, "#!/bin/sh\n");
		await host.publish();
		expect(core.entries.get(`${R}/config`)?.fileSha256).toBe(hashOf("[core]\n\tbare = true\n"));
		expect(core.entries.get(`${R}/hooks/post-checkout`)?.fileSha256).toBe(hashOf("#!/bin/sh\n"));
		const session = await open("first");
		expect(session.codeHost).toBe(false);
		await refused(write(session, `${R}/config`, "[core]\n"), "NOT_PERMITTED");
		await refused(session.mkdir(`${R}/info`), "NOT_PERMITTED");
	});

	it("saves an object, or an objects folder, another session published first as it is", async () => {
		const { core, open } = await repo();
		const first = await open("first");
		const second = await open("second");
		for (const view of [first, second]) {
			await write(view, OBJECT, "blob");
			await view.mkdir(`${R}/objects/cd`);
			await write(view, `${R}/objects/cd/ef0123`, "tree");
		}
		await first.publish();
		const object = core.entries.get(OBJECT);
		expect(object?.fileSha256).toBe(hashOf("blob"));
		expect(core.entries.get(`${R}/objects/cd`)?.kind).toBe("folder");
		const answer = await second.publish();
		expect(answer.paths.map((p) => p.outcome)).toEqual(answer.paths.map(() => "saved"));
		expect(core.entries.get(OBJECT)?.fileSha256).toBe(hashOf("blob"));
		expect(core.entries.get(`${R}/objects/cd/ef0123`)?.fileSha256).toBe(hashOf("tree"));
		expect([...core.entries.keys()].filter((p) => p.startsWith(`${R}/objects`)).sort()).toEqual([
			`${R}/objects`,
			`${R}/objects/ab`,
			OBJECT,
			`${R}/objects/cd`,
			`${R}/objects/cd/ef0123`,
		]);
	});

	it("deletes a branch and its log when the lock is removed after them", async () => {
		const { core, open } = await repo();
		const view = await open("first");
		await write(view, `${TOPIC}.lock`, "", true);
		await view.unlink(TOPIC, undefined);
		await view.unlink(TOPIC_LOG, undefined);
		await view.unlink(`${TOPIC}.lock`, undefined);
		expect(core.gitPublishes).toEqual([
			{
				leaseId: expect.any(String),
				units: [
					{ op: "delete", path: TOPIC, expectedVersion: v(103) },
					{ op: "delete", path: TOPIC_LOG, expectedVersion: v(104) },
				],
				published: true,
			},
		]);
		expect(core.entries.has(TOPIC)).toBe(false);
		expect(core.entries.has(TOPIC_LOG)).toBe(false);
		expect(core.gitLeases.size).toBe(0);
		expect(await names(view, `${R}/refs/heads`)).toEqual(["main"]);
		expect(await names(view, `${R}/logs/refs/heads`)).toEqual(["main"]);
	});

	it("releases the machine's reads before a branch's deletion is published", async () => {
		const { core, open } = await repo();
		const view = await open("first");
		await view.reads({ log: LOG, reads: [readOfMain(1)], lost: false });
		await write(view, `${TOPIC}.lock`, "", true);
		await view.unlink(TOPIC, undefined);
		await view.unlink(TOPIC_LOG, undefined);
		expect(core.releases).toEqual([]);
		await view.unlink(`${TOPIC}.lock`, undefined);
		expect(core.releases.map((r) => r.reads.map((read) => read.path))).toEqual([[MAIN]]);
		expect(core.gitPublishes).toMatchObject([{ published: true }]);
		expect(core.entries.has(TOPIC)).toBe(false);
	});

	it("publishes no git change when the core refuses the machine's reads", async () => {
		const { core, open } = await repo();
		const view = await open("first");
		await view.reads({ log: LOG, reads: [readOfMain(1)], lost: false });
		core.releaseRefusal = "denied";
		await write(view, `${MAIN}.lock`, "3333\n", true);
		await refused(view.rename({ from: `${MAIN}.lock`, to: MAIN, noReplace: false }), "DENIED");
		await write(view, `${TOPIC}.lock`, "", true);
		await view.unlink(TOPIC, undefined);
		await refused(view.unlink(`${TOPIC}.lock`, undefined), "DENIED");
		expect(core.gitPublishes).toEqual([]);
		expect(core.entries.get(MAIN)?.fileSha256).toBe(hashOf("1111\n"));
		expect(core.entries.has(TOPIC)).toBe(true);
	});

	it("publishes no git change once the machine lost its read log, but still gives an unused lease back", async () => {
		const { core, open } = await repo();
		const view = await open("first");
		await view.reads({ log: LOG, reads: [readOfMain(1)], lost: true });
		await write(view, `${MAIN}.lock`, "3333\n", true);
		await refused(view.rename({ from: `${MAIN}.lock`, to: MAIN, noReplace: false }), "DENIED");
		await view.unlink(`${MAIN}.lock`, undefined);
		expect(core.gitLeases.has(MAIN)).toBe(false);
		await write(view, `${TOPIC}.lock`, "", true);
		await view.unlink(TOPIC, undefined);
		await view.unlink(TOPIC_LOG, undefined);
		await refused(view.unlink(`${TOPIC}.lock`, undefined), "DENIED");
		expect(core.gitPublishes).toEqual([]);
		expect(core.releases).toEqual([]);
		expect(core.entries.has(TOPIC)).toBe(true);
	});

	it("drops the leases of a git killed midway when its view publishes final, and never publishes a lock", async () => {
		const { core, open } = await repo();
		const view = await open("first");
		await write(view, `${MAIN}.lock`, "3333\n", true);
		await write(view, "code/acme/app/notes.txt", "kept\n");
		await view.publish();
		expect(core.entries.has("code/acme/app/notes.txt")).toBe(true);
		expect(core.entries.has(`${MAIN}.lock`)).toBe(false);
		expect(core.gitLeases.has(MAIN)).toBe(true);
		expect(await view.publish(true)).toMatchObject({ closed: true });
		expect(core.gitLeases.size).toBe(0);
		expect(core.entries.has(`${MAIN}.lock`)).toBe(false);
		const other = await open("second");
		await write(other, `${MAIN}.lock`, "4444\n", true);
		expect(core.gitLeases.get(MAIN)?.viewId).toBe(SESSIONS.second.viewId);
	});

	it("keeps the time a file showed while pending after its publish, until another version arrives", async () => {
		const { core, service, open } = await repo();
		const first = await open("first");
		const second = await open("second");
		const file = (view: ViewHandle) =>
			view.list("code/acme/app", undefined).then((l) => l.entries.find((e) => e.name === "a.txt"));
		await write(first, "code/acme/app/a.txt", "one\n");
		const pending = await file(first);
		await first.publish();
		const published = await file(first);
		expect(published?.version).toBe(core.entries.get("code/acme/app/a.txt")?.version);
		expect(published?.version).not.toBe(pending?.version);
		expect(published?.mtimeMs).toBe(pending?.mtimeMs);
		const updatedAt = Date.parse(core.entries.get("code/acme/app/a.txt")?.updatedAt ?? "");
		expect(updatedAt).not.toBe(pending?.mtimeMs);
		await service.poll();
		await service.settled();
		expect((await file(second))?.mtimeMs).toBe(updatedAt);
		await write(second, "code/acme/app/a.txt", "two\n");
		await second.publish();
		const live = core.entries.get("code/acme/app/a.txt");
		await service.poll();
		await service.settled();
		expect(await file(first)).toMatchObject({ version: live?.version, mtimeMs: Date.parse(live?.updatedAt ?? "") });
	});
});
