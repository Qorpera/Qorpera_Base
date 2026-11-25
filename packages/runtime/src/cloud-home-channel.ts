// The channel from a run's sealed slot to its home machine (lanes/agent-box-20261113, slice 1).
//
// `machine_run` is one request and one answer. Codex's own tools need a channel that stays open: its exec-server
// streams a command's output as it comes and takes stdin back (P1 measured 1,097 output notifications in one run).
// So this is the one streaming route of the coding executor's ingress: an HTTP upgrade on the same listener, with the
// same transport token and the same proof of the run's holder, and then plain JSON-RPC lines, one per line, both ways.
//
//   the run's host (cloud-codex-home.ts) --upgrade--> the executor's ingress --> `codex exec-server` on the machine
//
// Why an upgrade and not another POST: the ingress bounds a request at 15 s and 10 per socket, which a channel that
// lives as long as a turn cannot keep. An upgraded socket leaves that per-request machinery behind, and both ends of
// this one are ours, so it carries our own lines rather than WebSocket frames (the office viewer's gateway does the
// framing because a browser is its other end; here nothing needs it).
//
// The handshake is the first line ON the socket, never the URL or a header: a run's holder and its binding are not
// things to put in a request line that proxies and logs keep.

import { type CloudCodingCommandScope, type JsonValue, POSTGRES_UUID_PATTERN } from "@qorpera/contracts";
import type { CloudNativeToolBinding } from "./cloud-native-tool-authority.ts";

export const CLOUD_HOME_CHANNEL_PATH = "/v1/home-session";
export const CLOUD_HOME_CHANNEL_PROTOCOL = "qorpera-home-session/1";
export const CLOUD_CODING_CHANNEL_PROTOCOL = "qorpera-coding-session/1";
/** The handshake, and each line after it. A command's output chunk is far below this; a line over it ends the channel. */
export const CLOUD_HOME_CHANNEL_LINE_BYTES = 8 * 1024 * 1024;
/** How long the ingress waits for the handshake line after the upgrade. */
export const CLOUD_HOME_CHANNEL_HANDSHAKE_MS = 10_000;
/** The whole of opening a channel from the run's side: the connection, the upgrade and the handshake together. */
export const CLOUD_HOME_CHANNEL_OPEN_MS = 20_000;

/**
 * A line each end of an open channel sends the other every CLOUD_HOME_CHANNEL_KEEPALIVE_MS and drops when it reads
 * one: never a line of the exec-server's, never passed on to the machine or to Codex. The exec-server says nothing
 * while the model thinks or a command runs quietly, and a front (the node's nginx, home-lxd 14 Nov 2026) ends an
 * upgraded connection that is quiet for its read timeout, which would end the exec-server and what it runs. With a
 * line in each direction every 20 s, a front's ordinary timeout of a minute or more holds a quiet channel open, and a
 * channel whose other end is truly gone still ends.
 */
export const CLOUD_HOME_CHANNEL_KEEPALIVE = '{"qorpera":"keepalive"}';
export const CLOUD_HOME_CHANNEL_KEEPALIVE_MS = 20_000;

/** Sends the keep-alive line every `ms` while the socket can take it; the returned function stops it. */
export function cloudHomeChannelKeepAlive(
	socket: { readonly writable: boolean; write(line: string): unknown },
	ms: number,
): () => void {
	const timer = setInterval(() => {
		if (socket.writable) socket.write(`${CLOUD_HOME_CHANNEL_KEEPALIVE}\n`);
	}, ms);
	timer.unref();
	return () => clearInterval(timer);
}

/** The lines of a channel without the other end's keep-alive lines. */
export async function* cloudHomeChannelWithoutKeepAlive(lines: AsyncIterable<string>): AsyncGenerator<string> {
	for await (const line of lines) if (line !== CLOUD_HOME_CHANNEL_KEEPALIVE) yield line;
}

