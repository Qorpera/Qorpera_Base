// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthController } from "../src/app/auth.ts";
import { CompanyController } from "../src/app/company.ts";
import type { Route } from "../src/app/router.ts";
import { HubController } from "../src/app/views/hub.ts";
import { NewConversationView } from "../src/app/views/new-conversation.ts";
import { SettingsView } from "../src/app/views/settings.ts";
import { renderRail } from "../src/app/views/shell.ts";
import type { HostedCompanyOrganization } from "../src/cloud/organization.ts";
import { projectTranscript, type TranscriptMessage } from "../src/cloud/transcript.ts";
import type { HostedStaffExecutionActivity } from "../src/cloud/types.ts";
import { renderAuthorizationCard } from "../src/ui/authorization-card.ts";
import { SurfaceDialog } from "../src/ui/dialog.ts";
import { h } from "../src/ui/dom.ts";
import {
	languagePreference,
	setLanguagePreference,
	setThemePreference,
	themePreference,
	uiText,
	watchTheme,
} from "../src/ui/preferences.ts";
import { RailLayout } from "../src/ui/rail-layout.ts";
import { ReceivedAttachments } from "../src/ui/received-attachments.ts";
import {
	deferred,
	event,
	file,
	fixture,
	id,
	profileA,
	profileB,
	session,
	settle,
	staff,
	stubFigureMotion,
	team,
	timestamp,
	userA,
} from "./fixtures.ts";

const cleanup: (() => void)[] = [];
beforeEach(() => {
	localStorage.clear();
	vi.stubGlobal("innerWidth", 1280);
	// The phone layout follows the stubbed window width, as the stylesheet's media query does.
	vi.stubGlobal("matchMedia", (query: string) => ({
		matches: query === "(max-width: 760px)" && window.innerWidth <= 760,
		addEventListener() {},
		removeEventListener() {},
	}));
	HTMLDialogElement.prototype.show = function () {
		this.open = true;
	};
	HTMLDialogElement.prototype.showModal = HTMLDialogElement.prototype.show;
	HTMLDialogElement.prototype.close = function () {
		this.open = false;
	};
	URL.createObjectURL = vi.fn(() => "blob:local-fixture");
	URL.revokeObjectURL = vi.fn();
});
afterEach(() => {
	for (const dispose of cleanup.splice(0).reverse()) dispose();
	document.body.replaceChildren();
	localStorage.clear();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});
function companyFixture() {
	const f = fixture();
	const company = new CompanyController(f.api, profileA, userA.id);
	company.store.set({ loading: false, staff: [staff], sessions: [session], team });
	cleanup.push(() => company.stop());
	return { ...f, company };
}
/** The company rail and its resizer inside the app frame, drawn for the company home unless told otherwise. */
function mountRail(f: ReturnType<typeof companyFixture>, section: "home" | "file" = "home") {
	const rail = h("aside", { class: "rail" }),
		frame = h("div", { class: "frame" }, rail);
	document.body.append(frame);
	const auth = new AuthController(f.cloud);
	cleanup.push(() => auth.dispose());
	const draw = (route: Route = { name: "company", profileId: profileA.profileId, section }) =>
		renderRail(rail, f.company, {
			profiles: [profileA],
			user: userA,
			route,
			auth,
			invitations: 0,
			openSettings: () => {},
			openFeedback: () => {},
			openFriends: () => {},
		});
	draw();
	const layout = new RailLayout(frame, rail);
	frame.append(layout.el);
	cleanup.push(() => layout.dispose());
	return { rail, frame, draw, layout };
}
const imageMessage: TranscriptMessage = {
	kind: "member",
	id: id(90),
	sequence: 1,
	text: "",
	attachmentCount: 1,
	createdAt: timestamp,
	attachments: [{ kind: "image", name: "brief.png", bytes: 2048, mediaType: "image/png" }],
};

