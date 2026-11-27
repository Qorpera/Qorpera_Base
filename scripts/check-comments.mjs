import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SELF = "scripts/check-comments.mjs";

export const MARKER = "WHY:";
export const MAX_LINES = 3;

const LANGUAGES = { ".rs": "rust", ".sql": "sql", ".sh": "shell", ".bash": "shell", ".py": "python" };
for (const extension of [".ts", ".mts", ".cts", ".js", ".mjs", ".cjs"]) LANGUAGES[extension] = "script";

const SKIPPED_SEGMENTS = new Set(["node_modules", "dist", "vendor", "public", ".artifacts"]);
const GENERATED = /\.generated\.|_runtime_bundle_activation_v\d+\.sql$/;

const DIRECTIVES = {
	script:
		/^(?:biome-ignore\b|@ts-(?:expect-error|ignore|nocheck|check)\b|eslint-(?:disable|enable)\b|prettier-ignore\b|(?:v8|c8|istanbul) ignore\b|@(?:vitest|jest)-environment\b|[@#]__(?:PURE|NO_SIDE_EFFECTS)__|@vite-ignore\b|webpack[A-Z]\w*:|[#@] ?sourceMappingURL=|@(?:license|preserve)\b|<(?:reference|amd-module|amd-dependency)\b)/,
	shell: /^shellcheck /,
	sql: /^(?:@fixture [0-9a-z_.-]+\.test\.sql until "[^"\n]+"|BEGIN GENERATED CONNECTOR CATALOG \(scripts\/generate-cloud-connector-catalog\.mjs\)|END GENERATED CONNECTOR CATALOG|Catalog version \d+: \d+ operations\.)$/,
	python: /^(?:type:|noqa\b|pragma:|pylint:|mypy:|ruff:|fmt:|-\*- )/,
};
const MARKERS = { rust: [MARKER, "SAFETY:"] };

export function languageOf(path) {
	if (GENERATED.test(path) || path.split("/").some((segment) => SKIPPED_SEGMENTS.has(segment))) return null;
	return LANGUAGES[extname(path)] ?? null;
}

function lineStarts(text) {
	const starts = [0];
	for (let index = text.indexOf("\n"); index !== -1; index = text.indexOf("\n", index + 1)) starts.push(index + 1);
	return starts;
}

function lineAt(starts, position) {
	let low = 0;
	let high = starts.length - 1;
	while (low < high) {
		const middle = (low + high + 1) >> 1;
		if (starts[middle] <= position) low = middle;
		else high = middle - 1;
	}
	return low;
}

function bodyLines(raw) {
	if (!raw.startsWith("/*")) return [raw.replace(/^(?:\/\/[/!]*|--|#+)/, "").trim()];
	const inner = raw.slice(2, raw.length >= 4 && raw.endsWith("*/") ? -2 : undefined);
	const lines = inner.split("\n").map((line) => line.trim().replace(/^\*+ ?/, "").trim());
	while (lines.length > 1 && lines[0] === "") lines.shift();
	while (lines.length > 1 && lines.at(-1) === "") lines.pop();
	return lines;
}

function isDirective(language, lines) {
	return lines.length === 1 && DIRECTIVES[language] !== undefined && DIRECTIVES[language].test(lines[0]);
}

function toUnits(text, spans, language) {
	const starts = lineStarts(text);
	const units = [];
	for (const [from, to] of [...spans].sort((left, right) => left[0] - right[0])) {
		const raw = text.slice(from, to);
		const line = lineAt(starts, from);
		const lines = bodyLines(raw);
		const comment = {
			language,
			line: line + 1,
			endLine: lineAt(starts, Math.max(from, to - 1)) + 1,
			block: raw.startsWith("/*"),
			own: text.slice(starts[line], from).trim() === "",
			directive: isDirective(language, lines),
			lines,
		};
		const last = units.at(-1);
		const joins =
			last !== undefined &&
			!last.block &&
			!comment.block &&
			!last.directive &&
			!comment.directive &&
			last.own &&
			comment.own &&
			comment.line === last.endLine + 1;
		if (joins) {
			last.lines.push(...comment.lines);
			last.endLine = comment.endLine;
		} else units.push(comment);
	}
	return units;
}

function lineEnd(text, from, to) {
	const end = text.indexOf("\n", from);
	return end === -1 || end > to ? to : end;
}

function nestedBlockEnd(text, from, to) {
	let depth = 1;
	let index = from + 2;
	while (index < to && depth > 0) {
		if (text.startsWith("/*", index)) {
			depth++;
			index += 2;
		} else if (text.startsWith("*/", index)) {
			depth--;
			index += 2;
		} else index++;
	}
	return Math.min(index, to);
}

function quotedEnd(text, from, to, quote, backslash) {
	let index = from + 1;
	while (index < to) {
		if (backslash && text[index] === "\\") index += 2;
		else if (text[index] !== quote) index++;
		else if (!backslash && text[index + 1] === quote) index += 2;
		else return index + 1;
	}
	return to;
}

const WORD = /[\p{L}\p{N}_$]+/uy;
const PATTERN_MAY_FOLLOW = new Set([
	"return",
	"typeof",
	"instanceof",
	"in",
	"of",
	"new",
	"delete",
	"void",
	"throw",
	"case",
	"do",
	"else",
	"yield",
	"await",
]);

function patternEnd(text, from) {
	let inClass = false;
	for (let index = from + 1; index < text.length; index++) {
		const character = text[index];
		if (character === "\n") return -1;
		if (character === "\\") index++;
		else if (character === "[") inClass = true;
		else if (character === "]") inClass = false;
		else if (character === "/" && !inClass) {
			let end = index + 1;
			while (/[a-z]/i.test(text[end] ?? "")) end++;
			return end;
		}
	}
	return -1;
}

function scriptStringEnd(text, from) {
	for (let index = from + 1; index < text.length; index++) {
		if (text[index] === "\\") index++;
		else if (text[index] === text[from]) return index + 1;
		else if (text[index] === "\n") return index;
	}
	return text.length;
}

function templateTextEnd(text, from, slots) {
	let index = from;
	while (index < text.length) {
		if (text[index] === "\\") index += 2;
		else if (text[index] === "`") return index + 1;
		else if (text.startsWith("${", index)) {
			slots.push(0);
			return index + 2;
		} else index++;
	}
	return text.length;
}

function scriptSpans(text) {
	const spans = [];
	const slots = [];
	let patternAllowed = true;
	let index = text.startsWith("#!") ? lineEnd(text, 0, text.length) : 0;
	const readTemplateText = (from) => {
		const open = slots.length;
		index = templateTextEnd(text, from, slots);
		patternAllowed = slots.length > open;
	};
	while (index < text.length) {
		const character = text[index];
		if (text.startsWith("//", index)) {
			const end = lineEnd(text, index, text.length);
			spans.push([index, end]);
			index = end;
		} else if (text.startsWith("/*", index)) {
			const close = text.indexOf("*/", index + 2);
			const end = close === -1 ? text.length : close + 2;
			spans.push([index, end]);
			index = end;
		} else if (character === "/") {
			const end = patternAllowed ? patternEnd(text, index) : -1;
			patternAllowed = end === -1;
			index = end === -1 ? index + 1 : end;
		} else if (character === '"' || character === "'") {
			index = scriptStringEnd(text, index);
			patternAllowed = false;
		} else if (character === "`") readTemplateText(index + 1);
		else if (character === "}" && slots.at(-1) === 0) {
			slots.pop();
			readTemplateText(index + 1);
		} else if (character === "{" || character === "}") {
			if (slots.length > 0) slots[slots.length - 1] += character === "{" ? 1 : -1;
			patternAllowed = true;
			index++;
		} else if (character === ")" || character === "]") {
			patternAllowed = false;
			index++;
		} else if ((character === "+" || character === "-") && text[index + 1] === character) index += 2;
		else if (/\s/.test(character)) index++;
		else {
			WORD.lastIndex = index;
			const word = WORD.exec(text)?.[0];
			patternAllowed = word === undefined || PATTERN_MAY_FOLLOW.has(word);
			index += word === undefined ? 1 : word.length;
		}
	}
	return spans;
}

const IDENTIFIER_CHARACTER = /[A-Za-z0-9_]/;
const RAW_STRING = /b?r(#*)"/y;

function rustSpans(text) {
	const spans = [];
	let index = 0;
	while (index < text.length) {
		const character = text[index];
		if (text.startsWith("//", index)) {
			const end = lineEnd(text, index, text.length);
			spans.push([index, end]);
			index = end;
		} else if (text.startsWith("/*", index)) {
			const end = nestedBlockEnd(text, index, text.length);
			spans.push([index, end]);
			index = end;
		} else if (character === '"') index = quotedEnd(text, index, text.length, '"', true);
		else if ((character === "r" || character === "b") && !IDENTIFIER_CHARACTER.test(text[index - 1] ?? "")) {
			RAW_STRING.lastIndex = index;
			const raw = RAW_STRING.exec(text);
			if (raw === null) index++;
			else {
				const close = text.indexOf(`"${raw[1]}`, index + raw[0].length);
				index = close === -1 ? text.length : close + 1 + raw[1].length;
			}
		} else if (character === "'") {
			if (text[index + 1] === "\\") {
				const close = text.indexOf("'", index + 3);
				index = close === -1 ? text.length : close + 1;
			} else {
				const width = String.fromCodePoint(text.codePointAt(index + 1) ?? 0).length;
				index += text[index + 1 + width] === "'" ? width + 2 : 1;
			}
		} else index++;
	}
	return spans;
}

const DOLLAR_TAG = /\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/y;
const CODE_BODY_OPENER = /\b(?:as|do)\s*$/i;

function sqlSpans(text, from = 0, to = text.length, spans = []) {
	let index = from;
	while (index < to) {
		const character = text[index];
		if (text.startsWith("--", index)) {
			const end = lineEnd(text, index, to);
			spans.push([index, end]);
			index = end;
		} else if (text.startsWith("/*", index)) {
			const end = nestedBlockEnd(text, index, to);
			spans.push([index, end]);
			index = end;
		} else if (character === "'") {
			const escapes = /[eE]/.test(text[index - 1] ?? "") && !IDENTIFIER_CHARACTER.test(text[index - 2] ?? "");
			index = quotedEnd(text, index, to, "'", escapes);
		} else if (character === '"') index = quotedEnd(text, index, to, '"', false);
		else if (character === "$" && !IDENTIFIER_CHARACTER.test(text[index - 1] ?? "")) {
			DOLLAR_TAG.lastIndex = index;
			const tag = DOLLAR_TAG.exec(text)?.[0];
			if (tag === undefined) {
				index++;
				continue;
			}
			const start = index + tag.length;
			const found = text.indexOf(tag, start);
			const close = found === -1 || found > to ? to : found;
			if (CODE_BODY_OPENER.test(text.slice(Math.max(from, index - 40), index))) sqlSpans(text, start, close, spans);
			index = close + tag.length;
		} else index++;
	}
	return spans;
}

const HEREDOC = /<<-?\s*(['"]?)\\?([A-Za-z_][A-Za-z0-9_]*)\1/y;

function scanShellLine(line, quote) {
	let open = quote;
	let terminator = null;
	let arithmetic = 0;
	for (let index = 0; index < line.length; index++) {
		const character = line[index];
		if (open === "'") {
			if (character === "'") open = null;
		} else if (character === "\\") index++;
		else if (open === '"') {
			if (character === '"') open = null;
		} else if (character === "'" || character === '"') open = character;
		else if (character === "#" && (index === 0 || /\s/.test(line[index - 1]))) break;
		else if (line.startsWith("((", index)) {
			arithmetic++;
			index++;
		} else if (arithmetic > 0 && line.startsWith("))", index)) {
			arithmetic--;
			index++;
		} else if (arithmetic === 0 && terminator === null && line.startsWith("<<", index) && line[index + 2] !== "<" && line[index - 1] !== "<") {
			HEREDOC.lastIndex = index;
			const heredoc = HEREDOC.exec(line);
			if (heredoc !== null) {
				terminator = heredoc[2];
				index += heredoc[0].length - 1;
			}
		}
	}
	return { quote: open, terminator };
}

function shellSpans(text) {
	const spans = [];
	let terminator = null;
	let quote = null;
	let offset = 0;
	for (const line of text.split("\n")) {
		const indent = line.length - line.trimStart().length;
		if (terminator !== null) {
			if (line.trim() === terminator) terminator = null;
		} else if (quote === null && line[indent] === "#") {
			if (offset > 0 || !line.startsWith("#!")) spans.push([offset + indent, offset + line.length]);
		} else ({ quote, terminator } = scanShellLine(line, quote));
		offset += line.length + 1;
	}
	return spans;
}

const TRIPLE_QUOTE = /"""|'''/g;

function pythonSpans(text) {
	const spans = [];
	let triple = null;
	let offset = 0;
	for (const line of text.split("\n")) {
		const indent = line.length - line.trimStart().length;
		if (triple === null && line[indent] === "#") {
			if (offset > 0 || !line.startsWith("#!")) spans.push([offset + indent, offset + line.length]);
		} else {
			for (const [mark] of line.matchAll(TRIPLE_QUOTE)) {
				if (triple === null) triple = mark;
				else if (triple === mark) triple = null;
			}
		}
		offset += line.length + 1;
	}
	return spans;
}

const SCANNERS = { script: scriptSpans, rust: rustSpans, sql: sqlSpans, shell: shellSpans, python: pythonSpans };

export function commentsIn(path, text) {
	const language = languageOf(path);
	return language === null ? [] : toUnits(text, SCANNERS[language](text), language);
}

export function verdict(unit) {
	const lines = unit.lines.filter((line) => line !== "");
	if (lines.length === 0 || isDirective(unit.language, lines)) return null;
	const marker = (MARKERS[unit.language] ?? [MARKER]).find((candidate) => lines[0].startsWith(candidate));
	if (marker === undefined) return "plain";
	if (lines.length === 1 && lines[0].slice(marker.length).trim() === "") return "empty";
	if (unit.lines.length > MAX_LINES) return "long";
	return null;
}

export function commentLines(path, text, into = new Set()) {
	if (text !== null) for (const unit of commentsIn(path, text)) for (const line of unit.lines) into.add(line);
	return into;
}

export function newFindings(path, now, olds, elsewhere = new Set()) {
	const known = new Set(elsewhere);
	for (const [oldPath, text] of olds) commentLines(oldPath, text, known);
	const findings = [];
	const report = (unit, problem) => findings.push({ path, line: unit.line, problem, text: unit.lines.find((line) => line !== "") });
	for (const unit of commentsIn(path, now)) {
		const fresh = unit.lines.map((line) => line !== "" && !known.has(line));
		const problem = fresh.includes(true) ? verdict(unit) : null;
		if (problem === null) continue;
		if (unit.block) {
			report(unit, problem);
			continue;
		}
		for (let start = 0; start < fresh.length; start++) {
			if (!fresh[start]) continue;
			let end = start;
			while (fresh[end + 1]) end++;
			const run = { ...unit, line: unit.line + start, lines: unit.lines.slice(start, end + 1) };
			const runProblem = verdict(run);
			if (runProblem !== null) report(run, runProblem);
			start = end;
		}
	}
	return findings;
}

function read(file) {
	try {
		return readFileSync(file, "utf8");
	} catch {
		return null;
	}
}

export function check({ base = "origin/master", head = null, cwd = root } = {}) {
	const run = (args, input) =>
		execFileSync("git", args, { cwd, input, encoding: "utf8", maxBuffer: 1 << 28, stdio: ["pipe", "pipe", "pipe"] });
	const git = (...args) => run(args);
	const show = (revision, path) => {
		try {
			return git("show", `${revision}:${path}`);
		} catch {
			return null;
		}
	};
	const changes = (...revisions) => {
		const found = [];
		const fields = git("diff", "--name-status", "-M", "-z", ...revisions).split("\0");
		for (let index = 0; index < fields.length - 1; ) {
			const status = fields[index++];
			const from = fields[index++];
			const path = status.startsWith("R") || status.startsWith("C") ? fields[index++] : from;
			found.push({ path, from, deleted: status.startsWith("D") });
		}
		return found;
	};
	const upTo = head === null ? [] : [head];
	const tip = head ?? "HEAD";
	if (head !== null && show(head, SELF) === null) return { skipped: true, findings: [] };
	const fork = git("merge-base", base, tip).trim();

	const commits = git("rev-list", "--parents", `${fork}..${tip}`)
		.split("\n")
		.filter(Boolean)
		.map((row) => row.split(" "));
	const answers = run(["cat-file", "--batch-check"], commits.map(([commit]) => `${commit}:${SELF}\n`).join("")).split("\n");
	const holdsRule = new Map(commits.map(([commit], index) => [commit, !answers[index].endsWith(" missing")]));
	const befores = [];
	for (const [commit, ...parents] of commits) {
		if (!holdsRule.get(commit)) continue;
		for (const parent of parents) {
			if (holdsRule.get(parent) !== false || befores.some((before) => before.revision === parent)) continue;
			befores.push({
				revision: parent,
				touched: new Set(changes(`${fork}...${parent}`).flatMap((change) => (change.deleted ? [] : [change.path]))),
				nameThen: new Map(changes(parent, ...upTo).map((change) => [change.path, change.from])),
			});
		}
	}

	const changed = changes(fork, ...upTo);
	if (head === null) {
		for (const path of git("ls-files", "--others", "--exclude-standard", "-z").split("\0").filter(Boolean)) {
			changed.push({ path, from: path, deleted: false });
		}
	}
	let elsewhere = null;
	const linesElsewhere = () => {
		if (elsewhere !== null) return elsewhere;
		elsewhere = new Set();
		for (const { from } of changed) if (languageOf(from) !== null) commentLines(from, show(fork, from), elsewhere);
		for (const before of befores) {
			for (const path of before.touched) if (languageOf(path) !== null) commentLines(path, show(before.revision, path), elsewhere);
		}
		return elsewhere;
	};

	const findings = [];
	for (const { path, from, deleted } of changed) {
		if (deleted || languageOf(path) === null) continue;
		const now = head === null ? read(join(cwd, path)) : show(head, path);
		if (now === null) continue;
		const olds = [[from, languageOf(from) === null ? null : show(fork, from)]];
		if (newFindings(path, now, olds).length === 0) continue;
		for (const before of befores) {
			const earlier = before.nameThen.get(path) ?? path;
			if (before.touched.has(earlier) && languageOf(earlier) !== null) olds.push([earlier, show(before.revision, earlier)]);
		}
		if (newFindings(path, now, olds).length === 0) continue;
		findings.push(...newFindings(path, now, olds, linesElsewhere()));
	}
	return { skipped: false, findings };
}

const PROBLEMS = {
	plain: `comment without "${MARKER}"`,
	empty: `"${MARKER}" with no reason after it`,
	long: `"${MARKER}" comment longer than ${MAX_LINES} lines`,
};

export function describeFindings(findings) {
	return [
		...findings.map((finding) => {
			const text = finding.text.length > 80 ? `${finding.text.slice(0, 77)}...` : finding.text;
			return `${finding.path}:${finding.line}  ${PROBLEMS[finding.problem]}: ${text}`;
		}),
		"",
		`${findings.length} new or edited comment(s) break the comment rule (AGENTS.md, "Comments").`,
		"Delete the comment and let the code say it: a better name, a smaller function, a type.",
		"A rule others must follow becomes a lint rule or a test. Something still to do gets done.",
		"Keep a comment only where the code looks wrong but is right and no test can hold the reason:",
		`start it with "${MARKER}" and keep it to ${MAX_LINES} lines. Do not add "${MARKER}" to anything else.`,
	];
}

function main(args) {
	const options = {};
	for (let index = 0; index < args.length; index += 2) {
		if ((args[index] !== "--base" && args[index] !== "--head") || !args[index + 1]) {
			console.error("usage: node scripts/check-comments.mjs [--base <revision>] [--head <revision>]");
			return 2;
		}
		options[args[index].slice(2)] = args[index + 1];
	}
	let result;
	try {
		result = check(options);
	} catch (error) {
		console.error(`check-comments could not read the change: ${error.stderr?.trim() || error.message}`);
		return 2;
	}
	if (result.skipped) {
		console.log("check-comments: this branch does not hold the comment rule yet; nothing checked.");
		return 0;
	}
	if (result.findings.length === 0) return 0;
	for (const line of describeFindings(result.findings)) console.error(line);
	return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	process.exitCode = main(process.argv.slice(2));
}
