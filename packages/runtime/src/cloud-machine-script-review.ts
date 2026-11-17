import { createHash } from "node:crypto";
import { posix } from "node:path";
import { type JsonValue, SHA256_HEX_PATTERN } from "@qorpera/contracts";

export const CLOUD_SCRIPT_FILE_BYTES = 64 * 1024;
export const CLOUD_SCRIPT_TOTAL_BYTES = 128 * 1024;
export const CLOUD_SCRIPT_FILES = 8;
export const CLOUD_SCRIPT_SHOWN =
	"The files this command runs directly, each as it is on the machine now and in full, are shown here. Files they load, import or read themselves are not shown.";

const HOME = "/root";
const MAX_PATH_BYTES = 512;
const PROGRAMS = /^\/(usr|bin|sbin|lib|lib64|opt|snap)\/|^\/root\/(\.local|\.cargo|\.bun|\.deno|go)\/bin\//;
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const KEYWORDS = new Set(["if", "then", "else", "elif", "do", "while", "until", "!", "fi", "done", "esac"]);
const SKIPPED = new Set(["for", "case", "select", "function", "alias", "export", "local", "declare", "readonly"]);

interface Prefix {
	readonly values: readonly string[];
	readonly operand?: true;
	readonly chdir?: readonly string[];
}

const PREFIXES: Readonly<Record<string, Prefix>> = {
	env: { values: ["-u", "--unset", "-C", "--chdir", "-S", "--split-string"], chdir: ["-C", "--chdir"] },
	sudo: { values: ["-u", "-g", "-C", "-D", "-h", "-p", "-r", "-t", "-U", "--chdir"], chdir: ["-D", "--chdir"] },
	timeout: { values: ["-k", "--kill-after", "-s", "--signal"], operand: true },
	nice: { values: ["-n", "--adjustment"] },
	ionice: { values: ["-c", "--class", "-n", "--classdata"] },
	nohup: { values: [] },
	exec: { values: ["-a"] },
	time: { values: ["-f", "--format", "-o", "--output"] },
	command: { values: [] },
	stdbuf: { values: ["-i", "-o", "-e", "--input", "--output", "--error"] },
	setsid: { values: [] },
	"xvfb-run": {
		values: ["-s", "--server-args", "-n", "--server-num", "-e", "--error-file", "-f", "--auth-file", "-p"],
	},
};

interface Interpreter {
	readonly inline: readonly string[];
	readonly values: readonly string[];
	readonly module?: readonly string[];
	readonly file?: readonly string[];
	readonly stdin?: readonly string[];
}

const SHELL: Interpreter = {
	inline: ["-c"],
	values: ["-o", "+o", "-O", "+O", "--rcfile", "--init-file"],
	stdin: ["-s"],
};
const PYTHON: Interpreter = { inline: ["-c"], values: ["-W", "-X", "-Q"], module: ["-m"] };
const NODE: Interpreter = {
	inline: ["-e", "--eval", "-p", "--print"],
	values: ["-r", "--require", "--import", "--loader", "--experimental-loader", "-C", "--conditions", "--env-file"],
};
const INTERPRETERS: Readonly<Record<string, Interpreter>> = {
	bash: SHELL,
	sh: SHELL,
	dash: SHELL,
	zsh: SHELL,
	python: PYTHON,
	python3: PYTHON,
	node: NODE,
	nodejs: NODE,
	tsx: NODE,
	"ts-node": NODE,
	ruby: { inline: ["-e"], values: ["-r", "-I", "-C", "-E"] },
	perl: { inline: ["-e", "-E"], values: ["-I", "-M", "-m"] },
	php: { inline: ["-r"], values: ["-c", "-d", "-z"], file: ["-f"] },
	Rscript: { inline: ["-e"], values: [] },
	lua: { inline: ["-e"], values: ["-l"] },
};

interface Word {
	readonly text: string;
	readonly literal: boolean;
	readonly substituted: boolean;
	readonly plain: boolean;
	readonly bodies: readonly string[];
	readonly start: number;
}

interface Simple {
	readonly words: Word[];
	readonly inputs: Word[];
	readonly outputs: Word[];
	heredoc: boolean;
	readonly bodies: string[];
	alone: boolean;
	readonly piped: boolean;
	readonly joined: Join;
	readonly after: string;
	readonly marker?: "(" | ")";
}

type Join = "&&" | "||" | "start";

export interface CloudCommandScriptRun {
	readonly path: string;
	readonly mentioned: boolean;
}

