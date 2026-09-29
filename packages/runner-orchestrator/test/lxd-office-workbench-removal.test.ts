import { constants } from "node:fs";
import {
	chmod,
	lstat,
	mkdir,
	mkdtemp,
	open,
	readdir,
	readFile,
	realpath,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { publish } from "../src/lxd-office-journal-files.ts";
import {
	assertLxdOfficeWorkbenchExclusive,
	lxdOfficeWorkbenchNames,
	removeLxdOfficeWorkbench,
} from "../src/lxd-office-workbench-removal.ts";

// lstat answers as the file system does, except for entries a test marks as another account's or
// another file system's (by their last path segment).
const changed = vi.hoisted(() => new Map<string, { uid?: number; dev?: number }>());
vi.mock("node:fs/promises", async (original) => {
	const actual = await original<typeof import("node:fs/promises")>();
	return {
		...actual,
		lstat: async (path: string) => {
			const stat = await actual.lstat(path);
			const override = changed.get(String(path).split("/").pop()!);
			if (override?.uid !== undefined) stat.uid = override.uid;
			if (override?.dev !== undefined) stat.dev = override.dev;
			return stat;
		},
	};
});

const roots: string[] = [],
	signal = () => new AbortController().signal;
const writable = async (path: string): Promise<void> => {
	if (!(await lstat(path)).isDirectory()) return;
	await chmod(path, 0o700);
	for (const name of await readdir(path)) await writable(join(path, name));
};
afterEach(async () => {
	changed.clear();
	for (const root of roots.splice(0)) {
		await writable(root).catch(() => {});
		await rm(root, { recursive: true, force: true });
	}
});
async function temporary(prefix: string): Promise<string> {
	const root = await realpath(await mkdtemp(join(tmpdir(), prefix)));
	roots.push(root);
	return root;
}

const OURS = "a0000000-0000-4000-8000-000000000001";
const THEIRS = "b0000000-0000-4000-8000-000000000002";

describe("what this office's workbench holds", () => {
	it("names its adoptions' trees and the top-level names its inventories saw, never another office's tree", async () => {
		const journal = await temporary("office-journal-");
		const record = (name: string, value: unknown) => publish(journal, name, Buffer.from(JSON.stringify(value)));
		await record(`adoption-${OURS}.json`, {});
		await record(`adoption-result-${OURS}.json`, {});
		await record(`inventory-${"1".repeat(64)}.json`, {
			inventory: {
				root: "/mnt/office-workbench",
				entries: [
					{ path: "." },
					{ path: "legacy" },
					{ path: "legacy/workbench" },
					{ path: "notes.txt" },
					{ path: `.qorpera-adopted-${THEIRS}` },
					{ path: `.qorpera-adopted-${THEIRS}/desktop` },
				],
			},
		});
		// Another root's inventory and unrelated records name nothing.
		await record(`inventory-${"2".repeat(64)}.json`, { inventory: { root: "/mnt/other", entries: [{ path: "x" }] } });
		await record("office-retirement-request.json", {});
		expect([...(await lxdOfficeWorkbenchNames(journal, "/mnt/office-workbench"))].sort()).toEqual([
			`.qorpera-adopted-${OURS}`,
			`.qorpera-adoption-staging-${OURS}`,
			"legacy",
			"notes.txt",
		]);
		await record(`inventory-${"3".repeat(64)}.json`, { inventory: { root: "/mnt/office-workbench", entries: 7 } });
		await expect(lxdOfficeWorkbenchNames(journal, "/mnt/office-workbench")).rejects.toThrow(
			"OFFICE_WORKBENCH_INVENTORY_INVALID",
		);
	});
});

describe("the workbench is this office's alone", () => {
	const scope = { root: "/mnt/office-workbench", source: "192.0.2.1:/offices/a1", serverAddress: "192.0.2.1" };
	const own =
		"41 29 0:52 / /mnt/office-workbench rw,nosuid,nodev,relatime shared:1 - nfs4 192.0.2.1:/offices/a1 rw,vers=4.2,addr=192.0.2.1";
	const disk = (source: string) => ({
		expandedDevices: { root: { type: "disk", path: "/", pool: "default" }, work: { type: "disk", source } },
	});
	it("allows its own mount and unrelated disks and mounts", () => {
		expect(() =>
			assertLxdOfficeWorkbenchExclusive(
				scope,
				[disk("/srv/elsewhere"), disk("/mnt/office-workbench-2")],
				[
					own,
					"42 29 0:53 / /mnt/b rw - nfs4 192.0.2.1:/offices/b1 rw,addr=192.0.2.1",
					"43 29 0:54 / /mnt/c rw - nfs4 192.0.2.9:/offices/a1 rw,addr=192.0.2.9",
					"44 29 8:1 / /srv rw - ext4 /dev/sda1 rw",
				].join("\n"),
			),
		).not.toThrow();
	});
	it.each([
		["another instance's disk on it", [disk("/mnt/office-workbench")], own],
		["another instance's disk under it", [disk("/mnt/office-workbench/.qorpera-adopted-x/workbench")], own],
		["another instance's disk above it", [disk("/mnt")], own],
		[
			"another mount of the same export",
			[],
			`${own}\n45 29 0:55 / /mnt/b rw - nfs4 192.0.2.1:/offices/a1 rw,addr=192.0.2.1`,
		],
		[
			"a mount of an enclosing export",
			[],
			`${own}\n45 29 0:55 / /mnt/b rw - nfs 192.0.2.1:/offices rw,addr=192.0.2.1`,
		],
		[
			"a mount of an enclosed export",
			[],
			`${own}\n45 29 0:55 / /mnt/b rw - nfs4 192.0.2.1:/offices/a1/sub rw,addr=192.0.2.1`,
		],
		[
			"the same server under another name",
			[],
			`${own}\n45 29 0:55 / /mnt/b rw - nfs4 nas.local:/offices/a1 rw,addr=192.0.2.1`,
		],
	])("refuses %s", (_, instances, mountInfo) => {
		expect(() => assertLxdOfficeWorkbenchExclusive(scope, instances, mountInfo)).toThrow("OFFICE_WORKBENCH_SHARED");
	});
});

/** A directory chain made through descriptors, so a path longer than PATH_MAX can be built. */
async function deep(root: string, levels: number): Promise<void> {
	let parent = await open(root, constants.O_RDONLY | constants.O_DIRECTORY);
	for (let level = 0; level < levels; level += 1) {
		const name = `d${level}`.padEnd(200, "x");
		await mkdir(`/proc/self/fd/${parent.fd}/${name}`);
		const child = await open(`/proc/self/fd/${parent.fd}/${name}`, constants.O_RDONLY | constants.O_DIRECTORY);
		await parent.close();
		parent = child;
	}
	await writeFile(`/proc/self/fd/${parent.fd}/leaf.txt`, "deep");
	await parent.close();
}

describe.skipIf(process.platform !== "linux")("emptying a retired office's workbench (Linux)", () => {
	const uid = process.getuid?.() ?? -1;
	const names = new Set([`.qorpera-adopted-${OURS}`, `.qorpera-adoption-staging-${OURS}`, "legacy"]);
	async function workbench() {
		const base = await temporary("office-workbench-");
		const root = join(base, "mount"),
			outside = join(base, "outside"),
			adopted = join(root, `.qorpera-adopted-${OURS}`);
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
		await chmod(join(adopted, "profiles"), 0o2500);
		await chmod(root, 0o700);
		return { root, outside, adopted, scope: { root, source: "", serverAddress: "", uid, journalRoot: "" } };
	}
	it("removes everything it accounts for, keeps the mount root, follows no link, and is idempotent", async () => {
		const w = await workbench();
		// 30 levels of 200-character names: a path longer than PATH_MAX.
		await deep(join(w.root, "legacy"), 30);
		await expect(removeLxdOfficeWorkbench(w.scope, names, signal(), 30000)).resolves.toEqual({
			done: true,
			removed: 43,
		});
		expect(await readdir(w.root)).toEqual([]);
		expect((await lstat(w.root)).isDirectory()).toBe(true);
		expect(await readFile(join(w.outside, "keep.txt"), "utf8")).toBe("not the company's");
		await expect(removeLxdOfficeWorkbench(w.scope, names, signal(), 30000)).resolves.toEqual({
			done: true,
			removed: 0,
		});
	});
	it("stops when its pass is out of time and continues on the next pass", async () => {
		const w = await workbench();
		await expect(removeLxdOfficeWorkbench(w.scope, names, signal(), 0)).resolves.toEqual({ done: false, removed: 0 });
		expect((await readdir(w.root)).sort()).toEqual([`.qorpera-adopted-${OURS}`, "legacy"]);
		await expect(removeLxdOfficeWorkbench(w.scope, names, signal(), 30000)).resolves.toMatchObject({ done: true });
		expect(await readdir(w.root)).toEqual([]);
	});
	it("holds on a top-level entry this office does not account for, before removing anything", async () => {
		const w = await workbench();
		await mkdir(join(w.root, `.qorpera-adopted-${THEIRS}`));
		await expect(removeLxdOfficeWorkbench(w.scope, names, signal(), 30000)).rejects.toThrow(
			"OFFICE_WORKBENCH_UNACCOUNTED_ENTRY",
		);
		expect(await readdir(w.root)).toHaveLength(3);
	});
	it("refuses a mount root of another account", async () => {
		const w = await workbench();
		await expect(removeLxdOfficeWorkbench({ ...w.scope, uid: uid + 1 }, names, signal(), 30000)).rejects.toThrow(
			"OFFICE_WORKBENCH_ROOT_DIFFERS",
		);
		expect(await readdir(w.root)).toHaveLength(2);
	});
	it.each([
		["another account's", { uid: uid + 1 }],
		["another file system's", { dev: 1 }],
	])("holds on %s entry and removes nothing beneath it", async (_, override) => {
		const w = await workbench();
		changed.set("project", override);
		await expect(removeLxdOfficeWorkbench(w.scope, names, signal(), 30000)).rejects.toThrow(
			"OFFICE_WORKBENCH_FOREIGN_ENTRY",
		);
		expect(await readdir(join(w.adopted, "workbench", "project", "deep"))).toEqual(["notes.txt"]);
		expect((await lstat(join(w.adopted, "workbench", "project"))).mode & 0o7777).toBe(0o500);
	});
	it("names a file system error by a fixed token", async () => {
		const w = await workbench();
		await chmod(w.root, 0o500);
		await expect(removeLxdOfficeWorkbench(w.scope, names, signal(), 30000)).rejects.toThrow(
			/^OFFICE_WORKBENCH_REMOVAL_EACCES$/,
		);
	});
	it("stops when the caller aborts", async () => {
		const w = await workbench();
		const controller = new AbortController();
		controller.abort(new Error("stopped"));
		await expect(removeLxdOfficeWorkbench(w.scope, names, controller.signal, 30000)).rejects.toThrow("stopped");
		expect(await readdir(w.root)).toHaveLength(2);
	});
});
