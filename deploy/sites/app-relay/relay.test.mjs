/* The relay and the link program (deploy/sites/APP-PREVIEW.md, section 3), end to end in one process: a fake
 * database (PostgREST's RPC paths as the relay's own role: claims, keys, sites, sessions, the password), the relay, a
 * tiny app on a random port, a front standing in for api-front (it adds x-forwarded-host, as the apps virtual host
 * does) and the real client.mjs as a child process. Then the pure parts on their own.
 * Run: node --test 'deploy/sites/**\/*.test.mjs' */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { createServer, request } from "node:http";
import { connect, createServer as createTcpServer } from "node:net";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
	acceptKey,
	addressGroup,
	appCookie,
	appHost,
	CLEAR_GATE_COOKIE,
	CLOSE,
	changeFromAnotherSite,
	clientAddress,
	createRelay,
	decodeFrame,
	decodeMessage,
	decodeWsClose,
	encodeFrame,
	encodeMessage,
	encodeWsClose,
	FORWARDED_CACHE_HEADERS,
	GATE_COOKIE,
	gateCookie,
	gateTokens,
	headerPairs,
	isValidCloseCode,
	isValidVisitorWsOrigin,
	jwtRole,
	language,
	MAX_QUEUED_BYTES,
	MAX_WS_MESSAGE_BYTES,
	MAX_WS_PER_SITE,
	MAX_WS_QUEUED_BYTES,
	PAGE_SECURITY_POLICY,
	parseConnectAnswer,
	parseSessionAnswer,
	parseUnlockAnswer,
	parseWebOrigins,
	parseWsProtocols,
	passwordPage,
	PUBLIC_RATE_LIMIT_BURST,
	RELAY_ROLE,
	relayHeaders,
	requestHeaders,
	responseHeaders,
	safeNext,
	sanitizeCloseCode,
	TYPE,
	truncateUtf8,
	WebSocketConnection,
	WebSocketError,
	withoutGateCookie,
	wsRequestHeaders,
	wsResponseHeaders,
} from "./relay.mjs";

const SUFFIX = "-preview.example.test";
const HOST = `shop${SUFFIX}`;
const LAB = `lab${SUFFIX}`;
const ORIGIN = `https://${HOST}`;
const jwt = (claims) =>
	`eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.c2lnbmF0dXJlLW5vdC1yZWFs`;
const ANON_KEY = jwt({ iss: "supabase", role: "anon" });
const RELAY_JWT = jwt({ iss: "supabase", role: RELAY_ROLE });
const RELAY = { apiKey: ANON_KEY, relayJwt: RELAY_JWT };
const PASSWORD = "k7mq-x2pa-9fhd";
const CLIENT = fileURLToPath(new URL("./client.mjs", import.meta.url));
const BIG = randomBytes(3 * 1024 * 1024 + 17);
/** A link program's id, as client.mjs makes one per process. */
const PROGRAM = randomBytes(32).toString("base64url");
/** A raw connect's credentials: the Bearer secret and the program's id. */
const bearer = (secret, id = PROGRAM) => `Authorization: Bearer ${secret}\r\nX-Qorpera-Program: ${id}\r\n`;

function listen(server) {
	return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

function readAll(stream) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		stream.on("data", (chunk) => chunks.push(chunk));
		stream.on("end", () => resolve(Buffer.concat(chunks)));
		stream.on("error", reject);
		stream.resume();
	});
}

