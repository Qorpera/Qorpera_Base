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
	appCookie,
	appHost,
	CLEAR_GATE_COOKIE,
	CLOSE,
	clientAddress,
	createRelay,
	decodeFrame,
	decodeMessage,
	encodeFrame,
	encodeMessage,
	FORWARDED_CACHE_HEADERS,
	GATE_COOKIE,
	gateCookie,
	gateTokens,
	headerPairs,
	jwtRole,
	language,
	MAX_QUEUED_BYTES,
	PAGE_SECURITY_POLICY,
	parseConnectAnswer,
	parseSessionAnswer,
	parseUnlockAnswer,
	passwordPage,
	RELAY_ROLE,
	relayHeaders,
	requestHeaders,
	responseHeaders,
	safeNext,
	TYPE,
	WebSocketConnection,
	WebSocketError,
	withoutGateCookie,
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
			if (!app) return { state: "refused" };
			const claim = app.claims.get(args.p_secret);
			if (claim && !claim.used) {
				// Used at once; the new key replaces the old one, so only the newest program connects.
				claim.used = true;
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
		db.sites.get(slug).claims.set(claim, { used: false });
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
		assert.ok(db.sites.get("shop").claims.get(claim).used);
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
		// Each request on a connection of its own to the app.
		assert.deepEqual(values(seen.headers, "connection"), ["close"]);
		for (const name of ["x-real-ip", "forwarded", "x-envoy-original-path", "x-hop"])
			assert.deepEqual(values(seen.headers, name), [], name);
		// Only the gate cookie: no Cookie header at all.
		const bare = JSON.parse((await visit("/echo", { headers: withSession() })).text);
		assert.deepEqual(values(bare.headers, "cookie"), []);
		assert.ok(!JSON.stringify(seen.headers).includes(token));
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

	it("never lets a shared cache keep an answer: the app's cache headers go, private and no-store come", async () => {
		const answer = await visit("/assets/app.js", { headers: withSession() });
		assert.equal(answer.status, 200);
		assert.equal(answer.text, "export {};");
		assert.deepEqual(values(answer.raw, "cache-control"), ["private, no-cache"]);
		assert.deepEqual(values(answer.raw, "cdn-cache-control"), ["no-store"]);
		for (const name of ["expires", "cloudflare-cdn-cache-control", "surrogate-control"])
			assert.deepEqual(values(answer.raw, name), [], name);
		// The browser may still ask again with its tag.
		assert.equal(answer.headers.etag, '"v1"');
		const plain = await visit("/hello", { headers: withSession() });
		assert.equal(plain.headers["cache-control"], "private, no-cache");
		assert.equal(plain.headers["cdn-cache-control"], "no-store");
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
		// The visitor never reads: the relay's buffers fill and the program waits, for half a second (pausedMs) at most.
		socket.pause();
		await sleep(300);
		// Another visitor is served while the first still reads nothing: its answer has ended, the program goes on.
		assert.equal((await visit("/hello", { headers: withSession() })).text, "hello");
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

	it("answers a visitor's WebSocket with 501, and an unknown host's with 404", async () => {
		const live = await rawUpgrade(relayPort, HOST, "/socket");
		assert.equal(live.status, 501);
		live.socket.destroy();
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
			lab = await rawUpgrade(relayPort, LAB, "/.qorpera/connect", `Authorization: Bearer ${db.claim("lab")}\r\n`);
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
			assert.deepEqual(Object.keys(said), ["key", "url", "port"]);
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

		it("refuses no secret, a wrong one or another scheme with 4001, after asking the database for a Bearer only", async () => {
			const asked = db.connects().length;
			for (const extra of ["", `Authorization: Bearer ${"w".repeat(43)}\r\n`, "Authorization: Basic abc\r\n"]) {
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
				const socket = await rawUpgrade(relayPort, LAB, "/.qorpera/connect", `Authorization: Bearer ${key}\r\n`);
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
		const lab = await rawUpgrade(port, LAB, "/.qorpera/connect", `Authorization: Bearer ${db.claim("lab")}\r\n`);
		t.after(async () => {
			lab.socket.destroy();
			await new Promise((resolve) => relay.close(resolve));
			db.server.close();
			db.server.closeAllConnections();
		});
		const frames = frameReader(lab.socket, lab.rest);
		assert.equal(decodeMessage((await frames.next()).payload).type, TYPE.hello);
		return { db, relay, frames };
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

	it("checks a program again: a changed port closes it with 1012, so it connects again and learns the port", async (t) => {
		const { db, relay, frames } = await setup(t, { recheckMs: 150 });
		db.sites.get("lab").port = 3001;
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
		const lab = await rawUpgrade(port, LAB, "/.qorpera/connect", `Authorization: Bearer ${"c".repeat(43)}\r\n`);
		assert.equal(lab.status, 503);
		lab.socket.destroy();
	});

	it("completes no handshake before the database answers, and limits connect attempts per address", async (t) => {
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
			connectLimit: { perMinute: 2, pending: 1, total: 10 },
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
				`Authorization: Bearer ${"k".repeat(43)}\r\nCF-Connecting-IP: ${address}\r\n`,
			);
			sockets.push(socket);
			const got = [];
			socket.on("data", (chunk) => got.push(chunk));
			socket.on("error", () => {});
			return { socket, got, head: answerHead(socket) };
		};
		const first = attempt("203.0.113.1");
		await until(() => asked.length === 1, "the database to be asked");
		// One in flight for this address already: the next waits, another address does not.
		const second = attempt("203.0.113.1");
		assert.equal((await second.head).status, 429);
		const other = attempt("198.51.100.7");
		await until(() => asked.length === 2, "the other address's connect");
		await sleep(100);
		assert.equal(first.got.length, 0, "nothing written before the database answered");
		answer();
		assert.equal((await first.head).status, 101);
		assert.equal((await other.head).status, 101);
		// Two a minute for this address: one more, then 429.
		assert.equal((await attempt("203.0.113.1").head).status, 101);
		assert.equal((await attempt("203.0.113.1").head).status, 429);
		assert.equal(asked.length, 3);
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
				["cache-control", "private, no-cache"],
				["cdn-cache-control", "no-store"],
			],
		);
		assert.deepEqual(
			responseHeaders([]),
			FORWARDED_CACHE_HEADERS.map((pair) => [...pair]),
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
		assert.deepEqual(TYPE, { head: 1, body: 2, end: 3, response: 4, reset: 5, hello: 6, keepalive: 7 });
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
