import { spawn } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { CODE_BUNDLE_NAME } from "../src/code-bundle-store.ts";
import { CodeHostJobFailure, CodeHostRefusal, codeRefsSha256 } from "../src/code-host-jobs.ts";
import {
	CODE_IMPORT_ADVERTISEMENT_BYTES,
	CODE_IMPORT_AUTHOR_DAYS,
	CODE_IMPORT_BRANCH_BYTES,
	CODE_IMPORT_BRANCH_DAYS,
	CODE_IMPORT_BRANCHES,
	CODE_IMPORT_BUNDLE_NAME,
	CODE_IMPORT_BUSY,
	CODE_IMPORT_CLAIMS,
	CODE_IMPORT_CONNECT_MS,
	CODE_IMPORT_FAILED_CODE,
	CODE_IMPORT_FAILURES,
	CODE_IMPORT_FETCH_MS,
	CODE_IMPORT_FILE_MAXIMUM_BYTES,
	CODE_IMPORT_FSCK_MS,
	CODE_IMPORT_HEADERS_MS,
	CODE_IMPORT_IDLE_MS,
	CODE_IMPORT_KEY_KINDS,
	CODE_IMPORT_KEY_PATTERNS,
	CODE_IMPORT_LEASE_MS,
	CODE_IMPORT_LOOK_BYTES,
	CODE_IMPORT_LOOK_COLUMN_BYTES,
	CODE_IMPORT_LOOK_PATH_BYTES,
	CODE_IMPORT_LOOK_PATHS,
	CODE_IMPORT_LOOK_SHOWN,
	CODE_IMPORT_MAIN_ENTRIES,
	CODE_IMPORT_MAXIMUM_BYTES,
	CODE_IMPORT_MAXIMUM_BYTES_LIMIT,
	CODE_IMPORT_PIECE_BYTES,
	CODE_IMPORT_PKT_LINE_BYTES,
	CODE_IMPORT_PROGRESS_BYTES,
	CODE_IMPORT_READ_PIECE_BYTES,
	CODE_IMPORT_REF_LAST_PART_BYTES,
	CODE_IMPORT_REF_LINES,
	CODE_IMPORT_REF_LIST_BYTES,
	CODE_IMPORT_REF_NAME_BYTES,
	CODE_IMPORT_REF_PART_BYTES,
	CODE_IMPORT_REFUSALS,
	CODE_IMPORT_REFUSED_CODE,
	CODE_IMPORT_RELAY_REFUSALS,
	CODE_IMPORT_RENEW_MS,
	CODE_IMPORT_RPCS,
	CODE_IMPORT_SCAN,
	CODE_IMPORT_SCAN_BLOB_BYTES,
	CODE_IMPORT_SCAN_BYTES,
	CODE_IMPORT_SCAN_OUTPUT_BYTES,
	CODE_IMPORT_SCAN_SECONDS,
	CODE_IMPORT_SCRATCH_FACTOR,
	CODE_IMPORT_TAGS,
	CODE_IMPORT_WANTS,
	type CodeImportAnswer,
	type CodeImportLookFacts,
	type CodeImportRefList,
	type CodeImportRefSeen,
	CodeImportStop,
	codeImportAdvertisement,
	codeImportAnswerStop,
	codeImportAuthors,
	codeImportBranchValid,
	codeImportBundleHeader,
	codeImportBundleHeaderOf,
	codeImportBundleName,
	codeImportBundlePieces,
	codeImportEnvFile,
	codeImportFetchRequest,
	codeImportFileBranch,
	codeImportFolderPathValid,
	codeImportGitHubOf,
	codeImportGitRefValid,
	codeImportHeaderRefValid,
	codeImportHistoryCode,
	codeImportIncomingPathValid,
	codeImportInputOf,
	codeImportJsonbBound,
	codeImportKeyIn,
	codeImportLfsPointer,
	codeImportLook,
	codeImportLookedAnswer,
	codeImportLookOf,
	codeImportLsRefsRequest,
	codeImportOutcomeOf,
	codeImportPack,
	codeImportPackets,
	codeImportPackStats,
	codeImportPktLine,
	codeImportProgressOf,
	codeImportProgressValue,
	codeImportRecord,
	codeImportRecordedAnswer,
	codeImportRefList,
	codeImportRefPartsFit,
	codeImportRefsPlan,
	codeImportRelayRefusals,
	codeImportRequestOf,
	codeImportScanAnswer,
	codeImportScanBlobs,
	codeImportShown,
	codeImportStopOf,
	codeImportTime,
	codeImportWants,
} from "../src/code-import.ts";

const MiB = 1024 ** 2;
const GiB = 1024 ** 3;
const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);
const D = "d".repeat(40);
const pkt = codeImportPktLine;
const FLUSH = Buffer.from("0000");
const DELIM = Buffer.from("0001");
const END = Buffer.from("0002");
const place = { host: "qorpera" as const, owner: "acme", name: "shop", baseBranch: "main" };

/** A body that hands out `bytes` in pieces of `size`. */
function pieces(bytes: Uint8Array, size: number): AsyncIterable<Uint8Array> {
	return (async function* () {
		for (let at = 0; at < bytes.length; at += size) yield bytes.subarray(at, at + size);
	})();
}
/** A body of these chunks as they are. */
function body(...chunks: Uint8Array[]): AsyncIterable<Uint8Array> {
	return (async function* () {
		for (const chunk of chunks) yield chunk;
	})();
}
async function all<T>(iterable: AsyncIterable<T>): Promise<T[]> {
	const out: T[] = [];
	for await (const item of iterable) out.push(item);
	return out;
}
/** Every way to cut `bytes` in two, and one byte at a time. */
function cuts(bytes: Buffer): AsyncIterable<Uint8Array>[][] {
	return [
		...Array.from({ length: bytes.length + 1 }, (_, at) => [body(bytes.subarray(0, at), bytes.subarray(at))]),
		[pieces(bytes, 1)],
	];
}
/** What a promise rejects with, as a stop's three facts. */
async function stopped(work: Promise<unknown>) {
	const error = await work.then(
		() => null,
		(caught: unknown) => caught,
	);
	if (!(error instanceof CodeImportStop)) throw new Error(`not a stop: ${String(error)}`);
	return { end: error.end, code: error.code, notOurRef: error.notOurRef };
}
const stop = (end: string, code: string, notOurRef = false) => ({ end, code, notOurRef });

describe("the limits and the codes", () => {
	it("are the design's numbers", () => {
		expect({
			CODE_IMPORT_MAXIMUM_BYTES,
			CODE_IMPORT_MAXIMUM_BYTES_LIMIT,
			CODE_IMPORT_FILE_MAXIMUM_BYTES,
			CODE_IMPORT_REF_LINES,
			CODE_IMPORT_REF_LIST_BYTES,
			CODE_IMPORT_ADVERTISEMENT_BYTES,
			CODE_IMPORT_WANTS,
			CODE_IMPORT_PKT_LINE_BYTES,
			CODE_IMPORT_REF_NAME_BYTES,
			CODE_IMPORT_REF_PART_BYTES,
			CODE_IMPORT_REF_LAST_PART_BYTES,
			CODE_IMPORT_BRANCH_BYTES,
			CODE_IMPORT_FETCH_MS,
			CODE_IMPORT_IDLE_MS,
			CODE_IMPORT_CONNECT_MS,
			CODE_IMPORT_HEADERS_MS,
			CODE_IMPORT_PIECE_BYTES,
			CODE_IMPORT_READ_PIECE_BYTES,
			CODE_IMPORT_SCRATCH_FACTOR,
			CODE_IMPORT_FSCK_MS,
			CODE_IMPORT_MAIN_ENTRIES,
			CODE_IMPORT_TAGS,
			CODE_IMPORT_BRANCHES,
			CODE_IMPORT_BRANCH_DAYS,
			CODE_IMPORT_AUTHOR_DAYS,
			CODE_IMPORT_SCAN_BLOB_BYTES,
			CODE_IMPORT_SCAN_BYTES,
			CODE_IMPORT_SCAN_SECONDS,
			CODE_IMPORT_SCAN_OUTPUT_BYTES,
			CODE_IMPORT_LOOK_BYTES,
			CODE_IMPORT_LOOK_COLUMN_BYTES,
			CODE_IMPORT_LOOK_PATH_BYTES,
			CODE_IMPORT_LOOK_PATHS,
			CODE_IMPORT_LOOK_SHOWN,
			CODE_IMPORT_PROGRESS_BYTES,
			CODE_IMPORT_LEASE_MS,
			CODE_IMPORT_RENEW_MS,
			CODE_IMPORT_CLAIMS,
			CODE_IMPORT_RELAY_REFUSALS,
		}).toEqual({
			CODE_IMPORT_MAXIMUM_BYTES: GiB,
			CODE_IMPORT_MAXIMUM_BYTES_LIMIT: 2 * GiB,
			CODE_IMPORT_FILE_MAXIMUM_BYTES: 256 * MiB,
			CODE_IMPORT_REF_LINES: 20_000,
			CODE_IMPORT_REF_LIST_BYTES: 4 * MiB,
			CODE_IMPORT_ADVERTISEMENT_BYTES: 64 * 1024,
			CODE_IMPORT_WANTS: 5_000,
			CODE_IMPORT_PKT_LINE_BYTES: 65_520,
			CODE_IMPORT_REF_NAME_BYTES: 1_000,
			CODE_IMPORT_REF_PART_BYTES: 255,
			CODE_IMPORT_REF_LAST_PART_BYTES: 250,
			CODE_IMPORT_BRANCH_BYTES: 200,
			CODE_IMPORT_FETCH_MS: 3_600_000,
			CODE_IMPORT_IDLE_MS: 120_000,
			CODE_IMPORT_CONNECT_MS: 10_000,
			CODE_IMPORT_HEADERS_MS: 30_000,
			CODE_IMPORT_PIECE_BYTES: MiB,
			CODE_IMPORT_READ_PIECE_BYTES: 16 * MiB,
			CODE_IMPORT_SCRATCH_FACTOR: 5,
			CODE_IMPORT_FSCK_MS: 1_800_000,
			CODE_IMPORT_MAIN_ENTRIES: 9_000,
			CODE_IMPORT_TAGS: 500,
			CODE_IMPORT_BRANCHES: 200,
			CODE_IMPORT_BRANCH_DAYS: 90,
			CODE_IMPORT_AUTHOR_DAYS: 30,
			CODE_IMPORT_SCAN_BLOB_BYTES: MiB,
			CODE_IMPORT_SCAN_BYTES: 2 * GiB,
			CODE_IMPORT_SCAN_SECONDS: 600,
			CODE_IMPORT_SCAN_OUTPUT_BYTES: 65_536,
			CODE_IMPORT_LOOK_BYTES: 15 * 1024,
			CODE_IMPORT_LOOK_COLUMN_BYTES: 16_384,
			CODE_IMPORT_LOOK_PATH_BYTES: 200,
			CODE_IMPORT_LOOK_PATHS: 10,
			CODE_IMPORT_LOOK_SHOWN: 30,
			CODE_IMPORT_PROGRESS_BYTES: 3_072,
			CODE_IMPORT_LEASE_MS: 900_000,
			CODE_IMPORT_RENEW_MS: 300_000,
			CODE_IMPORT_CLAIMS: 5,
			CODE_IMPORT_RELAY_REFUSALS: 3,
		});
	});

	it("are each the kernel's kind of code, once", () => {
		const codes = [...CODE_IMPORT_REFUSALS, ...CODE_IMPORT_FAILURES, ...CODE_IMPORT_BUSY];
		expect(new Set(codes).size).toBe(codes.length);
		for (const code of CODE_IMPORT_REFUSALS) expect(CODE_IMPORT_REFUSED_CODE.test(code), code).toBe(true);
		for (const code of [...CODE_IMPORT_FAILURES, ...CODE_IMPORT_BUSY])
			expect(CODE_IMPORT_FAILED_CODE.test(code), code).toBe(true);
		expect(CODE_IMPORT_REFUSED_CODE.test("IMPORT_X:PLACE_AS_BEFORE")).toBe(false);
		expect(CODE_IMPORT_REFUSED_CODE.test(`IMPORT_${"A".repeat(101)}`)).toBe(false);
		expect(CODE_IMPORT_REFUSED_CODE.test("CODE_HOST_NAMES_NOT_NFC")).toBe(true);
		// The run's refusal of a place an earlier import left half done (part C3) is one of these, with words in D and E.
		expect(CODE_IMPORT_REFUSALS).toContain("IMPORT_PLACE_HALF_DONE");
		expect(CODE_IMPORT_FAILED_CODE.test("IMPORT_FETCH_TIMEOUT:PLACE_AS_BEFORE")).toBe(true);
		expect(CODE_IMPORT_RPCS).toEqual(["qorpera_code_import_looked", "qorpera_code_import_record"]);
	});

	it("names a history's refusal by git's message id, a warning's apart from damage", () => {
		const oid = "0123456789abcdef0123456789abcdef01234567";
		const said = `error: object ${oid}: zeroPaddedFilemode: contains zero-padded file modes\nfatal: fsck error in packed object\n`;
		expect(codeImportHistoryCode(said, true)).toBe("IMPORT_HISTORY_ZERO_PADDED_FILEMODE");
		expect(codeImportHistoryCode(said, false)).toBe("IMPORT_HISTORY_DAMAGED_ZERO_PADDED_FILEMODE");
		// An object's id is never taken for the message's, also when it begins with a letter.
		expect(codeImportHistoryCode(`error: ${"abcdef".repeat(6)}abcd: missingTree: no tree`, false)).toBe(
			"IMPORT_HISTORY_DAMAGED_MISSING_TREE",
		);
		expect(codeImportHistoryCode("error in tree 1234: badTreeSha1: x", false)).toBe(
			"IMPORT_HISTORY_DAMAGED_BAD_TREE_SHA1",
		);
		expect(codeImportHistoryCode("fatal: fsck error in packed object", true)).toBe("IMPORT_HISTORY_DAMAGED");
		expect(codeImportHistoryCode("", false)).toBe("IMPORT_HISTORY_DAMAGED");
		for (const code of ["IMPORT_HISTORY_ZERO_PADDED_FILEMODE", "IMPORT_HISTORY_DAMAGED_MISSING_TREE"])
			expect(CODE_IMPORT_REFUSED_CODE.test(code)).toBe(true);
		const long = codeImportHistoryCode(`x: a${"B".repeat(40)}: y`, false);
		expect(CODE_IMPORT_REFUSED_CODE.test(long) || long === "IMPORT_HISTORY_DAMAGED").toBe(true);
	});

	it("makes a stop of any error of the fetch, the read and the look", () => {
		const of = (error: unknown, signal?: AbortSignal) => {
			const s = codeImportStopOf(error, signal);
			return [s.end, s.code];
		};
		const own = new CodeImportStop("refused", "IMPORT_USES_LFS");
		expect(codeImportStopOf(own)).toBe(own);
		expect(of(new CodeHostRefusal("CODE_HOST_NAMES_NOT_NFC", ["a"]))).toEqual(["refused", "CODE_HOST_NAMES_NOT_NFC"]);
		expect(of(new CodeHostRefusal("IMPORT_TOO_MANY_FILES"))).toEqual(["refused", "IMPORT_TOO_MANY_FILES"]);
		expect(of(new CodeHostJobFailure("CODE_HOST_JOB_YIELDED"))).toEqual(["busy", "CODE_HOST_JOB_YIELDED"]);
		expect(of(new Error("CODE_BUNDLE_STORE_TIMEOUT"))).toEqual(["busy", "CODE_BUNDLE_STORE_TIMEOUT"]);
		expect(of(new CodeHostJobFailure("CODE_HOST_BUNDLE_FAILED", "detail"))).toEqual([
			"failed",
			"CODE_HOST_BUNDLE_FAILED",
		]);
		expect(of(new Error("connect ECONNREFUSED 1.2.3.4"))).toEqual(["failed", "UNCLASSIFIED"]);
		expect(of("thrown text")).toEqual(["failed", "UNCLASSIFIED"]);
		const ended = new AbortController();
		ended.abort();
		expect(of(new Error("anything"), ended.signal)).toEqual(["busy", "IMPORT_STOPPED"]);
		expect(new CodeImportStop("failed", "IMPORT_SOURCE_ERROR").message).toBe("IMPORT_SOURCE_ERROR");
	});
});

