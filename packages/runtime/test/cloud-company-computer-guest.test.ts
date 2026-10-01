import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { cp, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	COMPANY_COMPUTER_UUID,
	type CompanyComputerToolContent,
} from "@qorpera/cloud-client/cloud-company-computer-contract";
import type { JsonValue } from "@qorpera/contracts";
import { planCompanyComputerStateAdoption } from "@qorpera/runtime/cloud-company-computer-adoption";
import { CompanyComputerBrowserNetworkPausedError } from "@qorpera/runtime/cloud-company-computer-browser-control";
import { CompanyComputerGuestEndpoint } from "@qorpera/runtime/cloud-company-computer-endpoint";
import type { CompanyComputerFileExportPublisher } from "@qorpera/runtime/cloud-company-computer-file-transfers";
import {
	assertCompanyComputerGuestLayout,
	type CompanyComputerBrowserAccess,
	type CompanyComputerBrowserLaunch,
	type CompanyComputerBrowserSession,
	CompanyComputerGuestAutomation,
	type CompanyComputerGuestBoundary,
	type CompanyComputerGuestCommands,
	type CompanyComputerGuestLayout,
	type CompanyComputerScreenshotPublisher,
	PersistentCompanyComputerBrowser,
} from "@qorpera/runtime/cloud-company-computer-guest";
import { CompanyComputerScreenActionGate } from "@qorpera/runtime/cloud-company-computer-leases";
import { COMPANY_COMPUTER_PRIVATE_FIELD_SELECTOR } from "@qorpera/runtime/cloud-company-computer-private-fields";
import { CompanyComputerRegistryUnansweredError } from "@qorpera/runtime/cloud-company-computer-registry-http";
import type { CompanyComputerAction } from "@qorpera/runtime/cloud-company-computer-tools";
import type { BrowserContext, Page } from "playwright-core";
import { afterEach, describe, expect, it, vi } from "vitest";
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
		return { context: context as unknown as BrowserContext, close: context.close };
	});
	const manager = new PersistentCompanyComputerBrowser({ layout, boundary, access, launch });
	const grant = { profileId: computerId(40), grantId: computerId(41), version: 1 };
	return { root, layout, boundary, access, contexts, launch, manager, grant };
}

