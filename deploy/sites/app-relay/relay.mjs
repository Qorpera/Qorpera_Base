#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, STATUS_CODES } from "node:http";
import { pathToFileURL } from "node:url";

export const DEFAULT_HOST_SUFFIX = "-preview.qorpera.com";
export const DEFAULT_WEB_ORIGINS = Object.freeze(["https://app.qorpera.com"]);
export const GATE_COOKIE = "__Host-qorpera_app";
export const SITE_HOST_COOKIE = "__Host-qorpera_site";
export const RELAY_ROLE = "qorpera_site_relay";
export const MAX_BODY_BYTES = 10 * 1024 * 1024;
export const MAX_CONFIGURABLE_BODY_BYTES = 100 * 1024 * 1024;
export const MAX_UNLOCK_BODY_BYTES = 4096;
export const MAX_FRAME_BYTES = 1024 * 1024;
export const MAX_QUEUED_BYTES = 8 * 1024 * 1024;
export const MAX_PROGRAM_BUFFERED_BYTES = 2 * 1024 * 1024;
export const MAX_TOTAL_BUFFERED_BYTES = 32 * 1024 * 1024;
export const MAX_PINGS_PER_SECOND = 10;
export const CHUNK_BYTES = 64 * 1024;
export const INITIAL_STREAM_WINDOW = 256 * 1024;
export const WINDOW_UPDATE_THRESHOLD = 64 * 1024;
export const FIRST_BYTE_TIMEOUT_MS = 60_000;
export const RESPONSE_TIMEOUT_MS = FIRST_BYTE_TIMEOUT_MS;
export const STREAM_IDLE_TIMEOUT_MS = 300_000;
export const SSE_KEEPALIVE_MS = 25_000;
export const GRACEFUL_SHUTDOWN_MS = 30_000;
export const SESSION_CACHE_MS = 30_000;
export const LOCKED_CACHE_MS = 5_000;
export const KEEPALIVE_MS = 25_000;
export const SILENT_MS = 60_000;
export const PAUSED_MS = 30_000;
export const RECHECK_MS = 5 * 60_000;
export const CONNECT_LIMIT = Object.freeze({ refusedPerMinute: 10, total: 512 });
export const PUBLIC_RATE_LIMIT_BURST = 300;
export const PUBLIC_RATE_LIMIT_PER_MINUTE = 600;
export const PUBLIC_MAX_CONCURRENT_PER_IP = 32;
export const MAX_WS_PER_SITE = 256;
export const MAX_WS_MESSAGE_BYTES = 1024 * 1024;
export const MAX_WS_QUEUED_BYTES = 2 * 1024 * 1024;
export const TYPE = Object.freeze({
	head: 1,
	body: 2,
	end: 3,
	response: 4,
	reset: 5,
	hello: 6,
	keepalive: 7,
	wsOpen: 8,
	wsOpenOk: 9,
	wsData: 10,
	wsClose: 11,
	window: 12,
	health: 13,
	swapTarget: 14,
});
export const CLOSE = Object.freeze({ refused: 4001, replaced: 4002, portChanged: 1012, tooManyPings: 1008 });

const SLUG = "[a-z0-9][a-z0-9-]{1,46}[a-z0-9]";
const CUSTOM_DOMAIN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const WEB_ORIGIN = /^https:\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)*(?::[0-9]{1,5})?$/;
const IPV4_HOST = /^[0-9.]+$/;
const TOKEN = /^[A-Za-z0-9_-]{32}$/;
const MEMBER_PASS = /^[A-Za-z0-9_-]{43}$/;
const AUTH_MODES = new Set(["password", "company_member", "public"]);
const GATE_COOKIE_NAMES = new Set([GATE_COOKIE.toLowerCase(), SITE_HOST_COOKIE.toLowerCase()]);
/** A claim or a key as the database makes them (base64url or hex), and as a Bearer header carries them. */
const SECRET = /^[A-Za-z0-9._~+/-]{16,512}={0,2}$/;
/** A link program's id: 32 random bytes in base64url, made once per process. */
const PROGRAM_ID = /^[A-Za-z0-9_-]{43}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const JWT = /^[A-Za-z0-9_-]+\.([A-Za-z0-9_-]+)\.[A-Za-z0-9_-]+$/;
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const HEADER_VALUE = /^[\t\x20-\x7e\x80-\xff]*$/;
const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const MAX_STREAMS = 256;
const MAX_SESSIONS_KEPT = 10_000;
const MAX_REFUSALS_KEPT = 10_000;
const SHARED_PAUSED_MS = 4_000;
const MAX_RPC_ANSWER_BYTES = 64 * 1024;
const RPC_TIMEOUT_MS = 20_000;
const MAX_PASSWORD = 1024;
const MAX_NEXT = 2048;
const MAX_VISITOR_UPGRADING = 512;
const MAX_WS_PROTOCOLS = 32;
const MAX_WS_PROTOCOL_LENGTH = 256;
const WS_HANDSHAKE_DROPPED = new Set([
	"content-length",
	"sec-websocket-key",
	"sec-websocket-version",
	"sec-websocket-extensions",
	"sec-websocket-accept",
]);
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
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
/** An app's caching headers: never passed on, the relay's own go in their place. */
const APP_CACHE_HEADERS = new Set([
	"cache-control",
	"expires",
	"cdn-cache-control",
	"cloudflare-cdn-cache-control",
	"surrogate-control",
]);
/** Every forwarded answer: the visitor's browser may keep it (and ask again each time), no shared cache may. */
export const FORWARDED_CACHE_HEADERS = Object.freeze([
	["cache-control", "private, no-cache"],
	["cdn-cache-control", "no-store"],
]);
/** An answer the app said must never be stored: the browser does not keep it either. */
export const NO_STORE_CACHE_HEADERS = Object.freeze([
	["cache-control", "private, no-store"],
	["cdn-cache-control", "no-store"],
]);

/** What the platform's own pages are served with: no script, no framing, forms only to this origin. */
export const PAGE_SECURITY_POLICY =
	"default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";

// --- Hosts, cookies and headers ---------------------------------------------------------------------------------------