/**
 * What a channel carries (Claude Code on the home, slice C1). `exec`: `codex exec-server --listen stdio`, JSON-RPC lines
 * (Codex's own tools, and Claude Code's shell through its CLAUDE_CODE_SHELL_PREFIX bridge). `sftp`: OpenSSH's
 * `sftp-server`, whose byte stream travels as lines of standard base64 (cloudHomeSftpLines, cloudHomeSftpBytes), so
 * every hop of the channel (the ingress, a forwarding peer, the keep-alive) stays as it is for both. A handshake without
 * a kind is `exec`, so a run's host from before this kind existed is unchanged; the same session authorizes both.
 */
export const CLOUD_HOME_CHANNEL_KINDS = ["exec", "sftp"] as const;
export type CloudHomeChannelKind = (typeof CLOUD_HOME_CHANNEL_KINDS)[number];

/** The most of the SFTP stream one line carries, before base64 (1 MiB of text a line, far below the line bound). */
export const CLOUD_HOME_SFTP_PIECE_BYTES = 768 * 1024;
/** Standard base64 with its padding, checked with the length (a multiple of 4) and without a backtracking group. */
const BASE64_LINE = /^[A-Za-z0-9+/]+={0,2}$/;

/** An `sftp` channel's bytes as its lines: each chunk, in order, cut at CLOUD_HOME_SFTP_PIECE_BYTES, as base64. */
export async function* cloudHomeSftpLines(chunks: AsyncIterable<Buffer | Uint8Array>): AsyncGenerator<string> {
	for await (const chunk of chunks) {
		const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
		for (let at = 0; at < bytes.byteLength; at += CLOUD_HOME_SFTP_PIECE_BYTES)
			yield bytes.subarray(at, at + CLOUD_HOME_SFTP_PIECE_BYTES).toString("base64");
	}
}

/** One line of an `sftp` channel as its bytes. Anything but nonempty standard base64 (padded, no other character) is not
 * the stream, and ends the channel: Node's own decoder would skip what it cannot read and pass the rest on. */
export function cloudHomeSftpBytes(line: string): Buffer {
	if (line.length % 4 !== 0 || line.length > CLOUD_HOME_CHANNEL_LINE_BYTES || !BASE64_LINE.test(line))
		throw new Error("Home sftp line invalid");
	return Buffer.from(line, "base64");
}

/** The first line the run's host writes: whose channel this is, which machine it wants, and what the channel carries. */
export interface CloudHomeChannelHandshake {
	schema: typeof CLOUD_HOME_CHANNEL_PROTOCOL;
	binding: CloudNativeToolBinding;
	machineId: string;
	sessionId: string;
	/** Absent: `exec`. */
	kind?: CloudHomeChannelKind;
}

/** The ingress's one line back, before any byte of the machine's: the session, or why there is none. */
export type CloudHomeChannelReady =
	| { readonly ok: true; readonly sessionId: string; readonly machine: string }
	| { readonly ok: false; readonly reason: string };

/** What SQL answers the ingress for one session (`qorpera_authorize_home_session`), as the executor parses it. */
export interface CloudHomeSessionAuthorized {
	readonly state: "authorized";
	readonly sessionId: string;
	readonly machineId: string;
	readonly machine: string;
	readonly placementId: string;
	/** The machine's boot SQL authorized: the guest's own shell checks it again when it starts the exec-server. */
	readonly bootId: string;
	readonly executorOwner: string;
	readonly providerId: string;
}

/** Who asked for a channel, as the ingress passes it to `open`, so an executor that does not hold the machine can
 * forward the channel to the one that does (as a machine command is forwarded). */
export interface CloudHomeChannelRequest {
	readonly binding: CloudNativeToolBinding;
	/** The run's holder as its own ingress read it; a peer listener takes none (only executors hold its token). */
	readonly holder: string | undefined;
	/** What the channel carries, as the handshake named it (`exec` when it named none). */
	readonly kind: CloudHomeChannelKind;
}

export type CloudHomeSessionAnswer =
	| CloudHomeSessionAuthorized
	| { readonly state: "refused"; readonly reason: string };

/** A refusal's reason as it travels: one of SQL's or the ingress's own codes, never words, an address or an id. */
export const CLOUD_HOME_CHANNEL_REASON = /^[A-Z][A-Z_]{0,63}$/;