describe("names", () => {
	it("names the first bundle apart from every dated one", () => {
		const name = codeImportBundleName("2026-11-12T14:00:05.000Z", A);
		expect(name).toBe(`import-20261112T140005Z-${"a".repeat(12)}`);
		expect(CODE_IMPORT_BUNDLE_NAME.test(name)).toBe(true);
		expect(CODE_BUNDLE_NAME.test(name)).toBe(false);
		expect(name > "20991231T235959Z-ffffffffffff").toBe(true);
		expect(() => codeImportBundleName("2026-11-12", A)).toThrow("INVALID_CODE_BUNDLE");
	});

	it("takes a ref's name as git's check-ref-format does (2.53, seen on node02)", () => {
		const ok = [
			"refs/heads/a./b",
			"refs/heads/\u00e6",
			"refs/heads/@",
			"refs/heads/-a",
			"refs/heads/a@b",
			"refs/@",
			"refs/heads/@/x",
			"refs/heads/x/@",
			"refs/heads/a\u00a0b",
			"refs/heads/a{b",
			"refs/heads/a}b",
			"refs/heads/a@",
			"refs/tags/v1.0",
		];
		const bad = [
			"refs/heads/a b",
			"refs/heads/a..b",
			"refs/heads/.a",
			"refs/heads/a.lock",
			"refs/heads/a@{b",
			"refs/heads/a/",
			"refs/heads/a.",
			"refs/heads/a//b",
			"refs/heads/a~b",
			"refs/heads/a\\b",
			"refs/heads/a:b",
			"refs/heads/a?b",
			"refs/heads/a*b",
			"refs/heads/a[b",
			"refs/heads/a^b",
			"refs/heads/.lock",
			"refs/heads/a/.lock/b",
			"refs/heads/a.lock/b",
			"refs/heads/a\u007f",
			"refs/heads/a\tb",
			"refs/heads/@{",
			"@",
			"main",
			"refs/heads/\ud800",
		];
		for (const name of ok) expect(codeImportGitRefValid(name), name).toBe(true);
		for (const name of bad) expect(codeImportGitRefValid(name), name).toBe(false);
	});

	it("takes the first bundle's names and the default branch by their bounds", () => {
		expect(codeImportHeaderRefValid("refs/heads/main")).toBe(true);
		expect(codeImportHeaderRefValid("refs/tags/v1")).toBe(true);
		for (const name of ["refs/remotes/origin/main", "refs/pull/1/head", "HEAD", "refs/heads/", "refs/heads/a b"])
			expect(codeImportHeaderRefValid(name), name).toBe(false);
		// 1,000 bytes in all, of parts of 200 bytes and less.
		const name = (bytes: number) => `refs/heads/${`${"a".repeat(200)}/`.repeat(4)}${"x".repeat(bytes - 11 - 804)}`;
		expect(codeImportHeaderRefValid(name(1000))).toBe(true);
		expect(codeImportHeaderRefValid(name(1001))).toBe(false);
		// What the code host's disk holds as a file and its `.lock` (in bytes, not characters): a folder part of 255, a
		// last part of 250.
		for (const [bytes, folder, last] of [
			[250, true, true],
			[251, true, false],
			[255, true, false],
			[256, false, false],
		] as [number, boolean, boolean][]) {
			const part = "t".repeat(bytes);
			expect(codeImportRefPartsFit(`refs/heads/a/${part}/b`), `${bytes} folder`).toBe(folder);
			expect(codeImportHeaderRefValid(`refs/heads/a/${part}/b`), `${bytes} folder`).toBe(folder);
			expect(codeImportRefPartsFit(`refs/tags/${part}`), `${bytes} last`).toBe(last);
			expect(codeImportHeaderRefValid(`refs/tags/${part}`), `${bytes} last`).toBe(last);
		}
		expect(codeImportHeaderRefValid(`refs/tags/${"\u00e6".repeat(125)}`)).toBe(true);
		expect(codeImportHeaderRefValid(`refs/tags/${"\u00e6".repeat(126)}`)).toBe(false);
		expect(codeImportHeaderRefValid(`refs/heads/${"\u00e6".repeat(127)}/x`)).toBe(true);
		expect(codeImportHeaderRefValid(`refs/heads/${"\u00e6".repeat(128)}/x`)).toBe(false);
		expect(() => codeImportBundleHeader([{ name: `refs/tags/${"t".repeat(256)}`, sha: A }])).toThrow(
			"INVALID_CODE_IMPORT_BUNDLE_HEADER",
		);
		expect(codeImportBranchValid("x".repeat(200))).toBe(true);
		expect(codeImportBranchValid("x".repeat(201))).toBe(false);
		expect(codeImportBranchValid("\u00e6".repeat(100))).toBe(true);
		expect(codeImportBranchValid("\u00e6".repeat(101))).toBe(false);
		for (const branch of ["main", "feature/x", "release-1.2"]) expect(codeImportBranchValid(branch)).toBe(true);
		for (const branch of ["", "a b", "a..b", "AKIAQORPERATESTKEY01", "fix/sk-ant-0123456789abcdefghijkl", "a\ufffdb"])
			expect(codeImportBranchValid(branch), branch).toBe(false);
	});

	it("takes a file source's path as the request does", () => {
		for (const path of ["code/_incoming/shop/shop.bundle", "code/_incoming/a-1/x.y_z.bundle"])
			expect(codeImportIncomingPathValid(path), path).toBe(true);
		for (const path of [
			"code/_incoming/shop/shop.zip",
			"code/_incoming/shop.bundle",
			"code/_incoming/a/b/c.bundle",
			"code/_incoming/.a/b.bundle",
			"code/_incoming/a/.b.bundle",
			"code/_incoming/a../b.bundle",
			"code/_incoming/a./b.bundle",
			"code/_incoming/repo.git/b.bundle",
			"code/_incoming/REPO.GIT/b.bundle",
			"code/acme/shop/x.bundle",
			`code/_incoming/${"a".repeat(101)}/b.bundle`,
			"code/_incoming/a b/c.bundle",
		])
			expect(codeImportIncomingPathValid(path), path).toBe(false);
	});
});

/** The folder's rule (`qorpera_company_path_valid`), as its newest migration has it. */
const SQL_RULE = (() => {
	const folder = new URL("../../../supabase/migrations/", import.meta.url);
	const defining = readdirSync(folder)
		.filter((name) => name.endsWith(".sql"))
		.sort()
		.filter((name) =>
			readFileSync(new URL(name, folder), "utf8").includes("function public.qorpera_company_path_valid("),
		);
	const text = readFileSync(new URL(defining.at(-1) as string, folder), "utf8");
	const start = text.indexOf("function public.qorpera_company_path_valid(");
	return { file: defining.at(-1), body: text.slice(start, text.indexOf("$$;", start)), all: defining };
})();
/** Paths under code/ and whether the folder takes them: the twin's cases, each of which the database's own function
 * answered the same (a throwaway SQL test on node02, 12 Nov: build6/C1.md). */
const FOLDER_CASES: readonly [string, boolean][] = [
	["code/acme/shop/repo.git/refs/heads/main", true],
	["code/acme/shop/repo.git/refs/qorpera/imported/heads/feature/x", true],
	["code/a/b/c%d", true],
	["code/a/b/con", true],
	["code/a/b/aux.txt", true],
	["code/a/b/a:b", true],
	["code/a/b/\u00e6\u00f8\u00e5", true],
	["code/a/b/Stra\u00dfe", true],
	["code/a/b/-x", true],
	["code/a/b/a@b", true],
	[`code/${"a".repeat(4091)}`, true],
	[`code/${"a".repeat(4092)}`, false],
	["code/a/b/e\u0301", false],
	["code/a/b/a.", false],
	["code/a/b/a./c", false],
	["code/a/b/a ", false],
	["code/a/b/a\\b", false],
	["code/a/b/a\u0007b", false],
	["code/a/b/a\u007fb", false],
	["code/a/b/a\u0085b", false],
	["code//b", false],
	["code/a/./b", false],
	["code/a/../b", false],
	["code/a/b/", false],
	["code/a/b\uff0fc", false],
	["code/a/b/x\u2024", false],
	["code/a/b/\ufe52", false],
	["", false],
	["code", true],
	["CODE/a", true],
];

describe("the folder's path rule, twinned", () => {
	it("is the newest migration's rule, with the clauses the twin keeps", () => {
		expect(SQL_RULE.file).toBe("20260928569110_folder_code_names.sql");
		for (const clause of [
			"octet_length(p_path) not between 1 and 4096",
			"p_path <> normalize(p_path, NFC)",
			"v_code := split_part(public.qorpera_company_path_key(p_path), '/', 1) = 'code'",
			"foreach v_candidate in array array[p_path, public.qorpera_company_path_key(p_path)] loop",
			"v_candidate ~ '[[:cntrl:]]' or strpos(v_candidate, chr(92)) > 0",
			"(strpos(v_candidate, '%') > 0 and not v_code)",
			"cardinality(string_to_array(v_candidate,'/')) <> cardinality(string_to_array(p_path,'/'))",
			"v_part in ('', '.', '..') or v_part ~ '[. ]$'",
			"(not v_code and (strpos(v_part, ':') > 0",
		])
			expect(SQL_RULE.body, clause).toContain(clause);
		const key = readFileSync(
			new URL("../../../supabase/migrations/20260828005000_company_file_path_gateway.sql", import.meta.url),
			"utf8",
		);
		expect(key).toContain("select normalize(lower(upper(normalize(p_path, NFKC))), NFKC)");
	});

	it("answers its cases as the database does", () => {
		for (const [path, valid] of FOLDER_CASES)
			expect(codeImportFolderPathValid(path), JSON.stringify(path.slice(0, 60))).toBe(valid);
		expect(codeImportFolderPathValid("code/a/\ud800")).toBe(false);
		// A path outside code/ is none the twin is for, whatever the database says of it.
		expect(codeImportFolderPathValid("notcode/a")).toBe(false);
	});
});

const PLANTED = {
	aws: "AKIAQORPERATESTKEY01",
	github: `ghp_${"a1".repeat(18)}`,
	stripe: `sk_live_${"b2".repeat(12)}`,
	slack: "xoxb-1234567890-abcdefghij",
	google: `AIza${"c3".repeat(17)}d`,
	"private-key": "-----BEGIN RSA PRIVATE KEY-----",
	resend: `re_${"e4".repeat(4)}_${"f5".repeat(12)}`,
	openai: `sk-proj-${"g6".repeat(12)}`,
	anthropic: `sk-ant-api03-${"h7".repeat(12)}`,
} as const;
/** Every value the real scan plants, with its kind: one of each, and an older OpenAI key. */
const PLANTED_ALL: [string, string][] = [
	...Object.entries(PLANTED),
	["openai", `sk-${"i8".repeat(10)}T3BlbkFJ${"j9".repeat(10)}`],
];

