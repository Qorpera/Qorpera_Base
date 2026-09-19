// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthController } from "../src/app/auth.ts";
import { CompanyController } from "../src/app/company.ts";
import { ApprovalsView } from "../src/app/views/approvals.ts";
import { HubController } from "../src/app/views/hub.ts";
import { NewConversationView } from "../src/app/views/new-conversation.ts";
import { renderOrganization } from "../src/app/views/organization.ts";
import { SettingsView } from "../src/app/views/settings.ts";
import { renderRail } from "../src/app/views/shell.ts";
import type { HostedCompanyOrganization } from "../src/cloud/organization.ts";
import { projectTranscript, type TranscriptMessage } from "../src/cloud/transcript.ts";
import type { HostedStaffExecutionActivity } from "../src/cloud/types.ts";
import { renderAuthorizationCard } from "../src/ui/authorization-card.ts";
import { SurfaceDialog } from "../src/ui/dialog.ts";
import { h } from "../src/ui/dom.ts";
import { languagePreference, setLanguagePreference, uiText } from "../src/ui/preferences.ts";
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
/** The real rail over a fixture company; `draw` renders it again, as a store change does. */
function mountRail(f: ReturnType<typeof companyFixture>, section: "home" | "file" = "home") {
	const rail = h("nav");
	document.body.append(rail);
	const auth = new AuthController(f.cloud);
	cleanup.push(() => auth.dispose());
	const draw = () =>
		renderRail(rail, f.company, {
			profiles: [profileA],
			user: userA,
			route: { name: "company", profileId: profileA.profileId, section },
			auth,
			invitations: 0,
			openSettings: () => {},
			openFeedback: () => {},
		});
	draw();
	return { rail, draw };
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
		expect(row("create")).toBeNull();
		expect(search.placeholder).toBe("Add agents");
		for (const agent of [other, staff]) row(agent.id)!.click();
		// Chips keep the order the agents were added in.
		expect([...view.el.querySelectorAll(".recipient-chip")].map((chip) => chip.textContent)).toEqual([
			"Second agent",
			"Fixture agent",
		]);
		// No client can start a group conversation yet, and the row says so.
		const hash = location.hash;
		expect(row("start")!.getAttribute("aria-disabled")).toBe("true");
		expect(row("start")!.textContent).toContain("Not available yet");
		row("start")!.click();
		expect(location.hash).toBe(hash);
		f.company.store.set({ activity: [] });
		await settle();
		expect(view.el.querySelectorAll('[aria-selected="true"]')).toHaveLength(2);
		f.company.store.set({ staff: [staff, { ...other, employmentStatus: "archived" }] });
		await settle();
		expect(view.el.querySelectorAll(".recipient-chip")).toHaveLength(1);
		expect(row("start")!.textContent).toContain("Pick two or more agents");
		// Backspace in the empty field takes the last agent back out.
		press("Backspace");
		expect(view.el.querySelectorAll(".recipient-chip")).toHaveLength(0);
		// Escape with the list closed puts the group chat away.
		expect(press("Escape").defaultPrevented).toBe(true);
		expect(row("create")).not.toBeNull();
		expect(view.el.querySelector('[role="listbox"]')!.hasAttribute("aria-multiselectable")).toBe(false);
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
		// The default is half again the desktop's 304px rail; the 1280px fixture window shows all of it.
		expect(rail.el.getAttribute("aria-valuenow")).toBe("456");
		press("ArrowRight");
		expect(rail.el.getAttribute("aria-valuenow")).toBe("472");
		press("End");
		press("ArrowRight");
		expect(rail.el.getAttribute("aria-valuenow")).toBe(cap);
		expect(localStorage.getItem("qorpera.web.rail-width")).toBe(cap);
		// Only the rail and its edge carry the width, so a change restyles nothing else.
		expect(aside.style.getPropertyValue("--rail-width")).toBe(`${cap}px`);
		expect(rail.el.style.getPropertyValue("--rail-width")).toBe(`${cap}px`);
		expect(frame.style.getPropertyValue("--rail-width")).toBe("");
		// A narrower window clamps what is shown; the preference survives until the member acts.
		vi.stubGlobal("innerWidth", 800);
		window.dispatchEvent(new Event("resize"));
		expect(rail.el.getAttribute("aria-valuenow")).toBe("320");
		expect(localStorage.getItem("qorpera.web.rail-width")).toBe(cap);
		vi.stubGlobal("innerWidth", 1280);
		window.dispatchEvent(new Event("resize"));
		expect(rail.el.getAttribute("aria-valuenow")).toBe(cap);
		vi.stubGlobal("innerWidth", 800);
		window.dispatchEvent(new Event("resize"));
		press("ArrowLeft");
		expect(rail.el.getAttribute("aria-valuenow")).toBe("304");
		expect(localStorage.getItem("qorpera.web.rail-width")).toBe("304");
		vi.stubGlobal("innerWidth", 1280);
		window.dispatchEvent(new Event("resize"));
		expect(rail.el.getAttribute("aria-valuenow")).toBe("304");
		// Where the cap is the minimum, a key press that moves nothing leaves the preference alone.
		vi.stubGlobal("innerWidth", 600);
		window.dispatchEvent(new Event("resize"));
		expect(rail.el.getAttribute("aria-valuenow")).toBe("240");
		press("ArrowRight");
		expect(rail.el.getAttribute("aria-valuenow")).toBe("240");
		expect(localStorage.getItem("qorpera.web.rail-width")).toBe("304");
		vi.stubGlobal("innerWidth", 1280);
		window.dispatchEvent(new Event("resize"));
		expect(rail.el.getAttribute("aria-valuenow")).toBe("304");
		// Going back to the default forgets the stored width, even where the window caps it.
		vi.stubGlobal("innerWidth", 1024);
		window.dispatchEvent(new Event("resize"));
		rail.el.dispatchEvent(new MouseEvent("dblclick"));
		expect(rail.el.getAttribute("aria-valuenow")).toBe("409");
		expect(localStorage.getItem("qorpera.web.rail-width")).toBeNull();
		vi.stubGlobal("innerWidth", 1280);
		window.dispatchEvent(new Event("resize"));
		expect(rail.el.getAttribute("aria-valuenow")).toBe("456");
		vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
			throw new Error("Blocked");
		});
		rail.el.dispatchEvent(new KeyboardEvent("keydown", { key: "Home" }));
		expect(frame.classList.contains("rail-compact")).toBe(true);
		rail.el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
		expect(rail.el.getAttribute("aria-valuenow")).toBe("456");
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
		const view = new SettingsView(
			f.api,
			auth,
			hub,
			[profileA, profileB],
			f.company,
			() => {},
			() => {},
		);
		cleanup.push(() => view.dispose());
		document.body.append(view.el);
		view.el.querySelector<HTMLButtonElement>("#settings-tab-company")!.click();
		expect(view.el.querySelector(".settings-file")?.textContent).toContain("Loading storage");
		expect(view.el.querySelector("progress")).toBeNull();
		const picker = view.el.querySelector<HTMLSelectElement>(".settings-company-picker")!;
		picker.value = profileB.profileId;
		picker.dispatchEvent(new Event("change"));
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
			figure: string;
			line: string;
			disc: "red" | "green" | "none";
		}[] = [
			{ name: "Failed", run: ["failed", "needs_attention"], figure: "Idle", line: "Analyst", disc: "red" },
			{ name: "Stopped", run: ["cancelled", "needs_attention"], figure: "Idle", line: "Analyst", disc: "red" },
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
					.filter((row) => row.proposal)
					.map(({ runId }) => [
						runId,
						{
							runId,
							sourceKind: "session_turn",
							jobStatus: "failed",
							proposalId: id(99),
							unsettledOperations: 0,
						},
					]),
			),
		});
		const { rail } = mountRail(f, "file");
		const figures = new Map(mount.mock.calls.map(([, , , , options]) => [options?.identity, options?.activity]));
		const disc = (status: Element | null) =>
			!status ? "none" : status.classList.contains("failed") ? "red" : "green";
		for (const { agent, figure, line, disc: shown } of rows) {
			const link = rail.querySelector(`a[href$="/staff/${agent.id}"]`)!;
			const status = link.querySelector(".rail-row-status");
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
		expect(card.querySelector("small")?.textContent).toBe("Co-founder");
		expect(disc(card.querySelector(".cofounder-status"))).toBe("red");
		expect(card.getAttribute("aria-label")).toBe("Co-Founder · Co-founder · A run did not finish");
	});
	it("redraws the status disc as a run fails, is picked up again and is dismissed", () => {
		stubFigureMotion();
		const f = companyFixture();
		const { rail, draw } = mountRail(f);
		const disc = () => rail.querySelector(`a[href$="/staff/${staff.id}"] .rail-row-status`);
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
		expect(disc()?.classList.contains("failed")).toBe(true);
		f.company.store.set({ activity: [{ ...failed, runId: id(71), jobStatus: "leased", activity: "working" }] });
		draw();
		expect(disc()?.classList.contains("failed")).toBe(false);
		f.company.store.set({ activity: [failed] });
		draw();
		f.company.store.set({ activity: [] });
		draw();
		expect(disc()).toBeNull();
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
	it("carries a canonical decision into the inbox request card", async () => {
		const f = companyFixture();
		vi.mocked(f.api.readSessionEvents).mockResolvedValue([
			{ ...event(1), eventType: "authorization_request", body: { title: "Share brief" } },
			{ ...event(2), eventType: "authorization_decision", body: { requestEventId: id(1001), decision: "denied" } },
		]);
		const view = new ApprovalsView(f.company);
		cleanup.push(() => view.dispose());
		await settle();
		expect(view.el.querySelector(".authorization_request")?.getAttribute("data-decision-state")).toBe("declined");
		expect(view.el.textContent).toContain("Waiting for a decision (0)");
		expect(f.cloud.rpc).not.toHaveBeenCalled();
	});
});