/**
 * The ingress said no, with its reason (the machine is not running, this boot is over, the home is busy with another
 * run's work). The run's host turns the reason into words the model can act on; a forwarding executor passes it on
 * to the run unchanged.
 */
export class CloudHomeChannelRefused extends Error {
	readonly reason: string;

	constructor(reason: string) {
		super(`cloud_home_channel_unavailable: ${reason}`);
		this.reason = reason;
	}
}

/** One side of the channel: the machine's, as the executor's host opens it, and the run's, as its host sees it. */
export interface CloudHomeChannelSide {
	write(line: string): void;
	lines: AsyncIterable<string>;
	close(): Promise<void>;
}

/**
 * Each complete line of a stream of bytes, in order, decoded as UTF-8 across chunk boundaries: a character split
 * between two reads must arrive whole, or a command, a path or a file's text would change on its way through this
 * host (review round 1, F9). One reader per connection, used by both ends of the channel.
 */
export async function* cloudHomeChannelLines(chunks: AsyncIterable<Buffer | Uint8Array>): AsyncGenerator<string> {
	let parts: Buffer[] = [];
	let lineBytes = 0;
	for await (const chunk of chunks) {
		const view = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
		let start = 0;
		while (start < view.byteLength) {
			const nl = view.indexOf(0x0a, start);
			if (nl < 0) {
				const tailLength = view.byteLength - start;
				if (lineBytes + tailLength > CLOUD_HOME_CHANNEL_LINE_BYTES) throw new Error("Home line too large");
				parts.push(Buffer.from(view.subarray(start)));
				lineBytes += tailLength;
				break;
			}
			const pieceLength = nl - start;
			if (lineBytes + pieceLength > CLOUD_HOME_CHANNEL_LINE_BYTES) throw new Error("Home line too large");
			if (parts.length === 0) {
				yield view.toString("utf8", start, nl);
			} else {
				if (pieceLength > 0) parts.push(view.subarray(start, nl));
				const line = Buffer.concat(parts, lineBytes + pieceLength).toString("utf8");
				parts = [];
				lineBytes = 0;
				yield line;
			}
			start = nl + 1;
		}
	}
}

export function cloudHomeChannelHandshake(input: {
	binding: CloudNativeToolBinding;
	machineId: string;
	sessionId: string;
	kind?: CloudHomeChannelKind;
}): string {
	if (
		!POSTGRES_UUID_PATTERN.test(input.machineId) ||
		!POSTGRES_UUID_PATTERN.test(input.sessionId) ||
		(input.kind !== undefined && !CLOUD_HOME_CHANNEL_KINDS.includes(input.kind))
	)
		throw new Error("Invalid home session identity");
	// An exec channel names no kind, so an executor from before the kind existed still takes it.
	return JSON.stringify({
		schema: CLOUD_HOME_CHANNEL_PROTOCOL,
		binding: input.binding,
		machineId: input.machineId,
		sessionId: input.sessionId,
		...(input.kind === "sftp" ? { kind: input.kind } : {}),
	} satisfies CloudHomeChannelHandshake);
}