describe("what looks like a key", () => {
	it("tells each kind apart, in JavaScript as the scan does", () => {
		for (const [kind, value] of Object.entries(PLANTED)) {
			expect(codeImportKeyIn(`x=${value};`), kind).toBe(kind);
			expect(new RegExp(CODE_IMPORT_KEY_PATTERNS[kind as keyof typeof PLANTED]).exec(`"${value}"`)?.[0]).toBe(value);
		}
		expect(codeImportKeyIn(`github_pat_${"A".repeat(22)}_${"b".repeat(59)}`)).toBe("github");
		expect(codeImportKeyIn("ASIAQORPERATESTKEY02")).toBe("aws");
		expect(codeImportKeyIn("rk_live_abcdefghijklmnopqrstuvwx")).toBe("stripe");
		expect(codeImportKeyIn("https://hooks.slack.com/services/T00000000/B00000000/abcdefghijklmnopqrstuvwx")).toBe(
			"slack",
		);
		expect(codeImportKeyIn("-----BEGIN OPENSSH PRIVATE KEY-----")).toBe("private-key");
		expect(codeImportKeyIn("-----BEGIN PGP PRIVATE KEY BLOCK-----")).toBe("private-key");
		expect(codeImportKeyIn(`sk-svcacct-${"x".repeat(20)}`)).toBe("openai");
		expect(codeImportKeyIn(`key: sk-${"a".repeat(20)}T3BlbkFJ${"b".repeat(20)}\n`)).toBe("openai");
		for (const near of [
			"AKIAQORPERATESTKEY0",
			"AKIAQORPERATESTKEY012",
			"xAKIAQORPERATESTKEY01",
			`ghp_${"a".repeat(35)}`,
			`sk_test_${"b".repeat(24)}`,
			`pk_live_${"b".repeat(24)}`,
			"xoxb-123",
			`AIza${"c".repeat(34)}`,
			"-----BEGIN PUBLIC KEY-----",
			`re_${"e".repeat(7)}_${"f".repeat(24)}`,
			`more_${"e".repeat(8)}_${"f".repeat(24)}`,
			`sk-${"g".repeat(48)}`,
			`sk-ant-${"h".repeat(19)}`,
			"0123456789abcdef0123456789abcdef01234567 blob 1024",
		])
			expect(codeImportKeyIn(near), near).toBeNull();
		for (const pattern of Object.values(CODE_IMPORT_KEY_PATTERNS)) {
			expect(pattern).not.toMatch(/['#\n]/);
			for (const count of pattern.matchAll(/\{(\d+)(?:,(\d*))?\}/g))
				expect(Number(count[2] || count[1])).toBeLessThanOrEqual(59);
		}
		expect(CODE_IMPORT_KEY_KINDS).toEqual([...Object.keys(CODE_IMPORT_KEY_PATTERNS), "env-file"]);
	});

	it("knows a tracked .env by its path", () => {
		for (const path of [".env", "app/.env", ".env.local", "a/.ENV.production", ".env.local.backup"])
			expect(codeImportEnvFile(path), path).toBe(true);
		for (const path of [
			".env.example",
			"a/.env.sample",
			".ENV.TEMPLATE",
			".env.local.example",
			"env",
			".envrc",
			"x.env",
		])
			expect(codeImportEnvFile(path), path).toBe(false);
	});

	it("shows a path whole or not at all", () => {
		expect(codeImportShown("src/a.ts")).toBe("src/a.ts");
		expect(codeImportShown("x".repeat(200))).toBe("x".repeat(200));
		expect(codeImportShown("x".repeat(201))).toBeNull();
		expect(codeImportShown("\u00e6".repeat(100))).toBe("\u00e6".repeat(100));
		expect(codeImportShown("\u00e6".repeat(101))).toBeNull();
		for (const path of [
			`keys/${PLANTED.aws}/a.txt`,
			"a\nb",
			"a\u0085b",
			"a\u2028b",
			"a\ufffdb",
			"a\ud800b",
			"",
			null,
			undefined,
		])
			expect(codeImportShown(path), String(path)).toBeNull();
	});
});

describe("pkt-lines", () => {
	it("frames and reads lines back, of every size git takes", async () => {
		for (const size of [1, 100, 65_516]) {
			const payload = Buffer.alloc(size, 0x61);
			const line = pkt(payload);
			expect(line.subarray(0, 4).toString()).toBe((size + 4).toString(16).padStart(4, "0"));
			expect(await all(codeImportPackets(body(line)))).toEqual([{ type: "data", payload }]);
		}
		expect(pkt("version 2\n").toString()).toBe("000eversion 2\n");
		expect(() => pkt(Buffer.alloc(65_517))).toThrow("INVALID_CODE_IMPORT_PKT_LINE");
		expect(() => pkt("")).toThrow("INVALID_CODE_IMPORT_PKT_LINE");
		expect(await all(codeImportPackets(body(Buffer.from("0000000100020004"), Buffer.from("0005\x01"))))).toEqual([
			{ type: "flush" },
			{ type: "delim" },
			{ type: "end" },
			{ type: "data", payload: Buffer.alloc(0) },
			{ type: "data", payload: Buffer.from([0x01]) },
		]);
		expect(await stopped(all(codeImportPackets(body(Buffer.from("000000010002000400050001")))))).toEqual(
			stop("failed", "IMPORT_SOURCE_PROTOCOL"),
		);
		expect(await all(codeImportPackets(body(Buffer.from("000AabcdeF")))).then((p) => p.length)).toBe(1);
	});

	it("refuses a length that is none, and a stream that ends within a line", async () => {
		for (const bad of ["000x", "0003", "fff1", "ffff", "00g0", "00", "0010abc", "0005", " 004"])
			expect(await stopped(all(codeImportPackets(body(Buffer.from(bad))))), bad).toEqual(
				stop("failed", "IMPORT_SOURCE_PROTOCOL"),
			);
		expect(await stopped(all(codeImportPackets(body("text" as unknown as Uint8Array))))).toEqual(
			stop("failed", "IMPORT_SOURCE_PROTOCOL"),
		);
		expect((await all(codeImportPackets(body(Buffer.from("fff0"), Buffer.alloc(65_516))))).length).toBe(1);
		// Whole lines past each bound: refused for their length, not for a stream that ends within one.
		for (const whole of [
			Buffer.concat([Buffer.from("fff1"), Buffer.alloc(65_517, 0x61)]),
			Buffer.concat([Buffer.from("0003000"), Buffer.alloc(12_284, 0x61)]),
		])
			expect(await stopped(all(codeImportPackets(body(whole))))).toEqual(stop("failed", "IMPORT_SOURCE_PROTOCOL"));
	});

	it("reads the same lines however the stream is cut", async () => {
		const answer = Buffer.concat([
			pkt(`${A} HEAD symref-target:refs/heads/main\n`),
			pkt(`${A} refs/heads/main\n`),
			DELIM,
			pkt(Buffer.from([1, 2, 3])),
			FLUSH,
			END,
		]);
		const want = await all(codeImportPackets(body(answer)));
		expect(want).toHaveLength(6);
		for (const [cut] of cuts(answer))
			expect(await all(codeImportPackets(cut as AsyncIterable<Uint8Array>))).toEqual(want);
	});
});

/** GitHub's advertisement, byte for byte as the check saw it (12 Nov, node02). */
const GITHUB_ADVERTISEMENT = Buffer.concat([
	Buffer.from("001e# service=git-upload-pack\n0000"),
	pkt("version 2\n"),
	pkt("agent=git/github-8a7a2c5d1e3f\n"),
	pkt("ls-refs=unborn\n"),
	pkt("fetch=shallow wait-for-done filter\n"),
	pkt("server-option\n"),
	pkt("object-format=sha1\n"),
	FLUSH,
]);

describe("the capability advertisement", () => {
	it("reads GitHub's form, with its service line, however it is cut", async () => {
		for (const [cut] of cuts(GITHUB_ADVERTISEMENT)) {
			const server = await codeImportAdvertisement(cut as AsyncIterable<Uint8Array>);
			expect(server.objectFormat).toBe("sha1");
			expect([...server.capabilities]).toEqual([
				["agent", "git/github-8a7a2c5d1e3f"],
				["ls-refs", "unborn"],
				["fetch", "shallow wait-for-done filter"],
				["server-option", null],
				["object-format", "sha1"],
			]);
		}
	});

	it("refuses what is not version 2 as asked, and a repository of SHA-256", async () => {
		const advertise = (...lines: (string | Buffer)[]) =>
			codeImportAdvertisement(
				body(Buffer.concat(lines.map((line) => (typeof line === "string" ? pkt(line) : line)))),
			);
		const caps = ["ls-refs\n", "fetch\n"];
		expect((await advertise("version 2\n", ...caps, FLUSH)).capabilities.size).toBe(2);
		expect(await stopped(advertise("version 2\n", ...caps, "object-format=sha256\n", FLUSH))).toEqual(
			stop("refused", "IMPORT_SHA256_REPOSITORY"),
		);
		for (const lines of [
			[`${A} HEAD\0multi_ack\n`, FLUSH],
			["# service=git-upload-pack\n", "version 2\n", ...caps, FLUSH],
			["version 1\n", ...caps, FLUSH],
			["version 2\n", "fetch\n", FLUSH],
			["version 2\n", "ls-refs\n", FLUSH],
			["version 2\n", ...caps, "object-format=md5\n", FLUSH],
			["version 2\n", ...caps, "fetch\n", FLUSH],
			["version 2\n", ...caps],
			["version 2\n", ...caps, DELIM],
			["version 2\n", ...caps, FLUSH, "more\n"],
			["version 2\n", ...caps, "bad capability\n", FLUSH],
			[FLUSH],
			[],
		])
			expect(await stopped(advertise(...lines)), JSON.stringify(lines)).toEqual(
				stop("failed", "IMPORT_SOURCE_PROTOCOL"),
			);
		expect(await stopped(advertise("ERR Repository not found.\n"))).toEqual(stop("failed", "IMPORT_SOURCE_ERROR"));
		const big = Array.from({ length: 700 }, (_, i) => `x${i}=${"v".repeat(90)}\n`);
		expect(await stopped(advertise("version 2\n", ...caps, ...big, FLUSH))).toEqual(
			stop("failed", "IMPORT_SOURCE_PROTOCOL"),
		);
	});

	it("stops reading its body once it stops", async () => {
		let returned = false;
		const source: AsyncIterable<Uint8Array> = {
			[Symbol.asyncIterator]() {
				let sent = false;
				return {
					next: async () => {
						if (sent) return { done: false, value: pkt("more\n") };
						sent = true;
						return { done: false, value: pkt("version 1\n") };
					},
					return: async () => {
						returned = true;
						return { done: true, value: undefined };
					},
				};
			},
		};
		await expect(codeImportAdvertisement(source)).rejects.toThrow("IMPORT_SOURCE_PROTOCOL");
		expect(returned).toBe(true);
	});
});

describe("the ref list", () => {
	const listing = (...lines: (string | Buffer)[]) =>
		Buffer.concat(lines.map((line) => (typeof line === "string" ? pkt(line) : line)));
	const answer = listing(
		`${A} HEAD symref-target:refs/heads/master\n`,
		`${A} refs/heads/master\n`,
		`${B} refs/heads/feature\n`,
		`${C} refs/tags/v1 peeled:${A}\n`,
		`${B} refs/tags/v0\n`,
		FLUSH,
	);

	it("reads HEAD's branch, the heads and peeled tags, however it is cut", async () => {
		const want: CodeImportRefList = {
			head: { oid: A, target: "refs/heads/master" },
			refs: [
				{ name: "refs/heads/master", oid: A, peeled: null },
				{ name: "refs/heads/feature", oid: B, peeled: null },
				{ name: "refs/tags/v1", oid: C, peeled: A },
				{ name: "refs/tags/v0", oid: B, peeled: null },
			],
			unreadable: 0,
		};
		for (const [cut] of cuts(answer)) expect(await codeImportRefList(cut as AsyncIterable<Uint8Array>)).toEqual(want);
		expect(await codeImportRefList(body(answer, END))).toEqual(want);
	});

	it("passes over what it cannot name and refuses what is no list", async () => {
		const odd = await codeImportRefList(
			body(
				listing(
					"unborn HEAD symref-target:refs/heads/main\n",
					`${A} refs/pull/1/head\n`,
					`${B} refs/heads/x future:attribute\n`,
				),
				pkt(Buffer.concat([Buffer.from(`${C} refs/heads/`), Buffer.from([0xff, 0xfe]), Buffer.from("\n")])),
				FLUSH,
			),
		);
		expect(odd).toEqual({
			head: { oid: null, target: "refs/heads/main" },
			refs: [{ name: "refs/heads/x", oid: B, peeled: null }],
			unreadable: 2,
		});
		for (const lines of [
			[`${A} refs/heads/a\n`],
			[`${A} refs/heads/a\n`, DELIM, FLUSH],
			[`${A} refs/heads/a\n`, FLUSH, `${B} refs/heads/b\n`],
			[`${A} refs/heads/a\n`, FLUSH, END, END],
			[`${A.slice(1)} refs/heads/a\n`, FLUSH],
			[`${"e".repeat(64)} refs/heads/a\n`, FLUSH],
			[`${A} refs/heads/a\n`, `${B} refs/heads/a\n`, FLUSH],
			[`${A} HEAD\n`, `${A} HEAD\n`, FLUSH],
			[`${A}\n`, FLUSH],
			[`${A} refs/tags/v peeled:xyz\n`, FLUSH],
			[`unborn refs/heads/a\n`, FLUSH],
		])
			expect(await stopped(codeImportRefList(body(listing(...lines)))), JSON.stringify(lines)).toEqual(
				stop("failed", "IMPORT_SOURCE_PROTOCOL"),
			);
		expect(await stopped(codeImportRefList(body(listing("ERR access denied\n"))))).toEqual(
			stop("failed", "IMPORT_SOURCE_ERROR"),
		);
	});

	it("is bounded before any pack: 20,000 lines and 4 MiB", async () => {
		const lines = (count: number) =>
			listing(...Array.from({ length: count }, (_, i) => `${A} refs/tags/t${i}\n`), FLUSH);
		expect((await codeImportRefList(body(lines(20_000)))).refs).toHaveLength(20_000);
		expect(await stopped(codeImportRefList(body(lines(20_001))))).toEqual(stop("refused", "IMPORT_TOO_MANY_REFS"));
		const long = (count: number) =>
			listing(
				...Array.from({ length: count }, (_, i) => `${A} refs/heads/${String(i).padStart(60_000, "x")}\n`),
				FLUSH,
			);
		expect((await codeImportRefList(pieces(long(69), 65_536))).refs).toHaveLength(69);
		expect(await stopped(codeImportRefList(pieces(long(70), 65_536)))).toEqual(
			stop("refused", "IMPORT_TOO_MANY_REFS"),
		);
	});
});

describe("the wants", () => {
	const list = (
		refs: [string, string, string?][],
		head: CodeImportRefList["head"] = { oid: A, target: "refs/heads/master" },
	) =>
		({
			head,
			refs: refs.map(([name, oid, peeled]) => ({ name, oid, peeled: peeled ?? null })),
			unreadable: 1,
		}) as CodeImportRefList;
	const refs: [string, string, string?][] = [
		["refs/tags/v1", C, A],
		["refs/heads/zeta", B],
		["refs/heads/master", A],
		["refs/heads/alpha", D],
		["refs/tags/v0", B],
	];

	it("takes the default branch first, then heads and tags by name, each object once", () => {
		expect(codeImportWants(list(refs))).toEqual({
			defaultBranch: "master",
			mainSha: A,
			refs: [
				{ name: "refs/heads/master", sha: A },
				{ name: "refs/heads/alpha", sha: D },
				{ name: "refs/heads/zeta", sha: B },
				{ name: "refs/tags/v0", sha: B },
				{ name: "refs/tags/v1", sha: C },
			],
			wants: [A, D, B, C],
			leftOut: 1,
		});
		// A branch the request named.
		expect(codeImportWants(list(refs), { branch: "zeta" })).toMatchObject({ defaultBranch: "zeta", mainSha: B });
	});

	it("leaves out what is past the wants' cap, and names the header refuses; a ref of a wanted object comes along", () => {
		const wanted = codeImportWants(list(refs), { maximumWants: 2 });
		expect(wanted.wants).toEqual([A, D]);
		expect(wanted.refs.map((ref) => ref.name)).toEqual(["refs/heads/master", "refs/heads/alpha"]);
		expect(wanted.leftOut).toBe(4);
		const three = codeImportWants(list(refs), { maximumWants: 3 });
		expect(three.refs.map((ref) => ref.name)).toEqual([
			"refs/heads/master",
			"refs/heads/alpha",
			"refs/heads/zeta",
			"refs/tags/v0",
		]);
		expect(three.leftOut).toBe(2);
		const names = codeImportWants(
			list([
				["refs/heads/master", A],
				["refs/heads/a..b", B],
				[`refs/heads/${"x".repeat(990)}`, C],
			]),
		);
		expect(names.refs).toEqual([{ name: "refs/heads/master", sha: A }]);
		expect(names.leftOut).toBe(3);
		// A tag and a branch with a part of 256 bytes, and a tag whose last part is 251, are left out and counted, and
		// their objects never wanted; a folder part of 255 and a last part of 250 come.
		const long = codeImportWants(
			list([
				["refs/heads/master", A],
				[`refs/tags/${"t".repeat(256)}`, B],
				[`refs/heads/${"b".repeat(256)}/x`, C],
				[`refs/tags/${"u".repeat(251)}`, "f".repeat(40)],
				[`refs/tags/${"t".repeat(250)}`, D],
				[`refs/heads/${"b".repeat(255)}/x`, "e".repeat(40)],
			]),
		);
		expect(long.refs.map((ref) => ref.name)).toEqual([
			"refs/heads/master",
			`refs/heads/${"b".repeat(255)}/x`,
			`refs/tags/${"t".repeat(250)}`,
		]);
		expect(long.wants).toEqual([A, "e".repeat(40), D]);
		expect(long.leftOut).toBe(4);
		expect(() => codeImportWants(list(refs), { maximumWants: 0 })).toThrow("INVALID_CODE_IMPORT");
		expect(() => codeImportWants(list(refs), { maximumWants: 5_001 })).toThrow("INVALID_CODE_IMPORT");
	});

	it("refuses an empty project, a branch that is not there and a name it does not take", () => {
		const of = (work: () => unknown) => {
			try {
				work();
			} catch (error) {
				return error instanceof CodeImportStop ? error.code : String(error);
			}
			return "none";
		};
		expect(of(() => codeImportWants(list(refs, null)))).toBe("IMPORT_SOURCE_EMPTY");
		expect(of(() => codeImportWants(list(refs, { oid: null, target: "refs/heads/main" })))).toBe(
			"IMPORT_SOURCE_EMPTY",
		);
		expect(of(() => codeImportWants(list(refs, { oid: A, target: null })))).toBe("IMPORT_BRANCH_UNKNOWN");
		expect(of(() => codeImportWants(list(refs, { oid: C, target: "refs/tags/v1" })))).toBe("IMPORT_BRANCH_UNKNOWN");
		expect(of(() => codeImportWants(list(refs, { oid: A, target: "refs/heads/gone" })))).toBe(
			"IMPORT_BRANCH_UNKNOWN",
		);
		expect(of(() => codeImportWants(list(refs), { branch: "gone" }))).toBe("IMPORT_BRANCH_UNKNOWN");
		expect(of(() => codeImportWants(list(refs), { branch: "a b" }))).toBe("IMPORT_BRANCH_NAME");
		const keyed = `refs/heads/${PLANTED.aws}`;
		expect(of(() => codeImportWants(list([[keyed, A]], { oid: A, target: keyed })))).toBe("IMPORT_BRANCH_NAME");
		const long = `refs/heads/${"x".repeat(201)}`;
		expect(of(() => codeImportWants(list([[long, A]], { oid: A, target: long })))).toBe("IMPORT_BRANCH_NAME");
		// A default branch with a part of 256 bytes (over 200 bytes as well).
		const part = `refs/heads/${"x".repeat(256)}`;
		expect(of(() => codeImportWants(list([[part, A]], { oid: A, target: part })))).toBe("IMPORT_BRANCH_NAME");
		expect(of(() => codeImportWants(list([[part, A]]), { branch: "x".repeat(256) }))).toBe("IMPORT_BRANCH_NAME");
	});
});

describe("the requests", () => {
	it("asks for the ref list as git and GitHub take it", () => {
		expect(codeImportLsRefsRequest().toString()).toBe(
			"0014command=ls-refs\n0017object-format=sha1\n0001" +
				"0009peel\n000csymrefs\n0014ref-prefix HEAD\n001bref-prefix refs/heads/\n001aref-prefix refs/tags/\n0000",
		);
	});

	it("asks for the pack with ofs-delta, the wants and done, 5,000 of them in 250,072 bytes", () => {
		expect(codeImportFetchRequest([A, B]).toString()).toBe(
			`0012command=fetch\n0017object-format=sha1\n0001000eofs-delta\n0032want ${A}\n0032want ${B}\n0009done\n0000`,
		);
		const many = Array.from({ length: 5_000 }, (_, i) => i.toString(16).padStart(40, "0"));
		expect(codeImportFetchRequest(many).length).toBe(250_072);
		for (const bad of [[], [A, A], ["xyz"], [...many, "f".repeat(40)], "A" as unknown as string[]])
			expect(() => codeImportFetchRequest(bad)).toThrow("INVALID_CODE_IMPORT");
	});
});

/** A pack's first bytes, and a whole small one. */
const PACK = Buffer.concat([Buffer.from("PACK"), Buffer.from([0, 0, 0, 2, 0, 0, 0, 1]), Buffer.alloc(30, 7)]);
const band = (n: number, data: Uint8Array | string) =>
	pkt(Buffer.concat([Buffer.from([n]), typeof data === "string" ? Buffer.from(data) : data]));

describe("the pack", () => {
	const answer = Buffer.concat([
		pkt("packfile\n"),
		band(2, "Enumerating objects: 3, done.\n"),
		band(1, PACK.subarray(0, 5)),
		Buffer.from("0005\x01"),
		band(1, PACK.subarray(5, 20)),
		band(2, "Total 3\n"),
		band(1, PACK.subarray(20)),
		FLUSH,
	]);

	it("hands on the bytes of band 1 as they come, counting band 2 and keep-alives, however the answer is cut", async () => {
		for (const [cut] of cuts(answer)) {
			const stats = codeImportPackStats();
			const got = await all(codeImportPack(cut as AsyncIterable<Uint8Array>, stats));
			expect(Buffer.concat(got)).toEqual(PACK);
			expect(stats).toEqual({ packets: 6, progress: 2, keepAlives: 1, bytes: PACK.length });
		}
		expect(Buffer.concat(await all(codeImportPack(body(answer, END))))).toEqual(PACK);
	});

	it("says the source's errors, and refuses what is no pack", async () => {
		const pack = (...parts: Buffer[]) => all(codeImportPack(body(Buffer.concat(parts))));
		// GitHub's own words for a want it lacks, a top-level line with HTTP 200.
		expect(await stopped(pack(Buffer.from(`0049ERR upload-pack: not our ref ${A}`)))).toEqual(
			stop("failed", "IMPORT_SOURCE_ERROR", true),
		);
		expect(await stopped(pack(pkt("packfile\n"), band(1, PACK), pkt("ERR upload-pack: timeout\n")))).toEqual(
			stop("failed", "IMPORT_SOURCE_ERROR"),
		);
		expect(await stopped(pack(pkt("packfile\n"), band(3, "fatal: not our ref x\n")))).toEqual(
			stop("failed", "IMPORT_SOURCE_ERROR", true),
		);
		expect(await stopped(pack(pkt("packfile\n"), band(3, "error: out of memory\n")))).toEqual(
			stop("failed", "IMPORT_SOURCE_ERROR"),
		);
		for (const parts of [
			[pkt("acknowledgments\n"), FLUSH],
			[pkt("packfile\n"), band(1, PACK)],
			[pkt("packfile\n"), band(1, PACK), DELIM, FLUSH],
			[pkt("packfile\n"), band(1, PACK), END],
			[pkt("packfile\n"), Buffer.from("0004"), FLUSH],
			[pkt("packfile\n"), band(4, "x"), FLUSH],
			[pkt("packfile\n"), band(1, Buffer.concat([Buffer.from("KCAP"), PACK.subarray(4)])), FLUSH],
			[
				pkt("packfile\n"),
				band(1, Buffer.concat([PACK.subarray(0, 4), Buffer.from([0, 0, 0, 4]), PACK.subarray(8)])),
				FLUSH,
			],
			[pkt("packfile\n"), band(1, PACK.subarray(0, 31)), FLUSH],
			[pkt("packfile\n"), band(1, PACK.subarray(0, 8)), FLUSH],
			[pkt("packfile\n"), FLUSH],
			[pkt("packfile\n"), band(1, PACK), FLUSH, band(1, "more")],
			[pkt("packfile\n"), band(1, PACK), FLUSH, END, END],
			[FLUSH],
			[],
		])
			expect(await stopped(pack(...parts)), JSON.stringify(parts.map(String))).toEqual(
				stop("failed", "IMPORT_SOURCE_PROTOCOL"),
			);
	});

	it("stops reading its body when it stops, and when its reader does", async () => {
		/** A body that never ends: the pack's line, then the lines `next` gives, and that says when it is closed. */
		const endless = (next: (sent: number) => Buffer) => {
			const state = { returned: false };
			let sent = 0;
			const source: AsyncIterable<Uint8Array> = {
				[Symbol.asyncIterator]: () => ({
					next: async () => {
						sent += 1;
						return { done: false, value: sent === 1 ? pkt("packfile\n") : next(sent) };
					},
					return: async () => {
						state.returned = true;
						return { done: true, value: undefined };
					},
				}),
			};
			return { state, source };
		};
		const read = endless(() => band(1, PACK));
		for await (const piece of codeImportPack(read.source)) {
			expect(piece.length).toBeGreaterThan(0);
			break;
		}
		expect(read.state.returned).toBe(true);
		const failing = endless((sent) => (sent === 2 ? band(1, PACK) : band(3, "error: gone\n")));
		await expect(all(codeImportPack(failing.source))).rejects.toThrow("IMPORT_SOURCE_ERROR");
		expect(failing.state.returned).toBe(true);
	});

	it("passes a 1 GiB pack through in bounded memory: a reader that is slow holds the source back", async () => {
		const data = 65_515,
			count = Math.ceil(GiB / data) + 1;
		const line = Buffer.alloc(65_520, 0x5a);
		line.write("fff0", 0, "latin1");
		line[4] = 1;
		const first = Buffer.from(line);
		PACK.subarray(0, 12).copy(first, 5);
		let produced = 0;
		const source = (async function* () {
			yield pkt("packfile\n");
			for (let i = 0; i < count; i++) {
				produced += data;
				yield i === 0 ? first : line;
			}
			yield FLUSH;
		})();
		const header = codeImportBundleHeader([{ name: "refs/heads/main", sha: A }]);
		let taken = 0,
			peak = 0,
			ahead = 0;
		for await (const piece of codeImportBundlePieces(header, codeImportPack(source), 2 * GiB)) {
			taken += piece.length;
			ahead = Math.max(ahead, produced - (taken - header.length));
			if (taken % (128 * MiB) < MiB) peak = Math.max(peak, process.memoryUsage().arrayBuffers);
			await new Promise((resolve) => setImmediate(resolve));
		}
		expect(taken).toBe(header.length + count * data);
		expect(ahead).toBeLessThanOrEqual(MiB + 2 * 65_520);
		expect(peak).toBeLessThan(512 * MiB);
	}, 120_000);
});

describe("the bundle", () => {
	it("writes its header as git took it, and reads a header back", () => {
		const refs = [
			{ name: "refs/heads/main", sha: A },
			{ name: "refs/tags/v1", sha: B },
		];
		const header = codeImportBundleHeader(refs);
		expect(header.toString()).toBe(`# v2 git bundle\n${A} refs/heads/main\n${B} refs/tags/v1\n\n`);
		expect(codeImportBundleHeaderOf(Buffer.concat([header, PACK]))).toEqual({
			version: 2,
			capabilities: new Map(),
			prerequisites: 0,
			refs,
			bytes: header.length,
		});
		for (const bad of [
			[],
			[{ name: "refs/heads/main", sha: "x" }],
			[{ name: "refs/remotes/o/main", sha: A }],
			[{ name: "refs/heads/a b", sha: A }],
			[
				{ name: "refs/heads/main", sha: A },
				{ name: "refs/heads/main", sha: B },
			],
		])
			expect(() => codeImportBundleHeader(bad)).toThrow("INVALID_CODE_IMPORT_BUNDLE_HEADER");
	});

	it("reads a file's header: v3 with its object format, prerequisites, and what is none", () => {
		const v3 = Buffer.from(
			`# v3 git bundle\n@object-format=sha1\n@filter=blob:none\n-${C} old\n${A} refs/heads/main\n${B} HEAD\n\nPACK`,
		);
		const read = codeImportBundleHeaderOf(v3);
		expect(read).toMatchObject({ version: 3, prerequisites: 1, bytes: v3.length - 4 });
		expect([...read.capabilities]).toEqual([
			["object-format", "sha1"],
			["filter", "blob:none"],
		]);
		expect(read.refs).toEqual([
			{ name: "refs/heads/main", sha: A },
			{ name: "HEAD", sha: B },
		]);
		const code = (bytes: string | Buffer) => {
			try {
				codeImportBundleHeaderOf(Buffer.from(bytes));
			} catch (error) {
				return (error as CodeImportStop).code;
			}
			return "read";
		};
		expect(code(`# v3 git bundle\n@object-format=sha256\n${"e".repeat(64)} refs/heads/main\n\n`)).toBe(
			"IMPORT_SHA256_REPOSITORY",
		);
		for (const bad of [
			"PK\u0003\u0004 a zip",
			`# v2 git bundle\n${A} refs/heads/main\n`,
			`# v4 git bundle\n${A} refs/heads/main\n\n`,
			`# v2 git bundle\n@object-format=sha1\n${A} refs/heads/main\n\n`,
			`# v2 git bundle\n${A}\n\n`,
			`# v2 git bundle\n${A.slice(2)} refs/heads/main\n\n`,
			Buffer.concat([Buffer.from(`# v2 git bundle\n${A} refs/heads/`), Buffer.from([0xff]), Buffer.from("\n\n")]),
		])
			expect(code(bad), String(bad)).toBe("IMPORT_FILE_NOT_WHOLE");
	});

	it("hands the bytes on in 1 MiB pieces, each new, and refuses one byte too many before its piece", async () => {
		const header = Buffer.from("header\n\n");
		const pack = Buffer.alloc(3 * MiB + 5, 9);
		const got = await all(codeImportBundlePieces(header, pieces(pack, 70_000), 4 * MiB));
		expect(got.map((piece) => piece.length)).toEqual([MiB, MiB, MiB, header.length + 5]);
		expect(new Set(got.map((piece) => piece.buffer)).size).toBe(4);
		expect(Buffer.concat(got).equals(Buffer.concat([header, pack]))).toBe(true);
		const exact = header.length + pack.length;
		expect((await all(codeImportBundlePieces(header, pieces(pack, 4096), exact))).length).toBe(4);
		let handed = 0;
		const over = (async () => {
			for await (const piece of codeImportBundlePieces(header, pieces(pack, 4096), exact - 1))
				handed += piece.length;
		})();
		expect(await stopped(over)).toEqual(stop("refused", "IMPORT_TOO_LARGE"));
		expect(handed).toBe(3 * MiB);
		for (const [max, size] of [
			[0, MiB],
			[2 * GiB + 1, MiB],
			[GiB, 0],
			[GiB, 16 * MiB + 1],
		])
			await expect(all(codeImportBundlePieces(header, pieces(pack, 4096), max, size))).rejects.toThrow(
				"INVALID_CODE_IMPORT",
			);
	});
});

describe("the transport's answers", () => {
	const source = (status: number, contentType: string | null = null): CodeImportAnswer => ({
		by: "source",
		status,
		contentType,
		body: body(),
	});
	const relay = (status: number): CodeImportAnswer => ({ by: "relay", status, error: "unavailable" });
	const of = (answer: CodeImportAnswer, type: "advertisement" | "result" = "result") => {
		const s = codeImportAnswerStop(answer, type);
		return s && [s.end, s.code];
	};

	it("reads the source's own answer of the asked type, and says how every other one ends", () => {
		expect(of(source(200, "application/x-git-upload-pack-result"))).toBeNull();
		expect(of(source(200, "application/x-git-upload-pack-advertisement"), "advertisement")).toBeNull();
		expect(of(source(200, "application/x-git-upload-pack-advertisement"))).toEqual([
			"failed",
			"IMPORT_SOURCE_PROTOCOL",
		]);
		expect(of(source(200, "text/html"), "advertisement")).toEqual(["failed", "IMPORT_SOURCE_PROTOCOL"]);
		expect(of(source(200))).toEqual(["failed", "IMPORT_SOURCE_PROTOCOL"]);
		for (const status of [301, 302, 307, 308]) expect(of(source(status))).toEqual(["refused", "IMPORT_SOURCE_MOVED"]);
		for (const status of [401, 403, 404]) expect(of(source(status))).toEqual(["refused", "IMPORT_SOURCE_REFUSED"]);
		for (const status of [429, 500, 502, 503, 599])
			expect(of(source(status))).toEqual(["busy", "IMPORT_SOURCE_BUSY"]);
		for (const status of [204, 400, 410, 422, 600])
			expect(of(source(status))).toEqual(["failed", "IMPORT_SOURCE_PROTOCOL"]);
		expect(of(relay(403))).toEqual(["busy", "IMPORT_RELAY_REFUSED"]);
		expect(of(relay(503))).toEqual(["busy", "IMPORT_RELAY_BUSY"]);
		expect(of(relay(404))).toEqual(["failed", "IMPORT_RELAY_NOT_ROUTED"]);
		for (const status of [400, 500, 200]) expect(of(relay(status))).toEqual(["failed", "IMPORT_RELAY_FAILED"]);
	});

	it("ends refused at the relay's third own 403 in a row, and counts again after any other end", () => {
		const refusal = () => codeImportAnswerStop(relay(403), "result");
		let count = 0;
		const ends: string[] = [];
		for (let i = 0; i < 3; i++) {
			const next = codeImportRelayRefusals(count, refusal());
			count = next.relayRefused;
			ends.push(`${next.stop?.end}:${next.stop?.code}`);
		}
		expect(ends).toEqual(["busy:IMPORT_RELAY_REFUSED", "busy:IMPORT_RELAY_REFUSED", "refused:IMPORT_SOURCE_REFUSED"]);
		expect(count).toBe(3);
		const busy = codeImportAnswerStop(relay(503), "result");
		expect(codeImportRelayRefusals(2, busy)).toEqual({ relayRefused: 0, stop: busy });
		expect(codeImportRelayRefusals(2, null)).toEqual({ relayRefused: 0, stop: null });
		expect(codeImportRelayRefusals(1, refusal()).relayRefused).toBe(2);
	});
});

const DAY = 86_400;
const NOW = Date.UTC(2026, 10, 12, 14, 0, 0);
const nowSeconds = NOW / 1000;
const ref = (name: string, sha: string, time = nowSeconds, type = "commit", peeledType = ""): CodeImportRefSeen => ({
	name,
	sha,
	type,
	peeledType,
	time,
});
const shaOf = (i: number) => i.toString(16).padStart(40, "0");

describe("the refs plan", () => {
	const plan = (refs: CodeImportRefSeen[], defaultBranch = "master") =>
		codeImportRefsPlan({ repository: place, defaultBranch, refs, now: NOW });

	it("keeps main and the mark at the default branch, tags on commits and the heads of 90 days, each with its reason when not", () => {
		const refs = [
			ref("refs/heads/master", A, nowSeconds - 10),
			ref("refs/heads/feature", B, nowSeconds - 5),
			ref("refs/heads/edge", B, nowSeconds - CODE_IMPORT_BRANCH_DAYS * DAY),
			ref("refs/heads/stale", C, nowSeconds - CODE_IMPORT_BRANCH_DAYS * DAY - 1),
			ref("refs/heads/odd", C, nowSeconds, "tag", "commit"),
			ref("refs/tags/v1", D, nowSeconds - 100, "tag", "commit"),
			ref("refs/tags/v0", A, nowSeconds - 200),
			ref("refs/tags/tree", C, nowSeconds, "tag", "tree"),
			ref("refs/tags/nested", C, nowSeconds, "tag", "tag"),
			ref("refs/tags/blob", C, nowSeconds, "blob"),
			ref("refs/remotes/origin/master", A),
			ref("refs/pull/1/head", B),
		];
		const made = plan(refs);
		expect(made.mainSha).toBe(A);
		expect(made.refs).toEqual(
			[
				{ name: "refs/heads/main", sha: A },
				{ name: "refs/qorpera/imported/heads/edge", sha: B },
				{ name: "refs/qorpera/imported/heads/feature", sha: B },
				{ name: "refs/qorpera/kept-here", sha: A },
				{ name: "refs/tags/v0", sha: A },
				{ name: "refs/tags/v1", sha: D },
			].sort((a, b) => Buffer.compare(Buffer.from(a.name), Buffer.from(b.name))),
		);
		expect(made.refsSha256).toBe(codeRefsSha256(made.refs));
		expect(made.tags).toEqual({ seen: 5, kept: 2 });
		expect(made.branches).toEqual({ seen: 4, kept: 2 });
		expect(made.leftOutBy).toEqual({ name: 0, clash: 0, notCommit: 4, older: 1, over: 0, other: 2 });
		expect(made.leftOut).toBe(7);
		// One transaction deletes what is not kept as it is, the next makes what is new, each with the value it moves from.
		const lines = made.stdin.toString().split("\0");
		expect(lines.pop()).toBe("");
		const second = lines.indexOf("start", 1);
		expect(lines.slice(0, 1)).toEqual(["start"]);
		expect(lines.slice(second - 2, second)).toEqual(["prepare", "commit"]);
		expect(lines.slice(-2)).toEqual(["prepare", "commit"]);
		const deleted = lines.slice(1, second - 2),
			created = lines.slice(second + 1, -2);
		expect(deleted.filter((_, i) => i % 2 === 0).sort()).toEqual(
			[
				"delete refs/heads/master",
				"delete refs/heads/feature",
				"delete refs/heads/edge",
				"delete refs/heads/stale",
				"delete refs/heads/odd",
				"delete refs/tags/tree",
				"delete refs/tags/nested",
				"delete refs/tags/blob",
				"delete refs/remotes/origin/master",
				"delete refs/pull/1/head",
			].sort(),
		);
		expect(deleted[deleted.indexOf("delete refs/heads/odd") + 1]).toBe(C);
		expect(created).toEqual([
			"create refs/heads/main",
			A,
			"create refs/qorpera/imported/heads/edge",
			B,
			"create refs/qorpera/imported/heads/feature",
			B,
			"create refs/qorpera/kept-here",
			A,
		]);
	});

	it("keeps 500 tags and 200 heads, newest first, ties by name", () => {
		const refs = [
			ref("refs/heads/master", A),
			...Array.from({ length: 501 }, (_, i) =>
				ref(`refs/tags/t${String(i).padStart(3, "0")}`, shaOf(i + 1), nowSeconds - i),
			),
			ref("refs/tags/same-b", shaOf(9001), nowSeconds - 1),
			ref("refs/tags/same-a", shaOf(9002), nowSeconds - 1),
			...Array.from({ length: 201 }, (_, i) =>
				ref(`refs/heads/b${String(i).padStart(3, "0")}`, shaOf(1000 + i), nowSeconds - i),
			),
		];
		const made = plan(refs);
		const tags = made.refs.filter((r) => r.name.startsWith("refs/tags/")).map((r) => r.name);
		expect(tags).toHaveLength(500);
		expect(tags).toContain("refs/tags/same-a");
		expect(tags).toContain("refs/tags/same-b");
		expect(tags).not.toContain("refs/tags/t499");
		expect(tags).toContain("refs/tags/t497");
		expect(tags).not.toContain("refs/tags/t498");
		const heads = made.refs.filter((r) => r.name.startsWith("refs/qorpera/imported/")).map((r) => r.name);
		expect(heads).toHaveLength(200);
		expect(heads).not.toContain("refs/qorpera/imported/heads/b200");
		expect(made.tags).toEqual({ seen: 503, kept: 500 });
		expect(made.branches).toEqual({ seen: 201, kept: 200 });
		expect(made.leftOutBy).toMatchObject({ over: 4 });
		// The same newest time: the name decides, a before b.
		const tied = plan([
			ref("refs/heads/master", A),
			...Array.from({ length: 500 }, (_, i) => ref(`refs/tags/t${i}`, shaOf(i + 1), nowSeconds)),
			ref("refs/tags/aaa", B, nowSeconds - 1),
			ref("refs/tags/zzz", C, nowSeconds - 1),
		]);
		expect(tied.refs.map((r) => r.name)).not.toContain("refs/tags/aaa");
		const ab = plan([
			ref("refs/heads/master", A),
			...Array.from({ length: 499 }, (_, i) => ref(`refs/tags/t${i}`, shaOf(i + 1), nowSeconds)),
			ref("refs/tags/zzz", C, nowSeconds - 1),
			ref("refs/tags/aaa", B, nowSeconds - 1),
		]);
		expect(ab.refs.map((r) => r.name)).toContain("refs/tags/aaa");
		expect(ab.refs.map((r) => r.name)).not.toContain("refs/tags/zzz");
	});

	it("leaves out names git, restore's own test, the disk or the folder refuse, and one name to the folder with an earlier one", () => {
		// 4,097 bytes where the folder keeps it, of parts the disk can hold.
		const long = `refs/heads/${`${"l".repeat(200)}/`.repeat(20)}${"l".repeat(25)}`;
		expect(Buffer.byteLength(`code/acme/shop/repo.git/refs/qorpera/imported/heads/${long.slice(11)}`)).toBe(4097);
		const made = plan([
			ref("refs/heads/master", A),
			ref("refs/heads/e\u0301", B),
			ref("refs/heads/a./b", B),
			ref("refs/heads/sp\u00a0ace", B),
			ref("refs/heads/bad..name", B),
			ref(long, B),
			ref("refs/tags/Fix", C, nowSeconds - 1),
			ref("refs/tags/fix", D, nowSeconds - 2),
			ref("refs/heads/topic", B, nowSeconds - 1),
			ref("refs/heads/Topic/part", C, nowSeconds - 2),
			ref("refs/heads/Main", D),
			ref("refs/tags/stra\u00dfe", B, nowSeconds - 3),
			// A part the code host's disk cannot hold, in a tag or a branch (256, or a last part of 251); 255 and 250 it holds.
			ref(`refs/tags/${"t".repeat(256)}`, C, nowSeconds - 4),
			ref(`refs/heads/${"b".repeat(256)}/y`, C, nowSeconds - 4),
			ref(`refs/heads/y/${"c".repeat(251)}`, C, nowSeconds - 4),
			ref(`refs/tags/${"t".repeat(250)}`, D, nowSeconds - 5),
			ref(`refs/heads/${"b".repeat(255)}/y`, D, nowSeconds - 5),
		]);
		expect(made.refs.map((r) => r.name)).toEqual(
			[
				"refs/heads/main",
				"refs/qorpera/imported/heads/Main",
				"refs/qorpera/imported/heads/topic",
				`refs/qorpera/imported/heads/${"b".repeat(255)}/y`,
				"refs/qorpera/kept-here",
				"refs/tags/Fix",
				"refs/tags/stra\u00dfe",
				`refs/tags/${"t".repeat(250)}`,
			].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))),
		);
		expect(made.leftOutBy).toEqual({ name: 8, clash: 2, notCommit: 0, older: 0, over: 0, other: 0 });
		const lines = made.stdin.toString().split("\0");
		expect(lines).toContain(`delete refs/tags/${"t".repeat(256)}`);
		expect(lines.filter((line) => line.startsWith("create ") && /(t{256}|b{256}|c{251})/.test(line))).toEqual([]);
	});

	it("refuses a default branch that is none, or one it does not take, and input that is not a repository's refs", () => {
		const code = (work: () => unknown) => {
			try {
				work();
			} catch (error) {
				return error instanceof CodeImportStop ? error.code : (error as Error).message;
			}
			return "planned";
		};
		expect(code(() => plan([ref("refs/heads/other", A)]))).toBe("IMPORT_BRANCH_UNKNOWN");
		expect(code(() => plan([ref("refs/heads/master", C, nowSeconds, "tag", "commit")]))).toBe(
			"IMPORT_BRANCH_UNKNOWN",
		);
		expect(code(() => plan([ref(`refs/heads/${PLANTED.github}`, A)], PLANTED.github))).toBe("IMPORT_BRANCH_NAME");
		expect(code(() => plan([ref("refs/heads/master", A)], "x".repeat(201)))).toBe("IMPORT_BRANCH_NAME");
		expect(code(() => plan([ref(`refs/heads/${"x".repeat(256)}`, A)], "x".repeat(256)))).toBe("IMPORT_BRANCH_NAME");
		for (const refs of [
			[ref("HEAD", A), ref("refs/heads/master", A)],
			[ref("refs/heads/master", A), ref("refs/heads/master", B)],
			[ref("refs/heads/master", "x")],
			[ref("refs/heads/master", A, 1.5)],
			[{ ...ref("refs/heads/master", A), type: undefined } as unknown as CodeImportRefSeen],
			[ref("refs/heads/ma\nster", A)],
		])
			expect(code(() => plan(refs))).toBe("INVALID_CODE_IMPORT");
		expect(
			code(() =>
				codeImportRefsPlan({
					repository: { ...place, host: "github.com" } as never,
					defaultBranch: "master",
					refs: [ref("refs/heads/master", A)],
					now: NOW,
				}),
			),
		).toBe("INVALID_CODE_IMPORT");
		expect(
			code(() =>
				codeImportRefsPlan({
					repository: place,
					defaultBranch: "master",
					refs: [ref("refs/heads/master", A)],
					now: -1,
				}),
			),
		).toBe("INVALID_CODE_IMPORT");
	});

	it("does nothing to refs that are already the kept ones", () => {
		const made = plan(
			[
				ref("refs/heads/main", A),
				ref("refs/qorpera/kept-here", A),
				ref("refs/tags/v1", B, nowSeconds - 1, "tag", "commit"),
			],
			"main",
		);
		expect(made.stdin.length).toBe(0);
		expect(made.refs).toEqual([
			{ name: "refs/heads/main", sha: A },
			{ name: "refs/qorpera/kept-here", sha: A },
			{ name: "refs/tags/v1", sha: B },
		]);
		// The mark at another commit: deleted, then made at main's.
		const moved = plan([ref("refs/heads/main", A), ref("refs/qorpera/kept-here", B)], "main");
		expect(moved.stdin.toString().split("\0")).toEqual([
			"start",
			"delete refs/qorpera/kept-here",
			B,
			"prepare",
			"commit",
			"start",
			"create refs/qorpera/kept-here",
			A,
			"prepare",
			"commit",
			"",
		]);
	});
});

