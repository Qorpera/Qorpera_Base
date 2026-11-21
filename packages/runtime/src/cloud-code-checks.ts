import { createHash } from "node:crypto";
import {
	type CloudCodingCommandReceipt,
	type CloudCodingCommandScope,
	type JsonValue,
	parseCloudCodingCommandRead,
	parseCloudCodingCommandReceipt,
} from "@qorpera/contracts";
import type { CloudCodingCommandGateway } from "./cloud-coding-command-tools.ts";
import { CLOUD_COMMAND_PAGE_ASK } from "./cloud-command-page-fit.ts";
import { cloudControlPause } from "./cloud-control-errors.ts";
import { type CloudNativeToolIdentity, cloudToolRequest } from "./cloud-native-tool-authority.ts";
import {
	type CloudToolContent,
	type CloudToolContext,
	cloudToolJsonText,
	redactCloudWebhookSecrets,
} from "./cloud-native-tool-boundary.ts";
import type { CloudNativeToolOperations } from "./cloud-native-tool-operations.ts";
import { SITE_NAME_RULE } from "./cloud-site-tools.ts";
import { fitsOneResult } from "./cloud-worker-tools.ts";

export const MAX_CODE_CHECKS_FILE_BYTES = 16 * 1024;
export const CODE_CHECK_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,39}$/;

const MAX_CODE_CHECKS = 20;
const CODE_CHECK_DEFAULT_SECONDS = 600;
const CODE_CHECK_MIN_SECONDS = 10;
const CODE_CHECK_MAX_SECONDS = 1800;
const CODE_CHECKS_TOTAL_SECONDS = 3600;
const MAX_RUN_BYTES = 4096;
const MAX_CWD_BYTES = 300;
const MAX_SITE_TITLE_CHARS = 120;
const MAX_JSON_DEPTH = 32;
const MAX_TAIL_LINES = 30;
const MAX_TAIL_BYTES = 1500;
const MAX_COMMAND_BYTES = 16384;
const MAX_COMMAND_JSON_BYTES = 60000;
const READ_CHECKS_TIMEOUT_MS = 30_000;
const DEFAULT_POLL_MS = 250;
const MAX_POLL_MS = 1000;
const DEFAULT_TIMEOUT_GRACE_MS = 5000;
const CANCEL_ON_ABORT_MS = 5000;
const TAIL_READ_BYTES = 8192;
const UNKNOWN_KEY_MESSAGE = "This key is not in the checks file's schema.";

const SITE_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{1,46}[a-z0-9]$/;
const RESERVED_SITE_NAMES = new Set(
	"api app www admin assets static qorpera login signin signup robots favicon sites site well-known help support status mail functions auth rest storage realtime objects inbox send screens edge coding noreply staging dev test preview next docs blog news account accounts billing pay payments checkout secure security sso id oauth my dashboard console portal cdn media files download downloads smtp imap pop mx autoconfig autodiscover abuse postmaster hostmaster webmaster ns1 ns2 vpn git code data db ws live screen desktop computer health metrics tunnel gateway relay hooks webhooks events invite invites join team teams company companies members cofounder agent agents chat email webmail calendar ftp m mobile wiki shop store home root system internal private public demo beta".split(
		" ",
	),
);

const JSON_ESCAPES = new Map<string, string>([
	['"', '"'],
	["\\", "\\"],
	["/", "/"],
	["b", "\b"],
	["f", "\f"],
	["n", "\n"],
	["r", "\r"],
	["t", "\t"],
]);
const JSON_LITERALS: readonly [string, boolean | null][] = [
	["true", true],
	["false", false],
	["null", null],
];
const JSON_NUMBER = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;
const LONE_SURROGATE = /[\uD800-\uDFFF]/u;

const READ_CHECKS_COMMAND =
	"if [ ! -e .qorpera/checks.json ] && [ ! -L .qorpera/checks.json ]; then exit 44; fi; if [ -L .qorpera ] || [ -L .qorpera/checks.json ] || [ ! -f .qorpera/checks.json ]; then exit 45; fi; if [ \"$(wc -c < .qorpera/checks.json)\" -gt 16384 ]; then exit 46; fi; if command -v iconv >/dev/null 2>&1; then iconv -f UTF-8 -t UTF-8 -- .qorpera/checks.json >/dev/null 2>&1 || exit 47; elif command -v node >/dev/null 2>&1; then node -e \"new TextDecoder('utf-8',{fatal:true}).decode(require('node:fs').readFileSync('.qorpera/checks.json'))\" >/dev/null 2>&1 || exit 47; fi; cat -- .qorpera/checks.json";

const CHANGE_INDEX_LINE = /^- (\d+) · (\d{4}-\d{2}-\d{2}) · ([^·]+?)(?: · (.*))?$/;
const CHANGE_INDEX_NOTICE =
	/^(?:Put back to an earlier copy|Brought in on|Live:|Ready in What's new:|Preparing for What's new:|Site taken down)/;

export interface CodePreflightCheck {
	readonly name: string;
	readonly run: string;
	readonly timeoutSeconds: number;
	readonly cwd: string;
}

export interface CodePreflightSite {
	readonly folder: string;
	readonly name: string | null;
	readonly title: string | null;
}

