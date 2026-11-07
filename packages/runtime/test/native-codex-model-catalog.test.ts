import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { AGENT_MODELS } from "@qorpera/cloud-client/company-state-files";
import { POSTGRES_UUID_PATTERN } from "@qorpera/contracts";
import { CLOUD_CODEX_MODEL_CATALOG_MODELS } from "@qorpera/runtime/cloud-codex-model-catalog.generated";
import { CLOUD_CODEX_BOUNDARY_CONFIG } from "@qorpera/runtime/cloud-codex-tool-session";
import { describe, expect, it } from "vitest";

// What the pinned catalog buys, and that it changes nothing else, on the pinned artifact and a loopback provider. The
// provider's bearer comes from a command, as a plan run's does, because that makes Codex fetch the catalog with no login.
const binary = process.env.QORPERA_CODEX_FENCE_BINARY;
const CATALOG = `{"models":[${CLOUD_CODEX_MODEL_CATALOG_MODELS.join(",")}]}`;

interface Provider {
	port: number;
	catalogReads: () => number;
	requests: Record<string, unknown>[];
	close(): void;
}

async function provider(catalogDelayMs: number): Promise<Provider> {
	let catalogReads = 0;
	const requests: Record<string, unknown>[] = [];
	const server = createServer((request, response) => {
		const chunks: Buffer[] = [];
		request.on("data", (chunk: Buffer) => chunks.push(chunk));
		request.on("end", () => {
			if (request.url?.includes("/models")) {
				catalogReads++;
				setTimeout(() => {
					response.writeHead(200, { "content-type": "application/json", etag: '"fixture"' });
					response.end(CATALOG);
				}, catalogDelayMs);
				return;
			}
			const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
			requests.push(body);
			const base = { id: `resp_${requests.length}`, object: "response", model: body.model, created_at: 1 };
			const usage = { input_tokens: 10, output_tokens: 1, total_tokens: 11 };
			const item = {
				type: "message",
				id: "m1",
				role: "assistant",
				status: "completed",
				content: [{ type: "output_text", text: "ok", annotations: [] }],
			};
			const send = (value: Record<string, unknown>) =>
				response.write(`event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`);
			response.writeHead(200, { "content-type": "text/event-stream" });
			send({ type: "response.created", response: { ...base, status: "in_progress", output: [] } });
			send({ type: "response.output_item.done", output_index: 0, item });
			send({ type: "response.completed", response: { ...base, status: "completed", output: [item], usage } });
			response.end();
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	return {
		port: (server.address() as AddressInfo).port,
		catalogReads: () => catalogReads,
		requests,
		close: () => server.close(),
	};
}

/** One app-server: its handshake, a thread and, on request, a turn. Answers how long `thread/start` took. */
async function codex(options: { catalog: boolean; catalogDelayMs: number; model: string; turn?: boolean }) {
	const root = await mkdtemp(join(tmpdir(), "qorpera-model-catalog-"));
	const home = join(root, "codex");
	const workspace = join(root, "workspace");
	await mkdir(home);
	await mkdir(workspace);
	await writeFile(join(root, "token"), "synthetic", { mode: 0o600 });
	const fixture = await provider(options.catalogDelayMs);
	const auth = `auth={command="/bin/cat",args=[${JSON.stringify(join(root, "token"))}],timeout_ms=5000,refresh_interval_ms=60000}`;
	const args = [
		"app-server",
		"--strict-config",
		"--listen",
		"stdio://",
		...CLOUD_CODEX_BOUNDARY_CONFIG.flatMap((config) => ["-c", config]),
		"-c",
		'model_provider="fixture"',
		"-c",
		`model_providers.fixture={name="Fixture",base_url="http://127.0.0.1:${fixture.port}/v1",wire_api="responses",supports_websockets=false,${auth}}`,
	];
	if (options.catalog) {
		const path = join(root, "model-catalog.json");
		await writeFile(path, CATALOG, { mode: 0o400 });
		args.push("-c", `model_catalog_json=${JSON.stringify(path)}`);
	}
	const child: ChildProcessWithoutNullStreams = spawn(binary as string, args, {
		cwd: workspace,
		env: { HOME: root, CODEX_HOME: home, PATH: "/usr/bin:/bin", NO_COLOR: "1" },
		stdio: ["pipe", "pipe", "pipe"],
	});
	let nextId = 0;
	const waiting = new Map<number, (result: Record<string, unknown>) => void>();
	const completed = new Promise<void>((resolve) => {
		createInterface({ input: child.stdout }).on("line", (line) => {
			const message = JSON.parse(line) as { id?: number; method?: string; result?: Record<string, unknown> };
			if (message.method === "turn/completed") resolve();
			if (message.id !== undefined) waiting.get(message.id)?.(message.result ?? {});
		});
	});
	const request = (method: string, params: unknown) =>
		new Promise<Record<string, unknown>>((resolve) => {
			waiting.set(++nextId, resolve);
			child.stdin.write(`${JSON.stringify({ id: nextId, method, params })}\n`);
		});
	try {
		await request("initialize", {
			clientInfo: { name: "qorpera_cloud_boundary", version: "1" },
			capabilities: { experimentalApi: true },
		});
		child.stdin.write(`${JSON.stringify({ method: "initialized", params: {} })}\n`);
		const started = performance.now();
		const thread = await request("thread/start", {
			model: options.model,
			cwd: workspace,
			runtimeWorkspaceRoots: [],
			environments: [],
			ephemeral: true,
			approvalPolicy: "never",
			approvalsReviewer: "user",
			sandbox: "read-only",
			developerInstructions: "Host instructions.",
			dynamicTools: [],
		});
		const threadStartMs = performance.now() - started;
		if (options.turn) {
			await request("turn/start", {
				threadId: (thread.thread as { id: string }).id,
				input: [{ type: "text", text: "Hello.", text_elements: [] }],
				effort: "low",
				environments: [],
				runtimeWorkspaceRoots: [],
				sandboxPolicy: { type: "readOnly", networkAccess: false },
			});
			await completed;
		}
		return { threadStartMs, catalogReads: fixture.catalogReads(), request: fixture.requests[0] };
	} finally {
		child.kill("SIGKILL");
		fixture.close();
		await rm(root, { recursive: true, force: true });
	}
}

/** A provider request with what differs in every run taken out: ids, the temporary root and the order of the metadata. */
function sameInEveryRun(request: Record<string, unknown> | undefined): string {
	const { client_metadata: metadata, prompt_cache_key: _key, ...rest } = request ?? {};
	return JSON.stringify({ ...rest, metadata: Object.keys(metadata as object).sort() })
		.replace(/qorpera-model-catalog-[A-Za-z0-9]{6}/g, "ROOT")
		.replace(/\d{4}-\d{2}-\d{2}T[0-9:.]+Z?/g, "TIME")
		.replace(new RegExp(POSTGRES_UUID_PATTERN.source.slice(1, -1), "g"), "UUID");
}

describe.skipIf(!binary)(
	"the pinned model catalog on the native artifact (requires QORPERA_CODEX_FENCE_BINARY)",
	() => {
		it("thread/start waits for a slow catalog without it, and neither waits nor asks with it", async () => {
			const asking = await codex({ catalog: false, catalogDelayMs: 1_500, model: "gpt-6-astra" });
			expect(asking.threadStartMs).toBeGreaterThan(1_000);
			expect(asking.catalogReads).toBeGreaterThanOrEqual(1);
			const pinned = await codex({ catalog: true, catalogDelayMs: 1_500, model: "gpt-6-astra" });
			expect(pinned.threadStartMs).toBeLessThan(500);
			expect(pinned.catalogReads).toBe(0);
		}, 30_000);

		it.each(AGENT_MODELS)(
			"%s: the first provider request is the same as when the provider served the catalog",
			async (model) => {
				const served = await codex({ catalog: false, catalogDelayMs: 0, model, turn: true });
				const pinned = await codex({ catalog: true, catalogDelayMs: 0, model, turn: true });
				expect(sameInEveryRun(pinned.request)).toBe(sameInEveryRun(served.request));
				expect(pinned.catalogReads).toBe(0);
			},
			30_000,
		);
	},
);
