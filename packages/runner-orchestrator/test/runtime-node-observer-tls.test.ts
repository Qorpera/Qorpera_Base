import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "esbuild";
import { expect, it } from "vitest";

it("publishes through actual jitless TLS with bounded bodies, cancellation and no redirect/retry", async () => {
	const root = await mkdtemp(join(tmpdir(), "node-observer-tls-")),
		key = join(root, "key.pem"),
		cert = join(root, "cert.pem");
	const server = createServer(),
		seen: string[] = [],
		closed: string[] = [];
	let failure: unknown;
	try {
		const generated = spawnSync(
			"openssl",
			[
				"req",
				"-x509",
				"-newkey",
				"rsa:2048",
				"-nodes",
				"-keyout",
				key,
				"-out",
				cert,
				"-days",
				"1",
				"-subj",
				"/CN=127.0.0.1",
				"-addext",
				"subjectAltName=IP:127.0.0.1",
			],
			{ encoding: "utf8", timeout: 10000 },
		);
		expect(generated.status).toBe(0);
		server.setSecureContext({ key: await readFile(key), cert: await readFile(cert) });
		server.on("request", (request, response) => {
			const chunks: Buffer[] = [];
			request.on("data", (b: Buffer) => chunks.push(b));
			request.on("end", () => {
				try {
					const mode = JSON.parse(Buffer.concat(chunks).toString()).mode;
					seen.push(mode);
					response.on("close", () => closed.push(mode));
					expect(request.url).toBe("/rest/v1/rpc/qorpera_observe_runtime_node_inventory");
					expect(request.headers.authorization).toBe(`Bearer ${"fixture-observer-credential-".repeat(3)}`);
					if (mode === "redirect") {
						response.writeHead(307, { location: "/forbidden" });
						response.flushHeaders();
						return;
					}
					if (mode === "denied") {
						response.writeHead(403);
						response.end("PRIVATE");
						return;
					}
					response.writeHead(200, { "content-type": "application/json" });
					if (mode === "cancel") {
						response.flushHeaders();
						return;
					}
					response.end(
						mode === "bad-json"
							? "PRIVATE"
							: JSON.stringify(mode === "limit" ? "x".repeat(4194305) : { ok: true }),
					);
				} catch (error) {
					failure = error;
					response.writeHead(500).end();
				}
			});
		});
		await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
		const address = server.address();
		if (!address || typeof address === "string") throw new Error();
		await build({
			entryPoints: [resolve(import.meta.dirname, "../src/runtime-node-observer-service.ts")],
			outfile: join(root, "registry.cjs"),
			bundle: true,
			platform: "node",
			format: "cjs",
			target: "node22",
			logLevel: "silent",
		});
		await writeFile(
			join(root, "probe.cjs"),
			`const assert=require('node:assert/strict'); const {RuntimeNodeObserverHttpRegistry}=require('./registry.cjs');
(async()=>{const out=[];for(const mode of ['success','redirect','denied','bad-json','limit','cancel']){
const r=new RuntimeNodeObserverHttpRegistry(${JSON.stringify(`https://127.0.0.1:${address.port}`)},'fixture-observer-credential-'.repeat(3));
try{out.push({mode,value:await r.call('qorpera_observe_runtime_node_inventory',{mode},AbortSignal.timeout(1000))});}catch(e){out.push({mode,error:e.message});}}
const r=new RuntimeNodeObserverHttpRegistry(${JSON.stringify(`https://127.0.0.1:${address.port}`)},'fixture-observer-credential-'.repeat(3));
await assert.rejects(r.call('qorpera_enroll_runtime_node_inventory',{},new AbortController().signal),/UNAVAILABLE/);
await assert.rejects(r.call('qorpera_observe_runtime_node_inventory',{mode:'x'.repeat(4194305)},new AbortController().signal),/UNCONFIRMED/);
await assert.rejects(r.call('qorpera_observe_runtime_node_inventory',{},AbortSignal.abort()),/UNCONFIRMED/);
process.stdout.write(JSON.stringify(out));})().catch(()=>process.exit(1));`,
		);
		const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((done, reject) => {
			const child = spawn(
				process.execPath,
				["--jitless", "--disable-proto=throw", "--disallow-code-generation-from-strings", join(root, "probe.cjs")],
				{
					cwd: root,
					env: { PATH: process.env.PATH, NODE_EXTRA_CA_CERTS: cert },
					stdio: ["ignore", "pipe", "pipe"],
				},
			);
			let stdout = "",
				stderr = "";
			child.stdout.on("data", (v) => {
				stdout += v;
			});
			child.stderr.on("data", (v) => {
				stderr += v;
			});
			child.once("error", reject);
			child.once("exit", (code) => done({ code, stdout, stderr }));
		});
		expect(result.code, result.stderr).toBe(0);
		expect(failure).toBeUndefined();
		const out = JSON.parse(result.stdout);
		expect(out[0]).toEqual({ mode: "success", value: { ok: true } });
		for (const entry of out.slice(1)) expect(entry.error).toBe("NODE_OBSERVER_RPC_UNCONFIRMED");
		expect(seen).toEqual(["success", "redirect", "denied", "bad-json", "limit", "cancel"]);
		expect(closed).toEqual(expect.arrayContaining(seen));
	} finally {
		server.closeAllConnections();
		await new Promise<void>((done) => server.close(() => done()));
		await rm(root, { recursive: true, force: true });
	}
}, 15000);
