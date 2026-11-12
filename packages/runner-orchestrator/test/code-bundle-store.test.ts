import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	symlinkSync,
	truncateSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	CODE_BUNDLE_FOLDER,
	CODE_BUNDLES_KEPT,
	type CodeBundleFacts,
	type CodeBundleStore,
	type CodeBundleStoreOptions,
	type CodeBundleTarget,
	codeBundleName,
	createCodeBundleStore,
} from "../src/code-bundle-store.ts";
import {
	CODE_IMPORT_BUNDLE_SCHEMA,
	type CodeImportBundleFacts,
	type CodeImportBundleStore,
	codeImportBundleName,
} from "../src/code-import.ts";

const COMPANY = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const ENVIRONMENT = "33333333-3333-4333-8333-333333333333";
const TARGET: CodeBundleTarget = { companyId: COMPANY, owner: "acme", name: "app" };
const MAIN = "a".repeat(40);
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
/** The n-th second of the night of 11 Nov 2026, as a bundle's time. */
const at = (n: number) => new Date(Date.UTC(2026, 10, 11, 2, 0, n)).toISOString();

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup(options: Partial<CodeBundleStoreOptions> = {}) {
	// The store's folder is made in a parent that exists, as on the storage.
	const parent = realpathSync(mkdtempSync(join(tmpdir(), "code-bundle-store-")));
	dirs.push(parent);
	const root = join(parent, CODE_BUNDLE_FOLDER);
	const storage = { mounted: true, asserted: 0 };
	const store = createCodeBundleStore({
		root,
		assert: async () => {
			storage.asserted += 1;
			if (!storage.mounted) throw new Error("CODING_STORAGE_MOUNT_UNCONFIRMED");
		},
		...options,
	});
	return { parent, root, store, storage, folder: join(root, COMPANY, "acme", "app") };
}

function facts(bytes: Uint8Array, createdAt: string, extra: Partial<CodeBundleFacts> = {}): CodeBundleFacts {
	return {
		environmentId: ENVIRONMENT,
		createdAt,
		gitVersion: "2.56.0",
		mainSha: MAIN,
		refsSha256: "c".repeat(64),
		refs: [
			{ name: "refs/heads/main", sha: MAIN },
			{ name: "refs/qorpera/kept-here", sha: "b".repeat(40) },
		],
		sha256: digest(bytes),
		bytes: bytes.length,
		executorOwner: "coding-node-1",
		...extra,
	};
}

/** One bundle through a writer, in two pieces. */
async function put(store: CodeBundleStore, target: CodeBundleTarget, text: string, createdAt: string) {
	const bytes = Buffer.from(text);
	const writer = await store.begin(target, { expectedBytes: bytes.length });
	await writer.write(bytes.subarray(0, 3));
	await writer.write(bytes.subarray(3));
	const name = codeBundleName(createdAt, MAIN);
	return { name, manifest: await writer.commit(name, facts(bytes, createdAt)) };
}

const mode = (path: string) => statSync(path).mode & 0o7777;

