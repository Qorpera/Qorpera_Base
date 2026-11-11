import { createHash } from "node:crypto";
import type { CloudCodingRepository } from "@qorpera/contracts";
import { describe, expect, it, vi } from "vitest";
import { type CodeHostGcBlock, type CodeHostJob, CodeHostJobFailure, CodeHostRefusal } from "../src/code-host-jobs.ts";
import { CODE_HOST_LAYOUT, type CodeHostJobOptions, type CodeHostJobs } from "../src/code-host-views.ts";
import {
	CODE_SITE_LIST_BYTES,
	CODE_SITE_LIST_FILES,
	CODE_SITE_MISSING_PATHS,
	CODE_SITE_PART_BYTES,
	CODE_SITE_PUT_PARTS,
	CODE_SITE_REQUEST_BYTES,
	CODE_SITE_RPCS,
	type CodeSiteUploadFile,
	CodeSiteUploads,
	type CodeSiteUploadsOptions,
} from "../src/code-site-uploads.ts";
import { CodingControlBusy } from "../src/coding-executor.ts";
import { watchAbortSignalAny } from "./helpers/abort-any.ts";

const COMPANY = "11111111-1111-4111-8111-111111111111";
const ENVIRONMENT = "33333333-3333-4333-8333-333333333333";
const OWNER = "coding-node-1";
const MACHINE = "d".repeat(64);
const TREE = "a".repeat(40);
const KiB = 1024;
/** The version each repository's begin finds or makes. */
const VERSIONS: Readonly<Record<string, string>> = {
	shop: "44444444-4444-4444-8444-444444444444",
	site: "55555555-5555-4555-8555-555555555555",
};
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const size = (value: unknown) => Buffer.byteLength(JSON.stringify(value));

/** STAND-IN for C1's `codeSiteManifest` and the manifest B's read answers with: `publish_site`'s (site-tools'
 * `manifestOf`), lines `path TAB sha256 TAB bytes` in C order joined by LF, then SHA-256. */
function manifestOf(files: readonly { path: string; sha256: string; bytes: number }[]): string {
	const lines = [...files]
		.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
		.map((entry) => `${entry.path}\t${entry.sha256}\t${entry.bytes}`);
	return createHash("sha256").update(lines.join("\n"), "utf8").digest("hex");
}

/** A file of a site, `bytes` long, its content made from its path. */
function file(path: string, bytes: number): CodeSiteUploadFile {
	const content = new Uint8Array(bytes);
	const seed = createHash("sha256").update(path).digest();
	for (let at = 0; at < bytes; at++) content[at] = (seed[at % 32] as number) ^ (at & 0xff);
	return { path, bytes, sha256: sha256(content), content };
}

/** A site of `count` files of `bytes` each, with its index. */
function small(count: number, bytes = 100): CodeSiteUploadFile[] {
	return [
		file("index.html", 200),
		...Array.from({ length: count - 1 }, (_, at) => file(`a/f${String(at).padStart(3, "0")}.txt`, bytes)),
	];
}

function due(name: string, files: readonly CodeSiteUploadFile[], change = 14): Record<string, unknown> {
	return {
		companyId: COMPANY,
		environmentId: ENVIRONMENT,
		owner: "qorpera",
		name,
		change,
		site: {
			schema: "qorpera.code-site/v1",
			tree: TREE,
			files: files.length,
			bytes: files.reduce((sum, entry) => sum + entry.bytes, 0),
			folder: "dist",
			name: null,
			title: null,
		},
	};
}

interface Row {
	path: string;
	bytes: number;
	sha256: string;
	content: Uint8Array | null;
	parts: Map<number, Uint8Array>;
}
interface Version {
	manifest: { manifestSha256: string; files: number; bytes: number };
	rows: Map<string, Row>;
	listed: boolean;
	state: "uploading" | "ready";
}
type Part = { path: string; part: number; of: number; contentBase64: string };

const BLOCK: CodeHostGcBlock = {
	begin: async () => ({ state: "blocking", held: 0 }),
	end: async () => undefined,
};
const SHELL = {
	run: async () => {
		throw new Error("the stand-ins run no command");
	},
};
const yielded = () => new CodeHostJobFailure("CODE_HOST_JOB_YIELDED", "another job of the company joined the line");

/** The kernel's seven calls as a stand-in that keeps the versions as SQL does (STEP4-BUILD.md section 1), the code
 * hosts' jobs, and B's read of a tree. `trees`: each repository's site, all due, in this order. */
