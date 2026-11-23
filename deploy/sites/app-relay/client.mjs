#!/usr/bin/env node

import { createHash, randomBytes } from "node:crypto";
import { Agent, request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { connect as tcpConnect } from "node:net";

const HEAD = 1;
const BODY = 2;
const END = 3;
const RESPONSE = 4;
const RESET = 5;
const HELLO = 6;
const KEEPALIVE = 7;
const WS_OPEN = 8;
const WS_OPEN_OK = 9;
const WS_DATA = 10;
const WS_CLOSE = 11;
const WINDOW = 12;
const HEALTH = 13;
const SWAP_TARGET = 14;
const REFUSED = 4001;
const REPLACED = 4002;
const CHUNK = 64 * 1024;
const MAX_WS_MESSAGE = 1024 * 1024;
const MAX_WS_QUEUED = 4 * 1024 * 1024;
const MAX_UPLOAD_BUFFER = 128 * 1024 * 1024;
const MAX_TUNNEL_QUEUED = 4 * 1024 * 1024;
const DEFAULT_HEALTH_INTERVAL_MS = 10_000;
const DEFAULT_DRAIN_MS = 30_000;
const HEALTH_PROBE_TIMEOUT_MS = 3_000;
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const WS_UTF8 = new TextDecoder("utf-8", { fatal: true });
const WS_TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const EMPTY = Buffer.alloc(0);
const WS_SKIP_REQ_HEADERS = new Set([
	"connection",
	"upgrade",
	"keep-alive",
	"proxy-connection",
	"transfer-encoding",
	"content-length",
	"sec-websocket-key",
	"sec-websocket-version",
	"sec-websocket-extensions",
	"sec-websocket-accept",
	"sec-websocket-protocol",
]);
const WS_SKIP_RES_HEADERS = new Set([
	"connection",
	"upgrade",
	"sec-websocket-accept",
	"sec-websocket-protocol",
	"sec-websocket-extensions",
]);

const [slug = "", portText = "", claim = "", suffix = "-preview.qorpera.com"] = process.argv.slice(2);
const given = Number(portText);
if (
	!/^[a-z0-9][a-z0-9-]{1,46}[a-z0-9]$/.test(slug) ||
	!Number.isInteger(given) ||
	given < 1 ||
	given > 65535 ||
	!claim ||
	!/^[-.][a-z0-9.-]*\.[a-z0-9-]+$/.test(suffix)
) {
	console.error("Usage: node client.mjs <slug> <port> <claim> [host suffix]");
	process.exit(2);
}
const url = `https://${slug}${suffix}/`;
const connectUrl = `${process.env.QORPERA_APP_RELAY_ORIGIN || `wss://${slug}${suffix}`}/.qorpera/connect`;
const healthPath = (process.env.QORPERA_APP_HEALTH_PATH ?? "").trim();
const healthIntervalMs = Math.max(
	50,
	Number(process.env.QORPERA_APP_HEALTH_INTERVAL_MS) || DEFAULT_HEALTH_INTERVAL_MS,
);
const drainTimeoutMs = Math.max(100, Number(process.env.QORPERA_APP_DRAIN_MS) || DEFAULT_DRAIN_MS);
const httpAgent = new Agent({ keepAlive: true, maxSockets: 256, maxFreeSockets: 64 });

let secret = claim;
const programId = randomBytes(32).toString("base64url");
let holdsKey = false;
let port = null;
let delay = 1000;
let appAnswers = true;
let current = null;
let shuttingDown = false;
let reconnectTimer = null;
let restartCount = Math.max(0, Number(process.env.QORPERA_APP_RESTART_COUNT) || 0);
let lastHealthState = null;

function isValidCloseCode(code) {
	return (
		Number.isInteger(code) &&
		((code >= 1000 && code <= 1003) || (code >= 1007 && code <= 1014) || (code >= 3000 && code <= 4999))
	);
}

function sanitizeCloseCode(code, fallback = 1000) {
	return isValidCloseCode(code) ? code : fallback;
}

function truncateUtf8(text, maxBytes = 123) {
	const buf = Buffer.from(String(text ?? ""), "utf8");
	if (buf.length <= maxBytes) return buf;
	let end = maxBytes;
	while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
	return buf.subarray(0, end);
}

function encodeWsClose(code = 1000, reason = "") {
	const safeCode = sanitizeCloseCode(code);
	const text = truncateUtf8(reason, 123);
	const payload = Buffer.allocUnsafe(2 + text.length);
	payload.writeUInt16BE(safeCode, 0);
	text.copy(payload, 2);
	return payload;
}

function decodeWsClose(payload) {
	if (!payload || payload.length < 2) return { code: 1000, reason: "" };
	const code = sanitizeCloseCode(payload.readUInt16BE(0));
	let reason = "";
	try {
		reason = WS_UTF8.decode(payload.subarray(2));
	} catch {
		reason = "";
	}
	return { code, reason };
}

function encodeClientFrame(opcode, payload = EMPTY) {
	const length = payload.length;
	const extra = length < 126 ? 0 : length < 65536 ? 2 : 8;
	const out = Buffer.allocUnsafe(2 + extra + 4 + length);
	out[0] = 0x80 | opcode;
	out[1] = 0x80 | (extra === 0 ? length : extra === 2 ? 126 : 127);
	if (extra === 2) out.writeUInt16BE(length, 2);
	if (extra === 8) out.writeBigUInt64BE(BigInt(length), 2);
	const maskAt = 2 + extra;
	const mask = randomBytes(4);
	mask.copy(out, maskAt);
	const dataAt = maskAt + 4;
	for (let i = 0; i < length; i++) out[dataAt + i] = payload[i] ^ mask[i & 3];
	return out;
}

function encodeTunnelMessageFrame(type, stream, payload = EMPTY, prefixByte = -1) {
	const hasPrefix = prefixByte >= 0;
	const headerLen = hasPrefix ? 6 : 5;
	const length = headerLen + payload.length;
	const extra = length < 126 ? 0 : length < 65536 ? 2 : 8;
	const out = Buffer.allocUnsafe(2 + extra + 4 + length);
	out[0] = 0x82;
	out[1] = 0x80 | (extra === 0 ? length : extra === 2 ? 126 : 127);
	if (extra === 2) out.writeUInt16BE(length, 2);
	if (extra === 8) out.writeBigUInt64BE(BigInt(length), 2);
	const maskAt = 2 + extra;
	const mask = randomBytes(4);
	mask.copy(out, maskAt);
	const dataAt = maskAt + 4;
	out[dataAt] = type ^ mask[0];
	out[dataAt + 1] = ((stream >>> 24) & 0xff) ^ mask[1];
	out[dataAt + 2] = ((stream >>> 16) & 0xff) ^ mask[2];
	out[dataAt + 3] = ((stream >>> 8) & 0xff) ^ mask[3];
	out[dataAt + 4] = (stream & 0xff) ^ mask[0];
	if (hasPrefix) out[dataAt + 5] = prefixByte ^ mask[1];
	const payloadAt = dataAt + headerLen;
	for (let i = 0; i < payload.length; i++) out[payloadAt + i] = payload[i] ^ mask[(headerLen + i) & 3];
	return out;
}

function peekHeaderBytes(chunks, buffered, count) {
	if (chunks.length === 1) return chunks[0];
	const out = Buffer.allocUnsafe(Math.min(count, buffered));
	let copied = 0;
	for (const chunk of chunks) {
		const take = Math.min(chunk.length, out.length - copied);
		chunk.copy(out, copied, 0, take);
		copied += take;
		if (copied >= out.length) break;
	}
	return out;
}

function nextServerFrameLength(chunks, buffered, maxPayload) {
	if (buffered < 2) return null;
	const head = peekHeaderBytes(chunks, buffered, 10);
	const fin = (head[0] & 0x80) !== 0;
	const opcode = head[0] & 0x0f;
	if (head[0] & 0x70) throw { wsCode: 1002, message: "reserved bits set" };
	if (![0x0, 0x1, 0x2, 0x8, 0x9, 0xa].includes(opcode)) throw { wsCode: 1002, message: "unknown opcode" };
	if ((head[1] & 0x80) !== 0) throw { wsCode: 1002, message: "masked frame" };
	let length = head[1] & 0x7f;
	let offset = 2;
	if (opcode >= 0x8 && (length > 125 || !fin)) throw { wsCode: 1002, message: "invalid control frame" };
	if (length === 126) {
		if (head.length < 4) return null;
		length = head.readUInt16BE(2);
		offset = 4;
	} else if (length === 127) {
		if (head.length < 10) return null;
		const declared = head.readBigUInt64BE(2);
		if (declared > BigInt(maxPayload)) throw { wsCode: 1009, message: "frame too large" };
		length = Number(declared);
		offset = 10;
	}
	if (length > maxPayload) throw { wsCode: 1009, message: "frame too large" };
	return offset + length;
}

function decodeServerFrame(buffer, maxPayload) {
	if (buffer.length < 2) return null;
	const fin = (buffer[0] & 0x80) !== 0;
	const opcode = buffer[0] & 0x0f;
	if (buffer[0] & 0x70) throw { wsCode: 1002, message: "reserved bits set" };
	if (![0x0, 0x1, 0x2, 0x8, 0x9, 0xa].includes(opcode)) throw { wsCode: 1002, message: "unknown opcode" };
	if ((buffer[1] & 0x80) !== 0) throw { wsCode: 1002, message: "masked frame" };
	let length = buffer[1] & 0x7f;
	let offset = 2;
	if (opcode >= 0x8 && (length > 125 || !fin)) throw { wsCode: 1002, message: "invalid control frame" };
	if (length === 126) {
		if (buffer.length < 4) return null;
		length = buffer.readUInt16BE(2);
		offset = 4;
	} else if (length === 127) {
		if (buffer.length < 10) return null;
		const declared = buffer.readBigUInt64BE(2);
		if (declared > BigInt(maxPayload)) throw { wsCode: 1009, message: "frame too large" };
		length = Number(declared);
		offset = 10;
	}
	if (length > maxPayload) throw { wsCode: 1009, message: "frame too large" };
	if (buffer.length < offset + length) return null;
	return { fin, opcode, payload: buffer.subarray(offset, offset + length), size: offset + length };
}

function probeLocalTarget(targetPort, probePath) {
	const startedAt = Date.now();
	if (probePath && probePath.startsWith("/")) {
		return new Promise((resolve) => {
			let settled = false;
			const finish = (healthy, status) => {
				if (settled) return;
				settled = true;
				resolve({ healthy, status, latencyMs: Math.max(0, Date.now() - startedAt) });
			};
			const req = httpRequest(
				{
					host: "127.0.0.1",
					port: targetPort,
					method: "GET",
					path: probePath,
					agent: false,
					timeout: HEALTH_PROBE_TIMEOUT_MS,
				},
				(res) => {
					res.resume();
					finish(res.statusCode >= 200 && res.statusCode < 400, res.statusCode ?? 0);
				},
			);
			req.on("timeout", () => {
				req.destroy();
				finish(false, 0);
			});
			req.on("error", () => finish(false, 0));
			req.end();
		});
	}
	return new Promise((resolve) => {
		let settled = false;
		const finish = (healthy) => {
			if (settled) return;
			settled = true;
			resolve({ healthy, status: healthy ? 200 : 0, latencyMs: Math.max(0, Date.now() - startedAt) });
		};
		const sock = tcpConnect({ host: "127.0.0.1", port: targetPort });
		sock.setTimeout(HEALTH_PROBE_TIMEOUT_MS);
		sock.once("connect", () => {
			sock.destroy();
			finish(true);
		});
		sock.once("timeout", () => {
			sock.destroy();
			finish(false);
		});
		sock.once("error", () => {
			sock.destroy();
			finish(false);
		});
	});
}

function openTunnelSocket(parsedUrl) {
	const wsKey = randomBytes(16).toString("base64");
	const expectedAccept = createHash("sha1")
		.update(wsKey + WS_GUID)
		.digest("base64");
	const isTls = parsedUrl.protocol === "wss:";
	const defaultPort = isTls ? 443 : 80;
	const requestFn = isTls ? httpsRequest : httpRequest;
	const req = requestFn({
		hostname: parsedUrl.hostname,
		port: parsedUrl.port ? Number(parsedUrl.port) : defaultPort,
		path: `${parsedUrl.pathname}${parsedUrl.search}`,
		method: "GET",
		headers: {
			Connection: "Upgrade",
			Upgrade: "websocket",
			"Sec-WebSocket-Version": "13",
			"Sec-WebSocket-Key": wsKey,
			Authorization: `Bearer ${secret}`,
			"X-Qorpera-Program": programId,
		},
		agent: false,
		...(isTls ? { servername: parsedUrl.hostname } : {}),
	});
	return { req, expectedAccept };
}

function connect() {
	if (shuttingDown) return;
	let parsedUrl;
	try {
		parsedUrl = new URL(connectUrl);
		if (parsedUrl.protocol !== "ws:" && parsedUrl.protocol !== "wss:") throw new Error("bad scheme");
	} catch {
		console.error(`The relay's address is not valid: ${connectUrl}`);
		process.exit(2);
	}
	const { req: tunnelReq, expectedAccept } = openTunnelSocket(parsedUrl);
	const session = {
		req: tunnelReq,
		socket: null,
		closed: false,
		closing: false,
		tunnelDraining: false,
		flowControlWindow: 0,
		streams: new Map(),
		wsStreams: new Map(),
		totalBufferedBytes: 0,
		healthTimer: null,
		drainWaiters: [],
		finishShutdownCheck: null,
	};
	current = session;

	const maybeFinishShutdown = () => {
		if (!shuttingDown || session.streams.size > 0 || session.wsStreams.size > 0) return;
		session.finishShutdownCheck?.();
	};

	const notifyTunnelDrain = () => {
		if (!session.socket || session.socket.destroyed) return;
		if (session.socket.writableLength >= MAX_TUNNEL_QUEUED) return;
		session.tunnelDraining = false;
		const waiters = session.drainWaiters.splice(0);
		for (const wake of waiters) wake();
	};

	const waitTunnelDrain = (wake) => {
		session.drainWaiters.push(wake);
		if (!session.tunnelDraining && session.socket && !session.socket.destroyed) {
			session.tunnelDraining = true;
			session.socket.once("drain", notifyTunnelDrain);
		}
	};

	const send = (type, stream, payload = EMPTY, prefixByte = -1) => {
		if (session.closed || session.closing || !session.socket || session.socket.destroyed) return false;
		const frame = encodeTunnelMessageFrame(type, stream, payload, prefixByte);
		const room = session.socket.write(frame);
		if (!room || session.socket.writableLength >= MAX_TUNNEL_QUEUED) {
			if (!session.tunnelDraining) {
				session.tunnelDraining = true;
				session.socket.once("drain", notifyTunnelDrain);
			}
			return false;
		}
		return true;
	};

	let lastSeen = Date.now();
	const watch = setInterval(() => {
		if (Date.now() - lastSeen > 60_000) lost();
	}, 5000);
	watch.unref();

	function syncUploadBuffered(entry, nextValue) {
		const next = Math.max(0, nextValue);
		const delta = next - entry.bufferedBytes;
		if (delta !== 0) {
			entry.bufferedBytes = next;
			session.totalBufferedBytes = Math.max(0, session.totalBufferedBytes + delta);
		}
	}

	function cleanupHttpStream(id, entry) {
		if (session.streams.get(id) !== entry) return false;
		session.streams.delete(id);
		syncUploadBuffered(entry, 0);
		entry.uploadPending.length = 0;
		entry.pendingChunks.length = 0;
		maybeFinishShutdown();
		return true;
	}

	async function sendHealthProbe() {
		if (session.closed || session.closing || port === null || shuttingDown) return;
		const probedPort = port;
		const result = await probeLocalTarget(probedPort, healthPath);
		if (session.closed || session.closing || current !== session) return;
		if (lastHealthState === false && result.healthy) restartCount++;
		lastHealthState = result.healthy;
		send(
			HEALTH,
			0,
			Buffer.from(
				JSON.stringify({
					connected: true,
					healthy: result.healthy,
					port: probedPort,
					lastStatus: result.status,
					lastLatencyMs: result.latencyMs,
					restartCount,
					checkedAt: Date.now(),
				}),
			),
		);
	}

	async function handleSwapTarget(payload) {
		let spec;
		try {
			spec = JSON.parse(payload.toString("utf8"));
		} catch {
			return send(SWAP_TARGET, 0, Buffer.from(JSON.stringify({ ok: false, activePort: port, error: "invalid" })));
		}
		const targetPort = spec?.port;
		if (!Number.isInteger(targetPort) || targetPort < 1 || targetPort > 65535) {
			return send(SWAP_TARGET, 0, Buffer.from(JSON.stringify({ ok: false, activePort: port, error: "bad port" })));
		}
		const probePath = typeof spec.healthPath === "string" ? spec.healthPath : healthPath;
		const deadline = Date.now() + Math.min(30_000, Math.max(200, Number(spec.timeoutMs) || 5_000));
		let probe = await probeLocalTarget(targetPort, probePath);
		while (!probe.healthy && Date.now() < deadline && !session.closed && !shuttingDown) {
			await new Promise((resolve) => setTimeout(resolve, 100));
			probe = await probeLocalTarget(targetPort, probePath);
		}
		if (!probe.healthy) {
			return send(
				SWAP_TARGET,
				0,
				Buffer.from(JSON.stringify({ ok: false, activePort: port, error: "target unhealthy" })),
			);
		}
		const previousPort = port;
		port = targetPort;
		appAnswers = true;
		send(
			SWAP_TARGET,
			0,
			Buffer.from(
				JSON.stringify({
					ok: true,
					activePort: targetPort,
					previousPort,
					drainingStreams: session.streams.size + session.wsStreams.size,
				}),
			),
		);
	}

	function lost(code) {
		if (current !== session || session.closed) return;
		session.closed = true;
		current = null;
		clearInterval(watch);
		if (session.healthTimer) {
			clearInterval(session.healthTimer);
			session.healthTimer = null;
		}
		session.drainWaiters.length = 0;
		for (const entry of session.streams.values()) entry.app.destroy();
		session.streams.clear();
		session.totalBufferedBytes = 0;
		for (const upstream of session.wsStreams.values()) upstream.destroy();
		session.wsStreams.clear();
		session.socket?.destroy();
		if (shuttingDown) {
			httpAgent.destroy();
			process.exit(0);
		}
		if (code === REFUSED) {
			httpAgent.destroy();
			console.log(
				holdsKey
					? "The relay refused this program: the link was turned off or shared again. Stopping."
					: "The relay refused the claim: it was used already or has expired. Ask the agent to share the app again.",
			);
			process.exit(1);
		}
		if (code === REPLACED) {
			httpAgent.destroy();
			console.log("A newer link program took over this link. Stopping.");
			process.exit(0);
		}
		console.log("Lost the connection, trying again");
		const jittered = Math.round(delay * (0.75 + Math.random() * 0.5));
		reconnectTimer = setTimeout(connect, jittered);
		delay = Math.min(delay * 2, 30_000);
	}

	function handleMessage(data) {
		if (current !== session || session.closed) return;
		lastSeen = Date.now();
		if (data.length < 5) return;
		const type = data[0];
		const id = data.readUInt32BE(1);
		const payload = data.subarray(5);
		if (type === HELLO) hello(payload);
		else if (type === KEEPALIVE) send(KEEPALIVE, 0);
		else if (type === SWAP_TARGET) void handleSwapTarget(payload);
		else if (type === WINDOW) handleWindow(id, payload);
		else if (type === HEAD) start(id, payload);
		else if (type === BODY) handleBody(id, payload);
		else if (type === END) handleEnd(id);
		else if (type === RESET) handleReset(id);
		else if (type === WS_OPEN) openWs(id, payload);
		else if (type === WS_DATA) wsData(id, payload);
		else if (type === WS_CLOSE) wsClose(id, payload);
	}

	function handleWindow(id, payload) {
		if (payload.length !== 4) return;
		const delta = payload.readUInt32BE(0);
		if (delta === 0) return;
		const httpEntry = session.streams.get(id);
		if (httpEntry) {
			httpEntry.sendCredits = Math.min(httpEntry.maxWindow, httpEntry.sendCredits + delta);
			httpEntry.pumpResponse();
			return;
		}
		const wsEntry = session.wsStreams.get(id);
		if (wsEntry) {
			wsEntry.sendCredits = Math.min(wsEntry.maxWindow, wsEntry.sendCredits + delta);
			wsEntry.pumpUpstream();
		}
	}

	function handleBody(id, payload) {
		const entry = session.streams.get(id);
		if (!entry || entry.uploadClosed || entry.app.destroyed || entry.app.writableEnded) return;
		const queuedPending = entry.uploadPendingBytes;
		const liveWritable = entry.app.writableLength;
		syncUploadBuffered(entry, liveWritable + queuedPending);
		if (session.totalBufferedBytes + payload.length > MAX_UPLOAD_BUFFER) {
			cleanupHttpStream(id, entry);
			entry.app.destroy();
			send(RESET, id);
			return;
		}
		if (entry.uploadDraining || entry.uploadPending.length > 0) {
			entry.uploadPending.push(Buffer.from(payload));
			entry.uploadPendingBytes += payload.length;
			syncUploadBuffered(entry, entry.app.writableLength + entry.uploadPendingBytes);
			return;
		}
		const room = entry.app.write(payload);
		syncUploadBuffered(entry, entry.app.writableLength);
		if (!room) {
			entry.uploadDraining = true;
			entry.app.once("drain", entry.flushUpload);
		}
	}

	function handleEnd(id) {
		const entry = session.streams.get(id);
		if (!entry || entry.uploadClosed || entry.app.destroyed || entry.app.writableEnded) return;
		if (entry.uploadDraining || entry.uploadPending.length > 0) {
			entry.uploadEndRequested = true;
			return;
		}
		entry.app.end();
	}

	function handleReset(id) {
		const entry = session.streams.get(id);
		if (entry) {
			cleanupHttpStream(id, entry);
			entry.app.destroy();
		}
		const upstream = session.wsStreams.get(id);
		if (upstream) {
			session.wsStreams.delete(id);
			upstream.destroy();
			maybeFinishShutdown();
		}
	}

	function hello(payload) {
		let said = {};
		try {
			said = JSON.parse(payload.toString());
		} catch {
			said = {};
		}
		if (!Number.isInteger(said?.port) || said.port < 1 || said.port > 65535) {
			console.log("The relay did not say which port this link is shared for. Stopping.");
			httpAgent.destroy();
			process.exit(1);
		}
		if (typeof said.key === "string") {
			secret = said.key;
			holdsKey = true;
		}
		if (Number.isInteger(said.window) && said.window > 0) {
			session.flowControlWindow = said.window;
		}
		if (said.port !== port && said.port !== given)
			console.log(`This link is shared for port ${said.port}, not ${given}: serving port ${said.port}.`);
		port = said.port;
		delay = 1000;
		console.log(`Connected: ${url}`);
		if (!session.healthTimer) {
			session.healthTimer = setInterval(() => {
				void sendHealthProbe();
			}, healthIntervalMs);
			session.healthTimer.unref();
			if (healthPath || process.env.QORPERA_APP_HEALTH_INTERVAL_MS) {
				void sendHealthProbe();
			}
		}
	}

	function start(id, payload) {
		if (shuttingDown) return send(RESET, id);
		let app;
		const targetPort = port;
		try {
			const head = JSON.parse(payload.toString());
			if (targetPort === null) throw new Error("No port yet");
			app = httpRequest({
				host: "127.0.0.1",
				port: targetPort,
				method: head.method,
				path: head.path,
				headers: head.headers.flat(),
				agent: httpAgent,
			});
		} catch {
			return send(RESET, id);
		}
		const flowWindow = session.flowControlWindow > 0 ? session.flowControlWindow : Number.POSITIVE_INFINITY;
		const entry = {
			app,
			response: null,
			answered: false,
			uploadClosed: false,
			uploadDraining: false,
			uploadEndRequested: false,
			uploadPending: [],
			uploadPendingBytes: 0,
			bufferedBytes: 0,
			sendCredits: flowWindow,
			maxWindow: Number.isFinite(flowWindow) ? flowWindow * 4 : Number.POSITIVE_INFINITY,
			pendingChunks: [],
			upstreamEnded: false,
			waitingTunnel: false,
			flushUpload() {
				entry.uploadDraining = false;
				if (session.streams.get(id) !== entry || entry.uploadClosed || app.destroyed || app.writableEnded) {
					syncUploadBuffered(entry, 0);
					return;
				}
				while (entry.uploadPending.length > 0) {
					const next = entry.uploadPending.shift();
					entry.uploadPendingBytes = Math.max(0, entry.uploadPendingBytes - next.length);
					const room = app.write(next);
					syncUploadBuffered(entry, app.writableLength + entry.uploadPendingBytes);
					if (!room) {
						entry.uploadDraining = true;
						app.once("drain", entry.flushUpload);
						return;
					}
				}
				syncUploadBuffered(entry, app.writableLength);
				if (entry.uploadEndRequested) {
					entry.uploadEndRequested = false;
					app.end();
				}
			},
			pumpResponse() {
				if (session.streams.get(id) !== entry || session.closed) return;
				while (entry.pendingChunks.length > 0 && entry.sendCredits > 0) {
					if (session.tunnelDraining && session.socket && session.socket.writableLength >= MAX_TUNNEL_QUEUED) {
						if (entry.response && !entry.response.isPaused()) entry.response.pause();
						if (!entry.waitingTunnel) {
							entry.waitingTunnel = true;
							waitTunnelDrain(() => {
								entry.waitingTunnel = false;
								entry.pumpResponse();
							});
						}
						return;
					}
					const chunk = entry.pendingChunks[0];
					const limit = Number.isFinite(entry.sendCredits) ? Math.min(CHUNK, entry.sendCredits) : CHUNK;
					const take = Math.min(chunk.length, limit);
					const slice = take === chunk.length ? entry.pendingChunks.shift() : chunk.subarray(0, take);
					if (take < chunk.length) entry.pendingChunks[0] = chunk.subarray(take);
					if (Number.isFinite(entry.sendCredits)) entry.sendCredits -= slice.length;
					const room = send(BODY, id, slice);
					if (!room && session.socket && session.socket.writableLength >= MAX_TUNNEL_QUEUED) {
						if (entry.response && !entry.response.isPaused()) entry.response.pause();
						if (!entry.waitingTunnel) {
							entry.waitingTunnel = true;
							waitTunnelDrain(() => {
								entry.waitingTunnel = false;
								entry.pumpResponse();
							});
						}
						return;
					}
				}
				if (entry.pendingChunks.length === 0 && entry.upstreamEnded) {
					cleanupHttpStream(id, entry);
					send(END, id);
					if (!app.writableEnded) app.destroy();
					return;
				}
				if (entry.response) {
					if (entry.sendCredits <= 0 || entry.pendingChunks.length > 0) {
						if (!entry.response.isPaused()) entry.response.pause();
					} else if (entry.response.isPaused()) {
						entry.response.resume();
					}
				}
			},
		};
		session.streams.set(id, entry);
		const reset = () => {
			if (!cleanupHttpStream(id, entry)) return;
			send(RESET, id);
		};
		app.on("response", (response) => {
			entry.answered = true;
			entry.response = response;
			// WHY: 413 means the app rejected the upload payload; stop writing more BODY/END frames so a closed app socket does not TCP-RST unread response bytes under backpressure.
			if (response.statusCode === 413) {
				entry.uploadClosed = true;
				entry.uploadPending.length = 0;
				entry.uploadPendingBytes = 0;
				syncUploadBuffered(entry, 0);
			}
			if (!appAnswers) console.log(`The app on port ${targetPort} answers again`);
			appAnswers = true;
			const headers = [];
			for (let i = 0; i < response.rawHeaders.length; i += 2)
				headers.push([response.rawHeaders[i], response.rawHeaders[i + 1]]);
			send(RESPONSE, id, Buffer.from(JSON.stringify({ status: response.statusCode, headers })));
			response.on("data", (chunk) => {
				if (session.streams.get(id) !== entry) return;
				entry.pendingChunks.push(chunk);
				entry.pumpResponse();
			});
			response.on("end", () => {
				if (session.streams.get(id) !== entry) return;
				entry.upstreamEnded = true;
				entry.pumpResponse();
			});
			response.on("error", reset);
			response.on("close", () => {
				if (!response.complete) reset();
			});
		});
		app.on("error", () => {
			if (session.streams.get(id) !== entry) return;
			reset();
			if (!entry.answered && appAnswers) {
				appAnswers = false;
				console.log(`The app on port ${targetPort} is not answering`);
			}
		});
	}

	function openWs(id, payload) {
		if (shuttingDown || port === null || session.streams.has(id) || session.wsStreams.has(id)) return send(RESET, id);
		const targetPort = port;
		let head;
		try {
			head = JSON.parse(payload.toString("utf8"));
		} catch {
			return send(RESET, id);
		}
		if (typeof head?.path !== "string" || !head.path.startsWith("/") || !Array.isArray(head?.headers))
			return send(RESET, id);
		const outgoing = [];
		const offeredProtocols = [];
		for (const pair of head.headers) {
			if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== "string" || typeof pair[1] !== "string")
				return send(RESET, id);
			const lower = pair[0].toLowerCase();
			if (lower === "sec-websocket-protocol") {
				for (const part of pair[1].split(",")) {
					const token = part.trim();
					if (token && WS_TOKEN.test(token) && !offeredProtocols.includes(token)) offeredProtocols.push(token);
				}
				continue;
			}
			if (WS_SKIP_REQ_HEADERS.has(lower)) continue;
			outgoing.push([pair[0], pair[1]]);
		}
		const wsKey = randomBytes(16).toString("base64");
		const expectedWsAccept = createHash("sha1")
			.update(wsKey + WS_GUID)
			.digest("base64");
		outgoing.push(
			["Connection", "Upgrade"],
			["Upgrade", "websocket"],
			["Sec-WebSocket-Version", "13"],
			["Sec-WebSocket-Key", wsKey],
		);
		if (offeredProtocols.length > 0) outgoing.push(["Sec-WebSocket-Protocol", offeredProtocols.join(", ")]);
		let req;
		try {
			req = httpRequest({
				host: "127.0.0.1",
				port: targetPort,
				method: "GET",
				path: head.path,
				headers: outgoing.flat(),
				agent: false,
			});
		} catch {
			return send(RESET, id);
		}
		const flowWindow = session.flowControlWindow > 0 ? session.flowControlWindow : Number.POSITIVE_INFINITY;
		const entry = {
			req,
			socket: null,
			opened: false,
			closing: false,
			closeTimer: null,
			sendCredits: flowWindow,
			maxWindow: Number.isFinite(flowWindow) ? flowWindow * 4 : Number.POSITIVE_INFINITY,
			pendingFrames: [],
			waitingTunnel: false,
			clearTimers() {
				if (entry.closeTimer) {
					clearTimeout(entry.closeTimer);
					entry.closeTimer = null;
				}
			},
			pumpUpstream() {
				if (session.wsStreams.get(id) !== entry || !entry.opened || entry.closing || session.closed) return;
				while (entry.pendingFrames.length > 0 && entry.sendCredits > 0) {
					if (session.tunnelDraining && session.socket && session.socket.writableLength >= MAX_TUNNEL_QUEUED) {
						if (entry.socket && !entry.socket.isPaused()) entry.socket.pause();
						if (!entry.waitingTunnel) {
							entry.waitingTunnel = true;
							waitTunnelDrain(() => {
								entry.waitingTunnel = false;
								entry.pumpUpstream();
							});
						}
						return;
					}
					const next = entry.pendingFrames.shift();
					if (Number.isFinite(entry.sendCredits)) entry.sendCredits -= next.data.length;
					const room = send(WS_DATA, id, next.data, next.opcode);
					if (!room && session.socket && session.socket.writableLength >= MAX_TUNNEL_QUEUED) {
						if (entry.socket && !entry.socket.isPaused()) entry.socket.pause();
						if (!entry.waitingTunnel) {
							entry.waitingTunnel = true;
							waitTunnelDrain(() => {
								entry.waitingTunnel = false;
								entry.pumpUpstream();
							});
						}
						return;
					}
				}
				if (entry.socket && !entry.socket.destroyed) {
					if (entry.sendCredits <= 0 || entry.pendingFrames.length > 0) {
						if (!entry.socket.isPaused()) entry.socket.pause();
					} else if (entry.socket.isPaused()) {
						entry.socket.resume();
					}
				}
			},
			writeFrame(opcode, data) {
				if (!entry.opened || entry.closing || !entry.socket || entry.socket.destroyed) return false;
				const frame = encodeClientFrame(opcode, data);
				if (entry.socket.writableLength + frame.length > MAX_WS_QUEUED) {
					entry.abort(1001, "upstream stalled");
					return false;
				}
				entry.socket.write(frame);
				return true;
			},
			closeFromRelay(code, reason) {
				session.wsStreams.delete(id);
				entry.clearTimers();
				entry.pendingFrames.length = 0;
				maybeFinishShutdown();
				if (!entry.opened) {
					req.destroy();
					return;
				}
				if (entry.closing || !entry.socket || entry.socket.destroyed) {
					entry.socket?.destroy();
					return;
				}
				entry.closing = true;
				entry.socket.write(encodeClientFrame(0x8, encodeWsClose(code, reason)));
				entry.socket.end();
				entry.closeTimer = setTimeout(() => entry.socket?.destroy(), 3000);
				entry.closeTimer.unref();
			},
			abort(code, reason) {
				if (session.wsStreams.get(id) !== entry) return;
				session.wsStreams.delete(id);
				entry.clearTimers();
				entry.pendingFrames.length = 0;
				maybeFinishShutdown();
				if (entry.opened && entry.socket && !entry.socket.destroyed && !entry.closing) {
					entry.closing = true;
					entry.socket.write(encodeClientFrame(0x8, encodeWsClose(code, reason)));
					entry.socket.end();
					entry.closeTimer = setTimeout(() => entry.socket?.destroy(), 3000);
					entry.closeTimer.unref();
				} else {
					entry.socket ? entry.socket.destroy() : req.destroy();
				}
				send(WS_CLOSE, id, encodeWsClose(code, reason));
			},
			destroy() {
				entry.clearTimers();
				entry.pendingFrames.length = 0;
				if (entry.opened && entry.socket && !entry.socket.destroyed && !entry.closing) {
					entry.closing = true;
					try {
						entry.socket.write(encodeClientFrame(0x8, encodeWsClose(1001, "tunnel closed")));
					} catch {
						entry.socket.destroy();
						return;
					}
					entry.socket.end();
					entry.closeTimer = setTimeout(() => entry.socket?.destroy(), 1000);
					entry.closeTimer.unref();
				} else {
					entry.socket ? entry.socket.destroy() : req.destroy();
				}
			},
		};
		session.wsStreams.set(id, entry);
		req.on("response", (response) => {
			response.resume();
			if (session.wsStreams.get(id) !== entry) return;
			session.wsStreams.delete(id);
			entry.clearTimers();
			maybeFinishShutdown();
			if (!appAnswers) console.log(`The app on port ${targetPort} answers again`);
			appAnswers = true;
			if (response.statusCode >= 400 && response.statusCode <= 599) {
				const buf = Buffer.allocUnsafe(2);
				buf.writeUInt16BE(response.statusCode, 0);
				send(WS_CLOSE, id, buf);
			} else {
				send(RESET, id);
			}
			req.destroy();
		});
		req.on("error", () => {
			if (session.wsStreams.get(id) !== entry || entry.opened) return;
			session.wsStreams.delete(id);
			entry.clearTimers();
			maybeFinishShutdown();
			send(RESET, id);
			if (appAnswers) {
				appAnswers = false;
				console.log(`The app on port ${targetPort} is not answering`);
			}
		});
		req.on("upgrade", (response, socket, headBuf) => {
			if (session.wsStreams.get(id) !== entry) {
				socket.destroy();
				return;
			}
			const connTokens = String(response.headers.connection ?? "")
				.toLowerCase()
				.split(",")
				.map((token) => token.trim());
			const protoHeaders = [];
			const acceptHeaders = [];
			const resHeaders = [];
			let hasExtensions = false;
			for (let i = 0; i + 1 < response.rawHeaders.length; i += 2) {
				const name = response.rawHeaders[i];
				const value = response.rawHeaders[i + 1];
				const lower = name.toLowerCase();
				if (lower === "sec-websocket-protocol") protoHeaders.push(value.trim());
				else if (lower === "sec-websocket-accept") acceptHeaders.push(value.trim());
				else if (lower === "sec-websocket-extensions" && value.trim() !== "") hasExtensions = true;
				else if (!WS_SKIP_RES_HEADERS.has(lower)) resHeaders.push([name, value]);
			}
			const okBody = {};
			if (protoHeaders.length === 1) okBody.protocol = protoHeaders[0];
			if (resHeaders.length > 0) okBody.headers = resHeaders;
			const okPayload = Buffer.from(JSON.stringify(okBody));
			const validUpgrade =
				response.statusCode === 101 &&
				String(response.headers.upgrade ?? "").toLowerCase() === "websocket" &&
				connTokens.includes("upgrade") &&
				acceptHeaders.length === 1 &&
				acceptHeaders[0] === expectedWsAccept &&
				!hasExtensions &&
				protoHeaders.length <= 1 &&
				(protoHeaders.length === 0 || offeredProtocols.includes(protoHeaders[0])) &&
				okPayload.length <= 64 * 1024;
			if (!validUpgrade) {
				session.wsStreams.delete(id);
				entry.clearTimers();
				maybeFinishShutdown();
				socket.destroy();
				send(RESET, id);
				return;
			}
			entry.opened = true;
			entry.socket = socket;
			if (!appAnswers) console.log(`The app on port ${targetPort} answers again`);
			appAnswers = true;
			send(WS_OPEN_OK, id, okPayload);
			socket.setNoDelay(true);
			socket.setTimeout(0);
			socket.setKeepAlive(true, 30_000);
			let chunks = [];
			let buffered = 0;
			let fragments = null;
			let fragmentBytes = 0;
			let fragmentOpcode = 0;
			const deliver = (data, opcode) => {
				if (opcode === 1) {
					try {
						WS_UTF8.decode(data);
					} catch {
						throw { wsCode: 1007, message: "invalid utf-8" };
					}
				}
				if (
					entry.pendingFrames.length === 0 &&
					entry.sendCredits > 0 &&
					!(session.tunnelDraining && session.socket && session.socket.writableLength >= MAX_TUNNEL_QUEUED)
				) {
					if (Number.isFinite(entry.sendCredits)) entry.sendCredits -= data.length;
					const room = send(WS_DATA, id, data, opcode);
					if (
						entry.sendCredits <= 0 ||
						(!room && session.socket && session.socket.writableLength >= MAX_TUNNEL_QUEUED)
					) {
						if (!socket.isPaused()) socket.pause();
						if (!room && !entry.waitingTunnel) {
							entry.waitingTunnel = true;
							waitTunnelDrain(() => {
								entry.waitingTunnel = false;
								entry.pumpUpstream();
							});
						}
					}
					return;
				}
				entry.pendingFrames.push({ opcode, data: Buffer.from(data) });
				if (!socket.isPaused()) socket.pause();
				entry.pumpUpstream();
			};
			const onFrame = ({ fin, opcode, payload: framePayload }) => {
				if (opcode === 0x8) {
					if (framePayload.length === 1) throw { wsCode: 1002, message: "invalid close frame" };
					let code = 1000;
					let reason = "";
					if (framePayload.length >= 2) {
						code = framePayload.readUInt16BE(0);
						if (!isValidCloseCode(code)) throw { wsCode: 1002, message: "invalid close code" };
						try {
							reason = WS_UTF8.decode(framePayload.subarray(2));
						} catch {
							throw { wsCode: 1007, message: "invalid close reason" };
						}
					}
					if (!entry.closing) {
						entry.closing = true;
						socket.write(
							encodeClientFrame(0x8, framePayload.length >= 2 ? framePayload.subarray(0, 2) : EMPTY),
						);
					}
					socket.end();
					if (session.wsStreams.get(id) === entry) {
						session.wsStreams.delete(id);
						entry.clearTimers();
						maybeFinishShutdown();
						send(WS_CLOSE, id, encodeWsClose(code, reason));
					}
					return;
				}
				if (opcode === 0x9) {
					if (!entry.closing && !socket.destroyed && socket.writableLength + framePayload.length + 14 <= MAX_WS_QUEUED)
						socket.write(encodeClientFrame(0xa, framePayload));
					return;
				}
				if (opcode === 0xa || entry.closing) return;
				if (opcode === 0x1 || opcode === 0x2) {
					if (fragments) throw { wsCode: 1002, message: "a new message inside a fragmented one" };
					if (fin) return deliver(framePayload, opcode);
					fragments = [Buffer.from(framePayload)];
					fragmentBytes = framePayload.length;
					fragmentOpcode = opcode;
					return;
				}
				if (!fragments) throw { wsCode: 1002, message: "a continuation without a message" };
				fragmentBytes += framePayload.length;
				if (fragmentBytes > MAX_WS_MESSAGE) throw { wsCode: 1009, message: "message too large" };
				fragments.push(Buffer.from(framePayload));
				if (!fin) return;
				const full = Buffer.concat(fragments);
				const fullOpcode = fragmentOpcode;
				fragments = null;
				fragmentBytes = 0;
				fragmentOpcode = 0;
				deliver(full, fullOpcode);
			};
			const drain = () => {
				try {
					for (;;) {
						if (session.wsStreams.get(id) !== entry || entry.closing || socket.destroyed) return;
						const needed = nextServerFrameLength(chunks, buffered, MAX_WS_MESSAGE);
						if (needed === null || buffered < needed) return;
						const buffer = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, buffered);
						const frame = decodeServerFrame(buffer, MAX_WS_MESSAGE);
						if (!frame) return;
						const rest = buffer.subarray(frame.size);
						chunks = rest.length > 0 ? [rest] : [];
						buffered = rest.length;
						onFrame(frame);
					}
				} catch (error) {
					chunks = [];
					buffered = 0;
					entry.abort(error?.wsCode ?? 1002, error?.message ?? "protocol error");
				}
			};
			socket.on("data", (chunk) => {
				if (chunk.length > 0) {
					chunks.push(chunk);
					buffered += chunk.length;
					drain();
				}
			});
			socket.on("end", () => socket.end());
			socket.on("error", () => socket.destroy());
			socket.on("close", () => {
				entry.clearTimers();
				if (session.wsStreams.get(id) === entry) {
					session.wsStreams.delete(id);
					maybeFinishShutdown();
					send(WS_CLOSE, id, encodeWsClose(1001, ""));
				}
			});
			if (headBuf?.length) {
				chunks.push(headBuf);
				buffered = headBuf.length;
				drain();
			}
		});
		req.end();
	}

	function wsData(id, payload) {
		const entry = session.wsStreams.get(id);
		if (!entry || !entry.opened || entry.closing) return;
		if (payload.length < 1) return entry.abort(1002, "invalid message");
		const opcode = payload[0];
		if (opcode !== 1 && opcode !== 2) return entry.abort(1002, "invalid message");
		const data = payload.subarray(1);
		if (data.length > MAX_WS_MESSAGE) return entry.abort(1009, "message too large");
		entry.writeFrame(opcode, data);
	}

	function wsClose(id, payload) {
		const entry = session.wsStreams.get(id);
		if (!entry) return;
		const { code, reason } = decodeWsClose(payload);
		entry.closeFromRelay(code, reason);
	}

	tunnelReq.on("response", (res) => {
		res.resume();
		lost(res.statusCode === 401 || res.statusCode === 403 ? REFUSED : 1006);
	});
	tunnelReq.on("error", () => lost(1006));
	tunnelReq.on("upgrade", (response, socket, headBuf) => {
		if (current !== session || session.closed) {
			socket.destroy();
			return;
		}
		if (response.statusCode !== 101 || response.headers["sec-websocket-accept"] !== expectedAccept) {
			socket.destroy();
			lost(1006);
			return;
		}
		session.socket = socket;
		socket.setNoDelay(true);
		socket.setTimeout(0);
		socket.setKeepAlive(true, 30_000);
		let chunks = [];
		let buffered = 0;
		let fragments = null;
		let fragmentBytes = 0;
		let closeCode = 1006;
		const maxTunnelPayload = Math.max(MAX_WS_MESSAGE + 64, 2 * 1024 * 1024);
		const onTunnelFrame = ({ fin, opcode, payload }) => {
			lastSeen = Date.now();
			if (opcode === 0x8) {
				if (payload.length >= 2) closeCode = payload.readUInt16BE(0);
				if (!session.closing && !socket.destroyed) {
					session.closing = true;
					socket.write(encodeClientFrame(0x8, payload.length >= 2 ? payload.subarray(0, 2) : EMPTY));
					socket.end();
				}
				return;
			}
			if (opcode === 0x9) {
				if (!session.closing && !socket.destroyed) socket.write(encodeClientFrame(0xa, payload));
				return;
			}
			if (opcode === 0xa) return;
			if (opcode === 0x2) {
				if (fragments) throw { wsCode: 1002, message: "unexpected message" };
				if (fin) return handleMessage(payload);
				fragments = [Buffer.from(payload)];
				fragmentBytes = payload.length;
				return;
			}
			if (opcode === 0x0) {
				if (!fragments) throw { wsCode: 1002, message: "unexpected continuation" };
				fragmentBytes += payload.length;
				if (fragmentBytes > maxTunnelPayload) throw { wsCode: 1009, message: "frame too large" };
				fragments.push(Buffer.from(payload));
				if (!fin) return;
				const full = Buffer.concat(fragments);
				fragments = null;
				fragmentBytes = 0;
				handleMessage(full);
				return;
			}
			throw { wsCode: 1003, message: "unsupported opcode" };
		};
		const drainTunnel = () => {
			try {
				for (;;) {
					if (current !== session || session.closed || socket.destroyed) return;
					const needed = nextServerFrameLength(chunks, buffered, maxTunnelPayload);
					if (needed === null || buffered < needed) return;
					const buffer = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, buffered);
					const frame = decodeServerFrame(buffer, maxTunnelPayload);
					if (!frame) return;
					const rest = buffer.subarray(frame.size);
					chunks = rest.length > 0 ? [rest] : [];
					buffered = rest.length;
					onTunnelFrame(frame);
				}
			} catch {
				socket.destroy();
			}
		};
		socket.on("data", (chunk) => {
			if (chunk.length > 0) {
				chunks.push(chunk);
				buffered += chunk.length;
				drainTunnel();
			}
		});
		socket.on("error", () => socket.destroy());
		socket.on("close", () => lost(closeCode));
		if (headBuf?.length) {
			chunks.push(headBuf);
			buffered = headBuf.length;
			drainTunnel();
		}
	});
	tunnelReq.end();
}

function gracefulShutdown() {
	if (shuttingDown) return;
	shuttingDown = true;
	if (reconnectTimer) {
		clearTimeout(reconnectTimer);
		reconnectTimer = null;
	}
	const session = current;
	if (!session || session.closed) {
		httpAgent.destroy();
		process.exit(0);
	}
	if (session.healthTimer) {
		clearInterval(session.healthTimer);
		session.healthTimer = null;
	}
	const finish = () => {
		session.finishShutdownCheck = null;
		if (session.socket && !session.socket.destroyed && !session.closing) {
			session.closing = true;
			session.socket.write(encodeClientFrame(0x8, encodeWsClose(1001, "shutting down")));
			session.socket.end();
		}
		httpAgent.destroy();
		process.exit(0);
	};
	if (session.streams.size === 0 && session.wsStreams.size === 0) {
		finish();
		return;
	}
	session.finishShutdownCheck = finish;
	const deadline = setTimeout(finish, drainTimeoutMs);
	deadline.unref();
}

process.once("SIGTERM", gracefulShutdown);
process.once("SIGINT", gracefulShutdown);

connect();
