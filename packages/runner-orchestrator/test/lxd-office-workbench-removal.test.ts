import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { removeLxdOfficeWorkbench } from "../src/lxd-office-workbench-removal.ts";

// lstat answers as the file system does, except for paths a test marks as
// another account's or another file system's.
const changed = vi.hoisted(() => new Map<string, { uid?: number; dev?: number }>());
vi.mock("node:fs/promises", async (original) => {
	const actual = await original<typeof import("node:fs/promises")>();
	return {
		...actual,
		lstat: async (path: string) => {
			const stat = await actual.lstat(path);
			const override = changed.get(path);
			if (override?.uid !== undefined) stat.uid = override.uid;
			if (override?.dev !== undefined) stat.dev = override.dev;
			return stat;
		},
	};
});

const roots: string[] = [],
	uid = process.getuid!(),
	signal = () => new AbortController().signal;
const writable = async (path: string): Promise<void> => {
	if (!(await lstat(path)).isDirectory()) return;
	await chmod(path, 0o700);
	for (const name of await readdir(path)) await writable(join(path, name));
};
afterEach(async () => {
	changed.clear();
	for (const root of roots.splice(0)) {
		await writable(root);
		await rm(root, { recursive: true, force: true });
	}
});

/** A workbench with an adopted tree, a source left in place and an outside directory. */
async function workbench() {
	const base = await realpath(await mkdtemp(join(tmpdir(), "office-workbench-")));
	roots.push(base);
	const root = join(base, "mount"),
		outside = join(base, "outside"),
		adopted = join(root, ".qorpera-adopted-a0000000-0000-4000-8000-000000000001");
	await mkdir(join(adopted, "workbench", "project", "deep"), { recursive: true });
	await mkdir(join(adopted, "profiles", "p1"), { recursive: true });
	await mkdir(join(root, "legacy", "workbench"), { recursive: true });
	await mkdir(outside);
	await writeFile(join(outside, "keep.txt"), "not the company's");
	await writeFile(join(adopted, "workbench", "project", "deep", "notes.txt"), "draft");
	await writeFile(join(adopted, "profiles", "p1", "Cookies"), "cookie");
	await writeFile(join(root, "legacy", "workbench", "old.txt"), "old");
	await symlink(outside, join(adopted, "workbench", "link-out"));
	await chmod(join(adopted, "workbench", "project"), 0o500);
	await chmod(root, 0o700);
	return { root, outside, adopted };
}

describe("emptying a retired office's workbench", () => {
	it("removes everything under the mount, keeps the mount root, follows no link, and is idempotent", async () => {
		const w = await workbench();
		await expect(removeLxdOfficeWorkbench(w.root, uid, signal())).resolves.toEqual({ done: true, removed: 12 });
		expect(await readdir(w.root)).toEqual([]);
		expect((await lstat(w.root)).isDirectory()).toBe(true);
		expect(await readFile(join(w.outside, "keep.txt"), "utf8")).toBe("not the company's");
		await expect(removeLxdOfficeWorkbench(w.root, uid, signal())).resolves.toEqual({ done: true, removed: 0 });
	});
	it("stops when its pass is out of time and continues on the next pass", async () => {
		const w = await workbench();
		await expect(removeLxdOfficeWorkbench(w.root, uid, signal(), 0)).resolves.toEqual({ done: false, removed: 0 });
		expect((await readdir(w.root)).sort()).toEqual([
			".qorpera-adopted-a0000000-0000-4000-8000-000000000001",
			"legacy",
		]);
		await expect(removeLxdOfficeWorkbench(w.root, uid, signal())).resolves.toMatchObject({ done: true });
		expect(await readdir(w.root)).toEqual([]);
	});
	it("refuses a mount root of another account", async () => {
		const w = await workbench();
		await expect(removeLxdOfficeWorkbench(w.root, uid + 1, signal())).rejects.toThrow(
			"OFFICE_WORKBENCH_ROOT_DIFFERS",
		);
		expect(await readdir(w.root)).toHaveLength(2);
	});
	it.each([
		["another account's", { uid: uid + 1 }],
		["another file system's", { dev: 1 }],
	])("holds on %s entry and removes nothing beneath it", async (_, override) => {
		const w = await workbench();
		const deep = join(w.adopted, "workbench", "project");
		changed.set(deep, override);
		await expect(removeLxdOfficeWorkbench(w.root, uid, signal())).rejects.toThrow("OFFICE_WORKBENCH_FOREIGN_ENTRY");
		expect(await readdir(join(deep, "deep"))).toEqual(["notes.txt"]);
		expect((await lstat(deep)).mode & 0o777).toBe(0o500);
	});
	it("stops when the caller aborts", async () => {
		const w = await workbench();
		const controller = new AbortController();
		controller.abort(new Error("stopped"));
		await expect(removeLxdOfficeWorkbench(w.root, uid, controller.signal)).rejects.toThrow("stopped");
		expect(await readdir(w.root)).toHaveLength(2);
	});
});