describe("createCodeBundleStore", () => {
	it("stores a bundle and its manifest in the repository's folder, named by its time and main's commit, its own alone", async () => {
		const { root, store, folder, storage } = setup();
		expect(codeBundleName("2026-11-11T02:14:55.000Z", `0123456789abcdef${"0".repeat(24)}`)).toBe(
			"20261111T021455Z-0123456789ab",
		);
		for (const [time, main] of [
			["2026-11-11T02:14:55Z", MAIN],
			["yesterday", MAIN],
			[at(0), "main"],
			[at(0), MAIN.toUpperCase()],
		])
			expect(() => codeBundleName(time, main)).toThrow("INVALID_CODE_BUNDLE");

		const { name, manifest } = await put(store, TARGET, "a bundle of every ref", at(0));
		expect(name).toBe("20261111T020000Z-aaaaaaaaaaaa");
		expect(readdirSync(folder).sort()).toEqual([`${name}.bundle`, `${name}.json`]);
		expect(readFileSync(join(folder, `${name}.bundle`), "utf8")).toBe("a bundle of every ref");
		expect(manifest).toEqual({
			schema: "qorpera.code-bundle/v1",
			companyId: COMPANY,
			environmentId: ENVIRONMENT,
			repository: { host: "qorpera", owner: "acme", name: "app", baseBranch: "main" },
			createdAt: at(0),
			gitVersion: "2.56.0",
			mainSha: MAIN,
			refsSha256: "c".repeat(64),
			refs: [
				{ name: "refs/heads/main", sha: MAIN },
				{ name: "refs/qorpera/kept-here", sha: "b".repeat(40) },
			],
			refsCount: 2,
			sha256: digest(Buffer.from("a bundle of every ref")),
			bytes: 21,
			verified: true,
			executorOwner: "coding-node-1",
		});
		expect(JSON.parse(readFileSync(join(folder, `${name}.json`), "utf8"))).toEqual(manifest);
		for (const file of readdirSync(folder)) expect(mode(join(folder, file))).toBe(0o600);
		for (const dir of [root, join(root, COMPANY), join(root, COMPANY, "acme"), folder]) expect(mode(dir)).toBe(0o700);
		// The storage was checked before the writer began and before the bundle got its name.
		expect(storage.asserted).toBe(2);

		await expect(store.find(TARGET, name)).resolves.toEqual(manifest);
		await expect(store.verify(TARGET, name)).resolves.toEqual(manifest);
		await expect(store.find(TARGET, codeBundleName(at(1), MAIN))).resolves.toBeNull();
		await expect(store.find({ ...TARGET, name: "other" }, name)).resolves.toBeNull();
		await expect(store.find({ ...TARGET, companyId: OTHER }, name)).resolves.toBeNull();
		// Another repository's folder was not made by asking.
		expect(readdirSync(join(root, COMPANY, "acme"))).toEqual(["app"]);
		expect(readdirSync(root)).toEqual([COMPANY]);

		// A file of the manifest's size with other bytes: found, but not verified.
		writeFileSync(join(folder, `${name}.bundle`), "A bundle of every ref");
		await expect(store.find(TARGET, name)).resolves.toEqual(manifest);
		await expect(store.verify(TARGET, name)).resolves.toBeNull();
		truncateSync(join(folder, `${name}.bundle`), 5);
		await expect(store.find(TARGET, name)).resolves.toBeNull();
		await expect(store.verify(TARGET, name)).resolves.toBeNull();
	});

	it("lists at most 2,000 refs in a manifest, and says how many there were", async () => {
		const { store } = setup();
		const bytes = Buffer.from("bundle");
		const refs = Array.from({ length: 2003 }, (_, i) => ({
			name: `refs/heads/b${String(i).padStart(4, "0")}`,
			sha: MAIN,
		}));
		const writer = await store.begin(TARGET);
		await writer.write(bytes);
		const manifest = await writer.commit(codeBundleName(at(0), MAIN), facts(bytes, at(0), { refs }));
		expect(manifest.refs).toHaveLength(2000);
		expect(manifest.refs.at(-1)).toEqual({ name: "refs/heads/b1999", sha: MAIN });
		expect(manifest.refsCount).toBe(2003);
		await expect(store.find(TARGET, codeBundleName(at(0), MAIN))).resolves.toEqual(manifest);
	});

	it("never overwrites a stored bundle or a manifest", async () => {
		const { store, folder } = setup();
		const { name } = await put(store, TARGET, "the first", at(0));
		await expect(put(store, TARGET, "the second", at(0))).rejects.toThrow("CODE_BUNDLE_EXISTS");
		expect(readdirSync(folder).sort()).toEqual([`${name}.bundle`, `${name}.json`]);
		expect(readFileSync(join(folder, `${name}.bundle`), "utf8")).toBe("the first");
		expect(JSON.parse(readFileSync(join(folder, `${name}.json`), "utf8")).bytes).toBe(9);

		// A manifest's name already taken: the bundle's name this commit gave goes again, and the manifest stays as it was.
		const taken = codeBundleName(at(1), MAIN);
		writeFileSync(join(folder, `${taken}.json`), "someone's", { mode: 0o600 });
		await expect(put(store, TARGET, "the third", at(1))).rejects.toThrow("CODE_BUNDLE_EXISTS");
		expect(readdirSync(folder).sort()).toEqual([`${name}.bundle`, `${name}.json`, `${taken}.json`]);
		expect(readFileSync(join(folder, `${taken}.json`), "utf8")).toBe("someone's");
		await expect(store.find(TARGET, taken)).resolves.toBeNull();
	});

	it("stores nothing unless the bytes that came have the SHA-256 and the size the code host reported", async () => {
		const { store, folder } = setup();
		const bytes = Buffer.from("what the code host hashed");
		const name = codeBundleName(at(0), MAIN);
		const wrong: Partial<CodeBundleFacts>[] = [
			{ sha256: digest(Buffer.from("something else")) },
			{ bytes: bytes.length + 1 },
			{ bytes: bytes.length - 1 },
		];
		for (const extra of wrong) {
			const writer = await store.begin(TARGET);
			await writer.write(bytes);
			await expect(writer.commit(name, facts(bytes, at(0), extra))).rejects.toThrow("CODE_BUNDLE_DIFFERS");
			expect(readdirSync(folder)).toEqual([]);
			// The writer is over.
			await expect(writer.write(bytes)).rejects.toThrow("CODE_BUNDLE_WRITER_CLOSED");
			await expect(writer.commit(name, facts(bytes, at(0)))).rejects.toThrow("CODE_BUNDLE_WRITER_CLOSED");
			await writer.abort();
		}
		// A piece left out.
		const short = await store.begin(TARGET);
		await short.write(bytes.subarray(0, 10));
		await expect(short.commit(name, facts(bytes, at(0)))).rejects.toThrow("CODE_BUNDLE_DIFFERS");
		// Facts that are no bundle's, and a name that is not the facts' own.
		const invalid: [string, Partial<CodeBundleFacts>][] = [
			[codeBundleName(at(1), MAIN), {}],
			["../escape", {}],
			[name, { environmentId: "not-a-uuid" }],
			[name, { refsSha256: "c".repeat(63) }],
			[name, { sha256: "nothing" }],
			[name, { refs: [{ name: "refs/heads/main" } as never] }],
			[name, { refs: "refs/heads/main" as never }],
			[name, { bytes: 0 }],
		];
		for (const [as, extra] of invalid) {
			const writer = await store.begin(TARGET);
			await writer.write(bytes);
			await expect(writer.commit(as, facts(bytes, at(0), extra))).rejects.toThrow("INVALID_CODE_BUNDLE");
			expect(readdirSync(folder)).toEqual([]);
		}
		// More than the writer takes.
		const capped = await store.begin(TARGET, { maximumBytes: 30 });
		await capped.write(bytes);
		await expect(capped.write(bytes)).rejects.toThrow("CODE_BUNDLE_TOO_LARGE");
		await expect(capped.commit(name, facts(bytes, at(0)))).rejects.toThrow("CODE_BUNDLE_WRITER_CLOSED");
		expect(readdirSync(folder)).toHaveLength(1);
		await capped.abort();
		await capped.abort();
		expect(readdirSync(folder)).toEqual([]);
		// A caller that stopped waiting for a piece ends the writer too.
		const stopped = await store.begin(TARGET);
		const controller = new AbortController();
		const reason = new Error("the job yielded");
		controller.abort(reason);
		await expect(stopped.write(bytes, controller.signal)).rejects.toBe(reason);
		await expect(stopped.commit(name, facts(bytes, at(0)))).rejects.toThrow("CODE_BUNDLE_WRITER_CLOSED");
		await stopped.abort();
		expect(readdirSync(folder)).toEqual([]);
		await expect(store.find(TARGET, name)).resolves.toBeNull();
	});

	it("hands a stored bundle out for a restore: its manifest, and exactly its bytes in pieces of 1 MiB, read as they are taken", async () => {
		const { store, folder, storage } = setup();
		// Two whole pieces and a part of one.
		const bytes = randomBytes(2 * 1024 ** 2 + 4321),
			name = codeBundleName(at(0), MAIN);
		const writer = await store.begin(TARGET, { expectedBytes: bytes.length });
		await writer.write(bytes);
		const manifest = await writer.commit(name, facts(bytes, at(0)));
		/** The files this process holds open in the repository's folder. */
		const held = () =>
			readdirSync("/proc/self/fd").filter((fd) => {
				try {
					return realpathSync(join("/proc/self/fd", fd)).startsWith(folder);
				} catch {
					return false;
				}
			}).length;

		const asserted = storage.asserted;
		const read = await store.read(TARGET, name);
		expect(read.manifest).toEqual(manifest);
		// Nothing is opened before a piece is taken.
		expect(held()).toBe(0);
		expect(storage.asserted).toBe(asserted + 1);
		const pieces: Buffer[] = [];
		for await (const piece of read.pieces) {
			pieces.push(Buffer.from(piece));
			expect(held()).toBe(1);
		}
		expect(pieces.map((piece) => piece.length)).toEqual([1024 ** 2, 1024 ** 2, 4321]);
		expect(digest(Buffer.concat(pieces))).toBe(manifest.sha256);
		expect(held()).toBe(0);
		// The storage was checked again when the file was opened.
		expect(storage.asserted).toBe(asserted + 2);
		// A second pass reads the file again.
		const again: Buffer[] = [];
		for await (const piece of read.pieces) again.push(Buffer.from(piece));
		expect(Buffer.concat(again).equals(bytes)).toBe(true);

		// A reader that stops lets the file go.
		for await (const piece of read.pieces) {
			expect(piece.length).toBe(1024 ** 2);
			break;
		}
		await store.companies();
		expect(held()).toBe(0);
		// So does one whose caller gave up between two pieces, with the caller's own reason.
		const gone = new AbortController(),
			reason = new Error("the job yielded");
		const stopped = (await store.read(TARGET, name, gone.signal)).pieces[Symbol.asyncIterator]();
		expect((await stopped.next()).done).toBe(false);
		gone.abort(reason);
		await expect(stopped.next()).rejects.toBe(reason);
		await store.companies();
		expect(held()).toBe(0);

		// What `find` does not answer is not handed out: no such bundle, another repository's or company's name for it.
		for (const [target, bundle] of [
			[TARGET, codeBundleName(at(1), MAIN)],
			[{ ...TARGET, name: "other" }, name],
			[{ ...TARGET, companyId: OTHER }, name],
		] as const)
			await expect(store.read(target, bundle)).rejects.toThrow("CODE_BUNDLE_MISSING");
		expect(readdirSync(join(folder, ".."))).toEqual(["app"]);
		for (const bad of ["", "../x", `${name}.bundle`])
			await expect(store.read(TARGET, bad)).rejects.toThrow("INVALID_CODE_BUNDLE");
		await expect(store.read({ ...TARGET, owner: ".." }, name)).rejects.toThrow("INVALID_CODE_BUNDLE");
		// A file cut short after it was found: the pieces fail, and nothing of another size is handed out as the bundle.
		const late = await store.read(TARGET, name);
		truncateSync(join(folder, `${name}.bundle`), 10);
		await expect(
			(async () => {
				for await (const _ of late.pieces) throw new Error("a piece came");
			})(),
		).rejects.toThrow("CODE_BUNDLE_DIFFERS");
		expect(held()).toBe(0);
		await expect(store.read(TARGET, name)).rejects.toThrow("CODE_BUNDLE_MISSING");
		// A link where the bundle was is no stored bundle.
		rmSync(join(folder, `${name}.bundle`));
		writeFileSync(join(folder, "elsewhere"), bytes, { mode: 0o600 });
		symlinkSync(join(folder, "elsewhere"), join(folder, `${name}.bundle`));
		await expect(store.read(TARGET, name)).rejects.toThrow("CODE_BUNDLE_MISSING");
		storage.mounted = false;
		await expect(store.read(TARGET, name)).rejects.toThrow("CODING_STORAGE_MOUNT_UNCONFIRMED");
	});

	it("closes a bundle's file that is opened after its reader stopped waiting", async () => {
		// The storage's check can be made to hang (a hard mount that stalls), one use at a time.
		const stalls: (() => void)[] = [];
		let stalling = false;
		const { store, folder } = setup({
			assert: () =>
				new Promise<void>((resolve) => {
					if (stalling) stalls.push(resolve);
					else resolve();
				}),
		});
		const kept = await put(store, TARGET, "a stored bundle", at(0));
		/** The files this process holds open in the repository's folder. */
		const held = () =>
			readdirSync("/proc/self/fd").filter((fd) => {
				try {
					return realpathSync(join("/proc/self/fd", fd)).startsWith(folder);
				} catch {
					return false;
				}
			}).length;
		const gone = new AbortController();
		const read = await store.read(TARGET, kept.name, gone.signal);
		// The first piece is asked for, and the check before the file is opened hangs. Another use waits behind it.
		stalling = true;
		const first = read.pieces[Symbol.asyncIterator]().next();
		await vi.waitFor(() => expect(stalls).toHaveLength(1));
		const behind = store.companies();
		// The reader gives up (its job yielded) while the file is being opened.
		gone.abort(new Error("the job yielded"));
		await expect(first).rejects.toThrow("the job yielded");
		expect(held()).toBe(0);
		// The check answers. The work goes on and opens the file nobody waits for.
		stalls[0]?.();
		await vi.waitFor(() => expect(stalls).toHaveLength(2));
		expect(held()).toBe(1);
		// The use behind it ends, and then the store closes the file: the close is owed, and waited its turn in the line.
		// By the end of the use after it, the file is closed.
		stalling = false;
		stalls[1]?.();
		await expect(behind).resolves.toEqual([COMPANY]);
		await store.companies();
		expect(held()).toBe(0);
		// The bundle is still handed out whole.
		const pieces: Buffer[] = [];
		for await (const piece of (await store.read(TARGET, kept.name)).pieces) pieces.push(Buffer.from(piece));
		expect(Buffer.concat(pieces).toString()).toBe("a stored bundle");
		expect(held()).toBe(0);

		// The same for a reader whose wait ran out: the file opened after that is closed too.
		const slow = setup({
			stepMs: 500,
			assert: () =>
				new Promise<void>((resolve) => {
					if (stalling) stalls.push(resolve);
					else resolve();
				}),
		});
		const late = await put(slow.store, TARGET, "a stored bundle", at(0));
		const slowly = await slow.store.read(TARGET, late.name);
		stalls.length = 0;
		stalling = true;
		await expect(slowly.pieces[Symbol.asyncIterator]().next()).rejects.toThrow("CODE_BUNDLE_STORE_TIMEOUT");
		stalling = false;
		stalls[0]?.();
		// The use behind the open, and then one behind the close.
		await slow.store.companies();
		await slow.store.companies();
		expect(
			readdirSync("/proc/self/fd").filter((fd) => {
				try {
					return realpathSync(join("/proc/self/fd", fd)).startsWith(slow.folder);
				} catch {
					return false;
				}
			}),
		).toEqual([]);
	});

	it("removes what a dead write left at the repository's next begin, and nothing else", async () => {
		const { store, folder } = setup();
		const kept = await put(store, TARGET, "stored", at(0));
		// A process that died while it wrote, and one that died between a bundle's name and its manifest's.
		const half = join(folder, `.write-${randomUUID()}`);
		const orphan = `${codeBundleName(at(1), MAIN)}.bundle`;
		writeFileSync(half, "half a bund", { mode: 0o600 });
		writeFileSync(join(folder, orphan), "a bundle without its manifest", { mode: 0o600 });
		// Not the store's to judge: left alone.
		writeFileSync(join(folder, "README"), "an operator's note", { mode: 0o600 });
		writeFileSync(join(folder, ".write-not-a-uuid"), "?", { mode: 0o600 });

		const first = await store.begin(TARGET);
		expect(existsSync(half)).toBe(false);
		expect(existsSync(join(folder, orphan))).toBe(false);
		const open = readdirSync(folder).filter((name) => /^\.write-[0-9a-f-]{36}$/.test(name));
		expect(open).toHaveLength(1);
		expect(
			readdirSync(folder)
				.filter((name) => !open.includes(name))
				.sort(),
		).toEqual([".write-not-a-uuid", `${kept.name}.bundle`, `${kept.name}.json`, "README"].sort());
		// A second writer's begin leaves the first one's file.
		const second = await store.begin(TARGET);
		expect(existsSync(join(folder, open[0] as string))).toBe(true);
		expect(readdirSync(folder).filter((name) => /^\.write-[0-9a-f-]{36}$/.test(name))).toHaveLength(2);
		await first.abort();
		await second.abort();
		expect(readdirSync(folder).filter((name) => /^\.write-[0-9a-f-]{36}$/.test(name))).toEqual([]);
		await expect(store.verify(TARGET, kept.name)).resolves.toEqual(kept.manifest);
	});

	it("keeps the newest stored bundles, prunes only right after a new one is stored, and never removes the last good one", async () => {
		const { store, folder } = setup();
		expect(CODE_BUNDLES_KEPT).toBe(7);
		// Nothing stored through this store yet.
		await expect(store.prune(TARGET, CODE_BUNDLES_KEPT)).rejects.toThrow("CODE_BUNDLE_PRUNE_NOT_NOW");
		const names: string[] = [];
		for (let n = 0; n < 7; n++) {
			names.push((await put(store, TARGET, `bundle ${n}`, at(n))).name);
			await expect(store.prune(TARGET, CODE_BUNDLES_KEPT)).resolves.toEqual([]);
		}
		await expect(store.prune(TARGET, CODE_BUNDLES_KEPT)).rejects.toThrow("CODE_BUNDLE_PRUNE_NOT_NOW");
		expect(readdirSync(folder)).toHaveLength(14);
		// Two more without a prune between them: both of the oldest go at the next one.
		names.push((await put(store, TARGET, "bundle 7", at(7))).name);
		names.push((await put(store, TARGET, "bundle 8", at(8))).name);
		await expect(store.prune(TARGET, CODE_BUNDLES_KEPT)).resolves.toEqual([names[1], names[0]]);
		expect(readdirSync(folder).sort()).toEqual(
			names
				.slice(2)
				.flatMap((name) => [`${name}.bundle`, `${name}.json`])
				.sort(),
		);
		for (const name of names.slice(2)) await expect(store.verify(TARGET, name)).resolves.not.toBeNull();

		// Another repository's and another company's bundles are not this one's to prune.
		const beside = await put(store, { ...TARGET, name: "site" }, "bundle", at(0));
		const theirs = await put(store, { ...TARGET, companyId: OTHER }, "bundle", at(0));
		// A bundle whose file was cut, and one whose manifest is no manifest, are not stored bundles: they count for
		// nothing, and are left for an operator to look at.
		truncateSync(join(folder, `${names[8]}.bundle`), 2);
		writeFileSync(join(folder, `${names[7]}.json`), "{}");
		// The clock went back: the new bundle sorts before all the others, and stays.
		const early = await put(
			store,
			TARGET,
			"bundle from an earlier clock",
			new Date(Date.UTC(2026, 10, 10)).toISOString(),
		);
		await expect(store.prune(TARGET, 1)).resolves.toEqual([names[5], names[4], names[3], names[2]]);
		expect(readdirSync(folder).sort()).toEqual(
			[names[6], names[7], names[8], early.name].flatMap((name) => [`${name}.bundle`, `${name}.json`]).sort(),
		);
		await expect(store.verify(TARGET, names[6] as string)).resolves.not.toBeNull();
		await expect(store.verify(TARGET, early.name)).resolves.toEqual(early.manifest);
		await expect(store.verify({ ...TARGET, name: "site" }, beside.name)).resolves.toEqual(beside.manifest);
		await expect(store.verify({ ...TARGET, companyId: OTHER }, theirs.name)).resolves.toEqual(theirs.manifest);

		// A new bundle that did not land whole does not count as one: the newest whole one still stays.
		const broken = await put(store, TARGET, "bundle 9", at(9));
		truncateSync(join(folder, `${broken.name}.bundle`), 1);
		await expect(store.prune(TARGET, 1)).resolves.toEqual([early.name]);
		await expect(store.verify(TARGET, names[6] as string)).resolves.not.toBeNull();
		const last = await put(store, TARGET, "bundle 10", at(10));
		truncateSync(join(folder, `${last.name}.bundle`), 1);
		truncateSync(join(folder, `${names[6]}.bundle`), 1);
		await expect(store.prune(TARGET, 1)).resolves.toEqual([]);
		for (const keep of [0, -1, 1.5, 1001])
			await expect(store.prune(TARGET, keep)).rejects.toThrow("INVALID_CODE_BUNDLE");
	});

	it("takes down a writer that comes after its begin's caller stopped waiting, with its file", async () => {
		// The storage's check hangs past the begin's time (a hard mount that stalls), then answers.
		let release: () => void = () => undefined;
		const hung = new Promise<void>((resolve) => {
			release = resolve;
		});
		let checks = 0;
		const { store, folder } = setup({
			stepMs: 2_000,
			assert: async () => {
				checks += 1;
				if (checks === 1) await hung;
			},
		});
		await expect(store.begin(TARGET)).rejects.toThrow("CODE_BUNDLE_STORE_TIMEOUT");
		// The work goes on: it opens the file nobody waits for, and the store removes it again.
		release();
		const kept = await put(store, TARGET, "stored", at(0));
		await expect(store.find(TARGET, kept.name)).resolves.toEqual(kept.manifest);
		await vi.waitFor(() => expect(readdirSync(folder).sort()).toEqual([`${kept.name}.bundle`, `${kept.name}.json`]));
		// And no later begin steps around a file of the lost writer's: a dead write's leftover is swept as before.
		const half = join(folder, `.write-${randomUUID()}`);
		writeFileSync(half, "half a bund", { mode: 0o600 });
		await (await store.begin(TARGET)).abort();
		expect(readdirSync(folder).sort()).toEqual([`${kept.name}.bundle`, `${kept.name}.json`]);

		// The same for a caller that gives up by its own signal while the work is under way.
		checks = 0;
		let let2: () => void = () => undefined;
		const second = new Promise<void>((resolve) => {
			let2 = resolve;
		});
		const other = setup({
			assert: async () => {
				checks += 1;
				if (checks === 1) await second;
			},
		});
		const gone = new AbortController();
		const begun = other.store.begin(TARGET, {}, gone.signal);
		await vi.waitFor(() => expect(checks).toBe(1));
		gone.abort(new Error("the caller left"));
		await expect(begun).rejects.toThrow("the caller left");
		let2();
		await expect(other.store.companies()).resolves.toEqual([COMPANY]);
		await vi.waitFor(() => expect(readdirSync(other.folder)).toEqual([]));
		await (await other.store.begin(TARGET)).abort();
		expect(readdirSync(other.folder)).toEqual([]);

		// Another use stands in the line before the lost writer's removal, and stalls for longer than a step may take:
		// the removal is owed, so it waits its turn and is not given up.
		const stalls: (() => void)[] = [];
		const queued = setup({
			stepMs: 500,
			assert: () =>
				new Promise<void>((resolve) => {
					if (stalls.length < 2) stalls.push(resolve);
					else resolve();
				}),
		});
		const left = new AbortController();
		const lost = expect(queued.store.begin(TARGET, {}, left.signal)).rejects.toThrow("the caller left");
		const behind = expect(queued.store.companies()).rejects.toThrow("CODE_BUNDLE_STORE_TIMEOUT");
		await vi.waitFor(() => expect(stalls).toHaveLength(1));
		left.abort(new Error("the caller left"));
		await lost;
		stalls[0]?.();
		// The second use is under way, behind it the removal; the writer's file is there.
		await vi.waitFor(() => expect(stalls).toHaveLength(2));
		expect(readdirSync(queued.folder).filter((name) => /^\.write-[0-9a-f-]{36}$/.test(name))).toHaveLength(1);
		await behind;
		await new Promise((resolve) => setTimeout(resolve, 600));
		expect(readdirSync(queued.folder)).toHaveLength(1);
		stalls[1]?.();
		await vi.waitFor(() => expect(readdirSync(queued.folder)).toEqual([]));
		// A writer whose own abort waited too long is told so, and its file goes all the same.
		const slow = await queued.store.begin(TARGET);
		stalls.length = 1;
		const stalled = expect(queued.store.companies()).rejects.toThrow("CODE_BUNDLE_STORE_TIMEOUT");
		await vi.waitFor(() => expect(stalls).toHaveLength(2));
		await expect(slow.abort()).rejects.toThrow("CODE_BUNDLE_STORE_TIMEOUT");
		await stalled;
		expect(readdirSync(queued.folder)).toHaveLength(1);
		stalls[1]?.();
		await vi.waitFor(() => expect(readdirSync(queued.folder)).toEqual([]));
	});

	it("checks the storage before a writer begins and before a bundle gets its name", async () => {
		const { parent, root, store, storage, folder } = setup();
		storage.mounted = false;
		await expect(store.begin(TARGET)).rejects.toThrow("CODING_STORAGE_MOUNT_UNCONFIRMED");
		await expect(store.companies()).rejects.toThrow("CODING_STORAGE_MOUNT_UNCONFIRMED");
		await expect(store.removeCompany(COMPANY)).rejects.toThrow("CODING_STORAGE_MOUNT_UNCONFIRMED");
		await expect(store.find(TARGET, codeBundleName(at(0), MAIN))).rejects.toThrow("CODING_STORAGE_MOUNT_UNCONFIRMED");
		// Nothing was made under the unmounted share.
		expect(readdirSync(parent)).toEqual([]);

		storage.mounted = true;
		const bytes = Buffer.from("bundle");
		const writer = await store.begin(TARGET);
		await writer.write(bytes);
		storage.mounted = false;
		const name = codeBundleName(at(0), MAIN);
		await expect(writer.commit(name, facts(bytes, at(0)))).rejects.toThrow("CODING_STORAGE_MOUNT_UNCONFIRMED");
		expect(readdirSync(folder)).toEqual([]);
		storage.mounted = true;
		await expect(store.find(TARGET, name)).resolves.toBeNull();
		expect(existsSync(root)).toBe(true);
	});

	it("refuses a begin without twice the expected bytes free, and folders that are not its own", async () => {
		const { root, store, folder } = setup();
		await expect(store.begin(TARGET, { expectedBytes: 2 ** 50 })).rejects.toThrow("CODE_BUNDLE_NO_SPACE");
		expect(readdirSync(folder)).toEqual([]);
		for (const options of [{ expectedBytes: -1 }, { expectedBytes: 1.5 }, { maximumBytes: 0 }])
			await expect(store.begin(TARGET, options)).rejects.toThrow("INVALID_CODE_BUNDLE");
		// A folder others can enter is not the store's.
		chmodSync(join(root, COMPANY), 0o755);
		await expect(store.begin(TARGET)).rejects.toThrow("CODE_BUNDLE_STORE_UNSAFE");
		await expect(store.find(TARGET, codeBundleName(at(0), MAIN))).rejects.toThrow("CODE_BUNDLE_STORE_UNSAFE");
		chmodSync(join(root, COMPANY), 0o700);
		await (await store.begin(TARGET)).abort();
		// Nor is one reached through a link.
		const { root: linked, parent, store: other } = setup();
		const elsewhere = join(parent, "elsewhere");
		mkdirSync(elsewhere, { mode: 0o700 });
		mkdirSync(linked, { mode: 0o700 });
		symlinkSync(elsewhere, join(linked, COMPANY));
		await expect(other.begin(TARGET)).rejects.toThrow("CODE_BUNDLE_STORE_UNSAFE");
		expect(readdirSync(elsewhere)).toEqual([]);
	});

	it("removes exactly one company's folder, and nothing outside the store", async () => {
		const { parent, root, store } = setup();
		const mine = await put(store, TARGET, "bundle", at(0));
		await put(store, { ...TARGET, name: "site" }, "bundle", at(0));
		const theirs = await put(store, { ...TARGET, companyId: OTHER }, "bundle", at(0));
		// What lies beside the store, and what is in it without being a company's folder.
		mkdirSync(join(parent, "folder-views"), { mode: 0o700 });
		writeFileSync(join(parent, "folder-views", "record.json"), "{}");
		writeFileSync(join(root, "notes"), "an operator's");
		await expect(store.companies()).resolves.toEqual([COMPANY, OTHER]);

		for (const id of [
			"",
			"*",
			"..",
			`../${COMPANY}`,
			`${COMPANY}/`,
			`${COMPANY}/acme`,
			"AAAAAAAA-1111-4111-8111-111111111111",
			"notes",
		])
			await expect(store.removeCompany(id)).rejects.toThrow("INVALID_CODE_BUNDLE");
		await expect(store.removeCompany(COMPANY)).resolves.toBe(true);
		expect(readdirSync(root).sort()).toEqual([OTHER, "notes"].sort());
		expect(readdirSync(join(parent, "folder-views"))).toEqual(["record.json"]);
		await expect(store.verify({ ...TARGET, companyId: OTHER }, theirs.name)).resolves.toEqual(theirs.manifest);
		await expect(store.find(TARGET, mine.name)).resolves.toBeNull();
		await expect(store.removeCompany(COMPANY)).resolves.toBe(false);
		await expect(store.companies()).resolves.toEqual([OTHER]);
		// A removed company's repository can no longer be pruned on the strength of an old commit.
		await expect(store.prune(TARGET, 7)).rejects.toThrow("CODE_BUNDLE_PRUNE_NOT_NOW");

		// A link named like a company's folder is not one: it stays, and so does what it points at.
		const outside = join(parent, "outside");
		mkdirSync(outside, { mode: 0o700 });
		writeFileSync(join(outside, "keep"), "kept");
		symlinkSync(outside, join(root, COMPANY));
		await expect(store.removeCompany(COMPANY)).rejects.toThrow("CODE_BUNDLE_STORE_UNSAFE");
		expect(readFileSync(join(outside, "keep"), "utf8")).toBe("kept");
		expect(readdirSync(root).sort()).toEqual([COMPANY, OTHER, "notes"].sort());
		// A link inside a company's folder goes as a link.
		rmSync(join(root, COMPANY));
		symlinkSync(outside, join(root, OTHER, "acme", "linked"));
		await expect(store.removeCompany(OTHER)).resolves.toBe(true);
		expect(readFileSync(join(outside, "keep"), "utf8")).toBe("kept");
		expect(readdirSync(root)).toEqual(["notes"]);

		// A store whose folder was never made has no companies.
		const empty = setup();
		await expect(empty.store.companies()).resolves.toEqual([]);
		await expect(empty.store.removeCompany(COMPANY)).resolves.toBe(false);
		expect(existsSync(empty.root)).toBe(false);
	});

	it("runs one use at a time within its deadline, and waits for a use still pending", async () => {
		let hang = true;
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let running = 0,
			most = 0;
		const { store } = setup({
			stepMs: 40,
			assert: async () => {
				most = Math.max(most, ++running);
				if (hang) await gate;
				running -= 1;
			},
		});
		await expect(store.companies()).rejects.toThrow("CODE_BUNDLE_STORE_TIMEOUT");
		hang = false;
		// The first use's check is still pending on the storage: the next one waits for it, and runs out of time too.
		await expect(store.companies()).rejects.toThrow("CODE_BUNDLE_STORE_TIMEOUT");
		const controller = new AbortController();
		const waiting = store.companies(controller.signal);
		const reason = new Error("the pass stopped");
		controller.abort(reason);
		await expect(waiting).rejects.toBe(reason);
		release();
		await expect(store.companies()).resolves.toEqual([]);
		expect(most).toBe(1);
	});

	it("refuses a root that is not a code-bundles folder, and targets and names that are not a repository's or a bundle's", async () => {
		const bad: unknown[] = [
			"code-bundles",
			"/code-bundles",
			"/srv/control",
			"/srv/control/code-bundles/",
			"/srv/control/../code-bundles",
			"/srv/control/code-bundles/x",
			undefined,
		];
		for (const root of bad)
			expect(() => createCodeBundleStore({ root: root as string })).toThrow("INVALID_CODE_BUNDLE_STORE");
		for (const ms of [0, 1.5, 86_400_001])
			expect(() => createCodeBundleStore({ root: "/srv/control/code-bundles", stepMs: ms })).toThrow(
				"INVALID_CODE_BUNDLE_STORE",
			);
		const { store } = setup();
		const targets: unknown[] = [
			{ ...TARGET, companyId: "company" },
			{ ...TARGET, owner: ".." },
			{ ...TARGET, owner: "Acme" },
			{ ...TARGET, name: "../app" },
			{ ...TARGET, name: "a/b" },
			{ ...TARGET, name: "" },
			{ ...TARGET, name: "app." },
			undefined,
		];
		for (const target of targets) {
			await expect(store.begin(target as CodeBundleTarget)).rejects.toThrow("INVALID_CODE_BUNDLE");
			await expect(store.prune(target as CodeBundleTarget, 7)).rejects.toThrow("INVALID_CODE_BUNDLE");
			await expect(store.find(target as CodeBundleTarget, codeBundleName(at(0), MAIN))).rejects.toThrow(
				"INVALID_CODE_BUNDLE",
			);
		}
		for (const name of ["", "x", "../x", "20261111T020000Z-aaaaaaaaaaaa.bundle", "20261111T020000Z-AAAAAAAAAAAA"]) {
			await expect(store.find(TARGET, name)).rejects.toThrow("INVALID_CODE_BUNDLE");
			await expect(store.verify(TARGET, name)).rejects.toThrow("INVALID_CODE_BUNDLE");
		}
	});
});

