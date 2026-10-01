/** Folder protocol v1: what a machine's folder program and its node's folder service say to each other. The
 * machine side is `crates/qorpera-folder/src/proto.rs` and `frame.rs`; keep the two in step.
 *
 * A frame is a u32 big-endian length (of the type byte plus the payload), one type byte, then the payload. Control
 * messages carry JSON; a read reply carries the bytes as they are. */

import { isUuid } from "@qorpera/contracts";

export const PROTOCOL = 1;
export const MAX_PAYLOAD = 2 * 1024 * 1024;
export const MAX_READ = 1024 * 1024;
/** Entries per listing page. */
export const LIST_PAGE = 1000;

export const Kind = {
	/** From the node's bridge only, first on its socket: the machine's vsock CID. */
	bridge: 0x42, // B
	hello: 0x48, // H
	helloOk: 0x68, // h
	list: 0x4c, // L
	listing: 0x6c, // l
	read: 0x52, // R
	data: 0x64, // d
	change: 0x63, // c
	ack: 0x61, // a
	error: 0x65, // e
} as const;

export const ErrorCode = {
	notFound: "NOT_FOUND",
	notAFolder: "NOT_A_FOLDER",
	notAFile: "NOT_A_FILE",
	/** The version asked for is no longer one this view may read. */
	stale: "STALE",
	denied: "DENIED",
	badRequest: "BAD_REQUEST",
	/** The database or the storage server cannot answer now; the machine may ask again. */
	unavailable: "UNAVAILABLE",
	/** The view was closed, or its owner lost it: the folder program unmounts and exits. */
	viewClosed: "VIEW_CLOSED",
	/** The view, its pass or the calling machine did not match. */
	viewRefused: "VIEW_REFUSED",
} as const;
export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

export class ProtocolError extends Error {
	readonly code: ErrorCode;
	/** The peer broke the protocol itself: the connection ends after the error frame. */
	readonly fatal: boolean;
	constructor(code: ErrorCode, message: string, fatal = false) {
		super(message);
		this.name = "ProtocolError";
		this.code = code;
		this.fatal = fatal;
	}
}

export interface Frame {
	readonly kind: number;
	readonly payload: Buffer;
}

export function encodeFrame(kind: number, payload: Uint8Array): Buffer {
	if (payload.byteLength > MAX_PAYLOAD) throw new Error("Frame payload is too large");
	const head = Buffer.allocUnsafe(5);
	head.writeUInt32BE(payload.byteLength + 1, 0);
	head[4] = kind;
	return Buffer.concat([head, payload]);
}

export function encodeJson(kind: number, value: unknown): Buffer {
	return encodeFrame(kind, Buffer.from(JSON.stringify(value)));
}

/** Splits a byte stream into frames. A bad length is a protocol error: the connection is then closed. */
export class FrameReader {
	#buffer: Buffer = Buffer.alloc(0);