export interface CodeChecksProblem {
	readonly at: string;
	readonly code: string;
	readonly message: string;
}

export type ParsedCodeChecks =
	| {
			readonly ok: true;
			readonly checks: readonly CodePreflightCheck[];
			readonly totalTimeoutSeconds: number;
			readonly site: CodePreflightSite | null;
	  }
	| { readonly ok: false; readonly problems: readonly CodeChecksProblem[] };

export interface CodeChangeSummary {
	readonly change: number;
	readonly date: string;
	readonly state: string;
	readonly summary: string;
}

export interface ParsedCodeChangesIndex {
	readonly notices: readonly string[];
	readonly totalListed: number;
	readonly changes: readonly CodeChangeSummary[];
}

export interface CodingPreflightCheckRequest {
	readonly operationKey: string;
	readonly checkNames?: readonly string[];
	readonly failFast: boolean;
}

interface PreflightCheckOutcome {
	readonly name: string;
	readonly cwd: string;
	readonly status: "passed" | "failed" | "cancelled" | "machine_stopped" | "unconfirmed";
	readonly exitCode: number | null;
	readonly timedOut: boolean;
	readonly ms: number;
	readonly commandId: string;
	readonly tail?: string;
}

class ChecksJsonSyntaxError extends Error {
	readonly index: number;

	constructor(index: number, message: string) {
		super(message);
		this.index = index;
	}
}

type Refuse = (at: string, code: string, message: string) => void;