function setup(trees: Record<string, CodeSiteUploadFile[]>, options: Partial<CodeSiteUploadsOptions> = {}) {
	const calls: { method: string; args: Record<string, unknown>; bytes: number }[] = [];
	const answers: number[] = [];
	const schema = (call: string) => `qorpera.code-site-${call}/v1`;
	const refused = (call: string, code: string, path?: string) => ({
		schema: schema(call),
		state: "refused",
		code,
		...(path === undefined ? {} : { path }),
	});
	const kernel = {
		due: Object.entries(trees).map(([name, files]) => due(name, files)) as unknown[],
		/** What begin answers for a repository, in place of the version it keeps. */
		begun: {} as Record<string, Record<string, unknown>>,
		versions: new Map<string, Version>(),
		/** Bytes another version of the site holds, by path: copied in when the listing ends. */
		copies: new Map<string, Uint8Array>(),
		/** A test's own answer for a call, by its method; undefined leaves the usual one. */
		answer: undefined as ((method: string, args: Record<string, unknown>) => unknown) | undefined,
		usual(method: string, args: Record<string, unknown>): unknown {
			if (method === "qorpera_code_sites_due")
				return { schema: "qorpera.code-sites-due/v1", sites: kernel.due.slice(0, args.p_limit as number) };
			if (method === "qorpera_code_site_failed") return { schema: "qorpera.code-site-failed/v1", state: "recorded" };
			if (method === "qorpera_code_site_begin") {
				const name = args.p_name as string;
				const id = VERSIONS[name] as string;
				const forced = kernel.begun[name];
				if (forced) return { schema: schema("begin"), versionId: id, slug: name, ...forced };
				const manifest = args.p_manifest as Version["manifest"];
				expect(Object.keys(manifest).sort()).toEqual(["bytes", "files", "manifestSha256"]);
				let version = kernel.versions.get(id);
				if (!version) {
					version = { manifest, rows: new Map(), listed: false, state: "uploading" };
					kernel.versions.set(id, version);
				}
				return { schema: schema("begin"), state: version.state, versionId: id, slug: name, listed: version.listed };
			}
			const version = kernel.versions.get(args.p_version_id as string);
			if (!version) throw new Error(`no version ${args.p_version_id}`);
			const rows = () => [...version.rows.values()].sort((a, b) => (a.path < b.path ? -1 : 1));
			if (method === "qorpera_code_site_list") {
				const { files, last } = args.p_files as {
					files: { path: string; bytes: number; sha256: string }[];
					last: boolean;
				};
				expect(files.length).toBeLessThanOrEqual(150);
				// A version listed already, or no longer uploading, answers listed and writes nothing (part A).
				if (version.listed || version.state !== "uploading")
					return { schema: schema("list"), state: "listed", missing: rows().filter((row) => !row.content).length };
				for (const entry of files) {
					const row = version.rows.get(entry.path);
					if (row && (row.bytes !== entry.bytes || row.sha256 !== entry.sha256)) {
						version.rows.clear();
						return refused("list", "SITE_FILE_REFUSED", entry.path);
					}
					if (!row) version.rows.set(entry.path, { ...entry, content: null, parts: new Map() });
				}
				const missing = () => rows().filter((row) => !row.content).length;
				if (!last) return { schema: schema("list"), state: "listing", missing: missing() };
				if (
					manifestOf(rows()) !== version.manifest.manifestSha256 ||
					version.rows.size !== version.manifest.files
				) {
					version.rows.clear();
					return refused("list", "SITE_MANIFEST_DIFFERS");
				}
				for (const row of rows()) row.content ??= kernel.copies.get(row.path) ?? null;
				version.listed = true;
				return { schema: schema("list"), state: "listed", missing: missing() };
			}
			if (method === "qorpera_code_site_missing") {
				const after = args.p_after as string | null;
				const left = rows().filter((row) => !row.content && (after === null || row.path > after));
				const page = left.slice(0, args.p_limit as number);
				return {
					schema: schema("missing"),
					missing: page.map((row) => ({ path: row.path, bytes: row.bytes })),
					more: left.length > page.length,
				};
			}
			if (method === "qorpera_code_site_put") {
				let filed = 0;
				for (const part of (args.p_parts as { parts: Part[] }).parts) {
					const row = version.rows.get(part.path);
					if (!row) throw new Error(`no row ${part.path}`);
					row.parts.set(part.part, Buffer.from(part.contentBase64, "base64"));
					if (row.content || row.parts.size !== part.of) continue;
					const joined = Buffer.concat(
						Array.from({ length: part.of }, (_, at) => row.parts.get(at) as Uint8Array),
					);
					row.parts.clear();
					if (joined.byteLength !== row.bytes || sha256(joined) !== row.sha256)
						return refused("put", "SITE_FILE_DIFFERS", row.path);
					row.content = joined;
					filed += 1;
				}
				return { schema: schema("put"), state: "kept", filed };
			}
			if (method === "qorpera_code_site_finish") {
				if (version.state !== "uploading") return { schema: schema("finish"), state: version.state };
				if (!version.listed || rows().some((row) => !row.content))
					return refused("finish", "SITE_UPLOAD_INCOMPLETE");
				version.state = "ready";
				return { schema: schema("finish"), state: "ready", pruned: 0 };
			}
			throw new Error(`not a site call: ${method}`);
		},
		async call(method: string, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
			// As a call over the network: the test's timers run between calls, so a pass that never ends fails its test.
			await new Promise((resolve) => setImmediate(resolve));
			signal.throwIfAborted();
			expect(CODE_SITE_RPCS).toContain(method);
			calls.push({ method, args: structuredClone(args), bytes: size(args) });
			const forced = await kernel.answer?.(method, args);
			const answer = forced !== undefined ? forced : kernel.usual(method, args);
			answers.push(size(answer));
			return answer;
		},
	};
	const runs: { companyId: string; environmentId: string; options: CodeHostJobOptions | undefined }[] = [];
	const hosts: Pick<CodeHostJobs, "run"> = {
		async run<T>(
			companyId: string,
			environmentId: string,
			signal: AbortSignal,
			job: (job: CodeHostJob, gc: CodeHostGcBlock) => Promise<T>,
			jobOptions?: CodeHostJobOptions,
		): Promise<T> {
			runs.push({ companyId, environmentId, options: jobOptions });
			signal.throwIfAborted();
			return await job({ shell: SHELL, layout: CODE_HOST_LAYOUT, signal }, BLOCK);
		},
	};
	const read = vi.fn<CodeSiteUploadsOptions["read"]>(async (_job, value) => {
		const files = trees[value.repository.name];
		if (!files) throw new Error(`no tree for ${value.repository.name}`);
		// In the order git lists them, not C order: the pass sorts.
		return { files: [...files].reverse(), manifestSha256: manifestOf(files) };
	});
	const events: Record<string, unknown>[] = [];
	const uploads = new CodeSiteUploads({
		control: kernel,
		hosts,
		read,
		owner: OWNER,
		machineIdSha256: MACHINE,
		report: (event) => events.push(event),
		...options,
	});
	const of = (method: string) => calls.filter((call) => call.method === method);
	return {
		uploads,
		kernel,
		calls,
		answers,
		runs,
		read,
		events,
		of,
		methods: () => calls.map((call) => call.method.replace("qorpera_code_", "")),
		puts: () => of("qorpera_code_site_put").map((call) => (call.args.p_parts as { parts: Part[] }).parts),
		/** The bytes a repository's version keeps, by path. */
		stored: (name: string) =>
			new Map(
				[...(kernel.versions.get(VERSIONS[name] as string)?.rows.values() ?? [])].map((row) => [
					row.path,
					row.content && Buffer.from(row.content),
				]),
			),
		pass: () => uploads.pass(new AbortController().signal),
		errors: () =>
			events
				.filter((event) => event.event === "code-site-error")
				.map((event) =>
					[
						event.step,
						event.problem,
						event.path,
						event.error === undefined ? undefined : (event.error as Error).message,
					]
						.filter((said) => said !== undefined)
						.join(":"),
				),
	};
}
const WHO = { p_owner: OWNER, p_machine_id_sha256: MACHINE };
const WHICH = { ...WHO, p_environment_id: ENVIRONMENT, p_repository_owner: "qorpera", p_name: "shop" };
const NAMED = { companyId: COMPANY, environmentId: ENVIRONMENT, repository: "qorpera/shop", change: 14 };
const REPOSITORY: CloudCodingRepository = { host: "qorpera", owner: "qorpera", name: "shop", baseBranch: "main" };
const total = (files: readonly CodeSiteUploadFile[]) => files.reduce((sum, entry) => sum + entry.bytes, 0);

