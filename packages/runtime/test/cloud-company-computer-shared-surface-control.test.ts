import { performance } from "node:perf_hooks";
import { CloudCompanyComputerSharedSurfaceControl } from "@qorpera/runtime/cloud-company-computer-shared-surface-control";
import { afterEach, describe, expect, it, vi } from "vitest";
import { computerBinding, computerId, computerScope } from "./fixtures/company-computer.ts";

function fixture() {
	const call = vi.fn(
		async (): Promise<unknown> => ({ state: "authorized", privacyVersion: 2, epoch: 4, validForMs: 5000 }),
	);
	const control = new CloudCompanyComputerSharedSurfaceControl({
		scope: computerScope(),
		computerGeneration: 1,
		control: { call },
	});
	return { call, control, signal: new AbortController().signal };
}
afterEach(() => vi.restoreAllMocks());
describe("shared desktop lifetime authority", () => {
	it("returns current privacy and epoch without minting an input or browser grant", async () => {
		const f = fixture();
		await expect(f.control.check(computerBinding(), f.signal)).resolves.toEqual({ privacyVersion: 2, epoch: 4 });
		expect(f.call).toHaveBeenCalledExactlyOnceWith(
			"qorpera_check_runtime_office_shared_surface",
			{ p_binding: computerBinding() },
			expect.any(AbortSignal),
		);
		f.call.mockRejectedValue(new Error("sensitive SQL revoked"));
		await expect(f.control.check(computerBinding(), f.signal)).rejects.toThrow("SHARED_SURFACE_UNCONFIRMED");
	});
	it.each([{ companyId: computerId(99) }, { computerGeneration: 2 }, { screenOrdinal: 0 }])(
		"rejects incompatible binding %j before RPC",
		async (changed) => {
			const f = fixture();
			await expect(f.control.check({ ...computerBinding(), ...changed }, f.signal)).rejects.toThrow();
			expect(f.call).not.toHaveBeenCalled();
		},
	);
	it.each([
		{ state: "private", privacyVersion: 2, epoch: 4, validForMs: 5000 },
		{ state: "authorized", privacyVersion: -1, epoch: 4, validForMs: 5000 },
		{ state: "authorized", privacyVersion: 2, epoch: 1.5, validForMs: 5000 },
		{ state: "authorized", privacyVersion: 2, epoch: 4, validForMs: 5001 },
		{ state: "authorized", privacyVersion: 2, epoch: 4, validForMs: 0 },
		{ state: "authorized", privacyVersion: 2, epoch: 4, validForMs: 5000, profile: "not lifetime authority" },
	])("rejects invalid authority %j", async (response) => {
		const f = fixture();
		f.call.mockResolvedValue(response);
		await expect(f.control.check(computerBinding(), f.signal)).rejects.toThrow("SHARED_SURFACE_UNCONFIRMED");
	});
	it("rejects authority that expired in transit", async () => {
		const f = fixture();
		vi.spyOn(performance, "now").mockReturnValueOnce(100).mockReturnValue(5100);
		await expect(f.control.check(computerBinding(), f.signal)).rejects.toThrow("SHARED_SURFACE_UNCONFIRMED");
	});
	it("reads exactly the two saved avatar fields for the bound screen and nothing else", async () => {
		const f = fixture();
		f.call.mockResolvedValue({ creature: "rocket", templateId: null });
		await expect(f.control.appearance(computerBinding(), f.signal)).resolves.toEqual({
			creature: "rocket",
			templateId: undefined,
		});
		expect(f.call).toHaveBeenCalledExactlyOnceWith(
			"qorpera_runtime_office_screen_appearance",
			{ p_binding: computerBinding() },
			expect.any(AbortSignal),
		);
		for (const response of [
			null,
			[],
			{ creature: "rocket" },
			{ creature: "rocket", templateId: null, displayName: "not an avatar field" },
			{ creature: 7, templateId: null },
			{ creature: "", templateId: null },
			{ creature: null, templateId: "x".repeat(257) },
		]) {
			f.call.mockResolvedValue(response);
			await expect(f.control.appearance(computerBinding(), f.signal)).rejects.toThrow(
				"SCREEN_APPEARANCE_UNCONFIRMED",
			);
		}
		f.call.mockClear();
		await expect(f.control.appearance({ ...computerBinding(), computerGeneration: 2 }, f.signal)).rejects.toThrow(
			"OFFICE_GENERATION_MISMATCH",
		);
		expect(f.call).not.toHaveBeenCalled();
	});
});