describe("shell presentation lifecycle", () => {
	it("anchors desktop details without trapping the page and switches to a mobile sheet", () => {
		const anchor = h("button", null, "Agent"),
			outside = h("button", null, "Outside");
		document.body.append(anchor, outside);
		anchor.focus();
		const closed = vi.fn();
		const view = new SurfaceDialog("Details", "agent-details", closed, anchor);
		cleanup.push(() => view.close(false));
		view.open();
		expect(view.el.getAttribute("aria-modal")).toBe("false");
		vi.stubGlobal("innerWidth", 390);
		window.dispatchEvent(new Event("resize"));
		expect(view.el.getAttribute("aria-modal")).toBe("true");
		outside.dispatchEvent(new Event("pointerdown", { bubbles: true }));
		expect(view.el.open).toBe(true);
		vi.stubGlobal("innerWidth", 1280);
		window.dispatchEvent(new Event("resize"));
		outside.dispatchEvent(new Event("pointerdown", { bubbles: true }));
		expect(view.el.isConnected).toBe(false);
		expect(closed).toHaveBeenCalledTimes(1);
	});
	it("gathers a group chat locally, retains it through refresh, and drops archived recipients", async () => {
		const f = companyFixture();
		const other = { ...staff, id: id(91), displayName: "Second agent" };
		f.company.store.set({ staff: [staff, other] });
		const view = new NewConversationView(f.company, {}, () => {});
		cleanup.push(() => view.dispose());
		document.body.append(view.el);
		const row = (key: string) => view.el.querySelector<HTMLElement>(`[role="option"][data-choice="${key}"]`);
		const search = view.el.querySelector<HTMLInputElement>('[role="combobox"]')!;
		const press = (key: string) => {
			const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
			search.dispatchEvent(event);
			return event;
		};
		row("group")!.click();
		expect(view.el.querySelector('[role="listbox"]')!.getAttribute("aria-multiselectable")).toBe("true");
		expect(row("create")).not.toBeNull();
		expect(search.placeholder).toBe("Add agents");
		for (const agent of [other, staff]) row(agent.id)!.click();
		// Chips keep the order the agents were added in.
		expect([...view.el.querySelectorAll(".recipient-chip")].map((chip) => chip.textContent)).toEqual([
			"Second agent",
			"Fixture agent",
		]);
		// Selecting recipients does not create the conversation; sending does.
		const hash = location.hash;
		expect(row("start")).toBeNull();
		expect(view.el.querySelector<HTMLButtonElement>('[aria-label="Send message"]')!.disabled).toBe(true);
		expect(location.hash).toBe(hash);
		f.company.store.set({ activity: [] });
		await settle();
		expect(view.el.querySelectorAll('[aria-selected="true"]')).toHaveLength(2);
		f.company.store.set({ staff: [staff, { ...other, employmentStatus: "archived" }] });
		await settle();
		expect(view.el.querySelectorAll(".recipient-chip")).toHaveLength(1);
		expect(view.el.querySelector<HTMLButtonElement>('[aria-label="Send message"]')!.disabled).toBe(true);
		// Backspace in the empty field takes the last agent back out.
		press("Backspace");
		expect(view.el.querySelectorAll(".recipient-chip")).toHaveLength(0);
		// Escape with the list closed puts the group chat away.
		expect(press("Escape").defaultPrevented).toBe(true);
		expect(row("create")).not.toBeNull();
		expect(view.el.querySelector('[role="listbox"]')!.getAttribute("aria-multiselectable")).toBe("true");
		expect(f.cloud.rpc).not.toHaveBeenCalled();
	});
	it("caps the rail at two fifths of the window and keeps resizing usable when storage is blocked", () => {
		const aside = h("aside", { class: "rail" }),
			frame = h("div", null, aside),
			rail = new RailLayout(frame, aside);
		frame.append(rail.el);
		cleanup.push(() => rail.dispose());
		const cap = String(Math.floor(window.innerWidth * 0.4));
		const press = (key: string) => rail.el.dispatchEvent(new KeyboardEvent("keydown", { key }));
		expect(rail.el.getAttribute("aria-valuemax")).toBe(cap);
		// The default is the earlier 456px rail made a tenth narrower twice; the 1280px fixture window shows all of it.
		expect(rail.el.getAttribute("aria-valuenow")).toBe("369");
		press("ArrowRight");
		expect(rail.el.getAttribute("aria-valuenow")).toBe("385");
		press("End");
		press("ArrowRight");
		expect(rail.el.getAttribute("aria-valuenow")).toBe(cap);
		expect(localStorage.getItem("qorpera.web.rail-width.v4")).toBe(cap);
		// Only the rail and its edge carry the width, so a change restyles nothing else.
		expect(aside.style.getPropertyValue("--rail-width")).toBe(`${cap}px`);
		expect(rail.el.style.getPropertyValue("--rail-width")).toBe(`${cap}px`);
		expect(frame.style.getPropertyValue("--rail-width")).toBe("");
		// A narrower window clamps what is shown; the preference survives until the member acts.
		vi.stubGlobal("innerWidth", 800);
		window.dispatchEvent(new Event("resize"));
		expect(rail.el.getAttribute("aria-valuenow")).toBe("320");
		expect(localStorage.getItem("qorpera.web.rail-width.v4")).toBe(cap);
		vi.stubGlobal("innerWidth", 1280);
		window.dispatchEvent(new Event("resize"));
		expect(rail.el.getAttribute("aria-valuenow")).toBe(cap);
		vi.stubGlobal("innerWidth", 800);
		window.dispatchEvent(new Event("resize"));
		press("ArrowLeft");
		expect(rail.el.getAttribute("aria-valuenow")).toBe("304");
		expect(localStorage.getItem("qorpera.web.rail-width.v4")).toBe("304");
		vi.stubGlobal("innerWidth", 1280);
		window.dispatchEvent(new Event("resize"));
		expect(rail.el.getAttribute("aria-valuenow")).toBe("304");
		// Where the cap is the minimum, a key press that moves nothing leaves the preference alone.
		vi.stubGlobal("innerWidth", 600);
		window.dispatchEvent(new Event("resize"));
		expect(rail.el.getAttribute("aria-valuenow")).toBe("240");
		press("ArrowRight");
		expect(rail.el.getAttribute("aria-valuenow")).toBe("240");
		expect(localStorage.getItem("qorpera.web.rail-width.v4")).toBe("304");
		vi.stubGlobal("innerWidth", 1280);
		window.dispatchEvent(new Event("resize"));
		expect(rail.el.getAttribute("aria-valuenow")).toBe("304");
		// Going back to the default forgets the stored width, even where the window caps it.
		vi.stubGlobal("innerWidth", 900);
		window.dispatchEvent(new Event("resize"));
		rail.el.dispatchEvent(new MouseEvent("dblclick"));
		expect(rail.el.getAttribute("aria-valuenow")).toBe("360");
		expect(localStorage.getItem("qorpera.web.rail-width.v4")).toBeNull();
		vi.stubGlobal("innerWidth", 1280);
		window.dispatchEvent(new Event("resize"));
		expect(rail.el.getAttribute("aria-valuenow")).toBe("369");
		vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
			throw new Error("Blocked");
		});
		rail.el.dispatchEvent(new KeyboardEvent("keydown", { key: "Home" }));
		expect(frame.classList.contains("rail-compact")).toBe(true);
		rail.el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
		expect(rail.el.getAttribute("aria-valuenow")).toBe("369");
	});
	it("starts every member once from the new default and keeps any width chosen since", () => {
		const shown = () => {
			const aside = h("aside", { class: "rail" }),
				rail = new RailLayout(h("div", null, aside), aside);
			cleanup.push(() => rail.dispose());
			return rail.el.getAttribute("aria-valuenow");
		};
		localStorage.setItem("qorpera.web.rail-width", "400");
		localStorage.setItem("qorpera.web.rail-width.v2", "456");
		localStorage.setItem("qorpera.web.rail-width.v3", "410");
		expect(shown()).toBe("369");
		localStorage.setItem("qorpera.web.rail-width.v4", "304");
		expect(shown()).toBe("304");
	});
	it("changes marked labels without translating company names or message text", () => {
		const label = uiText("Company"),
			content = h("p", null, "Company");
		document.body.append(label, content);
		expect(setLanguagePreference("da")).toBe(true);
		expect(label.textContent).toBe("Virksomhed");
		expect(content.textContent).toBe("Company");
		expect(languagePreference()).toBe("da");
		expect(setLanguagePreference("not-a-locale")).toBe(false);
		vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
			throw new Error("Blocked");
		});
		expect(setLanguagePreference("en")).toBe(false);
		expect(languagePreference()).toBe("da");
	});
	it("follows the device's appearance until a theme is chosen, in every open tab", () => {
		let deviceDark = false;
		const listeners = new Set<() => void>();
		vi.stubGlobal("matchMedia", (query: string) => ({
			get matches() {
				return query === "(prefers-color-scheme: dark)" && deviceDark;
			},
			addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
			removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener),
		}));
		const deviceChanged = () => {
			for (const listener of listeners) listener();
		};
		const changes = vi.fn();
		window.addEventListener("qorpera-theme-change", changes);
		const unwatch = watchTheme();
		cleanup.push(() => {
			unwatch();
			window.removeEventListener("qorpera-theme-change", changes);
			delete document.documentElement.dataset.theme;
		});
		const theme = () => document.documentElement.dataset.theme;
		expect(themePreference()).toBe("system");
		expect(theme()).toBe("light");
		deviceDark = true;
		deviceChanged();
		expect(theme()).toBe("dark");
		expect(setThemePreference("light")).toBe(true);
		expect(localStorage.getItem("qorpera.web.theme")).toBe("light");
		expect(theme()).toBe("light");
		// A chosen theme holds when the device changes.
		deviceDark = false;
		deviceChanged();
		deviceDark = true;
		deviceChanged();
		expect(theme()).toBe("light");
		expect(setThemePreference("sepia")).toBe(false);
		expect(themePreference()).toBe("light");
		// Another tab chooses Dark.
		localStorage.setItem("qorpera.web.theme", "dark");
		window.dispatchEvent(new StorageEvent("storage", { key: "qorpera.web.theme" }));
		expect(theme()).toBe("dark");
		expect(changes).toHaveBeenCalledTimes(4);
		unwatch();
		deviceDark = false;
		expect(setThemePreference("system")).toBe(true);
		expect(theme()).toBe("light");
		deviceDark = true;
		deviceChanged();
		expect(theme()).toBe("light");
		vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
			throw new Error("Blocked");
		});
		expect(setThemePreference("dark")).toBe(false);
		expect(themePreference()).toBe("system");
		expect(theme()).toBe("light");
	});
	it("ignores storage totals returned after settings moves to another company", async () => {
		const f = companyFixture(),
			auth = new AuthController(f.cloud);
		await auth.start();
		cleanup.push(() => auth.dispose());
		const pending = deferred<typeof file>();
		vi.mocked(f.api.getCompanyFile)
			.mockReturnValueOnce(pending.promise)
			.mockResolvedValue({ ...file, storageUsedBytes: 40 });
		const hub = new HubController(f.api);
		cleanup.push(() => hub.dispose());
		// On the company list, settings follow the account's only company.
		const view = new SettingsView(
			f.api,
			auth,
			hub,
			[],
			undefined,
			() => {},
			() => {},
		);
		cleanup.push(() => view.dispose());
		document.body.append(view.el);
		view.el.querySelector<HTMLButtonElement>("#settings-tab-company")!.click();
		view.updateProfiles([profileA]);
		expect(view.el.querySelector(".settings-file")?.textContent).toContain("Loading storage");
		expect(view.el.querySelector("progress")).toBeNull();
		// The company is removed and another one takes its place.
		view.updateProfiles([]);
		view.updateProfiles([profileB]);
		await settle();
		expect(view.el.querySelector(".settings-file")?.textContent).toContain("40 B used");
		pending.resolve({ ...file, storageUsedBytes: 99 });
		await settle();
		expect(view.el.querySelector(".settings-file")?.textContent).not.toContain("99 B");
		expect(view.el.querySelector(".settings-file")?.textContent).toContain("40 B used");
	});
	it("draws each agent state, with a red disc on an idle agent whose run did not finish", () => {
		const mount = stubFigureMotion();
		const f = companyFixture();
		const cofounder = {
			...staff,
			id: id(40),
			displayName: "Co-Founder",
			role: "Co-founder",
			templateId: "co-founder",
		};
		const cases: {
			name: string;
			run?: [HostedStaffExecutionActivity["jobStatus"], HostedStaffExecutionActivity["activity"]];
			proposal?: boolean;
			/** The run's details have been read (a proposal implies them). */
			details?: boolean;
			figure: string;
			line: string;
			disc: "red" | "green" | "none";
		}[] = [
			{ name: "Failed", run: ["failed", "needs_attention"], figure: "Idle", line: "Analyst", disc: "red" },
			// A run a member stopped is no failure: once its details show it left no
			// decision, the agent is idle (an older cloud still lists every stop).
			{
				name: "Stopped",
				run: ["cancelled", "needs_attention"],
				details: true,
				figure: "Idle",
				line: "Analyst",
				disc: "none",
			},
			{
				name: "Stopped mid-change",
				run: ["cancelled", "needs_attention"],
				proposal: true,
				figure: "Waiting",
				line: "Needs you",
				disc: "none",
			},
			{
				name: "Decision",
				run: ["completed", "needs_attention"],
				figure: "Waiting",
				line: "Needs you",
				disc: "none",
			},
			// A failed run that left Company File changes is a decision too.
			{
				name: "Recovery",
				run: ["failed", "needs_attention"],
				proposal: true,
				figure: "Waiting",
				line: "Needs you",
				disc: "none",
			},
			{ name: "Leased", run: ["leased", "working"], figure: "Working", line: "Working", disc: "green" },
			{ name: "Queued", run: ["queued", "waiting"], figure: "Working", line: "Working", disc: "green" },
			{ name: "Quiet", figure: "Idle", line: "Analyst", disc: "none" },
		];
		const rows = cases.map((row, index) => ({
			...row,
			runId: id(60 + index),
			agent: { ...staff, id: id(41 + index), displayName: row.name, role: "Analyst" },
		}));
		f.company.store.set({
			staff: [cofounder, ...rows.map((row) => row.agent)],
			activity: [
				...rows.flatMap(({ run, runId, agent }) =>
					run
						? [
								{
									runId,
									staffAgentId: agent.id,
									sourceKind: "session_turn" as const,
									jobStatus: run[0],
									activity: run[1],
									updatedAt: timestamp,
								},
							]
						: [],
				),
				{
					runId: id(69),
					staffAgentId: cofounder.id,
					sourceKind: "room_delivery",
					jobStatus: "failed",
					activity: "needs_attention",
					updatedAt: timestamp,
				},
			],
			recoveries: Object.fromEntries(
				rows
					.filter((row) => row.proposal || row.details)
					.map(({ runId, run, proposal }) => [
						runId,
						{
							runId,
							sourceKind: "session_turn",
							jobStatus: run?.[0] === "cancelled" ? "cancelled" : "failed",
							...(proposal ? { proposalId: id(99) } : {}),
							unsettledOperations: 0,
						},
					]),
			),
		});
		const { rail } = mountRail(f, "file");
		const figures = new Map(mount.mock.calls.map(([, , , , options]) => [options?.identity, options?.activity]));
		// A failed run shows a red "!" in place of the figure; working shows the green disc.
		const disc = (status: Element | null) =>
			!status ? "none" : status.classList.contains("alert-mark") ? "red" : "green";
		for (const { agent, figure, line, disc: shown } of rows) {
			const link = rail.querySelector(`a[href$="/staff/${agent.id}"]`)!;
			const status = link.querySelector(".rail-row-status, .alert-mark");
			expect(figures.get(agent.id), agent.displayName).toBe(figure);
			expect(link.querySelector("small")?.textContent, agent.displayName).toBe(line);
			expect(disc(status), agent.displayName).toBe(shown);
			// The disc is only drawn. The link names the state in words, which the
			// compact rail needs: it hides the text beside the figure.
			if (status) expect(status.getAttribute("aria-hidden")).toBe("true");
			const state = shown === "red" ? "A run did not finish" : line === "Analyst" ? undefined : line;
			const words = [agent.displayName, "Analyst", state].filter(Boolean).join(" · ");
			expect(link.getAttribute("aria-label"), agent.displayName).toBe(state ? words : null);
			expect(link.getAttribute("title"), agent.displayName).toBe(words);
		}
		// The Co-Founder's failed room delivery reads the same way on its card.
		const card = rail.querySelector(".cofounder-home")!;
		expect(figures.get(cofounder.id)).toBe("Idle");
		// The card shows only the name; its role and state are in the link's name.
		expect(card.querySelector("small")).toBeNull();
		expect(card.textContent).toBe("Co-Founder");
		expect(disc(card.querySelector(".cofounder-status, .alert-mark"))).toBe("red");
		expect(card.getAttribute("aria-label")).toBe("Co-Founder · Co-founder · A run did not finish");
	});
	it("redraws the status disc as a run fails, is picked up again and is dismissed", () => {
		stubFigureMotion();
		const f = companyFixture();
		const { rail, draw } = mountRail(f);
		const disc = () => rail.querySelector(`a[href$="/staff/${staff.id}"] :is(.rail-row-status, .alert-mark)`);
		const failed = {
			runId: id(70),
			staffAgentId: staff.id,
			sourceKind: "wake" as const,
			jobStatus: "failed" as const,
			activity: "needs_attention" as const,
			updatedAt: timestamp,
		};
		expect(disc()).toBeNull();
		// Idle and failed share the figure and the subtitle, so a redraw must look at the disc itself.
		f.company.store.set({ activity: [failed] });
		draw();
		expect(disc()?.classList.contains("alert-mark")).toBe(true);
		f.company.store.set({ activity: [{ ...failed, runId: id(71), jobStatus: "leased", activity: "working" }] });
		draw();
		expect(disc()?.classList.contains("alert-mark")).toBe(false);
		f.company.store.set({ activity: [failed] });
		draw();
		f.company.store.set({ activity: [] });
		draw();
		expect(disc()).toBeNull();
	});
	it.each(["agent", "cofounder"])("updates the %s state without disturbing a composing search", (kind) => {
		stubFigureMotion();
		const f = companyFixture();
		if (kind === "cofounder") f.company.store.set({ staff: [{ ...staff, templateId: "co-founder" }] });
		const { rail, draw } = mountRail(f);
		const row = () =>
			rail.querySelector<HTMLElement>(kind === "cofounder" ? ".cofounder-home" : `a[href$="/staff/${staff.id}"]`)!;
		const disc = () => row().querySelector(".rail-row-status, .cofounder-status, .alert-mark");
		const search = rail.querySelector<HTMLInputElement>('input[type="search"]')!;
		rail.querySelector<HTMLButtonElement>(".rail-search-toggle")!.click();
		expect(document.activeElement).toBe(search);
		search.dispatchEvent(new CompositionEvent("compositionstart"));
		search.value = "Fixture";
		search.setSelectionRange(1, 3);
		search.dispatchEvent(new InputEvent("input", { isComposing: true }));
		const observer = new MutationObserver(() => {});
		observer.observe(rail, { childList: true, subtree: true });
		const failed: HostedStaffExecutionActivity = {
			runId: id(72),
			staffAgentId: staff.id,
			sourceKind: "wake",
			jobStatus: "failed",
			activity: "needs_attention",
			updatedAt: timestamp,
		};
		const idle = row();
		f.company.store.set({ activity: [failed] });
		draw();
		expect(row()).not.toBe(idle);
		expect(disc()?.classList.contains("alert-mark")).toBe(true);
		expect(row().getAttribute("aria-label")).toContain("A run did not finish");
		f.company.store.set({ activity: [] });
		draw();
		expect(disc()).toBeNull();
		expect(row().hasAttribute("aria-label")).toBe(false);
		f.company.store.set({
			activity: [failed],
			recoveries: {
				[failed.runId]: {
					runId: failed.runId,
					sourceKind: "wake",
					jobStatus: "failed",
					proposalId: id(73),
					unsettledOperations: 0,
				},
			},
		});
		draw();
		expect(disc()).toBeNull();
		expect(row().querySelector("small")?.textContent).toBe(kind === "cofounder" ? undefined : "Needs you");
		expect(row().getAttribute("aria-label")).toContain("Needs you");
		expect(document.activeElement).toBe(search);
		expect(search.value).toBe("Fixture");
		expect([search.selectionStart, search.selectionEnd]).toEqual([1, 3]);
		expect(
			observer
				.takeRecords()
				.flatMap((record) => [...record.removedNodes])
				.some((node) => node === search || node.contains(search)),
		).toBe(false);
		observer.disconnect();
		search.dispatchEvent(new CompositionEvent("compositionend", { data: "Fixture" }));
	});
});

