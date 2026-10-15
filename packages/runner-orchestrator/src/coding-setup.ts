import { createHash } from "node:crypto";

/** The setup files a repository can carry, in the order they are looked for at the root of one commit
 * (`deploy/first-node/RUNTIME-FOLDER-CODING-MACHINES.md` "Setup file and snapshots"). The first that exists is the
 * repository's. Ours takes Cursor's keys. */
export const CODING_SETUP_FILES = [
	{ path: ".qorpera/environment.json", format: "qorpera" },
	{ path: ".cursor/environment.json", format: "cursor" },
	{ path: ".devcontainer/devcontainer.json", format: "devcontainer" },
] as const;
export type CodingSetupFormat = (typeof CODING_SETUP_FILES)[number]["format"];

export const MAX_CODING_SETUP_FILE_BYTES = 64 * 1024;
export const MAX_CODING_SETUP_DOCKERFILE_BYTES = 1024 * 1024;

/** SHA-256 of no bytes: the digest of a repository with no setup file, or with one that was refused. It is 5a's
 * default in `qorpera_plan_coding_machine`. */
export const EMPTY_CODING_SETUP_DIGEST = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

/** What is at one path in the commit the setup is read from. */
export type CodingSetupEntry =
	| { kind: "missing" }
	/** A regular file (mode 100644 or 100755). The source may stop reading after `maxBytes + 1` bytes: more than
	 * `maxBytes` is too large. */
	| { kind: "file"; bytes: Uint8Array }
	/** Anything else: a folder, a symlink or a submodule. */
	| { kind: "other" };

/** Reads a repository at one commit: the code host's `git show` (5e). Paths are relative to the repository's root,
 * with no `.` or `..` segment. A read that fails throws; that is not a missing file. */
export interface CodingSetupSource {
	read(path: string, maxBytes: number): Promise<CodingSetupEntry>;
}

/** A shell line (run with `/bin/sh -c`), or an argument list run without a shell. */
export type CodingSetupCommand = { readonly shell: string } | { readonly argv: readonly string[] };

/** One step of `initialize`, `install` or `start`. Its commands run side by side (a devcontainer command object's
 * named entries); the next step starts when they have all succeeded. */
export interface CodingSetupStep {
	/** The key it came from: `install`, `start`, `onCreateCommand`, … */
	readonly from: string;
	readonly commands: readonly { readonly name: string | null; readonly run: CodingSetupCommand }[];
}

/** Where the session's commands run: the machine itself (5f's image), or a container from a registry image or a
 * Dockerfile (both built in 5h-4). Paths are relative to the repository's root; "." is the root. */
export type CodingSetupBase =
	| { readonly kind: "machine" }
	| { readonly kind: "image"; readonly image: string }
	| {
			readonly kind: "dockerfile";
			/** The Dockerfile's path, or null when `contents` holds it. */
			readonly dockerfile: string | null;
			readonly contents: string | null;
			readonly context: string;
			readonly args: Readonly<Record<string, string>>;
			readonly target: string | null;
	  };

export interface CodingSetupTerminal {
	readonly name: string | null;
	readonly command: string;
	readonly description: string | null;
}

export interface CodingSetupMcpServer {
	readonly name: string | null;
	readonly serverUrl: string | null;
	readonly command: string | null;
	readonly toolAllowlist: readonly string[];
}

/** A repository's setup in one shape for the three formats. Its canonical JSON is in the setup digest. */
export interface CodingSetup {
	/** The format it was read from; null for the empty setup. */
	readonly format: CodingSetupFormat | null;
	readonly name: string | null;
	readonly base: CodingSetupBase;
	/** The user the session's commands run as; null for the base's own. */
	readonly user: string | null;
	/** Run in the builder VM, never on a host (devcontainer `initializeCommand`). */
	readonly initialize: readonly CodingSetupStep[];
	/** Run in a snapshot build and again in each session's worktree at every attach. */
	readonly install: readonly CodingSetupStep[];
	/** Run after `install` at every attach. */
	readonly start: readonly CodingSetupStep[];
	/** tmux windows, each with its terminals. */
	readonly terminals: readonly (readonly CodingSetupTerminal[])[];
	readonly ports: readonly { readonly port: number; readonly name: string | null }[];
	/** Set on the machine for every process (devcontainer `containerEnv`). */
	readonly containerEnv: Readonly<Record<string, string>>;
	/** Set on top of `containerEnv` for the session's commands and terminals (devcontainer `remoteEnv`). A value may
	 * refer to `${containerEnv:…}`, so the two scopes stay apart; null unsets a variable the base or `containerEnv`
	 * sets. */
	readonly remoteEnv: Readonly<Record<string, string | null>>;
	/** Other repositories added beside the session's worktree, as GitHub `<owner>/<name>` in lower case (5a's
	 * `repository`). The grant decides at attach which of them the session gets. */
	readonly repositoryDependencies: readonly string[];
	/** Devcontainer features, installed by the devcontainer CLI in the builder VM: id to options. */
	readonly features: Readonly<Record<string, unknown>>;
	readonly featureInstallOrder: readonly string[];
	readonly chromeExecutablePath: string | null;
	readonly enableTesting: boolean;
	readonly mcp: { readonly disableAll: boolean; readonly allowlist: readonly CodingSetupMcpServer[] };
}

