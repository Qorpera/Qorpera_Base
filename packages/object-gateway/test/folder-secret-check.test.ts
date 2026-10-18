import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	CodingFolderControl,
	codingFolderBoundaryChecking,
} from "../../runner-orchestrator/src/coding-folder-control.ts";
import { createControlServer } from "../src/folder-service/control.ts";
import { SaveChecks } from "../src/folder-service/git-objects.ts";
import { DESKTOP_QUIET_MS } from "../src/folder-service/mounts.ts";
import { NasObjects } from "../src/folder-service/objects.ts";
import {
	CHECK_RUNNING,
	NAME_CARRIES,
	TARGET_CARRIES,
	WAITS_FOR_CHECK,
	WAITS_FOR_REFUSED,
} from "../src/folder-service/plan.ts";
import type { BridgeInfo, Hello } from "../src/folder-service/protocol.ts";
import { CARRIES, type SecretSet, UNCHECKED } from "../src/folder-service/secret-scan.ts";
import { FolderService, type MachineBoundary, type ViewHandle } from "../src/folder-service/service.ts";
import { FolderStaging } from "../src/folder-service/staging.ts";
import {
	ALLOCATION,
	CODING,
	CODING_MACHINE_ID,
	codingGrants,
	ENV,
	FakeCore,
	FakeUploads,
	folder,
	hashOf,
	looseObject,
	noSecrets,
	OFFICE,
	SECRET_KEY,
	secretHashes,
	secretsOf,
	storeFile,
} from "./folder-service-fixtures.ts";

/** The folder service's save check (5j-5 (a), deploy/first-node/RUNTIME-FOLDER-CODING-MACHINES.md, "Masking"): what a
 * coding machine saves is checked against its member's secret values, as the keyed hashes its executor sends. A name,
 * a link's target or a file's bytes that carries one is refused and kept on the machine, and what needs a refused change
 * waits with it; until the machine's first values come, nothing of it is saved. No refusal, report or log line names a
 * value, and none names a change not checked yet. */
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const SESSION = "c0d1e5e5-0001-4a00-8b00-000000000001";
const PASS = "codepass_0123456789-abcdefghijklmnopqrstuvw";
const AT_CODING: BridgeInfo = { cid: 95, lookup: "found", machine: CODING };
/** A desktop of the company's office machine, whose views are not checked. */
const DESK = "4d5e6f70-8192-4a3b-8c4d-5e6f708192a3";
const DESK_PASS = "deskpass_0123456789-abcdefghijklmnopqrstuvw";
const AT_OFFICE: BridgeInfo = { cid: 90, lookup: "found", machine: OFFICE };
/** The member's secret value in these tests. None is a secret. */
const VALUE = "test-value-0001";
/** A value that spans a folder and the name of a file in it. */
const SPANNING = "abcdefgh/ijklmnop";
const SECRETS_WAIT = "waiting for the machine's secret check";

/** A company folder with two files, a coding session's view on a coding machine, a desktop's on the office machine,
 * and the node's service, whose log lines `logs` keeps. `secrets`: the coding machine's values its executor sent, or
 * none yet; `more`: further entries by path, each a file's text or `null` for a folder; `checks`: the node's checks of
 * git's storage; `checkWaitMs`: how long a boundary waits for its checks. */
async function company(
	secrets?: SecretSet,
	more: Record<string, string | null> = {},
	checks?: SaveChecks,
	checkWaitMs?: number,
) {
	const root = await mkdtemp(join(tmpdir(), "qorpera-folder-secrets-"));
	const core = new FakeCore();
	core.seed([
		folder("docs"),
		await storeFile(root, "docs/plan.md", "the plan", 1),
		await storeFile(root, "docs/notes.md", "the notes", 2),
	]);
	let version = 3;
	for (const [path, text] of Object.entries(more))
		core.seed([text === null ? folder(path, version++) : await storeFile(root, path, text, version++)]);
	core.openView(SESSION, PASS, { kind: "coding_session", codingMachineId: CODING_MACHINE_ID });
	core.openView(DESK, DESK_PASS, { kind: "computer_desktop", machineId: ALLOCATION });
	const objects = new NasObjects({ root, cacheBytes: 64 * 1024 * 1024 });
	const staging = new FolderStaging(core, new FakeUploads(root, core), objects, checks);
	// Each file the service staged or checked again.
	let staged = 0;
	const stageFile = staging.stageFile.bind(staging);
	staging.stageFile = (...args) => {
		staged++;
		return stageFile(...args);
	};
	const check = staging.check.bind(staging);
	staging.check = (...args) => {
		staged++;
		return check(...args);
	};
	const logs: string[] = [];
	const service = new FolderService({
		core,
		objects,
		grants: codingGrants(),
		staging,
		log: (line) => logs.push(line),
		...(checkWaitMs === undefined ? {} : { checkWaitMs }),
	});
	if (secrets) service.secrets(CODING_MACHINE_ID, secrets);
	const handles: ViewHandle[] = [];
	cleanups.push(async () => {
		for (const h of handles) h.release();
		service.stop();
		await rm(root, { recursive: true, force: true });
	});
	const open = async (desk = false) => {
		const hello: Hello = desk
			? { protocol: 4, environmentId: ENV, viewId: DESK, pass: DESK_PASS, role: "io" }
			: { protocol: 4, environmentId: ENV, viewId: SESSION, pass: PASS, role: "io" };
		const handle = await service.open(hello, desk ? AT_OFFICE : AT_CODING);
		handles.push(handle);
		return handle;
	};
	/** No log line holds the value, its hashes or the key, and no change set the core was sent holds the value or its
	 * whole's. */
	const nothingNamed = (value = VALUE) => {
		const { start, whole } = secretHashes(SECRET_KEY, value);
		for (const line of logs) {
			expect(line).not.toContain(value);
			expect(line).not.toContain(whole);
			expect(line).not.toContain(String(start));
			expect(line).not.toContain(SECRET_KEY.toString("base64url"));
		}
		expect(JSON.stringify(core.commits)).not.toContain(value);
		expect(JSON.stringify(core.commits)).not.toContain(whole);
	};
	return { core, service, open, logs, staged: () => staged, nothingNamed };
}

