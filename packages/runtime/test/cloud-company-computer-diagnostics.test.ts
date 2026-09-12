import {
	CompanyComputerLifecycleFailure,
	companyComputerFailureDiagnostic,
} from "@qorpera/runtime/cloud-company-computer-diagnostics";
import { describe, expect, it, vi } from "vitest";

describe("closed office failure diagnostics", () => {
	it("retains useful cause codes while excluding credentials, paths, stacks and arbitrary fields", () => {
		const secret = "Bearer private-token /run/credentials/customer SQL payload";
		const original = Object.assign(new Error(secret), { code: "EACCES", path: secret, token: secret });
		const error = new CompanyComputerLifecycleFailure(
			"startup",
			new Error("OFFICE_SERVICE_START_FAILED", {
				cause: new Error("OFFICE_REGISTRY_UNCONFIRMED", { cause: original }),
			}),
		);
		expect(error.cause).toBeInstanceOf(Error);
		const result = companyComputerFailureDiagnostic(error);
		expect(result).toEqual({
			schema: "qorpera.office-service-failure/v1",
			stages: ["startup"],
			codes: ["OFFICE_SERVICE_START_FAILED", "OFFICE_REGISTRY_UNCONFIRMED"],
			categories: ["filesystem-permission"],
		});
		expect(JSON.stringify(result)).not.toContain(secret);
	});
	it("never invokes hostile accessors, stringifiers or serialization hooks", () => {
		const invoked = vi.fn(() => {
			throw new Error("private-secret");
		});
		const hostile = Object.defineProperties(
			{},
			Object.fromEntries(
				["message", "stage", "code", "category", "cause", "errors", "toJSON", "toString"].map((key) => [
					key,
					{ get: invoked },
				]),
			),
		);
		expect(JSON.stringify(companyComputerFailureDiagnostic(hostile))).toBe(
			'{"schema":"qorpera.office-service-failure/v1","stages":[],"codes":[],"categories":["unknown"]}',
		);
		expect(invoked).not.toHaveBeenCalled();
		const revoked = Proxy.revocable({}, {});
		revoked.revoke();
		expect(companyComputerFailureDiagnostic(revoked.proxy).categories).toEqual(["unknown"]);
	});
	it.each(["OFFICE_REGISTRY_UNCONFIRMED secret", "secret OFFICE_REGISTRY_UNCONFIRMED", "__proto__", "constructor"])(
		"only accepts exact allowlisted values: %s",
		(message) => {
			const result = companyComputerFailureDiagnostic({ message, code: message, stage: message, category: message });
			expect(result.codes).toEqual([]);
			expect(result.stages).toEqual([]);
			expect(result.categories).toEqual(["unknown"]);
		},
	);
	it("bounds aggregate and cyclic chains while preserving distinct lifecycle failures", () => {
		const cycle = new Error("OFFICE_REGISTRY_UNCONFIRMED");
		cycle.cause = cycle;
		const original = new CompanyComputerLifecycleFailure("supervision", cycle);
		const combined = new CompanyComputerLifecycleFailure(
			"service-drain",
			new AggregateError([
				original,
				Object.assign(new Error("private"), { code: "ETIMEDOUT" }),
				...Array.from({ length: 100 }, () => new Error("private")),
			]),
		);
		expect(companyComputerFailureDiagnostic(combined)).toEqual({
			schema: "qorpera.office-service-failure/v1",
			stages: ["service-drain", "supervision"],
			codes: ["OFFICE_REGISTRY_UNCONFIRMED"],
			categories: ["timeout"],
		});
	});
});
