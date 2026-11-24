import { createHash } from "node:crypto";
import { parseWall, wallHandle } from "@qorpera/cloud-client/agent-wall";
import { parseCloudCompanyPath } from "@qorpera/cloud-client/company-path-schema";
import { companyPathKey, osRelative } from "@qorpera/cloud-client/company-state-files";
import {
	APP_MANIFEST,
	APP_MANIFEST_MAX_BYTES,
	APPS_FOLDER,
	type AppManifestParse,
	appPath,
	isAppManifestPath,
	parseAppManifest,
} from "@qorpera/cloud-client/interface-apps";
import { folderKey, type JsonValue, UUID_PATTERN } from "@qorpera/contracts";
import {
	type CloudCompanyFolderClient,
	type CloudCompanyFolderEntry,
	CloudCompanyFolderError,
	type CloudCompanyFolderFileEntry,
	type CloudCompanyFolderRelease,
	type CloudCompanyFolderUnit,
	type CloudCompanyFolderUnitResult,
	cloudCompanyFolderRelease,
} from "./cloud-company-folder-client.ts";
import { CloudCompanyPathNotText } from "./cloud-company-path-gateway.ts";
import { CloudCompanyFolderRpcError } from "./cloud-company-path-refusal.ts";
import { refuseRetiredMove, refuseRetiredPath } from "./cloud-folder-app-retired.ts";
import {
	FolderImageRefusal,
	folderImageFormat,
	folderImageView,
	IMAGE_HEAD_BYTES,
	MAX_FOLDER_IMAGE_BYTES,
	oneImageAtATime,
	otherImageFormat,
	SHOWN_MAX_HEIGHT,
	SHOWN_MAX_WIDTH,
} from "./cloud-folder-images.ts";
import type { CloudNativeToolIdentity } from "./cloud-native-tool-authority.ts";
import {
	type CloudNativeTool,
	CloudToolArgumentRefusal,
	type CloudToolContent,
	type CloudToolContext,
	CloudToolRefusal,
	cloudSecretSpans,
	cloudToolJsonText,
	MAX_CLOUD_TOOL_RESULT_BYTES,
	MAX_TOOL_ARGUMENT_BYTES,
	redactCloudWebhookSecrets,
} from "./cloud-native-tool-boundary.ts";
import type { CloudNativeToolOperations } from "./cloud-native-tool-operations.ts";
import {
	CloudRuntimeDiagnosticError,
	type CloudRuntimeErrorCategory,
	type CloudRuntimeToolOperation,
} from "./cloud-runtime-observability.ts";
import { fitsOneResult } from "./cloud-worker-tools.ts";

/*
 * The one-file Company File tools of a folder-v2 run (folder core slice P19, core C3; the 2 October 2026 amendment
 * "light threads", item 2): `company_read`, `company_list`, `company_write`, `company_edit`, `company_move`,
 * `company_mkdir` and `company_delete` with the run's own authority, through the folder core (`company_edit` and
 * `company_move`: the 21 October 2026 amendment "how agents start work and use the company folder").
 *
 * - A read or a listing is the run actor's (the run's own view of the folder). Its answer is fitted to one tool
 *   result, so the model sees all of it, and everything it shows (the entry read, or the folder and each entry listed)
 *   is released with the run actor under the hash of exactly that text before the model sees it. The answer cites the
 *   release (`companyReadId`).
 * - A listing goes down to `depth` levels and keeps the paths like `glob` (keyholes S2, 12 November 2026), one short
 *   line an entry, so one call shows a small company's whole tree; what it leaves out comes with where to go on.
 * - A read of several paths (keyholes S3, 12 November 2026) reads each from its start into one result, each file its own
 *   release, and says for each path what a read of it alone would: its version, how much is shown and nextOffset. An
 *   image among them is named, not shown (one result shows one picture); read alone, it is shown as before.
 * - A PNG, JPEG, GIF or WebP file read from its start is shown as one PNG made here (cloud-folder-images.ts), after an
 *   answer that names that PNG's hash and is released like any read; an image in another format is refused by name.
 * - A change is a one-unit change set, committed under the tool call's receipt, so it happens once and a replay of the
 *   same call answers from its receipt. The folder core decides it: a stale version is a conflict, a missing folder is
 *   refused, and a unit the core reviews (a deletion; delegation through files) needs a recorded review. A deletion
 *   records the automatic review's approval of its call (C2 R1); other files that need review have their own tools.
 * - An edit replaces one exact span of one file's text, found once in the file at the version the model read, and
 *   writes the whole file under that version, as a write does. A move is one move unit, reviewed as a deletion is: the
 *   core takes the source path away.
 */

const MAX_READ_BYTES = MAX_CLOUD_TOOL_RESULT_BYTES;
const MAX_WRITE_BYTES = MAX_TOOL_ARGUMENT_BYTES;
/** A listing (keyholes S2, 12 November 2026) shows at most this many entries a call, one short line each: about as
 * many as fit one result when paths are about 50 bytes, as they are in companies today. Fewer when they do not fit. */
const MAX_LIST = 500;
/** How many levels below its folder a listing goes: the companies of 7 November 2026 had paths 7 deep at most. */
const MAX_DEPTH = 8;
/** What one listing call looks through at most, in the folder core's pages (the client's 200 a page), before it
 * answers with where to go on: entries a depth or a glob leaves out count too, so a call over a large subtree stays
 * short. It stops at whichever comes first. */
const LIST_SCAN_ENTRIES = 5000;
const LIST_SCAN_MS = 2000;
/** One listing answer is one moment of the folder: a look whose pages answered at different folder clocks is taken
 * again, up to this many looks a call in all, all within LIST_CALL_MS (so a look that took its whole LIST_SCAN_MS is
 * still taken again once). */
const LIST_LOOKS = 3;
const LIST_CALL_MS = 2 * LIST_SCAN_MS;
/** The line a listing answer carries when the folder kept changing through every look. */
const CHANGED_WHILE_LISTED =
	"The folder changed while it was listed, so a path may show twice here or not at all; call again the same way for a clean listing.";
/** A glob, as company_search's (MAX_QUERY there). */
const MAX_GLOB = 256;
const MAX_PATHS = 24;
const READ_MANY_CONCURRENCY = 6;
const LINE_RANGE_READ_BYTES = 256 * 1024;
const MAX_LINE_NUMBER = 1_000_000;
const MANY_JSON_BYTES = MAX_PATHS * (MAX_READ_BYTES * 6 + 32 * 1024);
/** A listing shows a link's target up to this many bytes; company_read shows all of it. */
const LIST_TARGET_BYTES = 512;
/** The model's operation key, as the legacy tools take it. */
export const OPERATION_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
export const TOOL_VERSION = "folder-v2/1";
const TEXT = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
/** What a read takes past a window's end, and before its start, to see a secret its edge would cut (windowEnd,
 * windowLead): more than the longest the shortest whole secret can be in any spelling the cut knows (a github_pat_
 * whose every `_` is JSON-escaped twice: 597 characters). */
const SECRET_MARGIN = 1024;
/** The longest unit a secret's pattern takes as one character: a JSON escape written twice (`\\u005F`), 7. */
const SECRET_UNIT = 7;
/** Text around a window, only to find secrets in: bytes that are no UTF-8 become U+FFFD, which no secret holds. */
const AROUND = new TextDecoder("utf-8", { ignoreBOM: true });

type MutationTool = "company_write" | "company_edit" | "company_move" | "company_mkdir" | "company_delete";

/** One release id per tool call and output: a replay of the same call showing the same text releases under the same
 * id, and one that shows something else gets its own. */