describe("persistent browser profile component (fake Chrome, real temporary filesystem)", () => {
	it("keeps the window when nobody entitled is present or no answer came, and closes it on a refusal", async () => {
		const fixture = await profileFixture();
		const session = await fixture.manager.open(computerBinding(), fixture.grant, new AbortController().signal);
		for (const reason of [
			new CompanyComputerBrowserNetworkPausedError(),
			new CompanyComputerRegistryUnansweredError(new Error("request timed out")),
		]) {
			fixture.access.assertGranted = vi.fn(async () => {
				throw reason;
			});
			await expect(session.assertActive(new AbortController().signal)).rejects.toThrow("BROWSER_ACCESS_UNCONFIRMED");
			expect(fixture.contexts[0].closed).toBe(false);
			expect(session.isEnded?.()).toBe(false);
		}
		fixture.access.assertGranted = vi.fn(async () => {
			throw new Error("OFFICE_REGISTRY_UNCONFIRMED", { cause: new Error("denied") });
		});
		await expect(session.assertActive(new AbortController().signal)).rejects.toThrow("BROWSER_ACCESS_ENDED");
		await vi.waitFor(() => expect(fixture.contexts[0].closed).toBe(true));
		await fixture.manager.close();
	});
	it("requires an explicit contained launch adapter", async () => {
		const fixture = await profileFixture();
		expect(() => new PersistentCompanyComputerBrowser({ ...fixture, launch: undefined } as never)).toThrow(
			"CONTAINED_BROWSER_LAUNCH_REQUIRED",
		);
	});
	it("retains profile occupancy after context disconnect until physical cleanup finishes", async () => {
		const fixture = await profileFixture();
		const context = new FakeBrowserContext();
		const drained = computerDeferred<void>();
		const physicalClose = vi.fn(async () => {
			await context.close();
			await drained.promise;
		});
		const manager = new PersistentCompanyComputerBrowser({
			...fixture,
			launch: async () => ({ context: context as unknown as BrowserContext, close: physicalClose }),
		});
		const session = await manager.open(computerBinding(), fixture.grant, new AbortController().signal);
		const closing = session.close();
		await vi.waitFor(() => expect(context.closed).toBe(true));
		await expect(manager.open(computerBinding(), fixture.grant, new AbortController().signal)).rejects.toThrow(
			"BROWSER_ACCESS_ENDED",
		);
		expect(physicalClose).toHaveBeenCalledOnce();
		drained.resolve();
		await closing;
		await manager.close();
	});
	it("service shutdown waits for a pending launch and closes its late physical result", async () => {
		const fixture = await profileFixture();
		const started = computerDeferred<void>();
		const launched = computerDeferred<Awaited<ReturnType<CompanyComputerBrowserLaunch>>>();
		const manager = new PersistentCompanyComputerBrowser({
			...fixture,
			launch: async () => {
				started.resolve();
				return launched.promise;
			},
		});
		const opening = manager.open(computerBinding(), fixture.grant, new AbortController().signal);
		const rejected = expect(opening).rejects.toThrow("BROWSER_ACCESS_ENDED");
		await started.promise;
		let closed = false;
		const closing = manager.close().then(() => {
			closed = true;
		});
		await new Promise((resolve) => setImmediate(resolve));
		expect(closed).toBe(false);
		const context = new FakeBrowserContext();
		launched.resolve({ context: context as unknown as BrowserContext, close: context.close });
		await rejected;
		await closing;
		expect(context.close).toHaveBeenCalledOnce();
		await expect(manager.open(computerBinding(), fixture.grant, new AbortController().signal)).rejects.toThrow();
	});
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
		const launched = computerDeferred<Awaited<ReturnType<CompanyComputerBrowserLaunch>>>();
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
		launched.resolve({ context: late as unknown as BrowserContext, close: late.close });
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
function captureBytes(width = 1920, height = 1200): Uint8Array {
	const bytes = Buffer.alloc(33);
	Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
	bytes.writeUInt32BE(13, 8);
	bytes.write("IHDR", 12);
	bytes.writeUInt32BE(width, 16);
	bytes.writeUInt32BE(height, 20);
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
		// The values of the page's private boxes (password, code, card).
		evaluate: vi.fn(async (): Promise<string[]> => []),
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
		readFile: vi.fn(async () => new Uint8Array([0, 255, 10])),
	};
	const fileExports: CompanyComputerFileExportPublisher = {
		publish: vi.fn<CompanyComputerFileExportPublisher["publish"]>(async (bytes, lease, _effect, operation) => ({
			schema: "qorpera.file-transfer-asset/v1",
			assetId: computerId(51),
			sha256: createHash("sha256").update(bytes).digest("hex"),
			bytes: bytes.length,
			mediaType: "application/octet-stream",
			source: {
				realm: "company_computer",
				companyComputerId: lease.binding.companyComputerId,
				screenId: lease.binding.screenId,
				path: (operation.arguments as { source: { path: string } }).source.path,
			},
			destination: { realm: "object_storage" },
		})),
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
		fileExports,
		...(withBrowser ? { browser } : {}),
		...(withCommands ? { commands } : {}),
	});
	const effects = {
		assertAuthorized: vi.fn(async () => undefined),
		begin: vi.fn(async () => new AbortController().signal),
		finish: vi.fn(async () => undefined),
	};
	const gate = new CompanyComputerScreenActionGate();
	const endpoint = new CompanyComputerGuestEndpoint({
		binding: computerBinding(),
		capabilities: ["browser", "desktop", "shell"],
		resourceTarget: {},
		effects,
		gate,
		automation,
		assertScreenAdmitted: async () => undefined,
		prepareScreen: async () => undefined,
	});
	const perform = (action: CompanyComputerAction, lease = computerLease(), effect = computerEffect()) =>
		endpoint.perform(
			{ ...computerOperation(), tool: `computer_${action.kind}`, arguments: action as unknown as JsonValue },
			lease,
			effect,
		);
	return {
		automation,
		boundary,
		locator,
		page,
		context,
		browser,
		commands,
		screenshots,
		fileExports,
		effects,
		gate,
		perform,
	};
}

