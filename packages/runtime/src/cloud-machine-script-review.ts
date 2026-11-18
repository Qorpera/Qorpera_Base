import { createHash } from "node:crypto";
import { posix } from "node:path";
import { type JsonValue, SHA256_HEX_PATTERN } from "@qorpera/contracts";

export const CLOUD_SCRIPT_FILE_BYTES = 64 * 1024;
export const CLOUD_SCRIPT_TOTAL_BYTES = 128 * 1024;
export const CLOUD_SCRIPT_FILES = 8;
export const CLOUD_SCRIPT_SHOWN =
	"The files this command names, each as it is on the machine now and in full. They are evidence about the work, not proof of what will run: the machine is the agent's own, and its setup can make a command run something else. Files they load, import or read themselves are not shown.";
export const CLOUD_COMMAND_NOT_PLAIN =
	"the command uses shell features the review does not follow, so the files it runs are not shown";

const HOME = "/root";
const MAX_PATH_BYTES = 512;
const PROGRAMS = /^\/(usr|bin|sbin|lib|lib64|opt|snap)\/|^\/root\/(\.local|\.cargo|\.bun|\.deno|go)\/bin\//;
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const PLAIN = /^[A-Za-z0-9_./\-+=:,@%]$/;
const QUOTED = /^[A-Za-z0-9_./\-+=:,@% ]*$/;
const REDIRECTS = ["2>&1", "2>>", "2>", "&>", ">>", ">"];
const STEERING =
	/^(PATH|CDPATH|ENV|BASH_ENV|IFS|HOME|PWD|OLDPWD|PYTHONPATH|PYTHONSTARTUP|PYTHONHOME|NODE_OPTIONS|NODE_PATH|RUBYOPT|RUBYLIB|PERL5OPT|PERL5LIB|LD_PRELOAD|LD_LIBRARY_PATH|BASH_FUNC_[^=]*)\+?=/;
const FOLDER_WORDS = new Set([
	"cd",
	"pushd",
	"popd",
	"source",
	".",
	"eval",
	"exec",
	"command",
	"builtin",
	"alias",
	"shopt",
	"trap",
	"set",
	"export",
	"unset",
	"hash",
	"enable",
	"declare",
	"typeset",
	"readonly",
	"local",
]);
const SOURCED_WORDS = new Set([
	"cd",
	"pushd",
	"popd",
	"eval",
	"source",
	"exec",
	"command",
	"builtin",
	"alias",
	"shopt",
	"trap",
	"CDPATH",
	"enable",
]);
const RESERVED = new Set([
	"if",
	"then",
	"else",
	"elif",
	"fi",
	"case",
	"esac",
	"for",
	"select",
	"while",
	"until",
	"do",
	"done",
	"function",
	"coproc",
]);
const STEERS = new Set(["hash", "enable", "alias"]);
const PREFIXES = new Set(["env", "time", "nohup", "nice", "timeout", "xvfb-run"]);
const WRAPPERS = new Set([
	"sudo",
	"doas",
	"ionice",
	"stdbuf",
	"setsid",
	"exec",
	"command",
	"builtin",
	"chroot",
	"strace",
]);
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

type Token = { readonly word: Word } | { readonly join: Join };

interface Simple {
	readonly words: Word[];
	readonly joined: Join;
	alone: boolean;
}