export function releaseId(runId: string, callId: string, outputSha256: string): string {
	const hex = createHash("sha256")
		.update(`qorpera.company-file-release/v1:${runId}:${callId}:${outputSha256}`)
		.digest("hex");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${((Number.parseInt(hex[16] as string, 16) & 0x3) | 0x8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export function args(value: JsonValue, tool: string, keys: readonly string[]): Record<string, JsonValue> {
	if (value === null || typeof value !== "object" || Array.isArray(value))
		throw new CloudToolArgumentRefusal(`${tool} takes an object with ${keys.join(", ")}`);
	if (Object.keys(value).some((key) => !keys.includes(key)) || keys.some((key) => !Object.hasOwn(value, key)))
		throw new CloudToolArgumentRefusal(`${tool} takes exactly ${keys.join(", ")}`);
	return value as Record<string, JsonValue>;
}

/** A tool's arguments with `required` keys and any of `optional`, and nothing else. */
function someArgs(
	value: JsonValue,
	tool: string,
	required: readonly string[],
	optional: readonly string[],
): Record<string, JsonValue> {
	const keys = [...required, ...optional];
	if (value === null || typeof value !== "object" || Array.isArray(value))
		throw new CloudToolArgumentRefusal(`${tool} takes an object with ${keys.join(", ")}`);
	if (Object.keys(value).some((key) => !keys.includes(key)) || required.some((key) => !Object.hasOwn(value, key)))
		throw new CloudToolArgumentRefusal(
			required.length
				? `${tool} takes ${required.join(", ")}${optional.length ? `, and may take ${optional.join(", ")}` : ""}, and nothing else`
				: `${tool} takes only ${optional.join(", ")}`,
		);
	return value as Record<string, JsonValue>;
}

/** A listing's glob: the syntax of company_search's (packages/object-gateway/src/folder-service/search.ts,
 * compileGlob and globMatches), its '/'-separated parts each a name pattern (code points: `*` any run of them, `?` any
 * one) or `**` (any number of folders), and without a '/' it is matched against a name alone. Matched on folder keys
 * (case folded, as the folder compares names), so `*.md` finds README.MD. The same linear walks as the search's. */
interface Glob {
	readonly parts: readonly (readonly string[] | "**")[];
	readonly nameOnly: boolean;
}

function compileGlob(glob: string): Glob {
	const key = folderKey(glob);
	return {
		parts: key.split("/").map((part) => (part === "**" ? "**" : Array.from(part))),
		nameOnly: !key.includes("/"),
	};
}

/** One name against one pattern: the two-pointer walk with one place to go back to, at most name × pattern steps. */
function nameMatches(pattern: readonly string[], name: readonly string[]): boolean {
	let p = 0;
	let n = 0;
	let star = -1;
	let mark = 0;
	while (n < name.length) {
		if (p < pattern.length && pattern[p] !== "*" && (pattern[p] === "?" || pattern[p] === name[n])) {
			p++;
			n++;
		} else if (p < pattern.length && pattern[p] === "*") {
			star = p++;
			mark = n;
		} else if (star >= 0) {
			p = star + 1;
			n = ++mark;
		} else return false;
	}
	while (p < pattern.length && pattern[p] === "*") p++;
	return p === pattern.length;
}

/** A path's key below the listed folder against a glob: the same walk over its names, `**` any run of them. */
function globMatches(glob: Glob, key: string): boolean {
	const names = key.split("/");
	if (glob.nameOnly) return nameMatches(glob.parts[0] as readonly string[], Array.from(names[names.length - 1]!));
	let p = 0;
	let n = 0;
	let star = -1;
	let mark = 0;
	while (n < names.length) {
		const part = glob.parts[p];
		if (part !== undefined && part !== "**" && nameMatches(part, Array.from(names[n]!))) {
			p++;
			n++;
		} else if (part === "**") {
			star = p++;
			mark = n;
		} else if (star >= 0) {
			p = star + 1;
			n = ++mark;
		} else return false;
	}
	while (p < glob.parts.length && glob.parts[p] === "**") p++;
	return p === glob.parts.length;
}

/** One look through a listing's pages: every entry it looked at, in key order, those it would show, the folder clock
 * of its first page, whether all its pages answered at that clock (then it is the folder at that moment: each page is
 * one statement, and no change set came between them), and whether it reached the folder's end. */
interface ListLook {
	readonly looked: readonly CloudCompanyFolderEntry[];
	readonly matched: readonly CloudCompanyFolderEntry[];
	readonly asOfSeq: number;
	readonly steady: boolean;
	readonly ended: boolean;
}

export function path(value: JsonValue | undefined, root: boolean): string {
	try {
		return parseCloudCompanyPath(value as string, root);
	} catch {
		throw new CloudToolArgumentRefusal(
			`path must be a company-relative path like sales/sales-dashboard.html${root ? ", or empty for the top of the folder" : ""} (no leading or trailing /)`,
		);
	}
}

export function integer(value: JsonValue | undefined, label: string, minimum: number, maximum: number): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum)
		throw new CloudToolArgumentRefusal(`${label} must be a whole number from ${minimum} to ${maximum}`);
	return value;
}

export function operationKey(value: JsonValue | undefined): string {
	if (typeof value !== "string" || !OPERATION_KEY.test(value))
		throw new CloudToolArgumentRefusal(
			"operationKey must be 1 to 192 letters, digits or . _ : -, starting with a letter or digit",
		);
	return value;
}

export function version(value: JsonValue | undefined, nullable: boolean): string | null {
	if (value === null && nullable) return null;
	if (typeof value !== "string" || !UUID_PATTERN.test(value))
		throw new CloudToolArgumentRefusal(
			nullable
				? "expectedVersion must be the version company_read reported, or null for a path that does not exist"
				: "expectedVersion must be the version company_read reported",
		);
	return value;
}

/** A folder call that failed before anything was shown or changed, as a refusal the model can act on. */
export function unavailable(error: unknown, what: string): never {
	if (!(error instanceof CloudCompanyFolderError)) throw error;
	if (error.failure === "stopped")
		throw new CloudToolRefusal(`COMPANY_WORK_STOPPED: the company's work is stopped, so nothing was ${what}`);
	if (error.failure === "read_revoked")
		throw new CloudToolRefusal(
			"READ_REVOKED: something this answer drew on may no longer be read by you, so it is not shown; read again",
		);
	throw new CloudToolRefusal(`COMPANY_FOLDER_UNAVAILABLE: the company folder could not be ${what} now; try again`);
}

/** Releases what an answer shows under the hash of exactly its text, and returns the text with its citation. An
 * answer that cannot reach the model whole (its smallest form is still cut by the fence) is refused before anything is
 * released. The text is the answer as the model is shown it: the boundary cuts a secret out of every answer (a file,
 * a name or a link's target may hold a token) and hashes what is left, and the context view cites the release under
 * that hash, which SQL compares with the release's (`Context read provenance differs` otherwise). The cut never
 * lengthens a text, so an answer fitted before it still fits, and cutting again changes nothing. */
export async function released(
	folder: CloudCompanyFolderClient,
	runId: string,
	context: CloudToolContext,
	answer: string,
	reads: readonly CloudCompanyFolderRelease[],
	tooLong = "COMPANY_FILE_ANSWER_TOO_LONG: a path in this answer is too long to show in one tool result, so nothing was read; find names with company_search (names_only)",
): Promise<CloudToolContent> {
	const text = redactCloudWebhookSecrets(answer);
	if (!fitsOneResult(text)) throw new CloudToolRefusal(tooLong);
	context.observation?.update({ outputBytes: Buffer.byteLength(text) });
	if (reads.length === 0) return { kind: "text", value: text };
	const outputSha256 = createHash("sha256").update(text, "utf8").digest("hex");
	const id = releaseId(runId, context.callId, outputSha256);
	try {
		await folder.release(id, reads, outputSha256, context.signal);
	} catch (error) {
		unavailable(error, "shown");
	}
	return { kind: "text", value: text, companyReadId: id };
}

/** The longest start of a window that is whole UTF-8 text: a code point cut by the window's end is left for the next
 * window; at the file's end, or at a start inside a code point, the bytes are not text. */
function windowText(bytes: Uint8Array, atEnd: boolean): string | null {
	for (let trim = 0; trim <= Math.min(3, bytes.byteLength); trim++) {
		try {
			const text = TEXT.decode(bytes.subarray(0, bytes.byteLength - trim));
			return text.length === 0 && bytes.byteLength > 0 ? null : text;
		} catch {
			if (atEnd) return null;
		}
	}
	return null;
}

/** The longest start of `text` of at most `bytes` UTF-8 bytes, cut at a code point. */
function head(text: string, bytes: number): string {
	if (Buffer.byteLength(text) <= bytes) return text;
	let shown = "";
	let used = 0;
	for (const point of text) {
		used += Buffer.byteLength(point);
		if (used > bytes) break;
		shown += point;
	}
	return shown;
}

function codePointEndOffsets(text: string): Int32Array {
	const offsets = new Int32Array(text.length + 1);
	let count = 0;
	for (let i = 0; i < text.length; ) {
		const code = text.charCodeAt(i);
		const next = i + 1 < text.length ? text.charCodeAt(i + 1) : 0;
		i += code >= 0xd800 && code <= 0xdbff && next >= 0xdc00 && next <= 0xdfff ? 2 : 1;
		offsets[++count] = i;
	}
	return offsets.subarray(0, count + 1);
}

/** The answer `render` makes of `text`, or of its longest start (at least `least` code points) whose answer fits one
 * tool result: escaping can grow text up to seven times. A start whose answer is past even a tool JSON's own bound
 * (`cloudToolJsonText`'s 64 KiB, which a whole 32 KiB window of line breaks or control characters passes) does not fit
 * either; the answer for `least` is rendered outside that check, so a render that always fails still throws. */
function fitted(text: string, least: number, render: (shown: string) => string): string {
	const answer = (shown: string): string | undefined => {
		try {
			const output = render(shown);
			return fitsOneResult(output) ? output : undefined;
		} catch {
			return undefined;
		}
	};
	const whole = answer(text);
	if (whole !== undefined) return whole;
	const ends = codePointEndOffsets(text);
	let low = Math.min(least, ends.length - 1);
	let high = ends.length - 1;
	while (low < high) {
		const middle = Math.ceil((low + high) / 2);
		if (answer(text.slice(0, ends[middle])) !== undefined) low = middle;
		else high = middle - 1;
	}
	return render(text.slice(0, ends[low]));
}

/**
 * Where a window may end (keyholes S3, after #1721). The boundary cuts a secret out of an answer only when the answer
 * holds it whole, so a window that ended inside one showed its start, and the next window its rest, neither cut. So a
 * window never ends inside a secret (cloudSecretSpans, the boundary's own patterns): `text` is the window and what
 * follows it as far as read, `end` where the window's room would end it (within the window). A secret that starts in
 * the window and runs past that end ends the window where it starts, so the next window holds it whole. One that
 * starts the window is taken whole, past the room if need be: the answer shows its short cut form. If it may go on past
 * everything read (`more`: the file goes on, and it reaches the end of the read, or ends so near it that its next
 * unit, a %-escape or a \u escape, may be cut there: reviews r6 and r7 of #1700), it is taken as far as read, and `runsOn`
 * says the window ends inside it: no window can hold it, and what follows is the rest of it, which nothing can cut on
 * its own. (Such a secret is longer than the read's SECRET_MARGIN: no real key is.) `secrets` are
 * cloudSecretSpans(text), found once for a window's many fittings.
 */
function windowEnd(
	text: string,
	end: number,
	more: boolean,
	secrets: ReturnType<typeof cloudSecretSpans> = cloudSecretSpans(text),
): { readonly end: number; readonly runsOn: boolean } {
	for (const span of secrets) {
		if (span.start >= end) break;
		if (span.end <= end) continue;
		if (span.start > 0) return { end: span.start, runsOn: false };
		// What is left after it, cut off by the read's end, may be the start of its next unit (%2 of %2B, \u00 of \u002B):
		// printable ASCII only, so the end stays a whole character. Anything else (a character, or bytes of one the
		// read cut) ends it there (review r7 of #1700).
		if (more && span.end > text.length - SECRET_UNIT && /^[\x21-\x7e]*$/.test(text.slice(span.end)))
			return { end: text.length, runsOn: true };
		return { end: span.end, runsOn: false };
	}
	return { end, runsOn: false };
}

/** Where a window may start: never inside a secret either. `behind` is what was read before the window's offset,
 * `rest` the window and what follows. A secret that runs from `behind` into the window starts the window instead: what
 * of `behind` the window takes in front, or "". */
function windowLead(behind: string, rest: string): string {
	for (const span of cloudSecretSpans(behind + rest)) {
		if (span.start >= behind.length) break;
		if (span.end > behind.length) return behind.slice(span.start);
	}
	return "";
}

/** What an answer says of a window that ends inside a secret no window can hold (windowEnd's `runsOn`). */
function secretRunsOn(start: number): string {
	return `A secret-shaped run starts at offset ${start} and goes on past nextOffset: what was read of it is shown cut, and reading on shows the rest of it, which cannot be cut on its own.`;
}

/** A link's target as an answer shows it: `targetCut` when only its start fits. */
function shownTarget(whole: string, shown: string): { target: string } | { target: string; targetCut: true } {
	return shown.length < whole.length ? { target: shown, targetCut: true } : { target: whole };
}

/** The save check refused the change only because an agent authors no page or table layout (20260930510000): the
 * same change can never save, so the model is told not to try it again. */
function layoutAuthoring(unit: CloudCompanyFolderUnitResult): boolean {
	return (
		unit.outcome === "refused" &&
		unit.reason === "structured_rule" &&
		unit.problems.length > 0 &&
		unit.problems.every((problem) => problem.code === "layout_authoring")
	);
}

/** What the folder core's answer to a change means, for the model (make_picture's answer starts from company_write's). */
export function mutationText(
	tool: MutationTool,
	request: { operationKey: string; path: string },
	receiptId: string,
	unit: CloudCompanyFolderUnitResult,
): string {
	const reason = unit.reason ?? "";
	const next =
		unit.outcome === "saved"
			? undefined
			: unit.outcome === "waiting_for_review"
				? "The change waits for a member's approval: do not make it again; tell the member it is waiting for them."
				: reason === "exists"
					? tool === "company_move"
						? "COMPANY_FILE_EXISTS: nothing was moved; something is already at the new path. Choose another path, or move or delete what is there first, with a new operationKey."
						: "COMPANY_FILE_EXISTS: nothing was written; something is already at that path. Read it and change it under its version, or choose another path, with a new operationKey."
					: unit.outcome === "conflict"
						? tool === "company_move" && reason === "unseen_change"
							? "COMPANY_FILE_VERSION_CHANGED: nothing was moved; something in the folder changed after your listing. List it again with company_list and move it with that listing's asOfSeq under a new operationKey."
							: `COMPANY_FILE_VERSION_CHANGED: nothing was ${tool === "company_move" ? "moved" : "written"}; the path ${reason === "missing" ? "is gone" : "changed"} since your version. Read it again and make the change on its current version under a new operationKey.`
						: reason === "parent_missing"
							? "COMPANY_FILE_PARENT_MISSING: nothing was written; the folder this path goes in does not exist. When it is where the file belongs (its area, such as sales/, or a place a member or your assignment named), create it with company_mkdir first (outermost first) and repeat with a new operationKey; otherwise write the file in the folder where it belongs."
							: reason === "review_required"
								? tool === "company_delete"
									? "Nothing was deleted: the deletion needs the automatic review's approval of this call. Call again, and if this repeats tell the member."
									: tool === "company_move"
										? "Nothing was moved: the move needs the automatic review's approval of this call. Call again, and if this repeats tell the member."
										: "Nothing was written: this change needs a review, so it is made with its own tool (hire_agent, hire_team, create_group_chat, manage_routine), not with a file write."
								: unit.outcome === "denied"
									? "COMPANY_FILE_ACCESS_DENIED: you may not change this path; nothing was written."
									: layoutAuthoring(unit)
										? "COMPANY_FILE_LAYOUT_AUTHORING: nothing was written; page and table layout authoring is not available. Do not make this change again, with this or any other tool; if a member asked for it, tell them."
										: `Nothing was written (${reason || "refused"})${unit.problems.length ? ": fix the problems listed and call again with a new operationKey" : ""}.`;
	return cloudToolJsonText({
		schema: "qorpera.company-folder-result/v1",
		state: unit.outcome === "saved" ? "applied" : unit.outcome === "waiting_for_review" ? "proposed" : "not_applied",
		operationKey: request.operationKey,
		path: unit.path,
		...(typeof unit.to === "string" ? { to: unit.to } : {}),
		version: unit.outcome === "saved" ? unit.version : null,
		receiptId,
		outcome: unit.outcome,
		...(unit.reason ? { reason: unit.reason } : {}),
		...(unit.problems.length ? { problems: unit.problems } : {}),
		...(next ? { next } : {}),
	});
}

const STALE_REASONS = new Set(["exists", "missing", "version_changed", "unseen_change"]);
const PARENT_REASONS = new Set(["parent_missing", "folder_missing"]);
const DENIED_REASONS = new Set([
	"denied",
	"review_required",
	"review_denied",
	"not_a_writer",
	"owners_only",
	"rows_not_writable",
	"claim",
]);

/** Why a folder-v2 change's answer says it changed nothing, as the call's observation names it (contract, Minimum
 * operational observability: refused work never looks like success): a file tool's, a save's or a row write's
 * `state`, or an apply's `outcome`, `not_applied`, by its own reason or else its first file's that was not saved.
 * Nothing for a saved, parked, unchanged or partly saved change. Read from the answer alone, which is all a replay has. */
export function cloudFolderRefusal(content: CloudToolContent): CloudRuntimeErrorCategory | undefined {
	// Any JSON value: a field that is not there, or a value that is not an object, reads as undefined.
	type Part = { state?: unknown; outcome?: unknown; reason?: unknown; files?: unknown; notSaved?: unknown } | null;
	let whole: Part;
	try {
		whole = (content.kind === "text" ? JSON.parse(content.value) : content.value) as Part;
	} catch {
		return undefined;
	}
	if ((whole?.state ?? whole?.outcome) !== "not_applied") return undefined;
	const why = (row: Part): CloudRuntimeErrorCategory | undefined => {
		const reason = typeof row?.reason === "string" ? row.reason : undefined;
		if (row?.outcome === "conflict" || (reason && STALE_REASONS.has(reason))) return "stale_version";
		if (reason && PARENT_REASONS.has(reason)) return "parent_missing";
		if (row?.outcome === "denied" || (reason && DENIED_REASONS.has(reason))) return "authority_unavailable";
		return reason || row?.outcome === "refused" || row?.outcome === "blocked" ? "invalid_arguments" : undefined;
	};
	const unsaved = [whole?.files, whole?.notSaved].flatMap((rows) => (Array.isArray(rows) ? (rows as Part[]) : []));
	return [whole, ...unsaved].map(why).find((category) => category !== undefined) ?? "invalid_arguments";
}

/** An interface app's manifest written as a file (RUNTIME-INTERFACE-APPS.md §3): it must parse; its `posted` stays as
 * stored (`before`, null for a new file, which is not posted), since posting an app is post_app's, which the automatic
 * review sees; and its `owner` stays as stored, or is the writing agent (`agent`) or none on a new one, since the panel
 * names the owner to members. Says nothing a file holds but whether the app is posted and whose it is. */
export function appManifestCheck(path: string, before: AppManifestParse | null, after: string, agent: string): void {
	if (!isAppManifestPath(path)) return;
	const parsed = parseAppManifest(after);
	if (!parsed.ok)
		throw new CloudToolRefusal(
			`APP_MANIFEST_INVALID: nothing was written; app.toml has problems: ${parsed.problems
				.slice(0, 5)
				.map((problem) => `${problem.line === null ? "" : `line ${problem.line}: `}${problem.message}`)
				.join("; ")}`,
		);
	const stored = before?.ok ? before.manifest : null;
	const posted = stored?.posted ?? false;
	if (parsed.manifest.posted !== posted)
		throw new CloudToolRefusal(
			`APP_POSTED_BY_POST_APP: nothing was written; keep posted = ${posted} in app.toml, and post the app or take it away with post_app`,
		);
	const owner = parsed.manifest.owner;
	if (stored ? owner !== stored.owner : owner !== null && owner !== agent)
		throw new CloudToolRefusal(
			`APP_OWNER_FIXED: nothing was written; owner names the agent that made the app and does not change${stored?.owner ? `: keep owner = "${stored.owner}"` : ""}`,
		);
}

/** An agent's wall written as a file (packages/cloud-client/src/agent-wall.ts): it must still read as a wall, within
 * its limits, for the web that shows it. No tool keeps walls since 14 November 2026 (the founder: "rather drop the
 * wall"); a member's hand or an agent's file tool is the only writer left. */
export function wallCheck(path: string, text: string): void {
	if (wallHandle(path) === null) return;
	const { problems } = parseWall(text);
	if (problems.length)
		throw new CloudToolRefusal(
			`WALL_INVALID: nothing was written; wall.md has problems: ${problems
				.slice(0, 5)
				.map((problem) => `line ${problem.line}: ${problem.message}`)
				.join("; ")}`,
		);
}

export type SurfaceFilePolicy =
	| { readonly mode: "cofounder"; readonly allowExplicitMemberDoc?: boolean }
	| {
			readonly mode: "surface_worker";
			readonly writableRoots: readonly string[];
			readonly stagedRoots: readonly string[];
	  };

const COFOUNDER_DOC_SPRAWL_ROOTS = new Set([
	"strategy",
	"research",
	"operations",
	"plans",
	"docs",
	"memos",
	"reports",
	"meetings",
	"marketing",
	"sales",
]);

function normalizePolicyPath(targetPath: string): string {
	return companyPathKey(targetPath).replace(/^\/+|\/+$/g, "");
}

function enforceSurfaceFilePolicy(policy: SurfaceFilePolicy | undefined, targetPath: string): void {
	if (!policy) return;
	const normalized = normalizePolicyPath(targetPath);
	if (policy.mode === "cofounder") {
		if (policy.allowExplicitMemberDoc) return;
		const root = normalized.split("/")[0] ?? "";
		if (COFOUNDER_DOC_SPRAWL_ROOTS.has(root)) {
			throw new CloudToolRefusal(
				`SURFACE_FILE_POLICY_REFUSED: writing under "${root}/" is blocked in Surface-First mode to prevent doc sprawl. Stage a tangible Surface Change via start_surface_session or place a concise Note under QorperaOS/surfaces/<slug>/notes/ instead of creating loose markdown documents.`,
			);
		}
		return;
	}
	const roots = (paths: readonly string[]) =>
		paths
			.map((root) => ({ key: normalizePolicyPath(root), shown: root.replace(/^\/+|\/+$/g, "") }))
			.filter((root) => root.key.length > 0);
	const within = (root: { readonly key: string }) => normalized === root.key || normalized.startsWith(`${root.key}/`);
	const writable = roots(policy.writableRoots);
	if (writable.some(within)) return;
	const notes = writable.map((root) => `${root.shown}/`).join(", ") || "none";
	const staged = roots(policy.stagedRoots).find(within);
	if (staged !== undefined) {
		throw new CloudToolRefusal(
			`SURFACE_FILE_POLICY_REFUSED: nothing was written; "${targetPath}" is in this Studio's folder ${staged.shown}/, which changes only through staged changes the member previews and approves. Stage this change with stage_surface_patch (paths relative to ${staged.shown}/). Direct file writes are for notes under ${notes} only.`,
		);
	}
	throw new CloudToolRefusal(
		`SURFACE_FILE_POLICY_REFUSED: path "${targetPath}" is outside this Surface worker's writable roots (${notes}). Change Studio files with stage_surface_patch and write directly only notes under ${notes}.`,
	);
}

/** The five tools for a folder-v2 run. `operations` takes the receipts of its changes. */
export function cloudFolderFileTools(options: {
	folder: CloudCompanyFolderClient;
	operations: CloudNativeToolOperations;
	identity: CloudNativeToolIdentity;
	surfaceFilePolicy?: SurfaceFilePolicy;
}): CloudNativeTool[] {
	const { folder, operations, identity, surfaceFilePolicy } = options;
	const pathSchema = { type: "string", maxLength: 4096 };
	const nullableVersion = { type: ["string", "null"], pattern: UUID_PATTERN.source };

	const agent = identity.staffAgentId.toLowerCase();
	// An interface app's files are its owner's (RUNTIME-INTERFACE-APPS.md §3): another agent changes them with save_app,
	// which the automatic review sees, so the owner the panel names is the one who made what members see. A manifest
	// that doesn't read names no owner, and anyone may write it whole again.
	const appGuard = async (path: string, text: string | null, signal: AbortSignal): Promise<void> => {
		const app = appPath(path);
		if (!app || app.inner === "") return;
		let stored: Awaited<ReturnType<CloudCompanyFolderClient["readText"]>> = null;
		try {
			stored = await folder.readText(`${APPS_FOLDER}/${app.name}/${APP_MANIFEST}`, APP_MANIFEST_MAX_BYTES, signal);
		} catch (error) {
			if (!(error instanceof CloudCompanyPathNotText)) unavailable(error, "written");
		}
		const before = stored ? parseAppManifest(stored.text) : null;
		if (before?.ok && before.manifest.owner !== agent)
			throw new CloudToolRefusal(
				"APP_NOT_YOURS: nothing was written; this app is another agent's or a member's: change it with save_app, which asks first",
			);
		if (text !== null) appManifestCheck(path, before, text, agent);
	};

	const read = async (path: string, what: string, signal: AbortSignal): Promise<CloudCompanyFolderEntry | null> => {
		try {
			return (await folder.read(path, signal)).entry;
		} catch (error) {
			return unavailable(error, what);
		}
	};

	/** A PNG, JPEG, GIF or WebP file, read whole and shown as one PNG made here, released with its read. */
	const showImage = async (
		entry: CloudCompanyFolderFileEntry,
		context: CloudToolContext,
		preloaded?: Uint8Array,
	): Promise<CloudToolContent> => {
		const total = entry.file.bytes;
		if (total > MAX_FOLDER_IMAGE_BYTES)
			throw new CloudToolRefusal(
				`COMPANY_IMAGE_TOO_LARGE: the file is larger than ${MAX_FOLDER_IMAGE_BYTES / 1024 / 1024} MiB; open it on a machine`,
			);
		// One image at a time in this process: a call waits here, with nothing read, for the images before it.
		const view = await oneImageAtATime(context.signal, async () => {
			let bytes: Uint8Array;
			if (preloaded !== undefined && preloaded.byteLength >= total) {
				bytes = preloaded;
			} else {
				try {
					bytes = await folder.readRange(entry, 0, total, context.signal);
				} catch (error) {
					return unavailable(error, "read");
				}
			}
			try {
				return folderImageView(bytes);
			} catch (error) {
				if (!(error instanceof FolderImageRefusal)) throw error;
				throw new CloudToolRefusal(
					`${error.reason === "too_large" ? "COMPANY_IMAGE_TOO_LARGE" : "COMPANY_IMAGE_UNREADABLE"}: ${error.message}; open it on a machine`,
				);
			}
		});
		const text = cloudToolJsonText({
			path: entry.path,
			kind: "image",
			version: entry.version,
			mediaType: `image/${view.format}`,
			totalBytes: total,
			width: view.width,
			height: view.height,
			shownWidth: view.shownWidth,
			shownHeight: view.shownHeight,
			imageSha256: view.sha256,
		});
		const content = await released(folder, identity.runId, context, text, [cloudCompanyFolderRelease(entry)]);
		return { ...content, image: { png: view.png, sha256: view.sha256 } };
	};

	type PathReadTarget =
		| string
		| {
				readonly path: string;
				readonly startLine?: number;
				readonly endLine?: number;
		  };
	type LineSpan = {
		readonly startChar: number;
		readonly endChar: number;
		readonly startByte: number;
		readonly endByte: number;
	};
	const splitLineSpans = (text: string): LineSpan[] => {
		if (text.length === 0) return [];
		const spans: LineSpan[] = [];
		let startChar = 0;
		let startByte = 0;
		for (let index = 0; index < text.length; index++) {
			if (text.charCodeAt(index) === 0x0a) {
				const endChar = index + 1;
				const endByte = startByte + Buffer.byteLength(text.slice(startChar, endChar));
				spans.push({ startChar, endChar, startByte, endByte });
				startChar = endChar;
				startByte = endByte;
			}
		}
		if (startChar < text.length) {
			const endByte = startByte + Buffer.byteLength(text.slice(startChar));
			spans.push({ startChar, endChar: text.length, startByte, endByte });
		}
		return spans;
	};
	const countNewlines = (text: string): number => {
		let count = 0;
		for (let index = 0; index < text.length; index++) {
			if (text.charCodeAt(index) === 0x0a) count++;
		}
		return count;
	};
	type ManyPart = {
		readonly answer: Record<string, JsonValue>;
		readonly text?: {
			readonly field: "text" | "target";
			readonly ends: Int32Array;
			readonly around: string;
			readonly secrets: ReturnType<typeof cloudSecretSpans>;
			readonly more: boolean;
			readonly offset: number;
			readonly total: number;
			readonly lineRange?: {
				readonly startLine: number;
				readonly totalLines?: number;
			};
		};
		readonly release?: CloudCompanyFolderRelease;
	};
	const readPart = async (
		target: PathReadTarget,
		signal: AbortSignal,
		bytesTurn: <T>(fileSha256: string, read: () => Promise<T>) => Promise<T>,
	): Promise<ManyPart> => {
		const targetPath = typeof target === "string" ? target : target.path;
		const reqStartLine = typeof target === "string" ? undefined : target.startLine;
		const reqEndLine = typeof target === "string" ? undefined : target.endLine;
		const hasLineRange = reqStartLine !== undefined || reqEndLine !== undefined;
		const failed = (error: unknown): ManyPart => {
			const lost =
				error instanceof CloudCompanyFolderError
					? error.failure !== "stopped"
					: error instanceof CloudRuntimeDiagnosticError &&
						!(error instanceof CloudCompanyFolderRpcError) &&
						(error.category === "timeout" || error.category === "transport_unavailable") &&
						!signal.aborted;
			if (!lost) return unavailable(error, "read");
			return {
				answer: {
					path: targetPath,
					refused: "COMPANY_FOLDER_UNAVAILABLE: it could not be read now; read it again",
				},
			};
		};
		let entry: CloudCompanyFolderEntry | null;
		try {
			entry = (await folder.read(targetPath, signal)).entry;
		} catch (error) {
			return failed(error);
		}
		if (!entry) return { answer: { path: targetPath, kind: "absent", version: null } };
		const release = cloudCompanyFolderRelease(entry);
		if (entry.kind === "folder")
			return { answer: { path: entry.path, kind: "folder", version: entry.version }, release };
		if (entry.kind === "symlink") {
			if (hasLineRange)
				return {
					answer: {
						path: entry.path,
						kind: "symlink",
						version: entry.version,
						refused: "COMPANY_LINE_RANGE_UNSUPPORTED: startLine and endLine only apply to text files",
					},
					release,
				};
			return {
				answer: { path: entry.path, kind: "symlink", version: entry.version, offset: 0 },
				text: {
					field: "target",
					ends: codePointEndOffsets(entry.target),
					around: entry.target,
					secrets: cloudSecretSpans(entry.target),
					more: false,
					offset: 0,
					total: Buffer.byteLength(entry.target),
				},
				release,
			};
		}
		const total = entry.file.bytes;
		const readBytes = hasLineRange
			? Math.max(LINE_RANGE_READ_BYTES + SECRET_MARGIN, IMAGE_HEAD_BYTES)
			: Math.max(MAX_READ_BYTES + SECRET_MARGIN, IMAGE_HEAD_BYTES);
		let bytes: Uint8Array;
		try {
			bytes = await bytesTurn(entry.file.fileSha256, () => folder.readRange(entry, 0, readBytes, signal));
		} catch (error) {
			return failed(error);
		}
		const named = { path: entry.path, kind: "file", version: entry.version };
		const format = folderImageFormat(bytes);
		if (format)
			return {
				answer: {
					path: entry.path,
					kind: "image",
					version: entry.version,
					mediaType: `image/${format}`,
					totalBytes: total,
					shown: false,
					next: "Read it alone with company_read (path, offset 0) to see it.",
				},
				release,
			};
		const other = otherImageFormat(bytes);
		const { mediaType } = entry.file;
		if (other === undefined && ["image/png", "image/jpeg", "image/gif", "image/webp"].includes(mediaType))
			return {
				answer: {
					...named,
					refused: "COMPANY_IMAGE_UNREADABLE: the file is not the image its type says; open it on a machine",
				},
				release,
			};
		if (other !== undefined || (mediaType.startsWith("image/") && mediaType !== "image/svg+xml"))
			return {
				answer: {
					...named,
					refused: `COMPANY_IMAGE_FORMAT_UNSUPPORTED: only PNG, JPEG, GIF and WebP images are shown here${other ? `, and this one is ${other}` : ""}; open it on a machine`,
				},
				release,
			};
		if (!hasLineRange) {
			const window = bytes.subarray(0, MAX_READ_BYTES);
			const text = windowText(window, window.byteLength >= total);
			if (text === null)
				return {
					answer: {
						...named,
						refused: "COMPANY_FILE_NOT_TEXT: this file is not UTF-8 text; open such files on a machine",
					},
					release,
				};
			const around = text + AROUND.decode(bytes.subarray(Buffer.byteLength(text)));
			return {
				answer: { ...named, offset: 0 },
				text: {
					field: "text",
					ends: codePointEndOffsets(text),
					around,
					secrets: cloudSecretSpans(around),
					more: bytes.byteLength < total,
					offset: 0,
					total,
				},
				release,
			};
		}
		const scanWindow = bytes.subarray(0, Math.min(bytes.byteLength, LINE_RANGE_READ_BYTES));
		const scanned = windowText(scanWindow, scanWindow.byteLength >= total);
		if (scanned === null)
			return {
				answer: {
					...named,
					refused: "COMPANY_FILE_NOT_TEXT: this file is not UTF-8 text; open such files on a machine",
				},
				release,
			};
		const fullScanned = Buffer.byteLength(scanned) >= total;
		const spans = splitLineSpans(scanned);
		const startLine = reqStartLine ?? 1;
		const completeCount = fullScanned ? spans.length : Math.max(0, spans.length - (scanned.endsWith("\n") ? 0 : 1));
		if (startLine > completeCount) {
			if (!fullScanned)
				return {
					answer: {
						...named,
						refused:
							"COMPANY_LINE_RANGE_BEYOND_SCAN: startLine is past the first 256 KiB of this file; read it alone with path and offset",
					},
					release,
				};
			return {
				answer: {
					...named,
					offset: total,
					startLine,
					endLine: startLine - 1,
					totalLines: spans.length,
					bytesRead: 0,
					totalBytes: total,
					text: "",
					nextOffset: null,
				},
				release,
			};
		}
		const firstSpan = spans[startLine - 1]!;
		const lastIdx = Math.min((reqEndLine ?? completeCount) - 1, completeCount - 1);
		const lastSpan = spans[lastIdx]!;
		const tailAround = AROUND.decode(bytes.subarray(Buffer.byteLength(scanned)));
		const behind = scanned.slice(Math.max(0, firstSpan.startChar - SECRET_MARGIN), firstSpan.startChar);
		const rest = scanned.slice(firstSpan.startChar) + tailAround;
		const lead = windowLead(behind, rest);
		const startOffset = firstSpan.startByte - Buffer.byteLength(lead);
		const rawSlice = lead + scanned.slice(firstSpan.startChar, lastSpan.endChar);
		const sliceText = head(rawSlice, MAX_READ_BYTES);
		const sliceBodyLen = sliceText.length - lead.length;
		const around = sliceText + rest.slice(sliceBodyLen, sliceBodyLen + SECRET_MARGIN);
		const actualStartLine = Math.max(1, startLine - countNewlines(lead));
		return {
			answer: { ...named, offset: startOffset },
			text: {
				field: "text",
				ends: codePointEndOffsets(sliceText),
				around,
				secrets: cloudSecretSpans(around),
				more: startOffset + Buffer.byteLength(around) < total,
				offset: startOffset,
				total,
				lineRange: {
					startLine: actualStartLine,
					...(fullScanned ? { totalLines: spans.length } : {}),
				},
			},
			release,
		};
	};

	const readMany = async (
		targets: readonly PathReadTarget[],
		context: CloudToolContext,
	): Promise<CloudToolContent> => {
		// WHY: object gateway runs up to 8 NAS lanes concurrently, but rejects two simultaneous byte reads for the same fileSha256.
		// Serializing per fileSha256 before acquiring a concurrency slot prevents same-object contention without holding slots idle.
		const shaQueues = new Map<string, Promise<unknown>>();
		let activeBytes = 0;
		const byteWaiters: (() => void)[] = [];
		const acquireByteSlot = (): Promise<void> => {
			if (activeBytes < READ_MANY_CONCURRENCY) {
				activeBytes++;
				return Promise.resolve();
			}
			return new Promise<void>((resolve) => byteWaiters.push(resolve));
		};
		const releaseByteSlot = (): void => {
			const next = byteWaiters.shift();
			if (next) next();
			else activeBytes--;
		};
		const bytesTurn = <T>(fileSha256: string, read: () => Promise<T>): Promise<T> => {
			const prior = shaQueues.get(fileSha256) ?? Promise.resolve();
			const run = async (): Promise<T> => {
				await acquireByteSlot();
				try {
					return await read();
				} finally {
					releaseByteSlot();
				}
			};
			const turn = prior.then(run, run);
			const settled = turn.then(
				() => undefined,
				() => undefined,
			);
			shaQueues.set(fileSha256, settled);
			void settled.finally(() => {
				if (shaQueues.get(fileSha256) === settled) shaQueues.delete(fileSha256);
			});
			return turn;
		};
		const parts = await Promise.all(targets.map((target) => readPart(target, context.signal, bytesTurn)));
		const render = (cap: number): string =>
			cloudToolJsonText(
				{
					files: parts.map((part): JsonValue => {
						if (!part.text) return part.answer;
						const maxCap = part.text.ends.length - 1;
						const room = part.text.ends[cap < maxCap ? cap : maxCap]!;
						const { end, runsOn } = windowEnd(part.text.around, room, part.text.more, part.text.secrets);
						const shown = part.text.around.slice(0, end);
						const bytesRead = Buffer.byteLength(shown);
						const endOffset = part.text.offset + bytesRead;
						const lineFields: Record<string, JsonValue> = {};
						if (part.text.lineRange) {
							const shownLines = shown.length === 0 ? 0 : countNewlines(shown) + (shown.endsWith("\n") ? 0 : 1);
							lineFields.startLine = part.text.lineRange.startLine;
							lineFields.endLine =
								shownLines === 0
									? part.text.lineRange.startLine - 1
									: part.text.lineRange.startLine + shownLines - 1;
							if (part.text.lineRange.totalLines !== undefined)
								lineFields.totalLines = part.text.lineRange.totalLines;
						}
						return {
							...part.answer,
							...lineFields,
							bytesRead,
							totalBytes: part.text.total,
							[part.text.field]: shown,
							nextOffset: endOffset < part.text.total ? endOffset : null,
							...(runsOn ? { secretRun: secretRunsOn(part.text.offset) } : {}),
						};
					}),
				},
				MANY_JSON_BYTES,
			);
		let low = 0;
		let high = Math.max(0, ...parts.map((part) => (part.text ? part.text.ends.length - 1 : 0)));
		while (low < high) {
			const middle = Math.ceil((low + high) / 2);
			if (fitsOneResult(redactCloudWebhookSecrets(render(middle)))) low = middle;
			else high = middle - 1;
		}
		const dedupedReads: CloudCompanyFolderRelease[] = [];
		const seenReads = new Set<string>();
		for (const part of parts) {
			if (!part.release) continue;
			const key = `${folderKey(part.release.path)}\0${part.release.version ?? ""}`;
			if (seenReads.has(key)) continue;
			seenReads.add(key);
			dedupedReads.push(part.release);
		}
		return released(
			folder,
			identity.runId,
			context,
			render(low),
			dedupedReads,
			"COMPANY_FILE_ANSWER_TOO_LONG: these paths are too long to read together in one tool result, so nothing was read; read fewer at once",
		);
	};

	/** One change set of one unit, under the call's receipt. */
	const change = async (
		tool: MutationTool,
		request: { operationKey: string; path: string; to?: string },
		target: Record<string, JsonValue>,
		units: readonly CloudCompanyFolderUnit[],
		context: CloudToolContext,
		review?: string,
	): Promise<CloudToolContent> => {
		// A commit no one can complete would fence this run's later operations: refuse before writing anything.
		if (!operations.completesFolderCommits) throw new Error("This run cannot complete folder writes");
		const content = await operations.execute({
			operation: {
				tool,
				toolVersion: TOOL_VERSION,
				logicalOperationKey: request.operationKey,
				arguments: target,
				target: { path: request.path },
				requiresCompanyRevision: true,
			},
			// The folder core decides at the commit, under this call's receipt.
			authorize: async () => {},
			refused: cloudFolderRefusal,
			perform: async (_operation, { receiptId, signal }) => {
				// The commit's operation key for the model's: fixed length, and distinct per tool.
				const key = `${tool}:${createHash("sha256").update(request.operationKey).digest("hex")}`;
				let committed: Awaited<ReturnType<CloudCompanyFolderClient["commit"]>>;
				if (review === undefined) committed = await folder.commit(key, units, { receiptId }, signal);
				else {
					const staged = await folder.stage(units, signal);
					const reviewId = await folder.recordReview(
						{ actionReviewId: review, tool, argumentSha256: context.argumentSha256 },
						staged,
						signal,
					);
					committed = await folder.commitStaged(key, staged, { reviewId, receiptId }, signal);
				}
				const unit = committed.units[0];
				if (!unit) throw new Error("Company folder commit answered no unit");
				return {
					content: { kind: "text", value: mutationText(tool, request, receiptId, unit) },
					folderCommitId: committed.commitId,
					...(unit.outcome === "waiting_for_review" ? { proposed: true as const } : {}),
				};
			},
			signal: context.signal,
			...(context.observation ? { observation: context.observation } : {}),
		});
		// A change of the company's pages and tables shows in the run's conversation, with Undo (Interfaces I10): SQL
		// notes each of the run's commits there once, a replay's too. Its failure is a folder error, never a refusal,
		// so the call is unconfirmed: the same call again notes it.
		if (
			[request.path, request.to ?? ""].some((path) =>
				/^(?:interfaces|tables)\//.test(osRelative(companyPathKey(path)) ?? ""),
			)
		)
			await folder.noteInterfaceChanges(context.signal);
		return content;
	};

	const tools: CloudNativeTool[] = [
		{
			name: "company_read" satisfies CloudRuntimeToolOperation,
			source: "company_file",
			images: true,
			description: [
				`Read the company folder by company paths: a file's UTF-8 text, or the target a link names (not followed), from offset (in bytes, 0 by default), up to limit bytes (at most ${MAX_READ_BYTES}, the default) a call, as much as fits one result: continue from nextOffset until it is null. A path that is a folder, or absent, says so. A file's version is what a change of it names.`,
				`A PNG, JPEG, GIF or WebP image read from offset 0 is shown to you after the answer, at most ${SHOWN_MAX_WIDTH}×${SHOWN_MAX_HEIGHT} pixels.`,
				`paths (up to ${MAX_PATHS}) in place of path reads several files at once into one result (plain path strings, or { path, startLine?, endLine? } objects for 1-based line ranges of text files): small files whole, the rest sharing the room alike, each with its own version and nextOffset (read on with path and offset); an image there is named, not shown.`,
			].join("\n"),
			inputSchema: {
				type: "object",
				additionalProperties: false,
				properties: {
					path: pathSchema,
					paths: {
						type: "array",
						minItems: 1,
						maxItems: MAX_PATHS,
						items: {
							anyOf: [
								pathSchema,
								{
									type: "object",
									additionalProperties: false,
									required: ["path"],
									properties: {
										path: pathSchema,
										startLine: { type: "integer", minimum: 1, maximum: MAX_LINE_NUMBER },
										endLine: { type: "integer", minimum: 1, maximum: MAX_LINE_NUMBER },
									},
								},
							],
						},
					},
					offset: { type: "integer", minimum: 0 },
					limit: { type: "integer", minimum: 4, maximum: MAX_READ_BYTES },
				},
			},
			parseArguments(value): JsonValue {
				const input = someArgs(value, "company_read", [], ["path", "paths", "offset", "limit"]);
				if ((input.path === undefined) === (input.paths === undefined))
					throw new CloudToolArgumentRefusal("company_read takes path, or paths to read several files at once");
				if (input.paths !== undefined) {
					if (input.offset !== undefined || input.limit !== undefined)
						throw new CloudToolArgumentRefusal(
							"offset and limit go with path: paths reads each file from its start; read on with path and offset",
						);
					if (!Array.isArray(input.paths) || input.paths.length < 1 || input.paths.length > MAX_PATHS)
						throw new CloudToolArgumentRefusal(`paths must be a list of 1 to ${MAX_PATHS} company paths`);
					const seen = new Set<string>();
					const paths: JsonValue[] = [];
					for (const item of input.paths) {
						if (typeof item === "string") {
							const validated = path(item, false);
							const dedupeKey = `${folderKey(validated)}\0\0`;
							if (seen.has(dedupeKey)) throw new CloudToolArgumentRefusal("paths must name each file once");
							seen.add(dedupeKey);
							paths.push(validated);
							continue;
						}
						if (item !== null && typeof item === "object" && !Array.isArray(item)) {
							const entry = someArgs(item, "company_read paths entry", ["path"], ["startLine", "endLine"]);
							const validated = path(entry.path, false);
							const startLine =
								entry.startLine === undefined
									? undefined
									: integer(entry.startLine, "startLine", 1, MAX_LINE_NUMBER);
							const endLine =
								entry.endLine === undefined ? undefined : integer(entry.endLine, "endLine", 1, MAX_LINE_NUMBER);
							if (startLine !== undefined && endLine !== undefined && endLine < startLine)
								throw new CloudToolArgumentRefusal("endLine must be greater than or equal to startLine");
							const dedupeKey = `${folderKey(validated)}\0${startLine ?? ""}\0${endLine ?? ""}`;
							if (seen.has(dedupeKey))
								throw new CloudToolArgumentRefusal("paths must name each file or range once");
							seen.add(dedupeKey);
							if (startLine === undefined && endLine === undefined) paths.push(validated);
							else
								paths.push({
									path: validated,
									...(startLine !== undefined ? { startLine } : {}),
									...(endLine !== undefined ? { endLine } : {}),
								});
							continue;
						}
						throw new CloudToolArgumentRefusal(
							"paths items must be company paths or { path, startLine?, endLine? }",
						);
					}
					return { paths };
				}
				return {
					path: path(input.path, false),
					offset: input.offset === undefined ? 0 : integer(input.offset, "offset", 0, 256 * 1024 * 1024),
					limit: input.limit === undefined ? MAX_READ_BYTES : integer(input.limit, "limit", 4, MAX_READ_BYTES),
				};
			},
			async execute(value, context) {
				if (Array.isArray((value as { paths?: unknown }).paths))
					return readMany((value as { paths: PathReadTarget[] }).paths, context);
				const input = value as { path: string; offset: number; limit: number };
				const entry = await read(input.path, "read", context.signal);
				if (!entry)
					return released(
						folder,
						identity.runId,
						context,
						cloudToolJsonText({ path: input.path, kind: "absent", version: null }),
						[],
					);
				if (entry.kind === "folder")
					return released(
						folder,
						identity.runId,
						context,
						cloudToolJsonText({ path: entry.path, kind: "folder", version: entry.version }),
						[cloudCompanyFolderRelease(entry)],
					);
				// A link's target is what it holds: shown as written, never followed, in windows as a file's text is (escaped,
				// 4,095 bytes of it can pass one tool result).
				if (entry.kind === "symlink") {
					const whole = Buffer.from(entry.target, "utf8");
					const window = whole.subarray(input.offset, input.offset + input.limit);
					const text = windowText(window, input.offset + window.byteLength >= whole.byteLength);
					if (text === null)
						throw new CloudToolRefusal(
							"COMPANY_FILE_NOT_TEXT: this offset is inside a character of the link's target; read from an offset a window gave",
						);
					// The whole target is in hand: a window of it neither starts nor ends inside a secret either.
					const after = whole.subarray(input.offset + Buffer.byteLength(text)).toString("utf8");
					const lead = windowLead(whole.subarray(0, input.offset).toString("utf8"), text + after);
					const start = input.offset - Buffer.byteLength(lead);
					const around = lead + text + after;
					const secrets = cloudSecretSpans(around);
					const render = (room: string) => {
						const shown = around.slice(0, windowEnd(around, room.length, false, secrets).end);
						const included = Buffer.byteLength(shown);
						return cloudToolJsonText({
							path: entry.path,
							kind: "symlink",
							version: entry.version,
							offset: start,
							bytesRead: included,
							totalBytes: whole.byteLength,
							target: shown,
							nextOffset: start + included < whole.byteLength ? start + included : null,
						});
					};
					return released(
						folder,
						identity.runId,
						context,
						fitted(lead + text, 1, (room) => redactCloudWebhookSecrets(render(room))),
						[cloudCompanyFolderRelease(entry)],
					);
				}
				// An offset at or past the end reads an empty window, which still shows the file's size and version. The read
				// takes SECRET_MARGIN bytes before the window and after it too, so that the window neither starts nor ends
				// inside a secret (windowLead, windowEnd).
				const total = entry.file.bytes;
				const { mediaType } = entry.file;
				if (
					input.offset === 0 &&
					total <= MAX_FOLDER_IMAGE_BYTES &&
					["image/png", "image/jpeg", "image/gif", "image/webp"].includes(mediaType)
				) {
					const single = await oneImageAtATime(context.signal, async () => {
						let raw: Uint8Array;
						try {
							raw = await folder.readRange(entry, 0, total, context.signal);
						} catch (error) {
							return unavailable(error, "read");
						}
						if (!folderImageFormat(raw)) return { raw };
						try {
							return { view: folderImageView(raw) };
						} catch (error) {
							if (!(error instanceof FolderImageRefusal)) throw error;
							throw new CloudToolRefusal(
								`${error.reason === "too_large" ? "COMPANY_IMAGE_TOO_LARGE" : "COMPANY_IMAGE_UNREADABLE"}: ${error.message}; open it on a machine`,
							);
						}
					});
					if ("view" in single && single.view) {
						const { view } = single;
						const text = cloudToolJsonText({
							path: entry.path,
							kind: "image",
							version: entry.version,
							mediaType: `image/${view.format}`,
							totalBytes: total,
							width: view.width,
							height: view.height,
							shownWidth: view.shownWidth,
							shownHeight: view.shownHeight,
							imageSha256: view.sha256,
						});
						const content = await released(folder, identity.runId, context, text, [
							cloudCompanyFolderRelease(entry),
						]);
						return { ...content, image: { png: view.png, sha256: view.sha256 } };
					}
					const other = otherImageFormat(single.raw);
					if (other === undefined)
						throw new CloudToolRefusal(
							"COMPANY_IMAGE_UNREADABLE: the file is not the image its type says; open it on a machine",
						);
					throw new CloudToolRefusal(
						`COMPANY_IMAGE_FORMAT_UNSUPPORTED: only PNG, JPEG, GIF and WebP images are shown here, and this one is ${other}; open it on a machine`,
					);
				}
				const behind = Math.min(SECRET_MARGIN, input.offset);
				let bytes: Uint8Array;
				try {
					const head =
						input.offset === 0
							? Math.max(input.limit + SECRET_MARGIN, IMAGE_HEAD_BYTES)
							: input.limit + SECRET_MARGIN;
					bytes = await folder.readRange(entry, input.offset - behind, behind + head, context.signal);
				} catch (error) {
					return unavailable(error, "read");
				}
				// An image read from its start is shown as an image (chat images PR3), or refused by name.
				if (input.offset === 0) {
					if (folderImageFormat(bytes))
						return showImage(entry, context, bytes.byteLength >= total ? bytes : undefined);
					// Its own start names the format; a media type of an image (SVG is text) says it is one in another format.
					const other = otherImageFormat(bytes);
					if (other === undefined && ["image/png", "image/jpeg", "image/gif", "image/webp"].includes(mediaType))
						throw new CloudToolRefusal(
							"COMPANY_IMAGE_UNREADABLE: the file is not the image its type says; open it on a machine",
						);
					if (other !== undefined || (mediaType.startsWith("image/") && mediaType !== "image/svg+xml"))
						throw new CloudToolRefusal(
							`COMPANY_IMAGE_FORMAT_UNSUPPORTED: only PNG, JPEG, GIF and WebP images are shown here${other ? `, and this one is ${other}` : ""}; open it on a machine`,
						);
				}
				const window = bytes.subarray(behind, behind + input.limit);
				const atEnd = input.offset + window.byteLength >= total;
				const text = windowText(window, atEnd);
				if (text === null)
					throw new CloudToolRefusal(
						"COMPANY_FILE_NOT_TEXT: this file, or this offset, is not UTF-8 text; open such files on a machine",
					);
				const after = AROUND.decode(bytes.subarray(behind + Buffer.byteLength(text)));
				const lead = behind === 0 ? "" : windowLead(AROUND.decode(bytes.subarray(0, behind)), text + after);
				const start = input.offset - Buffer.byteLength(lead);
				const around = lead + text + after;
				const more = input.offset - behind + bytes.byteLength < total;
				const secrets = cloudSecretSpans(around);
				const render = (room: string) => {
					const { end, runsOn } = windowEnd(around, room.length, more, secrets);
					const shown = around.slice(0, end);
					const included = Buffer.byteLength(shown);
					return cloudToolJsonText({
						path: entry.path,
						kind: "file",
						version: entry.version,
						offset: start,
						bytesRead: included,
						totalBytes: total,
						text: shown,
						nextOffset: start + included < total ? start + included : null,
						...(runsOn ? { secretRun: secretRunsOn(start) } : {}),
					});
				};
				// The window, cut at a code point so that its answer reaches the model whole (escaping can grow it, the
				// boundary's cut of a secret shortens it: the fit is of the answer as the model is shown it).
				return released(
					folder,
					identity.runId,
					context,
					fitted(lead + text, 1, (room) => redactCloudWebhookSecrets(render(room))),
					[cloudCompanyFolderRelease(entry)],
				);
			},
		},
		{
			name: "company_list" satisfies CloudRuntimeToolOperation,
			source: "company_file",
			description: [
				`List what you may read in the folder at path (empty for the top), down to depth levels (1 to ${MAX_DEPTH}; 1 by default, ${MAX_DEPTH} with a glob): use depth to see a folder's whole tree in one call. glob keeps only paths like it (* and ? within a name, ** across folders, not case-sensitive; without a / it matches names alone: *.md, specs/**/*.csv).`,
				`Up to limit entries a call (1 to ${MAX_LIST}, ${MAX_LIST} by default), one a line: a file as its path, a tab and its size in bytes; a folder as its path and /; a link as its path, a tab and -> what it names (its first ${LIST_TARGET_BYTES} bytes; company_read shows all). When there is more, the answer says so and gives after to call again with.`,
				"A file's version comes from company_read; a folder's move takes the listing's asOfSeq.",
			].join("\n"),
			inputSchema: {
				type: "object",
				additionalProperties: false,
				required: ["path"],
				properties: {
					path: pathSchema,
					depth: { type: "integer", minimum: 1, maximum: MAX_DEPTH },
					glob: { type: "string", minLength: 1, maxLength: MAX_GLOB },
					after: { type: ["string", "null"], maxLength: 4096 },
					limit: { type: "integer", minimum: 1, maximum: MAX_LIST },
				},
			},
			parseArguments(value) {
				const input = someArgs(value, "company_list", ["path"], ["depth", "glob", "after", "limit"]);
				let after: string | null = null;
				if (input.after !== undefined && input.after !== null) {
					try {
						after = parseCloudCompanyPath(input.after as string);
					} catch {
						throw new CloudToolArgumentRefusal("after must be null, or the after value a listing gave");
					}
				}
				let glob: string | null = null;
				if (input.glob !== undefined) {
					if (
						typeof input.glob !== "string" ||
						input.glob.length === 0 ||
						input.glob.length > MAX_GLOB ||
						/[\u0000-\u001f\u007f]/.test(input.glob)
					)
						throw new CloudToolArgumentRefusal(`glob must be text of 1 to ${MAX_GLOB} characters, on one line`);
					glob = input.glob;
				}
				return {
					path: path(input.path, true),
					depth:
						input.depth === undefined
							? glob === null
								? 1
								: MAX_DEPTH
							: integer(input.depth, "depth", 1, MAX_DEPTH),
					glob,
					after,
					limit: input.limit === undefined ? MAX_LIST : integer(input.limit, "limit", 1, MAX_LIST),
				};
			},
			async execute(value, context) {
				const input = value as {
					path: string;
					depth: number;
					glob: string | null;
					after: string | null;
					limit: number;
				};
				let parent: CloudCompanyFolderEntry | null = null;
				if (input.path !== "") {
					parent = await read(input.path, "listed", context.signal);
					if (!parent)
						return released(
							folder,
							identity.runId,
							context,
							`${input.path}: absent; nothing is there that you may read.`,
							[],
						);
					if (parent.kind !== "folder")
						throw new CloudToolRefusal(
							`COMPANY_FILE_NOT_A_FOLDER: that path is a ${parent.kind === "file" ? "file" : "link"}; read it with company_read`,
						);
				}
				// The folder core's pages in key order: one level, or the whole subtree for a depth past 1, filtered here by
				// depth and glob. One more entry than is shown proves there is more; a look that went through its bound
				// stops with the last entry it looked at.
				const levels = input.path === "" ? 0 : input.path.split("/").length;
				const glob = input.glob === null ? null : compileGlob(input.glob);
				const begun = performance.now();
				const look = async (): Promise<ListLook> => {
					const looked: CloudCompanyFolderEntry[] = [];
					const matched: CloudCompanyFolderEntry[] = [];
					let asOfSeq = -1;
					let steady = true;
					let after = input.after;
					const started = performance.now();
					scan: for (;;) {
						let page: Awaited<ReturnType<CloudCompanyFolderClient["list"]>>;
						try {
							page = await folder.list(
								input.path,
								{ ...(after === null ? {} : { after }), recursive: input.depth > 1 },
								context.signal,
							);
						} catch (error) {
							return unavailable(error, "listed");
						}
						// The folder clock of the look's first page: a change after it stops a folder's move, even one a
						// later page shows (listAll's rule). A later page at another clock may have met a change.
						if (asOfSeq < 0) asOfSeq = page.asOfSeq;
						else if (page.asOfSeq !== asOfSeq) steady = false;
						for (const entry of page.entries) {
							looked.push(entry);
							const names = entry.path.split("/");
							if (names.length - levels > input.depth) continue;
							if (glob && !globMatches(glob, folderKey(names.slice(levels).join("/")))) continue;
							matched.push(entry);
							if (matched.length > input.limit) break scan;
						}
						if (page.next === null) return { looked, matched, asOfSeq, steady, ended: true };
						after = page.next;
						const now = performance.now();
						if (
							looked.length >= LIST_SCAN_ENTRIES ||
							now - started >= LIST_SCAN_MS ||
							now - begun >= LIST_CALL_MS
						)
							break;
					}
					return { looked, matched, asOfSeq, steady, ended: false };
				};
				// One answer is one moment of the folder. A look whose pages answered at different clocks may have met a
				// change between two of them (a rename then shows a path twice, or not at all), so the call looks again,
				// and answers with a look whose pages answered at one clock. The clock is the company's whole folder's, so
				// a change elsewhere costs a look too: two looks that read the same are no proof (a file renamed back and
				// forth in step with the pages is missed alike by both; review r1 of #1748). If no look was one moment,
				// the answer says so (owed from v240, 13 November 2026).
				let listed = await look();
				for (let looks = 1; !listed.steady && looks < LIST_LOOKS; looks++) {
					if (performance.now() - begun >= LIST_CALL_MS) break;
					listed = await look();
				}
				const settled = listed.steady;
				const { matched, asOfSeq, ended } = listed;
				const looked = listed.looked.length;
				const last = listed.looked.at(-1);
				// A target shown in part never ends inside a secret: before it, or past it whole (windowEnd).
				const shownTo = (whole: string, room: string) => {
					const shown = whole.slice(0, windowEnd(whole, room.length, false).end);
					return `-> ${JSON.stringify(shown)}${shown.length < whole.length ? " (cut; company_read shows all)" : ""}`;
				};
				const line = (entry: CloudCompanyFolderEntry, target?: string): string =>
					entry.kind === "folder"
						? `${entry.path}/`
						: entry.kind === "file"
							? `${entry.path}\t${entry.file.bytes}`
							: `${entry.path}\t${shownTo(entry.target, target ?? head(entry.target, LIST_TARGET_BYTES))}`;
				const header = `${input.path === "" ? "The top of the company folder" : `${input.path}/ (version ${parent?.version})`}, asOfSeq ${asOfSeq}, depth ${input.depth}${input.glob === null ? "" : `, glob ${JSON.stringify(input.glob)}`}:`;
				// What is said after the lines shown: there is more after the last one shown, none, or perhaps more after the
				// last entry looked at, which the answer then shows (and releases) too.
				const ending = (count: number): string => {
					const shown = count === 0 ? "No entries" : `${count} ${count === 1 ? "entry" : "entries"}`;
					if (count < matched.length)
						return `${shown} shown. More: call again with after ${JSON.stringify(matched[count - 1]?.path)}.`;
					if (ended || !last) return `${shown}. Nothing more.`;
					return `${shown} shown, ${looked} looked through. More may follow: call again with after ${JSON.stringify(last.path)}.`;
				};
				const render = (count: number, first?: string): string =>
					[
						header,
						...matched.slice(0, count).map((entry, index) => line(entry, index === 0 ? first : undefined)),
						"",
						...(settled ? [] : [CHANGED_WHILE_LISTED]),
						ending(count),
					].join("\n");
				// As many entries as fit one result (the longest start that fits, found by halving); at least one. A first
				// link whose target, escaped at worst, still passes one result shows less of it: only a path makes an
				// answer too long to show.
				let count = Math.min(matched.length, input.limit, 1);
				let output = render(count);
				const first = matched[0];
				if (first?.kind === "symlink" && !fitsOneResult(output))
					output = fitted(head(first.target, LIST_TARGET_BYTES), 0, (shown) => render(1, shown));
				else if (count > 0) {
					let high = Math.min(matched.length, input.limit);
					while (count < high) {
						const middle = Math.ceil((count + high) / 2);
						if (fitsOneResult(render(middle))) count = middle;
						else high = middle - 1;
					}
					output = render(count);
				}
				const shown = matched.slice(0, count);
				const named =
					count === matched.length && !ended && last && !shown.includes(last)
						? [cloudCompanyFolderRelease(last)]
						: [];
				return released(folder, identity.runId, context, output, [
					...(parent ? [cloudCompanyFolderRelease(parent)] : []),
					...shown.map(cloudCompanyFolderRelease),
					...named,
				]);
			},
		},
		{
			name: "company_write" satisfies CloudRuntimeToolOperation,
			source: "company_file",
			maxArgumentBytes: MAX_TOOL_ARGUMENT_BYTES,
			description: `Write UTF-8 text (up to ${MAX_WRITE_BYTES / 1024} KiB, as much as one call carries; less where characters need escaping) to one file of the company folder, such as a page, a document or a self-contained HTML prototype; to change part of a long file, use company_edit. Read it first and give its version as expectedVersion, or null to create a file that does not exist. The folder it goes in must exist (make it with company_mkdir). The result's state is applied only when it was written.`,
			inputSchema: {
				type: "object",
				additionalProperties: false,
				required: ["path", "operationKey", "expectedVersion", "text"],
				properties: {
					path: pathSchema,
					operationKey: { type: "string", pattern: OPERATION_KEY.source },
					expectedVersion: nullableVersion,
					text: { type: "string", maxLength: MAX_WRITE_BYTES },
				},
			},
			parseArguments(value) {
				const input = args(value, "company_write", ["path", "operationKey", "expectedVersion", "text"]);
				if (typeof input.text !== "string" || Buffer.byteLength(input.text) > MAX_WRITE_BYTES)
					throw new CloudToolArgumentRefusal(`text must be UTF-8 text of at most ${MAX_WRITE_BYTES} bytes`);
				return {
					path: path(input.path, false),
					operationKey: operationKey(input.operationKey),
					expectedVersion: version(input.expectedVersion, true),
					text: input.text,
				};
			},
			refused: cloudFolderRefusal,
			async execute(value, context) {
				const input = value as { path: string; operationKey: string; expectedVersion: string | null; text: string };
				context.observation?.update({ inputBytes: Buffer.byteLength(input.text) });
				enforceSurfaceFilePolicy(surfaceFilePolicy, input.path);
				await refuseRetiredPath(folder, input.path, context.signal, "written");
				// A change of a file keeps its media type and executable bit (a script stays runnable). Read before the receipt
				// and changing nothing: a file at another version makes the commit a conflict anyway.
				const current = input.expectedVersion === null ? null : await read(input.path, "written", context.signal);
				// The core would make the link a file at its version: a write never replaces a link the model may take for
				// the file it names. Nothing is written and no receipt is taken; the answer names the link's target, a read
				// of the link released as company_read's is.
				if (current?.kind === "symlink" && current.version === input.expectedVersion) {
					const link = current;
					const render = (shown: string) =>
						cloudToolJsonText({
							schema: "qorpera.company-folder-result/v1",
							state: "not_applied",
							operationKey: input.operationKey,
							path: link.path,
							version: null,
							reason: "link",
							...shownTarget(link.target, shown),
							next: `COMPANY_FILE_IS_A_LINK: nothing was written; that path is a link, and company_write never follows or replaces one. Write the file its target names (relative to the link's folder unless it starts with /), or delete the link first and write a new file in its place.${shown === link.target ? "" : " Only the target's start is shown: read the link with company_read for all of it."}`,
						});
					return released(folder, identity.runId, context, fitted(link.target, 0, render), [
						cloudCompanyFolderRelease(link),
					]);
				}
				const kept =
					current?.kind === "file" && current.version === input.expectedVersion
						? { mediaType: current.file.mediaType, executable: current.file.executable }
						: {};
				await appGuard(input.path, isAppManifestPath(input.path) ? input.text : null, context.signal);
				wallCheck(input.path, input.text);
				return change(
					"company_write",
					input,
					{
						path: input.path,
						expectedVersion: input.expectedVersion,
						textSha256: createHash("sha256").update(input.text, "utf8").digest("hex"),
					},
					[
						{
							op: "write",
							path: input.path,
							content: { text: input.text, ...kept },
							...(input.expectedVersion === null ? {} : { expectedVersion: input.expectedVersion }),
						},
					],
					context,
				);
			},
		},
		{
			name: "company_edit" satisfies CloudRuntimeToolOperation,
			source: "company_file",
			maxArgumentBytes: MAX_TOOL_ARGUMENT_BYTES,
			description: `Change part of one file of the company folder instead of writing it whole again: replace oldText, which occurs exactly once in the file at expectedVersion (the version company_read reported), with newText (empty to remove it). Copy oldText exactly, spaces and line breaks included, with enough around it to be unique. The file is UTF-8 text of at most ${MAX_WRITE_BYTES / 1024} KiB before and after. Not found, or found more than once, writes nothing: read the file and give a span that occurs once. The result's state is applied only when it was written.`,
			inputSchema: {
				type: "object",
				additionalProperties: false,
				required: ["path", "operationKey", "expectedVersion", "oldText", "newText"],
				properties: {
					path: pathSchema,
					operationKey: { type: "string", pattern: OPERATION_KEY.source },
					expectedVersion: { type: "string", pattern: UUID_PATTERN.source },
					oldText: { type: "string", minLength: 1, maxLength: MAX_WRITE_BYTES },
					newText: { type: "string", maxLength: MAX_WRITE_BYTES },
				},
			},
			parseArguments(value) {
				const input = args(value, "company_edit", [
					"path",
					"operationKey",
					"expectedVersion",
					"oldText",
					"newText",
				]);
				for (const [label, text] of [
					["oldText", input.oldText],
					["newText", input.newText],
				] as const)
					if (typeof text !== "string" || Buffer.byteLength(text) > MAX_WRITE_BYTES || !text.isWellFormed())
						throw new CloudToolArgumentRefusal(`${label} must be UTF-8 text of at most ${MAX_WRITE_BYTES} bytes`);
				if (input.oldText === "") throw new CloudToolArgumentRefusal("oldText must name the text to replace");
				if (input.oldText === input.newText) throw new CloudToolArgumentRefusal("newText must differ from oldText");
				return {
					path: path(input.path, false),
					operationKey: operationKey(input.operationKey),
					expectedVersion: version(input.expectedVersion, false),
					oldText: input.oldText as string,
					newText: input.newText as string,
				};
			},
			refused: cloudFolderRefusal,
			async execute(value, context) {
				const input = value as {
					path: string;
					operationKey: string;
					expectedVersion: string;
					oldText: string;
					newText: string;
				};
				context.observation?.update({
					inputBytes: Buffer.byteLength(input.oldText) + Buffer.byteLength(input.newText),
				});
				const target = {
					path: input.path,
					expectedVersion: input.expectedVersion,
					oldTextSha256: createHash("sha256").update(input.oldText, "utf8").digest("hex"),
					newTextSha256: createHash("sha256").update(input.newText, "utf8").digest("hex"),
				};
				if (surfaceFilePolicy?.mode === "surface_worker") {
					enforceSurfaceFilePolicy(surfaceFilePolicy, input.path);
				}
				await refuseRetiredPath(folder, input.path, context.signal, "edited");
				// The edit is made on the file's text at the version the model read. Another version (this call's own saved
				// edit included, so a replay reaches its receipt), or nothing at the path, is the folder core's conflict:
				// the write names the model's version and saves nothing.
				const current = await read(input.path, "edited", context.signal);
				if (current?.version !== input.expectedVersion)
					return change(
						"company_edit",
						input,
						target,
						[{ op: "write", path: input.path, content: { text: "" }, expectedVersion: input.expectedVersion }],
						context,
					);
				if (current.kind !== "file")
					throw new CloudToolRefusal(
						`COMPANY_FILE_NOT_A_FILE: that path is a ${current.kind === "folder" ? "folder" : "link"}; company_edit changes a file's text`,
					);
				if (current.file.bytes > MAX_WRITE_BYTES)
					throw new CloudToolRefusal(
						`COMPANY_FILE_TOO_LARGE: company_edit changes files of at most ${MAX_WRITE_BYTES / 1024} KiB; change this one on a machine`,
					);
				let bytes: Uint8Array;
				try {
					bytes = await folder.readRange(current, 0, current.file.bytes, context.signal);
				} catch (error) {
					return unavailable(error, "edited");
				}
				const text = windowText(bytes, true);
				if (text === null || Buffer.byteLength(text) !== bytes.byteLength)
					throw new CloudToolRefusal("COMPANY_FILE_NOT_TEXT: this file is not UTF-8 text; change it on a machine");
				const at = text.indexOf(input.oldText);
				if (at < 0)
					throw new CloudToolRefusal(
						"COMPANY_EDIT_NOT_FOUND: oldText is not in the file at this version, so nothing was written. Read the file and copy the exact text, spaces and line breaks included.",
					);
				if (text.indexOf(input.oldText, at + 1) >= 0)
					throw new CloudToolRefusal(
						"COMPANY_EDIT_NOT_UNIQUE: oldText occurs more than once in the file, so nothing was written. Give a longer span that occurs once.",
					);
				const edited = text.slice(0, at) + input.newText + text.slice(at + input.oldText.length);
				if (Buffer.byteLength(edited) > MAX_WRITE_BYTES)
					throw new CloudToolRefusal(
						`COMPANY_FILE_TOO_LARGE: the edited file would be larger than ${MAX_WRITE_BYTES / 1024} KiB; nothing was written`,
					);
				await appGuard(input.path, isAppManifestPath(input.path) ? edited : null, context.signal);
				wallCheck(input.path, edited);
				return change(
					"company_edit",
					input,
					target,
					[
						{
							op: "write",
							path: input.path,
							// A change of a file keeps its media type and executable bit, as company_write's does.
							content: { text: edited, mediaType: current.file.mediaType, executable: current.file.executable },
							expectedVersion: input.expectedVersion,
						},
					],
					context,
				);
			},
		},
		{
			name: "company_move" satisfies CloudRuntimeToolOperation,
			source: "company_file",
			description:
				"Move or rename one file, link or folder of the company folder (a folder moves with everything in it). from is where it is now, to is its new path: nothing may be there yet (a change of letter case alone is fine), and the folder it goes in must exist. Read from first and give its version as expectedVersion. For a folder, list it with company_list first and give that listing's asOfSeq (its first page's): a change in the folder after it stops the move; for a file or a link, asOfSeq is null. A move needs the automatic review's approval of this call, as a deletion does. Links and mentions of the old path in other files stay as they are.",
			inputSchema: {
				type: "object",
				additionalProperties: false,
				required: ["from", "to", "operationKey", "expectedVersion", "asOfSeq"],
				properties: {
					from: pathSchema,
					to: pathSchema,
					operationKey: { type: "string", pattern: OPERATION_KEY.source },
					expectedVersion: { type: "string", pattern: UUID_PATTERN.source },
					asOfSeq: { type: ["integer", "null"], minimum: 0 },
				},
			},
			parseArguments(value) {
				const input = args(value, "company_move", ["from", "to", "operationKey", "expectedVersion", "asOfSeq"]);
				const from = path(input.from, false);
				const to = path(input.to, false);
				if (from === to) throw new CloudToolArgumentRefusal("to must differ from from");
				return {
					from,
					to,
					operationKey: operationKey(input.operationKey),
					expectedVersion: version(input.expectedVersion, false),
					asOfSeq:
						input.asOfSeq === null
							? null
							: integer(input.asOfSeq, "asOfSeq (null for a file or a link)", 0, Number.MAX_SAFE_INTEGER),
				};
			},
			refused: cloudFolderRefusal,
			async execute(value, context) {
				const input = value as {
					from: string;
					to: string;
					operationKey: string;
					expectedVersion: string;
					asOfSeq: number | null;
				};
				const review = context.actionReviewId;
				if (!review)
					throw new CloudToolRefusal(
						"A move needs the automatic review's approval of this call, and it has none: call again, and if this repeats tell the member",
					);
				enforceSurfaceFilePolicy(surfaceFilePolicy, input.to);
				if (surfaceFilePolicy?.mode === "surface_worker") {
					enforceSurfaceFilePolicy(surfaceFilePolicy, input.from);
				}
				// A retired interface, and the members' list of them, are the members' alone, from either end of a move.
				await refuseRetiredMove(folder, input.from, input.to, context.signal);
				// An app comes into apps/ only through save_app, so its manifest is checked (who owns it, whether it is
				// posted): a folder or a manifest moved in from elsewhere is refused. Files moved into an app are its files.
				const into = appPath(input.to);
				if (into && appPath(input.from) === null) {
					const moving = await read(input.from, "moved", context.signal);
					if (into.inner === "" || moving?.kind === "folder" || isAppManifestPath(input.to))
						throw new CloudToolRefusal(
							"APP_MOVE_REFUSED: nothing was moved; make an app with save_app, which checks its manifest, and copy its files in there",
						);
					await appGuard(input.to, null, context.signal);
				}
				// A folder moves as of the model's own listing of it, which its call and review carry: the core refuses a
				// change under it since. Checked before the receipt, and passed once this call's own move is saved (the path
				// is then gone), so a replay of the call reaches its receipt.
				const entry = await read(input.from, "moved", context.signal);
				if (entry?.kind === "folder" && input.asOfSeq === null)
					throw new CloudToolRefusal(
						"COMPANY_MOVE_NEEDS_LISTING: that path is a folder; list it with company_list and give that listing's asOfSeq",
					);
				return change(
					"company_move",
					{ operationKey: input.operationKey, path: input.from, to: input.to },
					{ from: input.from, to: input.to, expectedVersion: input.expectedVersion, asOfSeq: input.asOfSeq },
					[
						{
							op: "move",
							from: input.from,
							to: input.to,
							expectedVersion: input.expectedVersion,
							...(entry?.kind === "folder" && input.asOfSeq !== null ? { asOfSeq: input.asOfSeq } : {}),
						},
					],
					context,
					review,
				);
			},
		},
		{
			name: "company_mkdir" satisfies CloudRuntimeToolOperation,
			source: "company_file",
			description:
				"Create one folder in the company folder: an area of the business when its first file arrives (sales/), a subfolder by kind in a crowded area (sales/proposals/), a folder for one project in its area, or a folder a member or your assignment names. Name it in lowercase words joined by hyphens. expectedVersion is null. The folder it goes in must exist: create missing folders outermost first.",
			inputSchema: {
				type: "object",
				additionalProperties: false,
				required: ["path", "operationKey", "expectedVersion"],
				properties: {
					path: pathSchema,
					operationKey: { type: "string", pattern: OPERATION_KEY.source },
					expectedVersion: { type: "null" },
				},
			},
			parseArguments(value) {
				const input = args(value, "company_mkdir", ["path", "operationKey", "expectedVersion"]);
				if (input.expectedVersion !== null)
					throw new CloudToolArgumentRefusal(
						"expectedVersion is null: company_mkdir only creates a folder that does not exist yet",
					);
				return { path: path(input.path, false), operationKey: operationKey(input.operationKey) };
			},
			refused: cloudFolderRefusal,
			async execute(value, context) {
				const input = value as { path: string; operationKey: string };
				enforceSurfaceFilePolicy(surfaceFilePolicy, input.path);
				await refuseRetiredPath(folder, input.path, context.signal, "written");
				return change("company_mkdir", input, { path: input.path }, [{ op: "mkdir", path: input.path }], context);
			},
		},
		{
			name: "company_delete" satisfies CloudRuntimeToolOperation,
			source: "company_file",
			description:
				"Delete one file, one link (never what it names) or one empty folder of the company folder. Read it first and give its version as expectedVersion.",
			inputSchema: {
				type: "object",
				additionalProperties: false,
				required: ["path", "operationKey", "expectedVersion"],
				properties: {
					path: pathSchema,
					operationKey: { type: "string", pattern: OPERATION_KEY.source },
					expectedVersion: { type: "string", pattern: UUID_PATTERN.source },
				},
			},
			parseArguments(value) {
				const input = args(value, "company_delete", ["path", "operationKey", "expectedVersion"]);
				return {
					path: path(input.path, false),
					operationKey: operationKey(input.operationKey),
					expectedVersion: version(input.expectedVersion, false),
				};
			},
			refused: cloudFolderRefusal,
			async execute(value, context) {
				const input = value as { path: string; operationKey: string; expectedVersion: string };
				const review = context.actionReviewId;
				if (!review)
					throw new CloudToolRefusal(
						"A deletion needs the automatic review's approval of this call, and it has none: call again, and if this repeats tell the member",
					);
				if (surfaceFilePolicy?.mode === "surface_worker") {
					enforceSurfaceFilePolicy(surfaceFilePolicy, input.path);
				}
				await refuseRetiredPath(folder, input.path, context.signal, "deleted");
				// Checked before the receipt, and still true once this call's own deletion is saved (the path is then gone),
				// so a replay of the call reaches its receipt: only an empty folder is deleted, as of the listing that
				// found it empty (a change under it after that is a conflict).
				let asOfSeq: number | undefined;
				const entry = await read(input.path, "deleted", context.signal);
				if (entry?.kind === "folder") {
					let page: Awaited<ReturnType<CloudCompanyFolderClient["list"]>>;
					try {
						page = await folder.list(input.path, { limit: 1 }, context.signal);
					} catch (error) {
						return unavailable(error, "deleted");
					}
					if (page.entries.length > 0)
						throw new CloudToolRefusal(
							"COMPANY_FOLDER_NOT_EMPTY: company_delete deletes one file or an empty folder; delete what is in it first",
						);
					asOfSeq = page.asOfSeq;
				}
				return change(
					"company_delete",
					input,
					{ path: input.path, expectedVersion: input.expectedVersion },
					[
						{
							op: "delete",
							path: input.path,
							expectedVersion: input.expectedVersion,
							...(asOfSeq === undefined ? {} : { asOfSeq }),
						},
					],
					context,
					review,
				);
			},
		},
	];
	return tools;
}
