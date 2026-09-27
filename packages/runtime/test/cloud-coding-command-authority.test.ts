import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { authorizeCodingCommand } from "../../../deploy/coding-worker/command-authority.ts";
import type { CloudCodingCommandHttpRequest } from "../src/cloud-coding-command-http.ts";
import { cloudNativeToolOperationEnvelope } from "../src/cloud-native-tool-operations.ts";
import { nativeToolAuthorityFixture } from "./fixtures/native-tool-authority-fixture.ts";

function fixture() {
	const { authority, binding } = nativeToolAuthorityFixture();
	const scope = { workerId: randomUUID(), vmId: randomUUID(), requestId: randomUUID(), turn: 1 };
	const operationKey = "build:1";
	const command = "printf 'test € 😀'";
	const timeoutMs = 1000;
	const inputSha256 = createHash("sha256")
		.update(
			cloudNativeToolOperationEnvelope(authority.identity, {
				tool: "coding_run_command",
				toolVersion: "v1",
				logicalOperationKey: operationKey,
				arguments: { operationKey, command, timeoutMs },
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