it("renders recorded responsibility targets and room links without inventing missing relationships", () => {
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
	const search = rail.querySelector<HTMLInputElement>('input[type="search"]')!;
	search.value = "Product quality";
	search.dispatchEvent(new Event("input"));
	expect(rail.textContent).toContain("No matching conversations.");
	const root = h("div");
	renderOrganization(f.company, root);
	const card = root.querySelector(".responsibility-node")!;
	expect(card.textContent).toBe("Product quality");
	expect(card.querySelector(".figure, p, .badge")).toBeNull();
	expect(card.getAttribute("href")).toBe(`#/c/${profileA.profileId}/responsibility/${id(31)}`);
	renderOrganization(f.company, root, { kind: "responsibility", id: id(31) });
	expect(root.textContent).toContain("Under 5");
	expect(root.textContent).toContain("quality/report.md");
	expect(root.querySelector(`a[href$="/project/${id(33)}"]`)).not.toBeNull();
	renderOrganization(f.company, root, { kind: "project", id: id(33) });
	expect(root.querySelector('a[href*="/chat/"]')).toBeNull();
	f.company.store.set({
		sessions: [{ ...session, executionScope: { kind: "project", projectId: id(33), roomId: id(34) } }],
	});
	renderOrganization(f.company, root, { kind: "project", id: id(33) });
	expect(root.querySelector('a[href*="/chat/"]')?.getAttribute("href")).toBe(
		`#/c/${profileA.profileId}/chat/${session.sessionId}`,
	);
	expect(f.cloud.rpc).not.toHaveBeenCalled();
});

