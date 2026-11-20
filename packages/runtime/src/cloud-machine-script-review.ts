import { createHash } from "node:crypto";
import { posix } from "node:path";
import { type JsonValue, SHA256_HEX_PATTERN } from "@qorpera/contracts";

export const CLOUD_SCRIPT_FILE_BYTES = 64 * 1024;
export const CLOUD_SCRIPT_SHOWN =
	"The files this command names, each as it is on the machine now and in full. They are evidence about the work, not proof of what will run: the machine is the agent's own, and its setup can make a command run something else. Files they load, import or read themselves are not shown.";
export const CLOUD_SCRIPT_LATER = "only the first command's file is shown";
export const CLOUD_COMMAND_NOT_PLAIN =
	"the command uses shell features the review does not follow, so the files it runs are not shown";

const HOME = "/root";
const MAX_PATH_BYTES = 512;
const PROGRAMS = /^\/(usr|bin|sbin|lib|lib64|opt|snap)\/|^\/root\/(\.local|\.cargo|\.bun|\.deno|go)\/bin\//;
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const PLAIN = /^[A-Za-z0-9_./\-+=:,@%]$/;
const QUOTED = /^[A-Za-z0-9_./\-+=:,@% ]*$/;
const REDIRECTS = ["2>&1", "2>>", "2>", "&>", ">>", ">"];
const PREFIXES = new Set(["time", "nohup", "nice", "timeout", "xvfb-run"]);
const QUIET = new Set(["2>&1", "> /dev/null", "2> /dev/null", "&> /dev/null"]);
const COUNT = /^[0-9]{1,9}$/;
const KEY = /^[0-9]{1,4}(?:\.[0-9]{1,4})?[bdfgiMhnRrV]*(?:,[0-9]{1,4}(?:\.[0-9]{1,4})?[bdfgiMhnRrV]*)?$/;
const DURATION = /^[0-9]{1,6}(\.[0-9]{1,3})?[smhd]?$/;
const NICENESS = /^-?[0-9]{1,2}$/;

interface Interpreter {
	readonly inline: readonly string[];
	readonly allowed: readonly string[];
	readonly module?: readonly string[];
}

const SHELL: Interpreter = { inline: ["-c"], allowed: ["-e", "-u", "-x", "-eu", "-ex", "-eux"] };
const SHELL_SETTINGS = new Set(["pipefail", "errexit", "nounset"]);
const PYTHON: Interpreter = { inline: ["-c"], allowed: ["-u", "-B", "-O", "-q"], module: ["-m"] };
const NODE: Interpreter = { inline: ["-e", "--eval", "-p", "--print"], allowed: [] };
const INTERPRETERS: Readonly<Record<string, Interpreter>> = {
	bash: SHELL,
	sh: SHELL,
	dash: SHELL,
	python: PYTHON,
	python3: PYTHON,
	node: NODE,
	nodejs: NODE,
	tsx: NODE,
	"ts-node": NODE,
	ruby: { inline: ["-e"], allowed: [] },
	perl: { inline: ["-e", "-E"], allowed: [] },
	php: { inline: ["-r"], allowed: [] },
	Rscript: { inline: ["-e"], allowed: [] },
	lua: { inline: ["-e"], allowed: [] },
};

interface Word {
	readonly text: string;
	readonly start: number;
}

type Join = "start" | "&&" | "|";

type Token = { readonly word: Word } | { readonly join: Join } | { readonly redirect: string };

interface Simple {
	readonly words: Word[];
	readonly redirects: string[];
	readonly joined: Join;
	alone: boolean;
}

export interface CloudCommandScriptRun {
	readonly path: string;
}

export interface CloudCommandScripts {
	readonly files: readonly CloudCommandScriptRun[];
	readonly notShown: readonly string[];
}

