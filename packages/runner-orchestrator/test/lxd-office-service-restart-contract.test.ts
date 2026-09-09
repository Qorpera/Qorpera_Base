import {
	parseCompanyComputerServiceRestartCompletion,
	parseCompanyComputerServiceRestartRequest,
} from "@qorpera/contracts";
import { describe, expect, it } from "vitest";
import { officeServiceRestartFixture } from "./fixtures/office-service-restart.ts";
import { serviceStartId as id } from "./fixtures/office-service-start.ts";

describe("protected restart packet", () => {
	it("owns the nested history and requires a new activation with the same configuration", () => {
		const f = officeServiceRestartFixture(),
			input = structuredClone(f.request);
		const parsed = parseCompanyComputerServiceRestartRequest(input);
		Object.assign(input.acknowledgement.request.startup.scope, { companyId: id(99) });
		Object.assign(input.start.attestation, { activationId: id(99) });
		expect(parsed).toEqual(f.request);
		expect(parsed.start.configuration).toEqual(f.initial.request.configuration);
		expect(parsed.start.attestation.activationId).not.toEqual(parsed.stop.revocation.request.activationId);
		for (const value of [
			parsed,
			parsed.start.attestation,
			parsed.stop.revocation.request.startup.scope,
			parsed.acknowledgement.inspection.stop.command,
			parsed.successor.request.predecessor,
		])
			expect(Object.isFrozen(value)).toBe(true);
	});
	it.each([
		"extra",
		"schema",
		"hash",
		"unprepared",
		"fresh",
		"invocation",
		"ack-clock",
		"ack-scope",
		"attestation",
		"predecessor",
		"reused-activation",
		"boot",
		"action",
		"populated",
		"missing-inspection",
		"missing-successor",
	])("rejects inconsistent %s", (fault) => {
		const request = structuredClone(officeServiceRestartFixture().request);
		if (fault === "extra") Object.assign(request, { mayStart: true });
		if (fault === "schema") Object.assign(request, { schema: "old" });
		if (fault === "hash") Object.assign(request, { stopCompletionSha256: "X".repeat(64) });
		if (fault === "unprepared")
			Object.assign(request.successor, {
				state: "active",
				serviceInvocationId: "d".repeat(32),
				readinessFresh: true,
			});
		if (fault === "fresh") Object.assign(request.successor, { readinessFresh: true });
		if (fault === "invocation") Object.assign(request.successor, { serviceInvocationId: "d".repeat(32) });
		if (fault === "ack-clock") Object.assign(request.acknowledgement, { acknowledgedAtMs: 1501 });
		if (fault === "ack-scope") Object.assign(request.acknowledgement.request.startup.scope, { companyId: id(99) });
		if (fault === "attestation") Object.assign(request.start.attestation, { activationId: id(99) });
		if (fault === "predecessor") Object.assign(request.successor.request.predecessor, { transitionId: id(99) });
		if (fault === "reused-activation")
			Object.assign(request.successor.request.attestation, {
				activationId: request.stop.revocation.request.activationId,
			});
		if (fault === "boot") Object.assign(request.successor.request.attestation, { bootId: id(99) });
		if (fault === "action") Object.assign(request.successor.request.predecessor, { action: "reboot" });
		if (fault === "populated") Object.assign(request.acknowledgement.inspection, { cgroupState: "populated" });
		if (fault === "missing-inspection") Object.assign(request.acknowledgement, { inspection: null });
		if (fault === "missing-successor") Object.assign(request, { successor: null });
		expect(() => parseCompanyComputerServiceRestartRequest(request)).toThrow(
			/^INVALID_OFFICE_SERVICE_RESTART_REQUEST$/,
		);
	});
	it.each(["fromServiceInvocationId", "observedInvocationId", "stoppedInvocationId"] as const)(
		"refuses reuse of %s",
		(key) => {
			const f = officeServiceRestartFixture();
			expect(() =>
				parseCompanyComputerServiceRestartCompletion(
					{ ...f.completion, serviceInvocationId: f.request.acknowledgement.inspection.stop[key] },
					f.command,
					f.request,
				),
			).toThrow(/^INVALID_OFFICE_SERVICE_RESTART_COMPLETION$/);
		},
	);
	it.each(["stop", "preparation", "configuration"])("refuses reuse of the %s command", (kind) => {
		const f = officeServiceRestartFixture();
		const commandId =
			kind === "stop"
				? f.request.acknowledgement.inspection.stop.command.commandId
				: kind === "preparation"
					? f.request.start.configuration.preparation.commandId
					: f.request.start.configuration.command.commandId;
		const command = { ...f.command, commandId };
		expect(() =>
			parseCompanyComputerServiceRestartCompletion({ ...f.completion, command }, command, f.request),
		).toThrow(/^INVALID_OFFICE_SERVICE_RESTART_COMPLETION$/);
	});
	it.each([
		{ activationId: id(99) },
		{ configurationSha256: "d".repeat(64) },
		{ configurationCompletionSha256: "d".repeat(64) },
		{ mainPid: 0 },
		{ controlGroup: "/other.service" },
		{ extra: true },
	])("refuses mismatched completion %j", (change) => {
		const f = officeServiceRestartFixture();
		expect(() =>
			parseCompanyComputerServiceRestartCompletion({ ...f.completion, ...change }, f.command, f.request),
		).toThrow(/^INVALID_OFFICE_SERVICE_RESTART_COMPLETION$/);
	});
});
