// @vitest-environment jsdom
import { REALTIME_SUBSCRIBE_STATES, RealtimeClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mountApplication } from "../src/app/application.ts";
import { AuthController } from "../src/app/auth.ts";
import { CompanyController } from "../src/app/company.ts";
import { HubController } from "../src/app/views/hub.ts";
import { SettingsView } from "../src/app/views/settings.ts";
import { type Cloud, CloudRpcError } from "../src/cloud/client.ts";
import { WebCompanyFiles } from "../src/cloud/company-files.ts";
import { GoodWillCardError } from "../src/cloud/good-will.ts";
import type { CompanyMemory } from "../src/cloud/memory-mode.ts";
import type { HostedAccountEntitlement, HostedAccountMatch } from "../src/cloud/types.ts";
import { markdown } from "../src/ui/markdown.ts";
import { setTimeZonePreference } from "../src/ui/preferences.ts";
import {
	deferred,
	fixture,
	id,
	profileA,
	profileB,
	session,
	settle,
	team,
	timestamp,
	userA,
	userB,
} from "./fixtures.ts";

let dispose: (() => void) | undefined;
const { showModal, close } = HTMLDialogElement.prototype;
beforeEach(() => {
	vi.useFakeTimers();
	vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
	// jsdom has no modal dialogs; the Friends window is one.
	HTMLDialogElement.prototype.showModal = function () {
		this.open = true;
	};
	HTMLDialogElement.prototype.close = function () {
		this.open = false;
	};
	history.replaceState(null, "", `/#/c/${profileA.profileId}/chat/${session.sessionId}`);
});
afterEach(() => {
	dispose?.();
	document.body.replaceChildren();
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	HTMLDialogElement.prototype.showModal = showModal;
	HTMLDialogElement.prototype.close = close;
});
async function draw() {
	await settle();
	await vi.advanceTimersByTimeAsync(60);
}
async function setup(f = fixture()) {
	const root = document.createElement("div");
	document.body.append(root);
	dispose = mountApplication(root, f.cloud, f.api);
	await draw();
	return { ...f, root };
}
/** The RPC names called so far, besides the app marking the account online (online-mark.ts), which it does at
 * sign-in whatever is open. */
function rpcNames(f: { cloud: Cloud }): string[] {
	return vi
		.mocked(f.cloud.rpc)
		.mock.calls.map(([name]) => name)
		.filter((name) => name !== "qorpera_mark_online");
}
/** The SDK RPCs Settings made, besides General's rules list (its only one until Company connections opens) and the
 * company's mail, offers, consents and pages reads, which run while it is open (Interfaces steps I5c, I9c, C6a and
 * C6d), Settings reading the pages too. The mail's read includes Digital Post's state, which Company connections'
 * Digital Post card reads too (test/digital-post.test.ts). */
function sdkRpcs(f: { cloud: Cloud }): string[] {
	return rpcNames(f).filter(
		(name) =>
			name !== "qorpera_list_review_rules" &&
			!name.startsWith("qorpera_member_mail_") &&
			name !== "qorpera_member_digital_post" &&
			name !== "qorpera_member_interface_offers" &&
			name !== "qorpera_member_interface_supervisions" &&
			name !== "qorpera_member_interface_pages",
	);
}
function click(root: Element, selector: string) {
	root.querySelector<HTMLButtonElement>(selector)!.click();
}
function open(root: Element) {
	click(root, ".account-trigger");
	click(root, '[data-account-action="settings"]');
}
/** Opens the Friends window from the account menu, as a member does. */
function openFriendsWindow(root: Element): HTMLDialogElement {
	click(root, ".account-trigger");
	click(root, '[data-account-action="friends"]');
	return root.querySelector<HTMLDialogElement>(".friends-window")!;
}
/** The settings pages the nav shows, by id. */
function navTabs(root: Element): string[] {
	return [...root.querySelectorAll<HTMLElement>('.settings-nav:not(.settings-storage-nav) [role="tab"]')]
		.filter((tab) => !tab.hidden)
		.map((tab) => tab.id.replace("settings-tab-", ""));
}
function selectedTab(root: Element): string | undefined {
	return root.querySelector('.settings-nav [role="tab"][aria-selected="true"]')?.id.replace("settings-tab-", "");
}
const ACCOUNT_TABS = ["general", "appearance", "leaderboard", "ai-subscriptions"];
const ALL_TABS = [
	"general",
	"appearance",
	"company",
	"leaderboard",
	"ai-subscriptions",
	"company-connections",
	"sites",
];

/** Read-only folder data for the real browser embedded in Settings. */
function storageFixture() {
	const source: WebCompanyFiles[] = [];
	const list = vi.fn(async () => ({
		asOfSeq: 1,
		entries: ["notes", "operations"].map((path) => ({
			path,
			kind: "folder",
			version: id(101),
			seq: 1,
			updatedAt: timestamp,
			file: null,
			target: null,
		})),
		next: null,
	}));
	const history = vi.fn(async () => ({ asOfSeq: 1, items: [], next: null }));
	vi.spyOn(WebCompanyFiles.prototype, "folder").mockImplementation(function (this: WebCompanyFiles) {
		source.push(this);
		return { list, history } as never;
	});
	vi.spyOn(WebCompanyFiles.prototype, "folderHints").mockReturnValue({ close: async () => {} } as never);
	return { source, list, history };
}

function confirmCompanyRemoval(root: Element, deleting: boolean, profile = profileA) {
	expect(root.querySelector(".company-exit")?.textContent).toBe(deleting ? "Delete company" : "Leave company");
	click(root, ".company-exit");
	const dialog = document.querySelector('[role="alertdialog"]')!;
	if (deleting) {
		const input = dialog.querySelector("input")!;
		input.value = profile.profileName;
		input.dispatchEvent(new Event("input"));
	}
	[...dialog.querySelectorAll("button")]
		.find((button) => button.textContent === (deleting ? "Delete company" : "Leave"))!
		.click();
}

function realtimeFixture() {
	const f = fixture();
	const realtime = new RealtimeClient("wss://fixture.invalid/realtime/v1", { params: { apikey: "fixture" } });
	vi.mocked(f.api.listProfiles).mockResolvedValue([profileA, profileB]);
	vi.mocked(f.cloud.supabase.channel).mockImplementation((topic) => {
		// Exercise the installed SDK's topic reuse without opening a socket.
		const channel = realtime.channel(topic);
		vi.spyOn(channel, "subscribe").mockReturnValue(channel);
		return channel;
	});
	// The fixture deliberately leaves removed channels registered, as the SDK
	// does while an asynchronous unsubscribe is waiting for its response.
	return f;
}

