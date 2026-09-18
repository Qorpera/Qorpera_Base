import { describe, expect, it } from "vitest";
import { COMPANY_COMPUTER_SERVICE_SOFTWARE_PATH } from "../src/company-computer-service-software.ts";
import {
	companyComputerServiceSoftwareMeasurementText,
	parseCompanyComputerServiceSoftwareInvocationEvidence as evidence,
	parseCompanyComputerServiceSoftwareInvocationChallenge as parse,
} from "../src/company-computer-service-software-measurement.ts";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const challenge = () => ({
	schema: "qorpera.office-software-invocation-challenge/v1",
	challengeId: id(1),
	activationId: id(2),
	revision: 1,
	capabilityRevision: 2,
	validForMs: 4991,
	startup: {
		scope: { companyId: id(3), environmentId: id(4), companyComputerId: id(5), logicalComputerId: id(6) },
		computerGeneration: 1,
		allocationId: id(7),
		instanceSha256: "a".repeat(64),
		imageSha256: "b".repeat(64),
		bootstrapSha256: "c".repeat(64),
		bootId: id(8),
		configurationSha256: "d".repeat(64),
		serviceInvocationId: "e".repeat(32),
	},
	service: { path: COMPANY_COMPUTER_SERVICE_SOFTWARE_PATH, bytes: 1024, sha256: "f".repeat(64) },
});
describe("software invocation measurement contract", () => {
	it("preserves remaining lifetime and capability revision in canonical immutable challenge data", () => {
		const input = challenge(),
			parsed = parse(input);
		expect(parsed.validForMs).toBe(4991);
		expect(parsed.capabilityRevision).toBe(2);
		expect(companyComputerServiceSoftwareMeasurementText(parse(JSON.parse(JSON.stringify(input))))).toBe(
			companyComputerServiceSoftwareMeasurementText(parsed),
		);
		input.startup.scope.companyId = id(10);
		expect(parsed.startup.scope.companyId).toBe(id(3));
		expect(Object.isFrozen(parsed.service)).toBe(true);
	});
	it.each([
		{ revision: -1 },
		{ revision: 9007199254740991 },
		{ capabilityRevision: 0 },
		{ capabilityRevision: 1.5 },
		{ validForMs: 0 },
		{ validForMs: 5001 },
		{ service: { ...challenge().service, path: "/tmp/service" } },
		{ service: { ...challenge().service, bytes: 33554433 } },
		{ service: { ...challenge().service, extra: true } },
		{ providerCapability: "PRIVATE_CANARY" },
	])("rejects malformed or broadened data %j", (patch) => {
		expect(() => parse({ ...challenge(), ...patch })).toThrow();
	});
	it("rejects symbols and getters before invoking untrusted accessors", () => {
		expect(() => parse({ ...challenge(), [Symbol("hidden")]: true })).toThrow();
		let accessed = false;
		const input = challenge();
		Object.defineProperty(input.startup.scope, "companyId", {
			get() {
				accessed = true;
				return id(3);
			},
			enumerable: true,
		});
		expect(() => parse(input)).toThrow();
		expect(accessed).toBe(false);
	});
	it("binds safe evidence to nonce, activation, full startup, target revision and capability revision", () => {
		const expected = parse(challenge()),
			{ validForMs: _ms, ...fields } = expected;
		const value = {
			...fields,
			schema: "qorpera.office-software-invocation-evidence/v1",
			mainPid: 42,
			controlGroup: "/system.slice/qorpera-company-computer.service",
			configurationCompletionSha256: "1".repeat(64),
			serviceStartCompletionSha256: "2".repeat(64),
		};
		expect(evidence(value, expected).mainPid).toBe(42);
		for (const patch of [
			{ challengeId: id(99) },
			{ revision: 0 },
			{ capabilityRevision: 3 },
			{ mainPid: 0 },
			{ controlGroup: "/wrong" },
			{ startup: { ...expected.startup, serviceInvocationId: "3".repeat(32) } },
			{ configurationCompletionSha256: "bad" },
			{ secret: "PRIVATE_CANARY" },
		])
			expect(() => evidence({ ...value, ...patch }, expected)).toThrow();
	});
});
