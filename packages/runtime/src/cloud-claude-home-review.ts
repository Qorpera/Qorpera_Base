import { createHash, randomUUID } from "node:crypto";
import { posix } from "node:path";
import type { JsonValue } from "@qorpera/contracts";
import { withAbortScopes } from "./abort-scope.ts";
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
export const CLAUDE_REPEAT_ELSEWHERE =
	"If it is approved, it is the agent's to do in its own thread: say in your report exactly what you would have done and where, so it can. Nothing else of this run's work is picked up again.";
export const CLAUDE_FILE_UNREADABLE =
	"REVIEW_UNAVAILABLE: This file change could not be read whole for its safety review, so it did not happen. Make it smaller, or in parts.";
export const CLAUDE_FILE_UNACCOUNTED =
	"REVIEW_UNAVAILABLE: This change to the machine's files came from no file tool call that was reviewed, so it did not happen.";
export const CLAUDE_REVIEW_FAILED =
	"REVIEW_UNAVAILABLE: The safety review of this action could not run, so it did not happen. You may try the identical action once more; if it fails again, say so in your report.";

const SNAPSHOT = /^source \/slot\/config\/shell-snapshots\/snapshot-[a-z]{1,16}-\d{1,20}-[a-z0-9]{1,32}\.sh /;
const CWD_FILE = / < \/dev\/null && pwd -P >\| \/tmp\/claude-[0-9a-f]{1,16}-cwd$/;
const BARE = /^[A-Za-z0-9_/.,:@%+=-]$/;
const RIPGREP_ARGUMENT = /^'((?:[^']|'\\'')*)'(?: |$)/;
const CALL_ID = /^[A-Za-z0-9_:.-]{1,160}$/;

const digestOf = (text: string | Uint8Array): string => createHash("sha256").update(text).digest("hex");

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
	const found = body.startsWith("eval ") ? 0 : body.indexOf(" && eval ");
	if (found < 0 || (found > 0 && !SNAPSHOT.test(body))) return { command: invocation, shape };
	const at = found === 0 ? 0 : found + 4;
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
	const action = finishAction({
		tool: "home_command",
		machine,
		summary: command,
		identity: {
			run: bounded(command, IDENTITY_TEXT_BYTES),
			cwd: request.cwd,
			shellSha256: digestOf(shape),
		},
		callId,
		step: { tool: "claude_code_bash", arguments: { command, workdir: request.cwd }, paths: [] },
		repeat: CLAUDE_REPEAT_COMMAND,
	});
	return { ...action, repeatElsewhere: CLAUDE_REPEAT_ELSEWHERE };
}

export interface ClaudeFileCall {
	readonly id: string;
	readonly tool: ClaudeReviewedFileTool;
	readonly path: string;
	readonly input: Readonly<Record<string, unknown>>;
}