/** A small file, written as the folder program writes it: opened with truncate, its one chunk, closed. */
async function write(view: ViewHandle, path: string, text: string | Buffer): Promise<void> {
	const { handle } = await view.open({ path, create: true, exclusive: false, truncate: true });
	const data = typeof text === "string" ? Buffer.from(text) : text;
	await view.chunk({ handle, index: 0, sha256: hashOf(data), bytes: data.byteLength, offset: 0, data });
	await view.close(handle, data.byteLength);
}

/** A boundary's report of the session's view, its entries by path. */
function pathsOf(boundary: MachineBoundary) {
	const report = boundary.views.find((view) => view.viewId === SESSION)?.report;
	return [...(report?.paths ?? [])].sort((a, b) => (a.path < b.path ? -1 : 1));
}
const refusedIn = (boundary: MachineBoundary) => pathsOf(boundary).filter((entry) => entry.outcome === "refused");
/** The names the view shows in the folder `path`. */
async function namesIn(view: ViewHandle, path: string): Promise<string[]> {
	return (await view.list(path, undefined)).entries.map((entry) => entry.name).sort();
}

/** A file written where no folder of its path may be yet: the missing ones are made first, as git makes them. */
async function put(view: ViewHandle, path: string, data: Buffer): Promise<void> {
	const parts = path.split("/");
	for (let i = 1; i < parts.length - 1; i++)
		if (!(await namesIn(view, parts.slice(0, i).join("/"))).includes(parts[i]!))
			await view.mkdir(parts.slice(0, i + 1).join("/"));
	await write(view, path, data);
}

