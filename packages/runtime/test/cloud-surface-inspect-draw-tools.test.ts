import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync, gunzipSync } from "node:zlib";
import type { CloudCodingCommandReceipt, JsonValue, StudioBinaryRef } from "@qorpera/contracts";
import { parseSurfaceLayout, SURFACE_LAYOUT_SCHEMA } from "@qorpera/contracts";
import { describe, expect, it } from "vitest";
import { cloudActionEffect } from "../src/cloud-action-review.ts";
import type { CloudCompanyFolderClient } from "../src/cloud-company-folder-client.ts";
import {
	CloudToolArgumentRefusal,
	type CloudToolContext,
	CloudToolRefusal,
} from "../src/cloud-native-tool-boundary.ts";
import type { CloudNativeToolOperations } from "../src/cloud-native-tool-operations.ts";
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
import { prepareSurfaceCodingWorkspace } from "../src/cloud-surface-coding-tools.ts";
import {
	createInspectSurfaceTool,
	renderStudioPreviewHtml,
	STUDIO_INSPECT_SURFACE_SCHEMA,
} from "../src/cloud-surface-inspect-tool.ts";
import { createComposeSurfaceLayoutTool, STUDIO_COMPOSE_LAYOUT_SCHEMA } from "../src/cloud-surface-layout-tool.ts";
import {
	createStageSurfacePatchTool,
	createSurfacePatchSessionTracker,
	type SurfacePatchToolPort,
} from "../src/cloud-surface-tools.ts";

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