describe("a file's default branch", () => {
	const heads = (...names: string[]) => names.map((name, i) => ({ name: `refs/heads/${name}`, sha: shaOf(i + 1) }));
	const branch = (value: Parameters<typeof codeImportFileBranch>[0]) => {
		try {
			return codeImportFileBranch(value);
		} catch (error) {
			return (error as CodeImportStop).code;
		}
	};
	it("takes the branch asked for, the only head, main, master, or the one head at HEAD", () => {
		expect(branch({ branch: "b", refs: heads("a", "b", "main"), headSha: null })).toBe("b");
		expect(branch({ branch: "c", refs: heads("a", "b"), headSha: null })).toBe("IMPORT_BRANCH_UNKNOWN");
		expect(branch({ branch: null, refs: heads("solo"), headSha: null })).toBe("solo");
		expect(branch({ branch: null, refs: heads("a", "master", "main"), headSha: null })).toBe("main");
		expect(branch({ branch: null, refs: heads("a", "master"), headSha: null })).toBe("master");
		expect(branch({ branch: null, refs: heads("a", "b", "c"), headSha: shaOf(2) })).toBe("b");
		expect(
			branch({
				branch: null,
				refs: [...heads("a", "b"), { name: "refs/heads/c", sha: shaOf(2) }],
				headSha: shaOf(2),
			}),
		).toBe("IMPORT_BRANCH_UNKNOWN");
		expect(branch({ branch: null, refs: heads("a", "b"), headSha: null })).toBe("IMPORT_BRANCH_UNKNOWN");
		expect(branch({ branch: null, refs: [{ name: "refs/tags/v1", sha: A }], headSha: A })).toBe(
			"IMPORT_BRANCH_UNKNOWN",
		);
		expect(branch({ branch: null, refs: heads(PLANTED.aws), headSha: null })).toBe("IMPORT_BRANCH_NAME");
	});
});

