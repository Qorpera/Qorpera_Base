#!/usr/bin/env node
/* Private app links: the relay (deploy/sites/APP-PREVIEW.md, section 3). Node 24, no dependencies.
 *
 * An agent shares one port of a company's always-on machine as https://<slug>-preview.qorpera.com/, behind the site's
 * password. The machine runs the link program (client.mjs), which dials out to this relay over a WebSocket and serves
 * each request the relay hands it from 127.0.0.1:<port>. Visitors reach the relay through Cloudflare, the dbhome
 * tunnel and api-front's `apps` virtual host (envoy-front-sites.yaml), which sets x-forwarded-host to the request's
 * own name. The relay never reaches a node or a VM; it holds no company data. The database decides every answer
 * through four RPCs (service role only): qorpera_site_app_connect, qorpera_site_app_session, qorpera_site_unlock.
 *
 * On an app host:
 *  - /.qorpera/connect   the link program's WebSocket (Authorization: Bearer <claim or key>). The relay always
 *                        completes the handshake and refuses with close code 4001, because a WebSocket client sees no
 *                        HTTP status; a newer program for the same link closes the older one with 4002.
 *  - /.qorpera/client.mjs the link program itself, no password.
 *  - /.qorpera/unlock    the password form (POST password, next).
 *  - /.qorpera/health    (on any host, none needed) the container's healthcheck.
 *  - anything else       the gate (cookie __Host-qorpera_app, checked with the database, an open answer kept 30 s),
 *                        then the app through its link program: 503 when none runs, 504 when no response head comes
 *                        in 60 s, 502 when the app does not answer, 413 over 10 MiB, 501 for a visitor's WebSocket.
 *
 * Messages on the program's WebSocket (binary frames): one byte type, a 4-byte stream id (big endian), the payload.
 *   1 request head  relay -> program  JSON {method, path, headers: [[name, value], ...]}
 *   2 body chunk    either way        bytes (at most 64 KiB)
 *   3 body end      either way        empty
 *   4 response head program -> relay  JSON {status, headers: [[name, value], ...]}
 *   5 reset         either way        empty: the stream is over, nothing more of it is sent
 *   6 hello         relay -> program  JSON {key, url} on stream 0, once connected (key null when the program used it)
 *   7 keepalive     either way        empty, stream 0: the relay sends one every 25 s and the program answers; either
 *                                     side drops a connection silent for 60 s
 *
 * Never logged: a claim, a key, a session token, a password or a cookie. */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, STATUS_CODES } from "node:http";
import { pathToFileURL } from "node:url";

export const DEFAULT_HOST_SUFFIX = "-preview.qorpera.com";
export const GATE_COOKIE = "__Host-qorpera_app";
/** The largest request body the relay passes to an app. */
export const MAX_BODY_BYTES = 10 * 1024 * 1024;
/** The password form's body: a password and a path, far below this. */
export const MAX_UNLOCK_BODY_BYTES = 4096;
/** The largest WebSocket frame, and message, the relay takes from a link program. */
export const MAX_FRAME_BYTES = 1024 * 1024;
/** The largest body chunk one message carries. */
export const CHUNK_BYTES = 64 * 1024;
export const RESPONSE_TIMEOUT_MS = 60_000;
export const SESSION_CACHE_MS = 30_000;
export const KEEPALIVE_MS = 25_000;
export const SILENT_MS = 60_000;
/** How often a connected program's key is checked again (a link turned off ends its program). */
export const RECHECK_MS = 5 * 60_000;
export const TYPE = Object.freeze({ head: 1, body: 2, end: 3, response: 4, reset: 5, hello: 6, keepalive: 7 });
export const CLOSE = Object.freeze({ refused: 4001, replaced: 4002 });

const SLUG = "[a-z0-9][a-z0-9-]{1,46}[a-z0-9]";
const TOKEN = /^[A-Za-z0-9_-]{32}$/;
/** A claim or a key as the database makes them (base64url or hex), and as a Bearer header carries them. */
const SECRET = /^[A-Za-z0-9._~+/-]{16,512}={0,2}$/;
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const HEADER_VALUE = /^[\t\x20-\x7e\x80-\xff]*$/;
const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const MAX_STREAMS = 256;
const MAX_SESSIONS_KEPT = 10_000;
const MAX_RPC_ANSWER_BYTES = 64 * 1024;
const RPC_TIMEOUT_MS = 20_000;
const MAX_PASSWORD = 1024;
const MAX_NEXT = 2048;
const EMPTY = Buffer.alloc(0);

/** Headers that belong to one connection, never passed on (RFC 9110 7.6.1), either way. */
const HOP_BY_HOP = new Set([
	"connection",
	"keep-alive",
	"proxy-connection",
	"transfer-encoding",
	"te",
	"trailer",
	"upgrade",
	"proxy-authenticate",
	"proxy-authorization",
	"http2-settings",
]);
/** A visitor's headers the relay sets itself (or never passes): the app's proxy headers come only from here. */
const VISITOR_DROPPED = new Set([
	"host",
	"expect",
	"forwarded",
	"x-forwarded-for",
	"x-forwarded-host",
	"x-forwarded-proto",
	"x-forwarded-port",
	"x-forwarded-prefix",
	"x-real-ip",
]);

/** What the platform's own pages are served with: no script, no framing, forms only to this origin. */
export const PAGE_SECURITY_POLICY =
	"default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";

// --- Hosts, cookies and headers ---------------------------------------------------------------------------------------