describe("Playwright/X11/shell adapters (test doubles, never the member machine)", () => {
	it("fails a page that does not load in time on its own: the browser stays and the resource is drained", async () => {
		const f = automationFixture();
		f.page.goto.mockRejectedValueOnce(new Error("page.goto: Timeout 10000ms exceeded"));
		await expect(f.perform({ kind: "browser", action: "navigate", url: "https://slow.example/" })).rejects.toThrow(
			"page.goto: Timeout 10000ms exceeded",
		);
		f.locator.click.mockRejectedValueOnce(new Error("locator.click: Timeout 5000ms exceeded"));
		await expect(f.perform({ kind: "browser", action: "click", role: "button", name: "Submit" })).rejects.toThrow(
			"locator.click: Timeout 5000ms exceeded",
		);
		f.locator.getAttribute.mockResolvedValueOnce("password");
		await expect(
			f.perform({ kind: "browser", action: "fill", role: "textbox", name: "Password", text: "x" }),
		).rejects.toThrow("PRIVATE_SIGN_IN_REQUIRED");
		expect(f.locator.fill).not.toHaveBeenCalled();
		expect(f.context.close).not.toHaveBeenCalled();
		expect(f.effects.finish).toHaveBeenCalledTimes(3);
	});

	it("hides from a snapshot what a member typed into a password box, read before and after the snapshot", async () => {
		const f = automationFixture();
		f.locator.ariaSnapshot.mockResolvedValueOnce(
			['- textbox "Email": jonas@example.com', '- textbox "Password": hunter2-typed', '- button "Sign in"'].join(
				"\n",
			),
		);
		// The member starts typing while the snapshot is taken.
		f.page.evaluate.mockResolvedValueOnce([]).mockResolvedValueOnce(["hunter2-typed"]);
		const result = await f.perform({ kind: "browser", action: "snapshot" });
		expect(result).toMatchObject({
			kind: "json",
			value: {
				snapshot: ['- textbox "Email": [hidden]', '- textbox "Password": [hidden]', '- button "Sign in"'].join(
					"\n",
				),
			},
		});
		expect(JSON.stringify(result)).not.toContain("hunter2");
		expect(f.page.evaluate).toHaveBeenCalledTimes(2);

		// A page whose private value cannot be read gives no snapshot at all.
		f.locator.ariaSnapshot.mockResolvedValueOnce('- textbox "Password": hunter2-typed');
		f.page.evaluate.mockRejectedValueOnce(new Error("Execution context was destroyed"));
		await expect(f.perform({ kind: "browser", action: "snapshot" })).rejects.toThrow(
			"Execution context was destroyed",
		);
		expect(f.locator.ariaSnapshot).toHaveBeenCalledTimes(1);
	});

	it("fails an action as its own when an authority check between its steps gets no answer, and stops nothing", async () => {
		const f = automationFixture();
		const unanswered = new CompanyComputerRegistryUnansweredError(new Error("request timed out"));
		vi.mocked(f.browser.assertActive).mockResolvedValueOnce(undefined).mockRejectedValueOnce(unanswered);
		await expect(f.perform({ kind: "browser", action: "navigate", url: "https://example.com/" })).rejects.toThrow(
			"OFFICE_REGISTRY_UNCONFIRMED",
		);
		expect(f.page.goto).toHaveBeenCalledOnce();
		vi.mocked(f.boundary.assertReady).mockRejectedValueOnce(
			new Error("OFFICE_GUEST_READINESS_UNCONFIRMED", { cause: unanswered }),
		);
		await expect(f.perform({ kind: "browser", action: "snapshot" })).rejects.toThrow(
			"OFFICE_GUEST_READINESS_UNCONFIRMED",
		);
		expect(f.context.close).not.toHaveBeenCalled();
		expect(f.effects.finish).toHaveBeenCalledTimes(2);
		// A refusal between steps still stops the browser and keeps the resource.
		vi.mocked(f.browser.assertActive).mockRejectedValueOnce(new Error("PROFILE_GRANT_REVOKED"));
		await expect(f.perform({ kind: "browser", action: "snapshot" })).rejects.toThrow("PROFILE_GRANT_REVOKED");
		expect(f.context.close).toHaveBeenCalledOnce();
		expect(f.effects.finish).toHaveBeenCalledTimes(2);
	});

	it("drains a command stopped at its own limit, but not one whose exit is unconfirmed", async () => {
		const f = automationFixture();
		vi.mocked(f.commands.run).mockRejectedValueOnce(new Error("OFFICE_COMMAND_TIMEOUT"));
		await expect(
			f.perform({ kind: "shell", command: "sleep 99", timeoutMs: 1000 } as CompanyComputerAction),
		).rejects.toThrow("OFFICE_COMMAND_TIMEOUT");
		expect(f.effects.finish).toHaveBeenCalledOnce();
		expect(f.context.close).not.toHaveBeenCalled();
		vi.mocked(f.commands.run).mockRejectedValueOnce(new Error("OFFICE_COMMAND_DRAIN_UNCONFIRMED"));
		await expect(
			f.perform({ kind: "shell", command: "sleep 99", timeoutMs: 1000 } as CompanyComputerAction),
		).rejects.toThrow("OFFICE_COMMAND_DRAIN_UNCONFIRMED");
		expect(f.effects.finish).toHaveBeenCalledOnce();
		// An untyped failure keeps the old rule: automation stops, the resource stays for the supervisor.
		expect(f.context.close).toHaveBeenCalledOnce();
	});

	it("exports binary bytes from a literal workbench path with the original receipt and no shell", async () => {
		const f = automationFixture(false);
		const action: CompanyComputerAction = {
			kind: "transfer",
			action: "export",
			source: { realm: "company_computer", path: "reports/$(literal); 'file'.bin" },
			destination: { realm: "object_storage" },
			mediaType: "application/octet-stream",
		};
		const effect = computerEffect(),
			lease = computerLease();
		const result = await f.perform(action, lease, effect);
		expect(f.commands.readFile).toHaveBeenCalledOnce();
		expect(f.commands.readFile).toHaveBeenCalledWith({ path: action.source.path, signal: expect.any(AbortSignal) });
		expect(f.commands.run).not.toHaveBeenCalled();
		expect(f.fileExports.publish).toHaveBeenCalledExactlyOnceWith(
			new Uint8Array([0, 255, 10]),
			lease,
			expect.objectContaining({
				receiptId: effect.receiptId,
				idempotencyKey: effect.idempotencyKey,
				identity: effect.identity,
			}),
			{ ...computerOperation(), tool: "computer_transfer", arguments: action },
		);
		expect(result).toEqual({ kind: "json", value: await vi.mocked(f.fileExports.publish).mock.results[0].value });
	});
	it("does not publish an export after file reading fails", async () => {
		const f = automationFixture(false);
		vi.mocked(f.commands.readFile!).mockRejectedValue(new Error("WORKBENCH_FILE_CHANGED"));
		await expect(
			f.perform({
				kind: "transfer",
				action: "export",
				source: { realm: "company_computer", path: "file.bin" },
				destination: { realm: "object_storage" },
				mediaType: "application/octet-stream",
			}),
		).rejects.toThrow("WORKBENCH_FILE_CHANGED");
		expect(f.fileExports.publish).not.toHaveBeenCalled();
		expect(f.commands.run).not.toHaveBeenCalled();
	});
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
				effects: {
					assertAuthorized: async () => undefined,
					begin: async () => new AbortController().signal,
					finish: async () => undefined,
				},
				gate: new CompanyComputerScreenActionGate(),
				automation,
				assertScreenAdmitted: async () => undefined,
				prepareScreen: async () => undefined,
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

	it("preserves shared tabs at detach, including an agent-created about:blank now used by a member", async () => {
		const blankPage = () => {
			const opened = fakePage();
			opened.page.url.mockReturnValue("about:blank");
			return { ...opened.page, close: vi.fn(async () => undefined) };
		};
		// The browser had no tab: the run opens one, then a member uses it and
		// opens another. Its URL can remain blank despite DOM or omnibox drafts.
		const unused = automationFixture();
		const mine = blankPage();
		unused.context.pages.mockReturnValue([]);
		unused.context.newPage.mockResolvedValue(mine as unknown as Page);
		await unused.perform({ kind: "browser", action: "snapshot" });
		mine.locator().ariaSnapshot.mockResolvedValue('- textbox "Notes": Unsaved member draft');
		unused.context.pages.mockReturnValue([mine, unused.page] as unknown as Page[]);
		await unused.automation.release();
		expect(mine.close).not.toHaveBeenCalled();
		expect(await mine.locator().ariaSnapshot()).toContain("Unsaved member draft");
		await unused.automation.release();
		expect(mine.close).not.toHaveBeenCalled();

		// The only tab stays: closing it would close the browser.
		const only = automationFixture();
		const last = blankPage();
		only.context.pages.mockReturnValue([]);
		only.context.newPage.mockResolvedValue(last as unknown as Page);
		await only.perform({ kind: "browser", action: "snapshot" });
		only.context.pages.mockReturnValue([last] as unknown as Page[]);
		await only.automation.release();
		expect(last.close).not.toHaveBeenCalled();

		// A tab the run used shows a page, and a tab it did not open is not its to close.
		const used = automationFixture();
		const visited = blankPage();
		used.context.pages.mockReturnValue([]);
		used.context.newPage.mockResolvedValue(visited as unknown as Page);
		await used.perform({ kind: "browser", action: "snapshot" });
		visited.url.mockReturnValue("https://example.com/");
		used.context.pages.mockReturnValue([visited, used.page] as unknown as Page[]);
		await used.automation.release();
		expect(visited.close).not.toHaveBeenCalled();
		const joined = automationFixture();
		const theirs = blankPage();
		joined.context.pages.mockReturnValue([theirs] as unknown as Page[]);
		await joined.perform({ kind: "browser", action: "snapshot" });
		joined.context.pages.mockReturnValue([theirs, joined.page] as unknown as Page[]);
		await joined.automation.release();
		expect(theirs.close).not.toHaveBeenCalled();
		expect(joined.context.newPage).not.toHaveBeenCalled();
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
			{
				...computerOperation(),
				tool: "computer_browser",
				arguments: { kind: "browser", action: "fill", role: "textbox", name: "Search", text: "$(not a command)" },
			},
		);
		expect(fixture.page.getByRole).toHaveBeenCalledWith("textbox", { name: "Search", exact: true });
		expect(fixture.locator.fill).toHaveBeenCalledWith("$(not a command)", { timeout: 5000 });
		fixture.locator.getAttribute.mockImplementation(async (name) => (name === "type" ? "password" : null));
		await expect(
			fixture.automation.perform(
				{ kind: "browser", action: "fill", role: "textbox", name: "Password", text: "not-a-secret" },
				computerLease(),
				computerEffect(),
				{
					...computerOperation(),
					tool: "computer_browser",
					arguments: { kind: "browser", action: "fill", role: "textbox", name: "Password", text: "not-a-secret" },
				},
			),
		).rejects.toThrow("PRIVATE_SIGN_IN_REQUIRED");
		fixture.locator.count.mockResolvedValue(2);
		await expect(
			fixture.automation.perform(
				{ kind: "browser", action: "click", role: "button", name: "Submit" },
				computerLease(),
				computerEffect(),
				{
					...computerOperation(),
					tool: "computer_browser",
					arguments: { kind: "browser", action: "click", role: "button", name: "Submit" },
				},
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
				{
					...computerOperation(),
					tool: "computer_shell",
					arguments: { kind: "shell", command: "pwd", timeoutMs: 1000 },
				},
			),
		).rejects.toThrow("SCREEN_BINDING_MISMATCH");
		fixture.browser.assertActive = vi.fn(async () => {
			throw new Error("SIGN_IN_PRIVATE");
		});
		await expect(
			fixture.automation.perform({ kind: "desktop", action: "type", text: "x" }, computerLease(), computerEffect(), {
				...computerOperation(),
				tool: "computer_desktop",
				arguments: { kind: "desktop", action: "type", text: "x" },
			}),
		).rejects.toThrow("SIGN_IN_PRIVATE");
		expect(fixture.commands.run).not.toHaveBeenCalled();
		const without = automationFixture(false, false);
		await expect(
			without.automation.perform({ kind: "browser", action: "snapshot" }, computerLease(), computerEffect(), {
				...computerOperation(),
				tool: "computer_browser",
				arguments: { kind: "browser", action: "snapshot" },
			}),
		).rejects.toThrow("BROWSER_GRANT_REQUIRED");
		await expect(
			without.automation.perform(
				{ kind: "shell", command: "pwd", timeoutMs: 1000 },
				computerLease(),
				computerEffect(),
				{
					...computerOperation(),
					tool: "computer_shell",
					arguments: { kind: "shell", command: "pwd", timeoutMs: 1000 },
				},
			),
		).rejects.toThrow("CONTAINED_COMPUTER_COMMANDS_UNAVAILABLE");
	});

	it("sends fixed X11 commands with the assigned display and literal text on stdin", async () => {
		const fixture = automationFixture();
		await fixture.automation.perform(
			{ kind: "desktop", action: "type", text: "$(touch /tmp/should-not-run)" },
			computerLease(),
			computerEffect(),
			{
				...computerOperation(),
				tool: "computer_desktop",
				arguments: { kind: "desktop", action: "type", text: "$(touch /tmp/should-not-run)" },
			},
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
			{
				...computerOperation(),
				tool: "computer_desktop",
				arguments: { kind: "desktop", action: "click", x: 42, y: 50, button: "left" },
			},
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
			{
				...computerOperation(),
				tool: "computer_shell",
				arguments: { kind: "shell", command: "pwd", timeoutMs: 1000 },
			},
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
				{
					...computerOperation(),
					tool: "computer_shell",
					arguments: { kind: "shell", command: "pwd", timeoutMs: 1000 },
				},
			),
		).rejects.toThrow("INVALID_COMPUTER_COMMAND_RESULT");
	});

	it("publishes screenshots through immutable receipts and rejects altered digests", async () => {
		const fixture = automationFixture();
		await expect(
			fixture.automation.perform({ kind: "screenshot", surface: "browser" }, computerLease(), computerEffect(), {
				...computerOperation(),
				tool: "computer_screenshot",
				arguments: { kind: "screenshot", surface: "browser" },
			}),
		).resolves.toMatchObject({
			kind: "json",
			value: { assetId: computerId(50), screenId: computerId(6), mediaType: "image/png" },
		});
		expect(fixture.page.screenshot).toHaveBeenCalledWith(
			expect.objectContaining({ type: "png", mask: [fixture.locator] }),
		);
		expect(fixture.page.locator).toHaveBeenCalledWith(COMPANY_COMPUTER_PRIVATE_FIELD_SELECTOR);
		fixture.screenshots.publish = vi.fn(async (bytes: Uint8Array) => ({
			assetId: computerId(50),
			sha256: "0".repeat(64),
			bytes: bytes.length,
			mediaType: "image/png" as const,
		}));
		await expect(
			fixture.automation.perform({ kind: "screenshot", surface: "desktop" }, computerLease(), computerEffect(), {
				...computerOperation(),
				tool: "computer_screenshot",
				arguments: { kind: "screenshot", surface: "desktop" },
			}),
		).rejects.toThrow("INVALID_SCREENSHOT_RECEIPT");
		expect(fixture.commands.capturePng).toHaveBeenCalledWith(
			expect.objectContaining({ display: ":1", maxBytes: 8 * 1024 * 1024 }),
		);
	});
	it("takes no whole-screen picture while a shown tab holds a private value, also one typed during the capture", async () => {
		const fixture = automationFixture();
		const desktop = () =>
			fixture.automation.perform({ kind: "screenshot", surface: "desktop" }, computerLease(), computerEffect(), {
				...computerOperation(),
				tool: "computer_screenshot",
				arguments: { kind: "screenshot", surface: "desktop" },
			});
		fixture.page.evaluate.mockResolvedValueOnce(["hunter2"]);
		await expect(desktop()).rejects.toThrow("PRIVATE_FIELD_ON_SCREEN");
		expect(fixture.commands.capturePng).not.toHaveBeenCalled();
		fixture.page.evaluate.mockResolvedValueOnce([]).mockResolvedValueOnce(["hunter2"]);
		await expect(desktop()).rejects.toThrow("PRIVATE_FIELD_ON_SCREEN");
		expect(fixture.commands.capturePng).toHaveBeenCalledOnce();
		expect(fixture.screenshots.publish).not.toHaveBeenCalled();
		// Only shown tabs count; the page itself answers whether it is shown.
		expect(fixture.page.evaluate).toHaveBeenLastCalledWith(
			expect.any(Function),
			expect.objectContaining({ shownOnly: true }),
		);
		await expect(desktop()).resolves.toMatchObject({ kind: "json", value: { surface: "desktop" } });
		expect(fixture.screenshots.publish).toHaveBeenCalledOnce();
	});

	it("preserves actual page dimensions while desktop images retain fixed pixel coordinates", async () => {
		const fixture = automationFixture();
		fixture.page.screenshot.mockResolvedValue(captureBytes(1918, 1048));
		await expect(
			fixture.automation.perform({ kind: "screenshot", surface: "browser" }, computerLease(), computerEffect(), {
				...computerOperation(),
				tool: "computer_screenshot",
				arguments: { kind: "screenshot", surface: "browser" },
			}),
		).resolves.toMatchObject({ kind: "json", value: { surface: "browser", width: 1918, height: 1048 } });
		await expect(
			fixture.automation.perform({ kind: "screenshot", surface: "desktop" }, computerLease(), computerEffect(), {
				...computerOperation(),
				tool: "computer_screenshot",
				arguments: { kind: "screenshot", surface: "desktop" },
			}),
		).resolves.toMatchObject({ kind: "json", value: { surface: "desktop", width: 1920, height: 1200 } });
	});
	it.each([
		["browser", 0, 100],
		["browser", 100, 0],
		["browser", 1921, 100],
		["browser", 100, 1201],
		["desktop", 1918, 1048],
	] as const)("rejects %s capture dimensions %i x %i before publishing", async (surface, width, height) => {
		const fixture = automationFixture();
		fixture.page.screenshot.mockResolvedValue(captureBytes(width, height));
		vi.mocked(fixture.commands.capturePng).mockResolvedValue(captureBytes(width, height));
		await expect(
			fixture.automation.perform({ kind: "screenshot", surface }, computerLease(), computerEffect(), {
				...computerOperation(),
				tool: "computer_screenshot",
				arguments: { kind: "screenshot", surface },
			}),
		).rejects.toThrow("INVALID_SCREENSHOT");
		expect(fixture.screenshots.publish).not.toHaveBeenCalled();
	});
});
