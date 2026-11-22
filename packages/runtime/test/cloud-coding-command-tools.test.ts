import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { JsonValue } from "@qorpera/contracts";
import { JpegChroma, JpegEncoder } from "image-in-browser/lib/src/formats/jpeg-encoder.js";
import { PngDecoder } from "image-in-browser/lib/src/formats/png-decoder.js";
import { WebPEncoder } from "image-in-browser/lib/src/formats/webp-encoder.js";
import { MemoryImage } from "image-in-browser/lib/src/image/image.js";
import { describe, expect, it, vi } from "vitest";
import { authorizeCodingCommand } from "../../../deploy/coding-worker/command-authority.ts";
import {
	type CloudCodingCommandGateway,
	cloudCodingCommandTools,
	parseCloudCodingCommandReceipt,
} from "../src/cloud-coding-command-tools.ts";
import { CODING_INSPECT_IMAGE_SCHEMA, MAX_CODING_INSPECT_IMAGE_BYTES } from "../src/cloud-coding-image-inspect.ts";
import { CLOUD_COMMAND_PAGE_ASK } from "../src/cloud-command-page-fit.ts";
import { CloudNativeToolRun } from "../src/cloud-native-tool-authority.ts";
import { CloudNativeToolBoundary } from "../src/cloud-native-tool-boundary.ts";
import {
	type CloudNativeToolOperationControlPlane,
	CloudNativeToolOperations,
} from "../src/cloud-native-tool-operations.ts";
import { nativeToolAuthorityFixture } from "./fixtures/native-tool-authority-fixture.ts";
import { pngChunk, pngFile, pngHeader, pngRows } from "./fixtures/png-fixture.ts";

const execFileAsync = promisify(execFile);

function fixture() {
	const { authority } = nativeToolAuthorityFixture();
	const identity = authority.identity;
	const scope = { workerId: randomUUID(), vmId: randomUUID(), requestId: randomUUID(), turn: 1 };
	const commandId = randomUUID();
	const receipt = {
		schema: "qorpera.coding-command-result/v2",
		workerId: scope.workerId,
		commandId,
		inputSha256: "a".repeat(64),
		state: "running",
		exitCode: null,
		output: "",
		truncated: false,
		log: { offset: 0, nextOffset: 0, totalBytes: 0, limitBytes: 67108864, limitReached: false },
	};
	const gateway = {
		authorize: vi.fn<CloudCodingCommandGateway["authorize"]>().mockResolvedValue(undefined),
		start: vi.fn<CloudCodingCommandGateway["start"]>().mockResolvedValue(receipt),
		read: vi.fn<CloudCodingCommandGateway["read"]>().mockResolvedValue(receipt),
		cancel: vi.fn<CloudCodingCommandGateway["cancel"]>().mockResolvedValue({ ...receipt, state: "cancelled" }),
	};
	const execute = vi.fn<CloudNativeToolOperations["execute"]>(async (options) => {
		await options.authorize(options.operation, identity, options.signal);
		return (
			await options.perform(options.operation, {
				identity,
				receiptId: commandId,
				inputSha256: receipt.inputSha256,
				idempotencyKey: "b".repeat(64),
				signal: options.signal,
			})
		).content;
	});
	const tools = cloudCodingCommandTools({ scope, identity, gateway, operations: { execute } });
	const boundary = new CloudNativeToolBoundary({
		companyId: identity.companyId,
		runId: identity.runId,
		identity,
		tools,
		assertActive: async () => undefined,
		signal: new AbortController().signal,
	});
	return { identity, scope, commandId, receipt, gateway, execute, tools, boundary };
}

