import { startCompanyComputerLinuxPrivateSurface } from "@qorpera/runtime/cloud-company-computer-linux-private-surface";
import { describe, expect, it, vi } from "vitest";
import { computerBinding, computerId, computerScope } from "./fixtures/company-computer.ts";

function fixture() {
	return {
		scope: computerScope(),
		computerGeneration: 1,
		challenge: {
			scope: computerScope(),
			computerGeneration: 1,
			challengeId: computerId(70),
			version: 1,
			state: "entering" as const,
			memberId: computerId(71),
			profileId: computerId(72),
			profileVersion: 2,
			screenId: computerBinding().screenId,
			drains: [{ state: "draining" as const, drainId: computerId(73), epoch: 2, binding: computerBinding() }],
		},
		layout: {
			workbenchRoot: "/srv/workbench",
			desktopHome: "/srv/desktop",
			screenStateRoot: "/srv/screens",
			browserProfilesRoot: "/srv/profiles",
		},
		limits: { memoryBytes: 1073741824, pids: 256, cpuQuota: 200000, cpuPeriod: 100000 },
		displayRuntimeRoot: "/run/office-screens",
		browserRuntimeRoot: "/run/office-browser",
		privateWorkbenchMount: { filesystem: "tmpfs", source: "tmpfs", root: "/", mountPoint: "/run/office-private" },
		authority: { assertActive: vi.fn(async () => undefined) },
		assertDrained: vi.fn(async () => {
			throw new Error("PHYSICAL_DRAIN_REQUIRED");
		}),
		onFailure: vi.fn(),
		signal: new AbortController().signal,
	};
}

describe("private Linux surface admission (real lifecycle uses --private Linux probe)", () => {
	it.each([
		"/srv/workbench",
		"/srv/desktop",
		"/srv/screens",
		"/srv/profiles",
		"/srv",
		"/srv/workbench/private",
		"/run/office-screens",
		"/run/office-browser/subdir",
	])("rejects private workbench overlapping %s", async (mountPoint) => {
		const f = fixture();
		await expect(
			startCompanyComputerLinuxPrivateSurface({
				...f,
				privateWorkbenchMount: { ...f.privateWorkbenchMount, mountPoint },
			}),
		).rejects.toThrow("PRIVATE_SURFACE_SHARED_PATH");
		expect(f.authority.assertActive).not.toHaveBeenCalled();
	});
	it.each([
		"/srv/workbench",
		"/srv/desktop/private",
		"/run/office-browser",
		"/run",
		"relative",
		"/run//private",
		"/run/a\0b",
	])("rejects display control path %s before starting", async (displayRuntimeRoot) => {
		const f = fixture();
		await expect(startCompanyComputerLinuxPrivateSurface({ ...f, displayRuntimeRoot })).rejects.toThrow(
			"PRIVATE_SURFACE_SHARED_PATH",
		);
		expect(f.authority.assertActive).not.toHaveBeenCalled();
	});
	it("requires a dedicated tmpfs and exact current entry generation", async () => {
		const f = fixture();
		await expect(
			startCompanyComputerLinuxPrivateSurface({
				...f,
				privateWorkbenchMount: { ...f.privateWorkbenchMount, filesystem: "nfs4" },
			}),
		).rejects.toThrow("PRIVATE_SURFACE_TMPFS_REQUIRED");
		await expect(startCompanyComputerLinuxPrivateSurface({ ...f, computerGeneration: 2 })).rejects.toThrow(
			"PRIVATE_SURFACE_CHALLENGE_DIFFERS",
		);
		await expect(
			startCompanyComputerLinuxPrivateSurface({ ...f, challenge: { ...f.challenge, state: "leaving" } }),
		).rejects.toThrow("PRIVATE_SURFACE_CHALLENGE_DIFFERS");
		expect(f.authority.assertActive).not.toHaveBeenCalled();
	});
	it("requires physical drain proof after fresh authority and before filesystem preparation", async () => {
		const f = fixture();
		await expect(startCompanyComputerLinuxPrivateSurface(f)).rejects.toThrow("PHYSICAL_DRAIN_REQUIRED");
		expect(f.authority.assertActive).toHaveBeenCalledOnce();
		expect(f.assertDrained).toHaveBeenCalledExactlyOnceWith(f.challenge, expect.any(AbortSignal));
		expect(f.onFailure).not.toHaveBeenCalled();
	});
	it("does not consult physical resources after cancellation or denied authority", async () => {
		const f = fixture();
		f.authority.assertActive.mockRejectedValue(new Error("PRIVATE_SURFACE_UNCONFIRMED"));
		await expect(startCompanyComputerLinuxPrivateSurface(f)).rejects.toThrow("PRIVATE_SURFACE_UNCONFIRMED");
		expect(f.assertDrained).not.toHaveBeenCalled();
		const stop = new AbortController();
		stop.abort();
		await expect(startCompanyComputerLinuxPrivateSurface({ ...f, signal: stop.signal })).rejects.toThrow();
		expect(f.authority.assertActive).toHaveBeenCalledOnce();
	});
});
