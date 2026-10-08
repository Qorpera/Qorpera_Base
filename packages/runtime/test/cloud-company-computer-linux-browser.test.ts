import { readFileSync } from "node:fs";
import {
	COMPANY_COMPUTER_BROWSER_ARGUMENTS,
	companyComputerBrowserSandboxArgs,
	createCompanyComputerLinuxBrowserLaunch,
	tidyCompanyComputerBrowserTabs,
} from "@qorpera/runtime/cloud-company-computer-linux-browser";
import { companyComputerLinuxSandboxArgs } from "@qorpera/runtime/cloud-company-computer-linux-host";
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
	it("allows only the new-tab routes while keeping other internal pages blocked", () => {
		const policy = JSON.parse(
			readFileSync(
				new URL("../../../deploy/lxd-company-computer-guest/qorpera-browser-policy.json", import.meta.url),
				"utf8",
			),
		);
		expect(policy.URLAllowlist).toEqual(["chrome://newtab/", "chrome://new-tab-page/"]);
		expect(policy.URLBlocklist).toEqual([
			"file://*",
			"chrome://*",
			"chrome-untrusted://*",
			"devtools://*",
			"javascript://*",
			"view-source:*",
		]);
		// Server names stay visible to the node's agent exit.
		expect(policy.EncryptedClientHelloEnabled).toBe(false);
	});

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

	it("gives Chromium's shared memory a 1 GiB /tmp while other namespaces keep 64 MiB", () => {
		// The browser keeps --disable-dev-shm-usage, so its shared memory lives in /tmp.
		expect(COMPANY_COMPUTER_BROWSER_ARGUMENTS).toContain("--disable-dev-shm-usage");
		const browser = companyComputerBrowserSandboxArgs();
		const tmp = browser.indexOf("/tmp");
		expect(browser.slice(tmp - 3, tmp + 1)).toEqual(["--size", "1073741824", "--tmpfs", "/tmp"]);
		// Chromium's nested sandbox needs user namespaces; only the browser namespace allows them.
		expect(browser).not.toContain("--disable-userns");
		expect(browser).not.toContain("--assert-userns-disabled");
		const other = companyComputerLinuxSandboxArgs();
		expect(other.slice(-4)).toEqual(["--size", "67108864", "--tmpfs", "/tmp"]);
		expect(other).toContain("--disable-userns");
		expect(other).toContain("--assert-userns-disabled");
		for (const size of [0, -1, 1.5, Number.NaN, 2 ** 53])
			expect(() => companyComputerLinuxSandboxArgs(size)).toThrow();
	});

	const startupUrl = "about:blank#qorpera-startup-test";
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
		const evaluate = vi.fn(async () => undefined);
		const browser = {
			newBrowserCDPSession: vi.fn(async () => ({ send, detach })),
			contexts: () => [
				{
					pages: () =>
						targetInfos
							.filter((target) => target.type === "page")
							.map((target) => ({ url: () => target.url, evaluate })),
				},
			],
		};
		const closed = (): string[] =>
			send.mock.calls.filter(([method]) => method === "Target.closeTarget").map(([, args]) => args!.targetId);
		return { browser: browser as never, send, detach, closed, evaluate, targetInfos };
	}

	it("closes only this launch's marked tab, preserving every user blank or restored page", async () => {
		const piled = chromium([
			"https://httpbin.org/cookies",
			"about:blank",
			startupUrl,
			"chrome://newtab/",
			"chrome://new-tab-page/",
			"",
			"about:blank#qorpera-startup-earlier",
		]);
		await tidyCompanyComputerBrowserTabs(piled.browser, startupUrl, new AbortController().signal);
		expect(piled.closed()).toEqual(["T2"]);
		expect(piled.send.mock.calls.map(([method]) => method)).toEqual([
			"Target.getTargets",
			"Target.getTargets",
			"Target.closeTarget",
		]);
		expect(piled.detach).toHaveBeenCalledOnce();
	});

	it("keeps the only tab and removes its marker without navigating it", async () => {
		const fresh = chromium([startupUrl, { type: "service_worker", url: startupUrl }]);
		await tidyCompanyComputerBrowserTabs(fresh.browser, startupUrl, new AbortController().signal);
		expect(fresh.closed()).toEqual([]);
		expect(fresh.evaluate).toHaveBeenCalledOnce();
		expect(fresh.evaluate).toHaveBeenCalledWith(expect.any(Function), startupUrl);
	});

	it("does nothing when only user tabs or an earlier startup marker exist", async () => {
		const existing = chromium(["about:blank", "chrome://newtab/", "", "about:blank#qorpera-startup-earlier"]);
		await tidyCompanyComputerBrowserTabs(existing.browser, startupUrl, new AbortController().signal);
		expect(existing.closed()).toEqual([]);
		expect(existing.evaluate).not.toHaveBeenCalled();
		expect(existing.send).toHaveBeenCalledOnce();
	});

	it("keeps its placeholder if the other page closed after discovery", async () => {
		const remaining = chromium([startupUrl]);
		remaining.send.mockResolvedValueOnce({
			targetInfos: [...remaining.targetInfos, { targetId: "other", type: "page", url: "https://example.com/" }],
		});
		await tidyCompanyComputerBrowserTabs(remaining.browser, startupUrl, new AbortController().signal);
		expect(remaining.closed()).toEqual([]);
		expect(remaining.evaluate).toHaveBeenCalledOnce();
	});

	it("does not close a startup tab that navigated after discovery", async () => {
		const moved = chromium(["https://example.com/", startupUrl]);
		moved.send.mockResolvedValueOnce({ targetInfos: moved.targetInfos.map((target) => ({ ...target })) });
		moved.targetInfos[1].url = "https://example.com/edited";
		await tidyCompanyComputerBrowserTabs(moved.browser, startupUrl, new AbortController().signal);
		expect(moved.closed()).toEqual([]);
		expect(moved.evaluate).not.toHaveBeenCalled();
	});

	it.each([1, 2])("does not issue late cleanup commands after target read %i times out", async (read) => {
		vi.useFakeTimers();
		try {
			const late = chromium(["https://example.com/", startupUrl]);
			if (read === 2) late.send.mockResolvedValueOnce({ targetInfos: late.targetInfos });
			let finish!: (value: { targetInfos: typeof late.targetInfos }) => void;
			late.send.mockImplementationOnce(
				() =>
					new Promise((resolve) => {
						finish = resolve;
					}),
			);
			const cleaning = tidyCompanyComputerBrowserTabs(late.browser, startupUrl, new AbortController().signal);
			await vi.advanceTimersByTimeAsync(3001);
			await cleaning;
			finish({ targetInfos: late.targetInfos });
			await vi.runAllTimersAsync();
			expect(late.closed()).toEqual([]);
			expect(late.send).toHaveBeenCalledTimes(read);
			expect(late.detach).toHaveBeenCalledOnce();
		} finally {
			vi.useRealTimers();
		}
	});

	it("is tidying only: a browser that refuses or an ended launch changes nothing and never throws", async () => {
		const refusing = chromium(["https://example.com/", startupUrl]);
		refusing.send.mockImplementation(async (method: string) => {
			if (method === "Target.getTargets")
				return {
					targetInfos: [
						{ targetId: "T1", type: "page", url: startupUrl },
						{ targetId: "T0", type: "page", url: "https://example.com/" },
					],
				};
			throw new Error("Target closed");
		});
		await expect(
			tidyCompanyComputerBrowserTabs(refusing.browser, startupUrl, new AbortController().signal),
		).resolves.toBeUndefined();
		expect(refusing.detach).toHaveBeenCalledOnce();

		const ended = new AbortController();
		ended.abort();
		const late = chromium(["https://example.com/", "about:blank"]);
		await expect(tidyCompanyComputerBrowserTabs(late.browser, startupUrl, ended.signal)).resolves.toBeUndefined();
		expect(late.closed()).toEqual([]);
	});
});
