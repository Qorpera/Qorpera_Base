import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { build } from "esbuild";

const repository = resolve(import.meta.dirname, "..");
const flags = ["--jitless", "--disable-proto=throw", "--disallow-code-generation-from-strings"];
const cleanEnvironment = { PATH: process.env.PATH, TMPDIR: tmpdir() };

async function listen(server) {
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	return server.address().port;
}

async function stop(server) {
	server.closeAllConnections();
	await new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
}

function child(file, environment, poison) {
	const processChild = spawn(process.execPath, [...flags, "--require", poison, file], {
		cwd: tmpdir(), env: { ...cleanEnvironment, ...environment }, stdio: ["ignore", "pipe", "pipe"],
	});
	let output = "";
	processChild.stdout.on("data", (chunk) => { output += chunk; });
	processChild.stderr.on("data", (chunk) => { output += chunk; });
	const finished = once(processChild, "close");
	return { process: processChild, finished, output: () => output };
}

async function until(predicate, message) {
	const deadline = Date.now() + 10_000;
	while (!(await predicate())) {
		assert(Date.now() < deadline, message);
		await delay(25);
	}
}

async function terminate(running) {
	running.process.kill("SIGTERM");
	const timeout = setTimeout(() => running.process.kill("SIGKILL"), 5000);
	try { assert.deepEqual(await running.finished, [0, null], running.output()); }
	finally { clearTimeout(timeout); }
	assert.doesNotMatch(running.output(), /WebAssembly|Undici|forbidden global|ReferenceError/);
}

