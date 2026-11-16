import { createHash, randomUUID } from "node:crypto";
import { posix } from "node:path";
import type { JsonValue } from "@qorpera/contracts";
import {
	bounded,
	type CloudCodexHomeAction,
	type CloudCodexHomeMachine,
	type CloudCodexHomeReview,
	cloudHomeFileAction,
	finishAction,
	folderPath,
	IDENTITY_TEXT_BYTES,
	stepPath,
} from "./cloud-codex-home.ts";

export const CLAUDE_REVIEW_HOOK_PATH = "/opt/qorpera/review-hook";
export const CLAUDE_REVIEW_HOOK_TOOLS = Object.freeze(["Write", "Edit", "NotebookEdit"] as const);
export type ClaudeReviewedFileTool = (typeof CLAUDE_REVIEW_HOOK_TOOLS)[number];

export const CLAUDE_REPEAT_COMMAND =
	"When you are woken because it was approved, run that exact command again with your Bash tool, unchanged and in the same folder. Made unchanged, it runs without another review.";
export const CLAUDE_REPEAT_CHANGE =
	"When you are woken because it was approved, make that exact change again with the same file tool and the same input. Made unchanged, it is saved without another review.";
export const CLAUDE_REVIEW_FAILED =
	"REVIEW_UNAVAILABLE: The safety review of this action could not run, so it did not happen. You may try the identical action once more; if it fails again, say so in your report.";

const SNAPSHOT = /^source \/slot\/config\/shell-snapshots\/snapshot-[a-z]{1,16}-\d{1,20}-[a-z0-9]{1,32}\.sh /;
const CWD_FILE = / < \/dev\/null && pwd -P >\| \/tmp\/claude-[0-9a-f]{1,16}-cwd$/;
const BARE = /^[A-Za-z0-9_/.,:@%+=-]$/;
const RIPGREP_ARGUMENT = /^'((?:[^']|'\\'')*)'(?: |$)/;
const CALL_ID = /^[A-Za-z0-9_:.-]{1,160}$/;

const sha256 = (text: string | Uint8Array): string => createHash("sha256").update(text).digest("hex");

export function cloudClaudeShellWord(text: string): string | undefined {
	let out = "";
	let at = 0;
	while (at < text.length) {
		const char = text[at] as string;
		if (char === "'") {
			const end = text.indexOf("'", at + 1);
			if (end < 0) return undefined;
			out += text.slice(at + 1, end);
			at = end + 1;
		} else if (char === '"') {
			at += 1;
			while (at < text.length && text[at] !== '"') {
				const inner = text[at] as string;
				if (inner === "\\" && at + 1 < text.length && '$`"\\\n'.includes(text[at + 1] as string)) {
					out += text[at + 1];
					at += 2;
				} else if (inner === "$" || inner === "`") return undefined;
				else {
					out += inner;
					at += 1;
				}
			}
			if (at >= text.length) return undefined;
			at += 1;
		} else if (char === "\\") {
			if (at + 1 >= text.length) return undefined;
			out += text[at + 1];
			at += 2;
		} else if (BARE.test(char)) {
			out += char;
			at += 1;
		} else return undefined;
	}
	return out;
}

export function cloudClaudeInvocationCommand(invocation: string): { command: string; shape: string } {
	const shape = invocation
		.replace(SNAPSHOT, "source <snapshot> ")
		.replace(CWD_FILE, " < /dev/null && pwd -P >| <cwd>");
	const tail = CWD_FILE.exec(invocation);
	if (!tail) return { command: invocation, shape };
	const body = invocation.slice(0, tail.index);
	const at = body.startsWith("eval ") ? 0 : body.indexOf(" && eval ") + 4;
	if (at < 0 || (at > 0 && !SNAPSHOT.test(body))) return { command: invocation, shape };
	const command = cloudClaudeShellWord(body.slice(at + 5));
	return { command: command && command.length > 0 ? command : invocation, shape };
}

