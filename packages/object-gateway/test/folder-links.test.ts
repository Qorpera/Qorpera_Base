import { mkdtemp, readFile, rm } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CoreEntry } from "../src/folder-service/core.ts";
import { NasObjects } from "../src/folder-service/objects.ts";
import {
	encodeJson,
	type Frame,
	FrameReader,
	Kind,
	MAX_TARGET,
	ProtocolError,
	parseLink,
	parseSymlink,
	type WireEntry,
} from "../src/folder-service/protocol.ts";
import { createFolderServer } from "../src/folder-service/server.ts";
import { FolderService, type ViewHandle } from "../src/folder-service/service.ts";
import { FolderStaging } from "../src/folder-service/staging.ts";
import {
	BRIDGE,
	ENV,
	FakeCore,
	FakeUploads,
	folder,
	hashOf,
	link,
	PASS,
	PROFILE,
	storeFile,
	v,
	writableGrants,
} from "./folder-service-fixtures.ts";

/** Links through the mount (contract amendment #1020, item 4; LK3): a machine on protocol 4 lists, reads and makes
 * symbolic links (`Y`) and hard links (`J`); one below it never sees a link. Against the stand-in core and share. */
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	// Last in, first out: a socket's clients go before the server, which closes only once they have.
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const BIG = 4 * 1024 * 1024;

async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "qorpera-folder-links-"));
	const core = new FakeCore();
	const objects = new NasObjects({ root, cacheBytes: 64 * 1024 * 1024 });
	const uploads = new FakeUploads(root, core);
	const service = new FolderService({
		core,
		objects,
		grants: writableGrants(),
		staging: new FolderStaging(core, uploads, objects),
		log: () => undefined,
	});
	const handles: ViewHandle[] = [];
	cleanups.push(async () => {
		for (const h of handles) h.release();
		service.stop();
		await rm(root, { recursive: true, force: true });
	});
	/** A connection of the machine's at `protocol`; every one is on the same view. */
	const open = async (protocol = 4) => {
		const handle = await service.open(
			{ protocol, environmentId: ENV, viewId: "proof", pass: PASS, role: "io" },
			BRIDGE,
		);
		handles.push(handle);
		return handle;
	};
	/** Another machine's save, brought to the view by its feed. */
	const elsewhere = async (entry: CoreEntry) => {
		core.write(entry);
		await service.poll();
		await service.settled();
	};
	return { root, core, uploads, service, open, elsewhere };
}

/** A stored file's objects in the catalogue, as they are once the gateway put them: a file made of them puts none. */
async function catalogue(core: FakeCore, root: string, entry: CoreEntry): Promise<void> {
	const manifest = await readFile(join(root, PROFILE, entry.manifestSha256!));
	core.catalog.set(entry.manifestSha256!, manifest.byteLength);
	for (const chunk of (JSON.parse(manifest.toString()) as { chunks: { sha256: string; bytes: number }[] }).chunks)
		core.catalog.set(chunk.sha256, chunk.bytes);
}

/** A save as the folder program makes it, and the version its close answered. */
async function save(view: ViewHandle, path: string, text: string): Promise<string> {
	const { handle } = await view.open({ path, create: true, exclusive: false, truncate: true });
	const data = Buffer.from(text);
	await view.chunk({ handle, index: 0, sha256: hashOf(data), bytes: data.byteLength, offset: 0, data });
	return (await view.close(handle, data.byteLength)).version;
}

/** What the machine reads at a version it was shown: a file's bytes, a link's target. */
async function readAt(view: ViewHandle, path: string, version: string, offset = 0, length = 1024): Promise<string> {
	return (await view.read({ path, version, offset, length })).toString();
}

type Page = { readonly entries: readonly WireEntry[] };
const names = (page: Page) => page.entries.map((e) => e.name);
const named = (page: Page, name: string) => page.entries.find((e) => e.name === name);

async function refused(promise: Promise<unknown>, code: string): Promise<void> {
	await expect(promise).rejects.toBeInstanceOf(ProtocolError);
	await expect(promise).rejects.toMatchObject({ code });
}