// Step 6, part C2: the first bundle of code brought in, beside the ordinary bundles.

const TAG = "b".repeat(40);

function importFacts(bytes: Uint8Array, createdAt: string, extra: Partial<CodeImportBundleFacts> = {}) {
	return {
		environmentId: ENVIRONMENT,
		createdAt,
		from: { github: "Acme/App" },
		defaultBranch: "main",
		mainSha: MAIN,
		refs: [
			{ name: "refs/heads/main", sha: MAIN },
			{ name: "refs/tags/v1", sha: TAG },
		],
		leftOut: 2,
		sha256: digest(bytes),
		bytes: bytes.length,
		executorOwner: "coding-node-1",
		...extra,
	} as CodeImportBundleFacts;
}

/** One first bundle through an import writer, in two pieces. */
async function putImport(store: CodeBundleStore, target: CodeBundleTarget, text: string, createdAt: string) {
	const bytes = Buffer.from(text);
	const writer = await store.begin(target, { kind: "import", maximumBytes: 1024 ** 2 });
	await writer.write(bytes.subarray(0, 3));
	await writer.write(bytes.subarray(3));
	const name = codeImportBundleName(createdAt, MAIN);
	return { name, bytes, manifest: await writer.commit(name, importFacts(bytes, createdAt)) };
}