/** One problem with the setup file, reported to the agent and the member so the agent can fix the file. */
export interface CodingSetupProblem {
	/** A JSON pointer into the file; "" is the whole file. */
	readonly at: string;
	/** `refused`: the session gets the empty setup. `ignored`: the key does nothing, and the rest is used. */
	readonly effect: "refused" | "ignored";
	readonly code: string;
	readonly message: string;
}

export interface CodingSetupDockerfile {
	readonly path: string;
	readonly bytes: Uint8Array;
}

export interface CodingSetupRead {
	/** The setup file found, or null when the commit has none. */
	readonly file: { readonly path: string; readonly format: CodingSetupFormat } | null;
	/** The file was refused: the session gets the empty setup, and the attach goes on. */
	readonly refused: boolean;
	readonly setup: CodingSetup;
	readonly digest: string;
	/** Each Dockerfile the setup names, by path. Their bytes are in the digest. */
	readonly dockerfiles: readonly CodingSetupDockerfile[];
	readonly problems: readonly CodingSetupProblem[];
}

type Json = null | boolean | number | string | Json[] | JsonObject;
interface JsonObject {
	[key: string]: Json;
}
type Draft = { -readonly [K in keyof CodingSetup]: CodingSetup[K] };
interface Mapped {
	setup: Draft;
	dockerfiles: { path: string; at: string }[];
}

const MACHINE: CodingSetupBase = Object.freeze({ kind: "machine" });

function draft(format: CodingSetupFormat | null): Draft {
	return {
		format,
		name: null,
		base: MACHINE,
		user: null,
		initialize: [],
		install: [],
		start: [],
		terminals: [],
		ports: [],
		containerEnv: {},
		remoteEnv: {},
		repositoryDependencies: [],
		features: {},
		featureInstallOrder: [],
		chromeExecutablePath: null,
		enableTesting: true,
		mcp: { disableAll: false, allowlist: [] },
	};
}

export const EMPTY_CODING_SETUP: CodingSetup = frozen(draft(null));

/** Reads the repository's setup at the source's commit: the first setup file that exists, mapped to one shape under
 * a strict schema, and its digest. A file that is refused gives the empty setup with every problem reported: the
 * attach never fails over a setup file, so the agent can always reach its machine to fix it. */
export async function readCodingSetup(source: CodingSetupSource): Promise<CodingSetupRead> {
	for (const candidate of CODING_SETUP_FILES) {
		const entry = await source.read(candidate.path, MAX_CODING_SETUP_FILE_BYTES);
		if (entry.kind === "missing") continue;
		const file = { path: candidate.path, format: candidate.format };
		const problems = new Problems();
		let mapped: Mapped | null = null;
		if (entry.kind === "file") mapped = parseSetup(candidate.format, entry.bytes, problems);
		else
			problems.refuse(
				"",
				"NOT_A_FILE",
				"The setup file is not a regular file (a folder, a symlink or a submodule).",
			);
		const dockerfiles: CodingSetupDockerfile[] = [];
		for (const named of mapped?.dockerfiles ?? []) {
			const read = await source.read(named.path, MAX_CODING_SETUP_DOCKERFILE_BYTES);
			if (read.kind === "missing")
				problems.refuse(named.at, "DOCKERFILE_MISSING", `There is no file at ${named.path}.`);
			else if (read.kind === "other")
				problems.refuse(named.at, "DOCKERFILE_NOT_A_FILE", `${named.path} is not a regular file.`);
			else if (read.bytes.byteLength > MAX_CODING_SETUP_DOCKERFILE_BYTES)
				problems.refuse(named.at, "DOCKERFILE_TOO_LARGE", `${named.path} is over 1 MiB.`);
			else dockerfiles.push({ path: named.path, bytes: read.bytes });
		}
		if (!mapped || problems.refused)
			return {
				file,
				refused: true,
				setup: EMPTY_CODING_SETUP,
				digest: EMPTY_CODING_SETUP_DIGEST,
				dockerfiles: [],
				problems: problems.done(),
			};
		const setup = frozen(mapped.setup);
		return {
			file,
			refused: false,
			setup,
			digest: setupDigest(setup, dockerfiles),
			dockerfiles,
			problems: problems.done(),
		};
	}
	return {
		file: null,
		refused: false,
		setup: EMPTY_CODING_SETUP,
		digest: EMPTY_CODING_SETUP_DIGEST,
		dockerfiles: [],
		problems: [],
	};
}

const DIGEST_SCHEMA = "qorpera.coding-setup-digest/v1";

/** SHA-256 over length-framed parts (each an 8-byte big-endian length, then its bytes): the schema, the setup's
 * canonical JSON (keys sorted at every level), then each named Dockerfile's path and bytes in path order. Only what
 * the setup means is in it, so a comment, a space or the order of keys never changes it. */
function setupDigest(setup: CodingSetup, dockerfiles: readonly CodingSetupDockerfile[]): string {
	const hash = createHash("sha256");
	const frame = (part: string | Uint8Array) => {
		const bytes = typeof part === "string" ? Buffer.from(part, "utf8") : part;
		const length = Buffer.alloc(8);
		length.writeBigUInt64BE(BigInt(bytes.byteLength));
		hash.update(length).update(bytes);
	};
	frame(DIGEST_SCHEMA);
	frame(canonicalJson(setup));
	for (const file of [...dockerfiles].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
		frame(file.path);
		frame(file.bytes);
	}
	return hash.digest("hex");
}

