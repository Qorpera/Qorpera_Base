import { describe, expect, it, vi } from "vitest";
import {
	LxdOfficeCodePackageControl,
	type LxdOfficeCodePackageRegistry,
} from "../src/lxd-office-code-package-control.ts";
import { officeCanonical, officeDigest } from "../src/lxd-office-image-provenance.ts";
import { officeCodePackageControlFixture } from "./fixtures/office-code-package-control.ts";

const signal = () => new AbortController().signal;
describe("separate code package SQL authority", () => {
	it("enrolls exact canonical relation and treats authorized status as history without dispatch", async () => {
		const f = officeCodePackageControlFixture(),
			call = vi.fn<LxdOfficeCodePackageRegistry["call"]>(async () => f.status()),
			control = new LxdOfficeCodePackageControl(f.options, { call });
		const enrolled = await control.enroll(signal());
		expect(enrolled.state).toBe("enrolled");
		expect(call.mock.calls[0]).toEqual([
			"qorpera_enroll_office_package_provision",
			{
				p_reset_plan_text: officeCanonical(f.resetPlan),
				p_plan_text: officeCanonical(f.plan),
				p_statement_text: officeCanonical(f.statement),
				p_plan_sha256: officeDigest(f.plan),
				p_provider_capability: f.options.providerCapability,
			},
			expect.any(AbortSignal),
		]);
		call.mockResolvedValue(f.status("authorized"));
		const status = await control.status(signal());
		expect(status.request).toEqual(f.request);
		expect(call).toHaveBeenCalledTimes(2);
		expect(call.mock.calls[1][0]).toBe("qorpera_office_package_provision_status");
		expect(JSON.stringify([enrolled, status])).not.toContain(f.options.providerCapability);
	});
	it.each(["planSha256", "targetManifestSha256"])("rejects changed request %s before SQL", async (key) => {
		const f = officeCodePackageControlFixture(),
			call = vi.fn(),
			control = new LxdOfficeCodePackageControl(f.options, { call });
		await expect(control.dispatch({ ...f.request, [key]: "c".repeat(64) }, signal())).rejects.toThrow();
		expect(call).not.toHaveBeenCalled();
	});
	it.each(["requestSha256", "statement", "capabilityRevision", "targetRevision", "validForMs"])(
		"rejects altered dispatch reply %s",
		async (key) => {
			const f = officeCodePackageControlFixture(),
				reply = {
					...f.dispatch(),
					[key]: key.endsWith("Sha256")
						? "c".repeat(64)
						: key === "statement"
							? { ...f.statement, extra: true }
							: 6000,
				};
			const control = new LxdOfficeCodePackageControl(f.options, { call: async () => reply });
			await expect(control.dispatch(f.request, signal())).rejects.toThrow();
		},
	);
	it("subtracts RPC time from authority and refuses expired replies", async () => {
		const f = officeCodePackageControlFixture(),
			control = new LxdOfficeCodePackageControl(f.options, {
				call: async () => {
					await new Promise((resolve) => setTimeout(resolve, 10));
					return { ...f.dispatch(), validForMs: 1 };
				},
			});
		await expect(control.dispatch(f.request, signal())).rejects.toThrow("CHALLENGE_EXPIRED");
	});
	it("observes and acknowledges exact completed installation with fresh nonce and no installation retry", async () => {
		const f = officeCodePackageControlFixture(),
			nonce = f.id(35),
			call = vi.fn(async (method: string) =>
				method === "qorpera_check_office_package_provision_observation"
					? {
							...f.dispatch(),
							schema: "qorpera.office-code-package-observation-challenge/v1",
							provisionId: f.plan.provisionId,
							observationId: nonce,
						}
					: f.status("installed"),
			);
		const control = new LxdOfficeCodePackageControl(f.options, { call });
		await control.observe(f.request, nonce, signal());
		const done = await control.acknowledge(f.receipt, f.request, nonce, f.sha, signal());
		expect(done.state).toBe("installed");
		expect(call.mock.calls.map((c) => c[0])).toEqual([
			"qorpera_check_office_package_provision_observation",
			"qorpera_ack_office_package_provision",
		]);
		await expect(
			control.acknowledge(
				{ ...f.receipt, installedInventorySha256: "c".repeat(64) },
				f.request,
				nonce,
				f.sha,
				signal(),
			),
		).rejects.toThrow();
		expect(call).toHaveBeenCalledTimes(2);
	});
	it.each(["receiptSha256", "installationEvidenceSha256", "currentPackageRevision", "state"])(
		"refuses inconsistent installed history %s",
		async (key) => {
			const f = officeCodePackageControlFixture(),
				reply = {
					...f.status("installed"),
					[key]: key === "state" ? "enrolled" : key === "currentPackageRevision" ? 0 : null,
				};
			const control = new LxdOfficeCodePackageControl(f.options, { call: async () => reply });
			await expect(control.status(signal())).rejects.toThrow();
		},
	);
});
