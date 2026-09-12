import { describe, expect, it } from "vitest";
import {
	officeCodePackageDeadline,
	parseOfficeCodePackageProbe,
} from "../../../deploy/lxd-company-computer-guest/office-code-package-control.ts";
import { replacePackageCode } from "../../../deploy/lxd-company-computer-guest/office-code-package-files.ts";

const probe = () =>
	parseOfficeCodePackageProbe({
		schema: "qorpera.office-code-package-probe/v1",
		purpose: "install",
		probeId: "a733543e-9b18-4623-b4cc-28a3d4d8a3fb",
		provisionId: "c2857f22-b4f3-4e16-8dcd-ab10262983a5",
		packetSha256: "a".repeat(64),
		bootId: "94bcf4e6-9284-4b32-bd68-965f99e47d3f",
		challengeId: "d9257fc2-4319-4999-a6c9-5a646bd78f09",
		nonce: "9419bdac-ffcd-4d30-ac59-6d3b4a15a533",
		monotonicNs: "1000000000",
	});
describe("code package authority", () => {
	it("consumes time elapsed before SQL rather than starting at delayed dispatch", () => {
		let now = 1000000000n;
		const p = probe(),
			assert = officeCodePackageDeadline(p, p.nonce, 5000, () => now);
		expect(assert).not.toThrow();
		now = 5999999999n;
		expect(assert).not.toThrow();
		now = 6000000000n;
		expect(assert).toThrow("EXPIRED");
		expect(officeCodePackageDeadline(p, p.nonce, 5000, () => now)).toThrow("EXPIRED");
	});
	it("rejects a rolled-back guest monotonic clock", () => {
		const p = probe();
		expect(officeCodePackageDeadline(p, p.nonce, 5000, () => 999999999n)).toThrow("EXPIRED");
	});
	it.each([0, -1, 5001, 1.5, Number.NaN, Infinity])("rejects unbounded remaining lifetime %s", (ms) => {
		const p = probe();
		expect(() => officeCodePackageDeadline(p, p.nonce, ms)).toThrow("AUTHORITY");
	});
	it("rejects a different nonce", () => {
		const p = probe();
		expect(() => officeCodePackageDeadline(p, p.challengeId, 5000)).toThrow("AUTHORITY");
	});
	it.each(["0", "-1", "1.5", "Infinity", "1".repeat(25)])("rejects invalid monotonic origin %s", (monotonicNs) => {
		expect(() => parseOfficeCodePackageProbe({ ...probe(), monotonicNs })).toThrow("PROBE");
	});
	it("rejects extra authority-bearing input", () => {
		expect(() => parseOfficeCodePackageProbe({ ...probe(), authorized: true })).toThrow();
	});
	it.each(["arbitrary.mjs", "../../etc/config.cjs", "qorpera-company-computer.service", "office-browser-child.mjs"])(
		"rejects non-allowlisted write before any filesystem effect: %s",
		async (file) => {
			let called = false;
			await expect(
				replacePackageCode(
					file,
					Buffer.from("ignored"),
					null,
					async () => {
						called = true;
					},
					() => {},
				),
			).rejects.toThrow("CODE_PACKAGE_TARGET");
			expect(called).toBe(false);
		},
	);
});
