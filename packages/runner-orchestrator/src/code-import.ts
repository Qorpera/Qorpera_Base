import {
	type CloudCodingRepository,
	folderKey,
	isUuid,
	parseClosedRecord,
	parseCloudCodingRepository,
	SHA256_HEX_PATTERN,
} from "@qorpera/contracts";
import { CODE_BUNDLE_NAME, type CodeBundleRef, type CodeBundleTarget, codeBundleName } from "./code-bundle-store.ts";
import {
	CODE_AREA_IN_QORPERA_REF,
	type CodeAreaRef,
	type CodeBundleSink,
	type CodeHostJob,
	CodeHostJobFailure,
	CodeHostRefusal,
	codeRefsSha256,
} from "./code-host-jobs.ts";

/** Existing code brought into Qorpera (own code storage, step 6; STEP6-IMPORT-BUILD.md, as the last section of
 * STEP6-BUILD.md corrected it): what is pure of it (part C1). An import is a code request of kind `import`, run by the
 * coding executor like a restore, with no machine and no model:
 *
 *   fetch / read  the first bundle: from GitHub through git's protocol v2 as bytes only (part C2: one GET and two POSTs,
 *                 the pack of side band 1 written behind a bundle header as it comes), or from a git bundle an agent put
 *                 under `code/_incoming/` (part B's read job). Stored as `import-<UTC>-<12 hex>`, and kept.
 *   look          part B's code host job: the one fsck, the facts and the key scan (the look), then the refs plan and a
 *                 second, restore-shaped bundle (an ordinary stored bundle).
 *   close …       part C3's run hands that bundle to restore's own jobs; the job that opens the place makes the
 *                 import's record (registry row and change 1, `qorpera_code_import_record`).
 *
 * This file holds what those parts share and must not differ on: the limits, the codes, the shapes the kernel keeps
 * (input, progress, look, outcome, record), the pkt-line codec with the protocol's requests and streaming answer
 * parsers, the bundle header, the refs plan, the key scan (its patterns, its script, how its output reads and how an
 * offset maps to a blob) and the interfaces between the parts. Nothing here reaches the network, a file or a process.
 * No value the key scan matches ever reaches a value this file returns, an error it throws or anything it logs. */

const KiB = 1024;
const MiB = 1024 ** 2;
const GiB = 1024 ** 3;

// Limits (the design's section 7, and the bounds of 5.2 to 5.4) ---------------------------------------------------------

/** The largest first bundle, by default (`qorpera_code_import_maximum_bytes()`, the input's `maximumBytes`), and the
 * most an operator may raise it to: the store's own cap. */
export const CODE_IMPORT_MAXIMUM_BYTES = 1 * GiB;
export const CODE_IMPORT_MAXIMUM_BYTES_LIMIT = 2 * GiB;
/** A file source: one company folder file. */
export const CODE_IMPORT_FILE_MAXIMUM_BYTES = 256 * MiB;
/** The ref list: lines (HEAD's among them) and bytes (its pkt-lines whole), bounded before any pack. */
export const CODE_IMPORT_REF_LINES = 20_000;
export const CODE_IMPORT_REF_LIST_BYTES = 4 * MiB;
/** The capability advertisement, whole. */
export const CODE_IMPORT_ADVERTISEMENT_BYTES = 64 * KiB;
/** Objects one fetch wants, each once. */
export const CODE_IMPORT_WANTS = 5_000;
/** One pkt-line, its four length digits included (git's LARGE_PACKET_MAX). */
export const CODE_IMPORT_PKT_LINE_BYTES = 65_520;
/** A ref name in the first bundle's header. */
export const CODE_IMPORT_REF_NAME_BYTES = 1_000;
/** The default branch's name (`qorpera_coding_repository_valid`'s bound): it goes into the look, the registry row's
 * `imported_from` and `changes/1.md`. */
export const CODE_IMPORT_BRANCH_BYTES = 200;
/** The fetch: in all, idle (no byte read), to connect, to the answer's headers. */
export const CODE_IMPORT_FETCH_MS = 60 * 60_000;
export const CODE_IMPORT_IDLE_MS = 2 * 60_000;
export const CODE_IMPORT_CONNECT_MS = 10_000;
export const CODE_IMPORT_HEADERS_MS = 30_000;
/** The pieces the fetch writes into the store, each awaited; and the pieces a code host job reads a file out in. */
export const CODE_IMPORT_PIECE_BYTES = 1 * MiB;
export const CODE_IMPORT_READ_PIECE_BYTES = 16 * MiB;
/** The look's scratch must have this many times the first bundle free. */
export const CODE_IMPORT_SCRATCH_FACTOR = 5;
/** The one `fsck --full`. */
export const CODE_IMPORT_FSCK_MS = 30 * 60_000;
/** Entries (files and folders) of main's tree: a new `main/` is one save unit of at most 10,000. */
export const CODE_IMPORT_MAIN_ENTRIES = 9_000;
/** Refs kept beside main and the kept-here mark: tags, and other branches changed in the last days. */
export const CODE_IMPORT_TAGS = 500;
export const CODE_IMPORT_BRANCHES = 200;
export const CODE_IMPORT_BRANCH_DAYS = 90;
/** Who changed main lately (`authors30d`). */
export const CODE_IMPORT_AUTHOR_DAYS = 30;
/** The key scan: blobs under this size, this many bytes of them in all, this long, this much output. */
export const CODE_IMPORT_SCAN_BLOB_BYTES = 1 * MiB;
export const CODE_IMPORT_SCAN_BYTES = 2 * GiB;
export const CODE_IMPORT_SCAN_SECONDS = 600;
export const CODE_IMPORT_SCAN_OUTPUT_BYTES = 65_536;
/** The look: its JSON text, and a bound of its jsonb size, each at most this (the column holds 16 KiB by
 * `pg_column_size`: a margin of 1 KiB stays). */
export const CODE_IMPORT_LOOK_BYTES = 15 * KiB;
export const CODE_IMPORT_LOOK_COLUMN_BYTES = 16 * KiB;
/** A path in the look: at most this many bytes, or null. At most this many refused paths and found keys shown. */
export const CODE_IMPORT_LOOK_PATH_BYTES = 200;
export const CODE_IMPORT_LOOK_PATHS = 10;
export const CODE_IMPORT_LOOK_SHOWN = 30;
/** A request's progress (the step call's own bound), and what of it the executor sends (the kernel adds its words). */
export const CODE_IMPORT_PROGRESS_BYTES = 3 * KiB;
export const CODE_IMPORT_PROGRESS_SENT_BYTES = 2_560;
/** The lease, its renewal, and the claims an import gets before it ends `DID_NOT_FINISH`. */
export const CODE_IMPORT_LEASE_MS = 15 * 60_000;
export const CODE_IMPORT_RENEW_MS = 5 * 60_000;
export const CODE_IMPORT_CLAIMS = 5;
/** The relay's own 403s in a row that end an import refused (each before it is `busy`). */
export const CODE_IMPORT_RELAY_REFUSALS = 3;

// Codes ------------------------------------------------------------------------------------------------------------------

/** The refusals an import ends with (`refused {code}`): the code's own, or a rule it does not meet. Members and agents
 * get words for each (parts D and E). Beside these: the code host's own refusals of main's names (`CODE_HOST_NAMES_*`
 * and `CODE_HOST_FILE_TOO_LARGE`, from `Run.checkNames`), and the two families `codeImportHistoryCode` makes. */
export const CODE_IMPORT_REFUSALS = [
	/** The first bundle is over the input's `maximumBytes`. */
	"IMPORT_TOO_LARGE",
	/** GitHub's own 401, 403 or 404; the relay's own 403 the third time in a row. */
	"IMPORT_SOURCE_REFUSED",
	/** A public project answered a redirect: it was renamed or moved. */
	"IMPORT_SOURCE_MOVED",
	/** HEAD names no commit: the project is empty. */
	"IMPORT_SOURCE_EMPTY",
	/** `object-format=sha256`. */
	"IMPORT_SHA256_REPOSITORY",
	/** The ref list is over 20,000 lines or 4 MiB. */
	"IMPORT_TOO_MANY_REFS",
	/** The default branch is over 200 bytes, holds what looks like a key, or is no name git and the folder keep. */
	"IMPORT_BRANCH_NAME",
	/** The branch asked for is not there, or a file's default branch cannot be told. */
	"IMPORT_BRANCH_UNKNOWN",
	/** The file is no git bundle, or one that needs commits it does not hold. */
	"IMPORT_FILE_NOT_WHOLE",
	/** The file is not the one asked for (another SHA-256, another size, or gone). */
	"IMPORT_FILE_CHANGED",
	/** git's check found an error in the history (also `IMPORT_HISTORY_DAMAGED_<ID>`). */
	"IMPORT_HISTORY_DAMAGED",
	/** Main holds Git LFS pointers. */
	"IMPORT_USES_LFS",
	/** Main holds submodules (gitlinks). */
	"IMPORT_USES_SUBMODULES",
	/** Main's tree has more than 9,000 entries. */
	"IMPORT_TOO_MANY_FILES",
] as const;
export type CodeImportRefusal = (typeof CODE_IMPORT_REFUSALS)[number];

/** The failures an import ends with (`failed {code}`): not the code's fault. A run may add `:PLACE_AS_BEFORE` once it
 * opened a place it closed again untouched, as a restore does. */
export const CODE_IMPORT_FAILURES = [
	/** An answer that is not git's protocol v2 as asked: no `version 2`, bad pkt-lines, an unexpected section, another
	 * answer type, or an HTTP status the import does not know. */
	"IMPORT_SOURCE_PROTOCOL",
	/** The source's own error: side band 3, or an `ERR` packet. */
	"IMPORT_SOURCE_ERROR",
	/** The relay's own 404: no broker takes this company's fetch (an operator's matter). */
	"IMPORT_RELAY_NOT_ROUTED",
	/** Any other answer of the relay's own. */
	"IMPORT_RELAY_FAILED",
	/** The fetch took more than 60 minutes. */
	"IMPORT_FETCH_TIMEOUT",
	/** The code host's scratch has not five times the first bundle free. */
	"IMPORT_NO_SPACE",
	/** The fsck took more than 30 minutes. */
	"IMPORT_FSCK_TIMEOUT",
	/** The key scan's output had a line that is not its own. */
	"IMPORT_SCAN_FAILED",
] as const;
export type CodeImportFailure = (typeof CODE_IMPORT_FAILURES)[number];

/** What puts an import off (`busy`: claimed again later). Words of the log only: a busy outcome has no code. */
export const CODE_IMPORT_BUSY = [
	/** The relay's own 403: one opaque answer for a database blip, a real refusal and a renamed project (counted). */
	"IMPORT_RELAY_REFUSED",
	/** The relay's own 503: the vault's database is busy. */
	"IMPORT_RELAY_BUSY",
	/** The source's 429 or 5xx. */
	"IMPORT_SOURCE_BUSY",
	/** The transfer was cut (the relay, a proxy, a reset), or it stood idle past its bound. */
	"IMPORT_TRANSFER_CUT",
	/** The executor is stopping, or the run's signal ended. */
	"IMPORT_STOPPED",
] as const;

/** A refusal's code as the kernel takes it, and a failure's. */
export const CODE_IMPORT_REFUSED_CODE = /^(?:IMPORT|CODE_HOST)_[A-Z0-9_]{1,100}$/;
export const CODE_IMPORT_FAILED_CODE = /^[A-Z0-9_:]{1,120}$/;
const FIXED = /^[A-Z][A-Z0-9_]{2,80}$/;

/** How an import stops short of its end, as its outcome takes it: `refused` (the code's own, or a rule), `failed`
 * (not the code's fault), or `busy` (asked again at a later claim; the code is for the log only). The message is the
 * code alone: no text of the source's is ever in it. `notOurRef`: the fetch was refused a want, as after a force-push
 * between the ref list and the fetch: worth exactly one new ref list (C2). */
export class CodeImportStop extends Error {
	readonly end: "refused" | "failed" | "busy";
	readonly code: string;
	readonly notOurRef: boolean;
	constructor(end: "refused" | "failed" | "busy", code: string, options: { notOurRef?: boolean } = {}) {
		super(code);
		this.name = "CodeImportStop";
		this.end = end;
		this.code = code;
		this.notOurRef = options.notOurRef === true;
	}
}
const refused = (code: CodeImportRefusal) => new CodeImportStop("refused", code);
const protocol = () => new CodeImportStop("failed", "IMPORT_SOURCE_PROTOCOL");

/** Any error of the fetch, the read or the look as a stop: a stop as it is; the code host's refusal of a code the kernel
 * takes as a refusal; a job that gave way (`CODE_HOST_JOB_YIELDED`), a store whose line was held past its step
 * (`CODE_BUNDLE_STORE_TIMEOUT`) and anything once `signal` has ended, busy; a failure with its fixed code; anything else
 * `UNCLASSIFIED`. Which of restore's own refusals are the code's fault is the run's to say (part C3). */
export function codeImportStopOf(error: unknown, signal?: AbortSignal): CodeImportStop {
	if (error instanceof CodeImportStop) return error;
	if (signal?.aborted) return new CodeImportStop("busy", "IMPORT_STOPPED");
	if (error instanceof CodeHostRefusal && CODE_IMPORT_REFUSED_CODE.test(error.code))
		return new CodeImportStop("refused", error.code);
	const code =
		error instanceof CodeHostJobFailure || error instanceof CodeHostRefusal
			? error.code
			: error instanceof Error
				? error.message
				: "";
	if (code === "CODE_HOST_JOB_YIELDED" || code === "CODE_BUNDLE_STORE_TIMEOUT")
		return new CodeImportStop("busy", code);
	return new CodeImportStop("failed", FIXED.test(code) ? code : "UNCLASSIFIED");
}

const MESSAGE_ID = /: ([a-z][A-Za-z0-9]{1,40})(?=: )/g;