describe("settings session lifecycle", () => {
	it.each([[profileA], [profileA, profileB]])(
		"updates open settings after the initial company list arrives: %j",
		async (...profiles) => {
			history.replaceState(null, "", "/#/");
			const fixtureState = fixture(),
				pending = deferred<typeof profiles>();
			vi.mocked(fixtureState.api.listProfiles).mockReturnValue(pending.promise);
			const f = await setup(fixtureState);
			open(f.root);
			click(f.root, "#settings-tab-company");
			const content = () => f.root.querySelector("#settings-content")!;
			// No company is open yet: only the account's pages, and General in the Company page's place.
			expect(navTabs(f.root)).toEqual(ACCOUNT_TABS);
			expect(selectedTab(f.root)).toBe("general");
			expect(content().textContent).not.toContain("Open a company to see these settings.");
			pending.resolve(profiles);
			await draw();
			if (profiles.length > 1) {
				// Several companies: the member opens one from the list first.
				expect(navTabs(f.root)).toEqual(ACCOUNT_TABS);
				expect(selectedTab(f.root)).toBe("general");
				expect(content().querySelector(".settings-file-card")).toBeNull();
				expect(f.api.getTeam).not.toHaveBeenCalled();
			} else {
				// The only company opens, and with it the Company page asked for.
				expect(navTabs(f.root)).toEqual(ALL_TABS);
				expect(selectedTab(f.root)).toBe("company");
				// The Company tab has no heading of its own.
				expect(content().querySelector("h1")).toBeNull();
				expect(
					content().querySelector(`.settings-file-card[data-profile-id='${profileA.profileId}']`),
				).not.toBeNull();
			}
			// On the company list itself the rail needs no way back to it.
			expect(f.root.querySelector<HTMLElement>(".settings-back")!.hidden).toBe(true);
			// The only company's settings read its pages, once (Interfaces C6a).
			expect(rpcNames(f)).toEqual(profiles.length > 1 ? [] : ["qorpera_member_interface_pages"]);
		},
	);
	it("preserves the selected company and focus when the profile list refreshes", async () => {
		const f = fixture(),
			auth = new AuthController(f.cloud);
		await auth.start();
		const company = new CompanyController(f.api, profileA, userA.id);
		const hub = new HubController(f.api);
		const view = new SettingsView(
			f.api,
			auth,
			hub,
			[profileA],
			company,
			() => {},
			() => {},
		);
		document.body.append(view.el);
		dispose = () => {
			view.dispose();
			hub.dispose();
			company.stop();
			auth.dispose();
		};
		const content = view.el.querySelector<HTMLElement>("#settings-content")!;
		content.focus();
		view.updateProfiles([{ ...profileA }, profileB]);
		expect(view.el.querySelector("#settings-content")).toBe(content);
		expect(document.activeElement).toBe(content);
		expect(f.api.getTeam).not.toHaveBeenCalled();
		expect(company.signal.aborted).toBe(false);
	});
	it("loads the rules only once General is shown", async () => {
		const f = fixture(),
			auth = new AuthController(f.cloud);
		await auth.start();
		const company = new CompanyController(f.api, profileA, userA.id);
		const hub = new HubController(f.api);
		const view = new SettingsView(
			f.api,
			auth,
			hub,
			[profileA],
			company,
			() => {},
			() => {},
			"appearance",
		);
		document.body.append(view.el);
		dispose = () => {
			view.dispose();
			hub.dispose();
			company.stop();
			auth.dispose();
		};
		await draw();
		const rulesLists = () =>
			vi.mocked(f.cloud.rpc).mock.calls.filter(([name]) => name === "qorpera_list_review_rules").length;
		expect(rulesLists()).toBe(0);
		view.el.querySelector<HTMLButtonElement>("#settings-tab-general")!.click();
		await draw();
		expect(rulesLists()).toBe(1);
		expect(view.el.querySelector("#settings-content .settings-rules")).not.toBeNull();
	});
	it("shows only the open company, and returns to it unstarted when it is listed again", async () => {
		const f = fixture(),
			auth = new AuthController(f.cloud);
		await auth.start();
		const company = new CompanyController(f.api, profileA, userA.id);
		const hub = new HubController(f.api);
		const view = new SettingsView(
			f.api,
			auth,
			hub,
			[profileA, profileB],
			company,
			() => {},
			() => {},
			"company",
		);
		document.body.append(view.el);
		dispose = () => {
			view.dispose();
			hub.dispose();
			company.stop();
			auth.dispose();
		};
		// The Company tab's Storage button identifies the company it opens.
		const shown = () =>
			view.el.querySelector("#settings-content .settings-file-card")?.getAttribute("data-profile-id");
		expect(shown()).toBe(profileA.profileId);
		expect(view.el.querySelector("#settings-content h1")).toBeNull();
		// Settings over a company never show another one, however often the list repeats: with none, they show the
		// account's pages, General for the Company page.
		view.updateProfiles([profileB]);
		view.updateProfiles([{ ...profileB }]);
		expect(navTabs(view.el)).toEqual(ACCOUNT_TABS);
		expect(selectedTab(view.el)).toBe("general");
		expect(shown()).toBeUndefined();
		expect(f.api.getTeam).not.toHaveBeenCalled();
		view.updateProfiles([profileA, profileB]);
		await settle();
		expect(navTabs(view.el)).toEqual(ALL_TABS);
		expect(selectedTab(view.el)).toBe("company");
		expect(shown()).toBe(profileA.profileId);
		// The open company is borrowed again: Settings neither start nor stop it.
		expect(f.api.getTeam).not.toHaveBeenCalled();
		expect(company.signal.aborted).toBe(false);
	});
	it("shows the account's only company when Settings are not over a company", async () => {
		history.replaceState(null, "", "/#/");
		const f = fixture(),
			auth = new AuthController(f.cloud);
		await auth.start();
		const hub = new HubController(f.api);
		const view = new SettingsView(
			f.api,
			auth,
			hub,
			[profileA, profileB],
			undefined,
			() => {},
			() => {},
			"company",
		);
		document.body.append(view.el);
		dispose = () => {
			view.dispose();
			hub.dispose();
			auth.dispose();
		};
		expect(selectedTab(view.el)).toBe("general");
		const shown = () =>
			view.el.querySelector("#settings-content .settings-file-card")?.getAttribute("data-profile-id");
		expect(shown()).toBeUndefined();
		view.updateProfiles([profileB]);
		await settle();
		expect(shown()).toBe(profileB.profileId);
		expect(view.el.querySelector("#settings-content h1")).toBeNull();
		// A company joins: the one shown stays.
		view.updateProfiles([profileA, profileB]);
		await settle();
		expect(shown()).toBe(profileB.profileId);
		// The company shown is removed: the one left is shown.
		view.updateProfiles([profileA]);
		await settle();
		expect(shown()).toBe(profileA.profileId);
	});
	it("shows the company's pages on the Company tab, and says when one was switched (Interfaces C6a)", async () => {
		const f = fixture(),
			auth = new AuthController(f.cloud);
		await auth.start();
		vi.mocked(f.cloud.rpc).mockImplementation(async (name: string, args?: Record<string, unknown>) => {
			if (name !== "qorpera_member_interface_pages" && name !== "qorpera_set_interface_page")
				throw new Error("Unexpected RPC");
			const pages = [
				{ page: "mailbox", on: false },
				{ page: "members", on: args?.p_on === true },
			];
			return { schema: "qorpera.member-interface-pages/v1", pages, mayChange: true };
		});
		const company = new CompanyController(f.api, profileA, userA.id);
		const hub = new HubController(f.api);
		const changed = vi.fn();
		const view = new SettingsView(
			f.api,
			auth,
			hub,
			[profileA],
			company,
			() => {},
			() => {},
			"company",
			changed,
		);
		document.body.append(view.el);
		dispose = () => {
			view.dispose();
			hub.dispose();
			company.stop();
			auth.dispose();
		};
		await draw();
		const section = view.el.querySelector<HTMLElement>("#settings-content .settings-pages")!;
		expect(section.querySelector("h2")?.textContent).toBe("Pages");
		const members = () => section.querySelector<HTMLButtonElement>('[role="switch"][aria-label="Members"]')!;
		expect(members().getAttribute("aria-checked")).toBe("false");
		members().click();
		await draw();
		expect(f.cloud.rpc).toHaveBeenCalledWith("qorpera_set_interface_page", {
			p_environment_id: profileA.environmentId,
			p_page: "members",
			p_on: true,
		});
		expect(members().getAttribute("aria-checked")).toBe("true");
		expect(changed).toHaveBeenCalledWith(profileA.environmentId);
	});
	it("shows no other company on a company page that has none to lend", async () => {
		// A company page without its company: access lost, or not available.
		const f = fixture(),
			auth = new AuthController(f.cloud);
		await auth.start();
		const hub = new HubController(f.api);
		const view = new SettingsView(
			f.api,
			auth,
			hub,
			[profileB],
			undefined,
			() => {},
			() => {},
			"company",
		);
		document.body.append(view.el);
		dispose = () => {
			view.dispose();
			hub.dispose();
			auth.dispose();
		};
		view.updateProfiles([{ ...profileB }]);
		await settle();
		expect(navTabs(view.el)).toEqual(ACCOUNT_TABS);
		expect(selectedTab(view.el)).toBe("general");
		expect(view.el.querySelector<HTMLElement>(".settings-back")!.hidden).toBe(false);
		expect(f.api.getTeam).not.toHaveBeenCalled();
	});
	it("stays open on the revoked-access page and does not restart the revoked company", async () => {
		const f = await setup();
		vi.mocked(f.api.getTeam).mockRejectedValue(
			new CloudRpcError("getTeam", { code: "42501", message: "Access revoked" }),
		);
		f.hints.get("qorpera_profile_access_state")!();
		await draw();
		expect(f.root.querySelector("main")?.textContent).toContain("Your access to this company was revoked");
		const teams = vi.mocked(f.api.getTeam).mock.calls.length;
		open(f.root);
		click(f.root, "#settings-tab-company");
		await draw();
		await vi.advanceTimersByTimeAsync(5000);
		// The revoked company is still listed; Settings used to start it again,
		// fail at once and close themselves.
		expect(f.root.querySelector(".settings-overlay")).not.toBeNull();
		expect(navTabs(f.root)).toEqual(ACCOUNT_TABS);
		expect(selectedTab(f.root)).toBe("general");
		expect(vi.mocked(f.api.getTeam).mock.calls.length).toBe(teams);
	});
	it("shows only the account's pages and no Storage with no company open, and every page inside one", async () => {
		history.replaceState(null, "", "/#/");
		const fixtureState = fixture();
		vi.mocked(fixtureState.api.listProfiles).mockResolvedValue([profileA, profileB]);
		const f = await setup(fixtureState);
		open(f.root);
		await draw();
		expect(navTabs(f.root)).toEqual(ACCOUNT_TABS);
		expect(selectedTab(f.root)).toBe("general");
		expect(f.root.querySelector<HTMLElement>(".settings-modes")!.hidden).toBe(true);
		// A search never brings a company page back (inside a company, "agents" finds Company and Leaderboard too).
		const search = f.root.querySelector<HTMLInputElement>('.settings-header input[aria-label="Search settings"]')!;
		search.value = "ranking";
		search.dispatchEvent(new Event("input"));
		expect(navTabs(f.root)).toEqual(["leaderboard"]);
		expect(selectedTab(f.root)).toBe("leaderboard");
		click(f.root, ".settings-close");
		// Inside a company, its pages and Storage are there as before.
		location.hash = `#/c/${profileA.profileId}/chat/${session.sessionId}`;
		await draw();
		open(f.root);
		await draw();
		expect(navTabs(f.root)).toEqual(ALL_TABS);
		expect(f.root.querySelector<HTMLElement>(".settings-modes")!.hidden).toBe(false);
	});
	it.each([
		["company-connections", "general"],
		["storage", "general"],
		["my-connections", "ai-subscriptions"],
	] as const)("opens %s with no company open on %s", async (asked, opened) => {
		history.replaceState(null, "", "/#/");
		const f = fixture(),
			auth = new AuthController(f.cloud);
		await auth.start();
		const hub = new HubController(f.api);
		const view = new SettingsView(
			f.api,
			auth,
			hub,
			[profileA, profileB],
			undefined,
			() => {},
			() => {},
			asked,
		);
		document.body.append(view.el);
		dispose = () => {
			view.dispose();
			hub.dispose();
			auth.dispose();
		};
		await settle();
		expect(selectedTab(view.el)).toBe(opened);
		expect(view.el.querySelector<HTMLElement>("#settings-content")!.hidden).toBe(false);
		expect(view.el.querySelector<HTMLElement>("#settings-storage-content")!.hidden).toBe(true);
		const text = view.el.querySelector(".settings-dialog")!.textContent;
		expect(text).not.toContain("Open a company to see these settings.");
		expect(text).not.toContain("Open a company to see its storage.");
	});
	it("lists the member's AI subscriptions with no company open, read through the first company that shares them", async () => {
		history.replaceState(null, "", "/#/");
		const fixtureState = fixture();
		vi.mocked(fixtureState.api.listProfiles).mockResolvedValue([profileB, profileA]);
		const f = await setup(fixtureState);
		const calls: Array<[string, unknown]> = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
				const url = String(input);
				if (url.endsWith("/qorpera_list_member_notifications")) return Response.json([]);
				const method = url.slice(url.lastIndexOf("/") + 1);
				const company = (JSON.parse(String(init?.body ?? "{}")) as { p_profile_id?: unknown }).p_profile_id;
				calls.push([method, company]);
				if (method === "qorpera_list_account_model_logins")
					return Response.json({
						schema: "qorpera.account-model-logins/v1",
						// Company A has a vault of its own; Company B's sign-ins are account sign-ins.
						enabled: company === profileB.profileId,
						logins: [
							{
								loginId: id(90),
								loginKind: "codex",
								status: "active",
								providerAccountEmail: "member@example.com",
								createdAt: timestamp,
								companies: 2,
								connectionIds: [],
							},
						],
					});
				if (method === "qorpera_list_member_native_execution_connections")
					return Response.json({ compute_identity: null, connections: [] });
				throw new Error("Unexpected request in the AI subscriptions fixture");
			}),
		);
		open(f.root);
		click(f.root, "#settings-tab-ai-subscriptions");
		await draw();
		await draw();
		const content = f.root.querySelector<HTMLElement>("#settings-content")!;
		expect(content.querySelector("h1")?.textContent).toBe("AI subscriptions");
		expect(content.textContent).not.toContain("Open a company to see these settings.");
		const card = content.querySelector<HTMLElement>(`.connection-card[data-login-id="${id(90)}"]`)!;
		expect(card.textContent).toContain("member@example.com");
		expect(card.textContent).toContain("Used in all your companies");
		expect([...card.querySelectorAll("button")].map((button) => button.textContent)).toEqual(["Sign out everywhere"]);
		expect(content.querySelector(".connection-note")?.textContent).toBe(
			"A ChatGPT subscription you add here is used in all your companies.",
		);
		expect(content.querySelector(".connection-add")?.textContent).toBe("Add ChatGPT subscription");
		expect(content.querySelector(".connection-provider-picker")).toBeNull();
		// Companies are asked in id order (A, then B); everything after that is read in Company B, the first that
		// shares sign-ins.
		expect(calls.slice(0, 2)).toEqual([
			["qorpera_list_account_model_logins", profileA.profileId],
			["qorpera_list_account_model_logins", profileB.profileId],
		]);
		expect(calls.slice(2).map(([, company]) => company)).toEqual(calls.slice(2).map(() => profileB.profileId));
		expect(calls.map(([method]) => method)).toContain("qorpera_list_member_native_execution_connections");
		// No company was opened for it.
		expect(f.api.getTeam).not.toHaveBeenCalled();
	});
	it("ends the rail with a way back to the company list, not a company picker", async () => {
		const f = await setup();
		open(f.root);
		await draw();
		const nav = f.root.querySelector(".settings-nav")!;
		expect(nav.querySelector("select")).toBeNull();
		const back = nav.querySelector<HTMLAnchorElement>(".settings-back")!;
		expect(nav.lastElementChild).toBe(back);
		expect(back.hidden).toBe(false);
		expect(back.getAttribute("href")).toBe("#/");
		expect(back.textContent).toBe("Back to companies");
		expect(back.querySelector("svg.icon")).not.toBeNull();
		back.click();
		await draw();
		expect(location.hash).toBe("#/");
		expect(f.root.querySelector(".settings-overlay")).toBeNull();
		expect(f.root.querySelector<HTMLElement>(".frame")!.inert).toBe(false);
		expect(f.root.querySelector(".company-card[href]")).not.toBeNull();
		// The company list itself needs no way back.
		open(f.root);
		expect(f.root.querySelector<HTMLElement>(".settings-back")!.hidden).toBe(true);
	});
	it("opens the Friends window from the button beside Settings | Storage", async () => {
		const f = await setup();
		open(f.root);
		await draw();
		const header = f.root.querySelector(".settings-header")!;
		const friends = header.querySelector<HTMLButtonElement>(".settings-friends")!;
		// Inside a company it stands left of the Settings | Storage switch.
		expect(friends.nextElementSibling?.classList.contains("settings-modes")).toBe(true);
		friends.click();
		await draw();
		expect(f.root.querySelector(".settings-overlay")).toBeNull();
		expect(f.root.querySelector<HTMLDialogElement>(".friends-window")?.open).toBe(true);
	});
	it("opens all eight tabs over the same conversation and restores the profile button", async () => {
		const f = await setup(),
			composer = f.root.querySelector<HTMLTextAreaElement>("textarea")!;
		composer.value = "Keep my conversation draft";
		composer.dispatchEvent(new Event("input", { bubbles: true }));
		open(f.root);
		await draw();
		expect(
			[...f.root.querySelectorAll('.settings-nav:not(.settings-storage-nav) [role="tab"]')].map(
				(tab) => tab.textContent,
			),
		).toEqual([
			"General",
			"Appearance",
			"Company",
			"Leaderboard",
			"AI subscriptions",
			"Company connections",
			"Sites",
		]);
		for (const tab of f.root.querySelectorAll('.settings-nav:not(.settings-storage-nav) [role="tab"]'))
			expect(tab.querySelector("svg.icon")).not.toBeNull();
		// Rules live on General, under the account's settings, for the chosen company.
		expect(
			f.root.querySelector('#settings-content .settings-rules input[aria-label="When an agent wants to:"]'),
		).not.toBeNull();
		expect(vi.mocked(f.cloud.rpc)).toHaveBeenCalledWith("qorpera_list_review_rules", {
			p_profile_id: profileA.profileId,
		});
		expect(f.root.querySelector<HTMLElement>(".frame")!.inert).toBe(true);
		click(f.root, "#settings-tab-company");
		expect(f.root.querySelector(".settings-dialog button.settings-file-card")?.textContent).toContain("Storage");
		expect(f.root.querySelector('.settings-dialog a[href$="/file"]')).toBeNull();
		// No company execution controls, and no Organization or Approvals pages to link to.
		expect(
			f.root.querySelector(
				'.settings-dialog :is(.company-execution, .settings-execution, a[href$="/organization"], a[href$="/approvals"])',
			),
		).toBeNull();
		expect(f.root.querySelector(".settings-dialog")?.textContent).not.toMatch(
			/Company execution|Organization|Approvals/,
		);
		expect(f.root.querySelector('.account-popover a[href$="/file"]')).toBeNull();
		click(f.root, ".settings-close");
		expect(f.root.querySelector(".settings-dialog")).toBeNull();
		expect(f.root.querySelector<HTMLElement>(".frame")!.inert).toBe(false);
		expect(f.root.querySelector("textarea")).toBe(composer);
		expect(composer.value).toBe("Keep my conversation draft");
		expect(document.activeElement).toBe(f.root.querySelector(".account-trigger"));
	});
	it("filters tabs, navigates by keyboard, and keeps an invitation picker open on refresh", async () => {
		const f = await setup();
		open(f.root);
		await draw();
		const search = f.root.querySelector<HTMLInputElement>('.settings-header input[aria-label="Search settings"]')!;
		search.value = "time zone";
		search.dispatchEvent(new Event("input"));
		const shownTabs = [
			...f.root.querySelectorAll<HTMLElement>(".settings-nav:not(.settings-storage-nav) [role=tab]"),
		].filter((tab) => !tab.hidden);
		expect(shownTabs.map((tab) => tab.id)).toEqual(["settings-tab-general"]);
		search.value = "team";
		search.dispatchEvent(new Event("input"));
		expect(f.root.querySelector("#settings-tab-company")?.getAttribute("aria-selected")).toBe("true");
		const picker = f.root.querySelector<HTMLDetailsElement>(".company-invite")!;
		picker.open = true;
		const role = f.root.querySelector<HTMLSelectElement>('[data-draft="invite-role"]')!;
		role.value = "viewer";
		role.focus();
		f.hints.get("qorpera_profile_access_state")!();
		await draw();
		expect(f.root.querySelector<HTMLDetailsElement>(".company-invite")!.open).toBe(true);
		expect(f.root.querySelector<HTMLSelectElement>('[data-draft="invite-role"]')!.value).toBe("viewer");
		expect(document.activeElement).toBe(f.root.querySelector('[data-draft="invite-role"]'));
		// Each word matches on its own, so the button's own label finds its tab.
		search.value = "Delete company";
		search.dispatchEvent(new Event("input"));
		expect(
			[...f.root.querySelectorAll<HTMLElement>(".settings-nav:not(.settings-storage-nav) [role=tab]")]
				.filter((tab) => !tab.hidden)
				.map((tab) => tab.id),
		).toEqual(["settings-tab-company"]);
		const exit = f.root.querySelector<HTMLButtonElement>(".company-exit")!;
		exit.focus();
		f.hints.get("qorpera_profile_access_state")!();
		await draw();
		expect(f.root.querySelector(".company-exit")).not.toBe(exit);
		expect(document.activeElement).toBe(f.root.querySelector(".company-exit"));
		search.value = "";
		search.dispatchEvent(new Event("input"));
		click(f.root, "#settings-tab-general");
		f.root
			.querySelector("#settings-tab-general")!
			.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
		expect(document.activeElement).toBe(f.root.querySelector("#settings-tab-appearance"));
	});
	it("shares one header between Settings and Storage while preserving each search and the conversation draft", async () => {
		const folder = storageFixture();
		const f = await setup();
		const composer = f.root.querySelector<HTMLTextAreaElement>("textarea")!;
		composer.value = "Keep this draft while browsing company storage";
		composer.dispatchEvent(new Event("input", { bubbles: true }));
		open(f.root);
		await draw();
		const dialog = f.root.querySelector(".settings-dialog")!;
		const settingsSearch = dialog.querySelector<HTMLInputElement>(
			'.settings-header input[aria-label="Search settings"]',
		)!;
		const storageSearch = dialog.querySelector<HTMLInputElement>(
			'.settings-header input[aria-label="Search this folder"]',
		)!;
		expect(dialog.firstElementChild?.classList.contains("settings-header")).toBe(true);
		expect(dialog.querySelector(".settings-nav input[type='search']")).toBeNull();
		settingsSearch.value = "time zone";
		settingsSearch.dispatchEvent(new Event("input"));
		click(dialog, '.settings-mode[data-mode="storage"]');
		await draw();
		expect(settingsSearch.hidden).toBe(true);
		expect(storageSearch.hidden).toBe(false);
		expect(dialog.querySelector('.settings-mode[data-mode="storage"]')?.getAttribute("aria-pressed")).toBe("true");
		expect(dialog.querySelector("#settings-storage-documents")?.getAttribute("aria-selected")).toBe("true");
		expect([...dialog.querySelectorAll(".settings-storage-nav [role=tab]")].map((tab) => tab.textContent)).toEqual([
			"Documents",
			"Recents",
		]);
		storageSearch.value = "notes";
		storageSearch.dispatchEvent(new Event("input"));
		expect([...dialog.querySelectorAll(".files-name")].map((name) => name.textContent)).toEqual(["notes"]);
		click(dialog, '.settings-mode[data-mode="settings"]');
		expect(settingsSearch.hidden).toBe(false);
		expect(storageSearch.hidden).toBe(true);
		expect(settingsSearch.value).toBe("time zone");
		expect(dialog.querySelector("#settings-tab-general")?.getAttribute("aria-selected")).toBe("true");
		click(dialog, '.settings-mode[data-mode="storage"]');
		expect(storageSearch.value).toBe("notes");
		expect(folder.list).toHaveBeenCalledOnce();
		expect(location.hash).toBe(`#/c/${profileA.profileId}/chat/${session.sessionId}`);
		click(dialog, ".settings-close");
		expect(f.root.querySelector("textarea")).toBe(composer);
		expect(composer.value).toBe("Keep this draft while browsing company storage");
		expect(folder.source.at(-1)?.signal.aborted).toBe(true);
	});
	it("draws Storage's dates again in a time zone chosen in Settings meanwhile", async () => {
		const folder = storageFixture();
		expect(setTimeZonePreference("UTC")).toBe(true);
		try {
			const f = await setup();
			open(f.root);
			click(f.root, '.settings-mode[data-mode="storage"]');
			await draw();
			const modified = () =>
				f.root.querySelector<HTMLElement>(".settings-storage-content time")?.title.replace(/\s/g, " ");
			expect(modified()).toBe("Sep 5, 2026, 10:00 AM");
			click(f.root, '.settings-mode[data-mode="settings"]');
			expect(setTimeZonePreference("Pacific/Auckland")).toBe(true);
			await draw();
			click(f.root, '.settings-mode[data-mode="storage"]');
			expect(modified()).toBe("Sep 5, 2026, 10:00 PM");
			expect(folder.list).toHaveBeenCalledOnce();
		} finally {
			setTimeZonePreference("system");
		}
	});
	it("keeps a focused Storage file row when an unrelated company refresh arrives", async () => {
		const folder = storageFixture();
		const f = await setup();
		open(f.root);
		click(f.root, '.settings-mode[data-mode="storage"]');
		await draw();
		const notes = [...f.root.querySelectorAll<HTMLElement>(".settings-storage-content .files-row-main")].find(
			(row) => row.querySelector(".files-name")?.textContent === "notes",
		)!;
		notes.focus();
		const teamReads = vi.mocked(f.api.getTeam).mock.calls.length;
		f.hints.get("qorpera_profile_access_state")!();
		await draw();
		expect(vi.mocked(f.api.getTeam).mock.calls.length).toBeGreaterThan(teamReads);
		expect(notes.isConnected).toBe(true);
		expect(document.activeElement).toBe(notes);
		expect(folder.list).toHaveBeenCalledOnce();
	});
	it("opens Storage from the Company card in the same dialog and reaches Recents by keyboard", async () => {
		const folder = storageFixture();
		const f = await setup();
		open(f.root);
		click(f.root, "#settings-tab-company");
		await draw();
		const dialog = f.root.querySelector(".settings-dialog");
		click(f.root, "button.settings-file-card");
		await draw();
		expect(f.root.querySelector(".settings-dialog")).toBe(dialog);
		expect(location.hash).toBe(`#/c/${profileA.profileId}/chat/${session.sessionId}`);
		const documents = f.root.querySelector<HTMLElement>("#settings-storage-documents")!;
		documents.focus();
		documents.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
		await draw();
		expect(document.activeElement).toBe(f.root.querySelector("#settings-storage-recents"));
		expect(f.root.querySelector("#settings-storage-recents")?.getAttribute("aria-selected")).toBe("true");
		expect(f.root.querySelector<HTMLElement>(".storage-recents")?.hidden).toBe(false);
		expect(folder.history).toHaveBeenCalledOnce();
	});
	/** A Storage folder that also reads: `operations` is a folder, any other path an HTML page. */
	function linkedFolder() {
		const folder = storageFixture();
		const html = "<p>Dashboard</p>";
		const read = vi.fn(async (path: string) => ({
			asOfSeq: 1,
			entry:
				path === "operations"
					? { path, kind: "folder", version: id(103), seq: 1, updatedAt: timestamp, file: null, target: null }
					: {
							path,
							kind: "file",
							version: id(102),
							seq: 1,
							updatedAt: timestamp,
							file: {
								manifestSha256: "a".repeat(64),
								fileSha256: "b".repeat(64),
								bytes: html.length,
								mediaType: "text/html",
								executable: false,
							},
							target: null,
						},
		}));
		const readFile = vi.fn(async () => new TextEncoder().encode(html));
		vi.mocked(WebCompanyFiles.prototype.folder).mockImplementation(function (this: WebCompanyFiles) {
			folder.source.push(this);
			return { list: folder.list, history: folder.history, read, readFile } as never;
		});
		return { ...folder, read, readFile };
	}
	/** An agent's message with two folder links, in the open conversation. */
	function linksInMessage(root: Element) {
		const prose = markdown("See [the dashboard](folder:notes/dashboard.html) and [operations](folder:operations).");
		root.querySelector("main")!.append(prose);
		const [dashboard, operations] = prose.querySelectorAll<HTMLButtonElement>(".folder-link");
		return { prose, dashboard: dashboard!, operations: operations! };
	}
	/** The dashboard's link opens the page beside the chat (interface apps, 5 Nov 2026); its Show in Storage opens it
	 * in Storage, over the conversation, as a folder link to any other file does. */
	async function dashboardInStorage(root: Element) {
		const links = linksInMessage(root);
		links.dashboard.click();
		await draw();
		root.querySelector<HTMLButtonElement>('.side-panel [aria-label="Show in Storage"]')!.click();
		return links;
	}
	it("opens Storage at a folder link's file or folder, over the conversation", async () => {
		const folder = linkedFolder();
		const f = await setup();
		const { prose, dashboard, operations } = linksInMessage(f.root);
		const followed = new MouseEvent("click", { bubbles: true, cancelable: true });
		dashboard.dispatchEvent(followed);
		expect(followed.defaultPrevented).toBe(true);
		await draw();
		// An HTML page opens beside the chat, which stays as it is; its Show in Storage opens Storage there.
		expect(f.root.querySelector(".thread-body.has-beside .side-panel .side-panel-title")?.textContent).toBe(
			"dashboard.html",
		);
		expect(f.root.querySelector(".settings-dialog")).toBeNull();
		f.root.querySelector<HTMLButtonElement>('.side-panel [aria-label="Show in Storage"]')!.click();
		await draw();
		await draw();
		expect(f.root.querySelector('.settings-mode[data-mode="storage"]')?.getAttribute("aria-pressed")).toBe("true");
		expect(f.root.querySelector("#settings-storage-documents")?.getAttribute("aria-selected")).toBe("true");
		expect(folder.read).toHaveBeenCalledWith("notes/dashboard.html", expect.any(AbortSignal));
		expect(folder.list).toHaveBeenLastCalledWith("notes", null, 200, expect.any(AbortSignal));
		expect(f.root.querySelector(".settings-storage-content .files-preview-head h2")?.textContent).toBe(
			"dashboard.html",
		);
		expect(f.root.querySelector(".settings-storage-content iframe.files-page-frame")?.getAttribute("sandbox")).toBe(
			"allow-scripts",
		);
		// The conversation stays where it was, below Settings.
		expect(location.hash).toBe(`#/c/${profileA.profileId}/chat/${session.sessionId}`);
		expect(prose.isConnected).toBe(true);
		// Closed and followed again, a folder link opens the folder it names.
		click(f.root, ".settings-close");
		operations.click();
		await draw();
		await draw();
		expect(folder.read).toHaveBeenLastCalledWith("operations", expect.any(AbortSignal));
		expect(folder.list).toHaveBeenLastCalledWith("operations", null, 200, expect.any(AbortSignal));
		expect(f.root.querySelector(".settings-storage-content .storage-title")?.textContent).toBe("operations");
		expect(f.root.querySelector(".settings-storage-content .files-preview")?.hasAttribute("hidden")).toBe(true);
	});
	it("still shows a folder link's file when the Company File opens only at Retry", async () => {
		const folder = linkedFolder();
		folder.list.mockRejectedValueOnce(new Error("The cloud is away"));
		const f = await setup();
		await dashboardInStorage(f.root);
		await draw();
		await draw();
		expect(f.root.querySelector(".settings-storage-content .files-preview-head h2")).toBeNull();
		const retry = [...f.root.querySelectorAll<HTMLButtonElement>(".settings-storage-content button")].find(
			(control) => control.textContent === "Retry opening Company File",
		);
		retry!.click();
		await draw();
		await draw();
		expect(folder.read).toHaveBeenCalledWith("notes/dashboard.html", expect.any(AbortSignal));
		expect(f.root.querySelector(".settings-storage-content .files-preview-head h2")?.textContent).toBe(
			"dashboard.html",
		);
		// Once shown, it is not shown again: Documents goes to the top.
		click(f.root, "#settings-storage-documents");
		await draw();
		expect(f.root.querySelector(".settings-storage-content .storage-title")?.textContent).toBe("Documents");
		expect(f.root.querySelector(".settings-storage-content .files-preview")?.hasAttribute("hidden")).toBe(true);
	});
	it("lets the keyboard into a page shown across the window, over Settings", async () => {
		const dialog = HTMLDialogElement.prototype;
		const { showModal, close } = dialog;
		dialog.showModal = function () {
			this.open = true;
		};
		dialog.close = function () {
			this.open = false;
		};
		// jsdom lays nothing out; the dialog counts only controls that are drawn.
		vi.spyOn(Element.prototype, "getClientRects").mockReturnValue([{}] as unknown as DOMRectList);
		try {
			linkedFolder();
			const f = await setup();
			await dashboardInStorage(f.root);
			await draw();
			await draw();
			f.root
				.querySelector<HTMLButtonElement>('.files-preview-head [aria-label="Show dashboard.html large"]')!
				.click();
			const large = document.querySelector<HTMLDialogElement>("dialog.page-preview-dialog")!;
			const frame = large.querySelector<HTMLIFrameElement>("iframe.page-preview-frame")!;
			const closeLarge = large.querySelector<HTMLButtonElement>(".surface-close")!;
			expect(document.activeElement).toBe(closeLarge);
			// Tab goes on from Close into the page: neither the dialog nor Settings holds it back.
			const forwards = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
			closeLarge.dispatchEvent(forwards);
			expect(forwards.defaultPrevented).toBe(false);
			// Shift+Tab from Close, the first control, goes round to the page.
			const backwards = new KeyboardEvent("keydown", {
				key: "Tab",
				shiftKey: true,
				bubbles: true,
				cancelable: true,
			});
			closeLarge.dispatchEvent(backwards);
			expect(backwards.defaultPrevented).toBe(true);
			expect(document.activeElement).toBe(frame);
			// Escape closes the page and leaves Settings open.
			closeLarge.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
			expect(document.querySelector("dialog.page-preview-dialog")).toBeNull();
			expect(f.root.querySelector(".settings-dialog")).not.toBeNull();
		} finally {
			dialog.showModal = showModal;
			dialog.close = close;
		}
	});
	it("closes a page shown across the window on Escape pressed inside it, then Settings, and the composer has focus", async () => {
		const dialog = HTMLDialogElement.prototype;
		const { showModal, close } = dialog;
		dialog.showModal = function () {
			this.open = true;
		};
		dialog.close = function () {
			this.open = false;
		};
		try {
			linkedFolder();
			const f = await setup();
			await draw();
			const composer = f.root.querySelector<HTMLTextAreaElement>(".composer textarea")!;
			expect(composer).not.toBeNull();
			await dashboardInStorage(f.root);
			await draw();
			await draw();
			const expand = f.root.querySelector<HTMLButtonElement>(
				'.files-preview-head [aria-label="Show dashboard.html large"]',
			)!;
			expand.focus();
			expand.click();
			const large = document.querySelector<HTMLDialogElement>("dialog.page-preview-dialog")!;
			const frame = large.querySelector<HTMLIFrameElement>("iframe.page-preview-frame")!;
			frame.focus();
			// 3 Nov 2026: with focus in the page, Escape went to the page and the preview stayed. The frame document
			// passes it on (public/page-preview/index.html); only a frame of this view is heard.
			const escapeFrom = (source: Window | null) => {
				const event = new MessageEvent("message", { data: { type: "qorpera-page-escape" } });
				Object.defineProperty(event, "source", { value: source });
				window.dispatchEvent(event);
			};
			escapeFrom(document.createElement("iframe").contentWindow);
			escapeFrom(null);
			expect(document.querySelector("dialog.page-preview-dialog")).not.toBeNull();
			escapeFrom(frame.contentWindow);
			expect(document.querySelector("dialog.page-preview-dialog")).toBeNull();
			expect(document.activeElement).toBe(expand);
			expect(f.root.querySelector(".settings-dialog")).not.toBeNull();
			// Escape again closes the file, then Settings, opened from the conversation's link: typing goes on in the
			// composer.
			const press = () =>
				(document.activeElement ?? document.body).dispatchEvent(
					new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
				);
			press();
			expect(f.root.querySelector(".files-preview-head")?.closest("[hidden]")).not.toBeNull();
			expect(f.root.querySelector(".settings-dialog")).not.toBeNull();
			press();
			expect(f.root.querySelector(".settings-dialog")).toBeNull();
			expect(document.activeElement).toBe(composer);
		} finally {
			dialog.showModal = showModal;
			dialog.close = close;
		}
	});
	it("keeps Tab inside the available Settings controls while a storage folder read is pending", async () => {
		const folder = storageFixture();
		const f = await setup();
		open(f.root);
		click(f.root, '.settings-mode[data-mode="storage"]');
		await draw();
		const files = f.root.querySelector<HTMLElement>(".files-root")!;
		// jsdom does not reflect HTMLElement.inert to its attribute as browsers do.
		Object.defineProperty(files, "inert", {
			configurable: true,
			get: () => files.hasAttribute("inert"),
			set: (value: boolean) => files.toggleAttribute("inert", value),
		});
		const loading = deferred<Awaited<ReturnType<typeof folder.list>>>();
		folder.list.mockReturnValueOnce(loading.promise);
		click(files, '.files-row-main[data-path="notes"]');
		expect(files.inert).toBe(true);
		const content = f.root.querySelector<HTMLElement>("#settings-storage-content")!;
		content.focus();
		const forwards = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
		content.dispatchEvent(forwards);
		expect(forwards.defaultPrevented).toBe(true);
		expect(document.activeElement?.closest(".settings-header")).not.toBeNull();
		expect(document.activeElement?.closest("[inert]")).toBeNull();
		const backwards = new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true });
		document.activeElement!.dispatchEvent(backwards);
		expect(backwards.defaultPrevented).toBe(true);
		expect(document.activeElement).toBe(content);
		loading.resolve({ asOfSeq: 1, entries: [], next: null });
		await draw();
		expect(files.inert).toBe(false);
	});
	it.each(["revocation", "sign out"])("ends Storage reads and removes the dialog on %s", async (change) => {
		const folder = storageFixture();
		const f = await setup();
		open(f.root);
		click(f.root, '.settings-mode[data-mode="storage"]');
		await draw();
		const current = folder.source.at(-1)!;
		expect(current.signal.aborted).toBe(false);
		if (change === "sign out") f.auth(null);
		else {
			vi.mocked(f.api.getTeam).mockRejectedValue(
				new CloudRpcError("getTeam", { code: "42501", message: "Access revoked" }),
			);
			f.hints.get("qorpera_profile_access_state")!();
		}
		await draw();
		expect(current.signal.aborted).toBe(true);
		expect(() => current.current()).toThrow();
		expect(f.root.querySelector(".settings-overlay")).toBeNull();
	});
	it("selects the top matching tab when a search hides the open one", async () => {
		const f = await setup();
		open(f.root);
		await draw();
		const search = f.root.querySelector<HTMLInputElement>('.settings-header input[aria-label="Search settings"]')!;
		// Company holds the good will counted on sales, Leaderboard ranks friends by them; General has neither.
		search.value = "sales";
		search.dispatchEvent(new Event("input"));
		const shown = [
			...f.root.querySelectorAll<HTMLElement>('.settings-nav:not(.settings-storage-nav) [role="tab"]'),
		].filter((tab) => !tab.hidden);
		expect(shown.map((tab) => tab.id)).toEqual(["settings-tab-company", "settings-tab-leaderboard"]);
		expect(f.root.querySelector("#settings-tab-company")?.getAttribute("aria-selected")).toBe("true");
	});
	it("reads the Leaderboard once its tab opens: busiest friends, then top earners", async () => {
		const f = await setup();
		const person = (id: string, name: string, me: boolean, tasks: number, revenueOre: number) => ({
			user_id: id,
			display_name: name,
			me,
			last_seen_at: me ? null : timestamp,
			companies: 1,
			tasks,
			last_week_tasks: 0,
			revenue_ore: revenueOre,
			main_profile_id: null,
		});
		vi.mocked(f.cloud.rpc).mockImplementation(async (name: string) => {
			if (name === "qorpera_friends_leaderboard")
				return {
					since: "2026-11-02T00:00:00Z",
					until: "2026-11-09T00:00:00Z",
					week: 45,
					hidden: false,
					people: [person(userA.id, "Account A", true, 10, 500000), person(userB.id, "Account B", false, 20, 0)],
					companies: [],
				};
			if (name === "qorpera_list_review_rules") return [];
			throw new Error("Unexpected RPC");
		});
		const leaderboardCalls = () =>
			vi.mocked(f.cloud.rpc).mock.calls.filter(([name]) => name === "qorpera_friends_leaderboard");
		open(f.root);
		await draw();
		expect(leaderboardCalls()).toEqual([]);
		click(f.root, "#settings-tab-leaderboard");
		await draw();
		expect(leaderboardCalls()).toEqual([["qorpera_friends_leaderboard", {}]]);
		const content = f.root.querySelector<HTMLElement>("#settings-content")!;
		expect(content.querySelector("h1")?.textContent).toBe("Leaderboard");
		const rows = () => [...content.querySelectorAll(".leaderboard-row")].map((row) => row.textContent ?? "");
		expect(rows()).toHaveLength(2);
		expect(rows()[0]).toContain("Account B");
		expect(content.querySelector(".leaderboard-row.is-me")?.textContent).toContain("Account A");
		click(content, '[data-board="earning-friends"]');
		expect(rows()[0]).toContain("Account A");
		// The categories switch on the page; the board is read once.
		expect(leaderboardCalls()).toHaveLength(1);
		expect(content.querySelector('.leaderboard-visible [role="switch"]')?.getAttribute("aria-checked")).toBe("true");
	});
	it("finds the member's own logins and the company's services on their own tabs", async () => {
		const f = await setup();
		open(f.root);
		await draw();
		const search = f.root.querySelector<HTMLInputElement>('.settings-header input[aria-label="Search settings"]')!;
		const shown = (words: string) => {
			search.value = words;
			search.dispatchEvent(new Event("input"));
			return [...f.root.querySelectorAll<HTMLElement>('.settings-nav:not(.settings-storage-nav) [role="tab"]')]
				.filter((tab) => !tab.hidden)
				.map((tab) => tab.id);
		};
		expect(shown("connections")).toEqual(["settings-tab-ai-subscriptions", "settings-tab-company-connections"]);
		// The Danish word finds both too: the labels are English, so the keywords carry it.
		expect(shown("forbindelser")).toEqual(["settings-tab-ai-subscriptions", "settings-tab-company-connections"]);
		expect(shown("chatgpt")).toEqual(["settings-tab-ai-subscriptions"]);
		expect(shown("claude")).toEqual(["settings-tab-ai-subscriptions"]);
		expect(shown("github")).toEqual(["settings-tab-company-connections"]);
		expect(shown("gmail")).toEqual(["settings-tab-company-connections"]);
		expect(shown("webhooks")).toEqual(["settings-tab-company-connections"]);
		expect(shown("postkasser")).toEqual(["settings-tab-company-connections"]);
	});
	it("shows the company's websites on Sites, read only once that tab opens", async () => {
		const f = await setup();
		vi.mocked(f.cloud.rpc).mockImplementation(async (name: string) => {
			if (name === "qorpera_list_company_sites") return [];
			throw new Error("Unexpected RPC");
		});
		open(f.root);
		await draw();
		expect(sdkRpcs(f)).not.toContain("qorpera_list_company_sites");
		// The Danish word finds it too: the label is English, so the keywords carry it. The search shows the one tab
		// it finds, which opens the page.
		const search = f.root.querySelector<HTMLInputElement>('.settings-header input[aria-label="Search settings"]')!;
		search.value = "hjemmesider";
		search.dispatchEvent(new Event("input"));
		expect(navTabs(f.root)).toEqual(["sites"]);
		expect(selectedTab(f.root)).toBe("sites");
		search.value = "";
		search.dispatchEvent(new Event("input"));
		click(f.root, "#settings-tab-sites");
		await draw();
		const content = f.root.querySelector<HTMLElement>("#settings-content")!;
		expect(content.querySelector("h1")?.textContent).toBe("Sites");
		expect(content.querySelector(".settings-lead")?.textContent).toBe(
			"Websites the company's agents published. Each has its own link and password; share both with the people who should see it.",
		);
		expect(content.textContent).toContain("No sites yet.");
		expect(sdkRpcs(f).filter((name) => name === "qorpera_list_company_sites")).toHaveLength(1);
	});
	it("brings a service sign-in back to Company connections", async () => {
		sessionStorage.setItem(
			"qorpera.connector-sign-in.v1",
			JSON.stringify({
				ticketId: id(61),
				connectorId: "github",
				companyId: profileA.profileId,
				serviceOrigin: "https://broker.fixture.invalid",
				browserProof: "a".repeat(43),
				startedAt: Date.now(),
			}),
		);
		history.replaceState(null, "", `/#/c/${profileA.profileId}?connector=github&connection=failed&reason=declined`);
		const f = await setup();
		await draw();
		expect(f.root.querySelector("#settings-tab-company-connections")?.getAttribute("aria-selected")).toBe("true");
		expect(f.root.querySelector("#settings-content h1")?.textContent).toBe("Company connections");
		expect(f.root.querySelector('#settings-content .service-card[data-connector="github"]')?.textContent).toContain(
			"GitHub was not connected. The sign-in was cancelled before access was granted.",
		);
	});
	it("accepts a company invitation from the Friends window and opens that company", async () => {
		const fixtureState = fixture();
		const invitation = {
			id: id(43),
			profileId: profileB.profileId,
			environmentId: profileB.environmentId,
			profileName: profileB.profileName,
			environmentName: profileB.environmentName,
			email: userA.email!,
			role: "contributor" as const,
			invitedByUserId: userB.id,
			createdAt: timestamp,
			expiresAt: "2099-01-01T00:00:00Z",
		};
		vi.mocked(fixtureState.api.listIncomingInvitations).mockResolvedValue([invitation]);
		const accept = vi.spyOn(fixtureState.api, "acceptInvitation").mockImplementation(async () => {
			vi.mocked(fixtureState.api.listIncomingInvitations).mockResolvedValue([]);
			vi.mocked(fixtureState.api.listProfiles).mockResolvedValue([profileA, profileB]);
		});
		const f = await setup(fixtureState);
		// The waiting invitation shows on the friends button and on the account menu's Friends item.
		expect(f.root.querySelector(".account-friends .account-friends-dot")).not.toBeNull();
		click(f.root, ".account-trigger");
		expect(f.root.querySelector('[data-account-action="friends"] .account-count')?.textContent).toBe("1");
		click(f.root, '[data-account-action="friends"]');
		await draw();
		expect(f.root.querySelector<HTMLDialogElement>(".friends-window")?.open).toBe(true);
		const row = f.root.querySelector(".friends-window .person-row")!;
		expect(row.textContent).toContain(profileB.profileName);
		// The expiry sits in the second line, which stays visible on phones.
		expect(row.querySelector(".person-copy > span")?.textContent).toMatch(/^Invited as contributor · expires \S/);
		expect(row.querySelector(".person-meta")).toBeNull();
		[...row.querySelectorAll("button")].find((button) => button.textContent === "Accept")!.click();
		await draw();
		expect(accept).toHaveBeenCalledExactlyOnceWith(invitation.id);
		expect(location.hash).toBe(`#/c/${profileB.profileId}`);
		expect(f.root.querySelector(".account-friends .account-friends-dot")).toBeNull();
		// The company opens, and the Friends window gives way to it.
		expect(f.root.querySelector(".friends-window")).toBeNull();
		expect(f.root.querySelector<HTMLElement>(".frame")!.inert).toBe(false);
	});
	it("declines a company invitation without closing the Friends window", async () => {
		const fixtureState = fixture();
		vi.mocked(fixtureState.api.listIncomingInvitations).mockResolvedValue([
			{
				id: id(43),
				profileId: profileB.profileId,
				environmentId: profileB.environmentId,
				profileName: profileB.profileName,
				environmentName: profileB.environmentName,
				email: userA.email!,
				role: "viewer",
				invitedByUserId: userB.id,
				createdAt: timestamp,
				expiresAt: "2099-01-01T00:00:00Z",
			},
		]);
		const decline = vi.spyOn(fixtureState.api, "declineInvitation").mockImplementation(async () => {
			vi.mocked(fixtureState.api.listIncomingInvitations).mockResolvedValue([]);
		});
		const f = await setup(fixtureState);
		// The friends button beside the account opens the window too.
		click(f.root, ".account-friends");
		await draw();
		[...f.root.querySelectorAll<HTMLButtonElement>(".friends-window .person-row button")]
			.find((button) => button.textContent === "Decline")!
			.click();
		await draw();
		expect(decline).toHaveBeenCalledExactlyOnceWith(id(43));
		expect(location.hash).toBe(`#/c/${profileA.profileId}/chat/${session.sessionId}`);
		expect(f.root.querySelector<HTMLDialogElement>(".friends-window")?.open).toBe(true);
		expect(f.root.querySelector(".account-friends .account-friends-dot")).toBeNull();
		expect(f.root.querySelector(".friends-window")?.textContent).not.toContain(profileB.profileName);
	});
	it("sends a friend request only to an address an account holds", async () => {
		const f = await setup();
		const send = vi.spyOn(f.api, "sendFriendRequest").mockResolvedValue();
		const find = vi
			.mocked(f.api.findAccountByEmail)
			.mockImplementation(async (email) =>
				email === "new@example.invalid" ? { userId: id(45), email, displayName: "New Person", self: false } : null,
			);
		openFriendsWindow(f.root);
		await draw();
		const field = f.root.querySelector<HTMLInputElement>(".friends-window .panel-search input")!,
			submit = f.root.querySelector<HTMLButtonElement>('.friends-window .panel-search button[type="submit"]')!,
			panel = () => f.root.querySelector(".friends-window .panel")!,
			names = () => [...panel().querySelectorAll(".person-row strong")].map((name) => name.textContent),
			typeIn = async (value: string) => {
				field.value = value;
				field.dispatchEvent(new Event("input"));
				await draw();
			};
		// A whole address no account holds finds nobody, and no request can go to it.
		await typeIn("nobody@example.invalid");
		expect(panel().querySelector(".skeleton-list")).not.toBeNull();
		expect(submit.disabled).toBe(true);
		await vi.advanceTimersByTimeAsync(250);
		await draw();
		expect(find).toHaveBeenCalledExactlyOnceWith("nobody@example.invalid");
		expect(panel().querySelector(".skeleton-list")).toBeNull();
		expect(panel().textContent).toContain("No Qorpera account uses nobody@example.invalid.");
		expect(names()).toEqual([]);
		expect(submit.disabled).toBe(true);
		field.form!.dispatchEvent(new Event("submit", { cancelable: true }));
		await draw();
		expect(send).not.toHaveBeenCalled();
		// An address still being typed is not looked up; the one typing stops at is.
		await typeIn("new@example.inv");
		await typeIn("New@Example.invalid");
		await vi.advanceTimersByTimeAsync(250);
		await draw();
		expect(find).toHaveBeenCalledTimes(2);
		expect(find).toHaveBeenLastCalledWith("new@example.invalid");
		expect(names()).toEqual(["New Person"]);
		expect(panel().textContent).toContain("Add a friend");
		expect(submit.disabled).toBe(false);
		submit.click();
		await draw();
		expect(send).toHaveBeenCalledExactlyOnceWith("new@example.invalid");
		expect(f.api.listFriends).toHaveBeenCalledTimes(2);
		expect(f.root.querySelector(".friends-window")?.textContent).toContain("Request sent to new@example.invalid.");
		expect(field.value).toBe("");
		expect(names()).toEqual([]);
		// An address already answered is not asked again, until "no account" may have changed.
		await typeIn("nobody@example.invalid");
		expect(panel().textContent).toContain("No Qorpera account uses nobody@example.invalid.");
		expect(find).toHaveBeenCalledTimes(2);
		await typeIn("");
		await vi.advanceTimersByTimeAsync(60_000);
		await typeIn("nobody@example.invalid");
		await vi.advanceTimersByTimeAsync(250);
		await draw();
		expect(find).toHaveBeenCalledTimes(3);
		expect(panel().textContent).toContain("No Qorpera account uses nobody@example.invalid.");
	});
	it("shows only the answer for the address the field holds now, and says when it is your own", async () => {
		const f = await setup();
		const slow = deferred<HostedAccountMatch | null>();
		const find = vi
			.mocked(f.api.findAccountByEmail)
			.mockImplementation((email) =>
				email === "slow@example.invalid"
					? slow.promise
					: Promise.resolve({ userId: userA.id, email, displayName: "Me", self: true }),
			);
		openFriendsWindow(f.root);
		await draw();
		const field = f.root.querySelector<HTMLInputElement>(".friends-window .panel-search input")!,
			submit = f.root.querySelector<HTMLButtonElement>('.friends-window .panel-search button[type="submit"]')!,
			panel = () => f.root.querySelector(".friends-window .panel")!,
			names = () => [...panel().querySelectorAll(".person-row strong")].map((name) => name.textContent),
			typeIn = async (value: string) => {
				field.value = value;
				field.dispatchEvent(new Event("input"));
				await draw();
			};
		await typeIn("slow@example.invalid");
		await vi.advanceTimersByTimeAsync(250);
		await draw();
		await typeIn("me@example.invalid");
		await vi.advanceTimersByTimeAsync(250);
		await draw();
		expect(panel().textContent).toContain("That is your own address.");
		expect(submit.disabled).toBe(true);
		// Typed again while its answer is on the way, an address waits for that answer instead of asking twice.
		await typeIn("slow@example.invalid");
		await vi.advanceTimersByTimeAsync(250);
		await draw();
		expect(panel().querySelector(".skeleton-list")).not.toBeNull();
		await typeIn("me@example.invalid");
		expect(find).toHaveBeenCalledTimes(2);
		// The first address's answer arrives late: the field has moved on.
		slow.resolve({ userId: id(46), email: "slow@example.invalid", displayName: "Slow", self: false });
		await draw();
		expect(names()).toEqual([]);
		expect(panel().textContent).toContain("That is your own address.");
		// It was kept, so that address shows its account at once.
		await typeIn("slow@example.invalid");
		expect(names()).toEqual(["Slow"]);
		expect(submit.disabled).toBe(false);
		expect(find).toHaveBeenCalledTimes(2);
	});
	it("asks again after a failed lookup, and lets any address through on a cloud without the lookup", async () => {
		const f = await setup();
		const send = vi.spyOn(f.api, "sendFriendRequest").mockResolvedValue();
		const find = vi.mocked(f.api.findAccountByEmail).mockRejectedValueOnce(new Error("The network is down."));
		openFriendsWindow(f.root);
		await draw();
		const field = f.root.querySelector<HTMLInputElement>(".friends-window .panel-search input")!,
			submit = f.root.querySelector<HTMLButtonElement>('.friends-window .panel-search button[type="submit"]')!,
			panel = () => f.root.querySelector(".friends-window .panel")!,
			typeIn = async (value: string) => {
				field.value = value;
				field.dispatchEvent(new Event("input"));
				await draw();
			};
		await typeIn("new@example.invalid");
		await vi.advanceTimersByTimeAsync(250);
		await draw();
		expect(panel().textContent).toContain("The network is down.");
		expect(submit.disabled).toBe(true);
		// Until the release that adds the lookup is live, the cloud refuses an address no account holds.
		find.mockRejectedValue(
			new CloudRpcError("qorpera_find_account_by_email", { message: "missing", code: "PGRST202" }, 404),
		);
		[...panel().querySelectorAll("button")].find((button) => button.textContent === "Try again")!.click();
		await draw();
		expect(find).toHaveBeenCalledTimes(2);
		expect(panel().textContent).toContain("Nobody here by that address. Send new@example.invalid a friend request.");
		expect(submit.disabled).toBe(false);
		await typeIn("other@example.invalid");
		await vi.advanceTimersByTimeAsync(250);
		await draw();
		expect(find).toHaveBeenCalledTimes(2);
		expect(submit.disabled).toBe(false);
		submit.click();
		await draw();
		expect(send).toHaveBeenCalledExactlyOnceWith("other@example.invalid");
	});
	it("sends on Enter pressed before the answer came, once the address finds someone", async () => {
		const f = await setup();
		const send = vi.spyOn(f.api, "sendFriendRequest").mockResolvedValue();
		const find = vi
			.mocked(f.api.findAccountByEmail)
			.mockImplementation(async (email) =>
				email === "new@example.invalid" ? { userId: id(45), email, displayName: "New Person", self: false } : null,
			);
		openFriendsWindow(f.root);
		await draw();
		const field = f.root.querySelector<HTMLInputElement>(".friends-window .panel-search input")!,
			enter = () =>
				field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
		field.value = "nobody@example.invalid";
		field.dispatchEvent(new Event("input"));
		enter();
		await draw();
		expect(find).toHaveBeenCalledExactlyOnceWith("nobody@example.invalid");
		expect(send).not.toHaveBeenCalled();
		field.value = "new@example.invalid";
		field.dispatchEvent(new Event("input"));
		enter();
		await draw();
		expect(find).toHaveBeenCalledTimes(2);
		expect(send).toHaveBeenCalledExactlyOnceWith("new@example.invalid");
		expect(field.value).toBe("");
		// Enter twice before a slow answer: one request, and the field keeps the address if it fails.
		const refused = deferred<void>();
		send.mockReturnValueOnce(refused.promise);
		find.mockClear();
		field.value = "second@example.invalid";
		field.dispatchEvent(new Event("input"));
		find.mockResolvedValueOnce({
			userId: id(47),
			email: "second@example.invalid",
			displayName: "Second",
			self: false,
		});
		enter();
		enter();
		await draw();
		expect(send).toHaveBeenCalledTimes(2);
		expect(field.value).toBe("second@example.invalid");
		refused.reject(new Error("The cloud refused it."));
		await draw();
		expect(f.root.querySelector(".friends-window")?.textContent).toContain("The cloud refused it.");
		expect(field.value).toBe("second@example.invalid");
	});
	it("looks up a friend's address again once they are no longer a friend", async () => {
		const fixtureState = fixture();
		vi.mocked(fixtureState.api.listFriends).mockResolvedValueOnce([
			{
				userId: userB.id,
				email: userB.email!,
				displayName: "Friend B",
				status: "accepted",
				direction: "outgoing",
				since: timestamp,
			},
		]);
		const f = await setup(fixtureState);
		const remove = vi.spyOn(f.api, "removeFriend").mockResolvedValue();
		const find = vi
			.mocked(f.api.findAccountByEmail)
			.mockImplementation(async (email) => ({ userId: userB.id, email, displayName: "Friend B", self: false }));
		openFriendsWindow(f.root);
		await draw();
		const field = f.root.querySelector<HTMLInputElement>(".friends-window .panel-search input")!,
			submit = f.root.querySelector<HTMLButtonElement>('.friends-window .panel-search button[type="submit"]')!,
			panel = () => f.root.querySelector(".friends-window .panel")!;
		// A friend's address shows the friend, and is not looked up.
		field.value = userB.email!;
		field.dispatchEvent(new Event("input"));
		await vi.advanceTimersByTimeAsync(250);
		await draw();
		expect(find).not.toHaveBeenCalled();
		expect(submit.disabled).toBe(true);
		[...panel().querySelectorAll("button")].find((button) => button.textContent === "Remove")!.click();
		await draw();
		expect(remove).toHaveBeenCalledExactlyOnceWith(userB.id);
		await vi.advanceTimersByTimeAsync(250);
		await draw();
		expect(find).toHaveBeenCalledExactlyOnceWith(userB.email!.toLowerCase());
		expect(panel().querySelector(".skeleton-list")).toBeNull();
		expect(panel().textContent).toContain("Add a friend");
		expect(submit.disabled).toBe(false);
	});
	it("never moves the Friends field: composed text filters the list and the field keeps focus", async () => {
		history.replaceState(null, "", "/#/");
		const fixtureState = fixture(),
			profiles = deferred<(typeof profileA)[]>(),
			friend = { status: "accepted", direction: "outgoing", since: timestamp } as const;
		vi.mocked(fixtureState.api.listProfiles).mockReturnValue(profiles.promise);
		vi.mocked(fixtureState.api.listFriends).mockResolvedValue([
			{ ...friend, userId: userB.id, email: userB.email!, displayName: "Émile" },
			{ ...friend, userId: id(44), email: "carl@example.invalid", displayName: "Carl" },
		]);
		const f = await setup(fixtureState);
		openFriendsWindow(f.root);
		await draw();
		const field = f.root.querySelector<HTMLInputElement>(".friends-window .panel-search input")!,
			names = () =>
				[...f.root.querySelectorAll(".friends-window .person-row strong")].map((name) => name.textContent);
		expect(names()).toEqual(["Émile", "Carl"]);
		// Every removal that took the field out of the page, even if it was put back afterwards.
		const removed: Node[] = [],
			observer = new MutationObserver((records) => {
				for (const record of records) removed.push(...record.removedNodes);
			}),
			fieldRemovals = () => {
				for (const record of observer.takeRecords()) removed.push(...record.removedNodes);
				return removed.filter((node) => node.contains(field));
			};
		observer.observe(f.root, { childList: true, subtree: true });
		// A dead key (´ then e on a Danish Mac) or an IME composes "é"; the list filters while it composes.
		field.focus();
		field.dispatchEvent(new CompositionEvent("compositionstart"));
		field.value = "é";
		field.dispatchEvent(new InputEvent("input", { isComposing: true }));
		await draw();
		expect(fieldRemovals()).toEqual([]);
		expect(document.activeElement).toBe(field);
		expect(names()).toEqual(["Émile"]);
		// The company list arriving mid-composition draws the window again; nothing it shows changed.
		const row = f.root.querySelector(".friends-window .person-row");
		profiles.resolve([profileA]);
		await draw();
		expect(f.api.listProfiles).toHaveBeenCalled();
		expect(fieldRemovals()).toEqual([]);
		expect(document.activeElement).toBe(field);
		expect(field.value).toBe("é");
		expect(f.root.querySelector(".friends-window .person-row")).toBe(row);
		observer.disconnect();
	});
	it("draws the Friends dates again in a time zone chosen while the window was closed", async () => {
		history.replaceState(null, "", "/#/");
		const fixtureState = fixture();
		// 23:30 UTC on 5 September is already 6 September in Auckland.
		vi.mocked(fixtureState.api.listFriends).mockResolvedValue([
			{
				status: "accepted",
				direction: "outgoing",
				since: "2026-09-05T23:30:00Z",
				userId: userB.id,
				email: userB.email!,
				displayName: "Émile",
			},
		]);
		expect(setTimeZonePreference("UTC")).toBe(true);
		try {
			const f = await setup(fixtureState);
			openFriendsWindow(f.root);
			await draw();
			const row = () => f.root.querySelector(".friends-window .person-row")?.textContent;
			expect(row()).toContain("since Sep 5, 2026");
			click(f.root, ".friends-window-close");
			expect(f.root.querySelector(".friends-window")).toBeNull();
			expect(setTimeZonePreference("Pacific/Auckland")).toBe(true);
			await draw();
			openFriendsWindow(f.root);
			await draw();
			expect(row()).toContain("since Sep 6, 2026");
		} finally {
			setTimeZonePreference("system");
		}
	});
	it("draws the Friends rows again when the window opens again, so a company logo is live", async () => {
		history.replaceState(null, "", "/#/");
		const fixtureState = fixture();
		vi.mocked(fixtureState.api.listIncomingInvitations).mockResolvedValue([
			{
				id: id(43),
				profileId: profileB.profileId,
				environmentId: profileB.environmentId,
				profileName: profileB.profileName,
				environmentName: profileB.environmentName,
				email: userA.email!,
				role: "contributor",
				invitedByUserId: userB.id,
				createdAt: timestamp,
				expiresAt: "2099-01-01T00:00:00Z",
			},
		]);
		const f = await setup(fixtureState);
		openFriendsWindow(f.root);
		await draw();
		const logo = () => f.root.querySelector(".friends-window .person-row .company-logo");
		const first = logo();
		expect(first?.isConnected).toBe(true);
		// Off the page the logo's figure stops; a theme or size change would not reach it.
		click(f.root, ".friends-window-close");
		await draw();
		expect(first?.isConnected).toBe(false);
		click(f.root, ".account-friends");
		await draw();
		expect(logo()).not.toBeNull();
		expect(logo()).not.toBe(first);
		expect(logo()?.isConnected).toBe(true);
	});
	it("offers accepted friends in the company invitation picker and sends Add a friend to the Friends window", async () => {
		const fixtureState = fixture();
		vi.mocked(fixtureState.api.listFriends).mockResolvedValue([
			{
				userId: userB.id,
				email: userB.email!,
				displayName: "Friend B",
				status: "accepted",
				direction: "outgoing",
				since: timestamp,
			},
		]);
		const f = await setup(fixtureState);
		open(f.root);
		click(f.root, "#settings-tab-company");
		await draw();
		f.root.querySelector<HTMLDetailsElement>(".company-invite")!.open = true;
		expect(f.root.querySelector(".invite-results")?.textContent).toContain("Friend B");
		expect(f.api.listFriends).toHaveBeenCalledTimes(1);
		[...f.root.querySelectorAll<HTMLButtonElement>(".company-invite button")]
			.find((button) => button.textContent === "Add a friend")!
			.click();
		// Settings close and the Friends window opens over the conversation, its search field ready to type in.
		expect(f.root.querySelector(".settings-overlay")).toBeNull();
		expect(f.root.querySelector<HTMLElement>(".frame")!.inert).toBe(false);
		const friendsWindow = f.root.querySelector<HTMLDialogElement>(".friends-window")!;
		expect(friendsWindow.open).toBe(true);
		expect(document.activeElement).toBe(friendsWindow.querySelector(".panel-search input"));
		await draw();
		// The window reads the list for itself.
		expect(f.api.listFriends).toHaveBeenCalledTimes(2);
		expect(friendsWindow.querySelector(".person-row")?.textContent).toContain("Friend B");
	});
	it("closes nested confirmation before settings, and cancels it on sign-out", async () => {
		const f = await setup();
		open(f.root);
		click(f.root, "#settings-tab-company");
		[...f.root.querySelectorAll("button")].find((button) => button.textContent === "Delete company")!.click();
		expect(document.querySelector('[role="alertdialog"]')).not.toBeNull();
		document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
		expect(document.querySelector('[role="alertdialog"]')).toBeNull();
		expect(document.querySelector('[role="dialog"]')).not.toBeNull();
		[...f.root.querySelectorAll("button")].find((button) => button.textContent === "Delete company")!.click();
		f.auth(null);
		await draw();
		expect(document.querySelector('[role="alertdialog"]')).toBeNull();
		expect(document.querySelector(".settings-overlay")).toBeNull();
	});
	it("shows the company's good will under Staff at work: its invoices and the card that pays them", async () => {
		const f = await setup();
		vi.mocked(f.api.getCompanyGoodWill).mockResolvedValue({
			profileId: profileA.profileId,
			companyName: profileA.profileName,
			canAddCard: true,
			card: { mine: true, payerName: "Ada", brand: "visa", last4: "4242" },
			months: [
				{ month: "2026-12", status: "open", netOre: 0, feeOre: 0, dueOre: 0, chargedAt: null, invoiceUrl: null },
				{
					month: "2026-11",
					status: "charged",
					netOre: 5_100_000,
					feeOre: 510_000,
					dueOre: 510_000,
					chargedAt: "2026-12-05T09:00:00Z",
					invoiceUrl: "https://invoice.stripe.com/i/1",
				},
			],
			steps: [{ fromOre: 0, toOre: 10_000_000, rateBp: 1000 }],
			minChargeOre: 10_000,
		});
		vi.spyOn(f.api, "startGoodWillCard").mockRejectedValue(new GoodWillCardError("not_open"));
		open(f.root);
		click(f.root, "#settings-tab-company");
		await draw();
		const section = f.root.querySelector<HTMLElement>("#settings-content .settings-good-will")!;
		expect(section.hidden).toBe(false);
		// Under Staff at work.
		expect(section.parentElement?.previousElementSibling?.classList.contains("settings-staff-group")).toBe(true);
		expect(section.querySelector("h2")?.textContent).toBe("Good will");
		expect(section.querySelector(".settings-lead")?.textContent).toContain(
			`${profileA.profileName} pays a good will tax`,
		);
		expect(f.api.getCompanyGoodWill).toHaveBeenCalledWith(profileA.profileId);
		const november = section.querySelector('[data-month="2026-11"]')!;
		expect(november.textContent).toContain("November 2026");
		expect(november.textContent).toContain("5,100 kr charged");
		expect(november.querySelector("a")?.getAttribute("href")).toBe("https://invoice.stripe.com/i/1");
		expect(section.querySelector('[data-month="2026-12"]')?.textContent).toContain("0 kr so far this month");
		expect(section.querySelector(".good-will-card")?.textContent).toContain("Your Visa ending 4242");
		[...section.querySelectorAll("button")].find((button) => button.textContent === "Change card")!.click();
		await draw();
		expect(f.api.startGoodWillCard).toHaveBeenCalledWith(profileA.profileId);
		expect(section.querySelector(".notice-danger")?.textContent).toBe(
			"Cards can't be added yet. Nothing is charged until then.",
		);
		// The tab is read once, and the Plan & usage tab is gone.
		click(f.root, "#settings-tab-general");
		click(f.root, "#settings-tab-company");
		await draw();
		expect(f.api.getCompanyGoodWill).toHaveBeenCalledTimes(1);
		expect(f.root.querySelector("#settings-tab-plan")).toBeNull();
	});
	it("hides good will on a cloud without it, and shows the member's companies in General with none open", async () => {
		const fixtureState = fixture();
		vi.mocked(fixtureState.api.listProfiles).mockResolvedValue([profileA, profileB]);
		const f = await setup(fixtureState);
		open(f.root);
		click(f.root, "#settings-tab-company");
		await draw();
		expect(f.root.querySelector<HTMLElement>("#settings-content .settings-good-will")?.hidden).toBe(true);
		expect(f.api.getMyGoodWill).not.toHaveBeenCalled();
		click(f.root, ".settings-close");
		location.hash = "#/";
		await draw();
		vi.mocked(f.api.getMyGoodWill).mockResolvedValue({
			year: 2026,
			paidByMeOre: 1_425_000,
			companies: [
				{
					profileId: profileA.profileId,
					name: profileA.profileName,
					netOre: 14_250_000,
					feeOre: 1_425_000,
					rateBp: 1000,
					payer: "me",
					brand: "visa",
					last4: "4242",
				},
				{
					profileId: profileB.profileId,
					name: profileB.profileName,
					netOre: 0,
					feeOre: 0,
					rateBp: 1000,
					payer: "none",
					brand: null,
					last4: null,
				},
			],
		});
		open(f.root);
		await draw();
		const mine = f.root.querySelector<HTMLElement>("#settings-content .settings-good-will-account")!;
		expect(mine.hidden).toBe(false);
		expect(mine.querySelector("h2")?.textContent).toBe("Good will in your companies");
		expect(mine.querySelector(".good-will-total")?.textContent).toBe("14,250 krpaid on your card in 2026");
		const rows = [...mine.querySelectorAll(".good-will-companies li")];
		expect(rows.map((row) => row.getAttribute("data-profile-id"))).toEqual([profileA.profileId, profileB.profileId]);
		expect(rows[0]?.textContent).toContain("142,500 kr from customers");
		expect(rows[0]?.textContent).toContain("Your Visa ending 4242");
		expect(rows[1]?.textContent).toContain("No sales yet");
		expect(rows[1]?.textContent).toContain("No card yet");
	});
	it("retries a failed storage lookup from the Company tab's storage card", async () => {
		const f = await setup();
		vi.mocked(f.api.getCompanyFile).mockRejectedValueOnce(new Error("Storage offline"));
		open(f.root);
		click(f.root, "#settings-tab-company");
		await draw();
		const file = () => f.root.querySelector("#settings-content .settings-file")!;
		expect(file().textContent).toContain("Storage information unavailable");
		const retry = () => [...file().querySelectorAll("button")].find((button) => button.textContent === "Retry");
		retry()!.click();
		// The button disables at once while the retry runs.
		expect(retry()?.disabled).toBe(true);
		await draw();
		expect(f.api.getCompanyFile).toHaveBeenCalledTimes(2);
		expect(file().textContent).not.toContain("Storage information unavailable");
	});
	it("shows the open company's rules in General, and asks to open a company when none is open", async () => {
		const fixtureState = fixture();
		vi.mocked(fixtureState.api.listProfiles).mockResolvedValue([profileA, profileB]);
		const f = await setup(fixtureState);
		open(f.root);
		await draw();
		const content = () => f.root.querySelector("#settings-content")!;
		expect(content().querySelector('.settings-rules input[aria-label="When an agent wants to:"]')).not.toBeNull();
		expect(vi.mocked(f.cloud.rpc)).toHaveBeenCalledWith("qorpera_list_review_rules", {
			p_profile_id: profileA.profileId,
		});
		click(f.root, ".settings-close");
		location.hash = "#/";
		await draw();
		vi.mocked(f.cloud.rpc).mockClear();
		open(f.root);
		await draw();
		expect(content().querySelector(".settings-rules")?.textContent).toBe("Open a company to see its rules.");
		expect(content().querySelector(".settings-rules input")).toBeNull();
		expect(vi.mocked(f.cloud.rpc)).not.toHaveBeenCalledWith("qorpera_list_review_rules", expect.anything());
	});
	it("keeps focus in General when the account plan arrives", async () => {
		const f = await setup(),
			pending = deferred<HostedAccountEntitlement>();
		vi.mocked(f.api.getAccountEntitlement).mockReturnValueOnce(pending.promise);
		open(f.root);
		await draw();
		const language = f.root.querySelector<HTMLButtonElement>(".preference-picker-button")!;
		language.focus();
		pending.resolve({
			planKey: "free",
			billingMode: "fixture",
			featureSet: "fixture",
			storageAllocation: "fixture",
			source: "fixture",
		});
		await draw();
		expect(language.isConnected).toBe(true);
		expect(document.activeElement).toBe(language);
	});
	it("shows an account failure in General", async () => {
		const f = await setup(),
			pending = deferred<HostedAccountEntitlement>();
		vi.mocked(f.api.getAccountEntitlement).mockReturnValueOnce(pending.promise);
		open(f.root);
		await draw();
		pending.reject(new Error("Account temporarily unavailable"));
		await draw();
		expect(f.root.querySelector(".settings-content")!.textContent).toContain("Account temporarily unavailable");
	});
	it("discards a late account response after closing settings or changing account", async () => {
		const f = await setup(),
			pending = deferred<HostedAccountEntitlement>();
		vi.mocked(f.api.getAccountEntitlement).mockReturnValueOnce(pending.promise);
		open(f.root);
		f.auth(userB);
		await draw();
		pending.resolve({
			planKey: "OLD PRIVATE PLAN",
			billingMode: "fixture",
			featureSet: "fixture",
			storageAllocation: "fixture",
			source: "fixture",
		});
		await draw();
		expect(f.root.querySelector(".settings-overlay")).toBeNull();
		expect(f.root.textContent).not.toContain("OLD PRIVATE PLAN");
		expect(f.root.querySelector<HTMLElement>(".frame")!.inert).toBe(false);
	});
	it("closes settings immediately when company membership is revoked", async () => {
		const f = await setup();
		open(f.root);
		click(f.root, "#settings-tab-company");
		vi.mocked(f.api.getTeam).mockRejectedValue(
			new CloudRpcError("getTeam", { code: "42501", message: "Access revoked" }),
		);
		f.hints.get("qorpera_profile_access_state")!();
		await draw();
		expect(f.root.querySelector(".settings-overlay")).toBeNull();
		expect(f.root.querySelector<HTMLElement>(".frame")!.inert).toBe(false);
		expect(f.root.querySelector("main")?.textContent).toContain("Your access to this company was revoked");
	});
	it("shows an initial team failure and recovers on retry with healthy Realtime", async () => {
		history.replaceState(null, "", "/#/");
		const fixtureState = fixture();
		vi.mocked(fixtureState.api.getTeam).mockRejectedValue(new Error("Team temporarily unavailable"));
		const f = await setup(fixtureState);
		open(f.root);
		click(f.root, "#settings-tab-company");
		// The company's private hint channel joins once Realtime holds the member's token.
		await vi.advanceTimersByTimeAsync(0);
		const channel = vi.mocked(f.cloud.supabase.channel).mock.results[0]!.value;
		vi.mocked(channel.subscribe).mock.calls[0]![0]!(REALTIME_SUBSCRIBE_STATES.SUBSCRIBED);
		await vi.advanceTimersByTimeAsync(60_000);
		expect(f.api.getTeam).toHaveBeenCalledTimes(1);
		expect(f.root.querySelector(".settings-team")!.textContent).toContain("Team temporarily unavailable");
		expect(f.root.querySelector(".settings-team")!.textContent).not.toContain("Loading team");
		// No Delete company while the team cannot be read; the empty slot hides.
		expect(f.root.querySelector(".settings-company-exit")!.childElementCount).toBe(0);
		[...f.root.querySelectorAll("button")].find((button) => button.textContent === "Retry company")!.click();
		await draw();
		expect(f.api.getTeam).toHaveBeenCalledTimes(2);
		expect(f.root.querySelector(".settings-team")!.textContent).toContain("Team temporarily unavailable");
		vi.mocked(f.api.getTeam).mockResolvedValue(team);
		[...f.root.querySelectorAll("button")].find((button) => button.textContent === "Retry company")!.click();
		await draw();
		expect(f.root.querySelector(".settings-team")!.textContent).not.toContain("Team temporarily unavailable");
		expect(f.root.querySelector(".settings-file + .settings-company-exit > .company-exit")?.textContent).toBe(
			"Delete company",
		);
		expect(sdkRpcs(f)).toEqual([]);
	});
	it("shows the company's memory between its agents and its file, and saves a choice through the cloud API", async () => {
		history.replaceState(null, "", "/#/");
		const fixtureState = fixture();
		const memory: CompanyMemory = {
			profileId: profileA.profileId,
			mode: "notebooks",
			setAt: null,
			effective: "notebooks",
			betaOffered: true,
			canManage: true,
			runsInOtherMode: 0,
		};
		vi.mocked(fixtureState.api.getCompanyMemory).mockResolvedValue(memory);
		const chosen = { ...memory, mode: "tree", setAt: timestamp, effective: "tree" } as const;
		vi.spyOn(fixtureState.api, "setCompanyMemory").mockResolvedValue(chosen);
		const f = await setup(fixtureState);
		open(f.root);
		click(f.root, "#settings-tab-company");
		await draw();
		const section = f.root.querySelector<HTMLElement>(
			".settings-staff-group + .settings-good-will-slot + .settings-memory-slot > .settings-memory",
		)!;
		expect(section.hidden).toBe(false);
		// The company's pages (C6a) come between its memory and its file.
		expect(f.root.querySelector(".settings-memory-slot + .settings-pages-slot + .settings-file")).not.toBeNull();
		expect(f.api.getCompanyMemory).toHaveBeenCalledExactlyOnceWith(profileA.profileId);
		section.querySelector<HTMLInputElement>("input[type=radio][value=tree]")!.click();
		await draw();
		expect(f.api.setCompanyMemory).toHaveBeenCalledExactlyOnceWith(profileA.profileId, "tree");
		expect(section.textContent).toContain("Saved. New runs use Shared context — Beta.");
		expect(f.api.getCompanyMemory).toHaveBeenCalledTimes(1);
		expect(sdkRpcs(f)).toEqual([]);
	});
	it("shows founders what they may do with their own membership", async () => {
		history.replaceState(null, "", "/#/");
		const member = (userId: string, role: "owner" | "admin" | "contributor") => ({
			userId,
			email: `${role}@example.test`,
			displayName: role === "owner" ? "Founder" : "Member",
			role,
			joinedAt: timestamp,
		});
		const exitFor = async (capabilities: Partial<typeof team.capabilities>, members: ReturnType<typeof member>[]) => {
			const fixtureState = fixture();
			vi.mocked(fixtureState.api.getTeam).mockResolvedValue({
				...team,
				capabilities: { ...team.capabilities, ...capabilities },
				members,
			});
			const f = await setup(fixtureState);
			open(f.root);
			click(f.root, "#settings-tab-company");
			await draw();
			const exit = f.root.querySelector<HTMLButtonElement>(".company-exit")!;
			const stepDown = [...f.root.querySelectorAll("button")].find((button) => button.textContent === "Step down");
			const roles = [...f.root.querySelectorAll<HTMLOptionElement>(".company-person select option")].map(
				(option) => option.value,
			);
			const next = exit.nextElementSibling;
			const hint = next?.classList.contains("notice") ? next.textContent : null;
			const result = {
				text: exit.textContent,
				disabled: exit.disabled,
				hint,
				stepDown: stepDown !== undefined,
				roles,
			};
			dispose?.();
			document.body.replaceChildren();
			return result;
		};
		// The last founder while a member remains: no delete, and leaving waits for another founder.
		expect(
			await exitFor({ manageFounders: true, leave: false, deleteCompany: false }, [
				member(userA.id, "owner"),
				member(userB.id, "contributor"),
			]),
		).toEqual({
			text: "Leave company",
			disabled: true,
			hint: "Make someone else a founder before you leave.",
			stepDown: false,
			roles: ["viewer", "contributor", "admin", "owner"],
		});
		// With a co-founder, a founder may leave or step down.
		expect(
			await exitFor({ manageFounders: true, leave: true, deleteCompany: false }, [
				member(userA.id, "owner"),
				member(userB.id, "owner"),
			]),
		).toEqual({ text: "Leave company", disabled: false, hint: null, stepDown: true, roles: [] });
		// While company setup runs for this founder, neither, even with a co-founder.
		expect(
			await exitFor({ manageFounders: true, leave: false, deleteCompany: false }, [
				member(userA.id, "owner"),
				member(userB.id, "owner"),
			]),
		).toEqual({
			text: "Leave company",
			disabled: true,
			hint: "Company setup must finish before you can leave.",
			stepDown: false,
			roles: [],
		});
		// The last member deletes.
		expect(
			await exitFor({ manageFounders: true, leave: false, deleteCompany: true }, [member(userA.id, "owner")]),
		).toEqual({ text: "Delete company", disabled: false, hint: null, stepDown: false, roles: [] });
	});

	it.each(["delete", "leave"])("closes settings and refreshes the hub after %s", async (action) => {
		history.replaceState(null, "", "/#/");
		const fixtureState = fixture();
		vi.mocked(fixtureState.api.getTeam).mockResolvedValue({
			...team,
			role: action === "delete" ? "owner" : "contributor",
		});
		const removal = vi
			.spyOn(fixtureState.api, action === "delete" ? "deleteProfile" : "leaveProfile")
			.mockImplementation(async () => {
				vi.mocked(fixtureState.api.listProfiles).mockResolvedValue([]);
			});
		const f = await setup(fixtureState);
		open(f.root);
		click(f.root, "#settings-tab-company");
		await draw();
		confirmCompanyRemoval(f.root, action === "delete");
		await draw();
		expect(removal).toHaveBeenCalledExactlyOnceWith(profileA.profileId);
		expect(location.hash).toBe("#/");
		expect(f.root.querySelector(".settings-overlay")).toBeNull();
		expect(f.root.querySelector<HTMLElement>(".frame")!.inert).toBe(false);
		expect(f.root.querySelector(".company-card[href]")).toBeNull();
		expect(f.api.listProfiles).toHaveBeenCalledTimes(2);
		expect(f.cloud.supabase.removeChannel).toHaveBeenCalledTimes(1);
		expect(sdkRpcs(f)).toEqual([]);
	});
	it("keeps settings and company membership after a failed deletion", async () => {
		history.replaceState(null, "", "/#/");
		const f = await setup();
		vi.spyOn(f.api, "deleteProfile").mockRejectedValue(new Error("Deletion unavailable"));
		open(f.root);
		click(f.root, "#settings-tab-company");
		await draw();
		confirmCompanyRemoval(f.root, true);
		await draw();
		expect(f.root.querySelector(".settings-company-exit")!.textContent).toContain("Deletion unavailable");
		expect(f.root.querySelector<HTMLElement>(".frame")!.inert).toBe(true);
		expect(f.root.querySelector(".company-card[href]")!.textContent).toContain(profileA.profileName);
		expect(f.api.listProfiles).toHaveBeenCalledTimes(1);
	});
	it("refreshes the hub even when revocation arrives before the deletion response", async () => {
		history.replaceState(null, "", "/#/");
		const f = await setup(),
			pending = deferred<void>();
		vi.spyOn(f.api, "deleteProfile").mockReturnValue(pending.promise);
		open(f.root);
		click(f.root, "#settings-tab-company");
		await draw();
		confirmCompanyRemoval(f.root, true);
		await draw();
		vi.mocked(f.api.getTeam).mockRejectedValue(
			new CloudRpcError("getTeam", { code: "42501", message: "Access revoked" }),
		);
		f.hints.get("qorpera_profile_access_state")!();
		await draw();
		expect(f.root.querySelector(".settings-overlay")).toBeNull();
		vi.mocked(f.api.listProfiles).mockResolvedValue([]);
		pending.resolve();
		await draw();
		expect(f.api.listProfiles).toHaveBeenCalledTimes(2);
		expect(f.root.querySelector(".company-card[href]")).toBeNull();
		expect(sdkRpcs(f)).toEqual([]);
	});
	it("ignores a deletion response from a previous account", async () => {
		history.replaceState(null, "", "/#/");
		const f = await setup(),
			pending = deferred<void>();
		vi.spyOn(f.api, "deleteProfile").mockReturnValue(pending.promise);
		open(f.root);
		click(f.root, "#settings-tab-company");
		await draw();
		confirmCompanyRemoval(f.root, true);
		await draw();
		vi.mocked(f.api.listProfiles).mockResolvedValue([profileB]);
		f.auth(userB);
		await draw();
		open(f.root);
		click(f.root, "#settings-tab-company");
		await draw();
		const settings = f.root.querySelector(".settings-overlay");
		const reads = vi.mocked(f.api.listProfiles).mock.calls.length;
		pending.resolve();
		await draw();
		expect(f.root.querySelector(".settings-overlay")).toBe(settings);
		// The new account's only company is shown by its Storage button.
		expect(
			settings!.querySelector(`#settings-content .settings-file-card[data-profile-id='${profileB.profileId}']`),
		).not.toBeNull();
		expect(f.api.listProfiles).toHaveBeenCalledTimes(reads);
		expect(f.root.querySelector<HTMLElement>(".frame")!.inert).toBe(true);
	});
	it("keeps a newer settings session open when an old deletion completes", async () => {
		history.replaceState(null, "", "/#/");
		const f = await setup(),
			pending = deferred<void>();
		vi.spyOn(f.api, "deleteProfile").mockReturnValue(pending.promise);
		open(f.root);
		click(f.root, "#settings-tab-company");
		await draw();
		confirmCompanyRemoval(f.root, true);
		await draw();
		click(f.root, ".settings-close");
		open(f.root);
		const settings = f.root.querySelector(".settings-overlay");
		vi.mocked(f.api.listProfiles).mockResolvedValue([]);
		pending.resolve();
		await draw();
		expect(f.root.querySelector(".settings-overlay")).toBe(settings);
		expect(f.root.querySelector<HTMLElement>(".frame")!.inert).toBe(true);
		// The company is gone: Settings show only the account's pages.
		expect(navTabs(f.root)).toEqual(ACCOUNT_TABS);
		expect(selectedTab(f.root)).toBe("general");
		expect(f.api.listProfiles).toHaveBeenCalledTimes(2);
	});
	it("returns the standalone Team page to an updated hub after leaving", async () => {
		history.replaceState(null, "", `/#/c/${profileA.profileId}/team`);
		const fixtureState = fixture();
		vi.mocked(fixtureState.api.getTeam).mockResolvedValue({ ...team, role: "contributor" });
		vi.spyOn(fixtureState.api, "leaveProfile").mockImplementation(async () => {
			vi.mocked(fixtureState.api.listProfiles).mockResolvedValue([]);
		});
		const f = await setup(fixtureState);
		confirmCompanyRemoval(f.root, false);
		await draw();
		expect(location.hash).toBe("#/");
		expect(f.root.querySelector(".team")).toBeNull();
		expect(f.root.querySelector(".company-card[href]")).toBeNull();
		expect(f.api.listProfiles).toHaveBeenCalledTimes(2);
		expect(f.cloud.supabase.removeChannel).toHaveBeenCalledTimes(1);
		expect(sdkRpcs(f)).toEqual([]);
	});
	it.each(["settings", "team page"])("shows a failed company deletion right under its button in %s", async (place) => {
		history.replaceState(null, "", place === "settings" ? "/#/" : `/#/c/${profileA.profileId}/team`);
		const fixtureState = fixture();
		vi.spyOn(fixtureState.api, "deleteProfile").mockRejectedValue(new Error("Deleting is paused"));
		const f = await setup(fixtureState);
		if (place === "settings") {
			open(f.root);
			click(f.root, "#settings-tab-company");
			await draw();
		}
		confirmCompanyRemoval(f.root, true);
		await draw();
		const exit = f.root.querySelector(".company-exit")!;
		expect(exit.nextElementSibling?.matches(".notice-danger")).toBe(true);
		expect(exit.nextElementSibling?.textContent).toContain("Deleting is paused");
		// Not also at the top of the page, above the members. (In settings, the pages' read fails too: the fixture
		// answers no RPC.)
		const notices = [...f.root.querySelectorAll(".notice-danger")];
		expect(notices.filter((notice) => notice.textContent?.includes("Deleting is paused"))).toHaveLength(1);
		expect(location.hash).toBe(place === "settings" ? "#/" : `#/c/${profileA.profileId}/team`);
	});
	it("does not restore a removed company from an older company-list request", async () => {
		const fixtureState = fixture(),
			pending = deferred<(typeof profileA)[]>();
		vi.mocked(fixtureState.api.listProfiles).mockResolvedValue([profileA, profileB]);
		vi.spyOn(fixtureState.api, "deleteProfile").mockResolvedValue(undefined);
		const f = await setup(fixtureState);
		vi.mocked(f.api.listProfiles).mockReturnValueOnce(pending.promise).mockResolvedValue([]);
		open(f.root);
		click(f.root, "#settings-tab-company");
		await draw();
		confirmCompanyRemoval(f.root, true);
		await draw();
		open(f.root);
		click(f.root, "#settings-tab-company");
		await draw();
		confirmCompanyRemoval(f.root, true, profileB);
		await draw();
		pending.resolve([profileB]);
		await draw();
		expect(f.api.deleteProfile).toHaveBeenCalledTimes(2);
		expect(f.root.querySelector(".company-card[href]")).toBeNull();
		expect(f.api.listProfiles).toHaveBeenCalledTimes(3);
		expect(f.root.querySelector(".settings-overlay")).toBeNull();
		expect(sdkRpcs(f)).toEqual([]);
	});
	it.each([
		["ai-subscriptions", ".connection-section-heading button", ["qorpera_list_coding_environment"]],
		[
			"company-connections",
			".service-card button:not(:disabled)",
			["qorpera_list_cloud_secret_connections", "qorpera_list_coding_environment", "qorpera_list_event_hooks"],
		],
	])("keeps the focused %s control through an unrelated company refresh", async (tab, selector, rpcs) => {
		const f = await setup();
		open(f.root);
		click(f.root, `#settings-tab-${tab}`);
		await draw();
		const content = f.root.querySelector<HTMLElement>("#settings-content")!;
		const panel = content.firstElementChild;
		const control = content.querySelector<HTMLElement>(selector)!;
		control.focus();
		const key = control.dataset.focusKey;
		expect(key).toBeTruthy();
		f.hints.get("qorpera_profile_access_state")!();
		await draw();
		// The page is not rebuilt; a list that redraws itself hands the focus to the same control.
		expect(content.firstElementChild).toBe(panel);
		expect(content.contains(document.activeElement)).toBe(true);
		expect((document.activeElement as HTMLElement).dataset.focusKey).toBe(key);
		// Opened alone, each tab reads only its own lists: AI subscriptions never reads the services.
		expect(sdkRpcs(f)).toEqual(rpcs);
	});
	it("reads only the member's own accounts on AI subscriptions, and only the company's on Company connections", async () => {
		// Isolate Settings reads from an open conversation's quota polling.
		// The Team route keeps the same company authority without a composer.
		history.replaceState(null, "", `/#/c/${profileA.profileId}/team`);
		const f = await setup(realtimeFixture());
		const connectionsUrl = "https://fixture.invalid/rest/v1/rpc/qorpera_list_member_native_execution_connections";
		const fetch = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
			if (String(input).endsWith("/qorpera_list_member_notifications")) return Response.json([]);
			if (String(input) === connectionsUrl) return Response.json({ compute_identity: null, connections: [] });
			throw new Error("Unexpected request in the settings read-only fixture");
		});
		vi.stubGlobal("fetch", fetch);
		const memberReads = () => fetch.mock.calls.filter(([url]) => String(url) === connectionsUrl);
		open(f.root);
		const content = f.root.querySelector<HTMLElement>("#settings-content")!;

		click(f.root, "#settings-tab-company-connections");
		await draw();
		expect(content.querySelector("h1")?.textContent).toBe("Company connections");
		expect(content.querySelector(".settings-lead")?.textContent).toBe(
			"The company's own accounts, webhooks and mailboxes. Every agent can use them, and they stay when someone leaves.",
		);
		// The Services section lists the Step 7 connectors with their own Connect buttons; Digital Post has its own card.
		expect(content.querySelectorAll('.service-card:not([data-connector="digital_post"])')).toHaveLength(3);
		expect(content.querySelector('.digital-post .service-card[data-connector="digital_post"]')).not.toBeNull();
		expect(content.querySelector(".connection-card, .connection-add")).toBeNull();
		await vi.advanceTimersByTimeAsync(60_000);
		// The services, the coding environment variables and the hooks are this tab's only reads; the member's own
		// accounts are not read for it.
		const companyReads = [
			"qorpera_list_cloud_secret_connections",
			"qorpera_list_coding_environment",
			"qorpera_list_event_hooks",
		];
		expect(sdkRpcs(f)).toEqual(companyReads);
		expect(memberReads()).toEqual([]);

		click(f.root, "#settings-tab-ai-subscriptions");
		await draw();
		expect(content.querySelector("h1")?.textContent).toBe("AI subscriptions");
		expect(content.querySelector(".settings-lead")?.textContent).toBe(
			"Your own AI subscriptions. They pay for the work you start, including your routines, and they leave with you.",
		);
		expect(content.querySelectorAll(".connection-card")).toHaveLength(0);
		expect(content.querySelector<HTMLButtonElement>(".connection-add")!.disabled).toBe(true);
		expect(content.querySelector<HTMLElement>(".connection-provider-picker")!.hidden).toBe(true);
		expect(content.querySelector(".service-card")).toBeNull();
		await vi.advanceTimersByTimeAsync(60_000);
		// Model accounts never go through the SDK RPC path, and the company's lists are not read again; the member's
		// own coding environment variables are read for this tab.
		expect(sdkRpcs(f)).toEqual([...companyReads, "qorpera_list_coding_environment"]);
		expect(memberReads()).toEqual([[connectionsUrl, expect.objectContaining({ method: "POST" })]]);
	});
	it("reads AI subscriptions' coding variables again after Company connections gives one to a repository", async () => {
		const f = await setup();
		const companyToken = {
			schema: "qorpera.coding-environment-secret/v1",
			secretId: id(30),
			name: "NPM_TOKEN",
			ownerKind: "company",
			purpose: "Installs private packages",
			version: 1,
			grants: [] as unknown[],
			createdAt: timestamp,
			updatedAt: timestamp,
		};
		const memberToken = {
			...companyToken,
			secretId: id(32),
			ownerKind: "member",
			purpose: "My own token",
			grants: [],
		};
		const grant = { grantId: id(41), repository: "acme/web", issuedByUserId: userA.id, createdAt: timestamp };
		vi.mocked(f.cloud.rpc).mockImplementation(async (name: string) => {
			if (name === "qorpera_list_coding_environment") return structuredClone([companyToken, memberToken]);
			if (name === "qorpera_grant_coding_environment_secret") {
				companyToken.grants = [grant];
				return { schema: "qorpera.coding-environment-grant/v1", status: "active", secretId: id(30), ...grant };
			}
			throw new Error("Unexpected RPC");
		});
		const card = (owner: string, secretId: string) =>
			f.root.querySelector<HTMLElement>(`[data-coding-environment="${owner}"] [data-variable="${secretId}"]`)!;
		const press = (root: Element, label: string) =>
			[...root.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent === label)!.click();
		const reach = () => card("member", id(32)).querySelector(".hook-state")?.textContent;
		open(f.root);
		click(f.root, "#settings-tab-ai-subscriptions");
		await draw();
		expect(reach()).toBe("Your coding sessions get it.");

		click(f.root, "#settings-tab-company-connections");
		await draw();
		press(card("company", id(30)), "Give to a repository");
		const repository = f.root.querySelector<HTMLInputElement>('input[aria-label="Repository for NPM_TOKEN"]')!;
		repository.value = "acme/web";
		repository.dispatchEvent(new Event("input"));
		press(card("company", id(30)), "Add");
		await draw();
		// The company's list and then the member's are read again.
		const reads = [
			"qorpera_list_coding_environment",
			"qorpera_list_cloud_secret_connections",
			"qorpera_list_coding_environment",
			"qorpera_list_event_hooks",
			"qorpera_grant_coding_environment_secret",
			"qorpera_list_coding_environment",
			"qorpera_list_coding_environment",
		];
		expect(sdkRpcs(f)).toEqual(reads);

		click(f.root, "#settings-tab-ai-subscriptions");
		await draw();
		expect(reach()).toBe("Your coding sessions get it. In acme/web, the company's NPM_TOKEN is used instead.");
		// Switching tabs alone reads nothing again.
		click(f.root, "#settings-tab-company-connections");
		await draw();
		click(f.root, "#settings-tab-ai-subscriptions");
		await draw();
		expect(sdkRpcs(f)).toEqual(reads);
	});
});
