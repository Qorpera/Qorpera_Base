import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { authorizeCodingCommand, proveNativeBinding } from "../../../deploy/coding-worker/command-authority.ts";
import type { CloudCodingCommandHttpRequest } from "../src/cloud-coding-command-http.ts";
import { cloudNativeToolOperationEnvelope } from "../src/cloud-native-tool-operations.ts";
import { nativeToolAuthorityFixture } from "./fixtures/native-tool-authority-fixture.ts";

function fixture(timeoutMs: number | null = 1000) {
	const { authority, binding } = nativeToolAuthorityFixture();
	const scope = { workerId: randomUUID(), vmId: randomUUID(), requestId: randomUUID(), turn: 1 };
	const operationKey = "build:1";
	const command = "printf 'test € 😀'";
	const inputSha256 = createHash("sha256")
		.update(
			cloudNativeToolOperationEnvelope(authority.identity, {
				tool: "coding_run_command",
				toolVersion: "v1",
				logicalOperationKey: operationKey,
				arguments: { operationKey, command, ...(timeoutMs === null ? {} : { timeoutMs }) },
				target: { schema: "qorpera.coding-command-target/v1", ...scope },
				requiresCompanyRevision: false,
			}),
		)
		.digest("hex");
	const request: CloudCodingCommandHttpRequest = {
		schema: "qorpera.coding-command-http/v1",
		binding,
		scope,
		action: "start",
		input: { commandId: randomUUID(), inputSha256, command, timeoutMs },
	};
	// The kernel names the turn turnId/sequence; the guest protocol names it requestId/turn.
	const coding = { workerId: scope.workerId, vmId: scope.vmId, turnId: scope.requestId, sequence: scope.turn };
	const call = vi.fn(async () => ({ authority: { ...authority, coding }, operationKey, inputSha256 }));
	return { request, call, inputSha256, signal: new AbortController().signal };
}
describe("coding command receipt binding", () => {
	it("verifies exact canonical operation bytes including Unicode", async () => {
		const f = fixture();
		expect(await authorizeCodingCommand(f, f.request, f.signal)).toEqual({ inputSha256: f.inputSha256 });
	});
	it("binds a command without a deadline to the arguments the tool recorded without one", async () => {
		const f = fixture(null);
		expect(await authorizeCodingCommand(f, f.request, f.signal)).toEqual({ inputSha256: f.inputSha256 });
		if (f.request.action !== "start") throw new Error("fixture");
		await expect(
			authorizeCodingCommand(f, { ...f.request, input: { ...f.request.input, timeoutMs: 1000 } }, f.signal),
		).rejects.toThrow("INPUT_DIFFERS");
	});
	it.each([{ command: "different" }, { timeoutMs: 2000 }])(
		"rejects changed execution arguments %j despite a real receipt",
		async (change) => {
			const f = fixture();
			if (f.request.action !== "start") throw new Error("fixture");
			await expect(
				authorizeCodingCommand(f, { ...f.request, input: { ...f.request.input, ...change } }, f.signal),
			).rejects.toThrow("INPUT_DIFFERS");
		},
	);
	it("returns the original digest for an earlier command read", async () => {
		const f = fixture();
		expect(
			await authorizeCodingCommand(
				f,
				{ ...f.request, action: "read", input: { commandId: f.request.input.commandId } },
				f.signal,
			),
		).toEqual({ inputSha256: f.inputSha256 });
	});
});

describe("the guest-facing listener's lease proof (G2-6b)", () => {
	it("asks the database only whether the holder proves the binding, and holds only on its plain yes", async () => {
		const { binding } = nativeToolAuthorityFixture();
		const holder = `job.${binding.jobId}.${"L".repeat(43)}`;
		const signal = new AbortController().signal;
		const call = vi.fn(
			async (_method: string, _args: Record<string, unknown>, _signal: AbortSignal): Promise<unknown> => true,
		);
		await proveNativeBinding({ call }, binding, holder, signal);
		expect(call).toHaveBeenCalledWith(
			"qorpera_native_binding_proven",
			{ p_binding: binding, p_holder: holder },
			signal,
		);
		for (const answer of [false, null, "true", { proven: true }]) {
			call.mockResolvedValueOnce(answer);
			await expect(proveNativeBinding({ call }, binding, holder, signal)).rejects.toThrow("CODING_COMMAND_UNPROVEN");
		}
		// The database's refusal is a refusal, and nothing of the holder is in what this side throws.
		call.mockRejectedValueOnce(new Error("CODING_CONTROL_UNCONFIRMED"));
		const refused = await proveNativeBinding({ call }, binding, holder, signal).catch((error: unknown) => error);
		expect(refused).toBeInstanceOf(Error);
		expect(String((refused as Error).message)).not.toContain("L".repeat(43));
	});
});