function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (value !== null && typeof value === "object") {
		const record = value as Record<string, unknown>;
		return `{${Object.keys(record)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}

function frozen<T>(value: T): T {
	if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
		for (const entry of Object.values(value)) frozen(entry);
		Object.freeze(value);
	}
	return value;
}

// The report lists this many problems, then how many more there were.
const MAX_PROBLEMS = 100;

class Problems {
	readonly list: CodingSetupProblem[] = [];
	refused = false;
	#more = 0;
	#moreRefused = false;

	refuse(at: string, code: string, message: string): void {
		this.refused = true;
		this.#add({ at, effect: "refused", code, message });
	}

	ignore(at: string, code: string, message: string): void {
		this.#add({ at, effect: "ignored", code, message });
	}

	done(): CodingSetupProblem[] {
		if (this.#more === 0) return [...this.list];
		const more: CodingSetupProblem = {
			at: "",
			effect: this.#moreRefused ? "refused" : "ignored",
			code: "MORE_PROBLEMS",
			message: `${this.#more} more problems are not listed.`,
		};
		return [...this.list, more];
	}

	#add(problem: CodingSetupProblem): void {
		if (this.list.length < MAX_PROBLEMS) this.list.push(problem);
		else {
			this.#more++;
			if (problem.effect === "refused") this.#moreRefused = true;
		}
	}
}

function parseSetup(format: CodingSetupFormat, bytes: Uint8Array, problems: Problems): Mapped | null {
	if (bytes.byteLength > MAX_CODING_SETUP_FILE_BYTES) {
		problems.refuse("", "TOO_LARGE", "The setup file is over 64 KiB.");
		return null;
	}
	let text: string;
	try {
		text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		problems.refuse("", "NOT_UTF8", "The setup file is not UTF-8 text.");
		return null;
	}
	let root: Json;
	try {
		root = parseSetupJson(text, format === "devcontainer");
	} catch (error) {
		if (!(error instanceof SetupSyntaxError)) throw error;
		const before = text.slice(0, error.index);
		const line = before.split("\n").length;
		const column = error.index - before.lastIndexOf("\n");
		problems.refuse("", "SYNTAX", `Line ${line}, column ${column}: ${error.message}`);
		return null;
	}
	if (!isObject(root)) {
		problems.refuse("", "WRONG_TYPE", "The setup file must hold one JSON object.");
		return null;
	}
	return format === "devcontainer" ? devcontainerSetup(root, problems) : cursorSetup(format, root, problems);
}

class SetupSyntaxError extends Error {
	readonly index: number;

	constructor(index: number, message: string) {
		super(message);
		this.index = index;
	}
}

const ESCAPES = new Map([
	['"', '"'],
	["\\", "\\"],
	["/", "/"],
	["b", "\b"],
	["f", "\f"],
	["n", "\n"],
	["r", "\r"],
	["t", "\t"],
]);
const LITERALS: readonly [string, Json][] = [
	["true", true],
	["false", false],
	["null", null],
];
const NUMBER = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;
// A lone surrogate from a \u escape: it has no UTF-8, so two different files would hash as one.
const LONE_SURROGATE = /[\uD800-\uDFFF]/u;
// Deeper than any setup needs, and shallow enough for the parser's recursion.
const MAX_DEPTH = 32;

/** JSON with comments (all three formats) and, for devcontainer.json only, trailing commas. A key that appears twice
 * in one object is refused. Objects have no prototype, so any key is plain data. */