/** The refusal of a history git's strict object check refused (the look's fetch with `transfer.fsckObjects`), from
 * what it said: the first message id in it (`<oid>: zeroPaddedFilemode: …`, never an object's id), upper snake case.
 * `IMPORT_HISTORY_<ID>` when git takes that id for a warning alone (`warning`: an fsck that is not strict passes, as
 * `zeroPaddedFilemode` does: old git objects Qorpera can't take in yet), `IMPORT_HISTORY_DAMAGED_<ID>` otherwise;
 * `IMPORT_HISTORY_DAMAGED` when it named none. So the words can tell the two apart by the code alone. */
export function codeImportHistoryCode(said: string, warning: boolean): string {
	let id: string | undefined;
	for (const match of String(said).matchAll(MESSAGE_ID))
		if (!/^[0-9a-f]+$/.test(match[1] as string)) {
			id = match[1] as string;
			break;
		}
	if (id === undefined) return "IMPORT_HISTORY_DAMAGED";
	const upper = id.replace(/([A-Z])/g, "_$1").toUpperCase();
	return warning ? `IMPORT_HISTORY_${upper}` : `IMPORT_HISTORY_DAMAGED_${upper}`;
}

// Text and names -----------------------------------------------------------------------------------------------------------

const SHA = /^[0-9a-f]{40}$/;
const AT = /^\d{8}T\d{6}Z$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const utf8 = (text: string) => Buffer.byteLength(text, "utf8");
/** No lone surrogate: the text is its UTF-8 bytes exactly. */
const wellFormed = (text: string) => Buffer.from(text, "utf8").toString("utf8") === text;
const byBytes = (a: string, b: string) => Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
const whole = (value: unknown, least = 0): value is number => Number.isSafeInteger(value) && (value as number) >= least;

/** The first bundle's name in the store: `import-<UTC>-<the default branch's commit, 12 hex>`. No dated bundle's name
 * (`CODE_BUNDLE_NAME`) is one, so prune, care and restore never see it; it sorts after every dated name. */
export const CODE_IMPORT_BUNDLE_NAME = /^import-\d{8}T\d{6}Z-[0-9a-f]{12}$/;
export const CODE_IMPORT_BUNDLE_SCHEMA = "qorpera.code-import-bundle/v1";
export function codeImportBundleName(createdAt: string, mainSha: string): string {
	return `import-${codeBundleName(createdAt, mainSha)}`;
}

/** Where every other branch of an imported repository is kept: read them, never change them. */
export const CODE_IMPORT_IMPORTED_HEADS = "refs/qorpera/imported/heads/";

