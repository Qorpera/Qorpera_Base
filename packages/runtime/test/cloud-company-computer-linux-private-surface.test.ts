import { EventEmitter } from "node:events";
import { companyComputerFailureDiagnostic } from "@qorpera/runtime/cloud-company-computer-diagnostics";
import { startCompanyComputerLinuxPrivateSurface } from "@qorpera/runtime/cloud-company-computer-linux-private-surface";
import { afterEach, describe, expect, it, vi } from "vitest";
import { computerBinding, computerDeferred, computerId, computerScope } from "./fixtures/company-computer.ts";

const physical = vi.hoisted(() => ({ display: vi.fn(), browser: vi.fn() }));
vi.mock("node:fs/promises", async (original) => ({
	...(await original<typeof import("node:fs/promises")>()),
	mkdir: vi.fn(async () => undefined),
	readdir: vi.fn(async () => []),
	rm: vi.fn(async () => undefined),
}));
vi.mock("../src/cloud-company-computer-linux-host.ts", async (original) => ({
	...(await original<typeof import("../src/cloud-company-computer-linux-host.ts")>()),
	openCompanyComputerLinuxDirectory: vi.fn(async () => ({ close: async () => undefined })),
	assertCompanyComputerWorkbenchMount: vi.fn(async () => undefined),
}));
vi.mock("../src/cloud-company-computer-linux-private-display.ts", () => ({
	startCompanyComputerLinuxPrivateDisplay: physical.display,
}));
vi.mock("../src/cloud-company-computer-linux-browser.ts", () => ({
	createCompanyComputerLinuxBrowserLaunch: () => physical.browser,
}));
afterEach(() => vi.useRealTimers());

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
		assertDrained: vi.fn(async (): Promise<void> => {
			throw new Error("PHYSICAL_DRAIN_REQUIRED");
		}),
		onFailure: vi.fn(),
		signal: new AbortController().signal,
	};
}

describe("private Linux surface admission (real lifecycle uses --private Linux probe)", () => {
	it.each(["authority", "display", "browser"] as const)(
		"retains distinct %s failure cause while still draining the private lifetime",
		async (kind) => {
			vi.useFakeTimers();
			const f = fixture();
			f.assertDrained.mockResolvedValue(undefined);
			const exited = computerDeferred<void>();
			const displayClose = vi.fn(async () => undefined);
			const browserClose = vi.fn(async () => undefined);
			const context = Object.assign(new EventEmitter(), { browser: () => ({ isConnected: () => true }) });
			physical.display.mockResolvedValue({
				xSocket: "/run/fixture-X1",
				exited: exited.promise,
				close: displayClose,
				fence: vi.fn(),
			});
			physical.browser.mockResolvedValue({ context, close: browserClose });
			const surface = await startCompanyComputerLinuxPrivateSurface(f);
			const cause = Object.assign(new Error("private cookie contents"), { code: "ECONNRESET" });
			if (kind === "authority") {
				f.authority.assertActive.mockRejectedValue(cause);
				await vi.advanceTimersByTimeAsync(1000);
			} else if (kind === "display") exited.reject(cause);
			else context.emit("close");
			await surface.closed;
			const code =
				kind === "authority"
					? "PRIVATE_SURFACE_AUTHORITY_UNCONFIRMED"
					: kind === "display"
						? "PRIVATE_SURFACE_DISPLAY_EXITED"
						: "PRIVATE_SURFACE_BROWSER_EXITED";
			expect(f.onFailure).toHaveBeenCalledOnce();
			const reported = f.onFailure.mock.calls[0][0];
			expect(reported.message).toBe(code);
			if (kind !== "browser") expect(reported.cause).toBe(cause);
			expect(companyComputerFailureDiagnostic(reported).codes).toContain(code);
			expect(JSON.stringify(companyComputerFailureDiagnostic(reported))).not.toContain("cookie");
			expect(displayClose).toHaveBeenCalledOnce();
			expect(browserClose).toHaveBeenCalledOnce();
			await surface.close();
		},
	);
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
