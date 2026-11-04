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
//
// Messages with the relay (binary WebSocket frames): 1 byte type, 4-byte stream id, payload. 1 request head (JSON
// {method, path, headers}), 2 body chunk, 3 body end, 4 response head (JSON {status, headers}), 5 reset, 6 hello
// (JSON {key, url, port}), 7 keepalive. Headers travel as [name, value] pairs.

import { randomBytes } from "node:crypto";
import { request } from "node:http";

const HEAD = 1;
const BODY = 2;
const END = 3;
const RESPONSE = 4;
const RESET = 5;
const HELLO = 6;
const KEEPALIVE = 7;
const REFUSED = 4001; // the relay's close code: the claim or key does not hold
const REPLACED = 4002; // the relay's close code: a newer link program took over
const CHUNK = 64 * 1024;

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
	const head = Buffer.alloc(5);
	head[0] = type;
	head.writeUInt32BE(stream, 1);
	return Buffer.concat([head, payload]);
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
		setTimeout(connect, delay);
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
		else if (type === BODY) streams.get(id)?.write(payload);
		else if (type === END) streams.get(id)?.end();
		else if (type === RESET) {
			const app = streams.get(id);
			streams.delete(id);
			app?.destroy();
		}
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
			if (!appAnswers) console.log(`The app on port ${port} answers again`);
			appAnswers = true;
			const headers = [];
			for (let i = 0; i < response.rawHeaders.length; i += 2)
				headers.push([response.rawHeaders[i], response.rawHeaders[i + 1]]);
			send(RESPONSE, id, Buffer.from(JSON.stringify({ status: response.statusCode, headers })));
			response.on("data", (chunk) => {
				for (let at = 0; at < chunk.length; at += CHUNK) send(BODY, id, chunk.subarray(at, at + CHUNK));
				// The relay is slower than the app: wait until what is queued has gone out.
				if (ws.bufferedAmount > 4 * 1024 * 1024) {
					response.pause();
					const check = () =>
						ws.readyState !== WebSocket.OPEN || ws.bufferedAmount < 1024 * 1024
							? response.resume()
							: setTimeout(check, 20);
					setTimeout(check, 20);
				}
			});
			response.on("end", () => {
				if (streams.get(id) !== app) return;
				streams.delete(id);
				send(END, id);
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
}

connect();