const REF_BAD = /[\u0000-\u0020\u007f~^:?*[\\]/;
/** Whether git takes `name` as a ref's full name (`git check-ref-format` without `--allow-onelevel`, git 2.53): two or
 * more parts; no empty part, none starting with `.` or ending in `.lock`; no `..`, no `@{`; no control character, DEL,
 * space, `~`, `^`, `:`, `?`, `*`, `[` or backslash; not ending in `/` or `.`; not `@`. */
export function codeImportGitRefValid(name: string): boolean {
	if (
		typeof name !== "string" ||
		!wellFormed(name) ||
		name === "@" ||
		!name.includes("/") ||
		name.endsWith("/") ||
		name.endsWith(".") ||
		REF_BAD.test(name) ||
		name.includes("..") ||
		name.includes("@{")
	)
		return false;
	return name.split("/").every((part) => part !== "" && !part.startsWith(".") && !part.endsWith(".lock"));
}

/** A ref the first bundle names (5.2): under `refs/heads/` or `refs/tags/`, a name git takes (so no NUL, CR, LF or
 * space), UTF-8, at most 1,000 bytes. A fetch from a bundle that names one git refuses fails whole. */
export function codeImportHeaderRefValid(name: string): boolean {
	return (
		typeof name === "string" &&
		/^refs\/(?:heads|tags)\/./.test(name) &&
		utf8(name) <= CODE_IMPORT_REF_NAME_BYTES &&
		codeImportGitRefValid(name)
	);
}

/** A default branch as an import takes it (its name after `refs/heads/`): a header ref's name, at most 200 bytes,
 * shown as it is (`codeImportShown`) and with nothing in it that looks like a key. Else `IMPORT_BRANCH_NAME`, before
 * the name is written anywhere. */
export function codeImportBranchValid(branch: string): boolean {
	return (
		typeof branch === "string" &&
		codeImportHeaderRefValid(`refs/heads/${branch}`) &&
		codeImportShown(branch, CODE_IMPORT_BRANCH_BYTES) === branch
	);
}

const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
/** The company folder's rule for a path under `code/` (`qorpera_company_path_valid`, migration 20260928569110, whose
 * code/ branch takes `%`, `:` and device names): 1 to 4,096 bytes, NFC; and the path, its folder key and its key by full
 * case mapping (stricter than the database's simple mapping wherever the two differ) each have as many parts as the
 * path, none empty, `.` or `..`, none ending in `.` or a space, no control character (C0, DEL, C1 and the line and
 * paragraph separators: stricter than the database's `[[:cntrl:]]` where it differs) and no backslash. A path outside
 * `code/` is no path this rule is for: false. No TypeScript copy of the rule was in `@qorpera/contracts`. */
export function codeImportFolderPathValid(path: string): boolean {
	if (typeof path !== "string" || !wellFormed(path)) return false;
	const bytes = utf8(path);
	if (bytes < 1 || bytes > 4096 || path.normalize("NFC") !== path) return false;
	const key = folderKey(path);
	if (key.split("/")[0] !== "code") return false;
	const parts = path.split("/").length;
	for (const candidate of [path, key, path.normalize("NFKC").toUpperCase().toLowerCase().normalize("NFKC")]) {
		if (CONTROL.test(candidate) || candidate.includes("\\") || candidate.split("/").length !== parts) return false;
		if (candidate.split("/").some((part) => part === "" || part === "." || part === ".." || /[. ]$/.test(part)))
			return false;
	}
	return true;
}

const INCOMING = /^code\/_incoming\/([A-Za-z0-9][A-Za-z0-9._-]{0,99})\/[A-Za-z0-9][A-Za-z0-9._-]{0,92}\.bundle$/;
/** A file source's path, as `from.file` names it: `code/_incoming/<folder>/<name>.bundle`, the folder 1 to 100 and the
 * name 1 to 100 of letters, digits, `.`, `_` and `-`, each starting with a letter or a digit; no `..`, no folder git
 * keeps for itself (`repo.git`), and a path the folder takes. */
export function codeImportIncomingPathValid(path: string): boolean {
	const match = typeof path === "string" ? INCOMING.exec(path) : null;
	return (
		match !== null &&
		!path.includes("..") &&
		folderKey(match[1] as string) !== "repo.git" &&
		codeImportFolderPathValid(path)
	);
}

// What looks like a key --------------------------------------------------------------------------------------------------

/** What the key scan tells apart. `env-file` is a path rule (a tracked `.env`), every other kind a pattern. */
export const CODE_IMPORT_KEY_KINDS = [
	"aws",
	"github",
	"stripe",
	"slack",
	"google",
	"private-key",
	"resend",
	"openai",
	"anthropic",
	"env-file",
] as const;
export type CodeImportKeyKind = (typeof CODE_IMPORT_KEY_KINDS)[number];
export type CodeImportScannedKind = Exclude<CodeImportKeyKind, "env-file">;

/** Each kind's pattern: POSIX extended regular expressions as GNU grep and sed take them under `LC_ALL=C` (`\b` is a
 * boundary of ASCII letters, digits and `_`), written so JavaScript reads each the same way. None holds `'`, `#` or a
 * newline (the scan's shell quotes them and its sed rules end at `#`), none can match within a batch header (40
 * lowercase hex, ` blob `, digits), and none counts past 59 (open-ended runs are cheap for grep, long counted ones are
 * not). Matched: AWS access key ids (`AKIA`, `ASIA` and 16), GitHub tokens (`ghp_`, `gho_`,
 * `ghu_`, `ghs_`, `ghr_` and 36 or more; `github_pat_` and 22 `_` 59), Stripe live secret and restricted keys, Slack
 * tokens (`xox?-`, `xapp-`) and webhooks, Google API keys (`AIza` and 35), private key blocks (PEM, OpenSSH, PGP: their
 * first line), Resend keys (`re_`, 8 to 12, `_`, 20 to 40: the format is not verified), OpenAI project, service account
 * and admin keys (`sk-proj-`, `sk-svcacct-`, `sk-admin-`) and its older user keys (`sk-`, 20, `T3BlbkFJ`, 20),
 * Anthropic keys (`sk-ant-`). */
export const CODE_IMPORT_KEY_PATTERNS: Readonly<Record<CodeImportScannedKind, string>> = Object.freeze({
	aws: "\\b(AKIA|ASIA)[0-9A-Z]{16}\\b",
	github: "\\b(gh[pousr]_[0-9A-Za-z]{36,}|github_pat_[0-9A-Za-z]{22}_[0-9A-Za-z]{59})",
	stripe: "\\b[rs]k_live_[0-9A-Za-z]{24,}",
	slack: "\\bxox[abeoprs]-[0-9A-Za-z-]{10,}|\\bxapp-[0-9]-[0-9A-Za-z-]{10,}|hooks\\.slack\\.com/services/T[0-9A-Z]{8,12}/B[0-9A-Z]{8,12}/[0-9A-Za-z]{24}",
	google: "\\bAIza[0-9A-Za-z_-]{35}",
	"private-key": "-----BEGIN ([A-Z0-9]+ )*PRIVATE KEY( BLOCK)?-----",
	resend: "\\bre_[0-9A-Za-z]{8,12}_[0-9A-Za-z]{20,40}\\b",
	openai: "\\bsk-(proj|svcacct|admin)-[0-9A-Za-z_-]{20,}|\\bsk-[0-9A-Za-z]{20}T3BlbkFJ[0-9A-Za-z]{20}\\b",
	anthropic: "\\bsk-ant-[0-9A-Za-z_-]{20,}",
});
const SCANNED = CODE_IMPORT_KEY_KINDS.filter((kind): kind is CodeImportScannedKind => kind !== "env-file");
const KEY_TESTS = SCANNED.map((kind) => [kind, new RegExp(CODE_IMPORT_KEY_PATTERNS[kind])] as const);

/** The first kind whose pattern matches anywhere in `text`, or null. For paths and branch names, which the scan does
 * not read. */
export function codeImportKeyIn(text: string): CodeImportScannedKind | null {
	for (const [kind, test] of KEY_TESTS) if (test.test(text)) return kind;
	return null;
}

/** A tracked `.env`: a path whose last part is `.env` or starts with `.env.`, of any case, but for those ending in
 * `.example`, `.sample` or `.template`. */
export function codeImportEnvFile(path: string): boolean {
	const last = path.slice(path.lastIndexOf("/") + 1);
	return /^\.env(?:\.[^/]*)?$/i.test(last) && !/\.(?:example|sample|template)$/i.test(last);
}

/** A path or a name as the look shows it: as it is, or null (never cut) when it is over `bytes` (200), holds what looks
 * like a key, is not well-formed UTF-8 text (a lone surrogate, or U+FFFD where a name was not UTF-8) or holds a
 * control character. */
export function codeImportShown(text: string | null | undefined, bytes = CODE_IMPORT_LOOK_PATH_BYTES): string | null {
	if (typeof text !== "string" || text === "" || utf8(text) > bytes || !wellFormed(text)) return null;
	if (text.includes("\ufffd") || CONTROL.test(text) || codeImportKeyIn(text) !== null) return null;
	return text;
}

// pkt-lines ----------------------------------------------------------------------------------------------------------------

/** git's pkt-line framing: four lowercase hex digits of the line's whole length, then its bytes. `0000` (flush),
 * `0001` (delim) and `0002` (response end) are the three special lines. */
export function codeImportPktLine(payload: string | Uint8Array): Buffer {
	const data = typeof payload === "string" ? Buffer.from(payload, "utf8") : Buffer.from(payload);
	if (data.length === 0 || data.length + 4 > CODE_IMPORT_PKT_LINE_BYTES)
		throw new Error("INVALID_CODE_IMPORT_PKT_LINE");
	return Buffer.concat([Buffer.from((data.length + 4).toString(16).padStart(4, "0"), "latin1"), data]);
}
const FLUSH = Buffer.from("0000", "latin1");
const DELIM = Buffer.from("0001", "latin1");

export type CodeImportPacket =
	| { readonly type: "data"; readonly payload: Buffer }
	| { readonly type: "flush" | "delim" | "end" };

const LENGTH = /^[0-9a-fA-F]{4}$/;
const EMPTY = Buffer.alloc(0);

/** The pkt-lines of a stream, as its chunks come, whatever their sizes. It holds at most one line besides the chunk it
 * reads, and reads the next chunk only once the lines it has are taken. A length that is not four hex digits, is 3,
 * or is over 65,520, and a stream that ends within a line: `IMPORT_SOURCE_PROTOCOL`. `0004` is a data line with nothing
 * in it (its reader says whether it takes one). A data line's payload is a view of the chunk it came in. */
export async function* codeImportPackets(
	body: AsyncIterable<Uint8Array>,
): AsyncGenerator<CodeImportPacket, void, undefined> {
	let held: Buffer = EMPTY;
	for await (const chunk of body) {
		if (!(chunk instanceof Uint8Array)) throw protocol();
		const piece = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
		const buffer = held.length ? Buffer.concat([held, piece]) : piece;
		let at = 0;
		while (buffer.length - at >= 4) {
			const digits = buffer.toString("latin1", at, at + 4);
			if (!LENGTH.test(digits)) throw protocol();
			const length = Number.parseInt(digits, 16);
			if (length < 3) {
				at += 4;
				yield { type: length === 0 ? "flush" : length === 1 ? "delim" : "end" };
				continue;
			}
			if (length === 3 || length > CODE_IMPORT_PKT_LINE_BYTES) throw protocol();
			if (buffer.length - at < length) break;
			const payload = buffer.subarray(at + 4, at + length);
			at += length;
			yield { type: "data", payload };
		}
		// What is left is less than one line: copied, so the chunk it came in can go.
		held = at < buffer.length ? Buffer.from(buffer.subarray(at)) : EMPTY;
	}
	if (held.length) throw protocol();
}

/** A stream that ends with `stop` once it brought more than `maximum` bytes. */
async function* within(
	body: AsyncIterable<Uint8Array>,
	maximum: number,
	stop: () => CodeImportStop,
): AsyncGenerator<Uint8Array, void, undefined> {
	let bytes = 0;
	for await (const chunk of body) {
		bytes += chunk.byteLength;
		if (bytes > maximum) throw stop();
		yield chunk;
	}
}

const strictUtf8 = new TextDecoder("utf-8", { fatal: true });
/** A text line's text: UTF-8, without the one line feed it may end in. */
function textOf(payload: Buffer): string {
	let text: string;
	try {
		text = strictUtf8.decode(payload);
	} catch {
		throw protocol();
	}
	return text.endsWith("\n") ? text.slice(0, -1) : text;
}
/** An `ERR` line, anywhere: the source's own error. Its text never leaves here. */
function errorLine(payload: Buffer): CodeImportStop | null {
	if (payload.length < 4 || payload.toString("latin1", 0, 4) !== "ERR ") return null;
	return new CodeImportStop("failed", "IMPORT_SOURCE_ERROR", {
		notOurRef: payload.toString("latin1").includes("not our ref"),
	});
}

// Protocol v2: the advertisement, the ref list, the fetch -------------------------------------------------------------------

/** What the source said it serves (the GET of `info/refs?service=git-upload-pack` with `Git-Protocol: version=2`). */
export interface CodeImportServer {
	/** Every capability line, `key` or `key=value`. */
	readonly capabilities: ReadonlyMap<string, string | null>;
	readonly objectFormat: "sha1";
}

/** The capability advertisement, as GitHub sends it (a `# service=git-upload-pack` line and a flush, then `version 2`)
 * or as `git upload-pack --http-backend-info-refs` makes it (`version 2` first): the capability lines up to the flush,
 * and nothing after it. No `version 2`, no `ls-refs` or `fetch`, an object format git's own client would not speak, a
 * capability twice, or more than 64 KiB: `IMPORT_SOURCE_PROTOCOL`. `object-format=sha256`:
 * `IMPORT_SHA256_REPOSITORY`. */
export async function codeImportAdvertisement(body: AsyncIterable<Uint8Array>): Promise<CodeImportServer> {
	const packets = codeImportPackets(within(body, CODE_IMPORT_ADVERTISEMENT_BYTES, protocol));
	const next = async () => {
		const read = await packets.next();
		return read.done ? null : read.value;
	};
	const text = (packet: CodeImportPacket | null) => {
		if (packet?.type !== "data") return null;
		const stop = errorLine(packet.payload);
		if (stop) throw stop;
		return textOf(packet.payload);
	};
	const capabilities = new Map<string, string | null>();
	try {
		let packet = await next();
		if (text(packet) === "# service=git-upload-pack") {
			if ((await next())?.type !== "flush") throw protocol();
			packet = await next();
		}
		if (text(packet) !== "version 2") throw protocol();
		for (;;) {
			packet = await next();
			if (packet?.type === "flush") break;
			const line = text(packet);
			const capability = line === null ? null : /^([A-Za-z0-9-]{1,64})(?:=([\x20-\x7e]{0,1024}))?$/.exec(line);
			if (!capability || capabilities.has(capability[1] as string)) throw protocol();
			capabilities.set(capability[1] as string, capability[2] ?? null);
		}
		if ((await next()) !== null) throw protocol();
	} finally {
		// A stop before the end leaves the body to its caller no longer read: its reader goes.
		await packets.return(undefined);
	}
	if (!capabilities.has("ls-refs") || !capabilities.has("fetch")) throw protocol();
	const format = capabilities.get("object-format");
	if (format === "sha256") throw refused("IMPORT_SHA256_REPOSITORY");
	if (format !== undefined && format !== "sha1") throw protocol();
	return { capabilities, objectFormat: "sha1" };
}

/** The ls-refs request: the default branch (HEAD's `symref-target`), every head and every tag, with the commits that
 * annotated tags point to (`peeled:`), in the form git and GitHub take (`object-format=sha1` and a delim first). */
export function codeImportLsRefsRequest(): Buffer {
	return Buffer.concat([
		codeImportPktLine("command=ls-refs\n"),
		codeImportPktLine("object-format=sha1\n"),
		DELIM,
		codeImportPktLine("peel\n"),
		codeImportPktLine("symrefs\n"),
		codeImportPktLine("ref-prefix HEAD\n"),
		codeImportPktLine("ref-prefix refs/heads/\n"),
		codeImportPktLine("ref-prefix refs/tags/\n"),
		FLUSH,
	]);
}

/** One ref the source listed. `oid` is what the ref names (an annotated tag's own object); `peeled` the object such a
 * tag points to. */
export interface CodeImportListedRef {
	readonly name: string;
	readonly oid: string;
	readonly peeled: string | null;
}
export interface CodeImportRefList {
	/** HEAD: the commit it names (null when it names a branch with no commit yet) and the ref it is (`symref-target`). */
	readonly head: { readonly oid: string | null; readonly target: string | null } | null;
	/** Every head and tag, in the order listed. */
	readonly refs: readonly CodeImportListedRef[];
	/** Lines left out: a name that is not UTF-8, or a ref outside `refs/heads/` and `refs/tags/`. */
	readonly unreadable: number;
}

/** The ls-refs answer: `<oid> <name>[ symref-target:<ref>][ peeled:<oid>]` lines up to the flush (a `0002` after it is
 * taken, never needed), and nothing else. More than 20,000 lines or 4 MiB: `IMPORT_TOO_MANY_REFS`. A line that is not
 * one (another object id's length, a name twice, HEAD twice), a delim, or no flush: `IMPORT_SOURCE_PROTOCOL`; an `ERR`
 * line: `IMPORT_SOURCE_ERROR`. Attributes it does not know are passed over. */
export async function codeImportRefList(body: AsyncIterable<Uint8Array>): Promise<CodeImportRefList> {
	let lines = 0,
		unreadable = 0,
		ended = false,
		closed = false,
		head: CodeImportRefList["head"] = null;
	const refs: CodeImportListedRef[] = [],
		names = new Set<string>();
	for await (const packet of codeImportPackets(
		within(body, CODE_IMPORT_REF_LIST_BYTES, () => refused("IMPORT_TOO_MANY_REFS")),
	)) {
		if (ended) {
			if (packet.type !== "end" || closed) throw protocol();
			closed = true;
			continue;
		}
		if (packet.type === "flush") {
			ended = true;
			continue;
		}
		if (packet.type !== "data") throw protocol();
		const stop = errorLine(packet.payload);
		if (stop) throw stop;
		lines += 1;
		if (lines > CODE_IMPORT_REF_LINES) throw refused("IMPORT_TOO_MANY_REFS");
		// Split as bytes: a name is decoded on its own, and git's names hold no space.
		const raw = packet.payload.toString("latin1");
		const fields = (raw.endsWith("\n") ? raw.slice(0, -1) : raw).split(" ");
		const [oid, latin] = fields;
		if (oid === undefined || latin === undefined || latin === "" || !(SHA.test(oid) || oid === "unborn"))
			throw protocol();
		let symref: string | null = null,
			peeled: string | null = null;
		for (const attribute of fields.slice(2)) {
			if (attribute.startsWith("symref-target:")) symref = attribute.slice("symref-target:".length);
			else if (attribute.startsWith("peeled:")) {
				peeled = attribute.slice("peeled:".length);
				if (!SHA.test(peeled)) throw protocol();
			}
		}
		let name: string;
		try {
			name = strictUtf8.decode(Buffer.from(latin, "latin1"));
			if (symref !== null) symref = strictUtf8.decode(Buffer.from(symref, "latin1"));
		} catch {
			unreadable += 1;
			continue;
		}
		if (name === "HEAD") {
			if (head !== null) throw protocol();
			head = { oid: oid === "unborn" ? null : oid, target: symref };
			continue;
		}
		if (oid === "unborn" || names.has(name)) throw protocol();
		names.add(name);
		if (!name.startsWith("refs/heads/") && !name.startsWith("refs/tags/")) {
			unreadable += 1;
			continue;
		}
		refs.push({ name, oid, peeled });
	}
	if (!ended) throw protocol();
	return { head, refs, unreadable };
}

/** What the fetch wants and what its bundle names. */
export interface CodeImportWanted {
	/** The default branch's name (after `refs/heads/`) and its commit. */
	readonly defaultBranch: string;
	readonly mainSha: string;
	/** The first bundle's header, the default branch first, then the other heads and the tags, each in its names' byte
	 * order. */
	readonly refs: readonly CodeBundleRef[];
	/** The objects to fetch, each once, in that order. */
	readonly wants: readonly string[];
	/** Refs not in the header: names git or the header refuses, refs past the wants' cap, and the list's unreadable. */
	readonly leftOut: number;
}

/** From the ref list to the fetch: the default branch is `branch` when the request named one
 * (`IMPORT_BRANCH_UNKNOWN` when the list has no such head), else HEAD's `symref-target` (`IMPORT_SOURCE_EMPTY` when
 * HEAD is missing or names no commit, `IMPORT_BRANCH_UNKNOWN` when it is no listed head); a name `codeImportBranchValid`
 * refuses is `IMPORT_BRANCH_NAME`. Then every head and tag whose name the header takes, each object wanted once, until
 * `maximumWants` (5,000) objects are: a ref whose object is wanted already comes along, any other is left out. */
export function codeImportWants(
	list: CodeImportRefList,
	options: { branch?: string | null; maximumWants?: number } = {},
): CodeImportWanted {
	const maximum = options.maximumWants ?? CODE_IMPORT_WANTS;
	if (!whole(maximum, 1) || maximum > CODE_IMPORT_WANTS) throw new Error("INVALID_CODE_IMPORT");
	const byName = new Map(list.refs.map((ref) => [ref.name, ref]));
	let target: string;
	if (options.branch !== undefined && options.branch !== null) {
		if (!codeImportBranchValid(options.branch)) throw refused("IMPORT_BRANCH_NAME");
		target = `refs/heads/${options.branch}`;
		if (!byName.has(target)) throw refused("IMPORT_BRANCH_UNKNOWN");
	} else {
		if (list.head === null || list.head.oid === null) throw refused("IMPORT_SOURCE_EMPTY");
		if (list.head.target === null || !list.head.target.startsWith("refs/heads/") || !byName.has(list.head.target))
			throw refused("IMPORT_BRANCH_UNKNOWN");
		target = list.head.target;
	}
	const defaultBranch = target.slice("refs/heads/".length);
	if (!codeImportBranchValid(defaultBranch)) throw refused("IMPORT_BRANCH_NAME");
	const main = byName.get(target) as CodeImportListedRef;
	const sorted = (prefix: string) =>
		list.refs.filter((ref) => ref.name.startsWith(prefix) && ref !== main).sort((a, b) => byBytes(a.name, b.name));
	const wanted = new Set<string>(),
		refs: CodeBundleRef[] = [];
	let leftOut = list.unreadable;
	for (const ref of [main, ...sorted("refs/heads/"), ...sorted("refs/tags/")]) {
		if (!codeImportHeaderRefValid(ref.name)) {
			leftOut += 1;
			continue;
		}
		if (!wanted.has(ref.oid)) {
			if (wanted.size >= maximum) {
				leftOut += 1;
				continue;
			}
			wanted.add(ref.oid);
		}
		refs.push({ name: ref.name, sha: ref.oid });
	}
	return { defaultBranch, mainSha: main.oid, refs, wants: [...wanted], leftOut };
}

/** The fetch request: `ofs-delta`, the wants and `done` (no haves, so no acknowledgments and a pack that needs nothing
 * else; no `thin-pack`; no `no-progress`, so side band 2 keeps the relay's idle timer fed). */
export function codeImportFetchRequest(wants: readonly string[]): Buffer {
	if (
		!Array.isArray(wants) ||
		wants.length < 1 ||
		wants.length > CODE_IMPORT_WANTS ||
		!wants.every((want) => typeof want === "string" && SHA.test(want)) ||
		new Set(wants).size !== wants.length
	)
		throw new Error("INVALID_CODE_IMPORT");
	return Buffer.concat([
		codeImportPktLine("command=fetch\n"),
		codeImportPktLine("object-format=sha1\n"),
		DELIM,
		codeImportPktLine("ofs-delta\n"),
		...wants.map((want) => codeImportPktLine(`want ${want}\n`)),
		codeImportPktLine("done\n"),
		FLUSH,
	]);
}

/** What came with a pack, counted as it came: every line, side band 2's (progress, which only says the source is
 * alive), band 1's empty lines (keep-alives while the source packs), and the pack's bytes. */
export interface CodeImportPackStats {
	packets: number;
	progress: number;
	keepAlives: number;
	bytes: number;
}
export function codeImportPackStats(): CodeImportPackStats {
	return { packets: 0, progress: 0, keepAlives: 0, bytes: 0 };
}

/** The pack of a fetch answer, its bytes handed on as they come, never collected: `packfile`, then side-band lines up
 * to the flush (a `0002` after it is taken, never needed), and nothing after. Band 1 is the pack (it must begin `PACK`,
 * version 2 or 3, and hold at least a header and a trailer); band 2 is counted; band 3, or an `ERR` line anywhere, is
 * `IMPORT_SOURCE_ERROR` (`notOurRef` when it says so); any other section or band, an empty line, a delim, or no flush is
 * `IMPORT_SOURCE_PROTOCOL`. Each piece it yields is a view of the line it came in, at most 65,515 bytes; the first are
 * held only until the pack's 12 header bytes are seen. */
export async function* codeImportPack(
	body: AsyncIterable<Uint8Array>,
	stats: CodeImportPackStats = codeImportPackStats(),
): AsyncGenerator<Buffer, void, undefined> {
	const packets = codeImportPackets(body);
	const next = async () => {
		const read = await packets.next();
		return read.done ? null : read.value;
	};
	try {
		const first = await next();
		if (first?.type !== "data") throw protocol();
		const stop = errorLine(first.payload);
		if (stop) throw stop;
		if (first.payload.toString("latin1") !== "packfile\n") throw protocol();
		let start: Buffer[] | null = [];
		for (;;) {
			const packet = await next();
			if (packet?.type === "flush") break;
			if (packet?.type !== "data") throw protocol();
			stats.packets += 1;
			const { payload } = packet;
			const error = errorLine(payload);
			if (error) throw error;
			if (payload.length === 0) throw protocol();
			const band = payload[0],
				data = payload.subarray(1);
			if (band === 2) {
				stats.progress += 1;
				continue;
			}
			if (band === 3)
				throw new CodeImportStop("failed", "IMPORT_SOURCE_ERROR", {
					notOurRef: data.toString("latin1").includes("not our ref"),
				});
			if (band !== 1) throw protocol();
			if (data.length === 0) {
				stats.keepAlives += 1;
				continue;
			}
			stats.bytes += data.length;
			if (start === null) {
				yield data;
				continue;
			}
			start.push(data);
			if (stats.bytes < 12) continue;
			const seen = Buffer.concat(start).subarray(0, 12);
			if (seen.toString("latin1", 0, 4) !== "PACK" || ![2, 3].includes(seen.readUInt32BE(4))) throw protocol();
			const held = start;
			start = null;
			for (const piece of held) yield piece;
		}
		const after = await next();
		if (after !== null && (after.type !== "end" || (await next()) !== null)) throw protocol();
		if (start !== null || stats.bytes < 32) throw protocol();
	} finally {
		// A stop, or a reader that stopped taking pieces, leaves the body no longer read: its reader goes.
		await packets.return(undefined);
	}
}

/** The first bundle's header, in the form `git bundle verify` and a fetch from it took on node02 (git 2.53): `# v2 git
 * bundle`, one `<oid> <name>` line a ref, a blank line. The pack follows it as the fetch got it. Names must be header
 * refs (`codeImportHeaderRefValid`), each once; at least one. */
export function codeImportBundleHeader(refs: readonly CodeBundleRef[]): Buffer {
	if (!Array.isArray(refs) || refs.length === 0) throw new Error("INVALID_CODE_IMPORT_BUNDLE_HEADER");
	const names = new Set<string>(),
		lines = ["# v2 git bundle\n"];
	for (const ref of refs) {
		if (
			typeof ref?.sha !== "string" ||
			!SHA.test(ref.sha) ||
			!codeImportHeaderRefValid(ref.name) ||
			names.has(ref.name)
		)
			throw new Error("INVALID_CODE_IMPORT_BUNDLE_HEADER");
		names.add(ref.name);
		lines.push(`${ref.sha} ${ref.name}\n`);
	}
	lines.push("\n");
	return Buffer.from(lines.join(""), "utf8");
}

/** A git bundle's header as its first bytes give it (`# v2 git bundle` or `# v3 git bundle` with its capabilities),
 * up to its blank line: what a file source holds, before git reads it. */
export interface CodeImportBundleHeader {
	readonly version: 2 | 3;
	/** v3's `@key[=value]` lines. */
	readonly capabilities: ReadonlyMap<string, string | null>;
	/** `-<oid>` lines: commits the bundle needs and does not hold. */
	readonly prerequisites: number;
	readonly refs: readonly CodeBundleRef[];
	/** Where the pack begins. */
	readonly bytes: number;
}

/** A bundle's header from the file's first bytes (at most 4 MiB of them are read): anything that is not one, a
 * header with no end in them, or object ids that are not SHA-1: `IMPORT_FILE_NOT_WHOLE`;
 * `@object-format=sha256`: `IMPORT_SHA256_REPOSITORY`. Prerequisites are counted (the read job refuses a bundle
 * with any). */
export function codeImportBundleHeaderOf(start: Uint8Array): CodeImportBundleHeader {
	const bytes = Buffer.from(start.buffer, start.byteOffset, Math.min(start.byteLength, CODE_IMPORT_REF_LIST_BYTES));
	const end = bytes.indexOf("\n\n", 0, "latin1");
	const notWhole = () => refused("IMPORT_FILE_NOT_WHOLE");
	if (end < 0) throw notWhole();
	let text: string;
	try {
		text = strictUtf8.decode(bytes.subarray(0, end + 1));
	} catch {
		throw notWhole();
	}
	const lines = text.split("\n").slice(0, -1);
	const version = lines[0] === "# v2 git bundle" ? 2 : lines[0] === "# v3 git bundle" ? 3 : null;
	if (version === null) throw notWhole();
	const capabilities = new Map<string, string | null>(),
		refs: CodeBundleRef[] = [];
	let prerequisites = 0;
	// v3's capabilities come first, and say the object format before any object id is read.
	let at = 1;
	for (; version === 3 && at < lines.length; at++) {
		const capability = /^@([A-Za-z0-9-]{1,64})(?:=(.{0,1024}))?$/.exec(lines[at] as string);
		if (!capability) break;
		capabilities.set(capability[1] as string, capability[2] ?? null);
	}
	const format = capabilities.get("object-format");
	if (format === "sha256") throw refused("IMPORT_SHA256_REPOSITORY");
	if (format !== undefined && format !== "sha1") throw notWhole();
	for (const line of lines.slice(at)) {
		const ref = /^(-?)([0-9a-f]{40})(?: (.*))?$/.exec(line);
		if (!ref) throw notWhole();
		if (ref[1] === "-") prerequisites += 1;
		else if (ref[3] === undefined || ref[3] === "") throw notWhole();
		else refs.push({ name: ref[3], sha: ref[2] as string });
	}
	return { version, capabilities, prerequisites, refs, bytes: end + 2 };
}

/** The first bundle's bytes in the pieces the store takes: the header, then the pack, in `pieceBytes` (1 MiB) pieces,
 * the last one shorter. Each is a new buffer, made only when the one before was taken, so a writer that is slow holds
 * the pack back (its source is read no further) and at most one piece is held. More than `maximumBytes` in all (the
 * header counted): `IMPORT_TOO_LARGE`, before the piece that would hold the byte too many. */
export async function* codeImportBundlePieces(
	header: Uint8Array,
	pack: AsyncIterable<Uint8Array>,
	maximumBytes: number,
	pieceBytes = CODE_IMPORT_PIECE_BYTES,
): AsyncGenerator<Buffer, void, undefined> {
	if (
		!(header instanceof Uint8Array) ||
		!whole(maximumBytes, 1) ||
		maximumBytes > CODE_IMPORT_MAXIMUM_BYTES_LIMIT ||
		!whole(pieceBytes, 1) ||
		pieceBytes > CODE_IMPORT_READ_PIECE_BYTES
	)
		throw new Error("INVALID_CODE_IMPORT");
	let piece = Buffer.allocUnsafe(pieceBytes),
		filled = 0,
		total = 0;
	const sources = (async function* () {
		yield header;
		yield* pack;
	})();
	for await (const chunk of sources) {
		total += chunk.byteLength;
		if (total > maximumBytes) throw refused("IMPORT_TOO_LARGE");
		for (let offset = 0; offset < chunk.byteLength; ) {
			const taken = Math.min(pieceBytes - filled, chunk.byteLength - offset);
			piece.set(chunk.subarray(offset, offset + taken), filled);
			filled += taken;
			offset += taken;
			if (filled === pieceBytes) {
				yield piece;
				piece = Buffer.allocUnsafe(pieceBytes);
				filled = 0;
			}
		}
	}
	if (filled) yield piece.subarray(0, filled);
}

// The transport, and what its answers mean -------------------------------------------------------------------------------

/** One answer to the import's requests, as a transport hands it back: the source's own (GitHub's status and type, with
 * its body to read), or the relay's own refusal (`qorpera.cloud-secret-error/v1`: its JSON, read and closed by the
 * transport; `error` its `error` word). */
export type CodeImportAnswer =
	| {
			readonly by: "source";
			readonly status: number;
			/** The answer's type without its parameters, lower case; null when it has none. */
			readonly contentType: string | null;
			readonly body: AsyncIterable<Uint8Array>;
	  }
	| { readonly by: "relay"; readonly status: number; readonly error: string | null };

/** How the import reaches GitHub's smart HTTP for one repository (part C2, `deploy/coding-worker/repository-fetch.ts`):
 * through the company's secret broker (the relay's `/v1/coding-repository-fetch/refs` and `/upload-pack`, the
 * request's id, lease and executor in its headers; the token never reaches the executor), or straight to
 * `https://github.com/<Owner>/<Name>.git` for a public project. Redirects are refused, never followed. A rejection, and
 * a body whose reading rejects, is a cut transfer (`busy`), unless the import's signal ended, or unless it rejects with
 * a `CodeImportStop`, which the fetch takes at its word (the public transport's `IMPORT_SOURCE_PROTOCOL` for an answer
 * with a content encoding). */
export interface CodeImportTransport {
	/** GET `info/refs?service=git-upload-pack`, `Git-Protocol: version=2`. */
	refs(signal: AbortSignal): Promise<CodeImportAnswer>;
	/** POST `git-upload-pack`, `Content-Type: application/x-git-upload-pack-request`, `Git-Protocol: version=2`, with
	 * this body: an ls-refs or a fetch request. */
	uploadPack(body: Uint8Array, signal: AbortSignal): Promise<CodeImportAnswer>;
}
export interface CodeImportTransports {
	/** Through the company's GitHub connection, as the request's own lease. */
	connection(
		scope: { companyId: string; requestId: string; leaseToken: string },
		repository: { owner: string; name: string },
	): CodeImportTransport;
	/** A public project, with no credential. */
	public(repository: { owner: string; name: string }): CodeImportTransport;
}

/** Whether an answer is the one to read (null), or how the import stops: the source's 200 of the asked type (`result`
 * for a POST, `advertisement` for the GET) is read, of another type `IMPORT_SOURCE_PROTOCOL`; its redirect (public
 * only: the relay refuses one with its own 403) `IMPORT_SOURCE_MOVED`; its 401, 403 and 404 `IMPORT_SOURCE_REFUSED`;
 * its 429 and 5xx busy; any other `IMPORT_SOURCE_PROTOCOL`. The relay's own 403 is busy `IMPORT_RELAY_REFUSED`
 * (`codeImportRelayRefusals` counts it), its 503 busy, its 404 `IMPORT_RELAY_NOT_ROUTED`, any other
 * `IMPORT_RELAY_FAILED`. A body the import does not read is the caller's to cancel. */
export function codeImportAnswerStop(
	answer: CodeImportAnswer,
	type: "advertisement" | "result",
): CodeImportStop | null {
	const { status } = answer;
	if (answer.by === "relay") {
		if (status === 403) return new CodeImportStop("busy", "IMPORT_RELAY_REFUSED");
		if (status === 503) return new CodeImportStop("busy", "IMPORT_RELAY_BUSY");
		return new CodeImportStop("failed", status === 404 ? "IMPORT_RELAY_NOT_ROUTED" : "IMPORT_RELAY_FAILED");
	}
	if (status === 200) return answer.contentType === `application/x-git-upload-pack-${type}` ? null : protocol();
	if (status >= 300 && status < 400) return refused("IMPORT_SOURCE_MOVED");
	if (status === 401 || status === 403 || status === 404) return refused("IMPORT_SOURCE_REFUSED");
	if (status === 429 || (status >= 500 && status < 600)) return new CodeImportStop("busy", "IMPORT_SOURCE_BUSY");
	return protocol();
}

/** The relay's own 403s in a row (the progress's `relayRefused`, before this answer) and how this one ends: a third in
 * a row is `IMPORT_SOURCE_REFUSED`; any other end, and a fetch that got past the relay (`stop` null), starts the count
 * again. */
export function codeImportRelayRefusals(
	previous: number,
	stop: CodeImportStop | null,
): { relayRefused: number; stop: CodeImportStop | null } {
	if (stop?.code !== "IMPORT_RELAY_REFUSED") return { relayRefused: 0, stop };
	const relayRefused = Math.max(0, Math.trunc(previous) || 0) + 1;
	return relayRefused >= CODE_IMPORT_RELAY_REFUSALS
		? { relayRefused, stop: refused("IMPORT_SOURCE_REFUSED") }
		: { relayRefused, stop };
}

// The refs plan --------------------------------------------------------------------------------------------------------------

/** One ref of the look's proof repository, as `git for-each-ref --format=%(refname)%00%(objectname)%00%(objecttype)
 * %00%(*objecttype)%00%(creatordate:unix)` gives it, the name decoded as UTF-8 (a name that is not is the look's to
 * remove first: this plan deletes refs by their names). */
export interface CodeImportRefSeen {
	/** Its full name, under `refs/`. */
	readonly name: string;
	/** The object it names: a commit, or an annotated tag's own object. */
	readonly sha: string;
	readonly type: string;
	/** For a tag object, the type of what it points to; "" otherwise. */
	readonly peeledType: string;
	/** Seconds since 1970: a commit's committer date, a tag's tagger date. */
	readonly time: number;
}

/** Why refs were left out. */
export interface CodeImportLeftOut {
	/** A name git, restore's own test (`^refs/[^\s\0]+$`, JavaScript's `\s`) or the folder's path rule refuses. */
	readonly name: number;
	/** One name to the folder with a ref kept before it: a case clash, or a ref that is another's folder. */
	readonly clash: number;
	/** A tag whose target, or a head that, is no commit. */
	readonly notCommit: number;
	/** A head not changed in the last 90 days. */
	readonly older: number;
	/** Past the 500 tags or the 200 heads. */
	readonly over: number;
	/** Neither a head nor a tag. */
	readonly other: number;
}

export interface CodeImportRefsPlan {
	/** The default branch's commit: `refs/heads/main` and `refs/qorpera/kept-here` name it. */
	readonly mainSha: string;
	/** Every ref the repository keeps, in their names' byte order, and their fingerprint (`codeRefsSha256`): the
	 * restore-shaped bundle's. */
	readonly refs: readonly CodeAreaRef[];
	readonly refsSha256: string;
	/** `git update-ref --no-deref -z --stdin` on the proof repository: one transaction that deletes every ref not
	 * kept as it is, then one that creates the new ones, each name with its old value, so each refuses a ref that moved.
	 * Two, since git (2.53, files backend) refuses to create `refs/heads/main` while `refs/heads/main/x`, which the same
	 * transaction deletes, is still there. Empty when there is nothing to do. */
	readonly stdin: Buffer;
	readonly tags: { readonly seen: number; readonly kept: number };
	/** Heads other than the default branch. */
	readonly branches: { readonly seen: number; readonly kept: number };
	/** Every ref left out, and why. The default branch is not among them: it became main. */
	readonly leftOut: number;
	readonly leftOutBy: CodeImportLeftOut;
}

/** From the proof repository's refs to what the imported repository keeps (5.3 step 5, X11): `refs/heads/main` and
 * `refs/qorpera/kept-here` at the default branch; tags whose target is a commit, newest first, at most 500; other heads
 * changed in the last 90 days, newest first, at most 200, as `refs/qorpera/imported/heads/<name>`; every other ref
 * deleted, and counted with its reason (`CodeImportLeftOut`). Each kept name must be one git, restore's own name test
 * and the folder (at `code/<owner>/<name>/repo.git/<ref>`, `codeImportFolderPathValid`) take, and not one name to the
 * folder with a ref kept before it, by prove's own rule (`restore:372-387`). Ties go by name. The default branch must be
 * a head and a commit (`IMPORT_BRANCH_UNKNOWN`) with a name the import takes (`IMPORT_BRANCH_NAME`). */
export function codeImportRefsPlan(value: {
	repository: CloudCodingRepository;
	defaultBranch: string;
	refs: readonly CodeImportRefSeen[];
	now: number;
}): CodeImportRefsPlan {
	let repository: CloudCodingRepository;
	try {
		repository = parseCloudCodingRepository(value?.repository);
	} catch {
		throw new Error("INVALID_CODE_IMPORT");
	}
	const { defaultBranch, refs, now } = value;
	if (
		repository.host !== "qorpera" ||
		!whole(now) ||
		!Array.isArray(refs) ||
		!refs.every(
			(ref) =>
				typeof ref?.name === "string" &&
				ref.name.startsWith("refs/") &&
				wellFormed(ref.name) &&
				!/[\0\n]/.test(ref.name) &&
				typeof ref.sha === "string" &&
				SHA.test(ref.sha) &&
				typeof ref.type === "string" &&
				typeof ref.peeledType === "string" &&
				Number.isSafeInteger(ref.time),
		) ||
		new Set(refs.map((ref) => ref.name)).size !== refs.length
	)
		throw new Error("INVALID_CODE_IMPORT");
	if (!codeImportBranchValid(defaultBranch)) throw refused("IMPORT_BRANCH_NAME");
	const base = refs.find((ref) => ref.name === `refs/heads/${defaultBranch}`);
	if (!base || base.type !== "commit") throw refused("IMPORT_BRANCH_UNKNOWN");
	const place = `code/${repository.owner}/${repository.name}/repo.git/`;
	const named = (name: string) =>
		codeImportGitRefValid(name) && /^refs\/[^\s\0]+$/.test(name) && codeImportFolderPathValid(`${place}${name}`);
	// Each ref becomes a file of its name in the folder, where names that differ only by case are one name, and no
	// ref's own name may be another's folder.
	const spelled = new Map<string, string>();
	const prefixes = (name: string) => {
		const parts = name.split("/");
		return parts.map((_, index) => {
			const path = parts.slice(0, index + 1).join("/");
			return {
				key: path.split("/").map(folderKey).join("/"),
				as: `${index === parts.length - 1 ? "ref" : "folder"} ${path}`,
			};
		});
	};
	const clashes = (name: string) => prefixes(name).some(({ key, as }) => spelled.has(key) && spelled.get(key) !== as);
	const kept: CodeAreaRef[] = [];
	const keep = (name: string, sha: string) => {
		for (const { key, as } of prefixes(name)) if (!spelled.has(key)) spelled.set(key, as);
		kept.push({ name, sha });
	};
	keep("refs/heads/main", base.sha);
	keep(CODE_AREA_IN_QORPERA_REF, base.sha);
	const left = { name: 0, clash: 0, notCommit: 0, older: 0, over: 0, other: 0 };
	const newest = (a: CodeImportRefSeen, b: CodeImportRefSeen) => b.time - a.time || byBytes(a.name, b.name);
	const tags = refs.filter((ref) => ref.name.startsWith("refs/tags/")).sort(newest);
	const heads = refs.filter((ref) => ref.name.startsWith("refs/heads/") && ref !== base).sort(newest);
	left.other = refs.length - 1 - tags.length - heads.length;
	const since = Math.floor(now / 1000) - CODE_IMPORT_BRANCH_DAYS * 86_400;
	/** One ref considered for keeping under `name`, until `cap` of its kind are kept. */
	const consider = (
		ref: CodeImportRefSeen,
		name: string,
		eligible: boolean,
		recent: boolean,
		cap: number,
		count: number,
	) => {
		if (!eligible) left.notCommit += 1;
		else if (!recent) left.older += 1;
		else if (!named(name)) left.name += 1;
		else if (count >= cap) left.over += 1;
		else if (clashes(name)) left.clash += 1;
		else {
			keep(name, ref.sha);
			return 1;
		}
		return 0;
	};
	let keptTags = 0,
		keptHeads = 0;
	for (const tag of tags)
		keptTags += consider(
			tag,
			tag.name,
			tag.type === "commit" || (tag.type === "tag" && tag.peeledType === "commit"),
			true,
			CODE_IMPORT_TAGS,
			keptTags,
		);
	for (const head of heads)
		keptHeads += consider(
			head,
			`${CODE_IMPORT_IMPORTED_HEADS}${head.name.slice("refs/heads/".length)}`,
			head.type === "commit",
			head.time >= since,
			CODE_IMPORT_BRANCHES,
			keptHeads,
		);
	kept.sort((a, b) => byBytes(a.name, b.name));
	const finalSha = new Map(kept.map((ref) => [ref.name, ref.sha])),
		givenSha = new Map(refs.map((ref) => [ref.name, ref.sha]));
	const deletes = refs.filter((ref) => finalSha.get(ref.name) !== ref.sha),
		creates = kept.filter((ref) => givenSha.get(ref.name) !== ref.sha);
	const transaction = (lines: string[]) => (lines.length ? ["start", ...lines, "prepare", "commit"] : []);
	const commands = [
		...transaction(deletes.map((ref) => `delete ${ref.name}\0${ref.sha}`)),
		...transaction(creates.map((ref) => `create ${ref.name}\0${ref.sha}`)),
	];
	const leftOut = left.name + left.clash + left.notCommit + left.older + left.over + left.other;
	return {
		mainSha: base.sha,
		refs: kept,
		refsSha256: codeRefsSha256(kept),
		stdin: Buffer.from(commands.map((command) => `${command}\0`).join(""), "utf8"),
		tags: { seen: tags.length, kept: keptTags },
		branches: { seen: heads.length, kept: keptHeads },
		leftOut,
		leftOutBy: left,
	};
}

/** A file source's default branch (5.5), from the bundle's heads (`refs/heads/<name>` and their commits) and the
 * commit its `HEAD` line names (null when it has none): the branch the request named, the only head, `main`, `master`,
 * or the one head at HEAD's commit; else `IMPORT_BRANCH_UNKNOWN`. A name the import does not take: `IMPORT_BRANCH_NAME`. */
export function codeImportFileBranch(value: {
	branch: string | null;
	refs: readonly CodeBundleRef[];
	headSha: string | null;
}): string {
	const heads = (Array.isArray(value?.refs) ? value.refs : [])
		.filter((ref) => typeof ref?.name === "string" && ref.name.startsWith("refs/heads/"))
		.map((ref) => ({ branch: ref.name.slice("refs/heads/".length), sha: ref.sha }));
	const has = (branch: string) => heads.some((head) => head.branch === branch);
	let branch: string | undefined;
	if (value.branch !== null && value.branch !== undefined) branch = has(value.branch) ? value.branch : undefined;
	else if (heads.length === 1) branch = heads[0]?.branch;
	else if (has("main")) branch = "main";
	else if (has("master")) branch = "master";
	else {
		const atHead = heads.filter((head) => value.headSha !== null && head.sha === value.headSha);
		branch = atHead.length === 1 ? atHead[0]?.branch : undefined;
	}
	if (branch === undefined) throw refused("IMPORT_BRANCH_UNKNOWN");
	if (!codeImportBranchValid(branch)) throw refused("IMPORT_BRANCH_NAME");
	return branch;
}

/** A Git LFS pointer file: under 1 KiB, and it begins with the spec's version line. */
export function codeImportLfsPointer(content: Uint8Array): boolean {
	return (
		content.byteLength < 1024 &&
		Buffer.from(content.buffer, content.byteOffset, content.byteLength)
			.toString("latin1")
			.startsWith("version https://git-lfs.github.com/spec/")
	);
}

// The key scan ----------------------------------------------------------------------------------------------------------------

const ALL = SCANNED.map((kind) => `(${CODE_IMPORT_KEY_PATTERNS[kind]})`).join("|");
const RULES = SCANNED.map((kind) => `-e 's#^([0-9]+):(${CODE_IMPORT_KEY_PATTERNS[kind]})$#\\1 ${kind}#p'`).join(" ");

/** The key scan, one `/bin/sh -c` in the code host (dash, GNU grep and sed, uutils `head` and `timeout`), with its
 * arguments as positional parameters: `$1` the status file (new for each run), `$2` the list (one object id a line,
 * every one a blob, in the order of the sizes the executor maps by), `$3` the seconds it may take (600), then git's
 * whole argv for `cat-file --batch` on the proof repository. git's batch output goes through `grep -a -b -o`, which
 * prints each match as `<offset>:<match>`, and `sed -n`, whose one rule per kind prints `<offset> <kind>` for a match
 * of that kind and nothing for anything else: no match, and no byte of one, reaches stdout. At most 64 KiB of it.
 * Each of git (its `timeout`'s status: 124 or 137 once stopped), grep and sed appends `<name> <status>` to the status
 * file, which `codeImportScanAnswer` reads. */
export const CODE_IMPORT_SCAN = [
	"status=$1 list=$2 seconds=$3",
	"shift 3",
	"export LC_ALL=C",
	`{ timeout -k 10 "$seconds" "$@" <"$list"; echo "git $?" >>"$status"; } |`,
	`\t{ grep -a -b -o -E -e '${ALL}'; echo "grep $?" >>"$status"; } |`,
	`\t{ sed -n -E ${RULES}; echo "sed $?" >>"$status"; } |`,
	`\thead -c ${CODE_IMPORT_SCAN_OUTPUT_BYTES}`,
].join("\n");

export interface CodeImportScanHit {
	/** The match's first byte in git's batch output. */
	readonly offset: number;
	readonly kind: CodeImportScannedKind;
}

const SCAN_LINE = new RegExp(`^(0|[1-9][0-9]{0,12}) (${SCANNED.join("|")})$`);

/** The scan's ending, from its stdout and its status file's text (null when there was none): every hit, and `all`, true
 * only when git ended 0, grep 0 or 1, sed 0, each said once, and stdout stayed under its 64 KiB. At the bound the cut
 * last line is passed over. Any other line, and an unfinished last line under the bound, is no line of the scan's:
 * `IMPORT_SCAN_FAILED`, and nothing of it is said. */
export function codeImportScanAnswer(
	stdout: Uint8Array,
	status: string | null,
): { hits: CodeImportScanHit[]; all: boolean } {
	const fail = () => new CodeImportStop("failed", "IMPORT_SCAN_FAILED");
	if (!(stdout instanceof Uint8Array) || stdout.byteLength > CODE_IMPORT_SCAN_OUTPUT_BYTES) throw fail();
	const bounded = stdout.byteLength === CODE_IMPORT_SCAN_OUTPUT_BYTES;
	const lines = Buffer.from(stdout.buffer, stdout.byteOffset, stdout.byteLength).toString("latin1").split("\n");
	const last = lines.pop();
	if (last !== "" && !bounded) throw fail();
	const hits: CodeImportScanHit[] = [];
	for (const line of lines) {
		const hit = SCAN_LINE.exec(line);
		if (!hit) throw fail();
		hits.push({ offset: Number(hit[1]), kind: hit[2] as CodeImportScannedKind });
	}
	const said = new Map<string, number>();
	let readable = typeof status === "string";
	for (const line of (typeof status === "string" ? status : "").split("\n").filter(Boolean)) {
		const entry = /^(git|grep|sed) ([0-9]{1,3})$/.exec(line);
		if (!entry || said.has(entry[1] as string)) readable = false;
		else said.set(entry[1] as string, Number(entry[2]));
	}
	const all =
		readable &&
		!bounded &&
		said.size === 3 &&
		said.get("git") === 0 &&
		(said.get("grep") === 0 || said.get("grep") === 1) &&
		said.get("sed") === 0;
	return { hits, all };
}

/** Which blob of the scan's batch each hit is in. git's batch output is, for each object of the list in turn,
 * `<40 hex> blob <size>\n`, the content, `\n`: so the sizes (the list's `cat-file --batch-check` sizes, in its order)
 * give each blob's range. A hit is in a blob when its first byte is in the blob's content; one in a header or a
 * separator, or past the end, is `outside` (the patterns match none there). Each blob and kind once, by index. */
export function codeImportScanBlobs(
	sizes: ArrayLike<number>,
	hits: readonly CodeImportScanHit[],
): { blobs: { index: number; kind: CodeImportScannedKind }[]; outside: number } {
	const sorted = [...hits].sort((a, b) => a.offset - b.offset);
	const found = new Map<number, Set<CodeImportScannedKind>>();
	let outside = 0,
		index = 0,
		start = 0;
	const size = (at: number) => {
		const value = sizes[at];
		if (!whole(value)) throw new Error("INVALID_CODE_IMPORT");
		return value;
	};
	for (const hit of sorted) {
		// The record that holds the offset: each is its header, its content and one line feed.
		while (index < sizes.length) {
			const bytes = size(index),
				end = start + 47 + String(bytes).length + bytes + 1;
			if (hit.offset < end) break;
			start = end;
			index += 1;
		}
		if (index >= sizes.length) {
			outside += 1;
			continue;
		}
		const bytes = size(index),
			content = start + 47 + String(bytes).length;
		if (hit.offset < content || hit.offset >= content + bytes) {
			outside += 1;
			continue;
		}
		const kinds = found.get(index) ?? new Set<CodeImportScannedKind>();
		kinds.add(hit.kind);
		found.set(index, kinds);
	}
	const blobs = [...found]
		.sort(([a], [b]) => a - b)
		.flatMap(([at, kinds]) => SCANNED.filter((kind) => kinds.has(kind)).map((kind) => ({ index: at, kind })));
	return { blobs, outside };
}

// The look ----------------------------------------------------------------------------------------------------------------------

export const CODE_IMPORT_LOOK_SCHEMA = "qorpera.code-import-look/v1";

/** What the look found (4.4), as `qorpera_code_import_looked` keeps it in the request's `look` column: within 15 KiB of
 * JSON text and a jsonb bound of the same; every path and the default branch as `codeImportShown` gives them. */
export interface CodeImportLook {
	readonly schema: typeof CODE_IMPORT_LOOK_SCHEMA;
	/** The first bundle's bytes. */
	readonly bytes: number;
	readonly defaultBranch: string | null;
	readonly mainSha: string;
	/** `rev-list --count` of the default branch, and when its first and its last commit were made (UTC, to the second). */
	readonly commits: number;
	readonly firstAt: string | null;
	readonly lastAt: string | null;
	/** Distinct author addresses on the default branch in the last 30 days, but the platform's own and bots'. */
	readonly authors30d: number;
	readonly tags: { readonly seen: number; readonly kept: number };
	readonly branches: { readonly seen: number; readonly kept: number };
	/** Refs the fetch and the plan left out. */
	readonly leftOut: number;
	/** Main's blobs, and its entries (files and folders). */
	readonly files: number;
	readonly entries: number;
	/** Main's largest file. */
	readonly biggest: { readonly path: string | null; readonly bytes: number };
	readonly lfs: { readonly pointers: number };
	/** Gitlinks in main. */
	readonly submodules: number;
	/** What main's tree was refused for, with at most 10 of its paths and how many more there were. */
	readonly refused: {
		readonly code: string | null;
		readonly paths: readonly (string | null)[];
		readonly more: number;
	};
	readonly secrets: {
		/** Every hit (a blob and a kind, or a tracked `.env`), and at most 30 of them shown, those still in main first. */
		readonly found: number;
		readonly shown: readonly {
			readonly kind: CodeImportKeyKind;
			readonly path: string | null;
			readonly inMain: boolean;
		}[];
		/** The blobs and bytes scanned, and whether that was every blob the kept refs reach and every hit. */
		readonly scan: { readonly blobs: number; readonly bytes: number; readonly all: boolean };
	};
	/** `why`: the refusal that stops the import, null when it fits. */
	readonly fits: boolean;
	readonly why: string | null;
}

/** What part B's look gathers, before the look's rules: paths as git gave them (decoded as UTF-8), every refused path
 * and every hit. */
export interface CodeImportLookFacts {
	bytes: number;
	defaultBranch: string;
	mainSha: string;
	commits: number;
	firstAt: string | null;
	lastAt: string | null;
	authors30d: number;
	tags: { seen: number; kept: number };
	branches: { seen: number; kept: number };
	leftOut: number;
	files: number;
	entries: number;
	biggest: { path: string; bytes: number } | null;
	lfsPointers: number;
	submodules: number;
	refused: { code: string; paths: readonly string[] } | null;
	/** One a blob and kind (`codeImportScanBlobs`, with the blob's first path in `rev-list --objects` and whether main's
	 * tree holds it), and one a tracked `.env`. */
	secrets: readonly { kind: CodeImportKeyKind; path: string | null; inMain: boolean }[];
	scan: { blobs: number; bytes: number; all: boolean };
	why: string | null;
}

/** A jsonb value's size as PostgreSQL stores it, from above: 4 bytes of the datum's header; for each container 3 of
 * alignment, 4 of its header and 4 for each entry (an object's keys and values each have one), then its keys' bytes and
 * its values; a string's bytes; a number's 3 of alignment, 6 of numeric header and 2 for each four decimal digits; 0 for
 * true, false and null. A value that is no container is stored as an array of one. Only whole numbers are bounded.
 * Checked against `pg_column_size` on PostgreSQL 17 (node02, 12 Nov): never below it. */
export function codeImportJsonbBound(value: unknown): number {
	const size = (item: unknown): number => {
		if (item === null || typeof item === "boolean") return 0;
		if (typeof item === "string") return utf8(item);
		if (typeof item === "number") return 9 + 2 * Math.ceil(String(Math.abs(Math.trunc(item))).length / 4);
		if (Array.isArray(item)) return 7 + 4 * item.length + item.reduce((sum: number, entry) => sum + size(entry), 0);
		if (typeof item === "object")
			return Object.entries(item as Record<string, unknown>).reduce(
				(sum, [key, entry]) => sum + 8 + utf8(key) + size(entry),
				7,
			);
		throw new Error("INVALID_CODE_IMPORT");
	};
	return 4 + size(value !== null && typeof value === "object" ? value : [value]);
}
const lookFits = (look: CodeImportLook) =>
	utf8(JSON.stringify(look)) <= CODE_IMPORT_LOOK_BYTES && codeImportJsonbBound(look) <= CODE_IMPORT_LOOK_BYTES;

/** The look, from what part B found: every path and the default branch shown or null (`codeImportShown`), never cut;
 * the found keys deduplicated as shown, still in main first, then by kind and path, at most 30; at most 10 refused
 * paths (`more` counts the rest). Then whole shown keys are dropped from the last until it fits its bounds (`found`
 * still counts them). The result is one `codeImportLookOf` takes. */
export function codeImportLook(facts: CodeImportLookFacts): CodeImportLook {
	const refusedPaths = (facts.refused?.paths ?? []).map((path) => codeImportShown(path));
	const order = (kind: CodeImportKeyKind) => CODE_IMPORT_KEY_KINDS.indexOf(kind);
	const seen = new Set<string>();
	const shown = (facts.secrets ?? [])
		.map((hit) => ({ kind: hit.kind, path: codeImportShown(hit.path), inMain: hit.inMain === true }))
		.sort(
			(a, b) =>
				Number(b.inMain) - Number(a.inMain) ||
				order(a.kind) - order(b.kind) ||
				(a.path === null ? 1 : 0) - (b.path === null ? 1 : 0) ||
				byBytes(a.path ?? "", b.path ?? ""),
		)
		.filter((hit) => {
			const key = JSON.stringify(hit);
			if (seen.has(key)) return false;
			seen.add(key);
			return true;
		});
	const look = {
		schema: CODE_IMPORT_LOOK_SCHEMA,
		bytes: facts.bytes,
		defaultBranch: codeImportBranchValid(facts.defaultBranch) ? facts.defaultBranch : null,
		mainSha: facts.mainSha,
		commits: facts.commits,
		firstAt: facts.firstAt,
		lastAt: facts.lastAt,
		authors30d: facts.authors30d,
		tags: { seen: facts.tags?.seen, kept: facts.tags?.kept },
		branches: { seen: facts.branches?.seen, kept: facts.branches?.kept },
		leftOut: facts.leftOut,
		files: facts.files,
		entries: facts.entries,
		biggest: { path: codeImportShown(facts.biggest?.path), bytes: facts.biggest?.bytes ?? 0 },
		lfs: { pointers: facts.lfsPointers },
		submodules: facts.submodules,
		refused: {
			code: facts.refused?.code ?? null,
			paths: refusedPaths.slice(0, CODE_IMPORT_LOOK_PATHS),
			more: Math.max(0, refusedPaths.length - CODE_IMPORT_LOOK_PATHS),
		},
		secrets: {
			found: (facts.secrets ?? []).length,
			shown: shown.slice(0, CODE_IMPORT_LOOK_SHOWN),
			scan: { blobs: facts.scan?.blobs, bytes: facts.scan?.bytes, all: facts.scan?.all },
		},
		fits: facts.why === null,
		why: facts.why,
	} as CodeImportLook & {
		refused: { paths: (string | null)[]; more: number };
		secrets: { shown: CodeImportLook["secrets"]["shown"][number][] };
	};
	// Without the shown keys a look always fits: ten refused paths, the largest file's and the branch are at most 200
	// bytes each, at most 400 as JSON (a path with a control character is never shown).
	while (!lookFits(look)) {
		if (!look.secrets.shown.length) throw new Error("INVALID_CODE_IMPORT_LOOK");
		look.secrets.shown.pop();
	}
	return codeImportLookOf(look);
}

/** A record with exactly these keys (`optional` may be missing), else `error`: the shared wire check, with this
 * module's own error in the place of its message. */
function closed<R extends string, O extends string = never>(
	value: unknown,
	required: readonly R[],
	optional: readonly O[],
	error: string,
): Record<R, unknown> & Partial<Record<O, unknown>> {
	try {
		return parseClosedRecord(value, error, required, optional) as Record<R, unknown> & Partial<Record<O, unknown>>;
	} catch {
		throw new Error(error);
	}
}

const time = (value: unknown) =>
	value === null || (typeof value === "string" && ISO.test(value) && Number.isFinite(Date.parse(value)));
const shownOrNull = (value: unknown) =>
	value === null || (typeof value === "string" && codeImportShown(value) === value);

/** A look, read back as the kernel keeps it (the claim's `looked`, and a look made here): exactly its keys, each of
 * its kind and within its bounds, every path and the default branch shown or null, and within its bounds as a whole.
 * Anything else: `INVALID_CODE_IMPORT_LOOK`. */
export function codeImportLookOf(value: unknown): CodeImportLook {
	const fail = "INVALID_CODE_IMPORT_LOOK";
	const look = closed(
		value,
		[
			"schema",
			"bytes",
			"defaultBranch",
			"mainSha",
			"commits",
			"firstAt",
			"lastAt",
			"authors30d",
			"tags",
			"branches",
			"leftOut",
			"files",
			"entries",
			"biggest",
			"lfs",
			"submodules",
			"refused",
			"secrets",
			"fits",
			"why",
		],
		[],
		fail,
	);
	const pair = (item: unknown, cap: number) => {
		const { seen, kept } = closed(item, ["seen", "kept"], [], fail);
		return whole(seen) && whole(kept) && kept <= seen && kept <= cap;
	};
	const biggest = closed(look.biggest, ["path", "bytes"], [], fail),
		lfs = closed(look.lfs, ["pointers"], [], fail),
		turnedDown = closed(look.refused, ["code", "paths", "more"], [], fail),
		secrets = closed(look.secrets, ["found", "shown", "scan"], [], fail),
		scan = closed(secrets.scan, ["blobs", "bytes", "all"], [], fail);
	const shown = secrets.shown,
		paths = turnedDown.paths;
	if (
		look.schema !== CODE_IMPORT_LOOK_SCHEMA ||
		!whole(look.bytes, 1) ||
		!shownOrNull(look.defaultBranch) ||
		(look.defaultBranch !== null && !codeImportBranchValid(look.defaultBranch as string)) ||
		typeof look.mainSha !== "string" ||
		!SHA.test(look.mainSha) ||
		!whole(look.commits, 1) ||
		!time(look.firstAt) ||
		!time(look.lastAt) ||
		!whole(look.authors30d) ||
		!pair(look.tags, CODE_IMPORT_TAGS) ||
		!pair(look.branches, CODE_IMPORT_BRANCHES) ||
		!whole(look.leftOut) ||
		!whole(look.files) ||
		!whole(look.entries) ||
		!shownOrNull(biggest.path) ||
		!whole(biggest.bytes) ||
		!whole(lfs.pointers) ||
		!whole(look.submodules) ||
		!(
			turnedDown.code === null ||
			(typeof turnedDown.code === "string" && CODE_IMPORT_REFUSED_CODE.test(turnedDown.code))
		) ||
		!Array.isArray(paths) ||
		paths.length > CODE_IMPORT_LOOK_PATHS ||
		!paths.every(shownOrNull) ||
		!whole(turnedDown.more) ||
		(turnedDown.code === null && (paths.length > 0 || turnedDown.more > 0)) ||
		!whole(secrets.found) ||
		!Array.isArray(shown) ||
		shown.length > CODE_IMPORT_LOOK_SHOWN ||
		shown.length > secrets.found ||
		!shown.every((hit) => {
			const { kind, path, inMain } = closed(hit, ["kind", "path", "inMain"], [], fail);
			return (
				(CODE_IMPORT_KEY_KINDS as readonly unknown[]).includes(kind) &&
				shownOrNull(path) &&
				typeof inMain === "boolean"
			);
		}) ||
		!whole(scan.blobs) ||
		!whole(scan.bytes) ||
		typeof scan.all !== "boolean" ||
		!(look.why === null || (typeof look.why === "string" && CODE_IMPORT_REFUSED_CODE.test(look.why))) ||
		look.fits !== (look.why === null) ||
		(turnedDown.code !== null && look.why === null)
	)
		throw new Error(fail);
	const parsed = value as CodeImportLook;
	if (!lookFits(parsed)) throw new Error(fail);
	return parsed;
}

/** `authors30d`: distinct addresses, of any case, but the platform's own (`code@qorpera.com`, a session's
 * `<worker>@coding.qorpera.com`) and bots' (`*[bot]@*`). */
export function codeImportAuthors(emails: Iterable<string>): number {
	const seen = new Set<string>();
	for (const email of emails) {
		const address = String(email).trim().toLowerCase();
		if (
			!address ||
			address === "code@qorpera.com" ||
			address.endsWith("@coding.qorpera.com") ||
			address.includes("[bot]@")
		)
			continue;
		seen.add(address);
	}
	return seen.size;
}

/** A commit's time (seconds since 1970) as the look says it, `YYYY-MM-DDTHH:MM:SSZ`; null outside the years 1 to 9999. */
export function codeImportTime(seconds: number): string | null {
	if (!Number.isSafeInteger(seconds) || seconds < -62_135_596_800 || seconds > 253_402_300_799) return null;
	return `${new Date(seconds * 1000).toISOString().slice(0, 19)}Z`;
}

// The request: its input, progress and outcome, and the record ----------------------------------------------------------

/** Where the code comes from, as the asker named it: a GitHub repository `Owner/Name` (as GitHub spells it), or a file
 * source's path; with the branch to take as the default, when one was named. */
export type CodeImportFrom =
	| { readonly github: string; readonly branch?: string }
	| { readonly file: string; readonly branch?: string };

/** A request's input, as the kernel wrote it when the import was asked (4.4): `via` is fixed then (`connection` when the
 * asker may use the company's GitHub connection, else `public`; `file` for a file); `look` asks for the look alone;
 * `maximumBytes` is the kernel's at the time; `fileSha256` is the file source's as the request saw it (S27), present
 * exactly for a file. */
export interface CodeImportInput {
	readonly from: CodeImportFrom;
	readonly via: "connection" | "public" | "file";
	readonly look: boolean;
	readonly maximumBytes: number;
	readonly fileSha256: string | null;
}

/** A GitHub repository's `Owner/Name`, split, by GitHub's own rule (`parseCloudCodingRepository`, host github.com). */
export function codeImportGitHubOf(value: string): { owner: string; name: string } {
	const [owner, name, more] = typeof value === "string" ? value.split("/") : [];
	if (more !== undefined) throw new Error("INVALID_CODE_IMPORT_INPUT");
	try {
		const repository = parseCloudCodingRepository({ host: "github.com", owner, name, baseBranch: "main" });
		return { owner: repository.owner, name: repository.name };
	} catch {
		throw new Error("INVALID_CODE_IMPORT_INPUT");
	}
}

export function codeImportInputOf(value: unknown): CodeImportInput {
	const fail = "INVALID_CODE_IMPORT_INPUT";
	const input = closed(value, ["from", "via", "look", "maximumBytes"], ["fileSha256"], fail);
	const from = closed(input.from, [], ["github", "file", "branch"], fail);
	const { via, look, maximumBytes, fileSha256 } = input;
	const branch = from.branch;
	// A branch that looks like a key is taken here and refused by the fetch or the read (`IMPORT_BRANCH_NAME`), in words.
	if (
		(branch !== undefined &&
			(typeof branch !== "string" ||
				utf8(branch) > CODE_IMPORT_BRANCH_BYTES ||
				!codeImportHeaderRefValid(`refs/heads/${branch}`))) ||
		typeof look !== "boolean" ||
		!whole(maximumBytes, 1) ||
		maximumBytes > CODE_IMPORT_MAXIMUM_BYTES_LIMIT
	)
		throw new Error(fail);
	const branchKey = branch === undefined ? {} : { branch };
	if (from.github !== undefined && from.file === undefined) {
		if (typeof from.github !== "string" || (via !== "connection" && via !== "public") || fileSha256 !== undefined)
			throw new Error(fail);
		codeImportGitHubOf(from.github);
		return { from: { github: from.github, ...branchKey }, via, look, maximumBytes, fileSha256: null };
	}
	if (
		from.file === undefined ||
		from.github !== undefined ||
		typeof from.file !== "string" ||
		!codeImportIncomingPathValid(from.file) ||
		via !== "file" ||
		typeof fileSha256 !== "string" ||
		!SHA256_HEX_PATTERN.test(fileSha256)
	)
		throw new Error(fail);
	return { from: { file: from.file, ...branchKey }, via, look, maximumBytes, fileSha256 };
}

/** The steps of an import, in order, as the progress names the one under way. The first step that names `look` is the
 * one the kernel answers `busy` while the company is not quiet. */
export const CODE_IMPORT_STEPS = ["fetch", "read", "look", "close", "set-aside", "build", "open", "tidy"] as const;
export type CodeImportStep = (typeof CODE_IMPORT_STEPS)[number];

/** The first bundle, as stored: its name, bytes and their SHA-256, the default branch and its commit, how many refs its
 * header names and how many the fetch left out. */
export interface CodeImportRaw {
	readonly name: string;
	readonly sha256: string;
	readonly bytes: number;
	readonly defaultBranch: string;
	readonly mainSha: string;
	readonly refs: number;
	readonly leftOut: number;
}
/** The restore-shaped bundle, as stored: what restore's jobs take (`CodeRestoreBundle`), and how many refs it has. */
export interface CodeImportKept {
	readonly name: string;
	readonly sha256: string;
	readonly bytes: number;
	readonly refsSha256: string;
	readonly mainSha: string;
	readonly refs: number;
}
/** What the import's record wrote, as the kernel keeps it in the progress: change 1, from this bundle, at this main. */
export interface CodeImportRecorded {
	readonly change: 1;
	readonly bundle: string;
	readonly mainSha: string;
}
/** How far an import got (`progress`, at most 3 KiB). The executor writes every key but the last two, which are the
 * kernel's and which a step call never brings back: `recorded` (the record was made) and `waiting` (why the claim or
 * the look's step waits). `setAside`: a job saw the place emptied, and where its content went (null: there was none).
 * `relayRefused`: the relay's own 403s in a row. */
export interface CodeImportProgress {
	readonly step?: CodeImportStep;
	readonly raw?: CodeImportRaw;
	readonly kept?: CodeImportKept;
	readonly at?: string;
	readonly setAside?: string | null;
	readonly built?: true;
	readonly relayRefused?: number;
	readonly recorded?: CodeImportRecorded;
	readonly waiting?: string;
}

const PROGRESS_OWN = ["step", "raw", "kept", "at", "setAside", "built", "relayRefused"] as const;
const SET_ASIDE = /^code\/_set-aside\/./;

function rawOf(value: unknown, fail: string): CodeImportRaw {
	const raw = closed(value, ["name", "sha256", "bytes", "defaultBranch", "mainSha", "refs", "leftOut"], [], fail);
	if (
		typeof raw.name !== "string" ||
		!CODE_IMPORT_BUNDLE_NAME.test(raw.name) ||
		typeof raw.sha256 !== "string" ||
		!SHA256_HEX_PATTERN.test(raw.sha256) ||
		!whole(raw.bytes, 1) ||
		typeof raw.defaultBranch !== "string" ||
		!codeImportBranchValid(raw.defaultBranch) ||
		typeof raw.mainSha !== "string" ||
		!SHA.test(raw.mainSha) ||
		!raw.name.endsWith(`-${raw.mainSha.slice(0, 12)}`) ||
		!whole(raw.refs, 1) ||
		!whole(raw.leftOut)
	)
		throw new Error(fail);
	return {
		name: raw.name,
		sha256: raw.sha256,
		bytes: raw.bytes,
		defaultBranch: raw.defaultBranch,
		mainSha: raw.mainSha,
		refs: raw.refs,
		leftOut: raw.leftOut,
	};
}

function keptOf(value: unknown, fail: string): CodeImportKept {
	const kept = closed(value, ["name", "sha256", "bytes", "refsSha256", "mainSha", "refs"], [], fail);
	if (
		typeof kept.name !== "string" ||
		!CODE_BUNDLE_NAME.test(kept.name) ||
		typeof kept.sha256 !== "string" ||
		!SHA256_HEX_PATTERN.test(kept.sha256) ||
		!whole(kept.bytes, 1) ||
		typeof kept.refsSha256 !== "string" ||
		!SHA256_HEX_PATTERN.test(kept.refsSha256) ||
		typeof kept.mainSha !== "string" ||
		!SHA.test(kept.mainSha) ||
		!kept.name.endsWith(`-${kept.mainSha.slice(0, 12)}`) ||
		!whole(kept.refs, 2)
	)
		throw new Error(fail);
	return {
		name: kept.name,
		sha256: kept.sha256,
		bytes: kept.bytes,
		refsSha256: kept.refsSha256,
		mainSha: kept.mainSha,
		refs: kept.refs,
	};
}

/** A request's progress as the kernel hands it out (null for none): its keys, each of its kind. Anything else:
 * `INVALID_CODE_IMPORT_PROGRESS`. */
export function codeImportProgressOf(value: unknown): CodeImportProgress {
	const fail = "INVALID_CODE_IMPORT_PROGRESS";
	if (value === null || value === undefined) return {};
	const input = closed(value, [], [...PROGRESS_OWN, "recorded", "waiting"], fail);
	const progress: Record<string, unknown> = {};
	if (input.step !== undefined) {
		if (!(CODE_IMPORT_STEPS as readonly unknown[]).includes(input.step)) throw new Error(fail);
		progress.step = input.step;
	}
	if (input.raw !== undefined) progress.raw = rawOf(input.raw, fail);
	if (input.kept !== undefined) progress.kept = keptOf(input.kept, fail);
	if (input.at !== undefined) {
		if (typeof input.at !== "string" || !AT.test(input.at)) throw new Error(fail);
		progress.at = input.at;
	}
	if (input.setAside !== undefined) {
		const { setAside } = input;
		if (setAside !== null && (typeof setAside !== "string" || !SET_ASIDE.test(setAside) || utf8(setAside) > 1024))
			throw new Error(fail);
		progress.setAside = setAside;
	}
	if (input.built !== undefined) {
		if (input.built !== true) throw new Error(fail);
		progress.built = true;
	}
	if (input.relayRefused !== undefined) {
		if (!whole(input.relayRefused) || input.relayRefused > CODE_IMPORT_RELAY_REFUSALS) throw new Error(fail);
		progress.relayRefused = input.relayRefused;
	}
	if (input.recorded !== undefined) {
		const recorded = closed(input.recorded, ["change", "bundle", "mainSha"], [], fail);
		if (
			recorded.change !== 1 ||
			typeof recorded.bundle !== "string" ||
			!CODE_BUNDLE_NAME.test(recorded.bundle) ||
			typeof recorded.mainSha !== "string" ||
			!SHA.test(recorded.mainSha)
		)
			throw new Error(fail);
		progress.recorded = { change: 1, bundle: recorded.bundle, mainSha: recorded.mainSha };
	}
	if (input.waiting !== undefined) {
		if (typeof input.waiting !== "string" || !/^[A-Z][A-Z0-9_]{1,60}$/.test(input.waiting)) throw new Error(fail);
		progress.waiting = input.waiting;
	}
	return progress as CodeImportProgress;
}

/** The progress a step call sends (`p_progress`): the executor's own keys, checked, in a fixed order, within 2,560
 * bytes of JSON text and of jsonb (the kernel adds its words within its 3 KiB). The kernel's own are never sent. */
export function codeImportProgressValue(progress: CodeImportProgress): Record<string, unknown> {
	const own: Record<string, unknown> = {};
	for (const key of PROGRESS_OWN) if (progress?.[key] !== undefined) own[key] = progress[key];
	const checked = codeImportProgressOf(own) as Record<string, unknown>;
	const sent: Record<string, unknown> = {};
	for (const key of PROGRESS_OWN) if (checked[key] !== undefined) sent[key] = checked[key];
	if (
		utf8(JSON.stringify(sent)) > CODE_IMPORT_PROGRESS_SENT_BYTES ||
		codeImportJsonbBound(sent) > CODE_IMPORT_PROGRESS_SENT_BYTES
	)
		throw new Error("INVALID_CODE_IMPORT_PROGRESS");
	return sent;
}

/** An import as `qorpera_code_requests_claim` hands it out: its lease, its place (a repository kept in Qorpera, by
 * the asker's owner and name), and its input, progress and look (`looked`: null until the look was written). */
export interface CodeImportRequest {
	readonly requestId: string;
	readonly token: string;
	readonly leaseUntil: string;
	readonly companyId: string;
	readonly environmentId: string;
	readonly owner: string;
	readonly name: string;
	readonly kind: "import";
	readonly input: CodeImportInput;
	readonly progress: CodeImportProgress;
	readonly looked: CodeImportLook | null;
}

/** A claimed import, checked field by field (part Q's `requestOf` hands it here for kind `import`): exactly its keys.
 * Anything else: `INVALID_CODE_IMPORT_REQUEST` (or its input's, progress's or look's own code). */
export function codeImportRequestOf(value: unknown): CodeImportRequest {
	const fail = "INVALID_CODE_IMPORT_REQUEST";
	const entry = closed(
		value,
		[
			"requestId",
			"token",
			"leaseUntil",
			"companyId",
			"environmentId",
			"owner",
			"name",
			"kind",
			"input",
			"progress",
			"looked",
		],
		[],
		fail,
	);
	const { requestId, token, leaseUntil, companyId, environmentId, owner, name } = entry;
	if (
		![requestId, token, companyId, environmentId].every((id) => isUuid(id)) ||
		entry.kind !== "import" ||
		typeof leaseUntil !== "string" ||
		!Number.isFinite(Date.parse(leaseUntil))
	)
		throw new Error(fail);
	try {
		parseCloudCodingRepository({ host: "qorpera", owner, name, baseBranch: "main" });
	} catch {
		throw new Error(fail);
	}
	return {
		requestId: requestId as string,
		token: token as string,
		leaseUntil,
		companyId: companyId as string,
		environmentId: environmentId as string,
		owner: owner as string,
		name: name as string,
		kind: "import",
		input: codeImportInputOf(entry.input),
		progress: codeImportProgressOf(entry.progress),
		looked: entry.looked === null ? null : codeImportLookOf(entry.looked),
	};
}

/** How an import ended, as `qorpera_code_request_finish` takes it (4.4). `done/imported` only once the progress has
 * `recorded`; `done/looked` only for a look alone; once recorded, only `done/imported` or `busy` (S15). */
export type CodeImportOutcome = { readonly schema: "qorpera.code-request-outcome/v1" } & (
	| {
			readonly state: "done";
			readonly result: "imported";
			readonly change: 1;
			readonly mainSha: string;
			/** The restore-shaped bundle, and the first one. */
			readonly bundle: string;
			readonly rawBundle: string;
			/** Where a GitHub copy that stood at the place went, or null. */
			readonly setAside: string | null;
	  }
	| { readonly state: "done"; readonly result: "looked" }
	| { readonly state: "refused"; readonly code: string }
	| { readonly state: "failed"; readonly code: string }
	| { readonly state: "busy" }
);

/** An outcome checked as the kernel will take it: exactly its keys, each of its kind, a refusal's code by
 * `CODE_IMPORT_REFUSED_CODE` and a failure's by `CODE_IMPORT_FAILED_CODE`. Anything else:
 * `INVALID_CODE_IMPORT_OUTCOME`. */
export function codeImportOutcomeOf(value: unknown): CodeImportOutcome {
	const fail = "INVALID_CODE_IMPORT_OUTCOME";
	const schema = "qorpera.code-request-outcome/v1";
	const head = closed(
		value,
		["schema", "state"],
		["result", "change", "mainSha", "bundle", "rawBundle", "setAside", "code"],
		fail,
	);
	if (head.schema !== schema) throw new Error(fail);
	if (head.state === "busy") {
		closed(value, ["schema", "state"], [], fail);
		return { schema, state: "busy" };
	}
	if (head.state === "refused" || head.state === "failed") {
		const { code } = closed(value, ["schema", "state", "code"], [], fail);
		const pattern = head.state === "refused" ? CODE_IMPORT_REFUSED_CODE : CODE_IMPORT_FAILED_CODE;
		if (typeof code !== "string" || !pattern.test(code)) throw new Error(fail);
		return { schema, state: head.state, code };
	}
	if (head.state !== "done") throw new Error(fail);
	if (head.result === "looked") {
		closed(value, ["schema", "state", "result"], [], fail);
		return { schema, state: "done", result: "looked" };
	}
	const done = closed(
		value,
		["schema", "state", "result", "change", "mainSha", "bundle", "rawBundle", "setAside"],
		[],
		fail,
	);
	if (
		done.result !== "imported" ||
		done.change !== 1 ||
		typeof done.mainSha !== "string" ||
		!SHA.test(done.mainSha) ||
		typeof done.bundle !== "string" ||
		!CODE_BUNDLE_NAME.test(done.bundle) ||
		typeof done.rawBundle !== "string" ||
		!CODE_IMPORT_BUNDLE_NAME.test(done.rawBundle) ||
		!(
			done.setAside === null ||
			(typeof done.setAside === "string" && SET_ASIDE.test(done.setAside) && utf8(done.setAside) <= 1024)
		)
	)
		throw new Error(fail);
	return {
		schema,
		state: "done",
		result: "imported",
		change: 1,
		mainSha: done.mainSha,
		bundle: done.bundle,
		rawBundle: done.rawBundle,
		setAside: done.setAside as string | null,
	};
}

export const CODE_IMPORT_RECORD_SCHEMA = "qorpera.code-import-record/v1";
/** The record's `p_imported`, exactly (4.2): the restore-shaped bundle, main as built, and main's files. */
export interface CodeImportRecord {
	readonly schema: typeof CODE_IMPORT_RECORD_SCHEMA;
	readonly bundle: string;
	readonly mainSha: string;
	readonly files: number;
}
export function codeImportRecord(value: { bundle: string; mainSha: string; files: number }): CodeImportRecord {
	const { bundle, mainSha, files } = closed(value, ["bundle", "mainSha", "files"], [], "INVALID_CODE_IMPORT_RECORD");
	if (
		typeof bundle !== "string" ||
		!CODE_BUNDLE_NAME.test(bundle) ||
		typeof mainSha !== "string" ||
		!SHA.test(mainSha) ||
		!bundle.endsWith(`-${mainSha.slice(0, 12)}`) ||
		!whole(files)
	)
		throw new Error("INVALID_CODE_IMPORT_RECORD");
	return { schema: CODE_IMPORT_RECORD_SCHEMA, bundle, mainSha, files };
}

/** The import's own calls (part Q adds them to `CODE_REQUEST_RPCS`, with `qorpera_code_restore_strand`). */
export const CODE_IMPORT_RPCS = ["qorpera_code_import_looked", "qorpera_code_import_record"] as const;

/** `qorpera_code_import_looked`'s answer: `recorded` or `lost`; anything else throws `CODE_IMPORT_LOOKED_UNCONFIRMED`. */
export function codeImportLookedAnswer(value: unknown): "recorded" | "lost" {
	const answer = value as Record<string, unknown> | null;
	if (
		answer &&
		typeof answer === "object" &&
		!Array.isArray(answer) &&
		Object.keys(answer).sort().join() === "schema,state" &&
		answer.schema === "qorpera.code-import-looked/v1" &&
		(answer.state === "recorded" || answer.state === "lost")
	)
		return answer.state;
	throw new Error("CODE_IMPORT_LOOKED_UNCONFIRMED");
}

/** `qorpera_code_import_record`'s answer: `recorded` (change 1) or `lost`; anything else throws
 * `CODE_IMPORT_RECORD_UNCONFIRMED`. */
export function codeImportRecordedAnswer(value: unknown): { state: "recorded"; change: 1 } | { state: "lost" } {
	const answer = value as Record<string, unknown> | null;
	const keys = answer && typeof answer === "object" && !Array.isArray(answer) ? Object.keys(answer).sort().join() : "";
	if (answer && answer.schema === "qorpera.code-import-recorded/v1") {
		if (keys === "change,schema,state" && answer.state === "recorded" && answer.change === 1)
			return { state: "recorded", change: 1 };
		if (keys === "schema,state" && answer.state === "lost") return { state: "lost" };
	}
	throw new Error("CODE_IMPORT_RECORD_UNCONFIRMED");
}

// The other parts' interfaces: types only -----------------------------------------------------------------------------------

/** Where the first bundle's pieces go as the fetch or the read job writes them, in order, each awaited: the import
 * writer of the store (`CodeImportBundleWriter`), as the fetch uses it. A piece that fails ends the writer. The fetch
 * and the read job never commit or abort it: the run that began it does both (part C3). */
export interface CodeImportSink {
	write(chunk: Uint8Array, signal?: AbortSignal): Promise<void>;
}

/** The first bundle as the fetch or the read job made it: its bytes' SHA-256 and size as written (taken as written, so
 * the store's commit can check them), the default branch and its commit, the refs its header names (a file's: every
 * ref it names) and how many refs were left out of it. */
export interface CodeImportFetched {
	readonly sha256: string;
	readonly bytes: number;
	readonly defaultBranch: string;
	readonly mainSha: string;
	readonly refs: readonly CodeBundleRef[];
	readonly leftOut: number;
}

/** Part C2's `fetchGitHubImport` (`code-import-fetch.ts`): the advertisement, the ref list (once more after a `not our
 * ref`, X10), the wants, the fetch, the header and the pack written in 1 MiB pieces; within 60 minutes in all and 2
 * idle. It stops with a `CodeImportStop`, or with the store's own error of a piece. */
export interface CodeImportFetchOptions {
	readonly transport: CodeImportTransport;
	readonly repository: { readonly owner: string; readonly name: string };
	/** `from.branch`, when the request named one. */
	readonly branch: string | null;
	readonly maximumBytes: number;
	readonly signal: AbortSignal;
}
export type CodeImportFetch = (options: CodeImportFetchOptions, writer: CodeImportSink) => Promise<CodeImportFetched>;

/** What the store's commit of a first bundle takes (part C2's `qorpera.code-import-bundle/v1`). */
export interface CodeImportBundleFacts {
	readonly environmentId: string;
	/** When the bundle was made, ISO text in UTC: its name starts with it. */
	readonly createdAt: string;
	readonly from: CodeImportFrom;
	readonly defaultBranch: string;
	readonly mainSha: string;
	readonly refs: readonly CodeBundleRef[];
	readonly leftOut: number;
	readonly sha256: string;
	readonly bytes: number;
	readonly executorOwner: string;
}
/** A first bundle's manifest: not verified (the look proves it), never pruned, kept with the repository. */
export interface CodeImportBundleManifest {
	readonly schema: typeof CODE_IMPORT_BUNDLE_SCHEMA;
	readonly companyId: string;
	readonly environmentId: string;
	readonly repository: { readonly host: "qorpera"; readonly owner: string; readonly name: string };
	readonly createdAt: string;
	readonly from: CodeImportFrom;
	readonly defaultBranch: string;
	readonly mainSha: string;
	/** The first 2,000 refs in the order they were given (the fetch's header: the default branch first), of
	 * `refsCount`. */
	readonly refs: readonly CodeBundleRef[];
	readonly refsCount: number;
	readonly leftOut: number;
	readonly sha256: string;
	readonly bytes: number;
	readonly executorOwner: string;
}
export interface CodeImportBundleWriter extends CodeImportSink {
	/** Stores what was written as `<name>.bundle` (`codeImportBundleName`) with its manifest, only when its SHA-256 and
	 * size are the facts' own. */
	commit(name: string, facts: CodeImportBundleFacts, signal?: AbortSignal): Promise<CodeImportBundleManifest>;
	/** Removes what was written; nothing after a commit. */
	abort(): Promise<void>;
}
/** What the run needs of the store for the first bundle (part C2 extends `CodeBundleStore` so it is one of these); the
 * restore-shaped bundle is an ordinary stored bundle (`begin` without `kind`, `read`). */
export interface CodeImportBundleStore {
	begin(
		target: CodeBundleTarget,
		options: { kind: "import"; expectedBytes?: number; maximumBytes?: number },
		signal?: AbortSignal,
	): Promise<CodeImportBundleWriter>;
	/** A first bundle's manifest and bytes, as `read` gives an ordinary one. */
	readImport(
		target: CodeBundleTarget,
		name: string,
		signal?: AbortSignal,
	): Promise<{ manifest: CodeImportBundleManifest; pieces: AsyncIterable<Uint8Array> }>;
	/** Every name of either kind in the repository's store folder that has a `.bundle` or a `.json` there, whole or not
	 * (a half-written leftover too, so a place's folder can be cleared), sorted: the dated names first, then the
	 * `import-*` ones. `readImport` and the store's `find` say whether one is whole. */
	names(target: CodeBundleTarget, signal?: AbortSignal): Promise<string[]>;
	/** Removes one name of either kind, its manifest first, then its bundle; true when either file was there, false when
	 * neither was. */
	remove(target: CodeBundleTarget, name: string, signal?: AbortSignal): Promise<boolean>;
}

/** Part B's `readIncomingCodeBundle`: the file source (`path`, `code/_incoming/<folder>/<name>.bundle`) copied to the
 * scratch, refused unless it is the request's file (`sha256`, `IMPORT_FILE_CHANGED`) of at most `maximumBytes`, a whole
 * bundle (`IMPORT_FILE_NOT_WHOLE`); its default branch chosen (`codeImportFileBranch`), and its bytes read out into
 * `sink` in 16 MiB pieces. The job's repository is the place. */
export interface CodeImportReadValue {
	readonly repository: CloudCodingRepository;
	readonly path: string;
	readonly sha256: string;
	readonly branch: string | null;
	readonly maximumBytes: number;
}
export type CodeImportReadJob = (
	job: CodeHostJob,
	value: CodeImportReadValue,
	sink: CodeImportSink,
) => Promise<CodeImportFetched>;

/** Part B's `lookCodeImport`, one job: the scratch cleared of other jobs' leftovers; the first bundle (`source`, its
 * bytes as stored) in, checked against `raw`; verify, the strict fetch, the one fsck; main's names, entries, LFS and
 * gitlinks; the facts and the key scan, as the look (`codeImportLook`). It answers `looked` for a look alone, and for
 * one whose `why` stops it (nothing else is made); otherwise the refs plan (`codeImportRefsPlan`) is applied, the
 * restore-shaped bundle made and proven (as care's), and read out into `sink`: `kept`, with what its commit needs.
 * Refusals before the facts are the code host's (`CodeHostRefusal` with an import code). */
export interface CodeImportLookValue {
	readonly repository: CloudCodingRepository;
	readonly raw: CodeImportRaw;
	readonly look: boolean;
	/** Milliseconds since 1970: the 90 days of the plan and the 30 of `authors30d` end then. */
	readonly now: number;
}
export type CodeImportLooked =
	| { readonly state: "looked"; readonly look: CodeImportLook }
	| {
			readonly state: "kept";
			readonly look: CodeImportLook;
			readonly bundle: {
				readonly sha256: string;
				readonly bytes: number;
				readonly gitVersion: string;
				readonly refs: readonly CodeAreaRef[];
				readonly refsSha256: string;
				readonly mainSha: string;
			};
	  };
export type CodeImportLookJob = (
	job: CodeHostJob,
	value: CodeImportLookValue,
	source: AsyncIterable<Uint8Array>,
	sink: CodeBundleSink,
	options?: { fsckMs?: number; scanSeconds?: number; chunkBytes?: number },
) => Promise<CodeImportLooked>;

/** Part B's `removeIncomingCodeFile` (the run's `tidy`): the file source removed, and its folder when that leaves it
 * empty; whether the file was there. */
export interface CodeImportRemoveValue {
	readonly repository: CloudCodingRepository;
	readonly path: string;
}
export type CodeImportRemoveJob = (job: CodeHostJob, value: CodeImportRemoveValue) => Promise<{ removed: boolean }>;

/** The code host jobs the run takes from part B, beside restore's own. */
export interface CodeImportJobs {
	readonly read: CodeImportReadJob;
	readonly look: CodeImportLookJob;
	readonly remove: CodeImportRemoveJob;
}