export function cloudCommandTokens(command: string): Token[] | undefined {
	const tokens: Token[] = [];
	let at = 0;
	const edge = (index: number) => index >= command.length || " \t\n;&|>".includes(command[index] as string);
	const begins = () => at === 0 || " \t\n;&|>".includes(command[at - 1] as string);
	const word = (): Word | undefined => {
		const start = at;
		const mark = command[at];
		if (mark === "'" || mark === '"') {
			if (!begins()) return undefined;
			const close = command.indexOf(mark, at + 1);
			if (close < 0 || !QUOTED.test(command.slice(at + 1, close)) || !edge(close + 1)) return undefined;
			at = close + 1;
			return { text: command.slice(start + 1, close), start };
		}
		while (at < command.length && PLAIN.test(command[at] as string)) at += 1;
		if (at === start || !edge(at) || (command[at] === ">" && /^[0-9]+$/.test(command.slice(start, at))))
			return undefined;
		return { text: command.slice(start, at), start };
	};
	while (at < command.length) {
		const char = command[at] as string;
		if (char === " " || char === "\t") {
			at += 1;
			continue;
		}
		if (char === "\n" || char === ";") {
			if (command[at + 1] === ";") return undefined;
			tokens.push({ join: "start" });
			at += 1;
			continue;
		}
		if (command.startsWith("&&", at)) {
			tokens.push({ join: "&&" });
			at += 2;
			continue;
		}
		if (char === "|") {
			if (command[at + 1] === "|" || command[at + 1] === "&") return undefined;
			tokens.push({ join: "|" });
			at += 1;
			continue;
		}
		const redirect = REDIRECTS.find((item) => command.startsWith(item, at) && (!item.startsWith("2") || begins()));
		if (redirect) {
			at += redirect.length;
			if (redirect === "2>&1") {
				if (!edge(at)) return undefined;
				tokens.push({ redirect });
				continue;
			}
			while (command[at] === " " || command[at] === "\t") at += 1;
			const target = word();
			if (!target) return undefined;
			tokens.push({ redirect: `${redirect} ${target.text}` });
			continue;
		}
		const next = word();
		if (!next) return undefined;
		tokens.push({ word: next });
	}
	return tokens;
}

function simplesOf(tokens: readonly Token[]): Simple[] {
	const simples: Simple[] = [];
	let current: Simple = { words: [], redirects: [], joined: "start", alone: false };
	for (const token of tokens) {
		if ("word" in token) {
			current.words.push(token.word);
			continue;
		}
		if ("redirect" in token) {
			current.redirects.push(token.redirect);
			continue;
		}
		if (token.join === "|") current.alone = true;
		if (current.words.length > 0) simples.push(current);
		current = { words: [], redirects: [], joined: token.join, alone: token.join === "|" };
	}
	if (current.words.length > 0) simples.push(current);
	return simples;
}

function basename(text: string): string {
	return text.slice(text.lastIndexOf("/") + 1);
}

function interpreterOf(name: string): Interpreter | undefined {
	return INTERPRETERS[/^python3\.[0-9]{1,2}$/.test(name) ? "python3" : name];
}

function shortFlags(interpreter: Interpreter, option: string, letters: readonly string[]): boolean {
	return (
		letters.includes(option) ||
		(/^-[A-Za-z]{2,}$/.test(option) &&
			letters.some((flag) => /^-[A-Za-z]$/.test(flag) && option.includes(flag.slice(1))) &&
			interpreter !== NODE)
	);
}

function runner(name: string): boolean {
	const base = basename(name);
	return name === "deno" || base === "deno" || interpreterOf(base) !== undefined || PREFIXES.has(base);
}

type Located = { readonly path: string } | { readonly why: string };

function climbs(text: string): boolean {
	return text.split("/").includes("..");
}

function locate(word: Word, folder: string): Located {
	if (climbs(word.text))
		return { why: `${line(word.text)}: its path goes up through "..", which a link can lead elsewhere` };
	const path = posix.resolve(folder, word.text);
	if (Buffer.byteLength(path) > MAX_PATH_BYTES) return { why: `${line(word.text)}: its name is too long to read` };
	return { path };
}

function programName(word: Word | undefined): string | undefined {
	if (!word) return undefined;
	if (!word.text.includes("/")) return word.text;
	if (climbs(word.text)) return undefined;
	return PROGRAMS.test(posix.resolve(word.text)) ? basename(word.text) : undefined;
}