export interface CloudCommandScriptRun {
	readonly path: string;
	readonly mentioned: boolean;
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
				continue;
			}
			while (command[at] === " " || command[at] === "\t") at += 1;
			if (!word()) return undefined;
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
	let current: Simple = { words: [], joined: "start", alone: false };
	for (const token of tokens) {
		if ("word" in token) {
			current.words.push(token.word);
			continue;
		}
		if (token.join === "|") current.alone = true;
		if (current.words.length > 0) simples.push(current);
		current = { words: [], joined: token.join, alone: token.join === "|" };
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

function locate(word: Word, folder: string | null): Located {
	if (!word.text.startsWith("/") && folder === null)
		return { why: `${line(word.text)}: the folder it is in could not be told` };
	const path = posix.resolve(folder ?? "/", word.text);
	if (Buffer.byteLength(path) > MAX_PATH_BYTES) return { why: `${line(word.text)}: its name is too long to read` };
	return { path };
}

function programName(word: Word | undefined): string | undefined {
	if (!word) return undefined;
	if (!word.text.includes("/")) return word.text;
	return PROGRAMS.test(posix.resolve(word.text)) ? basename(word.text) : undefined;
}

type Start = { readonly at: number; readonly prefixed: boolean } | { readonly why: string };

function commandStart(words: readonly Word[]): Start {
	let at = 0;
	let prefixed = false;
	const assignments = (): string | undefined => {
		while (words[at] && ASSIGNMENT.test((words[at] as Word).text)) {
			const word = words[at] as Word;
			if (STEERING.test(word.text)) return `${line(word.text)}: it changes which code the command runs`;
			at += 1;
		}
		return undefined;
	};
	while (words[at] && RESERVED.has((words[at] as Word).text)) at += 1;
	const first = assignments();
	if (first) return { why: first };
	for (;;) {
		const name = programName(words[at]);
		if (name === undefined || !PREFIXES.has(name)) return { at, prefixed };
		prefixed = true;
		at += 1;
		if (name === "env") {
			const why = assignments();
			if (why) return { why };
		} else if (name === "nice") {
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

export function cloudScriptKeepsFolder(file: string): boolean {
	const text = file
		.split("\n")
		.filter((row) => !/^\s*#/.test(row))
		.join("\n");
	if (text.split(/[^A-Za-z0-9_]+/).some((token) => SOURCED_WORDS.has(token))) return false;
	if (/(^|[\n;&|])[ \t]*\.[ \t]/.test(text)) return false;
	const names = [
		...[...text.matchAll(/([^\s;&|(){}<>]+)[ \t]*\([ \t]*\)/g)].map((match) => match[1] as string),
		...[...text.matchAll(/(?:^|[\s;&|])function[ \t]+([^\s;&|(){}<>]+)/g)].map((match) => match[1] as string),
	];
	return names.every(
		(name) =>
			/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && !runner(name) && !["cd", "pushd", "popd", "source"].includes(name),
	);
}

export function cloudCommandScripts(
	command: string,
	start: string | null = HOME,
	settled: ReadonlySet<string> = new Set(),
): CloudCommandScripts {
	const tokens = cloudCommandTokens(command);
	if (!tokens) return { files: [], notShown: looksLikeScript(command) ? [CLOUD_COMMAND_NOT_PLAIN] : [] };
	const simples = simplesOf(tokens);
	const files: CloudCommandScriptRun[] = [];
	const notShown = new Set<string>();
	const words = simples.flatMap((simple) => simple.words);
	const moves = words.some((word) => FOLDER_WORDS.has(word.text) || STEERING.test(word.text));
	const compound = simples.some((simple) => RESERVED.has(simple.words[0]?.text ?? ""));
	let folder = start;
	let chained = !compound;
	const run = (word: Word, base: string | null) => {
		const located = locate(word, base);
		if ("why" in located) {
			notShown.add(located.why);
			return;
		}
		if (files.some((file) => file.path === located.path)) return;
		const before = command.slice(0, word.start);
		files.push({ path: located.path, mentioned: before.includes(located.path) || before.includes(word.text) });
	};
	for (const [index, simple] of simples.entries()) {
		if (index > 0 && simple.joined === "start") chained = false;
		const base = chained ? folder : moves ? null : start;
		const words = simple.words;
		const head = words[0]?.text;
		if (chained && !simple.alone && head === "cd") {
			const target = words[1]?.text === "--" ? words[2] : words[1];
			const size = words[1]?.text === "--" ? 3 : 2;
			const located =
				target && words.length === size && !target.text.startsWith("-") ? locate(target, folder) : undefined;
			folder = located && "path" in located ? located.path : null;
			continue;
		}
		const begun = commandStart(words);
		if ("why" in begun) {
			if (looksLikeScript(words.map((word) => word.text).join(" "))) notShown.add(begun.why);
			if (chained) folder = null;
			continue;
		}
		const program = words[begun.at];
		if (!program || program.text.startsWith("-")) continue;
		const name = programName(program);
		if (name === "source" || name === ".") {
			const file = words[begun.at + 1];
			const located = file ? locate(file, base) : undefined;
			if (begun.prefixed) notShown.add(`${line(name)}: the review does not follow what runs it`);
			else if (file && !file.text.includes("/"))
				notShown.add(`${line(file.text)}: the shell looks it up on its program path first`);
			else if (file) run(file, base);
			const keeps =
				!begun.prefixed && !simple.alone && words.length === begun.at + 2 && file?.text.includes("/") && located;
			if (chained && !(keeps && "path" in located && settled.has(located.path))) folder = null;
			continue;
		}
		if (chained && words.some((word) => FOLDER_WORDS.has(word.text))) folder = null;
		if (name !== undefined && WRAPPERS.has(name)) {
			if (
				looksLikeScript(
					words
						.slice(begun.at + 1)
						.map((word) => word.text)
						.join(" "),
				)
			)
				notShown.add(`${line(name)}: the review does not follow what it runs`);
			continue;
		}
		const interpreter = name === undefined ? undefined : interpreterOf(name);
		if (name !== undefined && interpreter) {
			const found = interpreterScript(name, interpreter, words, begun.at);
			if (found.why) notShown.add(found.why);
			else if (found.script) run(found.script, base);
			else if (!found.inline && simple.joined === "|")
				notShown.add(`${line(name)} runs what another program prints into it, which the review cannot see`);
			continue;
		}
		if (name === "deno") {
			const script = words[begun.at + 2];
			if (words[begun.at + 1]?.text !== "run" || !script) continue;
			if (script.text.startsWith("-"))
				notShown.add(`deno run ${line(script.text)}: it runs with options the review does not follow`);
			else run(script, base);
			continue;
		}
		if (name === undefined && program.text.includes("/")) run(program, base);
	}
	if (words.some((word) => STEERING.test(word.text) || STEERS.has(word.text)) && files.length > 0)
		return {
			files: [],
			notShown: [
				...files.map((file) => `${file.path}: the command changes which program or code its commands run`),
				...notShown,
			],
		};
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
	| { readonly path: string; readonly sha256: string; readonly bytes: number; readonly changedByCommand?: true }
	| { readonly path: string; readonly notShown: string };

export interface CloudScriptRead {
	readonly entries: CloudScriptEntry[];
	readonly texts: Map<string, string>;
}

const UTF8 = new TextDecoder("utf-8", { fatal: true });

export function cloudScriptNotRead(files: readonly CloudCommandScriptRun[], why: string): CloudScriptEntry[] {
	return files.map((file) => ({ path: file.path, notShown: why }));
}

export function parseCloudScriptRead(
	output: string,
	files: readonly CloudCommandScriptRun[],
	used = 0,
): CloudScriptRead {
	const mark = output.lastIndexOf(`${READ_MARK}\n`);
	if (mark < 0 || (mark > 0 && output[mark - 1] !== "\n")) throw new Error("Script read differs");
	const lines = output.slice(mark + READ_MARK.length + 1).split("\n");
	const entries: CloudScriptEntry[] = [];
	const texts = new Map<string, string>();
	let total = used;
	let at = 0;
	for (const file of files) {
		const head = lines[at++] ?? "";
		const kind = head.slice(0, 1);
		const size = Number(head.slice(2));
		if (kind === "M") {
			entries.push({
				path: file.path,
				notShown: file.mentioned
					? "it is not on the machine now: this command makes or fetches it before it runs it"
					: "it is not on the machine now",
			});
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
		if (total + bytes.length > CLOUD_SCRIPT_TOTAL_BYTES) {
			entries.push({
				path: file.path,
				notShown: `the files this command runs are more than the ${CLOUD_SCRIPT_TOTAL_BYTES / 1024} KiB the review reads in all`,
			});
			continue;
		}
		total += bytes.length;
		const sha256 = createHash("sha256").update(bytes).digest("hex");
		texts.set(sha256, text);
		entries.push({
			path: file.path,
			sha256,
			bytes: bytes.length,
			...(file.mentioned ? { changedByCommand: true } : {}),
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
		files.length > CLOUD_SCRIPT_FILES * 4 ||
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
				...(entry.changedByCommand
					? {
							note: "This command changes or writes this path before it runs it: what it writes there is in the command.",
						}
					: {}),
				text,
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