function makeShellMachine(
	cwd: string,
	env: NodeJS.ProcessEnv = process.env,
	recordedCommands?: string[],
): StudioChatGptVoiceMachine {
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
				const cmdBytes = Buffer.byteLength(request.command, "utf8");
				if (cmdBytes > 16_384) {
					throw new Error(`Command exceeded 16384-byte coding gateway limit (${cmdBytes} bytes)`);
				}
				recordedCommands?.push(request.command);
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

function writeFakeChromium(dir: string, scrollHeight = 2200): string {
	const fakeChrome = join(dir, "fake-chromium.mjs");
	writeFileSync(
		fakeChrome,
		[
			"#!/usr/bin/env node",
			'import http from "node:http";',
			'import { createHash } from "node:crypto";',
			`const PNG_B64 = ${JSON.stringify(VALID_PNG.toString("base64"))};`,
			`const SCROLL_H = ${scrollHeight};`,
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
			'      else if (msg.method === "Runtime.evaluate") sendFrame({ id: msg.id, result: { result: { value: SCROLL_H } } });',
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
	return fakeChrome;
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

	it("compose_surface_layout keeps the layout's colours on every compose and changes them only with set_colors", async () => {
		let staged = "";
		let current: string | null = null;
		const tool = createComposeSurfaceLayoutTool({
			sessionId: "44444444-4444-4444-8444-444444444444",
			starter: "analytics",
			readCurrentLayoutText: async () => current,
			surfacePatch: {
				async stageSurfacePatch(_sessionId, req) {
					const op = req.ops[0];
					if (op?.op === "write_text") staged = op.content;
					return { changeId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", seq: 1, openChangeCount: 1 };
				},
			},
		});
		const compose = async (operations: JsonValue[]) => {
			await tool.execute({ operations }, CONTEXT);
			current = staged;
			return parseSurfaceLayout(JSON.parse(staged));
		};
		expect((await compose([{ op: "rename_tab", tabId: "now", title: "Today" }])).colors).toEqual({
			preset: "company",
		});
		expect((await compose([{ op: "set_colors", colors: { preset: "bright", down: "#b5543c" } }])).colors).toEqual({
			preset: "bright",
			down: "#b5543c",
		});
		expect((await compose([{ op: "remove_tab", tabId: "visitors" }])).colors).toEqual({
			preset: "bright",
			down: "#b5543c",
		});
		expect(await compose([{ op: "set_colors", colors: null }])).not.toHaveProperty("colors");
		await expect(
			tool.execute({ operations: [{ op: "set_colors", colors: { preset: "loud" } }] }, CONTEXT),
		).rejects.toThrow("operations[0].colors.preset must be one of company, one-colour, calm, bright");
		expect(tool.description).toContain("set_colors {op,colors} replaces them");
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

	it("compose_surface_layout refuses with LAYOUT_READ_FAILED when reading layout.json fails and never overwrites with starter", async () => {
		let stagedCalls = 0;
		const tool = createComposeSurfaceLayoutTool({
			sessionId: "44444444-4444-4444-8444-444444444444",
			starter: "strategy",
			readCurrentLayoutText: async () => {
				throw new Error("folder service temporarily unavailable");
			},
			surfacePatch: {
				async stageSurfacePatch() {
					stagedCalls += 1;
					return { changeId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", seq: 1, openChangeCount: 1 };
				},
			},
		});
		await expect(
			tool.execute({ operations: [{ op: "rename_tab", tabId: "plan", title: "Plan" }] }, CONTEXT),
		).rejects.toThrow("LAYOUT_READ_FAILED");
		expect(stagedCalls).toBe(0);
	});

	it("shares follow-up change targeting and staged layout state across compose_surface_layout, stage_surface_artifact, and stage_surface_patch", async () => {
		const dir = mkdtempSync(join(tmpdir(), "qorpera-tracker-test-"));
		try {
			writeFileSync(join(dir, "hero.png"), VALID_PNG);
			const changeA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
			const changeB = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2";
			const calls: { readonly changeId?: string | null; readonly ops: readonly unknown[] }[] = [];
			const surfacePatch: SurfacePatchToolPort = {
				async stageSurfacePatch(_sid, req) {
					calls.push({ changeId: req.changeId ?? null, ops: req.ops });
					return {
						changeId: req.changeId ?? "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
						seq: calls.length,
						openChangeCount: 2,
						updated: Boolean(req.changeId),
					};
				},
			};
			const openChanges = [
				{
					changeId: changeA,
					seq: 1,
					status: "open",
					title: "First change",
					summary: "First",
					kind: "folder_patch",
					actionKind: null,
					parentSha: null,
					headSha: null,
					affectedPaths: ["layout.json"],
					previewBaseChangeIds: [],
					patchManifest: null,
					baseFiles: null,
				},
				{
					changeId: changeB,
					seq: 2,
					status: "open",
					title: "Second change",
					summary: "Second",
					kind: "folder_patch",
					actionKind: null,
					parentSha: null,
					headSha: null,
					affectedPaths: ["charts/arr.json"],
					previewBaseChangeIds: [],
					patchManifest: null,
					baseFiles: null,
				},
			];

			const ambiguousTracker = createSurfacePatchSessionTracker({
				openChanges,
				replyChangeId: null,
				folderRoot: "surfaces/strategy",
			});
			const ambiguousCompose = createComposeSurfaceLayoutTool({
				sessionId: "44444444-4444-4444-8444-444444444444",
				starter: "custom",
				readCurrentLayoutText: async () => null,
				surfacePatch,
				patchTracker: ambiguousTracker,
			});
			const ambiguousArtifact = createStageSurfaceArtifactTool({
				sessionId: "44444444-4444-4444-8444-444444444444",
				folderRoot: "surfaces/strategy",
				machine: makeShellMachine(dir),
				stageBytes: async (bytes, mediaType) => {
					const sha = createHash("sha256").update(bytes).digest("hex");
					return { manifestSha256: sha, fileSha256: sha, bytes: bytes.byteLength, mediaType };
				},
				surfacePatch,
				patchTracker: ambiguousTracker,
				pollMs: 10,
			});
			expect(() =>
				ambiguousCompose.parseArguments({ operations: [{ op: "rename_tab", tabId: "overview", title: "Home" }] }),
			).toThrow(CloudToolArgumentRefusal);
			expect(() =>
				ambiguousArtifact.parseArguments({ sourcePath: "hero.png", destPath: "visuals/hero.png" }),
			).toThrow(CloudToolArgumentRefusal);

			const replyTracker = createSurfacePatchSessionTracker({
				openChanges,
				replyChangeId: changeA,
				folderRoot: "surfaces/strategy",
			});
			const composeTool = createComposeSurfaceLayoutTool({
				sessionId: "44444444-4444-4444-8444-444444444444",
				starter: "custom",
				readCurrentLayoutText: async () => null,
				surfacePatch,
				patchTracker: replyTracker,
			});
			const artifactTool = createStageSurfaceArtifactTool({
				sessionId: "44444444-4444-4444-8444-444444444444",
				folderRoot: "surfaces/strategy",
				machine: makeShellMachine(dir),
				stageBytes: async (bytes, mediaType) => {
					const sha = createHash("sha256").update(bytes).digest("hex");
					return { manifestSha256: sha, fileSha256: sha, bytes: bytes.byteLength, mediaType };
				},
				surfacePatch,
				patchTracker: replyTracker,
				pollMs: 10,
			});
			const patchTool = createStageSurfacePatchTool(
				"44444444-4444-4444-8444-444444444444",
				surfacePatch,
				{
					folderRoot: "surfaces/strategy",
					waitingOps: [],
					readLayout: async () => null,
				},
				{ openChanges, replyChangeId: changeA, deferSessionCompletion: true, tracker: replyTracker },
			);

			await composeTool.execute(
				{
					operations: [
						{
							op: "add_tab",
							tab: {
								id: "metrics",
								title: "Metrics",
								blocks: [{ type: "artifacts", heading: "Visuals" }],
							},
						},
					],
				},
				CONTEXT,
			);
			expect(calls[0]?.changeId).toBe(changeA);

			await artifactTool.execute({ sourcePath: "hero.png", destPath: "visuals/hero.png", createNew: true }, CONTEXT);
			expect(calls[1]?.changeId).toBeNull();

			const parsedPatch = patchTool.parseArguments({
				title: "Merge layout",
				summary: "Merge extra metadata into layout",
				changeId: changeA,
				ops: [{ op: "merge_json", path: "layout.json", patch: { schema: SURFACE_LAYOUT_SCHEMA } }],
			});
			await expect(patchTool.prepare?.(parsedPatch, CONTEXT)).resolves.toBeDefined();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("inspect_surface renders Studio preview HTML, bounds commands under 16KB even with 2MB PNGs, and reports scroll pagination", async () => {
		const dir = mkdtempSync(join(tmpdir(), "qorpera-inspect-test-"));
		try {
			const fakeChrome = writeFakeChromium(dir, 2200);
			const hugePng = Buffer.alloc(2 * 1024 * 1024, 0x42);
			VALID_PNG.copy(hugePng, 0);

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
									{
										type: "brand_mark",
										from: "visuals/base-mark.png",
										grounds: ["light"],
										heading: "Base mark",
									},
									{ type: "module", id: "sim", from: "modules/sim", heading: "Interactive sim" },
									{ type: "artifacts", heading: "Visuals" },
								],
							},
						],
					}),
					"surfaces/strategy/charts/mrr.json": JSON.stringify({
						kind: "bar",
						title: "MRR",
						unit: "$",
						yAxisMin: 0,
						yAxisMax: 40000,
						categories: ["Q1", "Q2"],
						series: [
							{
								name: "Actual",
								color: "#2b6cb0",
								data: [12000, { value: 24000, color: "#0f7a55" }],
								markLine: [{ value: 30000, label: "Goal" }],
							},
						],
					}),
					"surfaces/strategy/visuals/logo.svg": '<svg><script>alert(1)</script><circle r="5"/></svg>',
					"surfaces/strategy/visuals/large-graph.svg": `<svg xmlns="http://www.w3.org/2000/svg">${"<path d='M0 0 L10 10'/>".repeat(15_000)}</svg>`,
					"surfaces/strategy/modules/sim/index.html": `<!doctype html><html><body>${"<div data-x='1'>row</div>".repeat(2_000)}</body></html>`,
				},
				binaries: {
					"surfaces/strategy/visuals/hero.png": { bytes: VALID_PNG, mediaType: "image/png" },
					"surfaces/strategy/visuals/huge.png": { bytes: hugePng, mediaType: "image/png" },
				},
				knownBinaries: {
					"surfaces/strategy/visuals/base-mark.png": {
						bytes: 4096,
						mediaType: "image/png",
						inCompanyMount: true,
					},
				},
			};

			const rendered = renderStudioPreviewHtml({ snapshot, theme: "dark" });
			expect(rendered.html).toContain('data-theme="dark"');
			expect(rendered.html).toContain("<svg viewBox=");
			expect(rendered.html).toContain('fill="#2b6cb0"');
			expect(rendered.html).toContain('fill="#0f7a55"');
			expect(rendered.html).toContain("$40.0k");
			expect(rendered.html).toContain("Goal · $30.0k");
			expect(rendered.html).not.toContain("<script>");
			expect(rendered.html).toContain("/company-asset/visuals/base-mark.png");
			expect(rendered.html).toContain("2048 KB");
			expect(rendered.html).toContain("SVG · ");
			expect(rendered.html).toContain("HTML MODULE · ");
			expect(rendered.html).not.toContain("srcdoc=");
			expect(Buffer.byteLength(rendered.html, "utf8")).toBeLessThan(256_000);
			expect(rendered.warnings).toEqual([]);
			expect(rendered.renderedBlocks.find((b) => b.type === "chart")?.filled).toBe(true);
			expect(rendered.renderedBlocks.find((b) => b.type === "brand_mark")?.filled).toBe(true);
			expect(rendered.renderedBlocks.find((b) => b.type === "module")?.filled).toBe(true);

			const commands: string[] = [];
			const tool = createInspectSurfaceTool({
				machine: makeShellMachine(dir, { ...process.env, QORPERA_INSPECT_CHROMIUM: fakeChrome }, commands),
				loadSnapshot: async () => snapshot,
				pollMs: 10,
			});

			const firstShot = await tool.execute({ tab: "plan", theme: "dark", viewport: "desktop" }, CONTEXT);
			expect(firstShot.kind).toBe("json");
			if (firstShot.kind === "json") {
				const value = firstShot.value as Record<string, JsonValue>;
				expect(value.schema).toBe(STUDIO_INSPECT_SURFACE_SCHEMA);
				expect(value.kind).toBe("surface_screenshot");
				expect(value.tab).toBe("plan");
				expect(value.theme).toBe("dark");
				expect(value.fullPage).toBe(false);
				expect(value.scrollY).toBe(0);
				expect(value.scrollHeight).toBe(2200);
				expect(value.hasMoreBelow).toBe(true);
				expect(firstShot.image?.sha256).toBe(value.imageSha256);
				expect(firstShot.image?.png.byteLength).toBeGreaterThan(0);
			}
			expect(commands.length).toBeLessThanOrEqual(6);

			const scrolledShot = await tool.execute({ tab: "plan", viewport: "desktop", scrollY: 1400 }, CONTEXT);
			expect(scrolledShot.kind).toBe("json");
			if (scrolledShot.kind === "json") {
				const value = scrolledShot.value as Record<string, JsonValue>;
				expect(value.scrollY).toBe(1400);
				expect(value.hasMoreBelow).toBe(false);
			}

			const fullShot = await tool.execute({ tab: "plan", viewport: "desktop", fullPage: true }, CONTEXT);
			expect(fullShot.kind).toBe("json");
			if (fullShot.kind === "json") {
				const value = fullShot.value as Record<string, JsonValue>;
				expect(value.fullPage).toBe(true);
				expect(value.scrollY).toBe(0);
			}

			await expect(tool.execute({ tab: "missing" }, CONTEXT)).rejects.toBeInstanceOf(CloudToolArgumentRefusal);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("prepareSurfaceCodingWorkspace merges Base, Preview overlay, and staged binaries while skipping option-group binaries and clearing text overwrites", async () => {
		const dir = mkdtempSync(join(tmpdir(), "qorpera-prep-surface-"));
		try {
			const fakeChrome = writeFakeChromium(dir, 900);
			writeFileSync(join(dir, "fresh.png"), VALID_PNG);
			writeFileSync(join(dir, "alt.png"), VALID_PNG);

			const baseMarkRef: StudioBinaryRef = {
				manifestSha256: "1".repeat(64),
				fileSha256: "2".repeat(64),
				bytes: 2048,
				mediaType: "image/png",
			};
			const baseFiles = new Map<string, string>([
				[
					"surfaces/strategy/layout.json",
					JSON.stringify({
						schema: SURFACE_LAYOUT_SCHEMA,
						tabs: [
							{
								id: "plan",
								title: "Plan",
								blocks: [
									{ type: "brand_mark", from: "visuals/base-mark.png", grounds: ["light"], heading: "Mark" },
									{ type: "artifacts", heading: "Visuals" },
								],
							},
						],
					}),
				],
			]);
			let failLayoutRead = false;
			const folder = {
				async list(parent: string | null) {
					if (parent === "surfaces/strategy") {
						return {
							entries: [
								{
									path: "surfaces/strategy/layout.json",
									kind: "file",
									file: { bytes: baseFiles.get("surfaces/strategy/layout.json")!.length },
								},
								{ path: "surfaces/strategy/visuals", kind: "folder", file: null },
							],
						};
					}
					if (parent === "surfaces/strategy/visuals") {
						return {
							entries: [
								{
									path: "surfaces/strategy/visuals/base-mark.png",
									kind: "file",
									file: baseMarkRef,
								},
							],
						};
					}
					return { entries: [] };
				},
				async readRange(entry: { readonly path: string }) {
					const text = baseFiles.get(entry.path);
					if (text !== undefined) return Buffer.from(text, "utf8");
					return VALID_PNG;
				},
				async readText(path: string) {
					if (failLayoutRead && path === "surfaces/strategy/layout.json") {
						throw new Error("rpc timeout");
					}
					const text = baseFiles.get(path);
					return text === undefined ? null : { text };
				},
			} as unknown as CloudCompanyFolderClient;

			const recordedCommands: string[] = [];
			const machine = makeShellMachine(
				dir,
				{ ...process.env, QORPERA_INSPECT_CHROMIUM: fakeChrome },
				recordedCommands,
			);
			const prepared = await prepareSurfaceCodingWorkspace({
				workspaceKind: "surface_folder",
				surfaceSession: {
					sessionId: "44444444-4444-4444-8444-444444444444",
					surfaceSlug: "strategy",
					surfaceTitle: "Strategy",
					surfaceKind: "strategy",
					briefMarkdown: null,
					folderRoot: "surfaces/strategy",
					sourceKind: "folder",
					stageBytes: async (bytes, mediaType) => {
						const sha = createHash("sha256").update(bytes).digest("hex");
						return { manifestSha256: sha, fileSha256: sha, bytes: bytes.byteLength, mediaType };
					},
					stageSurfacePatch: async () => ({
						changeId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
						seq: 1,
						openChangeCount: 1,
					}),
				},
				folder,
				isClaudeTurn: false,
				newDisk: false,
				signal: CONTEXT.signal,
			});

			const tools = prepared.buildTools(
				machine.identity,
				machine.operations as unknown as CloudNativeToolOperations,
				machine,
			);
			const byName = new Map(tools.map((t) => [t.name, t]));
			const stageArtifact = byName.get("stage_surface_artifact")!;
			const stagePatch = byName.get("stage_surface_patch")!;
			const composeLayout = byName.get("compose_surface_layout")!;
			const inspectSurface = byName.get("inspect_surface")!;

			await stageArtifact.execute(
				{ sourcePath: "alt.png", destPath: "visuals/option-only.png", optionGroup: "hero-dir" },
				CONTEXT,
			);
			await stageArtifact.execute({ sourcePath: "fresh.png", destPath: "visuals/fresh.png" }, CONTEXT);

			const parsedOverwrite = stagePatch.parseArguments({
				title: "Replace with SVG",
				summary: "Overwrite path with text",
				ops: [{ op: "write_text", path: "visuals/fresh.png", content: "replaced" }],
			});
			await stagePatch.prepare?.(parsedOverwrite, CONTEXT);
			await stagePatch.execute(parsedOverwrite, CONTEXT);

			recordedCommands.length = 0;
			const shot = await inspectSurface.execute({ tab: "plan" }, CONTEXT);
			expect(shot.kind).toBe("json");
			if (shot.kind === "json") {
				const val = shot.value as Record<string, JsonValue>;
				expect(val.warnings).toEqual([]);
			}
			const gzChunks = recordedCommands
				.filter((cmd) => cmd.includes("index.html.gz.b64"))
				.map((cmd) => {
					const m = cmd.match(/printf '%s' '([^']+)' >> /);
					return m?.[1] ?? "";
				})
				.join("");
			const renderedHtml = gunzipSync(Buffer.from(gzChunks, "base64")).toString("utf8");
			expect(renderedHtml).toContain("/company-asset/visuals/base-mark.png");
			expect(renderedHtml).not.toContain("option-only.png");
			expect(renderedHtml).not.toContain("data:image/png;base64,");

			failLayoutRead = true;
			await expect(
				composeLayout.execute({ operations: [{ op: "rename_tab", tabId: "plan", title: "Renamed" }] }, CONTEXT),
			).rejects.toThrow("LAYOUT_READ_FAILED");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