function escapeRegExp(text) {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The app host a request came in on: x-forwarded-host as api-front sets it (the request's own name), one value, a
 * slug and the suffix, letters in any case. Host never decides. Null for anything else. */
export function appHost(header, suffix = DEFAULT_HOST_SUFFIX) {
	if (typeof header !== "string") return null;
	const host = header.toLowerCase();
	const match = new RegExp(`^(${SLUG})${escapeRegExp(suffix)}$`).exec(host);
	return match ? { host, slug: match[1] } : null;
}

/** The session tokens a Cookie header's gate cookies hold (at most 3, each tried). */
export function gateTokens(header) {
	const tokens = [];
	for (const part of (header ?? "").split(";")) {
		const at = part.indexOf("=");
		if (at === -1) continue;
		const value = part.slice(at + 1).trim();
		if (part.slice(0, at).trim() === GATE_COOKIE && TOKEN.test(value) && !tokens.includes(value)) tokens.push(value);
	}
	return tokens.slice(0, 3);
}

/** A Cookie header without the gate cookie (any case of its name), or null when nothing is left. */
export function withoutGateCookie(header) {
	const kept = String(header)
		.split(";")
		.map((part) => part.trim())
		.filter((part) => part !== "" && part.split("=")[0].trim().toLowerCase() !== GATE_COOKIE.toLowerCase());
	return kept.length ? kept.join("; ") : null;
}

export function gateCookie(token, maxAge) {
	return `${GATE_COOKIE}=${token}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
}

export const CLEAR_GATE_COOKIE = `${GATE_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;

/** An app's Set-Cookie as the visitor gets it: host-only (every Domain attribute taken out), or null for one that
 * would set the gate cookie. */
export function appCookie(value) {
	const [first = "", ...attributes] = String(value).split(";");
	// A nameless cookie ("=v" or "v") whose value starts like the gate's is refused by browsers too.
	const pair = first.trim().replace(/^=\s*/, "").toLowerCase();
	const gate = GATE_COOKIE.toLowerCase();
	if (pair === gate || pair.startsWith(`${gate}=`) || pair.startsWith(`${gate} `)) return null;
	return [first, ...attributes.filter((attribute) => !/^\s*domain\s*(=|$)/i.test(attribute))].join(";");
}

/** The lowercase names a set of headers' Connection headers list: hop-by-hop for that hop. */
function connectionListed(pairs) {
	const listed = new Set();
	for (const [name, value] of pairs)
		if (name.toLowerCase() === "connection")
			for (const token of value.split(",")) if (token.trim()) listed.add(token.trim().toLowerCase());
	return listed;
}

/** rawHeaders (name, value, name, value, ...) as pairs. */
export function headerPairs(raw) {
	const pairs = [];
	for (let index = 0; index + 1 < raw.length; index += 2) pairs.push([raw[index], raw[index + 1]]);
	return pairs;
}

/** What the app gets: the visitor's headers without the hop-by-hop ones, Envoy's own, the proxy headers a visitor
 * could send and the gate cookie; then Host and X-Forwarded-Host (the app host), X-Forwarded-Proto https and
 * X-Forwarded-For (the visitor's CF-Connecting-IP only, when it holds one address). */
export function requestHeaders(raw, { host, client }) {
	const pairs = headerPairs(raw);
	const listed = connectionListed(pairs);
	const headers = [["host", host]];
	for (const [name, value] of pairs) {
		const lower = name.toLowerCase();
		if (HOP_BY_HOP.has(lower) || listed.has(lower) || VISITOR_DROPPED.has(lower) || lower.startsWith("x-envoy-"))
			continue;
		if (lower === "cookie") {
			const kept = withoutGateCookie(value);
			if (kept !== null) headers.push([name, kept]);
			continue;
		}
		headers.push([name, value]);
	}
	headers.push(["x-forwarded-proto", "https"], ["x-forwarded-host", host]);
	if (client) headers.push(["x-forwarded-for", client]);
	return headers;
}

/** What the visitor gets of an app's response headers: no hop-by-hop ones, every Set-Cookie host-only, none for the gate
 * cookie, and only names and values HTTP allows. Null when the list is not a list of [name, value] strings. */
export function responseHeaders(pairs) {
	if (!Array.isArray(pairs) || pairs.length > 500) return null;
	if (
		!pairs.every((pair) => Array.isArray(pair) && pair.length === 2 && pair.every((item) => typeof item === "string"))
	)
		return null;
	const listed = connectionListed(pairs);
	const headers = [];
	for (const [name, value] of pairs) {
		const lower = name.toLowerCase();
		if (!HEADER_NAME.test(name) || !HEADER_VALUE.test(value) || HOP_BY_HOP.has(lower) || listed.has(lower)) continue;
		if (lower === "set-cookie") {
			const cookie = appCookie(value);
			if (cookie !== null) headers.push([name, cookie]);
			continue;
		}
		headers.push([name, value]);
	}
	return headers;
}

/** The path the password form sends a visitor back to: a path on this host (never another host, never the platform's
 * own), else "/". */
export function safeNext(value) {
	if (typeof value !== "string" || value.length > MAX_NEXT || !/^\/(?![/\\])[\x21-\x7e]*$/.test(value)) return "/";
	if (value.includes("\\") || isPlatformPath(value.split("?")[0])) return "/";
	return value;
}

/** Whether a path's first segment is the platform's (/.qorpera/), however it is spelled. */
function isPlatformPath(path) {
	const first = path.split("/")[1] ?? "";
	let decoded = first;
	try {
		decoded = decodeURIComponent(first);
	} catch {
		// Kept as it came.
	}
	return decoded.toLowerCase() === ".qorpera";
}

const IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;

/** The visitor's address (as site-serve's): CF-Connecting-IP, which Cloudflare's edge sets, when it holds exactly one
 * IPv4 or IPv6 address (IPv6 canonical, an IPv4-mapped one as its IPv4); else "". Never X-Forwarded-For. */
export function clientAddress(header) {
	const value = String(header ?? "").trim();
	if (IPV4.test(value)) return value;
	if (!value.includes(":") || !/^[0-9A-Fa-f:.]{2,45}$/.test(value)) return "";
	let address;
	try {
		address = new URL(`http://[${value}]/`).hostname.slice(1, -1);
	} catch {
		return "";
	}
	const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(address);
	if (!mapped) return address;
	const high = Number.parseInt(mapped[1], 16);
	const low = Number.parseInt(mapped[2], 16);
	return [high >> 8, high & 255, low >> 8, low & 255].join(".");
}

// --- WebSocket (RFC 6455, the server's side) --------------------------------------------------------------------------

export class WebSocketError extends Error {
	constructor(code, message) {
		super(message);
		this.code = code;
	}
}

/** Sec-WebSocket-Accept for a handshake's headers, or null when they are no WebSocket version 13 handshake. */
export function acceptKey(headers) {
	const key = headers["sec-websocket-key"];
	const connection = String(headers.connection ?? "")
		.toLowerCase()
		.split(",")
		.map((token) => token.trim());
	if (
		String(headers.upgrade ?? "").toLowerCase() !== "websocket" ||
		!connection.includes("upgrade") ||
		headers["sec-websocket-version"] !== "13" ||
		typeof key !== "string" ||
		!/^[A-Za-z0-9+/]{21}[AQgw]==$/.test(key)
	)
		return null;
	return createHash("sha1")
		.update(key + WEBSOCKET_GUID)
		.digest("base64");
}

/** One frame: FIN set unless `fin` is false, masked with `mask` (4 bytes) when given (a client's frame). */
export function encodeFrame(opcode, payload = EMPTY, { mask = null, fin = true } = {}) {
	const length = payload.length;
	const extra = length < 126 ? 0 : length < 65536 ? 2 : 8;
	const head = Buffer.alloc(2 + extra + (mask ? 4 : 0));
	head[0] = (fin ? 0x80 : 0) | opcode;
	head[1] = (mask ? 0x80 : 0) | (extra === 0 ? length : extra === 2 ? 126 : 127);
	if (extra === 2) head.writeUInt16BE(length, 2);
	if (extra === 8) head.writeBigUInt64BE(BigInt(length), 2);
	if (!mask) return Buffer.concat([head, payload]);
	mask.copy(head, 2 + extra);
	const body = Buffer.from(payload);
	for (let index = 0; index < body.length; index++) body[index] ^= mask[index & 3];
	return Buffer.concat([head, body]);
}

/** The frame at the start of `buffer`: {fin, opcode, payload (unmasked), size (bytes it took)}, or null until all of
 * it has arrived. Throws a WebSocketError (with the close code) for a frame RFC 6455 refuses, a frame that is not
 * masked as `masked` says, or a payload over `maxPayload`. */
export function decodeFrame(buffer, { maxPayload = MAX_FRAME_BYTES, masked = true } = {}) {
	if (buffer.length < 2) return null;
	const fin = (buffer[0] & 0x80) !== 0;
	const opcode = buffer[0] & 0x0f;
	if (buffer[0] & 0x70) throw new WebSocketError(1002, "reserved bits set");
	if (![0x0, 0x1, 0x2, 0x8, 0x9, 0xa].includes(opcode)) throw new WebSocketError(1002, "unknown opcode");
	if (((buffer[1] & 0x80) !== 0) !== masked)
		throw new WebSocketError(1002, masked ? "unmasked frame" : "masked frame");
	let length = buffer[1] & 0x7f;
	let offset = 2;
	if (opcode >= 0x8 && (length > 125 || !fin)) throw new WebSocketError(1002, "invalid control frame");
	if (length === 126) {
		if (buffer.length < 4) return null;
		length = buffer.readUInt16BE(2);
		offset = 4;
	} else if (length === 127) {
		if (buffer.length < 10) return null;
		const declared = buffer.readBigUInt64BE(2);
		if (declared > BigInt(maxPayload)) throw new WebSocketError(1009, "frame too large");
		length = Number(declared);
		offset = 10;
	}
	if (length > maxPayload) throw new WebSocketError(1009, "frame too large");
	const maskAt = offset;
	if (masked) offset += 4;
	if (buffer.length < offset + length) return null;
	const payload = Buffer.from(buffer.subarray(offset, offset + length));
	if (masked) for (let index = 0; index < payload.length; index++) payload[index] ^= buffer[maskAt + (index & 3)];
	return { fin, opcode, payload, size: offset + length };
}

/** One message: the type, the stream id, the payload. */
export function encodeMessage(type, stream, payload = EMPTY) {
	const head = Buffer.alloc(5);
	head[0] = type;
	head.writeUInt32BE(stream, 1);
	return Buffer.concat([head, payload]);
}

export function decodeMessage(message) {
	if (message.length < 5) throw new Error("A message is at least 5 bytes");
	return { type: message[0], stream: message.readUInt32BE(1), payload: message.subarray(5) };
}

/** The server's side of one upgraded connection: binary messages in and out, pings answered, a close handshake. */
export class WebSocketConnection {
	#socket;
	#buffer = EMPTY;
	#fragments = null;
	#fragmentBytes = 0;
	#maxPayload;
	closing = false;
	closed = false;
	lastSeen = Date.now();
	onMessage = () => {};
	onClose = () => {};
	onDrain = () => {};

	constructor(socket, head, { maxPayload = MAX_FRAME_BYTES } = {}) {
		this.#socket = socket;
		this.#maxPayload = maxPayload;
		socket.setNoDelay(true);
		socket.setTimeout(0);
		socket.setKeepAlive(true, 30_000);
		socket.on("data", (chunk) => this.#read(chunk));
		socket.on("drain", () => this.onDrain());
		// http.Server's sockets stay half open after the peer's FIN: a program that went away is gone at once.
		socket.on("end", () => socket.end());
		socket.on("error", () => socket.destroy());
		socket.on("close", () => {
			if (this.closed) return;
			this.closed = true;
			this.onClose();
		});
		if (head?.length) this.#read(head);
	}

	#read(chunk) {
		this.lastSeen = Date.now();
		this.#buffer = this.#buffer.length ? Buffer.concat([this.#buffer, chunk]) : chunk;
		try {
			for (;;) {
				if (this.closed) return;
				const frame = decodeFrame(this.#buffer, { maxPayload: this.#maxPayload });
				if (!frame) return;
				this.#buffer = this.#buffer.subarray(frame.size);
				this.#frame(frame);
			}
		} catch (error) {
			this.#buffer = EMPTY;
			this.close(error instanceof WebSocketError ? error.code : 1011, "protocol error");
		}
	}

	#frame({ fin, opcode, payload }) {
		if (opcode === 0x8) {
			// The peer's close: answered with its code (when it sent one), then the TCP connection ends.
			if (!this.closing) {
				this.closing = true;
				this.#socket.write(encodeFrame(0x8, payload.length >= 2 ? payload.subarray(0, 2) : EMPTY));
			}
			this.#socket.end();
			return;
		}
		if (opcode === 0x9) {
			if (!this.closing) this.#socket.write(encodeFrame(0xa, payload));
			return;
		}
		if (opcode === 0xa || this.closing) return;
		if (opcode === 0x1) throw new WebSocketError(1003, "text messages are not used");
		if (opcode === 0x2) {
			if (this.#fragments) throw new WebSocketError(1002, "a new message inside a fragmented one");
			if (fin) return this.onMessage(payload);
			this.#fragments = [payload];
			this.#fragmentBytes = payload.length;
			return;
		}
		// A continuation.
		if (!this.#fragments) throw new WebSocketError(1002, "a continuation without a message");
		this.#fragmentBytes += payload.length;
		if (this.#fragmentBytes > this.#maxPayload) throw new WebSocketError(1009, "message too large");
		this.#fragments.push(payload);
		if (!fin) return;
		const message = Buffer.concat(this.#fragments);
		this.#fragments = null;
		this.onMessage(message);
	}

	/** Sends one binary message; false when the socket's buffer is full (onDrain follows). */
	send(message) {
		if (this.closing || this.closed) return true;
		return this.#socket.write(encodeFrame(0x2, message));
	}

	close(code = 1000, reason = "") {
		if (this.closing || this.closed) return;
		this.closing = true;
		const text = Buffer.from(reason).subarray(0, 123);
		const payload = Buffer.alloc(2 + text.length);
		payload.writeUInt16BE(code, 0);
		text.copy(payload, 2);
		this.#socket.write(encodeFrame(0x8, payload));
		// The peer answers with its close; a peer that does not is cut off.
		setTimeout(() => this.#socket.destroy(), 3000).unref();
	}

	terminate() {
		this.#socket.destroy();
	}

	pause() {
		this.#socket.pause();
	}

	resume() {
		this.lastSeen = Date.now();
		this.#socket.resume();
	}
}

// --- Database answers -------------------------------------------------------------------------------------------------

class InvalidAnswer extends Error {}

function invalid() {
	throw new InvalidAnswer("The database's answer is invalid");
}

function closed(value, keys) {
	if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
	if (Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) invalid();
	return value;
}

export function parseConnectAnswer(value) {
	if (value?.state === "refused") return closed(value, ["state"]) && { state: "refused" };
	if (value?.state !== "ok") invalid();
	const answer = closed(value, ["state", "key", "port"]);
	if (
		!(answer.key === null || (typeof answer.key === "string" && SECRET.test(answer.key))) ||
		!Number.isInteger(answer.port) ||
		answer.port < 1 ||
		answer.port > 65535
	)
		invalid();
	return { state: "ok", key: answer.key, port: answer.port };
}

export function parseSessionAnswer(value) {
	if (value?.state !== "open" && value?.state !== "locked") invalid();
	closed(value, ["state"]);
	return { state: value.state };
}

export function parseUnlockAnswer(value) {
	const state = value?.state;
	if (state === "wrong") return closed(value, ["state"]) && { state };
	if (state === "open") {
		const answer = closed(value, ["state", "token", "maxAge"]);
		if (
			typeof answer.token !== "string" ||
			!TOKEN.test(answer.token) ||
			!Number.isSafeInteger(answer.maxAge) ||
			answer.maxAge < 60 ||
			answer.maxAge > 400 * 24 * 3600
		)
			invalid();
		return { state, token: answer.token, maxAge: answer.maxAge };
	}
	if (state !== "limited") invalid();
	const answer = closed(value, ["state", "retryAfter"]);
	if (!Number.isSafeInteger(answer.retryAfter) || answer.retryAfter < 0) invalid();
	return { state, retryAfter: Math.max(1, answer.retryAfter) };
}

/** The headers a Supabase secret key travels in: a service role JWT is also the bearer (as site-serve's). */
export function serviceHeaders(secretKey) {
	return /^eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(secretKey)
		? { apikey: secretKey, authorization: `Bearer ${secretKey}` }
		: { apikey: secretKey };
}

// --- Pages ------------------------------------------------------------------------------------------------------------

/** Danish when the visitor's first preference between Danish and English is Danish (as site-serve's). */
export function language(header) {
	const tags = String(header ?? "")
		.split(",")
		.map((part, index) => {
			const [tag = "", ...parameters] = part.trim().toLowerCase().split(";");
			const q = parameters.map((item) => /^\s*q=([0-9.]+)\s*$/.exec(item)?.[1]).find(Boolean);
			return { tag: tag.trim(), q: q === undefined ? 1 : Number(q), index };
		})
		.filter((item) => Number.isFinite(item.q) && item.q > 0)
		.sort((a, b) => b.q - a.q || a.index - b.index);
	for (const { tag } of tags) {
		if (tag === "da" || tag.startsWith("da-")) return "da";
		if (tag === "en" || tag.startsWith("en-")) return "en";
	}
	return "en";
}

const TEXT = {
	en: {
		private: "Private site",
		lead: "This site is private. Enter the password you were given.",
		password: "Password",
		open: "Open",
		wrong: "That password is not right. Try again.",
		empty: "Enter the password.",
		limited: (minutes) => `Too many tries. Try again in ${minutes} ${minutes === 1 ? "minute" : "minutes"}.`,
		notFound: "Page not found",
		nothing: "There is no page at this address.",
		unavailable: "Not available",
		unavailableLead: "The site can't be shown right now. Try again in a moment.",
		refused: "This form can only be sent from the site's own password page.",
		notRunning: "This app is not running right now",
		notAnswering: "The app is not answering",
		notAnsweringLead: "It may be starting, or it has stopped. Try again in a moment.",
		slow: "The app did not answer in time",
		again: "Try again in a moment.",
		tooLarge: "Too large",
		tooLargeLead: "What was sent is too large for an app link.",
		live: "Not supported",
		liveLead: "Live connections (WebSocket) do not work on app links yet.",
		footer: "Shared with Qorpera",
	},
	da: {
		private: "Privat side",
		lead: "Siden er privat. Skriv den adgangskode, du har fået.",
		password: "Adgangskode",
		open: "Åbn",
		wrong: "Adgangskoden er forkert. Prøv igen.",
		empty: "Skriv adgangskoden.",
		limited: (minutes) => `For mange forsøg. Prøv igen om ${minutes} ${minutes === 1 ? "minut" : "minutter"}.`,
		notFound: "Siden blev ikke fundet",
		nothing: "Der er ingen side på denne adresse.",
		unavailable: "Ikke tilgængelig",
		unavailableLead: "Sitet kan ikke vises lige nu. Prøv igen om lidt.",
		refused: "Formularen kan kun sendes fra sitets egen adgangskodeside.",
		notRunning: "Appen kører ikke lige nu",
		notAnswering: "Appen svarer ikke",
		notAnsweringLead: "Den starter måske, eller den er stoppet. Prøv igen om lidt.",
		slow: "Appen svarede ikke i tide",
		again: "Prøv igen om lidt.",
		tooLarge: "For stort",
		tooLargeLead: "Det sendte er for stort til et app-link.",
		live: "Understøttes ikke",
		liveLead: "Live-forbindelser (WebSocket) virker ikke på app-links endnu.",
		footer: "Delt med Qorpera",
	},
};

export function escapeHtml(value) {
	return String(value).replace(
		/[&<>"']/g,
		(character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character],
	);
}

// site-serve's look, exactly.
const STYLE = `:root{color-scheme:light dark;--bg:#f6f5f2;--card:#fff;--text:#1d1c1a;--muted:#6b6862;--line:#dcd9d2;--accent:#1d1c1a;--accent-text:#fff;--error:#b3261e}
@media (prefers-color-scheme:dark){:root{--bg:#161615;--card:#20201e;--text:#edebe6;--muted:#a4a19a;--line:#3a3935;--accent:#edebe6;--accent-text:#161615;--error:#f2b8b5}}
*{box-sizing:border-box}html,body{margin:0;height:100%}
body{background:var(--bg);color:var(--text);font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:16px}
main{width:100%;max-width:380px;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:28px 24px}
h1{font-size:1.25rem;margin:0 0 8px}p{margin:0 0 16px;color:var(--muted)}
label{display:block;font-size:.875rem;font-weight:600;margin-bottom:6px}
input{width:100%;font:inherit;padding:10px 12px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--text)}
input:focus{outline:2px solid var(--accent);outline-offset:1px}
button,a.button{display:inline-block;margin-top:14px;width:100%;font:inherit;font-weight:600;padding:10px 12px;border:0;border-radius:8px;background:var(--accent);color:var(--accent-text);cursor:pointer;text-align:center;text-decoration:none}
.error{color:var(--error);margin:12px 0 0}footer{margin-top:16px;font-size:.75rem;color:var(--muted)}`;

function page(lang, title, body, referrer = "no-referrer") {
	return `<!doctype html>
<html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><meta name="referrer" content="${referrer}"><title>${escapeHtml(title)}</title><style>${STYLE}</style></head>
<body><main>${body}</main><footer>${escapeHtml(TEXT[lang].footer)}</footer></body></html>
`;
}

/** The password page: its referrer policy is same-origin, so the form's POST carries this host's origin. */
export function passwordPage(lang, next, error) {
	const text = TEXT[lang];
	return page(
		lang,
		text.private,
		`<h1>${escapeHtml(text.private)}</h1><p>${escapeHtml(text.lead)}</p>` +
			`<form method="post" action="/.qorpera/unlock"><input type="hidden" name="next" value="${escapeHtml(next)}">` +
			`<label for="password">${escapeHtml(text.password)}</label>` +
			`<input id="password" name="password" type="password" required maxlength="128" autocomplete="off" autofocus>` +
			`${error ? `<p class="error" role="alert">${escapeHtml(error)}</p>` : ""}` +
			`<button type="submit">${escapeHtml(text.open)}</button></form>`,
		"same-origin",
	);
}

export function messagePage(lang, title, lead) {
	return page(lang, title, `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(lead)}</p>`);
}

function pageHeaders(referrer = "no-referrer") {
	return {
		"content-security-policy": PAGE_SECURITY_POLICY,
		"x-frame-options": "DENY",
		"x-content-type-options": "nosniff",
		"x-robots-tag": "noindex, nofollow, noarchive",
		"referrer-policy": referrer,
		"cache-control": "no-store",
	};
}

function answer(req, res, status, html, extra = {}, referrer = "no-referrer") {
	if (res.headersSent) {
		res.destroy();
		return;
	}
	const body = Buffer.from(html);
	res.writeHead(status, {
		...pageHeaders(referrer),
		"content-type": "text/html; charset=utf-8",
		"content-length": String(body.length),
		...extra,
	});
	res.end(req.method === "HEAD" ? undefined : body);
}

/** An answer written on an upgrade's raw socket (no HTTP response object there), then the socket ends. */
function rawAnswer(socket, status, html) {
	const body = Buffer.from(html);
	const headers = { ...pageHeaders(), "content-type": "text/html; charset=utf-8", "content-length": body.length };
	socket.end(
		Buffer.concat([
			Buffer.from(
				`HTTP/1.1 ${status} ${STATUS_CODES[status]}\r\n${Object.entries(headers)
					.map(([name, value]) => `${name}: ${value}\r\n`)
					.join("")}connection: close\r\n\r\n`,
			),
			body,
		]),
	);
}

/** Reads a body up to `limit` bytes: null when it is longer (the rest is read and dropped) or cut off. */
function readBody(req, limit) {
	return new Promise((resolve) => {
		const declared = req.headers["content-length"];
		if (declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) > limit)) {
			req.resume();
			resolve(null);
			return;
		}
		const chunks = [];
		let total = 0;
		req.on("data", (chunk) => {
			total += chunk.length;
			if (total <= limit) chunks.push(chunk);
			else resolve(null);
		});
		req.on("end", () => resolve(total <= limit ? Buffer.concat(chunks) : null));
		req.on("close", () => resolve(null));
		req.on("error", () => resolve(null));
	});
}

async function readLimited(response, limit) {
	const declared = response.headers.get("content-length");
	if (declared !== null && Number(declared) > limit) {
		void response.body?.cancel().catch(() => undefined);
		throw new Error("The database's answer is too large");
	}
	const reader = response.body?.getReader();
	if (!reader) throw new Error("The database answered without a body");
	const chunks = [];
	let total = 0;
	try {
		for (;;) {
			const chunk = await reader.read();
			if (chunk.done) break;
			total += chunk.value.byteLength;
			if (total > limit) throw new Error("The database's answer is too large");
			chunks.push(chunk.value);
		}
	} finally {
		void reader.cancel().catch(() => undefined);
	}
	return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
}

// --- The relay --------------------------------------------------------------------------------------------------------

/** One connected link program: its WebSocket, its key (in memory only) and its open streams. */
class Program {
	constructor(slug, ws, key) {
		this.slug = slug;
		this.ws = ws;
		this.key = key;
		this.streams = new Map();
		this.next = 1;
		this.blocked = 0;
		this.waiting = new Set();
		this.keptAliveAt = Date.now();
		this.checkedAt = Date.now();
	}

	send(type, stream, payload = EMPTY) {
		return this.ws.send(encodeMessage(type, stream, payload));
	}

	/** A stream id no open stream holds: 1 up to 2^32 - 1, then round again. Stream 0 is the connection's own. */
	allocate() {
		let id = this.next;
		while (this.streams.has(id)) id = id >= 0xffffffff ? 1 : id + 1;
		this.next = id >= 0xffffffff ? 1 : id + 1;
		return id;
	}

	/** A visitor reads slower than the app writes: the program's socket is not read until every such visitor drains. */
	block() {
		if (this.blocked++ === 0) this.ws.pause();
	}

	unblock() {
		if (--this.blocked === 0) this.ws.resume();
	}
}

/** The relay as an http.Server (not listening yet). `fetch` reaches the database; the other options are for tests. */
export function createRelay({
	api,
	serviceKey,
	hostSuffix = DEFAULT_HOST_SUFFIX,
	fetch: fetcher = globalThis.fetch,
	responseTimeoutMs = RESPONSE_TIMEOUT_MS,
	sessionCacheMs = SESSION_CACHE_MS,
	maxBodyBytes = MAX_BODY_BYTES,
	keepaliveMs = KEEPALIVE_MS,
	silentMs = SILENT_MS,
	recheckMs = RECHECK_MS,
	clientSource,
	log = (line) => console.log(`app-relay: ${line}`),
} = {}) {
	const apiUrl = new URL(api);
	if (!["http:", "https:"].includes(apiUrl.protocol) || apiUrl.username || apiUrl.password)
		throw new Error("The API must be an http(s) URL without credentials");
	const base = apiUrl.href.replace(/\/+$/, "");
	if (typeof serviceKey !== "string" || serviceKey.length < 20) throw new Error("The service key is missing");
	if (!/^[-.][a-z0-9.-]*\.[a-z0-9-]+$/.test(hostSuffix)) throw new Error("The host suffix is invalid");
	const client = Buffer.from(clientSource ?? readFileSync(new URL("./client.mjs", import.meta.url)));
	/** slug -> Program: the one connected link program of each link. */
	const programs = new Map();
	/** "slug token" -> when an open answer stops counting. */
	const sessions = new Map();
	/** Upgraded sockets not yet a program's (the database is being asked). */
	const pending = new Set();

	function failure(error) {
		// The error's kind only: never a secret.
		log(`the database could not answer (${error instanceof Error ? error.name : typeof error})`);
	}

	async function rpc(name, args) {
		const response = await fetcher(`${base}/rest/v1/rpc/${name}`, {
			method: "POST",
			redirect: "error",
			headers: { ...serviceHeaders(serviceKey), "content-type": "application/json" },
			body: JSON.stringify(args),
			signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
		});
		if (!response.ok) {
			void response.body?.cancel().catch(() => undefined);
			throw new Error(`The database answered HTTP ${response.status}`);
		}
		return JSON.parse(await readLimited(response, MAX_RPC_ANSWER_BYTES));
	}

	async function sessionOpen(slug, token) {
		const id = `${slug} ${token}`;
		if ((sessions.get(id) ?? 0) > Date.now()) return true;
		sessions.delete(id);
		const { state } = parseSessionAnswer(await rpc("qorpera_site_app_session", { p_slug: slug, p_token: token }));
		if (state === "open") keep(id);
		return state === "open";
	}

	function keep(id) {
		if (sessions.size >= MAX_SESSIONS_KEPT) {
			const now = Date.now();
			for (const [key, until] of sessions) if (until <= now) sessions.delete(key);
			// Still full: the oldest go first.
			for (const key of sessions.keys()) {
				if (sessions.size < MAX_SESSIONS_KEPT) break;
				sessions.delete(key);
			}
		}
		sessions.set(id, Date.now() + sessionCacheMs);
	}

	async function handle(req, res) {
		const lang = language(req.headers["accept-language"]);
		try {
			await route(req, res, lang);
		} catch (error) {
			failure(error);
			const text = TEXT[lang];
			answer(req, res, 503, messagePage(lang, text.unavailable, text.unavailableLead), { "retry-after": "30" });
		}
	}

	async function route(req, res, lang) {
		const url = req.url ?? "";
		const path = url.split("?")[0];
		if (path === "/.qorpera/health") {
			res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
			res.end(req.method === "HEAD" ? undefined : "ok\n");
			return;
		}
		const text = TEXT[lang];
		const site = appHost(req.headers["x-forwarded-host"], hostSuffix);
		if (!site || !url.startsWith("/")) return answer(req, res, 404, messagePage(lang, text.notFound, text.nothing));
		if (isPlatformPath(path)) return platform(req, res, lang, site, path);

		// The gate.
		const tokens = gateTokens(req.headers.cookie);
		for (const token of tokens) if (await sessionOpen(site.slug, token)) return forward(req, res, lang, site);
		// A session that ended takes its cookie with it.
		return answer(
			req,
			res,
			401,
			passwordPage(lang, safeNext(url)),
			tokens.length ? { "set-cookie": CLEAR_GATE_COOKIE } : {},
			"same-origin",
		);
	}

	async function platform(req, res, lang, site, path) {
		const text = TEXT[lang];
		const method = req.method;
		if (path === "/.qorpera/client.mjs") {
			if (method !== "GET" && method !== "HEAD") {
				res.writeHead(405, { ...pageHeaders(), allow: "GET, HEAD" });
				return void res.end();
			}
			res.writeHead(200, {
				"content-type": "text/javascript; charset=utf-8",
				"content-length": String(client.length),
				"cache-control": "no-cache",
				"x-content-type-options": "nosniff",
				"x-robots-tag": "noindex, nofollow, noarchive",
			});
			return void res.end(method === "HEAD" ? undefined : client);
		}
		if (path === "/.qorpera/unlock") {
			if (method === "GET" || method === "HEAD") {
				res.writeHead(303, { ...pageHeaders(), location: "/" });
				return void res.end();
			}
			if (method !== "POST") {
				res.writeHead(405, { ...pageHeaders(), allow: "POST" });
				return void res.end();
			}
			return unlock(req, res, lang, site);
		}
		if (path === "/.qorpera/connect") {
			res.writeHead(426, { ...pageHeaders(), upgrade: "websocket", connection: "Upgrade" });
			return void res.end();
		}
		return answer(req, res, 404, messagePage(lang, text.notFound, text.nothing));
	}

	async function unlock(req, res, lang, site) {
		const text = TEXT[lang];
		const refused = (status) =>
			answer(req, res, status, messagePage(lang, text.private, text.refused), { connection: "close" });
		const origin = req.headers.origin;
		if (origin !== undefined && origin !== `https://${site.host}`) return refused(403);
		if (
			!String(req.headers["content-type"] ?? "")
				.toLowerCase()
				.startsWith("application/x-www-form-urlencoded")
		)
			return refused(415);
		const body = await readBody(req, MAX_UNLOCK_BODY_BYTES);
		if (!body) return refused(413);
		let form;
		try {
			form = new URLSearchParams(new TextDecoder("utf-8", { fatal: true }).decode(body));
		} catch {
			return refused(400);
		}
		const next = safeNext(form.get("next") ?? "/");
		const password = form.get("password") ?? "";
		const locked = (status, error, extra = {}) =>
			answer(req, res, status, passwordPage(lang, next, error), extra, "same-origin");
		if (!password || password.length > MAX_PASSWORD) return locked(401, text.empty);
		const result = parseUnlockAnswer(
			await rpc("qorpera_site_unlock", {
				p_slug: site.slug,
				p_password: password,
				p_client: clientAddress(req.headers["cf-connecting-ip"]),
			}),
		);
		if (result.state === "wrong") return locked(401, text.wrong);
		if (result.state === "limited")
			return locked(429, text.limited(Math.ceil(result.retryAfter / 60)), {
				"retry-after": String(result.retryAfter),
			});
		keep(`${site.slug} ${result.token}`);
		res.writeHead(303, { ...pageHeaders(), location: next, "set-cookie": gateCookie(result.token, result.maxAge) });
		res.end();
	}

	/** One request through the link's program: its head, its body as it comes, the response streamed back. */
	function forward(req, res, lang, site) {
		const text = TEXT[lang];
		const program = programs.get(site.slug);
		if (!program)
			return answer(req, res, 503, messagePage(lang, text.notRunning, text.again), { "retry-after": "10" });
		const declared = req.headers["content-length"];
		if (declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) > maxBodyBytes)) {
			req.resume();
			return answer(req, res, 413, messagePage(lang, text.tooLarge, text.tooLargeLead), { connection: "close" });
		}
		if (program.streams.size >= MAX_STREAMS)
			return answer(req, res, 503, messagePage(lang, text.unavailable, text.unavailableLead), {
				"retry-after": "5",
			});

		const id = program.allocate();
		let answered = false;
		let over = false;
		let blocked = false;
		let received = 0;
		const unblock = () => {
			if (!blocked) return;
			blocked = false;
			program.unblock();
		};
		const done = () => {
			over = true;
			clearTimeout(timer);
			program.streams.delete(id);
			program.waiting.delete(req);
			unblock();
		};
		/** The stream ends early: the program is told (unless it ended it), the visitor gets a page (or the connection
		 * ends, once a response has begun), and the rest of the request body is dropped. */
		const fail = (status, title, lead, { tellProgram = true } = {}) => {
			if (over) return;
			done();
			if (tellProgram && !program.ws.closed) program.send(TYPE.reset, id);
			req.resume();
			if (answered) res.destroy();
			else answer(req, res, status, messagePage(lang, title, lead), { connection: "close" });
		};
		const timer = setTimeout(() => fail(504, text.slow, text.again), responseTimeoutMs);
		program.streams.set(id, {
			response(payload) {
				if (answered) return fail(502, text.notAnswering, text.notAnsweringLead);
				let head;
				try {
					head = JSON.parse(payload.toString("utf8"));
				} catch {
					return fail(502, text.notAnswering, text.notAnsweringLead);
				}
				const headers = responseHeaders(head?.headers);
				const status = head?.status;
				if (!Number.isInteger(status) || status < 200 || status > 599 || !headers)
					return fail(502, text.notAnswering, text.notAnsweringLead);
				try {
					res.writeHead(status, headers.flat());
				} catch {
					return fail(502, text.notAnswering, text.notAnsweringLead);
				}
				answered = true;
				clearTimeout(timer);
				res.flushHeaders();
			},
			body(payload) {
				if (!answered) return fail(502, text.notAnswering, text.notAnsweringLead);
				if (!res.write(payload) && !blocked) {
					blocked = true;
					program.block();
				}
			},
			end() {
				if (!answered) return fail(502, text.notAnswering, text.notAnsweringLead);
				done();
				res.end();
			},
			reset() {
				fail(502, text.notAnswering, text.notAnsweringLead, { tellProgram: false });
			},
			gone() {
				fail(502, text.notAnswering, text.notAnsweringLead, { tellProgram: false });
			},
		});
		res.on("drain", unblock);
		// The visitor left: the program stops too.
		res.on("close", () => {
			if (over) return;
			done();
			if (!program.ws.closed) program.send(TYPE.reset, id);
		});
		program.send(
			TYPE.head,
			id,
			Buffer.from(
				JSON.stringify({
					method: req.method,
					path: req.url,
					headers: requestHeaders(req.rawHeaders, {
						host: site.host,
						client: clientAddress(req.headers["cf-connecting-ip"]),
					}),
				}),
			),
		);
		req.on("data", (chunk) => {
			if (over) return;
			received += chunk.length;
			if (received > maxBodyBytes) return fail(413, text.tooLarge, text.tooLargeLead);
			let room = true;
			for (let at = 0; at < chunk.length; at += CHUNK_BYTES)
				room = program.send(TYPE.body, id, chunk.subarray(at, at + CHUNK_BYTES));
			if (!room) {
				req.pause();
				program.waiting.add(req);
			}
		});
		req.on("end", () => {
			if (!over) program.send(TYPE.end, id);
		});
	}

	function programMessage(program, message) {
		let decoded;
		try {
			decoded = decodeMessage(message);
		} catch {
			program.ws.close(1002, "invalid message");
			return;
		}
		const { type, stream: id, payload } = decoded;
		if (type === TYPE.keepalive) return;
		if (![TYPE.response, TYPE.body, TYPE.end, TYPE.reset].includes(type)) {
			program.ws.close(1002, "invalid message");
			return;
		}
		// A stream that is over already (a timeout, a visitor who left): its late messages are dropped.
		const stream = program.streams.get(id);
		if (!stream) return;
		if (type === TYPE.response) stream.response(payload);
		else if (type === TYPE.body) stream.body(payload);
		else if (type === TYPE.end) stream.end();
		else stream.reset();
	}

	function register(site, ws, key, traded) {
		const old = programs.get(site.slug);
		const program = new Program(site.slug, ws, key);
		programs.set(site.slug, program);
		pending.delete(ws);
		ws.onMessage = (message) => programMessage(program, message);
		ws.onDrain = () => {
			for (const req of program.waiting) req.resume();
			program.waiting.clear();
		};
		ws.onClose = () => {
			if (programs.get(site.slug) === program) {
				programs.delete(site.slug);
				log(`${site.slug}: the link program is gone`);
			}
			for (const stream of [...program.streams.values()]) stream.gone();
		};
		if (old) {
			// Only the newest program serves a link; the older one's open requests end with it.
			old.ws.close(CLOSE.replaced, "replaced");
			for (const stream of [...old.streams.values()]) stream.gone();
		}
		program.send(TYPE.hello, 0, Buffer.from(JSON.stringify({ key: traded, url: `https://${site.host}/` })));
		log(`${site.slug}: a link program connected${old ? ", replacing the one before" : ""}`);
	}

	async function upgrade(req, socket, head) {
		socket.on("error", () => socket.destroy());
		const lang = language(req.headers["accept-language"]);
		const text = TEXT[lang];
		const site = appHost(req.headers["x-forwarded-host"], hostSuffix);
		if (!site) return rawAnswer(socket, 404, messagePage(lang, text.notFound, text.nothing));
		if ((req.url ?? "").split("?")[0] !== "/.qorpera/connect")
			return rawAnswer(socket, 501, messagePage(lang, text.live, text.liveLead));
		const accept = req.method === "GET" ? acceptKey(req.headers) : null;
		if (!accept) return rawAnswer(socket, 400, messagePage(lang, text.notFound, text.nothing));
		socket.write(
			`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
		);
		const ws = new WebSocketConnection(socket, head);
		pending.add(ws);
		ws.onClose = () => pending.delete(ws);
		const secret = /^Bearer (\S+)$/.exec(String(req.headers.authorization ?? ""))?.[1];
		if (!secret || !SECRET.test(secret)) return ws.close(CLOSE.refused, "refused");
		let result;
		try {
			result = parseConnectAnswer(await rpc("qorpera_site_app_connect", { p_slug: site.slug, p_secret: secret }));
		} catch (error) {
			failure(error);
			return ws.close(1013, "try again later");
		}
		if (result.state !== "ok") {
			log(`${site.slug}: a link program was refused`);
			return ws.close(CLOSE.refused, "refused");
		}
		if (ws.closing || ws.closed) return;
		register(site, ws, result.key ?? secret, result.key);
	}

	/** Keepalives out, silent programs dropped, every key checked again now and then. */
	function sweep() {
		const now = Date.now();
		for (const program of programs.values()) {
			if (program.blocked === 0 && now - program.ws.lastSeen > silentMs) {
				log(`${program.slug}: the link program went silent`);
				program.ws.terminate();
				continue;
			}
			if (now - program.keptAliveAt >= keepaliveMs) {
				program.keptAliveAt = now;
				program.send(TYPE.keepalive, 0);
			}
			if (recheckMs > 0 && now - program.checkedAt >= recheckMs) {
				program.checkedAt = now;
				rpc("qorpera_site_app_connect", { p_slug: program.slug, p_secret: program.key })
					.then((value) => {
						if (parseConnectAnswer(value).state === "refused" && programs.get(program.slug) === program) {
							log(`${program.slug}: the link program's key no longer holds`);
							program.ws.close(CLOSE.refused, "refused");
						}
					})
					.catch(failure);
			}
		}
		for (const [id, until] of sessions) if (until <= now) sessions.delete(id);
	}

	const server = createServer(handle);
	// Longer than api-front's idle time for its connections here (60 s, the app_relay cluster), so a request Envoy
	// sends on a kept connection never meets one this side has just closed.
	server.keepAliveTimeout = 75_000;
	server.headersTimeout = 80_000;
	server.on("upgrade", (req, socket, head) => {
		upgrade(req, socket, head).catch((error) => {
			failure(error);
			socket.destroy();
		});
	});
	const timer = setInterval(sweep, Math.max(50, Math.min(keepaliveMs, silentMs, recheckMs || 5000, 5000) / 2));
	timer.unref();
	const close = server.close.bind(server);
	server.close = (callback) => {
		clearInterval(timer);
		for (const program of programs.values()) program.ws.close(1001, "going away");
		for (const ws of pending) ws.close(1001, "going away");
		close(callback);
		server.closeAllConnections();
		return server;
	};
	/** Whether a link's program is connected, and dropping it (its socket closed at once): for operators and tests. */
	server.isConnected = (slug) => programs.has(slug);
	server.dropProgram = (slug) => programs.get(slug)?.ws.terminate();
	return server;
}

export function main(env = process.env) {
	const required = (name) => {
		const value = env[name]?.trim();
		if (!value) throw new Error(`${name} is not set`);
		return value;
	};
	const server = createRelay({
		api: required("QORPERA_API"),
		serviceKey: required("QORPERA_SERVICE_KEY"),
		hostSuffix: env.QORPERA_APP_HOST_SUFFIX?.trim() || DEFAULT_HOST_SUFFIX,
	});
	const port = Number(env.QORPERA_APP_RELAY_PORT ?? 8090);
	server.listen(port, "0.0.0.0", () => console.log(`app-relay: listening on :${port}`));
	for (const signal of ["SIGTERM", "SIGINT"])
		process.once(signal, () => {
			server.close(() => process.exit(0));
			setTimeout(() => process.exit(0), 5000).unref();
		});
	return server;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	try {
		main();
	} catch (error) {
		console.error(`app-relay: ${error instanceof Error ? error.message : "failed"}`);
		process.exit(1);
	}
}
