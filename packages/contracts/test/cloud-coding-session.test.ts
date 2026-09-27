import { describe, expect, it } from "vitest";
import { CLOUD_CODING_GUEST_ROOTS, cloudCodingSessionLayout } from "../src/cloud-coding-session.ts";

describe("coding session layout inside a member's machine", () => {
	it("derives every path and unit name from the worker id", () => {
		const layout = cloudCodingSessionLayout("12345678-1234-4234-8234-000000000001");
		expect(layout).toEqual({
			workerId: "12345678-1234-4234-8234-000000000001",
			configurationRoot: "/run/qorpera-coding/12345678-1234-4234-8234-000000000001/configuration",
			dataRoot: "/workspace/12345678-1234-4234-8234-000000000001",
			custodyRoot: "/var/lib/qorpera-coding/12345678-1234-4234-8234-000000000001",
			runtimeRoot: "/run/qorpera-coding/12345678-1234-4234-8234-000000000001",
			workspacePath: "/workspace/12345678-1234-4234-8234-000000000001/repository",
			homePath: "/workspace/12345678-1234-4234-8234-000000000001/home",
			cachePath: "/workspace/12345678-1234-4234-8234-000000000001/cache",
			outputRoot: "/var/lib/qorpera-coding/12345678-1234-4234-8234-000000000001/logs",
			slice: "qorpera-coding-12345678123442348234000000000001.slice",
			unitPrefix: "qorpera-coding-12345678123442348234000000000001-",
		});
		expect(Object.isFrozen(layout)).toBe(true);
		expect(Object.isFrozen(CLOUD_CODING_GUEST_ROOTS)).toBe(true);
	});
	it("keeps two sessions apart", () => {
		const a = cloudCodingSessionLayout("12345678-1234-4234-8234-000000000001");
		const b = cloudCodingSessionLayout("12345678-1234-4234-8234-000000000002");
		for (const key of Object.keys(a) as (keyof typeof a)[]) expect(a[key]).not.toBe(b[key]);
	});
	it.each([
		"",
		"../etc",
		"12345678-1234-4234-8234-00000000000",
		"12345678-1234-4234-8234-00000000000G",
		"12345678-1234-0234-8234-000000000001",
	])("refuses %j as a worker id", (id) => {
		expect(() => cloudCodingSessionLayout(id)).toThrow("INVALID_CODING_SESSION");
	});
});