async function until(check, what, ms = 10_000) {
	const deadline = Date.now() + ms;
	while (!(await check())) {
		if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const values = (pairs, name) => pairs.filter(([key]) => key.toLowerCase() === name).map(([, value]) => value);

/** PostgREST's RPC paths as the relay's three functions answer them, for app sites by slug (shop, lab). A slug can be
 * taken again by a new site (another id), as after a member's unpublish. */
function fakeDatabase() {
	const site = (port = 0) => ({ id: randomUUID(), claims: new Map(), key: null, port, sessions: new Set() });
	const db = {
		sites: new Map([
			["shop", site()],
			["lab", site()],
		]),
		calls: [],
		limited: false,
		secrets: new Set(),
	};
	const secret = () => {
		const value = randomBytes(32).toString("base64url");
		db.secrets.add(value);
		return value;
	};
	const answer = (name, args) => {
		const app = db.sites.get(args.p_slug);
		if (name === "qorpera_site_app_connect") {
			if (!app || typeof args.p_program !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(args.p_program))
				return { state: "refused" };
			const claim = app.claims.get(args.p_secret);
			// A claim serves the program that first used it (again, a while, should its key not have arrived), no other;
			// each use's key replaces the one before, so only the newest program connects.
			if (claim && (claim.program === null || claim.program === args.p_program)) {
				claim.program = args.p_program;
				app.key = secret();
				return { state: "ok", key: app.key, port: app.port, siteId: app.id };
			}
			if (app.key !== null && args.p_secret === app.key)
				return { state: "ok", key: null, port: app.port, siteId: app.id };
			return { state: "refused" };
		}
		if (name === "qorpera_site_app_session")
			return app?.sessions.has(args.p_token) ? { state: "open", siteId: app.id } : { state: "locked" };
		if (name === "qorpera_site_app_unlock") {
			if (db.limited) return { state: "limited", retryAfter: 125 };
			if (!app || args.p_password !== PASSWORD) return { state: "wrong" };
			return { state: "open", token: db.session(args.p_slug), maxAge: 604800 };
		}
		return { message: "no such function" };
	};
	db.server = createServer(async (req, res) => {
		const body = await readAll(req);
		const name = /^\/rest\/v1\/rpc\/([a-z_]+)$/.exec(req.url ?? "")?.[1];
		if (
			req.method !== "POST" ||
			!name ||
			req.headers.apikey !== ANON_KEY ||
			req.headers.authorization !== `Bearer ${RELAY_JWT}` ||
			req.headers["content-type"] !== "application/json"
		) {
			res.writeHead(401, { "content-type": "application/json" });
			res.end('{"message":"no"}');
			return;
		}
		const args = JSON.parse(body.toString());
		db.calls.push({ name, args });
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify(answer(name, args)));
	});
	db.claim = (slug) => {
		const claim = secret();
		db.sites.get(slug).claims.set(claim, { program: null });
		return claim;
	};
	db.session = (slug) => {
		const token = randomBytes(24).toString("base64url");
		db.secrets.add(token);
		db.sites.get(slug).sessions.add(token);
		return token;
	};
	/** The slug's site deleted and the name taken by a new site (same port, nothing else carried over). */
	db.retake = (slug) => {
		const next = site(db.sites.get(slug).port);
		db.sites.set(slug, next);
		return next;
	};
	db.connects = () => db.calls.filter((call) => call.name === "qorpera_site_app_connect");
	db.sessionCalls = () => db.calls.filter((call) => call.name === "qorpera_site_app_session");
	return db;
}

/** The app on the machine: hello, an echo, a stream, cookies, cache headers, big bodies and one that never answers. */
function testApp() {
	const app = { seen: [], aborted: [], release: null };
	app.server = createServer(async (req, res) => {
		const body = await readAll(req);
		app.seen.push({ method: req.method, url: req.url });
		if (req.url === "/hello") {
			res.writeHead(200, { "content-type": "text/plain", "content-length": "5" });
			res.end(req.method === "HEAD" ? undefined : "hello");
		} else if (req.url.startsWith("/echo")) {
			const json = JSON.stringify({
				method: req.method,
				url: req.url,
				headers: headerPairs(req.rawHeaders),
				body: body.toString("base64"),
			});
			res.writeHead(201, { "content-type": "application/json", "x-app": "echo" });
			res.end(json);
		} else if (req.url === "/stream") {
			res.writeHead(200, { "content-type": "text/plain" });
			res.write("first\n");
			await new Promise((resolve) => {
				app.release = resolve;
			});
			res.end("second\n");
		} else if (req.url === "/cookies") {
			res.writeHead(200, [
				"Set-Cookie",
				"a=1; Domain=example.test; Path=/",
				"Set-Cookie",
				`b=2; Path=/; domain=.${HOST}; HttpOnly`,
				"Set-Cookie",
				`${GATE_COOKIE}=forged; Path=/; Secure`,
				"Set-Cookie",
				"c=3",
				"Content-Type",
				"text/plain",
			]);
			res.end("cookies");
		} else if (req.url === "/assets/app.js") {
			res.writeHead(200, [
				"Content-Type",
				"text/javascript",
				"Cache-Control",
				"public, max-age=31536000, immutable",
				"Expires",
				"Thu, 01 Jan 2099 00:00:00 GMT",
				"CDN-Cache-Control",
				"max-age=600",
				"Cloudflare-CDN-Cache-Control",
				"max-age=600",
				"Surrogate-Control",
				"max-age=600",
				"ETag",
				'"v1"',
			]);
			res.end("export {};");
		} else if (req.url === "/account.json") {
			res.writeHead(200, { "content-type": "application/json", "cache-control": "max-age=0, No-Store" });
			res.end("{}");
		} else if (req.url === "/big") {
			res.writeHead(200, { "content-type": "application/octet-stream" });
			res.end(BIG);
		} else if (req.url === "/huge") {
			// 64 MiB, as fast as whoever reads it.
			res.on("close", () => app.aborted.push(req.url));
			res.writeHead(200, { "content-type": "application/octet-stream" });
			const chunk = Buffer.alloc(64 * 1024, 120);
			let sent = 0;
			const pump = () => {
				while (sent < 64 * 1024 * 1024) {
					sent += chunk.length;
					if (!res.write(chunk)) return void res.once("drain", pump);
				}
				res.end();
			};
			pump();
		} else if (req.url === "/slow") {
			res.on("close", () => app.aborted.push(req.url));
		} else {
			res.writeHead(404);
			res.end();
		}
	});
	return app;
}

/** api-front in short: every connection to the relay with X-Forwarded-Host set to the shop's host. */
function testFront(relayPort) {
	return createTcpServer((visitor) => {
		const upstream = connect(relayPort, "127.0.0.1");
		let head = Buffer.alloc(0);
		let open = false;
		visitor.on("data", (chunk) => {
			if (open) return void upstream.write(chunk);
			head = Buffer.concat([head, chunk]);
			const end = head.indexOf("\r\n");
			if (end === -1) return;
			open = true;
			upstream.write(
				Buffer.concat([
					head.subarray(0, end + 2),
					Buffer.from(`X-Forwarded-Host: ${HOST}\r\n`),
					head.subarray(end + 2),
				]),
			);
		});
		upstream.on("data", (chunk) => visitor.write(chunk));
		const end = () => {
			visitor.destroy();
			upstream.destroy();
		};
		for (const socket of [visitor, upstream]) {
			socket.on("close", end);
			socket.on("error", end);
		}
	});
}

/** The start of a raw WebSocket handshake to a relay, written; the socket for the answer. */
function handshake(port, host, path, extra = "") {
	const socket = connect(port, "127.0.0.1");
	const key = randomBytes(16).toString("base64");
	socket.write(
		`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nX-Forwarded-Host: ${host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
			`Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${key}\r\n${extra}\r\n`,
	);
	return { socket, key };
}

/** The answer's head to a handshake (status, head, the bytes after it). */
function answerHead(socket) {
	return new Promise((resolve, reject) => {
		let buffer = Buffer.alloc(0);
		const onData = (chunk) => {
			buffer = Buffer.concat([buffer, chunk]);
			const end = buffer.indexOf("\r\n\r\n");
			if (end === -1) return;
			socket.off("data", onData);
			const head = buffer.subarray(0, end).toString();
			resolve({ head, status: Number(head.split(" ")[1]), rest: buffer.subarray(end + 4) });
		};
		socket.on("data", onData);
		socket.on("error", reject);
	});
}

/** A raw WebSocket handshake to a relay: the answer's status and head, and the socket for frames. */
async function rawUpgrade(port, host, path, extra = "") {
	const { socket, key } = handshake(port, host, path, extra);
	return { socket, key, ...(await answerHead(socket)) };
}

/** The server's frames on a raw socket, one at a time; `closed` resolves when the socket closes. */
function frameReader(socket, initial) {
	let buffer = initial;
	const queue = [];
	const waiting = [];
	const pump = () => {
		for (;;) {
			const frame = decodeFrame(buffer, { masked: false });
			if (!frame) break;
			buffer = buffer.subarray(frame.size);
			queue.push(frame);
		}
		while (queue.length && waiting.length) waiting.shift()(queue.shift());
	};
	socket.on("data", (chunk) => {
		buffer = Buffer.concat([buffer, chunk]);
		pump();
	});
	const closed = new Promise((resolve) => socket.on("close", resolve));
	pump();
	return {
		closed,
		next: (ms = 5000) =>
			new Promise((resolve, reject) => {
				const timer = setTimeout(() => reject(new Error("no frame came")), ms);
				waiting.push((frame) => {
					clearTimeout(timer);
					resolve(frame);
				});
				pump();
			}),
		/** The next frame that is not a keepalive message. */
		async message(ms) {
			for (;;) {
				const frame = await this.next(ms);
				if (frame.opcode !== 0x2 || decodeMessage(frame.payload).type !== TYPE.keepalive) return frame;
			}
		},
	};
}

/** Every byte a raw HTTP request gets back, until the connection closes. */
function rawRequest(port, text) {
	return new Promise((resolve) => {
		const socket = connect(port, "127.0.0.1");
		const chunks = [];
		socket.on("data", (chunk) => chunks.push(chunk));
		socket.on("error", () => {});
		socket.on("close", () => resolve(Buffer.concat(chunks).toString("latin1")));
		socket.write(text);
	});
}

const mask = () => randomBytes(4);

/** The next request a program gets, by hand: its head, then its body to the end message. */
async function nextRequest(frames) {
	const head = decodeMessage((await frames.message()).payload);
	assert.equal(head.type, TYPE.head);
	const body = [];
	for (;;) {
		const message = decodeMessage((await frames.message()).payload);
		assert.equal(message.stream, head.stream);
		if (message.type === TYPE.end) break;
		assert.equal(message.type, TYPE.body);
		body.push(message.payload);
	}
	return { ...head, body: Buffer.concat(body) };
}

/** A program's answer, by hand: the head, each body chunk, the end. */
function respond(socket, stream, status, headers, chunks = []) {
	socket.write(
		encodeFrame(0x2, encodeMessage(TYPE.response, stream, Buffer.from(JSON.stringify({ status, headers }))), {
			mask: mask(),
		}),
	);
	for (const chunk of chunks)
		socket.write(encodeFrame(0x2, encodeMessage(TYPE.body, stream, Buffer.from(chunk)), { mask: mask() }));
	socket.write(encodeFrame(0x2, encodeMessage(TYPE.end, stream), { mask: mask() }));
}

/** A visitor's GET on a relay, with a gate cookie. */
function get(port, host, path, session) {
	return new Promise((resolve, reject) => {
		const req = request(
			{
				host: "127.0.0.1",
				port,
				path,
				agent: false,
				headers: { "x-forwarded-host": host, cookie: `${GATE_COOKIE}=${session}` },
			},
			(res) => {
				readAll(res).then(
					(data) => resolve({ status: res.statusCode, headers: res.headers, text: data.toString() }),
					reject,
				);
			},
		);
		req.on("error", reject);
		req.end();
	});
}

describe("app relay: end to end with the link program", () => {
	const db = fakeDatabase();
	const app = testApp();
	const logs = [];
	const programs = [];
	let relay;
	let relayPort;
	let front;
	let frontPort;
	let appPort;
	let token;

	function linkProgram(claim, port = appPort) {
		const child = spawn(process.execPath, [CLIENT, "shop", String(port), claim, SUFFIX], {
			env: { ...process.env, QORPERA_APP_RELAY_ORIGIN: `ws://127.0.0.1:${frontPort}` },
			stdio: ["ignore", "pipe", "pipe"],
		});
		const program = { child, output: "", code: undefined };
		child.stdout.on("data", (chunk) => {
			program.output += chunk;
		});
		child.stderr.on("data", (chunk) => {
			program.output += chunk;
		});
		program.exited = new Promise((resolve) =>
			child.on("exit", (code) => {
				program.code = code;
				resolve(code);
			}),
		);
		program.count = (text) => program.output.split(text).length - 1;
		programs.push(program);
		return program;
	}

	function visit(path, { method = "GET", headers = {}, body, host = HOST } = {}) {
		return new Promise((resolve, reject) => {
			const req = request(
				{
					host: "127.0.0.1",
					port: relayPort,
					method,
					path,
					agent: false,
					headers: {
						...(host ? { "x-forwarded-host": host } : {}),
						"cf-connecting-ip": "203.0.113.9",
						...headers,
					},
				},
				(res) => {
					readAll(res).then(
						(data) =>
							resolve({
								status: res.statusCode,
								headers: res.headers,
								raw: headerPairs(res.rawHeaders),
								body: data,
								text: data.toString(),
							}),
						reject,
					);
				},
			);
			req.on("error", reject);
			req.end(body);
		});
	}

	function unlock(password, next = "/", headers = {}) {
		return visit("/.qorpera/unlock", {
			method: "POST",
			body: new URLSearchParams({ password, next }).toString(),
			headers: { "content-type": "application/x-www-form-urlencoded", origin: ORIGIN, ...headers },
		});
	}

	const withSession = (headers = {}, session = token) => ({ cookie: `${GATE_COOKIE}=${session}`, ...headers });

	before(async () => {
		const dbPort = await listen(db.server);
		appPort = await listen(app.server);
		for (const site of db.sites.values()) site.port = appPort;
		relay = createRelay({
			api: `http://127.0.0.1:${dbPort}/`,
			...RELAY,
			hostSuffix: SUFFIX,
			// Longer than a paused visitor may hold the program, so a request waiting behind one still gets its answer.
			responseTimeoutMs: 2500,
			sessionCacheMs: 200,
			lockedCacheMs: 200,
			maxBodyBytes: 256 * 1024,
			pausedMs: 500,
			recheckMs: 0,
			log: (line) => logs.push(line),
		});
		relayPort = await listen(relay);
		front = testFront(relayPort);
		frontPort = await listen(front);
	});

	after(async () => {
		for (const program of programs) program.child.kill();
		await new Promise((resolve) => relay.close(resolve));
		front.close();
		db.server.close();
		db.server.closeAllConnections();
		app.release?.();
		app.server.close();
		app.server.closeAllConnections();
	});

	it("answers its health on any host, and 404 for any name that is no app host", async () => {
		for (const host of [null, HOST, "evil.example"]) {
			const health = await visit("/.qorpera/health", { host });
			assert.equal(health.status, 200, String(host));
			assert.equal(health.text, "ok\n");
		}
		for (const host of [
			null,
			"evil.example",
			`shop.example.test`,
			`ab${SUFFIX}`,
			`-shop${SUFFIX}`,
			`shop-${SUFFIX}`,
			`sh_op${SUFFIX}`,
			`${"a".repeat(49)}${SUFFIX}`,
			`a.shop${SUFFIX}`,
			`${HOST}.`,
			`${HOST}:443`,
			`${HOST}, ${HOST}`,
			`${HOST}.evil.example`,
		]) {
			const answer = await visit("/hello", { host, headers: withSession() });
			assert.equal(answer.status, 404, String(host));
			assert.equal(answer.headers["content-security-policy"], PAGE_SECURITY_POLICY);
		}
		assert.equal(db.calls.length, 0, "nothing reached the database");
		// Letters in any case are the same name.
		assert.equal((await visit("/hello", { host: HOST.toUpperCase() })).status, 401);
	});

	it("serves the link program without the password, never cached on the way", async () => {
		const client = await visit("/.qorpera/client.mjs");
		assert.equal(client.status, 200);
		assert.equal(client.headers["content-type"], "text/javascript; charset=utf-8");
		assert.equal(client.headers["x-content-type-options"], "nosniff");
		assert.equal(client.headers["cdn-cache-control"], "no-store");
		assert.deepEqual(client.body, readFileSync(CLIENT));
		assert.equal((await visit("/.qorpera/client.mjs", { method: "POST", body: "x" })).status, 405);
		assert.equal((await visit("/.qorpera/other")).status, 404);
		assert.equal((await visit("/%2Eqorpera/other")).status, 404);
		assert.equal((await visit("/.qorpera/connect")).status, 426);
		assert.equal(db.calls.length, 0);
	});

	it("shows the password page, in English or Danish, without asking the database", async () => {
		const page = await visit("/hello?x=1");
		assert.equal(page.status, 401);
		assert.equal(page.headers["content-type"], "text/html; charset=utf-8");
		assert.equal(page.headers["content-security-policy"], PAGE_SECURITY_POLICY);
		assert.equal(page.headers["referrer-policy"], "same-origin");
		assert.equal(page.headers["cache-control"], "no-store");
		assert.equal(page.headers["x-frame-options"], "DENY");
		assert.equal(page.headers["set-cookie"], undefined);
		assert.match(page.text, /<h1>Private site<\/h1>/);
		assert.match(page.text, /<form method="post" action="\/\.qorpera\/unlock">/);
		assert.match(page.text, /<input type="hidden" name="next" value="\/hello\?x=1">/);
		assert.match(page.text, /<meta name="referrer" content="same-origin">/);
		const danish = await visit("/", { headers: { "accept-language": "da-DK,da;q=0.9,en;q=0.8" } });
		assert.match(danish.text, /<html lang="da">[\s\S]*Privat side/);
		// A cookie that is no session token is not asked about.
		const odd = await visit("/hello", { headers: { cookie: `${GATE_COOKIE}=short` } });
		assert.equal(odd.status, 401);
		assert.equal(db.calls.length, 0);
		const head = await visit("/hello", { method: "HEAD" });
		assert.equal(head.status, 401);
		assert.equal(head.body.length, 0);
	});

	it("keeps a locked answer a few seconds, so a token nobody holds costs one database call", async () => {
		const unknown = "Z".repeat(32);
		const asked = db.sessionCalls().length;
		for (let i = 0; i < 3; i++) {
			const answer = await visit("/hello", { headers: withSession({}, unknown) });
			assert.equal(answer.status, 401);
			assert.deepEqual(answer.headers["set-cookie"], [CLEAR_GATE_COOKIE]);
		}
		assert.equal(db.sessionCalls().length - asked, 1);
		await sleep(250);
		await visit("/hello", { headers: withSession({}, unknown) });
		assert.equal(db.sessionCalls().length - asked, 2);
	});

	it("refuses another origin and a wrong password, limits tries, and keeps next on this host", async () => {
		const calls = db.calls.length;
		for (const origin of ["https://evil.example", "null", `https://lab${SUFFIX}`, `http://${HOST}`])
			assert.equal((await unlock(PASSWORD, "/", { origin })).status, 403, origin);
		const json = await visit("/.qorpera/unlock", {
			method: "POST",
			body: JSON.stringify({ password: PASSWORD }),
			headers: { "content-type": "application/json", origin: ORIGIN },
		});
		assert.equal(json.status, 415);
		const big = await unlock("x".repeat(5000));
		assert.equal(big.status, 413);
		assert.equal(db.calls.length, calls);
		const wrong = await unlock("nope", "/hello");
		assert.equal(wrong.status, 401);
		assert.equal(wrong.headers["set-cookie"], undefined);
		assert.match(wrong.text, /That password is not right\. Try again\./);
		assert.match(wrong.text, /name="next" value="\/hello"/);
		db.limited = true;
		const limited = await unlock(PASSWORD, "/", { "accept-language": "da" });
		db.limited = false;
		assert.equal(limited.status, 429);
		assert.equal(limited.headers["retry-after"], "125");
		assert.match(limited.text, /Prøv igen om 3 minutter\./);
		// The app sites' own unlock, never the files sites' one.
		assert.deepEqual(db.calls.at(-1), {
			name: "qorpera_site_app_unlock",
			args: { p_slug: "shop", p_password: PASSWORD, p_client: "203.0.113.9" },
		});
		assert.ok(!db.calls.some((call) => call.name === "qorpera_site_unlock"));
		for (const next of ["//evil.example/", "https://evil.example/", "/\\evil.example", "/.qorpera/unlock", "hello"]) {
			const answer = await unlock(PASSWORD, next);
			assert.equal(answer.status, 303, next);
			assert.equal(answer.headers.location, "/", next);
		}
		const form = await visit("/.qorpera/unlock");
		assert.equal(form.status, 303);
		assert.equal(form.headers.location, "/");
		assert.equal((await visit("/.qorpera/unlock", { method: "PUT", body: "x" })).status, 405);
	});

	it("unlocks: a host-only, HttpOnly, Lax gate cookie and a 303 to the page asked for", async () => {
		const open = await unlock(PASSWORD, "/hello?x=1");
		assert.equal(open.status, 303);
		assert.equal(open.headers.location, "/hello?x=1");
		const [cookie] = open.headers["set-cookie"];
		token = /^__Host-qorpera_app=([A-Za-z0-9_-]{32});/.exec(cookie)?.[1];
		assert.ok(token);
		assert.equal(cookie, gateCookie(token, 604800));
		assert.equal(cookie, `${GATE_COOKIE}=${token}; Path=/; Max-Age=604800; HttpOnly; Secure; SameSite=Lax`);
	});

	it("says the app is not running while no link program is connected", async () => {
		const answer = await visit("/hello", { headers: withSession({ "accept-language": "en" }) });
		assert.equal(answer.status, 503);
		assert.match(answer.text, /<h1>This app is not running right now<\/h1>/);
		const danish = await visit("/hello", { headers: withSession({ "accept-language": "da" }) });
		assert.match(danish.text, /Appen kører ikke lige nu/);
	});

	it("connects the link program with its claim; it serves the port the link is shared for, whatever it was given", async () => {
		const claim = db.claim("shop");
		// Started with another port than the shared one: it says so, and serves the shared one.
		const program = linkProgram(claim, 1);
		await until(() => program.output.includes(`Connected: https://${HOST}/`), "the program to connect");
		assert.match(
			program.output,
			new RegExp(`This link is shared for port ${appPort}, not 1: serving port ${appPort}\\.`),
		);
		assert.equal(relay.isConnected("shop"), true);
		const [first] = db.connects();
		assert.equal(first.args.p_slug, "shop");
		assert.ok(first.args.p_secret === claim, "the claim, as the Bearer");
		assert.match(first.args.p_program, /^[A-Za-z0-9_-]{43}$/, "the program's own id");
		assert.ok(db.sites.get("shop").claims.get(claim).program === first.args.p_program);
		const hello = await visit("/hello", { headers: withSession() });
		assert.equal(hello.status, 200);
		assert.equal(hello.text, "hello");
		const head = await visit("/hello", { method: "HEAD", headers: withSession() });
		assert.equal(head.status, 200);
		assert.equal(head.headers["content-length"], "5");
		assert.equal(head.body.length, 0);
	});

	it("keeps an open session for a while, and then asks the database again", async () => {
		const asked = db.sessionCalls().length;
		await visit("/hello", { headers: withSession() });
		await visit("/hello", { headers: withSession() });
		assert.ok(db.sessionCalls().length - asked <= 1);
		await sleep(250);
		await visit("/hello", { headers: withSession() });
		assert.deepEqual(db.sessionCalls().at(-1).args, { p_slug: "shop", p_token: token });
	});

	it("forwards a POST's head and body; the app gets its proxy headers from the relay only, and no gate cookie", async () => {
		const answer = await visit("/echo?q=1", {
			method: "POST",
			body: "x=1&y=2",
			headers: {
				cookie: `theme=dark; ${GATE_COOKIE}=${token}; lang=da`,
				"content-type": "application/x-www-form-urlencoded",
				"x-forwarded-for": "198.51.100.1",
				"x-forwarded-proto": "http",
				"x-real-ip": "198.51.100.2",
				forwarded: "for=198.51.100.3",
				"x-envoy-original-path": "/other",
				"x-hop": "1",
				connection: "x-hop",
				"x-app-header": "kept",
			},
		});
		assert.equal(answer.status, 201);
		assert.equal(answer.headers["x-app"], "echo");
		const seen = JSON.parse(answer.text);
		assert.equal(seen.method, "POST");
		assert.equal(seen.url, "/echo?q=1");
		assert.equal(Buffer.from(seen.body, "base64").toString(), "x=1&y=2");
		assert.deepEqual(values(seen.headers, "host"), [HOST]);
		assert.deepEqual(values(seen.headers, "cookie"), ["theme=dark; lang=da"]);
		assert.deepEqual(values(seen.headers, "x-forwarded-for"), ["203.0.113.9"]);
		assert.deepEqual(values(seen.headers, "x-forwarded-proto"), ["https"]);
		assert.deepEqual(values(seen.headers, "x-forwarded-host"), [HOST]);
		assert.deepEqual(values(seen.headers, "x-app-header"), ["kept"]);
		assert.deepEqual(values(seen.headers, "content-length"), ["7"]);
		assert.deepEqual(values(seen.headers, "connection"), ["keep-alive"]);
		for (const name of ["x-real-ip", "forwarded", "x-envoy-original-path", "x-hop"])
			assert.deepEqual(values(seen.headers, name), [], name);
		// Only the gate cookie: no Cookie header at all.
		const bare = JSON.parse((await visit("/echo", { headers: withSession() })).text);
		assert.deepEqual(values(bare.headers, "cookie"), []);
		assert.ok(!JSON.stringify(seen.headers).includes(token));
	});

	it("refuses a change another site sent, with 403 and no-store, before the database or the app see it", async () => {
		const calls = db.calls.length;
		const reached = app.seen.length;
		const refuse = async (label, method, headers, session = token) => {
			const answer = await visit("/echo?forged", {
				method,
				body: "amount=100&to=evil",
				// A length of its own: Node frames a DELETE's body with none otherwise.
				headers: {
					"content-type": "application/x-www-form-urlencoded",
					"content-length": "18",
					...(session ? { cookie: `${GATE_COOKIE}=${session}` } : {}),
					...headers,
				},
			});
			assert.equal(answer.status, 403, label);
			assert.equal(answer.headers["cache-control"], "no-store", label);
			assert.equal(answer.headers["content-type"], "text/html; charset=utf-8", label);
			assert.equal(answer.headers["content-security-policy"], PAGE_SECURITY_POLICY, label);
			assert.equal(answer.headers["set-cookie"], undefined, label);
			return answer;
		};
		// Another company's site or app on a sibling name, another scheme, port or name: the Origin is not this host's.
		for (const origin of [
			`https://lab${SUFFIX}`,
			"https://shop.example.test",
			`http://${HOST}`,
			`https://${HOST}:8443`,
			`https://${HOST}.evil.example`,
			"https://evil.example",
			"null",
		])
			for (const method of ["POST", "PUT", "PATCH", "DELETE"])
				await refuse(`${method} ${origin}`, method, { origin });
		// The browser says the page that sent it is not this origin, whatever the Origin says (or without one).
		for (const site of ["same-site", "cross-site"])
			for (const origin of [undefined, ORIGIN, "null"])
				await refuse(`${site} ${origin}`, "POST", { "sec-fetch-site": site, ...(origin ? { origin } : {}) });
		// Origin "null" passes only when the browser says the request came from this very origin.
		for (const site of ["none", "nonsense"])
			await refuse(`null ${site}`, "POST", { origin: "null", "sec-fetch-site": site });
		// A forged POST without a session: 403, not the password page, so the refusal comes first.
		const probe = await refuse("no session", "POST", { origin: "https://evil.example" }, null);
		assert.match(probe.text, /<h1>Sent from another site<\/h1>/);
		const danish = await refuse("da", "POST", { origin: "https://evil.example", "accept-language": "da" });
		assert.match(danish.text, /<h1>Sendt fra et andet site<\/h1>/);
		assert.equal(db.calls.length, calls, "the database was not asked");
		assert.equal(app.seen.length, reached, "nothing reached the app");
	});

	it("forwards a change from the app's own pages, a request without either header, and every GET, HEAD and OPTIONS", async () => {
		const reached = app.seen.length;
		const through = async (label, method, headers) => {
			const answer = await visit("/echo?own", {
				method,
				body: method === "GET" || method === "HEAD" ? undefined : "x=1",
				headers: withSession(
					method === "GET" || method === "HEAD" ? headers : { "content-length": "3", ...headers },
				),
			});
			assert.equal(answer.status, 201, label);
			if (method !== "HEAD") assert.equal(JSON.parse(answer.text).method, method, label);
		};
		for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
			await through(`${method} own origin`, method, { origin: ORIGIN });
			await through(`${method} own origin, same-origin`, method, {
				origin: ORIGIN,
				"sec-fetch-site": "same-origin",
			});
			// A page of the app under Referrer-Policy: no-referrer: its browser hides the origin, and says same-origin.
			await through(`${method} null, same-origin`, method, { origin: "null", "sec-fetch-site": "same-origin" });
			// As before: no Origin and no Sec-Fetch-Site (an old browser, another program), or a typed-in request.
			await through(`${method} neither`, method, {});
			await through(`${method} none`, method, { "sec-fetch-site": "none" });
		}
		// Safe methods pass whoever sent them: a link, a picture, a preflight (5.2 adds the headers for reading).
		for (const method of ["GET", "HEAD", "OPTIONS"])
			for (const headers of [
				{ origin: "https://evil.example", "sec-fetch-site": "cross-site" },
				{ origin: `https://lab${SUFFIX}`, "sec-fetch-site": "same-site" },
			])
				await through(`${method} ${headers.origin}`, method, headers);
		assert.equal(app.seen.length - reached, 4 * 5 + 3 * 2);
	});

	it("still unlocks from the password page's own form, and refuses its POST from another site", async () => {
		const own = await unlock(PASSWORD, "/hello", { "sec-fetch-site": "same-origin" });
		assert.equal(own.status, 303);
		assert.match(own.headers["set-cookie"][0], /^__Host-qorpera_app=[A-Za-z0-9_-]{32}; Path=\/;/);
		const calls = db.calls.length;
		for (const site of ["same-site", "cross-site"]) {
			const forged = await unlock(PASSWORD, "/hello", { "sec-fetch-site": site });
			assert.equal(forged.status, 403, site);
			assert.equal(forged.headers["set-cookie"], undefined, site);
		}
		assert.equal(db.calls.length, calls, "the database was not asked");
	});

	it("frames a chunked body for the app whatever the method, so it never reads it as a request of its own", async () => {
		const smuggled = "GET /smuggled HTTP/1.1\r\nHost: x\r\nX-Forwarded-For: 127.0.0.1\r\n\r\n";
		const answer = await visit("/echo?chunked", {
			method: "DELETE",
			body: smuggled,
			headers: withSession({ "transfer-encoding": "chunked" }),
		});
		assert.equal(answer.status, 201);
		const seen = JSON.parse(answer.text);
		assert.equal(seen.method, "DELETE");
		assert.equal(Buffer.from(seen.body, "base64").toString(), smuggled);
		assert.deepEqual(values(seen.headers, "transfer-encoding"), ["chunked"]);
		await sleep(100);
		assert.ok(!app.seen.some((seen) => seen.url === "/smuggled"), "no second request reached the app");
	});

	it("forwards a binary body over several messages, and a big answer exactly", async () => {
		const body = randomBytes(200 * 1024);
		const echo = await visit("/echo", { method: "PUT", body, headers: withSession() });
		assert.equal(echo.status, 201);
		assert.equal(sha(Buffer.from(JSON.parse(echo.text).body, "base64")), sha(body));
		const big = await visit("/big", { headers: withSession() });
		assert.equal(big.status, 200);
		assert.equal(big.body.length, BIG.length);
		assert.equal(sha(big.body), sha(BIG));
	});

	it("streams an answer as the app writes it", async () => {
		const { res, chunk } = await new Promise((resolve, reject) => {
			const req = request(
				{
					host: "127.0.0.1",
					port: relayPort,
					path: "/stream",
					agent: false,
					headers: { "x-forwarded-host": HOST, ...withSession() },
				},
				(res) => {
					res.once("data", (chunk) => {
						res.pause();
						resolve({ res, chunk });
					});
				},
			);
			req.on("error", reject);
			req.end();
		});
		// The first part is here while the app still holds the rest.
		assert.equal(chunk.toString(), "first\n");
		assert.equal(typeof app.release, "function");
		const rest = readAll(res);
		app.release();
		assert.equal((await rest).toString(), "second\n");
	});

	it("passes every Set-Cookie host-only, and never one for the gate cookie", async () => {
		const answer = await visit("/cookies", { headers: withSession() });
		assert.equal(answer.status, 200);
		assert.deepEqual(answer.headers["set-cookie"], ["a=1; Path=/", "b=2; Path=/; HttpOnly", "c=3"]);
	});

	it("never lets a shared cache keep an answer: safe private Cache-Control is preserved with CDN no-store", async () => {
		const answer = await visit("/assets/app.js", { headers: withSession() });
		assert.equal(answer.status, 200);
		assert.equal(answer.text, "export {};");
		assert.deepEqual(values(answer.raw, "cache-control"), ["private, max-age=31536000, immutable"]);
		assert.deepEqual(values(answer.raw, "cdn-cache-control"), ["no-store"]);
		for (const name of ["expires", "cloudflare-cdn-cache-control", "surrogate-control"])
			assert.deepEqual(values(answer.raw, name), [], name);
		// The browser may still ask again with its tag.
		assert.equal(answer.headers.etag, '"v1"');
		const plain = await visit("/hello", { headers: withSession() });
		assert.equal(plain.headers["cache-control"], "private, no-cache");
		assert.equal(plain.headers["cdn-cache-control"], "no-store");
		// What the app says must never be stored is not stored by the browser either.
		const account = await visit("/account.json", { headers: withSession() });
		assert.deepEqual(values(account.raw, "cache-control"), ["private, no-store"]);
		assert.deepEqual(values(account.raw, "cdn-cache-control"), ["no-store"]);
	});

	it("answers 504 when the app has no answer in time, and ends the app's request", async () => {
		const answer = await visit("/slow", { headers: withSession() });
		assert.equal(answer.status, 504);
		assert.match(answer.text, /The app did not answer in time/);
		await until(() => app.aborted.includes("/slow"), "the app's request to end");
		// The program serves on.
		assert.equal((await visit("/hello", { headers: withSession() })).status, 200);
	});

	it("ends a visitor who stops reading after a while, so the program serves everyone else again", async () => {
		const socket = connect(relayPort, "127.0.0.1");
		let received = 0;
		socket.on("data", (chunk) => {
			received += chunk.length;
		});
		socket.on("error", () => {});
		const closed = new Promise((resolve) => socket.on("close", resolve));
		socket.write(
			`GET /huge HTTP/1.1\r\nHost: x\r\nX-Forwarded-Host: ${HOST}\r\nCookie: ${GATE_COOKIE}=${token}\r\n\r\n`,
		);
		socket.pause();
		await sleep(100);
		assert.equal((await visit("/hello", { headers: withSession() })).text, "hello");
		await sleep(600);
		socket.resume();
		await closed;
		assert.ok(received < 64 * 1024 * 1024, `the paused answer was cut off (${received} bytes)`);
	});

	it("refuses a body over the limit before it reaches the app", async () => {
		// Only the head is sent: the relay answers from the declared length.
		const status = await new Promise((resolve, reject) => {
			const req = request({
				host: "127.0.0.1",
				port: relayPort,
				method: "POST",
				path: "/echo?too-large",
				agent: false,
				headers: { "x-forwarded-host": HOST, "content-length": String(300 * 1024), ...withSession() },
			});
			req.on("response", (res) => {
				resolve(res.statusCode);
				req.destroy();
			});
			req.on("error", reject);
			req.flushHeaders();
		});
		assert.equal(status, 413);
		assert.ok(!app.seen.some((seen) => seen.url === "/echo?too-large"));
	});

	it("refuses a visitor WebSocket without origin (403) or session (401), and an unknown host's with 404", async () => {
		const noOrigin = await rawUpgrade(relayPort, HOST, "/socket");
		assert.equal(noOrigin.status, 403);
		noOrigin.socket.destroy();
		const noSession = await rawUpgrade(relayPort, HOST, "/socket", `Origin: ${ORIGIN}\r\n`);
		assert.equal(noSession.status, 401);
		noSession.socket.destroy();
		const unknown = await rawUpgrade(relayPort, "evil.example", "/.qorpera/connect");
		assert.equal(unknown.status, 404);
		unknown.socket.destroy();
	});

	it("reconnects with its key after the relay drops the connection", async () => {
		const [program] = programs;
		const key = db.sites.get("shop").key;
		const connects = db.connects().length;
		relay.dropProgram("shop");
		await until(() => program.output.includes("Lost the connection, trying again"), "the program to notice");
		await until(() => program.count("Connected: ") === 2 && relay.isConnected("shop"), "the program to reconnect");
		const again = db.connects().slice(connects);
		assert.equal(again.length, 1);
		assert.ok(again[0].args.p_secret === key, "the key, not the claim");
		assert.equal(again[0].args.p_program, db.connects()[0].args.p_program, "the same program's id");
		assert.ok(db.sites.get("shop").key === key, "no new key");
		// The port line is said once, not on every reconnect.
		assert.equal(program.count("This link is shared for port"), 1);
		assert.equal((await visit("/hello", { headers: withSession() })).text, "hello");
	});

	it("refuses a used claim: that program stops with a plain reason, the running one serves on", async () => {
		const [running] = programs;
		const used = [...db.sites.get("shop").claims.keys()][0];
		const late = linkProgram(used);
		assert.equal(await late.exited, 1);
		assert.match(
			late.output,
			/The relay refused the claim: it was used already or has expired\. Ask the agent to share the app again\./,
		);
		assert.equal(relay.isConnected("shop"), true);
		assert.equal(running.code, undefined);
		assert.equal((await visit("/hello", { headers: withSession() })).status, 200);
	});

	it("lets a newer program replace the older one, which stops", async () => {
		const [older] = programs;
		const newer = linkProgram(db.claim("shop"));
		await until(() => newer.output.includes("Connected: "), "the newer program to connect");
		assert.equal(await older.exited, 0);
		assert.match(older.output, /A newer link program took over this link\. Stopping\./);
		assert.equal(relay.isConnected("shop"), true);
		assert.equal((await visit("/hello", { headers: withSession() })).text, "hello");
		assert.match(logs.join("\n"), /shop: a link program connected, replacing the one before/);
	});

	it("never lets a program serve another site that took its slug: it is dropped and the link is not running", async () => {
		const stale = programs.at(-1);
		// The member unpublished the link; another company's site took the name, and its member unlocked it.
		db.retake("shop");
		const theirs = db.session("shop");
		const reached = app.seen.length;
		const answer = await visit("/hello", { headers: withSession({}, theirs) });
		assert.equal(answer.status, 503);
		assert.match(answer.text, /This app is not running right now/);
		assert.equal(await stale.exited, 1);
		assert.match(
			stale.output,
			/The relay refused this program: the link was turned off or shared again\. Stopping\./,
		);
		assert.equal(relay.isConnected("shop"), false);
		assert.equal(app.seen.length, reached, "nothing reached the old site's app");
		// The new site's own program serves it.
		const own = linkProgram(db.claim("shop"));
		await until(() => own.output.includes("Connected: "), "the new site's program to connect");
		assert.equal((await visit("/hello", { headers: withSession({}, theirs) })).text, "hello");
		token = theirs;
	});

	it("says the app is not running again as soon as its program stops", async () => {
		const newest = programs.at(-1);
		newest.child.kill();
		await newest.exited;
		await until(() => !relay.isConnected("shop"), "the relay to see the program gone", 2000);
		assert.equal((await visit("/hello", { headers: withSession() })).status, 503);
	});

	describe("a program speaking the protocol by hand", () => {
		const session = "L".repeat(32);
		let lab;
		let frames;

		const labVisit = (path, init = {}) =>
			visit(path, { host: LAB, ...init, headers: { cookie: `${GATE_COOKIE}=${session}`, ...init.headers } });
		/** The next request as the relay sends it: its head, then its body to the end message. */
		const nextHead = async () => {
			const head = decodeMessage((await frames.message()).payload);
			assert.equal(head.type, TYPE.head);
			const body = [];
			for (;;) {
				const message = decodeMessage((await frames.message()).payload);
				assert.equal(message.stream, head.stream);
				if (message.type === TYPE.end) break;
				assert.equal(message.type, TYPE.body);
				body.push(message.payload);
			}
			return { ...head, body: Buffer.concat(body) };
		};
		const answerWith = (stream, status, headers, ...chunks) => {
			lab.socket.write(
				encodeFrame(0x2, encodeMessage(TYPE.response, stream, Buffer.from(JSON.stringify({ status, headers }))), {
					mask: mask(),
				}),
			);
			for (const chunk of chunks)
				lab.socket.write(encodeFrame(0x2, encodeMessage(TYPE.body, stream, Buffer.from(chunk)), { mask: mask() }));
		};
		const endStream = (stream) =>
			lab.socket.write(encodeFrame(0x2, encodeMessage(TYPE.end, stream), { mask: mask() }));

		it("connects: the database first, then the handshake, then hello with the key, the url and the port", async () => {
			db.sites.get("lab").sessions.add(session);
			lab = await rawUpgrade(relayPort, LAB, "/.qorpera/connect", bearer(db.claim("lab")));
			assert.equal(lab.status, 101);
			const accept = acceptKey({
				upgrade: "websocket",
				connection: "Upgrade",
				"sec-websocket-version": "13",
				"sec-websocket-key": lab.key,
			});
			assert.ok(lab.head.includes(`\r\nSec-WebSocket-Accept: ${accept}`));
			frames = frameReader(lab.socket, lab.rest);
			const hello = decodeMessage((await frames.message()).payload);
			assert.deepEqual([hello.type, hello.stream], [TYPE.hello, 0]);
			const said = JSON.parse(hello.payload.toString());
			assert.deepEqual(Object.keys(said), ["key", "url", "port", "window"]);
			assert.ok(said.key === db.sites.get("lab").key);
			assert.equal(said.url, `https://${LAB}/`);
			assert.equal(said.port, appPort);
		});

		it("answers a ping with its payload", async () => {
			lab.socket.write(encodeFrame(0x9, Buffer.from("are you there"), { mask: mask() }));
			const pong = await frames.message();
			assert.equal(pong.opcode, 0xa);
			assert.equal(pong.payload.toString(), "are you there");
		});

		it("serves a visitor frame by frame, the answer in fragments, its hop-by-hop headers dropped", async () => {
			const visitor = labVisit("/by-hand?x=1", { method: "POST", body: "ping" });
			const head = await nextHead();
			const asked = JSON.parse(head.payload.toString());
			assert.equal(asked.method, "POST");
			assert.equal(asked.path, "/by-hand?x=1");
			assert.deepEqual(values(asked.headers, "host"), [LAB]);
			assert.equal(head.body.toString(), "ping");
			const response = encodeMessage(
				TYPE.response,
				head.stream,
				Buffer.from(
					JSON.stringify({
						status: 200,
						headers: [
							["content-type", "text/plain"],
							["Connection", "x-drop"],
							["x-drop", "1"],
						],
					}),
				),
			);
			lab.socket.write(encodeFrame(0x2, response.subarray(0, 7), { mask: mask(), fin: false }));
			lab.socket.write(encodeFrame(0x0, response.subarray(7), { mask: mask() }));
			lab.socket.write(
				encodeFrame(0x2, encodeMessage(TYPE.body, head.stream, Buffer.from("pong")), { mask: mask() }),
			);
			endStream(head.stream);
			const served = await visitor;
			assert.equal(served.status, 200);
			assert.equal(served.text, "pong");
			assert.equal(served.headers["x-drop"], undefined);
		});

		it("never writes past an answer's Content-Length: the visitor's connection ends instead", async () => {
			for (const [declared, chunks] of [
				["2", ["0123456789"]],
				["2", ["ab", "HTTP/1.1 200 OK\r\ncontent-length: 6\r\n\r\nforged"]],
				["5", ["ab"]],
			]) {
				// A kept-alive connection: only the relay's ending it stops a next answer from following on it.
				const wire = rawRequest(
					relayPort,
					`GET /declared HTTP/1.1\r\nHost: x\r\nX-Forwarded-Host: ${LAB}\r\nCookie: ${GATE_COOKIE}=${session}\r\n\r\n`,
				);
				const head = await nextHead();
				answerWith(head.stream, 200, [["content-length", declared]], ...chunks);
				endStream(head.stream);
				const got = await wire;
				const label = `${declared} ${chunks.join("|")}`;
				const [, body = ""] = got.split("\r\n\r\n");
				assert.ok(body.length <= Math.min(2, Number(declared)), `${label}: ${JSON.stringify(body)}`);
				assert.equal(got.split("HTTP/1.1").length - 1, 1, `${label}: one answer only`);
				assert.doesNotMatch(got, /forged/);
				// The relay told the program the stream is over.
				const reset = decodeMessage((await frames.message()).payload);
				assert.deepEqual([reset.type, reset.stream], [TYPE.reset, head.stream]);
			}
			// The program itself is fine.
			assert.equal(relay.isConnected("lab"), true);
			const visitor = labVisit("/after");
			const head = await nextHead();
			answerWith(head.stream, 200, [["content-length", "2"]], "ok");
			endStream(head.stream);
			assert.equal((await visitor).text, "ok");
		});

		it("refuses an answer that names its length twice or not in digits: 502, and the stream is reset", async () => {
			for (const headers of [
				[
					["content-length", "2"],
					["Content-Length", "2"],
				],
				[
					["content-length", "2"],
					["content-length", "7"],
				],
				[["content-length", "+2"]],
				[["content-length", "0x2"]],
				[["content-length", ""]],
			]) {
				const visitor = labVisit("/length");
				const head = await nextHead();
				answerWith(head.stream, 200, headers, "ab");
				endStream(head.stream);
				const answer = await visitor;
				assert.equal(answer.status, 502, JSON.stringify(headers));
				assert.match(answer.text, /The app is not answering/);
				const reset = decodeMessage((await frames.message()).payload);
				assert.deepEqual([reset.type, reset.stream], [TYPE.reset, head.stream]);
			}
			assert.equal(relay.isConnected("lab"), true);
		});

		it("ends the connection with 1002 on a frame that is not masked", async () => {
			lab.socket.write(encodeFrame(0x2, encodeMessage(TYPE.keepalive, 0)));
			const close = await frames.message();
			assert.equal(close.opcode, 0x8);
			assert.equal(close.payload.readUInt16BE(0), 1002);
			// The close handshake: answered, then the relay ends the connection.
			lab.socket.write(encodeFrame(0x8, close.payload.subarray(0, 2), { mask: mask() }));
			await frames.closed;
			await until(() => !relay.isConnected("lab"), "the lab program to be gone");
		});

		it("refuses with 4001 what is no claim or key with a program id, asking the database only for a well-formed one", async () => {
			const asked = db.connects().length;
			for (const extra of [
				"",
				bearer("w".repeat(43)),
				`Authorization: Basic abc\r\nX-Qorpera-Program: ${PROGRAM}\r\n`,
				`Authorization: Bearer ${db.claim("lab")}\r\n`,
				bearer(db.claim("lab"), "short"),
				bearer(db.claim("lab"), `${PROGRAM.slice(1)}!`),
			]) {
				const refused = await rawUpgrade(relayPort, LAB, "/.qorpera/connect", extra);
				assert.equal(refused.status, 101);
				const frame = await frameReader(refused.socket, refused.rest).message();
				assert.equal(frame.opcode, 0x8);
				assert.equal(frame.payload.readUInt16BE(0), CLOSE.refused);
				assert.equal(frame.payload.subarray(2).toString(), "refused");
				refused.socket.destroy();
			}
			assert.equal(db.connects().length - asked, 1);
		});

		it("closes on an oversized frame, a text frame, a reserved bit and a flood of pings", async () => {
			const key = db.sites.get("lab").key;
			// More than twice the limit, so a second's turn between them cannot hide it.
			const pings = Buffer.concat(
				Array.from({ length: 25 }, () => encodeFrame(0x9, Buffer.from("p"), { mask: mask() })),
			);
			for (const [frame, code] of [
				[Buffer.concat([Buffer.from([0x82, 0xff]), Buffer.alloc(8, 0).fill(0xff, 5)]), 1009],
				[encodeFrame(0x1, Buffer.from("text"), { mask: mask() }), 1003],
				[Buffer.from([0xc2, 0x80, 1, 2, 3, 4]), 1002],
				[pings, CLOSE.tooManyPings],
			]) {
				const socket = await rawUpgrade(relayPort, LAB, "/.qorpera/connect", bearer(key));
				const reader = frameReader(socket.socket, socket.rest);
				assert.equal(decodeMessage((await reader.message()).payload).type, TYPE.hello);
				socket.socket.write(frame);
				let close;
				do close = await reader.next();
				while (close.opcode !== 0x8);
				assert.equal(close.payload.readUInt16BE(0), code);
				socket.socket.destroy();
			}
		});
	});

	it("never logs or prints a claim, key, token, password or cookie", () => {
		const said = [...logs, ...programs.map((program) => program.output)].join("\n");
		assert.ok(logs.length > 0);
		for (const secret of [...db.secrets, PASSWORD, ANON_KEY, RELAY_JWT, token])
			assert.ok(!said.includes(secret), "a secret was logged");
		assert.doesNotMatch(said, /__Host-qorpera_app/);
	});
});