function escapeRegExp(text) {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function appHost(header, suffix = DEFAULT_HOST_SUFFIX, customDomains = null) {
	if (typeof header !== "string") return null;
	const host = header.toLowerCase();
	const match = new RegExp(`^(${SLUG})${escapeRegExp(suffix)}$`).exec(host);
	if (match) return { host, slug: match[1] };
	if (customDomains && CUSTOM_DOMAIN.test(host) && !IPV4_HOST.test(host)) {
		if (customDomains instanceof Map && customDomains.has(host)) {
			return { host, slug: customDomains.get(host), customDomain: true };
		}
		if (customDomains instanceof Set && customDomains.has(host)) {
			return { host, slug: host, customDomain: true };
		}
	}
	return null;
}

export function customDomainHost(header) {
	if (typeof header !== "string") return null;
	const host = header.toLowerCase();
	if (host.length < 4 || host.length > 253 || IPV4_HOST.test(host) || !CUSTOM_DOMAIN.test(host)) return null;
	return host;
}

export function encodeWindow(bytes) {
	const buf = Buffer.allocUnsafe(4);
	buf.writeUInt32BE(Math.max(0, Math.min(0xffffffff, bytes >>> 0)), 0);
	return buf;
}

export function decodeWindow(payload) {
	if (!payload || payload.length !== 4) return 0;
	return payload.readUInt32BE(0);
}

export function parseWebOrigins(value) {
	if (Array.isArray(value)) {
		const valid = value.filter((item) => {
			if (typeof item !== "string" || !WEB_ORIGIN.test(item)) return false;
			try {
				return new URL(item).origin === item;
			} catch {
				return false;
			}
		});
		return valid.length > 0 ? [...new Set(valid)].slice(0, 8) : DEFAULT_WEB_ORIGINS;
	}
	let parsed;
	try {
		parsed = JSON.parse(value ?? "");
	} catch {
		return DEFAULT_WEB_ORIGINS;
	}
	return Array.isArray(parsed) ? parseWebOrigins(parsed) : DEFAULT_WEB_ORIGINS;
}

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

export function authTokens(header) {
	return gateTokens(header);
}

export function withoutGateCookie(header) {
	const kept = String(header)
		.split(";")
		.map((part) => part.trim())
		.filter((part) => part !== "" && !GATE_COOKIE_NAMES.has(part.split("=")[0].trim().toLowerCase()));
	return kept.length ? kept.join("; ") : null;
}

export function gateCookie(token, maxAge) {
	return `${GATE_COOKIE}=${token}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
}

export const CLEAR_GATE_COOKIE = `${GATE_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;

export function appCookie(value) {
	const [first = "", ...attributes] = String(value).split(";");
	const pair = first.trim().replace(/^=\s*/, "").toLowerCase();
	for (const gate of GATE_COOKIE_NAMES) {
		if (pair === gate || pair.startsWith(`${gate}=`) || pair.startsWith(`${gate} `)) return null;
	}
	return [first, ...attributes.filter((attribute) => !/^\s*domain\s*(=|$)/i.test(attribute))].join(";");
}

function connectionListed(pairs) {
	const listed = new Set();
	for (const [name, value] of pairs)
		if (name.toLowerCase() === "connection")
			for (const token of value.split(",")) if (token.trim()) listed.add(token.trim().toLowerCase());
	return listed;
}

export function headerPairs(raw) {
	const pairs = [];
	for (let index = 0; index + 1 < raw.length; index += 2) pairs.push([raw[index], raw[index + 1]]);
	return pairs;
}

export function requestHeaders(raw, { host, client, chunked = false, memberId = null }) {
	const pairs = headerPairs(raw);
	const listed = connectionListed(pairs);
	const headers = [["host", host]];
	for (const [name, value] of pairs) {
		const lower = name.toLowerCase();
		if (
			HOP_BY_HOP.has(lower) ||
			listed.has(lower) ||
			VISITOR_DROPPED.has(lower) ||
			lower.startsWith("x-envoy-") ||
			lower.startsWith("x-qorpera-")
		)
			continue;
		if (lower === "cookie") {
			const kept = withoutGateCookie(value);
			if (kept !== null) headers.push([name, kept]);
			continue;
		}
		headers.push([name, value]);
	}
	if (chunked) headers.push(["transfer-encoding", "chunked"]);
	headers.push(["x-forwarded-proto", "https"], ["x-forwarded-host", host]);
	if (client) headers.push(["x-forwarded-for", client]);
	if (memberId) headers.push(["x-qorpera-member-id", memberId]);
	return headers;
}

function parseSafeCacheControl(pairs, isPublic) {
	let sawHeader = false;
	let noStore = false;
	let noCache = false;
	let mustRevalidate = false;
	let immutable = false;
	let requestedPublic = false;
	let maxAge = null;
	let staleWhileRevalidate = null;
	for (const [name, value] of pairs) {
		if (name.toLowerCase() !== "cache-control") continue;
		sawHeader = true;
		for (const rawDirective of value.split(",")) {
			const directive = rawDirective.trim().toLowerCase();
			if (!directive) continue;
			if (directive === "no-store") noStore = true;
			else if (directive === "no-cache") noCache = true;
			else if (directive === "must-revalidate") mustRevalidate = true;
			else if (directive === "immutable") immutable = true;
			else if (directive === "public") requestedPublic = true;
			else {
				const maxAgeMatch = /^max-age=(\d{1,9})$/.exec(directive);
				if (maxAgeMatch) {
					const seconds = Math.min(31_536_000, Number(maxAgeMatch[1]));
					maxAge = maxAge === null ? seconds : Math.min(maxAge, seconds);
					continue;
				}
				const swrMatch = /^stale-while-revalidate=(\d{1,6})$/.exec(directive);
				if (swrMatch) {
					const seconds = Math.min(86_400, Number(swrMatch[1]));
					staleWhileRevalidate = staleWhileRevalidate === null ? seconds : Math.min(staleWhileRevalidate, seconds);
				}
			}
		}
	}
	if (noStore) {
		return [
			["cache-control", "private, no-store"],
			["cdn-cache-control", "no-store"],
		];
	}
	if (!sawHeader || (maxAge === null && !noCache && !mustRevalidate)) {
		return FORWARDED_CACHE_HEADERS.map((pair) => [...pair]);
	}
	if (noCache && maxAge === null) {
		return FORWARDED_CACHE_HEADERS.map((pair) => [...pair]);
	}
	const scope = isPublic && requestedPublic ? "public" : "private";
	const directives = [scope];
	if (maxAge !== null) directives.push(`max-age=${maxAge}`);
	if (mustRevalidate) directives.push("must-revalidate");
	if (immutable && maxAge !== null && maxAge > 0) directives.push("immutable");
	if (staleWhileRevalidate !== null) directives.push(`stale-while-revalidate=${staleWhileRevalidate}`);
	const out = [["cache-control", directives.join(", ")]];
	if (!isPublic || scope === "private") out.push(["cdn-cache-control", "no-store"]);
	return out;
}

export function isEventStreamHeaders(pairs) {
	return pairs.some(
		([name, value]) => name.toLowerCase() === "content-type" && /^\s*text\/event-stream(?:\s*;|$)/i.test(value),
	);
}

export function responseHeaders(pairs, { isPublic = false } = {}) {
	if (!Array.isArray(pairs) || pairs.length > 500) return null;
	if (
		!pairs.every((pair) => Array.isArray(pair) && pair.length === 2 && pair.every((item) => typeof item === "string"))
	)
		return null;
	const lengths = pairs.filter(([name]) => name.toLowerCase() === "content-length");
	if (lengths.length > 1 || lengths.some(([, value]) => !/^\d{1,15}$/.test(value))) return null;
	const isEventStream = isEventStreamHeaders(pairs);
	const listed = connectionListed(pairs);
	const headers = [];
	for (const [name, value] of pairs) {
		const lower = name.toLowerCase();
		if (
			!HEADER_NAME.test(name) ||
			!HEADER_VALUE.test(value) ||
			HOP_BY_HOP.has(lower) ||
			listed.has(lower) ||
			APP_CACHE_HEADERS.has(lower) ||
			(isEventStream && lower === "x-accel-buffering")
		)
			continue;
		if (lower === "set-cookie") {
			const cookie = appCookie(value);
			if (cookie !== null) headers.push([name, cookie]);
			continue;
		}
		headers.push([name, value]);
	}
	if (isEventStream) {
		headers.push(["cache-control", "no-cache, no-transform"], ["x-accel-buffering", "no"]);
		if (!isPublic) headers.push(["cdn-cache-control", "no-store"]);
		return headers;
	}
	headers.push(...parseSafeCacheControl(pairs, isPublic));
	return headers;
}

export function parseWsProtocols(raw) {
	const protocols = [];
	const seen = new Set();
	for (const [name, value] of headerPairs(raw)) {
		if (name.toLowerCase() !== "sec-websocket-protocol") continue;
		const parts = value.split(",");
		for (const part of parts) {
			const token = part.trim();
			if (
				!token ||
				token.length > MAX_WS_PROTOCOL_LENGTH ||
				!HEADER_NAME.test(token) ||
				seen.has(token) ||
				protocols.length >= MAX_WS_PROTOCOLS
			)
				return { ok: false, protocols: [] };
			seen.add(token);
			protocols.push(token);
		}
	}
	return { ok: true, protocols };
}

export function isValidVisitorWsOrigin(headers, host, raw, { allowAbsentOrigin = false } = {}) {
	const site = headers["sec-fetch-site"];
	if (site === "same-site" || site === "cross-site") return false;
	const expected = `https://${host}`;
	if (Array.isArray(raw)) {
		const origins = [];
		for (const [name, value] of headerPairs(raw)) {
			const lower = name.toLowerCase();
			if (lower === "sec-fetch-site" && (value === "same-site" || value === "cross-site")) return false;
			if (lower === "origin") origins.push(value);
		}
		if (origins.length === 0) return allowAbsentOrigin;
		return origins.length === 1 && origins[0] === expected;
	}
	if (headers.origin === undefined) return allowAbsentOrigin;
	return headers.origin === expected;
}

export function wsRequestHeaders(raw, { host, client, protocols = [], memberId = null }) {
	const pairs = headerPairs(raw);
	const listed = connectionListed(pairs);
	const headers = [["host", host]];
	for (const [name, value] of pairs) {
		const lower = name.toLowerCase();
		if (
			HOP_BY_HOP.has(lower) ||
			listed.has(lower) ||
			VISITOR_DROPPED.has(lower) ||
			WS_HANDSHAKE_DROPPED.has(lower) ||
			lower === "sec-websocket-protocol" ||
			lower.startsWith("x-envoy-") ||
			lower.startsWith("x-qorpera-")
		)
			continue;
		if (lower === "cookie") {
			const kept = withoutGateCookie(value);
			if (kept !== null) headers.push([name, kept]);
			continue;
		}
		headers.push([name, value]);
	}
	if (protocols.length > 0) headers.push(["sec-websocket-protocol", protocols.join(", ")]);
	headers.push(["x-forwarded-proto", "https"], ["x-forwarded-host", host]);
	if (client) headers.push(["x-forwarded-for", client]);
	if (memberId) headers.push(["x-qorpera-member-id", memberId]);
	return headers;
}

export function wsResponseHeaders(pairs) {
	if (!Array.isArray(pairs) || pairs.length > 100) return null;
	if (
		!pairs.every((pair) => Array.isArray(pair) && pair.length === 2 && pair.every((item) => typeof item === "string"))
	)
		return null;
	const listed = connectionListed(pairs);
	const headers = [];
	for (const [name, value] of pairs) {
		const lower = name.toLowerCase();
		if (
			!HEADER_NAME.test(name) ||
			!HEADER_VALUE.test(value) ||
			HOP_BY_HOP.has(lower) ||
			listed.has(lower) ||
			APP_CACHE_HEADERS.has(lower) ||
			WS_HANDSHAKE_DROPPED.has(lower) ||
			lower === "sec-websocket-protocol"
		)
			continue;
		if (lower === "set-cookie") {
			const cookie = appCookie(value);
			if (cookie !== null) headers.push([name, cookie]);
			continue;
		}
		headers.push([name, value]);
	}
	return headers;
}

/** Methods that change nothing by HTTP's rules: forwarded whoever sent them. */
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** Whether a request is a change sent from another site, which the relay refuses before anyone sees it: a method other
 * than GET, HEAD and OPTIONS whose Sec-Fetch-Site (set by the browser, never by a page) is same-site or cross-site, or
 * whose Origin is there and is not exactly https://<host>. An Origin of "null" is the browser hiding the origin under
 * the page's referrer policy (no-referrer, as helmet's default sets it), on a request to its own origin too: it passes
 * only when Sec-Fetch-Site says same-origin. A request with neither header passes (old browsers, other programs, which
 * carry no visitor's cookie by themselves). `host` is the app host, lower case. */
export function changeFromAnotherSite(method, headers, host) {
	if (SAFE_METHODS.has(method)) return false;
	const site = headers["sec-fetch-site"];
	if (site === "same-site" || site === "cross-site") return true;
	const origin = headers.origin;
	if (origin === undefined || origin === `https://${host}`) return false;
	return !(origin === "null" && site === "same-origin");
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

/** The group an address's refused connects are counted in: an IPv4 address itself, an IPv6 address's /64 (one host
 * holds a whole /64), "" for none. Takes clientAddress's canonical forms. */
export function addressGroup(address) {
	if (!address.includes(":")) return address;
	const [head, tail = ""] = address.split("::");
	const left = head ? head.split(":") : [];
	const right = address.includes("::") && tail ? tail.split(":") : [];
	const groups = address.includes("::")
		? [...left, ...Array(8 - left.length - right.length).fill("0"), ...right]
		: left;
	return `${groups
		.slice(0, 4)
		.map((group) => Number.parseInt(group, 16).toString(16))
		.join(":")}::/64`;
}

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

function unmaskInto(source, offset, length, maskAt, target) {
	source.copy(target, 0, offset, offset + length);
	const m0 = source[maskAt];
	const m1 = source[maskAt + 1];
	const m2 = source[maskAt + 2];
	const m3 = source[maskAt + 3];
	const mask32 = (m0 | (m1 << 8) | (m2 << 16) | (m3 << 24)) >>> 0;
	let index = 0;
	const end4 = length & ~3;
	for (; index < end4; index += 4) {
		target.writeUInt32LE((target.readUInt32LE(index) ^ mask32) >>> 0, index);
	}
	for (; index < length; index++) target[index] ^= source[maskAt + (index & 3)];
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
	const payload = Buffer.allocUnsafe(length);
	if (masked) unmaskInto(buffer, offset, length, maskAt, payload);
	else buffer.copy(payload, 0, offset, offset + length);
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

export function isValidCloseCode(code) {
	return (
		Number.isInteger(code) &&
		((code >= 1000 && code <= 1003) || (code >= 1007 && code <= 1014) || (code >= 3000 && code <= 4999))
	);
}

export function sanitizeCloseCode(code, fallback = 1000) {
	return isValidCloseCode(code) ? code : fallback;
}

export function truncateUtf8(text, maxBytes = 123) {
	const buf = Buffer.from(String(text ?? ""), "utf8");
	if (buf.length <= maxBytes) return buf;
	let end = maxBytes;
	while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
	return buf.subarray(0, end);
}

export function encodeWsClose(code = 1000, reason = "") {
	const safeCode = sanitizeCloseCode(code);
	const text = truncateUtf8(reason, 123);
	const payload = Buffer.allocUnsafe(2 + text.length);
	payload.writeUInt16BE(safeCode, 0);
	text.copy(payload, 2);
	return payload;
}

export function decodeWsClose(payload) {
	if (!payload || payload.length === 0) return { code: 1000, reason: "" };
	if (payload.length < 2) return { code: 1000, reason: "" };
	const code = sanitizeCloseCode(payload.readUInt16BE(0));
	let reason = "";
	try {
		reason = UTF8_DECODER.decode(payload.subarray(2));
	} catch {
		reason = "";
	}
	return { code, reason };
}

/** The server's side of one upgraded connection: binary messages in and out, pings answered (a few a second), a close
 * handshake. A peer that lets more than `maxQueued` bytes pile up unread is cut off. */
export class WebSocketConnection {
	#socket;
	#chunks = [];
	#buffered = 0;
	#fragments = null;
	#fragmentBytes = 0;
	#fragmentOpcode = 0;
	#maxPayload;
	#maxQueued;
	#pingsPerSecond;
	#allowText;
	#pings = 0;
	#pingSecond = 0;
	#closeTimer = null;
	closing = false;
	closed = false;
	lastSeen = Date.now();
	onMessage = () => {};
	onClose = () => {};
	onCloseFrame = () => {};
	onProtocolError = () => {};
	onDrain = () => {};

	constructor(
		socket,
		head,
		{
			maxPayload = MAX_FRAME_BYTES,
			maxQueued = MAX_QUEUED_BYTES,
			pingsPerSecond = MAX_PINGS_PER_SECOND,
			allowText = false,
		} = {},
	) {
		this.#socket = socket;
		this.#maxPayload = maxPayload;
		this.#maxQueued = maxQueued;
		this.#pingsPerSecond = pingsPerSecond;
		this.#allowText = allowText;
		socket.setNoDelay(true);
		socket.setTimeout(0);
		socket.setKeepAlive(true, 30_000);
		socket.on("data", (chunk) => this.#read(chunk));
		socket.on("drain", () => this.onDrain());
		// http.Server's sockets stay half open after the peer's FIN: a program that went away is gone at once.
		socket.on("end", () => socket.end());
		socket.on("error", () => socket.destroy());
		socket.on("close", () => {
			if (this.#closeTimer) {
				clearTimeout(this.#closeTimer);
				this.#closeTimer = null;
			}
			if (this.closed) return;
			this.closed = true;
			this.onClose();
		});
		if (head?.length) {
			// WHY: Defer pipelined head frames one microtask so register() binds onMessage/onClose before dispatch.
			this.#chunks.push(head);
			this.#buffered = head.length;
			queueMicrotask(() => {
				if (this.closed) return;
				this.#drain();
				if (!this.closed) socket.resume();
			});
		} else {
			socket.resume();
		}
	}

	get queuedBytes() {
		return this.#socket.writableLength;
	}

	get needsDrain() {
		return Boolean(this.#socket.writableNeedDrain);
	}

	/** Writes a frame unless the peer has let too much pile up: then the connection ends at once. */
	#write(frame) {
		if (this.#socket.destroyed) return false;
		if (this.#socket.writableLength + frame.length > this.#maxQueued) {
			this.terminate();
			return false;
		}
		return this.#socket.write(frame);
	}

	#peekHeaderBytes(count) {
		if (this.#chunks.length === 1) return this.#chunks[0];
		const out = Buffer.allocUnsafe(Math.min(count, this.#buffered));
		let copied = 0;
		for (const chunk of this.#chunks) {
			const take = Math.min(chunk.length, out.length - copied);
			chunk.copy(out, copied, 0, take);
			copied += take;
			if (copied >= out.length) break;
		}
		return out;
	}

	#nextFrameLength() {
		if (this.#buffered < 2) return null;
		const head = this.#peekHeaderBytes(14);
		const fin = (head[0] & 0x80) !== 0;
		const opcode = head[0] & 0x0f;
		if (head[0] & 0x70) throw new WebSocketError(1002, "reserved bits set");
		if (![0x0, 0x1, 0x2, 0x8, 0x9, 0xa].includes(opcode)) throw new WebSocketError(1002, "unknown opcode");
		if ((head[1] & 0x80) === 0) throw new WebSocketError(1002, "unmasked frame");
		let length = head[1] & 0x7f;
		let offset = 2;
		if (opcode >= 0x8 && (length > 125 || !fin)) throw new WebSocketError(1002, "invalid control frame");
		if (length === 126) {
			if (head.length < 4) return null;
			length = head.readUInt16BE(2);
			offset = 4;
		} else if (length === 127) {
			if (head.length < 10) return null;
			const declared = head.readBigUInt64BE(2);
			if (declared > BigInt(this.#maxPayload)) throw new WebSocketError(1009, "frame too large");
			length = Number(declared);
			offset = 10;
		}
		if (length > this.#maxPayload) throw new WebSocketError(1009, "frame too large");
		return offset + 4 + length;
	}

	#read(chunk) {
		if (chunk.length > 0) {
			this.#chunks.push(chunk);
			this.#buffered += chunk.length;
		}
		this.#drain();
	}

	#drain() {
		try {
			for (;;) {
				if (this.closed) return;
				const needed = this.#nextFrameLength();
				if (needed === null || this.#buffered < needed) return;
				const buffer = this.#chunks.length === 1 ? this.#chunks[0] : Buffer.concat(this.#chunks, this.#buffered);
				const frame = decodeFrame(buffer, { maxPayload: this.#maxPayload });
				if (!frame) return;
				const rest = buffer.subarray(frame.size);
				this.#chunks = rest.length > 0 ? [rest] : [];
				this.#buffered = rest.length;
				this.#frame(frame);
			}
		} catch (error) {
			this.#chunks = [];
			this.#buffered = 0;
			if (this.closing) {
				this.#socket.destroy();
				return;
			}
			const code = error instanceof WebSocketError ? error.code : 1011;
			const reason = error instanceof WebSocketError ? error.message : "protocol error";
			this.onProtocolError(code, reason);
			this.close(code, reason);
		}
	}

	#deliver(payload, opcode) {
		if (opcode === 0x1) {
			try {
				UTF8_DECODER.decode(payload);
			} catch {
				throw new WebSocketError(1007, "invalid utf-8");
			}
		}
		this.onMessage(payload, opcode);
	}

	#frame({ fin, opcode, payload }) {
		this.lastSeen = Date.now();
		if (opcode === 0x8) {
			// The peer's close: answered with its code (when it sent one), then the TCP connection ends.
			if (payload.length === 1) throw new WebSocketError(1002, "invalid close frame");
			let code = 1000;
			let reason = "";
			if (payload.length >= 2) {
				code = payload.readUInt16BE(0);
				if (!isValidCloseCode(code)) throw new WebSocketError(1002, "invalid close code");
				try {
					reason = UTF8_DECODER.decode(payload.subarray(2));
				} catch {
					throw new WebSocketError(1007, "invalid close reason");
				}
			}
			const peerInitiated = !this.closing;
			if (!this.closing) {
				this.closing = true;
				this.#write(encodeFrame(0x8, payload.length >= 2 ? payload.subarray(0, 2) : EMPTY));
			}
			if (peerInitiated) this.onCloseFrame(code, reason);
			this.#socket.end();
			return;
		}
		if (opcode === 0x9) {
			const second = Math.floor(Date.now() / 1000);
			if (second !== this.#pingSecond) {
				this.#pingSecond = second;
				this.#pings = 0;
			}
			if (++this.#pings > this.#pingsPerSecond) throw new WebSocketError(CLOSE.tooManyPings, "too many pings");
			if (!this.closing) this.#write(encodeFrame(0xa, payload));
			return;
		}
		if (opcode === 0xa || this.closing) return;
		if (opcode === 0x1) {
			if (!this.#allowText) throw new WebSocketError(1003, "text messages are not used");
			if (this.#fragments) throw new WebSocketError(1002, "a new message inside a fragmented one");
			if (fin) return this.#deliver(payload, 0x1);
			this.#fragments = [payload];
			this.#fragmentBytes = payload.length;
			this.#fragmentOpcode = 0x1;
			return;
		}
		if (opcode === 0x2) {
			if (this.#fragments) throw new WebSocketError(1002, "a new message inside a fragmented one");
			if (fin) return this.#deliver(payload, 0x2);
			this.#fragments = [payload];
			this.#fragmentBytes = payload.length;
			this.#fragmentOpcode = 0x2;
			return;
		}
		// A continuation.
		if (!this.#fragments) throw new WebSocketError(1002, "a continuation without a message");
		this.#fragmentBytes += payload.length;
		if (this.#fragmentBytes > this.#maxPayload) throw new WebSocketError(1009, "message too large");
		this.#fragments.push(payload);
		if (!fin) return;
		const message = Buffer.concat(this.#fragments);
		const messageOpcode = this.#fragmentOpcode;
		this.#fragments = null;
		this.#fragmentBytes = 0;
		this.#fragmentOpcode = 0;
		this.#deliver(message, messageOpcode);
	}

	/** Sends one binary message; false when the socket's buffer is full (onDrain follows). */
	send(message, opcode = 0x2) {
		if (this.closing || this.closed) return true;
		return this.#write(encodeFrame(opcode, message));
	}

	ping(payload = EMPTY) {
		if (this.closing || this.closed) return true;
		return this.#write(encodeFrame(0x9, payload));
	}

	close(code = 1000, reason = "") {
		if (this.closing || this.closed) return;
		this.closing = true;
		if (!this.#socket.destroyed) this.#socket.write(encodeFrame(0x8, encodeWsClose(code, reason)));
		this.#closeTimer = setTimeout(() => this.#socket.destroy(), 3000);
		this.#closeTimer.unref();
	}

	terminate() {
		this.#socket.destroy();
	}

	pause() {
		this.#socket.pause();
	}

	resume() {
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

function closedOptional(value, required, optional = []) {
	if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
	const allowed = new Set([...required, ...optional]);
	for (const key of required) if (!Object.hasOwn(value, key)) invalid();
	for (const key of Object.keys(value)) if (!allowed.has(key)) invalid();
	return value;
}

export function parseConnectAnswer(value) {
	if (value?.state === "refused") return closed(value, ["state"]) && { state: "refused" };
	if (value?.state !== "ok") invalid();
	const answer = closedOptional(value, ["state", "key", "port", "siteId"], ["authMode", "domains"]);
	if (
		!(answer.key === null || (typeof answer.key === "string" && SECRET.test(answer.key))) ||
		!Number.isInteger(answer.port) ||
		answer.port < 1 ||
		answer.port > 65535 ||
		typeof answer.siteId !== "string" ||
		!UUID.test(answer.siteId)
	)
		invalid();
	const parsed = { state: "ok", key: answer.key, port: answer.port, siteId: answer.siteId };
	if (Object.hasOwn(answer, "authMode")) {
		if (typeof answer.authMode !== "string" || !AUTH_MODES.has(answer.authMode)) invalid();
		parsed.authMode = answer.authMode;
	}
	if (Object.hasOwn(answer, "domains")) {
		if (
			!Array.isArray(answer.domains) ||
			answer.domains.length > 20 ||
			!answer.domains.every((item) => typeof item === "string" && customDomainHost(item) === item)
		)
			invalid();
		parsed.domains = answer.domains;
	}
	return parsed;
}

export function parseSessionAnswer(value) {
	if (value?.state === "locked") {
		const answer = closedOptional(value, ["state"], ["authMode", "slug"]);
		const parsed = { state: "locked" };
		if (Object.hasOwn(answer, "authMode")) {
			if (typeof answer.authMode !== "string" || !AUTH_MODES.has(answer.authMode)) invalid();
			parsed.authMode = answer.authMode;
		}
		if (Object.hasOwn(answer, "slug")) {
			if (typeof answer.slug !== "string" || !new RegExp(`^${SLUG}$`).test(answer.slug)) invalid();
			parsed.slug = answer.slug;
		}
		return parsed;
	}
	if (value?.state !== "open") invalid();
	const answer = closedOptional(value, ["state", "siteId"], ["authMode", "memberId", "slug"]);
	if (typeof answer.siteId !== "string" || !UUID.test(answer.siteId)) invalid();
	const parsed = { state: "open", siteId: answer.siteId };
	if (Object.hasOwn(answer, "authMode")) {
		if (typeof answer.authMode !== "string" || !AUTH_MODES.has(answer.authMode)) invalid();
		parsed.authMode = answer.authMode;
	}
	if (Object.hasOwn(answer, "memberId")) {
		if (typeof answer.memberId !== "string" || !UUID.test(answer.memberId)) invalid();
		parsed.memberId = answer.memberId;
	}
	if (Object.hasOwn(answer, "slug")) {
		if (typeof answer.slug !== "string" || !new RegExp(`^${SLUG}$`).test(answer.slug)) invalid();
		parsed.slug = answer.slug;
	}
	return parsed;
}

export function parseUnlockAnswer(value) {
	const state = value?.state;
	if (state === "wrong") return closed(value, ["state"]) && { state };
	if (state === "open") {
		const answer = closedOptional(value, ["state", "token", "maxAge"], ["memberId"]);
		if (
			typeof answer.token !== "string" ||
			!TOKEN.test(answer.token) ||
			!Number.isSafeInteger(answer.maxAge) ||
			answer.maxAge < 60 ||
			answer.maxAge > 400 * 24 * 3600
		)
			invalid();
		const parsed = { state, token: answer.token, maxAge: answer.maxAge };
		if (Object.hasOwn(answer, "memberId")) {
			if (typeof answer.memberId !== "string" || !UUID.test(answer.memberId)) invalid();
			parsed.memberId = answer.memberId;
		}
		return parsed;
	}
	if (state !== "limited") invalid();
	const answer = closed(value, ["state", "retryAfter"]);
	if (!Number.isSafeInteger(answer.retryAfter) || answer.retryAfter < 0) invalid();
	return { state, retryAfter: Math.max(1, answer.retryAfter) };
}

/** The role a JWT's claims name, or null when it is no JWT. Its signature is the database's to check. */
export function jwtRole(token) {
	const claims = JWT.exec(String(token))?.[1];
	if (!claims) return null;
	try {
		const role = JSON.parse(Buffer.from(claims, "base64url").toString("utf8"))?.role;
		return typeof role === "string" ? role : null;
	} catch {
		return null;
	}
}

/** The headers every RPC travels with: the stack's anon key for the gateway, the relay's own JWT for the database. */
export function relayHeaders(apiKey, relayJwt) {
	return { apikey: apiKey, authorization: `Bearer ${relayJwt}` };
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
		otherSite: "Sent from another site",
		otherSiteLead: "This app takes changes only from its own pages. Open the app and try again there.",
		notRunning: "This app is not running right now",
		notAnswering: "The app is not answering",
		notAnsweringLead: "It may be starting, or it has stopped. Try again in a moment.",
		slow: "The app did not answer in time",
		again: "Try again in a moment.",
		tooLarge: "Too large",
		tooLargeLead: "What was sent is too large for an app link.",
		memberOnly: "Company members only",
		memberOnlyLead: "Open this app from Qorpera while signed in as a company member.",
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
		otherSite: "Sendt fra et andet site",
		otherSiteLead: "Appen tager kun imod ændringer fra sine egne sider. Åbn appen, og prøv igen der.",
		notRunning: "Appen kører ikke lige nu",
		notAnswering: "Appen svarer ikke",
		notAnsweringLead: "Den starter måske, eller den er stoppet. Prøv igen om lidt.",
		slow: "Appen svarede ikke i tide",
		again: "Prøv igen om lidt.",
		tooLarge: "For stort",
		tooLargeLead: "Det sendte er for stort til et app-link.",
		memberOnly: "Kun for medlemmer af virksomheden",
		memberOnlyLead: "Åbn denne app fra Qorpera, mens du er logget ind som medlem af virksomheden.",
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

/** An answer written on an upgrade's raw socket (no HTTP response object there), then the socket is closed: it may be
 * paused, and http.Server's sockets wait half open for the peer's FIN otherwise. */
function rawAnswer(socket, status, html, extra = {}) {
	if (socket.destroyed) return;
	const body = Buffer.from(html);
	const headers = {
		...pageHeaders(),
		"content-type": "text/html; charset=utf-8",
		"content-length": body.length,
		...extra,
	};
	socket.end(
		Buffer.concat([
			Buffer.from(
				`HTTP/1.1 ${status} ${STATUS_CODES[status]}\r\n${Object.entries(headers)
					.map(([name, value]) => `${name}: ${value}\r\n`)
					.join("")}connection: close\r\n\r\n`,
			),
			body,
		]),
		() => socket.destroy(),
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

class Program {
	constructor(slug, ws, { id, key, siteId, port, nextCheckAt, authMode = "password", domains = [] }) {
		this.slug = slug;
		this.ws = ws;
		this.id = id;
		this.key = key;
		this.siteId = siteId;
		this.port = port;
		this.authMode = authMode;
		this.domains = new Set(domains);
		this.streams = new Map();
		this.wsStreams = new Set();
		this.httpCount = 0;
		this.wsCount = 0;
		this.next = 1;
		this.buffered = 0;
		this.pauseCount = 0;
		this.windowUpdates = 0;
		this.sharedProgressChecks = 0;
		this.uploadQueue = [];
		this.keptAliveAt = Date.now();
		this.nextCheckAt = nextCheckAt;
		this.health = {
			connected: true,
			healthy: true,
			port,
			lastStatus: null,
			lastLatencyMs: null,
			restartCount: 0,
			checkedAt: null,
		};
		this.swapPending = null;
	}

	send(type, stream, payload = EMPTY) {
		return this.ws.send(encodeMessage(type, stream, payload));
	}

	allocate() {
		let id = this.next;
		while (this.streams.has(id)) id = id >= 0xffffffff ? 1 : id + 1;
		this.next = id >= 0xffffffff ? 1 : id + 1;
		return id;
	}

	pumpUploads(highWater) {
		while (this.uploadQueue.length > 0 && !this.ws.closed) {
			const entry = this.uploadQueue[0];
			if (entry.isOver()) {
				this.uploadQueue.shift();
				continue;
			}
			const type = entry.type ?? TYPE.body;
			while (entry.offset < entry.slices.length) {
				const slice = entry.slices[entry.offset];
				if (this.ws.needsDrain && this.ws.queuedBytes + slice.length > highWater) return;
				entry.offset++;
				const room = this.send(type, entry.id, slice);
				if (this.ws.closed) return;
				if (!room || (this.ws.needsDrain && this.ws.queuedBytes >= highWater)) return;
			}
			this.uploadQueue.shift();
			entry.onDrained();
			if (this.ws.needsDrain && this.ws.queuedBytes >= highWater) return;
		}
	}
}

export function createRelay({
	api,
	apiKey,
	relayJwt,
	hostSuffix = DEFAULT_HOST_SUFFIX,
	fetch: fetcher = globalThis.fetch,
	responseTimeoutMs,
	firstByteTimeoutMs = responseTimeoutMs ?? FIRST_BYTE_TIMEOUT_MS,
	streamIdleTimeoutMs = responseTimeoutMs ?? STREAM_IDLE_TIMEOUT_MS,
	sseKeepaliveMs = SSE_KEEPALIVE_MS,
	streamWindowBytes = INITIAL_STREAM_WINDOW,
	windowUpdateThreshold = WINDOW_UPDATE_THRESHOLD,
	sessionCacheMs = SESSION_CACHE_MS,
	lockedCacheMs = LOCKED_CACHE_MS,
	maxBodyBytes = MAX_BODY_BYTES,
	maxQueuedBytes = MAX_QUEUED_BYTES,
	maxProgramBufferedBytes = MAX_PROGRAM_BUFFERED_BYTES,
	maxTotalBufferedBytes = MAX_TOTAL_BUFFERED_BYTES,
	maxWsPerSite = MAX_WS_PER_SITE,
	maxWsMessageBytes = MAX_WS_MESSAGE_BYTES,
	maxWsQueuedBytes = MAX_WS_QUEUED_BYTES,
	wsPingMs = KEEPALIVE_MS,
	wsIdleMs = SILENT_MS,
	keepaliveMs = KEEPALIVE_MS,
	silentMs = SILENT_MS,
	pausedMs = PAUSED_MS,
	sharedPausedMs = SHARED_PAUSED_MS,
	recheckMs = RECHECK_MS,
	connectLimit = CONNECT_LIMIT,
	publicRateLimitBurst,
	publicRateLimitPerMinute = PUBLIC_RATE_LIMIT_PER_MINUTE,
	publicMaxConcurrentPerIp = PUBLIC_MAX_CONCURRENT_PER_IP,
	webOrigins = DEFAULT_WEB_ORIGINS,
	gracefulShutdownMs = GRACEFUL_SHUTDOWN_MS,
	maxSessionsKept = MAX_SESSIONS_KEPT,
	maxRefusalsKept = MAX_REFUSALS_KEPT,
	trustedAddresses = [],
	clientSource,
	log = (line) => console.log(`app-relay: ${line}`),
} = {}) {
	const apiUrl = new URL(api);
	if (!["http:", "https:"].includes(apiUrl.protocol) || apiUrl.username || apiUrl.password)
		throw new Error("The API must be an http(s) URL without credentials");
	const base = apiUrl.href.replace(/\/+$/, "");
	if (typeof apiKey !== "string" || apiKey.length < 20) throw new Error("The API key is missing");
	if (jwtRole(relayJwt) !== RELAY_ROLE) throw new Error(`The relay's JWT must name the role ${RELAY_ROLE}`);
	if (!/^[-.][a-z0-9.-]*\.[a-z0-9-]+$/.test(hostSuffix)) throw new Error("The host suffix is invalid");
	const allowedWebOrigins = parseWebOrigins(webOrigins);
	const boundedMaxBodyBytes = Math.max(1, Math.min(MAX_CONFIGURABLE_BODY_BYTES, Number(maxBodyBytes) || MAX_BODY_BYTES));
	const effectivePublicRatePerMin = Math.max(1, Number(publicRateLimitPerMinute) || PUBLIC_RATE_LIMIT_PER_MINUTE);
	const effectivePublicBurst = Math.max(
		1,
		publicRateLimitBurst !== undefined
			? Number(publicRateLimitBurst) || 1
			: Math.min(PUBLIC_RATE_LIMIT_BURST, effectivePublicRatePerMin),
	);
	const client = Buffer.from(clientSource ?? readFileSync(new URL("./client.mjs", import.meta.url)));
	const trusted = new Set(
		trustedAddresses.map((value) => {
			const address = clientAddress(value);
			if (!address) throw new Error("A trusted address is not one IPv4 or IPv6 address");
			return address;
		}),
	);
	const programs = new Map();
	const domainToSlug = new Map();
	const sessions = new Map();
	const lockedSessions = new Map();
	const sessionInFlight = new Map();
	const upgrading = new Set();
	const refusals = new Map();
	const addressRefusals = new Map();
	const pendingByAddress = new Map();
	const publicHits = new Map();
	const publicInFlight = new Map();
	const uploadHighWater = Math.max(1024, Math.min(Math.floor(maxQueuedBytes / 2), 4 * 1024 * 1024));
	let totalHttpBufferedBytes = 0;
	let pendingTotal = 0;
	let pendingUntrusted = 0;
	let visitorUpgrading = 0;
	let draining = false;
	const drainWaiters = new Set();

	function totalActiveStreams() {
		let count = 0;
		for (const program of programs.values()) count += program.streams.size;
		return count;
	}

	function evictLargestBuffered(targetPrograms) {
		let victim = null;
		let maxBytes = 0;
		let oldestStall = Number.POSITIVE_INFINITY;
		for (const prog of targetPrograms) {
			for (const stream of prog.streams.values()) {
				const bytes = stream.bufferedBytes?.() ?? 0;
				if (bytes <= 0 || !stream.evict) continue;
				const stalled = stream.stalledSince?.() ?? Number.POSITIVE_INFINITY;
				if (bytes > maxBytes || (bytes === maxBytes && stalled < oldestStall)) {
					victim = stream;
					maxBytes = bytes;
					oldestStall = stalled;
				}
			}
		}
		if (!victim) return false;
		victim.evict();
		return true;
	}

	function checkDrained() {
		if (!draining || totalActiveStreams() > 0) return;
		for (const wake of drainWaiters) wake();
		drainWaiters.clear();
	}

	function syncProgramDomains(program, domains = []) {
		for (const existing of program.domains) {
			if (domainToSlug.get(existing) === program.slug) domainToSlug.delete(existing);
		}
		program.domains.clear();
		for (const host of domains) {
			program.domains.add(host);
			domainToSlug.set(host, program.slug);
		}
	}

	function clearProgramDomains(program) {
		for (const existing of program.domains) {
			if (domainToSlug.get(existing) === program.slug) domainToSlug.delete(existing);
		}
		program.domains.clear();
	}

	function resolveSiteHost(header) {
		const matched = appHost(header, hostSuffix, domainToSlug);
		if (!matched) return null;
		return {
			host: matched.host,
			slug: matched.slug,
			lookupKey: matched.customDomain ? matched.host : matched.slug,
			customDomain: Boolean(matched.customDomain),
		};
	}

	function socketWriteQueue(res) {
		const size = res.socket?._handle?.writeQueueSize;
		return typeof size === "number" && size >= 0 ? size : 0;
	}

	function scheduleCheck(now = Date.now()) {
		if (recheckMs <= 0) return Number.POSITIVE_INFINITY;
		if (recheckMs < 10_000) return now + recheckMs;
		return now + Math.round(recheckMs * (0.9 + Math.random() * 0.2));
	}

	function failure(error) {
		log(`the database could not answer (${error instanceof Error ? error.name : typeof error})`);
	}

	async function rpc(name, args) {
		const response = await fetcher(`${base}/rest/v1/rpc/${name}`, {
			method: "POST",
			redirect: "error",
			headers: { ...relayHeaders(apiKey, relayJwt), "content-type": "application/json" },
			body: JSON.stringify(args),
			signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
		});
		if (!response.ok) {
			void response.body?.cancel().catch(() => undefined);
			throw new Error(`The database answered HTTP ${response.status}`);
		}
		return JSON.parse(await readLimited(response, MAX_RPC_ANSWER_BYTES));
	}

	function keep(map, id, entry, cap) {
		if (map.has(id)) map.delete(id);
		else if (map.size >= cap) map.delete(map.keys().next().value);
		map.set(id, entry);
	}

	async function sessionLookup(lookupKey, token, fresh = false) {
		const id = `${lookupKey} ${token ?? "-"}`;
		const now = Date.now();
		if (!fresh) {
			const open = sessions.get(id);
			if (open) {
				if (open.until > now) {
					sessions.delete(id);
					sessions.set(id, open);
					return open.info;
				}
				sessions.delete(id);
			}
			const locked = lockedSessions.get(id);
			if (locked) {
				if (locked.until > now) return locked.info;
				lockedSessions.delete(id);
			}
			const running = sessionInFlight.get(id);
			if (running) return running;
		} else {
			sessions.delete(id);
			lockedSessions.delete(id);
		}
		const lookup = (async () => {
			const result = parseSessionAnswer(await rpc("qorpera_site_app_session", { p_slug: lookupKey, p_token: token }));
			const info =
				result.state === "open"
					? {
							open: true,
							siteId: result.siteId,
							authMode: result.authMode ?? "password",
							memberId: result.memberId ?? null,
							slug: result.slug ?? null,
						}
					: {
							open: false,
							siteId: null,
							authMode: result.authMode ?? "password",
							memberId: null,
							slug: result.slug ?? null,
						};
			const until = Date.now() + (info.open ? sessionCacheMs : lockedCacheMs);
			if (info.open) {
				lockedSessions.delete(id);
				keep(sessions, id, { until, info }, maxSessionsKept);
			} else {
				sessions.delete(id);
				keep(lockedSessions, id, { until, info }, maxSessionsKept);
			}
			return info;
		})();
		if (!fresh) {
			sessionInFlight.set(id, lookup);
			try {
				return await lookup;
			} finally {
				if (sessionInFlight.get(id) === lookup) sessionInFlight.delete(id);
			}
		}
		return lookup;
	}

	function activeRefusalCount(map, id, now) {
		const entry = map.get(id);
		if (!entry) return 0;
		if (now - entry.start >= 60_000) {
			map.delete(id);
			return 0;
		}
		return entry.count;
	}

	function bumpRefusal(map, id, now) {
		let entry = map.get(id);
		if (!entry || now - entry.start >= 60_000) {
			entry = { start: now, count: 0 };
			keep(map, id, entry, maxRefusalsKept);
		}
		entry.count++;
	}

	function recordRefusal(address, slug) {
		if (trusted.has(address)) return;
		const group = addressGroup(address);
		const now = Date.now();
		bumpRefusal(refusals, `${group} ${slug}`, now);
		bumpRefusal(addressRefusals, group, now);
	}

	function admitPublic(address, slug) {
		const group = address ? addressGroup(address) : "unknown";
		const now = Date.now();
		const rateKey = `${group} ${slug}`;
		let bucket = publicHits.get(rateKey);
		if (!bucket) {
			bucket = { tokens: effectivePublicBurst, updatedAt: now };
			keep(publicHits, rateKey, bucket, maxRefusalsKept);
		} else {
			const elapsedMs = Math.max(0, now - bucket.updatedAt);
			bucket.tokens = Math.min(effectivePublicBurst, bucket.tokens + (elapsedMs * effectivePublicRatePerMin) / 60_000);
			bucket.updatedAt = now;
		}
		if (bucket.tokens < 1) return null;
		const active = publicInFlight.get(rateKey) ?? 0;
		if (active >= publicMaxConcurrentPerIp) return null;
		bucket.tokens -= 1;
		publicInFlight.set(rateKey, active + 1);
		let released = false;
		return () => {
			if (released) return;
			released = true;
			const left = (publicInFlight.get(rateKey) ?? 1) - 1;
			if (left <= 0) publicInFlight.delete(rateKey);
			else publicInFlight.set(rateKey, left);
		};
	}

	function admit(address, slug) {
		if (pendingTotal >= connectLimit.total) return null;
		const isTrusted = trusted.has(address);
		const group = isTrusted ? null : addressGroup(address);
		if (!isTrusted) {
			const untrustedCap = trusted.size > 0 ? Math.max(1, Math.floor(connectLimit.total * 0.75)) : connectLimit.total;
			if (pendingUntrusted >= untrustedCap) return null;
			const perAddressCap = Math.min(untrustedCap, Math.max(connectLimit.refusedPerMinute, 16));
			const inFlightForAddress = pendingByAddress.get(group) ?? 0;
			if (inFlightForAddress >= perAddressCap) return null;
			const now = Date.now();
			if (activeRefusalCount(refusals, `${group} ${slug}`, now) >= connectLimit.refusedPerMinute) return null;
			const perAddressRefusedCap = Math.max(connectLimit.refusedPerMinute * 5, 50);
			if (activeRefusalCount(addressRefusals, group, now) >= perAddressRefusedCap) return null;
			pendingUntrusted++;
			pendingByAddress.set(group, inFlightForAddress + 1);
		}
		pendingTotal++;
		let released = false;
		return () => {
			if (released) return;
			released = true;
			pendingTotal--;
			if (!isTrusted) {
				pendingUntrusted--;
				const left = (pendingByAddress.get(group) ?? 1) - 1;
				if (left <= 0) pendingByAddress.delete(group);
				else pendingByAddress.set(group, left);
			}
		};
	}

	async function stillHolds(program) {
		const result = parseConnectAnswer(
			await rpc("qorpera_site_app_connect", { p_slug: program.slug, p_secret: program.key, p_program: program.id }),
		);
		return result.state === "ok" && result.siteId === program.siteId ? result : null;
	}

	function drop(program, why, code = CLOSE.refused) {
		if (programs.get(program.slug) === program) {
			programs.delete(program.slug);
			clearProgramDomains(program);
		}
		if (program.swapPending) {
			program.swapPending.reject(new Error("program disconnected"));
			program.swapPending = null;
		}
		log(`${program.slug}: the link program ends: ${why}`);
		program.ws.close(code, code === CLOSE.refused ? "refused" : why);
		for (const stream of [...program.streams.values()]) stream.gone();
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
			if (draining) {
				res.writeHead(503, {
					"content-type": "text/plain; charset=utf-8",
					"cache-control": "no-store",
					connection: "close",
				});
				res.end(req.method === "HEAD" ? undefined : "draining\n");
				return;
			}
			res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
			res.end(req.method === "HEAD" ? undefined : "ok\n");
			return;
		}
		const text = TEXT[lang];
		if (draining) {
			req.resume();
			return answer(req, res, 503, messagePage(lang, text.unavailable, text.again), {
				"retry-after": "5",
				connection: "close",
			});
		}
		const site = resolveSiteHost(req.headers["x-forwarded-host"]);
		if (!site || !url.startsWith("/")) return answer(req, res, 404, messagePage(lang, text.notFound, text.nothing));
		const isMemberDoor = path === "/.qorpera/member" || path === "/__qorpera/member";
		if (isMemberDoor) {
			const sentOrigin = req.headers.origin;
			if (req.method === "POST" && (typeof sentOrigin !== "string" || !allowedWebOrigins.includes(sentOrigin))) {
				req.resume();
				return answer(req, res, 403, messagePage(lang, text.otherSite, text.otherSiteLead), { connection: "close" });
			}
			return platform(req, res, lang, site, path);
		}
		if (changeFromAnotherSite(req.method, req.headers, site.host)) {
			req.resume();
			return answer(req, res, 403, messagePage(lang, text.otherSite, text.otherSiteLead), { connection: "close" });
		}
		if (isPlatformPath(path)) return platform(req, res, lang, site, path);

		const program = programs.get(site.slug);
		const tokens = authTokens(req.headers.cookie);
		let lockedAuthMode = program?.authMode ?? "password";
		for (const token of tokens) {
			const info = await sessionLookup(site.lookupKey, token);
			if (info.open) {
				if (program) program.authMode = info.authMode;
				return serve(req, res, lang, site, token, info);
			}
			if (info.authMode) lockedAuthMode = info.authMode;
		}
		if (program?.authMode === "public") {
			const info = await sessionLookup(site.lookupKey, null);
			if (info.open) {
				const releasePublic = admitPublic(clientAddress(req.headers["cf-connecting-ip"]), site.slug);
				if (!releasePublic)
					return answer(req, res, 429, messagePage(lang, text.unavailable, text.again), { "retry-after": "30" });
				return serve(req, res, lang, site, null, info, releasePublic);
			}
			lockedAuthMode = info.authMode;
		}
		return lockedAnswer(req, res, lang, tokens.length > 0, lockedAuthMode);
	}

	function lockedAnswer(req, res, lang, clear, authMode = "password") {
		const text = TEXT[lang];
		if (authMode === "company_member") {
			return answer(
				req,
				res,
				401,
				messagePage(lang, text.memberOnly, text.memberOnlyLead),
				clear ? { "set-cookie": CLEAR_GATE_COOKIE } : {},
			);
		}
		return answer(
			req,
			res,
			401,
			passwordPage(lang, safeNext(req.url ?? "/")),
			clear ? { "set-cookie": CLEAR_GATE_COOKIE } : {},
			"same-origin",
		);
	}

	async function serve(req, res, lang, site, token, info, onComplete = null) {
		const text = TEXT[lang];
		const release = () => {
			if (onComplete) {
				const fn = onComplete;
				onComplete = null;
				fn();
			}
		};
		const notRunning = () => {
			release();
			return answer(req, res, 503, messagePage(lang, text.notRunning, text.again), { "retry-after": "10" });
		};
		let program = programs.get(site.slug);
		if (program && program.siteId !== info.siteId) {
			const fresh = await sessionLookup(site.lookupKey, token, true);
			if (!fresh.open) {
				release();
				return lockedAnswer(req, res, lang, token !== null, fresh.authMode);
			}
			program = programs.get(site.slug);
			if (program && program.siteId !== fresh.siteId) {
				if (!(await stillHolds(program)) && programs.get(site.slug) === program) drop(program, "its site is gone");
				return notRunning();
			}
			info = fresh;
		}
		if (!program) return notRunning();
		return forward(req, res, lang, site, program, info, release);
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
				"cdn-cache-control": "no-store",
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
			return unlock(req, res, lang, site, "password");
		}
		if (path === "/.qorpera/member" || path === "/__qorpera/member") {
			if (method !== "POST") {
				res.writeHead(405, { ...pageHeaders(), allow: "POST" });
				return void res.end();
			}
			return unlock(req, res, lang, site, "member");
		}
		if (path === "/.qorpera/connect") {
			res.writeHead(426, { ...pageHeaders(), upgrade: "websocket", connection: "Upgrade" });
			return void res.end();
		}
		return answer(req, res, 404, messagePage(lang, text.notFound, text.nothing));
	}

	async function unlock(req, res, lang, site, kind = "password") {
		const text = TEXT[lang];
		const refused = (status) =>
			answer(req, res, status, messagePage(lang, text.private, text.refused), { connection: "close" });
		const origin = req.headers.origin;
		if (kind === "member") {
			if (typeof origin !== "string" || !allowedWebOrigins.includes(origin)) return refused(403);
		} else if (origin !== undefined && origin !== `https://${site.host}`) {
			return refused(403);
		}
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
		const sentNext = form.get("next") ?? (form.has("path") ? `/${(form.get("path") ?? "").replace(/^\/+/, "")}` : "/");
		const next = safeNext(sentNext);
		const passes = kind === "member" ? form.getAll("pass") : form.getAll("password");
		const credential = passes.length === 1 ? (passes[0] ?? "") : "";
		const locked = (status, error, extra = {}) =>
			kind === "member"
				? answer(req, res, status, messagePage(lang, text.memberOnly, text.memberOnlyLead), extra)
				: answer(req, res, status, passwordPage(lang, next, error), extra, "same-origin");
		if (kind === "member") {
			if (!MEMBER_PASS.test(credential)) return locked(401, text.wrong);
		} else if (!credential || credential.length > MAX_PASSWORD) {
			return locked(401, text.empty);
		}
		const result = parseUnlockAnswer(
			await rpc("qorpera_site_app_unlock", {
				p_slug: site.lookupKey,
				p_password: credential,
				p_client: clientAddress(req.headers["cf-connecting-ip"]),
			}),
		);
		if (result.state === "wrong") return locked(401, text.wrong);
		if (result.state === "limited")
			return locked(429, text.limited(Math.ceil(result.retryAfter / 60)), {
				"retry-after": String(result.retryAfter),
			});
		res.writeHead(303, { ...pageHeaders(), location: next, "set-cookie": gateCookie(result.token, result.maxAge) });
		res.end();
	}

	function forward(req, res, lang, site, program, info, onComplete = null) {
		const text = TEXT[lang];
		const release = () => {
			if (onComplete) {
				const fn = onComplete;
				onComplete = null;
				fn();
			}
		};
		const declared = req.headers["content-length"];
		if (declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) > boundedMaxBodyBytes)) {
			req.resume();
			release();
			return answer(req, res, 413, messagePage(lang, text.tooLarge, text.tooLargeLead), { connection: "close" });
		}
		if (program.httpCount >= MAX_STREAMS) {
			release();
			return answer(req, res, 503, messagePage(lang, text.unavailable, text.unavailableLead), {
				"retry-after": "5",
			});
		}

		const id = program.allocate();
		program.httpCount++;
		const isPublic = info.authMode === "public";
		const maxStreamBuffered = Math.max(streamWindowBytes * 2, 512 * 1024);
		let answered = false;
		let isEventStream = false;
		let over = false;
		let waitingDrain = false;
		let creditRemaining = streamWindowBytes;
		let streamBuffered = 0;
		let pendingWindow = 0;
		let stalledTimer = null;
		let stalledAt = 0;
		let lastStalledWritable = 0;
		let lastStalledQueue = 0;
		let received = 0;
		let reqPaused = false;
		let reqEnded = false;
		let uploadEntry = null;
		let timer = null;
		let sseKeepaliveTimer = null;
		let lastSseWriteAt = 0;

		const syncBuffered = (next) => {
			const clamped = Math.max(0, next);
			const delta = clamped - streamBuffered;
			if (delta === 0) return;
			streamBuffered = clamped;
			program.buffered = Math.max(0, program.buffered + delta);
			totalHttpBufferedBytes = Math.max(0, totalHttpBufferedBytes + delta);
		};
		const flushWindow = () => {
			if (over || pendingWindow <= 0 || program.ws.closed) return;
			const amount = pendingWindow;
			pendingWindow = 0;
			creditRemaining += amount;
			program.windowUpdates++;
			program.send(TYPE.window, id, encodeWindow(amount));
		};
		const clearStalledTimer = () => {
			if (stalledTimer) {
				clearTimeout(stalledTimer);
				stalledTimer = null;
			}
		};
		const armTimer = () => {
			if (timer) clearTimeout(timer);
			const timeout = answered ? streamIdleTimeoutMs : firstByteTimeoutMs;
			timer = setTimeout(() => fail(504, text.slow, text.again), timeout);
		};
		const armStalledTimer = (ms) => {
			clearStalledTimer();
			stalledTimer = setTimeout(() => {
				if (over || !waitingDrain) return;
				const elapsed = Date.now() - stalledAt;
				if (elapsed >= pausedMs) return fail(502, text.notAnswering, text.notAnsweringLead);
				const currentWritable = Math.max(0, res.writableLength);
				const currentQueue = socketWriteQueue(res);
				// WHY: Check writableLength and libuv writeQueueSize so steadily draining slow visitors stay alive without blocking sibling streams.
				if (
					currentWritable < lastStalledWritable ||
					(currentWritable === lastStalledWritable && currentQueue < lastStalledQueue)
				) {
					program.sharedProgressChecks++;
					lastStalledWritable = currentWritable;
					lastStalledQueue = currentQueue;
					armStalledTimer(Math.min(sharedPausedMs, Math.max(1, pausedMs - elapsed)));
					return;
				}
				fail(502, text.notAnswering, text.notAnsweringLead);
			}, ms);
		};
		const startSseKeepalive = () => {
			if (!isEventStream || sseKeepaliveMs <= 0) return;
			lastSseWriteAt = Date.now();
			sseKeepaliveTimer = setInterval(() => {
				if (over || waitingDrain || res.destroyed || res.writableEnded) return;
				if (Date.now() - lastSseWriteAt < sseKeepaliveMs) return;
				try {
					res.write(": keepalive\n\n");
					lastSseWriteAt = Date.now();
				} catch {
					fail(502, text.notAnswering, text.notAnsweringLead);
				}
			}, Math.max(25, Math.floor(sseKeepaliveMs / 2)));
			sseKeepaliveTimer.unref();
		};
		const done = () => {
			if (over) return;
			over = true;
			if (timer) {
				clearTimeout(timer);
				timer = null;
			}
			if (sseKeepaliveTimer) {
				clearInterval(sseKeepaliveTimer);
				sseKeepaliveTimer = null;
			}
			clearStalledTimer();
			syncBuffered(0);
			program.streams.delete(id);
			program.httpCount = Math.max(0, program.httpCount - 1);
			uploadEntry = null;
			if (reqPaused && !reqEnded) {
				reqPaused = false;
				req.resume();
			}
			release();
			checkDrained();
		};
		const fail = (status, title, lead, { tellProgram = true } = {}) => {
			if (over) return;
			done();
			if (tellProgram && !program.ws.closed) program.send(TYPE.reset, id);
			req.resume();
			if (answered) res.destroy();
			else answer(req, res, status, messagePage(lang, title, lead), { connection: "close" });
		};
		armTimer();
		const broken = () => fail(502, text.notAnswering, text.notAnsweringLead);
		program.streams.set(id, {
			response(payload) {
				if (answered) return broken();
				let head;
				try {
					head = JSON.parse(payload.toString("utf8"));
				} catch {
					return broken();
				}
				const headers = responseHeaders(head?.headers, { isPublic });
				const status = head?.status;
				if (!Number.isInteger(status) || status < 200 || status > 599 || !headers) return broken();
				isEventStream = isEventStreamHeaders(headers);
				res.strictContentLength = true;
				try {
					res.writeHead(status, headers.flat());
				} catch {
					return broken();
				}
				answered = true;
				armTimer();
				res.flushHeaders();
				startSseKeepalive();
			},
			body(payload) {
				if (!answered) return broken();
				creditRemaining -= payload.length;
				if (creditRemaining < 0) {
					// WHY: Enforce per-stream send credits so a modified link program cannot exhaust relay memory when a visitor stops reading.
					done();
					if (!program.ws.closed) drop(program, "flow control window exceeded", 1002);
					req.resume();
					res.destroy();
					return;
				}
				if (!waitingDrain) armTimer();
				let room;
				try {
					room = res.write(payload);
				} catch {
					return broken();
				}
				syncBuffered(res.writableLength);
				if (streamBuffered > maxStreamBuffered) return fail(502, text.notAnswering, text.notAnsweringLead);
				// WHY: Evict the heaviest stalled stream when per-program or relay-wide memory caps trip so fast readers are never disrupted.
				while (program.buffered > maxProgramBufferedBytes) {
					if (!evictLargestBuffered([program])) break;
				}
				while (totalHttpBufferedBytes > maxTotalBufferedBytes) {
					if (!evictLargestBuffered(programs.values())) break;
				}
				if (over) return;
				if (isEventStream) lastSseWriteAt = Date.now();
				pendingWindow += payload.length;
				if (!room) {
					if (!waitingDrain) {
						waitingDrain = true;
						stalledAt = Date.now();
						lastStalledWritable = Math.max(0, res.writableLength);
						lastStalledQueue = socketWriteQueue(res);
						if (timer) {
							clearTimeout(timer);
							timer = null;
						}
						armStalledTimer(Math.min(pausedMs, sharedPausedMs));
					}
					return;
				}
				if (!waitingDrain && pendingWindow >= windowUpdateThreshold) flushWindow();
			},
			end() {
				if (!answered) return broken();
				try {
					res.end();
				} catch {
					return broken();
				}
				done();
			},
			reset() {
				fail(502, text.notAnswering, text.notAnsweringLead, { tellProgram: false });
			},
			gone() {
				fail(502, text.notAnswering, text.notAnsweringLead, { tellProgram: false });
			},
			bufferedBytes: () => streamBuffered,
			stalledSince: () => (waitingDrain ? stalledAt : Number.POSITIVE_INFINITY),
			evict: () => fail(502, text.notAnswering, text.notAnsweringLead),
			broken,
		});
		res.on("drain", () => {
			if (over) return;
			syncBuffered(res.writableLength);
			waitingDrain = false;
			clearStalledTimer();
			armTimer();
			flushWindow();
		});
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
						chunked: req.headers["transfer-encoding"] !== undefined,
						memberId: info.memberId,
					}),
				}),
			),
		);
		const queueSlices = (slices) => {
			if (!reqPaused) {
				reqPaused = true;
				req.pause();
			}
			if (uploadEntry) {
				uploadEntry.slices.push(...slices);
				return;
			}
			uploadEntry = {
				id,
				slices,
				offset: 0,
				isOver: () => over,
				onDrained: () => {
					uploadEntry = null;
					if (over) return;
					if (reqEnded) {
						if (!program.ws.closed) program.send(TYPE.end, id);
					} else if (reqPaused) {
						reqPaused = false;
						req.resume();
					}
				},
			};
			program.uploadQueue.push(uploadEntry);
		};
		req.on("data", (chunk) => {
			if (over) return;
			received += chunk.length;
			if (received > boundedMaxBodyBytes) return fail(413, text.tooLarge, text.tooLargeLead);
			const slices = [];
			for (let at = 0; at < chunk.length; at += CHUNK_BYTES) slices.push(chunk.subarray(at, at + CHUNK_BYTES));
			if (uploadEntry || program.uploadQueue.length > 0) return queueSlices(slices);
			for (let i = 0; i < slices.length; i++) {
				const slice = slices[i];
				// WHY: Pause and queue before approaching maxQueuedBytes so concurrent upload bursts never terminate the WS.
				if (program.ws.needsDrain && program.ws.queuedBytes + slice.length > uploadHighWater) {
					return queueSlices(slices.slice(i));
				}
				const room = program.send(TYPE.body, id, slice);
				if (over || program.ws.closed) return;
				if (!room || (program.ws.needsDrain && program.ws.queuedBytes >= uploadHighWater)) {
					const rest = slices.slice(i + 1);
					if (rest.length > 0) return queueSlices(rest);
					if (!reqPaused) {
						reqPaused = true;
						req.pause();
						uploadEntry = {
							id,
							slices: [],
							offset: 0,
							isOver: () => over,
							onDrained: () => {
								uploadEntry = null;
								if (over) return;
								if (reqEnded) {
									if (!program.ws.closed) program.send(TYPE.end, id);
								} else if (reqPaused) {
									reqPaused = false;
									req.resume();
								}
							},
						};
						program.uploadQueue.push(uploadEntry);
					}
					return;
				}
			}
		});
		req.on("end", () => {
			reqEnded = true;
			if (!over && !uploadEntry && !program.ws.closed) program.send(TYPE.end, id);
		});
	}

	function forwardVisitorWs(
		req,
		socket,
		headBytes,
		lang,
		site,
		program,
		accept,
		offeredProtocols,
		releaseUpgrading,
		sessionToken,
		info,
		onComplete = null,
	) {
		const text = TEXT[lang];
		const release = () => {
			if (onComplete) {
				const fn = onComplete;
				onComplete = null;
				fn();
			}
		};
		if (program.ws.closed || socket.destroyed) {
			releaseUpgrading();
			release();
			if (!socket.destroyed)
				rawAnswer(socket, 503, messagePage(lang, text.notRunning, text.again), { "retry-after": "10" });
			return;
		}
		if (program.wsCount >= maxWsPerSite) {
			releaseUpgrading();
			release();
			rawAnswer(socket, 503, messagePage(lang, text.unavailable, text.unavailableLead), { "retry-after": "5" });
			return;
		}
		const id = program.allocate();
		program.wsCount++;
		let opened = false;
		let over = false;
		let visitorClosed = false;
		let visitorPaused = false;
		let visitorWs = null;
		let wsTracker = null;
		let wsUploadEntry = null;
		let wsPendingBytes = 0;
		let pendingClose = null;
		let pendingWsWindow = 0;
		let wsWaitingDrain = false;
		let wsStalledTimer = null;
		let timer = null;

		const flushWsWindow = () => {
			if (over || pendingWsWindow <= 0 || program.ws.closed) return;
			const amount = pendingWsWindow;
			pendingWsWindow = 0;
			program.windowUpdates++;
			program.send(TYPE.window, id, encodeWindow(amount));
		};
		const clearWsStalledTimer = () => {
			if (wsStalledTimer) {
				clearTimeout(wsStalledTimer);
				wsStalledTimer = null;
			}
		};
		const onPrematureClose = () => {
			if (over || opened) return;
			done();
			if (!program.ws.closed) program.send(TYPE.reset, id);
		};
		const done = () => {
			if (over) return;
			over = true;
			if (timer) {
				clearTimeout(timer);
				timer = null;
			}
			clearWsStalledTimer();
			socket.off("close", onPrematureClose);
			releaseUpgrading();
			program.streams.delete(id);
			program.wsCount = Math.max(0, program.wsCount - 1);
			if (wsTracker) {
				program.wsStreams.delete(wsTracker);
				wsTracker = null;
			}
			wsUploadEntry = null;
			wsPendingBytes = 0;
			pendingClose = null;
			release();
			checkDrained();
		};
		const failBeforeOpen = (status, title, lead, extra = {}, tellProgram = true) => {
			if (over) return;
			done();
			if (tellProgram && !program.ws.closed) program.send(TYPE.reset, id);
			rawAnswer(socket, status, messagePage(lang, title, lead), extra);
		};
		const closeBoth = (code, reason) => {
			if (over) return;
			const encoded = encodeWsClose(code, reason);
			done();
			if (!program.ws.closed) program.send(TYPE.wsClose, id, encoded);
			visitorWs?.close(code, reason);
		};
		const dropSlowVisitor = (code = 1008, reason = "slow consumer") => {
			closeBoth(code, reason);
		};
		const pauseVisitor = () => {
			if (!visitorPaused && visitorWs && !visitorWs.closed) {
				visitorPaused = true;
				visitorWs.pause();
			}
		};
		const resumeVisitor = () => {
			if (visitorPaused && visitorWs && !visitorWs.closed) {
				visitorPaused = false;
				visitorWs.resume();
			}
		};
		const queueFrame = (frame) => {
			pauseVisitor();
			if (wsUploadEntry) {
				if (frame) wsUploadEntry.slices.push(frame);
				return;
			}
			wsUploadEntry = {
				type: TYPE.wsData,
				id,
				slices: frame ? [frame] : [],
				offset: 0,
				isOver: () => over,
				onDrained: () => {
					wsUploadEntry = null;
					wsPendingBytes = 0;
					if (over) return;
					if (pendingClose !== null) {
						const closePayload = pendingClose;
						pendingClose = null;
						done();
						if (!program.ws.closed) program.send(TYPE.wsClose, id, closePayload);
					} else {
						resumeVisitor();
					}
				},
			};
			program.uploadQueue.push(wsUploadEntry);
		};
		const notifyClientClose = (encoded, abortPending = false) => {
			if (over || visitorClosed) return;
			visitorClosed = true;
			if (!abortPending && wsUploadEntry && !program.ws.closed) {
				pendingClose = encoded;
				return;
			}
			done();
			if (!program.ws.closed) program.send(TYPE.wsClose, id, encoded);
		};
		socket.on("close", onPrematureClose);
		timer = setTimeout(() => failBeforeOpen(504, text.slow, text.again), firstByteTimeoutMs);
		program.streams.set(id, {
			wsOpenOk(payload) {
				if (over) return;
				if (opened) return closeBoth(1011, "protocol error");
				let head;
				try {
					head = JSON.parse(payload.toString("utf8"));
				} catch {
					return failBeforeOpen(502, text.notAnswering, text.notAnsweringLead);
				}
				if (!head || typeof head !== "object" || Array.isArray(head))
					return failBeforeOpen(502, text.notAnswering, text.notAnsweringLead);
				let protocol = null;
				if (head.protocol !== undefined && head.protocol !== null) {
					if (typeof head.protocol !== "string" || !offeredProtocols.includes(head.protocol))
						return failBeforeOpen(502, text.notAnswering, text.notAnsweringLead);
					protocol = head.protocol;
				}
				let extraHeaders = [];
				if (head.headers !== undefined && head.headers !== null) {
					extraHeaders = wsResponseHeaders(head.headers);
					if (!extraHeaders) return failBeforeOpen(502, text.notAnswering, text.notAnsweringLead);
				}
				if (timer) {
					clearTimeout(timer);
					timer = null;
				}
				socket.off("close", onPrematureClose);
				releaseUpgrading();
				if (socket.destroyed) {
					done();
					if (!program.ws.closed) program.send(TYPE.reset, id);
					return;
				}
				let response = `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n`;
				if (protocol !== null) response += `Sec-WebSocket-Protocol: ${protocol}\r\n`;
				for (const [name, value] of extraHeaders) response += `${name}: ${value}\r\n`;
				response += "\r\n";
				socket.write(response);
				opened = true;
				visitorWs = new WebSocketConnection(socket, headBytes, {
					maxPayload: maxWsMessageBytes,
					maxQueued: maxWsQueuedBytes,
					allowText: true,
				});
				visitorWs.onDrain = () => {
					if (over) return;
					wsWaitingDrain = false;
					clearWsStalledTimer();
					flushWsWindow();
				};
				wsTracker = {
					ws: visitorWs,
					token: sessionToken,
					lookupKey: site.lookupKey,
					siteId: info.siteId,
					authMode: info.authMode,
					pingedAt: Date.now(),
					checkedAt: Date.now(),
					rechecking: false,
					idleClose: () => closeBoth(1001, "idle timeout"),
					sessionEnded: () => closeBoth(1008, "session ended"),
				};
				program.wsStreams.add(wsTracker);
				visitorWs.onMessage = (message, opcode) => {
					if (over || visitorClosed || program.ws.closed) return;
					const frame = Buffer.allocUnsafe(1 + message.length);
					frame[0] = opcode;
					message.copy(frame, 1);
					if (wsUploadEntry || program.uploadQueue.length > 0) {
						if (wsPendingBytes + frame.length > maxWsQueuedBytes) {
							dropSlowVisitor(1008, "slow consumer");
							return;
						}
						wsPendingBytes += frame.length;
						queueFrame(frame);
						return;
					}
					if (program.ws.needsDrain && program.ws.queuedBytes + frame.length > uploadHighWater) {
						if (wsPendingBytes + frame.length > maxWsQueuedBytes) {
							dropSlowVisitor(1008, "slow consumer");
							return;
						}
						wsPendingBytes += frame.length;
						queueFrame(frame);
						return;
					}
					if (program.ws.queuedBytes + frame.length + 19 > maxQueuedBytes) {
						closeBoth(1009, "message too large");
						return;
					}
					const room = program.send(TYPE.wsData, id, frame);
					if (over || program.ws.closed) return;
					if (!room || (program.ws.needsDrain && program.ws.queuedBytes >= uploadHighWater)) queueFrame(null);
				};
				visitorWs.onCloseFrame = (code, reason) => notifyClientClose(encodeWsClose(code, reason));
				visitorWs.onProtocolError = (code, reason) => notifyClientClose(encodeWsClose(code, reason), true);
				visitorWs.onClose = () => notifyClientClose(encodeWsClose(1001, ""), true);
			},
			wsData(payload) {
				if (over) return;
				if (!opened) return failBeforeOpen(502, text.notAnswering, text.notAnsweringLead);
				if (payload.length < 1) return closeBoth(1011, "invalid message");
				const opcode = payload[0];
				if (opcode !== 1 && opcode !== 2) return closeBoth(1011, "invalid message");
				const data = payload.subarray(1);
				if (data.length > maxWsMessageBytes) return closeBoth(1009, "message too large");
				if (opcode === 1) {
					try {
						UTF8_DECODER.decode(data);
					} catch {
						return closeBoth(1007, "invalid utf-8");
					}
				}
				if (visitorWs.queuedBytes + data.length + 14 > maxWsQueuedBytes) {
					return dropSlowVisitor(1008, "slow consumer");
				}
				const room = visitorWs.send(data, opcode);
				pendingWsWindow += data.length;
				if (!room) {
					if (!wsWaitingDrain) {
						wsWaitingDrain = true;
						wsStalledTimer = setTimeout(() => {
							if (!over && wsWaitingDrain) dropSlowVisitor(1013, "slow consumer");
						}, pausedMs);
						wsStalledTimer.unref();
					}
					return;
				}
				if (!wsWaitingDrain && pendingWsWindow >= windowUpdateThreshold) flushWsWindow();
			},
			wsClose(payload) {
				if (over) return;
				if (!opened) {
					const status = payload.length >= 2 ? payload.readUInt16BE(0) : 502;
					const validStatus = status >= 400 && status <= 599 && STATUS_CODES[status] !== undefined;
					failBeforeOpen(
						validStatus ? status : 502,
						validStatus && status === 404 ? text.notFound : text.notAnswering,
						validStatus && status === 404 ? text.nothing : text.notAnsweringLead,
						{},
						false,
					);
					return;
				}
				const { code, reason } = decodeWsClose(payload);
				done();
				visitorWs.close(code, reason);
			},
			reset() {
				if (over) return;
				if (!opened) return failBeforeOpen(502, text.notAnswering, text.notAnsweringLead, {}, false);
				done();
				visitorWs.close(1001, "app disconnected");
			},
			gone() {
				if (over) return;
				if (!opened) return failBeforeOpen(503, text.notRunning, text.again, { "retry-after": "10" }, false);
				done();
				visitorWs.close(1001, "app disconnected");
			},
			broken() {
				if (over) return;
				if (!opened) return failBeforeOpen(502, text.notAnswering, text.notAnsweringLead);
				closeBoth(1011, "protocol error");
			},
		});
		program.send(
			TYPE.wsOpen,
			id,
			Buffer.from(
				JSON.stringify({
					path: req.url,
					headers: wsRequestHeaders(req.rawHeaders, {
						host: site.host,
						client: clientAddress(req.headers["cf-connecting-ip"]),
						protocols: offeredProtocols,
						memberId: info.memberId,
					}),
				}),
			),
		);
	}

	async function upgradeVisitor(req, socket, head, lang, site) {
		const text = TEXT[lang];
		if (draining)
			return rawAnswer(socket, 503, messagePage(lang, text.unavailable, text.again), { "retry-after": "5" });
		const url = req.url ?? "";
		const path = url.split("?")[0];
		if (!url.startsWith("/") || isPlatformPath(path))
			return rawAnswer(socket, 404, messagePage(lang, text.notFound, text.nothing));
		const accept = req.method === "GET" ? acceptKey(req.headers) : null;
		if (!accept) return rawAnswer(socket, 400, messagePage(lang, text.notFound, text.nothing));
		const parsedProtocols = parseWsProtocols(req.rawHeaders);
		if (!parsedProtocols.ok) return rawAnswer(socket, 400, messagePage(lang, text.notFound, text.nothing));
		if (!isValidVisitorWsOrigin(req.headers, site.host, req.rawHeaders, { allowAbsentOrigin: true }))
			return rawAnswer(socket, 403, messagePage(lang, text.otherSite, text.otherSiteLead));
		const originPresent = isValidVisitorWsOrigin(req.headers, site.host, req.rawHeaders, { allowAbsentOrigin: false });
		const precheckProgram = programs.get(site.slug);
		if (!originPresent && (precheckProgram?.authMode !== "public" || Boolean(req.headers.cookie)))
			return rawAnswer(socket, 403, messagePage(lang, text.otherSite, text.otherSiteLead));
		if (visitorUpgrading >= MAX_VISITOR_UPGRADING)
			return rawAnswer(socket, 503, messagePage(lang, text.unavailable, text.again), { "retry-after": "5" });
		socket.pause();
		upgrading.add(socket);
		visitorUpgrading++;
		let released = false;
		const releaseUpgrading = () => {
			if (released) return;
			released = true;
			upgrading.delete(socket);
			visitorUpgrading = Math.max(0, visitorUpgrading - 1);
		};
		let handedOff = false;
		let releasePublic = null;
		try {
			let program = programs.get(site.slug);
			const tokens = authTokens(req.headers.cookie);
			let matchedToken = null;
			let info = null;
			let lockedAuthMode = program?.authMode ?? "password";
			for (const token of tokens) {
				const found = await sessionLookup(site.lookupKey, token);
				if (socket.destroyed) return;
				if (found.open) {
					matchedToken = token;
					info = found;
					if (program) program.authMode = found.authMode;
					break;
				}
				if (found.authMode) lockedAuthMode = found.authMode;
			}
			if (!info && program?.authMode === "public") {
				const found = await sessionLookup(site.lookupKey, null);
				if (socket.destroyed) return;
				if (found.open) info = found;
				else lockedAuthMode = found.authMode;
			}
			if (!originPresent) {
				const allowedAbsentOrigin = info?.open && info.authMode === "public" && !req.headers.cookie;
				if (!allowedAbsentOrigin) {
					rawAnswer(socket, 403, messagePage(lang, text.otherSite, text.otherSiteLead));
					return;
				}
			}
			if (!info?.open) {
				rawAnswer(
					socket,
					401,
					lockedAuthMode === "company_member"
						? messagePage(lang, text.memberOnly, text.memberOnlyLead)
						: passwordPage(lang, safeNext(url)),
					tokens.length > 0 ? { "set-cookie": CLEAR_GATE_COOKIE } : {},
				);
				return;
			}
			if (info.authMode === "public") {
				releasePublic = admitPublic(clientAddress(req.headers["cf-connecting-ip"]), site.slug);
				if (!releasePublic) {
					rawAnswer(socket, 429, messagePage(lang, text.unavailable, text.again), { "retry-after": "30" });
					return;
				}
			}
			program = programs.get(site.slug);
			if (program && program.siteId !== info.siteId) {
				const fresh = await sessionLookup(site.lookupKey, matchedToken, true);
				if (socket.destroyed) return;
				if (!fresh.open) {
					rawAnswer(
						socket,
						401,
						fresh.authMode === "company_member"
							? messagePage(lang, text.memberOnly, text.memberOnlyLead)
							: passwordPage(lang, safeNext(url)),
						matchedToken ? { "set-cookie": CLEAR_GATE_COOKIE } : {},
					);
					return;
				}
				info = fresh;
				program = programs.get(site.slug);
				if (program && program.siteId !== fresh.siteId) {
					if (!(await stillHolds(program)) && programs.get(site.slug) === program) drop(program, "its site is gone");
					if (!socket.destroyed)
						rawAnswer(socket, 503, messagePage(lang, text.notRunning, text.again), { "retry-after": "10" });
					return;
				}
			}
			if (!program) {
				rawAnswer(socket, 503, messagePage(lang, text.notRunning, text.again), { "retry-after": "10" });
				return;
			}
			handedOff = true;
			const completePublic = releasePublic;
			releasePublic = null;
			forwardVisitorWs(
				req,
				socket,
				head,
				lang,
				site,
				program,
				accept,
				parsedProtocols.protocols,
				releaseUpgrading,
				matchedToken,
				info,
				completePublic,
			);
		} catch (error) {
			failure(error);
			rawAnswer(socket, 503, messagePage(lang, text.unavailable, text.unavailableLead), { "retry-after": "30" });
		} finally {
			if (!handedOff) {
				releasePublic?.();
				releaseUpgrading();
			}
		}
	}

	function handleHealthFrame(program, payload) {
		try {
			const data = JSON.parse(payload.toString("utf8"));
			if (!data || typeof data !== "object" || Array.isArray(data)) return;
			if (typeof data.healthy !== "boolean") return;
			program.health = {
				connected: true,
				healthy: data.healthy,
				port: Number.isInteger(data.port) ? data.port : program.port,
				lastStatus: Number.isInteger(data.lastStatus) ? data.lastStatus : null,
				lastLatencyMs:
					typeof data.lastLatencyMs === "number" && Number.isFinite(data.lastLatencyMs) && data.lastLatencyMs >= 0
						? Math.round(data.lastLatencyMs)
						: null,
				restartCount: Number.isSafeInteger(data.restartCount) && data.restartCount >= 0 ? data.restartCount : 0,
				checkedAt: Number.isSafeInteger(data.checkedAt) ? data.checkedAt : Date.now(),
			};
		} catch {
			return;
		}
	}

	function handleSwapTargetAck(program, payload) {
		if (!program.swapPending) return;
		const pending = program.swapPending;
		program.swapPending = null;
		try {
			const ack = JSON.parse(payload.toString("utf8"));
			if (ack?.ok === true && Number.isInteger(ack.activePort) && ack.activePort >= 1 && ack.activePort <= 65535) {
				program.port = ack.activePort;
				program.health = { ...program.health, port: ack.activePort, healthy: true };
			}
			pending.resolve(ack);
		} catch (error) {
			pending.reject(error);
		}
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
		if (type === TYPE.health && id === 0) return handleHealthFrame(program, payload);
		if (type === TYPE.swapTarget && id === 0) return handleSwapTargetAck(program, payload);
		if (
			![TYPE.response, TYPE.body, TYPE.end, TYPE.reset, TYPE.wsOpenOk, TYPE.wsData, TYPE.wsClose].includes(type)
		) {
			program.ws.close(1002, "invalid message");
			return;
		}
		const stream = program.streams.get(id);
		if (!stream) return;
		if (type === TYPE.response) stream.response ? stream.response(payload) : stream.broken();
		else if (type === TYPE.body) stream.body ? stream.body(payload) : stream.broken();
		else if (type === TYPE.end) stream.end ? stream.end() : stream.broken();
		else if (type === TYPE.wsOpenOk) stream.wsOpenOk ? stream.wsOpenOk(payload) : stream.broken();
		else if (type === TYPE.wsData) stream.wsData ? stream.wsData(payload) : stream.broken();
		else if (type === TYPE.wsClose) stream.wsClose ? stream.wsClose(payload) : stream.broken();
		else stream.reset();
	}

	function register(site, ws, secret, id, result) {
		const old = programs.get(site.slug);
		const program = new Program(site.slug, ws, {
			id,
			key: result.key ?? secret,
			siteId: result.siteId,
			port: result.port,
			nextCheckAt: scheduleCheck(),
			authMode: result.authMode ?? "password",
			domains: result.domains ?? [],
		});
		if (old) clearProgramDomains(old);
		programs.set(site.slug, program);
		syncProgramDomains(program, result.domains ?? []);
		ws.onMessage = (message) => programMessage(program, message);
		ws.onDrain = () => program.pumpUploads(uploadHighWater);
		ws.onClose = () => {
			if (programs.get(site.slug) === program) {
				programs.delete(site.slug);
				clearProgramDomains(program);
				log(`${site.slug}: the link program is gone`);
			}
			if (program.swapPending) {
				program.swapPending.reject(new Error("program disconnected"));
				program.swapPending = null;
			}
			program.uploadQueue.length = 0;
			for (const stream of [...program.streams.values()]) stream.gone();
			checkDrained();
		};
		if (old) {
			old.ws.close(CLOSE.replaced, "replaced");
			old.uploadQueue.length = 0;
			for (const stream of [...old.streams.values()]) stream.gone();
		}
		program.send(
			TYPE.hello,
			0,
			Buffer.from(
				JSON.stringify({
					key: result.key,
					url: `https://${site.host}/`,
					port: result.port,
					window: streamWindowBytes,
				}),
			),
		);
		log(`${site.slug}: a link program connected${old ? ", replacing the one before" : ""}`);
	}

	async function upgrade(req, socket, head) {
		socket.on("error", () => socket.destroy());
		const lang = language(req.headers["accept-language"]);
		const text = TEXT[lang];
		const path = (req.url ?? "").split("?")[0];
		if (path !== "/.qorpera/connect") {
			const site = resolveSiteHost(req.headers["x-forwarded-host"]);
			if (!site) return rawAnswer(socket, 404, messagePage(lang, text.notFound, text.nothing));
			return upgradeVisitor(req, socket, head, lang, site);
		}
		const site = appHost(req.headers["x-forwarded-host"], hostSuffix);
		if (!site) return rawAnswer(socket, 404, messagePage(lang, text.notFound, text.nothing));
		const accept = req.method === "GET" ? acceptKey(req.headers) : null;
		if (!accept) return rawAnswer(socket, 400, messagePage(lang, text.notFound, text.nothing));
		const opened = () => {
			socket.write(
				`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
			);
			return new WebSocketConnection(socket, head, {
				maxPayload: Math.max(MAX_FRAME_BYTES, maxWsMessageBytes + 64),
				maxQueued: maxQueuedBytes,
			});
		};
		const secret = /^Bearer (\S+)$/.exec(String(req.headers.authorization ?? ""))?.[1];
		const id = req.headers["x-qorpera-program"];
		if (!secret || !SECRET.test(secret) || typeof id !== "string" || !PROGRAM_ID.test(id))
			return opened().close(CLOSE.refused, "refused");
		const address = clientAddress(req.headers["cf-connecting-ip"]);
		const releaseAdmit = admit(address, site.slug);
		if (!releaseAdmit)
			return rawAnswer(socket, 429, messagePage(lang, text.unavailable, text.again), { "retry-after": "30" });
		socket.pause();
		upgrading.add(socket);
		try {
			let result;
			try {
				result = parseConnectAnswer(
					await rpc("qorpera_site_app_connect", { p_slug: site.slug, p_secret: secret, p_program: id }),
				);
			} catch (error) {
				failure(error);
				return rawAnswer(socket, 503, messagePage(lang, text.unavailable, text.again), { "retry-after": "10" });
			}
			if (result.state !== "ok") {
				log(`${site.slug}: a link program was refused`);
				recordRefusal(address, site.slug);
			}
			if (socket.destroyed) return;
			const ws = opened();
			if (result.state !== "ok") return ws.close(CLOSE.refused, "refused");
			register(site, ws, secret, id, result);
		} finally {
			upgrading.delete(socket);
			releaseAdmit();
		}
	}

	function requestSwapTarget(slug, newPort, { healthPath = "", timeoutMs = 5_000 } = {}) {
		const program = programs.get(slug);
		if (!program || program.ws.closed) return Promise.reject(new Error("program not connected"));
		if (!Number.isInteger(newPort) || newPort < 1 || newPort > 65535) return Promise.reject(new Error("invalid port"));
		if (program.swapPending) return Promise.reject(new Error("swap already in progress"));
		return new Promise((resolve, reject) => {
			const deadline = setTimeout(() => {
				if (program.swapPending) {
					program.swapPending = null;
					reject(new Error("swap timed out"));
				}
			}, timeoutMs + 1_000);
			deadline.unref();
			program.swapPending = {
				resolve: (value) => {
					clearTimeout(deadline);
					resolve(value);
				},
				reject: (error) => {
					clearTimeout(deadline);
					reject(error);
				},
			};
			program.send(TYPE.swapTarget, 0, Buffer.from(JSON.stringify({ port: newPort, healthPath, timeoutMs })));
		});
	}

	const wsSessionCheckMs = sessionCacheMs > 0 ? sessionCacheMs : SESSION_CACHE_MS;

	function sweep() {
		const now = Date.now();
		for (const program of programs.values()) {
			if (now - program.ws.lastSeen > silentMs) {
				log(`${program.slug}: the link program went silent`);
				program.ws.terminate();
				continue;
			}
			if (now - program.keptAliveAt >= keepaliveMs) {
				program.keptAliveAt = now;
				program.send(TYPE.keepalive, 0);
			}
			for (const visitor of [...program.wsStreams]) {
				if (now - visitor.ws.lastSeen > wsIdleMs) {
					visitor.idleClose();
					continue;
				}
				if (now - visitor.pingedAt >= wsPingMs) {
					visitor.pingedAt = now;
					visitor.ws.ping();
				}
				if (!visitor.rechecking && now - visitor.checkedAt >= wsSessionCheckMs) {
					visitor.rechecking = true;
					visitor.checkedAt = now;
					sessionLookup(visitor.lookupKey, visitor.token)
						.then((found) => {
							visitor.rechecking = false;
							if (!program.wsStreams.has(visitor)) return;
							if (!found.open || found.siteId !== visitor.siteId) visitor.sessionEnded();
						})
						.catch((error) => {
							visitor.rechecking = false;
							failure(error);
						});
				}
			}
			if (recheckMs > 0 && now >= program.nextCheckAt) {
				program.nextCheckAt = scheduleCheck(now);
				rpc("qorpera_site_app_connect", { p_slug: program.slug, p_secret: program.key, p_program: program.id })
					.then((value) => {
						const result = parseConnectAnswer(value);
						if (programs.get(program.slug) !== program) return;
						if (result.state !== "ok") drop(program, "its key no longer holds");
						else if (result.siteId !== program.siteId) drop(program, "its site is gone");
						else {
							program.authMode = result.authMode ?? "password";
							syncProgramDomains(program, result.domains ?? []);
							if (result.port !== program.port && !program.swapPending) {
								void requestSwapTarget(program.slug, result.port)
									.then((ack) => {
										if (programs.get(program.slug) !== program) return;
										if (!ack?.ok) drop(program, "the shared port changed", CLOSE.portChanged);
									})
									.catch(() => {
										if (programs.get(program.slug) === program)
											drop(program, "the shared port changed", CLOSE.portChanged);
									});
							}
						}
					})
					.catch(failure);
			}
		}
		for (const [id, kept] of sessions) if (kept.until <= now) sessions.delete(id);
		for (const [id, kept] of lockedSessions) if (kept.until <= now) lockedSessions.delete(id);
		for (const [id, entry] of refusals) if (now - entry.start >= 60_000) refusals.delete(id);
		for (const [id, entry] of addressRefusals) if (now - entry.start >= 60_000) addressRefusals.delete(id);
		for (const [id, entry] of publicHits) if (now - entry.updatedAt >= 120_000) publicHits.delete(id);
	}

	const server = createServer(handle);
	server.keepAliveTimeout = 375_000;
	server.headersTimeout = 380_000;
	server.on("upgrade", (req, socket, head) => {
		upgrade(req, socket, head).catch((error) => {
			failure(error);
			socket.destroy();
		});
	});
	const timer = setInterval(
		sweep,
		Math.max(50, Math.min(keepaliveMs, silentMs, wsPingMs, wsIdleMs, wsSessionCheckMs, recheckMs || 5000, 5000) / 2),
	);
	timer.unref();
	const close = server.close.bind(server);
	server.close = (callback) => {
		clearInterval(timer);
		for (const program of programs.values()) {
			for (const stream of [...program.streams.values()]) stream.gone();
			program.ws.close(1001, "going away");
		}
		for (const socket of upgrading) socket.destroy();
		close(callback);
		server.closeAllConnections();
		return server;
	};
	server.drain = async (timeoutMs = gracefulShutdownMs) => {
		draining = true;
		const closedPromise = new Promise((resolve) => close(resolve));
		if (totalActiveStreams() > 0) {
			await new Promise((resolve) => {
				let settled = false;
				const doneWait = () => {
					if (settled) return;
					settled = true;
					clearTimeout(deadline);
					drainWaiters.delete(doneWait);
					resolve();
				};
				const deadline = setTimeout(doneWait, Math.max(0, timeoutMs));
				deadline.unref();
				drainWaiters.add(doneWait);
				checkDrained();
			});
		}
		clearInterval(timer);
		for (const program of programs.values()) {
			for (const stream of [...program.streams.values()]) stream.gone();
			program.ws.close(1001, "going away");
		}
		for (const socket of upgrading) socket.destroy();
		server.closeAllConnections();
		await closedPromise;
	};
	server.isConnected = (slug) => programs.has(slug);
	server.dropProgram = (slug) => programs.get(slug)?.ws.terminate();
	server.pauseCount = (slug) => programs.get(slug)?.pauseCount ?? 0;
	server.windowUpdates = (slug) => programs.get(slug)?.windowUpdates ?? 0;
	server.sharedProgressChecks = (slug) => programs.get(slug)?.sharedProgressChecks ?? 0;
	server.wsCount = (slug) => programs.get(slug)?.wsCount ?? 0;
	server.programHealth = (slug) => {
		const program = programs.get(slug);
		if (!program)
			return {
				connected: false,
				healthy: false,
				port: null,
				lastStatus: null,
				lastLatencyMs: null,
				restartCount: 0,
				checkedAt: null,
			};
		return { ...program.health };
	};
	server.swapTarget = requestSwapTarget;
	return server;
}

export function main(env = process.env) {
	const required = (name) => {
		const value = env[name]?.trim();
		if (!value) throw new Error(`${name} is not set`);
		return value;
	};
	const parsedMaxBody = env.QORPERA_APP_RELAY_MAX_BODY_BYTES ? Number(env.QORPERA_APP_RELAY_MAX_BODY_BYTES) : MAX_BODY_BYTES;
	const parsedShutdownMs = env.QORPERA_APP_RELAY_GRACEFUL_SHUTDOWN_MS
		? Number(env.QORPERA_APP_RELAY_GRACEFUL_SHUTDOWN_MS)
		: GRACEFUL_SHUTDOWN_MS;
	const server = createRelay({
		api: required("QORPERA_API"),
		apiKey: required("QORPERA_API_KEY"),
		relayJwt: required("QORPERA_RELAY_JWT"),
		hostSuffix: env.QORPERA_APP_HOST_SUFFIX?.trim() || DEFAULT_HOST_SUFFIX,
		webOrigins: parseWebOrigins(env.QORPERA_WEB_ORIGINS),
		maxBodyBytes: Number.isFinite(parsedMaxBody) && parsedMaxBody > 0 ? parsedMaxBody : MAX_BODY_BYTES,
		gracefulShutdownMs:
			Number.isFinite(parsedShutdownMs) && parsedShutdownMs >= 0 ? parsedShutdownMs : GRACEFUL_SHUTDOWN_MS,
		trustedAddresses: (env.QORPERA_APP_RELAY_TRUSTED_ADDRESSES ?? "")
			.split(",")
			.map((value) => value.trim())
			.filter(Boolean),
	});
	const port = Number(env.QORPERA_APP_RELAY_PORT ?? 8090);
	server.listen(port, "0.0.0.0", () => {
		console.log(`app-relay: listening on :${port}`);
		if (!env.QORPERA_APP_RELAY_TRUSTED_ADDRESSES?.trim())
			console.warn("app-relay: QORPERA_APP_RELAY_TRUSTED_ADDRESSES is empty: set the agent exit's public addresses");
	});
	for (const signal of ["SIGTERM", "SIGINT"])
		process.once(signal, () => {
			void server.drain().finally(() => process.exit(0));
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