function parseSetupJson(text: string, trailingCommas: boolean): Json {
	let i = 0;
	const fail = (message: string) => new SetupSyntaxError(i, message);
	const space = () => {
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
	const string = (): string => {
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
			const simple = ESCAPES.get(letter);
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
	const value = (depth: number): Json => {
		space();
		const c = text[i];
		if (c === "{" || c === "[") {
			if (depth === MAX_DEPTH) throw fail(`The file nests deeper than ${MAX_DEPTH} levels.`);
			i++;
			return c === "{" ? object(depth + 1) : array(depth + 1);
		}
		if (c === '"') return string();
		for (const [word, literal] of LITERALS)
			if (text.startsWith(word, i)) {
				i += word.length;
				return literal;
			}
		NUMBER.lastIndex = i;
		const number = NUMBER.exec(text);
		if (!number) throw fail(i < text.length ? "Expected a value." : "The file ends where a value was expected.");
		const n = Number(number[0]);
		if (!Number.isFinite(n)) throw fail("A number is too large.");
		i = NUMBER.lastIndex;
		return n;
	};
	const object = (depth: number): JsonObject => {
		const out: JsonObject = Object.create(null);
		space();
		if (text[i] === "}") {
			i++;
			return out;
		}
		for (;;) {
			space();
			if (text[i] !== '"') throw fail("Expected a key in double quotes.");
			const keyAt = i;
			const key = string();
			if (key in out) {
				i = keyAt;
				throw fail(`The key ${JSON.stringify(key)} appears twice.`);
			}
			space();
			if (text[i] !== ":") throw fail("Expected ':' after a key.");
			i++;
			out[key] = value(depth);
			space();
			if (text[i] === "}") {
				i++;
				return out;
			}
			if (text[i] !== ",") throw fail("Expected ',' or '}'.");
			i++;
			space();
			if (text[i] === "}") {
				if (!trailingCommas) throw fail("A comma before '}': this file allows no trailing commas.");
				i++;
				return out;
			}
		}
	};
	const array = (depth: number): Json[] => {
		const out: Json[] = [];
		space();
		if (text[i] === "]") {
			i++;
			return out;
		}
		for (;;) {
			out.push(value(depth));
			space();
			if (text[i] === "]") {
				i++;
				return out;
			}
			if (text[i] !== ",") throw fail("Expected ',' or ']'.");
			i++;
			space();
			if (text[i] === "]") {
				if (!trailingCommas) throw fail("A comma before ']': this file allows no trailing commas.");
				i++;
				return out;
			}
		}
	};
	const root = value(0);
	space();
	if (i < text.length) throw fail("Text follows the value.");
	return root;
}

const UNKNOWN = "This key is not in the setup file's schema.";
const USER = /^(?:[a-z_][a-z0-9_-]{0,31}|[0-9]{1,10})$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const IMAGE_COMPONENT = "[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*";
const IMAGE = new RegExp(
	`^(?:[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?(?::[0-9]{1,5})?/)?${IMAGE_COMPONENT}(?:/${IMAGE_COMPONENT})*` +
		"(?::[A-Za-z0-9_][A-Za-z0-9_.-]{0,127})?(?:@sha256:[0-9a-f]{64})?$",
);
const GITHUB_REPOSITORY = /^(?:https:\/\/)?github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i;
// 5a's `repository` check on qorpera_coding_machines.
const REPOSITORY = /^[a-z0-9]([a-z0-9-]{0,37}[a-z0-9])?\/[a-z0-9_][a-z0-9_.-]{0,99}$/;

/** Ours and Cursor's (Cursor's environment.schema.json): the root and `build` take no other key, nor does an MCP
 * server entry; a port or a terminal may carry others, which are ignored. Paths are relative to the file's folder,
 * except one that starts with that folder, and a build context of `.` (the repository's root). */
function cursorSetup(format: "qorpera" | "cursor", root: JsonObject, problems: Problems): Mapped {
	const folder = `.${format}`;
	const within = (path: string) => (path === folder || path.startsWith(`${folder}/`) ? "" : folder);
	const setup = draft(format);
	const dockerfiles: Mapped["dockerfiles"] = [];
	for (const [key, value] of Object.entries(root)) {
		const at = pointer("", key);
		switch (key) {
			case "$schema":
				break;
			case "name":
				setup.name = textOf(value, at, problems);
				break;
			case "user":
				setup.user = userOf(value, at, problems);
				break;
			case "install":
			case "start": {
				const shell = textOf(value, at, problems);
				if (shell !== null) setup[key] = [{ from: key, commands: [{ name: null, run: { shell } }] }];
				break;
			}
			case "image":
				setup.base = imageOf(value, at, problems) ?? setup.base;
				break;
			case "build": {
				const build = objectOf(value, at, problems);
				if (!build) break;
				let dockerfile: string | null = null;
				let contents: string | null = null;
				let context = folder;
				for (const [buildKey, entry] of Object.entries(build)) {
					const entryAt = pointer(at, buildKey);
					const path =
						buildKey === "dockerfile" || buildKey === "context" ? textOf(entry, entryAt, problems) : null;
					if (buildKey === "dockerfile") {
						dockerfile = path === null ? null : fileOf(within(path), path, entryAt, problems);
						if (dockerfile !== null) dockerfiles.push({ path: dockerfile, at: entryAt });
					} else if (buildKey === "context") {
						// Only these two mean the repository's root; any other path is under the folder.
						if (path === "." || path === "./") context = ".";
						else if (path !== null) context = folderOf(within(path), path, entryAt, problems) ?? context;
					} else if (buildKey === "dockerfileContents") contents = textOf(entry, entryAt, problems);
					else problems.refuse(entryAt, "UNKNOWN_KEY", UNKNOWN);
				}
				if ("dockerfile" in build && "dockerfileContents" in build)
					problems.refuse(at, "CONFLICT", "Give dockerfile or dockerfileContents, not both.");
				else if (!("dockerfile" in build) && !("dockerfileContents" in build))
					problems.refuse(at, "MISSING_KEY", "Needs dockerfile or dockerfileContents.");
				setup.base = { kind: "dockerfile", dockerfile, contents, context, args: {}, target: null };
				break;
			}
			case "snapshot":
			case "agentCanUpdateSnapshot":
				problems.ignore(at, "IGNORED", "Snapshots are the platform's: it builds them from the default branch.");
				break;
			case "egressAllowlist":
			case "egressMode":
				problems.ignore(at, "IGNORED", "The company's exit rules govern the network.");
				break;
			case "repositoryDependencies":
				setup.repositoryDependencies = repositoriesOf(value, at, problems);
				break;
			case "disableAllMcpServers":
				setup.mcp = { ...setup.mcp, disableAll: flagOf(value, at, problems) ?? false };
				break;
			case "mcpServerAllowlist":
				setup.mcp = { ...setup.mcp, allowlist: mcpServersOf(value, at, problems) };
				break;
			case "chromeExecutablePath":
				setup.chromeExecutablePath = textOf(value, at, problems);
				break;
			case "enable_testing":
				if (typeof value === "boolean") setup.enableTesting = value;
				else if (value === "true" || value === "false") setup.enableTesting = value === "true";
				else problems.refuse(at, "WRONG_TYPE", 'Must be true, false, "true" or "false".');
				break;
			case "ports": {
				const ports = new Ports(problems);
				for (const [index, item] of (arrayOf(value, at, problems) ?? []).entries()) {
					const itemAt = pointer(at, index);
					const port = objectOf(item, itemAt, problems);
					if (!port) continue;
					let number: number | null = null;
					let name: string | null = null;
					for (const [portKey, entry] of Object.entries(port)) {
						const entryAt = pointer(itemAt, portKey);
						if (portKey === "port") number = portOf(entry, entryAt, problems);
						else if (portKey === "name") name = textOf(entry, entryAt, problems);
						else problems.ignore(entryAt, "IGNORED", "A port uses only port and name.");
					}
					if (!("port" in port)) problems.refuse(itemAt, "MISSING_KEY", "Needs port.");
					else if (number !== null) ports.add(number, name, itemAt);
				}
				setup.ports = ports.list;
				break;
			}
			case "terminals":
				setup.terminals = terminalsOf(value, at, problems);
				break;
			default:
				problems.refuse(at, "UNKNOWN_KEY", UNKNOWN);
		}
	}
	if ("build" in root && "image" in root) problems.refuse("/image", "CONFLICT", "Give build or image, not both.");
	return { setup, dockerfiles };
}

const DEVCONTAINER_KEYS = new Set([
	"$schema",
	"name",
	"image",
	"build",
	"dockerFile",
	"context",
	"features",
	"overrideFeatureInstallOrder",
	"initializeCommand",
	"onCreateCommand",
	"updateContentCommand",
	"postCreateCommand",
	"postStartCommand",
	"postAttachCommand",
	"forwardPorts",
	"containerEnv",
	"remoteEnv",
	"remoteUser",
	"containerUser",
]);
const CONTAINER_RUN = "The platform runs the container: it decides its mounts, privileges, user mapping and lifetime.";
const DEVCONTAINER_IGNORED: ReadonlyMap<string, string> = new Map([
	["privileged", CONTAINER_RUN],
	["capAdd", CONTAINER_RUN],
	["securityOpt", CONTAINER_RUN],
	["mounts", CONTAINER_RUN],
	["runArgs", CONTAINER_RUN],
	["init", CONTAINER_RUN],
	["overrideCommand", CONTAINER_RUN],
	["shutdownAction", CONTAINER_RUN],
	["workspaceMount", CONTAINER_RUN],
	["workspaceFolder", CONTAINER_RUN],
	["updateRemoteUserUID", CONTAINER_RUN],
	["userEnvProbe", CONTAINER_RUN],
	["appPort", "Ports are forwarded, not published: forwardPorts sets them."],
	["portsAttributes", "Port labels and actions are not used: forwardPorts sets the ports."],
	["otherPortsAttributes", "Port labels and actions are not used: forwardPorts sets the ports."],
	["customizations", "Editor settings are not used."],
	["hostRequirements", "The machine's size is the company's coding machine policy."],
	["waitFor", "Every install command finishes before the session's turn starts."],
]);
const COMPOSE_KEYS = new Set(["dockerComposeFile", "service", "runServices"]);
const INSTALL_KEYS = ["onCreateCommand", "updateContentCommand", "postCreateCommand"] as const;
const START_KEYS = ["postStartCommand", "postAttachCommand"] as const;

/** devcontainer.json (the containers.dev reference): onCreateCommand, updateContentCommand and postCreateCommand
 * install, postStartCommand and postAttachCommand start, forwardPorts gives the ports, containerEnv and remoteEnv the
 * environment's two scopes, remoteUser (else containerUser) the user. Paths are relative to `.devcontainer`. Variables such as
 * `${localEnv:…}` stay as written: the devcontainer CLI fills them in the builder VM (5h-4). */
function devcontainerSetup(root: JsonObject, problems: Problems): Mapped {
	const setup = draft("devcontainer");
	const dockerfiles: Mapped["dockerfiles"] = [];
	const folder = ".devcontainer";
	for (const key of Object.keys(root)) {
		const at = pointer("", key);
		const ignored = DEVCONTAINER_IGNORED.get(key);
		if (ignored !== undefined) problems.ignore(at, "IGNORED", ignored);
		else if (COMPOSE_KEYS.has(key))
			problems.refuse(at, "NOT_SUPPORTED", "Compose-based devcontainers are not supported yet.");
		else if (!DEVCONTAINER_KEYS.has(key)) problems.refuse(at, "UNKNOWN_KEY", UNKNOWN);
	}
	const field = (key: string): Json | undefined => (key in root ? root[key] : undefined);

	const name = field("name");
	if (name !== undefined) setup.name = textOf(name, "/name", problems);
	const remoteUser = field("remoteUser");
	const containerUser = field("containerUser");
	const remote = remoteUser === undefined ? null : userOf(remoteUser, "/remoteUser", problems);
	const container = containerUser === undefined ? null : userOf(containerUser, "/containerUser", problems);
	setup.user = remote ?? container;

	const initialize = field("initializeCommand");
	if (initialize !== undefined) setup.initialize = stepsOf("initializeCommand", initialize, problems);
	setup.install = INSTALL_KEYS.flatMap((key) => {
		const command = field(key);
		return command === undefined ? [] : stepsOf(key, command, problems);
	});
	setup.start = START_KEYS.flatMap((key) => {
		const command = field(key);
		return command === undefined ? [] : stepsOf(key, command, problems);
	});

	const forwardPorts = field("forwardPorts");
	if (forwardPorts !== undefined) {
		const ports = new Ports(problems);
		for (const [index, item] of (arrayOf(forwardPorts, "/forwardPorts", problems) ?? []).entries()) {
			const itemAt = pointer("/forwardPorts", index);
			if (typeof item === "string")
				problems.ignore(itemAt, "IGNORED", "Only the machine's own ports are forwarded, not another host's.");
			else {
				const port = portOf(item, itemAt, problems);
				if (port !== null) ports.add(port, null, itemAt);
			}
		}
		setup.ports = ports.list;
	}

	const containerEnv = new Map<string, string>();
	const remoteEnv = new Map<string, string | null>();
	for (const key of ["containerEnv", "remoteEnv"]) {
		const value = field(key);
		const variables = value === undefined ? null : objectOf(value, `/${key}`, problems);
		for (const [variable, entry] of Object.entries(variables ?? {})) {
			const at = pointer(`/${key}`, variable);
			if (!ENV_NAME.test(variable))
				problems.refuse(
					at,
					"INVALID_VALUE",
					"Not a variable name: letters, digits and _, not starting with a digit.",
				);
			// remoteEnv's null is kept: it unsets a variable the base or containerEnv sets.
			else if (entry === null && key === "remoteEnv") remoteEnv.set(variable, null);
			else if (typeof entry !== "string" || entry.includes("\0"))
				problems.refuse(at, "WRONG_TYPE", "Must be a string without a NUL character.");
			else if (key === "remoteEnv") remoteEnv.set(variable, entry);
			else containerEnv.set(variable, entry);
		}
	}
	setup.containerEnv = Object.fromEntries(containerEnv);
	setup.remoteEnv = Object.fromEntries(remoteEnv);

	const features = field("features");
	if (features !== undefined) {
		const options = new Map<string, unknown>();
		for (const [id, entry] of Object.entries(objectOf(features, "/features", problems) ?? {})) {
			const at = pointer("/features", id);
			if (id === "") problems.refuse(at, "INVALID_VALUE", "A feature needs an id.");
			else if (typeof entry === "string" || typeof entry === "boolean" || isObject(entry))
				options.set(id, plain(entry));
			else problems.refuse(at, "WRONG_TYPE", "Must be an object of options, a version or true.");
		}
		setup.features = Object.fromEntries(options);
	}
	const order = field("overrideFeatureInstallOrder");
	if (order !== undefined) setup.featureInstallOrder = textsOf(order, "/overrideFeatureInstallOrder", problems);

	const buildValue = field("build");
	const build = buildValue === undefined ? null : objectOf(buildValue, "/build", problems);
	let dockerfile: { path: string | null; at: string } | null = null;
	let context: string | null = null;
	let args: Record<string, string> = {};
	let target: string | null = null;
	for (const [key, entry] of Object.entries(build ?? {})) {
		const at = pointer("/build", key);
		if (key === "dockerfile") {
			const path = textOf(entry, at, problems);
			dockerfile = { path: path === null ? null : fileOf(folder, path, at, problems), at };
		} else if (key === "context") {
			const path = textOf(entry, at, problems);
			context = path === null ? null : folderOf(folder, path, at, problems);
		} else if (key === "args") args = argsOf(entry, at, problems);
		else if (key === "target") target = textOf(entry, at, problems);
		else if (key === "options" || key === "cacheFrom")
			problems.ignore(at, "IGNORED", "The platform runs the build and keeps its cache.");
		else problems.refuse(at, "UNKNOWN_KEY", UNKNOWN);
	}
	// The older form: dockerFile and context at the top.
	const oldDockerfile = field("dockerFile");
	if (oldDockerfile !== undefined) {
		if (dockerfile) problems.refuse("/dockerFile", "CONFLICT", "Give build.dockerfile or dockerFile, not both.");
		else {
			const path = textOf(oldDockerfile, "/dockerFile", problems);
			dockerfile = { path: path === null ? null : fileOf(folder, path, "/dockerFile", problems), at: "/dockerFile" };
		}
	}
	const oldContext = field("context");
	if (oldContext !== undefined) {
		if (build && "context" in build)
			problems.refuse("/context", "CONFLICT", "Give build.context or context, not both.");
		else {
			const path = textOf(oldContext, "/context", problems);
			context = path === null ? null : folderOf(folder, path, "/context", problems);
		}
	}
	if (!dockerfile) {
		if (build) problems.refuse("/build", "MISSING_KEY", "Needs dockerfile.");
		else if (oldContext !== undefined)
			problems.refuse("/context", "MISSING_KEY", "A build context needs a Dockerfile.");
	} else {
		if (dockerfile.path !== null) dockerfiles.push({ path: dockerfile.path, at: dockerfile.at });
		setup.base = {
			kind: "dockerfile",
			dockerfile: dockerfile.path,
			contents: null,
			context: context ?? folder,
			args,
			target,
		};
	}
	const image = field("image");
	if (image !== undefined) {
		if (dockerfile) problems.refuse("/image", "CONFLICT", "Give image or a Dockerfile, not both.");
		else setup.base = imageOf(image, "/image", problems) ?? setup.base;
	}
	return { setup, dockerfiles };
}

class Ports {
	readonly list: { port: number; name: string | null }[] = [];
	readonly #problems: Problems;

	constructor(problems: Problems) {
		this.#problems = problems;
	}

	add(port: number, name: string | null, at: string): void {
		if (this.list.some((entry) => entry.port === port))
			this.#problems.refuse(at, "DUPLICATE", `Port ${port} is given twice.`);
		else this.list.push({ port, name });
	}
}

/** A devcontainer lifecycle command: a shell line, an argument list, or an object of named commands that run side by
 * side (in name order here, as they have no order). */
function stepsOf(from: string, value: Json, problems: Problems): CodingSetupStep[] {
	const at = pointer("", from);
	if (typeof value === "string") return [{ from, commands: [{ name: null, run: { shell: value } }] }];
	if (Array.isArray(value)) {
		const argv = argvOf(value, at, problems);
		return argv ? [{ from, commands: [{ name: null, run: { argv } }] }] : [];
	}
	if (!isObject(value)) {
		problems.refuse(at, "WRONG_TYPE", "Must be a command: a string, an array of strings or an object of them.");
		return [];
	}
	const commands: CodingSetupStep["commands"][number][] = [];
	for (const name of Object.keys(value).sort()) {
		const entry = value[name];
		const entryAt = pointer(at, name);
		if (typeof entry === "string") commands.push({ name, run: { shell: entry } });
		else if (Array.isArray(entry)) {
			const argv = argvOf(entry, entryAt, problems);
			if (argv) commands.push({ name, run: { argv } });
		} else problems.refuse(entryAt, "WRONG_TYPE", "Must be a command: a string or an array of strings.");
	}
	return commands.length === 0 ? [] : [{ from, commands }];
}

function argvOf(value: Json[], at: string, problems: Problems): string[] | null {
	if (value.length === 0) {
		problems.refuse(at, "INVALID_VALUE", "An argument list needs a program.");
		return null;
	}
	const argv = textsOf(value, at, problems);
	return argv.length === value.length ? argv : null;
}

function terminalsOf(value: Json, at: string, problems: Problems): CodingSetupTerminal[][] {
	const windows: CodingSetupTerminal[][] = [];
	for (const [index, item] of (arrayOf(value, at, problems) ?? []).entries()) {
		const itemAt = pointer(at, index);
		const entries: [Json, string][] = Array.isArray(item)
			? item.map((entry, inner): [Json, string] => [entry, pointer(itemAt, inner)])
			: [[item, itemAt]];
		const window: CodingSetupTerminal[] = [];
		for (const [entry, entryAt] of entries) {
			const terminal = objectOf(entry, entryAt, problems);
			if (!terminal) continue;
			let name: string | null = null;
			let command: string | null = null;
			let description: string | null = null;
			for (const [key, field] of Object.entries(terminal)) {
				const fieldAt = pointer(entryAt, key);
				if (key === "name") name = textOf(field, fieldAt, problems);
				else if (key === "command") command = textOf(field, fieldAt, problems);
				else if (key === "description") description = textOf(field, fieldAt, problems);
				else problems.ignore(fieldAt, "IGNORED", "A terminal uses only name, command and description.");
			}
			if (!("command" in terminal)) problems.refuse(entryAt, "MISSING_KEY", "Needs command.");
			else if (command !== null) window.push({ name, command, description });
		}
		if (window.length > 0) windows.push(window);
	}
	return windows;
}

function mcpServersOf(value: Json, at: string, problems: Problems): CodingSetupMcpServer[] {
	const servers: CodingSetupMcpServer[] = [];
	for (const [index, item] of (arrayOf(value, at, problems) ?? []).entries()) {
		const itemAt = pointer(at, index);
		const server = objectOf(item, itemAt, problems);
		if (!server) continue;
		const entry = { name: null as string | null, serverUrl: null as string | null, command: null as string | null };
		let toolAllowlist: string[] = [];
		for (const [key, field] of Object.entries(server)) {
			const fieldAt = pointer(itemAt, key);
			if (key === "name" || key === "serverUrl" || key === "command") entry[key] = textOf(field, fieldAt, problems);
			else if (key === "toolAllowlist") toolAllowlist = textsOf(field, fieldAt, problems);
			else problems.refuse(fieldAt, "UNKNOWN_KEY", UNKNOWN);
		}
		if (!("serverUrl" in server) && !("command" in server))
			problems.refuse(itemAt, "MISSING_KEY", "Needs serverUrl or command.");
		servers.push({ ...entry, toolAllowlist });
	}
	return servers;
}

/** `github.com/<owner>/<name>`, with or without `https://` and `.git`, as `<owner>/<name>` in lower case: sorted,
 * each once. Another host's repository is ignored: only GitHub repositories can be granted. */
function repositoriesOf(value: Json, at: string, problems: Problems): string[] {
	const repositories = new Set<string>();
	for (const [index, item] of (arrayOf(value, at, problems) ?? []).entries()) {
		const itemAt = pointer(at, index);
		if (typeof item !== "string") {
			problems.refuse(itemAt, "WRONG_TYPE", "Must be a string.");
			continue;
		}
		const match = GITHUB_REPOSITORY.exec(item);
		const repository = match ? `${match[1]}/${match[2]}`.toLowerCase() : null;
		if (repository !== null && REPOSITORY.test(repository)) repositories.add(repository);
		else problems.ignore(itemAt, "IGNORED", "Only a GitHub repository (github.com/<owner>/<name>) can be added.");
	}
	return [...repositories].sort();
}

function argsOf(value: Json, at: string, problems: Problems): Record<string, string> {
	const args = new Map<string, string>();
	for (const [name, entry] of Object.entries(objectOf(value, at, problems) ?? {})) {
		const entryAt = pointer(at, name);
		if (!ENV_NAME.test(name)) problems.refuse(entryAt, "INVALID_VALUE", "Not a build argument name.");
		else {
			const text = textOf(entry, entryAt, problems);
			if (text !== null) args.set(name, text);
		}
	}
	return Object.fromEntries(args);
}

/** `path`, relative to the folder `within` ("" for the root), as a path from the repository's root with no `.` or `..`
 * segment: "." is the root. Null for a path that is empty or absolute, holds a control character or a backslash, or
 * leaves the repository. */
function repositoryPath(within: string, path: string): string | null {
	if (path === "" || path.length > 4096 || path.startsWith("/")) return null;
	for (let index = 0; index < path.length; index++) {
		const code = path.charCodeAt(index);
		if (code < 0x20 || code === 0x7f || code === 0x5c) return null;
	}
	const parts: string[] = [];
	for (const part of `${within}/${path}`.split("/")) {
		if (part === "" || part === ".") continue;
		if (part !== "..") parts.push(part);
		else if (parts.pop() === undefined) return null;
	}
	return parts.length === 0 ? "." : parts.join("/");
}

function folderOf(within: string, path: string, at: string, problems: Problems): string | null {
	const resolved = repositoryPath(within, path);
	if (resolved === null) problems.refuse(at, "INVALID_PATH", "Must be a relative path inside the repository.");
	return resolved;
}

function fileOf(within: string, path: string, at: string, problems: Problems): string | null {
	const resolved = folderOf(within, path, at, problems);
	if (resolved !== ".") return resolved;
	problems.refuse(at, "INVALID_PATH", "Must name a file.");
	return null;
}

function imageOf(value: Json, at: string, problems: Problems): CodingSetupBase | null {
	const image = textOf(value, at, problems);
	if (image === null) return null;
	if (image.length <= 512 && IMAGE.test(image)) return { kind: "image", image };
	problems.refuse(at, "INVALID_VALUE", "Must be an image reference, such as ubuntu:24.04.");
	return null;
}

function userOf(value: Json, at: string, problems: Problems): string | null {
	const user = textOf(value, at, problems);
	if (user === null || USER.test(user)) return user;
	problems.refuse(at, "INVALID_VALUE", "Must be a user name, such as node or root, or a uid.");
	return null;
}

function portOf(value: Json, at: string, problems: Problems): number | null {
	if (typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 65535) return value;
	problems.refuse(at, "INVALID_VALUE", "Must be a whole number from 1 to 65535.");
	return null;
}

function textOf(value: Json, at: string, problems: Problems): string | null {
	if (typeof value === "string") return value;
	problems.refuse(at, "WRONG_TYPE", "Must be a string.");
	return null;
}

function textsOf(value: Json, at: string, problems: Problems): string[] {
	const texts: string[] = [];
	for (const [index, item] of (arrayOf(value, at, problems) ?? []).entries()) {
		const text = textOf(item, pointer(at, index), problems);
		if (text !== null) texts.push(text);
	}
	return texts;
}

function flagOf(value: Json, at: string, problems: Problems): boolean | null {
	if (typeof value === "boolean") return value;
	problems.refuse(at, "WRONG_TYPE", "Must be true or false.");
	return null;
}

function arrayOf(value: Json, at: string, problems: Problems): Json[] | null {
	if (Array.isArray(value)) return value;
	problems.refuse(at, "WRONG_TYPE", "Must be an array.");
	return null;
}

function objectOf(value: Json, at: string, problems: Problems): JsonObject | null {
	if (isObject(value)) return value;
	problems.refuse(at, "WRONG_TYPE", "Must be an object.");
	return null;
}

function isObject(value: Json): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parsed objects have no prototype; the setup holds ordinary ones. */
function plain(value: Json): unknown {
	if (Array.isArray(value)) return value.map(plain);
	if (isObject(value)) return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, plain(entry)]));
	return value;
}

function pointer(at: string, key: string | number): string {
	return `${at}/${String(key).replaceAll("~", "~0").replaceAll("/", "~1")}`;
}
