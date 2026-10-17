import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DESKTOP_QUIET_MS } from "../src/folder-service/mounts.ts";
import { NasObjects } from "../src/folder-service/objects.ts";
import { NAME_CARRIES, TARGET_CARRIES, WAITS_FOR_REFUSED } from "../src/folder-service/plan.ts";
import type { BridgeInfo, Hello } from "../src/folder-service/protocol.ts";
import { CARRIES, type SecretSet } from "../src/folder-service/secret-scan.ts";
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
const SECRETS_WAIT = "waiting for the machine's secret check";

/** A company folder with two files, a coding session's view on a coding machine, a desktop's on the office machine,
 * and the node's service, whose log lines `logs` keeps. `secrets`: the coding machine's values its executor sent, or
 * none yet. */
async function company(secrets?: SecretSet) {
	const root = await mkdtemp(join(tmpdir(), "qorpera-folder-secrets-"));
	const core = new FakeCore();
	core.seed([
		folder("docs"),
		await storeFile(root, "docs/plan.md", "the plan", 1),
		await storeFile(root, "docs/notes.md", "the notes", 2),
	]);
	core.openView(SESSION, PASS, { kind: "coding_session", codingMachineId: CODING_MACHINE_ID });
	core.openView(DESK, DESK_PASS, { kind: "computer_desktop", machineId: ALLOCATION });
	const objects = new NasObjects({ root, cacheBytes: 64 * 1024 * 1024 });
	const staging = new FolderStaging(core, new FakeUploads(root, core), objects);
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
	const nothingNamed = () => {
		const { start, whole } = secretHashes(SECRET_KEY, VALUE);
		for (const line of logs) {
			expect(line).not.toContain(VALUE);
			expect(line).not.toContain(whole);
			expect(line).not.toContain(String(start));
			expect(line).not.toContain(SECRET_KEY.toString("base64url"));
		}
		expect(JSON.stringify(core.commits)).not.toContain(VALUE);
		expect(JSON.stringify(core.commits)).not.toContain(whole);
	};
	return { core, service, open, logs, staged: () => staged, nothingNamed };
}

/** A small file, written as the folder program writes it: opened with truncate, its one chunk, closed. */
async function write(view: ViewHandle, path: string, text: string): Promise<void> {
	const { handle } = await view.open({ path, create: true, exclusive: false, truncate: true });
	const data = Buffer.from(text);
	await view.chunk({ handle, index: 0, sha256: hashOf(data), bytes: data.byteLength, offset: 0, data });
	await view.close(handle, data.byteLength);
}

/** A boundary's report of the session's view, its entries by path. */
function pathsOf(boundary: MachineBoundary) {
	const report = boundary.views.find((view) => view.viewId === SESSION)?.report;
	return [...(report?.paths ?? [])].sort((a, b) => (a.path < b.path ? -1 : 1));
}
const refusedIn = (boundary: MachineBoundary) => pathsOf(boundary).filter((entry) => entry.outcome === "refused");

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
