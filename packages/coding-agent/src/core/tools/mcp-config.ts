import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { createRequire, isBuiltin } from "node:module";
import { delimiter, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const MCP_CONFIG_PATH = join("connections", "mcp.json");
const CONTROLLER_ONLY_ENV = new Set(["QORPERA_MODEL_BROKER_HANDLES", "QORPERA_TRAIL_BROKER_TOKEN"]);

function isControllerOnlyEnvironmentName(name: string): boolean {
	return CONTROLLER_ONLY_ENV.has(name.toUpperCase());
}

export interface McpServerConfig {
	/** Local stdio server: spawned with the controller's host access. */
	command?: string;
	args?: string[];
	env?: Record<string, string>;
	/** Remote server: MCP streamable-HTTP over the kernel HTTP lane. */
	url?: string;
	headers?: Record<string, string>;
}

function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (value && typeof value === "object") {
		const entries = Object.entries(value as Record<string, unknown>)
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([key, entryValue]) => `${JSON.stringify(key)}:${canonicalJson(entryValue)}`);
		return `{${entries.join(",")}}`;
	}
	return JSON.stringify(value) ?? "null";
}

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function fileSha256(path: string): string {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function isUnderRoot(path: string, root: string): boolean {
	const rel = relative(resolve(root), path);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function setEnvironmentValue(environment: Record<string, string>, name: string, value: string): void {
	if (process.platform === "win32") {
		for (const existing of Object.keys(environment)) {
			if (existing.toLowerCase() === name.toLowerCase()) delete environment[existing];
		}
	}
	environment[name] = value;
}

export function createMcpServerEnvironment(declared: Record<string, string> | undefined): Record<string, string> {
	const environment: Record<string, string> = {};
	for (const [name, value] of Object.entries(process.env)) {
		if (value !== undefined && !isControllerOnlyEnvironmentName(name)) setEnvironmentValue(environment, name, value);
	}
	setEnvironmentValue(environment, "ELECTRON_RUN_AS_NODE", "1");
	// Declared values override the inherited host environment. Avoid writing
	// raw secrets here when a secret:// reference over remote MCP is suitable.
	for (const [name, value] of Object.entries(declared ?? {})) {
		if (typeof value === "string" && !isControllerOnlyEnvironmentName(name)) {
			setEnvironmentValue(environment, name, value);
		}
	}
	return environment;
}

function environmentValue(environment: Record<string, string>, name: string): string | undefined {
	if (process.platform !== "win32") return environment[name];
	const match = Object.keys(environment).find((key) => key.toLowerCase() === name.toLowerCase());
	return match ? environment[match] : undefined;
}

function resolveExecutable(root: string, config: McpServerConfig) {
	const command = config.command!;
	const environment = createMcpServerEnvironment(config.env);
	const direct = isAbsolute(command) || /[/\\]/.test(command);
	const extensions =
		process.platform === "win32" && !extname(command)
			? (environmentValue(environment, "PATHEXT") ?? ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean)
			: [""];
	const bases = direct
		? [resolve(root, command)]
		: (environmentValue(environment, "PATH") ?? "")
				.split(delimiter)
				.map((entry) => resolve(root, entry.replace(/^"|"$/g, ""), command));
	for (const base of bases) {
		for (const extension of extensions) {
			const candidate = `${base}${extension}`;
			try {
				if (!statSync(candidate).isFile()) continue;
				const resolved = realpathSync.native(candidate);
				const stats = statSync(resolved);
				const agentControlled = isUnderRoot(candidate, root) || isUnderRoot(resolved, root);
				return {
					configured: command,
					resolved,
					stat: {
						device: stats.dev,
						inode: stats.ino,
						size: stats.size,
						modifiedMs: stats.mtimeMs,
						changedMs: stats.ctimeMs,
					},
					...(agentControlled ? { sha256: fileSha256(resolved) } : {}),
				};
			} catch {
				// Try the next executable candidate.
			}
		}
	}
	return { configured: command };
}

function fileLikeArgument(arg: string): string | undefined {
	if (!arg || (arg.startsWith("-") && !arg.includes("="))) return undefined;
	const candidate = arg.startsWith("-") ? arg.slice(arg.indexOf("=") + 1) : arg;
	if (!candidate || candidate.includes("\u0000")) return undefined;
	return candidate;
}

const MODULE_SOURCE_EXTENSIONS = new Set([".cjs", ".cts", ".js", ".jsx", ".mjs", ".mts", ".ts", ".tsx"]);
const STATIC_MODULE_SPECIFIER = /(?:^|[;\n\r])\s*(?:import|export)\s+(?:[^"'();]*?\s+from\s+)?["']([^"']+)["']/g;
const CALLED_MODULE_SPECIFIER = /\b(?:import|require)\s*\(\s*["']([^"']+)["']\s*\)/g;
const ALTERNATE_MODULE_LOADERS = new Set(["module", "node:module", "node:vm", "vm"]);
const DYNAMIC_CODE_CONSTRUCT =
	/\b(?:eval|Function|AsyncFunction|GeneratorFunction|WebAssembly|globalThis)\b|\.constructor\b|\bprocess\s*\.\s*getBuiltinModule\b|\bmodule\s*\[/;
const FILE_SYSTEM_MODULES = new Set(["fs", "node:fs", "fs/promises", "node:fs/promises"]);
const CHILD_PROCESS_MODULES = new Set(["child_process", "node:child_process"]);
const FILE_READ_METHOD_NAMES = [
	"access",
	"accessSync",
	"createReadStream",
	"exists",
	"existsSync",
	"lstat",
	"lstatSync",
	"open",
	"openAsBlob",
	"openSync",
	"opendir",
	"opendirSync",
	"readFile",
	"readFileSync",
	"readdir",
	"readdirSync",
	"readlink",
	"readlinkSync",
	"realpath",
	"realpathSync",
	"stat",
	"statSync",
] as const;
const FILE_READ_METHOD = new RegExp(`\\b(?:${FILE_READ_METHOD_NAMES.join("|")})\\b`);
const LITERAL_FILE_READ_CALL = new RegExp(
	`\\b(${FILE_READ_METHOD_NAMES.join("|")})\\s*\\(\\s*(["'])([^"'\\\\\\r\\n]*)\\2`,
	"g",
);
const ALIASED_FILE_READ_IMPORT = new RegExp(`\\b(?:${FILE_READ_METHOD_NAMES.join("|")})\\s+as\\s+\\w+`);
const STATIC_LITERAL_PATTERNS = [
	{ pattern: /'((?:\\[\s\S]|[^'\\\r\n])*)'/g, template: false },
	{ pattern: /"((?:\\[\s\S]|[^"\\\r\n])*)"/g, template: false },
	{ pattern: /`((?:\\[\s\S]|[^`])*)`/g, template: true },
] as const;

function decodeStaticJavaScriptLiteral(raw: string, template: boolean): string | undefined {
	let value = "";
	for (let index = 0; index < raw.length; index += 1) {
		const character = raw[index];
		if (template && character === "$" && raw[index + 1] === "{") return undefined;
		if (character !== "\\") {
			value += character;
			continue;
		}
		index += 1;
		const escaped = raw[index];
		if (escaped === undefined) return undefined;
		if (escaped === "\n") continue;
		if (escaped === "\r") {
			if (raw[index + 1] === "\n") index += 1;
			continue;
		}
		const simple = { b: "\b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v" }[escaped];
		if (simple !== undefined) {
			value += simple;
			continue;
		}
		if (escaped === "0") {
			if (/\d/.test(raw[index + 1] ?? "")) return undefined;
			value += "\u0000";
			continue;
		}
		if (/[1-9]/.test(escaped)) return undefined;
		if (escaped === "x") {
			const hex = raw.slice(index + 1, index + 3);
			if (!/^[\da-fA-F]{2}$/.test(hex)) return undefined;
			value += String.fromCodePoint(Number.parseInt(hex, 16));
			index += 2;
			continue;
		}
		if (escaped === "u") {
			const braced = raw[index + 1] === "{";
			const end = braced ? raw.indexOf("}", index + 2) : index + 5;
			const hex = braced ? raw.slice(index + 2, end) : raw.slice(index + 1, end);
			if (end < 0 || !/^[\da-fA-F]+$/.test(hex) || (!braced && hex.length !== 4)) return undefined;
			const codePoint = Number.parseInt(hex, 16);
			if (codePoint > 0x10ffff) return undefined;
			value += String.fromCodePoint(codePoint);
			index = braced ? end : end - 1;
			continue;
		}
		value += escaped;
	}
	return value;
}

function runtimePathIdentity(path: string): object {
	let resolved: string;
	let stats: ReturnType<typeof statSync>;
	try {
		resolved = realpathSync.native(path);
		stats = statSync(resolved);
	} catch {
		return { path, state: "missing" };
	}
	if (stats.isFile()) return { path, resolved, sha256: fileSha256(resolved) };
	if (!stats.isDirectory()) return { path, resolved, state: "not-file-or-directory" };
	const files: object[] = [];
	const visited = new Set<string>();
	const visit = (logicalDirectory: string): void => {
		const physicalDirectory = realpathSync.native(logicalDirectory);
		if (visited.has(physicalDirectory)) return;
		visited.add(physicalDirectory);
		for (const entry of readdirSync(logicalDirectory, { withFileTypes: true }).sort((a, b) =>
			a.name.localeCompare(b.name),
		)) {
			const logicalPath = join(logicalDirectory, entry.name);
			let physicalPath: string;
			let entryStats: ReturnType<typeof statSync>;
			try {
				physicalPath = realpathSync.native(logicalPath);
				entryStats = statSync(physicalPath);
			} catch {
				files.push({ path: relative(path, logicalPath), state: "missing" });
				continue;
			}
			if (entryStats.isDirectory()) {
				visit(logicalPath);
				continue;
			}
			files.push({
				path: relative(path, logicalPath),
				resolved: physicalPath,
				...(entryStats.isFile() ? { sha256: fileSha256(physicalPath) } : { state: "not-file" }),
			});
		}
	};
	visit(path);
	return { path, resolved, files };
}

/**
 * Bind only runtime files that reviewed source can reach through literal
 * node:fs reads or literal child-process script arguments. Dynamic fs paths
 * fail closed: without an immutable filesystem snapshot they cannot be tied
 * to the approval that launches host code.
 */
function runtimeInputIdentities(root: string, source: string, path: string, specifiers: string[]): object[] {
	const usesFileSystem = specifiers.some((specifier) => FILE_SYSTEM_MODULES.has(specifier));
	const usesChildProcess = specifiers.some((specifier) => CHILD_PROCESS_MODULES.has(specifier));
	if (!usesFileSystem && !usesChildProcess) return [];
	if (usesFileSystem && ALIASED_FILE_READ_IMPORT.test(source)) {
		throw new Error(
			`Local host program runtime input closure cannot be proven for ${path}; node:fs read imports cannot be aliased`,
		);
	}
	const inputs: object[] = [];
	LITERAL_FILE_READ_CALL.lastIndex = 0;
	for (let match = LITERAL_FILE_READ_CALL.exec(source); match; match = LITERAL_FILE_READ_CALL.exec(source)) {
		inputs.push(runtimePathIdentity(resolve(root, match[3])));
	}
	if (usesChildProcess) {
		for (const { pattern, template } of STATIC_LITERAL_PATTERNS) {
			pattern.lastIndex = 0;
			for (let match = pattern.exec(source); match; match = pattern.exec(source)) {
				const value = decodeStaticJavaScriptLiteral(match[1], template);
				if (value === undefined) {
					throw new Error(
						`Local host program runtime input closure cannot be proven for ${path}; child-process strings must be statically decodable`,
					);
				}
				if (
					value &&
					!value.includes("\u0000") &&
					(isAbsolute(value) ||
						value.startsWith(".") ||
						value.includes("/") ||
						value.includes("\\") ||
						extname(value))
				) {
					inputs.push(runtimePathIdentity(resolve(root, value)));
				}
			}
		}
	}
	if (usesFileSystem) {
		const unverifiedSource = source
			.replace(STATIC_MODULE_SPECIFIER, "")
			.replace(CALLED_MODULE_SPECIFIER, "")
			.replace(LITERAL_FILE_READ_CALL, "");
		if (FILE_READ_METHOD.test(unverifiedSource)) {
			throw new Error(
				`Local host program runtime input closure cannot be proven for ${path}; node:fs reads must use literal paths`,
			);
		}
	}
	return [...new Map(inputs.map((input) => [canonicalJson(input), input])).values()].sort((a, b) =>
		canonicalJson(a).localeCompare(canonicalJson(b)),
	);
}

function moduleSpecifiers(source: string, path: string): string[] {
	const specifiers = new Set<string>();
	for (const pattern of [STATIC_MODULE_SPECIFIER, CALLED_MODULE_SPECIFIER]) {
		pattern.lastIndex = 0;
		for (let match = pattern.exec(source); match; match = pattern.exec(source)) specifiers.add(match[1]);
	}
	const unverifiedSource = source
		.replace(STATIC_MODULE_SPECIFIER, "")
		.replace(CALLED_MODULE_SPECIFIER, "")
		.replace(/\bimport\s*\.\s*meta\b/g, "");
	if (/\b(?:import|require)\b/.test(unverifiedSource)) {
		throw new Error(
			`Local host program dependency closure cannot be proven for ${path}; use only literal import, export-from, and require references`,
		);
	}
	if (
		DYNAMIC_CODE_CONSTRUCT.test(unverifiedSource) ||
		[...specifiers].some((value) => ALTERNATE_MODULE_LOADERS.has(value))
	) {
		throw new Error(
			`Local host program dependency closure cannot be proven for ${path}; dynamic code and alternate module loaders are not allowed`,
		);
	}
	return [...specifiers].sort();
}

function resolveModuleSpecifier(importer: string, specifier: string): string | undefined {
	try {
		const configured = specifier.startsWith("file:")
			? fileURLToPath(new URL(specifier))
			: specifier.startsWith(".") || isAbsolute(specifier)
				? resolve(dirname(importer), specifier.replace(/[?#].*$/, ""))
				: undefined;
		if (configured && statSync(configured).isFile()) return configured;
		const resolved = createRequire(importer).resolve(specifier);
		return statSync(resolved).isFile() ? resolved : undefined;
	} catch {
		return undefined;
	}
}

function transitiveModuleIdentity(root: string, entry: string): object[] {
	const identities: object[] = [];
	const visited = new Set<string>();
	const visit = (path: string): void => {
		let resolved: string;
		try {
			resolved = realpathSync.native(path);
		} catch {
			return;
		}
		if (visited.has(resolved)) return;
		visited.add(resolved);
		const agentControlled = isUnderRoot(path, root) || isUnderRoot(resolved, root);
		const stats = statSync(resolved);
		identities.push({
			path,
			resolved,
			...(agentControlled
				? { sha256: fileSha256(resolved) }
				: { stat: { size: stats.size, modifiedMs: stats.mtimeMs, changedMs: stats.ctimeMs } }),
		});
		if (!agentControlled || !MODULE_SOURCE_EXTENSIONS.has(extname(resolved).toLowerCase())) return;
		const source = readFileSync(resolved, "utf-8");
		const specifiers = moduleSpecifiers(source, resolved);
		const runtimeInputs = runtimeInputIdentities(root, source, resolved, specifiers);
		if (runtimeInputs.length > 0) identities.push({ importer: resolved, runtimeInputs });
		for (const specifier of specifiers) {
			if (isBuiltin(specifier)) continue;
			const dependency = resolveModuleSpecifier(resolved, specifier);
			if (dependency) visit(dependency);
			else {
				throw new Error(
					`Local host program dependency closure cannot be proven for ${resolved}; ${specifier} could not be resolved`,
				);
			}
		}
	};
	visit(entry);
	return identities.sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b)));
}

function argumentFileIdentity(root: string, arg: string): object | undefined {
	const rawPath = fileLikeArgument(arg);
	if (!rawPath) return undefined;
	const candidate = resolve(root, rawPath);
	let resolved: string;
	try {
		if (!statSync(candidate).isFile()) return { argument: arg, path: candidate, state: "not-file" };
		resolved = realpathSync.native(candidate);
	} catch {
		return { argument: arg, path: candidate, state: "missing" };
	}
	return {
		argument: arg,
		path: candidate,
		resolved,
		sha256: fileSha256(resolved),
		dependencies: transitiveModuleIdentity(root, resolved),
	};
}

function localExecutionIdentity(root: string, config: McpServerConfig): object | undefined {
	if (!config.command) return undefined;
	const executable = resolveExecutable(root, config);
	const resolvedExecutable = "resolved" in executable ? executable.resolved : undefined;
	return {
		executable: {
			...executable,
			...(resolvedExecutable && isUnderRoot(resolvedExecutable, root)
				? { dependencies: transitiveModuleIdentity(root, resolvedExecutable) }
				: {}),
		},
		files: (config.args ?? []).flatMap((arg) => {
			const identity = argumentFileIdentity(root, arg);
			return identity ? [identity] : [];
		}),
	};
}

/** Identity bound to one company-program execution across approval and spawn. */
export function companyProgramExecutionFingerprint(root: string, cwd: string, rawPath: string): string {
	const candidate = resolve(cwd, rawPath);
	let resolved: string;
	try {
		resolved = realpathSync.native(candidate);
	} catch {
		return sha256(canonicalJson({ path: candidate, state: "missing" }));
	}
	return sha256(
		canonicalJson({
			path: candidate,
			resolved,
			insideCompany: isUnderRoot(candidate, root) && isUnderRoot(resolved, root),
			dependencies: transitiveModuleIdentity(root, resolved),
		}),
	);
}

export function readMcpConfig(root: string): Record<string, McpServerConfig> {
	const path = join(root, MCP_CONFIG_PATH);
	if (!existsSync(path)) {
		throw new Error(
			`No MCP servers declared. Create ${MCP_CONFIG_PATH} with {"servers": {"<name>": {"command": …, "args": […]}}}`,
		);
	}
	const parsed = JSON.parse(readFileSync(path, "utf-8")) as { servers?: Record<string, McpServerConfig> };
	if (!parsed.servers || typeof parsed.servers !== "object") {
		throw new Error(`${MCP_CONFIG_PATH} must carry a "servers" object`);
	}
	for (const [name, server] of Object.entries(parsed.servers)) {
		const hasCommand = typeof server?.command === "string" && server.command.length > 0;
		const hasUrl = typeof server?.url === "string" && server.url.startsWith("https://");
		if (!server || hasCommand === hasUrl) {
			throw new Error(`MCP server ${name} needs exactly one of "command" (local stdio) or an https "url" (remote)`);
		}
		if (server.args !== undefined && !Array.isArray(server.args)) {
			throw new Error(`MCP server ${name}: "args" must be an array`);
		}
	}
	return parsed.servers;
}

export function resolveMcpServerConfig(
	root: string,
	name: string,
): { config: McpServerConfig; configurationHash: string } {
	const servers = readMcpConfig(root);
	const config = servers[name];
	if (!config) {
		throw new Error(`Unknown MCP server: ${name}. Declared servers: ${Object.keys(servers).join(", ") || "(none)"}`);
	}
	return {
		config,
		configurationHash: sha256(canonicalJson({ config, localExecution: localExecutionIdentity(root, config) })),
	};
}

/**
 * Stable identity for the selected server entry. Invalid or missing config
 * still gets a deterministic fingerprint so fixing it invalidates any gate
 * requested against the broken state.
 */
export function mcpServerConfigurationFingerprint(root: string, name: string): string {
	try {
		return resolveMcpServerConfig(root, name).configurationHash;
	} catch {
		let raw: string;
		try {
			raw = readFileSync(join(root, MCP_CONFIG_PATH), "utf-8");
		} catch {
			raw = "<missing>";
		}
		return sha256(canonicalJson({ name, raw }));
	}
}
