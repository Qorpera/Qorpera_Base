import { CompanyComputerLinuxDesktopLauncher } from "@qorpera/runtime/cloud-company-computer-linux-desktop";
import { afterEach, describe, expect, it, vi } from "vitest";
import { computerBinding, computerId, computerScope } from "./fixtures/company-computer.ts";

function fixture() {
	return {
		scope: computerScope(),
		computerGeneration: 1,
		layout: {
			workbenchRoot: "/srv/workbench",
			desktopHome: "/srv/desktop",
			screenStateRoot: "/srv/screens",
			browserProfilesRoot: "/srv/profiles",
		},
		workbenchMount: { filesystem: "nfs4", source: "192.0.2.90:/workbench", root: "/", mountPoint: "/srv/workbench" },
		limits: { memoryBytes: 1073741824, pids: 256, cpuQuota: 200000, cpuPeriod: 100000 },
		runtimeRoot: "/run/office-screens",
		boundary: { assertReady: vi.fn(async () => undefined) },
	};
}

afterEach(() => vi.useRealTimers());
describe("Linux desktop admission (real XFCE lifecycle uses the explicit Linux probe)", () => {
	it("drains pending startup before a handle exists and rejects a substituted binding", async () => {
		vi.useFakeTimers();
		const options = fixture();
		options.boundary.assertReady.mockImplementation(() => new Promise(() => {}));
		const launcher = new CompanyComputerLinuxDesktopLauncher(options);
		const starting = launcher.launch(computerBinding(), new AbortController().signal).catch((error) => error);
		await vi.advanceTimersByTimeAsync(0);
		await expect(launcher.drain({ ...computerBinding(), screenId: computerId(99) })).rejects.toThrow(
			"SCREEN_BINDING_MISMATCH",
		);
		let drained = false;
		const draining = launcher.drain(computerBinding()).then(() => {
			drained = true;
		});
		expect(drained).toBe(false);
		await vi.advanceTimersByTimeAsync(5001);
		expect(await starting).toBeInstanceOf(Error);
		await draining;
		expect(drained).toBe(true);
		await launcher.close();
		await expect(launcher.drain(computerBinding())).resolves.toBeUndefined();
	});
	it("requires a canonical private runtime path disjoint from every persistent root", () => {
		for (const runtimeRoot of [
			"/",
			"relative",
			"/run//screens",
			"/run/../screens",
			"/run/screens/",
			"/srv/workbench/tmp",
			"/srv",
			"/run/a\0b",
		])
			expect(() => new CompanyComputerLinuxDesktopLauncher({ ...fixture(), runtimeRoot })).toThrow(
				"UNSAFE_OFFICE_CONTROL_PATH",
			);
	});
	it("requires a finite admitted allocation, exact mount identity and positive generation", () => {
		for (const computerGeneration of [0, -1, 1.5, Infinity])
			expect(() => new CompanyComputerLinuxDesktopLauncher({ ...fixture(), computerGeneration })).toThrow(
				"INVALID_OFFICE_GENERATION",
			);
		for (const limits of [
			{ ...fixture().limits, pids: 0 },
			{ ...fixture().limits, cpuQuota: Infinity },
		])
			expect(() => new CompanyComputerLinuxDesktopLauncher({ ...fixture(), limits })).toThrow(
				"INVALID_OFFICE_COMMAND_LIMITS",
			);
		for (const workbenchMount of [
			{ ...fixture().workbenchMount, source: "" },
			{ ...fixture().workbenchMount, root: "/a\nb" },
		])
			expect(() => new CompanyComputerLinuxDesktopLauncher({ ...fixture(), workbenchMount })).toThrow(
				"INVALID_OFFICE_WORKBENCH_MOUNT",
			);
	});
	it("rejects another company's binding or a stale computer before any guest access", async () => {
		const options = fixture();
		const launcher = new CompanyComputerLinuxDesktopLauncher(options);
		try {
			await expect(
				launcher.launch({ ...computerBinding(), companyId: computerId(900) }, new AbortController().signal),
			).rejects.toThrow("COMPUTER_BINDING_MISMATCH");
			await expect(
				launcher.launch({ ...computerBinding(), computerGeneration: 2 }, new AbortController().signal),
			).rejects.toThrow("OFFICE_GENERATION_MISMATCH");
			expect(options.boundary.assertReady).not.toHaveBeenCalled();
		} finally {
			await launcher.close();
		}
	});
	it("refuses paths and RFB connections before exact desktop readiness", async () => {
		const options = fixture();
		const launcher = new CompanyComputerLinuxDesktopLauncher(options);
		try {
			expect(() => launcher.xSocket(computerBinding())).toThrow("OFFICE_DESKTOP_NOT_READY");
			await expect(launcher.connectRfb(computerBinding(), new AbortController().signal)).rejects.toThrow(
				"OFFICE_DESKTOP_NOT_READY",
			);
			expect(options.boundary.assertReady).not.toHaveBeenCalled();
		} finally {
			await launcher.close();
		}
	});
	it("does not launch after a pre-cancelled request or completed service close", async () => {
		const options = fixture();
		const launcher = new CompanyComputerLinuxDesktopLauncher(options);
		const stop = new AbortController();
		stop.abort();
		await expect(launcher.launch(computerBinding(), stop.signal)).rejects.toThrow();
		await launcher.close();
		await launcher.close();
		await expect(launcher.launch(computerBinding(), new AbortController().signal)).rejects.toThrow();
		expect(options.boundary.assertReady).not.toHaveBeenCalled();
	});
});
