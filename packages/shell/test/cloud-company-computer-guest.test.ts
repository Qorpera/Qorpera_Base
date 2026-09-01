import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { cp, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JsonValue } from "@qorpera/contracts";
import type { BrowserContext, Page } from "playwright-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { planCompanyComputerStateAdoption } from "../src/cloud-company-computer-adoption.ts";
import { COMPANY_COMPUTER_UUID, type CompanyComputerToolContent } from "../src/cloud-company-computer-contract.ts";
import { CompanyComputerGuestEndpoint } from "../src/cloud-company-computer-endpoint.ts";
import {
	assertCompanyComputerGuestLayout,
	type CompanyComputerBrowserAccess,
	type CompanyComputerBrowserSession,
	CompanyComputerGuestAutomation,
	type CompanyComputerGuestBoundary,
	type CompanyComputerGuestCommands,
	type CompanyComputerGuestLayout,
	type CompanyComputerScreenshotPublisher,
	PersistentCompanyComputerBrowser,
} from "../src/cloud-company-computer-guest.ts";
import { CompanyComputerScreenActionGate } from "../src/cloud-company-computer-leases.ts";
import type { CompanyComputerAction } from "../src/cloud-company-computer-tools.ts";
import {
	computerBinding,
	computerDeferred,
	computerEffect,
	computerId,
	computerLease,
	computerOperation,
} from "./fixtures/company-computer.ts";