describe("the look's small rules", () => {
	it("knows an LFS pointer, counts authors but the platform's and bots', and says a commit's time", () => {
		expect(
			codeImportLfsPointer(Buffer.from("version https://git-lfs.github.com/spec/v1\noid sha256:ab\nsize 12\n")),
		).toBe(true);
		expect(codeImportLfsPointer(Buffer.from(`version https://git-lfs.github.com/spec/v1\n${"x".repeat(1024)}`))).toBe(
			false,
		);
		expect(codeImportLfsPointer(Buffer.from("not a pointer"))).toBe(false);
		const pointer = (bytes: number) => Buffer.from("version https://git-lfs.github.com/spec/v1\n".padEnd(bytes, "x"));
		expect(codeImportLfsPointer(pointer(1023))).toBe(true);
		expect(codeImportLfsPointer(pointer(1024))).toBe(false);
		expect(
			codeImportAuthors([
				"Ann@Example.com",
				"ann@example.com ",
				"bob@example.com",
				"code@qorpera.com",
				"0b6f0f3e-1111-4111-8111-111111111111@coding.qorpera.com",
				"dependabot[bot]@users.noreply.github.com",
				"",
			]),
		).toBe(2);
		expect(codeImportTime(0)).toBe("1970-01-01T00:00:00Z");
		expect(codeImportTime(1_762_956_000)).toBe("2025-11-12T14:00:00Z");
		expect(codeImportTime(253_402_300_799)).toBe("9999-12-31T23:59:59Z");
		expect(codeImportTime(253_402_300_800)).toBeNull();
		expect(codeImportTime(-62_135_596_801)).toBeNull();
		expect(codeImportTime(1.5)).toBeNull();
	});
});

/** A look's facts, every bound at its least. */
function facts(more: Partial<CodeImportLookFacts> = {}): CodeImportLookFacts {
	return {
		bytes: 1234,
		defaultBranch: "master",
		mainSha: A,
		commits: 12,
		firstAt: "2024-01-02T03:04:05Z",
		lastAt: "2026-11-12T14:00:00Z",
		authors30d: 2,
		tags: { seen: 3, kept: 2 },
		branches: { seen: 5, kept: 4 },
		leftOut: 2,
		files: 40,
		entries: 52,
		biggest: { path: "assets/logo.png", bytes: 400_000 },
		lfsPointers: 0,
		submodules: 0,
		refused: null,
		secrets: [],
		scan: { blobs: 90, bytes: 2_000_000, all: true },
		why: null,
		...more,
	};
}