describe("app relay: connecting, keepalives and the recheck", () => {
	/** A relay with these options and a lab program connected by hand; everything closes when the test ends. */
	async function setup(t, options) {
		const db = fakeDatabase();
		db.sites.get("lab").port = 3000;
		const dbPort = await listen(db.server);
		const relay = createRelay({
			api: `http://127.0.0.1:${dbPort}`,
			...RELAY,
			hostSuffix: SUFFIX,
			log: () => {},
			...options,
		});
		const port = await listen(relay);
		const lab = await rawUpgrade(port, LAB, "/.qorpera/connect", bearer(db.claim("lab")));
		t.after(async () => {
			lab.socket.destroy();
			await new Promise((resolve) => relay.close(resolve));
			db.server.close();
			db.server.closeAllConnections();
		});
		const frames = frameReader(lab.socket, lab.rest);
		assert.equal(decodeMessage((await frames.next()).payload).type, TYPE.hello);
		return { db, relay, port, lab, frames };
	}

	it("sends keepalives, and drops a program that stays silent", async (t) => {
		const { relay, frames } = await setup(t, { keepaliveMs: 100, silentMs: 400, recheckMs: 0 });
		const keepalive = decodeMessage((await frames.next()).payload);
		assert.deepEqual([keepalive.type, keepalive.stream, keepalive.payload.length], [TYPE.keepalive, 0, 0]);
		await frames.closed;
		await until(() => !relay.isConnected("lab"), "the silent program to be dropped", 2000);
	});

	it("checks a program again: a key that no longer holds ends it with 4001", async (t) => {
		const { db, relay, frames } = await setup(t, { recheckMs: 150 });
		await sleep(400);
		assert.equal(relay.isConnected("lab"), true, "the key holds");
		assert.ok(db.connects().length >= 2, "checked again");
		db.sites.get("lab").key = null;
		const close = await frames.message(3000);
		assert.equal(close.opcode, 0x8);
		assert.equal(close.payload.readUInt16BE(0), CLOSE.refused);
	});

	it("checks a program again: another site under its slug ends it with 4001", async (t) => {
		const { db, frames } = await setup(t, { recheckMs: 150 });
		const key = db.sites.get("lab").key;
		// The same key answers for a new site of the slug: not this program's site.
		db.retake("lab").key = key;
		const close = await frames.message(3000);
		assert.equal(close.payload.readUInt16BE(0), CLOSE.refused);
	});

	it("checks a program again: a changed port tries live swap and closes with 1012 when swap fails", async (t) => {
		const { db, relay, lab, frames } = await setup(t, { recheckMs: 150 });
		db.sites.get("lab").port = 3001;
		const swapReq = await frames.message(3000);
		assert.equal(swapReq.opcode, 0x2);
		const decoded = decodeMessage(swapReq.payload);
		assert.equal(decoded.type, TYPE.swapTarget);
		assert.equal(JSON.parse(decoded.payload.toString("utf8")).port, 3001);
		lab.socket.write(
			encodeFrame(
				0x2,
				encodeMessage(
					TYPE.swapTarget,
					0,
					Buffer.from(JSON.stringify({ ok: false, activePort: 3000, error: "target unhealthy" })),
				),
				{ mask: Buffer.from([5, 6, 7, 8]) },
			),
		);
		const close = await frames.message(3000);
		assert.equal(close.opcode, 0x8);
		assert.equal(close.payload.readUInt16BE(0), CLOSE.portChanged);
		assert.equal(relay.isConnected("lab"), false);
	});

	it("answers 503 before the handshake when the database cannot answer a connect, so the program tries again", async (t) => {
		const failing = createServer((_req, res) => {
			res.writeHead(500);
			res.end("{}");
		});
		const dbPort = await listen(failing);
		const relay = createRelay({ api: `http://127.0.0.1:${dbPort}`, ...RELAY, hostSuffix: SUFFIX, log: () => {} });
		const port = await listen(relay);
		t.after(async () => {
			await new Promise((resolve) => relay.close(resolve));
			failing.close();
			failing.closeAllConnections();
		});
		const lab = await rawUpgrade(port, LAB, "/.qorpera/connect", bearer("c".repeat(43)));
		assert.equal(lab.status, 503);
		lab.socket.destroy();
	});

	it("asks again before it drops a program: a kept session of an earlier site is locked, the new site's program serves on", async (t) => {
		const { db, relay, port, lab, frames } = await setup(t, { sessionCacheMs: 30_000, recheckMs: 0 });
		const earlier = db.session("lab");
		// A visitor of the earlier site, served by its program; the open answer is kept for 30 s.
		const first = get(port, LAB, "/x", earlier);
		respond(lab.socket, (await nextRequest(frames)).stream, 200, [["content-length", "3"]], ["one"]);
		assert.equal((await first).text, "one");
		// The member deletes the link; the name is shared again at once, and the new site's program connects.
		db.retake("lab");
		const newer = await rawUpgrade(
			port,
			LAB,
			"/.qorpera/connect",
			bearer(db.claim("lab"), randomBytes(32).toString("base64url")),
		);
		t.after(() => newer.socket.destroy());
		const newFrames = frameReader(newer.socket, newer.rest);
		assert.equal(decodeMessage((await newFrames.message()).payload).type, TYPE.hello);
		assert.equal((await frames.message()).payload.readUInt16BE(0), CLOSE.replaced);
		// The earlier visitor's kept answer names the earlier site: asked again, the session is locked, nothing dropped.
		const asked = db.connects().length;
		const stale = await get(port, LAB, "/x", earlier);
		assert.equal(stale.status, 401);
		assert.deepEqual(stale.headers["set-cookie"], [CLEAR_GATE_COOKIE]);
		assert.equal(relay.isConnected("lab"), true);
		assert.equal(db.connects().length, asked);
		// The new site's program serves its own visitors.
		const visitor = get(port, LAB, "/y", db.session("lab"));
		respond(newer.socket, (await nextRequest(newFrames)).stream, 200, [["content-length", "3"]], ["two"]);
		assert.equal((await visitor).text, "two");
	});

	it("completes no handshake before the database answers, and holds connects in flight to a total", async (t) => {
		const asked = [];
		let answer;
		const gate = new Promise((resolve) => {
			answer = resolve;
		});
		const fetcher = async (_url, init) => {
			asked.push(JSON.parse(init.body));
			await gate;
			return Response.json({ state: "ok", key: null, port: 3000, siteId: randomUUID() });
		};
		const relay = createRelay({
			api: "http://database.invalid",
			...RELAY,
			hostSuffix: SUFFIX,
			fetch: fetcher,
			connectLimit: { refusedPerMinute: 2, total: 2 },
			log: () => {},
		});
		const port = await listen(relay);
		const sockets = [];
		t.after(async () => {
			for (const socket of sockets) socket.destroy();
			await new Promise((resolve) => relay.close(resolve));
		});
		const attempt = (address) => {
			const { socket } = handshake(
				port,
				LAB,
				"/.qorpera/connect",
				`${bearer("k".repeat(43))}CF-Connecting-IP: ${address}\r\n`,
			);
			sockets.push(socket);
			const got = [];
			socket.on("data", (chunk) => got.push(chunk));
			socket.on("error", () => {});
			return { socket, got, head: answerHead(socket) };
		};
		const first = attempt("203.0.113.1");
		const second = attempt("198.51.100.7");
		await until(() => asked.length === 2, "the database to be asked twice");
		// Two in flight, the total: the next waits, whatever its address.
		assert.equal((await attempt("192.0.2.3").head).status, 429);
		await sleep(100);
		assert.equal(first.got.length, 0, "nothing written before the database answered");
		assert.deepEqual(asked[0], { p_slug: "lab", p_secret: "k".repeat(43), p_program: PROGRAM });
		answer();
		assert.equal((await first.head).status, 101);
		assert.equal((await second.head).status, 101);
		assert.equal((await attempt("192.0.2.3").head).status, 101);
		assert.equal(asked.length, 3);
	});

	it("counts only refused connects, per address (an IPv6 /64) and link, and never the agent exits' addresses", async (t) => {
		const asked = [];
		// A secret that starts with "r" is refused; any other is taken.
		const fetcher = async (_url, init) => {
			const args = JSON.parse(init.body);
			asked.push(args);
			return Response.json(
				args.p_secret.startsWith("r")
					? { state: "refused" }
					: { state: "ok", key: null, port: 3000, siteId: randomUUID() },
			);
		};
		const relay = createRelay({
			api: "http://database.invalid",
			...RELAY,
			hostSuffix: SUFFIX,
			fetch: fetcher,
			connectLimit: { refusedPerMinute: 2, total: 100 },
			trustedAddresses: [" 192.0.2.50", "2001:DB8:FFFF::1"],
			log: () => {},
		});
		const port = await listen(relay);
		const sockets = [];
		t.after(async () => {
			for (const socket of sockets) socket.destroy();
			await new Promise((resolve) => relay.close(resolve));
		});
		const attempt = async (address, { refused = false, host = LAB, extra } = {}) => {
			const { socket } = handshake(
				port,
				host,
				"/.qorpera/connect",
				`${extra ?? bearer((refused ? "r" : "k").repeat(43))}CF-Connecting-IP: ${address}\r\n`,
			);
			socket.on("error", () => {});
			sockets.push(socket);
			return (await answerHead(socket)).status;
		};
		// Malformed: refused at once (101, then 4001), asking and counting nothing.
		for (let i = 0; i < 5; i++) assert.equal(await attempt("203.0.113.1", { extra: "" }), 101);
		assert.equal(asked.length, 0);
		// Two refusals for this address and link, then it waits, whatever it sends; other links and addresses do not.
		assert.equal(await attempt("203.0.113.1", { refused: true }), 101);
		assert.equal(await attempt("203.0.113.1", { refused: true }), 101);
		assert.equal(await attempt("203.0.113.1"), 429);
		assert.equal(await attempt("203.0.113.1", { host: HOST }), 101);
		assert.equal(await attempt("203.0.113.2"), 101);
		// An IPv6 host stands for its /64.
		assert.equal(await attempt("2001:db8:1:2::1", { refused: true }), 101);
		assert.equal(await attempt("2001:db8:1:2:aaaa::9", { refused: true }), 101);
		assert.equal(await attempt("2001:db8:1:2::ffff"), 429);
		assert.equal(await attempt("2001:db8:1:3::1"), 101);
		// Connects that are taken never count.
		for (let i = 0; i < 4; i++) assert.equal(await attempt("198.51.100.9"), 101);
		// The agent exits' addresses: every company's machines, never held back.
		for (const address of ["192.0.2.50", "2001:db8:ffff:0:0:0:0:1"]) {
			for (let i = 0; i < 4; i++) assert.equal(await attempt(address, { refused: true }), 101, address);
			assert.equal(await attempt(address), 101, address);
		}
		assert.ok(asked.every((args) => args.p_program === PROGRAM));
		assert.throws(
			() => createRelay({ api: "http://x", ...RELAY, trustedAddresses: ["agent-exit.example"] }),
			/trusted/,
		);
	});
});

