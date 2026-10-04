import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Request as NodeHttpRequest } from "@whatwg-node/node-fetch";
import { LxdUnixClient } from "../../src/lxd-client.ts";
import { HttpLxdNativeLoginGateway, LxdNativeLoginGateway } from "../../src/lxd-login-gateway.ts";
import { nodeHttpFetch } from "../../src/node-http-fetch.ts";
import { cloudRunnerOrchestratorWakeTopic } from "../../src/orchestrator.ts";
import { RealtimeOrchestratorWake } from "../../src/orchestrator-wake.ts";
import type { CloudRunnerProviderServiceBackend } from "../../src/provider-service.ts";
import { WebCloudRunnerProviderService } from "../../src/provider-web.ts";
import { FakeRealtime } from "../helpers/realtime-fake.ts";

async function main(): Promise<void> {
	const certificate = await readFile(process.argv[2]!, "utf8");
	const gateway = new HttpLxdNativeLoginGateway(
		new LxdNativeLoginGateway(
			{
				adapterId: "lxd",
				supabaseUrl: "https://example.invalid",
				supabaseServiceKey: "synthetic-key",
				supabasePublishableKey: "sb_publishable_synthetic",
				stateRoot: process.argv[3]!,
				project: "qorpera-runners",
				loginProfile: "qorpera-login-v1",
				networkInterface: "enp5s0",
				imageServer: "local",
				imageFingerprint: "a".repeat(64),
				storagePool: "qorpera-vm",
				identityVolumePrefix: "identity-",
				identityVolumeSize: "32GiB",
				rootDiskSize: "80GiB",
				cpuLimit: 4,
				memoryLimit: "8GiB",
				nativeBridgePort: 8083,
				guestTrustedSource: "10.41.0.1",
				identityRecoveryCaCertificate: certificate,
				identityRecoveryCaSha256: createHash("sha256").update(certificate).digest("hex"),
				guestReadyTimeoutMs: 10_000,
				codexPath: "/absent/codex",
				claudePath: "/absent/claude",
			},
			new LxdUnixClient("/absent/lxd.socket"),
			nodeHttpFetch,
		),
		"127.0.0.1",
		0,
	);
	try {
		const port = await gateway.start();
		const health = await nodeHttpFetch(`http://127.0.0.1:${port}/healthz`);
		assert.equal(health.status, 200);
		assert.deepEqual(await health.json(), { ok: true });
		const refused = await nodeHttpFetch(
			new NodeHttpRequest(`http://127.0.0.1:${port}/login`, {
				method: "POST",
				headers: [["content-type", "application/json"]],
				body: "{}",
			}),
		);
		assert.equal(refused.status, 400);
		assert.deepEqual(await refused.json(), { error: "Invalid native login request" });
		const backend: CloudRunnerProviderServiceBackend = {
			adapterId: "jitless",
			async reconcile() {},
			async acquire() {
				throw new Error("No acquisition is authorized by this fixture");
			},
			async deliver() {
				throw new Error("No delivery is authorized by this fixture");
			},
			async stop() {
				throw new Error("No guest shutdown is authorized by this fixture");
			},
		};
		const web = new WebCloudRunnerProviderService(backend, "synthetic-token");
		const response = await web.handle(new NodeHttpRequest("http://localhost/provider"));
		assert.deepEqual(await response.json(), { ok: true });
		const denied = await web.handle(new NodeHttpRequest("http://localhost/provider", { method: "POST", body: "{}" }));
		assert.equal(denied.status, 401);
		assert.deepEqual(await denied.json(), { error: "Unauthorized" });
		// Push wake-ups ride a WebSocket that must not need Node's (Undici, WASM) WebSocket.
		const realtime = new FakeRealtime();
		await realtime.start();
		const topic = cloudRunnerOrchestratorWakeTopic("c".repeat(43));
		const wake = new RealtimeOrchestratorWake({
			supabaseUrl: realtime.url,
			publishableKey: "sb_publishable_synthetic",
			topic: () => topic,
		});
		let wakeUps = 0;
		wake.subscribe(() => wakeUps++);
		wake.start();
		try {
			for (let attempt = 0; attempt < 200 && !wake.listening; attempt++)
				await new Promise((resolve) => setTimeout(resolve, 10));
			assert.equal(wake.listening, true);
			assert.equal(realtime.wake(topic), 1);
			for (let attempt = 0; attempt < 200 && wakeUps < 2; attempt++)
				await new Promise((resolve) => setTimeout(resolve, 10));
			assert.equal(wakeUps, 2);
		} finally {
			wake.stop();
			await realtime.close();
		}
		// Undici's asynchronous WASM initialization can reject after a request completes.
		await new Promise((resolve) => setTimeout(resolve, 100));
		console.log("JITLESS_HTTP_BOUNDARIES_PASSED");
	} finally {
		await gateway.close();
	}
}

void main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
