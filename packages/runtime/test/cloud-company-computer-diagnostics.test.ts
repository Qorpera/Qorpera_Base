import {
	CompanyComputerLifecycleFailure,
	companyComputerFailureDiagnostic,
	createCompanyComputerViewerRefusalReporter,
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

describe("viewer refusal journal lines (closed codes, rate limited, nothing about the member)", () => {
	function reporter(state?: Parameters<typeof createCompanyComputerViewerRefusalReporter>[0]["state"]) {
		const lines: string[] = [];
		const clock = { now: 1_000_000 };
		const report = createCompanyComputerViewerRefusalReporter({
			write: (line) => lines.push(line),
			now: () => clock.now,
			state,
		});
		return { lines, clock, report, records: () => lines.map((line) => JSON.parse(line)) };
	}

	it("writes the closed code chain and the admission facts, and drops every free-text message", () => {
		const f = reporter(() => ({
			serving: true,
			supervisor: { failed: false, unconfirmedMs: 4200, unconfirmedPolls: 4, confirmedRevision: 17 },
		}));
		f.report(
			"connect",
			new Error("SHARED_SURFACE_UNCONFIRMED", {
				cause: Object.assign(new Error("member 7f3e token eyJhbGciOi wss://office.example.test/view"), {
					code: "ECONNRESET",
					cause: new Error("OFFICE_PRIVACY_FENCED"),
				}),
			}),
		);
		expect(f.records()).toEqual([
			{
				schema: "qorpera.office-viewer-refusal/v1",
				stage: "connect",
				codes: ["SHARED_SURFACE_UNCONFIRMED", "OFFICE_PRIVACY_FENCED"],
				categories: ["transport"],
				suppressed: 0,
				serving: true,
				supervisor: { failed: false, unconfirmedMs: 4200, unconfirmedPolls: 4, confirmedRevision: 17 },
			},
		]);
		expect(f.lines[0]).not.toMatch(/7f3e|eyJ|office\.example|wss:/);
	});

	it("holds a retrying client to one line per stage and code per window and counts what it held", () => {
		const f = reporter();
		for (let attempt = 0; attempt < 500; attempt++) {
			f.report("redeem", new Error("OFFICE_SERVICE_NOT_READY"));
			f.clock.now += 10;
		}
		expect(f.lines).toHaveLength(1);
		// Another cause, or the same cause at another stage, is not hidden by the first.
		f.report("redeem", new Error("OFFICE_SUPERVISOR_STATUS_STALE"));
		f.report("upgrade", new Error("VIEWER_UPGRADE_ORIGIN"));
		f.report("handshake", new Error("anything a client could provoke"));
		f.report("handshake", new Error("another unlisted message"));
		expect(f.records().map((record) => [record.stage, record.codes])).toEqual([
			["redeem", ["OFFICE_SERVICE_NOT_READY"]],
			["redeem", ["OFFICE_SUPERVISOR_STATUS_STALE"]],
			["upgrade", ["VIEWER_UPGRADE_ORIGIN"]],
			["handshake", []],
		]);
		f.clock.now += 10_000;
		f.report("redeem", new Error("OFFICE_SERVICE_NOT_READY"));
		expect(f.records().at(-1)).toMatchObject({
			codes: ["OFFICE_SERVICE_NOT_READY"],
			suppressed: 499,
			serving: false,
		});
		expect(f.records().at(-1)).not.toHaveProperty("supervisor");
	});

	it("never lets a failing writer, state reader or hostile error reach the viewer path", () => {
		const hostile = Object.defineProperty(new Error("OFFICE_SERVICE_NOT_READY"), "cause", {
			get() {
				throw new Error("getter must not run");
			},
		});
		const broken = createCompanyComputerViewerRefusalReporter({
			write: () => {
				throw new Error("journal unavailable");
			},
			state: () => {
				throw new Error("state unavailable");
			},
		});
		expect(() => broken("redeem", hostile)).not.toThrow();
		expect(() => broken("not-a-stage" as "redeem", new Error("OFFICE_SERVICE_NOT_READY"))).not.toThrow();
		expect(() => createCompanyComputerViewerRefusalReporter({ write: () => undefined, windowMs: 0 })).toThrow(
			"INVALID_VIEWER_REFUSAL_WINDOW",
		);
	});
});