for (const forbidGlobalFetch of [false, true]) test(`jitless packaged services serve and poll (global Fetch guard: ${forbidGlobalFetch})`, { timeout: 45_000 }, async () => {
	const root = await realpath(await mkdtemp(join(tmpdir(), "qorpera-jitless-services-")));
	const processes = [];
	let authority;
	try {
		const poison = join(root, "no-global-fetch.cjs");
		// Reconfiguring a lazy Node 22 global loads its value. Delete first so this
		// test guard itself cannot initialize Undici before the service starts.
		await writeFile(poison, forbidGlobalFetch ? 'for (const name of ["fetch", "Headers", "Request", "Response"]) { delete globalThis[name]; Object.defineProperty(globalThis, name, { get() { throw new Error("forbidden global " + name); } }); }\n' : "");
		for (const service of ["lxd-provider", "runner-orchestrator"]) {
			const result = spawnSync(process.execPath, [`scripts/package-${service}.mjs`, "--out", join(root, service)], {
				cwd: repository, encoding: "utf8", env: process.env, timeout: 15_000,
			});
			assert.equal(result.status, 0, result.stderr);
			const invalid = spawnSync(process.execPath, [...flags, "--require", poison, join(root, service, `qorpera-${service}.mjs`)], {
				cwd: tmpdir(), encoding: "utf8", env: cleanEnvironment, timeout: 5000,
			});
			assert.equal(invalid.status, 1, invalid.stderr);
			assert.match(invalid.stderr, /QORPERA_.* is required/);
			assert.doesNotMatch(invalid.stderr, /WebAssembly|forbidden global|ReferenceError/);
		}
		const reservation = createServer();
		const providerPort = await listen(reservation);
		await stop(reservation);
		const base = `http://127.0.0.1:${providerPort}`;
		const provider = child(join(root, "lxd-provider/qorpera-lxd-provider.mjs"), {
			QORPERA_RUNNER_PROVIDER_PORT: String(providerPort), QORPERA_RUNNER_PROVIDER_TOKEN: "synthetic-provider-token",
			QORPERA_RUNNER_PROVIDER_ADAPTER: "process", QORPERA_RUNNER_PROVIDER_BACKEND: "process",
			QORPERA_NATIVE_PROVIDER_EXECUTION_BOUNDARY: "virtual_machine", QORPERA_SUPABASE_URL: "https://example.invalid",
			QORPERA_SUPABASE_SERVICE_KEY: "synthetic-service-key", QORPERA_SUPABASE_PUBLISHABLE_KEY: "synthetic-publishable",
			QORPERA_EPHEMERAL_RUNNER_MODULE: "/absent/runner", QORPERA_NATIVE_PROVIDER_MODULE: "/absent/native",
			QORPERA_RUNNER_PROVIDER_STATE_ROOT: join(root, "provider-state"), QORPERA_RUNNER_PROVIDER_TEMPORARY_ROOT: join(root, "provider-tmp"),
			QORPERA_EPHEMERAL_RUNNER_IMAGE: `registry.invalid/qorpera@sha256:${"a".repeat(64)}`,
			QORPERA_EPHEMERAL_RUNNER_PODMAN: "/absent/podman", QORPERA_EPHEMERAL_RUNNER_ENTRYPOINT: "/absent/entrypoint",
			QORPERA_NATIVE_PROVIDER_MASTER_KEY_FILE: "/absent/key",
		}, poison);
		processes.push(provider);
		await until(async () => {
			assert.equal(provider.process.exitCode, null, provider.output());
			try { return (await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(500) })).ok; } catch { return false; }
		}, "provider did not become ready");
		const denied = await fetch(`${base}/v1/qorpera-runner-provider`, { method: "POST", body: "{}" });
		assert.equal(denied.status, 401);
		const actions = [];
		authority = createServer(async (request, response) => {
			let encoded = "";
			for await (const chunk of request) encoded += chunk;
			const body = JSON.parse(encoded);
			assert.equal(request.url, "/functions/v1/runner-orchestrator");
			assert.equal(request.headers.apikey, "synthetic-publishable");
			assert.match(request.headers.authorization, /^Bearer [A-Za-z0-9_-]{43}$/);
			actions.push(body.action);
			assert(["rotate_control", "routine_heads", "folder_dynamic_routines", "folder_drain_due", "folder_materialize_due",
				"reconcile", "retained", "claim"].includes(body.action));
			const value = ["routine_heads", "folder_dynamic_routines", "folder_drain_due", "folder_materialize_due"].includes(body.action)
				? { items: [], has_more: false } : body.action === "retained" ? [] : null;
			response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ value }));
		});
		const authorityPort = await listen(authority);
		const orchestrator = child(join(root, "runner-orchestrator/qorpera-runner-orchestrator.mjs"), {
			QORPERA_SUPABASE_URL: `http://127.0.0.1:${authorityPort}`, QORPERA_SUPABASE_PUBLISHABLE_KEY: "synthetic-publishable",
			QORPERA_RUNNER_ORCHESTRATOR_ID: "11111111-1111-4111-8111-111111111111",
			QORPERA_RUNNER_ORCHESTRATOR_CONTROL_TOKEN: "c".repeat(43),
			QORPERA_RUNNER_ORCHESTRATOR_CONTROL_STATE: join(root, "orchestrator-control.json"),
			QORPERA_RUNNER_PROVIDER_URL: base, QORPERA_RUNNER_PROVIDER_ADAPTER: "process",
			QORPERA_RUNNER_PROVIDER_TOKEN: "synthetic-provider-token", QORPERA_RUNNER_ORCHESTRATOR_POLL_MS: "50",
		}, poison);
		processes.push(orchestrator);
		await until(() => {
			assert.equal(orchestrator.process.exitCode, null, orchestrator.output());
			return actions.filter((action) => action === "claim").length >= 2;
		}, "orchestrator did not complete two polling cycles");
		assert(actions.includes("rotate_control") && actions.includes("retained") && actions.includes("reconcile"));
		await terminate(orchestrator);
		await terminate(provider);
		const state = JSON.parse(await readFile(join(root, "orchestrator-control.json"), "utf8"));
		assert(!JSON.stringify(state).includes("c".repeat(43)), "control token was not rotated");
		const fixture = join(root, "jitless-http.cjs");
		await build({ entryPoints: [join(repository, "packages/runner-orchestrator/test/fixtures/jitless-http.ts")], outfile: fixture,
			bundle: true, platform: "node", format: "cjs", target: "node22.19", logLevel: "silent" });
		const boundaries = spawnSync(process.execPath, [...flags, "--require", poison, fixture,
			join(repository, "deploy/cloud-secret-broker/supabase-prod-ca-2021.crt"), join(root, "login-state")], {
			cwd: tmpdir(), env: cleanEnvironment, encoding: "utf8", timeout: 10_000,
		});
		assert.equal(boundaries.status, 0, boundaries.stderr);
		assert.match(boundaries.stdout, /JITLESS_HTTP_BOUNDARIES_PASSED/);
	} finally {
		for (const running of processes) {
			if (running.process.exitCode === null && running.process.signalCode === null) running.process.kill("SIGKILL");
			await running.finished;
		}
		if (authority) await stop(authority);
		await rm(root, { recursive: true, force: true });
	}
});