type Start = { readonly at: number; readonly prefixed: boolean } | { readonly why: string };

function commandStart(words: readonly Word[]): Start {
	let at = 0;
	let prefixed = false;
	for (;;) {
		const word = words[at];
		if (word && ASSIGNMENT.test(word.text))
			return { why: `${line(word.text)}: it sets a variable for the command, which can change what runs` };
		const name = programName(word);
		if (name === undefined || !PREFIXES.has(name)) return { at, prefixed };
		prefixed = true;
		at += 1;
		if (name === "nice") {
			if (words[at]?.text === "-n" && NICENESS.test(words[at + 1]?.text ?? "")) at += 2;
		} else if (name === "timeout") {
			if (!DURATION.test(words[at]?.text ?? ""))
				return { why: "timeout: it runs its program with options the review does not follow" };
			at += 1;
		} else if (name === "xvfb-run" && words[at]?.text === "-a") at += 1;
		if (words[at]?.text.startsWith("-"))
			return { why: `${name}: it runs its program with options the review does not follow` };
	}
}

type Script = { readonly script?: Word; readonly inline?: true; readonly why?: string };

function interpreterScript(name: string, interpreter: Interpreter, words: readonly Word[], at: number): Script {
	for (let index = at + 1; index < words.length; ) {
		const word = words[index] as Word;
		const option = word.text;
		if (!option.startsWith("-") && !(interpreter === SHELL && option.startsWith("+"))) return { script: word };
		if (shortFlags(interpreter, option, interpreter.inline)) return { inline: true };
		if (interpreter.module && shortFlags(interpreter, option, interpreter.module))
			return { why: `${line(name)} ${line(option)}: it runs a module the review does not read` };
		if (interpreter.allowed.includes(option)) {
			index += 1;
			continue;
		}
		if (interpreter === SHELL && option === "-o" && SHELL_SETTINGS.has(words[index + 1]?.text ?? "")) {
			index += 2;
			continue;
		}
		if (option === "-") return {};
		return { why: `${line(name)} ${line(option)}: it runs with options the review does not follow` };
	}
	return {};
}

