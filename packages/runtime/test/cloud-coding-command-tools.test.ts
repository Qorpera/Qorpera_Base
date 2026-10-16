import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
	type CloudCodingCommandGateway,
	cloudCodingCommandTools,
	parseCloudCodingCommandReceipt,
} from "../src/cloud-coding-command-tools.ts";
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
	it("shrinks escaped log pages so the native fence preserves a complete JSON cursor", async () => {
		const f = fixture();
		f.gateway.read.mockImplementation(async (_scope, input) => {
			const length = Math.min(16000, input.limit ?? 4096);
			return {
				...f.receipt,
				output: "<".repeat(length),
				truncated: length < 16000,
				log: { offset: 0, nextOffset: length, totalBytes: 16000, limitBytes: 67108864, limitReached: false },
			};
		});
		try {
			const result = await f.boundary.invoke("page", "qorpera", "coding_read_command", {
				commandId: f.commandId,
				limit: 16384,
			});
			expect(result.success).toBe(true);
			const envelope = JSON.parse(result.contentItems[0].text);
			expect(envelope.content.truncated).toBe(false);
			const page = JSON.parse(envelope.content.text);
			expect(page.log.nextOffset).toBe(page.output.length);
			expect(page.log.nextOffset).toBeGreaterThan(0);
			expect(f.gateway.read.mock.calls.length).toBeGreaterThan(1);
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
		{ output: "x".repeat(16385) },
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
