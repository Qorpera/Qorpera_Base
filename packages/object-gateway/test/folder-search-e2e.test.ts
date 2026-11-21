import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CoreEntry } from "../src/folder-service/core.ts";
import { MountGrants } from "../src/folder-service/mounts.ts";
import { NasObjects } from "../src/folder-service/objects.ts";
import { type BridgeInfo, ErrorCode, ProtocolError, type SearchRequest } from "../src/folder-service/protocol.ts";
import { linearRegexAvailable, SearchPatternError } from "../src/folder-service/regex.ts";
import { searchView } from "../src/folder-service/search.ts";
import { NativeSearchWorker, searchViewNative } from "../src/folder-service/search-native.ts";
import { FolderService, SEARCH_RUNNING_NATIVE } from "../src/folder-service/service.ts";
import { ViewTree } from "../src/folder-service/view-tree.ts";
import { ENV, FakeCore, folder, hashOf, link, MACHINE, PROFILE, storeFile, v } from "./folder-service-fixtures.ts";

const program = process.env.QORPERA_FOLDER_MOUNT_BIN;
const cleanup: (() => Promise<void> | void)[] = [];

afterEach(async () => {
	for (const done of cleanup.splice(0).reverse()) await done();
});

const RUN_BOX_VIEW = "5ea8c000-0001-4a00-8b00-000000000001";
const RUN_BOX_PASS = "search-pass-0123456789-abcdefghijklmnopqrst";
const EXEC_BRIDGE: BridgeInfo = { cid: 77, lookup: "found", machine: MACHINE };

async function makeTempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "qorpera-search-e2e-"));
	cleanup.push(() => rm(dir, { recursive: true, force: true }));
	return dir;
}

function makeTree(entries: readonly CoreEntry[]): ViewTree {
	const tree = new ViewTree();
	for (const entry of entries) tree.put(entry);
	return tree;
}

function makeRequest(overrides: Partial<SearchRequest> = {}): SearchRequest {
	return {
		version: 2,
		query: "alpha",
		regex: false,
		path: "",
		glob: null,
		namesOnly: false,
		filesOnly: false,
		caseSensitive: false,
		context: 0,
		after: null,
		...overrides,
	};
}

async function waitForExit(pid: number, timeoutMs = 4_000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			process.kill(pid, 0);
		} catch {
			return true;
		}
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	return false;
}