/** A pack of one blob holding `text`, as the node's git writes it, made in the scratch repository `dir`. */
function packHolding(dir: string, text: string): Buffer {
	const git = (args: string[], input: string) => {
		const run = spawnSync("/usr/bin/git", args, {
			cwd: dir,
			input,
			env: { PATH: "/usr/bin:/bin", HOME: dir, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
		});
		if (run.status !== 0) throw new Error(`git ${args[0]} failed: ${run.stderr.toString()}`);
		return run.stdout;
	};
	git(["init", "-q", "--bare", "."], "");
	const oid = git(["hash-object", "-w", "--stdin"], text).toString().trim();
	return git(["pack-objects", "--stdout", "-q"], `${oid}\n`);
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(done: () => boolean, ms = 3_000): Promise<void> {
	for (const end = Date.now() + ms; !done() && Date.now() < end; ) await wait(10);
	expect(done()).toBe(true);
}

describe("the save check of a coding machine", () => {
	it("saves nothing of the machine until its executor sent its secret values, and names no change meanwhile, but checks no office desktop", async () => {
		const { core, service, open, logs, nothingNamed } = await company();
		const view = await open();
		await write(view, "docs/a.txt", "a");
		await view.mkdir("docs/b");
		// The quiet period publishes nothing, and its log counts what waits rather than naming it.
		const counted = ": 2 changes wait for the machine's secret check";
		await until(() => logs.some((line) => line.endsWith(counted)), DESKTOP_QUIET_MS * 2);
		expect(logs.filter((line) => line.includes("docs"))).toEqual([]);
		const waits = [
			{ path: "docs/a.txt", outcome: "not_applied", reason: SECRETS_WAIT, kept: true },
			{ path: "docs/b", outcome: "not_applied", reason: SECRETS_WAIT, kept: true },
		];
		expect(pathsOf(await service.boundary(CODING_MACHINE_ID))).toEqual(waits);
		// Not even at the view's last boundary is anything of it let go.
		expect(pathsOf(await service.boundary(CODING_MACHINE_ID, [SESSION]))).toEqual(waits);
		expect(core.commits).toEqual([]);
		// Only a coding session's views are checked: the office's desktop saves even the value, with none sent.
		const desk = await open(true);
		await write(desk, "docs/desk.txt", `the key is ${VALUE}.`);
		await until(() => core.entries.has("docs/desk.txt"), DESKTOP_QUIET_MS * 2);
		expect(core.entries.has("docs/a.txt")).toBe(false);
		// The values come: what waited goes at the next quiet period.
		expect(service.secrets(CODING_MACHINE_ID, secretsOf(VALUE))).toBe(1);
		await until(() => core.entries.has("docs/a.txt") && core.entries.has("docs/b"), DESKTOP_QUIET_MS * 2);
		expect(core.entries.get("docs/a.txt")?.fileSha256).toBe(hashOf("a"));
		nothingNamed();
	});

	it("refuses a file whose bytes carry a value and keeps it on the machine, saving the rest, but lets it go at the view's last boundary", async () => {
		const { core, service, open, nothingNamed } = await company(secretsOf(VALUE));
		const view = await open();
		await write(view, "docs/a.txt", `the key is ${VALUE}.`);
		await write(view, "docs/fine.txt", "fine");
		const refusal = { path: "docs/a.txt", outcome: "refused", reason: CARRIES, kept: true };
		expect(refusedIn(await service.boundary(CODING_MACHINE_ID))).toEqual([refusal]);
		expect(core.entries.get("docs/fine.txt")?.fileSha256).toBe(hashOf("fine"));
		expect(core.entries.has("docs/a.txt")).toBe(false);
		// Asked again, it is refused again; written without the value, it is saved.
		expect(refusedIn(await service.boundary(CODING_MACHINE_ID))).toEqual([refusal]);
		await write(view, "docs/a.txt", "the key is gone.");
		expect(refusedIn(await service.boundary(CODING_MACHINE_ID))).toEqual([]);
		expect(core.entries.get("docs/a.txt")?.fileSha256).toBe(hashOf("the key is gone."));
		await write(view, "docs/c.txt", VALUE);
		expect(refusedIn(await service.boundary(CODING_MACHINE_ID, [SESSION]))).toEqual([
			{ path: "docs/c.txt", outcome: "refused", reason: CARRIES },
		]);
		expect(core.entries.has("docs/c.txt")).toBe(false);
		nothingNamed();
	});

	it("refuses a name that carries a value at the folder it is made in, and a link whose target does, and names neither", async () => {
		const { core, service, open, nothingNamed } = await company(secretsOf(VALUE));
		const view = await open();
		await view.mkdir(`docs/${VALUE}`);
		await write(view, `docs/${VALUE}/x.md`, "x");
		await write(view, `docs/${VALUE}.md`, "y");
		await view.symlink("docs/link", `${VALUE}.md`);
		await write(view, "docs/fine.md", "fine");
		expect(refusedIn(await service.boundary(CODING_MACHINE_ID))).toEqual([
			{ path: "docs", outcome: "refused", reason: NAME_CARRIES, kept: true },
			{ path: "docs/link", outcome: "refused", reason: TARGET_CARRIES, kept: true },
		]);
		expect(core.entries.get("docs/fine.md")?.fileSha256).toBe(hashOf("fine"));
		expect([...core.entries.keys()].filter((path) => path.includes(VALUE) || path === "docs/link")).toEqual([]);
		nothingNamed();
	});

	it("keeps a refused move's source where it is, and holds back a change into the path it would free", async () => {
		const { core, service, open, nothingNamed } = await company(secretsOf(VALUE));
		const view = await open();
		await view.rename({ from: "docs/plan.md", to: `docs/${VALUE}.md`, noReplace: false });
		await write(view, "docs/plan.md", "a new plan");
		expect(refusedIn(await service.boundary(CODING_MACHINE_ID))).toEqual([
			{ path: "docs", outcome: "refused", reason: NAME_CARRIES, kept: true },
			{ path: "docs/plan.md", outcome: "refused", reason: WAITS_FOR_REFUSED, kept: true },
		]);
		expect(core.entries.get("docs/plan.md")?.fileSha256).toBe(hashOf("the plan"));
		// Moved on to a name without the value, both go.
		await view.rename({ from: `docs/${VALUE}.md`, to: "docs/old-plan.md", noReplace: false });
		expect(refusedIn(await service.boundary(CODING_MACHINE_ID))).toEqual([]);
		expect(core.entries.get("docs/old-plan.md")?.fileSha256).toBe(hashOf("the plan"));
		expect(core.entries.get("docs/plan.md")?.fileSha256).toBe(hashOf("a new plan"));
		nothingNamed();
	});

	it("still shows a refused move only where it put it after the rest was saved, and moved back it changes nothing", async () => {
		const { core, service, open, nothingNamed } = await company(secretsOf(VALUE));
		const view = await open();
		await view.rename({ from: "docs/plan.md", to: `docs/${VALUE}.md`, noReplace: false });
		await write(view, "docs/fine.md", "fine");
		expect(refusedIn(await service.boundary(CODING_MACHINE_ID))).toEqual([
			{ path: "docs", outcome: "refused", reason: NAME_CARRIES, kept: true },
		]);
		expect(core.entries.get("docs/fine.md")?.fileSha256).toBe(hashOf("fine"));
		expect(await namesIn(view, "docs")).toEqual(["fine.md", "notes.md", `${VALUE}.md`]);
		// Moved back, the file is where it was: the next boundary has nothing to save, and removes nothing.
		const commits = core.commits.length;
		await view.rename({ from: `docs/${VALUE}.md`, to: "docs/plan.md", noReplace: false });
		expect(refusedIn(await service.boundary(CODING_MACHINE_ID))).toEqual([]);
		expect(core.commits.length).toBe(commits);
		expect(core.entries.get("docs/plan.md")?.fileSha256).toBe(hashOf("the plan"));
		expect(await namesIn(view, "docs")).toEqual(["fine.md", "notes.md", "plan.md"]);
		nothingNamed();
	});

	it("checks the names a folder's move gives what it holds, keeps the folder where it is if one carries a value, and moved back it changes nothing", async () => {
		const { core, service, open, nothingNamed } = await company(secretsOf(SPANNING), {
			"docs/old": null,
			"docs/old/ijklmnop": "x",
		});
		const view = await open();
		await view.rename({ from: "docs/old", to: "docs/abcdefgh", noReplace: false });
		await write(view, "docs/fine.md", "fine");
		expect(refusedIn(await service.boundary(CODING_MACHINE_ID))).toEqual([
			{ path: "docs/abcdefgh", outcome: "refused", reason: NAME_CARRIES, kept: true },
		]);
		expect(core.entries.get("docs/fine.md")?.fileSha256).toBe(hashOf("fine"));
		expect(core.entries.get("docs/old/ijklmnop")?.fileSha256).toBe(hashOf("x"));
		expect([...core.entries.keys()].filter((path) => path.startsWith("docs/abcdefgh"))).toEqual([]);
		expect(await namesIn(view, "docs")).toEqual(["abcdefgh", "fine.md", "notes.md", "plan.md"]);
		expect(await namesIn(view, "docs/abcdefgh")).toEqual(["ijklmnop"]);
		// Moved back, it is the live folder again, and nothing is saved.
		const commits = core.commits.length;
		await view.rename({ from: "docs/abcdefgh", to: "docs/old", noReplace: false });
		expect(refusedIn(await service.boundary(CODING_MACHINE_ID))).toEqual([]);
		expect(core.commits.length).toBe(commits);
		expect(await namesIn(view, "docs")).toEqual(["fine.md", "notes.md", "old", "plan.md"]);
		// Moved to a name that gives none, it goes with what it holds.
		await view.rename({ from: "docs/old", to: "docs/new", noReplace: false });
		expect(refusedIn(await service.boundary(CODING_MACHINE_ID))).toEqual([]);
		expect(core.entries.get("docs/new/ijklmnop")?.fileSha256).toBe(hashOf("x"));
		expect(core.entries.has("docs/old")).toBe(false);
		expect(core.entries.has("docs/old/ijklmnop")).toBe(false);
		nothingNamed(SPANNING);
	});

	it("checks a file staged under older values again for new ones, and the same values not again", async () => {
		const { core, service, open, staged, nothingNamed } = await company(secretsOf("other-value-0002"));
		const view = await open();
		// Staged at its close, under values it carries none of.
		await write(view, "docs/e.txt", `the key is ${VALUE}.`);
		expect(staged()).toBe(1);
		expect(service.secrets(CODING_MACHINE_ID, secretsOf("other-value-0002", VALUE))).toBe(2);
		const refusal = { path: "docs/e.txt", outcome: "refused", reason: CARRIES, kept: true };
		expect(refusedIn(await service.boundary(CODING_MACHINE_ID))).toEqual([refusal]);
		expect(staged()).toBe(2);
		// The same values again: what was checked against them is not checked again.
		expect(service.secrets(CODING_MACHINE_ID, secretsOf(VALUE, "other-value-0002"))).toBe(2);
		expect(refusedIn(await service.boundary(CODING_MACHINE_ID))).toEqual([refusal]);
		expect(staged()).toBe(2);
		expect(core.entries.has("docs/e.txt")).toBe(false);
		// Values without it: the file is staged again, and saved.
		expect(service.secrets(CODING_MACHINE_ID, secretsOf("other-value-0003"))).toBe(1);
		expect(refusedIn(await service.boundary(CODING_MACHINE_ID))).toEqual([]);
		expect(core.entries.get("docs/e.txt")?.fileSha256).toBe(hashOf(`the key is ${VALUE}.`));
		expect(staged()).toBe(3);
		nothingNamed();
	});
});

/** A copy of a repository's objects anywhere in the folder: they are checked by their names' shape, as git stores
 * them, not by where the repository is. */
const MIRROR = "docs/mirror";
const refused = (path: string, reason: string) => ({ path, outcome: "refused", reason, kept: true });
const byPath = (a: { path: string }, b: { path: string }) => (a.path < b.path ? -1 : 1);

describe("the save check of git's own storage (repo.git)", () => {
	it("refuses a loose object whose compressed content carries a value: a file's, a name in a tree, a commit message", async () => {
		const { core, service, open, nothingNamed } = await company(secretsOf(VALUE));
		const view = await open();
		const carrying = [
			looseObject("blob", `the key is ${VALUE}.\n`),
			looseObject("tree", Buffer.concat([Buffer.from(`100644 ${VALUE}.txt\0`), Buffer.alloc(20, 7)])),
			looseObject("commit", `tree ${"4b825dc6".repeat(5)}\nauthor A <a@example.com> 1 +0000\n\nadd ${VALUE}\n`),
		];
		const honest = looseObject("blob", "the key is gone.\n");
		for (const object of [...carrying, honest]) {
			expect(object.data.includes(VALUE)).toBe(false);
			await put(view, `${MIRROR}/${object.name}`, object.data);
		}
		expect(refusedIn(await service.boundary(CODING_MACHINE_ID))).toEqual(
			carrying.map((object) => refused(`${MIRROR}/${object.name}`, CARRIES)).sort(byPath),
		);
		expect(core.entries.get(`${MIRROR}/${honest.name}`)?.fileSha256).toBe(hashOf(honest.data));
		for (const object of carrying) expect(core.entries.has(`${MIRROR}/${object.name}`)).toBe(false);
		nothingNamed();
	});

	it("refuses as not checked what is not one whole object at an object's name, and saves it on a machine with no values", async () => {
		const blob = looseObject("blob", "fine\n").data;
		const broken = [
			Buffer.from("not an object at all"),
			Buffer.concat([blob, Buffer.from("x")]),
			blob.subarray(0, blob.length - 2),
		].map((data, i) => ({ path: `${MIRROR}/objects/0${i}/${"e".repeat(38)}`, data }));
		const { core, service, open } = await company(secretsOf(VALUE));
		const view = await open();
		for (const { path, data } of broken) await put(view, path, data);
		expect(refusedIn(await service.boundary(CODING_MACHINE_ID))).toEqual(
			broken.map(({ path }) => refused(path, UNCHECKED)),
		);
		for (const { path } of broken) expect(core.entries.has(path)).toBe(false);
		// With no values to look for, nothing is read: the same bytes are saved.
		const plain = await company(noSecrets());
		const other = await plain.open();
		for (const { path, data } of broken) await put(other, path, data);
		expect(refusedIn(await plain.service.boundary(CODING_MACHINE_ID))).toEqual([]);
		for (const { path, data } of broken) expect(plain.core.entries.get(path)?.fileSha256).toBe(hashOf(data));
	});

	it("checks an object git wrote under a temporary name as the object's name it moves or links it to", async () => {
		const { core, service, open, nothingNamed } = await company(secretsOf(VALUE));
		const view = await open();
		const moved = looseObject("blob", `moved: ${VALUE}\n`);
		const linked = looseObject("blob", `linked: ${VALUE}\n`);
		const honest = looseObject("blob", "honest\n");
		for (const [i, object] of [moved, linked, honest].entries()) {
			const temporary = `${MIRROR}/${object.name.slice(0, "objects/xx/".length)}tmp_obj_${i}`;
			await put(view, temporary, object.data);
			if (object === linked) {
				await view.link({ from: temporary, to: `${MIRROR}/${object.name}` });
				await view.unlink(temporary, undefined);
			} else await view.rename({ from: temporary, to: `${MIRROR}/${object.name}`, noReplace: true });
		}
		expect(refusedIn(await service.boundary(CODING_MACHINE_ID))).toEqual(
			[moved, linked].map((object) => refused(`${MIRROR}/${object.name}`, CARRIES)).sort(byPath),
		);
		expect(core.entries.get(`${MIRROR}/${honest.name}`)?.fileSha256).toBe(hashOf(honest.data));
		expect([...core.entries.keys()].filter((path) => path.includes("tmp_obj_"))).toEqual([]);
		nothingNamed();
	});

	it("checks an object saved under git's temporary name again as the object's name it is moved or linked to later", async () => {
		const { core, service, open, nothingNamed } = await company(secretsOf(VALUE));
		const view = await open();
		/** A loose object of `text` and git's temporary name `n` for it. */
		const objectOf = (text: string, n: number) => {
			const object = looseObject("blob", text);
			const temporary = `${MIRROR}/${object.name.slice(0, "objects/xx/".length)}tmp_obj_${n}`;
			return { ...object, temporary, final: `${MIRROR}/${object.name}` };
		};
		const moved = objectOf(`moved: ${VALUE}\n`, 0);
		const linked = objectOf(`linked: ${VALUE}\n`, 1);
		const honest = objectOf("honest\n", 2);
		for (const object of [moved, linked, honest]) {
			expect(object.data.includes(VALUE)).toBe(false);
			await put(view, object.temporary, object.data);
		}
		// Under a temporary name the bytes are saved as they are, which hold no value as they are.
		expect(refusedIn(await service.boundary(CODING_MACHINE_ID))).toEqual([]);
		for (const object of [moved, linked, honest])
			expect(core.entries.get(object.temporary)?.fileSha256).toBe(hashOf(object.data));
		await view.rename({ from: moved.temporary, to: moved.final, noReplace: true });
		await view.link({ from: linked.temporary, to: linked.final });
		await view.rename({ from: honest.temporary, to: honest.final, noReplace: true });
		expect(refusedIn(await service.boundary(CODING_MACHINE_ID))).toEqual(
			[moved, linked].map((object) => refused(object.final, CARRIES)).sort(byPath),
		);
		// What is refused stays on the machine: the folder keeps the temporary names it had, and no object's name.
		for (const object of [moved, linked]) {
			expect(core.entries.has(object.final)).toBe(false);
			expect(core.entries.get(object.temporary)?.fileSha256).toBe(hashOf(object.data));
		}
		expect(core.entries.get(honest.final)?.fileSha256).toBe(hashOf(honest.data));
		expect(core.entries.has(honest.temporary)).toBe(false);
		nothingNamed();
	});

	it("refuses a pack holding a value as git reads it, moved from git's temporary name, and saves an honest pack", async () => {
		const scratch = await mkdtemp(join(tmpdir(), "qorpera-folder-packs-"));
		cleanups.push(() => rm(scratch, { recursive: true, force: true }));
		const carrying = packHolding(scratch, `the key is ${VALUE}.\n`);
		const honest = packHolding(scratch, "the key is gone.\n");
		expect(carrying.includes(VALUE)).toBe(false);
		const { core, service, open, nothingNamed } = await company(secretsOf(VALUE));
		const view = await open();
		const packs = `${MIRROR}/objects/pack`;
		await put(view, `${packs}/tmp_pack_a1`, carrying);
		await view.rename({ from: `${packs}/tmp_pack_a1`, to: `${packs}/pack-${"1".repeat(40)}.pack`, noReplace: true });
		await put(view, `${packs}/pack-${"2".repeat(40)}.pack`, honest);
		expect(refusedIn(await service.boundary(CODING_MACHINE_ID))).toEqual([
			refused(`${packs}/pack-${"1".repeat(40)}.pack`, CARRIES),
		]);
		expect(core.entries.get(`${packs}/pack-${"2".repeat(40)}.pack`)?.fileSha256).toBe(hashOf(honest));
		expect(core.entries.has(`${packs}/tmp_pack_a1`)).toBe(false);
		nothingNamed();
	});

	it("refuses a pack saved under git's temporary name once it is moved to a pack's name, at a later boundary", async () => {
		const scratch = await mkdtemp(join(tmpdir(), "qorpera-folder-packs-"));
		cleanups.push(() => rm(scratch, { recursive: true, force: true }));
		const carrying = packHolding(scratch, `the key is ${VALUE}.\n`);
		const { core, service, open, nothingNamed } = await company(secretsOf(VALUE));
		const view = await open();
		const temporary = `${MIRROR}/objects/pack/tmp_pack_a1`;
		const pack = `${MIRROR}/objects/pack/pack-${"1".repeat(40)}.pack`;
		await put(view, temporary, carrying);
		expect(refusedIn(await service.boundary(CODING_MACHINE_ID))).toEqual([]);
		expect(core.entries.get(temporary)?.fileSha256).toBe(hashOf(carrying));
		await view.rename({ from: temporary, to: pack, noReplace: true });
		expect(refusedIn(await service.boundary(CODING_MACHINE_ID))).toEqual([refused(pack, CARRIES)]);
		expect(core.entries.has(pack)).toBe(false);
		expect(core.entries.get(temporary)?.fileSha256).toBe(hashOf(carrying));
		nothingNamed();
	});

	it("refuses as not checked a pack past the node's waiting bound, and checks it again at the next boundary (d)", async () => {
		const scratch = await mkdtemp(join(tmpdir(), "qorpera-folder-packs-"));
		cleanups.push(() => rm(scratch, { recursive: true, force: true }));
		const carrying = packHolding(scratch, `the key is ${VALUE}.\n`);
		const honest = packHolding(scratch, "the key is gone.\n");
		// Other checks on the node hold its one turn and its one place to wait.
		const checks = new SaveChecks({ atOnce: 1, waitingMax: 1 });
		const others = [0, 1].map(() => checks.start(secretsOf(VALUE), honest.length, "pack"));
		const started = others.map((check) => check.push(honest.subarray(0, 20)));
		await started[0];
		const { core, service, open, staged, nothingNamed } = await company(secretsOf(VALUE), {}, checks);
		const view = await open();
		const [a, b] = [
			`${MIRROR}/objects/pack/pack-${"1".repeat(40)}.pack`,
			`${MIRROR}/objects/pack/pack-${"2".repeat(40)}.pack`,
		];
		await put(view, a, carrying);
		await put(view, b, honest);
		for (let i = 0; i < 2; i++) {
			const before = staged();
			expect(refusedIn(await service.boundary(CODING_MACHINE_ID))).toEqual([
				refused(a, UNCHECKED),
				refused(b, UNCHECKED),
			]);
			expect(staged()).toBe(before + 2);
			expect(core.entries.has(a) || core.entries.has(b)).toBe(false);
		}
		// Once the others are done, the next boundary checks both: the honest pack is saved, the other refused for its
		// value, which no later boundary checks again.
		for (const [n, check] of others.entries()) {
			await started[n];
			await check.push(honest.subarray(20));
			await check.end();
		}
		expect(refusedIn(await service.boundary(CODING_MACHINE_ID))).toEqual([refused(a, CARRIES)]);
		expect(core.entries.get(b)?.fileSha256).toBe(hashOf(honest));
		const after = staged();
		expect(refusedIn(await service.boundary(CODING_MACHINE_ID))).toEqual([refused(a, CARRIES)]);
		expect(staged()).toBe(after);
		expect(core.entries.has(a)).toBe(false);
		nothingNamed();
	});

	it("answers in time while a pack's check runs, has the pack wait for it, and saves or refuses it once it ends", async () => {
		const scratch = await mkdtemp(join(tmpdir(), "qorpera-folder-packs-"));
		cleanups.push(() => rm(scratch, { recursive: true, force: true }));
		const carrying = packHolding(scratch, `the key is ${VALUE}.\n`);
		const honest = packHolding(scratch, "the key is gone.\n");
		// Another check on the node holds its one turn: the packs' checks run once it ends, past the boundary's wait.
		const checks = new SaveChecks({ atOnce: 1 });
		const other = checks.start(secretsOf(VALUE), honest.length, "pack");
		const started = other.push(honest.subarray(0, 20));
		const { core, service, open, staged, nothingNamed } = await company(secretsOf(VALUE), {}, checks, 100);
		const view = await open();
		const [a, b] = [
			`${MIRROR}/objects/pack/pack-${"1".repeat(40)}.pack`,
			`${MIRROR}/objects/pack/pack-${"2".repeat(40)}.pack`,
		];
		// Each close waits for its pack's check a while, as a boundary does, and leaves it running.
		const before = staged();
		await put(view, a, carrying);
		await put(view, b, honest);
		for (let i = 0; i < 2; i++) {
			const answer = await service.boundary(CODING_MACHINE_ID);
			// Neither is refused, nor saved: each waits for its check, which a later boundary joins, not starts again.
			for (const path of [a, b])
				expect(pathsOf(answer)).toContainEqual({ path, outcome: "waiting", reason: CHECK_RUNNING, kept: true });
			expect(refusedIn(answer)).toEqual([]);
			expect(staged()).toBe(before + 2);
			expect(core.entries.has(a) || core.entries.has(b)).toBe(false);
		}
		await started;
		await other.push(honest.subarray(20));
		await other.end();
		// Once it ends, theirs run: a later boundary saves the honest pack and refuses the other, starting neither again.
		const checking = (answer: MachineBoundary) => pathsOf(answer).some((entry) => entry.reason === CHECK_RUNNING);
		let boundary = await service.boundary(CODING_MACHINE_ID);
		for (let i = 0; i < 50 && checking(boundary); i++) boundary = await service.boundary(CODING_MACHINE_ID);
		expect(refusedIn(boundary)).toEqual([refused(a, CARRIES)]);
		expect(core.entries.get(b)?.fileSha256).toBe(hashOf(honest));
		expect(core.entries.has(a)).toBe(false);
		expect(staged()).toBe(before + 2);
		nothingNamed();
	});

	it("saves nothing else of a code area's git directory while a pack's check there runs, nor once it refuses the pack", async () => {
		const scratch = await mkdtemp(join(tmpdir(), "qorpera-folder-packs-"));
		cleanups.push(() => rm(scratch, { recursive: true, force: true }));
		const carrying = packHolding(scratch, `the key is ${VALUE}.\n`);
		const honest = packHolding(scratch, "the key is gone.\n");
		// Another check on the node holds its one turn: the pack's check runs once it ends, past the boundary's wait.
		const checks = new SaveChecks({ atOnce: 1 });
		const other = checks.start(secretsOf(VALUE), honest.length, "pack");
		const started = other.push(honest.subarray(0, 20));
		const repo = "code/acme/app/repo.git";
		const own = `${repo}/worktrees/w1`;
		const { core, service, open, nothingNamed } = await company(
			secretsOf(VALUE),
			{
				code: null,
				"code/acme": null,
				"code/acme/app": null,
				[repo]: null,
				[`${repo}/objects`]: null,
				[`${repo}/worktrees`]: null,
				[own]: null,
				[`${own}/MERGE_HEAD`]: `${"3".repeat(40)}\n`,
			},
			checks,
			100,
		);
		const view = await open();
		// A fetch's pack holding the value, its index, a commit's honest object, and the worktree's index and finished
		// merge: all of it one git change, and a file outside it.
		const pack = `${repo}/objects/pack/pack-${"1".repeat(40)}.pack`;
		const index = `${repo}/objects/pack/pack-${"1".repeat(40)}.idx`;
		const object = looseObject("blob", "the key is gone.\n");
		await put(view, pack, carrying);
		await put(view, index, Buffer.from("the pack's index"));
		await put(view, `${repo}/${object.name}`, object.data);
		await write(view, `${own}/index`, "the worktree's index");
		await view.unlink(`${own}/MERGE_HEAD`, undefined);
		await write(view, "docs/fine.txt", "fine");
		const rest = [
			`${repo}/objects/pack`,
			index,
			`${repo}/${object.name.slice(0, "objects/xx".length)}`,
			`${repo}/${object.name}`,
			`${own}/index`,
			`${own}/MERGE_HEAD`,
		];
		const inGit = (answer: MachineBoundary) => pathsOf(answer).filter((entry) => entry.path.startsWith(`${repo}/`));
		/** Nothing of the git change is in the folder, and the worktree's merge is not finished there. */
		const noneSaved = async () => {
			for (const path of [pack, ...rest]) expect(core.entries.has(path)).toBe(path === `${own}/MERGE_HEAD`);
			// The view still shows the merge finished: its removal stays the view's, for a later boundary.
			expect(await namesIn(view, own)).toEqual(["index"]);
		};
		// While the pack's check runs, the rest waits for it, as the check may yet refuse it; the file outside is saved.
		for (let i = 0; i < 2; i++) {
			const answer = await service.boundary(CODING_MACHINE_ID);
			expect(inGit(answer)).toEqual(
				[
					{ path: pack, outcome: "waiting", reason: CHECK_RUNNING, kept: true },
					...rest.map((path) => ({ path, outcome: "waiting", reason: WAITS_FOR_CHECK, kept: true })),
				].sort(byPath),
			);
			expect(refusedIn(answer)).toEqual([]);
			expect(core.entries.get("docs/fine.txt")?.fileSha256).toBe(hashOf("fine"));
			await noneSaved();
		}
		await started;
		await other.push(honest.subarray(20));
		await other.end();
		// Once it ends, the pack is refused for its value, and the rest waits for it, refused too.
		const checking = (answer: MachineBoundary) => pathsOf(answer).some((entry) => entry.reason === CHECK_RUNNING);
		let boundary = await service.boundary(CODING_MACHINE_ID);
		for (let i = 0; i < 50 && checking(boundary); i++) boundary = await service.boundary(CODING_MACHINE_ID);
		expect(refusedIn(boundary)).toEqual(
			[refused(pack, CARRIES), ...rest.map((path) => refused(path, WAITS_FOR_REFUSED))].sort(byPath),
		);
		await noneSaved();
		// The way out removes the pack: the rest is saved, the merge's end with it.
		await view.unlink(pack, undefined);
		expect(refusedIn(await service.boundary(CODING_MACHINE_ID))).toEqual([]);
		expect(core.entries.has(pack)).toBe(false);
		expect(core.entries.has(`${own}/MERGE_HEAD`)).toBe(false);
		expect(core.entries.get(index)?.fileSha256).toBe(hashOf("the pack's index"));
		expect(core.entries.get(`${repo}/${object.name}`)?.fileSha256).toBe(hashOf(object.data));
		expect(core.entries.get(`${own}/index`)?.fileSha256).toBe(hashOf("the worktree's index"));
		nothingNamed();
	});

	it("answers the coding executor's control client in its time while a pack's check runs, asked at once or not, which a later boundary saves", async () => {
		const scratch = await mkdtemp(join(tmpdir(), "qorpera-folder-packs-"));
		cleanups.push(() => rm(scratch, { recursive: true, force: true }));
		const honest = packHolding(scratch, "the key is gone.\n");
		// Another check on the node holds its one turn until the test lets it end: the pack's check runs past the
		// client's timeout.
		const checks = new SaveChecks({ atOnce: 1 });
		const other = checks.start(secretsOf(VALUE), honest.length, "pack");
		const started = other.push(honest.subarray(0, 20));
		const { core, service, open } = await company(secretsOf(VALUE), {}, checks, 1_000);
		// The control socket as its unit makes it, the executor's alone (under /tmp, root's and sticky), and the
		// executor's own client, with a timeout twice the boundary's wait, as by default (20 s and 10 s).
		const dir = await realpath(await mkdtemp("/tmp/qfs-"));
		cleanups.push(() => rm(dir, { recursive: true, force: true }));
		const path = join(dir, "control.sock");
		const executorUid = process.getuid?.();
		const server = createControlServer({ target: service, path, executorUid, log: () => undefined });
		await new Promise<void>((resolve) => server.listen(path, resolve));
		cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
		await chmod(path, 0o600);
		const control = new CodingFolderControl({ path, timeoutMs: 2_000 });
		const signal = new AbortController().signal;
		const view = await open();
		const pack = `${MIRROR}/objects/pack/pack-${"2".repeat(40)}.pack`;
		await put(view, pack, honest);
		for (let i = 0; i < 2; i++) {
			// Three asked at once: each waits for the view's turn, and still answers in the client's time, as its wait
			// for the check counts from when it was asked.
			const answers = await Promise.all([0, 1, 2].map(() => control.boundary(CODING_MACHINE_ID, [], signal)));
			for (const answer of answers) {
				expect(answer.reads).toBe("released");
				expect(answer.views).toContainEqual(expect.objectContaining({ viewId: SESSION, checking: 1 }));
				expect(codingFolderBoundaryChecking(answer)).toBe(true);
			}
			expect(core.entries.has(pack)).toBe(false);
		}
		await started;
		await other.push(honest.subarray(20));
		await other.end();
		// Asked again, as the executor asks while a check runs: once it has ended, the pack is saved.
		let answer = await control.boundary(CODING_MACHINE_ID, [], signal);
		for (let i = 0; i < 50 && codingFolderBoundaryChecking(answer); i++)
			answer = await control.boundary(CODING_MACHINE_ID, [], signal);
		expect(codingFolderBoundaryChecking(answer)).toBe(false);
		expect(core.entries.get(pack)?.fileSha256).toBe(hashOf(honest));
	});

	it("answers the coding executor's control client in its time while a ref's update waits for a pack closed during its own pack's check, and publishes both with the ref once they end", async () => {
		const scratch = await mkdtemp(join(tmpdir(), "qorpera-folder-packs-"));
		cleanups.push(() => rm(scratch, { recursive: true, force: true }));
		const honest = packHolding(scratch, "the key is gone.\n");
		const later = packHolding(scratch, "the key is still gone.\n");
		// Checks on the node that hold its one turn until the test lets each end, each started ahead of a pack's.
		const checks = new SaveChecks({ atOnce: 1 });
		const holding = () => {
			const check = checks.start(secretsOf(VALUE), honest.length, "pack");
			return { check, started: check.push(honest.subarray(0, 20)) };
		};
		const first = holding();
		const repo = "code/acme/app/repo.git";
		const main = `${repo}/refs/heads/main`;
		const { core, service, open } = await company(
			secretsOf(VALUE),
			{
				code: null,
				"code/acme": null,
				"code/acme/app": null,
				[repo]: null,
				[`${repo}/objects`]: null,
				[`${repo}/refs`]: null,
				[`${repo}/refs/heads`]: null,
				[main]: "1111\n",
			},
			checks,
			1_000,
		);
		// The executor's control socket and client, as in the test before.
		const dir = await realpath(await mkdtemp("/tmp/qfs-"));
		cleanups.push(() => rm(dir, { recursive: true, force: true }));
		const path = join(dir, "control.sock");
		const server = createControlServer({
			target: service,
			path,
			executorUid: process.getuid?.(),
			log: () => undefined,
		});
		await new Promise<void>((resolve) => server.listen(path, resolve));
		cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
		await chmod(path, 0o600);
		const control = new CodingFolderControl({ path, timeoutMs: 2_000 });
		const signal = new AbortController().signal;
		const view = await open();
		const [a, b] = [
			`${repo}/objects/pack/pack-${"1".repeat(40)}.pack`,
			`${repo}/objects/pack/pack-${"2".repeat(40)}.pack`,
		];
		// A fetch writes its pack, takes the branch's lock and renames it onto the branch: the update waits for the pack's
		// check, before its turn.
		await put(view, a, honest);
		const { handle } = await view.open({ path: `${main}.lock`, create: true, exclusive: true, truncate: true });
		const ref = Buffer.from("3333\n");
		await view.chunk({ handle, index: 0, sha256: hashOf(ref), bytes: ref.byteLength, offset: 0, data: ref });
		await view.close(handle, ref.byteLength);
		const updated = view.rename({ from: `${main}.lock`, to: main, noReplace: false });
		// Meanwhile another git command writes a pack, whose check waits behind another check on the node.
		const second = holding();
		await put(view, b, later);
		// The first ends: the fetch's pack is checked, and its update's turn comes while the other pack's check waits.
		await first.started;
		await first.check.push(honest.subarray(20));
		await first.check.end();
		await second.started;
		for (let i = 0; i < 2; i++) {
			// Three asked at once, twice: none waits in the queue for the other pack's check, which the update waits for
			// out of it.
			const answers = await Promise.all([0, 1, 2].map(() => control.boundary(CODING_MACHINE_ID, [], signal)));
			for (const answer of answers) expect(codingFolderBoundaryChecking(answer)).toBe(true);
			expect(core.gitPublishes).toEqual([]);
			expect(core.entries.get(main)?.fileSha256).toBe(hashOf("1111\n"));
		}
		// Once that check ends, the update publishes the branch, with both packs.
		await second.check.push(honest.subarray(20));
		await second.check.end();
		await updated;
		expect(core.gitPublishes).toMatchObject([{ published: true }]);
		expect(core.entries.get(main)?.fileSha256).toBe(hashOf("3333\n"));
		expect(core.entries.get(a)?.fileSha256).toBe(hashOf(honest));
		expect(core.entries.get(b)?.fileSha256).toBe(hashOf(later));
	});
});
