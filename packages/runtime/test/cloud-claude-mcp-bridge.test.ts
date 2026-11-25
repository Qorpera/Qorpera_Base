import { createHash } from "node:crypto";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLOUD_CLAUDE_MCP_SERVER_NAME, CloudClaudeMcpBridge } from "@qorpera/runtime/cloud-claude-mcp-bridge";
import {
	type CloudNativeTool,
	CloudNativeToolBoundary,
	CloudToolArgumentRefusal,
} from "@qorpera/runtime/cloud-native-tool-boundary";
import { afterEach, describe, expect, it } from "vitest";

const TINY_PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
	"base64",
);
const TINY_PNG_SHA = createHash("sha256").update(TINY_PNG).digest("hex");

const tempDirs: string[] = [];

afterEach(async () => {
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop();
		if (dir) await rm(dir, { recursive: true, force: true });
	}
});

async function rpcExchange(socketPath: string, lines: readonly string[], expectResponses: number): Promise<unknown[]> {
	return await new Promise((resolve, reject) => {
		const socket = connect(socketPath);
		const responses: unknown[] = [];
		let buf = "";
		socket.on("error", reject);
		socket.on("connect", () => {
			for (const line of lines) socket.write(`${line}\n`);
		});
		socket.setEncoding("utf8");
		socket.on("data", (chunk: string) => {
			buf += chunk;
			let idx = buf.indexOf("\n");
			while (idx >= 0) {
				const raw = buf.slice(0, idx);
				buf = buf.slice(idx + 1);
				if (raw) responses.push(JSON.parse(raw));
				if (responses.length >= expectResponses) {
					socket.destroy();
					resolve(responses);
					return;
				}
				idx = buf.indexOf("\n");
			}
		});
		socket.once("close", () => {
			if (responses.length < expectResponses)
				reject(new Error(`closed early (${responses.length}/${expectResponses})`));
		});
	});
}

describe("CloudClaudeMcpBridge", () => {
	it("serves initialize, tools/list, tools/call (text, image, and refusal) over a private Unix socket", async () => {
		const dir = await mkdtemp(join(tmpdir(), "qorpera-mcp-"));
		tempDirs.push(dir);
		const controller = new AbortController();
		const tools: CloudNativeTool[] = [
			{
				name: "coding_finish",
				description: "Finish the coding turn.",
				source: "worker",
				inputSchema: {
					type: "object",
					properties: { summary: { type: "string" } },
					required: ["summary"],
					additionalProperties: false,
				},
				parseArguments(value) {
					if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid");
					const summary = (value as Record<string, unknown>).summary;
					if (typeof summary !== "string" || !summary.trim())
						throw new CloudToolArgumentRefusal("summary is required");
					return { summary };
				},
				async execute(value) {
					return {
						kind: "text",
						value: JSON.stringify({ ok: true, summary: (value as { summary: string }).summary }),
					};
				},
			},
			{
				name: "coding_view_attachment",
				description: "Inspect an uploaded image.",
				source: "worker",
				images: true,
				inputSchema: { type: "object", properties: {}, additionalProperties: false },
				parseArguments() {
					return {};
				},
				async execute() {
					return {
						kind: "json",
						value: { shown: true, imageSha256: TINY_PNG_SHA },
						image: { png: TINY_PNG, sha256: TINY_PNG_SHA },
					};
				},
			},
		];
		const boundary = new CloudNativeToolBoundary({
			companyId: "00000000-0000-4000-8000-000000000001",
			runId: "00000000-0000-4000-8000-000000000002",
			tools,
			assertActive: async () => {},
			signal: controller.signal,
		});
		const bridge = new CloudClaudeMcpBridge({ boundary, signal: controller.signal });
		await bridge.listen(dir);
		try {
			expect(bridge.declaredMcpToolNames).toEqual([
				`mcp__${CLOUD_CLAUDE_MCP_SERVER_NAME}__coding_finish`,
				`mcp__${CLOUD_CLAUDE_MCP_SERVER_NAME}__coding_view_attachment`,
			]);
			const socketStat = await stat(bridge.socketPath);
			expect(socketStat.mode & 0o777).toBe(0o600);

			const replies = (await rpcExchange(
				bridge.socketPath,
				[
					JSON.stringify({
						jsonrpc: "2.0",
						id: 1,
						method: "initialize",
						params: { protocolVersion: "2025-03-26" },
					}),
					JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
					JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
					JSON.stringify({
						jsonrpc: "2.0",
						id: 3,
						method: "tools/call",
						params: { name: "coding_finish", arguments: { summary: "Built feature" } },
					}),
					JSON.stringify({
						jsonrpc: "2.0",
						id: 4,
						method: "tools/call",
						params: { name: "coding_view_attachment", arguments: {} },
					}),
					JSON.stringify({
						jsonrpc: "2.0",
						id: 5,
						method: "tools/call",
						params: { name: "coding_finish", arguments: { summary: "" } },
					}),
					JSON.stringify({ jsonrpc: "2.0", id: 6, method: "unknown/method" }),
					JSON.stringify({
						jsonrpc: "2.0",
						id: 7,
						method: "initialize",
						params: { protocolVersion: "2099-01-01" },
					}),
					"{not-json",
				],
				8,
			)) as Array<{ id: unknown; result?: Record<string, unknown>; error?: { code: number; message: string } }>;

			expect(replies[0]).toMatchObject({
				id: 1,
				result: { protocolVersion: "2025-03-26", capabilities: { tools: {} } },
			});
			expect((replies[1]?.result?.tools as Array<{ name: string }>).map((t) => t.name)).toEqual([
				"coding_finish",
				"coding_view_attachment",
			]);
			expect(replies[2]?.result?.isError).toBe(false);
			const finishContent = replies[2]?.result?.content as Array<{ type: string; text?: string }>;
			expect(finishContent[0]?.type).toBe("text");
			expect(finishContent[0]?.text).toContain("Built feature");

			expect(replies[3]?.result?.isError).toBe(false);
			const imageContent = replies[3]?.result?.content as Array<{
				type: string;
				text?: string;
				mimeType?: string;
				data?: string;
			}>;
			expect(imageContent).toHaveLength(2);
			expect(imageContent[1]).toEqual({
				type: "image",
				mimeType: "image/png",
				data: TINY_PNG.toString("base64"),
			});

			expect(replies[4]?.result?.isError).toBe(true);
			const refusedContent = replies[4]?.result?.content as Array<{ type: string; text?: string }>;
			expect(refusedContent[0]?.text).toContain("summary is required");

			expect(replies[5]?.error).toMatchObject({ code: -32601 });
			expect(replies[6]).toMatchObject({
				id: 7,
				result: { protocolVersion: "2024-11-05" },
			});
			expect(replies[7]?.error).toMatchObject({ code: -32700 });
		} finally {
			const socketPath = bridge.socketPath;
			await bridge.close();
			boundary.close();
			await expect(stat(socketPath)).rejects.toThrow();
		}
	});
});
