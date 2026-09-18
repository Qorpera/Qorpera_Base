import {
	CompanyComputerLifecycleFailure,
	companyComputerFailureDiagnostic,
} from "@qorpera/runtime/cloud-company-computer-diagnostics";
import { describe, expect, it, vi } from "vitest";

describe("closed office failure diagnostics", () => {
	it("surfaces the inner privacy-transition and screen-lifecycle causes of a reconciliation failure", () => {
		const result = companyComputerFailureDiagnostic(
			new CompanyComputerLifecycleFailure(
				"supervision",
				new Error("OFFICE_SERVICE_SUPERVISION_FAILED", {
					cause: new Error("OFFICE_SUPERVISOR_RECONCILIATION_FAILED", {
						cause: new Error("OFFICE_GUEST_DRAIN_UNCONFIRMED", {
							cause: new Error("SCREEN_LIFECYCLE_UNCONFIRMED", { cause: new Error("secret text /etc/path") }),
						}),
					}),
				}),
			),
		);
		expect(result.codes).toEqual([
			"OFFICE_SERVICE_SUPERVISION_FAILED",
			"OFFICE_SUPERVISOR_RECONCILIATION_FAILED",
			"OFFICE_GUEST_DRAIN_UNCONFIRMED",
			"SCREEN_LIFECYCLE_UNCONFIRMED",
		]);
		expect(JSON.stringify(result)).not.toContain("secret");
		expect(
			companyComputerFailureDiagnostic(
				new Error("OFFICE_PHYSICAL_DRAIN_REQUIRED", { cause: new Error("OFFICE_PRIVACY_FENCED") }),
			).codes,
		).toEqual(["OFFICE_PHYSICAL_DRAIN_REQUIRED", "OFFICE_PRIVACY_FENCED"]);
	});
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
	it.each([
		"PRIVATE_SURFACE_AUTHORITY_UNCONFIRMED",
		"PRIVATE_SURFACE_DISPLAY_EXITED",
		"PRIVATE_SURFACE_BROWSER_EXITED",
		"PRIVATE_SURFACE_DRAIN_UNCONFIRMED",
	])("retains private failure class %s without private browser data", (code) => {
		const original = Object.assign(new Error("private login URL and cookies"), { code: "ECONNRESET" });
		const result = companyComputerFailureDiagnostic(
			new Error("OFFICE_GUEST_FAILED", { cause: new Error(code, { cause: original }) }),
		);
		expect(result.codes).toEqual(["OFFICE_GUEST_FAILED", code]);
		expect(result.categories).toEqual(["transport"]);
		expect(JSON.stringify(result)).not.toContain("cookies");
	});
	it("projects only safe-integer stale-status counts from the supervisor budget failure", () => {
		const stale = Object.assign(new Error("OFFICE_SUPERVISOR_STATUS_STALE"), {
			unconfirmedPolls: 16,
			unconfirmedMs: 90000,
		});
		expect(
			companyComputerFailureDiagnostic(new Error("OFFICE_SUPERVISOR_RECONCILIATION_FAILED", { cause: stale })),
		).toEqual({
			schema: "qorpera.office-service-failure/v1",
			stages: [],
			codes: ["OFFICE_SUPERVISOR_RECONCILIATION_FAILED", "OFFICE_SUPERVISOR_STATUS_STALE"],
			categories: ["unknown"],
			staleStatus: { polls: 16, durationMs: 90000 },
		});
		for (const hostile of [
			{ unconfirmedPolls: "16 /run/credentials", unconfirmedMs: 90000 },
			{ unconfirmedPolls: 16, unconfirmedMs: -1 },
			{ unconfirmedPolls: 1.5, unconfirmedMs: 90000 },
		]) {
			const result = companyComputerFailureDiagnostic(
				Object.assign(new Error("OFFICE_SUPERVISOR_STATUS_STALE"), hostile),
			);
			expect(result.codes).toEqual(["OFFICE_SUPERVISOR_STATUS_STALE"]);
			expect(result).not.toHaveProperty("staleStatus");
		}
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
