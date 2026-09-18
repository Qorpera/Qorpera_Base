import { createCompanyComputerLinuxBrowserLaunch } from "@qorpera/runtime/cloud-company-computer-linux-browser";
import { describe, expect, it, vi } from "vitest";
import { computerBinding, computerId, computerScope } from "./fixtures/company-computer.ts";

function fixture() {
	const options = {
		scope: computerScope(),
		computerGeneration: 1,
		layout: {
			workbenchRoot: "/srv/workbench",
			desktopHome: "/srv/desktop",
			screenStateRoot: "/srv/screens",
			browserProfilesRoot: "/srv/profiles",
		},
		limits: { memoryBytes: 2147483648, pids: 512, cpuQuota: 200000, cpuPeriod: 100000 },
		workbenchMount: { mountPoint: "/srv/workbench", root: "/", filesystem: "nfs4", source: "192.0.2.90:/workbench" },
		runtimeRoot: "/run/office-browser",
		boundary: { assertReady: vi.fn(async () => undefined) },
		access: { assertGranted: vi.fn(async () => undefined) },
		xSocket: vi.fn(() => "/run/screens/first/x11/X1"),
	};
	const grant = { profileId: computerId(81), grantId: computerId(82), version: 1 };
	const input = {
		binding: computerBinding(),
		grant,
		display: ":1",
		home: "/srv/desktop",
		signal: new AbortController().signal,
	};
	return { options, input, directory: `/srv/profiles/${grant.profileId}` };
}

describe("contained browser launch admission", () => {
	it("requires a separate canonical runtime directory and finite admitted allocation", () => {
		const f = fixture();
		for (const runtimeRoot of ["/", "/srv/profiles/tmp", "/srv", "relative", "/run/../tmp", "/run/office\0browser"])
			expect(() => createCompanyComputerLinuxBrowserLaunch({ ...f.options, runtimeRoot })).toThrow();
		expect(() =>
			createCompanyComputerLinuxBrowserLaunch({ ...f.options, limits: { ...f.options.limits, pids: 0 } }),
		).toThrow();
		expect(() => createCompanyComputerLinuxBrowserLaunch({ ...f.options, computerGeneration: 0 })).toThrow();
	});
	it("denies substituted companies, generations, profiles and displays before guest access", async () => {
		const f = fixture();
		const launch = createCompanyComputerLinuxBrowserLaunch(f.options);
		for (const input of [
			{ ...f.input, binding: { ...f.input.binding, companyId: computerId(99) } },
			{ ...f.input, binding: { ...f.input.binding, computerGeneration: 2 } },
			{ ...f.input, display: ":2" },
			{ ...f.input, home: "/srv/profiles" },
			{ ...f.input, grant: { ...f.input.grant, profileId: "../desktop" } },
			{ ...f.input, grant: { ...f.input.grant, version: 0 } },
		])
			await expect(launch(f.directory, input)).rejects.toThrow();
		await expect(launch("/srv/profiles/another-profile", f.input)).rejects.toThrow();
		expect(f.options.boundary.assertReady).not.toHaveBeenCalled();
		expect(f.options.access.assertGranted).not.toHaveBeenCalled();
		expect(f.options.xSocket).not.toHaveBeenCalled();
	});
	it("refuses an already cancelled launch before filesystem or authority work", async () => {
		const f = fixture();
		const launch = createCompanyComputerLinuxBrowserLaunch(f.options);
		await expect(launch(f.directory, { ...f.input, signal: AbortSignal.abort() })).rejects.toThrow();
		expect(f.options.boundary.assertReady).not.toHaveBeenCalled();
	});
});