describe("the look", () => {
	it("shows paths whole or null, keys in main first, and fits by dropping whole entries", () => {
		const look = codeImportLook(
			facts({
				defaultBranch: PLANTED.aws,
				biggest: { path: `big/${"x".repeat(200)}`, bytes: 9 },
				refused: { code: "CODE_HOST_NAMES_NOT_NFC", paths: Array.from({ length: 12 }, (_, i) => `n${i}`) },
				secrets: [
					{ kind: "aws", path: "old/secret.txt", inMain: false },
					{ kind: "github", path: "src/b.js", inMain: true },
					{ kind: "aws", path: "src/a.js", inMain: true },
					{ kind: "aws", path: "src/a.js", inMain: true },
					{ kind: "google", path: `keys/${PLANTED.aws}/conf.txt`, inMain: true },
					{ kind: "env-file", path: ".env", inMain: true },
				],
				why: "CODE_HOST_NAMES_NOT_NFC",
			}),
		);
		expect(look.defaultBranch).toBeNull();
		expect(look.biggest).toEqual({ path: null, bytes: 9 });
		expect(look.refused).toEqual({
			code: "CODE_HOST_NAMES_NOT_NFC",
			paths: Array.from({ length: 10 }, (_, i) => `n${i}`),
			more: 2,
		});
		expect(look.secrets.found).toBe(6);
		expect(look.secrets.shown).toEqual([
			{ kind: "aws", path: "src/a.js", inMain: true },
			{ kind: "github", path: "src/b.js", inMain: true },
			{ kind: "google", path: null, inMain: true },
			{ kind: "env-file", path: ".env", inMain: true },
			{ kind: "aws", path: "old/secret.txt", inMain: false },
		]);
		expect(look).toMatchObject({ fits: false, why: "CODE_HOST_NAMES_NOT_NFC" });
		// At most 30 shown; and paths that take two bytes each in JSON make it drop more, whole, to fit.
		const many = codeImportLook(
			facts({
				secrets: Array.from({ length: 40 }, (_, i) => ({
					kind: "aws" as const,
					path: `${i}`.padEnd(200, '"'),
					inMain: true,
				})),
				refused: {
					code: "IMPORT_TOO_MANY_FILES",
					paths: Array.from({ length: 10 }, (_, i) => `${i}`.padEnd(200, "\\")),
				},
				why: "IMPORT_TOO_MANY_FILES",
			}),
		);
		expect(many.secrets.found).toBe(40);
		expect(many.secrets.shown.length).toBeGreaterThan(0);
		expect(many.secrets.shown.length).toBeLessThan(30);
		for (const hit of many.secrets.shown) expect(hit.path?.length).toBe(200);
		expect(many.refused.paths.every((path) => path?.length === 200)).toBe(true);
		const text = Buffer.byteLength(JSON.stringify(many));
		expect(text).toBeLessThanOrEqual(CODE_IMPORT_LOOK_BYTES);
		expect(text + 450).toBeGreaterThan(CODE_IMPORT_LOOK_BYTES);
		expect(codeImportJsonbBound(many)).toBeLessThanOrEqual(CODE_IMPORT_LOOK_BYTES);
		expect(codeImportLookOf(JSON.parse(JSON.stringify(many)))).toEqual(many);
		expect(
			codeImportLook(
				facts({
					secrets: Array.from({ length: 31 }, (_, i) => ({ kind: "aws" as const, path: `p${i}`, inMain: true })),
				}),
			).secrets.shown,
		).toHaveLength(30);
	});

	it("bounds the jsonb from above", () => {
		expect(codeImportJsonbBound({})).toBe(11);
		expect(codeImportJsonbBound({ a: "xy" })).toBe(4 + 7 + 8 + 1 + 2);
		expect(codeImportJsonbBound([1, true, null])).toBe(4 + 7 + 12 + 11);
		expect(codeImportJsonbBound(123_456_789)).toBe(4 + 7 + 4 + 9 + 6);
		expect(codeImportJsonbBound(null)).toBe(4 + 7 + 4);
		// pg_column_size of each, as PostgreSQL 17 gave it on node02 (12 Nov): the bound is never below.
		const shown = Array.from({ length: 30 }, (_, i) => ({
			kind: "aws",
			path: `${i}`.padEnd(200, '"'),
			inMain: true,
		}));
		for (const [value, measured] of [
			[null, 12],
			[{}, 8],
			[{ a: "xy" }, 19],
			[[1, true, null], 28],
			[123_456_789, 24],
			[0, 18],
			[Number.MAX_SAFE_INTEGER, 26],
			[Array(200).fill(0), 2406],
			[Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`k${i}`, i])), 5900],
			[{ a: { b: { c: [1, 2, { d: "x".repeat(1000) }] } } }, 1097],
			[
				{
					schema: "qorpera.code-import-look/v1",
					bytes: 1,
					defaultBranch: null,
					mainSha: A,
					commits: 1,
					firstAt: null,
					lastAt: null,
					authors30d: 0,
					tags: { seen: 0, kept: 0 },
					branches: { seen: 0, kept: 0 },
					leftOut: 0,
					files: 0,
					entries: 0,
					biggest: { path: null, bytes: 0 },
					lfs: { pointers: 0 },
					submodules: 0,
					refused: { code: null, paths: [], more: 0 },
					secrets: { found: 0, shown, scan: { blobs: 0, bytes: 0, all: true } },
					fits: true,
					why: null,
				},
				8314,
			],
			[["\u00e6\u00f8\u00e5".repeat(50), '"'.repeat(300), "\\".repeat(300)], 920],
		] as [unknown, number][])
			expect(codeImportJsonbBound(value), JSON.stringify(value).slice(0, 40)).toBeGreaterThanOrEqual(measured);
		expect(() => codeImportJsonbBound({ f: () => 1 })).toThrow("INVALID_CODE_IMPORT");
	});

	it("reads a look back only as the kernel keeps it", () => {
		const look = codeImportLook(facts({ secrets: [{ kind: "aws", path: "a", inMain: true }] }));
		expect(codeImportLookOf(look)).toEqual(look);
		const broken = (change: (copy: Record<string, unknown>) => void) => {
			const copy = JSON.parse(JSON.stringify(look));
			change(copy);
			return copy;
		};
		for (const [what, change] of [
			[
				"a key more",
				(l) => {
					l.extra = 1;
				},
			],
			["a key less", (l) => delete l.why],
			[
				"schema",
				(l) => {
					l.schema = "qorpera.code-import-look/v2";
				},
			],
			[
				"no bytes",
				(l) => {
					l.bytes = 0;
				},
			],
			[
				"branch with a key",
				(l) => {
					l.defaultBranch = PLANTED.aws;
				},
			],
			[
				"main",
				(l) => {
					l.mainSha = "x";
				},
			],
			[
				"no commits",
				(l) => {
					l.commits = 0;
				},
			],
			[
				"time",
				(l) => {
					l.firstAt = "2026-11-12";
				},
			],
			[
				"kept over seen",
				(l) => {
					l.tags = { seen: 1, kept: 2 };
				},
			],
			[
				"over 500 tags",
				(l) => {
					l.tags = { seen: 600, kept: 501 };
				},
			],
			[
				"over 200 branches",
				(l) => {
					l.branches = { seen: 600, kept: 201 };
				},
			],
			[
				"files",
				(l) => {
					l.files = -1;
				},
			],
			[
				"long path",
				(l) => {
					(l.biggest as Record<string, unknown>).path = "x".repeat(201);
				},
			],
			[
				"key path",
				(l) => {
					(l.biggest as Record<string, unknown>).path = PLANTED.stripe;
				},
			],
			[
				"kind",
				(l) => {
					(l.secrets as { shown: Record<string, unknown>[] }).shown[0] = { kind: "x", path: "a", inMain: true };
				},
			],
			[
				"shown key path",
				(l) => {
					(l.secrets as { shown: Record<string, unknown>[] }).shown[0] = {
						kind: "aws",
						path: PLANTED.aws,
						inMain: true,
					};
				},
			],
			[
				"shown over found",
				(l) => {
					(l.secrets as Record<string, unknown>).found = 0;
				},
			],
			[
				"paths without a code",
				(l) => {
					l.refused = { code: null, paths: ["a"], more: 0 };
				},
			],
			[
				"refused but fits",
				(l) => {
					l.refused = { code: "IMPORT_USES_LFS", paths: [], more: 0 };
				},
			],
			[
				"fits and why",
				(l) => {
					l.why = "IMPORT_USES_LFS";
				},
			],
			[
				"why a failure",
				(l) => {
					l.why = "IMPORT_SCAN_FAILED:X";
					l.fits = false;
				},
			],
			[
				"all",
				(l) => {
					(l.secrets as { scan: Record<string, unknown> }).scan.all = "yes";
				},
			],
			[
				"too large",
				(l) => {
					l.secrets = {
						found: 30,
						shown: Array.from({ length: 30 }, () => ({ kind: "aws", path: "".padEnd(200, '"'), inMain: true })),
						scan: { blobs: 1, bytes: 1, all: true },
					};
					l.refused = {
						code: "IMPORT_USES_LFS",
						paths: Array.from({ length: 10 }, () => '"'.repeat(200)),
						more: 0,
					};
					l.why = "IMPORT_USES_LFS";
					l.fits = false;
				},
			],
		] as [string, (copy: Record<string, unknown>) => void][])
			expect(() => codeImportLookOf(broken(change)), what).toThrow("INVALID_CODE_IMPORT_LOOK");
	});
});

describe("the request's shapes", () => {
	const input = { from: { github: "Qorpera/saml-storefront" }, via: "connection", look: false, maximumBytes: GiB };
	const file = {
		from: { file: "code/_incoming/shop/shop.bundle", branch: "main" },
		via: "file",
		look: true,
		maximumBytes: GiB,
		fileSha256: "e".repeat(64),
	};
	const raw = {
		name: `import-20261112T140005Z-${A.slice(0, 12)}`,
		sha256: "f".repeat(64),
		bytes: 5000,
		defaultBranch: "master",
		mainSha: A,
		refs: 3,
		leftOut: 0,
	};
	const kept = {
		name: `20261112T141005Z-${A.slice(0, 12)}`,
		sha256: "9".repeat(64),
		bytes: 4000,
		refsSha256: "8".repeat(64),
		mainSha: A,
		refs: 4,
	};
	const progress = {
		step: "open",
		raw,
		kept,
		at: "20261112T141010Z",
		setAside: "code/_set-aside/acme/at-20261112T141010Z/shop",
		built: true,
		relayRefused: 0,
		recorded: { change: 1, bundle: kept.name, mainSha: A },
		waiting: "SESSIONS_OPEN",
	};

	it("reads an input of either source", () => {
		expect(codeImportInputOf(input)).toEqual({ ...input, fileSha256: null });
		expect(codeImportInputOf({ ...input, via: "public", from: { github: "a/b", branch: "dev" } })).toMatchObject({
			from: { github: "a/b", branch: "dev" },
		});
		expect(codeImportInputOf(file)).toEqual(file);
		// A branch that looks like a key is the fetch's to refuse, in words (IMPORT_BRANCH_NAME).
		expect(codeImportInputOf({ ...input, from: { github: "a/b", branch: PLANTED.aws } }).from).toEqual({
			github: "a/b",
			branch: PLANTED.aws,
		});
		expect(codeImportGitHubOf("Qorpera/saml-storefront")).toEqual({ owner: "Qorpera", name: "saml-storefront" });
		for (const bad of [
			{ ...input, extra: 1 },
			{ ...input, fileSha256: "e".repeat(64) },
			{ ...input, via: "file" },
			{ ...input, from: { github: "a/b/c" } },
			{ ...input, from: { github: "-a/b" } },
			{ ...input, from: { github: "a" } },
			{ ...input, from: { github: "a/b", file: file.from.file } },
			{ ...input, from: { github: "a/b", branch: "a b" } },
			{ ...input, from: { github: "a/b", branch: "x".repeat(201) } },
			{ ...input, from: {} },
			{ ...input, look: "no" },
			{ ...input, maximumBytes: 0 },
			{ ...input, maximumBytes: 2 * GiB + 1 },
			{ ...file, fileSha256: undefined },
			{ ...file, via: "public" },
			{ ...file, fileSha256: "E".repeat(64) },
			{ ...file, from: { file: "code/acme/shop/x.bundle" } },
			null,
		])
			expect(() => codeImportInputOf(bad), JSON.stringify(bad)).toThrow("INVALID_CODE_IMPORT_INPUT");
	});

	it("reads the progress with the kernel's words, and sends back only the executor's", () => {
		expect(codeImportProgressOf(null)).toEqual({});
		expect(codeImportProgressOf(progress)).toEqual(progress);
		expect(codeImportProgressOf({ step: "set-aside", setAside: null })).toEqual({
			step: "set-aside",
			setAside: null,
		});
		const sent = codeImportProgressValue(progress as never);
		expect(Object.keys(sent)).toEqual(["step", "raw", "kept", "at", "setAside", "built", "relayRefused"]);
		expect(
			Buffer.byteLength(
				JSON.stringify(
					codeImportProgressValue({ ...progress, raw: { ...raw, defaultBranch: "x".repeat(200) } } as never),
				),
			),
		).toBeLessThan(2560);
		for (const [what, bad] of [
			["step", { step: "fly" }],
			["key", { other: 1 }],
			["raw name", { raw: { ...raw, name: kept.name } }],
			["raw main", { raw: { ...raw, mainSha: B } }],
			["raw branch", { raw: { ...raw, defaultBranch: PLANTED.aws } }],
			["raw key", { raw: { ...raw, extra: 1 } }],
			["kept name", { kept: { ...kept, name: raw.name } }],
			["kept refs", { kept: { ...kept, refs: 1 } }],
			["at", { at: "2026-11-12" }],
			["set aside", { setAside: "code/acme/shop" }],
			["built", { built: false }],
			["relay", { relayRefused: 4 }],
			["recorded", { recorded: { change: 2, bundle: kept.name, mainSha: A } }],
			["waiting", { waiting: "busy" }],
			["array", []],
		] as [string, unknown][])
			expect(() => codeImportProgressOf(bad), what).toThrow("INVALID_CODE_IMPORT_PROGRESS");
		expect(() => codeImportProgressValue({ step: "fly" } as never)).toThrow("INVALID_CODE_IMPORT_PROGRESS");
	});

	it("reads a claimed import, and nothing else as one", () => {
		const look = codeImportLook(facts());
		const entry = {
			requestId: "11111111-1111-4111-8111-111111111111",
			token: "22222222-2222-4222-8222-222222222222",
			leaseUntil: "2026-11-12T15:00:00.123456+00:00",
			companyId: "33333333-3333-4333-8333-333333333333",
			environmentId: "44444444-4444-4444-8444-444444444444",
			owner: "acme",
			name: "shop",
			kind: "import",
			input,
			progress: null,
			looked: null,
		};
		expect(codeImportRequestOf(entry)).toEqual({ ...entry, input: { ...input, fileSha256: null }, progress: {} });
		expect(codeImportRequestOf({ ...entry, progress, looked: look }).looked).toEqual(look);
		for (const bad of [
			{ ...entry, kind: "restore" },
			{ ...entry, token: "x" },
			{ ...entry, leaseUntil: "soon" },
			{ ...entry, owner: "Acme" },
			{ ...entry, extra: 1 },
			(({ looked, ...rest }) => rest)(entry),
		])
			expect(() => codeImportRequestOf(bad)).toThrow("INVALID_CODE_IMPORT_REQUEST");
		expect(() => codeImportRequestOf({ ...entry, looked: { schema: "x" } })).toThrow("INVALID_CODE_IMPORT_LOOK");
		expect(() => codeImportRequestOf({ ...entry, input: {} })).toThrow("INVALID_CODE_IMPORT_INPUT");
	});

	it("checks an outcome as the kernel takes it", () => {
		const schema = "qorpera.code-request-outcome/v1";
		const imported = {
			schema,
			state: "done",
			result: "imported",
			change: 1,
			mainSha: A,
			bundle: kept.name,
			rawBundle: raw.name,
			setAside: null,
		};
		for (const outcome of [
			imported,
			{ ...imported, setAside: "code/_set-aside/acme/at-20261112T141010Z/shop" },
			{ schema, state: "done", result: "looked" },
			{ schema, state: "refused", code: "IMPORT_USES_LFS" },
			{ schema, state: "refused", code: "CODE_HOST_NAMES_NOT_NFC" },
			{ schema, state: "failed", code: "IMPORT_FETCH_TIMEOUT:PLACE_AS_BEFORE" },
			{ schema, state: "busy" },
		])
			expect(codeImportOutcomeOf(outcome)).toEqual(outcome);
		for (const bad of [
			{ ...imported, change: 2 },
			{ ...imported, bundle: raw.name },
			{ ...imported, rawBundle: kept.name },
			{ ...imported, setAside: "code/acme" },
			{ ...imported, extra: 1 },
			(({ setAside, ...rest }) => rest)(imported),
			{ schema, state: "done", result: "looked", change: 1 },
			{ schema, state: "done", result: "restored" },
			{ schema, state: "refused", code: "IMPORT_X:PLACE_AS_BEFORE" },
			{ schema, state: "refused", code: "NOT_IMPORT" },
			{ schema, state: "failed", code: "lower" },
			{ schema, state: "busy", code: "IMPORT_STOPPED" },
			{ schema: "other", state: "busy" },
			{ schema, state: "gone" },
		])
			expect(() => codeImportOutcomeOf(bad), JSON.stringify(bad)).toThrow("INVALID_CODE_IMPORT_OUTCOME");
	});

	it("makes the record's p_imported, and reads the two calls' answers", () => {
		expect(codeImportRecord({ bundle: kept.name, mainSha: A, files: 40 })).toEqual({
			schema: "qorpera.code-import-record/v1",
			bundle: kept.name,
			mainSha: A,
			files: 40,
		});
		for (const bad of [
			{ bundle: raw.name, mainSha: A, files: 1 },
			{ bundle: kept.name, mainSha: B, files: 1 },
			{ bundle: kept.name, mainSha: A, files: -1 },
			{ bundle: kept.name, mainSha: A, files: 1, more: 1 },
		])
			expect(() => codeImportRecord(bad as never)).toThrow("INVALID_CODE_IMPORT_RECORD");
		expect(codeImportLookedAnswer({ schema: "qorpera.code-import-looked/v1", state: "recorded" })).toBe("recorded");
		expect(codeImportLookedAnswer({ schema: "qorpera.code-import-looked/v1", state: "lost" })).toBe("lost");
		for (const bad of [
			null,
			{},
			{ schema: "qorpera.code-import-looked/v1", state: "done" },
			{ schema: "qorpera.code-import-looked/v1", state: "recorded", extra: 1 },
			{ schema: "x", state: "lost" },
		])
			expect(() => codeImportLookedAnswer(bad)).toThrow("CODE_IMPORT_LOOKED_UNCONFIRMED");
		const recorded = "qorpera.code-import-recorded/v1";
		expect(codeImportRecordedAnswer({ schema: recorded, state: "recorded", change: 1 })).toEqual({
			state: "recorded",
			change: 1,
		});
		expect(codeImportRecordedAnswer({ schema: recorded, state: "lost" })).toEqual({ state: "lost" });
		for (const bad of [
			null,
			{ schema: recorded, state: "recorded" },
			{ schema: recorded, state: "recorded", change: 2 },
			{ schema: recorded, state: "lost", change: 1 },
			{ schema: "x", state: "lost" },
		])
			expect(() => codeImportRecordedAnswer(bad)).toThrow("CODE_IMPORT_RECORD_UNCONFIRMED");
	});
});

