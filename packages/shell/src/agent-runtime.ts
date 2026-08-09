import { createHash, randomUUID } from "node:crypto";
import {
	appendFileSync,
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readFileSync,
	readSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

interface QorperaSessionAuthority {
	actor: "controller" | "product-worker";
	attended: boolean;
	autonomous?: boolean;
	label?: string;
	department?: string;
	worktree?: string;
}

interface SessionHeader {
	type: "session";
	version?: number;
	id: string;
	timestamp: string;
	cwd: string;
	qorpera?: QorperaSessionAuthority;
}

interface SessionEntry {
	type: string;
	id: string;
	parentId: string | null;
	timestamp: string;
	[key: string]: unknown;
}

export interface AgentScope {
	actor: "controller" | "product-worker";
	attended: boolean;
	autonomousLabel?: string;
	department?: string;
	worktree?: string;
}

export interface TrailBinding {
	path: string;
	file: string;
	token: string;
	authority: QorperaSessionAuthority;
}

export interface TrailAppendFrame {
	type: "qorpera_trail_append";
	token: string;
	entry: SessionEntry;
}

interface KernelWriteFrame {
	type: "qorpera_kernel_write";
	token: string;
	operation: "create_gate" | "consume_gate" | "append_notice";
	file?: string;
	content?: string;
	message?: string;
	status?: string;
}

const MAX_HEADER_BYTES = 64 * 1024;
const MAX_TRAIL_ENTRY_BYTES = 16 * 1024 * 1024;
const TRAIL_SESSION_VERSION = 3;

function readHeader(path: string): SessionHeader {
	const fd = openSync(path, "r");
	try {
		const buffer = Buffer.alloc(MAX_HEADER_BYTES);
		const size = readSync(fd, buffer, 0, buffer.length, 0);
		const end = buffer.subarray(0, size).indexOf(0x0a);
		if (end < 0) throw new Error(`trail session header is missing or too large: ${path}`);
		const header = JSON.parse(buffer.subarray(0, end).toString("utf-8")) as SessionHeader;
		if (header.type !== "session" || typeof header.id !== "string") {
			throw new Error(`trail session has an invalid header: ${path}`);
		}
		return header;
	} finally {
		closeSync(fd);
	}
}

function authorityForScope(scope: AgentScope): QorperaSessionAuthority {
	if (scope.actor === "product-worker" && (!scope.department || !scope.worktree)) {
		throw new Error("product-worker sessions require an exact department and worktree assignment");
	}
	return {
		actor: scope.actor,
		attended: scope.attended,
		autonomous: scope.autonomousLabel ? true : undefined,
		label: scope.autonomousLabel,
		department: scope.department,
		worktree: scope.worktree,
	};
}

function assertMatchingAuthority(actual: QorperaSessionAuthority | undefined, expected: QorperaSessionAuthority): void {
	if (!actual) throw new Error("legacy trail sessions have no kernel authority binding and cannot be resumed");
	for (const key of ["actor", "department", "worktree"] as const) {
		if (actual[key] !== expected[key]) {
			throw new Error(`trail session authority does not match the requested ${key}`);
		}
	}
}

export function bindTrailSession(root: string, cwd: string, scope: AgentScope, sessionFile?: string): TrailBinding {
	const trailDir = join(root, "trail");
	mkdirSync(trailDir, { recursive: true });
	const authority = authorityForScope(scope);
	let path: string;
	if (sessionFile) {
		if (basename(sessionFile) !== sessionFile || !sessionFile.endsWith(".jsonl")) {
			throw new Error("trail session must be a JSONL filename inside the company trail");
		}
		path = join(trailDir, sessionFile);
		if (!existsSync(path)) throw new Error(`trail session does not exist: ${sessionFile}`);
		const header = readHeader(path);
		if (header.version !== TRAIL_SESSION_VERSION) {
			throw new Error(`trail session schema ${header.version ?? 1} requires an explicit append-only migration`);
		}
		assertMatchingAuthority(header.qorpera, authority);
	} else {
		const timestamp = new Date().toISOString();
		const id = randomUUID();
		const fileTimestamp = timestamp.replace(/[:.]/g, "-");
		path = join(trailDir, `${fileTimestamp}_${id}.jsonl`);
		const header: SessionHeader = {
			type: "session",
			version: TRAIL_SESSION_VERSION,
			id,
			timestamp,
			cwd: resolve(cwd),
			qorpera: authority,
		};
		writeFileSync(path, `${JSON.stringify(header)}\n`, { flag: "wx" });
	}
	return { path, file: basename(path), token: randomUUID(), authority };
}

export function parseTrailAppendFrame(value: unknown, binding: TrailBinding): TrailAppendFrame | undefined {
	if (!value || typeof value !== "object") return undefined;
	const frame = value as Partial<TrailAppendFrame>;
	if (frame.type !== "qorpera_trail_append" || frame.token !== binding.token) return undefined;
	const entry = frame.entry as unknown;
	if (!entry || typeof entry !== "object") return undefined;
	const record = entry as { type?: unknown; id?: unknown; timestamp?: unknown };
	if (record.type === "session" || typeof record.id !== "string" || typeof record.timestamp !== "string") {
		return undefined;
	}
	if (Buffer.byteLength(JSON.stringify(record), "utf-8") > MAX_TRAIL_ENTRY_BYTES) return undefined;
	return { type: "qorpera_trail_append", token: binding.token, entry: entry as SessionEntry };
}

export function applyKernelWriteFrame(value: unknown, binding: TrailBinding, root: string): boolean {
	if (!value || typeof value !== "object") return false;
	const frame = value as Partial<KernelWriteFrame>;
	if (frame.type !== "qorpera_kernel_write") return false;
	if (frame.token !== binding.token) return true;
	const inbox = join(root, "inbox");
	if (frame.operation === "create_gate") {
		if (!frame.file || !/^gate-[a-z0-9-]+\.md$/i.test(frame.file)) return true;
		if (typeof frame.content !== "string" || Buffer.byteLength(frame.content) > 1024 * 1024) return true;
		const id = frame.content.match(/^id:\s*(gate-[a-z0-9-]+)$/m)?.[1];
		if (`${id}.md` !== frame.file || !/^status:\s*pending\b/m.test(frame.content)) return true;
		try {
			writeFileSync(join(inbox, frame.file), frame.content, { encoding: "utf-8", flag: "wx" });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
		return true;
	}
	if (frame.operation === "consume_gate") {
		if (frame.status !== "consumed" || !frame.file || !/^gate-[a-z0-9-]+\.md$/i.test(frame.file)) return true;
		const path = join(inbox, frame.file);
		const content = readFileSync(path, "utf-8");
		if (!/^status:\s*approved\b/m.test(content)) return true;
		writeFileSync(path, content.replace(/^status:.*$/m, "status: consumed"), "utf-8");
		return true;
	}
	if (frame.operation === "append_notice") {
		if (typeof frame.message !== "string" || Buffer.byteLength(frame.message) > 4096) return true;
		const path = join(inbox, "notices.md");
		const prefix = existsSync(path) ? "" : "# Notices\n\n";
		appendFileSync(path, `${prefix}- ${new Date().toISOString()} ${frame.message.replace(/[\r\n]+/g, " ")}\n`);
	}
	return true;
}

function tomlString(value: string): string {
	return JSON.stringify(value);
}

export function writeSandboxProfile(
	configDir: string,
	runtimeDir: string,
	companyRoot: string,
	scope: AgentScope,
	protectedPaths: string[],
): string {
	mkdirSync(configDir, { recursive: true });
	mkdirSync(runtimeDir, { recursive: true });
	const permissions = new Map<string, "read" | "write">([
		[":root", "read"],
		[":minimal", "read"],
		[":tmpdir", "write"],
		[":slash_tmp", "write"],
		[resolve(runtimeDir), "write"],
		[resolve(companyRoot), scope.actor === "controller" ? "write" : "read"],
	]);
	for (const path of protectedPaths) permissions.set(resolve(path), "read");
	if (scope.actor === "product-worker") {
		permissions.set(resolve(companyRoot, scope.worktree!), "write");
	} else {
		permissions.set(resolve(companyRoot, "inbox", "messages"), "write");
	}

	const filesystem = [...permissions]
		.map(([path, access]) => `${tomlString(path)} = ${tomlString(access)}`)
		.join("\n");
	const config = `default_permissions = "qorpera-agent"\n\n[permissions.qorpera-agent.filesystem]\n${filesystem}\n\n[permissions.qorpera-agent.network]\nenabled = true\n`;
	const configPath = join(configDir, "config.toml");
	writeFileSync(configPath, config, "utf-8");
	return configPath;
}

export function sandboxCommandArgs(codexEntry: string, runtimeDir: string, program: string, args: string[]): string[] {
	return [
		codexEntry,
		"sandbox",
		"--permission-profile",
		"qorpera-agent",
		"-C",
		resolve(runtimeDir),
		program,
		"--",
		...args,
	];
}

export function protectedControllerPaths(
	root: string,
	productPaths: Array<{ repository: string; worktrees: string }>,
): string[] {
	return [
		join(root, ".git"),
		join(root, "trail"),
		join(root, "authority.toml"),
		join(root, "AGENTS.md"),
		join(root, "CLAUDE.md"),
		join(root, ".qorpera", "products.json"),
		join(root, "inbox"),
		...productPaths.flatMap((product) => [join(root, product.repository), join(root, product.worktrees)]),
	];
}

export function inboxMessagesPath(root: string): string {
	const path = join(root, "inbox", "messages");
	mkdirSync(path, { recursive: true });
	return path;
}

export function sandboxConfigDir(userData: string, root: string, actor: AgentScope["actor"]): string {
	const resolvedRoot = resolve(root);
	const safeRoot = createHash("sha256")
		.update(process.platform === "win32" ? resolvedRoot.toLowerCase() : resolvedRoot)
		.digest("hex");
	return join(userData, "agent-sandbox", safeRoot, actor);
}

export function sandboxRuntimeDir(userData: string, root: string, actor: AgentScope["actor"]): string {
	return join(dirname(sandboxConfigDir(userData, root, actor)), "runtime", actor);
}