export function cloudClaudeFileCall(hookText: string, realPath?: string): ClaudeFileCall | undefined {
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
		path:
			realPath !== undefined && posix.isAbsolute(realPath) && !realPath.includes("\0")
				? posix.normalize(realPath)
				: posix.resolve(cwd, named),
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
		identity = { data: { bytes: Buffer.byteLength(content), sha256: digestOf(content) } };
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
	const action = finishAction({
		tool: "home_change",
		machine,
		summary: `Change 1 file: ${folderPath(call.path) ?? call.path}`,
		identity: { tool: call.tool, ...where, ...identity },
		...(contents === undefined ? {} : { contents }),
		callId: call.id,
		step: { tool: `claude_code_${call.tool.toLowerCase()}`, arguments: { ...where }, paths: [call.path] },
		repeat: CLAUDE_REPEAT_CHANGE,
	});
	return { ...action, repeatElsewhere: CLAUDE_REPEAT_ELSEWHERE };
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
const CLAUDE_CODE_CWD_FILE = /^\/tmp\/claude-[0-9a-f]{1,16}-cwd$/;

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

const MAX_QUEUED_BYTES = 4 * 1024 * 1024;
const MAX_QUEUED_PACKETS = 512;

class PacketFrames {
	#chunks: Buffer[] = [];
	#chunkHead = 0;
	#headOffset = 0;
	#buffered = 0;
	broken = false;

	#peekLength(): number {
		const first = this.#chunks[this.#chunkHead] as Buffer;
		if (first.length - this.#headOffset >= 4) return first.readUInt32BE(this.#headOffset);
		const header = Buffer.allocUnsafe(4);
		let copied = 0;
		let index = this.#chunkHead;
		let offset = this.#headOffset;
		while (copied < 4) {
			const chunk = this.#chunks[index] as Buffer;
			const take = Math.min(4 - copied, chunk.length - offset);
			chunk.copy(header, copied, offset, offset + take);
			copied += take;
			index += 1;
			offset = 0;
		}
		return header.readUInt32BE(0);
	}

	#take(total: number): Buffer {
		const first = this.#chunks[this.#chunkHead] as Buffer;
		const avail = first.length - this.#headOffset;
		this.#buffered -= total;
		if (avail >= total) {
			let packet: Buffer;
			if (this.#headOffset === 0 && avail === total) {
				packet = first;
				this.#chunkHead += 1;
			} else {
				packet = Buffer.allocUnsafe(total);
				first.copy(packet, 0, this.#headOffset, this.#headOffset + total);
				this.#headOffset += total;
				if (this.#headOffset === first.length) {
					this.#chunkHead += 1;
					this.#headOffset = 0;
				}
			}
			this.#compact();
			return packet;
		}
		const packet = Buffer.allocUnsafe(total);
		let copied = 0;
		while (copied < total) {
			const chunk = this.#chunks[this.#chunkHead] as Buffer;
			const take = Math.min(total - copied, chunk.length - this.#headOffset);
			chunk.copy(packet, copied, this.#headOffset, this.#headOffset + take);
			copied += take;
			this.#headOffset += take;
			if (this.#headOffset === chunk.length) {
				this.#chunkHead += 1;
				this.#headOffset = 0;
			}
		}
		this.#compact();
		return packet;
	}

	#compact(): void {
		if (this.#chunkHead === this.#chunks.length) {
			this.#chunks.length = 0;
			this.#chunkHead = 0;
			this.#headOffset = 0;
		} else if (this.#chunkHead >= 32 && this.#chunkHead * 2 >= this.#chunks.length) {
			this.#chunks = this.#chunks.slice(this.#chunkHead);
			this.#chunkHead = 0;
		}
	}

	push(chunk: Buffer): Buffer[] {
		if (this.broken || chunk.length === 0) return [];
		this.#chunks.push(chunk);
		this.#buffered += chunk.length;
		const packets: Buffer[] = [];
		while (this.#buffered >= 4) {
			const length = this.#peekLength();
			if (length < 1 || length > MAX_PACKET) {
				this.broken = true;
				this.#chunks.length = 0;
				this.#chunkHead = 0;
				this.#headOffset = 0;
				this.#buffered = 0;
				return packets;
			}
			if (this.#buffered < 4 + length) break;
			packets.push(this.#take(4 + length));
		}
		return packets;
	}
}

interface AdmittedCall {
	readonly path: string;
	readonly decision: Promise<string | undefined>;
	allowed?: boolean;
}

const REVIEWED_ALONE = new Set(["fs/remove", "fs/removeDirectory", "fs/createDirectory"]);

function belongsTo(change: ClaudeFileChange, file: string): boolean {
	return (
		change.paths.length > 0 &&
		change.paths.every(
			(path) =>
				path === file ||
				(path.startsWith(`${file}.tmp.`) && !path.slice(file.length + 5).includes("/")) ||
				(change.method === "fs/createDirectory" && file.startsWith(`${path}/`)),
		)
	);
}

export class CloudClaudeFilesGate {
	readonly #machine: CloudCodexHomeMachine;
	readonly #review: CloudCodexHomeReview;
	readonly #signal: AbortSignal;
	readonly #toHome: (bytes: Buffer) => void;
	readonly #toMount: (bytes: Buffer) => void;
	readonly #ownFolder?: string;
	readonly #fromMount = new PacketFrames();
	readonly #fromHome = new PacketFrames();
	#queue: Buffer[] = [];
	#queueHead = 0;
	#queuedBytes = 0;
	#spaceWaiters: (() => void)[] = [];
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
		ownFolder?: string;
	}) {
		this.#machine = options.machine;
		this.#review = options.review;
		this.#signal = options.signal;
		this.#toHome = options.toHome;
		this.#toMount = options.toMount;
		if (options.ownFolder) this.#ownFolder = posix.normalize(options.ownFolder);
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
			const gate = await withAbortScopes([this.#signal, signal], (both) => this.#review.check(action, both));
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

	#notifySpace(): void {
		if (this.#spaceWaiters.length === 0) return;
		const waiters = this.#spaceWaiters.splice(0);
		for (const wake of waiters) wake();
	}

	#hasSpace(): boolean {
		return this.#queuedBytes < MAX_QUEUED_BYTES && this.#queue.length - this.#queueHead < MAX_QUEUED_PACKETS;
	}

	waitForSpace(): Promise<void> {
		if (this.#hasSpace() || this.#signal.aborted || this.broken) return Promise.resolve();
		return new Promise<void>((resolve) => {
			let settled = false;
			const done = (): void => {
				if (settled) return;
				settled = true;
				this.#signal.removeEventListener("abort", done);
				const index = this.#spaceWaiters.indexOf(done);
				if (index >= 0) this.#spaceWaiters.splice(index, 1);
				resolve();
			};
			this.#spaceWaiters.push(done);
			this.#signal.addEventListener("abort", done, { once: true });
		});
	}

	fromMount(chunk: Buffer): void {
		for (const packet of this.#fromMount.push(chunk)) {
			this.#queue.push(packet);
			this.#queuedBytes += packet.length;
		}
		if (this.broken) this.#notifySpace();
		if (!this.#draining) void this.#drain();
	}

	async #drain(): Promise<void> {
		this.#draining = true;
		try {
			while (this.#queueHead < this.#queue.length) {
				const packet = this.#queue[this.#queueHead] as Buffer;
				this.#queueHead += 1;
				this.#queuedBytes -= packet.length;
				if (this.#queueHead === this.#queue.length) {
					this.#queue.length = 0;
					this.#queueHead = 0;
				} else if (this.#queueHead >= 64 && this.#queueHead * 2 >= this.#queue.length) {
					this.#queue = this.#queue.slice(this.#queueHead);
					this.#queueHead = 0;
				}
				if (this.#hasSpace()) this.#notifySpace();
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
			if (this.#hasSpace() || this.#signal.aborted || this.broken) this.#notifySpace();
		}
	}

	async #judge(change: ClaudeFileChange): Promise<string | undefined> {
		const own = this.#ownFolder;
		const ownFile =
			(change.method === "fs/remove" &&
				change.paths.length === 1 &&
				CLAUDE_CODE_CWD_FILE.test(change.paths[0] as string)) ||
			(own !== undefined &&
				change.paths.length > 0 &&
				change.paths.every((path) => path === own || path.startsWith(`${own}/`)));
		const calls = [...this.#calls.values()].reverse().filter((call) => belongsTo(change, call.path));
		if (ownFile && calls.length === 0) {
			this.counts.ownFiles += 1;
			return undefined;
		}
		for (const call of calls) if ((await call.decision) === undefined) return undefined;
		if (calls.length > 0) return (await (calls[0] as AdmittedCall).decision) ?? undefined;
		this.counts.lone += 1;
		this.onLone?.(change);
		if (change.paths.length === 0 || !REVIEWED_ALONE.has(change.method)) return CLAUDE_FILE_UNACCOUNTED;
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
