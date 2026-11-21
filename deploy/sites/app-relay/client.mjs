#!/usr/bin/env node
// Qorpera private app link: shares one port of this machine at https://<slug>-preview.qorpera.com/, behind the
// site's password (members find it in Settings -> Sites).
//
//   node client.mjs <slug> <port> <claim> [host suffix, default -preview.qorpera.com]
//
// It dials out to Qorpera's relay and hands each visitor's request to the app at 127.0.0.1, on the port the link is
// shared for (the relay says which when it connects; the port given here is only checked against it). Nothing new
// listens on this machine. The claim works for 15 minutes, for this program only: the relay trades it for a connection
// key at once, bound to the random id this program makes when it starts (sent on every connect). The key and the id
// stay in this program's memory only; after a dropped connection the program connects again with them. Stop the
// program (Ctrl-C) and the link says "This app is not running right now".

import { createHash, randomBytes } from "node:crypto";
import { request } from "node:http";

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
const REFUSED = 4001; // the relay's close code: the claim or key does not hold
const REPLACED = 4002; // the relay's close code: a newer link program took over
const CHUNK = 64 * 1024;
const MAX_WS_MESSAGE = 1024 * 1024;
const MAX_WS_QUEUED = 4 * 1024 * 1024;
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const WS_UTF8 = new TextDecoder("utf-8", { fatal: true });
const WS_TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
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

let secret = claim; // the claim, until the relay gives a key
const programId = randomBytes(32).toString("base64url"); // this process's own id: a claim serves only the first one
let holdsKey = false;
let port = null; // the port the link is shared for, from the relay's hello
let delay = 1000;
let appAnswers = true;
let current = null;

function message(type, stream, payload = Buffer.alloc(0)) {
	const out = Buffer.allocUnsafe(5 + payload.byteLength);
	out[0] = type;
	out.writeUInt32BE(stream, 1);
	if (payload.byteLength > 0) payload.copy(out, 5);
	return out;
}

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

function encodeClientFrame(opcode, payload = Buffer.alloc(0)) {
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
	const payload = Buffer.allocUnsafe(length);
	buffer.copy(payload, 0, offset, offset + length);
	return { fin, opcode, payload, size: offset + length };
}

