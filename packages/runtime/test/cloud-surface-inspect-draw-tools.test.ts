import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import type { CloudCodingCommandReceipt, JsonValue, StudioBinaryRef } from "@qorpera/contracts";
import { parseSurfaceLayout, SURFACE_LAYOUT_SCHEMA } from "@qorpera/contracts";
import { describe, expect, it, vi } from "vitest";
import { cloudActionEffect } from "../src/cloud-action-review.ts";
import {
	CloudToolArgumentRefusal,
	type CloudToolContext,
	CloudToolRefusal,
} from "../src/cloud-native-tool-boundary.ts";
import { CLOUD_RUNTIME_TOOL_OPERATIONS } from "../src/cloud-runtime-observability.ts";
import type { StudioChatGptVoiceMachine } from "../src/cloud-studio-voice-recorder.ts";
import {
	createStageSurfaceArtifactTool,
	decodeArtifactOutput,
	normalizeArtifactDestPath,
	normalizeArtifactSourcePath,
	STUDIO_STAGE_ARTIFACT_SCHEMA,
	validateArtifactBytes,
} from "../src/cloud-surface-artifact-tool.ts";
import {
	createInspectSurfaceTool,
	renderStudioPreviewHtml,
	STUDIO_INSPECT_SURFACE_SCHEMA,
} from "../src/cloud-surface-inspect-tool.ts";
import { createComposeSurfaceLayoutTool, STUDIO_COMPOSE_LAYOUT_SCHEMA } from "../src/cloud-surface-layout-tool.ts";
import type { SurfacePatchToolPort } from "../src/cloud-surface-tools.ts";

function crc32(data: Buffer): number {
	let crc = 0xffffffff;
	for (const byte of data) {
		crc ^= byte;
		for (let i = 0; i < 8; i += 1) {
			crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
		}
	}
	return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, body: Buffer): Buffer {
	const head = Buffer.alloc(8);
	head.writeUInt32BE(body.byteLength, 0);
	head.write(type, 4, "ascii");
	const tail = Buffer.alloc(4);
	tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0);
	return Buffer.concat([head, body, tail]);
}

function makeValidPng(): Buffer {
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(2, 0);
	ihdr.writeUInt32BE(2, 4);
	ihdr[8] = 8;
	ihdr[9] = 6;
	const raw = Buffer.alloc((1 + 2 * 4) * 2, 0xff);
	raw[0] = 0;
	raw[9] = 0;
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		pngChunk("IHDR", ihdr),
		pngChunk("IDAT", deflateSync(raw)),
		pngChunk("IEND", Buffer.alloc(0)),
	]);
}

const VALID_PNG = makeValidPng();

const CONTEXT: CloudToolContext = {
	companyId: "11111111-1111-4111-8111-111111111111",
	runId: "22222222-2222-4222-8222-222222222222",
	callId: "call-1",
	argumentSha256: "0".repeat(64),
	signal: new AbortController().signal,
};

function makeReceipt(commandId: string, inputSha256: string, output: string, exitCode = 0): CloudCodingCommandReceipt {
	const buf = Buffer.from(output, "utf8");
	const head = buf.subarray(0, 65536).toString("utf8");
	const headBytes = Buffer.byteLength(head, "utf8");
	return {
		schema: "qorpera.coding-command-result/v2",
		workerId: "33333333-3333-4333-8333-333333333333",
		commandId,
		inputSha256,
		state: exitCode === 0 ? "succeeded" : "failed",
		exitCode,
		output: head,
		log: {
			offset: 0,
			nextOffset: headBytes,
			totalBytes: buf.byteLength,
			limitBytes: 16 * 1024 * 1024,
			limitReached: false,
		},
		truncated: headBytes < buf.byteLength,
	};
}

