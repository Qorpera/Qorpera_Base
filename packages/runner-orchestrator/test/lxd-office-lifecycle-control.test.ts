import { randomUUID } from "node:crypto";
import {
	type CompanyComputerLifecycleRequest,
	parseCompanyComputerLifecycleRequest,
	parseCompanyComputerLifecycleTransition,
} from "@qorpera/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LxdOfficeLifecycleControl } from "../src/lxd-office-lifecycle-control.ts";

function fixture() {
	const request: CompanyComputerLifecycleRequest = {
		schema: "qorpera.office-lifecycle-request/v1",
		transitionId: randomUUID(),
		action: "service_restart",
		activationId: randomUUID(),
		providerId: randomUUID(),
		providerPolicySha256: "f".repeat(64),
		startup: {
			scope: {
				companyId: randomUUID(),
				environmentId: randomUUID(),
				companyComputerId: randomUUID(),
				logicalComputerId: randomUUID(),
			},
			computerGeneration: 1,
			allocationId: randomUUID(),
			instanceSha256: "a".repeat(64),
			imageSha256: "b".repeat(64),
			bootstrapSha256: "c".repeat(64),
			bootId: randomUUID(),
			configurationSha256: "d".repeat(64),
			serviceInvocationId: "e".repeat(32),
		},
	};
	const receipt = {
		schema: "qorpera.office-lifecycle-transition/v1",
		request,
		state: "draining",
		revocationRevision: 2,
		requestedAtMs: Date.now(),
		drains: [
			{
				state: "draining",
				drainId: String(randomUUID()),
				epoch: 2,
				binding: {
					...request.startup.scope,
					computerGeneration: 1,
					screenId: randomUUID(),
					screenOrdinal: 1,
					screenGeneration: 1,
					staffAgentId: randomUUID(),
				},
			},
		],
	};
	return { request, receipt };
}
afterEach(() => vi.useRealTimers());
describe("explicit office lifecycle revocation", () => {
	it("snapshots one identity, sends only begin/status and retains immutable revocation data", async () => {
		const { request, receipt } = fixture(),
			retained = structuredClone(request);
		const call = vi.fn(async (_method: string) => structuredClone(receipt));
		const control = new LxdOfficeLifecycleControl(request, { call });
		const result = await control.begin(new AbortController().signal);
		expect(result).toEqual(receipt);
		expect(Object.isFrozen(result.drains[0].binding)).toBe(true);
		(request as { action: string }).action = "replace";
		receipt.request = retained;
		expect(await control.status(new AbortController().signal)).toEqual(result);
		expect(call.mock.calls.map((args) => args[0])).toEqual([
			"qorpera_begin_runtime_office_lifecycle",
			"qorpera_runtime_office_lifecycle_status",
		]);
	});
	it.each(["service_restart", "reboot", "power_off", "replace"])(
		"accepts explicit %s without executing it",
		(action) => {
			const { request } = fixture();
			expect(parseCompanyComputerLifecycleRequest({ ...request, action }).action).toBe(action);
		},
	);
	it.each([
		{ extra: true },
		{ action: "suspend" },
		{ action: null },
		{ transitionId: "bad" },
		{ providerId: null },
		{ providerPolicySha256: "bad" },
		{ activationId: "0".repeat(32) },
		{ startup: {} },
	])("rejects malformed or broadened request %j", (change) => {
		const { request } = fixture();
		expect(() => parseCompanyComputerLifecycleRequest({ ...request, ...change })).toThrow(
			"INVALID_OFFICE_LIFECYCLE_REQUEST",
		);
	});
	it.each(["scope", "allocationId", "bootId", "serviceInvocationId", "computerGeneration", "configurationSha256"])(
		"rejects changed startup %s",
		(key) => {
			const { request, receipt } = fixture();
			const changed = structuredClone(receipt);
			(changed.request.startup as unknown as Record<string, unknown>)[key] =
				key === "scope"
					? { ...request.startup.scope, companyId: randomUUID() }
					: key === "computerGeneration"
						? 2
						: key.endsWith("Sha256")
							? "0".repeat(64)
							: key === "serviceInvocationId"
								? "f".repeat(32)
								: randomUUID();
			expect(() => parseCompanyComputerLifecycleTransition(changed, request)).toThrow("UNCONFIRMED");
		},
	);
	it.each(["completed", "revision", "time", "scope", "generation", "duplicate", "order", "extra", "challenge"])(
		"refuses malformed stop implication or drain %s",
		(kind) => {
			const { request, receipt } = fixture();
			if (kind === "completed") receipt.state = "stopped";
			if (kind === "revision") receipt.revocationRevision = 0;
			if (kind === "time") receipt.requestedAtMs = 0;
			if (kind === "scope") receipt.drains[0].binding.companyId = randomUUID();
			if (kind === "generation") receipt.drains[0].binding.computerGeneration = 2;
			if (kind === "duplicate") receipt.drains.push(structuredClone(receipt.drains[0]));
			if (kind === "order") receipt.drains[0].binding.screenOrdinal = 33;
			if (kind === "extra") Object.assign(receipt.drains[0], { stopped: true });
			if (kind === "challenge") receipt.drains[0].drainId = "bad";
			expect(() => parseCompanyComputerLifecycleTransition(receipt, request)).toThrow("UNCONFIRMED");
		},
	);
	it("rejects changed retained receipt and never retries a lost response", async () => {
		const { request, receipt } = fixture();
		const call = vi.fn(async () => structuredClone(receipt));
		const control = new LxdOfficeLifecycleControl(request, { call });
		await control.begin(new AbortController().signal);
		receipt.revocationRevision++;
		await expect(control.status(new AbortController().signal)).rejects.toThrow("UNCONFIRMED");
		call.mockRejectedValueOnce(new Error("secret response"));
		await expect(control.begin(new AbortController().signal)).rejects.toThrow(
			/^OFFICE_LIFECYCLE_REQUEST_UNCONFIRMED$/,
		);
		expect(call).toHaveBeenCalledTimes(3);
	});
	it("retains a cancelled request slot until actual IO settles and rejects late success", async () => {
		const { request, receipt } = fixture();
		let settle!: (value: unknown) => void;
		const call = vi.fn(
			() =>
				new Promise((resolve) => {
					settle = resolve;
				}),
		);
		const control = new LxdOfficeLifecycleControl(request, { call }),
			stop = new AbortController();
		const result = expect(control.begin(stop.signal)).rejects.toThrow("UNCONFIRMED");
		stop.abort();
		await result;
		await expect(control.status(new AbortController().signal)).rejects.toThrow("PENDING");
		settle(receipt);
		await new Promise((resolve) => setTimeout(resolve, 0));
		call.mockResolvedValueOnce(receipt);
		expect(await control.status(new AbortController().signal)).toEqual(receipt);
		expect(call).toHaveBeenCalledTimes(2);
	});
});