	push(data: Buffer): Frame[] {
		this.#buffer = this.#buffer.byteLength === 0 ? data : Buffer.concat([this.#buffer, data]);
		const frames: Frame[] = [];
		for (;;) {
			if (this.#buffer.byteLength < 5) break;
			const length = this.#buffer.readUInt32BE(0);
			if (length === 0 || length - 1 > MAX_PAYLOAD)
				throw new ProtocolError(ErrorCode.badRequest, "Bad frame length");
			if (this.#buffer.byteLength < 4 + length) break;
			frames.push({ kind: this.#buffer[4]!, payload: this.#buffer.subarray(5, 4 + length) });
			this.#buffer = this.#buffer.subarray(4 + length);
		}
		if (this.#buffer.byteLength === 0) this.#buffer = Buffer.alloc(0);
		return frames;
	}
}

export type Role = "io" | "feed";

export interface Hello {
	readonly protocol: number;
	readonly environmentId: string;
	readonly viewId: string;
	readonly pass: string;
	readonly role: Role;
}

export interface WireEntry {
	readonly name: string;
	readonly kind: "file" | "folder";
	readonly size: number;
	readonly mtimeMs: number;
	readonly executable: boolean;
	readonly version: number;
}

export interface ListRequest {
	readonly path: string;
	readonly after?: string;
}

export interface ReadRequest {
	readonly path: string;
	readonly version: number;
	readonly offset: number;
	readonly length: number;
}

/** A folder path: "" for the root, otherwise names joined by '/', none of them empty, "." or "..", none longer than
 * 255 bytes or holding a NUL. At most 4096 bytes in all. */
export function validPath(path: string): boolean {
	if (path === "") return true;
	return Buffer.byteLength(path) <= 4096 && path.split("/").every(validName);
}

export function validName(name: string): boolean {
	return name !== "" && name !== "." && name !== ".." && Buffer.byteLength(name) <= 255 && !/[/\0]/.test(name);
}

function object(payload: Buffer): Record<string, unknown> {
	let value: unknown;
	try {
		value = JSON.parse(payload.toString("utf8"));
	} catch {
		throw new ProtocolError(ErrorCode.badRequest, "Payload is not JSON");
	}
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new ProtocolError(ErrorCode.badRequest, "Payload is not an object");
	return value as Record<string, unknown>;
}

function exactKeys(
	value: Record<string, unknown>,
	required: readonly string[],
	optional: readonly string[] = [],
): void {
	for (const key of Object.keys(value))
		if (!required.includes(key) && !optional.includes(key))
			throw new ProtocolError(ErrorCode.badRequest, `Unknown field ${key}`);
	for (const key of required)
		if (!(key in value)) throw new ProtocolError(ErrorCode.badRequest, `Missing field ${key}`);
}

function count(value: unknown, max: number): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > max)
		throw new ProtocolError(ErrorCode.badRequest, "Bad number");
	return value;
}

export function parseBridge(payload: Buffer): number {
	const value = object(payload);
	exactKeys(value, ["cid"]);
	const cid = count(value.cid, 0xffff_ffff);
	if (cid < 3) throw new ProtocolError(ErrorCode.badRequest, "Bad CID");
	return cid;
}

export function parseHello(payload: Buffer): Hello {
	const value = object(payload);
	exactKeys(value, ["protocol", "environmentId", "viewId", "pass", "role"]);
	if (value.protocol !== PROTOCOL) throw new ProtocolError(ErrorCode.viewRefused, "Unsupported folder protocol");
	if (typeof value.environmentId !== "string" || !isUuid(value.environmentId))
		throw new ProtocolError(ErrorCode.viewRefused, "Bad environment id");
	const printable = (v: unknown): v is string =>
		typeof v === "string" && v.length > 0 && v.length <= 256 && /^[\x21-\x7e]+$/.test(v);
	if (!printable(value.viewId) || !printable(value.pass))
		throw new ProtocolError(ErrorCode.viewRefused, "Bad view id or pass");
	if (value.role !== "io" && value.role !== "feed") throw new ProtocolError(ErrorCode.badRequest, "Bad role");
	return {
		protocol: PROTOCOL,
		environmentId: value.environmentId,
		viewId: value.viewId,
		pass: value.pass,
		role: value.role,
	};
}

export function parseList(payload: Buffer): ListRequest {
	const value = object(payload);
	exactKeys(value, ["path"], ["after"]);
	if (typeof value.path !== "string" || !validPath(value.path))
		throw new ProtocolError(ErrorCode.badRequest, "Bad path");
	if (value.after !== undefined && (typeof value.after !== "string" || !validName(value.after)))
		throw new ProtocolError(ErrorCode.badRequest, "Bad continuation");
	return value.after === undefined ? { path: value.path } : { path: value.path, after: value.after };
}

export function parseRead(payload: Buffer): ReadRequest {
	const value = object(payload);
	exactKeys(value, ["path", "version", "offset", "length"]);
	if (typeof value.path !== "string" || value.path === "" || !validPath(value.path))
		throw new ProtocolError(ErrorCode.badRequest, "Bad path");
	return {
		path: value.path,
		version: count(value.version, Number.MAX_SAFE_INTEGER),
		offset: count(value.offset, Number.MAX_SAFE_INTEGER),
		length: count(value.length, MAX_READ),
	};
}

export function parseAck(payload: Buffer): number {
	const value = object(payload);
	exactKeys(value, ["seq"]);
	return count(value.seq, Number.MAX_SAFE_INTEGER);
}