describe("received content presentation", () => {
	it("projects attachment metadata without carrying embedded bytes, URLs or HTML into resources", () => {
		const source = event(1);
		source.body = {
			schema: "qorpera.runner-transcript-entry/v1",
			entry: {
				type: "message",
				message: {
					role: "user",
					content: [
						{
							type: "image_url",
							name: "<img onerror=alert(1)>",
							bytes: -1,
							url: "https://tracker.invalid/secret",
							data: "SECRET",
						},
						{ type: "file", filename: "plan.pdf", bytes: 42, mimeType: "application/pdf" },
					],
				},
			},
		};
		const message = projectTranscript([source]).items[0] as TranscriptMessage;
		expect(message.attachments).toEqual([
			{ kind: "image", name: "<img onerror=alert(1)>" },
			{ kind: "file", name: "plan.pdf", bytes: 42, mediaType: "application/pdf" },
		]);
		const view = new ReceivedAttachments(message);
		cleanup.push(() => view.dispose());
		document.body.append(view.el);
		view.el.querySelector("button")!.click();
		expect(document.querySelector("img, iframe, script")).toBeNull();
		expect(document.querySelector("dialog")?.textContent).toContain("<img onerror=alert(1)>");
		expect(URL.createObjectURL).not.toHaveBeenCalled();
	});
	it.each(["image/svg+xml", "text/html", "application/pdf"])("keeps %s bytes inert", async (type) => {
		const load = vi.fn(async () => new Blob(["untrusted"], { type }));
		const view = new ReceivedAttachments(imageMessage, load);
		cleanup.push(() => view.dispose());
		document.body.append(view.el);
		expect(load).not.toHaveBeenCalled();
		view.el.querySelector("button")!.click();
		await settle();
		expect(load).toHaveBeenCalledExactlyOnceWith(imageMessage.id, 0, expect.any(AbortSignal));
		expect(URL.createObjectURL).not.toHaveBeenCalled();
		expect(document.querySelector("img, iframe")).toBeNull();
	});
	it("allows retry after failure, caches safe previews, and releases URLs on disposal", async () => {
		const load = vi
			.fn()
			.mockRejectedValueOnce(new Error("Unavailable"))
			.mockResolvedValue(new Blob(["png"], { type: "image/png" }));
		const view = new ReceivedAttachments(imageMessage, load);
		cleanup.push(() => view.dispose());
		document.body.append(view.el);
		view.el.querySelector("button")!.click();
		await settle();
		expect(view.el.textContent).toContain("retry");
		document.querySelector<HTMLButtonElement>(".surface-close")!.click();
		view.el.querySelector("button")!.click();
		await settle();
		expect(document.querySelector("dialog img")?.getAttribute("src")).toBe("blob:local-fixture");
		document.querySelector<HTMLButtonElement>(".surface-close")!.click();
		view.el.querySelector("button")!.click();
		await settle();
		expect(load).toHaveBeenCalledTimes(2);
		view.dispose();
		expect(document.querySelector("dialog")).toBeNull();
		expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:local-fixture");
	});
	it("discards preview bytes that arrive after the conversation is disposed", async () => {
		const pending = deferred<Blob>();
		const view = new ReceivedAttachments(imageMessage, () => pending.promise);
		cleanup.push(() => view.dispose());
		document.body.append(view.el);
		view.el.querySelector("button")!.click();
		view.dispose();
		pending.resolve(new Blob(["png"], { type: "image/png" }));
		await settle();
		expect(URL.createObjectURL).not.toHaveBeenCalled();
		expect(document.querySelector("dialog")).toBeNull();
	});
	it.each([
		["approved", "approved"],
		["denied", "declined"],
		["unknown", "recorded"],
	])("renders a %s resolution without live decision controls", (decision, state) => {
		const card = renderAuthorizationCard(
			"authorization_request",
			{ title: "Share brief", to: "Recipient" },
			timestamp,
			"Jonas",
			{ decision },
		);
		expect(card.dataset.decisionState).toBe(state);
		expect(card.querySelectorAll("button")).toHaveLength(0);
		expect(Boolean(card.querySelector(".badge-ok"))).toBe(decision === "approved");
	});
});