function connect() {
	let ws;
	try {
		ws = new WebSocket(connectUrl, {
			headers: { authorization: `Bearer ${secret}`, "x-qorpera-program": programId },
		});
	} catch {
		console.error(`The relay's address is not valid: ${connectUrl}`);
		process.exit(2);
	}
	ws.binaryType = "arraybuffer";
	current = ws;
	const streams = new Map(); // stream id -> the request to the app
	const uploadClosed = new WeakSet();
	const wsStreams = new Map();
	const send = (type, stream, payload) => {
		if (ws.readyState === WebSocket.OPEN) ws.send(message(type, stream, payload));
	};
	let lastSeen = Date.now();
	// The relay sends a keepalive every 25 s: a connection silent for 60 s is gone.
	const watch = setInterval(() => {
		if (Date.now() - lastSeen > 60_000) lost();
	}, 5000);

	function lost(code) {
		if (current !== ws) return;
		current = null;
		clearInterval(watch);
		for (const app of streams.values()) app.destroy();
		streams.clear();
		for (const upstream of wsStreams.values()) upstream.destroy();
		wsStreams.clear();
		try {
			ws.close();
		} catch {
			// Closing already.
		}
		if (code === REFUSED) {
			console.log(
				holdsKey
					? "The relay refused this program: the link was turned off or shared again. Stopping."
					: "The relay refused the claim: it was used already or has expired. Ask the agent to share the app again.",
			);
			process.exit(1);
		}
		if (code === REPLACED) {
			console.log("A newer link program took over this link. Stopping.");
			process.exit(0);
		}
		console.log("Lost the connection, trying again");
		const jittered = Math.round(delay * (0.75 + Math.random() * 0.5));
		setTimeout(connect, jittered);
		delay = Math.min(delay * 2, 30_000);
	}

	ws.onerror = () => {}; // a close follows
	ws.onclose = (event) => lost(event.code);
	ws.onmessage = (event) => {
		if (current !== ws) return;
		lastSeen = Date.now();
		const data = Buffer.from(event.data);
		if (data.length < 5) return;
		const type = data[0];
		const id = data.readUInt32BE(1);
		const payload = data.subarray(5);
		if (type === HELLO) hello(payload);
		else if (type === KEEPALIVE) send(KEEPALIVE, 0);
		else if (type === HEAD) start(id, payload);
		else if (type === BODY) {
			const app = streams.get(id);
			if (!app || app.destroyed || app.writableEnded || uploadClosed.has(app)) return;
			let totalBuffered = 0;
			for (const stream of streams.values()) totalBuffered += stream.writableLength;
			// WHY: Bound aggregate local upload buffering (64 MiB) while still allowing any single valid 10 MiB delayed-read upload.
			if (totalBuffered + payload.length > 64 * 1024 * 1024) {
				streams.delete(id);
				app.destroy();
				send(RESET, id);
				return;
			}
			app.write(payload);
		} else if (type === END) {
			const app = streams.get(id);
			if (app && !app.destroyed && !app.writableEnded && !uploadClosed.has(app)) app.end();
		} else if (type === RESET) {
			const app = streams.get(id);
			streams.delete(id);
			app?.destroy();
			const upstream = wsStreams.get(id);
			wsStreams.delete(id);
			upstream?.destroy();
		} else if (type === WS_OPEN) openWs(id, payload);
		else if (type === WS_DATA) wsData(id, payload);
		else if (type === WS_CLOSE) wsClose(id, payload);
	};

	function hello(payload) {
		let said = {};
		try {
			said = JSON.parse(payload.toString());
		} catch {
			// Checked below.
		}
		if (!Number.isInteger(said?.port) || said.port < 1 || said.port > 65535) {
			console.log("The relay did not say which port this link is shared for. Stopping.");
			process.exit(1);
		}
		if (typeof said.key === "string") {
			secret = said.key;
			holdsKey = true;
		}
		if (said.port !== port && said.port !== given)
			console.log(`This link is shared for port ${said.port}, not ${given}: serving port ${said.port}.`);
		port = said.port;
		delay = 1000;
		console.log(`Connected: ${url}`);
	}

	// One visitor's request, to the app on this machine; a connection of its own, so no request can reach another's.
	function start(id, payload) {
		let app;
		try {
			const head = JSON.parse(payload.toString());
			if (port === null) throw new Error("No port yet");
			app = request({
				host: "127.0.0.1",
				port,
				method: head.method,
				path: head.path,
				headers: head.headers.flat(),
				agent: false,
			});
		} catch {
			return send(RESET, id);
		}
		streams.set(id, app);
		let answered = false;
		const reset = () => {
			if (streams.get(id) !== app) return; // ended already, or by the relay
			streams.delete(id);
			send(RESET, id);
		};
		app.on("response", (response) => {
			answered = true;
			// WHY: 413 means the app rejected the upload payload; stop writing more BODY/END frames so a closed app socket does not TCP-RST unread response bytes under backpressure.
			if (response.statusCode === 413) uploadClosed.add(app);
			if (!appAnswers) console.log(`The app on port ${port} answers again`);
			appAnswers = true;
			const headers = [];
			for (let i = 0; i < response.rawHeaders.length; i += 2)
				headers.push([response.rawHeaders[i], response.rawHeaders[i + 1]]);
			send(RESPONSE, id, Buffer.from(JSON.stringify({ status: response.statusCode, headers })));
			response.on("data", (chunk) => {
				for (let at = 0; at < chunk.length; at += CHUNK) send(BODY, id, chunk.subarray(at, at + CHUNK));
				// The relay is slower than the app: wait until what is queued has gone out.
				if (ws.bufferedAmount > 4 * 1024 * 1024 && !response.isPaused()) {
					response.pause();
					const check = () =>
						streams.get(id) !== app || ws.readyState !== WebSocket.OPEN || ws.bufferedAmount < 1024 * 1024
							? response.resume()
							: setTimeout(check, 20);
					setTimeout(check, 20);
				}
			});
			response.on("end", () => {
				if (streams.get(id) !== app) return;
				streams.delete(id);
				send(END, id);
				if (!app.writableEnded) app.destroy();
			});
			// The app broke off its answer.
			response.on("error", reset);
			response.on("close", () => {
				if (!response.complete) reset();
			});
		});
		app.on("error", () => {
			if (streams.get(id) !== app) return;
			reset();
			if (!answered && appAnswers) {
				appAnswers = false;
				console.log(`The app on port ${port} is not answering`);
			}
		});
	}

	function openWs(id, payload) {
		if (port === null || streams.has(id) || wsStreams.has(id)) return send(RESET, id);
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
		const expectedAccept = createHash("sha1")
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
			req = request({
				host: "127.0.0.1",
				port,
				method: "GET",
				path: head.path,
				headers: outgoing.flat(),
				agent: false,
			});
		} catch {
			return send(RESET, id);
		}
		const entry = {
			req,
			socket: null,
			opened: false,
			closing: false,
			closeTimer: null,
			resumeTimer: null,
			clearTimers() {
				if (entry.closeTimer) {
					clearTimeout(entry.closeTimer);
					entry.closeTimer = null;
				}
				if (entry.resumeTimer) {
					clearTimeout(entry.resumeTimer);
					entry.resumeTimer = null;
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
				wsStreams.delete(id);
				entry.clearTimers();
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
				if (wsStreams.get(id) !== entry) return;
				wsStreams.delete(id);
				entry.clearTimers();
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
		wsStreams.set(id, entry);
		req.on("response", (response) => {
			response.resume();
			if (wsStreams.get(id) !== entry) return;
			wsStreams.delete(id);
			entry.clearTimers();
			if (!appAnswers) console.log(`The app on port ${port} answers again`);
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
			if (wsStreams.get(id) !== entry || entry.opened) return;
			wsStreams.delete(id);
			entry.clearTimers();
			send(RESET, id);
			if (appAnswers) {
				appAnswers = false;
				console.log(`The app on port ${port} is not answering`);
			}
		});
		req.on("upgrade", (response, socket, headBuf) => {
			if (wsStreams.get(id) !== entry) {
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
				acceptHeaders[0] === expectedAccept &&
				!hasExtensions &&
				protoHeaders.length <= 1 &&
				(protoHeaders.length === 0 || offeredProtocols.includes(protoHeaders[0])) &&
				okPayload.length <= 64 * 1024;
			if (!validUpgrade) {
				wsStreams.delete(id);
				entry.clearTimers();
				socket.destroy();
				send(RESET, id);
				return;
			}
			entry.opened = true;
			entry.socket = socket;
			if (!appAnswers) console.log(`The app on port ${port} answers again`);
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
				const out = Buffer.allocUnsafe(1 + data.length);
				out[0] = opcode;
				data.copy(out, 1);
				send(WS_DATA, id, out);
				if (ws.bufferedAmount > 4 * 1024 * 1024 && !socket.isPaused()) {
					socket.pause();
					const check = () => {
						entry.resumeTimer = null;
						if (wsStreams.get(id) !== entry || ws.readyState !== WebSocket.OPEN || socket.destroyed) return;
						if (ws.bufferedAmount < 1024 * 1024) socket.resume();
						else entry.resumeTimer = setTimeout(check, 20);
					};
					entry.resumeTimer = setTimeout(check, 20);
				}
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
						socket.write(encodeClientFrame(0x8, framePayload.length >= 2 ? framePayload.subarray(0, 2) : Buffer.alloc(0)));
					}
					socket.end();
					if (wsStreams.get(id) === entry) {
						wsStreams.delete(id);
						entry.clearTimers();
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
					fragments = [framePayload];
					fragmentBytes = framePayload.length;
					fragmentOpcode = opcode;
					return;
				}
				if (!fragments) throw { wsCode: 1002, message: "a continuation without a message" };
				fragmentBytes += framePayload.length;
				if (fragmentBytes > MAX_WS_MESSAGE) throw { wsCode: 1009, message: "message too large" };
				fragments.push(framePayload);
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
						if (wsStreams.get(id) !== entry || entry.closing || socket.destroyed) return;
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
				if (wsStreams.get(id) === entry) {
					wsStreams.delete(id);
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
		const entry = wsStreams.get(id);
		if (!entry || !entry.opened || entry.closing) return;
		if (payload.length < 1) return entry.abort(1002, "invalid message");
		const opcode = payload[0];
		if (opcode !== 1 && opcode !== 2) return entry.abort(1002, "invalid message");
		const data = payload.subarray(1);
		if (data.length > MAX_WS_MESSAGE) return entry.abort(1009, "message too large");
		entry.writeFrame(opcode, data);
	}

	function wsClose(id, payload) {
		const entry = wsStreams.get(id);
		if (!entry) return;
		const { code, reason } = decodeWsClose(payload);
		entry.closeFromRelay(code, reason);
	}
}

connect();
