import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
	type CloudCodingCommandGateway,
	cloudCodingCommandTools,
	parseCloudCodingCommandReceipt,
} from "../src/cloud-coding-command-tools.ts";
import { CLOUD_COMMAND_PAGE_ASK } from "../src/cloud-command-page-fit.ts";
import { CloudNativeToolBoundary } from "../src/cloud-native-tool-boundary.ts";
import type { CloudNativeToolOperations } from "../src/cloud-native-tool-operations.ts";
import { nativeToolAuthorityFixture } from "./fixtures/native-tool-authority-fixture.ts";

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
});