it("keeps responsibility and project pages out of the rail even when they are recorded", () => {
	const f = companyFixture();
	const organization: HostedCompanyOrganization = {
		schema: "qorpera.company-organization/v1",
		profileId: profileA.profileId,
		cofounder: { staffAgentId: staff.id, formationId: id(30) },
		formation: {
			formationId: id(30),
			state: "operating",
			status: "active",
			revision: 1,
			projectionStatus: "ready",
			sourcePath: "company/formation.json",
		},
		responsibilities: [
			{
				responsibilityId: id(31),
				slug: "quality",
				name: "Product quality",
				outcome: "Fewer defects",
				status: "active",
				accountableStaffAgentId: staff.id,
				attentionCadence: "weekly",
				measures: [
					{
						measureId: id(32),
						key: "defects",
						label: "Defects",
						status: "active",
						target: "Under 5",
						sourcePaths: ["quality/report.md"],
					},
				],
				version: 1,
				sourcePath: "quality.json",
			},
		],
		projects: [
			{
				projectId: id(33),
				key: "launch",
				name: "Launch",
				status: "active",
				sponsoringResponsibilityId: id(31),
				leadStaffAgentId: staff.id,
				roomId: id(34),
				staff: [],
				version: 1,
				sourcePath: "launch.json",
			},
		],
	};
	f.company.store.set({ organization, organizationState: "ready" });
	const { rail } = mountRail(f);
	expect(rail.querySelector('a[href*="/responsibility/"], a[href*="/project/"]')).toBeNull();
	expect(rail.querySelector('.rail-cofounder .cofounder-home[aria-current="page"]')?.textContent).toContain(
		staff.displayName,
	);
	expect(rail.querySelector('[aria-label="Pinned agents"], [data-toggle-rail]')).toBeNull();
	expect(rail.querySelector(".cofounder-stand .figure")).not.toBeNull();
	expect(rail.querySelector(".cofounder-status")).toBeNull();
	expect(rail.querySelector(".account-menu-rail .account-trigger")).not.toBeNull();
	expect(rail.querySelector(".account-menu-rail .account-chevron")).toBeNull();
	// Search and the add button share the top row, search first.
	expect(rail.querySelector('.rail-toolbar > .rail-search > input[type="search"]')).not.toBeNull();
	expect(rail.querySelector('.rail-toolbar > .rail-search + .rail-add[href$="/new"]')).not.toBeNull();
	// The search folds out of its button over the tabs.
	rail.querySelector<HTMLButtonElement>(".rail-search-toggle")!.click();
	const search = rail.querySelector<HTMLInputElement>('input[type="search"]')!;
	expect(document.activeElement).toBe(search);
	search.value = "Product quality";
	search.dispatchEvent(new Event("input"));
	expect(rail.textContent).toContain("No matching conversations.");
	expect(f.cloud.rpc).not.toHaveBeenCalled();
});