const roots: string[] = [];
const sessions: CompanyComputerBrowserSession[] = [];
afterEach(async () => {
	for (const session of sessions.splice(0)) await session.close().catch(() => undefined);
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

class FakeBrowserContext extends EventEmitter {
	closed = false;
	readonly close = vi.fn(async () => {
		this.closed = true;
		this.emit("close");
	});
	readonly pages = vi.fn((): Page[] => []);
	readonly newPage = vi.fn(async (): Promise<Page> => {
		throw new Error("NO_FAKE_PAGE");
	});
}

async function profileFixture() {
	const root = await mkdtemp(join(await realpath(tmpdir()), "qorpera-computer-profiles-"));
	roots.push(root);
	const layout = {
		workbenchRoot: join(root, "workbench"),
		desktopHome: join(root, "desktop"),
		screenStateRoot: join(root, "screens"),
		browserProfilesRoot: join(root, "profiles"),
	};
	await Promise.all(Object.values(layout).map((directory) => mkdir(directory)));
	const boundary: CompanyComputerGuestBoundary = { assertReady: vi.fn(async () => undefined) };
	const access: CompanyComputerBrowserAccess = { assertGranted: vi.fn(async () => undefined) };
	const contexts: FakeBrowserContext[] = [];
	const launch = vi.fn(async () => {
		const context = new FakeBrowserContext();
		contexts.push(context);
		return context as unknown as BrowserContext;
	});
	const manager = new PersistentCompanyComputerBrowser({ layout, boundary, access, launch });
	const grant = { profileId: computerId(40), grantId: computerId(41), version: 1 };
	return { root, layout, boundary, access, contexts, launch, manager, grant };
}

describe("persistent browser profile component (fake Chrome, real temporary filesystem)", () => {
	it("opens adopted screen-N bytes under explicit UUID grants and preserves both source and adopted state on restart", async () => {
		const fixture = await profileFixture();
		const legacyRoots = {
			screenStateRoot: join(fixture.root, "legacy-screens"),
			browserProfilesRoot: join(fixture.root, "legacy-chrome"),
		};
		const binding = computerBinding();
		const [plan] = planCompanyComputerStateAdoption({
			scope: binding,
			legacyRoots,
			layout: fixture.layout,
			mappings: [{ legacy: { ...binding, screenOrdinal: 7 }, binding, browserProfile: fixture.grant }],
		});
		if (plan.browser.disposition !== "adopt") throw new Error("EXPECTED_TEST_PROFILE_MAPPING");
		const oldBrowser = join(legacyRoots.browserProfilesRoot, "screen-7");
		const oldDesktop = join(legacyRoots.screenStateRoot, "screen-7");
		await mkdir(join(oldBrowser, "Default"), { recursive: true });
		await mkdir(join(oldDesktop, "config"), { recursive: true });
		const preferences = Buffer.from('{"synthetic_profile_setting":"preserve"}');
		const desktop = Buffer.from('<channel name="fixture"><property name="setting" value="preserve"/></channel>');
		await writeFile(join(oldBrowser, "Default", "Preferences"), preferences);
		await writeFile(join(oldDesktop, "config", "fixture.xml"), desktop);
		fixture.boundary.assertReady = vi.fn(async () => {
			throw new Error("STATE_ADOPTION_PENDING");
		});
		await expect(fixture.manager.open(binding, fixture.grant, new AbortController().signal)).rejects.toThrow(
			"STATE_ADOPTION_PENDING",
		);
		expect(await readdir(fixture.layout.browserProfilesRoot)).toEqual([]);
		expect(fixture.launch).not.toHaveBeenCalled();
		await expect(readFile(join(plan.browser.destination, "Default", "Preferences"))).rejects.toMatchObject({
			code: "ENOENT",
		});
		// Test-only copy of synthetic fixture bytes. Production adoption requires
		// fresh authority, stopped services, inventory/contents checks and a receipt.
		await cp(plan.desktop.source, plan.desktop.destination, { recursive: true, force: false, errorOnExist: true });
		await cp(plan.browser.source, plan.browser.destination, { recursive: true, force: false, errorOnExist: true });
		fixture.boundary.assertReady = vi.fn(async () => undefined);
		fixture.access.assertGranted = vi.fn(async () => {
			throw new Error("PROFILE_GRANT_REVOKED");
		});
		await expect(fixture.manager.open(binding, fixture.grant, new AbortController().signal)).rejects.toThrow(
			"PROFILE_GRANT_REVOKED",
		);
		expect(fixture.launch).not.toHaveBeenCalled();
		fixture.access.assertGranted = vi.fn(async () => undefined);
		for (let restart = 0; restart < 2; restart++) {
			const manager = new PersistentCompanyComputerBrowser(fixture);
			const session = await manager.open(binding, fixture.grant, new AbortController().signal);
			sessions.push(session);
			expect(await readFile(join(plan.browser.destination, "Default", "Preferences"))).toEqual(preferences);
			expect(await readFile(join(plan.desktop.destination, "config", "fixture.xml"))).toEqual(desktop);
			await session.close();
		}
		expect(await readFile(join(oldBrowser, "Default", "Preferences"))).toEqual(preferences);
		expect(await readFile(join(oldDesktop, "config", "fixture.xml"))).toEqual(desktop);
		expect(fixture.access.assertGranted).toHaveBeenCalledWith(fixture.grant, binding, expect.any(AbortSignal));
		expect(fixture.launch).toHaveBeenLastCalledWith(
			plan.browser.destination,
			expect.objectContaining({ display: ":1" }),
		);
	});

	it("reuses the exact authorized profile directory across close and manager restart without copying or deleting bytes", async () => {
		const fixture = await profileFixture();
		const first = await fixture.manager.open(computerBinding(), fixture.grant, new AbortController().signal);
		sessions.push(first);
		await expect(fixture.manager.open(computerBinding(), fixture.grant, new AbortController().signal)).resolves.toBe(
			first,
		);
		const preferences = join(fixture.layout.browserProfilesRoot, fixture.grant.profileId, "Preferences");
		await writeFile(preferences, "synthetic persistent profile state");
		await first.close();
		const restarted = new PersistentCompanyComputerBrowser(fixture);
		sessions.push(await restarted.open(computerBinding(), fixture.grant, new AbortController().signal));
		expect(await readFile(preferences, "utf8")).toBe("synthetic persistent profile state");
		expect(fixture.launch).toHaveBeenCalledTimes(2);
		expect(fixture.launch).toHaveBeenLastCalledWith(
			join(fixture.layout.browserProfilesRoot, fixture.grant.profileId),
			expect.objectContaining({ display: ":1", home: fixture.layout.desktopHome }),
		);
	});

	it("does not lend one active profile to another screen or a substituted grant version", async () => {
		const fixture = await profileFixture();
		sessions.push(await fixture.manager.open(computerBinding(), fixture.grant, new AbortController().signal));
		await expect(
			fixture.manager.open({ ...computerBinding(), screenOrdinal: 2 }, fixture.grant, new AbortController().signal),
		).rejects.toThrow("SCREEN_BINDING_MISMATCH");
		await expect(
			fixture.manager.open(computerBinding(), { ...fixture.grant, version: 2 }, new AbortController().signal),
		).rejects.toThrow("BROWSER_PROFILE_IN_USE");
		expect(fixture.launch).toHaveBeenCalledOnce();
	});

	it("closes the automation channel on grant revocation and on run cancellation", async () => {
		for (const revoke of [true, false]) {
			const fixture = await profileFixture();
			const stop = new AbortController();
			const session = await fixture.manager.open(computerBinding(), fixture.grant, stop.signal);
			sessions.push(session);
			if (revoke) {
				fixture.access.assertGranted = vi.fn(async () => {
					throw new Error("GRANT_REVOKED");
				});
				await expect(session.assertActive(stop.signal)).rejects.toThrow("BROWSER_ACCESS_ENDED");
			} else stop.abort();
			await vi.waitFor(() => expect(fixture.contexts[0].close).toHaveBeenCalledOnce());
		}
	});

	it("refuses symlinked profile storage and an unverified guest before launching Chrome", async () => {
		const fixture = await profileFixture();
		const outside = join(fixture.root, "outside");
		await mkdir(outside);
		await symlink(outside, join(fixture.layout.browserProfilesRoot, fixture.grant.profileId));
		await expect(
			fixture.manager.open(computerBinding(), fixture.grant, new AbortController().signal),
		).rejects.toThrow("UNSAFE_BROWSER_PROFILE_DIRECTORY");
		fixture.boundary.assertReady = vi.fn(async () => {
			throw new Error("CONTAINMENT_UNAVAILABLE");
		});
		await expect(
			fixture.manager.open(computerBinding(), fixture.grant, new AbortController().signal),
		).rejects.toThrow("CONTAINMENT_UNAVAILABLE");
		expect(fixture.launch).not.toHaveBeenCalled();
	});

	it("closes a late browser launch after cancellation and retains a failed-close quarantine", async () => {
		const fixture = await profileFixture();
		const launched = computerDeferred<BrowserContext>();
		const started = computerDeferred<void>();
		const manager = new PersistentCompanyComputerBrowser({
			...fixture,
			launch: async () => {
				started.resolve();
				return launched.promise;
			},
		});
		const stop = new AbortController();
		const pending = manager.open(computerBinding(), fixture.grant, stop.signal);
		await started.promise;
		stop.abort();
		const late = new FakeBrowserContext();
		launched.resolve(late as unknown as BrowserContext);
		await expect(pending).rejects.toThrow("BROWSER_ACCESS_ENDED");
		expect(late.close).toHaveBeenCalledOnce();
		const session = await fixture.manager.open(computerBinding(), fixture.grant, new AbortController().signal);
		sessions.push(session);
		fixture.contexts[0].close.mockRejectedValue(new Error("NOT_REAPED"));
		await expect(session.close()).rejects.toThrow("BROWSER_DRAIN_FAILED");
		await expect(
			fixture.manager.open(computerBinding(), fixture.grant, new AbortController().signal),
		).rejects.toThrow("BROWSER_ACCESS_ENDED");
		expect(fixture.launch).toHaveBeenCalledOnce();
	});

	it("rejects canonical/credential routes and overlapping storage layouts", () => {
		const layout = {
			workbenchRoot: "/srv/workbench",
			desktopHome: "/srv/desktop",
			screenStateRoot: "/srv/screens",
			browserProfilesRoot: "/srv/profiles",
		};
		for (const workbenchRoot of ["/", "/srv/dataset/live", "/srv/credentials", "/srv/../live", "relative"]) {
			expect(() => assertCompanyComputerGuestLayout({ ...layout, workbenchRoot })).toThrow("UNSAFE_COMPUTER_LAYOUT");
		}
		expect(() => assertCompanyComputerGuestLayout({ ...layout, desktopHome: "/srv/workbench/home" })).toThrow(
			"OVERLAPPING_COMPUTER_LAYOUT",
		);
	});
});

// Synthetic capture header, not evidence of a real screenshot or a running desktop.
function captureBytes(): Uint8Array {
	const bytes = Buffer.alloc(33);
	Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
	bytes.writeUInt32BE(13, 8);
	bytes.write("IHDR", 12);
	bytes.writeUInt32BE(1920, 16);
	bytes.writeUInt32BE(1200, 20);
	return bytes;
}

function fakePage() {
	const locator = {
		count: vi.fn(async () => 1),
		getAttribute: vi.fn(async (_name: string): Promise<string | null> => null),
		click: vi.fn(async () => undefined),
		fill: vi.fn(async () => undefined),
		ariaSnapshot: vi.fn(async () => "- button Submit"),
	};
	const page = {
		isClosed: vi.fn(() => false),
		url: vi.fn(() => "https://example.com/"),
		title: vi.fn(async () => "Test page"),
		bringToFront: vi.fn(async (): Promise<void> => undefined),
		goto: vi.fn(async () => undefined),
		locator: vi.fn(() => locator),
		getByRole: vi.fn(() => locator),
		keyboard: { press: vi.fn(async () => undefined) },
		screenshot: vi.fn(async () => captureBytes()),
	};
	return { locator, page };
}

interface BrowserTabList {
	tabs: Array<{ tabId: string; titlePreview: string; urlPreview: string }>;
	selectedTabId: string | null;
	nextAfterTabId: string | null;
}

function tabList(content: CompanyComputerToolContent): BrowserTabList {
	if (content.kind !== "json") throw new Error("EXPECTED_TEST_TAB_LIST");
	return content.value as unknown as BrowserTabList;
}

function automationFixture(withBrowser = true, withCommands = true) {
	const layout: CompanyComputerGuestLayout = {
		workbenchRoot: "/srv/workbench",
		desktopHome: "/srv/desktop",
		screenStateRoot: "/srv/screens",
		browserProfilesRoot: "/srv/profiles",
	};
	const boundary: CompanyComputerGuestBoundary = { assertReady: vi.fn(async () => undefined) };
	const { locator, page } = fakePage();
	const context = new FakeBrowserContext();
	context.pages.mockReturnValue([page as unknown as Page]);
	const browser: CompanyComputerBrowserSession = {
		binding: computerBinding(),
		grant: { profileId: computerId(40), grantId: computerId(41), version: 1 },
		context: context as unknown as BrowserContext,
		assertActive: vi.fn(async () => undefined),
		close: context.close,
	};
	const commands: CompanyComputerGuestCommands = {
		run: vi.fn(async () => ({ code: 0, stdout: "ok", stderr: "" })),
		capturePng: vi.fn(async () => captureBytes()),
	};
	const screenshots: CompanyComputerScreenshotPublisher = {
		publish: vi.fn(async (bytes: Uint8Array) => ({
			assetId: computerId(50),
			sha256: createHash("sha256").update(bytes).digest("hex"),
			bytes: bytes.length,
			mediaType: "image/png" as const,
		})),
	};
	const automation = new CompanyComputerGuestAutomation({
		binding: computerBinding(),
		layout,
		boundary,
		screenshots,
		...(withBrowser ? { browser } : {}),
		...(withCommands ? { commands } : {}),
	});
	const effects = { assertAuthorized: vi.fn(async () => undefined) };
	const gate = new CompanyComputerScreenActionGate();
	const endpoint = new CompanyComputerGuestEndpoint({
		binding: computerBinding(),
		capabilities: ["browser", "desktop", "shell"],
		resourceTarget: {},
		effects,
		gate,
		automation,
		assertScreenReady: async () => undefined,
	});
	const perform = (action: CompanyComputerAction, lease = computerLease(), effect = computerEffect()) =>
		endpoint.perform(
			{ ...computerOperation(), tool: `computer_${action.kind}`, arguments: action as unknown as JsonValue },
			lease,
			effect,
		);
	return { automation, boundary, locator, page, context, browser, commands, screenshots, effects, gate, perform };
}

describe("Playwright/X11/shell adapters (test doubles, never the member machine)", () => {
	it.each(["target", "tab"] as const)(
		"keeps the real profile session usable after a pre-effect %s ambiguity",
		async (ambiguity) => {
			const fixture = automationFixture();
			const second = fakePage();
			const profiles = await profileFixture();
			const browser = await profiles.manager.open(computerBinding(), profiles.grant, new AbortController().signal);
			sessions.push(browser);
			profiles.contexts[0].pages.mockReturnValue(
				ambiguity === "tab"
					? [fixture.page as unknown as Page, second.page as unknown as Page]
					: [fixture.page as unknown as Page],
			);
			fixture.locator.count.mockResolvedValue(2);
			const automation = new CompanyComputerGuestAutomation({
				binding: computerBinding(),
				layout: profiles.layout,
				boundary: profiles.boundary,
				browser,
				screenshots: fixture.screenshots,
			});
			const endpoint = new CompanyComputerGuestEndpoint({
				binding: computerBinding(),
				capabilities: ["browser"],
				resourceTarget: {},
				effects: { assertAuthorized: async () => undefined },
				gate: new CompanyComputerScreenActionGate(),
				automation,
				assertScreenReady: async () => undefined,
			});
			await expect(
				endpoint.perform(
					{
						...computerOperation(),
						arguments: { kind: "browser", action: "click", role: "button", name: "Submit" },
					},
					computerLease(),
					computerEffect(),
				),
			).rejects.toThrow(ambiguity === "tab" ? "BROWSER_TAB_AMBIGUOUS" : "BROWSER_TARGET_AMBIGUOUS");
			expect(fixture.locator.click).not.toHaveBeenCalled();
			expect(profiles.contexts[0].close).not.toHaveBeenCalled();
			if (ambiguity === "tab") {
				const listed = tabList(
					await endpoint.perform(
						{ ...computerOperation(), arguments: { kind: "browser", action: "list_tabs" } },
						computerLease(),
						computerEffect(),
					),
				);
				expect(listed.tabs).toHaveLength(2);
				await endpoint.perform(
					{
						...computerOperation(),
						arguments: { kind: "browser", action: "select_tab", tabId: listed.tabs[1].tabId },
					},
					computerLease(),
					computerEffect(),
				);
				expect(second.page.bringToFront).toHaveBeenCalledOnce();
				expect(fixture.page.bringToFront).not.toHaveBeenCalled();
			}
			await expect(
				endpoint.perform(
					{ ...computerOperation(), logicalOperationKey: "test:inspect" },
					computerLease(),
					computerEffect(),
				),
			).resolves.toMatchObject({
				kind: "json",
				value: { snapshot: "- button Submit" },
			});
			expect(profiles.launch).toHaveBeenCalledOnce();
			if (ambiguity === "tab") {
				expect(second.locator.ariaSnapshot).toHaveBeenCalledOnce();
				expect(fixture.locator.ariaSnapshot).not.toHaveBeenCalled();
			}
			expect(profiles.contexts[0].close).not.toHaveBeenCalled();
		},
	);

	it("lists bounded, paginated tab previews without creating, selecting or navigating a page", async () => {
		const fixture = automationFixture();
		const pages = Array.from({ length: 22 }, (_, index) => {
			const { page } = fakePage();
			page.title.mockResolvedValue(`${index}:${String.fromCharCode(1, 34, 92, 30028).repeat(200)}`);
			page.url.mockReturnValue(`https://example.com/${String.fromCharCode(34, 92, 30028).repeat(200)}`);
			return page;
		});
		fixture.context.pages.mockReturnValue(pages as unknown as Page[]);
		const listed: BrowserTabList["tabs"] = [];
		let afterTabId: string | null = null;
		for (const count of [10, 10, 2]) {
			const result = await fixture.perform({
				kind: "browser",
				action: "list_tabs",
				...(afterTabId ? { afterTabId } : {}),
			});
			const batch = tabList(result);
			expect(batch.tabs).toHaveLength(count);
			expect(batch.selectedTabId).toBeNull();
			// Leave headroom for Step 2's 8 KiB untrusted-result envelope.
			expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(6144);
			for (const tab of batch.tabs) {
				expect(tab.tabId).toMatch(COMPANY_COMPUTER_UUID);
				expect(Buffer.byteLength(JSON.stringify(tab.titlePreview))).toBeLessThanOrEqual(128);
				expect(Buffer.byteLength(JSON.stringify(tab.urlPreview))).toBeLessThanOrEqual(256);
			}
			listed.push(...batch.tabs);
			afterTabId = batch.nextAfterTabId;
		}
		expect(afterTabId).toBeNull();
		expect(new Set(listed.map((tab) => tab.tabId)).size).toBe(22);
		expect(tabList(await fixture.perform({ kind: "browser", action: "list_tabs" })).tabs).toEqual(
			listed.slice(0, 10),
		);
		for (const page of pages) {
			expect(page.bringToFront).not.toHaveBeenCalled();
			expect(page.goto).not.toHaveBeenCalled();
		}
		expect(fixture.context.newPage).not.toHaveBeenCalled();
	});

	it("targets navigation, page input and screenshots at the selected page after reordering and lease renewal", async () => {
		const fixture = automationFixture();
		const second = fakePage();
		fixture.context.pages.mockReturnValue([fixture.page, second.page] as unknown as Page[]);
		const { tabs } = tabList(await fixture.perform({ kind: "browser", action: "list_tabs" }));
		fixture.context.pages.mockReturnValue([second.page, fixture.page] as unknown as Page[]);
		await fixture.perform(
			{ kind: "browser", action: "select_tab", tabId: tabs[1].tabId },
			{ ...computerLease(), validForMs: 10_000 },
		);
		const actions: CompanyComputerAction[] = [
			{ kind: "browser", action: "navigate", url: "https://example.com/selected" },
			{ kind: "browser", action: "fill", role: "textbox", name: "Search", text: "scoped input" },
			{ kind: "browser", action: "press", key: "Enter" },
			{ kind: "browser", action: "click", role: "button", name: "Submit" },
			{ kind: "browser", action: "snapshot" },
			{ kind: "screenshot", surface: "browser" },
		];
		for (const action of actions) await fixture.perform(action);
		expect(second.page.bringToFront).toHaveBeenCalledOnce();
		expect(second.page.goto).toHaveBeenCalledWith("https://example.com/selected", expect.any(Object));
		expect(second.locator.fill).toHaveBeenCalledWith("scoped input", expect.any(Object));
		expect(second.page.keyboard.press).toHaveBeenCalledWith("Enter");
		expect(second.locator.click).toHaveBeenCalledOnce();
		expect(second.locator.ariaSnapshot).toHaveBeenCalledOnce();
		expect(second.page.screenshot).toHaveBeenCalledOnce();
		expect(fixture.page.bringToFront).not.toHaveBeenCalled();
		expect(fixture.page.goto).not.toHaveBeenCalled();
		expect(fixture.locator.fill).not.toHaveBeenCalled();
		expect(fixture.page.keyboard.press).not.toHaveBeenCalled();
		expect(fixture.locator.click).not.toHaveBeenCalled();
		expect(fixture.locator.ariaSnapshot).not.toHaveBeenCalled();
		expect(fixture.page.screenshot).not.toHaveBeenCalled();
		expect(tabList(await fixture.perform({ kind: "browser", action: "list_tabs" })).selectedTabId).toBe(
			tabs[1].tabId,
		);
	});

	it("rejects IDs from another automation session without losing the authorized browser", async () => {
		const fixture = automationFixture();
		const other = automationFixture();
		const foreign = tabList(await other.perform({ kind: "browser", action: "list_tabs" })).tabs[0].tabId;
		await expect(fixture.perform({ kind: "browser", action: "select_tab", tabId: foreign })).rejects.toThrow(
			"BROWSER_TAB_UNAVAILABLE",
		);
		expect(fixture.page.bringToFront).not.toHaveBeenCalled();
		expect(other.page.bringToFront).not.toHaveBeenCalled();
		expect(fixture.context.close).not.toHaveBeenCalled();
		const own = tabList(await fixture.perform({ kind: "browser", action: "list_tabs" })).tabs[0].tabId;
		await fixture.perform({ kind: "browser", action: "select_tab", tabId: own });
		expect(fixture.page.bringToFront).toHaveBeenCalledOnce();
	});

	it.each(["lease", "epoch", "run"] as const)(
		"invalidates tab IDs and selection when the admitted %s changes",
		async (changed) => {
			const fixture = automationFixture();
			const old = tabList(await fixture.perform({ kind: "browser", action: "list_tabs" })).tabs[0].tabId;
			await fixture.perform({ kind: "browser", action: "select_tab", tabId: old });
			const lease = {
				...computerLease(),
				...(changed === "lease" ? { leaseId: computerId(90) } : {}),
				...(changed === "epoch" ? { epoch: 2 } : {}),
				...(changed === "run"
					? { driver: { kind: "agent" as const, runId: computerId(90), staffAgentId: computerId(5) } }
					: {}),
			};
			const effect = computerEffect();
			if (changed === "run") effect.identity = { ...effect.identity, runId: computerId(90) };
			await expect(
				fixture.perform({ kind: "browser", action: "select_tab", tabId: old }, lease, effect),
			).rejects.toThrow("BROWSER_TAB_UNAVAILABLE");
			const fresh = tabList(await fixture.perform({ kind: "browser", action: "list_tabs" }, lease, effect));
			expect(fresh.tabs[0].tabId).not.toBe(old);
			expect(fresh.selectedTabId).toBeNull();
			await fixture.perform({ kind: "browser", action: "select_tab", tabId: fresh.tabs[0].tabId }, lease, effect);
			expect(fixture.context.close).not.toHaveBeenCalled();
		},
	);

	it("rejects a closed tab or pagination cursor and allows a fresh listing", async () => {
		const fixture = automationFixture();
		const second = fakePage();
		fixture.context.pages.mockReturnValue([fixture.page, second.page] as unknown as Page[]);
		const first = tabList(await fixture.perform({ kind: "browser", action: "list_tabs" })).tabs[0].tabId;
		fixture.page.isClosed.mockReturnValue(true);
		await expect(fixture.perform({ kind: "browser", action: "select_tab", tabId: first })).rejects.toThrow(
			"BROWSER_TAB_UNAVAILABLE",
		);
		await expect(fixture.perform({ kind: "browser", action: "list_tabs", afterTabId: first })).rejects.toThrow(
			"BROWSER_TAB_UNAVAILABLE",
		);
		const remaining = tabList(await fixture.perform({ kind: "browser", action: "list_tabs" }));
		expect(remaining.tabs).toHaveLength(1);
		await fixture.perform({ kind: "browser", action: "select_tab", tabId: remaining.tabs[0].tabId });
		expect(second.page.bringToFront).toHaveBeenCalledOnce();
		expect(fixture.context.close).not.toHaveBeenCalled();
	});

	it("tolerates a tab closing while its preview is being read", async () => {
		const fixture = automationFixture();
		const second = fakePage();
		fixture.context.pages.mockReturnValue([fixture.page, second.page] as unknown as Page[]);
		fixture.page.title.mockImplementation(async () => {
			fixture.page.isClosed.mockReturnValue(true);
			throw new Error("PAGE_CLOSED");
		});
		const listed = tabList(await fixture.perform({ kind: "browser", action: "list_tabs" }));
		expect(listed.tabs).toHaveLength(1);
		await fixture.perform({ kind: "browser", action: "select_tab", tabId: listed.tabs[0].tabId });
		expect(second.page.bringToFront).toHaveBeenCalledOnce();
		expect(fixture.context.close).not.toHaveBeenCalled();
	});

	it("returns an empty tab inventory without opening an unsolicited page", async () => {
		const fixture = automationFixture();
		fixture.context.pages.mockReturnValue([]);
		expect(tabList(await fixture.perform({ kind: "browser", action: "list_tabs" }))).toEqual({
			tabs: [],
			selectedTabId: null,
			nextAfterTabId: null,
		});
		expect(fixture.context.newPage).not.toHaveBeenCalled();
	});

	it("withholds tab previews when profile access is revoked during enumeration", async () => {
		const fixture = automationFixture();
		const reading = computerDeferred<void>();
		const title = computerDeferred<string>();
		fixture.page.title.mockImplementation(() => {
			reading.resolve();
			return title.promise;
		});
		const listing = fixture.perform({ kind: "browser", action: "list_tabs" }).catch((error: unknown) => error);
		await reading.promise;
		fixture.browser.assertActive = vi.fn(async () => {
			throw new Error("PROFILE_GRANT_REVOKED");
		});
		title.resolve("must not be returned");
		expect(await listing).toMatchObject({ message: "PROFILE_GRANT_REVOKED" });
		expect(fixture.context.close).toHaveBeenCalledOnce();
	});

	it("rechecks profile access immediately before focusing a selected tab", async () => {
		const fixture = automationFixture();
		const tabId = tabList(await fixture.perform({ kind: "browser", action: "list_tabs" })).tabs[0].tabId;
		vi.mocked(fixture.browser.assertActive)
			.mockResolvedValueOnce(undefined)
			.mockRejectedValueOnce(new Error("PROFILE_GRANT_REVOKED"));
		await expect(fixture.perform({ kind: "browser", action: "select_tab", tabId })).rejects.toThrow(
			"PROFILE_GRANT_REVOKED",
		);
		expect(fixture.page.bringToFront).not.toHaveBeenCalled();
		expect(fixture.context.close).toHaveBeenCalledOnce();
	});

	it("withholds selection success and drains control when the final effect check fails", async () => {
		const fixture = automationFixture();
		const tabId = tabList(await fixture.perform({ kind: "browser", action: "list_tabs" })).tabs[0].tabId;
		fixture.effects.assertAuthorized
			.mockResolvedValueOnce(undefined)
			.mockRejectedValueOnce(new Error("SCREEN_ACCESS_REVOKED"));
		await expect(fixture.perform({ kind: "browser", action: "select_tab", tabId })).rejects.toThrow(
			"SCREEN_ACCESS_REVOKED",
		);
		expect(fixture.page.bringToFront).toHaveBeenCalledOnce();
		expect(fixture.context.close).toHaveBeenCalledOnce();
	});

	it("retains the screen interlock until a cancelled tab selection actually drains", async () => {
		const fixture = automationFixture();
		const tabId = tabList(await fixture.perform({ kind: "browser", action: "list_tabs" })).tabs[0].tabId;
		const focusing = computerDeferred<void>();
		const focused = computerDeferred<void>();
		fixture.page.bringToFront.mockImplementation(() => {
			focusing.resolve();
			return focused.promise;
		});
		const stop = new AbortController();
		const selecting = fixture
			.perform({ kind: "browser", action: "select_tab", tabId }, computerLease(), computerEffect(stop.signal))
			.catch((error: unknown) => error);
		await focusing.promise;
		stop.abort();
		expect(await selecting).toBeInstanceOf(Error);
		expect(fixture.context.close).toHaveBeenCalledOnce();
		await expect(fixture.perform({ kind: "browser", action: "snapshot" })).rejects.toThrow(
			"SCREEN_ACTION_STILL_RUNNING",
		);
		focused.resolve();
		await fixture.gate.fence(computerBinding(), 2, new AbortController().signal);
	});

	it("uses exact page roles, preserves literal text, and blocks password/ambiguous targets", async () => {
		const fixture = automationFixture();
		await fixture.automation.perform(
			{ kind: "browser", action: "fill", role: "textbox", name: "Search", text: "$(not a command)" },
			computerLease(),
			computerEffect(),
		);
		expect(fixture.page.getByRole).toHaveBeenCalledWith("textbox", { name: "Search", exact: true });
		expect(fixture.locator.fill).toHaveBeenCalledWith("$(not a command)", { timeout: 5000 });
		fixture.locator.getAttribute.mockImplementation(async (name) => (name === "type" ? "password" : null));
		await expect(
			fixture.automation.perform(
				{ kind: "browser", action: "fill", role: "textbox", name: "Password", text: "not-a-secret" },
				computerLease(),
				computerEffect(),
			),
		).rejects.toThrow("PRIVATE_SIGN_IN_REQUIRED");
		fixture.locator.count.mockResolvedValue(2);
		await expect(
			fixture.automation.perform(
				{ kind: "browser", action: "click", role: "button", name: "Submit" },
				computerLease(),
				computerEffect(),
			),
		).rejects.toThrow("BROWSER_TARGET_AMBIGUOUS");
		expect(fixture.commands.run).not.toHaveBeenCalled();
	});

	it("requires explicit selection to recover after the target closes, keeping other tabs usable", async () => {
		const fixture = automationFixture();
		const second = fakePage();
		await fixture.perform({ kind: "browser", action: "snapshot" });
		fixture.context.pages.mockReturnValue([second.page] as unknown as Page[]);
		fixture.page.isClosed.mockReturnValue(true);
		await expect(fixture.perform({ kind: "browser", action: "snapshot" })).rejects.toThrow("BROWSER_TARGET_CLOSED");
		const remaining = tabList(await fixture.perform({ kind: "browser", action: "list_tabs" }));
		expect(remaining.selectedTabId).toBeNull();
		// Merely listing the surviving page does not redirect a pending action to it.
		await expect(
			fixture.perform({ kind: "browser", action: "navigate", url: "https://example.com/" }),
		).rejects.toThrow("BROWSER_TARGET_CLOSED");
		expect(second.page.goto).not.toHaveBeenCalled();
		await fixture.perform({ kind: "browser", action: "select_tab", tabId: remaining.tabs[0].tabId });
		await fixture.perform({ kind: "browser", action: "snapshot" });
		expect(second.locator.ariaSnapshot).toHaveBeenCalledOnce();
		expect(fixture.context.close).not.toHaveBeenCalled();
	});

	it("requires verified guest, live profile and exact screen even for shell or pixels", async () => {
		const fixture = automationFixture();
		await expect(
			fixture.automation.perform(
				{ kind: "shell", command: "pwd", timeoutMs: 1000 },
				{ ...computerLease(), binding: { ...computerBinding(), screenOrdinal: 2 } },
				computerEffect(),
			),
		).rejects.toThrow("SCREEN_BINDING_MISMATCH");
		fixture.browser.assertActive = vi.fn(async () => {
			throw new Error("SIGN_IN_PRIVATE");
		});
		await expect(
			fixture.automation.perform({ kind: "desktop", action: "type", text: "x" }, computerLease(), computerEffect()),
		).rejects.toThrow("SIGN_IN_PRIVATE");
		expect(fixture.commands.run).not.toHaveBeenCalled();
		const without = automationFixture(false, false);
		await expect(
			without.automation.perform({ kind: "browser", action: "snapshot" }, computerLease(), computerEffect()),
		).rejects.toThrow("BROWSER_GRANT_REQUIRED");
		await expect(
			without.automation.perform(
				{ kind: "shell", command: "pwd", timeoutMs: 1000 },
				computerLease(),
				computerEffect(),
			),
		).rejects.toThrow("CONTAINED_COMPUTER_COMMANDS_UNAVAILABLE");
	});

	it("sends fixed X11 commands with the assigned display and literal text on stdin", async () => {
		const fixture = automationFixture();
		await fixture.automation.perform(
			{ kind: "desktop", action: "type", text: "$(touch /tmp/should-not-run)" },
			computerLease(),
			computerEffect(),
		);
		expect(fixture.commands.run).toHaveBeenCalledWith(
			expect.objectContaining({
				program: "/usr/bin/xdotool",
				args: ["type", "--clearmodifiers", "--file", "-"],
				stdin: "$(touch /tmp/should-not-run)",
				environment: { DISPLAY: ":1", PATH: "/usr/local/bin:/usr/bin:/bin", LANG: "C.UTF-8" },
				workingDirectory: "/srv/workbench",
			}),
		);
		await fixture.automation.perform(
			{ kind: "desktop", action: "click", x: 42, y: 50, button: "left" },
			computerLease(),
			computerEffect(),
		);
		expect(fixture.commands.run).toHaveBeenLastCalledWith(
			expect.objectContaining({ args: ["mousemove", "--sync", "42", "50", "click", "1"] }),
		);
	});

	it("routes shell only through the injected contained runner with bounded output and no inherited provider environment", async () => {
		const fixture = automationFixture();
		await fixture.automation.perform(
			{ kind: "shell", command: "pwd", timeoutMs: 1000 },
			computerLease(),
			computerEffect(),
		);
		expect(fixture.commands.run).toHaveBeenCalledWith(
			expect.objectContaining({
				program: "/bin/bash",
				args: ["--noprofile", "--norc", "-c", "pwd"],
				workingDirectory: "/srv/workbench",
				timeoutMs: 1000,
				maxOutputBytes: 16384,
				environment: { DISPLAY: ":1", PATH: "/usr/local/bin:/usr/bin:/bin", LANG: "C.UTF-8" },
			}),
		);
		fixture.commands.run = vi.fn(async () => ({ code: 0, stdout: "x".repeat(16_385), stderr: "" }));
		await expect(
			fixture.automation.perform(
				{ kind: "shell", command: "pwd", timeoutMs: 1000 },
				computerLease(),
				computerEffect(),
			),
		).rejects.toThrow("INVALID_COMPUTER_COMMAND_RESULT");
	});

	it("publishes screenshots through immutable receipts and rejects altered digests", async () => {
		const fixture = automationFixture();
		await expect(
			fixture.automation.perform({ kind: "screenshot", surface: "browser" }, computerLease(), computerEffect()),
		).resolves.toMatchObject({
			kind: "json",
			value: { assetId: computerId(50), screenId: computerId(6), mediaType: "image/png" },
		});
		expect(fixture.page.screenshot).toHaveBeenCalledWith(
			expect.objectContaining({ type: "png", mask: [fixture.locator] }),
		);
		fixture.screenshots.publish = vi.fn(async (bytes: Uint8Array) => ({
			assetId: computerId(50),
			sha256: "0".repeat(64),
			bytes: bytes.length,
			mediaType: "image/png" as const,
		}));
		await expect(
			fixture.automation.perform({ kind: "screenshot", surface: "desktop" }, computerLease(), computerEffect()),
		).rejects.toThrow("INVALID_SCREENSHOT_RECEIPT");
		expect(fixture.commands.capturePng).toHaveBeenCalledWith(
			expect.objectContaining({ display: ":1", maxBytes: 16 * 1024 * 1024 }),
		);
	});
});
