/* The relay and the link program (deploy/sites/APP-PREVIEW.md, section 3), end to end in one process: a fake
 * database (PostgREST's RPC paths: claims, keys, sessions, the password), the relay, a tiny app on a random port, a
 * front standing in for api-front (it adds x-forwarded-host, as the apps virtual host does) and the real client.mjs
 * as a child process. Then the pure parts on their own. Run: node --test deploy/sites/ */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
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
	GATE_COOKIE,
	gateCookie,
	gateTokens,
	headerPairs,
	language,
	PAGE_SECURITY_POLICY,
	parseConnectAnswer,
	parseSessionAnswer,
	parseUnlockAnswer,
	passwordPage,
	requestHeaders,
	responseHeaders,
	safeNext,
	serviceHeaders,
	TYPE,
	WebSocketError,
	withoutGateCookie,
} from "./relay.mjs";

const SUFFIX = "-preview.example.test";
const HOST = `shop${SUFFIX}`;
const LAB = `lab${SUFFIX}`;
const ORIGIN = `https://${HOST}`;
const SERVICE_KEY = `eyJhbGciOiJIUzI1NiJ9.${Buffer.from('{"role":"service_role"}').toString("base64url")}.c2lnbmF0dXJl`;
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

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const values = (pairs, name) => pairs.filter(([key]) => key.toLowerCase() === name).map(([, value]) => value);