it("keeps the rail's search field, rows and focus through redraws and pauses the search while the rail is collapsed", () => {
	const f = companyFixture();
	const other = { ...staff, id: id(92), displayName: "Second agent" };
	f.company.store.set({ staff: [staff, other] });
	const { rail, frame, draw, layout } = mountRail(f);
	const toolbar = rail.querySelector(".rail-toolbar"),
		list = rail.querySelector(".rail-scroll"),
		search = rail.querySelector<HTMLInputElement>('input[type="search"]')!,
		row = rail.querySelector<HTMLElement>(`a[href$="/staff/${staff.id}"]`)!,
		otherRow = rail.querySelector<HTMLElement>(`a[href$="/staff/${other.id}"]`)!;
	// An update that changes nothing the rail shows leaves its elements, and keyboard focus, alone.
	row.focus();
	const listChanges = new MutationObserver(() => {});
	listChanges.observe(list!, { childList: true, subtree: true });
	f.company.store.set({ activity: [] });
	draw();
	expect(listChanges.takeRecords()).toHaveLength(0);
	listChanges.disconnect();
	expect(rail.querySelector(`a[href$="/staff/${staff.id}"]`)).toBe(row);
	expect(document.activeElement).toBe(row);
	// A change rebuilds only the row it touches, inside the same list, and focus moves to the rebuilt row.
	f.company.store.set({ staff: [{ ...staff, role: "Lead designer" }, other] });
	draw();
	const rebuilt = rail.querySelector<HTMLElement>(`a[href$="/staff/${staff.id}"]`)!;
	expect(rebuilt).not.toBe(row);
	expect(rail.querySelector(`a[href$="/staff/${other.id}"]`)).toBe(otherRow);
	expect(document.activeElement).toBe(rebuilt);
	// When the focused row goes away, focus moves to the row now in its place, not to the page.
	otherRow.focus();
	f.company.store.set({
		staff: [
			{ ...staff, role: "Lead designer" },
			{ ...other, employmentStatus: "archived" },
		],
	});
	draw();
	expect(rail.querySelector(`a[href$="/staff/${other.id}"]`)).toBeNull();
	expect(document.activeElement).toBe(rail.querySelector(`a[href$="/chat/${session.sessionId}"]`));
	expect(rail.querySelector(".rail-toolbar")).toBe(toolbar);
	expect(rail.querySelector(".rail-scroll")).toBe(list);
	// Every keystroke filters, composed text included, and redraws never move the field.
	rail.querySelector<HTMLButtonElement>(".rail-search-toggle")!.click();
	expect(document.activeElement).toBe(search);
	search.dispatchEvent(new CompositionEvent("compositionstart"));
	search.value = "é";
	search.dispatchEvent(new InputEvent("input", { isComposing: true }));
	draw();
	expect(search.closest(".rail-toolbar")).toBe(toolbar);
	expect(document.activeElement).toBe(search);
	expect(rail.textContent).toContain("No matching conversations.");
	// Collapsing hides the field: its text stays, and it filters again once the rail opens.
	layout.el.dispatchEvent(new KeyboardEvent("keydown", { key: "Home" }));
	expect(search.value).toBe("é");
	expect(rail.textContent).toContain(staff.displayName);
	layout.el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
	expect(rail.textContent).toContain("No matching conversations.");
	// In the phone layout the rail is a drawer and never collapsed, so the field shows and filters.
	layout.el.dispatchEvent(new KeyboardEvent("keydown", { key: "Home" }));
	vi.stubGlobal("innerWidth", 760);
	window.dispatchEvent(new Event("resize"));
	expect(frame.classList.contains("rail-compact")).toBe(false);
	expect(rail.textContent).toContain("No matching conversations.");
	// One pixel wider it collapses again, although the width and its cap stay the same.
	vi.stubGlobal("innerWidth", 761);
	window.dispatchEvent(new Event("resize"));
	expect(frame.classList.contains("rail-compact")).toBe(true);
	expect(rail.textContent).toContain(staff.displayName);
	expect(f.cloud.rpc).not.toHaveBeenCalled();
});