describe("app relay: the pure parts", () => {
	it("reads the app host from x-forwarded-host only, a slug and the suffix exactly", () => {
		assert.deepEqual(appHost("shop-preview.qorpera.com"), { host: "shop-preview.qorpera.com", slug: "shop" });
		assert.deepEqual(appHost("SAML-Shop-Preview.Qorpera.com"), {
			host: "saml-shop-preview.qorpera.com",
			slug: "saml-shop",
		});
		assert.deepEqual(appHost("x-preview-preview.qorpera.com"), {
			host: "x-preview-preview.qorpera.com",
			slug: "x-preview",
		});
		for (const host of [
			undefined,
			"",
			"-preview.qorpera.com",
			"ab-preview.qorpera.com",
			"shop-preview.qorpera.com.",
			"shop-preview.qorpera.com:443",
			"shop-preview.qorpera.comx",
			"a.shop-preview.qorpera.com",
			"shop-preview.qorpera.com, shop-preview.qorpera.com",
			"shop-previewxqorpera.com",
			"sites.qorpera.com",
		])
			assert.equal(appHost(host), null, String(host));
		assert.deepEqual(appHost("shop-preview.example.test", SUFFIX), {
			host: "shop-preview.example.test",
			slug: "shop",
		});
	});

	it("tells a change from another site by the method, Sec-Fetch-Site and Origin", () => {
		const host = "shop-preview.qorpera.com";
		const own = `https://${host}`;
		const refused = (method, headers) => changeFromAnotherSite(method, headers, host);
		for (const method of ["GET", "HEAD", "OPTIONS"])
			assert.equal(
				refused(method, { origin: "https://evil.example", "sec-fetch-site": "cross-site" }),
				false,
				method,
			);
		for (const method of ["POST", "PUT", "PATCH", "DELETE", "PROPFIND", "get"]) {
			assert.equal(refused(method, {}), false, `${method}: neither header`);
			assert.equal(refused(method, { origin: own }), false, `${method}: own origin`);
			assert.equal(refused(method, { origin: own, "sec-fetch-site": "same-origin" }), false, method);
			assert.equal(refused(method, { "sec-fetch-site": "none" }), false, `${method}: typed in`);
			assert.equal(refused(method, { origin: "null", "sec-fetch-site": "same-origin" }), false, `${method}: null`);
			for (const site of ["same-site", "cross-site"])
				for (const origin of [undefined, own, "null"])
					assert.equal(refused(method, { "sec-fetch-site": site, origin }), true, `${method} ${site} ${origin}`);
			for (const origin of [
				"null",
				"https://lab-preview.qorpera.com",
				"https://shop.qorpera.com",
				"https://qorpera.com",
				`http://${host}`,
				`https://${host}:443`,
				`https://${host}.`,
				`${own}/`,
				`https://SHOP-preview.qorpera.com`,
				`${own}, ${own}`,
				"",
			]) {
				assert.equal(refused(method, { origin }), true, `${method} ${origin}`);
				assert.equal(refused(method, { origin, "sec-fetch-site": "none" }), true, `${method} ${origin} none`);
			}
			assert.equal(refused(method, { origin: "https://evil.example", "sec-fetch-site": "same-origin" }), true);
		}
	});

	it("reads gate cookies and takes them out of what the app gets", () => {
		const a = "A".repeat(32);
		const b = "b".repeat(32);
		assert.deepEqual(gateTokens(`x=1; ${GATE_COOKIE}=${a}; ${GATE_COOKIE}=${b}; ${GATE_COOKIE}=${a}`), [a, b]);
		assert.deepEqual(gateTokens(`${GATE_COOKIE}=short; __host-qorpera_app=${a}`), []);
		assert.deepEqual(gateTokens(undefined), []);
		assert.equal(withoutGateCookie(`x=1; ${GATE_COOKIE}=${a};y=2`), "x=1; y=2");
		assert.equal(withoutGateCookie(`${GATE_COOKIE}=${a}; __HOST-QORPERA_APP=z`), null);
		assert.equal(CLEAR_GATE_COOKIE, `${GATE_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`);
	});

	it("filters what goes to the app and what comes back", () => {
		const raw = [
			"Host",
			"evil.example",
			"Connection",
			"keep-alive, X-Secret-Hop",
			"Keep-Alive",
			"timeout=5",
			"Transfer-Encoding",
			"chunked",
			"TE",
			"trailers",
			"Upgrade",
			"h2c",
			"Proxy-Authorization",
			"Basic x",
			"X-Secret-Hop",
			"1",
			"Expect",
			"100-continue",
			"X-Forwarded-For",
			"198.51.100.1",
			"X-Envoy-Expected-Rq-Timeout-Ms",
			"15000",
			"Cookie",
			`${GATE_COOKIE}=${"t".repeat(32)}`,
			"Accept",
			"text/html",
			"Authorization",
			"Basic YXBwOmFwcA==",
		];
		assert.deepEqual(requestHeaders(raw, { host: "shop-preview.qorpera.com", client: "203.0.113.9" }), [
			["host", "shop-preview.qorpera.com"],
			["Accept", "text/html"],
			["Authorization", "Basic YXBwOmFwcA=="],
			["x-forwarded-proto", "https"],
			["x-forwarded-host", "shop-preview.qorpera.com"],
			["x-forwarded-for", "203.0.113.9"],
		]);
		// A chunked body goes on chunked, the visitor's own header never.
		assert.deepEqual(
			values(requestHeaders(raw, { host: "h-preview.qorpera.com", client: "", chunked: true }), "transfer-encoding"),
			["chunked"],
		);
		assert.deepEqual(
			values(requestHeaders([], { host: "h-preview.qorpera.com", client: "" }), "x-forwarded-for"),
			[],
			"no address, no X-Forwarded-For",
		);
		assert.deepEqual(
			responseHeaders([
				["Content-Type", "text/html"],
				["Connection", "close, X-Drop"],
				["X-Drop", "1"],
				["Transfer-Encoding", "chunked"],
				["Set-Cookie", "s=1; Domain=qorpera.com; Secure"],
				["Set-Cookie", "t=2;domain=x;Domain;path=/"],
				["set-cookie", `${GATE_COOKIE.toLowerCase()}=x`],
				["Set-Cookie", `=${GATE_COOKIE}=x`],
				["Set-Cookie", `${GATE_COOKIE}`],
				["Set-Cookie", `${GATE_COOKIE}x=1`],
				["Bad Name", "x"],
				["X-Bad", "a\r\nb"],
				["Cache-Control", "public, max-age=31536000"],
				["expires", "Thu, 01 Jan 2099 00:00:00 GMT"],
				["CDN-Cache-Control", "max-age=60"],
				["Cloudflare-CDN-Cache-Control", "max-age=60"],
				["Surrogate-Control", "max-age=60"],
				["Location", "/next"],
			]),
			[
				["Content-Type", "text/html"],
				["Set-Cookie", "s=1; Secure"],
				["Set-Cookie", "t=2;path=/"],
				["Set-Cookie", `${GATE_COOKIE}x=1`],
				["Location", "/next"],
				["cache-control", "private, max-age=31536000"],
				["cdn-cache-control", "no-store"],
			],
		);
		assert.deepEqual(
			responseHeaders([]),
			FORWARDED_CACHE_HEADERS.map((pair) => [...pair]),
		);
		for (const value of ["no-store", "No-Store", "private, max-age=0, no-store", "no-cache,no-store"])
			assert.deepEqual(
				values(responseHeaders([["Cache-Control", value]]), "cache-control"),
				["private, no-store"],
				value,
			);
		for (const value of ["no-storefront", "public"])
			assert.deepEqual(
				values(responseHeaders([["Cache-Control", value]]), "cache-control"),
				["private, no-cache"],
				value,
			);
		assert.deepEqual(values(responseHeaders([["Cache-Control", "max-age=60"]]), "cache-control"), [
			"private, max-age=60",
		]);
		assert.deepEqual(values(responseHeaders([["Cache-Control", "max-age=60"]]), "cdn-cache-control"), ["no-store"]);
		assert.deepEqual(
			values(responseHeaders([["Cache-Control", "public, max-age=120, immutable"]], { isPublic: true }), "cache-control"),
			["public, max-age=120, immutable"],
		);
		assert.deepEqual(
			values(responseHeaders([["Content-Type", "text/event-stream"]]), "x-accel-buffering"),
			["no"],
		);
		assert.deepEqual(
			values(responseHeaders([["Content-Type", "text/event-stream"]]), "cache-control"),
			["no-cache, no-transform"],
		);
		// One Content-Length, in digits only: Node would take +2 or 0x2, and write every copy.
		assert.deepEqual(values(responseHeaders([["Content-Length", "12"]]), "content-length"), ["12"]);
		for (const lengths of [["2", "2"], ["2", "7"], ["+2"], ["0x2"], [""], ["2 2"], ["-1"], ["1".repeat(16)]])
			assert.equal(
				responseHeaders(lengths.map((value, index) => [index ? "Content-Length" : "content-length", value])),
				null,
				lengths.join("|"),
			);
		assert.equal(responseHeaders("x"), null);
		assert.equal(responseHeaders([["a", 1]]), null);
		assert.equal(responseHeaders([["a"]]), null);
		assert.equal(appCookie("a=1; Path=/"), "a=1; Path=/");
	});

	it("keeps next a path on this host", () => {
		assert.equal(safeNext("/a/b?c=1&d=%2F"), "/a/b?c=1&d=%2F");
		for (const next of [
			"",
			"a",
			"//x",
			"/\\x",
			"/a\\b",
			"/a b",
			"/a\nb",
			"https://x/",
			"/.qorpera/unlock",
			"/.QORPERA/x",
			"/%2eqorpera/x",
			`/${"a".repeat(2048)}`,
			null,
		])
			assert.equal(safeNext(next), "/", String(next));
	});

	it("escapes what the password page echoes, and picks Danish only when preferred", () => {
		const html = passwordPage("en", `/"><script>`);
		assert.match(html, /value="\/&quot;&gt;&lt;script&gt;"/);
		assert.doesNotMatch(html, /<script>/);
		assert.equal(language("da-DK,da;q=0.9,en;q=0.8"), "da");
		assert.equal(language("en-GB,da;q=0.8"), "en");
		assert.equal(language(undefined), "en");
	});

	it("groups an address's refused connects: an IPv4 address itself, an IPv6 address by its /64", () => {
		assert.equal(addressGroup("203.0.113.9"), "203.0.113.9");
		assert.equal(addressGroup(""), "");
		for (const [address, group] of [
			["2001:db8::1", "2001:db8:0:0::/64"],
			["2001:db8:aa:bb:1:2:3:4", "2001:db8:aa:bb::/64"],
			["2001:db8:aa:bb::9", "2001:db8:aa:bb::/64"],
			["::1", "0:0:0:0::/64"],
			["fe80::", "fe80:0:0:0::/64"],
		])
			assert.equal(addressGroup(clientAddress(address)), group, address);
		assert.equal(
			addressGroup(clientAddress("2001:0DB8:0001:0002:ffff::")),
			addressGroup(clientAddress("2001:db8:1:2:0:0:0:1")),
		);
	});

	it("keys the limits on CF-Connecting-IP's one address", () => {
		assert.equal(clientAddress("203.0.113.9"), "203.0.113.9");
		assert.equal(clientAddress("2001:DB8:0:0:0:0:0:1"), "2001:db8::1");
		assert.equal(clientAddress("::ffff:203.0.113.9"), "203.0.113.9");
		for (const value of ["203.0.113.9, 198.51.100.1", "localhost", "", undefined, "203.0.113.9:443"])
			assert.equal(clientAddress(value), "", String(value));
	});

	it("encodes and decodes frames: lengths of 7, 16 and 64 bits, masks, fragments, control frames", () => {
		for (const length of [0, 125, 126, 65535, 65536, 200_000]) {
			const payload = randomBytes(length);
			const server = encodeFrame(0x2, payload);
			const decoded = decodeFrame(server, { masked: false });
			assert.equal(decoded.size, server.length);
			assert.ok(decoded.fin);
			assert.deepEqual(decoded.payload, payload);
			const masked = encodeFrame(0x2, payload, { mask: mask(), fin: false });
			const fromClient = decodeFrame(Buffer.concat([masked, Buffer.from([1, 2])]), { masked: true });
			assert.equal(fromClient.size, masked.length);
			assert.equal(fromClient.fin, false);
			assert.deepEqual(fromClient.payload, payload);
			// Any prefix is not a frame yet.
			assert.equal(decodeFrame(masked.subarray(0, masked.length - 1), { masked: true }), null);
		}
		assert.equal(decodeFrame(Buffer.from([0x82])), null);
		const expect = (frame, code, options = {}) =>
			assert.throws(
				() => decodeFrame(frame, options),
				(error) => error instanceof WebSocketError && error.code === code,
			);
		expect(encodeFrame(0x2, Buffer.from("x")), 1002); // a client's frame must be masked
		expect(encodeFrame(0x2, Buffer.from("x"), { mask: mask() }), 1002, { masked: false });
		expect(Buffer.from([0xc2, 0x80, 0, 0, 0, 0]), 1002); // RSV1
		expect(Buffer.from([0x83, 0x80, 0, 0, 0, 0]), 1002); // opcode 3
		expect(encodeFrame(0x9, Buffer.alloc(126), { mask: mask() }), 1002); // a control frame over 125
		expect(encodeFrame(0x9, Buffer.alloc(1), { mask: mask(), fin: false }), 1002); // a fragmented control frame
		expect(encodeFrame(0x2, Buffer.alloc(1025), { mask: mask() }), 1009, { maxPayload: 1024 });
		const huge = Buffer.alloc(14);
		huge[0] = 0x82;
		huge[1] = 0xff;
		huge.writeBigUInt64BE(2n ** 62n, 2);
		expect(huge, 1009);
		const handshakeHeaders = (overrides) => ({
			upgrade: "websocket",
			connection: "Upgrade",
			"sec-websocket-version": "13",
			"sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
			...overrides,
		});
		assert.equal(acceptKey(handshakeHeaders({})), "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");
		assert.equal(acceptKey(handshakeHeaders({ "sec-websocket-version": "8" })), null);
		assert.equal(acceptKey(handshakeHeaders({ connection: "keep-alive" })), null);
		assert.equal(acceptKey(handshakeHeaders({ "sec-websocket-key": "short" })), null);
	});

	it("cuts off a peer that lets too much pile up, pongs included, and one that pings too often", () => {
		class FakeSocket extends EventEmitter {
			writableLength = 0;
			written = [];
			destroyed = false;
			setNoDelay() {}
			setTimeout() {}
			setKeepAlive() {}
			resume() {}
			pause() {}
			end() {}
			write(data) {
				this.written.push(data);
				return true;
			}
			destroy() {
				this.destroyed = true;
			}
		}
		const full = new FakeSocket();
		const ws = new WebSocketConnection(full, null);
		full.writableLength = MAX_QUEUED_BYTES - 10;
		ws.send(Buffer.alloc(4));
		assert.equal(full.destroyed, false);
		ws.send(Buffer.alloc(20));
		assert.equal(full.destroyed, true);
		const pongs = new FakeSocket();
		new WebSocketConnection(pongs, null, { maxQueued: 1024 });
		pongs.writableLength = 1024;
		pongs.emit("data", encodeFrame(0x9, Buffer.from("p"), { mask: mask() }));
		assert.equal(pongs.destroyed, true);
		assert.equal(pongs.written.length, 0);
		const flood = new FakeSocket();
		new WebSocketConnection(flood, null, { pingsPerSecond: 3 });
		flood.emit(
			"data",
			Buffer.concat(Array.from({ length: 5 }, () => encodeFrame(0x9, Buffer.alloc(0), { mask: mask() }))),
		);
		const sent = flood.written.map((frame) => decodeFrame(frame, { masked: false }));
		assert.deepEqual(
			sent.map((frame) => frame.opcode),
			[0xa, 0xa, 0xa, 0x8],
		);
		assert.equal(sent[3].payload.readUInt16BE(0), CLOSE.tooManyPings);
	});

	it("frames messages as a type, a 4-byte stream id and the payload", () => {
		const message = encodeMessage(TYPE.body, 0xfffffffe, Buffer.from("abc"));
		assert.deepEqual([...message.subarray(0, 5)], [2, 0xff, 0xff, 0xff, 0xfe]);
		const decoded = decodeMessage(message);
		assert.deepEqual([decoded.type, decoded.stream, decoded.payload.toString()], [TYPE.body, 0xfffffffe, "abc"]);
		assert.throws(() => decodeMessage(Buffer.from([1, 0, 0])));
		assert.deepEqual(TYPE, {
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
	});

	it("validates visitor WebSocket origins, protocols, headers and RFC 6455 close codes", () => {
		const host = "shop-preview.qorpera.com";
		const own = `https://${host}`;
		assert.equal(isValidVisitorWsOrigin({ origin: own }, host), true);
		assert.equal(isValidVisitorWsOrigin({ origin: own, "sec-fetch-site": "same-origin" }, host), true);
		assert.equal(isValidVisitorWsOrigin({ origin: own }, host, ["Origin", own]), true);
		for (const headers of [
			{},
			{ origin: "" },
			{ origin: "null" },
			{ origin: "null", "sec-fetch-site": "same-origin" },
			{ origin: `http://${host}` },
			{ origin: `${own}:443` },
			{ origin: `${own}/` },
			{ origin: "https://lab-preview.qorpera.com" },
			{ origin: "https://evil.example" },
			{ origin: "https://SHOP-preview.qorpera.com" },
			{ origin: own, "sec-fetch-site": "cross-site" },
			{ origin: own, "sec-fetch-site": "same-site" },
		]) {
			assert.equal(isValidVisitorWsOrigin(headers, host), false, JSON.stringify(headers));
		}
		assert.equal(
			isValidVisitorWsOrigin({ origin: own }, host, ["Origin", own, "Origin", "https://evil.example"]),
			false,
		);

		assert.deepEqual(parseWsProtocols([]), { ok: true, protocols: [] });
		assert.deepEqual(parseWsProtocols(["Sec-WebSocket-Protocol", "vite-hmr, chat.v1"]), {
			ok: true,
			protocols: ["vite-hmr", "chat.v1"],
		});
		assert.deepEqual(
			parseWsProtocols(["Sec-WebSocket-Protocol", "vite-hmr", "sec-websocket-protocol", "graphql-ws"]),
			{ ok: true, protocols: ["vite-hmr", "graphql-ws"] },
		);
		for (const bad of [
			["Sec-WebSocket-Protocol", ""],
			["Sec-WebSocket-Protocol", "a, a"],
			["Sec-WebSocket-Protocol", "bad protocol"],
			["Sec-WebSocket-Protocol", "a,"],
			["Sec-WebSocket-Protocol", "a".repeat(257)],
		]) {
			assert.equal(parseWsProtocols(bad).ok, false, JSON.stringify(bad));
		}

		const wsReq = wsRequestHeaders(
			[
				"Host",
				"evil.example",
				"Connection",
				"Upgrade, X-Hop",
				"Upgrade",
				"websocket",
				"X-Hop",
				"1",
				"Authorization",
				"Bearer secret",
				"Cookie",
				`${GATE_COOKIE}=${"t".repeat(32)}; app_sid=abc`,
				"Sec-WebSocket-Key",
				"dGhlIHNhbXBsZSBub25jZQ==",
				"Sec-WebSocket-Version",
				"13",
				"Sec-WebSocket-Extensions",
				"permessage-deflate",
				"Sec-WebSocket-Protocol",
				"vite-hmr",
				"Content-Length",
				"10",
				"X-Envoy-Attempt-Count",
				"1",
				"Origin",
				own,
				"User-Agent",
				"test-browser",
			],
			{ host, client: "203.0.113.9", protocols: ["vite-hmr", "chat"] },
		);
		assert.deepEqual(wsReq, [
			["host", host],
			["Authorization", "Bearer secret"],
			["Cookie", "app_sid=abc"],
			["Origin", own],
			["User-Agent", "test-browser"],
			["sec-websocket-protocol", "vite-hmr, chat"],
			["x-forwarded-proto", "https"],
			["x-forwarded-host", host],
			["x-forwarded-for", "203.0.113.9"],
		]);

		assert.deepEqual(
			wsResponseHeaders([
				["Set-Cookie", "sid=1; Domain=qorpera.com; Path=/; HttpOnly"],
				["Set-Cookie", `${GATE_COOKIE}=forged; Path=/`],
				["Sec-WebSocket-Accept", "ignored"],
				["Sec-WebSocket-Protocol", "ignored"],
				["Sec-WebSocket-Extensions", "permessage-deflate"],
				["Cache-Control", "public"],
				["Upgrade", "websocket"],
				["Connection", "Upgrade, X-Secret"],
				["X-Secret", "drop"],
				["X-App-Ws", "ok"],
			]),
			[
				["Set-Cookie", "sid=1; Path=/; HttpOnly"],
				["X-App-Ws", "ok"],
			],
		);
		assert.equal(wsResponseHeaders("bad"), null);

		for (const valid of [1000, 1001, 1002, 1003, 1007, 1008, 1009, 1010, 1011, 1012, 1013, 1014, 3000, 4000, 4999]) {
			assert.equal(isValidCloseCode(valid), true, String(valid));
			assert.equal(sanitizeCloseCode(valid), valid, String(valid));
		}
		for (const invalid of [0, 999, 1004, 1005, 1006, 1015, 1016, 2999, 5000, 65535, NaN]) {
			assert.equal(isValidCloseCode(invalid), false, String(invalid));
			assert.equal(sanitizeCloseCode(invalid), 1000, String(invalid));
		}

		const truncated = truncateUtf8(`${"a".repeat(122)}ø`, 123);
		assert.equal(truncated.length, 122);
		assert.equal(truncated.toString("utf8"), "a".repeat(122));
		const exact = truncateUtf8(`${"a".repeat(121)}ø`, 123);
		assert.equal(exact.length, 123);
		assert.equal(exact.toString("utf8"), `${"a".repeat(121)}ø`);

		const encodedInvalid = encodeWsClose(1006, "bad code");
		assert.equal(encodedInvalid.readUInt16BE(0), 1000);
		assert.deepEqual(decodeWsClose(encodedInvalid), { code: 1000, reason: "bad code" });
		assert.deepEqual(decodeWsClose(Buffer.from([0x03, 0xee, 0xff, 0xfe])), { code: 1000, reason: "" });
		assert.equal(MAX_WS_PER_SITE, 256);
		assert.equal(MAX_WS_MESSAGE_BYTES, 1024 * 1024);
		assert.equal(MAX_WS_QUEUED_BYTES, 2 * 1024 * 1024);
	});

	it("takes the database's answers only in their exact shape", () => {
		const siteId = randomUUID();
		assert.deepEqual(parseConnectAnswer({ state: "ok", key: "k".repeat(43), port: 3000, siteId }), {
			state: "ok",
			key: "k".repeat(43),
			port: 3000,
			siteId,
		});
		assert.deepEqual(parseConnectAnswer({ state: "ok", key: null, port: 1, siteId }), {
			state: "ok",
			key: null,
			port: 1,
			siteId,
		});
		assert.deepEqual(parseConnectAnswer({ state: "refused" }), { state: "refused" });
		for (const value of [
			null,
			{ state: "ok", key: null, port: 80 },
			{ state: "ok", key: null, siteId },
			{ state: "ok", key: null, port: 0, siteId },
			{ state: "ok", key: "short", port: 80, siteId },
			{ state: "ok", key: null, port: 80, siteId: "not-a-uuid" },
			{ state: "ok", key: null, port: 80, siteId, extra: 1 },
			{ state: "refused", why: "x" },
			{ state: "other" },
		])
			assert.throws(() => parseConnectAnswer(value), JSON.stringify(value));
		assert.deepEqual(parseSessionAnswer({ state: "open", siteId }), { state: "open", siteId });
		assert.deepEqual(parseSessionAnswer({ state: "locked" }), { state: "locked" });
		for (const value of [
			{ state: "open" },
			{ state: "open", siteId: "x" },
			{ state: "locked", siteId },
			{ state: "x" },
		])
			assert.throws(() => parseSessionAnswer(value), JSON.stringify(value));
		assert.deepEqual(parseUnlockAnswer({ state: "limited", retryAfter: 0 }), { state: "limited", retryAfter: 1 });
		assert.throws(() => parseUnlockAnswer({ state: "open", token: "short", maxAge: 60 }));
	});

	it("calls the database as its own role, and refuses to start with any other", () => {
		assert.deepEqual(relayHeaders(ANON_KEY, RELAY_JWT), { apikey: ANON_KEY, authorization: `Bearer ${RELAY_JWT}` });
		assert.equal(jwtRole(RELAY_JWT), RELAY_ROLE);
		assert.equal(jwtRole(ANON_KEY), "anon");
		assert.equal(jwtRole("sb_secret_0123456789abcdefghij"), null);
		assert.equal(jwtRole("a.b.c"), null);
		for (const relayJwt of [jwt({ role: "service_role" }), ANON_KEY, "sb_secret_0123456789abcdefghij", "", undefined])
			assert.throws(
				() => createRelay({ api: "http://x", apiKey: ANON_KEY, relayJwt }),
				/must name the role qorpera_site_relay/,
			);
		assert.throws(() => createRelay({ api: "ftp://x", ...RELAY }));
		assert.throws(() => createRelay({ api: "http://u:p@x", ...RELAY }));
		assert.throws(() => createRelay({ api: "http://x", apiKey: "", relayJwt: RELAY_JWT }));
		assert.throws(() => createRelay({ api: "http://x", ...RELAY, hostSuffix: "preview.qorpera.com" }));
	});
});

describe("app relay: concurrency hardening and backpressure", () => {
	it("coalesces concurrent session lookups and isolates locked answers from open sessions past cache capacity", async (t) => {
		const siteId = randomUUID();
		const goodToken = "v".repeat(32);
		let sessionCalls = 0;
		const fetcher = async (url, init) => {
			if (url.endsWith("/qorpera_site_app_session")) {
				sessionCalls++;
				await sleep(25);
				const body = JSON.parse(init.body);
				if (body.p_token === goodToken) return Response.json({ state: "open", siteId });
				return Response.json({ state: "locked" });
			}
			return Response.json({ state: "refused" });
		};
		const relay = createRelay({
			api: "http://database.invalid",
			...RELAY,
			hostSuffix: SUFFIX,
			fetch: fetcher,
			maxSessionsKept: 20,
			log: () => {},
		});
		const port = await listen(relay);
		t.after(() => new Promise((resolve) => relay.close(resolve)));
		const get = (cookie) =>
			new Promise((resolve, reject) => {
				const req = request(
					{ host: "127.0.0.1", port, path: "/", headers: { "x-forwarded-host": HOST, cookie } },
					(res) => {
						res.resume();
						res.on("end", () => resolve(res.statusCode));
					},
				);
				req.on("error", reject);
				req.end();
			});
		const burst = await Promise.all(Array.from({ length: 24 }, () => get(`${GATE_COOKIE}=${goodToken}`)));
		assert.deepEqual([...new Set(burst)], [503]);
		assert.equal(sessionCalls, 1);
		const afterWarm = sessionCalls;
		for (let i = 0; i < 40; i++) {
			const bad = `x${String(i).padStart(31, "0")}`;
			assert.equal(await get(`${GATE_COOKIE}=${bad}`), 401);
		}
		const beforeRecheck = sessionCalls;
		assert.equal(await get(`${GATE_COOKIE}=${goodToken}`), 503);
		assert.equal(sessionCalls, beforeRecheck);
		assert.ok(sessionCalls > afterWarm);
	});

	it("reserves connect capacity for trusted exit addresses under a multi-IP untrusted flood and caps refusal tracking", async (t) => {
		let releaseGate;
		const gate = new Promise((resolve) => {
			releaseGate = resolve;
		});
		const fetcher = async (_url, init) => {
			const body = JSON.parse(init.body);
			if (body.p_slug === "shop") return Response.json({ state: "ok", key: null, port: 3000, siteId: randomUUID() });
			await gate;
			return Response.json({ state: "refused" });
		};
		const relay = createRelay({
			api: "http://database.invalid",
			...RELAY,
			hostSuffix: SUFFIX,
			fetch: fetcher,
			connectLimit: { refusedPerMinute: 4, total: 40 },
			maxRefusalsKept: 8,
			trustedAddresses: ["192.0.2.50"],
			log: () => {},
		});
		const port = await listen(relay);
		const sockets = [];
		t.after(async () => {
			releaseGate();
			for (const socket of sockets) socket.destroy();
			await new Promise((resolve) => relay.close(resolve));
		});
		const dial = (slug, ip) => {
			const { socket } = handshake(
				port,
				`${slug}${SUFFIX}`,
				"/.qorpera/connect",
				`${bearer("k".repeat(43))}CF-Connecting-IP: ${ip}\r\n`,
			);
			socket.on("error", () => {});
			sockets.push(socket);
			return answerHead(socket).then((h) => h.status);
		};
		const attackers = Array.from({ length: 50 }, (_, i) => dial(`atk${i}`, `203.0.113.${(i % 5) + 1}`));
		await sleep(60);
		assert.equal(await dial("shop", "192.0.2.50"), 101);
		releaseGate();
		const statuses = await Promise.all(attackers);
		assert.equal(statuses.filter((s) => s === 101).length, 30);
		assert.equal(statuses.filter((s) => s === 429).length, 20);
	});

	it("delivers pipelined head frames after handlers attach and decodes fragmented masked frames cleanly", async () => {
		class FakeSocket extends EventEmitter {
			writableLength = 0;
			destroyed = false;
			setNoDelay() {}
			setTimeout() {}
			setKeepAlive() {}
			resume() {}
			pause() {}
			write() {
				return true;
			}
			end() {
				this.emit("close");
			}
			destroy() {
				this.destroyed = true;
				this.emit("close");
			}
		}
		const payload = randomBytes(128 * 1024 + 7);
		const framed = encodeFrame(0x2, payload, { mask: randomBytes(4) });
		const sock1 = new FakeSocket();
		let gotHead = null;
		const ws1 = new WebSocketConnection(sock1, framed);
		ws1.onMessage = (msg) => {
			gotHead = msg;
		};
		await sleep(10);
		assert.ok(gotHead && gotHead.equals(payload));
		const sock2 = new FakeSocket();
		let gotFrag = null;
		const ws2 = new WebSocketConnection(sock2, null);
		ws2.onMessage = (msg) => {
			gotFrag = msg;
		};
		for (let at = 0; at < framed.length; at += 513) sock2.emit("data", framed.subarray(at, at + 513));
		assert.ok(gotFrag && gotFrag.equals(payload));
	});

	it("queues concurrent uploads under tight maxQueuedBytes, survives delayed-read uploads and early responses, allows steadily draining slow visitors, and times out mid-body stalls", async (t) => {
		const siteId = randomUUID();
		const token = "u".repeat(32);
		let releaseHold = null;
		const app = createServer((req, res) => {
			if (req.url === "/hold") {
				res.writeHead(200, { "content-type": "text/plain" });
				res.write("hold");
				const beat = setInterval(() => {
					if (!res.destroyed && !res.writableEnded) res.write(".");
				}, 150);
				res.on("close", () => clearInterval(beat));
				releaseHold = () => {
					clearInterval(beat);
					if (!res.destroyed && !res.writableEnded) res.end("ok");
				};
				return;
			}
			if (req.url === "/stall-body") {
				res.writeHead(200, { "content-type": "text/plain" });
				res.write("partial");
				return;
			}
			if (req.url === "/early") {
				res.writeHead(200, { "content-type": "text/plain" });
				res.write("early-ok");
				req.resume();
				req.once("end", () => res.end());
				return;
			}
			if (req.url === "/delayed-upload") {
				req.pause();
				setTimeout(() => {
					let bytes = 0;
					req.on("data", (chunk) => {
						bytes += chunk.length;
					});
					req.on("end", () => {
						res.writeHead(200, { "content-type": "application/json" });
						res.end(JSON.stringify({ bytes }));
					});
					req.resume();
				}, 150);
				return;
			}
			if (req.url === "/steady-big") {
				const total = 12 * 1024 * 1024;
				res.writeHead(200, { "content-type": "application/octet-stream", "content-length": String(total) });
				const chunk = Buffer.alloc(64 * 1024, 0x41);
				let left = total / chunk.length;
				const pump = () => {
					while (left > 0) {
						left--;
						if (!res.write(chunk)) {
							res.once("drain", pump);
							return;
						}
					}
					res.end();
				};
				pump();
				return;
			}
			let bytes = 0;
			req.on("data", (chunk) => {
				bytes += chunk.length;
			});
			req.on("end", () => {
				setTimeout(() => {
					res.writeHead(200, { "content-type": "application/json" });
					res.end(JSON.stringify({ bytes }));
				}, 40);
			});
		});
		const appPort = await listen(app);
		const claim = `c${"a".repeat(31)}`;
		const key = `k${"b".repeat(31)}`;
		const fetcher = async (url, init) => {
			const body = JSON.parse(init.body);
			if (url.endsWith("/qorpera_site_app_connect")) {
				return Response.json({ state: "ok", siteId, port: appPort, key: body.p_secret === claim ? key : null });
			}
			if (url.endsWith("/qorpera_site_app_session")) {
				return Response.json(body.p_token === token ? { state: "open", siteId } : { state: "locked" });
			}
			return Response.json({ state: "locked" });
		};
		const relay = createRelay({
			api: "http://database.invalid",
			...RELAY,
			hostSuffix: SUFFIX,
			fetch: fetcher,
			maxQueuedBytes: 512 * 1024,
			// WHY: armTimer is an idle timer and /early drains a 768 KiB upload under 512 KiB maxQueuedBytes before ending.
			responseTimeoutMs: 2_000,
			pausedMs: 8_000,
			sharedPausedMs: 600,
			log: () => {},
		});
		const relayPort = await listen(relay);
		const front = createServer((_req, res) => {
			res.writeHead(404);
			res.end();
		});
		front.on("upgrade", (req, sock, head) => {
			const up = connect(relayPort, "127.0.0.1", () => {
				const lines = [`GET ${req.url} HTTP/1.1`];
				for (let i = 0; i < req.rawHeaders.length; i += 2) lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
				lines.push(`x-forwarded-host: ${HOST}`);
				up.write(`${lines.join("\r\n")}\r\n\r\n`);
				if (head.length) up.write(head);
				sock.pipe(up);
				up.pipe(sock);
			});
			up.on("error", () => sock.destroy());
			sock.on("error", () => up.destroy());
		});
		const frontPort = await listen(front);
		const child = spawn(process.execPath, [CLIENT, "shop", String(appPort), claim, SUFFIX], {
			env: { ...process.env, QORPERA_APP_RELAY_ORIGIN: `ws://127.0.0.1:${frontPort}` },
			stdio: ["ignore", "pipe", "pipe"],
		});
		let logs = "";
		child.stdout.on("data", (d) => {
			logs += d.toString();
		});
		t.after(async () => {
			child.kill("SIGKILL");
			front.closeAllConnections();
			await new Promise((r) => front.close(r));
			relay.closeAllConnections();
			await new Promise((r) => relay.close(r));
			app.closeAllConnections();
			await new Promise((r) => app.close(r));
		});
		await until(() => relay.isConnected("shop"), "link program to connect", 5_000);
		const payload = Buffer.alloc(128 * 1024, 0x5a);
		const post = (path = "/upload", body = payload) =>
			new Promise((resolve, reject) => {
				const req = request(
					{
						host: "127.0.0.1",
						port: relayPort,
						path,
						method: "POST",
						headers: {
							"x-forwarded-host": HOST,
							cookie: `${GATE_COOKIE}=${token}`,
							"content-length": String(body.length),
						},
					},
					(res) => {
						let text = "";
						res.setEncoding("utf8");
						res.on("data", (c) => {
							text += c;
						});
						res.on("end", () => resolve({ status: res.statusCode, text }));
					},
				);
				req.on("error", reject);
				req.end(body);
			});
		const uploads = await Promise.all(Array.from({ length: 24 }, () => post()));
		for (const u of uploads) {
			assert.equal(u.status, 200, u.text);
			assert.equal(JSON.parse(u.text).bytes, payload.length);
		}
		assert.equal(logs.includes("Lost the connection"), false);
		const bigUpload = Buffer.alloc(3 * 1024 * 1024, 0x43);
		const delayed = await post("/delayed-upload", bigUpload);
		assert.equal(delayed.status, 200, delayed.text);
		assert.equal(JSON.parse(delayed.text).bytes, bigUpload.length);
		const early = await post("/early", Buffer.alloc(768 * 1024, 0x44));
		assert.equal(early.status, 200, early.text);
		assert.equal(early.text, "early-ok");
		const beforePauses = relay.pauseCount("shop");
		const heldReq = new Promise((resolve, reject) => {
			const req = request(
				{
					host: "127.0.0.1",
					port: relayPort,
					path: "/hold",
					method: "GET",
					headers: { "x-forwarded-host": HOST, cookie: `${GATE_COOKIE}=${token}` },
				},
				(res) => {
					let text = "";
					res.setEncoding("utf8");
					res.on("data", (c) => {
						text += c;
					});
					res.on("end", () => resolve({ status: res.statusCode, text }));
				},
			);
			req.on("error", reject);
			req.end();
		});
		await until(() => releaseHold !== null, "the concurrent hold request to reach the app", 3_000);
		let slowSock;
		const slowSteady = new Promise((resolve, reject) => {
			slowSock = connect(relayPort, "127.0.0.1", () => {
				slowSock.pause();
				slowSock.write(
					`GET /steady-big HTTP/1.1\r\nHost: ${HOST}\r\nX-Forwarded-Host: ${HOST}\r\nCookie: ${GATE_COOKIE}=${token}\r\nConnection: close\r\n\r\n`,
				);
			});
			let bytes = 0;
			slowSock.on("data", (c) => {
				bytes += c.length;
				slowSock.pause();
				setTimeout(() => {
					if (!slowSock.destroyed) slowSock.resume();
				}, 3);
			});
			slowSock.on("end", () => resolve(bytes));
			slowSock.on("error", reject);
		});
		await until(() => relay.windowUpdates("shop") > 0, "per-stream window updates to flow", 3_000);
		slowSock.resume();
		const slowBytes = await slowSteady;
		releaseHold();
		const heldRes = await heldReq;
		assert.equal(relay.pauseCount("shop"), beforePauses);
		assert.ok(relay.windowUpdates("shop") > 0);
		assert.ok(slowBytes > 12 * 1024 * 1024, `expected full steady download, got ${slowBytes}`);
		assert.equal(heldRes.status, 200);
		assert.ok(heldRes.text.startsWith("hold") && heldRes.text.endsWith("ok"));
		const stalledEnded = await new Promise((resolve) => {
			const req = request(
				{
					host: "127.0.0.1",
					port: relayPort,
					path: "/stall-body",
					headers: { "x-forwarded-host": HOST, cookie: `${GATE_COOKIE}=${token}` },
				},
				(res) => {
					res.on("data", () => {});
					res.on("end", () => resolve(false));
					res.on("close", () => resolve(!res.complete));
				},
			);
			req.on("error", () => resolve(true));
			req.end();
		});
		assert.equal(stalledEnded, true);
		assert.equal(relay.isConnected("shop"), true);
	});

	it("keeps a shared slow stream alive on byte-level writeQueueSize progress while writableLength is static, then cuts off once stalled", async (t) => {
		const siteId = randomUUID();
		const token = "q".repeat(32);
		const key = `k${"q".repeat(31)}`;
		const programId = "p".repeat(43);
		const fetcher = async (url, init) => {
			const body = JSON.parse(init.body);
			if (url.endsWith("/qorpera_site_app_connect")) return Response.json({ state: "ok", siteId, port: 3000, key: null });
			if (url.endsWith("/qorpera_site_app_session"))
				return Response.json(body.p_token === token ? { state: "open", siteId } : { state: "locked" });
			return Response.json({ state: "locked" });
		};
		const relay = createRelay({
			api: "http://database.invalid",
			...RELAY,
			hostSuffix: SUFFIX,
			fetch: fetcher,
			responseTimeoutMs: 2_000,
			pausedMs: 4_000,
			sharedPausedMs: 200,
			log: () => {},
		});
		const relayPort = await listen(relay);
		let progSocket = null;
		let drainTimer = null;
		t.after(async () => {
			if (drainTimer) clearInterval(drainTimer);
			progSocket?.destroy();
			relay.closeAllConnections();
			await new Promise((r) => relay.close(r));
		});
		const prog = await rawUpgrade(
			relayPort,
			HOST,
			"/.qorpera/connect",
			`Authorization: Bearer ${key}\r\nX-Qorpera-Program: ${programId}\r\n`,
		);
		progSocket = prog.socket;
		assert.equal(prog.status, 101);
		const frames = frameReader(prog.socket, prog.rest);
		const hello = decodeMessage((await frames.message()).payload);
		assert.equal(hello.type, TYPE.hello);

		const makeReq = (path) => {
			const req = new EventEmitter();
			req.method = "GET";
			req.url = path;
			req.headers = { "x-forwarded-host": HOST, cookie: `${GATE_COOKIE}=${token}` };
			req.rawHeaders = ["x-forwarded-host", HOST, "cookie", `${GATE_COOKIE}=${token}`];
			req.resume = () => {};
			req.pause = () => {};
			return req;
		};
		const slowRes = new EventEmitter();
		slowRes.writableLength = 512 * 1024;
		slowRes.socket = { _handle: { writeQueueSize: 512 * 1024 } };
		slowRes.destroyed = false;
		slowRes.writeHead = () => {};
		slowRes.flushHeaders = () => {};
		let slowBodyWritten = false;
		slowRes.write = () => {
			slowBodyWritten = true;
			return false;
		};
		slowRes.end = () => {};
		slowRes.destroy = () => {
			slowRes.destroyed = true;
		};

		const req1 = makeReq("/mobile-download");
		relay.emit("request", req1, slowRes);
		const head1 = decodeMessage((await frames.message()).payload);
		assert.equal(head1.type, TYPE.head);
		prog.socket.write(
			encodeFrame(
				0x2,
				encodeMessage(
					TYPE.response,
					head1.stream,
					Buffer.from(JSON.stringify({ status: 200, headers: [["content-type", "application/octet-stream"]] })),
				),
				{ mask: mask() },
			),
		);
		prog.socket.write(
			encodeFrame(0x2, encodeMessage(TYPE.body, head1.stream, Buffer.alloc(64 * 1024, 0x41)), { mask: mask() }),
		);
		await until(() => slowBodyWritten, "body chunk delivered to slowRes", 1_000);
		assert.equal(relay.pauseCount("shop"), 0);

		const fastRes = new EventEmitter();
		fastRes.writableLength = 0;
		fastRes.socket = { _handle: { writeQueueSize: 0 } };
		fastRes.destroyed = false;
		fastRes.status = 0;
		fastRes.ended = false;
		fastRes.writeHead = (s) => {
			fastRes.status = s;
		};
		fastRes.flushHeaders = () => {};
		fastRes.write = () => true;
		fastRes.end = () => {
			fastRes.ended = true;
		};
		fastRes.destroy = () => {
			fastRes.destroyed = true;
		};
		relay.emit("request", makeReq("/second"), fastRes);

		drainTimer = setInterval(() => {
			if (slowRes.socket._handle.writeQueueSize >= 4096) slowRes.socket._handle.writeQueueSize -= 4096;
		}, 25);
		try {
			await until(
				() => relay.sharedProgressChecks("shop") >= 2 || slowRes.destroyed,
				"tightened progress checks while writeQueueSize keeps moving",
				2_000,
			);
		} finally {
			clearInterval(drainTimer);
			drainTimer = null;
		}
		assert.equal(slowRes.destroyed, false);
		assert.ok(
			relay.sharedProgressChecks("shop") >= 2,
			`expected >= 2 tightened progress checks, got ${relay.sharedProgressChecks("shop")}`,
		);
		await until(() => slowRes.destroyed, "stalled shared stream to be destroyed once writeQueueSize stops moving", 2_000);
		assert.equal(fastRes.destroyed, false);
	});

	it("delivers a complete early 413 response with connection: close under WebSocket backpressure while upload BODY frames keep arriving", async (t) => {
		let earlySent = false;
		const app = createServer((req, res) => {
			req.on("error", () => {});
			res.on("error", () => {});
			if (req.url === "/fill") {
				const total = 24 * 1024 * 1024;
				res.writeHead(200, { "content-type": "application/octet-stream", "content-length": String(total) });
				const chunk = Buffer.alloc(64 * 1024, 0x41);
				let left = total / chunk.length;
				const pump = () => {
					while (left > 0) {
						left -= 1;
						if (!res.write(chunk)) {
							res.once("drain", pump);
							return;
						}
					}
					res.end();
				};
				pump();
				return;
			}
			if (req.url === "/early-rst") {
				req.once("data", () => {
					const body = Buffer.alloc(512 * 1024, 0x45);
					res.writeHead(413, {
						"content-type": "application/octet-stream",
						"content-length": String(body.length),
						connection: "close",
					});
					res.end(body, () => {
						earlySent = true;
					});
				});
				return;
			}
			if (req.url === "/stream-422") {
				res.writeHead(422, { "content-type": "text/plain" });
				res.write("err:");
				let readBytes = 0;
				req.on("data", (chunk) => {
					readBytes += chunk.length;
				});
				req.on("end", () => {
					res.end(String(readBytes));
				});
				return;
			}
			res.writeHead(404);
			res.end();
		});
		const appPort = await listen(app);
		let wsSock = null;
		let frames = null;
		const maskedFrameReader = (socket, initial) => {
			let buffer = initial;
			const queue = [];
			const waiting = [];
			const pump = () => {
				for (;;) {
					const frame = decodeFrame(buffer, { masked: true });
					if (!frame) break;
					buffer = buffer.subarray(frame.size);
					queue.push(frame);
				}
				while (queue.length && waiting.length) waiting.shift()(queue.shift());
			};
			socket.on("data", (chunk) => {
				buffer = Buffer.concat([buffer, chunk]);
				pump();
			});
			pump();
			return {
				next: (ms = 5000) =>
					new Promise((resolve, reject) => {
						const timer = setTimeout(() => reject(new Error("no masked frame came")), ms);
						waiting.push((frame) => {
							clearTimeout(timer);
							resolve(frame);
						});
						pump();
					}),
				async message(ms = 5000) {
					for (;;) {
						const frame = await this.next(ms);
						if (frame.opcode !== 0x2 || decodeMessage(frame.payload).type !== TYPE.keepalive) return frame;
					}
				},
			};
		};
		const wsServer = createServer((_req, res) => {
			res.writeHead(404);
			res.end();
		});
		wsServer.on("upgrade", (req, sock, head) => {
			sock.on("error", () => {});
			const accept = acceptKey(req.headers);
			sock.write(
				`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
			);
			wsSock = sock;
			frames = maskedFrameReader(sock, head);
			sock.write(
				encodeFrame(0x2, encodeMessage(TYPE.hello, 0, Buffer.from(JSON.stringify({ port: appPort, key: "k".repeat(32) })))),
			);
		});
		const wsPort = await listen(wsServer);
		const child = spawn(process.execPath, [CLIENT, "shop", String(appPort), "c".repeat(32), SUFFIX], {
			env: { ...process.env, QORPERA_APP_RELAY_ORIGIN: `ws://127.0.0.1:${wsPort}` },
			stdio: ["ignore", "pipe", "pipe"],
		});
		t.after(async () => {
			child.kill("SIGKILL");
			wsSock?.destroy();
			wsServer.closeAllConnections();
			await new Promise((r) => wsServer.close(r));
			app.closeAllConnections();
			await new Promise((r) => app.close(r));
		});
		await until(() => wsSock !== null, "client.mjs to connect to mock relay", 5_000);
		const sendMsg = (type, id, payload = Buffer.alloc(0)) => {
			wsSock.write(encodeFrame(0x2, encodeMessage(type, id, payload)));
		};
		sendMsg(
			TYPE.head,
			1,
			Buffer.from(JSON.stringify({ method: "GET", path: "/fill", headers: [["host", HOST]] })),
		);
		sendMsg(TYPE.end, 1);
		const fillHead = decodeMessage((await frames.message()).payload);
		assert.equal(fillHead.type, TYPE.response);
		wsSock.pause();
		await sleep(150);
		sendMsg(
			TYPE.head,
			2,
			Buffer.from(
				JSON.stringify({
					method: "POST",
					path: "/early-rst",
					headers: [
						["host", HOST],
						["content-length", String(512 * 1024)],
					],
				}),
			),
		);
		sendMsg(TYPE.body, 2, Buffer.from("a"));
		await until(() => earlySent, "app to send early 413 response while client is backpressured", 3_000);
		await sleep(50);
		for (let i = 0; i < 4; i++) sendMsg(TYPE.body, 2, Buffer.alloc(64 * 1024, 0x46));
		await sleep(80);
		wsSock.resume();

		const result = { status: 0, bodyBytes: 0, ended: false, sawReset: false };
		while (!result.ended && !result.sawReset) {
			const msg = decodeMessage((await frames.message()).payload);
			if (msg.stream !== 2) continue;
			if (msg.type === TYPE.response) result.status = JSON.parse(msg.payload.toString()).status;
			else if (msg.type === TYPE.body) result.bodyBytes += msg.payload.length;
			else if (msg.type === TYPE.end) result.ended = true;
			else if (msg.type === TYPE.reset) result.sawReset = true;
		}
		assert.deepEqual(result, { status: 413, bodyBytes: 512 * 1024, ended: true, sawReset: false });

		sendMsg(
			TYPE.head,
			3,
			Buffer.from(
				JSON.stringify({
					method: "POST",
					path: "/stream-422",
					headers: [
						["host", HOST],
						["content-length", "10"],
					],
				}),
			),
		);
		sendMsg(TYPE.body, 3, Buffer.from("hello"));
		const head422 = await (async () => {
			for (;;) {
				const msg = decodeMessage((await frames.message()).payload);
				if (msg.stream === 3 && msg.type === TYPE.response) return JSON.parse(msg.payload.toString()).status;
			}
		})();
		assert.equal(head422, 422);
		sendMsg(TYPE.body, 3, Buffer.from("world"));
		sendMsg(TYPE.end, 3);
		let body422 = "";
		let ended422 = false;
		while (!ended422) {
			const msg = decodeMessage((await frames.message()).payload);
			if (msg.stream !== 3) continue;
			if (msg.type === TYPE.body) body422 += msg.payload.toString();
			else if (msg.type === TYPE.end) ended422 = true;
			else if (msg.type === TYPE.reset) assert.fail("unexpected reset on streaming 422");
		}
		assert.equal(body422, "err:10");
	});
});

describe("app relay: visitor WebSockets", () => {
	function wsTestApp() {
		const state = {
			upgrades: [],
			closed: [],
			pongs: [],
			abortedHangs: 0,
			sockets: new Set(),
		};
		const server = createServer((req, res) => {
			if (req.url === "/http") {
				res.writeHead(200, { "content-type": "text/plain", "content-length": "2" });
				res.end("ok");
				return;
			}
			res.writeHead(404);
			res.end();
		});
		server.on("upgrade", (req, socket, head) => {
			state.sockets.add(socket);
			socket.on("close", () => state.sockets.delete(socket));
			socket.on("error", () => socket.destroy());
			const parsed = new URL(req.url, "http://127.0.0.1");
			const pathname = parsed.pathname;
			const record = {
				url: req.url,
				headers: headerPairs(req.rawHeaders),
			};
			state.upgrades.push(record);
			if (pathname === "/ws/reject-404") {
				socket.end("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
				return;
			}
			if (pathname === "/ws/reject-403") {
				socket.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
				return;
			}
			if (pathname === "/ws/reject-200") {
				socket.end("HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nhi");
				return;
			}
			if (pathname === "/ws/bad-accept") {
				socket.end(
					"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: invalid==\r\n\r\n",
				);
				return;
			}
			if (pathname === "/ws/bad-ext") {
				const accept = acceptKey(req.headers);
				socket.end(
					`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\nSec-WebSocket-Extensions: permessage-deflate\r\n\r\n`,
				);
				return;
			}
			if (pathname === "/ws/hang") {
				socket.on("end", () => socket.end());
				socket.on("close", () => {
					state.abortedHangs++;
				});
				socket.resume();
				return;
			}
			const accept = acceptKey(req.headers);
			if (!accept) {
				socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
				return;
			}
			let extra = "";
			if (pathname === "/ws/subproto") {
				if (parsed.searchParams.get("badproto") === "1") {
					extra += "Sec-WebSocket-Protocol: unlisted\r\n";
				} else {
					const offered = String(req.headers["sec-websocket-protocol"] ?? "")
						.split(",")
						.map((p) => p.trim())
						.filter(Boolean);
					if (offered.includes("vite-hmr")) extra += "Sec-WebSocket-Protocol: vite-hmr\r\n";
					else if (offered.length > 0) extra += `Sec-WebSocket-Protocol: ${offered[0]}\r\n`;
				}
			}
			if (parsed.searchParams.get("setcookie") === "1") {
				extra += `Set-Cookie: ws_sid=9; Domain=example.test; Path=/\r\n`;
				extra += `Set-Cookie: ${GATE_COOKIE}=forged; Path=/\r\n`;
				extra += "X-Upstream-Ws: yes\r\n";
			}
			const responseHead = Buffer.from(
				`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n${extra}\r\n`,
			);
			if (parsed.searchParams.get("pipelined") === "1") {
				socket.write(Buffer.concat([responseHead, encodeFrame(0x1, Buffer.from("welcome"))]));
			} else {
				socket.write(responseHead);
			}
			const conn = new WebSocketConnection(socket, head, {
				allowText: true,
				maxPayload: 2 * 1024 * 1024,
				maxQueued: 8 * 1024 * 1024,
			});
			conn.onMessage = (payload, opcode) => {
				if (opcode === 0x1 && payload.toString("utf8") === "trigger-upstream-close") {
					conn.close(4001, "lukket å");
					return;
				}
				if (opcode === 0x1 && payload.toString("utf8") === "trigger-oversized") {
					conn.send(Buffer.alloc(128 * 1024, 0x42), 0x2);
					return;
				}
				if (opcode === 0x1 && payload.toString("utf8") === "trigger-ping") {
					socket.write(encodeFrame(0x9, Buffer.from("up-ping")));
					return;
				}
				conn.send(payload, opcode);
			};
			conn.onCloseFrame = (code, reason) => {
				state.closed.push({ url: req.url, code, reason });
			};
			if (parsed.searchParams.get("flood") === "1") {
				const chunk = Buffer.alloc(32 * 1024, 0x7a);
				let sent = 0;
				const pump = () => {
					while (sent < 64 * 1024 * 1024 && !conn.closed && !socket.destroyed) {
						sent += chunk.length;
						if (!conn.send(chunk, 0x2)) return;
					}
				};
				conn.onDrain = pump;
				pump();
			}
			if (parsed.searchParams.get("ping") === "1") {
				let pongBuf = Buffer.alloc(0);
				socket.on("data", (chunk) => {
					pongBuf = Buffer.concat([pongBuf, chunk]);
					for (;;) {
						let frame;
						try {
							frame = decodeFrame(pongBuf, { masked: true });
						} catch {
							return;
						}
						if (!frame) return;
						pongBuf = pongBuf.subarray(frame.size);
						if (frame.opcode === 0xa) state.pongs.push(frame.payload.toString("utf8"));
					}
				});
				socket.write(encodeFrame(0x9, Buffer.from("srv-ping")));
			}
		});
		state.server = server;
		return state;
	}

	async function startStack(t, relayOptions = {}) {
		const db = fakeDatabase();
		const app = wsTestApp();
		const dbPort = await listen(db.server);
		const appPort = await listen(app.server);
		for (const site of db.sites.values()) site.port = appPort;
		const logs = [];
		const relay = createRelay({
			api: `http://127.0.0.1:${dbPort}/`,
			...RELAY,
			hostSuffix: SUFFIX,
			responseTimeoutMs: 800,
			sessionCacheMs: 200,
			lockedCacheMs: 200,
			recheckMs: 0,
			log: (line) => logs.push(line),
			...relayOptions,
		});
		const relayPort = await listen(relay);
		const front = testFront(relayPort);
		const frontPort = await listen(front);
		const programs = [];
		const spawnClient = (claim, slug = "shop", port = appPort) => {
			const child = spawn(process.execPath, [CLIENT, slug, String(port), claim, SUFFIX], {
				env: { ...process.env, QORPERA_APP_RELAY_ORIGIN: `ws://127.0.0.1:${frontPort}` },
				stdio: ["ignore", "pipe", "pipe"],
			});
			const entry = { child, output: "" };
			child.stdout.on("data", (d) => {
				entry.output += d;
			});
			child.stderr.on("data", (d) => {
				entry.output += d;
			});
			entry.exited = new Promise((resolve) => child.on("exit", resolve));
			programs.push(entry);
			return entry;
		};
		const token = db.session("shop");
		const client = spawnClient(db.claim("shop"));
		await until(() => client.output.includes(`Connected: https://${HOST}/`), "client to connect");
		t.after(async () => {
			for (const p of programs) p.child.kill("SIGKILL");
			for (const s of app.sockets) s.destroy();
			await new Promise((resolve) => relay.close(resolve));
			front.close();
			db.server.close();
			db.server.closeAllConnections();
			app.server.close();
			app.server.closeAllConnections();
		});
		const visitorUpgrade = (path, { cookie = `${GATE_COOKIE}=${token}`, origin = ORIGIN, extra = "", host = HOST } = {}) => {
			let headers = "";
			if (origin !== null) headers += `Origin: ${origin}\r\n`;
			if (cookie !== null) headers += `Cookie: ${cookie}\r\n`;
			headers += `CF-Connecting-IP: 203.0.113.9\r\n${extra}`;
			return rawUpgrade(relayPort, host, path, headers);
		};
		return { db, app, relay, relayPort, frontPort, appPort, token, logs, spawnClient, visitorUpgrade };
	}

	it("tunnels authenticated bidirectional text, binary, fragmented, empty and pipelined frames alongside HTTP without leaking gate cookies", async (t) => {
		const { app, relay, relayPort, token, visitorUpgrade } = await startStack(t);
		const conn = await visitorUpgrade("/ws/echo?setcookie=1&pipelined=1&ping=1", {
			cookie: `theme=dark; ${GATE_COOKIE}=${token}; lang=da`,
			extra: "Authorization: Bearer should-not-leak\r\nX-Forwarded-For: 198.51.100.1\r\nX-App-Client: yes\r\n",
		});
		t.after(() => conn.socket.destroy());
		assert.equal(conn.status, 101, conn.head);
		const expectedAccept = acceptKey({
			upgrade: "websocket",
			connection: "Upgrade",
			"sec-websocket-version": "13",
			"sec-websocket-key": conn.key,
		});
		assert.ok(conn.head.includes(`Sec-WebSocket-Accept: ${expectedAccept}`));
		assert.ok(conn.head.includes("Set-Cookie: ws_sid=9; Path=/"));
		assert.ok(!conn.head.includes("Domain="));
		assert.ok(!conn.head.includes(GATE_COOKIE));
		assert.ok(conn.head.includes("X-Upstream-Ws: yes"));
		assert.equal(relay.wsCount("shop"), 1);

		const reader = frameReader(conn.socket, conn.rest);
		const welcome = await reader.next();
		assert.equal(welcome.opcode, 0x1);
		assert.equal(welcome.payload.toString("utf8"), "welcome");

		await until(() => app.pongs.includes("srv-ping"), "client to answer upstream ping with masked pong");

		const seen = app.upgrades.at(-1);
		assert.equal(seen.url, "/ws/echo?setcookie=1&pipelined=1&ping=1");
		assert.deepEqual(values(seen.headers, "host"), [HOST]);
		assert.deepEqual(values(seen.headers, "origin"), [ORIGIN]);
		assert.deepEqual(values(seen.headers, "cookie"), ["theme=dark; lang=da"]);
		assert.deepEqual(values(seen.headers, "authorization"), ["Bearer should-not-leak"]);
		assert.deepEqual(values(seen.headers, "x-forwarded-proto"), ["https"]);
		assert.deepEqual(values(seen.headers, "x-forwarded-host"), [HOST]);
		assert.deepEqual(values(seen.headers, "x-forwarded-for"), ["203.0.113.9"]);
		assert.deepEqual(values(seen.headers, "x-app-client"), ["yes"]);
		assert.ok(!JSON.stringify(seen.headers).includes(token));

		const httpWhileWsOpen = get(relayPort, HOST, "/http", token);
		conn.socket.write(encodeFrame(0x1, Buffer.from("hej verden øæå"), { mask: mask() }));
		const textEcho = await reader.next();
		assert.equal(textEcho.opcode, 0x1);
		assert.equal(textEcho.payload.toString("utf8"), "hej verden øæå");

		const binaryPayload = randomBytes(96 * 1024 + 13);
		conn.socket.write(encodeFrame(0x2, binaryPayload, { mask: mask() }));
		const binaryEcho = await reader.next();
		assert.equal(binaryEcho.opcode, 0x2);
		assert.ok(binaryEcho.payload.equals(binaryPayload));

		const multiByte = Buffer.from("split-ø-char", "utf8");
		conn.socket.write(encodeFrame(0x1, multiByte.subarray(0, 7), { mask: mask(), fin: false }));
		conn.socket.write(encodeFrame(0x9, Buffer.from("mid-ping"), { mask: mask() }));
		conn.socket.write(encodeFrame(0x0, multiByte.subarray(7), { mask: mask(), fin: true }));
		const pong = await reader.next();
		assert.equal(pong.opcode, 0xa);
		assert.equal(pong.payload.toString("utf8"), "mid-ping");
		const fragEcho = await reader.next();
		assert.equal(fragEcho.opcode, 0x1);
		assert.equal(fragEcho.payload.toString("utf8"), "split-ø-char");

		conn.socket.write(encodeFrame(0x1, Buffer.alloc(0), { mask: mask() }));
		const emptyText = await reader.next();
		assert.equal(emptyText.opcode, 0x1);
		assert.equal(emptyText.payload.length, 0);

		conn.socket.write(encodeFrame(0x2, Buffer.alloc(0), { mask: mask() }));
		const emptyBin = await reader.next();
		assert.equal(emptyBin.opcode, 0x2);
		assert.equal(emptyBin.payload.length, 0);

		assert.equal((await httpWhileWsOpen).text, "ok");

		conn.socket.write(encodeFrame(0x8, encodeWsClose(1000, "done"), { mask: mask() }));
		await reader.closed;
		await until(() => relay.wsCount("shop") === 0, "wsCount to return to zero");
	});

	it("negotiates Sec-WebSocket-Protocol and rejects invalid or unlisted subprotocols", async (t) => {
		const { relay, visitorUpgrade } = await startStack(t);
		const negotiated = await visitorUpgrade("/ws/subproto", {
			extra: "Sec-WebSocket-Protocol: chat, vite-hmr\r\n",
		});
		t.after(() => negotiated.socket.destroy());
		assert.equal(negotiated.status, 101, negotiated.head);
		assert.match(negotiated.head, /\r\nSec-WebSocket-Protocol: vite-hmr(\r\n|$)/);
		const reader = frameReader(negotiated.socket, negotiated.rest);
		negotiated.socket.write(encodeFrame(0x1, Buffer.from("hmr"), { mask: mask() }));
		assert.equal((await reader.next()).payload.toString("utf8"), "hmr");
		negotiated.socket.write(encodeFrame(0x8, encodeWsClose(1000), { mask: mask() }));
		await reader.closed;

		const badSyntax = await visitorUpgrade("/ws/subproto", {
			extra: "Sec-WebSocket-Protocol: invalid protocol\r\n",
		});
		assert.equal(badSyntax.status, 400);
		badSyntax.socket.destroy();

		const unlisted = await visitorUpgrade("/ws/subproto?badproto=1", {
			extra: "Sec-WebSocket-Protocol: vite-hmr\r\n",
		});
		assert.equal(unlisted.status, 502);
		unlisted.socket.destroy();

		await until(() => relay.wsCount("shop") === 0, "wsCount to return to zero");
	});

	it("rejects unauthenticated visitor WebSockets (401) and missing or mismatched origins (403) before upgrade", async (t) => {
		const { db, app, visitorUpgrade } = await startStack(t);
		const upgradesBefore = app.upgrades.length;

		const callsBeforeOrigin = db.calls.length;
		for (const origin of [
			null,
			"",
			"null",
			`http://${HOST}`,
			`https://${HOST}:443`,
			`https://${HOST}/`,
			`https://${LAB}`,
			"https://evil.example",
			`https://${HOST.toUpperCase()}`,
		]) {
			const res = await visitorUpgrade("/ws/echo", { origin });
			assert.equal(res.status, 403, String(origin));
			res.socket.destroy();
		}
		for (const extra of [
			"Sec-Fetch-Site: cross-site\r\n",
			"Sec-Fetch-Site: same-site\r\n",
			`Origin: https://evil.example\r\n`,
		]) {
			const res = await visitorUpgrade("/ws/echo", { extra });
			assert.equal(res.status, 403, extra);
			res.socket.destroy();
		}
		assert.equal(db.calls.length, callsBeforeOrigin);

		const noCookie = await visitorUpgrade("/ws/echo", { cookie: null });
		assert.equal(noCookie.status, 401);
		assert.ok(!noCookie.head.includes("set-cookie:"));
		noCookie.socket.destroy();

		const malformedCookie = await visitorUpgrade("/ws/echo", { cookie: `${GATE_COOKIE}=short` });
		assert.equal(malformedCookie.status, 401);
		malformedCookie.socket.destroy();

		const badToken = await visitorUpgrade("/ws/echo", { cookie: `${GATE_COOKIE}=${"B".repeat(32)}` });
		assert.equal(badToken.status, 401);
		assert.ok(badToken.head.toLowerCase().includes(`set-cookie: ${CLEAR_GATE_COOKIE.toLowerCase()}`));
		badToken.socket.destroy();

		for (const platformPath of ["/.qorpera/unlock", "/.qorpera/client.mjs", "/.qorpera/other", "/%2eqorpera/x"]) {
			const res = await visitorUpgrade(platformPath);
			assert.equal(res.status, 404, platformPath);
			res.socket.destroy();
		}
		assert.equal(app.upgrades.length, upgradesBefore);
	});

	it("handles upstream non-101, bad 101 handshake, handshake timeout and ECONNREFUSED cleanly without leaking streams", async (t) => {
		const { db, app, relay, relayPort, token, visitorUpgrade } = await startStack(t, { responseTimeoutMs: 250 });

		for (const [path, expected] of [
			["/ws/reject-404", 404],
			["/ws/reject-403", 403],
			["/ws/reject-200", 502],
			["/ws/bad-accept", 502],
			["/ws/bad-ext", 502],
		]) {
			const res = await visitorUpgrade(path);
			assert.equal(res.status, expected, path);
			res.socket.destroy();
		}

		const timedOut = await visitorUpgrade("/ws/hang");
		assert.equal(timedOut.status, 504);
		timedOut.socket.destroy();
		await until(() => app.abortedHangs >= 1, "hanging upstream upgrade to abort");

		assert.equal(relay.isConnected("shop"), true);
		assert.equal(relay.wsCount("shop"), 0);
		assert.equal((await get(relayPort, HOST, "/http", token)).text, "ok");

		const closedServer = createTcpServer();
		const deadPort = await listen(closedServer);
		await new Promise((resolve) => closedServer.close(resolve));
		db.sites.get("lab").port = deadPort;
		const labToken = db.session("lab");
		const labFront = createTcpServer((visitor) => {
			const upstream = connect(relayPort, "127.0.0.1");
			let head = Buffer.alloc(0);
			let open = false;
			visitor.on("data", (chunk) => {
				if (open) return void upstream.write(chunk);
				head = Buffer.concat([head, chunk]);
				const end = head.indexOf("\r\n");
				if (end === -1) return;
				open = true;
				upstream.write(
					Buffer.concat([
						head.subarray(0, end + 2),
						Buffer.from(`X-Forwarded-Host: ${LAB}\r\n`),
						head.subarray(end + 2),
					]),
				);
			});
			upstream.on("data", (chunk) => visitor.write(chunk));
			const end = () => {
				visitor.destroy();
				upstream.destroy();
			};
			visitor.on("close", end);
			visitor.on("error", end);
			upstream.on("close", end);
			upstream.on("error", end);
		});
		const labFrontPort = await listen(labFront);
		const labClient = spawn(process.execPath, [CLIENT, "lab", String(deadPort), db.claim("lab"), SUFFIX], {
			env: { ...process.env, QORPERA_APP_RELAY_ORIGIN: `ws://127.0.0.1:${labFrontPort}` },
			stdio: ["ignore", "pipe", "pipe"],
		});
		t.after(() => {
			labClient.kill("SIGKILL");
			labFront.close();
		});
		await until(() => relay.isConnected("lab"), "lab client to connect");
		const refused = await visitorUpgrade("/ws/echo", {
			host: LAB,
			origin: `https://${LAB}`,
			cookie: `${GATE_COOKIE}=${labToken}`,
		});
		assert.equal(refused.status, 502);
		refused.socket.destroy();
		assert.equal(relay.isConnected("lab"), true);
		assert.equal(relay.wsCount("lab"), 0);
	});

	it("propagates valid close codes both ways, rejects invalid wire codes and invalid UTF-8, and sanitizes tunnel WS_CLOSE", async (t) => {
		const { db, app, relay, relayPort, visitorUpgrade } = await startStack(t);

		const visitorCloses = await visitorUpgrade("/ws/echo");
		t.after(() => visitorCloses.socket.destroy());
		assert.equal(visitorCloses.status, 101);
		const reader1 = frameReader(visitorCloses.socket, visitorCloses.rest);
		visitorCloses.socket.write(encodeFrame(0x8, encodeWsClose(4000, "farvel ø"), { mask: mask() }));
		await reader1.closed;
		await until(
			() => app.closed.some((c) => c.code === 4000 && c.reason === "farvel ø"),
			"upstream to receive visitor close code and reason",
		);

		const upstreamCloses = await visitorUpgrade("/ws/echo");
		t.after(() => upstreamCloses.socket.destroy());
		assert.equal(upstreamCloses.status, 101);
		const reader2 = frameReader(upstreamCloses.socket, upstreamCloses.rest);
		upstreamCloses.socket.write(encodeFrame(0x1, Buffer.from("trigger-upstream-close"), { mask: mask() }));
		const closeFrame = await reader2.next();
		assert.equal(closeFrame.opcode, 0x8);
		assert.equal(closeFrame.payload.readUInt16BE(0), 4001);
		assert.equal(closeFrame.payload.subarray(2).toString("utf8"), "lukket å");
		upstreamCloses.socket.write(encodeFrame(0x8, closeFrame.payload.subarray(0, 2), { mask: mask() }));
		await reader2.closed;

		for (const badCode of [1005, 1006, 1015]) {
			const badClose = await visitorUpgrade("/ws/echo");
			const r = frameReader(badClose.socket, badClose.rest);
			const badPayload = Buffer.alloc(2);
			badPayload.writeUInt16BE(badCode, 0);
			badClose.socket.write(encodeFrame(0x8, badPayload, { mask: mask() }));
			const reply = await r.next();
			assert.equal(reply.opcode, 0x8);
			assert.equal(reply.payload.readUInt16BE(0), 1002, String(badCode));
			badClose.socket.destroy();
		}

		const badUtf8 = await visitorUpgrade("/ws/echo");
		const rUtf8 = frameReader(badUtf8.socket, badUtf8.rest);
		badUtf8.socket.write(encodeFrame(0x1, Buffer.from([0xff, 0xfe]), { mask: mask() }));
		const utf8Close = await rUtf8.next();
		assert.equal(utf8Close.opcode, 0x8);
		assert.equal(utf8Close.payload.readUInt16BE(0), 1007);
		badUtf8.socket.destroy();

		const labToken = db.session("lab");
		const labProg = await rawUpgrade(relayPort, LAB, "/.qorpera/connect", bearer(db.claim("lab")));
		t.after(() => labProg.socket.destroy());
		const progFrames = frameReader(labProg.socket, labProg.rest);
		assert.equal(decodeMessage((await progFrames.message()).payload).type, TYPE.hello);

		for (const badWireCode of [1005, 1006, 1015]) {
			const visitorPromise = visitorUpgrade("/ws/sanitize", {
				host: LAB,
				origin: `https://${LAB}`,
				cookie: `${GATE_COOKIE}=${labToken}`,
			});
			const openMsg = decodeMessage((await progFrames.message()).payload);
			assert.equal(openMsg.type, TYPE.wsOpen);
			labProg.socket.write(
				encodeFrame(0x2, encodeMessage(TYPE.wsOpenOk, openMsg.stream, Buffer.from("{}")), { mask: mask() }),
			);
			const vis = await visitorPromise;
			assert.equal(vis.status, 101);
			const visFrames = frameReader(vis.socket, vis.rest);
			const rawClose = Buffer.alloc(2);
			rawClose.writeUInt16BE(badWireCode, 0);
			labProg.socket.write(encodeFrame(0x2, encodeMessage(TYPE.wsClose, openMsg.stream, rawClose), { mask: mask() }));
			const gotClose = await visFrames.next();
			assert.equal(gotClose.opcode, 0x8);
			assert.equal(gotClose.payload.readUInt16BE(0), 1000, String(badWireCode));
			vis.socket.destroy();
		}

		await until(() => relay.wsCount("shop") === 0 && relay.wsCount("lab") === 0, "all WS streams cleaned up");
	});

	it("enforces oversized message rejection, per-site cap and slow-consumer backpressure drop", async (t) => {
		const { relay, relayPort, token, visitorUpgrade } = await startStack(t, {
			maxWsPerSite: 2,
			maxWsMessageBytes: 64 * 1024,
			maxWsQueuedBytes: 64 * 1024,
		});

		const overVis = await visitorUpgrade("/ws/echo");
		assert.equal(overVis.status, 101);
		const overVisReader = frameReader(overVis.socket, overVis.rest);
		overVis.socket.write(encodeFrame(0x2, Buffer.alloc(64 * 1024 + 1, 0x41), { mask: mask() }));
		const close1 = await overVisReader.next();
		assert.equal(close1.opcode, 0x8);
		assert.equal(close1.payload.readUInt16BE(0), 1009);
		overVis.socket.destroy();

		const overUp = await visitorUpgrade("/ws/echo");
		assert.equal(overUp.status, 101);
		const overUpReader = frameReader(overUp.socket, overUp.rest);
		overUp.socket.write(encodeFrame(0x1, Buffer.from("trigger-oversized"), { mask: mask() }));
		const close2 = await overUpReader.next();
		assert.equal(close2.opcode, 0x8);
		assert.equal(close2.payload.readUInt16BE(0), 1009);
		overUp.socket.destroy();
		await until(() => relay.wsCount("shop") === 0, "oversized streams to clear");

		const healthy = await visitorUpgrade("/ws/echo");
		const slow = await visitorUpgrade("/ws/echo?flood=1");
		t.after(() => {
			healthy.socket.destroy();
			slow.socket.destroy();
		});
		assert.equal(healthy.status, 101);
		assert.equal(slow.status, 101);
		assert.equal(relay.wsCount("shop"), 2);

		const third = await visitorUpgrade("/ws/echo");
		assert.equal(third.status, 503);
		third.socket.destroy();

		slow.socket.pause();
		await until(() => relay.wsCount("shop") === 1, "slow consumer to be dropped", 5000);
		assert.equal((await get(relayPort, HOST, "/http", token)).text, "ok");

		const healthyReader = frameReader(healthy.socket, healthy.rest);
		healthy.socket.write(encodeFrame(0x1, Buffer.from("still-alive"), { mask: mask() }));
		const echoFrame = await healthyReader.next(1000);
		assert.equal(echoFrame.payload.toString("utf8"), "still-alive");

		const replacement = await visitorUpgrade("/ws/echo");
		t.after(() => replacement.socket.destroy());
		assert.equal(replacement.status, 101);
		assert.equal(relay.wsCount("shop"), 2);

		healthy.socket.write(encodeFrame(0x8, encodeWsClose(1000), { mask: mask() }));
		await healthyReader.closed;
		replacement.socket.write(encodeFrame(0x8, encodeWsClose(1000), { mask: mask() }));
		await frameReader(replacement.socket, replacement.rest).closed;
		slow.socket.destroy();
		await until(() => relay.wsCount("shop") === 0, "all sockets closed");
	});

	it("keeps active visitor WebSockets alive with ping/pong and closes silent visitors on idle timeout", async (t) => {
		const { relay, visitorUpgrade } = await startStack(t, {
			wsPingMs: 90,
			wsIdleMs: 300,
		});

		const active = await visitorUpgrade("/ws/echo");
		const silent = await visitorUpgrade("/ws/echo");
		t.after(() => {
			active.socket.destroy();
			silent.socket.destroy();
		});
		assert.equal(active.status, 101);
		assert.equal(silent.status, 101);
		assert.equal(relay.wsCount("shop"), 2);

		const activeReader = frameReader(active.socket, active.rest);
		const silentReader = frameReader(silent.socket, silent.rest);
		let pongsSent = 0;
		const keepAlive = (async () => {
			while (pongsSent < 4) {
				const frame = await activeReader.next(1500);
				if (frame.opcode === 0x9) {
					pongsSent++;
					active.socket.write(encodeFrame(0xa, frame.payload, { mask: mask() }));
				}
			}
		})();

		let silentClose;
		do silentClose = await silentReader.next(2000);
		while (silentClose.opcode === 0x9);
		assert.equal(silentClose.opcode, 0x8);
		assert.equal(silentClose.payload.readUInt16BE(0), 1001);
		silent.socket.destroy();

		await keepAlive;
		assert.ok(pongsSent >= 4);
		assert.equal(relay.wsCount("shop"), 1);

		active.socket.write(encodeFrame(0x1, Buffer.from("still-open"), { mask: mask() }));
		let echoFrame;
		do echoFrame = await activeReader.next(1000);
		while (echoFrame.opcode === 0x9);
		assert.equal(echoFrame.payload.toString("utf8"), "still-open");

		active.socket.write(encodeFrame(0x8, encodeWsClose(1000), { mask: mask() }));
		await activeReader.closed;
		await until(() => relay.wsCount("shop") === 0, "active socket closed");
	});

	it("closes active visitor WebSockets cleanly on tunnel drop, client replacement, site disable/retake and relay shutdown", async (t) => {
		const { db, relay, spawnClient, visitorUpgrade } = await startStack(t, { recheckMs: 120 });

		const wsDrop = await visitorUpgrade("/ws/echo");
		t.after(() => wsDrop.socket.destroy());
		assert.equal(wsDrop.status, 101);
		const dropReader = frameReader(wsDrop.socket, wsDrop.rest);
		relay.dropProgram("shop");
		const dropClose = await dropReader.next();
		assert.equal(dropClose.opcode, 0x8);
		assert.equal(dropClose.payload.readUInt16BE(0), 1001);
		wsDrop.socket.destroy();

		await until(() => relay.isConnected("shop"), "client to reconnect after drop");

		const wsReplace = await visitorUpgrade("/ws/echo");
		t.after(() => wsReplace.socket.destroy());
		assert.equal(wsReplace.status, 101);
		const replaceReader = frameReader(wsReplace.socket, wsReplace.rest);
		const newer = spawnClient(db.claim("shop"));
		await until(() => newer.output.includes(`Connected: https://${HOST}/`), "newer client to connect");
		const replaceClose = await replaceReader.next();
		assert.equal(replaceClose.opcode, 0x8);
		assert.equal(replaceClose.payload.readUInt16BE(0), 1001);
		wsReplace.socket.destroy();

		const wsDisable = await visitorUpgrade("/ws/echo");
		t.after(() => wsDisable.socket.destroy());
		assert.equal(wsDisable.status, 101);
		const disableReader = frameReader(wsDisable.socket, wsDisable.rest);
		db.sites.get("shop").key = null;
		const disableClose = await disableReader.next(3000);
		assert.equal(disableClose.opcode, 0x8);
		assert.equal(disableClose.payload.readUInt16BE(0), 1001);
		wsDisable.socket.destroy();
		await until(() => !relay.isConnected("shop"), "disabled program to disconnect");

		const whenOff = await visitorUpgrade("/ws/echo");
		assert.equal(whenOff.status, 503);
		whenOff.socket.destroy();

		const restored = spawnClient(db.claim("shop"));
		await until(() => restored.output.includes(`Connected: https://${HOST}/`), "restored client to connect");

		db.retake("shop");
		const newOwnerToken = db.session("shop");
		const staleAttempt = await visitorUpgrade("/ws/echo", { cookie: `${GATE_COOKIE}=${newOwnerToken}` });
		assert.equal(staleAttempt.status, 503);
		staleAttempt.socket.destroy();
		await until(() => !relay.isConnected("shop"), "stale site program to be dropped");

		const ownClient = spawnClient(db.claim("shop"));
		await until(() => ownClient.output.includes(`Connected: https://${HOST}/`), "new site client to connect");
		const wsShutdown = await visitorUpgrade("/ws/echo", { cookie: `${GATE_COOKIE}=${newOwnerToken}` });
		t.after(() => wsShutdown.socket.destroy());
		assert.equal(wsShutdown.status, 101);
		const shutdownReader = frameReader(wsShutdown.socket, wsShutdown.rest);
		const closedRelay = new Promise((resolve) => relay.close(resolve));
		const shutdownClose = await shutdownReader.next();
		assert.equal(shutdownClose.opcode, 0x8);
		assert.equal(shutdownClose.payload.readUInt16BE(0), 1001);
		wsShutdown.socket.destroy();
		await closedRelay;
	});

	it("closes open visitor WebSockets with 1008 within the session cache window when a session is revoked", async (t) => {
		const { db, app, relay, token, visitorUpgrade } = await startStack(t, {
			sessionCacheMs: 150,
			lockedCacheMs: 150,
			recheckMs: 0,
		});
		const ws1 = await visitorUpgrade("/ws/echo");
		const ws2 = await visitorUpgrade("/ws/echo");
		t.after(() => {
			ws1.socket.destroy();
			ws2.socket.destroy();
		});
		assert.equal(ws1.status, 101);
		assert.equal(ws2.status, 101);
		assert.equal(relay.wsCount("shop"), 2);

		const r1 = frameReader(ws1.socket, ws1.rest);
		const r2 = frameReader(ws2.socket, ws2.rest);
		ws1.socket.write(encodeFrame(0x1, Buffer.from("before-revoke"), { mask: mask() }));
		assert.equal((await r1.next()).payload.toString("utf8"), "before-revoke");

		const callsBeforeRevoke = db.sessionCalls().length;
		db.sites.get("shop").sessions.delete(token);

		const [close1, close2] = await Promise.all([r1.next(1500), r2.next(1500)]);
		assert.equal(close1.opcode, 0x8);
		assert.equal(close1.payload.readUInt16BE(0), 1008);
		assert.equal(close1.payload.subarray(2).toString("utf8"), "session ended");
		assert.equal(close2.opcode, 0x8);
		assert.equal(close2.payload.readUInt16BE(0), 1008);
		assert.equal(close2.payload.subarray(2).toString("utf8"), "session ended");
		assert.equal(db.sessionCalls().length - callsBeforeRevoke, 1);

		ws1.socket.destroy();
		ws2.socket.destroy();
		await until(() => relay.wsCount("shop") === 0, "revoked visitor sockets to clear");
		await until(
			() => app.closed.filter((c) => c.code === 1008).length >= 2,
			"upstream to receive 1008 close frames for revoked sockets",
		);
		assert.equal(relay.isConnected("shop"), true);
	});
});

describe("app relay overhaul: flow control, SSE, auth modes, custom domains, health, swap, drain", () => {
	async function startBridge(relayPort, forwardedHost = HOST) {
		const front = createServer((_req, res) => {
			res.writeHead(404);
			res.end();
		});
		front.on("upgrade", (req, sock, head) => {
			const up = connect(relayPort, "127.0.0.1", () => {
				const lines = [`GET ${req.url} HTTP/1.1`];
				for (let i = 0; i < req.rawHeaders.length; i += 2) lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
				lines.push(`x-forwarded-host: ${forwardedHost}`);
				up.write(`${lines.join("\r\n")}\r\n\r\n`);
				if (head.length) up.write(head);
				sock.pipe(up);
				up.pipe(sock);
			});
			up.on("error", () => sock.destroy());
			sock.on("error", () => up.destroy());
		});
		const port = await listen(front);
		return {
			port,
			close: async () => {
				front.closeAllConnections();
				await new Promise((r) => front.close(r));
			},
		};
	}

	function httpGet(relayPort, host, path, headers = {}) {
		return new Promise((resolve, reject) => {
			const req = request(
				{
					host: "127.0.0.1",
					port: relayPort,
					path,
					method: "GET",
					headers: { "x-forwarded-host": host, ...headers },
				},
				(res) => {
					const chunks = [];
					res.on("data", (chunk) => chunks.push(chunk));
					res.on("end", () =>
						resolve({
							status: res.statusCode,
							headers: res.headers,
							body: Buffer.concat(chunks),
							text: Buffer.concat(chunks).toString("utf8"),
						}),
					);
				},
			);
			req.on("error", reject);
			req.end();
		});
	}

	function httpPost(relayPort, host, path, body, headers = {}) {
		return new Promise((resolve, reject) => {
			const payload = Buffer.from(body, "utf8");
			const req = request(
				{
					host: "127.0.0.1",
					port: relayPort,
					path,
					method: "POST",
					headers: {
						"x-forwarded-host": host,
						"content-type": "application/x-www-form-urlencoded",
						"content-length": String(payload.length),
						...headers,
					},
				},
				(res) => {
					const chunks = [];
					res.on("data", (chunk) => chunks.push(chunk));
					res.on("end", () =>
						resolve({
							status: res.statusCode,
							headers: res.headers,
							body: Buffer.concat(chunks),
							text: Buffer.concat(chunks).toString("utf8"),
						}),
					);
				},
			);
			req.on("error", reject);
			req.end(payload);
		});
	}

	it("eliminates HOL blocking via TYPE.window credits, streams SSE past first-byte timeout with keepalives, and reuses keep-alive sockets in client.mjs", async (t) => {
		const siteId = randomUUID();
		const token = "w".repeat(32);
		const claim = `c${"w".repeat(42)}`;
		const key = `k${"w".repeat(42)}`;
		const seenPorts = new Set();
		const app = createServer((req, res) => {
			seenPorts.add(req.socket.remotePort);
			if (req.url === "/fast") {
				res.writeHead(200, { "content-type": "text/plain" });
				res.end("fast-ok");
				return;
			}
			if (req.url === "/slow-big") {
				const total = 4 * 1024 * 1024;
				res.writeHead(200, { "content-type": "application/octet-stream", "content-length": String(total) });
				const chunk = Buffer.alloc(64 * 1024, 0x62);
				let left = total / chunk.length;
				const pump = () => {
					while (left > 0) {
						left--;
						if (!res.write(chunk)) {
							res.once("drain", pump);
							return;
						}
					}
					res.end();
				};
				pump();
				return;
			}
			if (req.url === "/events") {
				res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
				res.write("data: first\n\n");
				setTimeout(() => {
					if (!res.destroyed && !res.writableEnded) {
						res.write("data: second\n\n");
						res.end();
					}
				}, 450);
				return;
			}
			res.writeHead(404);
			res.end();
		});
		const appPort = await listen(app);
		const fetcher = async (url, init) => {
			const body = JSON.parse(init.body);
			if (url.endsWith("/qorpera_site_app_connect"))
				return Response.json({ state: "ok", siteId, port: appPort, key: body.p_secret === claim ? key : null });
			if (url.endsWith("/qorpera_site_app_session"))
				return Response.json(body.p_token === token ? { state: "open", siteId } : { state: "locked" });
			return Response.json({ state: "locked" });
		};
		const relay = createRelay({
			api: "http://database.invalid",
			...RELAY,
			hostSuffix: SUFFIX,
			fetch: fetcher,
			firstByteTimeoutMs: 250,
			streamIdleTimeoutMs: 2_000,
			sseKeepaliveMs: 120,
			pausedMs: 4_000,
			log: () => {},
		});
		const relayPort = await listen(relay);
		const bridge = await startBridge(relayPort, HOST);
		const child = spawn(process.execPath, [CLIENT, "shop", String(appPort), claim, SUFFIX], {
			env: { ...process.env, QORPERA_APP_RELAY_ORIGIN: `ws://127.0.0.1:${bridge.port}` },
			stdio: ["ignore", "pipe", "pipe"],
		});
		t.after(async () => {
			child.kill("SIGKILL");
			await bridge.close();
			relay.closeAllConnections();
			await new Promise((r) => relay.close(r));
			app.closeAllConnections();
			await new Promise((r) => app.close(r));
		});
		await until(() => relay.isConnected("shop"), "client.mjs to connect", 5_000);

		const slowSock = connect(relayPort, "127.0.0.1", () => {
			slowSock.pause();
			slowSock.write(
				`GET /slow-big HTTP/1.1\r\nHost: ${HOST}\r\nX-Forwarded-Host: ${HOST}\r\nCookie: ${GATE_COOKIE}=${token}\r\nConnection: close\r\n\r\n`,
			);
		});
		t.after(() => slowSock.destroy());
		await sleep(80);
		const fastStart = Date.now();
		for (let i = 0; i < 6; i++) {
			const res = await httpGet(relayPort, HOST, "/fast", { cookie: `${GATE_COOKIE}=${token}` });
			assert.equal(res.status, 200);
			assert.equal(res.text, "fast-ok");
		}
		assert.ok(Date.now() - fastStart < 1500, "sibling requests completed without HOL stall");
		assert.equal(relay.pauseCount("shop"), 0, "shared tunnel must never be globally paused");
		assert.ok(seenPorts.size <= 3, `expected HTTP keep-alive agent reuse, saw ${seenPorts.size} ports`);

		slowSock.resume();
		slowSock.on("data", () => {});
		await new Promise((resolve) => slowSock.once("end", resolve));
		assert.ok(relay.windowUpdates("shop") > 0, "per-stream TYPE.window updates flowed");

		const sse = await httpGet(relayPort, HOST, "/events", { cookie: `${GATE_COOKIE}=${token}` });
		assert.equal(sse.status, 200);
		assert.equal(sse.headers["x-accel-buffering"], "no");
		assert.equal(sse.headers["cache-control"], "no-cache, no-transform");
		assert.ok(sse.text.includes("data: first\n\n"));
		assert.ok(sse.text.includes(": keepalive\n\n"), `expected SSE keepalive comment in ${JSON.stringify(sse.text)}`);
		assert.ok(sse.text.includes("data: second\n\n"));
	});

	it("enforces company_member auth mode via POST /.qorpera/member into __Host-qorpera_app, strips spoofed X-Qorpera-* headers, supports public mode with absent-Origin WS, and routes verified custom domains", async (t) => {
		const siteId = randomUUID();
		const memberId = randomUUID();
		const memberPass = "m".repeat(43);
		const memberSession = "s".repeat(32);
		const claim = `c${"m".repeat(42)}`;
		const key = `k${"m".repeat(42)}`;
		const customHost = "app.acme-test.example";
		let authMode = "company_member";
		let passRedeemed = false;
		const wsReceivedHeaders = [];

		assert.deepEqual(parseWebOrigins('["https://app.qorpera.com","http://bad.example"]'), ["https://app.qorpera.com"]);
		assert.ok(PUBLIC_RATE_LIMIT_BURST >= 300);

		const app = createServer((req, res) => {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(
				JSON.stringify({
					host: req.headers.host,
					memberId: req.headers["x-qorpera-member-id"] ?? null,
					spoofed: req.headers["x-qorpera-spoof"] ?? null,
					authorization: req.headers.authorization ?? null,
				}),
			);
		});
		app.on("upgrade", (req, socket) => {
			wsReceivedHeaders.push({ ...req.headers });
			const accept = acceptKey(req.headers);
			socket.write(
				`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
			);
			const ws = new WebSocketConnection(socket, Buffer.alloc(0), { allowText: true });
			ws.onMessage = (msg, opcode) => ws.send(msg, opcode);
		});
		const appPort = await listen(app);
		const fetcher = async (url, init) => {
			const body = JSON.parse(init.body);
			if (url.endsWith("/qorpera_site_app_connect")) {
				return Response.json({
					state: "ok",
					siteId,
					port: appPort,
					key: body.p_secret === claim ? key : null,
					authMode,
					domains: [customHost],
				});
			}
			if (url.endsWith("/qorpera_site_app_session")) {
				const isCustom = body.p_slug === customHost;
				const slugExtra = isCustom ? { slug: "shop" } : {};
				if (authMode === "public") return Response.json({ state: "open", siteId, authMode: "public", ...slugExtra });
				if (body.p_token === memberSession) {
					return Response.json({ state: "open", siteId, authMode: "company_member", memberId, ...slugExtra });
				}
				return Response.json({ state: "locked", authMode: "company_member", ...slugExtra });
			}
			if (url.endsWith("/qorpera_site_app_unlock")) {
				if (body.p_password === memberPass && !passRedeemed) {
					passRedeemed = true;
					return Response.json({ state: "open", token: memberSession, maxAge: 43200, memberId });
				}
				return Response.json({ state: "wrong" });
			}
			return Response.json({ state: "locked" });
		};
		const relay = createRelay({
			api: "http://database.invalid",
			...RELAY,
			hostSuffix: SUFFIX,
			fetch: fetcher,
			recheckMs: 120,
			publicRateLimitPerMinute: 4,
			log: () => {},
		});
		const relayPort = await listen(relay);
		const bridge = await startBridge(relayPort, HOST);
		const child = spawn(process.execPath, [CLIENT, "shop", String(appPort), claim, SUFFIX], {
			env: { ...process.env, QORPERA_APP_RELAY_ORIGIN: `ws://127.0.0.1:${bridge.port}` },
			stdio: ["ignore", "pipe", "pipe"],
		});
		t.after(async () => {
			child.kill("SIGKILL");
			await bridge.close();
			relay.closeAllConnections();
			await new Promise((r) => relay.close(r));
			app.closeAllConnections();
			await new Promise((r) => app.close(r));
		});
		await until(() => relay.isConnected("shop"), "company_member client to connect", 5_000);

		const locked = await httpGet(relayPort, HOST, "/");
		assert.equal(locked.status, 401);
		assert.match(locked.text, /Company members only/);

		const nonHostCookie = await httpGet(relayPort, HOST, "/", {
			cookie: `qorpera_site_member_pass=${memberPass}`,
		});
		assert.equal(nonHostCookie.status, 401);

		const badOriginMemberPost = await httpPost(relayPort, HOST, "/.qorpera/member", `pass=${memberPass}`, {
			origin: "https://sibling.qorpera.com",
			"sec-fetch-site": "same-site",
		});
		assert.equal(badOriginMemberPost.status, 403);

		const missingOriginMemberPost = await httpPost(relayPort, HOST, "/.qorpera/member", `pass=${memberPass}`, {
			"sec-fetch-site": "same-site",
		});
		assert.equal(missingOriginMemberPost.status, 403);

		const redeemed = await httpPost(relayPort, HOST, "/.qorpera/member", `pass=${memberPass}&path=dashboard`, {
			origin: "https://app.qorpera.com",
			"sec-fetch-site": "same-site",
		});
		assert.equal(redeemed.status, 303);
		assert.equal(redeemed.headers.location, "/dashboard");
		const setCookie = String(redeemed.headers["set-cookie"] ?? "");
		assert.match(setCookie, new RegExp(`^${GATE_COOKIE}=${memberSession};.*HttpOnly; Secure; SameSite=Lax`));

		const replay = await httpPost(relayPort, HOST, "/.qorpera/member", `pass=${memberPass}`, {
			origin: "https://app.qorpera.com",
			"sec-fetch-site": "same-site",
		});
		assert.equal(replay.status, 401);

		const memberRes = await httpGet(relayPort, customHost, "/", {
			cookie: `${GATE_COOKIE}=${memberSession}`,
			"x-qorpera-member-id": "00000000-0000-0000-0000-000000000000",
			"x-qorpera-spoof": "evil",
		});
		assert.equal(memberRes.status, 200);
		const memberPayload = JSON.parse(memberRes.text);
		assert.equal(memberPayload.host, customHost);
		assert.equal(memberPayload.memberId, memberId);
		assert.equal(memberPayload.spoofed, null);

		const wsCustom = await rawUpgrade(
			relayPort,
			customHost,
			"/ws",
			`Origin: https://${customHost}\r\nCookie: ${GATE_COOKIE}=${memberSession}\r\nAuthorization: Bearer app-jwt\r\nX-Qorpera-Member-Id: forged\r\n`,
		);
		t.after(() => wsCustom.socket.destroy());
		assert.equal(wsCustom.status, 101);
		await until(() => wsReceivedHeaders.length >= 1, "ws upgrade headers recorded", 2_000);
		assert.equal(wsReceivedHeaders[0]["x-qorpera-member-id"], memberId);
		assert.equal(wsReceivedHeaders[0].authorization, "Bearer app-jwt");
		wsCustom.socket.destroy();

		const wsMemberNoOrigin = await rawUpgrade(relayPort, HOST, "/ws", `Cookie: ${GATE_COOKIE}=${memberSession}\r\n`);
		assert.equal(wsMemberNoOrigin.status, 403);
		wsMemberNoOrigin.socket.destroy();

		authMode = "public";
		await sleep(220);

		const pubRes = await httpGet(relayPort, HOST, "/public-ok", { "cf-connecting-ip": "198.51.100.42" });
		assert.equal(pubRes.status, 200);

		const wsPublicCli = await rawUpgrade(
			relayPort,
			HOST,
			"/ws-cli",
			"Authorization: Bearer sdk-key\r\nCF-Connecting-IP: 198.51.100.42\r\n",
		);
		t.after(() => wsPublicCli.socket.destroy());
		assert.equal(wsPublicCli.status, 101);
		wsPublicCli.socket.destroy();

		const wsPublicBadOrigin = await rawUpgrade(
			relayPort,
			HOST,
			"/ws-cli",
			"Origin: https://evil.example\r\nCF-Connecting-IP: 198.51.100.42\r\n",
		);
		assert.equal(wsPublicBadOrigin.status, 403);
		wsPublicBadOrigin.socket.destroy();

		const wsPublicCookieNoOrigin = await rawUpgrade(
			relayPort,
			HOST,
			"/ws-cli",
			`Cookie: session=abc\r\nCF-Connecting-IP: 198.51.100.42\r\n`,
		);
		assert.equal(wsPublicCookieNoOrigin.status, 403);
		wsPublicCookieNoOrigin.socket.destroy();

		await httpGet(relayPort, HOST, "/r3", { "cf-connecting-ip": "198.51.100.42" });
		await httpGet(relayPort, HOST, "/r4", { "cf-connecting-ip": "198.51.100.42" });
		const limited = await httpGet(relayPort, HOST, "/r5", { "cf-connecting-ip": "198.51.100.42" });
		assert.equal(limited.status, 429);
	});

	it("closes a rogue link program with 1002 when it ignores per-stream TYPE.window credits while a visitor stops reading", async (t) => {
		const siteId = randomUUID();
		const token = "f".repeat(32);
		const claim = `c${"f".repeat(42)}`;
		const key = `k${"f".repeat(42)}`;
		const programId = "r".repeat(43);

		const fetcher = async (url, init) => {
			const body = JSON.parse(init.body);
			if (url.endsWith("/qorpera_site_app_connect")) {
				return Response.json({ state: "ok", siteId, port: 4123, key: body.p_secret === claim ? key : null });
			}
			if (url.endsWith("/qorpera_site_app_session")) {
				return Response.json(body.p_token === token ? { state: "open", siteId } : { state: "locked" });
			}
			return Response.json({ state: "locked" });
		};
		const relay = createRelay({
			api: "http://database.invalid",
			...RELAY,
			hostSuffix: SUFFIX,
			fetch: fetcher,
			streamWindowBytes: 32 * 1024,
			windowUpdateThreshold: 16 * 1024,
			recheckMs: 0,
			log: () => {},
		});
		const relayPort = await listen(relay);
		t.after(async () => {
			relay.closeAllConnections();
			await new Promise((r) => relay.close(r));
		});

		const rogue = await rawUpgrade(
			relayPort,
			HOST,
			"/.qorpera/connect",
			`Authorization: Bearer ${claim}\r\nX-Qorpera-Program: ${programId}\r\n`,
		);
		t.after(() => rogue.socket.destroy());
		assert.equal(rogue.status, 101);
		await until(() => relay.isConnected("shop"), "rogue program connected", 2_000);

		let closeCode = null;
		let buf = Buffer.from(rogue.rest);
		let flooded = false;
		const mask = Buffer.from([1, 2, 3, 4]);
		const sendClientFrame = (type, streamId, payload) => {
			if (!rogue.socket.destroyed) rogue.socket.write(encodeFrame(0x2, encodeMessage(type, streamId, payload), { mask }));
		};
		rogue.socket.on("data", (chunk) => {
			buf = Buffer.concat([buf, chunk]);
			while (buf.length >= 2) {
				const frame = decodeFrame(buf, { masked: false });
				if (!frame) break;
				buf = buf.subarray(frame.size);
				if (frame.opcode === 0x8) {
					closeCode = decodeWsClose(frame.payload).code;
				} else if (frame.opcode === 0x2) {
					const msg = decodeMessage(frame.payload);
					if (msg.type === TYPE.head && !flooded) {
						flooded = true;
						sendClientFrame(
							TYPE.response,
							msg.stream,
							Buffer.from(JSON.stringify({ status: 200, headers: [["content-type", "application/octet-stream"]] })),
						);
						const big = Buffer.alloc(16 * 1024, 0x41);
						let sent = 0;
						const pump = () => {
							if (closeCode !== null || rogue.socket.destroyed || sent >= 512) return;
							for (let i = 0; i < 8 && sent < 512; i++, sent++) sendClientFrame(TYPE.body, msg.stream, big);
							setImmediate(pump);
						};
						pump();
					}
				}
			}
		});

		const visitor = connect(relayPort, "127.0.0.1");
		t.after(() => visitor.destroy());
		await new Promise((resolve) => visitor.once("connect", resolve));
		visitor.pause();
		visitor.write(
			`GET /flood HTTP/1.1\r\nHost: ${HOST}\r\nX-Forwarded-Host: ${HOST}\r\nCookie: ${GATE_COOKIE}=${token}\r\n\r\n`,
		);

		await until(() => closeCode !== null, "relay to close rogue program", 3_000);
		assert.equal(closeCode, 1002);
		await until(() => !relay.isConnected("shop"), "rogue program removed", 2_000);
	});

	it("evicts the heaviest stalled stream when maxProgramBufferedBytes is exceeded while letting a fast reader complete", async (t) => {
		const siteId = randomUUID();
		const token = "e".repeat(32);
		const claim = `c${"e".repeat(42)}`;
		const key = `k${"e".repeat(42)}`;
		const bigChunk = Buffer.alloc(64 * 1024, 0x62);

		let abortedOnApp = 0;
		const app = createServer((req, res) => {
			if (req.url === "/fast") {
				res.writeHead(200, { "content-type": "text/plain" });
				res.end("fast-reader-ok");
				return;
			}
			res.writeHead(200, { "content-type": "application/octet-stream" });
			res.on("close", () => {
				if (!res.writableEnded) abortedOnApp++;
			});
			let sent = 0;
			const pump = () => {
				while (sent < 2048 && !res.destroyed && !res.closed) {
					sent++;
					if (!res.write(bigChunk)) return void res.once("drain", pump);
				}
				if (!res.destroyed && !res.closed) res.end();
			};
			pump();
		});
		const appPort = await listen(app);
		const fetcher = async (url, init) => {
			const body = JSON.parse(init.body);
			if (url.endsWith("/qorpera_site_app_connect"))
				return Response.json({ state: "ok", siteId, port: appPort, key: body.p_secret === claim ? key : null });
			if (url.endsWith("/qorpera_site_app_session"))
				return Response.json(body.p_token === token ? { state: "open", siteId } : { state: "locked" });
			return Response.json({ state: "locked" });
		};
		const relay = createRelay({
			api: "http://database.invalid",
			...RELAY,
			hostSuffix: SUFFIX,
			fetch: fetcher,
			streamWindowBytes: 256 * 1024,
			windowUpdateThreshold: 128 * 1024,
			maxProgramBufferedBytes: 64 * 1024,
			recheckMs: 0,
			log: () => {},
		});
		const relayPort = await listen(relay);
		const bridge = await startBridge(relayPort, HOST);
		const child = spawn(process.execPath, [CLIENT, "shop", String(appPort), claim, SUFFIX], {
			env: { ...process.env, QORPERA_APP_RELAY_ORIGIN: `ws://127.0.0.1:${bridge.port}` },
			stdio: ["ignore", "pipe", "pipe"],
		});
		t.after(async () => {
			child.kill("SIGKILL");
			await bridge.close();
			relay.closeAllConnections();
			await new Promise((r) => relay.close(r));
			app.closeAllConnections();
			await new Promise((r) => app.close(r));
		});
		await until(() => relay.isConnected("shop"), "eviction client to connect", 5_000);

		const stalled = [];
		let closedStalled = 0;
		for (let i = 0; i < 6; i++) {
			const sock = connect(relayPort, "127.0.0.1");
			t.after(() => sock.destroy());
			sock.on("error", () => {});
			sock.on("close", () => {
				closedStalled++;
			});
			await new Promise((resolve) => sock.once("connect", resolve));
			sock.pause();
			sock.write(
				`GET /stall-${i} HTTP/1.1\r\nHost: ${HOST}\r\nX-Forwarded-Host: ${HOST}\r\nCookie: ${GATE_COOKIE}=${token}\r\n\r\n`,
			);
			stalled.push(sock);
		}
		await until(
			() => relay.evictions("shop") > 0 && abortedOnApp >= 1,
			"relay to evict at least one stalled stream",
			10_000,
		);
		assert.ok(relay.evictions("shop") >= 1, "expected at least one stalled-stream eviction");
		assert.ok(abortedOnApp >= 1, "expected upstream app request to abort on eviction");

		for (let i = 0; i < 5; i++) {
			const fast = await httpGet(relayPort, HOST, "/fast", { cookie: `${GATE_COOKIE}=${token}` });
			assert.equal(fast.status, 200);
			assert.equal(fast.text, "fast-reader-ok");
		}
		for (const sock of stalled) {
			sock.on("data", () => {});
			sock.resume();
		}
		await until(() => closedStalled >= 1, "evicted stalled socket to close once drained", 5_000);
		assert.ok(closedStalled >= 1, "expected at least one evicted stalled socket to close");
		for (const sock of stalled) sock.destroy();
	});

	it("allows high-burst Vite/SPA page loads in public mode via token bucket without 429", async (t) => {
		const siteId = randomUUID();
		const claim = `c${"p".repeat(42)}`;
		const key = `k${"p".repeat(42)}`;
		const app = createServer((_req, res) => {
			res.writeHead(200, { "content-type": "application/javascript" });
			res.end("export default 1;");
		});
		const appPort = await listen(app);
		const fetcher = async (url, init) => {
			const body = JSON.parse(init.body);
			if (url.endsWith("/qorpera_site_app_connect")) {
				return Response.json({
					state: "ok",
					siteId,
					port: appPort,
					key: body.p_secret === claim ? key : null,
					authMode: "public",
				});
			}
			if (url.endsWith("/qorpera_site_app_session")) {
				return Response.json({ state: "open", siteId, authMode: "public" });
			}
			return Response.json({ state: "locked" });
		};
		const relay = createRelay({
			api: "http://database.invalid",
			...RELAY,
			hostSuffix: SUFFIX,
			fetch: fetcher,
			recheckMs: 0,
			log: () => {},
		});
		const relayPort = await listen(relay);
		const bridge = await startBridge(relayPort, HOST);
		const child = spawn(process.execPath, [CLIENT, "shop", String(appPort), claim, SUFFIX], {
			env: { ...process.env, QORPERA_APP_RELAY_ORIGIN: `ws://127.0.0.1:${bridge.port}` },
			stdio: ["ignore", "pipe", "pipe"],
		});
		t.after(async () => {
			child.kill("SIGKILL");
			await bridge.close();
			relay.closeAllConnections();
			await new Promise((r) => relay.close(r));
			app.closeAllConnections();
			await new Promise((r) => app.close(r));
		});
		await until(() => relay.isConnected("shop"), "public client to connect", 5_000);

		for (let i = 0; i < 150; i++) {
			const res = await httpGet(relayPort, HOST, `/mod-${i}.js`, { "cf-connecting-ip": "198.51.100.77" });
			assert.equal(res.status, 200, `request ${i} should succeed under default public token bucket burst`);
		}
	});

	it("reports active /healthz probes, performs zero-downtime SWAP_TARGET blue-green port swaps (including on recheck), and drains in-flight requests on shutdown", async (t) => {
		const siteId = randomUUID();
		const token = "z".repeat(32);
		const claim = `c${"z".repeat(42)}`;
		const key = `k${"z".repeat(42)}`;
		let releaseV1 = null;

		const appV1 = createServer((req, res) => {
			if (req.url === "/healthz") {
				res.writeHead(200);
				res.end("ok-v1");
				return;
			}
			if (req.url === "/slow-v1") {
				res.writeHead(200, { "content-type": "text/plain" });
				res.write("v1-start:");
				releaseV1 = () => res.end("v1-done");
				return;
			}
			res.writeHead(200, { "content-type": "text/plain" });
			res.end("from-v1");
		});
		const appV2 = createServer((req, res) => {
			if (req.url === "/healthz") {
				res.writeHead(200);
				res.end("ok-v2");
				return;
			}
			res.writeHead(200, { "content-type": "text/plain" });
			res.end("from-v2");
		});
		const portV1 = await listen(appV1);
		const portV2 = await listen(appV2);
		let dbPort = portV1;

		const fetcher = async (url, init) => {
			const body = JSON.parse(init.body);
			if (url.endsWith("/qorpera_site_app_connect"))
				return Response.json({ state: "ok", siteId, port: dbPort, key: body.p_secret === claim ? key : null });
			if (url.endsWith("/qorpera_site_app_session"))
				return Response.json(body.p_token === token ? { state: "open", siteId } : { state: "locked" });
			return Response.json({ state: "locked" });
		};
		const relay = createRelay({
			api: "http://database.invalid",
			...RELAY,
			hostSuffix: SUFFIX,
			fetch: fetcher,
			recheckMs: 120,
			log: () => {},
		});
		const relayPort = await listen(relay);
		const bridge = await startBridge(relayPort, HOST);
		const child = spawn(process.execPath, [CLIENT, "shop", String(portV1), claim, SUFFIX], {
			env: {
				...process.env,
				QORPERA_APP_RELAY_ORIGIN: `ws://127.0.0.1:${bridge.port}`,
				QORPERA_APP_HEALTH_PATH: "/healthz",
				QORPERA_APP_HEALTH_INTERVAL_MS: "80",
			},
			stdio: ["ignore", "pipe", "pipe"],
		});
		t.after(async () => {
			child.kill("SIGKILL");
			await bridge.close();
			relay.closeAllConnections();
			await new Promise((r) => relay.close(r));
			appV1.closeAllConnections();
			await new Promise((r) => appV1.close(r));
			appV2.closeAllConnections();
			await new Promise((r) => appV2.close(r));
		});
		await until(() => relay.isConnected("shop"), "client.mjs to connect", 5_000);
		await until(() => relay.programHealth("shop").lastStatus === 200, "active /healthz heartbeat", 3_000);
		const health = relay.programHealth("shop");
		assert.equal(health.connected, true);
		assert.equal(health.healthy, true);
		assert.equal(health.port, portV1);
		assert.equal(typeof health.lastLatencyMs, "number");

		const inFlightV1 = httpGet(relayPort, HOST, "/slow-v1", { cookie: `${GATE_COOKIE}=${token}` });
		await until(() => releaseV1 !== null, "slow v1 request to reach appV1", 3_000);

		dbPort = portV2;
		await until(() => relay.programHealth("shop").port === portV2, "recheck to live-swap to portV2", 3_000);
		assert.equal(relay.isConnected("shop"), true);

		const newReq = await httpGet(relayPort, HOST, "/which", { cookie: `${GATE_COOKIE}=${token}` });
		assert.equal(newReq.status, 200);
		assert.equal(newReq.text, "from-v2");

		releaseV1();
		const finishedV1 = await inFlightV1;
		assert.equal(finishedV1.status, 200);
		assert.equal(finishedV1.text, "v1-start:v1-done");

		let releaseDrainReq = null;
		const appV3 = createServer((req, res) => {
			if (req.url === "/healthz") {
				res.writeHead(200);
				res.end("ok");
				return;
			}
			res.writeHead(200, { "content-type": "text/plain" });
			res.write("drain:");
			releaseDrainReq = () => res.end("complete");
		});
		const portV3 = await listen(appV3);
		t.after(async () => {
			appV3.closeAllConnections();
			await new Promise((r) => appV3.close(r));
		});
		dbPort = portV3;
		const swapV3 = await relay.swapTarget("shop", portV3, { healthPath: "/healthz", timeoutMs: 3_000 });
		assert.equal(swapV3.ok, true);

		const drainingReq = httpGet(relayPort, HOST, "/during-drain", { cookie: `${GATE_COOKIE}=${token}` });
		await until(() => releaseDrainReq !== null, "drain request to start", 3_000);
		const drainPromise = relay.drain(3_000);
		await sleep(50);
		releaseDrainReq();
		const drainRes = await drainingReq;
		assert.equal(drainRes.status, 200);
		assert.equal(drainRes.text, "drain:complete");
		await drainPromise;
	});
});