function looksLikeScript(command: string): boolean {
	return command
		.split(/[\s;&|()<>{}'"`]+/)
		.some((part) => part === "source" || part === "." || part.startsWith("./") || runner(part));
}

type Runner =
	| { readonly script: Word }
	| { readonly why: string }
	| { readonly none: true }
	| { readonly other: string; readonly rest: string };

function runnerOf(simple: Simple): Runner {
	const words = simple.words;
	const begun = commandStart(words);
	if ("why" in begun) return begun;
	const program = words[begun.at];
	const name = programName(program);
	const other = {
		other: name ?? program?.text ?? "",
		rest: words
			.slice(begun.at + 1)
			.map((word) => word.text)
			.join(" "),
	};
	if (!program || name === "cd") return other;
	if (name === "source" || name === ".") {
		const file = words[begun.at + 1];
		if (begun.prefixed) return { why: `${line(name)}: the review does not follow what runs it` };
		if (!file) return { none: true };
		if (!file.text.includes("/"))
			return { why: `${line(file.text)}: the shell looks it up on its program path first` };
		return { script: file };
	}
	const interpreter = name === undefined ? undefined : interpreterOf(name);
	if (name !== undefined && interpreter) {
		const found = interpreterScript(name, interpreter, words, begun.at);
		if (found.why) return { why: found.why };
		if (found.script) return { script: found.script };
		if (!found.inline && simple.joined === "|")
			return { why: `${line(name)} runs what another program prints into it, which the review cannot see` };
		return { none: true };
	}
	if (name === "deno") {
		const script = words[begun.at + 2];
		if (words[begun.at + 1]?.text !== "run" || !script) return other;
		if (script.text.startsWith("-"))
			return { why: `deno run ${line(script.text)}: it runs with options the review does not follow` };
		return { script };
	}
	if (name === undefined && program.text.includes("/")) return { script: program };
	return other;
}

function options(words: readonly string[], whole: RegExp, valued: Readonly<Record<string, RegExp>> = {}): boolean {
	for (let at = 0; at < words.length; at += 1) {
		const word = words[at] as string;
		if (whole.test(word)) continue;
		const value = valued[word];
		if (!value || !value.test(words[at + 1] ?? "")) return false;
		at += 1;
	}
	return true;
}

function reads(simple: Simple): boolean {
	const [program, ...rest] = simple.words.map((word) => word.text);
	if (simple.redirects.length > 0) return false;
	switch (program) {
		case "head":
		case "tail":
			return options(rest, /^-(?:[nc])?[0-9]{1,9}$/, { "-n": COUNT, "-c": COUNT });
		case "grep":
			return (
				rest.length > 0 &&
				!(rest.at(-1) as string).startsWith("-") &&
				rest.slice(0, -1).every((word) => /^-[ivncEFowxsqha]+$/.test(word))
			);
		case "cat":
			return rest.length === 0;
		case "wc":
			return rest.every((word) => /^-[lwcm]+$/.test(word));
		case "sort":
			return options(rest, new RegExp(`^-(?:[rnufbhV]+|k${KEY.source.slice(1, -1)}|t[^-])$`), {
				"-k": KEY,
				"-t": /^[^-]$/,
			});
		case "uniq":
			return rest.every((word) => /^-(?:[cdui]+|[fsw][0-9]{1,9})$/.test(word));
		default:
			return false;
	}
}

function besideOf(simples: readonly Simple[], at: number): string | undefined {
	const first = simples[at] as Simple;
	const loud = first.redirects.find((redirect) => !QUIET.has(redirect));
	if (loud) return `${line(loud)}: the command writes its output to a file, which can change the script as it runs`;
	for (const peer of simples.slice(at + 1)) {
		if (peer.joined !== "|") break;
		if (!reads(peer))
			return `${line([textOf(peer), ...peer.redirects].join(" "))}: it runs beside the script, and the review does not follow it`;
	}
	return undefined;
}

function textOf(simple: Simple): string {
	return simple.words.map((word) => word.text).join(" ");
}

export function cloudCommandScripts(command: string, start = HOME): CloudCommandScripts {
	const tokens = cloudCommandTokens(command);
	if (!tokens) return { files: [], notShown: looksLikeScript(command) ? [CLOUD_COMMAND_NOT_PLAIN] : [] };
	const simples = simplesOf(tokens);
	const files: CloudCommandScriptRun[] = [];
	const notShown = new Set<string>();
	let folder = start;
	let at = 0;
	for (; at < simples.length; at += 1) {
		const simple = simples[at] as Simple;
		const target = simple.words[1];
		if (simple.words[0]?.text !== "cd" || simple.alone || simple.words.length !== 2 || !target) break;
		if (simple.redirects.length > 0) break;
		if (target.text.startsWith("-") || simples[at + 1]?.joined !== "&&") break;
		const located = locate(target, folder);
		if ("why" in located) {
			notShown.add(located.why);
			break;
		}
		folder = located.path;
	}
	const first = simples[at];
	if (first) {
		const found = runnerOf(first);
		const beside = besideOf(simples, at);
		if ("script" in found && beside) notShown.add(beside);
		else if ("script" in found) {
			const located = locate(found.script, folder);
			if ("why" in located) notShown.add(located.why);
			else files.push({ path: located.path });
		} else if ("why" in found) {
			if (looksLikeScript(textOf(first))) notShown.add(found.why);
		} else if ("other" in found && looksLikeScript(found.rest))
			notShown.add(`${line(found.other)}: the review does not follow what it runs`);
	}
	for (const simple of simples.slice(at + 1)) {
		const found = runnerOf(simple);
		if ("script" in found) notShown.add(`${line(found.script.text)}: ${CLOUD_SCRIPT_LATER}`);
		else if ("why" in found && looksLikeScript(textOf(simple))) notShown.add(found.why);
		else if ("other" in found && looksLikeScript(found.rest))
			notShown.add(`${line(textOf(simple))}: ${CLOUD_SCRIPT_LATER}`);
	}
	return { files, notShown: [...notShown] };
}

function line(text: string): string {
	return text.replace(/\s+/g, " ").slice(0, 200);
}

function quote(text: string): string {
	return `'${text.replaceAll("'", `'\\''`)}'`;
}

const READ_MARK = "QORPERA-REVIEW-READ";

export function cloudScriptReadProgram(paths: readonly string[]): string {
	return `echo ${READ_MARK}; { for f in ${paths.map(quote).join(" ")}; do if [ ! -e "$f" ]; then echo M; elif [ ! -f "$f" ] || [ ! -r "$f" ]; then echo X; else s=$(stat -c %s -- "$f") || s=0; if [ "$s" -gt ${CLOUD_SCRIPT_FILE_BYTES} ]; then echo "L $s"; else echo "F $s"; base64 -w 0 < "$f"; echo; fi; fi; done; } 2>/dev/null`;
}

export type CloudScriptEntry =
	| { readonly path: string; readonly sha256: string; readonly bytes: number; readonly written?: string }
	| { readonly path: string; readonly notShown: string };

export interface CloudWrittenScript {
	readonly path: string;
	readonly text: string;
}

const WRITTEN_PATH = String.raw`(\/[A-Za-z0-9_./\-+@%,:=]+)`;
const WRITTEN_TAG = String.raw`(['"])([A-Za-z_][A-Za-z0-9_]*)`;
const WRITE_THEN_TAG = new RegExp(String.raw`^[ \t]*cat[ \t]+>[ \t]*${WRITTEN_PATH}[ \t]+<<[ \t]*${WRITTEN_TAG}\2[ \t]*$`);
const TAG_THEN_WRITE = new RegExp(String.raw`^[ \t]*cat[ \t]+<<[ \t]*${WRITTEN_TAG}\1[ \t]+>[ \t]*${WRITTEN_PATH}[ \t]*$`);

export function cloudCommandWrittenScripts(command: string): CloudWrittenScript[] {
	const lines = command.split("\n");
	const written = new Map<string, string>();
	for (let at = 0; at < lines.length; at += 1) {
		const line = lines[at] as string;
		const first = WRITE_THEN_TAG.exec(line);
		const second = first ? null : TAG_THEN_WRITE.exec(line);
		const path = first?.[1] ?? second?.[3];
		const tag = first?.[3] ?? second?.[2];
		if (path === undefined || tag === undefined) continue;
		const end = lines.indexOf(tag, at + 1);
		if (end < 0) break;
		const text = lines
			.slice(at + 1, end)
			.map((body) => `${body}\n`)
			.join("");
		if (Buffer.byteLength(text) <= CLOUD_SCRIPT_FILE_BYTES) written.set(posix.normalize(path), text);
		else written.delete(posix.normalize(path));
		at = end;
	}
	return [...written].map(([path, text]) => ({ path, text }));
}

export const CLOUD_SCRIPT_WRITTEN = (why: string) =>
	`Not read from the machine just now (${why}). This is the text this run wrote to the file with an earlier command; a later command may have changed it.`;

export interface CloudScriptRead {
	readonly entries: CloudScriptEntry[];
	readonly texts: Map<string, string>;
}

const UTF8 = new TextDecoder("utf-8", { fatal: true });

export function cloudScriptNotRead(files: readonly CloudCommandScriptRun[], why: string): CloudScriptEntry[] {
	return files.map((file) => ({ path: file.path, notShown: why }));
}

export function parseCloudScriptRead(output: string, files: readonly CloudCommandScriptRun[]): CloudScriptRead {
	const mark = output.lastIndexOf(`${READ_MARK}\n`);
	if (mark < 0 || (mark > 0 && output[mark - 1] !== "\n")) throw new Error("Script read differs");
	const lines = output.slice(mark + READ_MARK.length + 1).split("\n");
	const entries: CloudScriptEntry[] = [];
	const texts = new Map<string, string>();
	let at = 0;
	for (const file of files) {
		const head = lines[at++] ?? "";
		const kind = head.slice(0, 1);
		const size = Number(head.slice(2));
		if (kind === "M") {
			entries.push({ path: file.path, notShown: "it is not on the machine now" });
			continue;
		}
		if (kind === "X") {
			entries.push({ path: file.path, notShown: "it is not a plain file the review can read, such as a folder" });
			continue;
		}
		if (kind === "L") {
			entries.push({
				path: file.path,
				notShown: `it is ${Number.isSafeInteger(size) ? size : "over"} bytes, more than the ${CLOUD_SCRIPT_FILE_BYTES / 1024} KiB the review reads of one file`,
			});
			continue;
		}
		if (kind !== "F" || head.length < 3) throw new Error("Script read differs");
		const encoded = lines[at++] ?? "";
		const bytes = Buffer.from(encoded, "base64");
		if (bytes.toString("base64") !== encoded || bytes.length > CLOUD_SCRIPT_FILE_BYTES)
			throw new Error("Script read differs");
		let text: string;
		try {
			text = UTF8.decode(bytes);
		} catch {
			text = "\0";
		}
		if (text.includes("\0")) {
			entries.push({ path: file.path, notShown: "it is not text, so the review cannot read it" });
			continue;
		}
		const sha256 = createHash("sha256").update(bytes).digest("hex");
		texts.set(sha256, text);
		entries.push({
			path: file.path,
			sha256,
			bytes: bytes.length,
		});
	}
	return { entries, texts };
}

export interface CloudPreparedScripts {
	readonly files: readonly CloudScriptEntry[];
	readonly notShown: readonly string[];
}

export function parseCloudPreparedScripts(value: JsonValue | undefined): CloudPreparedScripts | undefined {
	if (value === undefined) return undefined;
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid reviewed files");
	const { files, notShown } = value as Record<string, JsonValue>;
	if (
		Object.keys(value).sort().join() !== "files,notShown" ||
		!Array.isArray(files) ||
		files.length > 1 ||
		!Array.isArray(notShown) ||
		notShown.some((reason) => typeof reason !== "string")
	)
		throw new Error("Invalid reviewed files");
	for (const file of files) {
		const entry = file as Record<string, JsonValue>;
		if (
			!entry ||
			typeof entry !== "object" ||
			typeof entry.path !== "string" ||
			!entry.path.startsWith("/") ||
			(entry.written !== undefined && typeof entry.written !== "string") ||
			(typeof entry.notShown !== "string" &&
				(typeof entry.sha256 !== "string" ||
					!SHA256_HEX_PATTERN.test(entry.sha256) ||
					!Number.isSafeInteger(entry.bytes)))
		)
			throw new Error("Invalid reviewed files");
	}
	return { files: files as unknown as CloudScriptEntry[], notShown: notShown as string[] };
}

export function cloudScriptIdentity(scripts: CloudPreparedScripts): string {
	return JSON.stringify([
		"qorpera.reviewed-files/v1",
		scripts.files.map((entry) => ("sha256" in entry ? [entry.path, entry.sha256] : [entry.path, null])),
		scripts.notShown.length > 0,
	]);
}

export function cloudScriptContents(scripts: CloudPreparedScripts, texts: ReadonlyMap<string, string>): JsonValue {
	const notShown = [
		...scripts.notShown,
		...scripts.files.flatMap((entry) => ("notShown" in entry ? [`${entry.path}: ${entry.notShown}`] : [])),
	];
	return {
		shown: CLOUD_SCRIPT_SHOWN,
		files: scripts.files.map((entry): JsonValue => {
			if ("notShown" in entry) return { path: entry.path, notShown: entry.notShown };
			const text = texts.get(entry.sha256);
			if (text === undefined) throw new Error("Reviewed file is gone");
			return {
				path: entry.path,
				bytes: entry.bytes,
				sha256: entry.sha256,
				text,
				...(entry.written === undefined ? {} : { written: CLOUD_SCRIPT_WRITTEN(entry.written) }),
			};
		}),
		...(notShown.length > 0 ? { notShown } : {}),
	};
}

export function cloudScriptContentsIncomplete(contents: JsonValue | undefined): boolean {
	if (!contents || typeof contents !== "object" || Array.isArray(contents)) return false;
	const notShown = (contents as Record<string, JsonValue>).notShown;
	return Array.isArray(notShown) && notShown.length > 0;
}