it("leaves a hidden rail alone and leaves the foot untouched by redraws that change nothing", () => {
	const f = companyFixture();
	const { rail, draw, layout } = mountRail(f);
	const search = rail.querySelector<HTMLInputElement>('input[type="search"]')!;
	search.value = "zz";
	search.dispatchEvent(new Event("input"));
	expect(rail.textContent).toContain("No matching conversations.");
	// Another page is showing: collapsing the rail does not draw it until it returns.
	rail.hidden = true;
	layout.el.dispatchEvent(new KeyboardEvent("keydown", { key: "Home" }));
	expect(rail.textContent).toContain("No matching conversations.");
	rail.hidden = false;
	draw();
	expect(rail.textContent).toContain(staff.displayName);
	// While live updates are degraded, redraws that change nothing touch nothing in the foot.
	f.company.store.set({ realtime: "degraded", realtimeError: "offline" });
	draw();
	const foot = rail.querySelector(".rail-footer")!;
	expect(foot.querySelector(".rail-connection")?.textContent).toContain("live updates degraded");
	const changes = new MutationObserver(() => {});
	changes.observe(foot, { childList: true, subtree: true, characterData: true });
	draw();
	draw();
	expect(changes.takeRecords()).toHaveLength(0);
	changes.disconnect();
	expect(foot.querySelector(".account-menu")).not.toBeNull();
	expect(f.cloud.rpc).not.toHaveBeenCalled();
});

