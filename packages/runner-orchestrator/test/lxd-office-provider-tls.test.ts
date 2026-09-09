import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "esbuild";
import { expect, it } from "vitest";

it("uses the real provider HTTP adapter over trusted loopback TLS, with bounded lost replies and no redirect replay", async () => {
	const root = await mkdtemp(join(tmpdir(), "office-provider-tls-"));
	const key = join(root, "key.pem"),
		cert = join(root, "cert.pem");
	const seen: string[] = [],
		closed: string[] = [];
	let failure: unknown;
	const server = createServer();
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
			request.on("data", (chunk: Buffer) => chunks.push(chunk));
			request.on("end", () => {
				try {
					const mode = JSON.parse(Buffer.concat(chunks).toString()).mode;
					expect(request.url).toBe("/rest/v1/rpc/qorpera_runtime_office_provider_status");
					expect(request.headers.authorization).toBe(`Bearer ${"synthetic-provider-token-".repeat(3)}`);
					seen.push(mode);
					response.on("close", () => closed.push(mode));
					if (mode === "redirect") {
						response.writeHead(307, { location: "/forbidden" });
						response.flushHeaders();
						return;
					}
					response.writeHead(200, { "content-type": "application/json" });
					if (mode === "cancel" || mode === "timeout") {
						response.flushHeaders();
						return;
					}
					response.end(JSON.stringify(mode === "limit" ? "x".repeat(65537) : { ok: true }));
				} catch (error) {
					failure = error;
					response.writeHead(500).end();
				}
			});
		});
		await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("fixture address");
		const source = resolve(import.meta.dirname, "../src/lxd-office-provider-registry.ts");
		const bundled = join(root, "registry.mjs");
		await build({
			entryPoints: [source],
			outfile: bundled,
			bundle: true,
			platform: "node",
			format: "esm",
			target: "node22",
			logLevel: "silent",
		});
		const main = join(root, "probe.mjs");
		await writeFile(
			main,
			`import { LxdOfficeProviderHttpRegistry } from "./registry.mjs";
const out = [];
for (const mode of ["success", "redirect", "cancel", "limit", "timeout"]) {
 const registry = new LxdOfficeProviderHttpRegistry(${JSON.stringify(`https://127.0.0.1:${address.port}`)}, "synthetic-provider-token-".repeat(3));
 const controller = new AbortController();
 const timer = mode === "cancel" ? setTimeout(() => controller.abort(), 150) : null;
 const start = performance.now();
 try { out.push({ mode, value: await registry.call("qorpera_runtime_office_provider_status", { mode }, controller.signal) }); }
 catch (error) { out.push({ mode, error: error.message, elapsed: performance.now() - start }); }
 finally { if (timer) clearTimeout(timer); }
}
process.stdout.write(JSON.stringify(out));
`,
		);
		const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((done, reject) => {
			const child = spawn(process.execPath, ["--jitless", main], {
				cwd: root,
				env: { PATH: process.env.PATH, NODE_EXTRA_CA_CERTS: cert },
				stdio: ["ignore", "pipe", "pipe"],
			});
			let stdout = "",
				stderr = "";
			child.stdout.on("data", (value) => {
				stdout += value;
			});
			child.stderr.on("data", (value) => {
				stderr += value;
			});
			child.once("error", reject);
			child.once("exit", (code) => done({ code, stdout, stderr }));
		});
		expect(result.code, result.stderr).toBe(0);
		expect(failure).toBeUndefined();
		const results = JSON.parse(result.stdout);
		expect(results[0]).toEqual({ mode: "success", value: { ok: true } });
		for (const entry of results.slice(1)) expect(entry.error).toBe("OFFICE_PROVIDER_RPC_UNCONFIRMED");
		expect(results[4].elapsed).toBeGreaterThanOrEqual(4900);
		expect(results[4].elapsed).toBeLessThan(7000);
		expect(seen).toEqual(["success", "redirect", "cancel", "limit", "timeout"]);
		expect(closed).toEqual(expect.arrayContaining(seen));
	} finally {
		server.closeAllConnections();
		await new Promise<void>((done) => server.close(() => done()));
		await rm(root, { recursive: true, force: true });
	}
}, 15000);