function pointer(at: string, key: string | number): string {
	return `${at}/${String(key).replaceAll("~", "~0").replaceAll("/", "~1")}`;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseChecksJson(text: string): unknown {
	let i = 0;
	const fail = (message: string) => new ChecksJsonSyntaxError(i, message);
	const skipSpace = (): void => {
		for (;;) {
			const c = text[i];
			if (c === " " || c === "\t" || c === "\n" || c === "\r") i++;
			else if (c === "/" && text[i + 1] === "/") {
				while (i < text.length && text[i] !== "\n" && text[i] !== "\r") i++;
			} else if (c === "/" && text[i + 1] === "*") {
				const end = text.indexOf("*/", i + 2);
				if (end < 0) throw fail("A comment is never closed.");
				i = end + 2;
			} else return;
		}
	};
	const readString = (): string => {
		i++;
		let out = "";
		let from = i;
		for (;;) {
			if (i >= text.length) throw fail("A string is never closed.");
			const c = text.charCodeAt(i);
			if (c === 0x22) break;
			if (c < 0x20) throw fail("A string holds a control character; write it as an escape.");
			if (c !== 0x5c) {
				i++;
				continue;
			}
			out += text.slice(from, i);
			const letter = text.charAt(i + 1);
			const simple = JSON_ESCAPES.get(letter);
			if (simple !== undefined) {
				out += simple;
				i += 2;
			} else if (letter === "u" && /^[0-9a-fA-F]{4}$/.test(text.slice(i + 2, i + 6))) {
				out += String.fromCharCode(Number.parseInt(text.slice(i + 2, i + 6), 16));
				i += 6;
			} else throw fail("A string holds an escape JSON doesn't have.");
			from = i;
		}
		out += text.slice(from, i);
		if (LONE_SURROGATE.test(out)) throw fail("A string holds half of a UTF-16 surrogate pair.");
		i++;
		return out;
	};
	const readValue = (depth: number): unknown => {
		skipSpace();
		const c = text[i];
		if (c === "{" || c === "[") {
			if (depth === MAX_JSON_DEPTH) throw fail(`The file nests deeper than ${MAX_JSON_DEPTH} levels.`);
			i++;
			return c === "{" ? readObject(depth + 1) : readArray(depth + 1);
		}
		if (c === '"') return readString();
		for (const [word, literal] of JSON_LITERALS)
			if (text.startsWith(word, i)) {
				i += word.length;
				return literal;
			}
		JSON_NUMBER.lastIndex = i;
		const number = JSON_NUMBER.exec(text);
		if (!number) throw fail(i < text.length ? "Expected a value." : "The file ends where a value was expected.");
		const n = Number(number[0]);
		if (!Number.isFinite(n)) throw fail("A number is too large.");
		i = JSON_NUMBER.lastIndex;
		return n;
	};
	const readObject = (depth: number): Record<string, unknown> => {
		const out: Record<string, unknown> = Object.create(null);
		skipSpace();
		if (text[i] === "}") {
			i++;
			return out;
		}
		for (;;) {
			skipSpace();
			if (text[i] !== '"') throw fail("Expected a key in double quotes.");
			const keyAt = i;
			const key = readString();
			if (key in out) {
				i = keyAt;
				throw fail(`The key ${JSON.stringify(key)} appears twice.`);
			}
			skipSpace();
			if (text[i] !== ":") throw fail("Expected ':' after a key.");
			i++;
			out[key] = readValue(depth);
			skipSpace();
			if (text[i] === "}") {
				i++;
				return out;
			}
			if (text[i] !== ",") throw fail("Expected ',' or '}'.");
			i++;
			skipSpace();
			if (text[i] === "}") throw fail("A comma before '}': this file allows no trailing commas.");
		}
	};
	const readArray = (depth: number): unknown[] => {
		const out: unknown[] = [];
		skipSpace();
		if (text[i] === "]") {
			i++;
			return out;
		}
		for (;;) {
			out.push(readValue(depth));
			skipSpace();
			if (text[i] === "]") {
				i++;
				return out;
			}
			if (text[i] !== ",") throw fail("Expected ',' or ']'.");
			i++;
			skipSpace();
			if (text[i] === "]") throw fail("A comma before ']': this file allows no trailing commas.");
		}
	};
	const root = readValue(0);
	skipSpace();
	if (i < text.length) throw fail("Text follows the value.");
	return root;
}

function isControlPoint(point: number): boolean {
	return point < 0x20 || (point >= 0x7f && point <= 0x9f) || point === 0x2028 || point === 0x2029;
}

function isUnseenPoint(point: number): boolean {
	return (
		isControlPoint(point) ||
		(point >= 0x200b && point <= 0x200f) ||
		(point >= 0x202a && point <= 0x202e) ||
		(point >= 0x2066 && point <= 0x2069) ||
		point === 0xfeff
	);
}

function isCheckFolder(folder: string): boolean {
	if (folder === ".") return true;
	if (folder === "" || Buffer.byteLength(folder, "utf8") > MAX_CWD_BYTES) return false;
	for (let index = 0; index < folder.length; index++) {
		const code = folder.charCodeAt(index);
		if (code < 0x20 || code === 0x7f || code === 0x5c) return false;
	}
	return folder.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

function isSiteFolder(folder: string): boolean {
	if (folder === ".") return true;
	if (folder === "" || Buffer.byteLength(folder, "utf8") > MAX_CWD_BYTES) return false;
	for (const char of folder) {
		if (isControlPoint(char.codePointAt(0) as number) || char === "\\") return false;
	}
	return folder.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

function siteNameRefusal(name: string): string | null {
	let broken: string;
	if (!SITE_NAME_PATTERN.test(name)) broken = "";
	else if (name.includes("--")) broken = " This one has two hyphens in a row.";
	else if (name.endsWith("-preview")) broken = " This one ends in -preview.";
	else if (name.includes("qorpera")) broken = " This one contains qorpera.";
	else if (RESERVED_SITE_NAMES.has(name)) broken = " This one is a reserved name.";
	else return null;
	return `${SITE_NAME_RULE}${broken} Pick another, or leave name out.`;
}

function isSiteTitleValid(title: string): boolean {
	const chars = Array.from(title);
	if (chars.length < 1 || chars.length > MAX_SITE_TITLE_CHARS) return false;
	for (const char of chars) {
		if (isControlPoint(char.codePointAt(0) as number)) return false;
	}
	return true;
}

function parseSite(value: unknown, at: string, refuse: Refuse): CodePreflightSite | null {
	if (!isObject(value)) {
		refuse(at, "WRONG_TYPE", "Must be an object.");
		return null;
	}
	let folder: string | null = null;
	let name: string | null = null;
	let title: string | null = null;
	for (const [key, field] of Object.entries(value)) {
		const fieldAt = pointer(at, key);
		if (key !== "folder" && key !== "name" && key !== "title") refuse(fieldAt, "UNKNOWN_KEY", UNKNOWN_KEY_MESSAGE);
		else if (typeof field !== "string") refuse(fieldAt, "WRONG_TYPE", "Must be a string.");
		else if (key === "folder") {
			if (isSiteFolder(field)) folder = field;
			else
				refuse(
					fieldAt,
					"INVALID_PATH",
					'Must be "." or a folder of the repository: a relative path without . or .. parts, at most 300 bytes.',
				);
		} else if (key === "name") {
			const refused = siteNameRefusal(field);
			if (refused === null) name = field;
			else refuse(fieldAt, "INVALID_VALUE", refused);
		} else if (field.startsWith(" ") || field.endsWith(" "))
			refuse(fieldAt, "SITE_TITLE", "Must not start or end with a space.");
		else if (isSiteTitleValid(field)) title = field;
		else refuse(fieldAt, "INVALID_VALUE", "Must be 1 to 120 characters on one line.");
	}
	if (!("folder" in value)) refuse(at, "MISSING_KEY", "Needs folder.");
	return folder === null ? null : { folder, name, title };
}

function parseChecksArray(
	value: unknown,
	at: string,
	refuse: Refuse,
): { checks: CodePreflightCheck[]; totalTimeoutSeconds: number } {
	if (!Array.isArray(value)) {
		refuse(at, "WRONG_TYPE", "Must be an array.");
		return { checks: [], totalTimeoutSeconds: 0 };
	}
	if (value.length < 1 || value.length > MAX_CODE_CHECKS)
		refuse(at, "INVALID_VALUE", `Must hold 1 to ${MAX_CODE_CHECKS} checks.`);
	const checks: CodePreflightCheck[] = [];
	const names = new Set<string>();
	let total = 0;
	for (const [index, item] of value.entries()) {
		const itemAt = pointer(at, index);
		if (!isObject(item)) {
			refuse(itemAt, "WRONG_TYPE", "Must be an object.");
			continue;
		}
		let name: string | null = null;
		let run: string | null = null;
		let timeoutSeconds = CODE_CHECK_DEFAULT_SECONDS;
		let cwd = ".";
		for (const [key, field] of Object.entries(item)) {
			const fieldAt = pointer(itemAt, key);
			if (key === "name") {
				if (typeof field !== "string") refuse(fieldAt, "WRONG_TYPE", "Must be a string.");
				else if (!CODE_CHECK_NAME_PATTERN.test(field))
					refuse(
						fieldAt,
						"INVALID_VALUE",
						"Must be 1 to 40 of a-z, 0-9, '.', '_' and '-', starting with a letter or a digit.",
					);
				else if (names.has(field)) refuse(fieldAt, "DUPLICATE", `The name "${field}" is given twice.`);
				else {
					names.add(field);
					name = field;
				}
			} else if (key === "run") {
				if (typeof field !== "string") refuse(fieldAt, "WRONG_TYPE", "Must be a string.");
				else if (field === "" || Buffer.byteLength(field, "utf8") > MAX_RUN_BYTES || field.includes("\0"))
					refuse(fieldAt, "INVALID_VALUE", `Must be 1 to ${MAX_RUN_BYTES} bytes, without a NUL character.`);
				else run = field;
			} else if (key === "timeoutSeconds") {
				if (
					typeof field !== "number" ||
					!Number.isInteger(field) ||
					field < CODE_CHECK_MIN_SECONDS ||
					field > CODE_CHECK_MAX_SECONDS
				)
					refuse(
						fieldAt,
						"INVALID_VALUE",
						`Must be a whole number of seconds from ${CODE_CHECK_MIN_SECONDS} to ${CODE_CHECK_MAX_SECONDS}.`,
					);
				else timeoutSeconds = field;
			} else if (key === "cwd") {
				if (typeof field !== "string") refuse(fieldAt, "WRONG_TYPE", "Must be a string.");
				else if (!isCheckFolder(field))
					refuse(
						fieldAt,
						"INVALID_PATH",
						`Must be a folder of the repository: a relative path without . or .. parts, at most ${MAX_CWD_BYTES} bytes.`,
					);
				else cwd = field;
			} else refuse(fieldAt, "UNKNOWN_KEY", UNKNOWN_KEY_MESSAGE);
		}
		if (!("name" in item)) refuse(itemAt, "MISSING_KEY", "Needs name.");
		if (!("run" in item)) refuse(itemAt, "MISSING_KEY", "Needs run.");
		total += timeoutSeconds;
		if (name !== null && run !== null) {
			checks.push({ name, run, timeoutSeconds, cwd });
		}
	}
	if (total > CODE_CHECKS_TOTAL_SECONDS)
		refuse(
			at,
			"TOO_LONG",
			`The time limits add up to ${total} s; all checks together may take at most ${CODE_CHECKS_TOTAL_SECONDS} s.`,
		);
	return { checks, totalTimeoutSeconds: total };
}

export function parseCodeChecksText(text: string): ParsedCodeChecks {
	const problems: CodeChecksProblem[] = [];
	const refuse: Refuse = (at, code, message) => {
		problems.push({ at, code, message });
	};
	if (Buffer.byteLength(text, "utf8") > MAX_CODE_CHECKS_FILE_BYTES) {
		refuse("", "TOO_LARGE", "The checks file is over 16 KiB.");
		return { ok: false, problems };
	}
	const source = text.startsWith("\uFEFF") ? text.slice(1) : text;
	let root: unknown;
	try {
		root = parseChecksJson(source);
	} catch (error) {
		if (!(error instanceof ChecksJsonSyntaxError)) throw error;
		const before = source.slice(0, error.index);
		const line = before.split("\n").length;
		const column = error.index - before.lastIndexOf("\n");
		refuse("", "SYNTAX", `Line ${line}, column ${column}: ${error.message}`);
		return { ok: false, problems };
	}
	if (!isObject(root)) {
		refuse("", "WRONG_TYPE", "The checks file must hold one JSON object.");
		return { ok: false, problems };
	}
	let parsedChecks: { checks: CodePreflightCheck[]; totalTimeoutSeconds: number } = {
		checks: [],
		totalTimeoutSeconds: 0,
	};
	let site: CodePreflightSite | null = null;
	for (const [key, value] of Object.entries(root)) {
		const at = pointer("", key);
		if (key === "$schema") {
			if (typeof value !== "string") refuse(at, "WRONG_TYPE", "Must be a string.");
		} else if (key === "checks") parsedChecks = parseChecksArray(value, at, refuse);
		else if (key === "site") site = parseSite(value, at, refuse);
		else refuse(at, "UNKNOWN_KEY", UNKNOWN_KEY_MESSAGE);
	}
	if (!("checks" in root)) refuse("", "MISSING_KEY", "Needs checks.");
	if (problems.length > 0) return { ok: false, problems };
	return {
		ok: true,
		checks: parsedChecks.checks,
		totalTimeoutSeconds: parsedChecks.totalTimeoutSeconds,
		site,
	};
}

export function parseCodeChangesIndex(text: string, maxChanges = 15): ParsedCodeChangesIndex {
	const notices: string[] = [];
	const changes: CodeChangeSummary[] = [];
	let totalListed = 0;
	for (const raw of text.split(/\r?\n/)) {
		const line = raw.trim();
		if (!line || line.startsWith("#")) continue;
		const match = CHANGE_INDEX_LINE.exec(line);
		if (match) {
			totalListed++;
			if (changes.length < maxChanges) {
				changes.push({
					change: Number(match[1]),
					date: match[2]!,
					state: match[3]!.trim(),
					summary: (match[4] ?? "").trim(),
				});
			}
			continue;
		}
		if (CHANGE_INDEX_NOTICE.test(line) && notices.length < 6) notices.push(line);
	}
	return { notices, totalListed, changes };
}

function endOfLine(text: string, maxBytes: number): string {
	if (maxBytes <= 0) return "";
	const ellipsis = "…";
	const ellipsisBytes = Buffer.byteLength(ellipsis, "utf8");
	if (maxBytes < ellipsisBytes) return "";
	const chars = Array.from(text);
	let used = ellipsisBytes;
	let from = chars.length;
	while (from > 0) {
		const size = Buffer.byteLength(chars[from - 1]!, "utf8");
		if (used + size > maxBytes) break;
		used += size;
		from--;
	}
	return `${ellipsis}${chars.slice(from).join("")}`;
}

export function codeChecksTail(output: string, maxBytes = MAX_TAIL_BYTES): string {
	if (maxBytes <= 0) return "";
	let clean = "";
	for (const character of output.replaceAll("\r\n", "\n")) {
		const point = character.codePointAt(0) as number;
		const halfSurrogate = point >= 0xd800 && point <= 0xdfff;
		clean += character !== "\n" && (halfSurrogate || isUnseenPoint(point)) ? "\uFFFD" : character;
	}
	const lines = clean.split("\n").map((line) => line.trimEnd());
	while (lines.length > 0 && lines.at(-1) === "") lines.pop();
	const kept: string[] = [];
	let used = 0;
	for (let index = lines.length - 1; index >= 0 && kept.length < MAX_TAIL_LINES; index--) {
		const line = lines[index]!;
		const size = Buffer.byteLength(line, "utf8") + (kept.length > 0 ? 1 : 0);
		if (used + size <= maxBytes) {
			kept.unshift(line);
			used += size;
			continue;
		}
		if (kept.length === 0) kept.unshift(endOfLine(line, maxBytes));
		break;
	}
	while (kept.length > 0 && kept[0] === "") kept.shift();
	return kept.join("\n");
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

export function buildPreflightCheckCommand(check: Pick<CodePreflightCheck, "cwd" | "run">): string {
	const inner = `CI=true QORPERA_CHECKS=1 /bin/bash --noprofile --norc -c ${shellQuote(check.run)} </dev/null`;
	return check.cwd === "." ? inner : `( cd -- ${shellQuote(check.cwd)} && ${inner} )`;
}

function preflightSubOperationKey(operationKey: string, suffix: string): string {
	const hash = createHash("sha256").update(operationKey, "utf8").digest("hex").slice(0, 32);
	return `pf:${hash}:${suffix}`;
}

function serializePreflightOutcome(
	payload: {
		readonly state: "passed" | "failed" | "not_run";
		readonly ms: number;
		readonly checks: readonly PreflightCheckOutcome[];
		readonly notRun: readonly string[];
		readonly site: CodePreflightSite | null;
	},
	tailCap: number,
): string {
	const checks = payload.checks.map(
		(entry): Record<string, JsonValue> => ({
			name: entry.name,
			cwd: entry.cwd,
			status: entry.status,
			exitCode: entry.exitCode,
			...(entry.timedOut ? { timedOut: true } : {}),
			ms: entry.ms,
			commandId: entry.commandId,
			...(entry.tail !== undefined ? { tail: codeChecksTail(entry.tail, tailCap) } : {}),
		}),
	);
	return cloudToolJsonText(
		{
			schema: "qorpera.coding-preflight-checks/v1",
			state: payload.state,
			file: ".qorpera/checks.json",
			ms: payload.ms,
			checks,
			notRun: [...payload.notRun],
			site: payload.site
				? { folder: payload.site.folder, name: payload.site.name, title: payload.site.title }
				: null,
		},
		MAX_COMMAND_JSON_BYTES,
	);
}

export async function runCodingPreflightChecks(options: {
	scope: CloudCodingCommandScope;
	identity: CloudNativeToolIdentity;
	operations: Pick<CloudNativeToolOperations, "execute">;
	gateway: CloudCodingCommandGateway;
	checkAuthority: (context: CloudToolContext) => Promise<void>;
	request: CodingPreflightCheckRequest;
	context: CloudToolContext;
	pollMs?: number;
	timeoutGraceMs?: number;
}): Promise<CloudToolContent> {
	const { scope, operations, gateway, checkAuthority, request, context } = options;
	const target = { schema: "qorpera.coding-command-target/v1", ...scope };
	const basePollMs = options.pollMs ?? DEFAULT_POLL_MS;
	const maxPollMs = Math.max(basePollMs, Math.min(MAX_POLL_MS, basePollMs * 4));
	const timeoutGraceMs = options.timeoutGraceMs ?? DEFAULT_TIMEOUT_GRACE_MS;

	const checkedReceipt = (value: unknown, commandId: string, inputSha256?: string): CloudCodingCommandReceipt => {
		const receipt = parseCloudCodingCommandReceipt(value);
		if (
			receipt.workerId !== scope.workerId ||
			receipt.commandId !== commandId ||
			(inputSha256 !== undefined && receipt.inputSha256 !== inputSha256)
		)
			throw new Error("Coding command result differs");
		return receipt;
	};

	const cancelThroughOperation = async (
		suffix: string,
		commandId: string,
		signal: AbortSignal,
	): Promise<CloudCodingCommandReceipt> => {
		const cancelKey = preflightSubOperationKey(request.operationKey, `${suffix}:cancel`);
		const cancelArgs = { commandId, operationKey: cancelKey };
		const childObservation = context.observation?.child("coding_cancel_command");
		const content = await operations.execute({
			operation: {
				tool: "coding_cancel_command",
				toolVersion: "v1",
				logicalOperationKey: cancelKey,
				arguments: cancelArgs,
				target,
				requiresCompanyRevision: false,
			},
			authorize: (_operation, admitted, authSignal) => gateway.authorize(scope, admitted, authSignal),
			perform: async (_operation, receipt) => {
				const cancelled = checkedReceipt(await gateway.cancel(scope, commandId, receipt.signal), commandId);
				return { content: { kind: "text", value: cloudToolJsonText(cancelled) } };
			},
			signal,
			...(childObservation ? { observation: childObservation } : {}),
		});
		if (content.kind !== "text") throw new Error("Coding command result differs");
		return parseCloudCodingCommandReceipt(JSON.parse(content.value));
	};

	const cancelOnAbort = async (suffix: string, commandId: string): Promise<void> => {
		const controller = new AbortController();
		const timer = setTimeout(
			() => controller.abort(new DOMException("Cancel timed out", "TimeoutError")),
			CANCEL_ON_ABORT_MS,
		);
		timer.unref?.();
		try {
			await cancelThroughOperation(suffix, commandId, controller.signal);
		} catch {
			try {
				await gateway.cancel(scope, commandId, controller.signal);
			} catch {
				return;
			}
		} finally {
			clearTimeout(timer);
		}
	};

	const cancelOnTimeout = async (
		suffix: string,
		commandId: string,
	): Promise<CloudCodingCommandReceipt | undefined> => {
		if (context.signal.aborted) {
			await cancelOnAbort(suffix, commandId);
			context.signal.throwIfAborted();
		}
		try {
			return await cancelThroughOperation(suffix, commandId, context.signal);
		} catch {
			if (context.signal.aborted) {
				await cancelOnAbort(suffix, commandId);
				context.signal.throwIfAborted();
			}
			return undefined;
		}
	};

	const startSubCommand = async (
		suffix: string,
		command: string,
		timeoutMs: number,
	): Promise<CloudCodingCommandReceipt> => {
		const subKey = preflightSubOperationKey(request.operationKey, suffix);
		const subArgs = { operationKey: subKey, command, timeoutMs };
		const childObservation = context.observation?.child("coding_run_command");
		let startedRunningId: string | null = null;
		let content: CloudToolContent;
		try {
			content = await operations.execute({
				operation: {
					tool: "coding_run_command",
					toolVersion: "v1",
					logicalOperationKey: subKey,
					arguments: subArgs,
					target,
					requiresCompanyRevision: false,
				},
				authorize: (_operation, admitted, signal) => gateway.authorize(scope, admitted, signal),
				perform: async (_operation, receipt) => {
					const started = checkedReceipt(
						await gateway.start(
							scope,
							{ commandId: receipt.receiptId, inputSha256: receipt.inputSha256, command, timeoutMs },
							receipt.signal,
						),
						receipt.receiptId,
						receipt.inputSha256,
					);
					if (started.state === "running") startedRunningId = started.commandId;
					return { content: { kind: "text", value: cloudToolJsonText(started) } };
				},
				signal: context.signal,
				...(childObservation ? { observation: childObservation } : {}),
			});
		} catch (error) {
			if (context.signal.aborted && startedRunningId !== null) await cancelOnAbort(suffix, startedRunningId);
			throw error;
		}
		if (content.kind !== "text") throw new Error("Coding command result differs");
		return parseCloudCodingCommandReceipt(JSON.parse(content.value));
	};

	const readReceipt = async (
		commandId: string,
		input: { offset?: number; limit: number; tail?: boolean },
		signal: AbortSignal,
	): Promise<CloudCodingCommandReceipt> => {
		const parsed = parseCloudCodingCommandRead({ commandId, ...input });
		return checkedReceipt(
			await cloudToolRequest((requestSignal) => gateway.read(scope, parsed, requestSignal), signal),
			commandId,
		);
	};

	const readFullOutput = async (
		initial: CloudCodingCommandReceipt,
		maxBytes: number,
		signal: AbortSignal,
	): Promise<string> => {
		let out = initial.log.offset === 0 ? initial.output : "";
		let cursor = initial.log.offset === 0 ? initial.log.nextOffset : 0;
		const total = Math.min(initial.log.totalBytes, maxBytes);
		while (cursor < total) {
			const page = await readReceipt(
				initial.commandId,
				{ offset: cursor, limit: Math.max(4, Math.min(CLOUD_COMMAND_PAGE_ASK, total - cursor)) },
				signal,
			);
			out += page.output;
			if (page.log.nextOffset <= cursor) break;
			cursor = page.log.nextOffset;
		}
		return out;
	};

	const readOutputTail = async (ended: CloudCodingCommandReceipt, signal: AbortSignal): Promise<string> => {
		if (ended.log.totalBytes === 0) return "";
		if (ended.log.offset === 0 && ended.log.nextOffset >= ended.log.totalBytes) {
			return redactCloudWebhookSecrets(ended.output);
		}
		const tail = await readReceipt(ended.commandId, { tail: true, limit: TAIL_READ_BYTES }, signal);
		return redactCloudWebhookSecrets(tail.output);
	};

	const waitUntilDone = async (
		suffix: string,
		initial: CloudCodingCommandReceipt,
		timeoutMs: number,
	): Promise<{ receipt: CloudCodingCommandReceipt; timedOut: boolean }> => {
		let current = initial;
		const deadline = Date.now() + timeoutMs + timeoutGraceMs;
		let delay = basePollMs;
		while (current.state === "running") {
			if (context.signal.aborted) {
				await cancelOnAbort(suffix, current.commandId);
				context.signal.throwIfAborted();
			}
			const remaining = deadline - Date.now();
			if (remaining <= 0) {
				const cancelled = await cancelOnTimeout(suffix, current.commandId);
				return {
					receipt: { ...(cancelled ?? current), state: "failed", exitCode: cancelled?.exitCode ?? null },
					timedOut: true,
				};
			}
			try {
				await cloudControlPause(Math.min(delay, remaining), context.signal);
			} catch (error) {
				if (context.signal.aborted) await cancelOnAbort(suffix, current.commandId);
				throw error;
			}
			delay = Math.min(maxPollMs, Math.max(basePollMs, Math.round(delay * 1.5)));
			try {
				await checkAuthority(context);
				current = await readReceipt(
					current.commandId,
					{ offset: current.log.totalBytes, limit: 4 },
					context.signal,
				);
			} catch (error) {
				if (context.signal.aborted) await cancelOnAbort(suffix, current.commandId);
				throw error;
			}
		}
		return { receipt: current, timedOut: false };
	};

	const finish = async (text: string): Promise<CloudToolContent> => {
		await checkAuthority(context);
		return { kind: "text", value: text };
	};

	const readStarted = await startSubCommand("read", READ_CHECKS_COMMAND, READ_CHECKS_TIMEOUT_MS);
	const readWaited = await waitUntilDone("read", readStarted, READ_CHECKS_TIMEOUT_MS);
	if (readWaited.timedOut) {
		return finish(
			cloudToolJsonText({
				schema: "qorpera.coding-preflight-checks/v1",
				state: "not_run",
				file: ".qorpera/checks.json",
				reason: "read_timed_out",
			}),
		);
	}
	const readFinal = readWaited.receipt;
	if (readFinal.state !== "succeeded" && readFinal.state !== "failed") {
		return finish(
			cloudToolJsonText({
				schema: "qorpera.coding-preflight-checks/v1",
				state: "not_run",
				file: ".qorpera/checks.json",
				reason: readFinal.state,
			}),
		);
	}
	if (readFinal.state === "failed") {
		if (readFinal.exitCode === 44) {
			return finish(
				cloudToolJsonText({
					schema: "qorpera.coding-preflight-checks/v1",
					state: "missing",
					file: ".qorpera/checks.json",
					message: "No .qorpera/checks.json file was found in this worktree. Add one before coding_finish.",
				}),
			);
		}
		if (readFinal.exitCode === 45) {
			return finish(
				cloudToolJsonText({
					schema: "qorpera.coding-preflight-checks/v1",
					state: "invalid",
					file: ".qorpera/checks.json",
					problems: [
						{
							at: "",
							code: "NOT_A_FILE",
							message: "The checks file is not a regular file (a folder, a symlink or a submodule).",
						},
					],
				}),
			);
		}
		if (readFinal.exitCode === 46) {
			return finish(
				cloudToolJsonText({
					schema: "qorpera.coding-preflight-checks/v1",
					state: "invalid",
					file: ".qorpera/checks.json",
					problems: [{ at: "", code: "TOO_LARGE", message: "The checks file is over 16 KiB." }],
				}),
			);
		}
		if (readFinal.exitCode === 47) {
			return finish(
				cloudToolJsonText({
					schema: "qorpera.coding-preflight-checks/v1",
					state: "invalid",
					file: ".qorpera/checks.json",
					problems: [{ at: "", code: "NOT_UTF8", message: "The checks file is not UTF-8 text." }],
				}),
			);
		}
		return finish(
			cloudToolJsonText({
				schema: "qorpera.coding-preflight-checks/v1",
				state: "not_run",
				file: ".qorpera/checks.json",
				reason: "read_failed",
				exitCode: readFinal.exitCode,
			}),
		);
	}

	const rawChecksText = await readFullOutput(readFinal, MAX_CODE_CHECKS_FILE_BYTES + 1, context.signal);
	const parsed = parseCodeChecksText(rawChecksText);
	if (!parsed.ok) {
		return finish(
			cloudToolJsonText({
				schema: "qorpera.coding-preflight-checks/v1",
				state: "invalid",
				file: ".qorpera/checks.json",
				problems: parsed.problems.map((p) => ({ at: p.at, code: p.code, message: p.message })),
			}),
		);
	}

	const originalIndexByName = new Map(parsed.checks.map((check, index) => [check.name, index]));
	let selected = parsed.checks;
	if (request.checkNames !== undefined) {
		const unknown = request.checkNames.filter((name) => !originalIndexByName.has(name));
		if (unknown.length > 0) {
			return finish(
				cloudToolJsonText({
					schema: "qorpera.coding-preflight-checks/v1",
					state: "invalid",
					file: ".qorpera/checks.json",
					problems: unknown.map((name) => ({
						at: "",
						code: "UNKNOWN_CHECK",
						message: `No check named "${name}" exists in .qorpera/checks.json.`,
					})),
					availableChecks: parsed.checks.map((check) => check.name),
				}),
			);
		}
		const wanted = new Set(request.checkNames);
		selected = parsed.checks.filter((check) => wanted.has(check.name));
	}

	const commandProblems: CodeChecksProblem[] = [];
	const commandsByName = new Map<string, string>();
	for (const check of selected) {
		const cmd = buildPreflightCheckCommand(check);
		if (
			Buffer.byteLength(cmd, "utf8") > MAX_COMMAND_BYTES ||
			Buffer.byteLength(JSON.stringify(cmd)) > MAX_COMMAND_JSON_BYTES
		) {
			commandProblems.push({
				at: `/checks/${originalIndexByName.get(check.name)}/run`,
				code: "COMMAND_TOO_LONG",
				message: `Check "${check.name}" exceeds the command size limit after shell quoting.`,
			});
		} else {
			commandsByName.set(check.name, cmd);
		}
	}
	if (commandProblems.length > 0) {
		return finish(
			cloudToolJsonText({
				schema: "qorpera.coding-preflight-checks/v1",
				state: "invalid",
				file: ".qorpera/checks.json",
				problems: commandProblems.map((p) => ({ at: p.at, code: p.code, message: p.message })),
			}),
		);
	}

	const runStartedAt = Date.now();
	const outcomes: PreflightCheckOutcome[] = [];
	const notRun: string[] = [];
	let anyFailed = false;
	let anyNotRun = false;

	for (let index = 0; index < selected.length; index++) {
		const check = selected[index]!;
		const checkStartedAt = Date.now();
		const originalIndex = originalIndexByName.get(check.name)!;
		const suffix = `c:${originalIndex}`;
		const cmd = commandsByName.get(check.name)!;
		const timeoutMs = check.timeoutSeconds * 1000;
		const startedReceipt = await startSubCommand(suffix, cmd, timeoutMs);
		const waited = await waitUntilDone(suffix, startedReceipt, timeoutMs);
		const elapsedMs = Math.max(0, Date.now() - checkStartedAt);
		const finalReceipt = waited.receipt;
		const status: PreflightCheckOutcome["status"] =
			finalReceipt.state === "succeeded"
				? "passed"
				: finalReceipt.state === "failed"
					? "failed"
					: finalReceipt.state === "cancelled"
						? "cancelled"
						: finalReceipt.state === "machine_stopped"
							? "machine_stopped"
							: "unconfirmed";
		const tail = status === "passed" ? undefined : await readOutputTail(finalReceipt, context.signal);
		outcomes.push({
			name: check.name,
			cwd: check.cwd,
			status,
			exitCode: finalReceipt.exitCode,
			timedOut: waited.timedOut,
			ms: elapsedMs,
			commandId: finalReceipt.commandId,
			...(tail !== undefined ? { tail } : {}),
		});
		if (status !== "passed") {
			if (status === "machine_stopped" || status === "unconfirmed") anyNotRun = true;
			else anyFailed = true;
			if (request.failFast) {
				for (let rest = index + 1; rest < selected.length; rest++) notRun.push(selected[rest]!.name);
				break;
			}
		}
	}

	const totalMs = Math.max(0, Date.now() - runStartedAt);
	const overallState: "passed" | "failed" | "not_run" =
		anyNotRun && !anyFailed ? "not_run" : anyFailed || notRun.length > 0 ? "failed" : "passed";

	const payload = {
		state: overallState,
		ms: totalMs,
		checks: outcomes,
		notRun,
		site: parsed.site,
	};
	for (const tailCap of [MAX_TAIL_BYTES, 800, 400, 200, 0]) {
		const candidate = redactCloudWebhookSecrets(serializePreflightOutcome(payload, tailCap));
		if (fitsOneResult(candidate)) return finish(candidate);
	}
	return finish(redactCloudWebhookSecrets(serializePreflightOutcome(payload, 0)));
}