describe("the scan's output, read", () => {
	it("takes digits and kind words only, and says nothing of any other line", () => {
		const status = "git 0\ngrep 0\nsed 0\n";
		expect(codeImportScanAnswer(Buffer.from("12 aws\n0 private-key\n9999999999999 slack\n"), status)).toEqual({
			hits: [
				{ offset: 12, kind: "aws" },
				{ offset: 0, kind: "private-key" },
				{ offset: 9_999_999_999_999, kind: "slack" },
			],
			all: true,
		});
		expect(codeImportScanAnswer(Buffer.alloc(0), "sed 0\ngit 0\ngrep 1\n")).toEqual({ hits: [], all: true });
		for (const bad of [
			`12:${PLANTED.aws}\n`,
			`12 ${PLANTED.aws}\n`,
			"12 aws",
			"012 aws\n",
			"12 env-file\n",
			"12  aws\n",
			"-1 aws\n",
			"12 AWS\n",
			"\n",
		]) {
			let error: unknown;
			try {
				codeImportScanAnswer(Buffer.from(bad), status);
			} catch (caught) {
				error = caught;
			}
			expect(error).toBeInstanceOf(CodeImportStop);
			expect((error as Error).message).toBe("IMPORT_SCAN_FAILED");
			expect(JSON.stringify(error)).not.toContain("AKIA");
			expect(String((error as Error).stack)).not.toContain("AKIA");
		}
		expect(() => codeImportScanAnswer(Buffer.alloc(65_537, 0x31), status)).toThrow("IMPORT_SCAN_FAILED");
	});

	it("is whole only when git, grep and sed each ended well, once, and the output stayed under its bound", () => {
		const out = Buffer.from("5 aws\n");
		for (const [status, all] of [
			["git 0\ngrep 0\nsed 0\n", true],
			["git 0\ngrep 1\nsed 0", true],
			["git 124\ngrep 0\nsed 0\n", false],
			["git 137\ngrep 0\nsed 0\n", false],
			["git 141\ngrep 0\nsed 0\n", false],
			["git 0\ngrep 2\nsed 0\n", false],
			["git 0\ngrep 0\nsed 4\n", false],
			["git 0\ngrep 0\n", false],
			["git 0\ngit 0\ngrep 0\nsed 0\n", false],
			["git 0\ngrep 0\nsed 0\nhead 0\n", false],
			["", false],
			[null, false],
		] as [string | null, boolean][])
			expect(codeImportScanAnswer(out, status).all, String(status)).toBe(all);
		// At the bound, the line it cut is passed over, and it is not whole.
		const line = "1234567 aws\n";
		const full = Buffer.from(line.repeat(Math.ceil(65_536 / line.length))).subarray(0, 65_536);
		const read = codeImportScanAnswer(full, "git 0\ngrep 0\nsed 0\n");
		expect(read.all).toBe(false);
		expect(read.hits).toHaveLength(Math.floor(65_536 / line.length));
	});
});

describe("the scan's offsets, mapped to blobs", () => {
	const header = (size: number) => 47 + String(size).length;
	it("maps each offset to the blob whose content holds it, at the edges too", () => {
		const sizes = [10, 0, 1_048_576, 7, 123_456_789];
		const starts: number[] = [];
		let at = 0;
		for (const size of sizes) {
			starts.push(at);
			at += header(size) + size + 1;
		}
		const content = (i: number) => (starts[i] as number) + header(sizes[i] as number);
		const hits = [
			{ offset: content(0), kind: "aws" as const },
			{ offset: content(0) + 9, kind: "github" as const },
			{ offset: content(0) + 10, kind: "aws" as const },
			{ offset: starts[1] as number, kind: "aws" as const },
			{ offset: content(2), kind: "google" as const },
			{ offset: content(2) + 1_048_575, kind: "openai" as const },
			{ offset: content(2), kind: "google" as const },
			{ offset: content(3) - 1, kind: "aws" as const },
			{ offset: content(3) + 6, kind: "slack" as const },
			{ offset: content(4) + 123_456_788, kind: "stripe" as const },
			{ offset: at, kind: "aws" as const },
			{ offset: at + 1000, kind: "aws" as const },
		];
		expect(codeImportScanBlobs(sizes, [...hits].reverse())).toEqual({
			blobs: [
				{ index: 0, kind: "aws" },
				{ index: 0, kind: "github" },
				{ index: 2, kind: "google" },
				{ index: 2, kind: "openai" },
				{ index: 3, kind: "slack" },
				{ index: 4, kind: "stripe" },
			],
			outside: 5,
		});
		expect(codeImportScanBlobs([], [{ offset: 0, kind: "aws" }])).toEqual({ blobs: [], outside: 1 });
		expect(() => codeImportScanBlobs([1, -1], [{ offset: 100, kind: "aws" }])).toThrow("INVALID_CODE_IMPORT");
	});
});

// The pieces with real git, and the scan with the real shell tools: as on node02's test machine (Ubuntu 26.04, git
// 2.53, dash, GNU grep 3.12 and sed 4.9, uutils coreutils), the code host image's own. -------------------------------