describe("isolated coding command tools", () => {
	it("starts through a durable operation receipt and returns a fenced running handle", async () => {
		const f = fixture();
		try {
			const args = { operationKey: "test", command: "npm run check", timeoutMs: 600000 };
			const result = await f.boundary.invoke("start", "qorpera", "coding_run_command", args);
			expect(result.success).toBe(true);
			expect(f.gateway.start).toHaveBeenCalledWith(
				f.scope,
				{
					commandId: f.commandId,
					inputSha256: f.receipt.inputSha256,
					command: args.command,
					timeoutMs: args.timeoutMs,
				},
				expect.any(AbortSignal),
			);
			expect(f.execute.mock.calls[0][0].operation.target).toEqual({
				schema: "qorpera.coding-command-target/v1",
				...f.scope,
			});
			const envelope = JSON.parse(result.contentItems[0].text);
			expect(envelope.trust).toBe("untrusted_data");
			expect(JSON.parse(envelope.content.text).state).toBe("running");
			await f.boundary.invoke("start", "qorpera", "coding_run_command", args);
			expect(f.gateway.start).toHaveBeenCalledTimes(1);
		} finally {
			f.boundary.close();
		}
	});
	it("starts a command without a deadline when none is given, and has no maximum", async () => {
		const f = fixture();
		try {
			const args = { operationKey: "serve", command: "npm run dev" };
			expect((await f.boundary.invoke("serve", "qorpera", "coding_run_command", args)).success).toBe(true);
			expect(f.gateway.start).toHaveBeenCalledWith(
				f.scope,
				{ commandId: f.commandId, inputSha256: f.receipt.inputSha256, command: args.command, timeoutMs: null },
				expect.any(AbortSignal),
			);
			expect(f.execute.mock.calls[0][0].operation.arguments).toEqual(args);
			const long = { operationKey: "soak", command: "npm run soak", timeoutMs: 6 * 60 * 60 * 1000 };
			expect((await f.boundary.invoke("soak", "qorpera", "coding_run_command", long)).success).toBe(true);
			expect(
				(
					await f.boundary.invoke("short", "qorpera", "coding_run_command", {
						operationKey: "short",
						command: "true",
						timeoutMs: 999,
					})
				).success,
			).toBe(false);
		} finally {
			f.boundary.close();
		}
	});
	it.each(["vmId", "workerId", "cwd", "env", "credential", "commandId"])("refuses model-selected %s", async (key) => {
		const f = fixture();
		try {
			expect(
				(
					await f.boundary.invoke("bad", "qorpera", "coding_run_command", {
						operationKey: "one",
						command: "true",
						timeoutMs: 1000,
						[key]: "override",
					})
				).success,
			).toBe(false);
			expect(f.gateway.start).not.toHaveBeenCalled();
		} finally {
			f.boundary.close();
		}
	});
	it("refuses work before the guest when the current request is revoked", async () => {
		const f = fixture();
		f.gateway.authorize.mockRejectedValue(new Error("revoked"));
		try {
			expect(
				(
					await f.boundary.invoke("denied", "qorpera", "coding_run_command", {
						operationKey: "one",
						command: "true",
						timeoutMs: 1000,
					})
				).success,
			).toBe(false);
			expect(f.execute).not.toHaveBeenCalled();
		} finally {
			f.boundary.close();
		}
	});
	it("does not release a command result after authority changes", async () => {
		const f = fixture();
		f.gateway.authorize.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("revoked"));
		try {
			expect(
				(await f.boundary.invoke("read", "qorpera", "coding_read_command", { commandId: f.commandId })).success,
			).toBe(false);
			expect(f.gateway.read).toHaveBeenCalledTimes(1);
		} finally {
			f.boundary.close();
		}
	});
	/** A log of `totalBytes` whose page at `offset` the gateway answers with as many bytes as the read asks for. */
	const paged = (
		f: ReturnType<typeof fixture>,
		text: (bytes: number) => string,
		totalBytes: number,
		state = "succeeded",
	) =>
		f.gateway.read.mockImplementation(async (_scope, input) => {
			const offset = input.offset ?? 0;
			const output = text(offset + (input.limit ?? 4096)).slice(text(offset).length);
			const nextOffset = offset + Buffer.byteLength(output);
			return {
				...f.receipt,
				state,
				exitCode: state === "succeeded" ? 0 : state === "failed" ? 1 : null,
				output,
				truncated: nextOffset < totalBytes,
				log: { offset, nextOffset, totalBytes, limitBytes: 67108864, limitReached: false },
			};
		});
	/** The first `bytes` of a build log: plain lines. */
	const lines = (bytes: number) => {
		let text = "";
		for (let n = 0; text.length < bytes; n++)
			text += `[${String(n).padStart(5, "0")}] PASS test/case-${n}.test.ts (12 ms)\n`;
		return text.slice(0, bytes);
	};
	const shown = (result: unknown) => {
		const envelope = JSON.parse((result as { contentItems: { text: string }[] }).contentItems[0].text);
		return { envelope, page: JSON.parse(envelope.content.text) };
	};
	it("shows as much of a long log as one result holds, in one read (keyholes S1)", async () => {
		const f = fixture();
		paged(f, (bytes) => lines(Math.min(bytes, 60_000)), 60_000);
		try {
			const result = await f.boundary.invoke("page", "qorpera", "coding_read_command", { commandId: f.commandId });
			expect(result.success).toBe(true);
			expect(f.gateway.read).toHaveBeenCalledTimes(1);
			expect(f.gateway.read).toHaveBeenCalledWith(
				f.scope,
				{ commandId: f.commandId, offset: 0, limit: CLOUD_COMMAND_PAGE_ASK },
				expect.any(AbortSignal),
			);
			const { envelope, page } = shown(result);
			// The fence did not cut it: the cut is the tool's, at the page's own cursor.
			expect(envelope.content.truncated).toBe(false);
			expect(Buffer.byteLength(page.output)).toBeGreaterThan(28_000);
			expect(lines(60_000).startsWith(page.output)).toBe(true);
			expect(page.log.nextOffset).toBe(Buffer.byteLength(page.output));
			expect(page.truncated).toBe(true);
			// The next page goes on where this one ends.
			const next = shown(
				await f.boundary.invoke("next", "qorpera", "coding_read_command", {
					commandId: f.commandId,
					offset: page.log.nextOffset,
				}),
			).page;
			expect(page.output + next.output).toBe(lines(page.log.nextOffset + Buffer.byteLength(next.output)));
			// A tail shows the log's end, its offset where the shown part begins.
			f.gateway.read.mockImplementationOnce(async () => ({
				...f.receipt,
				state: "succeeded",
				exitCode: 0,
				output: lines(60_000).slice(60_000 - CLOUD_COMMAND_PAGE_ASK),
				truncated: false,
				log: {
					offset: 60_000 - CLOUD_COMMAND_PAGE_ASK,
					nextOffset: 60_000,
					totalBytes: 60_000,
					limitBytes: 67108864,
					limitReached: false,
				},
			}));
			const tail = shown(
				await f.boundary.invoke("tail", "qorpera", "coding_read_command", { commandId: f.commandId, tail: true }),
			).page;
			expect(lines(60_000).endsWith(tail.output)).toBe(true);
			expect(tail.log.offset).toBe(60_000 - Buffer.byteLength(tail.output));
			expect(Buffer.byteLength(tail.output)).toBeGreaterThan(28_000);
		} finally {
			f.boundary.close();
		}
	});
	it("cuts an escaped page to fit at a complete JSON cursor, without asking again", async () => {
		const f = fixture();
		paged(f, (bytes) => "<".repeat(Math.min(bytes, 16000)), 16000);
		try {
			const result = await f.boundary.invoke("page", "qorpera", "coding_read_command", {
				commandId: f.commandId,
				limit: 16384,
			});
			expect(result.success).toBe(true);
			const { envelope, page } = shown(result);
			expect(envelope.content.truncated).toBe(false);
			expect(page.log.nextOffset).toBe(page.output.length);
			expect(page.log.nextOffset).toBeGreaterThan(0);
			expect(page.log.nextOffset).toBeLessThan(16000);
			expect(f.gateway.read).toHaveBeenCalledTimes(1);
			expect(f.gateway.read.mock.calls[0][1].limit).toBe(16384);
		} finally {
			f.boundary.close();
		}
	});
	it("asks again for exactly what fits when the page cannot tell its cut's cursor (U+FFFD on both sides)", async () => {
		const f = fixture();
		// U+FFFD stands for a byte that is not UTF-8 too: a cut between two of them leaves the cursor unknown.
		const unit = Array.from(`\uFFFD${"<".repeat(9)}`);
		const text = (bytes: number) => {
			let out = "";
			for (let i = 0, used = 0; ; i++) {
				const c = unit[i % unit.length];
				used += Buffer.byteLength(c);
				if (used > bytes) return out;
				out += c;
			}
		};
		paged(f, (bytes) => text(Math.min(bytes, 20000)), 20000);
		try {
			const result = await f.boundary.invoke("page", "qorpera", "coding_read_command", { commandId: f.commandId });
			expect(result.success).toBe(true);
			const limits = f.gateway.read.mock.calls.map(([, input]) => input.limit);
			expect(limits).toEqual([CLOUD_COMMAND_PAGE_ASK, expect.any(Number)]);
			expect(limits[1]).toBeLessThan(20000);
			const { envelope, page } = shown(result);
			expect(envelope.content.truncated).toBe(false);
			expect(page.output).toBe(text(limits[1] as number));
			expect(page.log.nextOffset).toBe(limits[1]);
		} finally {
			f.boundary.close();
		}
	});
	it("takes a smaller limit as it is, and refuses one past one result's bound", async () => {
		const f = fixture();
		try {
			expect(
				(await f.boundary.invoke("small", "qorpera", "coding_read_command", { commandId: f.commandId, limit: 100 }))
					.success,
			).toBe(true);
			expect(f.gateway.read.mock.calls[0][1]).toEqual({ commandId: f.commandId, offset: 0, limit: 100 });
			expect(
				(await f.boundary.invoke("big", "qorpera", "coding_read_command", { commandId: f.commandId, limit: 32769 }))
					.success,
			).toBe(false);
			expect(f.gateway.read).toHaveBeenCalledTimes(1);
			const schema = f.tools.find((tool) => tool.name === "coding_read_command")?.inputSchema as {
				properties: { limit: { maximum: number } };
			};
			expect(schema.properties.limit.maximum).toBe(32768);
		} finally {
			f.boundary.close();
		}
	});
	it("shows a command that ended at its start with as much output as one result holds, in the same call", async () => {
		const f = fixture();
		const log = lines(50_000);
		f.gateway.start.mockResolvedValue({
			...f.receipt,
			state: "failed",
			exitCode: 1,
			output: log.slice(0, 4096),
			truncated: true,
			log: { offset: 0, nextOffset: 4096, totalBytes: 50_000, limitBytes: 67108864, limitReached: false },
		});
		paged(f, (bytes) => log.slice(0, Math.min(bytes, 50_000)), 50_000, "failed");
		try {
			const result = await f.boundary.invoke("run", "qorpera", "coding_run_command", {
				operationKey: "test",
				command: "npm test",
			});
			expect(result.success).toBe(true);
			expect(f.gateway.read).toHaveBeenCalledTimes(1);
			expect(f.gateway.read.mock.calls[0][1]).toEqual({
				commandId: f.commandId,
				offset: 0,
				limit: CLOUD_COMMAND_PAGE_ASK,
			});
			const { page } = shown(result);
			expect(page.state).toBe("failed");
			expect(Buffer.byteLength(page.output)).toBeGreaterThan(28_000);
			expect(log.startsWith(page.output)).toBe(true);
			// A read that fails keeps the start's own answer.
			f.gateway.read.mockRejectedValueOnce(new Error("transport_unavailable"));
			const kept = shown(
				await f.boundary.invoke("run2", "qorpera", "coding_run_command", {
					operationKey: "again",
					command: "npm test",
				}),
			).page;
			expect(kept.output).toBe(log.slice(0, 4096));
		} finally {
			f.boundary.close();
		}
	});
	it("reads nothing more at a start whose command still runs, or whose output its start shows whole", async () => {
		const f = fixture();
		try {
			await f.boundary.invoke("run", "qorpera", "coding_run_command", { operationKey: "a", command: "npm run dev" });
			f.gateway.start.mockResolvedValue({
				...f.receipt,
				state: "succeeded",
				exitCode: 0,
				output: "ok\n",
				log: { offset: 0, nextOffset: 3, totalBytes: 3, limitBytes: 67108864, limitReached: false },
			});
			await f.boundary.invoke("run2", "qorpera", "coding_run_command", { operationKey: "b", command: "true" });
			expect(f.gateway.read).not.toHaveBeenCalled();
		} finally {
			f.boundary.close();
		}
	});
	it("rejects another worker's receipt and does not echo upstream error text", async () => {
		const f = fixture();
		f.gateway.start.mockResolvedValue({ ...f.receipt, workerId: randomUUID(), output: "canary-secret" });
		try {
			const result = await f.boundary.invoke("bad", "qorpera", "coding_run_command", {
				operationKey: "one",
				command: "true",
				timeoutMs: 1000,
			});
			expect(result.success).toBe(false);
			expect(JSON.stringify(result)).not.toContain("canary-secret");
		} finally {
			f.boundary.close();
		}
	});
	it("cancels only the addressed command through a receipt", async () => {
		const f = fixture();
		try {
			expect(
				(
					await f.boundary.invoke("stop", "qorpera", "coding_cancel_command", {
						commandId: f.commandId,
						operationKey: "stop",
					})
				).success,
			).toBe(true);
			expect(f.gateway.cancel).toHaveBeenCalledWith(f.scope, f.commandId, expect.any(AbortSignal));
			expect(f.execute.mock.calls[0][0].operation.tool).toBe("coding_cancel_command");
		} finally {
			f.boundary.close();
		}
	});
	it("passes on a command the machine's stop ended, with the output its ring dropped", async () => {
		const f = fixture();
		const stopped = {
			...f.receipt,
			state: "machine_stopped",
			output: "step 1\n",
			truncated: false,
			log: { offset: 0, nextOffset: 7, totalBytes: 7, limitBytes: 67108864, limitReached: false, gapBytes: 65536 },
		};
		f.gateway.read.mockResolvedValue(stopped);
		try {
			const result = await f.boundary.invoke("page", "qorpera", "coding_read_command", { commandId: f.commandId });
			expect(result.success).toBe(true);
			expect(JSON.parse(JSON.parse(result.contentItems[0].text).content.text)).toEqual(stopped);
		} finally {
			f.boundary.close();
		}
	});
	it.each([
		{ state: "succeeded", exitCode: null },
		{ state: "failed", exitCode: 0 },
		{ state: "running", exitCode: 0 },
		{ state: "machine_stopped", exitCode: 137 },
		{ output: "x".repeat(65537) },
		{ token: "unexpected" },
	])("rejects inconsistent guest receipt %j", (patch) => {
		const f = fixture();
		try {
			expect(() => parseCloudCodingCommandReceipt({ ...f.receipt, ...patch })).toThrow();
		} finally {
			f.boundary.close();
		}
	});
	it.each([
		{ operationKey: "pf-1", runChecks: false },
		{ operationKey: "pf-1", runChecks: true, command: "npm test" },
		{ operationKey: "pf-1", runChecks: true, timeoutMs: 5000 },
		{ operationKey: "pf-1", checkNames: ["test"], command: "npm test" },
		{ operationKey: "pf-1", failFast: false, command: "npm test" },
		{ operationKey: "pf-1", runChecks: true, failFast: "no" },
		{ operationKey: "pf-1", runChecks: true, cleanCopy: "yes" },
		{ operationKey: "pf-1", runChecks: true, validateSite: 1 },
		{ operationKey: "pf-1", cleanCopy: true, command: "npm test" },
		{ operationKey: "pf-1", validateSite: true, command: "npm test" },
		{ operationKey: "pf-1", runChecks: true, checkNames: [] },
		{ operationKey: "pf-1", runChecks: true, checkNames: ["test", "test"] },
		{ operationKey: "pf-1", runChecks: true, checkNames: ["BadName"] },
		{ operationKey: "pf-1", runChecks: true, checkNames: Array.from({ length: 21 }, (_, i) => `c${i}`) },
		{ operationKey: "bad key", runChecks: true },
		{ runChecks: true },
	])("rejects invalid runChecks arguments %j", async (args) => {
		const f = fixture();
		try {
			const result = await f.boundary.invoke("bad-pf", "qorpera", "coding_run_command", args);
			expect(result.success).toBe(false);
			expect(f.gateway.start).not.toHaveBeenCalled();
		} finally {
			f.boundary.close();
		}
	});
});