it("keeps the rail search and keyboard focus through redraws and drops the search when the rail collapses", () => {
	const f = companyFixture();
	const rail = h("nav"),
		frame = h("div", null, rail);
	document.body.append(frame);
	const auth = new AuthController(f.cloud);
	cleanup.push(() => auth.dispose());
	const draw = () =>
		renderRail(rail, f.company, {
			profiles: [profileA],
			user: userA,
			route: { name: "company", profileId: profileA.profileId, section: "home" },
			auth,
			invitations: 0,
			openSettings: () => {},
			openFeedback: () => {},
		});
	draw();
	// A store-driven redraw rebuilds the add link; keyboard focus follows it.
	const add = rail.querySelector<HTMLElement>(".rail-add")!;
	add.focus();
	draw();
	expect(rail.querySelector(".rail-add")).not.toBe(add);
	expect(document.activeElement).toBe(rail.querySelector(".rail-add"));
	// A dead key or IME composition is not moved mid-word; the committed text filters.
	const search = rail.querySelector<HTMLInputElement>('input[type="search"]')!;
	search.focus();
	const toolbar = rail.querySelector(".rail-toolbar");
	search.dispatchEvent(new CompositionEvent("compositionstart"));
	search.value = "´";
	search.dispatchEvent(new InputEvent("input", { isComposing: true }));
	draw();
	expect(rail.querySelector(".rail-toolbar")).toBe(toolbar);
	search.value = "é";
	search.dispatchEvent(new CompositionEvent("compositionend", { data: "é" }));
	expect(rail.querySelector(".rail-toolbar")).not.toBe(toolbar);
	expect(rail.textContent).toContain("No matching conversations.");
	expect(document.activeElement).toBe(search);
	// Collapsing hides the field, so its filter goes with it.
	frame.classList.add("rail-compact");
	window.dispatchEvent(new Event("qorpera-rail-resize"));
	expect(search.value).toBe("");
	expect(rail.textContent).toContain(staff.displayName);
	expect(f.cloud.rpc).not.toHaveBeenCalled();
});