const GIT = "/usr/bin/git";
const PATH = "/usr/local/bin:/usr/bin:/bin";
const roots: string[] = [];
afterAll(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function scratch() {
	const top = await realpath(await mkdtemp(join(tmpdir(), "code-import-")));
	roots.push(top);
	return top;
}
const gitEnv = (home: string): Record<string, string> => ({
	PATH,
	HOME: home,
	LC_ALL: "C",
	GIT_CONFIG_NOSYSTEM: "1",
	GIT_CONFIG_GLOBAL: "/dev/null",
	GIT_AUTHOR_NAME: "Test",
	GIT_AUTHOR_EMAIL: "test@example.invalid",
	GIT_COMMITTER_NAME: "Test",
	GIT_COMMITTER_EMAIL: "test@example.invalid",
});
/** One command: its exit code, its stdout as bytes and its stderr as text. */
async function run(argv: string[], options: { env: Record<string, string>; input?: Uint8Array; cwd?: string }) {
	const child = spawn(argv[0] as string, argv.slice(1), {
		env: options.env,
		cwd: options.cwd,
		stdio: ["pipe", "pipe", "pipe"],
	});
	const out: Buffer[] = [],
		err: Buffer[] = [];
	child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
	child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
	child.stdin.on("error", () => {});
	child.stdin.end(options.input ?? Buffer.alloc(0));
	const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
	return { code, stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString() };
}
/** git in a repository of the test's, its output as text; it must end 0. */
async function gitIn(home: string, dir: string, args: string[], input?: Uint8Array, env: Record<string, string> = {}) {
	const result = await run([GIT, ...args], { env: { ...gitEnv(home), ...env }, cwd: dir, input });
	if (result.code !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
	return result.stdout.toString().trim();
}

describe("with real git", { timeout: 120_000 }, () => {
	it("gets a repository's refs and pack through protocol v2, and its bundle passes git's verify and a strict fetch", async () => {
		const top = await scratch();
		const work = join(top, "work");
		await mkdir(work);
		const g = (args: string[], input?: Uint8Array, env?: Record<string, string>) =>
			gitIn(top, work, args, input, env);
		await g(["init", "--quiet", "--initial-branch=master"]);
		await writeFile(join(work, "a.txt"), "one\n");
		await g(["add", "."]);
		await g(["commit", "--quiet", "-m", "one"]);
		await g(["tag", "v0"]);
		await writeFile(join(work, "b.txt"), "two\n");
		await g(["add", "."]);
		await g(["commit", "--quiet", "-m", "two"]);
		await g(["tag", "-a", "v1", "-m", "release one"]);
		await g(["branch", "feature", "HEAD~1"]);
		await gitIn(top, top, ["clone", "--quiet", "--bare", work, "source.git"]);
		const source = join(top, "source.git");
		const v2 = { GIT_PROTOCOL: "version=2" };
		// The advertisement as git http-backend serves it, and as GitHub does, with its service line first.
		const advertised = await run([GIT, "upload-pack", "--http-backend-info-refs", source], {
			env: { ...gitEnv(top), ...v2 },
		});
		expect(advertised.code).toBe(0);
		expect(advertised.stdout.toString("latin1", 0, 14)).toBe("000eversion 2\n");
		for (const form of [
			advertised.stdout,
			Buffer.concat([Buffer.from("001e# service=git-upload-pack\n0000"), advertised.stdout]),
		]) {
			const server = await codeImportAdvertisement(pieces(form, 5));
			expect(server.capabilities.has("ls-refs")).toBe(true);
			expect(server.capabilities.has("fetch")).toBe(true);
		}
		const uploadPack = (request: Buffer) =>
			run([GIT, "upload-pack", "--stateless-rpc", source], { env: { ...gitEnv(top), ...v2 }, input: request });
		const listed = await uploadPack(codeImportLsRefsRequest());
		expect(listed.code).toBe(0);
		const list = await codeImportRefList(pieces(listed.stdout, 7));
		const master = await g(["rev-parse", "master"]),
			feature = await g(["rev-parse", "feature"]),
			v1 = await g(["rev-parse", "v1"]);
		expect(list).toEqual({
			head: { oid: master, target: "refs/heads/master" },
			refs: [
				{ name: "refs/heads/feature", oid: feature, peeled: null },
				{ name: "refs/heads/master", oid: master, peeled: null },
				{ name: "refs/tags/v0", oid: feature, peeled: null },
				{ name: "refs/tags/v1", oid: v1, peeled: master },
			],
			unreadable: 0,
		});
		const wanted = codeImportWants(list);
		expect(wanted.wants).toEqual([master, feature, v1]);
		const answered = await uploadPack(codeImportFetchRequest(wanted.wants));
		expect(answered.code).toBe(0);
		const stats = codeImportPackStats();
		const header = codeImportBundleHeader(wanted.refs);
		const bundle = Buffer.concat(
			await all(codeImportBundlePieces(header, codeImportPack(pieces(answered.stdout, 1000), stats), GiB, 4096)),
		);
		expect(stats.bytes).toBeGreaterThan(32);
		const file = join(top, "first.bundle");
		await writeFile(file, bundle);
		const proof = join(top, "proof.git");
		await gitIn(top, top, ["init", "--quiet", "--bare", proof]);
		const verified = await run([GIT, `--git-dir=${proof}`, "bundle", "verify", file], { env: gitEnv(top) });
		expect(verified.code).toBe(0);
		expect(verified.stderr + verified.stdout.toString()).toContain("records a complete history");
		expect(codeImportBundleHeaderOf(bundle).refs).toEqual(wanted.refs);
		await gitIn(top, top, [
			`--git-dir=${proof}`,
			"-c",
			"transfer.fsckObjects=true",
			"fetch",
			"--quiet",
			"--no-tags",
			"--no-write-fetch-head",
			file,
			"+refs/*:refs/*",
		]);
		expect(
			(
				await gitIn(top, top, [
					`--git-dir=${proof}`,
					"for-each-ref",
					"--format=%(objectname) %(objecttype) %(refname)",
				])
			).split("\n"),
		).toEqual([
			`${feature} commit refs/heads/feature`,
			`${master} commit refs/heads/master`,
			`${feature} commit refs/tags/v0`,
			`${v1} tag refs/tags/v1`,
		]);
		await gitIn(top, top, [`--git-dir=${proof}`, "fsck", "--full", "--strict", "--no-progress"]);
		// A want the source does not have: its own words, an ERR line.
		const missing = await uploadPack(codeImportFetchRequest(["0123456789abcdef0123456789abcdef01234567"]));
		expect(await stopped(all(codeImportPack(body(missing.stdout))))).toEqual(
			stop("failed", "IMPORT_SOURCE_ERROR", true),
		);
	});

	it("names a zero-padded file mode by git's own message id: refused by the strict fetch, a warning to fsck", async () => {
		const top = await scratch();
		const repo = join(top, "old.git");
		await gitIn(top, top, ["init", "--quiet", "--bare", repo]);
		const g = (args: string[], input?: Uint8Array) => gitIn(top, repo, [`--git-dir=${repo}`, ...args], input);
		const blob = await g(["hash-object", "-w", "--stdin"], Buffer.from("x\n"));
		const sub = await g(["mktree"], Buffer.from(`100644 blob ${blob}\tf\n`));
		const tree = await g(
			["hash-object", "-t", "tree", "--literally", "-w", "--stdin"],
			Buffer.concat([Buffer.from("040000 d\0"), Buffer.from(sub, "hex")]),
		);
		const commit = await g(["commit-tree", tree, "-m", "old"]);
		await g(["update-ref", "refs/heads/main", commit]);
		await g(["bundle", "create", "--quiet", join(top, "old.bundle"), "--all"]);
		const proof = join(top, "proof.git");
		await gitIn(top, top, ["init", "--quiet", "--bare", proof]);
		const fetched = await run(
			[
				GIT,
				`--git-dir=${proof}`,
				"-c",
				"transfer.fsckObjects=true",
				"fetch",
				"--quiet",
				join(top, "old.bundle"),
				"+refs/*:refs/*",
			],
			{ env: gitEnv(top) },
		);
		expect(fetched.code).not.toBe(0);
		const fsck = await run([GIT, `--git-dir=${repo}`, "fsck", "--full", "--no-progress"], { env: gitEnv(top) });
		expect(fsck.code).toBe(0);
		expect(codeImportHistoryCode(fetched.stderr, fsck.code === 0)).toBe("IMPORT_HISTORY_ZERO_PADDED_FILEMODE");
	});

	it("holds a ref exactly where codeImportRefPartsFit says the disk does: a folder part of 255 bytes, a last part of 250", async () => {
		const top = await scratch();
		const repo = join(top, "parts.git");
		await gitIn(top, top, ["init", "--quiet", "--bare", repo]);
		const tree = await gitIn(top, repo, [`--git-dir=${repo}`, "mktree"], Buffer.alloc(0));
		const commit = await gitIn(top, repo, [`--git-dir=${repo}`, "commit-tree", tree, "-m", "one"]);
		for (const bytes of [250, 251, 255, 256])
			for (const name of [`refs/tags/${"t".repeat(bytes)}`, `refs/heads/${"d".repeat(bytes)}/x`]) {
				const made = await run([GIT, `--git-dir=${repo}`, "update-ref", name, commit], { env: gitEnv(top) });
				expect(made.code === 0, `${name.slice(0, 16)} ${bytes}`).toBe(codeImportRefPartsFit(name));
			}
	});

	it("applies the refs plan in one update-ref session, a ref that is another's folder and a mark already there among them", async () => {
		const top = await scratch();
		const repo = join(top, "proof.git");
		await gitIn(top, top, ["init", "--quiet", "--bare", repo]);
		const g = (args: string[], input?: Uint8Array, env?: Record<string, string>) =>
			gitIn(top, repo, [`--git-dir=${repo}`, ...args], input, env);
		const tree = await g(["mktree"], Buffer.alloc(0));
		const at = (seconds: number) => ({
			GIT_COMMITTER_DATE: `@${seconds} +0000`,
			GIT_AUTHOR_DATE: `@${seconds} +0000`,
		});
		const commit = (message: string, seconds: number) =>
			g(["commit-tree", tree, "-m", message], undefined, at(seconds));
		const master = await commit("master", nowSeconds - 60),
			recent = await commit("recent", nowSeconds - 3_600),
			old = await commit("old", nowSeconds - 200 * DAY);
		const refs: [string, string][] = [
			["refs/heads/master", master],
			["refs/heads/main/x", recent],
			["refs/heads/feature", recent],
			["refs/heads/old", old],
			["refs/heads/Fix", recent],
			["refs/heads/fix", recent],
			["refs/heads/e\u0301", recent],
			["refs/heads/a./b", recent],
			["refs/heads/sp\u00a0ace", recent],
			["refs/remotes/origin/x", recent],
			["refs/qorpera/imported/heads/feature", old],
			["refs/qorpera/kept-here", old],
			["refs/tags/v0", recent],
			["refs/tags/tree", tree],
		];
		await g(
			["update-ref", "--stdin", "-z"],
			Buffer.from(refs.map(([name, sha]) => `create ${name}\0${sha}\0`).join("")),
		);
		await g(["tag", "-a", "v1", "-m", "one", master], undefined, at(nowSeconds - 10));
		const seen = (
			await g([
				"for-each-ref",
				"--format=%(refname)%00%(objectname)%00%(objecttype)%00%(*objecttype)%00%(creatordate:unix)",
			])
		)
			.split("\n")
			.map((line) => {
				const [name, sha, type, peeledType, time] = line.split("\0") as [string, string, string, string, string];
				return { name, sha, type, peeledType, time: Number(time) };
			});
		expect(seen.find((r) => r.name === "refs/tags/v1")).toMatchObject({
			type: "tag",
			peeledType: "commit",
			time: nowSeconds - 10,
		});
		const made = codeImportRefsPlan({ repository: place, defaultBranch: "master", refs: seen, now: NOW });
		expect(made.leftOutBy).toEqual({ name: 3, clash: 1, notCommit: 1, older: 1, over: 0, other: 3 });
		const applied = await run([GIT, `--git-dir=${repo}`, "update-ref", "--no-deref", "-z", "--stdin"], {
			env: gitEnv(top),
			input: made.stdin,
		});
		expect(applied.stderr).toBe("");
		expect(applied.code).toBe(0);
		const after = (await g(["for-each-ref", "--format=%(refname) %(objectname)"])).split("\n").map((line) => {
			const [name, sha] = line.split(" ") as [string, string];
			return { name, sha };
		});
		expect(after).toEqual(made.refs);
		expect(after.map((r) => r.name)).toEqual([
			"refs/heads/main",
			"refs/qorpera/imported/heads/Fix",
			"refs/qorpera/imported/heads/feature",
			"refs/qorpera/imported/heads/main/x",
			"refs/qorpera/kept-here",
			"refs/tags/v0",
			"refs/tags/v1",
		]);
		expect(after.find((r) => r.name === "refs/qorpera/kept-here")?.sha).toBe(master);
		expect(codeRefsSha256(after)).toBe(made.refsSha256);
		// What the folder and restore's proof would do with each kept name: none refused, none one name with another.
		for (const { name } of after) expect(codeImportFolderPathValid(`code/acme/shop/repo.git/${name}`)).toBe(true);
	});

	it("scans a real batch stream: no planted value reaches stdout, and each hit maps to its blob, path and main", async () => {
		const top = await scratch();
		const work = join(top, "work");
		await mkdir(join(work, "old"), { recursive: true });
		const g = (args: string[], input?: Uint8Array) => gitIn(top, work, args, input);
		await g(["init", "--quiet", "--initial-branch=main"]);
		await writeFile(join(work, "old/secret.txt"), `aws_access_key_id = ${PLANTED.aws}\n`);
		await g(["add", "."]);
		await g(["commit", "--quiet", "-m", "old"]);
		await rm(join(work, "old"), { recursive: true });
		const big = Buffer.alloc(MiB, 0x78);
		for (let i = 1023; i < MiB; i += 1024) big[i] = 0x0a;
		big.write(` ${PLANTED.google} `, 500_000, "latin1");
		big.write(` ${PLANTED.openai}`, MiB - PLANTED.openai.length - 1, "latin1");
		const files: Record<string, string | Buffer> = {
			"aws.txt": `first line\nkey=${PLANTED.aws};\nlast\n`,
			// A letter that is a word's in a UTF-8 locale and none in C, right before the key.
			"accent.txt": `caf\u00e9${PLANTED.aws}\n`,
			"github.js": `const token = "${PLANTED.github}";\n`,
			"nofinal.txt": `token=${PLANTED.stripe}`,
			"big.bin": big,
			"binary.dat": Buffer.concat([
				Buffer.from([0, 1, 2, 0]),
				Buffer.from(PLANTED.anthropic),
				Buffer.from([0, 255, 0]),
			]),
			"two.txt": `${PLANTED.slack} ${PLANTED.resend}\n`,
			"legacy.txt": `OPENAI_API_KEY=${(PLANTED_ALL.at(-1) as [string, string])[1]}\n`,
			id_rsa: `${PLANTED["private-key"]}\nMIIEow...\n-----END RSA PRIVATE KEY-----\n`,
			".env": "PLAIN=1\n",
			[`keys/${PLANTED.aws.replace("01", "02")}/conf.txt`]: `google ${PLANTED.google}\n`,
			"clean.txt": "nothing here\n",
		};
		for (const [path, content] of Object.entries(files)) {
			await mkdir(join(work, path, ".."), { recursive: true });
			await writeFile(join(work, path), content);
		}
		await g(["add", "--all"]);
		await g(["commit", "--quiet", "-m", "now"]);
		const repo = join(work, ".git");
		// The look's lists, as files: every blob once with its first path, in rev-list's order, and their sizes.
		const objects = (await g(["rev-list", "--objects", "--all"])).split("\n").map((line) => {
			const space = line.indexOf(" ");
			return space < 0 ? { oid: line, path: "" } : { oid: line.slice(0, space), path: line.slice(space + 1) };
		});
		const types = (
			await g(["cat-file", "--batch-check"], Buffer.from(objects.map((o) => `${o.oid}\n`).join("")))
		).split("\n");
		const blobs = objects
			.map((object, i) => ({
				...object,
				size: Number((types[i] as string).split(" ")[2]),
				type: (types[i] as string).split(" ")[1],
			}))
			.filter((object) => object.type === "blob");
		const list = join(top, "scan.list"),
			status = join(top, "scan.status");
		await writeFile(list, blobs.map((b) => `${b.oid}\n`).join(""));
		const scan = (env: Record<string, string>, seconds = "600", git = GIT) =>
			run(
				[
					"/bin/sh",
					"-c",
					CODE_IMPORT_SCAN,
					"sh",
					status,
					list,
					seconds,
					git,
					"--no-replace-objects",
					`--git-dir=${repo}`,
					"cat-file",
					"--batch",
				],
				{
					env,
				},
			);
		// Whatever locale the command is given, it scans in C's.
		const scanned = await scan({ PATH, HOME: top, LC_ALL: "C.UTF-8", LANG: "C.UTF-8" });
		expect(scanned.code).toBe(0);
		expect(scanned.stderr).toBe("");
		const stdout = scanned.stdout.toString("latin1");
		expect(stdout).toMatch(/^(?:[0-9]+ [a-z-]+\n)+$/);
		for (const [, value] of PLANTED_ALL) {
			expect(stdout).not.toContain(value);
			for (let at = 0; at + 8 <= value.length; at++) expect(stdout).not.toContain(value.slice(at, at + 8));
		}
		const statusText = await readFile(status, "utf8");
		const answer = codeImportScanAnswer(scanned.stdout, statusText);
		expect(answer.all).toBe(true);
		// Each offset is where the value stands in git's own batch output.
		const batch = (
			await run([GIT, `--git-dir=${repo}`, "cat-file", "--batch"], { env: gitEnv(top), input: await readFile(list) })
		).stdout;
		const expected: { offset: number; kind: string }[] = [];
		for (const [kind, value] of PLANTED_ALL)
			for (let at = batch.indexOf(value); at >= 0; at = batch.indexOf(value, at + 1))
				expected.push({ offset: at, kind });
		const order = (a: { offset: number }, b: { offset: number }) => a.offset - b.offset;
		expect([...answer.hits].sort(order)).toEqual(expected.sort(order));
		const mapped = codeImportScanBlobs(
			blobs.map((b) => b.size),
			answer.hits,
		);
		expect(mapped.outside).toBe(0);
		const main = new Set((await g(["ls-tree", "-r", "--format=%(objectname)", "main"])).split("\n"));
		const found = mapped.blobs.map(({ index, kind }) => ({
			kind,
			path: (blobs[index] as { path: string }).path,
			inMain: main.has((blobs[index] as { oid: string }).oid),
		}));
		expect(found.sort((a, b) => `${a.path}${a.kind}`.localeCompare(`${b.path}${b.kind}`))).toEqual(
			[
				{ kind: "aws", path: "accent.txt", inMain: true },
				{ kind: "aws", path: "aws.txt", inMain: true },
				{ kind: "openai", path: "big.bin", inMain: true },
				{ kind: "google", path: "big.bin", inMain: true },
				{ kind: "anthropic", path: "binary.dat", inMain: true },
				{ kind: "github", path: "github.js", inMain: true },
				{ kind: "private-key", path: "id_rsa", inMain: true },
				{ kind: "google", path: `keys/${PLANTED.aws.replace("01", "02")}/conf.txt`, inMain: true },
				{ kind: "openai", path: "legacy.txt", inMain: true },
				{ kind: "stripe", path: "nofinal.txt", inMain: true },
				{ kind: "aws", path: "old/secret.txt", inMain: false },
				{ kind: "resend", path: "two.txt", inMain: true },
				{ kind: "slack", path: "two.txt", inMain: true },
			].sort((a, b) => `${a.path}${a.kind}`.localeCompare(`${b.path}${b.kind}`)),
		);
		// The look shows them, the key-like path as null, the tracked .env by its path rule.
		const paths = (await g(["ls-tree", "-r", "--name-only", "main"])).split("\n");
		const look = codeImportLook(
			facts({
				secrets: [
					...found,
					...paths.filter(codeImportEnvFile).map((path) => ({ kind: "env-file" as const, path, inMain: true })),
				],
				scan: { blobs: blobs.length, bytes: blobs.reduce((sum, b) => sum + b.size, 0), all: answer.all },
			}),
		);
		expect(look.secrets.found).toBe(14);
		expect(look.secrets.shown.filter((hit) => hit.path === null)).toEqual([
			{ kind: "google", path: null, inMain: true },
		]);
		expect(look.secrets.shown.at(-1)).toEqual({ kind: "aws", path: "old/secret.txt", inMain: false });
		expect(look.secrets.shown).toContainEqual({ kind: "env-file", path: ".env", inMain: true });
		expect(JSON.stringify(look)).not.toContain(PLANTED.aws);

		// The bound: more hits than 64 KiB of lines; stdout stops at it, and the scan is not whole.
		await writeFile(join(work, "many.txt"), `${PLANTED.aws}\n`.repeat(7_000));
		await g(["add", "many.txt"]);
		await g(["commit", "--quiet", "-m", "many"]);
		const manyBlob = await g(["rev-parse", "HEAD:many.txt"]);
		await writeFile(list, `${manyBlob}\n`);
		await rm(status);
		const bounded = await scan({ PATH, HOME: top });
		expect(bounded.stdout.length).toBe(CODE_IMPORT_SCAN_OUTPUT_BYTES);
		const read = codeImportScanAnswer(bounded.stdout, await readFile(status, "utf8"));
		expect(read.all).toBe(false);
		expect(read.hits.length).toBeGreaterThan(5_000);
		expect(read.hits.length).toBeLessThan(7_000);

		// A grep that cannot run: the status says so, and the scan is not whole.
		const stub = join(top, "stub");
		await mkdir(stub);
		await writeFile(join(stub, "grep"), "#!/bin/sh\nexit 2\n");
		await chmod(join(stub, "grep"), 0o755);
		await rm(status);
		const broken = await scan({ PATH: `${stub}:${PATH}`, HOME: top });
		expect(broken.stdout.length).toBe(0);
		expect(await readFile(status, "utf8")).toContain("grep 2\n");
		expect(codeImportScanAnswer(broken.stdout, await readFile(status, "utf8")).all).toBe(false);

		// A git that does not end in time: stopped, and the status file says so.
		const slow = join(top, "slow-git");
		await writeFile(slow, "#!/bin/sh\nexec sleep 30\n");
		await chmod(slow, 0o755);
		await rm(status);
		const started = Date.now();
		const late = await scan({ PATH, HOME: top }, "1", slow);
		expect(Date.now() - started).toBeLessThan(15_000);
		const lateStatus = await readFile(status, "utf8");
		expect(lateStatus).toMatch(/^git (124|137)$/m);
		expect(codeImportScanAnswer(late.stdout, lateStatus)).toEqual({ hits: [], all: false });
	});

	it("scans 64 MiB of key-like noise in seconds", async () => {
		const top = await scratch();
		const noise = Buffer.alloc(64 * MiB);
		const alphabet = Buffer.from("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-");
		for (let i = 0, seed = 7; i < noise.length; i++) {
			seed = (seed * 1_103_515_245 + 12_345) >>> 0;
			noise[i] = i % 4096 === 4095 ? 0x0a : (alphabet[seed % alphabet.length] as number);
		}
		const file = join(top, "noise");
		await writeFile(file, noise);
		const fake = join(top, "cat-noise");
		await writeFile(fake, `#!/bin/sh\nexec cat -- ${file}\n`);
		await chmod(fake, 0o755);
		const list = join(top, "list");
		await writeFile(list, "");
		const started = Date.now();
		const scanned = await run(["/bin/sh", "-c", CODE_IMPORT_SCAN, "sh", join(top, "status"), list, "600", fake], {
			env: { PATH, HOME: top },
		});
		expect(Date.now() - started).toBeLessThan(30_000);
		expect(scanned.code).toBe(0);
		expect(scanned.stdout.toString("latin1")).toMatch(/^(?:[0-9]+ [a-z-]+\n)*$/);
	});
});
