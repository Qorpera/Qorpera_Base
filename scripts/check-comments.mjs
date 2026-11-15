import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SELF = "scripts/check-comments.mjs";

export const MARKER = "WHY:";
export const MAX_LINES = 3;

const SCRIPT_KINDS = {
	".ts": ts.ScriptKind.TS,
	".mts": ts.ScriptKind.TS,
	".cts": ts.ScriptKind.TS,
	".tsx": ts.ScriptKind.TSX,
	".js": ts.ScriptKind.JS,
	".mjs": ts.ScriptKind.JS,
	".cjs": ts.ScriptKind.JS,
	".jsx": ts.ScriptKind.JSX,
};
const LANGUAGES = { ".rs": "rust", ".sql": "sql", ".sh": "shell", ".bash": "shell", ".py": "python" };
for (const extension of Object.keys(SCRIPT_KINDS)) LANGUAGES[extension] = "script";

const SKIPPED_SEGMENTS = new Set(["node_modules", "dist", "vendor", "public", ".artifacts"]);
const GENERATED = /\.generated\.|_runtime_bundle_activation_v\d+\.sql$/;

const DIRECTIVES = {
	script:
		/^(?:biome-ignore\b|@ts-(?:expect-error|ignore|nocheck|check)\b|eslint-(?:disable|enable)\b|prettier-ignore\b|(?:v8|c8|istanbul) ignore\b|@(?:vitest|jest)-environment\b|[@#]__(?:PURE|NO_SIDE_EFFECTS)__|@vite-ignore\b|webpack[A-Z]\w*:|[#@] ?sourceMappingURL=|@(?:license|preserve)\b|<(?:reference|amd-module|amd-dependency)\b)/,
	shell: /^shellcheck /,
	python: /^(?:type:|noqa\b|pragma:|pylint:|mypy:|ruff:|fmt:|-\*- )/,
};
const TYPE_TAG = /^@(?:type|typedef|satisfies|import|template|param|returns?|deprecated|internal)\b/;
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

function toUnits(text, spans, language) {
	const starts = lineStarts(text);
	const units = [];
	for (const [from, to] of [...spans].sort((left, right) => left[0] - right[0])) {
		const raw = text.slice(from, to);
		const line = lineAt(starts, from);
		const comment = {
			language,
			line: line + 1,
			endLine: lineAt(starts, Math.max(from, to - 1)) + 1,
			block: raw.startsWith("/*"),
			doc: raw.startsWith("/**"),
			own: text.slice(starts[line], from).trim() === "",
			lines: bodyLines(raw),
		};
		const last = units.at(-1);
		if (last && !last.block && !comment.block && last.own && comment.own && comment.line === last.endLine + 1) {
			last.lines.push(...comment.lines);
			last.endLine = comment.endLine;
		} else units.push(comment);
	}
	return units;
}

function isJsxParent(node) {
	return node !== undefined && (ts.isJsxElement(node) || ts.isJsxFragment(node));
}

function takesTrailingComments(token) {
	const parent = token.parent;
	if (token.kind === ts.SyntaxKind.CloseBraceToken) return !ts.isJsxExpression(parent) || !isJsxParent(parent.parent);
	if (token.kind !== ts.SyntaxKind.GreaterThanToken) return true;
	if (ts.isJsxOpeningElement(parent)) return token.end !== parent.end;
	if (ts.isJsxOpeningFragment(parent)) return false;
	if (ts.isJsxSelfClosingElement(parent)) return token.end !== parent.end || !isJsxParent(parent.parent);
	if (ts.isJsxClosingElement(parent) || ts.isJsxClosingFragment(parent)) return !isJsxParent(parent.parent.parent);
	return true;
}

function scriptSpans(path, text) {
	const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, SCRIPT_KINDS[extname(path)]);
	const spans = new Map();
	const add = (ranges) => {
		for (const range of ranges ?? []) spans.set(range.pos, [range.pos, range.end]);
	};
	const visit = (node) => {
		if (node.kind >= ts.SyntaxKind.FirstJSDocNode && node.kind <= ts.SyntaxKind.LastJSDocNode) return;
		if (!ts.isToken(node)) {
			for (const child of node.getChildren(source)) visit(child);
			return;
		}
		if (node.kind === ts.SyntaxKind.JsxText) return;
		add(ts.getLeadingCommentRanges(text, node.pos));
		if (takesTrailingComments(node)) add(ts.getTrailingCommentRanges(text, node.end));
	};
	visit(source);
	return [...spans.values()];
}

function blockEnd(text, from, to) {
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

function lineEnd(text, from, to) {
	const end = text.indexOf("\n", from);
	return end === -1 || end > to ? to : end;
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
			const end = blockEnd(text, index, text.length);
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
			const end = blockEnd(text, index, to);
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

const HEREDOC = /(?<!<)<<-?\s*(['"\\]?)([A-Za-z_][A-Za-z0-9_]*)/;

function hashSpans(text, shell) {
	const spans = [];
	let terminator = null;
	let offset = 0;
	for (const line of text.split("\n")) {
		const indent = line.length - line.trimStart().length;
		if (terminator !== null) {
			if (line.trim() === terminator) terminator = null;
		} else if (line[indent] === "#") {
			if (offset > 0 || !line.startsWith("#!")) spans.push([offset + indent, offset + line.length]);
		} else if (shell) terminator = HEREDOC.exec(line)?.[2] ?? null;
		offset += line.length + 1;
	}
	return spans;
}

export function commentsIn(path, text) {
	const language = languageOf(path);
	if (language === null) return [];
	const spans =
		language === "script"
			? scriptSpans(path, text)
			: language === "rust"
				? rustSpans(text)
				: language === "sql"
					? sqlSpans(text)
					: hashSpans(text, language === "shell");
	return toUnits(text, spans, language);
}

export function verdict(unit) {
	const lines = unit.lines.filter((line) => line !== "");
	if (lines.length === 0) return null;
	if (DIRECTIVES[unit.language]?.test(lines[0])) return null;
	if (unit.language === "script" && unit.doc && lines.every((line) => TYPE_TAG.test(line))) return null;
	const marker = (MARKERS[unit.language] ?? [MARKER]).find((candidate) => lines[0].startsWith(candidate));
	if (marker === undefined) return "plain";
	if (lines.length === 1 && lines[0].slice(marker.length).trim() === "") return "empty";
	if (unit.lines.length > MAX_LINES) return "long";
	return null;
}

export function newFindings(path, now, olds) {
	const known = new Set();
	for (const [oldPath, text] of olds) {
		if (text === null) continue;
		for (const unit of commentsIn(oldPath, text)) for (const line of unit.lines) known.add(line);
	}
	const findings = [];
	for (const unit of commentsIn(path, now)) {
		if (!unit.lines.some((line) => line !== "" && !known.has(line))) continue;
		const problem = verdict(unit);
		if (problem !== null) findings.push({ path, line: unit.line, problem, text: unit.lines.find((line) => line !== "") });
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
			if (!status.startsWith("D")) found.push({ path, from });
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
				touched: new Set(changes(`${fork}...${parent}`).map((change) => change.path)),
				nameThen: new Map(changes(parent, ...upTo).map((change) => [change.path, change.from])),
			});
		}
	}

	const changed = changes(fork, ...upTo);
	if (head === null) {
		for (const path of git("ls-files", "--others", "--exclude-standard", "-z").split("\0").filter(Boolean)) {
			changed.push({ path, from: path });
		}
	}

	const findings = [];
	for (const { path, from } of changed) {
		if (languageOf(path) === null) continue;
		const now = head === null ? read(join(cwd, path)) : show(head, path);
		if (now === null) continue;
		const olds = [[from, show(fork, from)]];
		if (newFindings(path, now, olds).length === 0) continue;
		for (const before of befores) {
			const earlier = before.nameThen.get(path) ?? path;
			if (before.touched.has(earlier)) olds.push([earlier, show(before.revision, earlier)]);
		}
		findings.push(...newFindings(path, now, olds));
	}
	return { skipped: false, findings };
}

const PROBLEMS = {
	plain: `comment without "${MARKER}"`,
	empty: `"${MARKER}" with no reason after it`,
	long: `"${MARKER}" comment longer than ${MAX_LINES} lines`,
};

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
	for (const finding of result.findings) {
		const text = finding.text.length > 80 ? `${finding.text.slice(0, 77)}...` : finding.text;
		console.error(`${finding.path}:${finding.line}  ${PROBLEMS[finding.problem]}: ${text}`);
	}
	console.error(
		[
			"",
			`${result.findings.length} new or edited comment(s) break the comment rule (AGENTS.md, "Comments").`,
			"Delete the comment and let the code say it: a better name, a smaller function, a type.",
			"A rule others must follow becomes a lint rule or a test. Something still to do gets done.",
			`Keep a comment only where the code looks wrong but is right and no test can hold the reason:`,
			`start it with "${MARKER}" and keep it to ${MAX_LINES} lines. Do not add "${MARKER}" to anything else.`,
		].join("\n"),
	);
	return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	process.exitCode = main(process.argv.slice(2));
}
