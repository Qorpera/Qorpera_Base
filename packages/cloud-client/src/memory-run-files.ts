/** Browser-safe run-log files (W1b, 20260930231000_memory_run_logs.sql). The database
 * checks ownership, append-only history, narrowing and generations. These parsers check
 * the bytes and placement alone. Stored structured parses are deliberately only {kind}. */
import { SHA256_HEX_PATTERN as HASH, POSTGRES_UUID_PATTERN as UUID } from "@qorpera/contracts";
import type { CompanyStateProblem } from "./company-state-files.ts";
import { companyPathKey } from "./company-state-shared.ts";

export type MemoryRunFileKind = "memory-run" | "memory-steps" | "memory-run-block";
export interface MemoryRunFile {
	readonly kind: MemoryRunFileKind;
}
export interface MemoryRunOrigin {
	readonly run: string;
	readonly conversation: string;
	readonly parent: string | null;
	readonly step: number | null;
	readonly continues: string | null;
	readonly narrow: boolean;
}

const UUID_TEXT = UUID.source.slice(1, -1);
const PATH = new RegExp(
	`^agents/(?:groups/([^/]+)/memory|([^/]+)/memory/thread)/runs/(${UUID_TEXT})/(run\\.toml|log/[0-9]{8}\\.jsonl|t([0-9]|1[0-4])/[0-9]{8}\\.jsonl)$`,
);
const TOML = new RegExp(
	`^format = 1\nrun = "(${UUID_TEXT})"\nconversation = "(${UUID_TEXT})"\n` +
		`(?:parent = "(${UUID_TEXT})"\nstep = (0|[1-9][0-9]{0,8})\n)?` +
		`(?:continues = "(${UUID_TEXT})"\n)?(narrow = true\n)?$`,
);
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
const encoder = new TextEncoder();

/** Match by the folder key; the normal dispatcher checks the spelling as written. */
export function memoryRunFilePath(path: string) {
	const key = companyPathKey(path);
	const match = PATH.exec(key);
	if (!match || match[0] !== key) return null;
	const suffix = match[4]!;
	const kind: MemoryRunFileKind =
		suffix === "run.toml" ? "memory-run" : suffix.startsWith("log/") ? "memory-steps" : "memory-run-block";
	return { kind, group: match[1] ?? null, agent: match[2] ?? null, run: match[3]!, suffix };
}

/** The exact canonical TOML grammar, not general TOML. UUIDs follow SQL's hex shape,
 * including the zero UUID; database state decides which origins actually exist. */
export function parseMemoryRunToml(text: string): MemoryRunOrigin | null {
	const match = TOML.exec(text);
	if (!match || match[0] !== text) return null;
	return {
		run: match[1]!,
		conversation: match[2]!,
		parent: match[3] ?? null,
		step: match[4] === undefined ? null : Number(match[4]),
		continues: match[5] ?? null,
		narrow: match[6] !== undefined,
	};
}

interface Token {
	readonly raw: string;
	readonly start: number;
	readonly end: number;
}
interface JsonObject {
	readonly value: Record<string, unknown>;
	readonly fields: ReadonlyMap<string, string>;
}

/** JSON.parse validates grammar; tokens preserve duplicates and the *original* JSON
 * field bytes, which PostgreSQL's json (unlike jsonb) retains for the size checks. */
function tokens(text: string): Token[] {
	return [...text.matchAll(/"(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null|[{}[\],:]/g)].map(
		(match) => ({ raw: match[0], start: match.index, end: match.index + match[0].length }),
	);
}

function valueEnd(parts: readonly Token[], start: number): number {
	if (parts[start]?.raw !== "{" && parts[start]?.raw !== "[") return start;
	let depth = 0;
	for (let index = start; index < parts.length; index++) {
		const raw = parts[index]!.raw;
		if (raw === "{" || raw === "[") depth++;
		else if (raw === "}" || raw === "]") depth--;
		if (depth === 0) return index;
	}
	throw new Error("Invalid JSON token structure");
}

function jsonObject(text: string): JsonObject | null {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		return null;
	}
	if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
	const parts = tokens(text);
	for (const part of parts) {
		if (part.raw.startsWith('"')) {
			const decoded = JSON.parse(part.raw) as string;
			// jsonb cannot hold NUL or unpaired Unicode surrogates, including in nested results/keys.
			if (decoded.includes("\u0000") || LONE_SURROGATE.test(decoded)) return null;
		} else if (/^-?\d/.test(part.raw)) {
			const [mantissa = "", power = "0"] = part.raw.split(/[eE]/);
			const exponent = Number(power);
			const [whole = "", fraction = ""] = mantissa.replace(/^-/, "").split(".");
			// jsonb numbers use PostgreSQL numeric's representable range, not JS doubles.
			if (!Number.isSafeInteger(exponent) || whole.length + exponent > 131072 || fraction.length - exponent > 16383)
				return null;
		}
	}
	const fields = new Map<string, string>();
	for (let index = 1; index < parts.length - 1; ) {
		const key = JSON.parse(parts[index]!.raw) as string;
		if (fields.has(key)) return null;
		const first = index + 2;
		const last = valueEnd(parts, first);
		fields.set(key, text.slice(parts[first]!.start, parts[last]!.end));
		index = last + 2;
	}
	return { value: value as Record<string, unknown>, fields };
}

