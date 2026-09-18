import { randomUUID } from "node:crypto";
import {
	parseCompanyComputerServiceStopCompletion,
	parseCompanyComputerServiceStopInspection,
	parseCompanyComputerServiceStopRequest,
} from "@qorpera/contracts";
import { describe, expect, it } from "vitest";

function fixture() {
	const request = parseCompanyComputerServiceStopRequest({
		schema: "qorpera.office-service-stop-request/v1",
		startCompletionSha256: "1".repeat(64),
		revocation: {
			schema: "qorpera.office-lifecycle-transition/v1",
			state: "draining",
			revocationRevision: 2,
			requestedAtMs: Date.now(),
			drains: [],
			request: {
				schema: "qorpera.office-lifecycle-request/v1",
				action: "service_restart",
				transitionId: randomUUID(),
				activationId: randomUUID(),
				providerId: randomUUID(),
				providerPolicySha256: "2".repeat(64),
				startup: {
					scope: {
						companyId: randomUUID(),
						environmentId: randomUUID(),
						companyComputerId: randomUUID(),
						logicalComputerId: randomUUID(),
					},
					computerGeneration: 1,
					allocationId: randomUUID(),
					bootId: randomUUID(),
					instanceSha256: "3".repeat(64),
					imageSha256: "4".repeat(64),
					bootstrapSha256: "5".repeat(64),
					configurationSha256: "6".repeat(64),
					serviceInvocationId: "7".repeat(32),
				},
			},
		},
	});
	const command = {
		commandId: randomUUID(),
		requestSha256: "8".repeat(64),
		bootId: request.revocation.request.startup.bootId,
	};
	const completion = parseCompanyComputerServiceStopCompletion(
		{
			schema: "qorpera.office-service-stop-completion/v1",
			command,
			transitionId: request.revocation.request.transitionId,
			activationId: request.revocation.request.activationId,
			revocationRevision: 2,
			configurationSha256: "6".repeat(64),
			startCompletionSha256: request.startCompletionSha256,
			fromServiceInvocationId: "7".repeat(32),
			observedInvocationId: "9".repeat(32),
			stoppedInvocationId: null,
			controlGroup: "/system.slice/qorpera-company-computer.service",
			cgroupState: "absent",
		},
		command,
		request,
	);
	return { request, command, completion };
}
describe("closed lifecycle stop evidence", () => {
	it("retains immutable identity while distinguishing the admitted and physically observed invocations", () => {
		const f = fixture(),
			input = structuredClone(f.request);
		const request = parseCompanyComputerServiceStopRequest(input);
		Object.assign(input.revocation.request.startup.scope, { companyId: randomUUID() });
		expect(request).toEqual(f.request);
		expect(Object.isFrozen(request.revocation.request.startup.scope)).toBe(true);
		expect(f.completion.observedInvocationId).not.toEqual(f.completion.fromServiceInvocationId);
		expect(f.completion.stoppedInvocationId).toBeNull();
	});
	it.each([
		{ schema: "old" },
		{ extra: true },
		{ command: {} },
		{ activationId: randomUUID() },
		{ transitionId: randomUUID() },
		{ revocationRevision: 3 },
		{ configurationSha256: "0".repeat(64) },
		{ startCompletionSha256: "0".repeat(64) },
		{ fromServiceInvocationId: "0".repeat(32) },
		{ observedInvocationId: "0".repeat(32) },
		{ observedInvocationId: "a".repeat(31) },
		{ stoppedInvocationId: "0".repeat(32) },
		{ stoppedInvocationId: undefined },
		{ cgroupState: "populated" },
		{ controlGroup: "/system.slice/other.service" },
	])("rejects mismatched completion %j", (change) => {
		const f = fixture();
		expect(() =>
			parseCompanyComputerServiceStopCompletion({ ...f.completion, ...change }, f.command, f.request),
		).toThrow(/^INVALID_OFFICE_SERVICE_STOP_COMPLETION$/);
	});
	it.each(["commandId", "requestSha256", "bootId"] as const)("pins original %s", (key) => {
		const f = fixture(),
			changed = { ...f.command, [key]: key === "requestSha256" ? "0".repeat(64) : randomUUID() };
		expect(() => parseCompanyComputerServiceStopCompletion(f.completion, changed, f.request)).toThrow();
		if (key === "bootId")
			expect(() =>
				parseCompanyComputerServiceStopCompletion({ ...f.completion, command: changed }, changed, f.request),
			).toThrow();
	});
	it.each(["nonce", "same nonce", "invocation", "populated", "extra"])(
		"refuses stale or broadened inspection %s",
		(fault) => {
			const f = fixture(),
				nonce = randomUUID(),
				value = {
					schema: "qorpera.office-service-stop-inspection/v1",
					inspectionId: nonce,
					stop: structuredClone(f.completion),
					cgroupState: "empty",
				};
			if (fault === "nonce") value.inspectionId = randomUUID();
			if (fault === "same nonce") value.inspectionId = f.command.commandId;
			if (fault === "invocation") Object.assign(value.stop, { observedInvocationId: "a".repeat(32) });
			if (fault === "populated") value.cgroupState = "populated";
			if (fault === "extra") Object.assign(value, { mayRestart: true });
			expect(() =>
				parseCompanyComputerServiceStopInspection(
					value,
					fault === "same nonce" ? f.command.commandId : nonce,
					f.completion,
					f.request,
				),
			).toThrow(/^INVALID_OFFICE_SERVICE_STOP_INSPECTION$/);
		},
	);
	it("requires the full retained revocation and snapshots a fresh valid inspection", () => {
		const f = fixture(),
			nonce = randomUUID();
		expect(() =>
			parseCompanyComputerServiceStopRequest({
				...f.request,
				revocation: { ...f.request.revocation, state: "stopped" },
			}),
		).toThrow();
		const result = parseCompanyComputerServiceStopInspection(
			{
				schema: "qorpera.office-service-stop-inspection/v1",
				inspectionId: nonce,
				stop: f.completion,
				cgroupState: "empty",
			},
			nonce,
			f.completion,
			f.request,
		);
		expect(result.stop).toEqual(f.completion);
		expect(Object.isFrozen(result.stop.command)).toBe(true);
	});
});
