import { createHash, randomUUID } from "node:crypto";
import {
	COMPANY_COMPUTER_SERVICE_SOFTWARE_PATH,
	companyComputerServiceSoftwareMeasurementText,
	parseCompanyComputerServiceSoftwareInvocationEvidence,
	parseCompanyComputerStartupIdentity,
} from "@qorpera/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	acknowledgeLxdOfficeSoftwareInvocation,
	type LxdOfficeSoftwareInvocationRegistry,
} from "../src/lxd-office-software-invocation-control.ts";
import { officeSoftwareFixture } from "./fixtures/office-software.ts";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
afterEach(() => vi.restoreAllMocks());
function fixture() {
	const f = officeSoftwareFixture();
	const options = {
		activationId: f.plan.successorActivationId,
		startup: parseCompanyComputerStartupIdentity({
			...f.plan.predecessor.startup,
			serviceInvocationId: "d".repeat(32),
		}),
		expectedRevision: 1,
		expectedService: { ...f.statement.next.service, path: COMPANY_COMPUTER_SERVICE_SOFTWARE_PATH },
		providerCapability: "1234567890abcdef".repeat(4),
		inspectionDeadline: performance.now() + 5000,
	};
	const registry = vi.fn<LxdOfficeSoftwareInvocationRegistry["call"]>(async (method, args, signal) => {
		signal.throwIfAborted();
		expect(args.p_provider_capability).toBe(options.providerCapability);
		if (method === "qorpera_check_office_software_invocation")
			return {
				schema: "qorpera.office-software-invocation-challenge/v1",
				challengeId: args.p_challenge_id,
				activationId: options.activationId,
				startup: options.startup,
				revision: 1,
				capabilityRevision: 2,
				service: options.expectedService,
				validForMs: 5000,
			};
		return {
			schema: "qorpera.office-software-measurement/v1",
			activationId: options.activationId,
			revision: 1,
			state: "measured",
		};
	});
	const physical = vi.fn<Parameters<typeof acknowledgeLxdOfficeSoftwareInvocation>[2]>(async (challenge) => {
		const { validForMs: _remaining, ...binding } = challenge;
		const evidence = parseCompanyComputerServiceSoftwareInvocationEvidence(
			{
				...binding,
				schema: "qorpera.office-software-invocation-evidence/v1",
				mainPid: 700,
				controlGroup: "/system.slice/qorpera-company-computer.service",
				configurationCompletionSha256: "a".repeat(64),
				serviceStartCompletionSha256: "b".repeat(64),
			},
			challenge,
		);
		return { evidence, evidenceSha256: hash(companyComputerServiceSoftwareMeasurementText(evidence)) };
	});
	return {
		options,
		registry,
		physical,
		run: () =>
			acknowledgeLxdOfficeSoftwareInvocation(options, { call: registry }, physical, new AbortController().signal),
	};
}
describe("independent provider invocation acknowledgement", () => {
	it("binds fresh capability revision, exact measured bytes and canonical evidence digest before ack", async () => {
		const f = fixture(),
			result = await f.run();
		expect(result.evidence.capabilityRevision).toBe(2);
		expect(result.evidence.startup).toEqual(f.options.startup);
		expect(f.registry.mock.calls.map(([method]) => method)).toEqual([
			"qorpera_check_office_software_invocation",
			"qorpera_ack_office_software_invocation",
		]);
		expect(f.registry.mock.calls[1][1].p_evidence_sha256).toBe(result.evidenceSha256);
		expect(JSON.stringify(result)).not.toContain(f.options.providerCapability);
		expect(result.deadline).toBeLessThanOrEqual(f.options.inspectionDeadline);
	});
	it.each(["startup", "service", "revision", "activationId", "challengeId", "capabilityRevision"])(
		"refuses changed %s before measurement",
		async (key) => {
			const f = fixture(),
				original = f.registry.getMockImplementation()!;
			f.registry.mockImplementationOnce(async (...args) => ({
				...((await original(...args)) as Record<string, unknown>),
				[key]: key.endsWith("Id") ? randomUUID() : key === "capabilityRevision" ? 0 : "changed",
			}));
			await expect(f.run()).rejects.toThrow("OFFICE_SOFTWARE_INVOCATION_UNCONFIRMED");
			expect(f.physical).not.toHaveBeenCalled();
		},
	);
	it.each(["digest", "invocation", "capability"])(
		"rejects changed physical %s and never acknowledges",
		async (fault) => {
			const f = fixture(),
				original = f.physical.getMockImplementation()!;
			f.physical.mockImplementation(async (...args) => {
				const result = await original(...args);
				if (fault === "digest") return { ...result, evidenceSha256: "0".repeat(64) };
				return {
					...result,
					evidence: {
						...(result.evidence as Record<string, unknown>),
						...(fault === "capability"
							? { capabilityRevision: 1 }
							: { startup: f.options.startup, activationId: randomUUID() }),
					},
				};
			});
			await expect(f.run()).rejects.toThrow();
			expect(f.registry).toHaveBeenCalledTimes(1);
		},
	);
	it("does not extend the outer inspection deadline for a later challenge", async () => {
		let now = 1000;
		vi.spyOn(performance, "now").mockImplementation(() => now);
		const f = fixture();
		f.options.inspectionDeadline = now + 1000;
		const original = f.physical.getMockImplementation()!;
		f.physical.mockImplementation(async (...args) => {
			expect(args[1]).toBe(2000);
			now = 2000;
			return original(...args);
		});
		await expect(f.run()).rejects.toThrow();
		expect(f.registry).toHaveBeenCalledTimes(1);
	});
	it("does not acknowledge or replay a failed physical observation", async () => {
		const f = fixture();
		f.physical.mockRejectedValue(new Error(f.options.providerCapability));
		await expect(f.run()).rejects.toThrow(/^OFFICE_SOFTWARE_INVOCATION_UNCONFIRMED$/);
		expect(f.physical).toHaveBeenCalledOnce();
		expect(f.registry).toHaveBeenCalledTimes(1);
	});
});
