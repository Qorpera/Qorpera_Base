import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer as createHttpServer, request as httpRequest } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { createServer as createTcpServer } from "node:net";
import { lstat, open, readFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export function platformBootstrapParts(sql) {
	const start = sql.indexOf("create table auth.users (");
	const end = sql.indexOf("create function auth.jwt()", start);
	assert(start > 0 && end > start && sql.indexOf("create table auth.users (", start + 1) === -1, "Platform bootstrap shape changed");
	return [sql.slice(0, start), sql.slice(end).replaceAll("create function auth.", "create or replace function auth.")];
}

export async function listenLoopback(server) {
	await new Promise((done, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", done); });
	const address = server.address();
	assert(address && typeof address !== "string" && address.address === "127.0.0.1", "Loopback listener required");
	return address.port;
}
export async function closeServer(server) {
	server.closeAllConnections?.();
	await new Promise((done, reject) => server.close(error => error ? reject(error) : done()));
}

/** Private SMTP capture: no relay, no external recipient, bounded memory. The
 * actual Auth service generates and verifies the code. Nothing mints a JWT. */
export async function startFoundingMail() {
	const messages = new Map();
	const sockets = new Set();
	const stages = { connections: 0, acceptedRecipients: 0, rejectedRecipients: 0, dataMessages: 0, codesCaptured: 0, templateRequests: 0 };
	const smtp = createTcpServer(socket => {
		stages.connections++;
		sockets.add(socket); socket.on("close", () => sockets.delete(socket));
		socket.setTimeout(10000, () => socket.destroy());
		let buffer = "", recipient = null, data = null;
		socket.write("220 localhost acceptance SMTP\r\n");
		socket.on("data", chunk => {
			buffer += chunk.toString("utf8");
			if (Buffer.byteLength(buffer) + (data?.length ?? 0) > 65536) return socket.destroy();
			while (buffer.includes("\r\n")) {
				const at = buffer.indexOf("\r\n"), line = buffer.slice(0, at); buffer = buffer.slice(at + 2);
				if (data !== null) {
					if (line !== ".") { data += `${line}\n`; continue; }
					const code = data.match(/\b([0-9]{8})\b/)?.[1];
					stages.dataMessages++;
					if (recipient && code) { messages.set(recipient, code); stages.codesCaptured++; }
					data = null; socket.write("250 captured\r\n"); continue;
				}
				if (/^(EHLO|HELO) /i.test(line)) socket.write("250 localhost\r\n");
				else if (/^MAIL FROM:/i.test(line)) socket.write("250 OK\r\n");
				else if (/^RCPT TO:/i.test(line)) {
					recipient = line.match(/^RCPT TO:<([a-z0-9-]+@founding\.example\.test)>$/i)?.[1]?.toLowerCase() ?? null;
					if (recipient) stages.acceptedRecipients++; else stages.rejectedRecipients++;
					socket.write(recipient ? "250 OK\r\n" : "550 local acceptance recipients only\r\n");
				} else if (line === "DATA" && recipient) { data = ""; socket.write("354 End with dot\r\n"); }
				else if (line === "QUIT") socket.end("221 bye\r\n");
				else if (line === "RSET" || line === "NOOP") socket.write("250 OK\r\n");
				else socket.write("500 Unsupported\r\n");
			}
		});
		socket.on("error", () => {});
	});
	const port = await listenLoopback(smtp);
	const template = createHttpServer((_req, res) => {
		stages.templateRequests++;
		res.writeHead(200, { "content-type": "text/html" }); res.end("<p>Your verification code: {{ .Token }}</p>");
	});
	const templatePort = await listenLoopback(template);
	return {
		port, templateUrl: `http://127.0.0.1:${templatePort}/template`,
		diagnostics: () => ({ ...stages }),
		async code(email) {
			const until = Date.now() + 15000;
			while (Date.now() < until) { if (messages.has(email)) return messages.get(email); await delay(100); }
			throw new Error(`Auth verification email was not delivered to private SMTP capture: ${JSON.stringify(stages)}`);
		},
		async close() { for (const socket of sockets) socket.destroy(); await Promise.all([closeServer(smtp), closeServer(template)]); messages.clear(); },
	};
}

export async function startOwnedProcess(executable, args, { cwd, env, logPath }) {
	const log = await open(logPath, "wx", 0o600);
	let child;
	try { child = spawn(executable, args, { cwd, env, stdio: ["ignore", log.fd, log.fd] }); }
	finally { await log.close(); }
	let exited = false, code;
	const closed = new Promise(done => {
		child.once("error", () => { exited = true; code = -1; done(); });
		child.once("close", value => { exited = true; code = value; done(); });
	});
	return {
		get exited() { return exited; },
		async wait() { await closed; assert.equal(code, 0, `Acceptance child ${executable.split("/").at(-1)} failed; private log retained until cleanup`); },
		async close() {
			if (exited) return;
			child.kill("SIGTERM");
			await Promise.race([closed, delay(10000)]);
			if (!exited) { child.kill("SIGKILL"); await Promise.race([closed, delay(3000)]); }
			assert(exited, "Owned acceptance process did not exit");
		},
	};
}

export async function waitHttp(url, process) {
	assert.equal(new URL(url).hostname, "127.0.0.1");
	const until = Date.now() + 30000;
	while (!process.exited && Date.now() < until) {
		try { const result = await fetch(url, { signal: AbortSignal.timeout(1000) }); await result.body?.cancel(); if (result.ok) return; } catch {}
		await delay(100);
	}
	throw new Error("Isolated Auth/REST service failed to become ready");
}

/** HTTPS origins are real client configuration. The proxy forwards tokens
 * unchanged to real Auth/PostgREST; it never interprets or substitutes claims. */
export async function startFoundingGateway({ cert, key, publicKey, webRoot }) {
	const upstream = { auth: null, rest: null };
	const server = createHttpsServer({ cert, key }, async (req, res) => {
		try {
			const url = new URL(req.url, "https://127.0.0.1");
			const kind = url.pathname.startsWith("/auth/v1/") ? "auth" : url.pathname.startsWith("/rest/v1/") ? "rest" : null;
			if (kind) {
				if (req.headers.apikey !== publicKey || !upstream[kind]) { res.writeHead(401); res.end(); return; }
				const headers = { ...req.headers, host: `127.0.0.1:${upstream[kind]}` };
				delete headers.apikey;
				if (headers.authorization === `Bearer ${publicKey}`) delete headers.authorization;
				const outgoing = httpRequest({ hostname: "127.0.0.1", port: upstream[kind], method: req.method,
					path: `${url.pathname.slice(kind === "auth" ? 8 : 8)}${url.search}`, headers }, response => {
					res.writeHead(response.statusCode ?? 502, response.headers); response.pipe(res);
				});
				outgoing.setTimeout(15000, () => outgoing.destroy());
				outgoing.on("error", () => { if (!res.headersSent) res.writeHead(502); res.end(); });
				req.pipe(outgoing); return;
			}
			if (url.pathname.startsWith("/realtime/") || url.pathname.startsWith("/functions/") || url.pathname.startsWith("/storage/")) {
				res.writeHead(503, { "content-type": "application/json" }); res.end('{"message":"Outside founding acceptance boundary"}'); return;
			}
			const path = resolve(webRoot, `.${decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname)}`);
			assert(path.startsWith(`${resolve(webRoot)}${sep}`), "Invalid static path");
			const stat = await lstat(path); assert(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 15000000);
			const type = path.endsWith(".js") ? "text/javascript" : path.endsWith(".css") ? "text/css" : path.endsWith(".html") ? "text/html" : path.endsWith(".svg") ? "image/svg+xml" : path.endsWith(".png") ? "image/png" : "application/octet-stream";
			res.writeHead(200, { "content-type": type, "cache-control": "no-store" }); res.end(await readFile(path));
		} catch { if (!res.headersSent) res.writeHead(404); res.end(); }
	});
	server.on("upgrade", (_req, socket) => socket.destroy());
	const port = await listenLoopback(server);
	return { origin: `https://127.0.0.1:${port}`, upstream, close: () => closeServer(server) };
}
