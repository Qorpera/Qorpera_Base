import {
	parseCompanyComputerBootServiceInspection,
	parseCompanyComputerBootServiceStartCompletion,
	parseCompanyComputerBootServiceStartRequest,
} from "@qorpera/contracts";
import { describe, expect, it } from "vitest";
import { bootServiceStartFixture } from "../../runtime/test/fixtures/company-computer-boot-service-start.ts";

const nonce = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
describe("retained boot service-start wire contract", () => {
	it("binds prepared successor metadata, new configuration and a distinct invocation", () => {
		const f = bootServiceStartFixture();
		expect(parseCompanyComputerBootServiceStartRequest(f.request)).toEqual(f.request);
		expect(parseCompanyComputerBootServiceStartCompletion(f.startCompletion, f.startCommand, f.request)).toEqual(
			f.startCompletion,
		);
		expect(
			parseCompanyComputerBootServiceInspection(
				{ schema: "qorpera.office-boot-service-inspection/v1", inspectionId: nonce, start: f.startCompletion },
				nonce,
				f.startCompletion,
				f.request,
			).start,
		).toEqual(f.startCompletion);
		expect(Object.isFrozen(f.request.successor.request.attestation)).toBe(true);
	});
	it.each(["schema", "configurationCompletionSha256", "extra"])("rejects malformed request %s", (key) => {
		const f = bootServiceStartFixture(),
			request = structuredClone(f.request) as unknown as Record<string, unknown>;
		request[key] = "invalid";
		expect(() => parseCompanyComputerBootServiceStartRequest(request)).toThrow(
			"INVALID_OFFICE_BOOT_SERVICE_START_REQUEST",
		);
	});
	it.each(["bootIntentId", "activationId", "bootObservationSha256", "adoptionReceiptSha256"])(
		"rejects mismatched configuration %s",
		(key) => {
			const f = bootServiceStartFixture(),
				request = structuredClone(f.request);
			(request.configuration as unknown as Record<string, unknown>)[key] = key.endsWith("Id")
				? nonce
				: "f".repeat(64);
			expect(() => parseCompanyComputerBootServiceStartRequest(request)).toThrow(
				"INVALID_OFFICE_BOOT_SERVICE_START_REQUEST",
			);
		},
	);
	it.each(["ready", "active"])("refuses %s metadata as a new root start packet", (state) => {
		const f = bootServiceStartFixture(),
			request = structuredClone(f.request);
		Object.assign(request.successor, { state, serviceInvocationId: "c".repeat(32), readinessFresh: true });
		expect(() => parseCompanyComputerBootServiceStartRequest(request)).toThrow(
			"INVALID_OFFICE_BOOT_SERVICE_START_REQUEST",
		);
	});
	it.each([null, [], Object.create(null), 12, "request"])("refuses a non-record request %j", (value) =>
		expect(() => parseCompanyComputerBootServiceStartRequest(value)).toThrow(
			"INVALID_OFFICE_BOOT_SERVICE_START_REQUEST",
		),
	);
	it.each([
		"schema",
		"bootIntentId",
		"activationId",
		"configurationCompletionSha256",
		"configurationSha256",
		"serviceInvocationId",
		"mainPid",
		"controlGroup",
		"extra",
	])("rejects changed completion %s", (key) => {
		const f = bootServiceStartFixture();
		expect(() =>
			parseCompanyComputerBootServiceStartCompletion(
				{ ...f.startCompletion, [key]: "invalid" },
				f.startCommand,
				f.request,
			),
		).toThrow("INVALID_OFFICE_BOOT_SERVICE_START_COMPLETION");
	});
	it.each([0, -1, 1.2, NaN, Infinity])("rejects invalid main PID %s", (mainPid) => {
		const f = bootServiceStartFixture();
		expect(() =>
			parseCompanyComputerBootServiceStartCompletion({ ...f.startCompletion, mainPid }, f.startCommand, f.request),
		).toThrow("INVALID_OFFICE_BOOT_SERVICE_START_COMPLETION");
	});
	it("refuses the predecessor invocation and the configuration command", () => {
		const f = bootServiceStartFixture();
		expect(() =>
			parseCompanyComputerBootServiceStartCompletion(
				{
					...f.startCompletion,
					serviceInvocationId: f.request.successor.request.predecessor.startup.serviceInvocationId,
				},
				f.startCommand,
				f.request,
			),
		).toThrow("INVALID_OFFICE_BOOT_SERVICE_START_COMPLETION");
		expect(() =>
			parseCompanyComputerBootServiceStartCompletion(
				{ ...f.startCompletion, command: f.request.configuration.command },
				f.request.configuration.command,
				f.request,
			),
		).toThrow("INVALID_OFFICE_BOOT_SERVICE_START_COMPLETION");
	});
	it.each(["nonce", "mainPid", "invocation", "schema", "extra"])("refuses changed inspection %s", (kind) => {
		const f = bootServiceStartFixture(),
			inspection = {
				schema: "qorpera.office-boot-service-inspection/v1",
				inspectionId: nonce,
				start: { ...f.startCompletion },
			};
		if (kind === "nonce") inspection.inspectionId = f.startCommand.commandId;
		if (kind === "mainPid") inspection.start.mainPid = 99;
		if (kind === "invocation") inspection.start.serviceInvocationId = "c".repeat(32);
		if (kind === "schema") inspection.schema = "qorpera.office-service-inspection/v1";
		if (kind === "extra") Object.assign(inspection, { extra: true });
		expect(() => parseCompanyComputerBootServiceInspection(inspection, nonce, f.startCompletion, f.request)).toThrow(
			"INVALID_OFFICE_BOOT_SERVICE_INSPECTION",
		);
	});
});