describe("CodeSiteUploads", () => {
	it("names the control's seven calls", () => {
		expect(CODE_SITE_RPCS).toEqual([
			"qorpera_code_sites_due",
			"qorpera_code_site_begin",
			"qorpera_code_site_list",
			"qorpera_code_site_missing",
			"qorpera_code_site_put",
			"qorpera_code_site_finish",
			"qorpera_code_site_failed",
		]);
	});

	it("refuses options that are not an uploader's", () => {
		const t = setup({ shop: small(2) });
		const make = (extra: Record<string, unknown>) => () =>
			new CodeSiteUploads({
				control: t.kernel,
				hosts: { run: async () => undefined as never },
				read: t.read,
				owner: OWNER,
				machineIdSha256: MACHINE,
				...extra,
			});
		for (const extra of [
			{ owner: "" },
			{ machineIdSha256: "d".repeat(63) },
			{ read: undefined },
			{ limit: 0 },
			{ limit: 21 },
			{ limit: 1.5 },
		])
			expect(make(extra)).toThrow("INVALID_CODE_SITE_UPLOADS");
		expect(make({ limit: 20 })).not.toThrow();
	});

	it("uploads a site of 400 files: read in a job that yields, listed in three pages, asked in four, put in parts", async () => {
		// 398 small files, a file of 300 KiB and the index: 400 files.
		const big = file("big.js", 300 * KiB);
		const files = [...small(399), big];
		const t = setup({ shop: files });
		await expect(t.pass()).resolves.toEqual({ uploaded: 1, failed: 0 });
		expect(t.runs).toEqual([{ companyId: COMPANY, environmentId: ENVIRONMENT, options: { yields: true } }]);
		expect(t.read).toHaveBeenCalledTimes(1);
		expect(t.read.mock.calls[0]?.[1]).toEqual({ repository: REPOSITORY, tree: TREE });
		expect(t.methods()).toEqual([
			"sites_due",
			"site_begin",
			...Array.from({ length: 3 }, () => "site_list"),
			...Array.from({ length: 4 }, () => "site_missing"),
			...Array.from({ length: 5 }, () => "site_put"),
			"site_finish",
		]);
		expect(t.calls[0]?.args).toEqual({ ...WHO, p_limit: 10 });
		// Begin: the manifest over every file, the count and the bytes, and nothing else.
		expect(t.calls[1]?.args).toEqual({
			...WHICH,
			p_change: 14,
			p_manifest: { manifestSha256: manifestOf(files), files: 400, bytes: total(files) },
		});
		// The listing: 150, 150 and 100 files, in C order, the last page marked.
		const lists = t
			.of("qorpera_code_site_list")
			.map((call) => call.args.p_files as { files: { path: string }[]; last: boolean });
		expect(lists.map((page) => [page.files.length, page.last])).toEqual([
			[150, false],
			[150, false],
			[100, true],
		]);
		const sorted = files.map((entry) => entry.path).sort();
		expect(lists.flatMap((page) => page.files.map((entry) => entry.path))).toEqual(sorted);
		expect(lists[0]?.files[0]).toEqual({ path: "a/f000.txt", bytes: 100, sha256: files[1]?.sha256 });
		// What is missing, a hundred at a time, each page after the one before.
		expect(t.of("qorpera_code_site_missing").map((call) => [call.args.p_after, call.args.p_limit])).toEqual([
			[null, 100],
			["a/f099.txt", 100],
			["a/f199.txt", 100],
			["a/f299.txt", 100],
		]);
		// The small files share one call; the large one goes in four parts, cut at fixed places; its last part and the
		// index share the last call.
		const puts = t.puts();
		expect(puts[0]).toHaveLength(398);
		expect(puts[0]?.every((part) => part.part === 0 && part.of === 1 && part.path.startsWith("a/"))).toBe(true);
		expect(puts.slice(1).map((parts) => parts.map((part) => [part.path, part.part, part.of]))).toEqual([
			[["big.js", 0, 4]],
			[["big.js", 1, 4]],
			[["big.js", 2, 4]],
			[
				["big.js", 3, 4],
				["index.html", 0, 1],
			],
		]);
		expect(puts.slice(1).map((parts) => Buffer.from(parts[0]?.contentBase64 ?? "", "base64").byteLength)).toEqual([
			CODE_SITE_PART_BYTES,
			CODE_SITE_PART_BYTES,
			CODE_SITE_PART_BYTES,
			300 * KiB - 3 * CODE_SITE_PART_BYTES,
		]);
		// Every file is kept whole, byte for byte.
		const stored = t.stored("shop");
		expect(stored.size).toBe(400);
		for (const entry of files) expect(stored.get(entry.path)?.equals(entry.content)).toBe(true);
		expect(t.of("qorpera_code_site_finish")[0]?.args).toEqual({ ...WHO, p_version_id: VERSIONS.shop });
		expect(t.events).toEqual([
			{ event: "code-site", step: "due", sites: 1 },
			{ event: "code-site", step: "read", ...NAMED, files: 400, bytes: total(files), ms: expect.any(Number) },
			{
				event: "code-site",
				step: "uploaded",
				...NAMED,
				state: "ready",
				versionId: VERSIONS.shop,
				slug: "shop",
				sent: total(files),
				calls: 14,
				files: 400,
				bytes: total(files),
				ms: expect.any(Number),
			},
		]);
		expect(t.kernel.versions.get(VERSIONS.shop as string)?.state).toBe("ready");
	});

	it("sends no request over 120 KiB, and asks nothing whose answer could pass 256 KiB, with the longest paths", async () => {
		// Site paths of 512 bytes, the most a site path is.
		const long = (at: number) =>
			`${String(at).padStart(3, "0")}${"x".repeat(197)}/${"y".repeat(200)}/${"z".repeat(106)}.htm`;
		expect(long(0)).toHaveLength(512);
		const files = [
			file("index.html", 10),
			...Array.from({ length: 300 }, (_, at) => file(long(at), at % 3 ? 7 : 3)),
			...Array.from({ length: 4 }, (_, at) => file(long(300 + at), CODE_SITE_PART_BYTES + at)),
		];
		const t = setup({ shop: files });
		await expect(t.pass()).resolves.toEqual({ uploaded: 1, failed: 0 });
		expect(t.stored("shop").size).toBe(305);
		for (const entry of files) expect(t.stored("shop").get(entry.path)?.equals(entry.content)).toBe(true);
		// Exactly what the control is sent: every request within 120 KiB, every listing within 150 files and 100 KiB.
		expect(Math.max(...t.calls.map((call) => call.bytes))).toBeLessThanOrEqual(CODE_SITE_REQUEST_BYTES);
		for (const call of t.of("qorpera_code_site_list")) {
			expect(call.bytes).toBeLessThanOrEqual(CODE_SITE_LIST_BYTES);
			expect((call.args.p_files as { files: unknown[] }).files.length).toBeLessThanOrEqual(CODE_SITE_LIST_FILES);
		}
		// The small files with long paths are held to the request's bound by their JSON, not their bytes; a whole part
		// with the longest path fits a request alone.
		const puts = t.puts();
		expect(puts.length).toBeGreaterThan(5);
		for (const parts of puts)
			expect(
				parts.reduce((sum, part) => sum + Buffer.from(part.contentBase64, "base64").byteLength, 0),
			).toBeLessThanOrEqual(CODE_SITE_PART_BYTES);
		expect(t.of("qorpera_code_site_put").some((call) => call.bytes > 117 * KiB)).toBe(true);
		// The answers the stand-in gave, and the most each call asked for could ever be: a hundred missing paths of 512
		// bytes, and twenty due sites whose row's site is at its 2 KiB.
		expect(Math.max(...t.answers)).toBeLessThanOrEqual(256 * KiB);
		expect(t.of("qorpera_code_site_missing").every((call) => call.args.p_limit === CODE_SITE_MISSING_PATHS)).toBe(
			true,
		);
		expect(
			size({
				schema: "qorpera.code-site-missing/v1",
				missing: Array.from({ length: CODE_SITE_MISSING_PATHS }, (_, at) => ({
					path: long(at),
					bytes: 10 * 1024 * KiB,
				})),
				more: true,
			}),
		).toBeLessThan(64 * KiB);
		const widest = { ...due("shop", files), site: { schema: "qorpera.code-site/v1", padding: "p".repeat(2048) } };
		expect(
			size({ schema: "qorpera.code-sites-due/v1", sites: Array.from({ length: 20 }, () => widest) }),
		).toBeLessThan(64 * KiB);
		const most = setup({ shop: small(2) }, { limit: 20 });
		await most.pass();
		expect(most.calls[0]?.args.p_limit).toBe(20);
	});

	it("keeps to its bounds even for paths longer than a site's, which the read refuses anyway", async () => {
		// A listing of 150 paths of 1000 bytes is over 100 KiB: it goes in more pages.
		const longer = Array.from({ length: 150 }, (_, at) =>
			file(`${String(at).padStart(3, "0")}${"p".repeat(997)}`, 1),
		);
		const t = setup({ shop: [file("index.html", 10), ...longer] });
		await expect(t.pass()).resolves.toEqual({ uploaded: 1, failed: 0 });
		const lists = t.of("qorpera_code_site_list");
		expect(lists.length).toBeGreaterThanOrEqual(2);
		for (const call of lists) expect(call.bytes).toBeLessThanOrEqual(CODE_SITE_LIST_BYTES);
		expect((lists[0]?.args.p_files as { files: unknown[] }).files.length).toBeLessThan(CODE_SITE_LIST_FILES);
		expect(Math.max(...t.calls.map((call) => call.bytes))).toBeLessThanOrEqual(CODE_SITE_REQUEST_BYTES);
		// A whole part with a path of 3000 bytes would be over 120 KiB: it is not sent, and the site fails.
		const huge = setup({ shop: [file("index.html", 10), file(`${"h".repeat(3000)}.js`, CODE_SITE_PART_BYTES)] });
		await expect(huge.pass()).resolves.toEqual({ uploaded: 0, failed: 1 });
		expect(huge.of("qorpera_code_site_put")).toEqual([]);
		expect(Math.max(...huge.calls.map((call) => call.bytes))).toBeLessThanOrEqual(CODE_SITE_REQUEST_BYTES);
		expect(huge.errors()).toEqual([`put:SITE_UPLOAD_FAILED:${"h".repeat(3000)}.js:CODE_SITE_PART_TOO_LARGE`]);
		// More than 500 files, all empty, would fit one request: a put carries at most the kernel's 500 parts. (The row
		// says 500 here, or the pass would not take it; the stand-in's begin does not count.)
		const empty = setup({
			shop: [file("index.html", 10), ...Array.from({ length: 700 }, (_, at) => file(`e/${at}.txt`, 0))],
		});
		(empty.kernel.due[0] as { site: { files: number } }).site.files = 500;
		await expect(empty.pass()).resolves.toEqual({ uploaded: 1, failed: 0 });
		expect(empty.puts().map((parts) => parts.length)).toEqual([CODE_SITE_PUT_PARTS, 701 - CODE_SITE_PUT_PARTS]);
	});

	it("lists in C order, whatever order the read gave", async () => {
		const files = [file("index.html", 5), file("b.css", 5), file("a/x.js", 5), file("A.txt", 5), file("a-b.js", 5)];
		const t = setup({ shop: files });
		await expect(t.pass()).resolves.toEqual({ uploaded: 1, failed: 0 });
		const listed = (t.of("qorpera_code_site_list")[0]?.args.p_files as { files: { path: string }[] }).files;
		expect(listed.map((entry) => entry.path)).toEqual(["A.txt", "a-b.js", "a/x.js", "b.css", "index.html"]);
		expect(t.puts()).toHaveLength(1);
	});

	it("goes on with an upload that stopped half way: no listing again, only what is missing, the same parts", async () => {
		const files = [
			file("index.html", 300),
			file("app.js", 200 * KiB),
			file("style.css", 4 * KiB),
			file("logo.png", 30 * KiB),
			file("data.json", 1000),
		];
		const t = setup({ shop: files });
		// An earlier pass listed the files, put two, and the first part of app.js.
		const rows = new Map<string, Row>(
			files.map((entry) => [
				entry.path,
				{
					path: entry.path,
					bytes: entry.bytes,
					sha256: entry.sha256,
					content: ["style.css", "logo.png"].includes(entry.path) ? entry.content : null,
					parts: new Map(),
				},
			]),
		);
		const app = files[1] as CodeSiteUploadFile;
		rows.get("app.js")?.parts.set(0, app.content.subarray(0, CODE_SITE_PART_BYTES));
		t.kernel.versions.set(VERSIONS.shop as string, {
			manifest: { manifestSha256: manifestOf(files), files: 5, bytes: total(files) },
			rows,
			listed: true,
			state: "uploading",
		});
		await expect(t.pass()).resolves.toEqual({ uploaded: 1, failed: 0 });
		expect(t.methods()).toEqual([
			"sites_due",
			"site_begin",
			"site_missing",
			"site_put",
			"site_put",
			"site_put",
			"site_finish",
		]);
		expect(t.puts().map((parts) => parts.map((part) => [part.path, part.part, part.of]))).toEqual([
			[["app.js", 0, 3]],
			[["app.js", 1, 3]],
			[
				["app.js", 2, 3],
				["data.json", 0, 1],
				["index.html", 0, 1],
			],
		]);
		for (const entry of files) expect(t.stored("shop").get(entry.path)?.equals(entry.content)).toBe(true);
		expect(t.events.at(-1)).toMatchObject({ step: "uploaded", sent: 200 * KiB + 1300, calls: 6 });

		// A listing after which the kernel had every file (another version of the site holds the same bytes): nothing is
		// asked or put.
		const copied = setup({ shop: files });
		for (const entry of files) copied.kernel.copies.set(entry.path, entry.content);
		await expect(copied.pass()).resolves.toEqual({ uploaded: 1, failed: 0 });
		expect(copied.methods()).toEqual(["sites_due", "site_begin", "site_list", "site_finish"]);
		expect(copied.events.at(-1)).toMatchObject({ step: "uploaded", sent: 0, calls: 3 });

		// The kernel says at the first page that the version is listed already: the listing ends there.
		const many = small(200);
		const early = setup({ shop: many });
		early.kernel.versions.set(VERSIONS.shop as string, {
			manifest: { manifestSha256: manifestOf(many), files: 200, bytes: total(many) },
			rows: new Map(
				many.map((entry, at) => [
					entry.path,
					{ ...entry, content: at % 2 ? entry.content : null, parts: new Map<number, Uint8Array>() },
				]),
			),
			listed: true,
			state: "uploading",
		});
		early.kernel.answer = (method) =>
			method === "qorpera_code_site_begin"
				? {
						schema: "qorpera.code-site-begin/v1",
						state: "uploading",
						versionId: VERSIONS.shop,
						slug: "shop",
						listed: false,
					}
				: undefined;
		await expect(early.pass()).resolves.toEqual({ uploaded: 1, failed: 0 });
		expect(early.methods()).toEqual([
			"sites_due",
			"site_begin",
			"site_list",
			"site_missing",
			"site_put",
			"site_finish",
		]);
		expect((early.puts()[0] ?? []).map((part) => part.path)).toEqual(
			many
				.filter((_, at) => !(at % 2))
				.map((entry) => entry.path)
				.sort(),
		);
		for (const entry of many) expect(early.stored("shop").get(entry.path)?.equals(entry.content)).toBe(true);
	});

	it("is done with a version that is ready, live or kept already", async () => {
		for (const state of ["ready", "live", "kept"]) {
			const t = setup({ shop: small(3) });
			t.kernel.begun.shop = { state };
			await expect(t.pass()).resolves.toEqual({ uploaded: 1, failed: 0 });
			expect(t.methods()).toEqual(["sites_due", "site_begin"]);
			expect(t.events.at(-1)).toMatchObject({
				step: "uploaded",
				state,
				versionId: VERSIONS.shop,
				sent: 0,
				calls: 1,
			});
			expect(t.errors()).toEqual([]);
		}
		// Finish says the version is no longer uploading: as it is.
		const t = setup({ shop: small(3) });
		t.kernel.answer = (method) =>
			method === "qorpera_code_site_finish" ? { schema: "qorpera.code-site-finish/v1", state: "live" } : undefined;
		await expect(t.pass()).resolves.toEqual({ uploaded: 1, failed: 0 });
		expect(t.events.at(-1)).toMatchObject({ step: "uploaded", state: "live" });
	});

	it("tells the kernel each refusal by its code, and goes on to the next site", async () => {
		const cases: [string, Record<string, unknown>, string][] = [
			["begin", { code: "SITE_LIMIT" }, "begin:SITE_LIMIT"],
			["begin", { code: "SITE_NAME_TAKEN" }, "begin:SITE_NAME_TAKEN"],
			["begin", { code: "SITE_ROW_GONE" }, "begin:SITE_ROW_GONE"],
			["begin", { code: "SITE_TREE_DIFFERS" }, "begin:SITE_TREE_DIFFERS"],
			["list", { code: "SITE_MANIFEST_DIFFERS" }, "list:SITE_MANIFEST_DIFFERS"],
			["list", { code: "SITE_FILE_REFUSED", path: "a/f000.txt" }, "list:SITE_FILE_REFUSED:a/f000.txt"],
			["put", { code: "SITE_FILE_DIFFERS", path: "index.html" }, "put:SITE_FILE_DIFFERS:index.html"],
			["finish", { code: "SITE_UPLOAD_INCOMPLETE" }, "finish:SITE_UPLOAD_INCOMPLETE"],
		];
		for (const [step, refusal, said] of cases) {
			const t = setup({ shop: small(3), site: small(2) });
			t.kernel.answer = (method, args) =>
				method === `qorpera_code_site_${step}` && args.p_name !== "site" && args.p_version_id !== VERSIONS.site
					? { schema: `qorpera.code-site-${step}/v1`, state: "refused", ...refusal }
					: undefined;
			await expect(t.pass()).resolves.toEqual({ uploaded: 1, failed: 1 });
			expect(t.of("qorpera_code_site_failed").map((call) => call.args)).toEqual([
				{ ...WHICH, p_change: 14, p_code: refusal.code },
			]);
			expect(t.errors()).toEqual([said]);
			// Nothing after the refusal for that site, and the next one whole.
			const methods = t.methods();
			const failedAt = methods.indexOf("site_failed");
			expect(methods.slice(failedAt + 1, failedAt + 2)).toEqual(["site_begin"]);
			expect(methods.slice(0, failedAt).filter((method) => method === `site_${step}`)).toHaveLength(1);
			expect(t.kernel.versions.get(VERSIONS.site as string)?.state).toBe("ready");
		}
		// The refusals the real kernel keeps: the list's takes the version's rows away, and a part of other bytes fails its
		// file (the stand-in does as SQL does).
		const files = small(3);
		const differs = setup({ shop: files });
		differs.read.mockImplementationOnce(async () => ({
			files: [
				{ ...(files[1] as CodeSiteUploadFile), sha256: "f".repeat(64) },
				files[0] as CodeSiteUploadFile,
				files[2] as CodeSiteUploadFile,
			],
			manifestSha256: manifestOf(files),
		}));
		await expect(differs.pass()).resolves.toEqual({ uploaded: 0, failed: 1 });
		expect(differs.errors()).toEqual(["list:SITE_MANIFEST_DIFFERS"]);
		// A code that is not one the kernel keeps reads as an answer that did not come.
		const odd = setup({ shop: small(3) });
		odd.kernel.begun.shop = { state: "refused", code: "site limit" };
		await expect(odd.pass()).resolves.toEqual({ uploaded: 0, failed: 1 });
		expect(odd.of("qorpera_code_site_failed")[0]?.args.p_code).toBe("SITE_UPLOAD_FAILED");
	});

	it("tells the kernel SITE_UPLOAD_FAILED for a call that did not answer, or answered what the pass cannot read", async () => {
		const steps = ["begin", "list", "missing", "put", "finish"];
		const failures: [string, unknown][] = [
			["throws", new Error("CODING_CONTROL_UNCONFIRMED")],
			["busy", new CodingControlBusy()],
			["odd", { schema: "qorpera.code-site-other/v1", state: "ready" }],
			["shapeless", { state: "kept" }],
		];
		for (const step of steps)
			for (const [kind, failure] of failures) {
				const t = setup({ shop: small(3), site: small(2) });
				t.kernel.answer = (method, args) => {
					if (
						method !== `qorpera_code_site_${step}` ||
						args.p_name === "site" ||
						args.p_version_id === VERSIONS.site
					)
						return undefined;
					if (failure instanceof Error) throw failure;
					return failure;
				};
				await expect(t.pass(), `${step} ${kind}`).resolves.toEqual({ uploaded: 1, failed: 1 });
				expect(t.of("qorpera_code_site_failed").map((call) => call.args)).toEqual([
					{ ...WHICH, p_change: 14, p_code: "SITE_UPLOAD_FAILED" },
				]);
				const message = failure instanceof Error ? failure.message : "CODE_SITE_ANSWER_UNCONFIRMED";
				expect(t.errors(), `${step} ${kind}`).toEqual([`${step}:SITE_UPLOAD_FAILED:${message}`]);
			}
		// Each answer's own shape: a listing that ends too soon or not at all, a version with no id, a put that files
		// nothing it can count.
		const shapes: [string, unknown][] = [
			["list", { schema: "qorpera.code-site-list/v1", state: "listed", missing: -1 }],
			["list", { schema: "qorpera.code-site-list/v1", state: "kept", missing: 0 }],
			[
				"begin",
				{ schema: "qorpera.code-site-begin/v1", state: "uploading", versionId: "v", slug: "shop", listed: false },
			],
			[
				"begin",
				{ schema: "qorpera.code-site-begin/v1", state: "uploading", versionId: VERSIONS.shop, slug: "shop" },
			],
			["begin", { schema: "qorpera.code-site-begin/v1", state: "made", versionId: VERSIONS.shop, slug: "shop" }],
			["put", { schema: "qorpera.code-site-put/v1", state: "kept", filed: -1 }],
			["finish", { schema: "qorpera.code-site-finish/v1", state: "uploading" }],
		];
		for (const [step, answer] of shapes) {
			const t = setup({ shop: small(200) });
			t.kernel.answer = (method) => (method === `qorpera_code_site_${step}` ? answer : undefined);
			await expect(t.pass(), JSON.stringify(answer)).resolves.toEqual({ uploaded: 0, failed: 1 });
			expect(t.errors()).toEqual([`${step}:SITE_UPLOAD_FAILED:CODE_SITE_ANSWER_UNCONFIRMED`]);
		}
		const last = setup({ shop: small(200) });
		last.kernel.answer = (method, args) =>
			method === "qorpera_code_site_list" && (args.p_files as { last: boolean }).last
				? { schema: "qorpera.code-site-list/v1", state: "listing", missing: 0 }
				: undefined;
		await expect(last.pass()).resolves.toEqual({ uploaded: 0, failed: 1 });
		expect(last.errors()).toEqual(["list:SITE_UPLOAD_FAILED:CODE_SITE_ANSWER_UNCONFIRMED"]);
	});

	it("reads only the missing pages it can trust: each path of the tree, at its size, after the page before", async () => {
		const missing = (entries: unknown[], more: boolean) => ({
			schema: "qorpera.code-site-missing/v1",
			missing: entries,
			more,
		});
		const pages: [string, unknown[]][] = [
			["a path the tree does not hold", [missing([{ path: "other.html", bytes: 200 }], false)]],
			["another size", [missing([{ path: "index.html", bytes: 201 }], false)]],
			[
				"a page that goes back",
				[missing([{ path: "index.html", bytes: 200 }], true), missing([{ path: "a/f000.txt", bytes: 100 }], false)],
			],
			[
				"a path twice",
				[
					missing(
						[
							{ path: "a/f000.txt", bytes: 100 },
							{ path: "a/f000.txt", bytes: 100 },
						],
						false,
					),
				],
			],
			["more, and nothing named", [missing([], true)]],
			[
				"more pages than three files fill",
				[
					missing([{ path: "a/f000.txt", bytes: 100 }], true),
					missing([{ path: "a/f001.txt", bytes: 100 }], true),
					missing([{ path: "index.html", bytes: 200 }], false),
				],
			],
			[
				"over a hundred",
				[
					missing(
						Array.from({ length: 101 }, () => ({ path: "index.html", bytes: 200 })),
						false,
					),
				],
			],
		];
		for (const [kind, answers] of pages) {
			const t = setup({ shop: small(3) });
			const queue = [...answers];
			t.kernel.answer = (method) => (method === "qorpera_code_site_missing" ? queue.shift() : undefined);
			await expect(t.pass(), kind).resolves.toEqual({ uploaded: 0, failed: 1 });
			expect(t.errors(), kind).toEqual(["missing:SITE_UPLOAD_FAILED:CODE_SITE_ANSWER_UNCONFIRMED"]);
			expect(t.of("qorpera_code_site_put"), kind).toEqual([]);
		}
	});

	it("tells the kernel the read job's own code when the tree cannot be read", async () => {
		const files = small(3);
		const cases: [unknown, string][] = [
			[new CodeHostRefusal("CODE_HOST_SITE_TREE_UNKNOWN"), "CODE_HOST_SITE_TREE_UNKNOWN"],
			[new CodeHostRefusal("CODE_HOST_SITE_TREE_INVALID", ["a/b.php"]), "CODE_HOST_SITE_TREE_INVALID"],
			[new CodeHostJobFailure("CODE_HOST_SITE_READ_FAILED", "fatal: bad object"), "CODE_HOST_SITE_READ_FAILED"],
			[new CodeHostJobFailure("CODE_HOST_VIEW_UNAVAILABLE", "the view did not open"), "CODE_HOST_VIEW_UNAVAILABLE"],
			[new Error("something else"), "CODE_HOST_SITE_READ_FAILED"],
		];
		for (const [error, code] of cases) {
			const t = setup({ shop: files, site: small(2) });
			t.read.mockRejectedValueOnce(error);
			await expect(t.pass()).resolves.toEqual({ uploaded: 1, failed: 1 });
			expect(t.of("qorpera_code_site_failed").map((call) => call.args)).toEqual([
				{ ...WHICH, p_change: 14, p_code: code },
			]);
			expect(t.errors()).toEqual([`read:${code}:${(error as Error).message}`]);
			expect(t.methods().slice(0, 3)).toEqual(["sites_due", "site_failed", "site_begin"]);
		}
		// A read that answers files whose bytes are not what they say, or no manifest: the parts would be cut wrong.
		const wrong = [
			{ files: [{ ...(files[0] as CodeSiteUploadFile), bytes: 201 }], manifestSha256: manifestOf(files) },
			{ files, manifestSha256: "m" },
			{ files: [{ ...(files[0] as CodeSiteUploadFile), content: "<html>" }], manifestSha256: manifestOf(files) },
		];
		for (const answer of wrong) {
			const t = setup({ shop: files });
			t.read.mockResolvedValueOnce(answer as never);
			await expect(t.pass()).resolves.toEqual({ uploaded: 0, failed: 1 });
			expect(t.of("qorpera_code_site_failed")[0]?.args.p_code).toBe("CODE_HOST_SITE_READ_FAILED");
			expect(t.of("qorpera_code_site_begin")).toEqual([]);
		}
	});

	it("fails nothing when the read job gives way to a turn's, and goes on to the next site", async () => {
		const t = setup({ shop: small(3), site: small(2) });
		t.read.mockRejectedValueOnce(yielded());
		await expect(t.pass()).resolves.toEqual({ uploaded: 1, failed: 0 });
		expect(t.runs.map((run) => run.options)).toEqual([{ yields: true }, { yields: true }]);
		expect(t.of("qorpera_code_site_failed")).toEqual([]);
		expect(t.of("qorpera_code_site_begin").map((call) => call.args.p_name)).toEqual(["site"]);
		expect(t.errors()).toEqual([]);
	});

	it("stops where it is when the pass is stopped, and tells nothing", async () => {
		const t = setup({ shop: small(3), site: small(2) });
		const controller = new AbortController();
		t.kernel.answer = (method) => {
			if (method === "qorpera_code_site_put") controller.abort(new Error("CODING_EXECUTOR_SHUTDOWN"));
			return undefined;
		};
		await expect(t.uploads.pass(controller.signal)).resolves.toEqual({ uploaded: 0, failed: 0 });
		expect(t.methods()).toEqual(["sites_due", "site_begin", "site_list", "site_missing", "site_put"]);
		expect(t.errors()).toEqual([]);
		// Stopped while its tree is read.
		const reading = setup({ shop: small(3) });
		const stop = new AbortController();
		reading.read.mockImplementationOnce(async (job) => {
			stop.abort(new Error("CODING_EXECUTOR_SHUTDOWN"));
			job.signal.throwIfAborted();
			throw new Error("unreachable");
		});
		await expect(reading.uploads.pass(stop.signal)).resolves.toEqual({ uploaded: 0, failed: 0 });
		expect(reading.methods()).toEqual(["sites_due"]);
		expect(reading.errors()).toEqual([]);
		// A pass stopped before it began asks nothing.
		const never = setup({ shop: small(3) });
		await expect(never.uploads.pass(controller.signal)).resolves.toEqual({ uploaded: 0, failed: 0 });
		expect(never.calls).toEqual([]);
	});

	it("tells nothing for a site the kernel says is not this executor's", async () => {
		for (const step of ["begin", "list", "missing", "put", "finish"]) {
			const t = setup({ shop: small(3) });
			t.kernel.answer = (method) =>
				method === `qorpera_code_site_${step}`
					? { schema: `qorpera.code-site-${step}/v1`, state: "lost" }
					: undefined;
			await expect(t.pass()).resolves.toEqual({ uploaded: 0, failed: 1 });
			expect(t.of("qorpera_code_site_failed")).toEqual([]);
			expect(t.errors()).toEqual([`${step}:CODE_SITE_LOST`]);
		}
	});

	it("reports a failure the kernel was not told of", async () => {
		const answers: [unknown, string][] = [
			[new Error("CODING_CONTROL_UNCONFIRMED"), "CODING_CONTROL_UNCONFIRMED"],
			[{ schema: "qorpera.code-site-failed/v1", state: "lost" }, "CODE_SITE_FAILED_LOST"],
			[{ schema: "qorpera.code-site-failed/v1", state: "kept" }, "CODE_SITE_FAILED_UNCONFIRMED"],
		];
		for (const [answer, message] of answers) {
			const t = setup({ shop: small(3) });
			t.kernel.begun.shop = { state: "refused", code: "SITE_LIMIT" };
			t.kernel.answer = (method) => {
				if (method !== "qorpera_code_site_failed") return undefined;
				if (answer instanceof Error) throw answer;
				return answer;
			};
			await expect(t.pass()).resolves.toEqual({ uploaded: 0, failed: 1 });
			expect(t.errors()).toEqual(["begin:SITE_LIMIT", `failed:SITE_LIMIT:${message}`]);
		}
	});

	it("reads the due list entry by entry, and never throws for a kernel that does not answer", async () => {
		const t = setup({ shop: small(3) });
		t.kernel.answer = (method) => {
			if (method === "qorpera_code_sites_due") throw new Error("CODING_CONTROL_UNCONFIRMED");
			return undefined;
		};
		await expect(t.pass()).resolves.toEqual({ uploaded: 0, failed: 0 });
		expect(t.errors()).toEqual(["due:CODING_CONTROL_UNCONFIRMED"]);
		const odd = setup({ shop: small(3) });
		odd.kernel.answer = (method) => (method === "qorpera_code_sites_due" ? { sites: [] } : undefined);
		await expect(odd.pass()).resolves.toEqual({ uploaded: 0, failed: 0 });
		expect(odd.errors()).toEqual(["due:CODE_SITE_DUE_UNCONFIRMED"]);
		// An entry that names no repository is passed over; one whose row's site cannot be read is told as an upload that
		// failed, without a job; the others go on.
		const entries = setup({ shop: small(3), site: small(2) });
		const shop = entries.kernel.due[0] as Record<string, unknown>;
		entries.kernel.due = [
			{ ...shop, companyId: "not a company" },
			{ ...shop, owner: "../etc" },
			{ ...shop, change: 0 },
			{ ...shop, site: { ...(shop.site as Record<string, unknown>), tree: "main" } },
			{ ...shop, site: { ...(shop.site as Record<string, unknown>), files: 501 } },
			{ ...shop, site: null },
			entries.kernel.due[1],
		];
		await expect(entries.pass()).resolves.toEqual({ uploaded: 1, failed: 3 });
		expect(entries.errors()).toEqual([
			"due:CODE_SITE_DUE_UNCONFIRMED",
			"due:CODE_SITE_DUE_UNCONFIRMED",
			"due:CODE_SITE_DUE_UNCONFIRMED",
			"due:SITE_UPLOAD_FAILED:CODE_SITE_DUE_UNCONFIRMED",
			"due:SITE_UPLOAD_FAILED:CODE_SITE_DUE_UNCONFIRMED",
			"due:SITE_UPLOAD_FAILED:CODE_SITE_DUE_UNCONFIRMED",
		]);
		expect(entries.runs).toHaveLength(1);
		expect(entries.of("qorpera_code_site_failed").map((call) => call.args.p_code)).toEqual([
			"SITE_UPLOAD_FAILED",
			"SITE_UPLOAD_FAILED",
			"SITE_UPLOAD_FAILED",
		]);
		// Nothing due: no job and no line.
		const quiet = setup({});
		await expect(quiet.pass()).resolves.toEqual({ uploaded: 0, failed: 0 });
		expect(quiet.runs).toEqual([]);
		expect(quiet.events).toEqual([]);
		// A reporter that throws changes nothing.
		const loud = setup(
			{ shop: small(3) },
			{
				report: () => {
					throw new Error("the log is full");
				},
			},
		);
		await expect(loud.pass()).resolves.toEqual({ uploaded: 1, failed: 0 });
	});

	it("hangs nothing off the signal its passes are given, which may last as long as the process (abort-scope.ts)", async () => {
		const t = setup({ shop: small(3) });
		const lasting = new AbortController();
		const watch = watchAbortSignalAny();
		try {
			await expect(t.uploads.pass(lasting.signal)).resolves.toEqual({ uploaded: 1, failed: 0 });
			await expect(t.uploads.pass(lasting.signal)).resolves.toEqual({ uploaded: 1, failed: 0 });
			expect(watch.made()).toBeGreaterThan(4);
			expect(watch.on(lasting.signal)).toBe(0);
		} finally {
			watch.restore();
		}
	});

	describe("wait", () => {
		const settled = async (waited: Promise<void>, ms = 50) =>
			await Promise.race([
				waited.then(() => "ended"),
				new Promise<string>((resolve) => setTimeout(() => resolve("waiting"), ms)),
			]);

		it("ends at a wake, after its time, or when its signal aborts, and never rejects", async () => {
			const { uploads } = setup({});
			const controller = new AbortController();
			const waited = uploads.wait(60_000, controller.signal);
			expect(await settled(waited)).toBe("waiting");
			uploads.wake();
			await expect(waited).resolves.toBeUndefined();
			// The wake was taken: the next wait waits.
			const next = uploads.wait(60_000, controller.signal);
			expect(await settled(next)).toBe("waiting");
			controller.abort(new Error("CODING_EXECUTOR_SHUTDOWN"));
			await expect(next).resolves.toBeUndefined();
			await expect(uploads.wait(60_000, controller.signal)).resolves.toBeUndefined();
			expect(await settled(uploads.wait(5, new AbortController().signal), 1000)).toBe("ended");
		});

		it("ends at once after a wake that came while nothing waited (a landing during a pass)", async () => {
			const t = setup({ shop: small(3) });
			const controller = new AbortController();
			t.kernel.answer = (method) => {
				if (method === "qorpera_code_site_finish") t.uploads.wake();
				return undefined;
			};
			await expect(t.uploads.pass(controller.signal)).resolves.toEqual({ uploaded: 1, failed: 0 });
			expect(await settled(t.uploads.wait(60_000, controller.signal))).toBe("ended");
			const next = t.uploads.wait(60_000, controller.signal);
			expect(await settled(next)).toBe("waiting");
			controller.abort();
			await next;
		});

		it("takes its listener off the signal when it ends", async () => {
			const { uploads } = setup({});
			const controller = new AbortController();
			const add = vi.spyOn(controller.signal, "addEventListener");
			const remove = vi.spyOn(controller.signal, "removeEventListener");
			const waited = uploads.wait(60_000, controller.signal);
			uploads.wake();
			await waited;
			await uploads.wait(1, controller.signal);
			expect(add).toHaveBeenCalledTimes(2);
			expect(remove.mock.calls.map((call) => call[1])).toEqual(add.mock.calls.map((call) => call[1]));
		});
	});
});
