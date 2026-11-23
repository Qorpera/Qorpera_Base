import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
	authorizeCodingCommand,
	authorizeCodingCommandV2,
	proveNativeBinding,
} from "../../../deploy/coding-worker/command-authority.ts";
import type { CloudCodingCommandHttpRequest } from "../src/cloud-coding-command-http.ts";
import { cloudNativeToolOperationEnvelope } from "../src/cloud-native-tool-operations.ts";
import { nativeToolAuthorityFixture } from "./fixtures/native-tool-authority-fixture.ts";

function fixture(timeoutMs: number | null = 1000, reasoningEffort?: "xhigh" | "max") {
	const fixed = nativeToolAuthorityFixture();
	const { binding } = fixed;
	const authority = reasoningEffort
		? {
				...fixed.authority,
				identity: { ...fixed.authority.identity, reasoningEffort } as typeof fixed.authority.identity,
			}
		: fixed.authority;
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
	it("authorizes a command of a member's turn at extra high and refuses max", async () => {
		const f = fixture(1000, "xhigh");
		expect(await authorizeCodingCommand(f, f.request, f.signal)).toEqual({ inputSha256: f.inputSha256 });
		const max = fixture(1000, "max");
		await expect(authorizeCodingCommand(max, max.request, max.signal)).rejects.toThrow();
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

	it("authorizes consolidated v2 response with route, runAuthority, rebuildDue, diskEpoch, and vaultEnvVersion", async () => {
		const f = fixture();
		const bindingAnswer = await f.call();
		const route = {
			schema: "qorpera.coding-command-route/v1",
			executorOwner: "node-1",
			providerId: "lxd",
			machineId: f.request.scope.vmId,
		};
		const runAuthority = { schema: "qorpera.coding-machine-admission/v1", intent: "run" };
		const vaultEnvVersion = "e".repeat(64);
		const diskEpoch = randomUUID();
		const holder = `job.${f.request.binding.jobId}.${"L".repeat(43)}`;
		const localRun = {
			workerId: f.request.scope.workerId,
			leaseToken: randomUUID(),
			bindingText: "{}",
			storage: {
				schema: "qorpera.coding-storage/v1" as const,
				volumeId: f.request.scope.workerId,
				workerId: f.request.scope.workerId,
				companyId: randomUUID(),
				environmentId: randomUUID(),
				writerGeneration: 1 as const,
				machineIdSha256: "f".repeat(64),
				policy: {
					schema: "qorpera.coding-nas-policy/v1" as const,
					mountPoint: "/srv/nas",
					source: "10.0.0.2:/srv/nas",
					serverAddress: "10.0.0.2",
					rootPath: "/srv/nas/coding",
				},
				dataSource: "/srv/nas/data",
				custodySource: "/srv/nas/state",
				dataTarget: "/workspace" as const,
				custodyTarget: "/var/lib/qorpera-coding" as const,
			},
			machineIdSha256: "f".repeat(64),
		};
		const call = vi.fn<() => Promise<unknown>>(async () => ({
			schema: "qorpera.coding-command-authority/v2",
			binding: bindingAnswer,
			route,
			runAuthority,
			rebuildDue: true,
			diskEpoch,
			vaultEnvVersion,
		}));
		const authorized = await authorizeCodingCommandV2({ call }, f.request, holder, localRun, f.signal);
		expect(call).toHaveBeenCalledWith(
			"qorpera_authorize_coding_command_v2",
			expect.objectContaining({
				p_binding: f.request.binding,
				p_holder: holder,
				p_scope: f.request.scope,
				p_action: "start",
				p_command_id: f.request.input.commandId,
				p_lease_token: localRun.leaseToken,
				p_binding_text: localRun.bindingText,
				p_machine_id_sha256: localRun.machineIdSha256,
			}),
			f.signal,
		);
		expect(authorized).toMatchObject({
			inputSha256: f.inputSha256,
			route,
			runAuthority,
			rebuildDue: true,
			diskEpoch,
			vaultEnvVersion,
		});
		expect(typeof authorized.startedAt).toBe("number");

		call.mockResolvedValueOnce({
			schema: "qorpera.coding-command-authority/v2",
			binding: bindingAnswer,
			route,
			runAuthority: null,
			rebuildDue: false,
			diskEpoch: null,
			vaultEnvVersion,
		});
		await expect(authorizeCodingCommandV2({ call }, f.request, holder, localRun, f.signal)).rejects.toThrow(
			"CODING_COMMAND_AUTHORITY_INVALID",
		);
	});
});