/** The handshake as the ingress reads it, or undefined for anything else: nothing of it is trusted beyond its shape. */
export function parseCloudHomeChannelHandshake(line: string): CloudHomeChannelHandshake | undefined {
	let value: JsonValue;
	try {
		value = JSON.parse(line) as JsonValue;
	} catch {
		return undefined;
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const record = value as Record<string, unknown>;
	const keys = Object.keys(record).sort().join();
	if (
		(keys !== "binding,machineId,schema,sessionId" && keys !== "binding,kind,machineId,schema,sessionId") ||
		(record.kind !== undefined && !(CLOUD_HOME_CHANNEL_KINDS as readonly unknown[]).includes(record.kind)) ||
		record.schema !== CLOUD_HOME_CHANNEL_PROTOCOL ||
		typeof record.machineId !== "string" ||
		!POSTGRES_UUID_PATTERN.test(record.machineId) ||
		typeof record.sessionId !== "string" ||
		!POSTGRES_UUID_PATTERN.test(record.sessionId) ||
		!record.binding ||
		typeof record.binding !== "object" ||
		Array.isArray(record.binding)
	)
		return undefined;
	return {
		schema: CLOUD_HOME_CHANNEL_PROTOCOL,
		binding: record.binding as CloudNativeToolBinding,
		machineId: record.machineId,
		sessionId: record.sessionId,
		kind: (record.kind as CloudHomeChannelKind | undefined) ?? "exec",
	};
}

export interface CloudCodingChannelHandshake {
	schema: typeof CLOUD_CODING_CHANNEL_PROTOCOL;
	binding: CloudNativeToolBinding;
	scope: CloudCodingCommandScope;
	kind?: CloudHomeChannelKind;
}

export type CloudCodingChannelReady =
	| { readonly ok: true; readonly workerId: string; readonly vmId: string }
	| { readonly ok: false; readonly reason: string };

export interface CloudCodingChannelAuthorized {
	readonly state: "authorized";
	readonly workerId: string;
	readonly vmId: string;
	readonly requestId: string;
	readonly turn: number;
	readonly executorOwner: string;
	readonly providerId: string;
}

export type CloudCodingChannelAnswer =
	| CloudCodingChannelAuthorized
	| { readonly state: "refused"; readonly reason: string };

export interface CloudCodingChannelRequest {
	readonly binding: CloudNativeToolBinding;
	readonly scope: CloudCodingCommandScope;
	readonly holder: string | undefined;
	readonly kind: CloudHomeChannelKind;
}

function validCodingScope(value: unknown): value is CloudCodingCommandScope {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const scope = value as Record<string, unknown>;
	if (Object.keys(scope).sort().join() !== "requestId,turn,vmId,workerId") return false;
	return (
		typeof scope.workerId === "string" &&
		POSTGRES_UUID_PATTERN.test(scope.workerId) &&
		typeof scope.vmId === "string" &&
		POSTGRES_UUID_PATTERN.test(scope.vmId) &&
		typeof scope.requestId === "string" &&
		POSTGRES_UUID_PATTERN.test(scope.requestId) &&
		typeof scope.turn === "number" &&
		Number.isSafeInteger(scope.turn) &&
		scope.turn >= 1
	);
}

export function cloudCodingChannelHandshake(input: {
	binding: CloudNativeToolBinding;
	scope: CloudCodingCommandScope;
	kind?: CloudHomeChannelKind;
}): string {
	if (!validCodingScope(input.scope) || (input.kind !== undefined && !CLOUD_HOME_CHANNEL_KINDS.includes(input.kind)))
		throw new Error("Invalid coding channel identity");
	return JSON.stringify({
		schema: CLOUD_CODING_CHANNEL_PROTOCOL,
		binding: input.binding,
		scope: input.scope,
		...(input.kind === "sftp" ? { kind: input.kind } : {}),
	} satisfies CloudCodingChannelHandshake);
}

export function parseCloudCodingChannelHandshake(line: string): CloudCodingChannelHandshake | undefined {
	let value: JsonValue;
	try {
		value = JSON.parse(line) as JsonValue;
	} catch {
		return undefined;
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const record = value as Record<string, unknown>;
	const keys = Object.keys(record).sort().join();
	if (
		(keys !== "binding,schema,scope" && keys !== "binding,kind,schema,scope") ||
		(record.kind !== undefined && !(CLOUD_HOME_CHANNEL_KINDS as readonly unknown[]).includes(record.kind)) ||
		record.schema !== CLOUD_CODING_CHANNEL_PROTOCOL ||
		!validCodingScope(record.scope) ||
		!record.binding ||
		typeof record.binding !== "object" ||
		Array.isArray(record.binding)
	)
		return undefined;
	return {
		schema: CLOUD_CODING_CHANNEL_PROTOCOL,
		binding: record.binding as CloudNativeToolBinding,
		scope: record.scope,
		kind: (record.kind as CloudHomeChannelKind | undefined) ?? "exec",
	};
}
