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

const STEERING =
	/^(PATH|CDPATH|ENV|BASH_ENV|IFS|PYTHONPATH|PYTHONSTARTUP|PYTHONHOME|NODE_OPTIONS|NODE_PATH|RUBYOPT|RUBYLIB|PERL5OPT|PERL5LIB|LD_PRELOAD|LD_LIBRARY_PATH|BASH_FUNC_[^=]*)\+?=/;
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
	background: boolean;
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
			background: false,
			piped,
			joined,
			after,
		};
		return current;
	};
	const end = (operator: string) => {
		if (current) {
			current.alone = current.piped || operator === "|" || operator === "|&" || operator === "&";
			current.background = operator === "&";
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
				background: false,
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

function grammar(words: readonly Word[]): { at: number; grouped: boolean; keywords: string[] } {
	let at = 0;
	let grouped = false;
	const keywords: string[] = [];
	for (;;) {
		const word = words[at];
		if (!word) return { at, grouped, keywords };
		if (word.literal && KEYWORDS.has(word.text)) keywords.push(word.text);
		else if (word.literal && (word.text === "{" || word.text === "}")) grouped = true;
		else if (!ASSIGNMENT.test(word.text)) return { at, grouped, keywords };
		at += 1;
	}
}

function programName(word: Word | undefined): string | undefined {
	if (!word?.literal) return undefined;
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
			if (!word.literal) return `${line(word.text)}: the command's setting is named through an expansion`;
			if (STEERING.test(word.text)) return `${line(word.text)}: it changes which code the command runs`;
			at += 1;
		}
		return undefined;
	};
	while (
		words[at]?.literal &&
		(KEYWORDS.has((words[at] as Word).text) || ["{", "}"].includes((words[at] as Word).text))
	)
		at += 1;
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

type Script = { readonly script?: Word; readonly code?: Word; readonly exact?: true; readonly why?: string };

function interpreterScript(name: string, interpreter: Interpreter, words: readonly Word[], at: number): Script {
	for (let index = at + 1; index < words.length; ) {
		const word = words[index] as Word;
		const option = word.text;
		if (!option.startsWith("-") && !(interpreter === SHELL && option.startsWith("+"))) return { script: word };
		if (shortFlags(interpreter, option, interpreter.inline)) {
			const code = words[index + 1];
			if (!code) return {};
			return interpreter.inline.includes(option) ? { code, exact: true } : { code };
		}
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

const FOLDER_WORDS = new Set(["cd", "pushd", "popd", "eval", "builtin", "command", "exec", "shopt", "trap"]);
const STARTUP = /^(BASH_ENV|ENV|ZDOTDIR)(\+?=|$)/;

interface Scan {
	moves: boolean;
	steers: boolean;
}

function named(name: string | undefined): boolean {
	return (
		name !== undefined &&
		(name in INTERPRETERS || PREFIXES.has(name) || name === "cd" || /^python3\.[0-9]{1,2}$/.test(name))
	);
}

function scan(text: string, sourced: boolean, depth = 0, found: Scan = { moves: false, steers: false }): Scan {
	if (depth > 8) {
		found.moves = true;
		found.steers = true;
		return found;
	}
	const { simples, complete } = lex(text);
	if (!complete) {
		found.moves = true;
		found.steers = true;
	}
	let cases = 0;
	let pattern = false;
	for (let at = 0; at < simples.length; at += 1) {
		const simple = simples[at] as Simple;
		if (simple.marker === ")" && pattern) {
			pattern = false;
			continue;
		}
		if (simple.marker === "(" && simples[at + 1]?.marker === ")") {
			const name = simples[at - 1]?.words.at(-1)?.text;
			if (!sourced || named(name)) {
				found.moves = true;
				found.steers = true;
			}
		}
		if (simple.marker) continue;
		const first = simple.words[0];
		if (cases > 0 && (simple.after === ";;" || simple.after === ";&" || simple.after === ";;&")) pattern = true;
		if (first?.plain && first.text === "esac" && cases > 0) {
			cases -= 1;
			pattern = false;
		}
		for (const [index, word] of simple.words.entries()) {
			if (word.text.includes("CDPATH") || STARTUP.test(word.text)) found.moves = true;
			if (!sourced && STEERING.test(word.text)) found.steers = true;
			if (word.literal && FOLDER_WORDS.has(word.text)) found.moves = true;
			if (word.literal && word.text === "alias") {
				found.moves = true;
				found.steers = true;
			}
			if (word.literal && word.text === "function" && (!sourced || named(simple.words[index + 1]?.text))) {
				found.moves = true;
				found.steers = true;
			}
			for (const body of word.bodies) scan(body, sourced, depth + 1, found);
			const shell = programName(word);
			if (shell !== undefined && INTERPRETERS[shell] === SHELL)
				for (let next = index + 1; simple.words[next]?.text.match(/^[-+]/); next += 1)
					if (shortFlags(SHELL, (simple.words[next] as Word).text, SHELL.inline)) {
						const code = simple.words[next + 1];
						if (code) scan(code.text, sourced, depth + 1, found);
						break;
					}
		}
		const { at: start } = grammar(simple.words);
		const program = simple.words[start];
		if (!program) continue;
		if (!pattern && !program.literal && program.text !== "[" && program.text !== "[[") {
			found.moves = true;
			found.steers = true;
		}
		const name = programName(program);
		if (name === "hash" && simple.words.slice(start + 1).some((word) => /^-[A-Za-z]*p/.test(word.text)))
			found.steers = true;
		if (sourced && (program.text === "source" || program.text === ".")) found.moves = true;
		if (first?.plain && first.text === "case") {
			cases += 1;
			pattern = true;
		}
		if (name !== undefined && INTERPRETERS[name] === SHELL)
			for (const body of simple.bodies) scan(body, sourced, depth + 1, found);
	}
	return found;
}

export function cloudScriptKeepsFolder(text: string): boolean {
	const found = scan(text, true);
	return !found.moves && !found.steers;
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

function chainOf(simples: readonly Simple[], from: number): boolean[] {
	const chained = simples.map(() => false);
	for (let at = from; at < simples.length; ) {
		let end = at;
		while (simples[end + 1]?.piped && !simples[end + 1]?.marker) end += 1;
		const pipeline = simples.slice(at, end + 1);
		const opened = pipeline.every((simple) => {
			if (simple.marker) return false;
			const shape = grammar(simple.words);
			return !shape.grouped && shape.keywords.length === 0;
		});
		if (!opened || pipeline[0]?.joined !== "&&" || pipeline.at(-1)?.background) break;
		for (let index = at; index <= end; index += 1) chained[index] = true;
		at = end + 1;
	}
	return chained;
}

function runsScript(words: readonly Word[]): boolean {
	return words.some((word) => {
		const name = programName(word);
		return (
			(name !== undefined && interpreterOf(name) !== undefined) || (name === undefined && word.text.includes("/"))
		);
	});
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
	const whole = scan(command, false);
	const restMoves =
		leading.count === 0 ? whole.moves : scan(rest === undefined ? "" : command.slice(rest), false).moves;
	let certain = leading.count === 0 ? !restMoves && start !== null : !restMoves && leading.folder !== null;
	const chained = leading.count > 0 ? chainOf(simples, leading.count) : [];
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
		const folder = !certain ? null : leading.count === 0 ? start : chained[index] ? leading.folder : null;
		const words = simple.words;
		const begun = commandStart(words);
		if ("why" in begun) {
			if (runsScript(words)) notShown.add(begun.why);
			continue;
		}
		const program = words[begun.at];
		if (!program || program.text.startsWith("-")) continue;
		if (!program.literal && program.text !== "[" && program.text !== "[[") {
			notShown.add(`${line(program.text) || "a program"}: it is named through a variable or an expansion`);
			continue;
		}
		const name = programName(program);
		if (name !== undefined && SKIPPED.has(name)) continue;
		if (name !== undefined && WRAPPERS.has(name)) {
			if (runsScript(words.slice(begun.at + 1)))
				notShown.add(`${line(name)}: the review does not follow what it runs`);
			continue;
		}
		if ((name === "cat" || name === "tee") && simple.heredoc) {
			const targets = name === "tee" ? words.slice(begun.at + 1).filter((word) => !word.text.startsWith("-")) : [];
			for (const target of [...simple.outputs, ...targets]) {
				const located = locate(target, folder);
				if ("path" in located) written.add(located.path);
			}
			continue;
		}
		if (name === "eval") {
			if (words.slice(begun.at + 1).some(printed))
				notShown.add("eval runs code another program prints, which the review cannot see");
			continue;
		}
		if (name === "source" || name === ".") {
			const file = words[begun.at + 1];
			const located = file ? locate(file, folder) : undefined;
			if (begun.prefixed) notShown.add(`${line(name)}: the review does not follow what runs it`);
			else if (file?.literal && !file.text.includes("/"))
				notShown.add(`${line(file.text)}: the shell looks it up on its program path first`);
			else if (file) run(file, folder);
			if (begun.prefixed || !(file?.text.includes("/") && located && "path" in located && settled.has(located.path)))
				certain = false;
			continue;
		}
		const interpreter = name === undefined ? undefined : interpreterOf(name);
		if (name !== undefined && interpreter) {
			const found = interpreterScript(name, interpreter, words, begun.at);
			if (found.why) {
				notShown.add(found.why);
				continue;
			}
			if (found.code) {
				if (printed(found.code))
					notShown.add(`${line(name)} runs code another program prints, which the review cannot see`);
				else if (interpreter === SHELL && !nested) {
					if (found.code.substituted)
						notShown.add(
							`${line(name)} runs code built from what another program prints, which the review cannot see`,
						);
					else {
						const inner = cloudCommandScripts(found.code.text, found.exact ? folder : null, true, settled);
						for (const reason of inner.notShown) notShown.add(reason);
						for (const file of inner.files)
							if (!written.has(file.path) && !files.some((known) => known.path === file.path)) files.push(file);
					}
				}
				continue;
			}
			if (found.script) run(found.script, folder);
			else if (simple.inputs[0]) run(simple.inputs[0], folder);
			else if (simple.piped && !simple.heredoc)
				notShown.add(`${line(name)} runs what another program prints into it, which the review cannot see`);
			continue;
		}
		if (name === "deno") {
			const script = words[begun.at + 2];
			if (words[begun.at + 1]?.text !== "run" || !script) continue;
			if (script.text.startsWith("-"))
				notShown.add(`deno run ${line(script.text)}: it runs with options the review does not follow`);
			else run(script, folder);
			continue;
		}
		if (name === undefined && program.text.includes("/")) run(program, folder);
	}
	if (whole.steers && (files.length > 0 || notShown.size > 0))
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
