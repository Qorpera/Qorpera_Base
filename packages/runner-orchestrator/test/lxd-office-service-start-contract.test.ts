import {
	parseCompanyComputerServiceInspection,
	parseCompanyComputerServiceStartCompletion,
	parseCompanyComputerServiceStartRequest,
} from "@qorpera/contracts";
import { describe, expect, it } from "vitest";
import { serviceStartId as id, officeServiceStartFixture } from "./fixtures/office-service-start.ts";

describe("closed service start and inspection evidence", () => {
	it("binds the original command, freezes nested evidence and does not retain caller objects", () => {
		const f = officeServiceStartFixture();
		const input = structuredClone(f.completion);
		const parsed = parseCompanyComputerServiceStartCompletion(input, f.command, f.request);
		Object.assign(input.command, { commandId: id(99) });
		expect(parsed.command.commandId).toBe(f.command.commandId);
		expect(Object.isFrozen(parsed)).toBe(true);
		expect(Object.isFrozen(parsed.command)).toBe(true);
		const inspection = parseCompanyComputerServiceInspection(
			{ schema: "qorpera.office-service-inspection/v1", inspectionId: id(6), start: parsed },
			id(6),
			f.completion,
			f.request,
		);
		expect(Object.isFrozen(inspection.start)).toBe(true);
	});
	it.each([
		{ schema: "old" },
		{ extra: "secret" },
		{ command: {} },
		{ activationId: id(99) },
		{ configurationCompletionSha256: "0".repeat(64) },
		{ configurationSha256: "0".repeat(64) },
		{ serviceInvocationId: "0".repeat(32) },
		{ serviceInvocationId: "a".repeat(31) },
		{ mainPid: 0 },
		{ mainPid: -1 },
		{ mainPid: 1.5 },
		{ mainPid: Number.MAX_SAFE_INTEGER + 1 },
		{ controlGroup: "/system.slice/other.service" },
	])("refuses malformed/substituted completion %j", (change) => {
		const f = officeServiceStartFixture();
		expect(() =>
			parseCompanyComputerServiceStartCompletion({ ...f.completion, ...change }, f.command, f.request),
		).toThrow(/^INVALID_OFFICE_SERVICE_START_COMPLETION$/);
	});
	it.each(["bootId", "commandId", "requestSha256"] as const)("pins retained command %s", (field) => {
		const f = officeServiceStartFixture();
		const changed = { ...f.command, [field]: field === "requestSha256" ? "0".repeat(64) : id(99) };
		expect(() => parseCompanyComputerServiceStartCompletion(f.completion, changed, f.request)).toThrow();
	});
	it("refuses colliding configuration/preparation commands and changed boot even if supplied as expected", () => {
		const f = officeServiceStartFixture();
		for (const change of [{ commandId: id(2) }, { commandId: id(3) }, { bootId: id(99) }]) {
			const command = { ...f.command, ...change };
			expect(() =>
				parseCompanyComputerServiceStartCompletion({ ...f.completion, command }, command, f.request),
			).toThrow();
		}
	});
	it.each(["schema", "nonce", "same nonce", "unknown", "invocation", "pid", "group"])(
		"refuses inspection %s substitution",
		(change) => {
			const f = officeServiceStartFixture();
			const value = {
				schema: "qorpera.office-service-inspection/v1",
				inspectionId: id(6),
				start: structuredClone(f.completion),
			};
			if (change === "schema") value.schema = "old";
			if (change === "nonce") value.inspectionId = id(7);
			if (change === "same nonce") value.inspectionId = f.command.commandId;
			if (change === "unknown") Object.assign(value, { extra: "never expose" });
			if (change === "invocation") Object.assign(value.start, { serviceInvocationId: "b".repeat(32) });
			if (change === "pid") Object.assign(value.start, { mainPid: value.start.mainPid + 1 });
			if (change === "group") Object.assign(value.start, { controlGroup: "/other" });
			expect(() =>
				parseCompanyComputerServiceInspection(
					value,
					change === "same nonce" ? f.command.commandId : id(6),
					f.completion,
					f.request,
				),
			).toThrow(/^INVALID_OFFICE_SERVICE_INSPECTION$/);
		},
	);
	it.each(["extra", "receipt", "config", "boot", "ports", "hash"])("refuses unbound request %s", (fault) => {
		const value = structuredClone(officeServiceStartFixture().request);
		if (fault === "extra") Object.assign(value, { extra: true });
		if (fault === "receipt") Object.assign(value.attestation, { adoptionReceiptSha256: "0".repeat(64) });
		if (fault === "config") Object.assign(value.attestation, { configurationSha256: "0".repeat(64) });
		if (fault === "boot") Object.assign(value.attestation, { bootId: id(99) });
		if (fault === "ports") Object.assign(value.attestation, { nativePort: value.attestation.viewerPort });
		if (fault === "hash") Object.assign(value, { configurationCompletionSha256: "bad" });
		expect(() => parseCompanyComputerServiceStartRequest(value)).toThrow(/^INVALID_OFFICE_SERVICE_START_REQUEST$/);
	});
});