it("moves the current row in place, keeps notices and moved rows, and retries figures that failed", () => {
	const f = companyFixture();
	const other = { ...staff, id: id(93), displayName: "Third agent" };
	f.company.store.set({ staff: [staff, other], sessionsError: "Conversations are unavailable." });
	const { rail, draw } = mountRail(f);
	const at = (agent: typeof staff) => rail.querySelector<HTMLElement>(`a[href$="/staff/${agent.id}"]`)!;
	const row = at(staff),
		otherRow = at(other),
		alert = rail.querySelector(".rail-scroll > [role=alert]");
	expect(alert).not.toBeNull();
	const listChanges = new MutationObserver(() => {});
	listChanges.observe(rail.querySelector(".rail-scroll")!, { childList: true, subtree: true });
	// Moving between agents marks the new row current without building either row again.
	draw({ name: "company", profileId: profileA.profileId, section: "staff", id: staff.id });
	expect(at(staff)).toBe(row);
	expect(row.getAttribute("aria-current")).toBe("page");
	expect(row.classList.contains("active")).toBe(true);
	draw({ name: "company", profileId: profileA.profileId, section: "staff", id: other.id });
	expect([at(staff), at(other)]).toEqual([row, otherRow]);
	expect(row.hasAttribute("aria-current")).toBe(false);
	expect(row.classList.contains("active")).toBe(false);
	expect(otherRow.getAttribute("aria-current")).toBe("page");
	expect(listChanges.takeRecords()).toHaveLength(0);
	// A change to one row leaves the error notice where it is, so it is not announced again.
	f.company.store.set({ staff: [{ ...staff, role: "Lead designer" }, other] });
	draw();
	expect(rail.querySelector(".rail-scroll")!.firstElementChild).toBe(alert);
	expect(listChanges.takeRecords().some((record) => record.target === rail.querySelector(".rail-scroll"))).toBe(false);
	listChanges.disconnect();
	// A row that moves keeps its element and keyboard focus.
	otherRow.focus();
	f.company.store.set({ staff: [other, { ...staff, role: "Lead designer" }] });
	draw();
	expect(at(other)).toBe(otherRow);
	expect(otherRow.nextElementSibling).toBe(at(staff));
	expect(document.activeElement).toBe(otherRow);
	// A row built again hands focus to its new element, even when a row before it left.
	at(staff).focus();
	f.company.store.set({
		staff: [
			{ ...other, employmentStatus: "archived" },
			{ ...staff, role: "Designer" },
		],
	});
	draw();
	expect(at(other)).toBeNull();
	expect(document.activeElement).toBe(at(staff));
	// A figure whose artwork could not load is built again on the next draw, so it gets another try.
	const failed = at(staff);
	failed.querySelector(".figure")!.setAttribute("data-motion-unavailable", "true");
	draw();
	expect(at(staff)).not.toBe(failed);
	expect(at(staff).querySelector("[data-motion-unavailable]")).toBeNull();
	expect(f.cloud.rpc).not.toHaveBeenCalled();
});

it("builds the account menu again in the language it is next shown in", () => {
	const f = companyFixture();
	const { rail, frame, draw } = mountRail(f);
	const signOut = () => rail.querySelector(".account-signout .account-item-label")?.textContent;
	expect(signOut()).toBe("Sign out");
	// The language changes while the menu is off the page, where the switch cannot reach it.
	frame.remove();
	expect(setLanguagePreference("da")).toBe(true);
	document.body.append(frame);
	draw();
	expect(signOut()).toBe(uiText("Sign out").textContent);
	expect(signOut()).not.toBe("Sign out");
});