export interface CloudCommandScripts {
	readonly files: readonly CloudCommandScriptRun[];
	readonly notShown: readonly string[];
}

const OPERATORS = ["&&", "||", "|&", ";;", ";", "|", "&", "(", ")"];
const REDIRECTS = ["<<<", "<<-", "<<", "&>>", "&>", ">>", ">|", ">&", "<&", "<>", "<", ">"];

function lex(command: string): { simples: Simple[]; complete: boolean } {
	const simples: Simple[] = [];
	let current: Simple | undefined;
	let piped = false;
	let joined: Join = "start";
	let after = "start";
	const pending: { delimiter: string; strip: boolean; owner: Simple }[] = [];
	let redirect: { kind: "in" | "out" | "heredoc" | "other" } | undefined;
	const simple = (): Simple => {
		current ??= {
			words: [],
			inputs: [],
			outputs: [],
			heredoc: false,
			bodies: [],
			alone: false,
			piped,
			joined,
			after,
		};
		return current;
	};
	const end = (operator: string) => {
		if (current) {
			current.alone = current.piped || operator === "|" || operator === "|&" || operator === "&";
			simples.push(current);
		}
		if (current || operator !== "\n") {
			joined = operator === "&&" || operator === "||" ? operator : "start";
			after = operator;
		}
		current = undefined;
		piped = operator === "|" || operator === "|&";
		if (operator === "(" || operator === ")")
			simples.push({
				words: [],
				inputs: [],
				outputs: [],
				heredoc: false,
				bodies: [],
				alone: false,
				piped: false,
				joined: "start",
				after: operator,
				marker: operator,
			});
	};
	let at = 0;
	const length = command.length;
	while (at < length) {
		const char = command[at] as string;
		if (char === "\\" && command[at + 1] === "\n") {
			at += 2;
			continue;
		}
		if (char === " " || char === "\t" || char === "\r") {
			at += 1;
			continue;
		}
		if (char === "\n") {
			end("\n");
			at += 1;
			while (pending.length > 0) {
				const { delimiter, strip, owner } = pending.shift() as { delimiter: string; strip: boolean; owner: Simple };
				const body: string[] = [];
				for (;;) {
					if (at >= length) return { simples, complete: false };
					const next = command.indexOf("\n", at);
					const line = command.slice(at, next < 0 ? length : next);
					at = next < 0 ? length : next + 1;
					if ((strip ? line.replace(/^\t+/, "") : line) === delimiter) break;
					body.push(line);
				}
				owner.bodies.push(body.join("\n"));
			}
			continue;
		}
		if (char === "#" && (at === 0 || /[\s;&|()]/.test(command[at - 1] as string))) {
			const next = command.indexOf("\n", at);
			at = next < 0 ? length : next;
			continue;
		}
		const fd = /^[0-9]+(?=[<>])/.exec(command.slice(at, at + 4));
		const head = fd ? at + fd[0].length : at;
		const redirection =
			(command[head] === "<" || command[head] === ">") && command[head + 1] === "("
				? undefined
				: REDIRECTS.find((item) => command.startsWith(item, head));
		if (redirection) {
			at = head + redirection.length;
			simple();
			if (redirection === "<<" || redirection === "<<-" || redirection === "<<<") {
				simple().heredoc = true;
				redirect = { kind: redirection === "<<<" ? "other" : "heredoc" };
				if (redirection !== "<<<") pending.push({ delimiter: "", strip: redirection === "<<-", owner: simple() });
			} else if (redirection === "<") redirect = { kind: "in" };
			else if (redirection === "<&" || redirection === ">&" || redirection === "<>") redirect = { kind: "other" };
			else redirect = { kind: "out" };
			continue;
		}
		const operator = OPERATORS.find((item) => command.startsWith(item, at));
		if (operator) {
			end(operator);
			at += operator.length;
			continue;
		}
		const start = at;
		let text = "";
		let literal = true;
		let substituted = false;
		const bodies: string[] = [];
		const skipParentheses = () => {
			const open = at;
			let depth = 0;
			for (; at < length; at += 1) {
				if (command[at] === "(") depth += 1;
				else if (command[at] === ")" && --depth === 0) break;
			}
			bodies.push(command.slice(open + 1, at));
			if (at >= length) bodies.push("(");
			at += 1;
		};
		const skipSubstitution = () => {
			literal = false;
			substituted = true;
			if (command[at] === "`") {
				const close = command.indexOf("`", at + 1);
				bodies.push(close < 0 ? "(" : command.slice(at + 1, close));
				at = close < 0 ? length : close + 1;
				return;
			}
			skipParentheses();
		};
		while (at < length) {
			const c = command[at] as string;
			if (c === " " || c === "\t" || c === "\r" || c === "\n" || ";&|".includes(c)) break;
			if ((c === "<" || c === ">") && command[at + 1] === "(") {
				literal = false;
				at += 1;
				skipParentheses();
				continue;
			}
			if (c === "(" || c === ")" || c === "<" || c === ">") break;
			if (c === "\\") {
				text += command[at + 1] ?? "";
				at += 2;
				continue;
			}
			if (c === "'") {
				const close = command.indexOf("'", at + 1);
				if (close < 0) return { simples, complete: false };
				text += command.slice(at + 1, close);
				at = close + 1;
				continue;
			}
			if (c === '"') {
				at += 1;
				while (at < length && command[at] !== '"') {
					const d = command[at] as string;
					if (d === "`" || (d === "$" && command[at + 1] === "(")) {
						if (d === "$") at += 1;
						skipSubstitution();
						continue;
					}
					if (d === "$") literal = false;
					if (d === "\\" && at + 1 < length && '$`"\\\n'.includes(command[at + 1] as string)) {
						text += command[at + 1];
						at += 2;
						continue;
					}
					text += d;
					at += 1;
				}
				if (at >= length) return { simples, complete: false };
				at += 1;
				continue;
			}
			if (c === "`" || (c === "$" && command[at + 1] === "(")) {
				if (c === "$") at += 1;
				skipSubstitution();
				continue;
			}
			if (c === "$" || c === "*" || c === "?" || c === "[") literal = false;
			text += c;
			at += 1;
		}
		if (at === start) {
			at += 1;
			continue;
		}
		const plain = literal && !/[\\'"]/.test(command.slice(start, at));
		const word: Word = { text, literal, substituted, plain, bodies, start };
		if (redirect) {
			if (redirect.kind === "heredoc") {
				const last = pending.at(-1);
				if (last) pending[pending.length - 1] = { ...last, delimiter: text };
			} else if (redirect.kind === "in") simple().inputs.push(word);
			else if (redirect.kind === "out") simple().outputs.push(word);
			redirect = undefined;
			continue;
		}
		simple().words.push(word);
	}
	end("\n");
	return { simples, complete: pending.length === 0 };
}

function basename(text: string): string {
	return text.slice(text.lastIndexOf("/") + 1);
}

function interpreterOf(text: string): Interpreter | undefined {
	const name = basename(text);
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

type Located = { readonly path: string } | { readonly why: string };

function locate(word: Word, folder: string | null): Located {
	if (!word.literal) return { why: `${line(word.text) || "a file"}: it is named through a variable or an expansion` };
	const text = word.text === "~" ? HOME : word.text.startsWith("~/") ? `${HOME}/${word.text.slice(2)}` : word.text;
	if (!text.startsWith("/") && folder === null) return { why: `${line(text)}: the folder it is in could not be told` };
	const path = posix.resolve(folder ?? "/", text);
	if (Buffer.byteLength(path) > MAX_PATH_BYTES || /[\n\\]/.test(path))
		return { why: `${line(text)}: its name is too long or unusual to read` };
	return { path };
}

function printed(word: Word): boolean {
	return word.substituted && word.text.trim() === "";
}

function stripPrefixes(
	words: Word[],
	folder: string | null,
): { folder: string | null; grouped: boolean; keywords: string[] } {
	let grouped = false;
	const keywords: string[] = [];
	for (;;) {
		while (words.length > 0 && ASSIGNMENT.test((words[0] as Word).text)) words.shift();
		const first = words[0];
		if (!first || !first.literal) return { folder, grouped, keywords };
		if (KEYWORDS.has(first.text)) {
			keywords.push(first.text);
			words.shift();
			continue;
		}
		if (first.text === "{" || first.text === "}") {
			grouped = true;
			words.shift();
			continue;
		}
		const prefix = PREFIXES[basename(first.text)];
		if (!prefix) return { folder, grouped, keywords };
		words.shift();
		let operand = prefix.operand === true;
		while (words.length > 0) {
			const option = (words[0] as Word).text;
			if (option === "--") {
				words.shift();
				break;
			}
			if (option.startsWith("-") && option.length > 1) {
				words.shift();
				if (prefix.chdir?.includes(option.split("=")[0] as string)) folder = null;
				if (prefix.values.includes(option)) words.shift();
				continue;
			}
			if (ASSIGNMENT.test(option)) {
				words.shift();
				continue;
			}
			if (!operand) break;
			words.shift();
			operand = false;
		}
	}
}

function interpreterScript(
	interpreter: Interpreter,
	words: readonly Word[],
): { readonly script?: Word; readonly inline?: true; readonly code?: Word } {
	for (let index = 1; index < words.length; ) {
		const word = words[index] as Word;
		const option = word.text;
		if (option === "--") return words[index + 1] ? { script: words[index + 1] as Word } : {};
		if (shortFlags(interpreter, option, interpreter.inline))
			return words[index + 1] ? { inline: true, code: words[index + 1] as Word } : { inline: true };
		if (interpreter.module && shortFlags(interpreter, option, interpreter.module)) return { inline: true };
		if (interpreter.file?.includes(option)) return words[index + 1] ? { script: words[index + 1] as Word } : {};
		if (interpreter.stdin && shortFlags(interpreter, option, interpreter.stdin)) return {};
		if (option === "-") return {};
		if (option.startsWith("-") || (interpreter === SHELL && option.startsWith("+"))) {
			index += interpreter.values.includes(option) ? 2 : 1;
			continue;
		}
		return { script: word };
	}
	return {};
}

const FOLDER_WORDS = new Set([
	"cd",
	"pushd",
	"popd",
	"eval",
	"builtin",
	"command",
	"exec",
	"alias",
	"shopt",
	"trap",
	"function",
]);

function shellCode(words: readonly Word[]): readonly Word[] {
	const interpreter = interpreterOf(words[0]?.text ?? "");
	if (interpreter !== SHELL) return [];
	const { code } = interpreterScript(interpreter, words);
	return code ? [code] : [];
}

function movesFolder(text: string, sourced: boolean, depth = 0): boolean {
	if (depth > 8) return true;
	const { simples, complete } = lex(text);
	if (!complete) return true;
	let cases = 0;
	let pattern = false;
	for (let at = 0; at < simples.length; at += 1) {
		const simple = simples[at] as Simple;
		if (simple.marker === ")" && pattern) {
			pattern = false;
			continue;
		}
		if (simple.marker === "(" && simples[at + 1]?.marker === ")" && !sourced) return true;
		if (simple.marker) continue;
		const first = simple.words[0];
		if (cases > 0 && (simple.after === ";;" || simple.after === ";&" || simple.after === ";;&")) pattern = true;
		if (first?.plain && first.text === "esac" && cases > 0) {
			cases -= 1;
			pattern = false;
		}
		for (const word of simple.words) {
			if (word.text.includes("CDPATH") || word.text === "--chdir") return true;
			if (word.literal && FOLDER_WORDS.has(word.text) && !(sourced && word.text === "function")) return true;
			for (const body of word.bodies) if (movesFolder(body, sourced, depth + 1)) return true;
		}
		const words = [...simple.words];
		if (stripPrefixes(words, HOME).folder === null) return true;
		const program = words[0];
		if (!program) continue;
		if (!pattern && !program.literal && program.text !== "[" && program.text !== "[[") return true;
		if (sourced && (program.text === "source" || program.text === ".")) return true;
		if (first?.plain && first.text === "case") {
			cases += 1;
			pattern = true;
		}
		for (const code of shellCode(words)) if (movesFolder(code.text, sourced, depth + 1)) return true;
		if (interpreterOf(program.text) === SHELL)
			for (const body of simple.bodies) if (movesFolder(body, sourced, depth + 1)) return true;
	}
	return false;
}

export function cloudScriptKeepsFolder(text: string): boolean {
	return !movesFolder(text, true);
}

function leadingFolder(simples: readonly Simple[], start: string | null): { count: number; folder: string | null } {
	let count = 0;
	let folder = start;
	for (const simple of simples) {
		const words = simple.words;
		const target = words[1]?.text === "--" ? words[2] : words[1];
		const size = words[1]?.text === "--" ? 3 : 2;
		if (
			simple.marker ||
			simple.alone ||
			simple.joined !== (count === 0 ? "start" : "&&") ||
			(count === 0 && simple !== simples[0]) ||
			words.length !== size ||
			words[0]?.text !== "cd" ||
			!words[0].literal ||
			!target ||
			!target.literal ||
			target.text === "-" ||
			target.text.startsWith("-") ||
			target.text === ""
		)
			break;
		const located = locate(target, folder);
		folder = "path" in located ? located.path : null;
		count += 1;
	}
	return { count, folder };
}

function inChain(simple: Simple): boolean {
	return !simple.marker && !simple.alone && simple.joined === "&&";
}

export function cloudCommandScripts(
	command: string,
	start: string | null = HOME,
	nested = false,
	settled: ReadonlySet<string> = new Set(),
): CloudCommandScripts {
	const { simples } = lex(command);
	const files: CloudCommandScriptRun[] = [];
	const notShown = new Set<string>();
	const written = new Set<string>();
	const leading = leadingFolder(simples, start);
	const rest =
		leading.count === 0
			? 0
			: simples.slice(leading.count).find((simple) => simple.words[0] !== undefined)?.words[0]?.start;
	const restMoves = movesFolder(rest === undefined ? "" : command.slice(rest), false);
	let certain = leading.count === 0 ? !restMoves && start !== null : !restMoves && leading.folder !== null;
	let chained = leading.count > 0;
	const run = (word: Word, folder: string | null) => {
		const located = locate(word, folder);
		if ("why" in located) {
			notShown.add(located.why);
			return;
		}
		const { path } = located;
		if (written.has(path) || files.some((file) => file.path === path)) return;
		const before = command.slice(0, word.start);
		files.push({ path, mentioned: before.includes(path) || before.includes(word.text) });
	};
	for (const [index, simple] of simples.entries()) {
		if (index < leading.count) continue;
		if (leading.count > 0) chained = chained && inChain(simple);
		const words = [...simple.words];
		const stripped = stripPrefixes(words, HOME);
		if (stripped.grouped || stripped.keywords.length > 0) chained = false;
		const folder = !certain ? null : leading.count === 0 ? start : chained ? leading.folder : null;
		const program = words[0];
		if (!program) continue;
		if (!program.literal && program.text !== "[" && program.text !== "[[") {
			notShown.add(`${line(program.text) || "a program"}: it is named through a variable or an expansion`);
			continue;
		}
		const name = program.text;
		if (SKIPPED.has(name)) continue;
		if ((name === "cat" || name === "tee") && simple.heredoc) {
			const targets = name === "tee" ? words.slice(1).filter((word) => !word.text.startsWith("-")) : [];
			for (const target of [...simple.outputs, ...targets]) {
				const located = locate(target, folder);
				if ("path" in located) written.add(located.path);
			}
			continue;
		}
		if (name === "eval") {
			if (words.slice(1).some(printed))
				notShown.add("eval runs code another program prints, which the review cannot see");
			continue;
		}
		if (name === "source" || name === ".") {
			const file = words[1];
			const located = file ? locate(file, folder) : undefined;
			if (file?.literal && !file.text.includes("/"))
				notShown.add(`${line(file.text)}: the shell looks it up on its program path first`);
			else if (file) run(file, folder);
			if (!(file?.text.includes("/") && located && "path" in located && settled.has(located.path))) certain = false;
			continue;
		}
		const interpreter = interpreterOf(name);
		if (interpreter) {
			const { script, inline, code } = interpreterScript(interpreter, words);
			if (code && printed(code))
				notShown.add(`${line(name)} runs code another program prints, which the review cannot see`);
			else if (code && interpreter === SHELL && !nested) {
				if (code.substituted)
					notShown.add(
						`${line(name)} runs code built from what another program prints, which the review cannot see`,
					);
				else {
					const inner = cloudCommandScripts(code.text, folder, true, settled);
					for (const reason of inner.notShown) notShown.add(reason);
					for (const file of inner.files)
						if (!written.has(file.path) && !files.some((known) => known.path === file.path)) files.push(file);
				}
			}
			if (inline) continue;
			if (script) run(script, folder);
			else if (simple.inputs[0]) run(simple.inputs[0], folder);
			else if (simple.piped && !simple.heredoc)
				notShown.add(`${line(name)} runs what another program prints into it, which the review cannot see`);
			continue;
		}
		if (name === "deno" || name === "bun") {
			if (name === "deno" && words[1]?.text !== "run") continue;
			const rest = words.slice(name === "deno" || words[1]?.text === "run" ? 2 : 1);
			const script = rest.find((word) => !word.text.startsWith("-"));
			if (script && (!script.literal || /[/.]/.test(script.text))) run(script, folder);
			continue;
		}
		if (name.includes("/") && !PROGRAMS.test(name.startsWith("/") ? posix.resolve(name) : name)) run(program, folder);
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