const files = (folder: string) => readdirSync(folder).sort();
const both = (name: string) => [`${name}.bundle`, `${name}.json`];
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("the store's import writer", () => {
	it("stores a first bundle under its own name and manifest, never one marked verified", async () => {
		const { store, folder } = setup();
		// What the run needs of the store, the store has.
		const imports: CodeImportBundleStore = store;
		const bytes = Buffer.from("# v2 git bundle\nthe refs and the pack, as the source sent them");
		const writer = await imports.begin(TARGET, { kind: "import", maximumBytes: 1024 });
		await writer.write(bytes.subarray(0, 5));
		await writer.write(bytes.subarray(5));
		const name = codeImportBundleName(at(0), MAIN);
		expect(name).toBe("import-20261111T020000Z-aaaaaaaaaaaa");
		const manifest = await writer.commit(name, importFacts(bytes, at(0)));
		expect(manifest).toEqual({
			schema: CODE_IMPORT_BUNDLE_SCHEMA,
			companyId: COMPANY,
			environmentId: ENVIRONMENT,
			repository: { host: "qorpera", owner: "acme", name: "app" },
			createdAt: at(0),
			from: { github: "Acme/App" },
			defaultBranch: "main",
			mainSha: MAIN,
			refs: [
				{ name: "refs/heads/main", sha: MAIN },
				{ name: "refs/tags/v1", sha: TAG },
			],
			refsCount: 2,
			leftOut: 2,
			sha256: digest(bytes),
			bytes: bytes.length,
			executorOwner: "coding-node-1",
		});
		expect(manifest).not.toHaveProperty("verified");
		expect(files(folder)).toEqual(both(name));
		expect(readFileSync(join(folder, `${name}.bundle`))).toEqual(bytes);
		expect(JSON.parse(readFileSync(join(folder, `${name}.json`), "utf8"))).toEqual(manifest);
		for (const file of both(name)) expect(mode(join(folder, file))).toBe(0o600);

		// A file source, and a header of more than 2,000 refs: the first 2,000 as they came, and their count.
		const refs = [
			{ name: "refs/heads/trunk", sha: MAIN },
			...Array.from({ length: 2_100 }, (_, n) => ({ name: `refs/tags/t${n}`, sha: TAG })),
		];
		const file = await store.begin(TARGET, { kind: "import" });
		await file.write(bytes);
		const fromFile = await file.commit(
			codeImportBundleName(at(1), MAIN),
			importFacts(bytes, at(1), {
				from: { file: "code/_incoming/drop/shop.bundle", branch: "trunk" },
				defaultBranch: "trunk",
				refs,
			}),
		);
		expect(fromFile.from).toEqual({ file: "code/_incoming/drop/shop.bundle", branch: "trunk" });
		expect(fromFile.refs).toEqual(refs.slice(0, 2_000));
		expect(fromFile.refsCount).toBe(2_101);

		// No more than its maximum; a writer a piece failed takes nothing more.
		const small = await store.begin(TARGET, { kind: "import", maximumBytes: 4 });
		await small.write(Buffer.from("1234"));
		await expect(small.write(Buffer.from("5"))).rejects.toThrow("CODE_BUNDLE_TOO_LARGE");
		await expect(small.write(Buffer.from("6"))).rejects.toThrow("CODE_BUNDLE_WRITER_CLOSED");
		await small.abort();

		// Facts that are not an import's store nothing, and the writer's file goes.
		const other = "c".repeat(40);
		const wrong: [string, Partial<CodeImportBundleFacts>][] = [
			[codeBundleName(at(2), MAIN), {}],
			[codeImportBundleName(at(3), MAIN), {}],
			[codeImportBundleName(at(2), other), {}],
			[codeImportBundleName(at(2), MAIN), { refs: [{ name: "refs/tags/v1", sha: TAG }] }],
			[codeImportBundleName(at(2), MAIN), { refs: [{ name: "refs/heads/main", sha: other }] }],
			[codeImportBundleName(at(2), MAIN), { refs: [{ name: "refs/heads/main", sha: "a".repeat(39) }] }],
			[
				codeImportBundleName(at(2), MAIN),
				{ from: { github: "Acme/App", file: "code/_incoming/a/b.bundle" } as never },
			],
			[codeImportBundleName(at(2), MAIN), { from: { github: "Acme/App/x" } }],
			[codeImportBundleName(at(2), MAIN), { from: { file: "code/acme/app/x.bundle" } }],
			[codeImportBundleName(at(2), MAIN), { from: { github: "Acme/App", branch: "a..b" } }],
			[codeImportBundleName(at(2), MAIN), { from: { github: "Acme/App", more: 1 } as never }],
			[codeImportBundleName(at(2), MAIN), { defaultBranch: "a..b", refs: [{ name: "refs/heads/a..b", sha: MAIN }] }],
			[codeImportBundleName(at(2), MAIN), { leftOut: -1 }],
			[codeImportBundleName(at(2), MAIN), { leftOut: 1.5 }],
			[codeImportBundleName(at(2), MAIN), { environmentId: "environment" }],
			[codeImportBundleName(at(2), MAIN), { executorOwner: "x".repeat(201) }],
			[codeImportBundleName(at(2), MAIN), { sha256: "d".repeat(63) }],
		];
		for (const [label, extra] of wrong) {
			const failing = await store.begin(TARGET, { kind: "import" });
			await failing.write(bytes);
			await expect(failing.commit(label, importFacts(bytes, at(2), extra)), label).rejects.toThrow(
				"INVALID_CODE_BUNDLE",
			);
		}
		for (const extra of [{ sha256: digest(Buffer.from("other bytes")) }, { bytes: bytes.length + 1 }]) {
			const failing = await store.begin(TARGET, { kind: "import" });
			await failing.write(bytes);
			await expect(
				failing.commit(codeImportBundleName(at(2), MAIN), importFacts(bytes, at(2), extra)),
			).rejects.toThrow("CODE_BUNDLE_DIFFERS");
		}
		expect(files(folder)).toEqual([...both(name), ...both(codeImportBundleName(at(1), MAIN))].sort());

		// Never over a stored one.
		const again = await store.begin(TARGET, { kind: "import" });
		await again.write(bytes);
		await expect(again.commit(name, importFacts(bytes, at(0)))).rejects.toThrow("CODE_BUNDLE_EXISTS");
		expect(readFileSync(join(folder, `${name}.json`), "utf8")).toBe(`${JSON.stringify(manifest)}\n`);
	});

	it("is never seen by find, verify, read or prune, and its commit lets no prune go on", async () => {
		const { store, folder } = setup();
		const imported = await putImport(store, TARGET, "every ref the source had", at(0));
		await expect(store.prune(TARGET, 1)).rejects.toThrow("CODE_BUNDLE_PRUNE_NOT_NOW");
		await expect(store.find(TARGET, imported.name)).rejects.toThrow("INVALID_CODE_BUNDLE");
		await expect(store.verify(TARGET, imported.name)).rejects.toThrow("INVALID_CODE_BUNDLE");
		await expect(store.read(TARGET, imported.name)).rejects.toThrow("INVALID_CODE_BUNDLE");
		// Under a dated name, an import's files are no ordinary bundle either.
		const dated = codeBundleName(at(5), MAIN);
		for (const suffix of [".bundle", ".json"])
			writeFileSync(join(folder, `${dated}${suffix}`), readFileSync(join(folder, `${imported.name}${suffix}`)), {
				mode: 0o600,
			});
		await expect(store.find(TARGET, dated)).resolves.toBeNull();
		await expect(store.verify(TARGET, dated)).resolves.toBeNull();
		await expect(store.read(TARGET, dated)).rejects.toThrow("CODE_BUNDLE_MISSING");
		rmSync(join(folder, `${dated}.bundle`));
		rmSync(join(folder, `${dated}.json`));

		// Ordinary bundles pruned to the newest: the import's stays, readable.
		const first = await put(store, TARGET, "bundle 1", at(1));
		const second = await put(store, TARGET, "bundle 2", at(2));
		await expect(store.prune(TARGET, 1)).resolves.toEqual([first.name]);
		expect(files(folder)).toEqual([...both(second.name), ...both(imported.name)].sort());
		await expect(store.verify(TARGET, second.name)).resolves.toEqual(second.manifest);
		// And an import's commit after a prune lets no prune go on.
		await putImport(store, TARGET, "a second first bundle", at(3));
		await expect(store.prune(TARGET, 1)).rejects.toThrow("CODE_BUNDLE_PRUNE_NOT_NOW");
		const read = await store.readImport(TARGET, imported.name);
		expect(read.manifest).toEqual(imported.manifest);

		// readImport reads only an import's: an ordinary name is none, and an ordinary manifest under an import's name
		// is no stored first bundle.
		await expect(store.readImport(TARGET, second.name)).rejects.toThrow("INVALID_CODE_BUNDLE");
		const posing = codeImportBundleName(at(6), MAIN);
		for (const suffix of [".bundle", ".json"])
			writeFileSync(join(folder, `${posing}${suffix}`), readFileSync(join(folder, `${second.name}${suffix}`)), {
				mode: 0o600,
			});
		await expect(store.readImport(TARGET, posing)).rejects.toThrow("CODE_BUNDLE_MISSING");
	});

	it("hands a first bundle out in pieces of 1 MiB, exactly its bytes", async () => {
		const { store, folder } = setup();
		const bytes = randomBytes(2.5 * 1024 ** 2);
		const writer = await store.begin(TARGET, { kind: "import", maximumBytes: 3 * 1024 ** 2 });
		for (let at = 0; at < bytes.length; at += 1024 ** 2) await writer.write(bytes.subarray(at, at + 1024 ** 2));
		const name = codeImportBundleName(at(0), MAIN);
		const manifest = await writer.commit(name, importFacts(bytes, at(0)));
		const read = await store.readImport(TARGET, name);
		expect(read.manifest).toEqual(manifest);
		const pieces: Buffer[] = [];
		for await (const piece of read.pieces) pieces.push(Buffer.from(piece));
		expect(pieces.map((piece) => piece.length)).toEqual([1024 ** 2, 1024 ** 2, 0.5 * 1024 ** 2]);
		expect(Buffer.concat(pieces).equals(bytes)).toBe(true);
		// Each pass reads the file again.
		const again: Buffer[] = [];
		for await (const piece of read.pieces) again.push(Buffer.from(piece));
		expect(digest(Buffer.concat(again))).toBe(manifest.sha256);

		await expect(store.readImport(TARGET, codeImportBundleName(at(1), MAIN))).rejects.toThrow("CODE_BUNDLE_MISSING");
		await expect(store.readImport({ ...TARGET, name: "site" }, name)).rejects.toThrow("CODE_BUNDLE_MISSING");
		for (const bad of ["", "import-x", `${name}.bundle`, "import-20261111T020000Z-AAAAAAAAAAAA"])
			await expect(store.readImport(TARGET, bad)).rejects.toThrow("INVALID_CODE_BUNDLE");
		// A manifest marked verified is no first bundle's; a file cut short is none either.
		const json = join(folder, `${name}.json`);
		writeFileSync(json, JSON.stringify({ ...manifest, verified: true }));
		await expect(store.readImport(TARGET, name)).rejects.toThrow("CODE_BUNDLE_MISSING");
		writeFileSync(json, JSON.stringify(manifest));
		await expect(store.readImport(TARGET, name)).resolves.toMatchObject({ manifest });
		truncateSync(join(folder, `${name}.bundle`), bytes.length - 1);
		await expect(store.readImport(TARGET, name)).rejects.toThrow("CODE_BUNDLE_MISSING");
	});

	it("lists every name of both kinds in a repository's folder, whole or not, and removes one, its manifest first", async () => {
		const { store, folder } = setup();
		await expect(store.names(TARGET)).resolves.toEqual([]);
		const ordinary = await put(store, TARGET, "bundle", at(0));
		const imported = await putImport(store, TARGET, "first bundle", at(1));
		const open = await store.begin(TARGET, { kind: "import" });
		const half = codeBundleName(at(2), MAIN);
		writeFileSync(join(folder, `${half}.bundle`), "a bundle whose manifest never came", { mode: 0o600 });
		const lone = codeImportBundleName(at(3), MAIN);
		writeFileSync(join(folder, `${lone}.json`), "{}", { mode: 0o600 });
		writeFileSync(join(folder, "README"), "an operator's note", { mode: 0o600 });
		writeFileSync(join(folder, `${codeBundleName(at(4), MAIN)}.txt`), "not a bundle's", { mode: 0o600 });
		await expect(store.names(TARGET)).resolves.toEqual([ordinary.name, half, imported.name, lone]);
		await expect(store.names({ ...TARGET, name: "site" })).resolves.toEqual([]);

		await expect(store.remove(TARGET, imported.name)).resolves.toBe(true);
		await expect(store.remove(TARGET, imported.name)).resolves.toBe(false);
		await expect(store.remove(TARGET, half)).resolves.toBe(true);
		await expect(store.remove(TARGET, lone)).resolves.toBe(true);
		await expect(store.remove({ ...TARGET, name: "site" }, ordinary.name)).resolves.toBe(false);
		await expect(store.names(TARGET)).resolves.toEqual([ordinary.name]);
		// The bundle a prune would keep for is gone: no prune goes on on its strength.
		await expect(store.remove(TARGET, ordinary.name)).resolves.toBe(true);
		await expect(store.prune(TARGET, 1)).rejects.toThrow("CODE_BUNDLE_PRUNE_NOT_NOW");
		expect(files(folder).filter((name) => !/^\.write-/.test(name))).toEqual(
			["README", `${codeBundleName(at(4), MAIN)}.txt`].sort(),
		);
		await open.abort();
		for (const bad of ["", "x", "../x", "import-x", `${ordinary.name}.json`, "20261111T020000Z-AAAAAAAAAAAA"])
			await expect(store.remove(TARGET, bad)).rejects.toThrow("INVALID_CODE_BUNDLE");
		await expect(store.names({ ...TARGET, owner: "Acme" })).rejects.toThrow("INVALID_CODE_BUNDLE");
	});

	it("sweeps what a dead import left at the repository's next begin, and nothing of a live one", async () => {
		const { store, folder } = setup();
		const imported = await putImport(store, TARGET, "stored", at(0));
		const live = await store.begin(TARGET, { kind: "import" });
		await live.write(Buffer.from("half a fet"));
		const liveFile = files(folder).find((name) => /^\.write-/.test(name)) as string;
		// A process that died while it fetched, and one that died between a first bundle's name and its manifest's.
		const dead = join(folder, `.write-${randomUUID()}`);
		writeFileSync(dead, "half a first bundle", { mode: 0o600 });
		const orphan = `${codeImportBundleName(at(1), MAIN)}.bundle`;
		writeFileSync(join(folder, orphan), "a first bundle without its manifest", { mode: 0o600 });
		await (await store.begin(TARGET)).abort();
		expect(files(folder)).toEqual([liveFile, ...both(imported.name)].sort());
		await live.abort();
		expect(files(folder)).toEqual(both(imported.name));
		await expect(store.readImport(TARGET, imported.name)).resolves.toMatchObject({ manifest: imported.manifest });
	});

	it("writes its pieces in a line of its own: a commit that holds the store's line does not stall them", async () => {
		let hold: Promise<void> | undefined;
		let release: () => void = () => undefined;
		let checks = 0;
		const { store } = setup({
			assert: async () => {
				checks += 1;
				// Only the one check that holds the line: what waits behind it waits for the line alone.
				const held = hold;
				hold = undefined;
				if (held) await held;
			},
		});
		const imported = await store.begin(TARGET, { kind: "import" });
		const ordinary = await store.begin({ ...TARGET, companyId: OTHER });
		const beside = await store.begin({ ...TARGET, name: "site" });
		const bytes = Buffer.from("another company's nightly bundle");
		await ordinary.write(bytes);
		hold = new Promise<void>((resolve) => {
			release = resolve;
		});
		const seen = checks;
		const committing = ordinary.commit(codeBundleName(at(0), MAIN), facts(bytes, at(0)));
		await vi.waitFor(() => expect(checks).toBe(seen + 1));
		// The store's line is held: the import's pieces go on in theirs.
		const pieces = [Buffer.alloc(1024, 1), Buffer.alloc(1024, 2), Buffer.alloc(1024, 3)];
		for (const piece of pieces) await imported.write(piece);
		// An ordinary writer's piece, and the import's own commit, wait in the store's line.
		let wrote = false,
			stored = false;
		const writing = beside.write(Buffer.from("x")).then(() => {
			wrote = true;
		});
		const whole = Buffer.concat(pieces);
		const name = codeImportBundleName(at(1), MAIN);
		const committed = imported.commit(name, importFacts(whole, at(1))).then((manifest) => {
			stored = true;
			return manifest;
		});
		await sleep(300);
		expect([wrote, stored]).toEqual([false, false]);
		hold = undefined;
		release();
		await committing;
		await writing;
		await expect(committed).resolves.toMatchObject({ sha256: digest(whole), bytes: whole.length });
		await beside.abort();
		const read = await store.readImport(TARGET, name);
		const back: Buffer[] = [];
		for await (const piece of read.pieces) back.push(Buffer.from(piece));
		expect(Buffer.concat(back).equals(whole)).toBe(true);
	});

	it("aborts in the store's line, after its own pieces, with its file gone however long the wait", async () => {
		const stalls: (() => void)[] = [];
		let stalling = false;
		const { store, folder } = setup({
			stepMs: 500,
			assert: () =>
				new Promise<void>((resolve) => {
					if (stalling) stalls.push(resolve);
					else resolve();
				}),
		});
		const imported = await store.begin(TARGET, { kind: "import" });
		await imported.write(Buffer.from("some of a pack"));
		// Another use holds the store's line past a step: the abort's caller is told so, and the file still goes.
		stalling = true;
		const behind = expect(store.companies()).rejects.toThrow("CODE_BUNDLE_STORE_TIMEOUT");
		await vi.waitFor(() => expect(stalls).toHaveLength(1));
		stalling = false;
		await expect(imported.abort()).rejects.toThrow("CODE_BUNDLE_STORE_TIMEOUT");
		await behind;
		expect(files(folder).filter((name) => /^\.write-/.test(name))).toHaveLength(1);
		stalls[0]?.();
		await vi.waitFor(() => expect(files(folder)).toEqual([]));
		await expect(imported.write(Buffer.from("more"))).rejects.toThrow("CODE_BUNDLE_WRITER_CLOSED");
	});

	it("refuses options that are no import's", async () => {
		const { store, folder } = setup();
		for (const options of [
			{ kind: "other" },
			{ kind: "import", maximumBytes: 2 * 1024 ** 3 + 1 },
			{ kind: "import", maximumBytes: 0 },
			{ kind: "import", maximumBytes: 1.5 },
			{ kind: "import", expectedBytes: -1 },
		])
			await expect(store.begin(TARGET, options as { kind: "import" })).rejects.toThrow("INVALID_CODE_BUNDLE");
		expect(existsSync(folder)).toBe(false);
		// The store's own cap is the most an operator may set.
		await (await store.begin(TARGET, { kind: "import", maximumBytes: 2 * 1024 ** 3 })).abort();
		for (const name of [codeBundleName(at(0), MAIN), "x"])
			await expect(store.readImport(TARGET, name)).rejects.toThrow("INVALID_CODE_BUNDLE");
		await expect(store.readImport({ ...TARGET, owner: ".." }, codeImportBundleName(at(0), MAIN))).rejects.toThrow(
			"INVALID_CODE_BUNDLE",
		);
	});
});