export function cloudClaudeSearchArguments(cmd: string): string[] | undefined {
	if (!cmd.startsWith("exec rg ")) return undefined;
	const args: string[] = [];
	let rest = cmd.slice(8);
	while (rest.length > 0) {
		const match = RIPGREP_ARGUMENT.exec(rest);
		if (!match) return undefined;
		args.push((match[1] as string).replaceAll("'\\''", "'"));
		rest = rest.slice(match[0].length);
	}
	return args.some((arg) => /^--pre(?:[=-]|$)/.test(arg)) ? undefined : args;
}

export function cloudClaudeShellAction(
	machine: CloudCodexHomeMachine,
	request: { readonly cmd: string; readonly cwd: string },
	callId: string,
): CloudCodexHomeAction | undefined {
	if (cloudClaudeSearchArguments(request.cmd)) return undefined;
	const { command, shape } = cloudClaudeInvocationCommand(request.cmd);
	return finishAction({
		tool: "home_command",
		machine,
		summary: command,
		identity: {
			run: bounded(command, IDENTITY_TEXT_BYTES),
			cwd: request.cwd,
			shellSha256: sha256(shape),
		},
		callId,
		step: { tool: "claude_code_bash", arguments: { command, workdir: request.cwd }, paths: [] },
		repeat: CLAUDE_REPEAT_COMMAND,
	});
}

export interface ClaudeFileCall {
	readonly id: string;
	readonly tool: ClaudeReviewedFileTool;
	readonly path: string;
	readonly input: Readonly<Record<string, unknown>>;
}