/** PostgREST's RPC paths as the four relay functions answer them, for two app sites (shop, lab). */
function fakeDatabase() {
	const site = () => ({ claims: new Map(), key: null, port: 0, sessions: new Set() });
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
				return { state: "ok", key: app.key, port: app.port };
			}
			if (app.key !== null && args.p_secret === app.key) return { state: "ok", key: null, port: app.port };
			return { state: "refused" };
		}
		if (name === "qorpera_site_app_session") return { state: app?.sessions.has(args.p_token) ? "open" : "locked" };
		if (name === "qorpera_site_unlock") {
			if (db.limited) return { state: "limited", retryAfter: 125 };
			if (!app || args.p_password !== PASSWORD) return { state: "wrong" };
			const token = randomBytes(24).toString("base64url");
			db.secrets.add(token);
			app.sessions.add(token);
			return { state: "open", token, maxAge: 604800 };
		}
		return { message: "no such function" };
	};
	db.server = createServer(async (req, res) => {
		const body = await readAll(req);
		const name = /^\/rest\/v1\/rpc\/([a-z_]+)$/.exec(req.url ?? "")?.[1];
		if (
			req.method !== "POST" ||
			!name ||
			req.headers.apikey !== SERVICE_KEY ||
			req.headers.authorization !== `Bearer ${SERVICE_KEY}` ||
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
	db.connects = () => db.calls.filter((call) => call.name === "qorpera_site_app_connect");
	db.sessionCalls = () => db.calls.filter((call) => call.name === "qorpera_site_app_session");
	return db;
}

/** The app on the machine: hello, an echo, a stream, cookies, a big body and one that never answers. */
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
		} else if (req.url === "/big") {
			res.writeHead(200, { "content-type": "application/octet-stream" });
			res.end(BIG);
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

/** A raw WebSocket handshake to a relay: the answer's status and head, and the socket for frames. */
function rawUpgrade(port, host, path, extra = "") {
	return new Promise((resolve, reject) => {
		const socket = connect(port, "127.0.0.1");
		const key = randomBytes(16).toString("base64");
		let buffer = Buffer.alloc(0);
		const onData = (chunk) => {
			buffer = Buffer.concat([buffer, chunk]);
			const end = buffer.indexOf("\r\n\r\n");
			if (end === -1) return;
			socket.off("data", onData);
			const head = buffer.subarray(0, end).toString();
			resolve({ socket, key, head, status: Number(head.split(" ")[1]), rest: buffer.subarray(end + 4) });
		};
		socket.on("data", onData);
		socket.on("error", reject);
		socket.write(
			`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nX-Forwarded-Host: ${host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
				`Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${key}\r\n${extra}\r\n`,
		);
	});
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

	function linkProgram(claim) {
		const child = spawn(process.execPath, [CLIENT, "shop", String(appPort), claim], {
			env: {
				...process.env,
				QORPERA_APP_RELAY_ORIGIN: `ws://127.0.0.1:${frontPort}`,
				QORPERA_APP_HOST_SUFFIX: SUFFIX,
			},
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

	const withSession = (headers = {}) => ({ cookie: `${GATE_COOKIE}=${token}`, ...headers });

	before(async () => {
		const dbPort = await listen(db.server);
		appPort = await listen(app.server);
		for (const site of db.sites.values()) site.port = appPort;
		relay = createRelay({
			api: `http://127.0.0.1:${dbPort}/`,
			serviceKey: SERVICE_KEY,
			hostSuffix: SUFFIX,
			responseTimeoutMs: 500,
			sessionCacheMs: 200,
			maxBodyBytes: 256 * 1024,
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

	it("serves the link program without the password", async () => {
		const client = await visit("/.qorpera/client.mjs");
		assert.equal(client.status, 200);
		assert.equal(client.headers["content-type"], "text/javascript; charset=utf-8");
		assert.equal(client.headers["x-content-type-options"], "nosniff");
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

	it("refuses another origin and a wrong password, limits tries, and keeps next on this host", async () => {
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
		assert.equal(db.calls.length, 0);
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
		assert.deepEqual(db.calls.at(-1), {
			name: "qorpera_site_unlock",
			args: { p_slug: "shop", p_password: PASSWORD, p_client: "203.0.113.9" },
		});
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

	it("connects the link program with its claim, then serves the app", async () => {
		const claim = db.claim("shop");
		const program = linkProgram(claim);
		await until(() => program.output.includes(`Connected: https://${HOST}/`), "the program to connect");
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
		await new Promise((resolve) => setTimeout(resolve, 250));
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
		for (const name of ["x-real-ip", "forwarded", "x-envoy-original-path", "x-hop"])
			assert.deepEqual(values(seen.headers, name), [], name);
		// Only the gate cookie: no Cookie header at all.
		const bare = JSON.parse((await visit("/echo", { headers: withSession() })).text);
		assert.deepEqual(values(bare.headers, "cookie"), []);
		assert.ok(!JSON.stringify(seen.headers).includes(token));
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

	it("answers 504 when the app has no answer in time, and ends the app's request", async () => {
		const answer = await visit("/slow", { headers: withSession() });
		assert.equal(answer.status, 504);
		assert.match(answer.text, /The app did not answer in time/);
		await until(() => app.aborted.includes("/slow"), "the app's request to end");
		// The program serves on.
		assert.equal((await visit("/hello", { headers: withSession() })).status, 200);
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

	it("says the app is not running again as soon as its program stops", async () => {
		const newest = programs.at(-1);
		newest.child.kill();
		await newest.exited;
		await until(() => !relay.isConnected("shop"), "the relay to see the program gone", 2000);
		assert.equal((await visit("/hello", { headers: withSession() })).status, 503);
	});

	it("speaks the protocol by hand: hello, ping, a request served frame by frame, refusals", async () => {
		const claim = db.claim("lab");
		const lab = await rawUpgrade(relayPort, LAB, "/.qorpera/connect", `Authorization: Bearer ${claim}\r\n`);
		assert.equal(lab.status, 101);
		assert.match(
			lab.head,
			new RegExp(
				`\\r\\nSec-WebSocket-Accept: ${acceptKey({
					upgrade: "websocket",
					connection: "Upgrade",
					"sec-websocket-version": "13",
					"sec-websocket-key": lab.key,
				}).replace(/[+/]/g, "\\$&")}`,
			),
		);
		const frames = frameReader(lab.socket, lab.rest);
		const hello = decodeMessage((await frames.message()).payload);
		assert.equal(hello.type, TYPE.hello);
		assert.equal(hello.stream, 0);
		const helloJson = JSON.parse(hello.payload.toString());
		assert.deepEqual(Object.keys(helloJson), ["key", "url"]);
		assert.ok(helloJson.key === db.sites.get("lab").key);
		assert.equal(helloJson.url, `https://${LAB}/`);
		// A ping is answered with its payload.
		lab.socket.write(encodeFrame(0x9, Buffer.from("are you there"), { mask: mask() }));
		const pong = await frames.message();
		assert.equal(pong.opcode, 0xa);
		assert.equal(pong.payload.toString(), "are you there");
		// A visitor of lab, served by hand: the head arrives, the answer goes back in two fragments and a body.
		db.sites.get("lab").sessions.add("L".repeat(32));
		const visitor = visit("/by-hand?x=1", {
			host: LAB,
			method: "POST",
			body: "ping",
			headers: { cookie: `${GATE_COOKIE}=${"L".repeat(32)}` },
		});
		const head = decodeMessage((await frames.message()).payload);
		assert.equal(head.type, TYPE.head);
		const asked = JSON.parse(head.payload.toString());
		assert.equal(asked.method, "POST");
		assert.equal(asked.path, "/by-hand?x=1");
		assert.deepEqual(values(asked.headers, "host"), [LAB]);
		const body = decodeMessage((await frames.message()).payload);
		assert.deepEqual([body.type, body.stream, body.payload.toString()], [TYPE.body, head.stream, "ping"]);
		assert.equal(decodeMessage((await frames.message()).payload).type, TYPE.end);
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
		lab.socket.write(encodeFrame(0x2, encodeMessage(TYPE.body, head.stream, Buffer.from("pong")), { mask: mask() }));
		lab.socket.write(encodeFrame(0x2, encodeMessage(TYPE.end, head.stream), { mask: mask() }));
		const served = await visitor;
		assert.equal(served.status, 200);
		assert.equal(served.text, "pong");
		assert.equal(served.headers["x-drop"], undefined);
		// A frame that is not masked ends the connection with 1002.
		lab.socket.write(encodeFrame(0x2, encodeMessage(TYPE.keepalive, 0)));
		const close = await frames.message();
		assert.equal(close.opcode, 0x8);
		assert.equal(close.payload.readUInt16BE(0), 1002);
		// The close handshake: answered, then the relay ends the connection.
		lab.socket.write(encodeFrame(0x8, close.payload.subarray(0, 2), { mask: mask() }));
		await frames.closed;
		await until(() => !relay.isConnected("lab"), "the lab program to be gone");
		// No secret, a wrong one, another scheme: the handshake completes and the close says 4001.
		for (const extra of ["", `Authorization: Bearer ${"w".repeat(43)}\r\n`, "Authorization: Basic abc\r\n"]) {
			const refused = await rawUpgrade(relayPort, LAB, "/.qorpera/connect", extra);
			assert.equal(refused.status, 101);
			const frame = await frameReader(refused.socket, refused.rest).message();
			assert.equal(frame.opcode, 0x8);
			assert.equal(frame.payload.readUInt16BE(0), CLOSE.refused);
			assert.equal(frame.payload.subarray(2).toString(), "refused");
			refused.socket.destroy();
		}
		// An oversized frame, a text frame, a reserved bit.
		const key = db.sites.get("lab").key;
		for (const [frame, code] of [
			[Buffer.concat([Buffer.from([0x82, 0xff]), Buffer.alloc(8, 0).fill(0xff, 5)]), 1009],
			[encodeFrame(0x1, Buffer.from("text"), { mask: mask() }), 1003],
			[Buffer.from([0xc2, 0x80, 1, 2, 3, 4]), 1002],
		]) {
			const socket = await rawUpgrade(relayPort, LAB, "/.qorpera/connect", `Authorization: Bearer ${key}\r\n`);
			const reader = frameReader(socket.socket, socket.rest);
			assert.equal(decodeMessage((await reader.message()).payload).type, TYPE.hello);
			socket.socket.write(frame);
			const close = await reader.message();
			assert.equal(close.opcode, 0x8);
			assert.equal(close.payload.readUInt16BE(0), code);
			socket.socket.destroy();
		}
	});

	it("never logs or prints a claim, key, token, password or cookie", () => {
		const said = [...logs, ...programs.map((program) => program.output)].join("\n");
		assert.ok(logs.length > 0);
		for (const secret of [...db.secrets, PASSWORD, SERVICE_KEY, token])
			assert.ok(!said.includes(secret), "a secret was logged");
		assert.doesNotMatch(said, /__Host-qorpera_app/);
	});
});

describe("app relay: keepalives and the key check", () => {
	/** A relay with these options and a lab program connected by hand; everything closes when the test ends. */
	async function setup(t, options) {
		const db = fakeDatabase();
		db.sites.get("lab").port = 3000;
		const dbPort = await listen(db.server);
		const relay = createRelay({
			api: `http://127.0.0.1:${dbPort}`,
			serviceKey: SERVICE_KEY,
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

	it("checks a program's key again, and closes it with 4001 once the link is off", async (t) => {
		const { db, relay, frames } = await setup(t, { recheckMs: 150 });
		await new Promise((resolve) => setTimeout(resolve, 400));
		assert.equal(relay.isConnected("lab"), true, "the key holds");
		assert.ok(db.connects().length >= 2, "checked again");
		db.sites.get("lab").key = null;
		const close = await frames.message(3000);
		assert.equal(close.opcode, 0x8);
		assert.equal(close.payload.readUInt16BE(0), CLOSE.refused);
	});

	it("closes with 1013 when the database cannot answer a connect, so the program tries again", async (t) => {
		const failing = createServer((_req, res) => {
			res.writeHead(500);
			res.end("{}");
		});
		const dbPort = await listen(failing);
		const relay = createRelay({
			api: `http://127.0.0.1:${dbPort}`,
			serviceKey: SERVICE_KEY,
			hostSuffix: SUFFIX,
			log: () => {},
		});
		const port = await listen(relay);
		const lab = await rawUpgrade(port, LAB, "/.qorpera/connect", `Authorization: Bearer ${"c".repeat(43)}\r\n`);
		t.after(async () => {
			lab.socket.destroy();
			await new Promise((resolve) => relay.close(resolve));
			failing.close();
			failing.closeAllConnections();
		});
		const close = await frameReader(lab.socket, lab.rest).message();
		assert.equal(close.payload.readUInt16BE(0), 1013);
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
				["Location", "/next"],
			]),
			[
				["Content-Type", "text/html"],
				["Set-Cookie", "s=1; Secure"],
				["Set-Cookie", "t=2;path=/"],
				["Set-Cookie", `${GATE_COOKIE}x=1`],
				["Location", "/next"],
			],
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
		assert.equal(
			acceptKey({
				upgrade: "websocket",
				connection: "Upgrade",
				"sec-websocket-version": "13",
				"sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
			}),
			"s3pPLMBiTxaQ9kYGzzhZRbK+xOo=",
		);
		assert.equal(
			acceptKey({
				upgrade: "websocket",
				connection: "Upgrade",
				"sec-websocket-version": "8",
				"sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
			}),
			null,
		);
		assert.equal(
			acceptKey({
				upgrade: "websocket",
				connection: "keep-alive",
				"sec-websocket-version": "13",
				"sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
			}),
			null,
		);
		assert.equal(
			acceptKey({
				upgrade: "websocket",
				connection: "Upgrade",
				"sec-websocket-version": "13",
				"sec-websocket-key": "short",
			}),
			null,
		);
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
		assert.deepEqual(parseConnectAnswer({ state: "ok", key: "k".repeat(43), port: 3000 }), {
			state: "ok",
			key: "k".repeat(43),
			port: 3000,
		});
		assert.deepEqual(parseConnectAnswer({ state: "ok", key: null, port: 1 }), { state: "ok", key: null, port: 1 });
		assert.deepEqual(parseConnectAnswer({ state: "refused" }), { state: "refused" });
		for (const value of [
			null,
			{ state: "ok", key: null },
			{ state: "ok", key: null, port: 0 },
			{ state: "ok", key: "short", port: 80 },
			{ state: "ok", key: null, port: 80, extra: 1 },
			{ state: "refused", why: "x" },
			{ state: "other" },
		])
			assert.throws(() => parseConnectAnswer(value), JSON.stringify(value));
		assert.deepEqual(parseSessionAnswer({ state: "open" }), { state: "open" });
		assert.throws(() => parseSessionAnswer({ state: "open", x: 1 }));
		assert.deepEqual(parseUnlockAnswer({ state: "limited", retryAfter: 0 }), { state: "limited", retryAfter: 1 });
		assert.throws(() => parseUnlockAnswer({ state: "open", token: "short", maxAge: 60 }));
		assert.deepEqual(serviceHeaders(SERVICE_KEY), { apikey: SERVICE_KEY, authorization: `Bearer ${SERVICE_KEY}` });
		assert.deepEqual(serviceHeaders("sb_secret_0123456789abcdefghij"), { apikey: "sb_secret_0123456789abcdefghij" });
	});

	it("refuses to start without its settings", () => {
		assert.throws(() => createRelay({ api: "ftp://x", serviceKey: SERVICE_KEY }));
		assert.throws(() => createRelay({ api: "http://u:p@x", serviceKey: SERVICE_KEY }));
		assert.throws(() => createRelay({ api: "http://x", serviceKey: "" }));
		assert.throws(() => createRelay({ api: "http://x", serviceKey: SERVICE_KEY, hostSuffix: "preview.qorpera.com" }));
	});
});
