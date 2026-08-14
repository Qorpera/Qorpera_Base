import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { delimiter, extname, isAbsolute, join, relative, resolve } from "node:path";

export const MCP_CONFIG_PATH = join("connections", "mcp.json");

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

function environmentValue(declared: Record<string, string> | undefined, name: string): string | undefined {
	for (const [key, value] of Object.entries(declared ?? {})) {
		if (key.toLowerCase() === name.toLowerCase()) return value;
	}
	for (const [key, value] of Object.entries(process.env)) {
		if (key.toLowerCase() === name.toLowerCase()) return value;
	}
	return undefined;
}

function resolveExecutable(root: string, config: McpServerConfig) {
	const command = config.command!;
	const direct = isAbsolute(command) || /[/\\]/.test(command);
	const extensions =
		process.platform === "win32" && !extname(command)
			? (environmentValue(config.env, "PATHEXT") ?? ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean)
			: [""];
	const bases = direct
		? [resolve(root, command)]
		: (environmentValue(config.env, "PATH") ?? "")
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

function argumentFileIdentity(root: string, arg: string): object | undefined {
	const rawPath = fileLikeArgument(arg);
	if (!rawPath) return undefined;
	const candidate = resolve(root, rawPath);
	try {
		if (!statSync(candidate).isFile()) return { argument: arg, path: candidate, state: "not-file" };
		const resolved = realpathSync.native(candidate);
		return { argument: arg, path: candidate, resolved, sha256: fileSha256(resolved) };
	} catch {
		return { argument: arg, path: candidate, state: "missing" };
	}
}

function localExecutionIdentity(root: string, config: McpServerConfig): object | undefined {
	if (!config.command) return undefined;
	return {
		executable: resolveExecutable(root, config),
		files: (config.args ?? []).flatMap((arg) => {
			const identity = argumentFileIdentity(root, arg);
			return identity ? [identity] : [];
		}),
	};
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