describe.skipIf(!program)("native Rust search-worker E2E", () => {
	it("advertises regex: true in FolderService hello without V8 experimental regex flag and handles literal + regex + v1/v2", async () => {
		const root = await makeTempDir();
		const core = new FakeCore();
		const planText = [
			"intro line",
			"second line",
			"target ALPHA item",
			"after one",
			"after two",
			"ΟΔΟΣ ΚΟΣΜΟΣ",
			"kelvin \u212A",
			"turkish \u0130stanbul",
			"",
			"final line",
		].join("\n");
		core.seed([
			folder("docs", 10),
			await storeFile(root, "docs/plan.md", planText, 11, 64),
			await storeFile(root, "docs/code.ts", "export function computeTotal(x: number) { return x + 1; }\n", 12, 64),
			await storeFile(root, "docs/bin.dat", Buffer.from([0x61, 0x6c, 0x70, 0x68, 0x61, 0x00, 0x62]), 13, 64),
			link("docs/latest", "plan.md", 14),
		]);
		core.openView(RUN_BOX_VIEW, RUN_BOX_PASS);
		const objects = new NasObjects({ root, cacheBytes: 1024 * 1024 });
		const service = new FolderService({
			core,
			objects,
			grants: new MountGrants([], [MACHINE]),
			folderProgram: program!,
			searchIndexMiB: 16,
			searchThreads: 4,
			log: () => {},
		});
		cleanup.push(() => service.stop());

		const handle = await service.open(
			{ protocol: 4, environmentId: ENV, viewId: RUN_BOX_VIEW, pass: RUN_BOX_PASS, role: "io" },
			EXEC_BRIDGE,
		);
		cleanup.push(() => handle.release());

		expect(handle.searchSupport).toEqual({ version: 2, regex: true });

		const literal = await handle.search(makeRequest({ query: "alpha", context: 2 }));
		expect(literal.hits).toHaveLength(1);
		expect(literal.hits[0]).toMatchObject({
			path: "docs/plan.md",
			line: 3,
			text: "target ALPHA item",
			before: ["intro line", "second line"],
			after: ["after one", "after two"],
		});
		expect(literal.searched).toBe(2);
		expect(literal.binary).toBe(1);
		expect(literal.unreadable).toBe(0);
		expect(literal.reads.map((r) => r.path)).toEqual(["docs", "docs/bin.dat", "docs/code.ts", "docs/plan.md"]);

		const warmMiss = await handle.search(makeRequest({ query: "never_present_anywhere_xyz" }));
		expect(warmMiss.hits).toEqual([]);
		expect(warmMiss.searched).toBe(2);
		expect(warmMiss.binary).toBe(1);
		expect(warmMiss.reads.map((r) => r.path)).toEqual(["docs", "docs/bin.dat", "docs/code.ts", "docs/plan.md"]);

		const regexHit = await handle.search(
			makeRequest({ query: "function\\s+compute[A-Z]\\w+", regex: true, caseSensitive: true }),
		);
		expect(regexHit.hits).toHaveLength(1);
		expect(regexHit.hits[0]).toMatchObject({ path: "docs/code.ts", line: 1 });
		expect(regexHit.reads.map((r) => r.path)).toEqual(["docs", "docs/bin.dat", "docs/code.ts", "docs/plan.md"]);

		const sigma = await handle.search(makeRequest({ query: "κοσμος", regex: true, caseSensitive: false }));
		expect(sigma.hits).toHaveLength(1);
		expect(sigma.hits[0]?.line).toBe(6);

		const emptyLine = await handle.search(makeRequest({ query: "^$", regex: true, path: "docs/plan.md" }));
		expect(emptyLine.hits).toHaveLength(1);
		expect(emptyLine.hits[0]?.line).toBe(9);

		const v1 = await handle.search(makeRequest({ version: 1, query: "computeTotal" }));
		expect(v1.hits).toHaveLength(1);
		expect("files" in v1).toBe(false);
		expect("longLines" in v1).toBe(false);

		const filesOnly = await handle.search(makeRequest({ query: "line", filesOnly: true }));
		expect(filesOnly.hits).toEqual([]);
		expect(filesOnly.files).toEqual([{ path: "docs/plan.md", version: v(11), count: 3 }]);

		const namesFind = await handle.search(makeRequest({ query: null, namesOnly: true, glob: "*.ts" }));
		expect(namesFind.hits).toHaveLength(1);
		expect(namesFind.hits[0]).toMatchObject({ path: "docs/code.ts", line: 0 });

		const linkHit = await handle.search(makeRequest({ query: "latest", namesOnly: true }));
		expect(linkHit.hits).toHaveLength(1);
		expect(linkHit.hits[0]).toMatchObject({ path: "docs/latest", kind: "symlink", target: "plan.md" });

		await expect(handle.search(makeRequest({ query: "(a)\\1", regex: true }))).rejects.toMatchObject({
			code: ErrorCode.badRequest,
			message: expect.stringMatching(/^REGEX_BACKREFERENCE: /),
		});
	});

	it("matches JS searchView exactly across cold and warm trigram passes, Unicode folding, regex, pagination, context, long lines, globs, and provenance reads", async () => {
		const root = await makeTempDir();
		const lines = Array.from({ length: 40 }, (_, i) =>
			i % 5 === 2 ? `item_${i} needle MATCH_${i} end` : `plain line ${i} without term`,
		).join("\n");
		const unicodeText = ["kelvin \u212A value", "turkish \u0130stanbul city", "ΟΔΟΣ ΚΟΣΜΟΣ", "plain ascii line"].join(
			"\n",
		);
		const tree = makeTree([
			folder("src", 1),
			folder("src/sub", 2),
			await storeFile(root, "src/a.ts", `${lines}\n`, 3, 128),
			await storeFile(root, "src/nomatch.txt", "unrelated content for skip\n", 7, 1024),
			await storeFile(root, "src/sub/b.ts", `${"x".repeat(45)}\n${"x".repeat(30)}\nneedle here\n`, 4, 32),
			await storeFile(root, "src/sub/c.bin", Buffer.from("needle\0binary\n"), 5, 32),
			link("src/sub/needle-link", "../a.ts", 6),
			await storeFile(root, "src/unicode.txt", `${unicodeText}\n`, 8, 1024),
		]);
		const objects = new NasObjects({ root, cacheBytes: 1024 * 1024 });
		const worker = new NativeSearchWorker({
			folderProgram: program!,
			storageRoot: root,
			indexMiB: 16,
			threads: 2,
		});
		cleanup.push(() => worker.close());

		const cases: { req: SearchRequest; pieceBytes?: number; longestLine?: number; links?: boolean }[] = [
			{ req: makeRequest({ query: "needle", context: 2 }), links: true },
			{ req: makeRequest({ query: "needle", context: 2 }), pieceBytes: 64, links: true },
			{ req: makeRequest({ query: "MATCH_", caseSensitive: true, filesOnly: true }), links: true },
			{ req: makeRequest({ query: "MATCH_", caseSensitive: true, filesOnly: true }), pieceBytes: 64, links: true },
			{ req: makeRequest({ query: "never_exists_in_any_file_trigram_skip" }), links: true },
			{ req: makeRequest({ query: "kelvin k value", caseSensitive: false }), links: true },
			{ req: makeRequest({ query: "KELVIN \u212A VALUE", caseSensitive: false }), links: true },
			{ req: makeRequest({ query: "i\u0307stanbul", caseSensitive: false }), links: true },
			{ req: makeRequest({ query: "οδος κοσμος", caseSensitive: false }), links: true },
			{ req: makeRequest({ query: "needle", glob: "sub/*.ts" }), links: true },
			{ req: makeRequest({ query: "needle", namesOnly: true }), links: true },
			{ req: makeRequest({ query: "needle", namesOnly: true }), links: false },
			{ req: makeRequest({ version: 1, query: "needle" }), links: true },
		];

		for (const tc of cases) {
			const jsAnswer = await searchView(
				{
					tree,
					links: tc.links ?? true,
					read: (entry, offset, length) => objects.read(PROFILE, entry, offset, length),
					now: Date.now,
					...(tc.pieceBytes === undefined ? {} : { pieceBytes: tc.pieceBytes }),
					...(tc.longestLine === undefined ? {} : { longestLine: tc.longestLine }),
				},
				tc.req,
			);
			const source = {
				tree,
				links: tc.links ?? true,
				resolveProfile: async () => PROFILE,
				now: Date.now,
				...(tc.pieceBytes === undefined ? {} : { pieceBytes: tc.pieceBytes }),
				...(tc.longestLine === undefined ? {} : { longestLine: tc.longestLine }),
			};
			const coldAnswer = await searchViewNative(worker, source, tc.req);
			expect(coldAnswer).toEqual(jsAnswer);
			const warmAnswer = await searchViewNative(worker, source, tc.req);
			expect(warmAnswer).toEqual(jsAnswer);
		}

		const regexCases: {
			req: SearchRequest;
			longestLine?: number;
			expectedPaths: string[];
			expectedLines: number[];
			expectedLongLines: number;
		}[] = [
			{
				req: makeRequest({ query: "^x+$", regex: true }),
				longestLine: 40,
				expectedPaths: ["src/sub/b.ts"],
				expectedLines: [2],
				expectedLongLines: 1,
			},
			{
				req: makeRequest({ query: "kelvin\\s+k\\s+value", regex: true, caseSensitive: false }),
				expectedPaths: ["src/unicode.txt"],
				expectedLines: [1],
				expectedLongLines: 0,
			},
			{
				req: makeRequest({ query: "οδος\\s+κοσμος", regex: true, caseSensitive: false }),
				expectedPaths: ["src/unicode.txt"],
				expectedLines: [3],
				expectedLongLines: 0,
			},
			{
				req: makeRequest({ query: "zzzz_regex_warm_skip_[0-9]+", regex: true }),
				longestLine: 40,
				expectedPaths: [],
				expectedLines: [],
				expectedLongLines: 1,
			},
		];
		const expectedAllReadPaths = [
			"src",
			"src/a.ts",
			"src/nomatch.txt",
			"src/sub",
			"src/sub/b.ts",
			"src/sub/c.bin",
			"src/unicode.txt",
		];
		for (const rc of regexCases) {
			const source = {
				tree,
				links: true,
				resolveProfile: async () => PROFILE,
				now: Date.now,
				...(rc.longestLine === undefined ? {} : { longestLine: rc.longestLine }),
			};
			const cold = await searchViewNative(worker, source, rc.req);
			const warm = await searchViewNative(worker, source, rc.req);
			expect(warm).toEqual(cold);
			expect(cold.hits.map((h) => h.path)).toEqual(rc.expectedPaths);
			expect(cold.hits.map((h) => h.line)).toEqual(rc.expectedLines);
			expect(cold.longLines).toBe(rc.expectedLongLines);
			expect(cold.searched).toBe(4);
			expect(cold.binary).toBe(1);
			expect(cold.reads.map((r) => r.path)).toEqual(expectedAllReadPaths);
			if (linearRegexAvailable()) {
				const jsRegex = await searchView(
					{
						tree,
						links: true,
						read: (entry, offset, length) => objects.read(PROFILE, entry, offset, length),
						now: Date.now,
						...(rc.longestLine === undefined ? {} : { longestLine: rc.longestLine }),
					},
					rc.req,
				);
				expect(cold).toEqual(jsRegex);
			}
		}
	});

	it("enforces linear-time regex immunity, all REGEX_* errors, tampered chunks, and missing profile dir", async () => {
		const root = await makeTempDir();
		const evil = await storeFile(root, "evil.txt", `${"a".repeat(32)}c\n`, 1, 1024);
		const good = await storeFile(root, "good.txt", "hello world\n", 2, 1024);
		const bad = await storeFile(root, "tampered.txt", "hello tampered\n", 3, 1024);
		await writeFile(join(root, PROFILE, hashOf("hello tampered\n")), "corrupted bytes");

		const tree = makeTree([evil, good, bad]);
		const worker = new NativeSearchWorker({
			folderProgram: program!,
			storageRoot: root,
			indexMiB: 8,
			threads: 2,
		});
		cleanup.push(() => worker.close());

		const start = performance.now();
		const redos = await searchViewNative(
			worker,
			{ tree, resolveProfile: async () => PROFILE, now: Date.now },
			makeRequest({ query: "(a|aa)*(a*)*b", regex: true, path: "evil.txt" }),
		);
		expect(redos.hits).toEqual([]);
		expect(performance.now() - start).toBeLessThan(2_000);

		const errorCases: [string, string][] = [
			["(a)\\1", "REGEX_BACKREFERENCE: "],
			["(?=a)a", "REGEX_LOOKAROUND: "],
			["(?i)a", "REGEX_FLAGS: "],
			["\\p{L}", "REGEX_ESCAPE: "],
			["[[:alpha:]]", "REGEX_SYNTAX: "],
			["\\k<x>", "REGEX_BACKREFERENCE: "],
			["\\q", "REGEX_ESCAPE: "],
			["[unclosed", "REGEX_SYNTAX: "],
			["a{17}", "REGEX_TOO_LARGE: "],
			["(a{1,10}){1,10}", "REGEX_TOO_LARGE: "],
		];
		for (const [pattern, prefix] of errorCases) {
			let caught: unknown;
			try {
				await searchViewNative(
					worker,
					{ tree, resolveProfile: async () => PROFILE, now: Date.now },
					makeRequest({ query: pattern, regex: true }),
				);
			} catch (error) {
				caught = error;
			}
			expect(caught).toBeInstanceOf(SearchPatternError);
			expect((caught as Error).message.startsWith(prefix), pattern).toBe(true);
		}

		const logs: string[] = [];
		const scanned = await searchViewNative(
			worker,
			{ tree, resolveProfile: async () => PROFILE, now: Date.now, log: (l) => logs.push(l) },
			makeRequest({ query: "hello" }),
		);
		expect(scanned.hits.map((h) => h.path)).toEqual(["good.txt"]);
		expect(scanned.unreadable).toBe(1);
		expect(scanned.searched).toBe(2);
		expect(scanned.reads.map((r) => r.path)).toEqual(["evil.txt", "good.txt"]);
		expect(logs).toHaveLength(1);

		await rm(join(root, PROFILE), { recursive: true, force: true });
		await expect(
			searchViewNative(
				worker,
				{ tree, resolveProfile: async () => PROFILE, now: Date.now },
				makeRequest({ query: "never_matches_warm_cache" }),
			),
		).rejects.toThrow("The company's objects are not on the storage server now");
	});

	it("runs 16 parallel searches concurrently off-event-loop, respawns after SIGKILL, and exits cleanly on stop", async () => {
		const root = await makeTempDir();
		const core = new FakeCore();
		const seeded = [folder("repo", 1)];
		for (let i = 0; i < 200; i++) {
			seeded.push(
				await storeFile(
					root,
					`repo/file_${String(i).padStart(3, "0")}.ts`,
					`export const token_${i} = "payload_${i}";\n`,
					10 + i,
					4096,
				),
			);
		}
		core.seed(seeded);
		core.openView(RUN_BOX_VIEW, RUN_BOX_PASS);
		const objects = new NasObjects({ root, cacheBytes: 1024 * 1024 });
		const service = new FolderService({
			core,
			objects,
			grants: new MountGrants([], [MACHINE]),
			folderProgram: program!,
			searchIndexMiB: 32,
			searchThreads: 4,
			log: () => {},
		});
		cleanup.push(() => service.stop());

		const handle = await service.open(
			{ protocol: 4, environmentId: ENV, viewId: RUN_BOX_VIEW, pass: RUN_BOX_PASS, role: "io" },
			EXEC_BRIDGE,
		);
		cleanup.push(() => handle.release());

		expect(SEARCH_RUNNING_NATIVE).toBe(16);
		const parallel = await Promise.all(
			Array.from({ length: SEARCH_RUNNING_NATIVE }, (_, i) =>
				handle.search(makeRequest({ query: `token_${i * 10}\\b`, regex: true })),
			),
		);
		for (let i = 0; i < SEARCH_RUNNING_NATIVE; i++) {
			expect(parallel[i]?.hits).toHaveLength(1);
			expect(parallel[i]?.hits[0]?.path).toBe(`repo/file_${String(i * 10).padStart(3, "0")}.ts`);
			expect(parallel[i]?.reads).toHaveLength(201);
		}

		const worker = new NativeSearchWorker({
			folderProgram: program!,
			storageRoot: root,
			indexMiB: 8,
			threads: 2,
			log: () => {},
		});
		const tree = makeTree(seeded.slice(0, 5));
		const first = await searchViewNative(
			worker,
			{ tree, resolveProfile: async () => PROFILE, now: Date.now },
			makeRequest({ query: "token_0" }),
		);
		expect(first.hits).toHaveLength(1);
		tree.put(await storeFile(root, "repo/added_after_sync.ts", 'export const fresh_sync_token = "ok";\n', 999, 4096));
		const afterMutate = await searchViewNative(
			worker,
			{ tree, resolveProfile: async () => PROFILE, now: Date.now },
			makeRequest({ query: "fresh_sync_token" }),
		);
		expect(afterMutate.hits.map((h) => h.path)).toEqual(["repo/added_after_sync.ts"]);
		const pid1 = worker.pid!;
		expect(pid1).toBeGreaterThan(0);

		process.kill(pid1, "SIGKILL");
		expect(await waitForExit(pid1)).toBe(true);

		const recovered = await searchViewNative(
			worker,
			{ tree, resolveProfile: async () => PROFILE, now: Date.now },
			makeRequest({ query: "token_1" }),
		);
		expect(recovered.hits).toHaveLength(1);
		const pid2 = worker.pid!;
		expect(pid2).toBeGreaterThan(0);
		expect(pid2).not.toBe(pid1);

		worker.close();
		expect(await waitForExit(pid2)).toBe(true);
		await expect(
			searchViewNative(
				worker,
				{ tree, resolveProfile: async () => PROFILE, now: Date.now },
				makeRequest({ query: "token_0" }),
			),
		).rejects.toThrow("closed");
		expect(new ProtocolError(ErrorCode.unavailable, "x").code).toBe(ErrorCode.unavailable);
	});

	it("handles 16 concurrent searches under continuous live tree mutations and delta rollover without snapshot failures", async () => {
		const root = await makeTempDir();
		const seeded: CoreEntry[] = [
			folder("repo", 1),
			await storeFile(root, "repo/sentinel.ts", 'export const ALWAYS_PRESENT_SENTINEL = "ok";\n', 2, 4096),
		];
		for (let i = 0; i < 120; i++) {
			seeded.push(
				await storeFile(
					root,
					`repo/item_${String(i).padStart(3, "0")}.ts`,
					`export const val_${i} = "initial_${i}";\n`,
					10 + i,
					4096,
				),
			);
		}
		const tree = makeTree(seeded);
		const objects = new NasObjects({ root, cacheBytes: 1024 * 1024 });
		const worker = new NativeSearchWorker({
			folderProgram: program!,
			storageRoot: root,
			indexMiB: 8,
			threads: 4,
			log: () => {},
		});
		cleanup.push(() => worker.close());

		const preparedUpdates: CoreEntry[] = [];
		for (let m = 0; m < 40; m++) {
			preparedUpdates.push(
				await storeFile(
					root,
					`repo/live_${String(m).padStart(2, "0")}.ts`,
					`export const live_token_${m} = "mutated_${m}";\n`,
					1_000 + m,
					4096,
				),
			);
		}

		let mutating = true;
		const mutator = (async () => {
			for (let m = 0; m < preparedUpdates.length; m++) {
				tree.put(preparedUpdates[m]!);
				if (m % 4 === 0) tree.remove(`repo/item_${String(m).padStart(3, "0")}.ts`);
				await new Promise((resolve) => setTimeout(resolve, 2));
			}
			mutating = false;
		})();

		const searchLoops = Array.from({ length: SEARCH_RUNNING_NATIVE }, (_, lane) =>
			(async () => {
				let runs = 0;
				while (mutating || runs < 3) {
					const req =
						lane % 3 === 0
							? makeRequest({ query: "ALWAYS_PRESENT_SENTINEL", regex: false })
							: lane % 3 === 1
								? makeRequest({ query: "ALWAYS_PRESENT_[A-Z]+", regex: true })
								: makeRequest({ query: "sentinel", namesOnly: true });
					const ans = await searchViewNative(
						worker,
						{ tree, links: true, resolveProfile: async () => PROFILE, now: Date.now },
						req,
					);
					expect(ans.hits.some((h) => h.path === "repo/sentinel.ts")).toBe(true);
					runs++;
				}
			})(),
		);

		await Promise.all([mutator, ...searchLoops]);

		const finalReq = makeRequest({ query: "mutated_" });
		const finalRust = await searchViewNative(
			worker,
			{ tree, links: true, resolveProfile: async () => PROFILE, now: Date.now },
			finalReq,
		);
		const finalJs = await searchView(
			{
				tree,
				links: true,
				read: (entry, offset, length) => objects.read(PROFILE, entry, offset, length),
				now: Date.now,
			},
			finalReq,
		);
		expect(finalRust).toEqual(finalJs);
		expect(finalRust.hits).toHaveLength(40);

		const rolloverEntry = await storeFile(root, "repo/rollover_marker.ts", "rollover_final_token\n", 9_999, 4096);
		for (let i = 0; i < 600; i++) {
			tree.put({ ...rolloverEntry, path: `repo/rollover_${i % 10}.ts`, version: v(2_000 + i) });
		}
		tree.put(rolloverEntry);
		expect(tree.changesSince(1)).toBeUndefined();
		const afterRollover = await searchViewNative(
			worker,
			{ tree, links: true, resolveProfile: async () => PROFILE, now: Date.now },
			makeRequest({ query: "rollover_final_token" }),
		);
		const jsAfterRollover = await searchView(
			{
				tree,
				links: true,
				read: (entry, offset, length) => objects.read(PROFILE, entry, offset, length),
				now: Date.now,
			},
			makeRequest({ query: "rollover_final_token" }),
		);
		expect(afterRollover).toEqual(jsAfterRollover);
		expect(afterRollover.hits.some((h) => h.path === "repo/rollover_marker.ts")).toBe(true);
	});
});