export function cloudClaudeFileCall(hookText: string): ClaudeFileCall | undefined {
	let value: unknown;
	try {
		value = JSON.parse(hookText);
	} catch {
		return undefined;
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const hook = value as Record<string, unknown>;
	const tool = hook.tool_name;
	if (typeof tool !== "string" || !(CLAUDE_REVIEW_HOOK_TOOLS as readonly string[]).includes(tool)) return undefined;
	const input = hook.tool_input;
	if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
	const named = (input as Record<string, unknown>)[tool === "NotebookEdit" ? "notebook_path" : "file_path"];
	if (typeof named !== "string" || named.length === 0 || named.length > 4096 || named.includes("\0")) return undefined;
	const cwd = typeof hook.cwd === "string" && posix.isAbsolute(hook.cwd) ? hook.cwd : "/company";
	return {
		id: typeof hook.tool_use_id === "string" && CALL_ID.test(hook.tool_use_id) ? hook.tool_use_id : randomUUID(),
		tool: tool as ClaudeReviewedFileTool,
		path: posix.resolve(cwd, named),
		input: input as Record<string, unknown>,
	};
}

function text(value: unknown): string {
	return typeof value === "string" ? value : "";
}

export function cloudClaudeFileAction(machine: CloudCodexHomeMachine, call: ClaudeFileCall): CloudCodexHomeAction {
	const where = stepPath(call.path);
	const input = call.input;
	let identity: Record<string, JsonValue>;
	let contents: JsonValue | undefined;
	if (call.tool === "Write") {
		const content = text(input.content);
		identity = { data: { bytes: Buffer.byteLength(content), sha256: sha256(content) } };
		contents = bounded(content, IDENTITY_TEXT_BYTES);
	} else if (call.tool === "Edit")
		identity = {
			old: bounded(text(input.old_string), IDENTITY_TEXT_BYTES),
			new: bounded(text(input.new_string), IDENTITY_TEXT_BYTES),
			all: input.replace_all === true,
		};
	else
		identity = {
			cell: text(input.cell_id) || null,
			kind: text(input.cell_type) || null,
			mode: text(input.edit_mode) || "replace",
			source: bounded(text(input.new_source), IDENTITY_TEXT_BYTES),
		};
	return finishAction({
		tool: "home_change",
		machine,
		summary: `Change 1 file: ${folderPath(call.path) ?? call.path}`,
		identity: { tool: call.tool, ...where, ...identity },
		...(contents === undefined ? {} : { contents }),
		callId: call.id,
		step: { tool: `claude_code_${call.tool.toLowerCase()}`, arguments: { ...where }, paths: [call.path] },
		repeat: CLAUDE_REPEAT_CHANGE,
	});
}

const FXP = Object.freeze({
	INIT: 1,
	OPEN: 3,
	CLOSE: 4,
	SETSTAT: 9,
	FSETSTAT: 10,
	REMOVE: 13,
	MKDIR: 14,
	RMDIR: 15,
	RENAME: 18,
	SYMLINK: 20,
	STATUS: 101,
	HANDLE: 102,
	EXTENDED: 200,
});
const OPEN_CHANGES = 0x02 | 0x04 | 0x08 | 0x10;
const PERMISSION_DENIED = 3;
const MAX_PACKET = 1024 * 1024;
const MAX_REMEMBERED = 8_192;
const STATUS_WORDS = 1024;
const EXTENDED_READS = new Set([
	"statvfs@openssh.com",
	"fstatvfs@openssh.com",
	"limits@openssh.com",
	"expand-path@openssh.com",
	"home-directory",
	"users-groups-by-id@openssh.com",
	"fsync@openssh.com",
]);
const CLAUDE_CODE_OWN_FILES = /^\/tmp\/claude-[0-9a-f]{1,16}-cwd$/;

export interface ClaudeFileChange {
	readonly method: string;
	readonly paths: readonly string[];
}

function readString(packet: Buffer, at: number): { value: Buffer; next: number } | undefined {
	if (at + 4 > packet.length) return undefined;
	const length = packet.readUInt32BE(at);
	if (at + 4 + length > packet.length) return undefined;
	return { value: packet.subarray(at + 4, at + 4 + length), next: at + 4 + length };
}

function readPath(packet: Buffer, at: number): { path: string; next: number } | undefined {
	const read = readString(packet, at);
	if (!read) return undefined;
	const raw = read.value.toString("utf8");
	if (raw.includes("\0")) return undefined;
	return { path: posix.normalize(posix.isAbsolute(raw) ? raw : `/${raw}`), next: read.next };
}

function readPaths(packet: Buffer, at: number, count: number): string[] | undefined {
	const paths: string[] = [];
	let next = at;
	for (let index = 0; index < count; index++) {
		const read = readPath(packet, next);
		if (!read) return undefined;
		paths.push(read.path);
		next = read.next;
	}
	return paths;
}

export function cloudClaudeStatusPacket(id: number, words: string): Buffer {
	const message = Buffer.from(words.slice(0, STATUS_WORDS), "utf8");
	const body = Buffer.alloc(1 + 4 + 4 + 4 + message.length + 4);
	let at = 0;
	body.writeUInt8(FXP.STATUS, at);
	at += 1;
	body.writeUInt32BE(id, at);
	at += 4;
	body.writeUInt32BE(PERMISSION_DENIED, at);
	at += 4;
	body.writeUInt32BE(message.length, at);
	at += 4;
	message.copy(body, at);
	at += message.length;
	body.writeUInt32BE(0, at);
	const length = Buffer.alloc(4);
	length.writeUInt32BE(body.length, 0);
	return Buffer.concat([length, body]);
}

class PacketFrames {
	#pending: Buffer = Buffer.alloc(0);
	broken = false;

	push(chunk: Buffer): Buffer[] {
		if (this.broken) return [];
		this.#pending = this.#pending.length ? Buffer.concat([this.#pending, chunk]) : chunk;
		const packets: Buffer[] = [];
		while (this.#pending.length >= 4) {
			const length = this.#pending.readUInt32BE(0);
			if (length < 1 || length > MAX_PACKET) {
				this.broken = true;
				this.#pending = Buffer.alloc(0);
				return packets;
			}
			if (this.#pending.length < 4 + length) break;
			packets.push(this.#pending.subarray(0, 4 + length));
			this.#pending = this.#pending.subarray(4 + length);
		}
		return packets;
	}
}

interface AdmittedCall {
	readonly path: string;
	readonly decision: Promise<string | undefined>;
	allowed?: boolean;
}

function belongsTo(change: ClaudeFileChange, file: string): boolean {
	return change.paths.every(
		(path) =>
			path === file ||
			(path.startsWith(`${file}.tmp.`) && !path.slice(file.length + 5).includes("/")) ||
			(change.method === "fs/createDirectory" && file.startsWith(`${path}/`)),
	);
}

export class CloudClaudeFilesGate {
	readonly #machine: CloudCodexHomeMachine;
	readonly #review: CloudCodexHomeReview;
	readonly #signal: AbortSignal;
	readonly #toHome: (bytes: Buffer) => void;
	readonly #toMount: (bytes: Buffer) => void;
	readonly #fromMount = new PacketFrames();
	readonly #fromHome = new PacketFrames();
	readonly #queue: Buffer[] = [];
	readonly #calls = new Map<string, AdmittedCall>();
	readonly #opening = new Map<number, string>();
	readonly #handles = new Map<string, string>();
	#draining = false;
	#lone = 0;
	readonly counts = { packets: 0, changes: 0, calls: 0, declined: 0, lone: 0, ownFiles: 0, refused: 0 };
	onLone?: (change: ClaudeFileChange) => void;

	constructor(options: {
		machine: CloudCodexHomeMachine;
		review: CloudCodexHomeReview;
		signal: AbortSignal;
		toHome: (bytes: Buffer) => void;
		toMount: (bytes: Buffer) => void;
	}) {
		this.#machine = options.machine;
		this.#review = options.review;
		this.#signal = options.signal;
		this.#toHome = options.toHome;
		this.#toMount = options.toMount;
	}

	get broken(): boolean {
		return this.#fromMount.broken || this.#fromHome.broken;
	}

	admit(call: ClaudeFileCall, signal: AbortSignal): Promise<string | undefined> {
		const known = this.#calls.get(call.id);
		if (known) return known.decision;
		this.counts.calls += 1;
		const entry: AdmittedCall = {
			path: call.path,
			decision: this.#decide(cloudClaudeFileAction(this.#machine, call), signal).then((refusal) => {
				entry.allowed = refusal === undefined;
				if (refusal !== undefined) this.counts.declined += 1;
				return refusal;
			}),
		};
		this.#calls.set(call.id, entry);
		while (this.#calls.size > MAX_REMEMBERED) this.#calls.delete(this.#calls.keys().next().value as string);
		return entry.decision;
	}

	async #decide(action: CloudCodexHomeAction, signal: AbortSignal): Promise<string | undefined> {
		try {
			const gate = await this.#review.check(action, AbortSignal.any([this.#signal, signal]));
			return gate.run ? undefined : gate.text;
		} catch {
			return CLAUDE_REVIEW_FAILED;
		}
	}

	notice(line: string): void {
		if (!line.includes('"tool_result"')) return;
		let event: unknown;
		try {
			event = JSON.parse(line);
		} catch {
			return;
		}
		const message = (event as { type?: unknown; message?: { content?: unknown } } | null) ?? {};
		if (message.type !== "user" || !Array.isArray(message.message?.content)) return;
		for (const block of message.message.content as unknown[]) {
			const id = (block as { type?: unknown; tool_use_id?: unknown } | null)?.tool_use_id;
			if ((block as { type?: unknown }).type === "tool_result" && typeof id === "string") this.#calls.delete(id);
		}
	}

	fromHome(chunk: Buffer): void {
		for (const packet of this.#fromHome.push(chunk)) {
			if (packet.length >= 9 && packet.readUInt8(4) === FXP.HANDLE) {
				const id = packet.readUInt32BE(5);
				const path = this.#opening.get(id);
				const handle = readString(packet, 9);
				if (path !== undefined && handle) {
					this.#handles.set(handle.value.toString("base64"), path);
					while (this.#handles.size > MAX_REMEMBERED)
						this.#handles.delete(this.#handles.keys().next().value as string);
				}
			}
			const kind = packet.length >= 9 ? packet.readUInt8(4) : 0;
			if (kind === FXP.HANDLE || kind === FXP.STATUS) this.#opening.delete(packet.readUInt32BE(5));
			this.#toMount(packet);
		}
	}

	fromMount(chunk: Buffer): void {
		this.#queue.push(...this.#fromMount.push(chunk));
		if (!this.#draining) void this.#drain();
	}

	async #drain(): Promise<void> {
		this.#draining = true;
		try {
			for (let packet = this.#queue.shift(); packet; packet = this.#queue.shift()) {
				this.counts.packets += 1;
				const change = this.#change(packet);
				if (!change) {
					this.#toHome(packet);
					continue;
				}
				this.counts.changes += 1;
				const refusal = await this.#judge(change);
				if (this.#signal.aborted) return;
				if (refusal === undefined) this.#toHome(packet);
				else {
					this.counts.refused += 1;
					this.#toMount(cloudClaudeStatusPacket(packet.readUInt32BE(5), refusal));
				}
			}
		} finally {
			this.#draining = false;
		}
	}

	async #judge(change: ClaudeFileChange): Promise<string | undefined> {
		if (
			change.method === "fs/remove" &&
			change.paths.length === 1 &&
			CLAUDE_CODE_OWN_FILES.test(change.paths[0] as string)
		) {
			this.counts.ownFiles += 1;
			return undefined;
		}
		const calls = [...this.#calls.values()].reverse().filter((call) => belongsTo(change, call.path));
		for (const call of calls) if ((await call.decision) === undefined) return undefined;
		if (calls.length > 0) return (await (calls[0] as AdmittedCall).decision) ?? undefined;
		this.counts.lone += 1;
		this.onLone?.(change);
		const action = cloudHomeFileAction(
			this.#machine,
			change.method,
			{ path: change.paths[0], destinationPath: change.paths[1] },
			`claude-file:${++this.#lone}`,
		);
		return await this.#decide({ ...action, repeat: CLAUDE_REPEAT_CHANGE }, this.#signal);
	}

	#change(packet: Buffer): ClaudeFileChange | undefined {
		if (packet.length < 9) return undefined;
		const type = packet.readUInt8(4);
		if (type === FXP.INIT) return undefined;
		const id = packet.readUInt32BE(5);
		const one = (method: string): ClaudeFileChange => ({ method, paths: readPaths(packet, 9, 1) ?? [] });
		const two = (method: string, at = 9): ClaudeFileChange => ({ method, paths: readPaths(packet, at, 2) ?? [] });
		switch (type) {
			case FXP.OPEN: {
				const read = readPath(packet, 9);
				if (!read) return { method: "fs/writeFile", paths: [] };
				const flags = read.next + 4 <= packet.length ? packet.readUInt32BE(read.next) : OPEN_CHANGES;
				this.#opening.set(id, read.path);
				while (this.#opening.size > MAX_REMEMBERED)
					this.#opening.delete(this.#opening.keys().next().value as number);
				return flags & OPEN_CHANGES ? { method: "fs/writeFile", paths: [read.path] } : undefined;
			}
			case FXP.CLOSE: {
				const handle = readString(packet, 9);
				if (handle) this.#handles.delete(handle.value.toString("base64"));
				return undefined;
			}
			case FXP.SETSTAT:
				return one("fs/setAttributes");
			case FXP.FSETSTAT: {
				const handle = readString(packet, 9);
				const path = handle ? this.#handles.get(handle.value.toString("base64")) : undefined;
				return { method: "fs/setAttributes", paths: path === undefined ? [] : [path] };
			}
			case FXP.REMOVE:
				return one("fs/remove");
			case FXP.MKDIR:
				return one("fs/createDirectory");
			case FXP.RMDIR:
				return one("fs/removeDirectory");
			case FXP.RENAME:
				return two("fs/rename");
			case FXP.SYMLINK:
				return two("fs/symlink");
			case FXP.EXTENDED: {
				const name = readString(packet, 9);
				const extension = name ? name.value.toString("utf8") : "";
				if (EXTENDED_READS.has(extension)) return undefined;
				const at = name ? name.next : packet.length;
				if (extension === "posix-rename@openssh.com") return two("fs/rename", at);
				if (extension === "hardlink@openssh.com") return two("fs/hardlink", at);
				if (extension === "lsetstat@openssh.com")
					return { method: "fs/setAttributes", paths: readPaths(packet, at, 1) ?? [] };
				return { method: `fs/${extension.replace(/[^A-Za-z0-9@._-]/g, "").slice(0, 64) || "extended"}`, paths: [] };
			}
			default:
				return undefined;
		}
	}
}