describe("links below protocol 4", () => {
	it("are not there: never listed or read, not removed or moved, and the names they hold taken", async () => {
		const { root, core, open } = await fixture();
		core.seed([
			folder("docs"),
			await storeFile(root, "docs/v1.md", "one", 2, BIG),
			link("docs/latest", "v1.md", 3),
			folder("only", 4),
			link("only/up", "../docs", 5),
		]);
		const view = await open(3);
		expect(names(await view.list("docs", undefined))).toEqual(["v1.md"]);
		expect(names(await view.list("only", undefined))).toEqual([]);
		await refused(view.read({ path: "docs/latest", version: v(3), offset: 0, length: 100 }), "NOT_FOUND");
		// Its name is taken all the same, and a folder holding one is not empty.
		await refused(view.mkdir("docs/latest"), "EXISTS");
		await refused(view.open({ path: "docs/latest", create: true, exclusive: false, truncate: true }), "EXISTS");
		await refused(view.rmdir("only", undefined), "NOT_EMPTY");
		await refused(view.unlink("docs/latest", undefined), "NOT_FOUND");
		await refused(view.rename({ from: "docs/latest", to: "docs/moved", noReplace: false }), "NOT_FOUND");
		await refused(view.setExecutable("docs/latest", true, undefined), "NOT_FOUND");
		await save(view, "docs/new.md", "new");
		await refused(view.rename({ from: "docs/new.md", to: "docs/latest", noReplace: false }), "EXISTS");
		// A link a protocol 4 connection of the same view made is not there either.
		const made = (await (await open(4)).symlink("docs/mine", "v1.md")).version;
		expect(names(await view.list("docs", undefined))).toEqual(["new.md", "v1.md"]);
		await refused(view.read({ path: "docs/mine", version: made, offset: 0, length: 100 }), "NOT_FOUND");
		await refused(view.unlink("docs/mine", undefined), "NOT_FOUND");
		await refused(view.rename({ from: "docs/new.md", to: "docs/mine", noReplace: false }), "EXISTS");
	});
});