function makeShellMachine(cwd: string, env: NodeJS.ProcessEnv = process.env): StudioChatGptVoiceMachine {
	let seq = 0;
	const receipts = new Map<string, CloudCodingCommandReceipt>();
	const rawOutputs = new Map<string, string>();
	const identity: StudioChatGptVoiceMachine["identity"] = {
		companyId: CONTEXT.companyId,
		environmentId: "11111111-1111-4111-8111-111111111112",
		runId: CONTEXT.runId,
		jobId: "55555555-5555-4555-8555-555555555555",
		runnerId: "66666666-6666-4666-8666-666666666666",
		assignmentId: "77777777-7777-4777-8777-777777777777",
		leaseId: "88888888-8888-4888-8888-888888888888",
		computeIdentityId: "99999999-9999-4999-8999-999999999999",
		staffAgentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
		staffVersion: 1,
		sessionId: null,
		requesterUserId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2",
		sponsorUserId: null,
		sponsorBindingId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3",
		sponsorVersion: 1,
		providerConnectionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4",
		providerConnectionVersion: 1,
		audienceKind: "company",
		audienceUserId: null,
		runtimeBundleId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa5",
		runtimeBundleSha256: "a".repeat(64),
		reasoningEffort: "medium",
		reasoningPolicySha256: "b".repeat(64),
		provider: "openai",
		nativeHarness: "codex-cli",
		model: "gpt-6.1-sol",
	};
	return {
		scope: {
			workerId: "33333333-3333-4333-8333-333333333333",
			vmId: "44444444-4444-4444-8444-444444444444",
			requestId: "44444444-4444-4444-8444-444444444445",
			turn: 1,
		},
		identity,
		operations: {
			async execute(req) {
				const id = `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;
				const sha = createHash("sha256").update(JSON.stringify(req.operation.arguments)).digest("hex");
				const result = await req.perform(req.operation, {
					identity,
					receiptId: id,
					inputSha256: sha,
					idempotencyKey: req.operation.logicalOperationKey,
					signal: req.signal,
				});
				return result.content;
			},
		},
		gateway: {
			async authorize() {
				return undefined;
			},
			async start(_scope, request) {
				let stdout = "";
				let exitCode = 0;
				try {
					stdout = execFileSync("/bin/sh", ["-c", request.command], {
						cwd,
						env,
						encoding: "utf8",
						maxBuffer: 20 * 1024 * 1024,
					});
				} catch (error) {
					const err = error as { status?: number; stdout?: string };
					exitCode = typeof err.status === "number" ? err.status : 1;
					stdout = typeof err.stdout === "string" ? err.stdout : "";
				}
				const receipt = makeReceipt(request.commandId, request.inputSha256, stdout, exitCode);
				receipts.set(request.commandId, receipt);
				rawOutputs.set(request.commandId, stdout);
				return receipt;
			},
			async read(_scope, request) {
				const full = receipts.get(request.commandId)!;
				const fullOut = rawOutputs.get(request.commandId) ?? full.output;
				const buf = Buffer.from(fullOut, "utf8");
				const offset = request.offset ?? 0;
				const limit = request.limit ?? 65536;
				const slice = buf.subarray(offset, offset + limit).toString("utf8");
				const nextOffset = offset + Buffer.byteLength(slice, "utf8");
				return {
					...full,
					output: slice,
					log: {
						offset,
						nextOffset,
						totalBytes: buf.byteLength,
						limitBytes: 16 * 1024 * 1024,
						limitReached: false,
					},
					truncated: nextOffset < buf.byteLength,
				};
			},
			async cancel(_scope, commandId) {
				return receipts.get(commandId) ?? makeReceipt(commandId, "0".repeat(64), "", 1);
			},
		},
	};
}

describe("Studio visual inspect & draw tools", () => {
	it("registers inspect_surface, stage_surface_artifact, and compose_surface_layout in observability and action review", () => {
		expect(CLOUD_RUNTIME_TOOL_OPERATIONS).toContain("inspect_surface");
		expect(CLOUD_RUNTIME_TOOL_OPERATIONS).toContain("stage_surface_artifact");
		expect(CLOUD_RUNTIME_TOOL_OPERATIONS).toContain("compose_surface_layout");
		expect(cloudActionEffect({ name: "inspect_surface", source: "runtime" }, {})).toBe("read");
		expect(cloudActionEffect({ name: "stage_surface_artifact", source: "runtime" }, {})).toBe("internal");
		expect(cloudActionEffect({ name: "compose_surface_layout", source: "runtime" }, {})).toBe("internal");
	});

	it("compose_surface_layout applies tab and block mutations, validates strictly, and stages layout.json", async () => {
		let stagedLayout = "";
		const surfacePatch: SurfacePatchToolPort = {
			async stageSurfacePatch(_sessionId, req) {
				const op = req.ops[0];
				if (op?.op === "write_text") stagedLayout = op.content;
				return { changeId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", seq: 1, openChangeCount: 1 };
			},
		};
		const tool = createComposeSurfaceLayoutTool({
			sessionId: "44444444-4444-4444-8444-444444444444",
			starter: "custom",
			readCurrentLayoutText: async () => null,
			surfacePatch,
		});
		const result = await tool.execute(
			{
				title: "Add KPI charts tab",
				summary: "Added Metrics tab with ARR bar chart and moved it first.",
				operations: [
					{ op: "add_tab", tab: { id: "metrics", title: "Metrics", blocks: [] } },
					{
						op: "add_block",
						tabId: "metrics",
						block: { type: "chart", id: "arr", from: "charts/arr.json", heading: "ARR" },
					},
					{ op: "rename_tab", tabId: "overview", title: "Home" },
					{ op: "reorder_tabs", tabIds: ["metrics", "overview", "reports"] },
				],
			},
			CONTEXT,
		);
		expect(result.kind).toBe("text");
		const payload = JSON.parse(result.kind === "text" ? result.value : "{}") as Record<string, JsonValue>;
		expect(payload.schema).toBe(STUDIO_COMPOSE_LAYOUT_SCHEMA);
		expect(payload.ok).toBe(true);
		const parsed = parseSurfaceLayout(JSON.parse(stagedLayout));
		expect(parsed.tabs.map((t) => `${t.id}:${t.title}`)).toEqual([
			"metrics:Metrics",
			"overview:Home",
			"reports:Reports",
		]);
		expect(parsed.tabs[0]?.blocks[0]).toEqual({
			type: "chart",
			id: "arr",
			from: "charts/arr.json",
			heading: "ARR",
		});

		await expect(
			tool.execute(
				{ operations: [{ op: "add_block", tabId: "overview", block: { type: "nonexistent" } }] },
				CONTEXT,
			),
		).rejects.toBeInstanceOf(CloudToolArgumentRefusal);
	});

	it("stage_surface_artifact validates paths, reads PNG from coding machine, stages binary, and returns inline image", async () => {
		const dir = mkdtempSync(join(tmpdir(), "qorpera-art-test-"));
		try {
			const pngRel = "chart.png";
			writeFileSync(join(dir, pngRel), VALID_PNG);
			const svgRel = "diagram.svg";
			writeFileSync(
				join(dir, svgRel),
				'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>',
			);
			symlinkSync("/etc/hosts", join(dir, "escape.png"));

			expect(() => normalizeArtifactSourcePath("/etc/passwd")).toThrow(CloudToolArgumentRefusal);
			expect(() => normalizeArtifactDestPath("layout.json", "surfaces/strategy", "image/png")).toThrow(
				CloudToolArgumentRefusal,
			);
			expect(normalizeArtifactSourcePath("/tmp/foo.png")).toEqual({ sourcePath: "/tmp/foo.png", ext: ".png" });
			expect(validateArtifactBytes(VALID_PNG, ".png")).toBeNull();
			expect(validateArtifactBytes(Buffer.from("not-a-png"), ".png")).toBeTruthy();
			expect(decodeArtifactOutput("garbage")).toBeNull();

			const stagedRefs: StudioBinaryRef[] = [];
			const stagedOps: unknown[] = [];
			const onStagedBinary = vi.fn();
			const tool = createStageSurfaceArtifactTool({
				sessionId: "44444444-4444-4444-8444-444444444444",
				folderRoot: "surfaces/strategy",
				machine: makeShellMachine(dir),
				stageBytes: async (bytes, mediaType) => {
					const sha = createHash("sha256").update(bytes).digest("hex");
					const ref: StudioBinaryRef = {
						manifestSha256: sha,
						fileSha256: sha,
						bytes: bytes.byteLength,
						mediaType,
					};
					stagedRefs.push(ref);
					return ref;
				},
				surfacePatch: {
					async stageSurfacePatch(_sid, req) {
						stagedOps.push(...req.ops);
						return {
							changeId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
							seq: stagedOps.length,
							openChangeCount: 1,
						};
					},
				},
				onStagedBinary,
				pollMs: 10,
			});

			const pngRes = await tool.execute({ sourcePath: pngRel, destPath: "visuals/chart.png" }, CONTEXT);
			expect(pngRes.kind).toBe("json");
			if (pngRes.kind === "json") {
				const value = pngRes.value as Record<string, JsonValue>;
				expect(value.schema).toBe(STUDIO_STAGE_ARTIFACT_SCHEMA);
				expect(value.kind).toBe("artifact_image");
				expect(value.path).toBe("visuals/chart.png");
				expect(pngRes.image?.sha256).toBe(value.imageSha256);
				expect(pngRes.image?.png.byteLength).toBeGreaterThan(0);
			}
			expect(stagedRefs).toHaveLength(1);
			expect(onStagedBinary).toHaveBeenCalledTimes(1);

			const svgRes = await tool.execute({ sourcePath: svgRel, destPath: "visuals/diagram.svg" }, CONTEXT);
			expect(svgRes.kind).toBe("text");
			expect(
				stagedOps.some(
					(op) =>
						(op as { op?: string; path?: string }).op === "write_text" &&
						(op as { path?: string }).path === "visuals/diagram.svg",
				),
			).toBe(true);

			await expect(
				tool.execute({ sourcePath: "escape.png", destPath: "visuals/escape.png" }, CONTEXT),
			).rejects.toBeInstanceOf(CloudToolRefusal);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("inspect_surface renders Studio preview HTML and captures PNG inline via CDP protocol", async () => {
		const dir = mkdtempSync(join(tmpdir(), "qorpera-inspect-test-"));
		try {
			const fakeChrome = join(dir, "fake-chromium.mjs");
			writeFileSync(
				fakeChrome,
				[
					"#!/usr/bin/env node",
					'import http from "node:http";',
					'import { createHash } from "node:crypto";',
					`const PNG_B64 = ${JSON.stringify(VALID_PNG.toString("base64"))};`,
					"const server = http.createServer((req, res) => {",
					'  if (req.url === "/json/list") {',
					"    const port = server.address().port;",
					'    res.writeHead(200, { "Content-Type": "application/json" });',
					'    res.end(JSON.stringify([{ type: "page", webSocketDebuggerUrl: "ws://127.0.0.1:" + port + "/devtools/page/1" }]));',
					"    return;",
					"  }",
					"  res.writeHead(404); res.end();",
					"});",
					'server.on("upgrade", (req, socket) => {',
					'  const key = req.headers["sec-websocket-key"];',
					'  const accept = createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");',
					'  socket.write("HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\nSec-WebSocket-Accept: " + accept + "\\r\\n\\r\\n");',
					"  let buf = Buffer.alloc(0);",
					"  const sendFrame = (obj) => {",
					'    const payload = Buffer.from(JSON.stringify(obj), "utf8");',
					"    const header = payload.length < 126 ? Buffer.from([0x81, payload.length]) : Buffer.from([0x81, 126, payload.length >> 8, payload.length & 255]);",
					"    socket.write(Buffer.concat([header, payload]));",
					"  };",
					'  socket.on("data", (chunk) => {',
					"    buf = Buffer.concat([buf, chunk]);",
					"    while (buf.length >= 2) {",
					"      let len = buf[1] & 127, offset = 2;",
					"      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); offset = 4; }",
					"      const masked = (buf[1] & 128) !== 0;",
					"      if (buf.length < offset + (masked ? 4 : 0) + len) return;",
					"      let payload = buf.subarray(offset + (masked ? 4 : 0), offset + (masked ? 4 : 0) + len);",
					"      if (masked) { const mask = buf.subarray(offset, offset + 4); payload = Buffer.from(payload.map((b, i) => b ^ mask[i & 3])); }",
					"      buf = buf.subarray(offset + (masked ? 4 : 0) + len);",
					"      if ((chunk[0] & 0x0f) === 8) { socket.end(); return; }",
					'      const msg = JSON.parse(payload.toString("utf8"));',
					'      if (msg.method === "Page.navigate") { sendFrame({ id: msg.id, result: {} }); sendFrame({ method: "Page.loadEventFired", params: {} }); }',
					'      else if (msg.method === "Runtime.evaluate") sendFrame({ id: msg.id, result: { result: { value: 920 } } });',
					'      else if (msg.method === "Page.captureScreenshot") sendFrame({ id: msg.id, result: { data: PNG_B64 } });',
					"      else sendFrame({ id: msg.id, result: {} });",
					"    }",
					"  });",
					"});",
					'server.listen(0, "127.0.0.1", () => {',
					'  process.stderr.write("DevTools listening on ws://127.0.0.1:" + server.address().port + "/devtools/browser/1\\n");',
					"});",
					"setTimeout(() => process.exit(0), 15000);",
				].join("\n"),
				{ mode: 0o755 },
			);

			const snapshot = {
				surfaceTitle: "Strategy",
				folderRoot: "surfaces/strategy",
				starter: "strategy" as const,
				files: {
					"surfaces/strategy/layout.json": JSON.stringify({
						schema: SURFACE_LAYOUT_SCHEMA,
						tabs: [
							{
								id: "plan",
								title: "Grand plan",
								blocks: [
									{ type: "chart", id: "mrr", from: "charts/mrr.json", heading: "MRR" },
									{ type: "artifacts", heading: "Visuals" },
								],
							},
						],
					}),
					"surfaces/strategy/charts/mrr.json": JSON.stringify({
						kind: "bar",
						title: "MRR",
						unit: "$",
						categories: ["Q1", "Q2"],
						series: [{ name: "Actual", data: [12000, 24000] }],
					}),
					"surfaces/strategy/visuals/logo.svg": '<svg><script>alert(1)</script><circle r="5"/></svg>',
				},
				binaries: {
					"surfaces/strategy/visuals/hero.png": { bytes: VALID_PNG, mediaType: "image/png" },
				},
			};

			const rendered = renderStudioPreviewHtml({ snapshot, theme: "dark" });
			expect(rendered.html).toContain('data-theme="dark"');
			expect(rendered.html).toContain("<svg viewBox=");
			expect(rendered.html).not.toContain("<script>");
			expect(rendered.renderedBlocks.find((b) => b.type === "chart")?.filled).toBe(true);

			const tool = createInspectSurfaceTool({
				machine: makeShellMachine(dir, { ...process.env, QORPERA_INSPECT_CHROMIUM: fakeChrome }),
				loadSnapshot: async () => snapshot,
				pollMs: 10,
			});

			const shot = await tool.execute({ tab: "plan", theme: "dark", viewport: "desktop", fullPage: true }, CONTEXT);
			expect(shot.kind).toBe("json");
			if (shot.kind === "json") {
				const value = shot.value as Record<string, JsonValue>;
				expect(value.schema).toBe(STUDIO_INSPECT_SURFACE_SCHEMA);
				expect(value.kind).toBe("surface_screenshot");
				expect(value.tab).toBe("plan");
				expect(value.theme).toBe("dark");
				expect(shot.image?.sha256).toBe(value.imageSha256);
				expect(shot.image?.png.byteLength).toBeGreaterThan(0);
			}

			await expect(tool.execute({ tab: "missing" }, CONTEXT)).rejects.toBeInstanceOf(CloudToolArgumentRefusal);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
