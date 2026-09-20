import {
	COMPANY_COMPUTER_BROWSER_ARGUMENTS,
	createCompanyComputerLinuxBrowserLaunch,
	tidyCompanyComputerBrowserTabs,
} from "@qorpera/runtime/cloud-company-computer-linux-browser";
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

describe("what a member sees when the company browser opens", () => {
	it("hides the Chrome for Testing bar and names the window without weakening the browser", () => {
		expect(COMPANY_COMPUTER_BROWSER_ARGUMENTS).toContain("--disable-infobars");
		expect(COMPANY_COMPUTER_BROWSER_ARGUMENTS).toContain("--class=qorpera-browser");
		expect(COMPANY_COMPUTER_BROWSER_ARGUMENTS).toContain("--start-maximized");
		expect(COMPANY_COMPUTER_BROWSER_ARGUMENTS).toContain("--remote-debugging-pipe");
		for (const argument of COMPANY_COMPUTER_BROWSER_ARGUMENTS)
			expect(argument).not.toMatch(
				/^--(no-sandbox|disable-setuid-sandbox|disable-web-security|test-type|enable-automation|ignore-certificate-errors|allow-running-insecure-content|disable-site-isolation-trials|remote-debugging-port|kiosk)\b/,
			);
		expect(Object.isFrozen(COMPANY_COMPUTER_BROWSER_ARGUMENTS)).toBe(true);
	});

	function chromium(urls: (string | { url: string; type: string })[]) {
		const targetInfos = urls.map((entry, index) =>
			typeof entry === "string"
				? { targetId: `T${index}`, type: "page", url: entry }
				: { targetId: `T${index}`, ...entry },
		);
		const send = vi.fn(async (method: string, _args?: { targetId: string }) =>
			method === "Target.getTargets" ? { targetInfos } : { success: true },
		);
		const detach = vi.fn(async () => undefined);
		const browser = { newBrowserCDPSession: vi.fn(async () => ({ send, detach })) };
		const closed = (): string[] =>
			send.mock.calls.filter(([method]) => method === "Target.closeTarget").map(([, args]) => args!.targetId);
		return { browser: browser as never, send, detach, closed };
	}

	it("keeps the pages the company had open and closes the blank tabs that piled up", async () => {
		// The capture of 20 September: one real page and a blank tab per earlier start.
		const piled = chromium(["https://httpbin.org/cookies", "about:blank", "about:blank"]);
		await tidyCompanyComputerBrowserTabs(piled.browser, new AbortController().signal);
		expect(piled.closed()).toEqual(["T1", "T2"]);
		expect(piled.send.mock.calls.map(([method]) => method)).toEqual([
			"Target.getTargets",
			"Target.closeTarget",
			"Target.closeTarget",
		]);
		expect(piled.detach).toHaveBeenCalledOnce();

		const newTabs = chromium(["chrome://newtab/", "https://example.com/", "chrome://new-tab-page/", ""]);
		await tidyCompanyComputerBrowserTabs(newTabs.browser, new AbortController().signal);
		expect(newTabs.closed()).toEqual(["T0", "T2", "T3"]);
	});

	it("leaves exactly one clean tab when nothing else is open, and never touches what is not a tab", async () => {
		const fresh = chromium(["about:blank"]);
		await tidyCompanyComputerBrowserTabs(fresh.browser, new AbortController().signal);
		expect(fresh.closed()).toEqual([]);

		const blanks = chromium([
			"about:blank",
			{ type: "service_worker", url: "about:blank" },
			"chrome://newtab/",
			"about:blank",
		]);
		await tidyCompanyComputerBrowserTabs(blanks.browser, new AbortController().signal);
		expect(blanks.closed()).toEqual(["T2", "T3"]);

		// A page that only looks like a blank address is a page.
		const near = chromium(["about:blank#notes", "https://example.com/about:blank", "about:blank"]);
		await tidyCompanyComputerBrowserTabs(near.browser, new AbortController().signal);
		expect(near.closed()).toEqual(["T2"]);
	});

	it("is tidying only: a browser that refuses or an ended launch changes nothing and never throws", async () => {
		const refusing = chromium(["https://example.com/", "about:blank", "about:blank"]);
		refusing.send.mockImplementation(async (method: string) => {
			if (method === "Target.getTargets")
				return {
					targetInfos: [
						{ targetId: "T1", type: "page", url: "about:blank" },
						{ targetId: "T0", type: "page", url: "https://example.com/" },
					],
				};
			throw new Error("Target closed");
		});
		await expect(
			tidyCompanyComputerBrowserTabs(refusing.browser, new AbortController().signal),
		).resolves.toBeUndefined();
		expect(refusing.detach).toHaveBeenCalledOnce();

		const ended = new AbortController();
		ended.abort();
		const late = chromium(["https://example.com/", "about:blank"]);
		await expect(tidyCompanyComputerBrowserTabs(late.browser, ended.signal)).resolves.toBeUndefined();
		expect(late.closed()).toEqual([]);
	});
});
