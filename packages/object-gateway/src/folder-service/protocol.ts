/** Folder protocol v1: what a machine's folder program and its node's folder service say to each other. The
 * machine side is `crates/qorpera-folder/src/proto.rs` and `frame.rs`; keep the two in step.
 *
 * A frame is a u32 big-endian length (of the type byte plus the payload), one type byte, then the payload. Control
 * messages carry JSON; a read reply carries the bytes as they are. */

import { isUuid } from "@qorpera/contracts";
import type { CoreReceipt } from "./core.ts";

export const PROTOCOL = 1;
export const MAX_PAYLOAD = 2 * 1024 * 1024;
/** Before a machine's hello is accepted, frames (the bridge's and the hello) are small: an unfinished large frame
 * would otherwise hold memory for any machine on the node, with no pass. */
export const HELLO_MAX_PAYLOAD = 4 * 1024;
/** After it, a machine sends only requests and acknowledgements: a path of at most 4 KiB and a few numbers. */
export const REQUEST_MAX_PAYLOAD = 64 * 1024;
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
	/** A run's search over its own view, served here (F3 `company_search`), and its answer. */
	search: 0x53, // S
	found: 0x73, // s
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
	// Writes (protocol 2): what a program on the machine sees as EEXIST, ENOTEMPTY, EPERM, EFBIG and EROFS.
	exists: "EXISTS",
	notEmpty: "NOT_EMPTY",
	notPermitted: "NOT_PERMITTED",
	tooLarge: "TOO_LARGE",
	readOnly: "READ_ONLY",
	/** EXDEV: a published path cannot go where nothing is published (a trash folder); a file manager then deletes. */
	notHere: "NOT_HERE",
	/** EBUSY: the change needed what was pending published first, and that could not be done now. */
	busy: "BUSY",
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
	/** The largest payload accepted now. */
	limit: number;

	constructor(limit = MAX_PAYLOAD) {
		this.limit = limit;
	}

	push(data: Buffer): Frame[] {
		this.#buffer = this.#buffer.byteLength === 0 ? data : Buffer.concat([this.#buffer, data]);
		const frames: Frame[] = [];
		for (;;) {
			if (this.#buffer.byteLength < 5) break;
			const length = this.#buffer.readUInt32BE(0);
			if (length === 0 || length - 1 > this.limit) throw new ProtocolError(ErrorCode.badRequest, "Bad frame length");
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
	/** The core's version id of the path (a uuid), opaque to the machine. */
	readonly version: string;
	/** The core's read receipt, in an agent's view (a run box's), for the box's read log. */
	readonly authority?: CoreReceipt;
}

export interface ListRequest {
	readonly path: string;
	readonly after?: string;
}

export interface ReadRequest {
	readonly path: string;
	readonly version: string;
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

/** What the bridge says about the calling machine: its CID, and the instance LXD says has it now. */
export interface BridgeInfo {
	readonly cid: number;
	readonly lookup: "found" | "none" | "unavailable";
	readonly machine?: { readonly project: string; readonly name: string; readonly physicalId: string };
}

export function parseBridge(payload: Buffer): BridgeInfo {
	const value = object(payload);
	exactKeys(value, ["cid", "lookup"], ["machine"]);
	const cid = count(value.cid, 0xffff_ffff);
	if (cid < 3) throw new ProtocolError(ErrorCode.badRequest, "Bad CID");
	if (value.lookup !== "found" && value.lookup !== "none" && value.lookup !== "unavailable")
		throw new ProtocolError(ErrorCode.badRequest, "Bad lookup");
	if (value.lookup !== "found") {
		if (value.machine !== undefined) throw new ProtocolError(ErrorCode.badRequest, "A machine without a lookup");
		return { cid, lookup: value.lookup };
	}
	const m = value.machine as Record<string, unknown> | undefined;
	if (!m || typeof m !== "object") throw new ProtocolError(ErrorCode.badRequest, "A lookup without a machine");
	exactKeys(m, ["project", "name", "physicalId"]);
	const text = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 128;
	if (!text(m.project) || !text(m.name) || !text(m.physicalId))
		throw new ProtocolError(ErrorCode.badRequest, "Bad machine");
	return { cid, lookup: "found", machine: { project: m.project, name: m.name, physicalId: m.physicalId } };
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
	if (typeof value.version !== "string" || !/^[0-9a-f-]{1,64}$/.test(value.version))
		throw new ProtocolError(ErrorCode.badRequest, "Bad version");
	return {
		path: value.path,
		version: value.version,
		offset: count(value.offset, Number.MAX_SAFE_INTEGER),
		length: count(value.length, MAX_READ),
	};
}

/** Where a search goes on: the next path to look at, and inside a file, the byte and line its next line starts at
 * (in the version it was searched at; another version is searched from its start). */
export interface SearchCursor {
	readonly path: string;
	readonly version: string;
	readonly offset: number;
	readonly line: number;
}

export interface SearchRequest {
	/** Literal text: in the files' lines, or with `namesOnly` in the names of files and folders. */
	readonly query: string;
	/** The folder (or the one file) to search: "" for the whole view. */
	readonly path: string;
	/** Only paths matching it: `*` and `?` within a name, `**` across folders; without a '/', the name alone. */
	readonly glob: string | null;
	readonly namesOnly: boolean;
	readonly caseSensitive: boolean;
	readonly after: SearchCursor | null;
}

export const MAX_SEARCH_QUERY = 256;

export function parseSearch(payload: Buffer): SearchRequest {
	const value = object(payload);
	exactKeys(value, ["query", "path", "glob", "namesOnly", "caseSensitive", "after"]);
	const text = (v: unknown): v is string =>
		typeof v === "string" && v.length > 0 && v.length <= MAX_SEARCH_QUERY && !/[\u0000-\u001f\u007f]/.test(v);
	if (!text(value.query)) throw new ProtocolError(ErrorCode.badRequest, "Bad query");
	if (typeof value.path !== "string" || !validPath(value.path))
		throw new ProtocolError(ErrorCode.badRequest, "Bad path");
	if (value.glob !== null && !text(value.glob)) throw new ProtocolError(ErrorCode.badRequest, "Bad glob");
	if (typeof value.namesOnly !== "boolean" || typeof value.caseSensitive !== "boolean")
		throw new ProtocolError(ErrorCode.badRequest, "Bad flag");
	let after: SearchCursor | null = null;
	if (value.after !== null) {
		const a = value.after as Record<string, unknown>;
		if (!a || typeof a !== "object" || Array.isArray(a)) throw new ProtocolError(ErrorCode.badRequest, "Bad cursor");
		exactKeys(a, ["path", "version", "offset", "line"]);
		if (typeof a.path !== "string" || a.path === "" || !validPath(a.path))
			throw new ProtocolError(ErrorCode.badRequest, "Bad cursor");
		if (typeof a.version !== "string" || !/^[0-9a-f-]{0,64}$/.test(a.version))
			throw new ProtocolError(ErrorCode.badRequest, "Bad cursor");
		after = {
			path: a.path,
			version: a.version,
			offset: count(a.offset, Number.MAX_SAFE_INTEGER),
			line: count(a.line, Number.MAX_SAFE_INTEGER),
		};
	}
	return {
		query: value.query,
		path: value.path,
		glob: value.glob as string | null,
		namesOnly: value.namesOnly,
		caseSensitive: value.caseSensitive,
		after,
	};
}

export function parseAck(payload: Buffer): number {
	const value = object(payload);
	exactKeys(value, ["seq"]);
	return count(value.seq, Number.MAX_SAFE_INTEGER);
}