function makeJpeg(width: number, height: number): Buffer {
	const image = MemoryImage.fromBytes({
		width,
		height,
		numChannels: 3,
		bytes: Uint8Array.from({ length: width * height * 3 }, (_, i) => (i % 3 === 0 ? 220 : 40)).buffer,
	});
	return Buffer.from(new JpegEncoder(90).encode({ image, chroma: JpegChroma.yuv444 }));
}

function makeWebp(width: number, height: number): Buffer {
	const image = MemoryImage.fromBytes({
		width,
		height,
		numChannels: 4,
		bytes: Uint8Array.from({ length: width * height * 4 }, (_, i) => (i % 4 === 1 ? 200 : i % 4 === 3 ? 255 : 20))
			.buffer,
	});
	return Buffer.from(new WebPEncoder().encode({ image }));
}

function makeSolidPng(width: number, height: number, extraChunks: Buffer[] = []): Buffer {
	const rowBytes = width * 3 + 1;
	const data = Buffer.alloc(rowBytes * height, 0x44);
	for (let y = 0; y < height; y++) data[y * rowBytes] = 0;
	return pngFile(pngHeader(width, height, 8, 2), data, ...extraChunks);
}

describe("coding_run_command inspectImage visual screenshot inspection", () => {
	async function workspaceFixture(
		options: {
			pageBytes?: number;
			startEmpty?: boolean;
			env?: NodeJS.ProcessEnv;
			authorize?: CloudCodingCommandGateway["authorize"];
			pollMs?: number;
			timeoutGraceMs?: number;
		} = {},
	) {
		const root = await mkdtemp(join(tmpdir(), "qorpera-coding-img-"));
		const workspace = join(root, "workspace");
		const outside = join(root, "outside");
		await mkdir(workspace, { recursive: true });
		await mkdir(outside, { recursive: true });
		const { binding, authority } = nativeToolAuthorityFixture();
		const identity = { ...authority.identity, sessionId: null as string | null };
		const scope = { workerId: randomUUID(), vmId: randomUUID(), requestId: randomUUID(), turn: 1 };
		const logs = new Map<
			string,
			{ inputSha256: string; state: "succeeded" | "failed"; exitCode: number; buf: Buffer }
		>();
		const ledger = new Map<string, { receiptId: string; inputSha256: string; result: JsonValue | null }>();
		const begun: { logicalOperationKey: string; receiptId: string; inputSha256: string }[] = [];
		const control: CloudNativeToolOperationControlPlane = {
			beginToolOperation: vi.fn(async (b, input) => {
				begun.push({
					logicalOperationKey: input.logicalOperationKey,
					receiptId: input.receiptId,
					inputSha256: input.inputSha256,
				});
				let row = ledger.get(input.logicalOperationKey);
				if (!row) {
					row = { receiptId: input.receiptId, inputSha256: input.inputSha256, result: null };
					ledger.set(input.logicalOperationKey, row);
				}
				return {
					run_id: b.runId,
					receipt_id: row.receiptId,
					state: row.result === null ? "executing" : "completed",
					result: row.result,
					output_snapshot_id: null,
					proposal_id: null,
					folder_commit_id: null,
				};
			}),
			completeToolOperation: vi.fn(async (b, input) => {
				const row = [...ledger.values()].find((r) => r.receiptId === input.receiptId);
				if (!row) throw new Error("missing receipt");
				row.result = structuredClone(input.result);
				return {
					run_id: b.runId,
					receipt_id: input.receiptId,
					state: "completed",
					result: input.result,
				};
			}),
		};
		const runAbort = new AbortController();
		const callAbort = new AbortController();
		const run = await CloudNativeToolRun.open(
			binding,
			{ describeToolAuthority: async () => structuredClone({ ...authority, identity }) },
			runAbort.signal,
		);
		const operations = new CloudNativeToolOperations(run, control);
		const readLimits: number[] = [];
		const gateway: CloudCodingCommandGateway = {
			authorize: vi.fn<CloudCodingCommandGateway["authorize"]>(options.authorize ?? (async () => undefined)),
			start: vi.fn<CloudCodingCommandGateway["start"]>(async (_scope, input) => {
				let outputText = "";
				let exitCode = 0;
				try {
					const ran = await execFileAsync("/bin/bash", ["--noprofile", "--norc", "-c", input.command], {
						cwd: workspace,
						env: { ...process.env, ...options.env },
						maxBuffer: 16 * 1024 * 1024,
						encoding: "utf8",
					});
					outputText = `${ran.stdout}${ran.stderr}`;
				} catch (error) {
					const err = error as { code?: number; stdout?: string; stderr?: string };
					exitCode = typeof err.code === "number" && err.code >= 1 && err.code <= 255 ? err.code : 1;
					const stdout = typeof err.stdout === "string" ? err.stdout : "";
					const stderr = typeof err.stderr === "string" ? err.stderr : "";
					outputText = `${stdout}${stderr}`;
				}
				const buf = Buffer.from(outputText, "utf8");
				const state = exitCode === 0 ? "succeeded" : "failed";
				logs.set(input.commandId, { inputSha256: input.inputSha256, state, exitCode, buf });
				const firstLen = options.startEmpty ? 0 : Math.min(buf.length, options.pageBytes ?? 4096);
				const output = buf.subarray(0, firstLen).toString("utf8");
				return {
					schema: "qorpera.coding-command-result/v2",
					workerId: scope.workerId,
					commandId: input.commandId,
					inputSha256: input.inputSha256,
					state,
					exitCode,
					output,
					truncated: firstLen < buf.length,
					log: {
						offset: 0,
						nextOffset: firstLen,
						totalBytes: buf.length,
						limitBytes: 67108864,
						limitReached: false,
					},
				};
			}),
			read: vi.fn<CloudCodingCommandGateway["read"]>(async (_scope, input) => {
				readLimits.push(input.limit ?? 4096);
				const entry = logs.get(input.commandId);
				if (!entry) throw new Error("missing command");
				const offset = input.offset ?? 0;
				const maxPage = Math.min(input.limit ?? 4096, options.pageBytes ?? 60000);
				const end = Math.min(entry.buf.length, offset + maxPage);
				const output = entry.buf.subarray(offset, end).toString("utf8");
				return {
					schema: "qorpera.coding-command-result/v2",
					workerId: scope.workerId,
					commandId: input.commandId,
					inputSha256: entry.inputSha256,
					state: entry.state,
					exitCode: entry.exitCode,
					output,
					truncated: end < entry.buf.length,
					log: {
						offset,
						nextOffset: end,
						totalBytes: entry.buf.length,
						limitBytes: 67108864,
						limitReached: false,
					},
				};
			}),
			cancel: vi.fn<CloudCodingCommandGateway["cancel"]>(async (_scope, commandId) => ({
				schema: "qorpera.coding-command-result/v2",
				workerId: scope.workerId,
				commandId,
				inputSha256: "a".repeat(64),
				state: "cancelled",
				exitCode: null,
				output: "",
				truncated: false,
				log: { offset: 0, nextOffset: 0, totalBytes: 0, limitBytes: 67108864, limitReached: false },
			})),
		};
		const tools = cloudCodingCommandTools({
			scope,
			identity,
			operations,
			gateway,
			pollMs: options.pollMs ?? 5,
			timeoutGraceMs: options.timeoutGraceMs ?? 25,
		});
		const boundary = new CloudNativeToolBoundary({
			companyId: identity.companyId,
			runId: identity.runId,
			identity,
			tools,
			assertActive: (signal) => run.assertActive(signal),
			signal: callAbort.signal,
		});
		const cleanup = async () => {
			boundary.close();
			run.close();
			await rm(root, { recursive: true, force: true });
		};
		return {
			root,
			workspace,
			outside,
			binding,
			authority: { ...authority, identity },
			identity,
			scope,
			gateway,
			boundary,
			tools,
			begun,
			readLimits,
			callAbort,
			cleanup,
		};
	}

	it("returns sanitized multimodal PNG images for PNG, JPEG, and WebP screenshots and strips metadata", async () => {
		const f = await workspaceFixture({
			pageBytes: 120,
			env: { NODE_OPTIONS: "--trace-warnings --experimental-vm-modules" },
		});
		try {
			expect(f.boundary.captureImagesEnabled).toBe(true);
			await mkdir(join(f.workspace, "docs", "changes"), { recursive: true });
			await mkdir(join(f.workspace, ".tmp"), { recursive: true });
			const pngBytes = makeSolidPng(24, 16, [pngChunk("tEXt", Buffer.from("Secret\0should-be-stripped"))]);
			const jpgBytes = makeJpeg(32, 20);
			const webpBytes = makeWebp(20, 12);
			await writeFile(join(f.workspace, "docs", "changes", "home screen.png"), pngBytes);
			await writeFile(join(f.workspace, ".tmp", "check.jpg"), jpgBytes);
			await writeFile(join(f.workspace, ".tmp", "mobile.webp"), webpBytes);
			await symlink("docs/changes/home screen.png", join(f.workspace, "latest.png"));

			for (const [opKey, rel, mediaType, expectedWidth, expectedHeight, rawBytes] of [
				["img-png", "docs/changes/home screen.png", "image/png", 24, 16, pngBytes],
				["img-jpg", ".tmp/check.jpg", "image/jpeg", 32, 20, jpgBytes],
				["img-webp", ".tmp/mobile.webp", "image/webp", 20, 12, webpBytes],
				["img-link", "latest.png", "image/png", 24, 16, pngBytes],
			] as const) {
				const res = await f.boundary.invoke(`call_${opKey}`, "qorpera", "coding_run_command", {
					operationKey: opKey,
					inspectImage: rel,
				});
				expect(res.success).toBe(true);
				expect(res.contentItems).toHaveLength(2);
				const envelope = JSON.parse(res.contentItems[0].text);
				expect(envelope.status).toBe("ok");
				expect(envelope.content.truncated).toBe(false);
				const answer = JSON.parse(envelope.content.text);
				expect(answer).toEqual({
					schema: CODING_INSPECT_IMAGE_SCHEMA,
					kind: "image",
					path: rel,
					commandId: expect.stringMatching(
						/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
					),
					mediaType,
					totalBytes: rawBytes.byteLength,
					width: expectedWidth,
					height: expectedHeight,
					shownWidth: expectedWidth,
					shownHeight: expectedHeight,
					imageSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
				});
				const imageItem = res.contentItems[1];
				expect(imageItem?.type).toBe("inputImage");
				expect(imageItem?.imageUrl.startsWith("data:image/png;base64,")).toBe(true);
				const shownPng = Buffer.from(imageItem!.imageUrl.slice("data:image/png;base64,".length), "base64");
				expect(createHash("sha256").update(shownPng).digest("hex")).toBe(answer.imageSha256);
				expect(shownPng.includes(Buffer.from("should-be-stripped"))).toBe(false);
				const decoded = new PngDecoder().decode({ bytes: shownPng });
				expect(decoded?.width).toBe(expectedWidth);
				expect(decoded?.height).toBe(expectedHeight);
			}
			expect(f.readLimits.every((limit) => limit >= 4)).toBe(true);
		} finally {
			await f.cleanup();
		}
	});

	it("resamples oversized dimensions down to <= 1920x1200 via folderImageView", async () => {
		const f = await workspaceFixture();
		try {
			const big = makeSolidPng(2400, 1600);
			await writeFile(join(f.workspace, "wide.png"), big);
			const res = await f.boundary.invoke("call-wide", "qorpera", "coding_run_command", {
				operationKey: "wide-1",
				inspectImage: "wide.png",
			});
			expect(res.success).toBe(true);
			expect(res.contentItems).toHaveLength(2);
			const answer = JSON.parse(JSON.parse(res.contentItems[0].text).content.text);
			expect(answer.width).toBe(2400);
			expect(answer.height).toBe(1600);
			expect(answer.shownWidth).toBe(1800);
			expect(answer.shownHeight).toBe(1200);
		} finally {
			await f.cleanup();
		}
	});

	it("matches authorizeCodingCommand receipt inputSha256 and replays cleanly under the same operationKey", async () => {
		const f = await workspaceFixture({ startEmpty: true });
		try {
			await writeFile(join(f.workspace, "shot.png"), makeSolidPng(8, 8));
			const res1 = await f.boundary.invoke("call-auth-1", "qorpera", "coding_run_command", {
				operationKey: "inspect-auth",
				inspectImage: "shot.png",
			});
			expect(res1.success).toBe(true);
			expect(res1.contentItems).toHaveLength(2);
			const startCall = vi.mocked(f.gateway.start).mock.calls[0]?.[1];
			expect(startCall).toBeDefined();
			const op = f.begun[0];
			expect(op?.logicalOperationKey.startsWith("coding_run_command:img:")).toBe(true);
			const subKey = op!.logicalOperationKey.slice("coding_run_command:".length);
			const authorized = await authorizeCodingCommand(
				{
					call: async () => ({
						inputSha256: op!.inputSha256,
						operationKey: subKey,
						authority: {
							...f.authority,
							coding: {
								workerId: f.scope.workerId,
								vmId: f.scope.vmId,
								turnId: f.scope.requestId,
								sequence: f.scope.turn,
							},
						},
					}),
				},
				{
					schema: "qorpera.coding-command-http/v1",
					binding: f.binding,
					scope: f.scope,
					action: "start",
					input: startCall!,
				},
				new AbortController().signal,
			);
			expect(authorized).toEqual({ inputSha256: startCall!.inputSha256 });

			const res2 = await f.boundary.invoke("call-auth-2", "qorpera", "coding_run_command", {
				operationKey: "inspect-auth",
				inspectImage: "shot.png",
			});
			expect(res2.success).toBe(true);
			expect(res2.contentItems).toHaveLength(2);
			expect(f.gateway.start).toHaveBeenCalledTimes(1);
			const answer1 = JSON.parse(JSON.parse(res1.contentItems[0].text).content.text);
			const answer2 = JSON.parse(JSON.parse(res2.contentItems[0].text).content.text);
			expect(answer2.commandId).toBe(answer1.commandId);

			await writeFile(join(f.workspace, "shot.png"), makeSolidPng(12, 10));
			const res3 = await f.boundary.invoke("call-auth-fresh", "qorpera", "coding_run_command", {
				operationKey: "inspect-auth-2",
				inspectImage: "shot.png",
			});
			expect(res3.success).toBe(true);
			expect(f.gateway.start).toHaveBeenCalledTimes(2);
			const answer3 = JSON.parse(JSON.parse(res3.contentItems[0].text).content.text);
			expect(answer3.commandId).not.toBe(answer1.commandId);
			expect(answer3.width).toBe(12);
			expect(answer3.height).toBe(10);

			const conflict = await f.boundary.invoke("call-auth-3", "qorpera", "coding_run_command", {
				operationKey: "inspect-auth",
				inspectImage: "other.png",
			});
			expect(conflict.success).toBe(false);
			expect(conflict.contentItems).toHaveLength(1);
		} finally {
			await f.cleanup();
		}
	});

	it.each([
		{ operationKey: "i1", inspectImage: "../outside.png" },
		{ operationKey: "i1", inspectImage: "docs/../../outside.png" },
		{ operationKey: "i1", inspectImage: "./shot.png" },
		{ operationKey: "i1", inspectImage: "/etc/passwd.png" },
		{ operationKey: "i1", inspectImage: "/tmp/shot.png" },
		{ operationKey: "i1", inspectImage: "docs\\shot.png" },
		{ operationKey: "i1", inspectImage: "docs//shot.png" },
		{ operationKey: "i1", inspectImage: "docs/shot.gif" },
		{ operationKey: "i1", inspectImage: "docs/shot.svg" },
		{ operationKey: "i1", inspectImage: "docs/shot.txt" },
		{ operationKey: "i1", inspectImage: "docs/.png" },
		{ operationKey: "i1", inspectImage: ".png" },
		{ operationKey: "i1", inspectImage: "docs/shot" },
		{ operationKey: "i1", inspectImage: "" },
		{ operationKey: "i1", inspectImage: " shot.png" },
		{ operationKey: "i1", inspectImage: "shot.png\n" },
		{ operationKey: "i1", inspectImage: `${"a/".repeat(260)}x.png` },
		{ operationKey: "i1", inspectImage: 42 },
		{ operationKey: "i1", inspectImage: "shot.png", command: "true" },
		{ operationKey: "i1", inspectImage: "shot.png", timeoutMs: 5000 },
		{ operationKey: "i1", inspectImage: "shot.png", runChecks: true },
		{ operationKey: "i1", inspectImage: "shot.png", failFast: false },
		{ operationKey: "i1", inspectImage: "shot.png", checkNames: ["test"] },
		{ operationKey: "bad key", inspectImage: "shot.png" },
		{ inspectImage: "shot.png" },
	])("rejects invalid inspectImage arguments %j before invoking gateway", async (args) => {
		const f = fixture();
		try {
			const res = await f.boundary.invoke("bad-img", "qorpera", "coding_run_command", args);
			expect(res.success).toBe(false);
			expect(res.contentItems).toHaveLength(1);
			expect(f.gateway.start).not.toHaveBeenCalled();
		} finally {
			f.boundary.close();
		}
	});

	it("rejects symlinks escaping workspace, non-regular files (dir and FIFO), missing files, corrupt images, and oversized >8 MiB files", async () => {
		const f = await workspaceFixture();
		try {
			const outsideFile = join(f.outside, "secret.png");
			await writeFile(outsideFile, makeSolidPng(4, 4));
			await symlink(outsideFile, join(f.workspace, "escape.png"));
			await symlink(f.outside, join(f.workspace, "escape-dir"));
			await mkdir(join(f.workspace, "folder.png"));
			await execFileAsync("mkfifo", [join(f.workspace, "pipe.png")]);
			await writeFile(join(f.workspace, "not-an-image.png"), Buffer.from("plain text not png"));
			await writeFile(
				join(f.workspace, "corrupt.png"),
				Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("broken")]),
			);
			await writeFile(join(f.workspace, "fake-gif.png"), Buffer.from("GIF89a\x01\x00\x01\x00\x80\x00\x00"));
			await writeFile(join(f.workspace, "empty.png"), Buffer.alloc(0));
			const oversized = Buffer.alloc(MAX_CODING_INSPECT_IMAGE_BYTES + 1, 0);
			makeSolidPng(2, 2).copy(oversized, 0);
			await writeFile(join(f.workspace, "huge.png"), oversized);

			for (const [opKey, rel, code] of [
				["esc-1", "escape.png", "CODING_IMAGE_OUTSIDE_WORKSPACE"],
				["esc-2", "escape-dir/secret.png", "CODING_IMAGE_OUTSIDE_WORKSPACE"],
				["dir-1", "folder.png", "CODING_IMAGE_NOT_A_FILE"],
				["fifo-1", "pipe.png", "CODING_IMAGE_NOT_A_FILE"],
				["miss-1", "does-not-exist.png", "CODING_IMAGE_NOT_FOUND"],
				["txt-1", "not-an-image.png", "CODING_IMAGE_UNREADABLE"],
				["corrupt-1", "corrupt.png", "CODING_IMAGE_UNREADABLE"],
				["gif-1", "fake-gif.png", "CODING_IMAGE_UNREADABLE"],
				["empty-1", "empty.png", "CODING_IMAGE_UNREADABLE"],
				["huge-1", "huge.png", "CODING_IMAGE_TOO_LARGE"],
			] as const) {
				const res = await f.boundary.invoke(`call_${opKey}`, "qorpera", "coding_run_command", {
					operationKey: opKey,
					inspectImage: rel,
				});
				expect(res.success, rel).toBe(false);
				expect(res.contentItems, rel).toHaveLength(1);
				const envelope = JSON.parse(res.contentItems[0].text);
				expect(envelope.status, rel).toBe("denied");
				expect(envelope.content.text, rel).toContain(`REFUSED: ${code}:`);
			}
		} finally {
			await f.cleanup();
		}
	});

	it("does not release an inspected image after authority is revoked", async () => {
		let authCalls = 0;
		const f = await workspaceFixture({
			authorize: async () => {
				authCalls += 1;
				if (authCalls >= 3) throw new Error("revoked");
			},
		});
		try {
			await writeFile(join(f.workspace, "shot.png"), makeSolidPng(4, 4));
			const res = await f.boundary.invoke("call-revoked", "qorpera", "coding_run_command", {
				operationKey: "revoked-1",
				inspectImage: "shot.png",
			});
			expect(res.success).toBe(false);
			expect(res.contentItems).toHaveLength(1);
			expect(JSON.parse(res.contentItems[0].text).content.text).not.toContain("CODING_IMAGE_");
		} finally {
			await f.cleanup();
		}
	});

	it("polls a running image read command until completion", async () => {
		const f = fixture();
		const png = pngFile(
			pngHeader(2, 2, 8, 2),
			pngRows([
				[255, 0, 0, 0, 255, 0],
				[0, 0, 255, 255, 255, 0],
			]),
		);
		const payload = `QORPERA_IMG:${png.byteLength}:${createHash("sha256").update(png).digest("hex")}:\n${png.toString("base64")}`;
		let readCount = 0;
		f.gateway.start.mockResolvedValue({
			...f.receipt,
			state: "running",
			exitCode: null,
			output: "",
			truncated: false,
			log: { offset: 0, nextOffset: 0, totalBytes: 0, limitBytes: 67108864, limitReached: false },
		});
		f.gateway.read.mockImplementation(async (_scope, input) => {
			readCount += 1;
			if (readCount === 1) {
				return {
					...f.receipt,
					state: "running",
					exitCode: null,
					output: "",
					truncated: false,
					log: { offset: 0, nextOffset: 0, totalBytes: 0, limitBytes: 67108864, limitReached: false },
				};
			}
			const offset = input.offset ?? 0;
			const end = Math.min(payload.length, offset + (input.limit ?? 4096));
			const output = payload.slice(offset, end);
			return {
				...f.receipt,
				state: "succeeded",
				exitCode: 0,
				output,
				truncated: end < payload.length,
				log: {
					offset,
					nextOffset: end,
					totalBytes: payload.length,
					limitBytes: 67108864,
					limitReached: false,
				},
			};
		});
		const fastTools = cloudCodingCommandTools({
			scope: f.scope,
			identity: f.identity,
			gateway: f.gateway,
			operations: { execute: f.execute },
			pollMs: 5,
			timeoutGraceMs: 25,
		});
		const boundary = new CloudNativeToolBoundary({
			companyId: f.identity.companyId,
			runId: f.identity.runId,
			identity: f.identity,
			tools: fastTools,
			assertActive: async () => undefined,
			signal: new AbortController().signal,
		});
		try {
			const res = await boundary.invoke("poll-img", "qorpera", "coding_run_command", {
				operationKey: "poll-1",
				inspectImage: "shot.png",
			});
			expect(res.success).toBe(true);
			expect(res.contentItems).toHaveLength(2);
			expect(readCount).toBeGreaterThanOrEqual(2);
		} finally {
			boundary.close();
			f.boundary.close();
		}
	});

	it("cancels a running image read command when aborted", async () => {
		const f = fixture();
		f.gateway.start.mockResolvedValue({
			...f.receipt,
			state: "running",
			exitCode: null,
			output: "",
			truncated: false,
			log: { offset: 0, nextOffset: 0, totalBytes: 0, limitBytes: 67108864, limitReached: false },
		});
		const abort = new AbortController();
		const fastTools = cloudCodingCommandTools({
			scope: f.scope,
			identity: f.identity,
			gateway: f.gateway,
			operations: { execute: f.execute },
			pollMs: 50,
			timeoutGraceMs: 25,
		});
		const boundary = new CloudNativeToolBoundary({
			companyId: f.identity.companyId,
			runId: f.identity.runId,
			identity: f.identity,
			tools: fastTools,
			assertActive: async () => undefined,
			signal: abort.signal,
		});
		try {
			const pending = boundary.invoke("abort-img", "qorpera", "coding_run_command", {
				operationKey: "abort-1",
				inspectImage: "shot.png",
			});
			await new Promise((resolve) => setTimeout(resolve, 15));
			abort.abort(new Error("turn aborted"));
			const res = await pending;
			expect(res.success).toBe(false);
			expect(res.contentItems).toHaveLength(1);
			expect(f.gateway.cancel).toHaveBeenCalledWith(f.scope, f.commandId, expect.any(AbortSignal));
		} finally {
			boundary.close();
			f.boundary.close();
		}
	});
});