/** jsonb renders numeric exponents as decimal and retains fractional scale. Do not
 * round k through a JS number: its contract extends to signed-bigint's maximum. */
function integer(raw: string | undefined, max: bigint): bigint | null {
	const match = raw === undefined ? null : /^(-?)(0|[1-9][0-9]*)(?:\.([0-9]+))?(?:[eE]([+-]?[0-9]+))?$/.exec(raw);
	if (!match) return null;
	const fraction = match[3] ?? "";
	const exponent = Number(match[4] ?? 0);
	const zeros = exponent - fraction.length;
	if (!Number.isSafeInteger(zeros) || zeros < 0) return null;
	const digits = `${match[2]}${fraction}`.replace(/^0+/, "") || "0";
	if (digits !== "0" && (match[1] === "-" || digits.length + zeros > String(max).length)) return null;
	const result = digits === "0" ? 0n : BigInt(digits + "0".repeat(zeros));
	return result <= max ? result : null;
}

function closed(fields: ReadonlyMap<string, string>, keys: readonly string[]): boolean {
	return fields.size === keys.length && keys.every((key) => fields.has(key));
}

function stepLine(text: string): bigint | null {
	const parsed = jsonObject(text);
	if (!parsed) return null;
	const { value: row, fields } = parsed;
	const j = integer(fields.get("j"), 2147483647n);
	if (j === null) return null;
	for (const [key, max] of [
		["tool", 128],
		["call", 256],
	] as const) {
		const value = row[key];
		if (typeof value !== "string" || [...value].length < 1 || [...value].length > max || CONTROL.test(value))
			return null;
	}
	if (row.args_hash !== null && (typeof row.args_hash !== "string" || !HASH.test(row.args_hash))) return null;
	const narrow = fields.has("narrow");
	const erased = fields.has("erased");
	if (narrow && row.narrow !== true) return null;
	const common = ["j", "tool", "call", "args_hash"];
	if (!narrow && integer(fields.get("args_bytes"), 9999999999n) === null) return null;
	if (erased)
		return row.erased === true && closed(fields, [...common, "erased", narrow ? "narrow" : "args_bytes"]) ? j : null;
	if (!Array.isArray(row.releases) || row.releases.some((id) => typeof id !== "string" || !UUID.test(id))) return null;
	if (typeof row.at !== "string" || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$(?![\s\S])/.test(row.at))
		return null;
	if (narrow) {
		if (typeof row.finished !== "boolean") return null;
		if (row.finished && (typeof row.result_hash !== "string" || !HASH.test(row.result_hash))) return null;
		return closed(fields, [
			...common,
			"narrow",
			"finished",
			"releases",
			"at",
			...(row.finished ? ["result_hash"] : []),
		])
			? j
			: null;
	}
	if (
		!closed(fields, [
			...common,
			"args",
			"args_bytes",
			"result",
			"reads",
			"releases",
			"text",
			"at",
			...(fields.has("reads_cut") ? ["reads_cut"] : []),
		])
	)
		return null;
	if (typeof row.args !== "string" || typeof row.text !== "string" || !Array.isArray(row.reads)) return null;
	for (const key of ["args", "text", "result", "reads"])
		if (encoder.encode(fields.get(key)!).length > (key === "reads" ? 16384 : 8192)) return null;
	if (fields.has("reads_cut") && (row.reads_cut !== true || row.result === null)) return null;
	if (row.result === null && (row.reads.length !== 0 || row.releases.length !== 0)) return null;
	const rawReads = fields.get("reads")!;
	const parts = tokens(rawReads);
	for (let index = 1; index < parts.length - 1; ) {
		const end = valueEnd(parts, index);
		const read = jsonObject(rawReads.slice(parts[index]!.start, parts[end]!.end));
		if (
			!read ||
			!closed(read.fields, ["path", "version"]) ||
			typeof read.value.path !== "string" ||
			(read.value.version !== null && typeof read.value.version !== "string")
		)
			return null;
		index = end + 2;
	}
	return j;
}