describe("links on protocol 4", () => {
	it("lists a link with its target's length as its size, and reads its target at its version and a replaced one", async () => {
		const { root, core, open, elsewhere } = await fixture();
		core.seed([folder("docs"), await storeFile(root, "docs/v1.md", "one", 2, BIG), link("docs/latest", "v1.md", 3)]);
		const view = await open();
		const latest = named(await view.list("docs", undefined), "latest");
		expect(latest).toMatchObject({ kind: "symlink", size: 5, version: v(3), executable: false });
		expect(latest).not.toHaveProperty("target");
		expect(await readAt(view, "docs/latest", v(3))).toBe("v1.md");
		expect(await readAt(view, "docs/latest", v(3), 1, 2)).toBe("1.");
		await elsewhere(link("docs/latest", "v22.md", 6));
		expect(named(await view.list("docs", undefined), "latest")).toMatchObject({ size: 6, version: v(6) });
		expect(await readAt(view, "docs/latest", v(6))).toBe("v22.md");
		// What the machine saw before the change still reads as it was.
		expect(await readAt(view, "docs/latest", v(3))).toBe("v1.md");
		await refused(view.read({ path: "docs/latest", version: v(99), offset: 0, length: 100 }), "STALE");
	});

	it("makes a link that reads back at once, publishes it as a symlink unit, and still reads it at the version made", async () => {
		const { root, core, open } = await fixture();
		core.seed([folder("docs"), await storeFile(root, "docs/v1.md", "one", 2, BIG)]);
		const view = await open();
		const { version } = await view.symlink("docs/latest", "v1.md");
		expect(named(await view.list("docs", undefined), "latest")).toMatchObject({ kind: "symlink", size: 5, version });
		expect(await readAt(view, "docs/latest", version)).toBe("v1.md");
		await refused(view.symlink("docs/latest", "v2.md"), "EXISTS");
		await refused(view.symlink("docs/v1.md", "v2.md"), "EXISTS");
		await refused(view.symlink("docs", "v2.md"), "EXISTS");
		expect((await view.publish()).paths).toEqual([{ path: "docs/latest", outcome: "saved" }]);
		expect(core.commits.at(-1)!.units).toEqual([{ op: "symlink", path: "docs/latest", target: "v1.md" }]);
		const live = core.entries.get("docs/latest")!;
		expect(live).toMatchObject({ kind: "symlink", target: "v1.md" });
		expect(named(await view.list("docs", undefined), "latest")).toMatchObject({ version: live.version });
		// The machine still holds the version `Y` answered: it reads as the version the save published.
		expect(await readAt(view, "docs/latest", version)).toBe("v1.md");
	});

	it("replaces a link as `ln -sf` does, in one symlink unit naming the version it replaced", async () => {
		const { core, open } = await fixture();
		core.seed([folder("docs"), link("docs/latest", "v1.md", 3)]);
		const view = await open();
		// The new link under a temporary name, renamed over the old one.
		const made = await view.symlink("docs/CuXXXXXX", "v2.md");
		await view.rename({
			from: "docs/CuXXXXXX",
			fromBase: made.version,
			to: "docs/latest",
			toBase: v(3),
			noReplace: false,
		});
		expect(await readAt(view, "docs/latest", made.version)).toBe("v2.md");
		expect((await view.publish()).paths).toEqual([{ path: "docs/latest", outcome: "saved" }]);
		expect(core.commits.at(-1)!.units).toEqual([
			{ op: "symlink", path: "docs/latest", target: "v2.md", expectedVersion: v(3) },
		]);
		expect(core.entries.get("docs/latest")).toMatchObject({ kind: "symlink", target: "v2.md" });
		expect(core.entries.has("docs/CuXXXXXX")).toBe(false);
	});

	it("tries `ln -sf` at the version it replaced after another machine removed that, never making the old name again", async () => {
		const { core, service, open } = await fixture();
		core.seed([folder("docs"), link("docs/latest", "v1.md", 3), link("docs/next", "v1.md", 4)]);
		const view = await open();
		const lnsf = async (name: string, base: string) => {
			const made = await view.symlink("docs/CuXXXXXX", "v2.md");
			await view.rename({
				from: "docs/CuXXXXXX",
				fromBase: made.version,
				to: `docs/${name}`,
				toBase: base,
				noReplace: false,
			});
			return made.version;
		};
		// One refused at a boundary first, the other not published yet.
		await lnsf("latest", v(3));
		core.refuse = (path) => path === "docs/latest";
		expect((await view.publish()).paths).toEqual([
			{ path: "docs/latest", outcome: "denied", reason: "denied", kept: true },
		]);
		core.refuse = () => false;
		const next = await lnsf("next", v(4));
		// Another machine removes both old links, and its change reaches the view: the new ones still show.
		core.remove("docs/latest");
		core.remove("docs/next");
		await service.poll();
		await service.settled();
		expect(names(await view.list("docs", undefined))).toEqual(["latest", "next"]);
		expect(await readAt(view, "docs/next", next)).toBe("v2.md");
		// Each still names the version it replaced, so the core finds it gone: a conflict kept on the receipt.
		const report = await view.publish();
		const units = core.commits.at(-1)!.units;
		expect(units).toHaveLength(2);
		expect(units).toEqual(
			expect.arrayContaining([
				{ op: "symlink", path: "docs/latest", target: "v2.md", expectedVersion: v(3) },
				{ op: "symlink", path: "docs/next", target: "v2.md", expectedVersion: v(4) },
			]),
		);
		const kept = { outcome: "conflict", reason: "version_changed", receipt: report.commitId, target: "v2.md" };
		expect(report.paths).toHaveLength(2);
		expect(report.paths).toEqual(
			expect.arrayContaining([
				{ path: "docs/latest", ...kept },
				{ path: "docs/next", ...kept },
			]),
		);
		expect(core.entries.has("docs/latest")).toBe(false);
		expect(core.entries.has("docs/next")).toBe(false);
		expect(names(await view.list("docs", undefined))).toEqual([]);
	});

	it("shows another machine's newer link again once the link that replaced the old one is removed or moved away", async () => {
		const { core, open, elsewhere } = await fixture();
		core.seed([folder("docs"), link("docs/latest", "v1.md", 3), link("docs/next", "v1.md", 4)]);
		const view = await open();
		for (const [name, base] of [
			["latest", v(3)],
			["next", v(4)],
		]) {
			const made = await view.symlink("docs/CuXXXXXX", "v2.md");
			await view.rename({
				from: "docs/CuXXXXXX",
				fromBase: made.version,
				to: `docs/${name}`,
				toBase: base,
				noReplace: false,
			});
		}
		await elsewhere(link("docs/latest", "v3.md", 6));
		await elsewhere(link("docs/next", "v3.md", 7));
		await view.unlink("docs/latest", undefined);
		await view.rename({ from: "docs/next", to: "docs/mine", noReplace: false });
		const listed = await view.list("docs", undefined);
		expect(names(listed)).toEqual(["latest", "mine", "next"]);
		expect(named(listed, "latest")).toMatchObject({ kind: "symlink", version: v(6) });
		expect(named(listed, "next")).toMatchObject({ kind: "symlink", version: v(7) });
		expect(await readAt(view, "docs/latest", v(6))).toBe("v3.md");
		// Neither old link's removal is published: the machine never saw what is there now.
		expect((await view.publish()).paths).toEqual([{ path: "docs/mine", outcome: "saved" }]);
		expect(core.commits.at(-1)!.units).toEqual([{ op: "symlink", path: "docs/mine", target: "v2.md" }]);
		expect(core.entries.get("docs/latest")).toMatchObject({ target: "v3.md", version: v(6) });
		expect(core.entries.get("docs/next")).toMatchObject({ target: "v3.md", version: v(7) });
	});

	it("keeps `ln -sf`'s link renamed only in case at the version it replaced after another machine removed or changed that", async () => {
		const { core, service, open, elsewhere } = await fixture();
		core.seed([folder("docs"), link("docs/latest", "v1.md", 3), link("docs/next", "v1.md", 4)]);
		const view = await open();
		for (const [name, base] of [
			["latest", v(3)],
			["next", v(4)],
		]) {
			const made = await view.symlink("docs/CuXXXXXX", "v2.md");
			await view.rename({
				from: "docs/CuXXXXXX",
				fromBase: made.version,
				to: `docs/${name}`,
				toBase: base,
				noReplace: false,
			});
		}
		// Another machine removes one old link and changes the other, and its changes reach the view.
		core.remove("docs/latest");
		await service.poll();
		await service.settled();
		await elsewhere(link("docs/next", "v3.md", 7));
		// A rename only in case keeps each new link the next version of the old one.
		await view.rename({ from: "docs/latest", to: "docs/LATEST", noReplace: false });
		await view.rename({ from: "docs/next", to: "docs/NEXT", noReplace: false });
		expect(names(await view.list("docs", undefined))).toEqual(["LATEST", "NEXT"]);
		const report = await view.publish();
		const units = core.commits.at(-1)!.units;
		expect(units).toHaveLength(2);
		expect(units).toEqual(
			expect.arrayContaining([
				{ op: "symlink", path: "docs/LATEST", target: "v2.md", expectedVersion: v(3) },
				{ op: "symlink", path: "docs/NEXT", target: "v2.md", expectedVersion: v(4) },
			]),
		);
		const kept = { outcome: "conflict", reason: "version_changed", receipt: report.commitId, target: "v2.md" };
		expect(report.paths).toHaveLength(2);
		expect(report.paths).toEqual(
			expect.arrayContaining([
				{ path: "docs/LATEST", ...kept },
				{ path: "docs/NEXT", ...kept },
			]),
		);
		expect(core.entries.has("docs/latest")).toBe(false);
		expect(core.entries.has("docs/LATEST")).toBe(false);
		expect(core.entries.get("docs/next")).toMatchObject({ target: "v3.md", version: v(7) });
		expect(core.entries.has("docs/NEXT")).toBe(false);
	});

	it("makes `ln -sf`'s link renamed over the old one another machine renamed only in case one replacement of that", async () => {
		const { core, service, open } = await fixture();
		core.seed([folder("docs"), link("docs/latest", "v1.md", 3)]);
		const view = await open();
		const made = await view.symlink("docs/CuXXXXXX", "v2.md");
		await view.rename({
			from: "docs/CuXXXXXX",
			fromBase: made.version,
			to: "docs/latest",
			toBase: v(3),
			noReplace: false,
		});
		// Another machine renames the old link only in case, and its change reaches the view: both names show.
		const old = core.entries.get("docs/latest")!;
		core.commitChanges([
			{ ...old, op: "move_out" },
			{ ...old, path: "docs/LATEST", version: v(8), op: "move_in", priorVersion: old.version },
		]);
		await service.poll();
		await service.settled();
		expect(names(await view.list("docs", undefined))).toEqual(["LATEST", "latest"]);
		// The new link renamed over it replaces the version the machine saw there, as one unit.
		await view.rename({ from: "docs/latest", to: "docs/LATEST", toBase: v(8), noReplace: false });
		expect(names(await view.list("docs", undefined))).toEqual(["LATEST"]);
		expect((await view.publish()).paths).toEqual([{ path: "docs/LATEST", outcome: "saved" }]);
		expect(core.commits.at(-1)!.units).toEqual([
			{ op: "symlink", path: "docs/LATEST", target: "v2.md", expectedVersion: v(8) },
		]);
		expect(core.entries.get("docs/LATEST")).toMatchObject({ kind: "symlink", target: "v2.md" });
		expect(core.entries.has("docs/latest")).toBe(false);
	});

	it("publishes `ln -sf`'s link first when another is renamed over the old one another machine renamed only in case beside it", async () => {
		const { core, service, open } = await fixture();
		core.seed([folder("docs"), link("docs/latest", "v1.md", 3)]);
		const view = await open();
		const made = await view.symlink("docs/CuXXXXXX", "v2.md");
		await view.rename({
			from: "docs/CuXXXXXX",
			fromBase: made.version,
			to: "docs/latest",
			toBase: v(3),
			noReplace: false,
		});
		// Another machine renames the old link only in case, and its change reaches the view: both names show.
		const old = core.entries.get("docs/latest")!;
		core.commitChanges([
			{ ...old, op: "move_out" },
			{ ...old, path: "docs/LATEST", version: v(8), op: "move_in", priorVersion: old.version },
		]);
		await service.poll();
		await service.settled();
		// Another `ln -sf` over the new name, at the version there: the first link publishes first, still replacing the
		// version it saw (a conflict, kept on the receipt), so it never takes the second link's base.
		const next = await view.symlink("docs/CuYYYYYY", "v3.md");
		await view.rename({
			from: "docs/CuYYYYYY",
			fromBase: next.version,
			to: "docs/LATEST",
			toBase: v(8),
			noReplace: false,
		});
		expect(core.commits).toHaveLength(1);
		expect(core.commits[0]!.units).toEqual(
			expect.arrayContaining([{ op: "symlink", path: "docs/latest", target: "v2.md", expectedVersion: v(3) }]),
		);
		expect([...core.copies.values()].flat()).toEqual([
			expect.objectContaining({ path: "docs/latest", kind: "symlink", target: "v2.md" }),
		]);
		expect(names(await view.list("docs", undefined))).toEqual(["LATEST"]);
		// The second link replaces the version it named.
		const report = await view.publish();
		expect(new Set(report.paths.map((p) => p.outcome))).toEqual(new Set(["saved"]));
		expect(core.entries.get("docs/LATEST")).toMatchObject({ kind: "symlink", target: "v3.md" });
		expect(core.entries.has("docs/latest")).toBe(false);
		expect(core.entries.has("docs/CuYYYYYY")).toBe(false);
		for (const unit of core.commits.flatMap((c) => c.units))
			expect(unit).not.toMatchObject({ path: "docs/latest", expectedVersion: v(8) });
	});

	it("publishes `ln -sf`'s link first when the old one another machine renamed only in case beside it is moved away", async () => {
		const { core, service, open } = await fixture();
		core.seed([folder("docs"), link("docs/latest", "v1.md", 3)]);
		const view = await open();
		const made = await view.symlink("docs/CuXXXXXX", "v2.md");
		await view.rename({
			from: "docs/CuXXXXXX",
			fromBase: made.version,
			to: "docs/latest",
			toBase: v(3),
			noReplace: false,
		});
		const old = core.entries.get("docs/latest")!;
		core.commitChanges([
			{ ...old, op: "move_out" },
			{ ...old, path: "docs/LATEST", version: v(8), op: "move_in", priorVersion: old.version },
		]);
		await service.poll();
		await service.settled();
		// The new name moved away, then removed: the link publishes first (a conflict), so removing what moved never
		// leaves the link replacing v8 in place of the version it saw.
		await view.rename({ from: "docs/LATEST", fromBase: v(8), to: "docs/old", noReplace: false });
		expect(core.commits).toHaveLength(1);
		expect(core.commits[0]!.units).toEqual([
			{ op: "symlink", path: "docs/latest", target: "v2.md", expectedVersion: v(3) },
		]);
		expect([...core.copies.values()].flat()).toEqual([
			expect.objectContaining({ path: "docs/latest", kind: "symlink", target: "v2.md" }),
		]);
		expect(names(await view.list("docs", undefined))).toEqual(["old"]);
		await view.unlink("docs/old", undefined);
		expect((await view.publish()).paths).toEqual([{ path: "docs/LATEST", outcome: "saved" }]);
		expect(core.commits.at(-1)!.units).toEqual([
			expect.objectContaining({ op: "delete", path: "docs/LATEST", expectedVersion: v(8) }),
		]);
		expect(core.entries.has("docs/LATEST")).toBe(false);
		expect(core.entries.has("docs/latest")).toBe(false);
		expect(core.entries.has("docs/old")).toBe(false);
		for (const unit of core.commits.flatMap((c) => c.units))
			expect(unit).not.toMatchObject({ path: "docs/latest", expectedVersion: v(8) });
	});

	it("publishes a new folder first when `ln -sf` runs in one another machine made, spelled otherwise", async () => {
		const { core, service, open } = await fixture();
		const view = await open();
		await view.mkdir("docs");
		core.commitChanges([
			{ ...folder("Docs", 5), op: "mkdir" },
			{ ...link("Docs/latest", "v1.md", 6), op: "write" },
		]);
		await service.poll();
		await service.settled();
		// In the core the new link would go into the pending folder's unit: the folder publishes first.
		const made = await view.symlink("Docs/CuXXXXXX", "v2.md");
		expect(core.commits).toHaveLength(1);
		expect(core.commits[0]!.units).toEqual([{ op: "mkdir", path: "docs" }]);
		await view.rename({
			from: "Docs/CuXXXXXX",
			fromBase: made.version,
			to: "Docs/latest",
			toBase: v(6),
			noReplace: false,
		});
		expect((await view.publish()).paths).toEqual([{ path: "Docs/latest", outcome: "saved" }]);
		expect(core.commits.at(-1)!.units).toEqual([
			{ op: "symlink", path: "Docs/latest", target: "v2.md", expectedVersion: v(6) },
		]);
		expect(core.entries.get("Docs/latest")).toMatchObject({ kind: "symlink", target: "v2.md" });
		expect(core.entries.has("Docs/CuXXXXXX")).toBe(false);
	});

	it("makes a hard link to a live file a write of the source's own reference, putting no byte again", async () => {
		const { root, core, uploads, open } = await fixture();
		const source = await storeFile(root, "docs/a.md", "alpha", 2, BIG);
		core.seed([folder("docs"), source]);
		await catalogue(core, root, source);
		const view = await open();
		const { version } = await view.link({ from: "docs/a.md", fromBase: v(2), to: "docs/b.md" });
		expect(named(await view.list("docs", undefined), "b.md")).toMatchObject({ kind: "file", size: 5, version });
		expect(await readAt(view, "docs/b.md", version)).toBe("alpha");
		expect((await view.publish()).paths).toEqual([{ path: "docs/b.md", outcome: "saved" }]);
		expect(core.commits.at(-1)!.units).toEqual([
			{
				op: "write",
				path: "docs/b.md",
				file: expect.objectContaining({ manifestSha256: source.manifestSha256, fileSha256: source.fileSha256 }),
			},
		]);
		expect(uploads.puts).toEqual([]);
		// Two names, two files: the source is as it was.
		expect(core.entries.get("docs/a.md")).toEqual(source);
		expect(core.entries.get("docs/b.md")).toMatchObject({ kind: "file", manifestSha256: source.manifestSha256 });
	});

	it("makes a hard link to a file this view wrote a write of the same staged reference, its bytes put once", async () => {
		const { core, uploads, open } = await fixture();
		core.seed([folder("docs")]);
		const view = await open();
		const fresh = await save(view, "docs/fresh.md", "fresh");
		// Its chunk and its manifest, staged at its close.
		const put = [...uploads.puts];
		expect(put).toHaveLength(2);
		expect(put).toContain(hashOf("fresh"));
		const { version } = await view.link({ from: "docs/fresh.md", fromBase: fresh, to: "docs/copy.md" });
		expect(await readAt(view, "docs/copy.md", version)).toBe("fresh");
		await view.publish();
		const units = core.commits.at(-1)!.units;
		expect(units.map((u) => u.op === "write" && u.path).sort()).toEqual(["docs/copy.md", "docs/fresh.md"]);
		const files = units.map((u) => (u.op === "write" ? u.file : undefined));
		expect(files[0]).toEqual(files[1]);
		expect(put).toContain(files[0]!.manifestSha256);
		expect(uploads.puts).toEqual(put);
		expect(core.entries.get("docs/copy.md")!.manifestSha256).toBe(core.entries.get("docs/fresh.md")!.manifestSha256);
	});

	it("makes a hard link to a link a new link with its target", async () => {
		const { core, open } = await fixture();
		core.seed([folder("docs"), link("docs/latest", "v1.md", 3)]);
		const view = await open();
		const { version } = await view.link({ from: "docs/latest", fromBase: v(3), to: "docs/also" });
		expect(named(await view.list("docs", undefined), "also")).toMatchObject({ kind: "symlink", size: 5, version });
		expect(await readAt(view, "docs/also", version)).toBe("v1.md");
		await view.publish();
		expect(core.commits.at(-1)!.units).toEqual([{ op: "symlink", path: "docs/also", target: "v1.md" }]);
		expect(core.entries.get("docs/latest")).toMatchObject({ target: "v1.md", version: v(3) });
	});

	it("refuses a hard link to a file open for writing, onto a present name, or from a version no longer served", async () => {
		const { root, core, open, elsewhere } = await fixture();
		const one = await storeFile(root, "a.md", "one", 2, BIG);
		core.seed([one, await storeFile(root, "c.md", "c", 3, BIG), folder("D", 4)]);
		const view = await open();
		const { handle } = await view.open({ path: "open.md", create: true, exclusive: false, truncate: true });
		await refused(view.link({ from: "open.md", to: "x.md" }), "BUSY");
		await view.close(handle, 0);
		await refused(view.link({ from: "a.md", to: "c.md" }), "EXISTS");
		await refused(view.link({ from: "a.md", fromBase: v(99), to: "x.md" }), "STALE");
		await refused(view.link({ from: "open.md", fromBase: v(99), to: "x.md" }), "STALE");
		await refused(view.link({ from: "D", to: "x" }), "NOT_PERMITTED");
		await refused(view.link({ from: "missing.md", to: "x.md" }), "NOT_FOUND");
		expect(names(await view.list("", undefined))).toEqual(["D", "a.md", "c.md", "open.md"]);
		// A version another machine's save replaced is served while the view keeps it: the new name gets what the
		// machine showed.
		await elsewhere(await storeFile(root, "a.md", "two", 5, BIG));
		const { version } = await view.link({ from: "a.md", fromBase: v(2), to: "old.md" });
		expect(await readAt(view, "old.md", version)).toBe("one");
		await view.publish();
		expect(core.entries.get("old.md")).toMatchObject({ kind: "file", manifestSha256: one.manifestSha256 });
		expect(core.entries.get("a.md")).toMatchObject({ version: v(5) });
	});

	it("keeps a refused link pending, says so, and saves it at a later boundary", async () => {
		const { core, open } = await fixture();
		core.seed([folder("locked")]);
		core.refuse = (path) => path.startsWith("locked/");
		const view = await open();
		const { version } = await view.symlink("locked/up", "../x");
		expect((await view.publish()).paths).toEqual([
			{ path: "locked/up", outcome: "denied", reason: "denied", kept: true },
		]);
		expect(await readAt(view, "locked/up", version)).toBe("../x");
		core.refuse = () => false;
		expect((await view.publish()).paths).toEqual([{ path: "locked/up", outcome: "saved" }]);
		expect(core.entries.get("locked/up")).toMatchObject({ kind: "symlink", target: "../x" });
	});

	it("never publishes an editor's lock link, and shows it until the editor removes it", async () => {
		const { core, open } = await fixture();
		const view = await open();
		await view.symlink(".#notes.md", "member@machine.4242:1760000000");
		await save(view, "notes.md", "notes");
		expect((await view.publish()).paths).toEqual([{ path: "notes.md", outcome: "saved" }]);
		expect(JSON.stringify(core.commits)).not.toContain(".#notes.md");
		expect(names(await view.list("", undefined))).toEqual([".#notes.md", "notes.md"]);
		await view.unlink(".#notes.md", undefined);
		expect((await view.publish()).paths).toEqual([]);
		expect(names(await view.list("", undefined))).toEqual(["notes.md"]);
		expect(core.entries.has(".#notes.md")).toBe(false);
	});

	it("keeps a conflicting link in the view until the receipt holds it, then reports it kept there with its target", async () => {
		const { core, open, elsewhere } = await fixture();
		core.seed([folder("docs"), link("docs/latest", "v1.md", 3)]);
		const view = await open();
		await elsewhere(link("docs/latest", "v3.md", 6));
		// `ln -sf` from what the machine showed before the other machine's change.
		const made = await view.symlink("docs/CuXXXXXX", "v2.md");
		await view.rename({ from: "docs/CuXXXXXX", to: "docs/latest", toBase: v(3), noReplace: false });
		// The core decided the conflict but kept no copy: the link stays this view's and is tried again, still replacing
		// the version the machine renamed over.
		core.copyConflicts = false;
		expect((await view.publish()).paths).toEqual([
			{ path: "docs/latest", outcome: "conflict", reason: "version_changed", kept: true },
		]);
		const unit = { op: "symlink", path: "docs/latest", target: "v2.md", expectedVersion: v(3) };
		expect(core.commits.at(-1)!.units).toEqual([unit]);
		expect(await readAt(view, "docs/latest", made.version)).toBe("v2.md");
		core.copyConflicts = true;
		const report = await view.publish();
		expect(core.commits.at(-1)!.units).toEqual([unit]);
		expect(report.paths).toEqual([
			{
				path: "docs/latest",
				outcome: "conflict",
				reason: "version_changed",
				receipt: report.commitId,
				target: "v2.md",
			},
		]);
		expect(core.copies.get(report.commitId!)).toEqual([
			{ unit: 1, file: 1, path: "docs/latest", kind: "symlink", target: "v2.md" },
		]);
		// The view shows the other machine's link now.
		expect(named(await view.list("docs", undefined), "latest")).toMatchObject({ kind: "symlink", version: v(6) });
		expect(await readAt(view, "docs/latest", v(6))).toBe("v3.md");
	});

	it("keeps a new folder whose link conflicts in the view until the receipt holds it, then reports the link's target", async () => {
		const { core, service, open } = await fixture();
		const view = await open();
		await view.mkdir("site");
		const home = await view.symlink("site/home", "index.html");
		// Another machine made the folder meanwhile; its change has not reached the view yet.
		core.write(folder("site", 6));
		core.copyConflicts = false;
		expect((await view.publish()).paths).toEqual([
			{ path: "site", outcome: "conflict", reason: "exists", kept: true },
			{ path: "site/home", outcome: "conflict", reason: "exists", kept: true },
		]);
		expect(core.commits.at(-1)!.units).toEqual([
			{ op: "new_folder", path: "site", contents: [{ path: "home", kind: "symlink", target: "index.html" }] },
		]);
		expect(await readAt(view, "site/home", home.version)).toBe("index.html");
		core.copyConflicts = true;
		const report = await view.publish();
		expect(report.paths).toEqual([
			{ path: "site", outcome: "conflict", reason: "exists", receipt: report.commitId },
			{ path: "site/home", outcome: "conflict", reason: "exists", receipt: report.commitId, target: "index.html" },
		]);
		expect(core.copies.get(report.commitId!)).toEqual([
			{ unit: 1, file: 1, path: "site/home", kind: "symlink", target: "index.html" },
		]);
		await service.poll();
		await service.settled();
		expect(named(await view.list("", undefined), "site")).toMatchObject({ kind: "folder", version: v(6) });
		expect(names(await view.list("site", undefined))).toEqual([]);
	});
});

