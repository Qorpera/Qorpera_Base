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
	it("keeps multi-selection local, retains it through refresh, and drops archived recipients", async () => {
		const f = companyFixture();
		const other = { ...staff, id: id(91), displayName: "Second agent" };
		f.company.store.set({ staff: [staff, other] });
		const view = new NewConversationView(f.company, {}, () => {});
		cleanup.push(() => view.dispose());
		document.body.append(view.el);
		for (const agent of [staff, other])
			view.el.querySelector<HTMLButtonElement>(`[data-agent-id="${agent.id}"]`)!.click();
		expect(view.el.querySelectorAll(".recipient-chip")).toHaveLength(2);
		expect(view.el.querySelector<HTMLButtonElement>(".recipient-footer .btn-primary")!.disabled).toBe(true);
		f.company.store.set({ activity: [] });
		await settle();
		expect(view.el.querySelectorAll('[aria-pressed="true"]')).toHaveLength(2);
		f.company.store.set({ staff: [staff, { ...other, employmentStatus: "archived" }] });
		await settle();
		expect(view.el.querySelectorAll(".recipient-chip")).toHaveLength(1);
		expect(view.el.querySelector<HTMLButtonElement>(".recipient-footer .btn-primary")!.disabled).toBe(false);
		expect(f.cloud.rpc).not.toHaveBeenCalled();
	});
	it("caps the rail at two fifths of the window and keeps resizing usable when storage is blocked", () => {
		const frame = h("div"),
			rail = new RailLayout(frame);
		frame.append(rail.el);
		cleanup.push(() => rail.dispose());
		const cap = String(Math.floor(window.innerWidth * 0.4));
		const press = (key: string) => rail.el.dispatchEvent(new KeyboardEvent("keydown", { key }));
		expect(rail.el.getAttribute("aria-valuemax")).toBe(cap);
		press("ArrowRight");
		expect(rail.el.getAttribute("aria-valuenow")).toBe("320");
		press("End");
		press("ArrowRight");
		expect(rail.el.getAttribute("aria-valuenow")).toBe(cap);
		expect(localStorage.getItem("qorpera.web.rail-width")).toBe(cap);
		expect(frame.style.getPropertyValue("--rail-width")).toBe(`${cap}px`);
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
		vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
			throw new Error("Blocked");
		});
		rail.el.dispatchEvent(new KeyboardEvent("keydown", { key: "Home" }));
		expect(frame.classList.contains("rail-compact")).toBe(true);
		rail.el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
		expect(rail.el.getAttribute("aria-valuenow")).toBe("304");
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
	const rail = h("nav");
	document.body.append(rail);
	const auth = new AuthController(f.cloud);
	cleanup.push(() => auth.dispose());
	renderRail(rail, f.company, {
		profiles: [profileA],
		user: userA,
		route: { name: "company", profileId: profileA.profileId, section: "home" },
		auth,
		invitations: 0,
		openSettings: () => {},
		openFeedback: () => {},
	});
	expect(rail.querySelector('a[href*="/responsibility/"], a[href*="/project/"]')).toBeNull();
	expect(rail.querySelector('.rail-cofounder .cofounder-home[aria-current="page"]')?.textContent).toContain(
		staff.displayName,
	);
	expect(rail.querySelector('[aria-label="Pinned agents"], [data-toggle-rail]')).toBeNull();
	expect(rail.querySelector(".cofounder-stand .figure")).not.toBeNull();
	expect(rail.querySelector(".cofounder-status")).toBeNull();
	expect(rail.querySelector(".account-menu-rail .account-trigger")).not.toBeNull();
	expect(rail.querySelector(".account-menu-rail .account-chevron")).toBeNull();
	expect(rail.querySelector('.rail-toolbar + .rail-search input[type="search"]')).not.toBeNull();
	expect(rail.querySelector('.rail-toolbar a[href$="/new"]')).not.toBeNull();
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