export type MemoryRunParseResult =
	| { readonly ok: true; readonly file: MemoryRunFile }
	| { readonly ok: false; readonly problems: readonly CompanyStateProblem[] };

export function parseMemoryRunFile(kind: MemoryRunFileKind, path: string, text: string): MemoryRunParseResult {
	const refuse = (
		message: string,
		line: number | null = null,
		code: CompanyStateProblem["code"] = "value",
	): MemoryRunParseResult => ({ ok: false, problems: [{ code, line, key: null, message }] });
	const place = memoryRunFilePath(path);
	if (!place || place.kind !== kind) return refuse("the file is not at a run log's structured path", null, "name");
	const maxBytes = kind === "memory-run-block" ? 65004 : 65536;
	if (encoder.encode(text).length > maxBytes)
		return refuse(`the file is larger than ${maxBytes} bytes`, null, "too_large");
	if (text.includes("\u0000") || LONE_SURROGATE.test(text))
		return refuse("the file must be plain UTF-8 text", null, "encoding");
	if (kind === "memory-run") {
		const origin = parseMemoryRunToml(text);
		if (!origin)
			return refuse(
				"run.toml is format = 1, run, conversation, then parent and step, continues and narrow = true when they apply, one per line",
			);
		if (origin.run !== place.run) return refuse(`run is this log's own run, ${place.run}`);
		return { ok: true, file: { kind } };
	}
	const lines = text.endsWith("\n") ? text.slice(0, -1).split("\n") : [];
	const maxLines = kind === "memory-steps" ? 16 : 30;
	if (lines.length < 1 || lines.length > maxLines)
		return refuse(`a block is 1 to ${maxLines} lines, each ending in a newline`);
	const block = BigInt(place.suffix.slice(-14, -6));
	const tier = kind === "memory-run-block" ? Number(place.suffix.slice(1, place.suffix.indexOf("/"))) : 0;
	let previousLevel = -1;
	let previousNumber = -1n;
	for (const [index, line] of lines.entries()) {
		if (encoder.encode(line).length > (kind === "memory-steps" ? 41983 : 2113))
			return refuse("this line is longer than this kind permits", index + 1);
		if (kind === "memory-steps") {
			const j = stepLine(line);
			if (j === null) return refuse("this line is not a step line", index + 1);
			if (j !== block + BigInt(index))
				return refuse("the steps go by j from the block's number, each once", index + 1);
			continue;
		}
		const parsed = jsonObject(line);
		if (!parsed) return refuse("this line is not a summary line", index + 1);
		const { value: row, fields } = parsed;
		const level = integer(fields.get("l"), 59n);
		const number = integer(fields.get("k"), 9223372036854775807n);
		if (
			level === null ||
			number === null ||
			typeof row.free !== "boolean" ||
			typeof row.text !== "string" ||
			!closed(fields, ["l", "k", "free", "text", ...(row.free === false ? ["tries"] : [])]) ||
			(row.free === false && (integer(fields.get("tries"), 3n) ?? 0n) < 1n) ||
			CONTROL.test(row.text)
		)
			return refuse("this line is not a summary line", index + 1);
		const escapedBytes =
			encoder.encode(row.text).length + [...row.text].filter((char) => char === '"' || char === "\\").length;
		if (escapedBytes > 2048) return refuse("the summary text is longer than 2048 escaped bytes", index + 1);
		const l = Number(level);
		if (l < 4 * tier || l > 4 * tier + 3 || number >> BigInt(4 * tier + 4 - l) !== block)
			return refuse("this line does not belong in this block", index + 1);
		if (l < previousLevel || (l === previousLevel && number <= previousNumber))
			return refuse("the lines go by level, then by number, each once", index + 1);
		previousLevel = l;
		previousNumber = number;
	}
	return { ok: true, file: { kind } };
}