describe("protocol 4", () => {
	it("checks every link request field", () => {
		const json = (value: unknown) => Buffer.from(JSON.stringify(value));
		expect(parseSymlink(json({ path: "docs/latest", target: "../v1.md" }))).toEqual({
			path: "docs/latest",
			target: "../v1.md",
		});
		// Up to 4,095 bytes of UTF-8, whatever they say: a target is never resolved.
		const longest = `${"é".repeat((MAX_TARGET - 1) / 2)}x`;
		expect(Buffer.byteLength(longest)).toBe(4095);
		expect(parseSymlink(json({ path: "l", target: longest })).target).toBe(longest);
		expect(parseSymlink(json({ path: "l", target: "/etc/../nowhere" })).target).toBe("/etc/../nowhere");
		for (const target of ["", "a\0b", `${longest}x`, "x".repeat(MAX_TARGET + 1), "\ud800", 7, null])
			expect(() => parseSymlink(json({ path: "l", target }))).toThrow(ProtocolError);
		expect(() => parseSymlink(json({ path: "l", target: "t", extra: 1 }))).toThrow(ProtocolError);
		expect(() => parseSymlink(json({ path: "", target: "t" }))).toThrow(ProtocolError);
		expect(() => parseSymlink(json({ target: "t" }))).toThrow(ProtocolError);
		const base = "00000000-0000-4000-8000-000000000001";
		expect(parseLink(json({ from: "a", to: "b" }))).toEqual({ from: "a", to: "b" });
		expect(parseLink(json({ from: "a", fromBase: base, to: "b" }))).toEqual({ from: "a", fromBase: base, to: "b" });
		for (const bad of [
			{ from: "a" },
			{ from: "a", to: 1 },
			{ from: "", to: "b" },
			{ from: "a", to: "b", fromBase: "v1" },
			{ from: "a", to: "b", base },
		])
			expect(() => parseLink(json(bad))).toThrow(ProtocolError);
	});

	it("answers Y and J with the version made, a bad target as a request error, and ends a protocol 3 connection sending one", async () => {
		const { service } = await fixture();
		const dir = await mkdtemp(join(tmpdir(), "qorpera-folder-links-socket-"));
		const server = createFolderServer(service, () => undefined);
		const path = join(dir, "service.sock");
		await new Promise<void>((resolve) => server.listen(path, resolve));
		cleanups.push(async () => {
			await new Promise<void>((resolve) => server.close(() => resolve()));
			await rm(dir, { recursive: true, force: true });
		});
		const client = async (protocol: number) => {
			const socket = connect(path);
			await new Promise<void>((resolve) => socket.once("connect", () => resolve()));
			cleanups.push(async () => {
				socket.destroy();
			});
			const reader = new FrameReader();
			const frames: Frame[] = [];
			const waiters: ((frame: Frame | undefined) => void)[] = [];
			let closed = false;
			socket.on("data", (data: Buffer) => {
				for (const frame of reader.push(data)) {
					const waiter = waiters.shift();
					if (waiter) waiter(frame);
					else frames.push(frame);
				}
			});
			socket.on("close", () => {
				closed = true;
				for (const waiter of waiters.splice(0)) waiter(undefined);
			});
			/** The next frame, or undefined once the service ended the connection. */
			const next = (): Promise<Frame | undefined> =>
				frames.length > 0 || closed
					? Promise.resolve(frames.shift())
					: new Promise((resolve) => waiters.push(resolve));
			const ask = async (kind: number, payload: Record<string, unknown>) => {
				socket.write(encodeJson(kind, payload));
				const frame = await next();
				return frame && { kind: frame.kind, body: JSON.parse(frame.payload.toString()) as Record<string, unknown> };
			};
			socket.write(encodeJson(Kind.bridge, BRIDGE));
			const hello = await ask(Kind.hello, { protocol, environmentId: ENV, viewId: "proof", pass: PASS, role: "io" });
			return { hello, ask, next };
		};
		const v4 = await client(4);
		expect(v4.hello).toMatchObject({ kind: Kind.helloOk, body: { protocol: 4, readOnly: false } });
		const made = await v4.ask(Kind.symlink, { path: "latest", target: "plan.md" });
		expect(made).toEqual({ kind: Kind.done, body: { version: expect.any(String) } });
		const linked = await v4.ask(Kind.link, { from: "latest", fromBase: made!.body.version, to: "also" });
		expect(linked).toEqual({ kind: Kind.done, body: { version: expect.any(String) } });
		expect(await v4.ask(Kind.symlink, { path: "bad", target: "" })).toEqual({
			kind: Kind.error,
			body: { code: "BAD_REQUEST", message: "Bad link target" },
		});
		// The connection carries on after a refused request.
		const listing = await v4.ask(Kind.list, { path: "" });
		expect((listing!.body.entries as WireEntry[]).map((e) => [e.name, e.kind, e.size, e.version])).toEqual([
			["also", "symlink", 7, linked!.body.version],
			["latest", "symlink", 7, made!.body.version],
		]);
		const report = await v4.ask(Kind.publish, {});
		expect(report?.kind).toBe(Kind.report);
		const saved = [...(report!.body.paths as { path: string }[])].sort((a, b) => (a.path < b.path ? -1 : 1));
		expect(saved).toEqual([
			{ path: "also", outcome: "saved" },
			{ path: "latest", outcome: "saved" },
		]);
		// A machine on protocol 3 sees none of them, and one that sends `Y` anyway is not one this service knows.
		const v3 = await client(3);
		expect(v3.hello).toMatchObject({ kind: Kind.helloOk, body: { protocol: 3, readOnly: false } });
		expect((await v3.ask(Kind.list, { path: "" }))!.body).toEqual({ entries: [], next: null });
		expect(await v3.ask(Kind.symlink, { path: "mine", target: "plan.md" })).toEqual({
			kind: Kind.error,
			body: { code: "BAD_REQUEST", message: "Unknown request" },
		});
		expect(await v3.next()).toBeUndefined();
		// The view goes on serving the machine's other connection.
		expect((await v4.ask(Kind.list, { path: "" }))!.kind).toBe(Kind.listing);
	});
});
