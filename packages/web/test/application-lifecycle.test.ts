// @vitest-environment jsdom
import { createHash, webcrypto } from "node:crypto";
import { cloudFileBytesSha256 } from "@qorpera/cloud-client/cloud-file-bytes";
import { writeRoutineFile } from "@qorpera/cloud-client/company-state-files";
import { CloudSurfacesClient } from "@qorpera/cloud-client/surfaces";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { linkedCompanyDatabaseNames, mountApplication } from "../src/app/application.ts";
import { AuthController } from "../src/app/auth.ts";
import { CompanyController } from "../src/app/company.ts";
import { takeWantedDataList } from "../src/app/data-page.ts";
import { tellAgent } from "../src/app/tell-agent.ts";
import { HubController, renderHub } from "../src/app/views/hub.ts";
import { pageNoteCard } from "../src/app/views/page-note.ts";
import { renderRail } from "../src/app/views/shell.ts";
import { SITE_DOOR_PASS, SITE_DOOR_READY, SITE_DOOR_SHOWN } from "../src/app/views/site-view.ts";
import { CloudRpcError, describeError } from "../src/cloud/client.ts";
import { WebCompanyFiles } from "../src/cloud/company-files.ts";
import type { HostedCompanyOrganization } from "../src/cloud/organization.ts";
import type { AgentThreadHandle } from "../src/cloud/parse.ts";
import type { HostedProfile, HostedStaffAgent } from "../src/cloud/types.ts";
import conversationCss from "../src/styles/conversation.css?raw";
import { h } from "../src/ui/dom.ts";
import { appCard, markdown } from "../src/ui/markdown.ts";
import { PAGE_READY } from "../src/ui/page-frame.ts";
import { setLanguagePreference } from "../src/ui/preferences.ts";
import {
	deferred,
	event,
	fixture,
	id,
	placeholderLabel,
	profileA,
	profileB,
	session,
	settle,
	staff,
	stubFigureMotion,
	team,
	userA,
	userB,
	visibleText,
} from "./fixtures.ts";
import { folderFake } from "./folder-fake.ts";
import {
	PREVIEW_IDS,
	previewFrame,
	session as surfaceSession,
	summary as surfaceSummary,
	workspace as surfaceWorkspace,
	VALID_PASS,
} from "./surface-fixtures.ts";
import "./register-lazy.ts";

let dispose: (() => void) | undefined;
beforeEach(() => {
	stubDialogs();
	vi.useFakeTimers();
	vi.stubGlobal("crypto", webcrypto);
	// The usage refresh behind each account check hashes with crypto.subtle,
	// which answers from a real thread that fake timers cannot drive. The same
	// hash, computed at once, makes that refresh end at the same point in every
	// run, whatever the machine's speed.
	vi.spyOn(webcrypto.subtle, "digest").mockImplementation(async (algorithm, data) => {
		const name = typeof algorithm === "string" ? algorithm : algorithm.name;
		const bytes = ArrayBuffer.isView(data)
			? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
			: new Uint8Array(data);
		const hash = createHash(name.replace("-", "")).update(bytes).digest();
		return hash.buffer.slice(hash.byteOffset, hash.byteOffset + hash.byteLength) as ArrayBuffer;
	});
	vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
	vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("No cloud transport in this UI fixture")));
	history.replaceState(null, "", "/#/");
	sessionStorage.clear();
});
afterEach(() => {
	dispose?.();
	dispose = undefined;
	document.body.replaceChildren();
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});
async function draw(): Promise<void> {
	await settle();
	await vi.advanceTimersByTimeAsync(60);
}
function mounted(hash = "#/") {
	history.replaceState(null, "", `/${hash}`);
	const f = fixture();
	f.cloud.config.publishableKey = "sb_publishable_fixturekey";
	f.cloud.config.objectGatewayUrl = "https://objects.fixture.invalid";
	f.cloud.config.nativeProviderLoginUrl = "https://login.fixture.invalid/";
	const root = document.createElement("div");
	document.body.append(root);
	dispose = mountApplication(root, f.cloud, f.api);
	return { ...f, root };
}
/** jsdom does not implement the native dialog methods the Friends window and agent cards open and closes with. */
function stubDialogs(): void {
	const dialog = HTMLDialogElement.prototype;
	dialog.showModal ??= function (this: HTMLDialogElement) {
		this.open = true;
	};
	dialog.close ??= function (this: HTMLDialogElement) {
		this.open = false;
	};
}
/** Opens an agent's card from the rail with a right-click and picks one of its lines. */
function fromAgentCard(root: HTMLElement, agentId: string, line: "Computer" | "Routines"): void {
	stubDialogs();
	HTMLDialogElement.prototype.show ??= HTMLDialogElement.prototype.showModal;
	root
		.querySelector(`.rail [data-agent-id="${agentId}"], .rail [data-cofounder-id="${agentId}"]`)!
		.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 20, clientY: 20 }));
	[...document.querySelectorAll<HTMLButtonElement>(".agent-card-link")]
		.find((link) => link.textContent === line)!
		.click();
}
/** A company of two with Members switched on (Interfaces C6a), so the rail has its Agents | Interfaces tabs. The cloud
 * answers no other RPC. */
function withInterfacesTab(f: ReturnType<typeof mounted>): void {
	const members = ["Ann", "Ben"].map((displayName, n) => ({
		userId: id(200 + n),
		email: `member${n}@example.invalid`,
		displayName,
		role: n === 0 ? ("owner" as const) : ("contributor" as const),
		joinedAt: "2026-10-02T09:00:00Z",
	}));
	vi.mocked(f.api.getTeam).mockResolvedValue({ ...team, members });
	vi.mocked(f.cloud.rpc).mockImplementation(async (name: string) => {
		if (name !== "qorpera_member_interface_pages") throw new Error("Unexpected RPC");
		const pages = [
			{ page: "mailbox", on: false },
			{ page: "bank", on: true },
		];
		return { schema: "qorpera.member-interface-pages/v1", pages, mayChange: true };
	});
}

function executionTransport() {
	const send = vi.fn(async (init?: RequestInit) => {
		const args = JSON.parse(String(init?.body)) as { p_client_input_id: string; p_client_request_id: string };
		return Response.json({
			turn_request_id: args.p_client_request_id,
			input_id: args.p_client_input_id,
			status: "queued",
			sponsor_mode: "member_connection",
		});
	});
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			const method = String(input).split("/").at(-1);
			if (method === "qorpera_request_session_turn_v2") return send(init);
			if (method === "qorpera_list_session_turn_requests") return Response.json([]);
			if (method === "qorpera_select_member_session_account") return Response.json(id(81));
			if (method === "qorpera_get_native_account_refresh") return Response.json(null);
			if (method === "qorpera_begin_native_account_refresh")
				return Response.json({
					request_id: id(83),
					profile_id: profileA.profileId,
					compute_identity_id: id(80),
					requested_by_user_id: userA.id,
					expires_at: new Date(Date.now() + 300_000).toISOString(),
					status: "completed",
				});
			if (method === "qorpera_list_member_native_execution_connections")
				return Response.json({
					compute_identity: {
						compute_identity_id: id(80),
						ownership_kind: "member",
						owner_user_id: userA.id,
						display_name: "My model account",
						template_key: "member",
						template_version: "1",
						capabilities: ["agent_turn"],
						policy: {},
						status: "active",
						created_at: userA.created_at,
						updated_at: userA.created_at,
					},
					connections: [
						{
							connection_id: id(81),
							client_connection_id: id(181),
							connection_version: 1,
							provider: "openai",
							native_harness: "codex-cli",
							authorization_state: "active",
							max_native_concurrency: 1,
							billing_source: "subscription",
							consent_version: "1",
							consented_at: userA.created_at,
							connection_status: "active",
							sponsor_binding_id: id(82),
							sponsor_version: 1,
							policy: { implementation_status: "supported", enablement_status: "enabled", policy_version: 1 },
						},
					],
				});
			throw new Error(`Unexpected fixture RPC: ${method}`);
		}),
	);
	return send;
}

/** Types a draft and waits until it can be sent with the member's one usable
 * account: no picker, no prompt to connect. */
async function drafted(root: HTMLElement, text: string) {
	const input = root.querySelector("textarea")!;
	input.value = text;
	input.dispatchEvent(new Event("input"));
	const button = root.querySelector<HTMLButtonElement>('[aria-label="Send message"]')!;
	await vi.waitFor(() => expect(button.disabled).toBe(false), { timeout: 3000 });
	expect(root.querySelector(".session-execution")?.textContent).toBe("");
	expect(root.querySelector('[aria-label="Model account for this conversation"]')).toBeNull();
	return { input, button };
}

function surfacesOn() {
	vi.spyOn(CloudSurfacesClient.prototype, "isSurfacesEnabled").mockResolvedValue(true);
	vi.spyOn(CloudSurfacesClient.prototype, "listSurfaces").mockResolvedValue([]);
	vi.spyOn(CloudSurfacesClient.prototype, "listAutomations").mockResolvedValue([]);
	vi.spyOn(CloudSurfacesClient.prototype, "getMigrationChecklist").mockRejectedValue(new Error("none"));
}

describe("account and route ownership", () => {
	it("sends the first message from the recipient composer before navigating to the conversation", async () => {
		const f = mounted(`#/c/${profileA.profileId}/new`);
		vi.mocked(f.api.listSessions).mockResolvedValue([{ ...session, staffAgentId: staff.id }]);
		const send = executionTransport();
		await draw();
		f.root.querySelector<HTMLElement>(`[data-choice="${staff.id}"]`)!.click();
		expect(location.hash).toBe(`#/c/${profileA.profileId}/new`);
		const input = f.root.querySelector("textarea")!;
		input.value = "First message";
		input.dispatchEvent(new Event("input"));
		f.root.querySelector<HTMLButtonElement>('[aria-label="Send message"]')!.click();
		await draw();
		await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
		await draw();
		expect(location.hash).toBe(`#/c/${profileA.profileId}/chat/${session.sessionId}`);
		expect(f.root.querySelector("textarea")!.value).toBe("");
		expect(f.root.textContent).toContain("First message");
	});
	it("navigates from new compose immediately once the post succeeds without waiting for transcript reload", async () => {
		const f = mounted(`#/c/${profileA.profileId}/new`);
		vi.mocked(f.api.listSessions).mockResolvedValue([{ ...session, staffAgentId: staff.id }]);
		const send = executionTransport();
		const events = deferred<Awaited<ReturnType<typeof f.api.readSessionEvents>>>();
		vi.mocked(f.api.readSessionEvents).mockReturnValueOnce(events.promise);
		await draw();
		f.root.querySelector<HTMLElement>(`[data-choice="${staff.id}"]`)!.click();
		const input = f.root.querySelector("textarea")!;
		input.value = "First accepted message";
		input.dispatchEvent(new Event("input"));
		f.root.querySelector<HTMLButtonElement>('[aria-label="Send message"]')!.click();
		await draw();
		await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
		await draw();
		expect(location.hash).toBe(`#/c/${profileA.profileId}/chat/${session.sessionId}`);
		expect(f.root.textContent).toContain("First accepted message");
		events.resolve([]);
		await draw();
		expect(f.root.querySelector("textarea")!.value).toBe("");
		expect(f.root.textContent).not.toContain("Cloud execution could not be confirmed");
	});
	it("retries an uncertain product send with the same input identity and preserves its draft", async () => {
		const f = mounted(`#/c/${profileA.profileId}/chat/${session.sessionId}`);
		const send = executionTransport();
		send.mockRejectedValueOnce(new Error("Response lost"));
		await draw();
		const { input, button } = await drafted(f.root, "One request");
		button.click();
		button.click();
		await draw();
		expect(send).toHaveBeenCalledTimes(1);
		expect(input.value).toBe("One request");
		button.click();
		await draw();
		expect(send).toHaveBeenCalledTimes(2);
		expect(send.mock.calls[0]?.[0]?.body).toBe(send.mock.calls[1]?.[0]?.body);
		expect(input.value).toBe("");
	});
	it("submits from the product composer through the authenticated member transport", async () => {
		const f = mounted(`#/c/${profileA.profileId}/chat/${session.sessionId}`);
		const send = executionTransport();
		await draw();
		const { input, button } = await drafted(f.root, "Work from the web");
		button.click();
		await draw();
		expect(send).toHaveBeenCalledTimes(1);
		expect(input.value).toBe("");
		expect(f.root.textContent).toContain("Work from the web");
	});
	/** Clicks Send and releases the write's token read after the given change. */
	async function writeAfter(change?: "route" | "account") {
		const f = mounted(`#/c/${profileA.profileId}/chat/${session.sessionId}`);
		const send = executionTransport();
		await draw();
		const { button } = await drafted(f.root, "Private draft");
		const calls = (method: string) =>
			vi.mocked(fetch).mock.calls.filter(([input]) => String(input).endsWith(`/${method}`)).length;
		const selections = calls("qorpera_select_member_session_account");
		const getSession = vi.mocked(f.cloud.supabase.auth.getSession);
		const current = getSession.getMockImplementation()!;
		const original = await getSession();
		const token = deferred<typeof original>();
		let holding = true;
		let held = 0;
		getSession.mockImplementation(() => {
			if (!holding) return current();
			held++;
			return token.promise;
		});
		button.click();
		for (let turn = 0; turn < 10 && !held; turn++) await settle();
		expect(held).toBe(1);
		expect(calls("qorpera_select_member_session_account")).toBe(selections);
		expect(send).not.toHaveBeenCalled();
		holding = false;
		if (change === "route") history.replaceState(null, "", "/#/account");
		if (change === "account") f.auth(userB);
		token.resolve(original);
		await draw();
		return send;
	}
	it.each(["route", "account"] as const)(
		"does not dispatch a composer write after %s changes during token refresh",
		async (change) => {
			expect(await writeAfter(change)).not.toHaveBeenCalled();
		},
	);
	// Without this, the two cases above would also pass if the held read were not the write's.
	it("dispatches the composer write when nothing changes during token refresh", async () => {
		expect(await writeAfter()).toHaveBeenCalledOnce();
	});
	it("keeps one thread placeholder while a company opens, standing in for the phone header too", async () => {
		const f = mounted(`#/c/${profileA.profileId}`);
		const membership = deferred<typeof team>();
		const organization = deferred<HostedCompanyOrganization | undefined>();
		vi.mocked(f.api.getTeam).mockReturnValue(membership.promise);
		vi.mocked(f.api.getOrganization).mockReturnValue(organization.promise);
		await draw();
		const placeholder = f.root.querySelector("main > .thread-skeleton");
		expect(placeholder).not.toBeNull();
		expect(f.root.querySelector(".frame")?.classList.contains("has-thread")).toBe(true);
		// The topbar hides on a phone, so the placeholder's header carries the rail's button.
		const toggle = placeholder!.querySelector<HTMLButtonElement>(".thread-header .mobile-navigation-toggle");
		expect(toggle?.getAttribute("aria-controls")).toBe("company-navigation");
		expect(toggle?.getAttribute("aria-expanded")).toBe("false");
		toggle!.click();
		await draw();
		expect(f.root.querySelector(".frame")?.classList.contains("navigation-open")).toBe(true);
		expect(
			f.root.querySelector("main > .thread-skeleton .mobile-navigation-toggle")?.getAttribute("aria-expanded"),
		).toBe("true");
		toggle!.click();
		await draw();
		membership.resolve(team);
		await draw();
		// Still opening: the redraw keeps the placeholder it already shows.
		expect(f.root.querySelector("main > .thread-skeleton")).toBe(placeholder);
		organization.resolve(undefined);
		await draw();
		expect(placeholderLabel(f.root.querySelector("main"))).not.toBe("Opening company");
	});
	it("shows company placeholders only for the first read of the company list", async () => {
		const f = mounted("#/");
		const hub = new HubController(f.api, userA.id);
		const container = document.createElement("div");
		hub.store.set({ loading: true, loaded: false, profiles: [] });
		renderHub(hub, container);
		expect(placeholderLabel(container)).toBe("Loading companies");
		expect(container.querySelector(".hub-welcome")).toBeNull();
		// A refresh keeps the companies it shows, and a member with none keeps the welcome.
		hub.store.set({ loading: true, loaded: true, profiles: [profileA] });
		renderHub(hub, container);
		expect(container.querySelector(".company-card")?.textContent).toContain(profileA.profileName);
		expect(container.querySelector(".skeleton-companies")).toBeNull();
		hub.store.set({ loading: true, loaded: true, profiles: [] });
		renderHub(hub, container);
		expect(container.querySelector(".hub-welcome")).not.toBeNull();
		expect(container.querySelector(".skeleton-companies")).toBeNull();
	});
	it("keeps the company placeholders and says it is reconnecting while the company list cannot be reached", async () => {
		const f = mounted("#/");
		vi.mocked(f.api.listProfiles).mockRejectedValue(
			new CloudRpcError(
				"qorpera_list_hosted_profiles",
				{ message: "TimeoutError: Qorpera did not answer in time." },
				0,
			),
		);
		const hub = new HubController(f.api, userA.id);
		const container = document.createElement("div");
		await hub.refresh();
		renderHub(hub, container);
		expect(placeholderLabel(container)).toBe("Loading companies");
		expect(container.querySelector(".notice-neutral")?.textContent).toBe("Can't reach Qorpera. Trying again…");
		expect(container.querySelector(".notice-danger")).toBeNull();
		expect(container.querySelector(".hub-welcome")).toBeNull();
		vi.mocked(f.api.listProfiles).mockResolvedValue([profileA]);
		window.dispatchEvent(new Event("online"));
		await vi.waitFor(() => expect(hub.store.get().connectionLost).toBeUndefined());
		renderHub(hub, container);
		expect(container.querySelector(".company-card")?.textContent).toContain(profileA.profileName);
		expect(container.querySelector(".notice-neutral")).toBeNull();
		hub.dispose();
	});
	it("shows any other failure of the company list as an error", async () => {
		const f = mounted("#/");
		vi.mocked(f.api.listProfiles).mockRejectedValue(new Error("Companies unavailable"));
		const hub = new HubController(f.api, userA.id);
		const container = document.createElement("div");
		await hub.refresh();
		renderHub(hub, container);
		expect(hub.store.get().connectionLost).toBeUndefined();
		expect(container.querySelector(".notice-danger")?.textContent).toBe("Companies unavailable");
		hub.dispose();
	});
	it.each([true, false])("waits for organization loading before resolving home (seeded: %s)", async (seeded) => {
		const home = `#/c/${profileA.profileId}`;
		const f = mounted(home);
		const loading = deferred<HostedCompanyOrganization | undefined>();
		vi.mocked(f.api.getOrganization).mockReturnValue(loading.promise);
		await draw();
		expect(f.api.listStaff).toHaveBeenCalled();
		expect(location.hash).toBe(home);
		expect(placeholderLabel(f.root.querySelector("main"))).toBe("Opening company");
		expect(visibleText(f.root.querySelector("main"))).not.toContain("Opening");
		loading.resolve(
			seeded
				? {
						schema: "qorpera.company-organization/v1",
						profileId: profileA.profileId,
						cofounder: { staffAgentId: staff.id, formationId: id(30), memberSessionId: session.sessionId },
						formation: {
							formationId: id(30),
							state: "operating",
							status: "active",
							revision: 1,
							projectionStatus: "ready",
							sourcePath: "company/formation.json",
						},
						responsibilities: [],
						projects: [],
					}
				: undefined,
		);
		await draw();
		if (seeded) {
			expect(location.hash).toBe(`#/c/${profileA.profileId}/chat/${session.sessionId}`);
			expect(f.root.querySelector("textarea")).not.toBeNull();
		} else {
			expect(location.hash).toBe(home);
			expect(f.root.querySelector("main")?.textContent).toContain("This company has no Co-Founder yet");
		}
	});

	it("opens a folder-v2 company's Co-Founder, which has no organization record, from its template", async () => {
		const home = `#/c/${profileA.profileId}`;
		const f = mounted(home);
		const cofounder = {
			...staff,
			id: id(40),
			displayName: "Co-Founder",
			role: "Co-Founder",
			templateId: "co-founder",
		};
		vi.mocked(f.api.listStaff).mockResolvedValue([staff, cofounder]);
		vi.mocked(f.api.getOrganization).mockResolvedValue(undefined);
		const create = vi.spyOn(f.api, "agentThread").mockResolvedValue({
			sessionId: session.sessionId,
			roomId: id(41),
			staffAgentId: cofounder.id,
			status: "active",
		});
		await draw();
		expect(create).toHaveBeenCalledExactlyOnceWith(profileA.environmentId, cofounder.id);
		expect(location.hash).toBe(`#/c/${profileA.profileId}/chat/${session.sessionId}`);
		expect(visibleText(f.root.querySelector("main"))).not.toContain("no Co-Founder yet");
	});

	it("waits for membership before creating the private Co-Founder conversation", async () => {
		const home = `#/c/${profileA.profileId}`;
		const f = mounted(home);
		const loading = deferred<typeof team>();
		vi.mocked(f.api.getTeam).mockReturnValue(loading.promise);
		vi.mocked(f.api.getOrganization).mockResolvedValue({
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
			responsibilities: [],
			projects: [],
		});
		const create = vi.spyOn(f.api, "agentThread").mockResolvedValue({
			sessionId: session.sessionId,
			roomId: id(31),
			staffAgentId: staff.id,
			status: "active",
		});
		await draw();
		expect(create).not.toHaveBeenCalled();
		expect(placeholderLabel(f.root.querySelector("main"))).toBe("Opening company");
		expect(visibleText(f.root.querySelector("main"))).not.toContain("Opening");
		loading.resolve(team);
		await draw();
		expect(create).toHaveBeenCalledExactlyOnceWith(profileA.environmentId, staff.id);
		expect(location.hash).toBe(`#/c/${profileA.profileId}/chat/${session.sessionId}`);
	});

	it("waits for membership before resolving a staff route", async () => {
		const route = `#/c/${profileA.profileId}/staff/${staff.id}`;
		const f = mounted(route);
		const loading = deferred<typeof team>();
		vi.mocked(f.api.getTeam).mockReturnValue(loading.promise);
		vi.mocked(f.api.listSessions).mockResolvedValue([]);
		const create = vi
			.spyOn(f.api, "agentThread")
			.mockResolvedValue({ sessionId: session.sessionId, roomId: id(31), staffAgentId: staff.id, status: "active" });
		await draw();
		expect(location.hash).toBe(route);
		expect(placeholderLabel(f.root.querySelector("main"))).toBe("Opening company");
		expect(visibleText(f.root.querySelector("main"))).not.toContain("Opening");
		loading.resolve(team);
		await draw();
		expect(create).toHaveBeenCalledTimes(1);
		expect(location.hash).toBe(`#/c/${profileA.profileId}/chat/${session.sessionId}`);
	});

	it("counts the member's open decisions on the Co-Founder's card on a page with no dock", async () => {
		const f = mounted(`#/c/${profileA.profileId}/team`);
		vi.mocked(f.api.listStaff).mockResolvedValue([{ ...staff, templateId: "co-founder" }]);
		const listed = vi.spyOn(f.api, "listCompanyOpenDecisions").mockResolvedValue([
			{
				kind: "question",
				sessionId: session.sessionId,
				interactionId: id(740),
				sequence: 1,
				actorUserId: userA.id,
				staffAgentId: staff.id,
				request: { surface: "question", title: "Which logo?", payload: { options: [{ label: "A" }] } },
				createdAt: "2026-09-05T10:00:00Z",
			},
		]);
		await draw();
		await draw();
		expect(listed).toHaveBeenCalledWith(profileA.profileId);
		expect(f.root.querySelector(".decision-dock")).toBeNull();
		expect(f.root.querySelector(".rail .cofounder-home .rail-decisions")?.textContent).toBe("1");
		expect(f.root.querySelector(".rail .cofounder-home")?.getAttribute("aria-label")).toContain(
			"1 decision waits for you",
		);
	});

	it("counts open decisions once the membership arrives late, without waiting for the clock", async () => {
		const f = mounted(`#/c/${profileA.profileId}/team`);
		vi.mocked(f.api.listStaff).mockResolvedValue([{ ...staff, templateId: "co-founder" }]);
		const membership = deferred<typeof team>();
		vi.mocked(f.api.getTeam).mockReturnValue(membership.promise);
		const listed = vi.spyOn(f.api, "listCompanyOpenDecisions").mockResolvedValue([
			{
				kind: "question",
				sessionId: session.sessionId,
				interactionId: id(741),
				sequence: 1,
				actorUserId: userA.id,
				staffAgentId: staff.id,
				request: { surface: "question", title: "Which logo?", payload: { options: [{ label: "A" }] } },
				createdAt: "2026-09-05T10:00:00Z",
			},
		]);
		await draw();
		expect(listed).not.toHaveBeenCalled();
		membership.resolve(team);
		await draw();
		await draw();
		expect(listed).toHaveBeenCalledWith(profileA.profileId);
		expect(f.root.querySelector(".rail .cofounder-home .rail-decisions")?.textContent).toBe("1");
	});

	it("cancels a private confirmation dialog when the account changes", async () => {
		const f = mounted(`#/c/${profileA.profileId}/team`);
		await draw();
		const deleteProfile = vi.spyOn(f.api, "deleteProfile").mockResolvedValue();
		[...f.root.querySelectorAll("button")].find((button) => button.textContent === "Delete company")!.click();
		expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain("Company A PRIVATE");
		f.auth(userB);
		await draw();
		expect(document.querySelector('[role="alertdialog"]')).toBeNull();
		expect(deleteProfile).not.toHaveBeenCalled();
	});

	it("preserves a team invitation draft through background refreshes", async () => {
		const f = mounted(`#/c/${profileA.profileId}/team`);
		await draw();
		const email = f.root.querySelector<HTMLInputElement>('input[type="email"]')!;
		email.value = "draft@example.invalid";
		email.focus();
		f.hints.get("qorpera_profile_access_state")!();
		await draw();
		const refreshed = f.root.querySelector<HTMLInputElement>('input[type="email"]')!;
		expect(refreshed.value).toBe("draft@example.invalid");
		expect(document.activeElement).toBe(refreshed);
	});
	it("clears company and invitation state on identity changes and rejects old responses", async () => {
		const { api, auth, root } = mounted();
		await draw();
		expect(root.textContent).toContain("Company A PRIVATE");
		const old = deferred<HostedProfile[]>();
		vi.mocked(api.listProfiles).mockReturnValueOnce(old.promise).mockResolvedValue([profileB]);
		auth(null);
		await draw();
		auth(userA);
		await draw();
		auth(userB);
		await draw();
		expect(root.textContent).toContain("Company B");
		old.resolve([profileA]);
		await draw();
		expect(root.textContent).not.toContain("Company A PRIVATE");
		expect(root.textContent).toContain("Account B");
	});

	it("loads friends afresh for the new account", async () => {
		const { api, auth, root } = mounted("#/account");
		await draw();
		vi.mocked(api.listProfiles).mockResolvedValue([profileB]);
		auth(userB);
		await draw();
		expect(api.listFriends).not.toHaveBeenCalled();
		const openFriends = () => {
			root.querySelector<HTMLButtonElement>(".account-trigger")!.click();
			root.querySelector<HTMLButtonElement>('[data-account-action="friends"]')!.click();
		};
		openFriends();
		await draw();
		expect(api.listFriends).toHaveBeenCalledTimes(1);
		expect(root.querySelector(".friends-window")).not.toBeNull();
		auth(userA);
		await draw();
		expect(root.querySelector(".friends-window")).toBeNull();
		openFriends();
		await draw();
		expect(api.listFriends).toHaveBeenCalledTimes(2);
	});

	it("opens the account page back from Stripe's card page and says the card is saved, once", async () => {
		history.replaceState(null, "", "/#/account?good-will=card-saved");
		const f = fixture();
		const mine = vi.spyOn(f.api, "getMyGoodWill").mockResolvedValue({
			year: 2026,
			paidByMeOre: 0,
			companies: [
				{
					profileId: profileA.profileId,
					name: profileA.profileName,
					netOre: 0,
					feeOre: 0,
					rateBp: 1000,
					payer: "me",
					brand: "visa",
					last4: "4242",
				},
			],
		});
		const root = document.createElement("div");
		document.body.append(root);
		dispose = mountApplication(root, f.cloud, f.api);
		await draw();
		// The return is read and removed before routing: the account page, not the hub.
		expect(location.hash).toBe("#/account");
		const saved = "Card saved. It pays the company's next invoice.";
		expect(root.querySelector(".settings-good-will-account .notice-ok")?.textContent).toBe(saved);
		// Leaving the page takes the notice with it; the next visit reads afresh.
		location.hash = "#/";
		await draw();
		location.hash = "#/account";
		await draw();
		expect(root.querySelector(".settings-good-will-account")?.textContent).toContain("Your Visa ending 4242");
		expect(root.textContent).not.toContain(saved);
		expect(mine).toHaveBeenCalledTimes(2);
	});

	it("keeps a return from Stripe for the member who added the card, not the next one", async () => {
		const saved = "Card saved. It pays the company's next invoice.";
		const { api, auth, root } = mounted("#/?good-will=card-saved");
		vi.spyOn(api, "getMyGoodWill").mockResolvedValue({
			year: 2026,
			paidByMeOre: 0,
			companies: [
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
		await draw();
		expect(location.hash).toBe("#/");
		vi.mocked(api.listProfiles).mockResolvedValue([profileB]);
		auth(userB);
		await draw();
		location.hash = "#/account";
		await draw();
		// The list shows for the new member, without the other member's note.
		const mine = root.querySelector<HTMLElement>(".settings-good-will-account")!;
		expect(mine.hidden).toBe(false);
		expect(mine.querySelector(".notice-ok")).toBeNull();
		expect(root.textContent).not.toContain(saved);
	});

	it("does not navigate after a staff-session request finishes on another page", async () => {
		const { api, root } = mounted();
		const opened = deferred<AgentThreadHandle>();
		vi.mocked(api.listSessions).mockResolvedValue([]);
		vi.spyOn(api, "agentThread").mockReturnValue(opened.promise);
		await draw();
		location.hash = `#/c/${profileA.profileId}/staff/${staff.id}`;
		await draw();
		expect(api.agentThread).toHaveBeenCalledTimes(1);
		location.hash = "#/account";
		await draw();
		opened.resolve({ sessionId: session.sessionId, roomId: id(31), staffAgentId: staff.id, status: "active" });
		await draw();
		expect(location.hash).toBe("#/account");
		expect(root.querySelector("main .account h1")?.textContent).toBe("General");
	});

	it("ignores a late company lookup after navigating away", async () => {
		const f = mounted();
		await draw();
		const profiles = deferred<HostedProfile[]>();
		vi.mocked(f.api.listProfiles).mockReturnValue(profiles.promise);
		location.hash = `#/c/${profileB.profileId}/file`;
		await draw();
		location.hash = "#/account";
		await draw();
		profiles.resolve([profileB]);
		await draw();
		expect(location.hash).toBe("#/account");
		expect(f.api.getCompanyFile).not.toHaveBeenCalled();
		expect(f.root.querySelector("main .account h1")?.textContent).toBe("General");
	});

	it("opens the drawer on the company's name while no page is on (Interfaces C6a)", async () => {
		const f = mounted(`#/c/${profileA.profileId}/chat/${session.sessionId}`);
		await draw();
		f.root.querySelector<HTMLButtonElement>("main .mobile-navigation-toggle")!.click();
		await draw();
		expect(f.root.querySelector<HTMLElement>(".rail .rail-apps")!.hidden).toBe(true);
		expect(document.activeElement).toBe(f.root.querySelector(".rail .rail-company"));
	});

	it("toggles and closes company navigation without replacing the composer", async () => {
		const f = mounted(`#/c/${profileA.profileId}/chat/${session.sessionId}`);
		withInterfacesTab(f);
		await draw();
		const composer = f.root.querySelector("textarea");
		f.root.querySelector<HTMLButtonElement>("main .mobile-navigation-toggle")!.click();
		await draw();
		expect(f.root.querySelector(".frame")?.classList.contains("navigation-open")).toBe(true);
		// The drawer opens on the company's name, never on the folded search field.
		expect(f.root.querySelector<HTMLElement>(".rail .rail-apps")!.hidden).toBe(false);
		expect(document.activeElement).toBe(f.root.querySelector(".rail .rail-company"));
		// Esc that ends a composition (a dead key, an IME) leaves the drawer open.
		window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", isComposing: true }));
		await draw();
		expect(f.root.querySelector(".frame")?.classList.contains("navigation-open")).toBe(true);
		window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
		await draw();
		expect(f.root.querySelector(".frame")?.classList.contains("navigation-open")).toBe(false);
		expect(document.activeElement).toBe(f.root.querySelector("main .mobile-navigation-toggle"));
		expect(f.root.querySelector("textarea")).toBe(composer);
	});

	it("reopens the drawer on the company's name", async () => {
		const f = mounted(`#/c/${profileA.profileId}/chat/${session.sessionId}`);
		withInterfacesTab(f);
		await draw();
		const toggle = () => f.root.querySelector<HTMLButtonElement>("main .mobile-navigation-toggle")!;
		toggle().click();
		await draw();
		expect(f.root.querySelector<HTMLElement>(".rail .rail-apps")!.hidden).toBe(false);
		window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
		await draw();
		expect(f.root.querySelector(".frame")?.classList.contains("navigation-open")).toBe(false);
		toggle().click();
		await draw();
		expect(document.activeElement).toBe(f.root.querySelector(".rail .rail-company"));
	});

	it("keeps profile-menu focus through refreshes and closes it before the mobile drawer", async () => {
		const f = mounted(`#/c/${profileA.profileId}/chat/${session.sessionId}`);
		await draw();
		f.root.querySelector<HTMLButtonElement>("main .mobile-navigation-toggle")!.click();
		await draw();
		f.root.querySelector<HTMLButtonElement>(".rail .account-trigger")!.click();
		const teamLink = '.account-popover [data-account-action="settings"]';
		f.root.querySelector<HTMLAnchorElement>(teamLink)!.focus();
		f.hints.get("qorpera_profile_access_state")!();
		await draw();
		expect(f.root.querySelector<HTMLElement>(".account-popover")!.hidden).toBe(false);
		expect(document.activeElement).toBe(f.root.querySelector(teamLink));
		document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
		await draw();
		expect(f.root.querySelector<HTMLElement>(".account-popover")!.hidden).toBe(true);
		expect(f.root.querySelector(".frame")?.classList.contains("navigation-open")).toBe(true);
		expect(document.activeElement).toBe(f.root.querySelector(".rail .account-trigger"));
		document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
		await draw();
		expect(f.root.querySelector("main")?.inert).toBe(false);
		expect(document.activeElement).toBe(f.root.querySelector("main .mobile-navigation-toggle"));
	});

	it("keeps company navigation and sign out available when the profile moves between rail and account pages", async () => {
		const f = mounted(`#/c/${profileA.profileId}/chat/${session.sessionId}`);
		const signOut = vi.spyOn(AuthController.prototype, "signOut").mockImplementation(async () => f.auth(null));
		await draw();
		expect(f.root.querySelector(".topbar .account-trigger")).toBeNull();
		f.root.querySelector<HTMLButtonElement>(".rail .account-trigger")!.click();
		expect(f.root.querySelector('.account-popover a[data-href$="/team"]')).toBeNull();
		f.root.querySelector<HTMLButtonElement>('[data-account-action="settings"]')!.click();
		f.root.querySelector<HTMLButtonElement>("#settings-tab-company")!.click();
		await draw();
		expect(f.root.querySelector(".settings-dialog")?.textContent).toContain("Delete company");
		document.dispatchEvent(
			new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true, cancelable: true }),
		);
		expect(document.querySelector("dialog.search-window[open]")).toBeNull();
		f.root.querySelector<HTMLButtonElement>(".settings-close")!.click();
		f.root.querySelector<HTMLButtonElement>(".rail .account-trigger")!.click();
		f.root.querySelector<HTMLButtonElement>('.account-popover [data-account-action="friends"]')!.click();
		await draw();
		expect(f.api.listFriends).toHaveBeenCalledTimes(2);
		expect(f.root.querySelector(".friends-window")).not.toBeNull();
		expect(location.hash).toBe(`#/c/${profileA.profileId}/chat/${session.sessionId}`);
		f.root.querySelector<HTMLButtonElement>(".friends-window-close")!.click();
		expect(f.root.querySelector(".friends-window")).toBeNull();
		location.hash = "#/account";
		await draw();
		expect(f.root.querySelector(".topbar .account-trigger")?.textContent).toContain("Account A");
		expect(f.root.querySelector(".account-company-name")).toBeNull();
		location.hash = `#/c/${profileA.profileId}/chat/${session.sessionId}`;
		await draw();
		expect(f.root.querySelectorAll(".account-trigger")).toHaveLength(1);
		f.root.querySelector<HTMLButtonElement>(".rail .account-trigger")!.click();
		f.root.querySelector<HTMLButtonElement>(".account-signout")!.click();
		await draw();
		expect(signOut).toHaveBeenCalledTimes(1);
		expect(f.root.querySelector(".account-trigger")).toBeNull();
		expect(f.root.textContent).not.toContain(profileA.profileName);
	});

	it("restores access to the page when membership is revoked with the mobile drawer open", async () => {
		const f = mounted(`#/c/${profileA.profileId}/chat/${session.sessionId}`);
		vi.mocked(f.api.listSessions).mockResolvedValue([{ ...session, staffAgentId: staff.id }]);
		await draw();
		fromAgentCard(f.root, staff.id, "Computer");
		const panel = f.root.querySelector<HTMLElement>(".computer-panel")!;
		expect(panel.childElementCount).toBeGreaterThan(0);
		f.root.querySelector<HTMLButtonElement>("main .mobile-navigation-toggle")!.click();
		await draw();
		expect(f.root.querySelector("main")?.inert).toBe(true);
		vi.mocked(f.api.getTeam).mockRejectedValue(
			new CloudRpcError("getTeam", { code: "42501", message: "Access revoked" }),
		);
		f.hints.get("qorpera_profile_access_state")!();
		await draw();
		expect(f.root.querySelector("main")?.textContent).toContain("Your access to this company was revoked");
		// The computer left open is ended, not merely set aside for a return.
		expect(panel.isConnected).toBe(false);
		expect(panel.childElementCount).toBe(0);
		expect(f.root.querySelector("main")?.inert).toBe(false);
		expect(f.root.querySelector(".frame")?.classList.contains("navigation-open")).toBe(false);
		expect(f.root.querySelector(".topbar .account-trigger")).not.toBeNull();
		expect(f.root.querySelector(".account-company-name")).toBeNull();
	});

	it("opens the agent's computer from its rail card in the agent's chat, and its routines in the card", async () => {
		const f = mounted(`#/c/${profileA.profileId}/team`);
		vi.mocked(f.api.listSessions).mockResolvedValue([{ ...session, staffAgentId: staff.id }]);
		await draw();
		expect(f.root.querySelector(".computer-panel")).toBeNull();
		// Away from the chat, the card takes the member there and shows the computer once it opens.
		fromAgentCard(f.root, staff.id, "Computer");
		await draw();
		expect(location.hash).toBe(`#/c/${profileA.profileId}/chat/${session.sessionId}`);
		expect(document.querySelector(".agent-card")).toBeNull();
		expect(f.root.querySelectorAll("main .computer-panel")).toHaveLength(1);
		// The routines are a page of the card itself: nothing moves and nothing lies over the chat.
		fromAgentCard(f.root, staff.id, "Routines");
		await draw();
		const card = document.querySelector<HTMLDialogElement>("dialog.agent-card")!;
		expect(card.dataset.page).toBe("routines");
		expect(location.hash).toBe(`#/c/${profileA.profileId}/chat/${session.sessionId}`);
		expect(document.querySelector(".thread-routines")).toBeNull();
		expect(f.root.querySelector<HTMLElement>("main .thread-conversation")?.inert).toBeFalsy();
		const back = card.querySelector<HTMLButtonElement>(".routine-close")!;
		expect(back.getAttribute("aria-label")).toBe("Back to agent details");
		expect(document.activeElement).toBe(back);
		// The way back returns to the details, on the Routines line.
		back.click();
		expect(card.dataset.page).toBe("details");
		expect(card.querySelector(".routine-close")).toBeNull();
		expect(document.activeElement?.textContent).toBe("Routines");
	});

	it("keeps one rail placeholder while the company's agents load, then drops it", () => {
		const f = fixture();
		const controller = new CompanyController(f.api, profileA, userA.id);
		dispose = () => controller.stop();
		const rail = document.createElement("aside");
		const context = {
			profiles: [profileA],
			user: userA,
			auth: new AuthController(f.cloud),
			invitations: 0,
			openSettings: () => {},
			openFeedback: () => {},
			openFriends: () => {},
			route: { name: "company", profileId: profileA.profileId, section: "home" } as const,
		};
		renderRail(rail, controller, context);
		const placeholder = rail.querySelector(".skeleton-rail");
		expect(placeholderLabel(rail)).toBe("Loading agents");
		expect(visibleText(rail.querySelector(".rail-scroll"))).toBe("");
		controller.store.set({ team });
		renderRail(rail, controller, context);
		expect(rail.querySelector(".skeleton-rail")).toBe(placeholder);
		controller.store.set({ staff: [staff], sessions: [session], loading: false });
		renderRail(rail, controller, context);
		expect(rail.querySelector(".skeleton")).toBeNull();
		expect(rail.textContent).toContain(staff.displayName);
	});

	it("closes a drawer opened while a company opens when that company turns out to be unavailable", async () => {
		const f = mounted(`#/c/${id(77)}`);
		const profiles = deferred<HostedProfile[]>();
		vi.mocked(f.api.listProfiles).mockReturnValue(profiles.promise);
		await draw();
		f.root.querySelector<HTMLButtonElement>("main > .thread-skeleton .mobile-navigation-toggle")!.click();
		await draw();
		expect(f.root.querySelector(".frame")?.classList.contains("navigation-open")).toBe(true);
		profiles.resolve([profileA]);
		await draw();
		expect(f.root.querySelector("main")?.textContent).toContain("This company is not available to your account.");
		expect(f.root.querySelector(".frame")?.classList.contains("navigation-open")).toBe(false);
		expect(f.root.querySelector<HTMLElement>("main")?.inert).toBe(false);
	});

	it("opens Company File links on the Files page, and draws the folder again when the member's role changes", async () => {
		const list = vi.fn(async () => ({
			asOfSeq: 1,
			entries: [
				{
					path: "notes",
					kind: "folder",
					version: id(101),
					seq: 1,
					updatedAt: session.updatedAt,
					file: null,
					target: null,
				},
			],
			next: null,
		}));
		vi.spyOn(WebCompanyFiles.prototype, "folder").mockReturnValue({ list } as never);
		surfacesOn();
		vi.spyOn(WebCompanyFiles.prototype, "folderHints").mockReturnValue({ close: async () => {} } as never);
		const f = mounted(`#/c/${profileA.profileId}/file`);
		await draw();
		await draw();
		await draw();
		expect(location.hash).toBe(`#/c/${profileA.profileId}/s/files`);
		expect(f.root.querySelector(".settings-dialog")).toBeNull();
		const page = f.root.querySelector("main .surface-files");
		const row = page?.querySelector(".files-row");
		expect(row?.querySelector(".files-name")?.textContent).toBe("notes");
		vi.mocked(f.api.getTeam).mockResolvedValue({
			...team,
			role: "viewer",
			capabilities: { ...team.capabilities, write: false, authorize: false },
		});
		f.hints.get("qorpera_profile_access_state")!();
		await draw();
		await draw();
		const again = f.root.querySelector("main .surface-files");
		expect(again?.querySelector(".files-row .files-name")?.textContent).toBe("notes");
		expect(again?.querySelector(".files-row")).not.toBe(row);
		expect(row?.isConnected).toBe(false);
		expect(list).toHaveBeenCalledTimes(2);
	});

	/** The company's folder with one posted app, `apps/sales-board/`, made by the fixture's agent. */
	function withApp() {
		const fake = folderFake({ seed: [] });
		fake.put("apps/sales-board/app.toml", `name = "Sales board"\nowner = "${staff.id}"\nposted = true\n`);
		fake.put("apps/sales-board/index.html", "<p>Sales this week</p>");
		vi.spyOn(WebCompanyFiles.prototype, "folder").mockReturnValue(fake.folder as never);
		vi.spyOn(WebCompanyFiles.prototype, "folderHints").mockReturnValue({ close: async () => {} } as never);
		return fake;
	}
	const appPage = (root: HTMLElement) => root.querySelector<HTMLElement>("main > .side-panel.is-page");

	it("opens an agent's app as a page of its own from a deep link, and says when the app is gone", async () => {
		withApp();
		const f = mounted(`#/c/${profileA.profileId}/a/sales-board`);
		await draw();
		await draw();
		const page = appPage(f.root)!;
		expect(page).not.toBeNull();
		// The whole main area: no chat, and nothing beside one.
		expect(f.root.querySelector(".thread, .thread-body.has-beside")).toBeNull();
		// The app is the whole page (Jonas, 10 November 2026: no header): nothing of Qorpera's stands over it, and the
		// page carries the app's name for assistive technology.
		expect(page.getAttribute("aria-label")).toBe("Sales board");
		expect(page.querySelector(".side-panel-header, .side-panel-button, .side-panel-way")).toBeNull();
		// What Qorpera keeps there shows only when needed: the bar of a request above the page, the questions dock over it.
		expect([...page.children].map((child) => child.className)).toEqual([
			"app-ask",
			"side-panel-body",
			"question-dock",
		]);
		expect(page.querySelector<HTMLElement>(".app-ask")?.hidden).toBe(true);
		expect(page.querySelector<HTMLElement>(".question-dock")?.hidden).toBe(true);
		expect(page.querySelector(".side-panel-body iframe.side-panel-frame")?.getAttribute("sandbox")).toBe(
			"allow-scripts",
		);
		// The rail's icon for it is a link to this page, marked as the open one.
		const icon = f.root.querySelector<HTMLAnchorElement>(
			`.rail a.rail-app[data-href="#/c/${profileA.profileId}/a/sales-board"]`,
		);
		expect(icon?.getAttribute("aria-current")).toBe("page");
		// The company's redraws keep the page as it is.
		await vi.advanceTimersByTimeAsync(2000);
		await draw();
		expect(appPage(f.root)).toBe(page);
		location.hash = `#/c/${profileA.profileId}/a/gone`;
		await draw();
		await draw();
		expect(page.isConnected).toBe(false);
		const gone = appPage(f.root)!;
		expect(gone.querySelector(".side-panel-status")?.textContent).toBe("This app isn't in the company anymore.");
		// With no header, the line has its own ways on: back to the company (it was opened straight from a link), and
		// Reload. There is no folder to show.
		const ways = [...gone.querySelectorAll<HTMLElement>(".side-panel-way")];
		expect(ways.map((way) => way.textContent)).toEqual(["Back to the company", "Reload"]);
		expect(ways[0]?.getAttribute("data-href")).toBe(`#/c/${profileA.profileId}`);
	});

	it("waits for the company's staff before a deep-linked app's page opens and answers its roster", async () => {
		withApp();
		const f = mounted(`#/c/${profileA.profileId}/a/sales-board`);
		const staffRead = deferred<HostedStaffAgent[]>();
		vi.mocked(f.api.listStaff).mockReturnValue(staffRead.promise);
		await draw();
		await draw();
		// The membership and the folder are read; the staff are not yet: no page with a roster it can't answer.
		expect(f.api.listStaff).toHaveBeenCalled();
		expect(appPage(f.root)).toBeNull();
		expect(f.root.querySelector("main > .page .skeleton-page")).not.toBeNull();
		staffRead.resolve([staff]);
		await draw();
		await draw();
		const page = appPage(f.root)!;
		expect(page.getAttribute("aria-label")).toBe("Sales board");
		expect(page.querySelector("iframe.side-panel-frame")).not.toBeNull();
	});

	it("opens an app's card in a chat as the app's page", async () => {
		withApp();
		const f = mounted(`#/c/${profileA.profileId}/chat/${session.sessionId}`);
		await draw();
		await draw();
		const prose = markdown("See [Sales board](app:sales-board).");
		f.root.querySelector(".thread")!.append(prose);
		const followed = new MouseEvent("click", { bubbles: true, cancelable: true });
		prose.querySelector<HTMLButtonElement>("button.app-card")!.dispatchEvent(followed);
		expect(followed.defaultPrevented).toBe(true);
		expect(location.hash).toBe(`#/c/${profileA.profileId}/a/sales-board`);
		await draw();
		await draw();
		// Not beside the chat: the chat is gone, and the app has the page.
		expect(f.root.querySelector(".thread")).toBeNull();
		const page = appPage(f.root)!;
		expect(page.getAttribute("aria-label")).toBe("Sales board");
		expect(page.querySelector(".side-panel-header")).toBeNull();
	});

	it("draws an app's card in a chat as the drawer draws the app, with what it is about", async () => {
		const fake = withApp();
		fake.put(
			"apps/sales-board/app.toml",
			`name = "Sales board"\nabout = "This week's sales, shop by shop"\nemblem = "chart"\ncolour = "blue"\nowner = "${staff.id}"\nposted = true\n`,
		);
		const f = mounted(`#/c/${profileA.profileId}/chat/${session.sessionId}`);
		await draw();
		await draw();
		const prose = markdown("[Sales board](app:sales-board) has new numbers. So has [Old board](app:old-board).");
		f.root.querySelector(".thread")!.append(prose);
		await draw();
		const [card, gone] = prose.querySelectorAll<HTMLElement>(".app-cards > button.app-card");
		// One line about the app, whole on a hover.
		const note = card?.querySelector<HTMLElement>(".app-card-note");
		expect([note?.textContent, note?.title]).toEqual(Array(2).fill("This week's sales, shop by shop"));
		// The drawer's own colour for the app, and its emblem in place of the plain page's.
		const tile = f.root.querySelector<HTMLElement>('.rail .rail-app[data-app-key="app:sales-board"]');
		const colour = tile?.style.getPropertyValue("--app-colour");
		expect(colour).toMatch(/^#[0-9a-f]{6}$/);
		expect(card?.style.getPropertyValue("--app-colour")).toBe(colour);
		const shapes = (root: Element | null | undefined) =>
			[...(root?.querySelectorAll("svg.interface-emblem > g > *") ?? [])].map((part) => part.outerHTML);
		expect(shapes(card)).not.toEqual([]);
		expect(shapes(card)).toEqual(shapes(tile));
		expect(shapes(card)).not.toEqual(shapes(gone));
		// A card whose app the company does not have stays plain.
		expect(gone?.querySelector(".app-card-note")?.textContent).toBe("App");
		expect(gone?.style.getPropertyValue("--app-colour")).toBe("");

		const mainEl = f.root.querySelector<HTMLElement>("main")!;
		const qsaSpy = vi.spyOn(mainEl, "querySelectorAll");
		f.root.querySelector(".thread")!.append(h("p", null, "plain streaming text"));
		await settle();
		const cardScans = qsaSpy.mock.calls.filter(([selector]) => selector.includes(".app-card"));
		expect(cardScans).toHaveLength(0);

		const later = appCard("sales-board", "sales-board", "Later note");
		f.root.querySelector(".thread")!.append(later);
		await settle();
		expect(later.querySelector(".app-card-title")?.textContent).toBe("Sales board");
	});

	it("names the card a note from an app opens with as the drawer names the app, keeps its line, and opens the app", async () => {
		const fake = withApp();
		fake.put(
			"apps/sales-board/app.toml",
			`name = "Sales board"\nabout = "This week's sales, shop by shop"\nemblem = "chart"\nowner = "${staff.id}"\nposted = true\n`,
		);
		const f = mounted(`#/c/${profileA.profileId}/chat/${session.sessionId}`);
		await draw();
		await draw();
		// As views/conversation.ts draws a member's message that opens with `> app:sales-board#4 · Shop 4 · Aarhus`.
		const card = appCard("sales-board", "sales-board", "Shop 4 · Aarhus");
		f.root.querySelector(".thread")!.append(h("div", { class: "app-cards" }, card));
		await draw();
		expect(card.querySelector(".app-card-title")?.textContent).toBe("Sales board");
		expect(card.querySelector(".app-card-note")?.textContent).toBe("Shop 4 · Aarhus");
		// The drawer's own emblem for the app, in place of the plain page's.
		const tile = f.root.querySelector<HTMLElement>('.rail .rail-app[data-app-key="app:sales-board"]');
		// Each emblem names its own mask: the drawing is what is compared.
		const emblem = (root: Element | null | undefined) =>
			root?.querySelector(".interface-emblem")?.innerHTML.replace(/emblem-cuts-\d+/g, "");
		expect(emblem(card)).toBe(emblem(tile));
		expect(emblem(card)).not.toBe(emblem(appCard("sales-board", "sales-board", "x")));
		const followed = new MouseEvent("click", { bubbles: true, cancelable: true });
		card.dispatchEvent(followed);
		expect(followed.defaultPrevented).toBe(true);
		expect(location.hash).toBe(`#/c/${profileA.profileId}/a/sales-board`);
		await draw();
		await draw();
		expect(appPage(f.root)?.getAttribute("aria-label")).toBe("Sales board");
	});

	/** The app's own page open (its thread is not on screen), the controller the app made for the company, and the
	 * member transport a send goes out on. Every send below passes the app's own check of where the member is. */
	async function onAppPage() {
		const start = vi.spyOn(CompanyController.prototype, "start");
		withApp();
		const f = mounted(`#/c/${profileA.profileId}/a/sales-board`);
		vi.mocked(f.api.listSessions).mockResolvedValue([{ ...session, staffAgentId: staff.id }]);
		const send = executionTransport();
		await draw();
		await draw();
		expect(appPage(f.root)).not.toBeNull();
		const controller = start.mock.contexts[0] as CompanyController;
		const texts = () =>
			send.mock.calls.map((call) => (JSON.parse(String(call[0]?.body)) as { p_body: { text: string } }).p_body.text);
		return { f, controller, send, texts };
	}

	it("sends a note from an app's page, its thread not on screen, and no other message from there", async () => {
		const { controller, texts } = await onAppPage();
		const accounts = controller.appIconAccounts!;
		const note = { text: "Get a quote for shop 4.", quotes: [], header: "app:sales-board#4 · Shop 4" };
		expect(await tellAgent(controller, accounts, staff.id, note)).toEqual({
			sent: true,
			href: `#/c/${profileA.profileId}/staff/${staff.id}`,
		});
		expect(texts()).toEqual(["> app:sales-board#4 · Shop 4\n\nGet a quote for shop 4."]);
		// Any other send from here is refused, as before: the member is not looking at the thread.
		expect(await controller.sendPrompt(session.sessionId, "From the app's page")).toBe(false);
		expect(controller.conversation(session.sessionId).get().sendError).toBe("Company access is unavailable.");
		expect(texts()).toHaveLength(1);
	});

	it("asks an app's owner for new icons from the drawer while another page is on screen", async () => {
		const { controller, texts } = await onAppPage();
		const app = controller.store.get().apps?.find((entry) => entry.name === "sales-board");
		expect(await controller.requestAppIcons(app!)).toEqual({ ok: true, agent: staff.displayName });
		expect(texts()).toEqual([
			"Please draw 3 new icons for Sales board (apps/sales-board), from its name and what it shows.",
		]);
	});

	it("opens the Data page at the list a question was asked on, from its card in the conversation", async () => {
		const f = mounted(`#/c/${profileA.profileId}/chat/${session.sessionId}`);
		await draw();
		await draw();
		const card = pageNoteCard("data", "workshop:waited-over-a-week", "Workshop · Waited over a week");
		f.root.querySelector(".thread")!.append(card);
		card.click();
		expect(location.hash).toBe(`#/c/${profileA.profileId}/i/data`);
		expect(takeWantedDataList(profileA.profileId)).toBe("workshop:waited-over-a-week");
		expect(takeWantedDataList(profileA.profileId)).toBeUndefined();
	});

	it("leads back to the conversation from a card whose app is gone", async () => {
		withApp();
		const f = mounted(`#/c/${profileA.profileId}/chat/${session.sessionId}`);
		await draw();
		await draw();
		const prose = markdown("See [Old board](app:old-board).");
		f.root.querySelector(".thread")!.append(prose);
		prose.querySelector<HTMLButtonElement>("button.app-card")!.click();
		await draw();
		await draw();
		const page = appPage(f.root)!;
		expect(page.querySelector(".side-panel-status")?.textContent).toBe("This app isn't in the company anymore.");
		const back = page.querySelector<HTMLElement>("a.side-panel-way")!;
		expect(back.textContent).toBe("Back to the conversation");
		expect(back.getAttribute("data-href")).toBe(`#/c/${profileA.profileId}/chat/${session.sessionId}`);
	});

	it("reads the open app again from its icon in the rail, which also lets it ask again", async () => {
		// The app's page has no Reload of its own (no header), and a link to where one already is does nothing: a press
		// on the open app's icon is the member's reload (review r1 of #1636).
		const fake = withApp();
		fake.put(
			"apps/sales-board/app.toml",
			`name = "Sales board"\nowner = "${staff.id}"\nposted = true\nwrites = ["table:orders"]\n`,
		);
		fake.put(
			"QorperaOS/tables/orders/table.toml",
			'format = "qorpera.table/v0"\n\n[table]\nid = "1d6e4a57-8b3c-4f21-9e6d-0a7c5b2f8e15"\nname = "Orders"\nrows = "file"\nkey = ["order"]\n\n[[column]]\nname = "order"\ntype = "text"\n\n[[column]]\nname = "status"\ntype = "text"\n\n[write]\nagents = "all"\nmembers = "all"\n',
		);
		fake.put("QorperaOS/tables/orders/rows.csv", "order,status\n1042,packed\n");
		const f = mounted(`#/c/${profileA.profileId}/a/sales-board`);
		await draw();
		await draw();
		const page = appPage(f.root)!;
		/** Plays the frame's side up to the hand-over, as the frame document would: a way to send a call on its port. */
		const played = async () => {
			const frame = await vi.waitFor(() => {
				const found = page.querySelector<HTMLIFrameElement>("iframe.side-panel-frame");
				if (!found?.contentWindow || found.dataset.played) throw new Error("no new frame yet");
				return found;
			});
			frame.dataset.played = "true";
			const post = vi.spyOn(frame.contentWindow as Window, "postMessage").mockImplementation(() => {});
			frame.dispatchEvent(new Event("load"));
			const ready = new MessageEvent("message", { data: { type: PAGE_READY } });
			Object.defineProperty(ready, "source", { value: frame.contentWindow });
			window.dispatchEvent(ready);
			const port = (post.mock.calls[0] as unknown as [unknown, string, MessagePort[]])[2][0] as MessagePort;
			let calls = 0;
			const call = (method: string, params: Record<string, unknown>) =>
				new Promise<{ ok: boolean; error?: string }>((resolve) => {
					const id = ++calls;
					const answer = (event: MessageEvent) => {
						if (event.data?.id !== id) return;
						port.removeEventListener("message", answer);
						resolve(event.data);
					};
					port.addEventListener("message", answer);
					port.start();
					port.postMessage({ type: "qorpera-app-call", id, method, params });
				});
			return { frame, call };
		};
		const ship = { table: "orders", key: "1042", cells: { status: "shipped" } };
		const bar = () => page.querySelector<HTMLElement>(".app-ask") as HTMLElement;
		const asked = () =>
			vi.waitFor(() => {
				if (bar().hidden) throw new Error("no request on the bar yet");
			});
		const first = await played();
		// Three times Not now: the app asks no more.
		for (let round = 0; round < 3; round++) {
			const answer = first.call("setRow", ship);
			await asked();
			[...bar().querySelectorAll("button")].find((button) => button.textContent === "Not now")?.click();
			expect(await answer).toMatchObject({ ok: false, error: "The member said not now" });
		}
		expect(await first.call("setRow", ship)).toMatchObject({
			ok: false,
			error: expect.stringContaining("three times"),
		});
		const icon = f.root.querySelector<HTMLAnchorElement>(
			`.rail a.rail-app[data-href="#/c/${profileA.profileId}/a/sales-board"]`,
		)!;
		// A modified click on the icon stays the link's own (a new tab): nothing is read again.
		const tab = vi.spyOn(window, "open").mockReturnValue(null);
		icon.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, metaKey: true }));
		expect(tab).toHaveBeenCalledOnce();
		await draw();
		expect(page.querySelector("iframe.side-panel-frame")).toBe(first.frame);
		// An ordinary press on the icon of the app that is open reads it again, in a new frame, and it may ask again.
		icon.click();
		const second = await played();
		expect(second.frame).not.toBe(first.frame);
		expect(appPage(f.root)).toBe(page);
		void second.call("setRow", ship);
		await asked();
		expect(bar().textContent).toContain("This app wants to change a row in a company table");
		expect(tab).toHaveBeenCalledOnce();
	});

	/** The company's folder with two concepts of its product, `shop-a` then `shop-b` (the newer), and the posted app. */
	function withConcepts() {
		const fake = withApp();
		// The folder's change hints, to send by hand.
		const hints: ((seq: number) => void)[] = [];
		vi.mocked(WebCompanyFiles.prototype.folderHints).mockImplementation((onHint) => {
			hints.push(onHint);
			return { close: async () => {} } as never;
		});
		fake.put(
			"apps/shop-a/app.toml",
			`name = "Shop A"\nabout = "A calm shop"\nowner = "${staff.id}"\nconcept = true\n`,
		);
		fake.put("apps/shop-a/index.html", "<p>Shop A</p>");
		fake.put("apps/shop-b/app.toml", 'name = "Shop B"\nconcept = true\nposted = true\n');
		fake.put("apps/shop-b/index.html", "<p>Shop B</p>");
		/** Tells the open company its folder changed, and lets the apps and the viewer read it. */
		const changed = async () => {
			for (const hint of hints) hint(fake.seq);
			await vi.advanceTimersByTimeAsync(3000);
			await draw();
			await draw();
		};
		return Object.assign(fake, { changed });
	}
	/** The side panel ends with its list: no controls under it and no strip (Jonas, 13 November 2026: "get rid of this
	 * at the bottom of the concepts sidepanel"), open or folded. */
	const endsWithItsList = (root: HTMLElement) => {
		const side = root.querySelector<HTMLElement>(".concepts > .concepts-side")!;
		expect(side.lastElementChild?.classList.contains("concepts-panel")).toBe(true);
		expect(side.querySelector(".concepts-panel")?.lastElementChild?.tagName).toBe("NAV");
	};
	/** A concept's row's menu, opened as a right-click (`at` the pointer) or the keyboard's menu key (no point) opens it. */
	const rowMenu = (root: HTMLElement, name: string, at = { clientX: 40, clientY: 120 }) => {
		const row = root.querySelector<HTMLAnchorElement>(`.concepts-side a.concepts-item[data-concept="${name}"]`)!;
		const opened = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, ...at });
		row.dispatchEvent(opened);
		expect(opened.defaultPrevented).toBe(true);
		const menu = document.querySelector<HTMLElement>(".context-menu");
		expect(menu?.getAttribute("aria-label")).toContain("actions");
		return {
			row,
			menu: menu!,
			labels: [...menu!.querySelectorAll("[role=menuitem]")].map((item) => item.textContent),
			choose: (label: string) =>
				[...menu!.querySelectorAll<HTMLButtonElement>("[role=menuitem]")]
					.find((item) => item.textContent === label)!
					.click(),
		};
	};
	const concepts = (root: HTMLElement) => root.querySelector<HTMLElement>("main > section.concepts");
	const conceptItems = (root: HTMLElement) =>
		[...root.querySelectorAll<HTMLAnchorElement>(".concepts-side a.concepts-item")].map((item) => [
			item.querySelector(".concepts-item-title")?.textContent,
			item.getAttribute("data-href"),
			item.getAttribute("aria-current"),
		]);
	const conceptFrame = (root: HTMLElement) =>
		root.querySelector<HTMLIFrameElement>(".concepts-stage > .side-panel.is-concept iframe.side-panel-frame");

	it("opens the Concepts viewer full screen from a deep link, at the newest concept, with no chrome over it", async () => {
		withConcepts();
		const f = mounted(`#/c/${profileA.profileId}/concepts`);
		await draw();
		await draw();
		const view = concepts(f.root)!;
		expect(view).not.toBeNull();
		// Full screen: no rail, no top bar, no chat.
		expect(f.root.querySelector<HTMLElement>(".rail")?.hidden).toBe(true);
		expect(f.root.querySelector(".frame")?.classList.contains("has-concepts")).toBe(true);
		expect(f.root.querySelector(".thread")).toBeNull();
		// The side panel: the way back to the company, the heading and one item per concept, the newest first and open.
		const back = view.querySelector<HTMLAnchorElement>("a.concepts-back")!;
		expect(back.getAttribute("data-href")).toBe(`#/c/${profileA.profileId}`);
		expect(back.textContent).toBe(profileA.profileName);
		expect(back.getAttribute("aria-label")).toBe(`Back to ${profileA.profileName}`);
		expect(view.querySelector(".concepts-heading")?.textContent).toBe("Concepts");
		expect(conceptItems(f.root)).toEqual([
			["Shop B", `#/c/${profileA.profileId}/concepts/shop-b`, "page"],
			["Shop A", `#/c/${profileA.profileId}/concepts/shop-a`, null],
		]);
		const a = view.querySelector(`a.concepts-item[data-href$="/shop-a"]`)!;
		expect(a.querySelector(".concepts-item-about")?.textContent).toBe("A calm shop");
		expect(a.querySelector(".concepts-item-by")?.textContent).toBe("Made by Fixture agent");
		expect(a.querySelector(".concepts-thumb svg.interface-emblem")).not.toBeNull();
		// The concept's frame fills the stage, with no header bar over it; the panel ends with its list.
		expect(conceptFrame(f.root)?.getAttribute("sandbox")).toBe("allow-scripts");
		expect(view.querySelector(".concepts-stage .side-panel-header")).toBeNull();
		endsWithItsList(f.root);
		// The posted app that is no concept is not listed.
		expect(view.querySelector(`a.concepts-item[data-href$="/sales-board"]`)).toBeNull();
		// The company's redraws keep the viewer and its frame as they are.
		const frame = conceptFrame(f.root);
		await vi.advanceTimersByTimeAsync(2000);
		await draw();
		expect(concepts(f.root)).toBe(view);
		expect(conceptFrame(f.root)).toBe(frame);
		// Leaving the route brings the rail back.
		location.hash = `#/c/${profileA.profileId}/chat/${session.sessionId}`;
		await draw();
		await draw();
		expect(view.isConnected).toBe(false);
		expect(f.root.querySelector<HTMLElement>(".rail")?.hidden).toBe(false);
		expect(f.root.querySelector(".frame")?.classList.contains("has-concepts")).toBe(false);
	});

	it("opens the concept a deep link names and switches concepts in place from the side panel", async () => {
		withConcepts();
		const f = mounted(`#/c/${profileA.profileId}/concepts/shop-a`);
		await draw();
		await draw();
		const view = concepts(f.root)!;
		expect(conceptItems(f.root).map(([, , current]) => current)).toEqual([null, "page"]);
		const first = conceptFrame(f.root)!;
		expect(first.title).toBe("App: Shop A");
		const item = view.querySelector<HTMLAnchorElement>(`a.concepts-item[data-href$="/shop-b"]`)!;
		location.hash = item.getAttribute("data-href")!;
		await draw();
		await draw();
		// The same viewer and side panel, the same item element; only the stage's frame is new.
		expect(concepts(f.root)).toBe(view);
		expect(view.querySelector(`a.concepts-item[data-href$="/shop-b"]`)).toBe(item);
		expect(conceptItems(f.root).map(([, , current]) => current)).toEqual(["page", null]);
		expect(first.isConnected).toBe(false);
		expect(conceptFrame(f.root)?.title).toBe("App: Shop B");
		// A concept that is gone says so, and offers the newest.
		location.hash = `#/c/${profileA.profileId}/concepts/gone`;
		await draw();
		await draw();
		expect(view.querySelector(".concepts-status p")?.textContent).toBe("This concept isn't in the company anymore.");
		expect(view.querySelector(".concepts-status a")?.getAttribute("data-href")).toBe(
			`#/c/${profileA.profileId}/concepts/shop-b`,
		);
	});

	it("keeps the missing concept's offer on the concept that is newest now", async () => {
		const fake = withConcepts();
		const f = mounted(`#/c/${profileA.profileId}/concepts/gone`);
		await draw();
		await draw();
		const view = concepts(f.root)!;
		const offer = () => view.querySelector(".concepts-status a")?.getAttribute("data-href");
		expect(offer()).toBe(`#/c/${profileA.profileId}/concepts/shop-b`);
		// The newest one is taken away: the same words, but the offer moves to the one that is newest now.
		fake.remove("apps/shop-b");
		await fake.changed();
		expect(view.querySelector(".concepts-status p")?.textContent).toBe("This concept isn't in the company anymore.");
		expect(offer()).toBe(`#/c/${profileA.profileId}/concepts/shop-a`);
		// The last one goes too: nothing is offered.
		fake.remove("apps/shop-a");
		await fake.changed();
		expect(view.querySelector(".concepts-status p")?.textContent).toBe("This concept isn't in the company anymore.");
		expect(view.querySelector(".concepts-status a")).toBeNull();
	});

	it("shows a cover made, replaced or read again after a failure, by its file's version", async () => {
		const made: string[] = [];
		const forgotten: string[] = [];
		let failNext = false;
		// jsdom has no object URLs: each picture gets a numbered one.
		Object.defineProperty(URL, "createObjectURL", {
			configurable: true,
			value: () => {
				if (failNext) {
					failNext = false;
					throw new Error("No picture");
				}
				made.push(`blob:cover-${made.length + 1}`);
				return made.at(-1);
			},
		});
		Object.defineProperty(URL, "revokeObjectURL", {
			configurable: true,
			value: (url: string) => forgotten.push(url),
		});
		try {
			const fake = withConcepts();
			fake.put("apps/shop-b/app.toml", 'name = "Shop B"\nconcept = true\ncover = "cover.webp"\n');
			const f = mounted(`#/c/${profileA.profileId}/concepts`);
			await draw();
			await draw();
			const thumb = () =>
				f.root.querySelector<HTMLElement>(`a.concepts-item[data-href$="/shop-b"] .concepts-thumb`)!;
			const shown = () => thumb().querySelector("img")?.getAttribute("src") ?? null;
			// Named but not there yet: the emblem.
			expect(shown()).toBeNull();
			expect(thumb().querySelector("svg.interface-emblem")).not.toBeNull();
			// Made, without a change to app.toml: it shows at the folder's next change.
			fake.put("apps/shop-b/cover.webp", "first");
			await fake.changed();
			expect(shown()).toBe("blob:cover-1");
			// Replaced: the new picture, and the old one let go.
			fake.put("apps/shop-b/cover.webp", "second");
			await fake.changed();
			expect(shown()).toBe("blob:cover-2");
			expect(forgotten).toEqual(["blob:cover-1"]);
			// A change the folder has no news of reads nothing again.
			await fake.changed();
			expect(made).toHaveLength(2);
			// A read that fails keeps what was shown, and is tried again at the next change.
			fake.put("apps/shop-b/cover.webp", "third");
			failNext = true;
			await fake.changed();
			expect(shown()).toBe("blob:cover-2");
			await fake.changed();
			expect(shown()).toBe("blob:cover-3");
			// Taken away: the emblem again.
			fake.remove("apps/shop-b/cover.webp");
			await fake.changed();
			expect(shown()).toBeNull();
			expect(thumb().querySelector("svg.interface-emblem")).not.toBeNull();
			expect(forgotten).toEqual(["blob:cover-1", "blob:cover-2", "blob:cover-3"]);
		} finally {
			Reflect.deleteProperty(URL, "createObjectURL");
			Reflect.deleteProperty(URL, "revokeObjectURL");
		}
	});

	it("folds the side panel to a strip and keeps that for the viewer", async () => {
		localStorage.removeItem("qorpera.web.concepts-collapsed");
		try {
			withConcepts();
			const f = mounted(`#/c/${profileA.profileId}/concepts`);
			await draw();
			await draw();
			const view = concepts(f.root)!;
			const fold = view.querySelector<HTMLButtonElement>("button.concepts-collapse")!;
			expect(view.classList.contains("is-collapsed")).toBe(false);
			// It says what it does now, as a sidebar's toggle does, and whether the sidebar is open.
			expect(fold.getAttribute("aria-label")).toBe("Hide sidebar");
			expect(fold.title).toBe("Hide sidebar");
			expect(fold.getAttribute("aria-expanded")).toBe("true");
			fold.click();
			expect(view.classList.contains("is-collapsed")).toBe(true);
			expect(fold.getAttribute("aria-label")).toBe("Show sidebar");
			expect(fold.title).toBe("Show sidebar");
			expect(fold.getAttribute("aria-expanded")).toBe("false");
			expect(localStorage.getItem("qorpera.web.concepts-collapsed")).toBe("1");
			// The concept stays open while the panel folds, and the folded strip has nothing under its buttons.
			expect(conceptFrame(f.root)?.title).toBe("App: Shop B");
			endsWithItsList(f.root);
			// Opened again, it is folded still.
			dispose?.();
			dispose = undefined;
			document.body.replaceChildren();
			const again = mounted(`#/c/${profileA.profileId}/concepts`);
			await draw();
			await draw();
			expect(concepts(again.root)?.classList.contains("is-collapsed")).toBe(true);
			endsWithItsList(again.root);
			concepts(again.root)!.querySelector<HTMLButtonElement>("button.concepts-collapse")!.click();
			endsWithItsList(again.root);
			expect(localStorage.getItem("qorpera.web.concepts-collapsed")).toBe("0");
		} finally {
			localStorage.removeItem("qorpera.web.concepts-collapsed");
		}
	});

	it("keeps Reload and Show in Files in a concept's row menu, where the panel's foot had them", async () => {
		withConcepts();
		const f = mounted(`#/c/${profileA.profileId}/concepts`);
		await draw();
		await draw();
		endsWithItsList(f.root);
		const open = rowMenu(f.root, "shop-b");
		expect(open.menu.classList.contains("context-menu")).toBe(true);
		expect(open.row.classList.contains("menu-open")).toBe(true);
		expect(open.labels).toEqual(["Reload", "Show in Files"]);
		// Reload reads the concept again, in a new frame (which also lets it ask again after three Not nows).
		const before = conceptFrame(f.root);
		open.choose("Reload");
		await draw();
		await draw();
		expect(conceptFrame(f.root)).not.toBe(before);
		expect(conceptFrame(f.root)?.title).toBe("App: Shop B");
		expect(rowMenu(f.root, "shop-a").labels).toEqual(["Show in Files"]);
		document
			.querySelector<HTMLElement>(".context-menu")!
			.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
		// From the keyboard (Shift+F10 or the menu key on the focused row): the browser's contextmenu has no point.
		const keyed = rowMenu(f.root, "shop-b", { clientX: 0, clientY: 0 });
		expect(keyed.labels).toEqual(["Reload", "Show in Files"]);
		keyed.choose("Show in Files");
		await draw();
		await draw();
		expect(location.hash).toBe(`#/c/${profileA.profileId}/s/files`);
	});

	it("keeps who made a concept in its row, with no strip and no controls under the list, in any layout", () => {
		const style = document.createElement("style");
		style.textContent = conversationCss;
		document.head.append(style);
		try {
			const rules = (list: CSSRuleList): { selector: string; rule: CSSStyleRule; media: string }[] =>
				[...list].flatMap((rule) =>
					rule instanceof CSSStyleRule
						? [{ selector: rule.selectorText, rule, media: "" }]
						: rule instanceof CSSMediaRule
							? rules(rule.cssRules).map((entry) => ({ ...entry, media: rule.media.mediaText }))
							: [],
				);
			const all = rules(style.sheet!.cssRules);
			// The strip and the foot are gone, in every layout (Jonas, 13 November 2026).
			expect(all.filter(({ selector }) => /\.concepts-(guard|foot|actions)\b/.test(selector))).toEqual([]);
			// Who made each concept stands in its row: nothing styles that line away.
			const hiding = all.filter(
				({ selector, rule }) =>
					/\.concepts-item(-copy|-by)?\b/.test(selector) &&
					(rule.style.display === "none" || rule.style.visibility === "hidden" || rule.style.opacity === "0"),
			);
			expect(hiding.map(({ selector, media }) => `${media} ${selector}`)).toEqual([]);
		} finally {
			style.remove();
		}
	});

	it("shows one Concepts entry in the rail and opens a concept's app link in the Concepts viewer", async () => {
		withConcepts();
		const f = mounted(`#/c/${profileA.profileId}/chat/${session.sessionId}`);
		await draw();
		await draw();
		const entry = f.root.querySelector<HTMLAnchorElement>(".rail .rail-apps-drawer a.rail-concepts");
		expect(entry?.getAttribute("data-href")).toBe(`#/c/${profileA.profileId}/concepts`);
		expect(entry?.querySelector(".rail-app-name")?.textContent).toBe("Concepts");
		// The concepts have no icon of their own; the posted app that is no concept keeps its own.
		expect(f.root.querySelector(`.rail a.rail-app[data-href$="/a/shop-b"]`)).toBeNull();
		expect(f.root.querySelector(`.rail a.rail-app[data-href$="/a/sales-board"]`)).not.toBeNull();
		// A concept's card in a chat opens the Concepts viewer at it, which leads back to the conversation.
		const prose = markdown("See [Shop A](app:shop-a).");
		f.root.querySelector(".thread")!.append(prose);
		const followed = new MouseEvent("click", { bubbles: true, cancelable: true });
		prose.querySelector<HTMLButtonElement>("button.app-card")!.dispatchEvent(followed);
		expect(followed.defaultPrevented).toBe(true);
		expect(location.hash).toBe(`#/c/${profileA.profileId}/concepts/shop-a`);
		await draw();
		await draw();
		expect(conceptItems(f.root).map(([, , current]) => current)).toEqual([null, "page"]);
		expect(concepts(f.root)?.querySelector("a.concepts-back")?.getAttribute("data-href")).toBe(
			`#/c/${profileA.profileId}/chat/${session.sessionId}`,
		);
		// A concept's own app link opens the Concepts viewer at it; an app that is no concept keeps its page.
		location.hash = `#/c/${profileA.profileId}/a/shop-b`;
		await draw();
		await draw();
		expect(location.hash).toBe(`#/c/${profileA.profileId}/concepts/shop-b`);
		expect(conceptFrame(f.root)?.title).toBe("App: Shop B");
		location.hash = `#/c/${profileA.profileId}/a/sales-board`;
		await draw();
		await draw();
		expect(location.hash).toBe(`#/c/${profileA.profileId}/a/sales-board`);
		expect(appPage(f.root)?.getAttribute("aria-label")).toBe("Sales board");
		expect(concepts(f.root)).toBeNull();
	});

	it("says in the rail that it is reconnecting when the conversations cannot be reached, and clears it once they can", async () => {
		const f = mounted(`#/c/${profileA.profileId}`);
		vi.mocked(f.api.listSessions).mockRejectedValue(
			new CloudRpcError("qorpera_list_shared_sessions", { message: "TypeError: Failed to fetch" }, 0),
		);
		await draw();
		await draw();
		const rail = f.root.querySelector(".rail")!;
		expect(rail.querySelector(".notice-neutral")?.textContent).toBe("Can't reach Qorpera. Trying again…");
		expect(rail.textContent).not.toContain("Failed to fetch");
		expect(rail.querySelector(".notice-danger")).toBeNull();
		vi.mocked(f.api.listSessions).mockResolvedValue([session]);
		window.dispatchEvent(new Event("online"));
		await draw();
		await draw();
		expect(rail.textContent).not.toContain("Can't reach Qorpera");
	});

	it("says a lost connection in the member's language once the app is mounted", () => {
		mounted();
		const lost = new CloudRpcError("qorpera_get_team", { message: "TypeError: Failed to fetch" }, 0);
		setLanguagePreference("da");
		try {
			expect(describeError(lost)).toBe("Qorpera kan ikke nås lige nu. Tjek din forbindelse, og prøv igen.");
		} finally {
			setLanguagePreference("system");
		}
		expect(describeError(lost)).toBe("Qorpera can't be reached right now. Check your connection and try again.");
	});

	it("sends an old Company File link to the Files page, and waits in the rail while the company cannot be reached", async () => {
		const f = mounted(`#/c/${profileA.profileId}/file`);
		const lost = new CloudRpcError("qorpera_get_team", { message: "TypeError: Failed to fetch" }, 0);
		vi.mocked(f.api.getTeam).mockRejectedValue(lost);
		vi.mocked(f.api.listStaff).mockRejectedValue(lost);
		await draw();
		await draw();
		expect(location.hash).toBe(`#/c/${profileA.profileId}/s/files`);
		expect(f.root.querySelector(".settings-dialog")).toBeNull();
		const rail = f.root.querySelector(".rail")!;
		expect(rail.textContent).not.toContain("No agents yet.");
		expect(rail.querySelector(".notice-danger")).toBeNull();
		vi.mocked(f.api.getTeam).mockResolvedValue(team);
		vi.mocked(f.api.listStaff).mockResolvedValue([staff]);
		window.dispatchEvent(new Event("online"));
		await draw();
		await draw();
		expect(rail.textContent).not.toContain("Can't reach Qorpera");
	});

	it("shows an error with a way to try again when the cloud session cannot be read", async () => {
		history.replaceState(null, "", "/#/");
		const f = fixture();
		vi.spyOn(f.cloud.supabase.auth, "getSession").mockRejectedValue(new Error("Network unavailable"));
		const root = document.createElement("div");
		document.body.append(root);
		dispose = mountApplication(root, f.cloud, f.api);
		await draw();
		expect(root.querySelector(".skeleton-group")).toBeNull();
		expect(root.textContent).toContain("The cloud could not be reached. Network unavailable");
		expect([...root.querySelectorAll("button")].some((button) => button.textContent === "Try again")).toBe(true);
		// A redraw, such as a route change, keeps the error instead of blanking the page again.
		location.hash = `#/c/${profileA.profileId}`;
		await draw();
		expect(root.textContent).toContain("The cloud could not be reached. Network unavailable");
	});

	it("keeps the rail bound to the current company and current route", () => {
		const f = fixture();
		const a = new CompanyController(f.api, profileA, userA.id),
			b = new CompanyController(f.api, profileB, userA.id);
		dispose = () => {
			a.stop();
			b.stop();
		};
		for (const controller of [a, b]) controller.store.set({ team, sessions: [session], loading: false });
		const rail = document.createElement("aside");
		const context = {
			profiles: [profileA, profileB],
			user: userA,
			auth: new AuthController(f.cloud),
			invitations: 0,
			openSettings: () => {},
			openFeedback: () => {},
			openFriends: () => {},
		};
		renderRail(rail, a, { ...context, route: { name: "company", profileId: profileA.profileId, section: "file" } });
		renderRail(rail, b, { ...context, route: { name: "company", profileId: profileB.profileId, section: "file" } });
		renderRail(rail, b, { ...context, route: { name: "company", profileId: profileB.profileId, section: "team" } });
		expect(rail.querySelector("input")).toBeNull();
		expect(rail.querySelector(".account-trigger")?.textContent).toContain("Account A");
		expect(rail.textContent).not.toContain("Company A PRIVATE");
		expect(rail.querySelector('a[data-href$="/team"]')).toBeNull();
	});

	it("retains creation idempotency across an ambiguous failure and controller restart", async () => {
		const f = fixture();
		vi.mocked(f.api.companyFoundingAvailable).mockResolvedValue(true);
		const opened: unknown[] = [];
		vi.mocked(f.cloud.rpc).mockImplementation(async (name: string, args?: Record<string, unknown>) => {
			if (name !== "qorpera_open_company_founding") throw new Error(`Unexpected RPC ${name}`);
			opened.push(args?.p_client_creation_id);
			throw new Error("Response lost");
		});
		let hub = new HubController(f.api, userA.id);
		await hub.createCompany("One company");
		hub.dispose();
		hub = new HubController(f.api, userA.id);
		expect(hub.store.get().creationRetry?.name).toBe("One company");
		await hub.createCompany("One company");
		expect(opened).toHaveLength(2);
		expect(opened[0]).toBe(opened[1]);
		expect(new HubController(f.api, userB.id).store.get().creationRetry).toBeUndefined();
		hub.dispose();
	});
});

describe("Continue with ChatGPT: the return from OpenAI", () => {
	const chat = `#/c/${profileA.profileId}/chat/${session.sessionId}`;
	const confirmation = "d".repeat(43);
	const status = () => document.querySelector(".connection-plan")?.textContent;
	const settingsOpen = () => document.querySelector(".settings-overlay") !== null;
	/** A sign-in this tab started on `chat`, a Co-Founder home that redirects to its conversation,
	 * and a vault that takes 3 s to confirm. */
	function returned(memberId = userA.id, returnRoute = chat) {
		const signals: AbortSignal[] = [];
		const confirm = vi.fn(
			(_input: string | URL | Request, init?: RequestInit) =>
				new Promise<Response>((resolve, reject) => {
					if (init?.signal) signals.push(init.signal);
					init?.signal?.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
					setTimeout(() => resolve(Response.json({ status: "completed", login_id: id(105) })), 3000);
				}),
		);
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
				if (String(input) === "https://login.fixture.invalid/chatgpt-plan-confirm") return confirm(input, init);
				throw new Error("No cloud transport in this UI fixture");
			}),
		);
		sessionStorage.setItem(
			"qorpera.chatgpt-plan-sign-in.v1",
			JSON.stringify({
				companyId: profileA.profileId,
				memberId,
				loginId: id(105),
				clientConnectionId: id(103),
				capability: "c".repeat(43),
				expiresAt: new Date(Date.now() + 900_000).toISOString(),
				startedAt: Date.now(),
				returnRoute,
			}),
		);
		// The callback's return page is the site's root, with the outcome after it.
		const f = mounted(`#?chatgpt_plan=confirm&confirmation=${confirmation}`);
		vi.mocked(f.api.getOrganization).mockResolvedValue({
			schema: "qorpera.company-organization/v1",
			profileId: profileA.profileId,
			cofounder: { staffAgentId: staff.id, formationId: id(30), memberSessionId: session.sessionId },
			formation: {
				formationId: id(30),
				state: "operating",
				status: "active",
				revision: 1,
				projectionStatus: "ready",
				sourcePath: "company/formation.json",
			},
			responsibilities: [],
			projects: [],
		});
		return { ...f, confirm, signals };
	}

	it("goes back to the page the sign-in began on and finishes it in AI subscriptions", async () => {
		const { confirm, signals } = returned();
		await draw();
		await draw();
		expect(location.hash).toBe(chat);
		expect(sessionStorage.getItem("qorpera.chatgpt-plan-sign-in.v1")).toBeNull();
		expect(settingsOpen()).toBe(true);
		expect(document.querySelector("#settings-tab-ai-subscriptions")?.getAttribute("aria-selected")).toBe("true");
		expect(status()).toBe("Finishing your ChatGPT sign-in…");
		await vi.advanceTimersByTimeAsync(3500);
		await draw();
		expect(confirm).toHaveBeenCalledOnce();
		expect(signals.map((signal) => signal.aborted)).toEqual([false]);
		expect(status()).toBe("Your ChatGPT plan is connected.");
	});

	it("finishes it while Settings is closed, and AI subscriptions shows the outcome when it opens", async () => {
		const { confirm, signals } = returned();
		await draw();
		await draw();
		expect(settingsOpen()).toBe(true);
		document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
		await draw();
		expect(settingsOpen()).toBe(false);
		await vi.advanceTimersByTimeAsync(3500);
		await draw();
		expect(signals.map((signal) => signal.aborted)).toEqual([false]);
		document.querySelector<HTMLButtonElement>(".account-trigger")!.click();
		document.querySelector<HTMLButtonElement>('[data-account-action="settings"]')!.click();
		await draw();
		document.querySelector<HTMLButtonElement>("#settings-tab-ai-subscriptions")!.click();
		await draw();
		expect(status()).toBe("Your ChatGPT plan is connected.");
		expect(confirm).toHaveBeenCalledOnce();
	});

	it("from the company list, goes to the company and opens AI subscriptions once home has moved on", async () => {
		const { signals } = returned(userA.id, `#/c/${profileA.profileId}`);
		await draw();
		await draw();
		expect(location.hash).toBe(chat);
		expect(settingsOpen()).toBe(true);
		expect(document.querySelector("#settings-tab-ai-subscriptions")?.getAttribute("aria-selected")).toBe("true");
		await vi.advanceTimersByTimeAsync(3500);
		await draw();
		expect(signals.map((signal) => signal.aborted)).toEqual([false]);
		expect(status()).toBe("Your ChatGPT plan is connected.");
	});

	it("never finishes a sign-in another account started in this tab", async () => {
		const { confirm } = returned(userB.id);
		await draw();
		await draw();
		await vi.advanceTimersByTimeAsync(3500);
		expect(confirm).not.toHaveBeenCalled();
		expect(sessionStorage.getItem("qorpera.chatgpt-plan-sign-in.v1")).toBeNull();
		expect(settingsOpen()).toBe(false);
	});
});

describe("a ChatGPT plan's first-routine card in the app", () => {
	const notice = {
		schema: "qorpera.member-notification/v1",
		notification_id: id(100),
		profile_id: profileA.profileId,
		kind: "routine_needs_model_account",
		created_at: userA.created_at,
		acknowledged_at: null,
		subject: { staffAgentId: staff.id, routineId: id(61), title: "Morning brief" },
	};
	const planRow = (version: number, on: boolean) => ({
		connection_id: id(85),
		client_connection_id: id(185),
		connection_version: version,
		provider: "openai",
		native_harness: "codex-cli",
		authorization_state: "active",
		max_native_concurrency: 1,
		billing_source: "subscription",
		consent_version: "1",
		consented_at: userA.created_at,
		connection_status: "active",
		sponsor_binding_id: id(86),
		sponsor_version: 1,
		policy: { implementation_status: "supported", enablement_status: "enabled", policy_version: 1 },
		login_kind: "chatgpt_plan",
		allow_autonomous: on,
		routine_offer_shown_at: null,
	});
	const routineRow = {
		routine_id: id(61),
		client_routine_id: id(161),
		version: 1,
		status: "paused",
		pause_reason: "needs_model_account",
		runs_for_user_id: userA.id,
		staff_agent_id: staff.id,
		title: "Morning brief",
		prompt: "Brief me.",
		triggers: [{ id: "agent", kind: "schedule", intervalMinutes: 60, replyPolicy: "silent" }],
		effort: "medium",
		sponsor_binding_id: id(87),
		sponsor_version: 1,
		logical_computer_id: null,
		required_capability: "agent_turn",
		job_type: "agent_turn",
		publication_mode: "automatic",
		review_policy_key: null,
		reviewer_staff_ids: [],
		created_at: userA.created_at,
		updated_at: userA.created_at,
	};
	/** The routine's file: still active, since the platform paused it in the index only (no model account paid). */
	const routinePath = "QorperaOS/agents/nora/routines/morning-brief.md";
	const routineBytes = new TextEncoder().encode(
		writeRoutineFile({
			id: id(161),
			title: "Morning brief",
			status: "active",
			trigger: { when: "every", minutes: 60, starts: null },
			timezone: null,
			ends: null,
			runs: null,
			quiet: null,
			effort: "medium",
			reply: "silent",
			conclusion: null,
			instructions: "Brief me.",
		}),
	);
	/** The file's bytes and manifest as the object gateway keeps them, by hash. */
	let stored: Promise<{ hash: string; manifestHash: string; objects: Map<string, Uint8Array> }> | undefined;
	const objects = () => {
		stored ??= (async () => {
			const hash = await cloudFileBytesSha256(routineBytes);
			const manifest = new TextEncoder().encode(
				JSON.stringify({
					schema: "qorpera.cloud-file-manifest/v2",
					fileSha256: hash,
					bytes: routineBytes.length,
					mediaType: "text/markdown",
					executable: false,
					chunks: [{ sha256: hash, bytes: routineBytes.length }],
				}),
			);
			const manifestHash = await cloudFileBytesSha256(manifest);
			return {
				hash,
				manifestHash,
				objects: new Map([
					[hash, routineBytes],
					[manifestHash, manifest],
				]),
			};
		})();
		return stored;
	};
	/** The member's own waiting routine, a plan that is not turned on, plans on, on a conversation page. */
	function planApp(capabilities = team.capabilities) {
		let connections = [planRow(2, false)];
		const calls: string[] = [];
		const commits: { op: string; path: string; text?: string; expectedVersion?: string }[][] = [];
		const answer = async (method: string, args: Record<string, unknown>): Promise<unknown> => {
			calls.push(method);
			// A routine is its file (P34r): the member finds it in the state folders read and writes it as the member.
			if (method === "qorpera_member_company_state_folders")
				return {
					schema: "qorpera.member-company-state-folders/v1",
					agents: [{ staffAgentId: staff.id, file: "QorperaOS/agents/nora/agent.md" }],
					groups: [],
					routines: [{ routineId: id(61), staffAgentId: staff.id, file: routinePath }],
				};
			if (method === "qorpera_member_folder_read") {
				const { hash, manifestHash } = await objects();
				return {
					schema: "qorpera.folder-read/v1",
					asOfSeq: 3,
					found: true,
					entry: {
						path: routinePath,
						kind: "file",
						version: id(91),
						seq: 3,
						updatedAt: userA.created_at,
						manifestSha256: manifestHash,
						fileSha256: hash,
						bytes: routineBytes.length,
						mediaType: "text/markdown",
						executable: false,
					},
				};
			}
			if (method === "qorpera_list_member_notifications") return [notice];
			if (method === "qorpera_acknowledge_member_notification")
				return { ...notice, acknowledged_at: userA.created_at };
			if (method === "qorpera_chatgpt_plan_available") return true;
			if (method === "qorpera_list_member_native_execution_connections")
				return { compute_identity: null, connections };
			if (method === "qorpera_list_cloud_routines") return [routineRow];
			if (method === "qorpera_record_chatgpt_plan_routine_offer")
				return { connection_id: args.p_connection_id, shown_at: userA.created_at };
			if (method === "qorpera_set_chatgpt_plan_work_while_away") {
				connections = [...connections, planRow(3, true)];
				return { connection_id: args.p_connection_id, version: 3, allow_autonomous: true };
			}
			if (method === "qorpera_create_member_execution_sponsor") return { binding_id: id(88), version: 1 };
			throw new Error(`Unexpected fixture RPC: ${method}`);
		};
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
				const url = new URL(String(input));
				const name = url.pathname.split("/").at(-1)!;
				if (url.pathname.includes("/v1/member-folder-objects/")) {
					const object = (await objects()).objects.get(name);
					if (!object) throw new Error("Unknown fixture object");
					return new Response(Uint8Array.from(object), {
						headers: { "x-qorpera-access-mode": "live-path-authority" },
					});
				}
				if (url.pathname.includes("/v1/member-folder-commits/")) {
					const units = (JSON.parse(String(init?.body)) as { units: (typeof commits)[number] }).units;
					calls.push("member-folder-commit");
					commits.push(units);
					return Response.json({
						schema: "qorpera.folder-commit/v1",
						commitId: id(89),
						seq: 4,
						replay: false,
						units: units.map((unit, index) => ({
							unit: index + 1,
							op: unit.op,
							path: unit.path,
							outcome: "saved",
							version: id(90),
						})),
					});
				}
				return Response.json(
					await answer(name, init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {}),
				);
			}),
		);
		const f = mounted(`#/c/${profileA.profileId}/chat/${session.sessionId}`);
		vi.mocked(f.cloud.rpc).mockImplementation((method: string, args?: Record<string, unknown>) =>
			answer(method, args ?? {}),
		);
		vi.mocked(f.api.listSessions).mockResolvedValue([{ ...session, staffAgentId: staff.id }]);
		vi.mocked(f.api.getTeam).mockResolvedValue({ ...team, capabilities });
		return { ...f, calls, commits };
	}
	const card = () => document.querySelector(".company-notices .company-notice p")?.textContent;
	const openAccountSettings = () => {
		document.querySelector<HTMLButtonElement>(".account-trigger")!.click();
		expect(document.querySelector('[data-account-action="settings"] .account-count')?.textContent).toBe("1");
		document.querySelector<HTMLButtonElement>('[data-account-action="settings"]')!.click();
	};

	it("asks the signed-in member about their own routine in Settings, and an owner's Turn on starts it", async () => {
		const f = planApp();
		await vi.waitFor(() => expect(document.querySelector(".account-health-dot")).not.toBeNull(), { timeout: 3000 });
		expect(card()).toBeUndefined();
		openAccountSettings();
		await vi.waitFor(() => expect(card()).toContain("Morning brief can run while you're away."), { timeout: 3000 });
		expect(f.calls).toContain("qorpera_record_chatgpt_plan_routine_offer");
		document.querySelector<HTMLButtonElement>('[data-action="turn-on-plan"]')!.click();
		await vi.waitFor(() => expect(f.calls).toContain("member-folder-commit"), { timeout: 3000 });
		expect(f.calls).toContain("qorpera_set_chatgpt_plan_work_while_away");
		expect(f.calls).toContain("qorpera_create_member_execution_sponsor");
		expect(f.calls).not.toContain("qorpera_consent_provider_connection_autonomous");
		// The file already says active: saved as it is, it ends the pause the index recorded, paid by the plan.
		expect(f.commits).toEqual([
			[
				{
					op: "write",
					path: routinePath,
					text: new TextDecoder().decode(routineBytes),
					expectedVersion: id(91),
				},
			],
		]);
	});

	it("turns the plan on for a member who does not save routines, and says to ask the agent", async () => {
		const f = planApp({ ...team.capabilities, authorize: false });
		await vi.waitFor(() => expect(document.querySelector(".account-health-dot")).not.toBeNull(), { timeout: 3000 });
		expect(card()).toBeUndefined();
		openAccountSettings();
		await vi.waitFor(() => expect(card()).toContain("Morning brief can run while you're away."), { timeout: 3000 });
		document.querySelector<HTMLButtonElement>('[data-action="turn-on-plan"]')!.click();
		await vi.waitFor(
			() =>
				expect(card()).toBe(
					"Your ChatGPT plan now works while you're away. Ask the agent to set Morning brief up again.",
				),
			{ timeout: 3000 },
		);
		expect(f.calls).not.toContain("member-folder-commit");
	});
});

describe("the rail's line under an idle agent's name in the app", () => {
	it("reads the agents' notes once the roster arrives, also when the team answers first", async () => {
		const routine = {
			routine_id: id(62),
			client_routine_id: id(162),
			version: 1,
			status: "active",
			staff_agent_id: staff.id,
			title: "Morning brief",
			prompt: "Brief me.",
			triggers: [{ id: "agent", kind: "schedule", intervalMinutes: 60, replyPolicy: "silent" }],
			effort: "medium",
			sponsor_binding_id: id(87),
			sponsor_version: 1,
			logical_computer_id: null,
			required_capability: "agent_turn",
			job_type: "agent_turn",
			publication_mode: "automatic",
			review_policy_key: null,
			reviewer_staff_ids: [],
			created_at: userA.created_at,
			updated_at: userA.created_at,
			next_run_at: new Date(Date.now() + 2 * 3_600_000).toISOString(),
		};
		const answer = async (method: string): Promise<unknown> => {
			if (method === "qorpera_member_company_state_folders")
				return {
					schema: "qorpera.member-company-state-folders/v1",
					agents: [{ staffAgentId: staff.id, file: "QorperaOS/agents/nora/agent.md" }],
					groups: [],
					routines: [],
				};
			if (method === "qorpera_member_folder_read")
				return { schema: "qorpera.folder-read/v1", asOfSeq: 1, found: false };
			if (method === "qorpera_list_cloud_routines") return [routine];
			if (method === "qorpera_list_member_notifications") return [];
			throw new Error(`Unexpected fixture RPC: ${method}`);
		};
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request) =>
				Response.json(await answer(new URL(String(input)).pathname.split("/").at(-1)!)),
			),
		);
		history.replaceState(null, "", `/#/c/${profileA.profileId}`);
		const f = fixture();
		f.cloud.config.objectGatewayUrl = "https://objects.fixture.invalid";
		vi.mocked(f.cloud.rpc).mockImplementation((method: string) => answer(method));
		// The team answers at once; the roster later, so the notes first read with no agents.
		const roster = deferred<HostedStaffAgent[]>();
		vi.mocked(f.api.listStaff).mockReturnValue(roster.promise);
		const root = document.createElement("div");
		document.body.append(root);
		dispose = mountApplication(root, f.cloud, f.api);
		await vi.waitFor(
			() =>
				expect(vi.mocked(f.cloud.rpc).mock.calls.some(([method]) => method === "qorpera_list_cloud_routines")).toBe(
					true,
				),
			{ timeout: 3000 },
		);
		roster.resolve([staff]);
		await vi.waitFor(
			() =>
				expect(root.querySelector(`.rail [data-agent-id="${staff.id}"] small`)?.textContent).toMatch(
					/^Next: Morning brief · /,
				),
			{ timeout: 3000 },
		);
	});

	it("opens a company route after a transient listProfiles outage recovers", async () => {
		history.replaceState(null, "", `/#/c/${profileA.profileId}/file`);
		const f = fixture();
		f.cloud.config.publishableKey = "sb_publishable_fixturekey";
		f.cloud.config.objectGatewayUrl = "https://objects.fixture.invalid";
		f.cloud.config.nativeProviderLoginUrl = "https://login.fixture.invalid/";
		let offline = true;
		vi.mocked(f.api.listProfiles).mockImplementation(async () => {
			if (offline) throw new TypeError("Failed to fetch");
			return [profileA];
		});
		const root = document.createElement("div");
		document.body.append(root);
		dispose = mountApplication(root, f.cloud, f.api);
		await draw();
		expect(root.textContent).toContain("Can't reach Qorpera. Trying again…");
		expect(root.textContent).not.toContain("This company is not available to your account.");
		expect(f.api.getTeam).not.toHaveBeenCalled();

		offline = false;
		window.dispatchEvent(new Event("online"));
		await vi.advanceTimersByTimeAsync(5_000);
		await draw();
		expect(f.api.getTeam).toHaveBeenCalledWith(profileA.profileId, expect.any(AbortSignal));
	});

	it("does not loop listProfiles when a company route is genuinely unavailable, and offers retry on non-connection errors", async () => {
		const f = mounted(`#/c/${id(77)}`);
		await draw();
		expect(f.root.querySelector("main")?.textContent).toContain("This company is not available to your account.");
		const callsAfterUnavailable = vi.mocked(f.api.listProfiles).mock.calls.length;
		await vi.advanceTimersByTimeAsync(15_000);
		await draw();
		expect(vi.mocked(f.api.listProfiles).mock.calls.length).toBe(callsAfterUnavailable);
		dispose?.();
		dispose = undefined;

		history.replaceState(null, "", `/#/c/${profileA.profileId}/file`);
		const g = fixture();
		let failList = true;
		vi.mocked(g.api.listProfiles).mockImplementation(async () => {
			if (failList) throw new Error("Database busy");
			return [profileA];
		});
		const root = document.createElement("div");
		document.body.append(root);
		dispose = mountApplication(root, g.cloud, g.api);
		await draw();
		expect(root.textContent).toContain("Database busy");
		expect(root.textContent).not.toContain("Can't reach Qorpera. Trying again…");
		const retry = [...root.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "Try again");
		expect(retry).toBeTruthy();
		const callsBeforeRetry = vi.mocked(g.api.listProfiles).mock.calls.length;
		await vi.advanceTimersByTimeAsync(15_000);
		await draw();
		expect(vi.mocked(g.api.listProfiles).mock.calls.length).toBe(callsBeforeRetry);

		failList = false;
		retry!.click();
		await draw();
		expect(g.api.getTeam).toHaveBeenCalledWith(profileA.profileId, expect.any(AbortSignal));
	});

	it("aborts in-flight listProfiles signal when the hub is disposed", async () => {
		let seen: AbortSignal | undefined;
		const f = fixture();
		vi.mocked(f.api.listProfiles).mockImplementation((signal) => {
			seen = signal;
			return new Promise(() => {});
		});
		const root = document.createElement("div");
		document.body.append(root);
		const stop = mountApplication(root, f.cloud, f.api);
		await draw();
		expect(seen).toBeInstanceOf(AbortSignal);
		expect(seen?.aborted).toBe(false);
		stop();
		expect(seen?.aborted).toBe(true);
	});
});

describe("a new website's first publish in the app", () => {
	const SITE_ID = id(91);
	const ADDRESS_HOST = "thetaband-go-live-test.qorpera.site";
	const siteRow = {
		schema: "qorpera.company-site/v1",
		id: SITE_ID,
		slug: "thetaband",
		title: "Go live test",
		kind: "files",
		url: "https://sites.qorpera.com/thetaband/",
		state: "live",
		source: "code/thetaband",
		files: 1,
		bytes: 10,
		publishedAt: null,
		publishedBy: null,
		createdAt: "2026-11-24T00:00:00Z",
		passwordChangedAt: "2026-11-24T00:00:00Z",
		machine: null,
		port: null,
	};

	async function firstPublish() {
		const hosting = { fails: false };
		surfacesOn();
		let current = surfaceSummary({
			title: "Go live test",
			siteSlug: "thetaband",
			liveUrl: `https://${ADDRESS_HOST}`,
			publishStatus: "publishing",
			activeSessionCount: 1,
			runningSessionCount: 0,
			pendingChangeCount: 0,
		});
		vi.spyOn(CloudSurfacesClient.prototype, "listSurfaces").mockImplementation(async () => [current]);
		vi.spyOn(CloudSurfacesClient.prototype, "getSurfaceWorkspace").mockImplementation(async () =>
			surfaceWorkspace([], { surface: current }),
		);
		let listed: unknown[] = [];
		const f = mounted(`#/c/${profileA.profileId}`);
		vi.mocked(f.cloud.rpc).mockImplementation(async (name: string) => {
			if (name === "qorpera_list_company_sites") return listed;
			if (name === "qorpera_company_site_access") return { schema: "qorpera.company-site-access/v1", sites: [] };
			if (name === "qorpera_company_site_hosting") {
				if (hosting.fails) throw new Error("offline");
				return {
					schema: "qorpera.company-site-hosting/v1",
					hostsDomain: "qorpera.com",
					hostsEnabled: true,
					publicEnabled: true,
					domainsEnabled: true,
					sites: [
						{
							siteId: SITE_ID,
							slug: "thetaband",
							isPublic: false,
							deploymentKind: "static",
							storageMode: "db",
							domains: [],
						},
					],
				};
			}
			throw new Error("Unexpected RPC");
		});
		const count = (name: string) => vi.mocked(f.cloud.rpc).mock.calls.filter(([method]) => method === name).length;
		const line = () =>
			f.root.querySelector('.rail-surface[data-surface-slug="website"] .rail-surface-sub')?.textContent ?? null;
		await draw();
		await draw();
		await draw();
		await vi.advanceTimersByTimeAsync(2_000);
		await draw();
		expect(count("qorpera_list_company_sites")).toBe(1);
		expect(count("qorpera_company_site_hosting")).toBe(0);

		listed = [siteRow];
		current = { ...current, publishStatus: "idle", liveHeadSha: "a1b2c3", activeSessionCount: 0 };
		await vi.advanceTimersByTimeAsync(2_000);
		await draw();
		await draw();
		await vi.advanceTimersByTimeAsync(5_000);
		await draw();
		return { count, line, hosting };
	}

	it("reads the site list and whether the site is public once more when the first publish ends, and the rail says Not live yet", async () => {
		const { count, line } = await firstPublish();
		expect(count("qorpera_list_company_sites")).toBe(2);
		expect(count("qorpera_company_site_hosting")).toBe(1);
		expect(line()).toBe("Not live yet");
	});

	it("forgets whether the site is public when that read fails, and shows the host alone on the rail", async () => {
		const { count, line, hosting } = await firstPublish();
		expect(line()).toBe("Not live yet");
		hosting.fails = true;
		window.dispatchEvent(new Event("focus"));
		await draw();
		await draw();
		expect(count("qorpera_list_company_sites")).toBe(3);
		expect(count("qorpera_company_site_hosting")).toBe(2);
		expect(line()).toBe(ADDRESS_HOST);
	});
});

describe("cold-boot waterfall optimizations", () => {
	it("boots a company route as soon as listProfiles resolves while invitations and founding are still pending", async () => {
		history.replaceState(null, "", `/#/c/${profileA.profileId}/chat/${session.sessionId}`);
		const f = fixture();
		f.cloud.config.publishableKey = "sb_publishable_fixturekey";
		f.cloud.config.objectGatewayUrl = "https://objects.fixture.invalid";
		f.cloud.config.nativeProviderLoginUrl = "https://login.fixture.invalid/";
		const pendingInvites = deferred<Awaited<ReturnType<typeof f.api.listIncomingInvitations>>>();
		const pendingFoundings = deferred<Awaited<ReturnType<typeof f.api.listCompanyFoundings>>>();
		vi.mocked(f.api.listIncomingInvitations).mockReturnValue(pendingInvites.promise);
		vi.mocked(f.api.listCompanyFoundings).mockReturnValue(pendingFoundings.promise);
		const root = document.createElement("div");
		document.body.append(root);
		dispose = mountApplication(root, f.cloud, f.api);
		await draw();
		expect(f.api.getTeam).toHaveBeenCalledWith(profileA.profileId, expect.any(AbortSignal));
		expect(f.api.readSessionEvents).toHaveBeenCalled();
		pendingInvites.resolve([]);
		pendingFoundings.resolve([]);
		await draw();
	});

	it("resolves Co-Founder home as soon as org, team, staff, and sessions load without waiting on sidebar or activity", async () => {
		history.replaceState(null, "", `/#/c/${profileA.profileId}`);
		const f = fixture();
		f.cloud.config.publishableKey = "sb_publishable_fixturekey";
		f.cloud.config.objectGatewayUrl = "https://objects.fixture.invalid";
		f.cloud.config.nativeProviderLoginUrl = "https://login.fixture.invalid/";
		const pendingSidebar = deferred<Awaited<ReturnType<typeof f.api.readCompanySidebar>>>();
		const pendingActivity = deferred<Awaited<ReturnType<typeof f.api.listStaffActivity>>>();
		vi.mocked(f.api.readCompanySidebar).mockReturnValue(pendingSidebar.promise);
		vi.mocked(f.api.listStaffActivity).mockReturnValue(pendingActivity.promise);
		vi.mocked(f.api.getOrganization).mockResolvedValue({
			schema: "qorpera.company-organization/v1",
			profileId: profileA.profileId,
			cofounder: {
				staffAgentId: staff.id,
				formationId: id(199),
				memberSessionId: session.sessionId,
			},
			formation: {
				formationId: id(199),
				state: "operating",
				status: "active",
				revision: 1,
				projectionStatus: "ready",
				sourcePath: "QorperaOS/company/formation.md",
			},
			responsibilities: [],
			projects: [],
		});
		const root = document.createElement("div");
		document.body.append(root);
		dispose = mountApplication(root, f.cloud, f.api);
		await draw();
		expect(location.hash).toBe(`#/c/${profileA.profileId}/chat/${session.sessionId}`);
		pendingSidebar.resolve({ sections: [], placements: {}, pinned: [], hidden: [] });
		pendingActivity.resolve([]);
		await draw();
	});

	it("overlaps auth.start() with localeReady while holding the boot skeleton until locale resolves", async () => {
		history.replaceState(null, "", "/#/");
		const f = fixture();
		const locale = deferred<void>();
		const root = document.createElement("div");
		document.body.append(root);
		dispose = mountApplication(root, f.cloud, f.api, {}, { localeReady: locale.promise });
		await draw();
		expect(f.cloud.supabase.auth.getSession).toHaveBeenCalled();
		expect(f.api.listProfiles).toHaveBeenCalled();
		expect(root.querySelector(".frame")).toBeNull();
		locale.resolve();
		await draw();
		expect(root.querySelector(".frame")).not.toBeNull();
	});

	it("keeps recently visited companies warm across A -> B -> A switches, suspends parked Realtime, and disposes on sign-out", async () => {
		const startSpy = vi.spyOn(CompanyController.prototype, "start");
		const suspendSpy = vi.spyOn(CompanyController.prototype, "suspend");
		const resumeSpy = vi.spyOn(CompanyController.prototype, "resume");
		const stopSpy = vi.spyOn(CompanyController.prototype, "stop");
		const f = mounted(`#/c/${profileA.profileId}/chat/${session.sessionId}`);
		vi.mocked(f.api.listProfiles).mockResolvedValue([profileA, profileB]);
		await draw();
		await draw();
		expect(startSpy).toHaveBeenCalledTimes(1);
		expect(f.root.querySelector(".rail-company-name")?.textContent).toBe(profileA.profileName);

		location.hash = `#/c/${profileB.profileId}/team`;
		await draw();
		await draw();
		expect(suspendSpy).toHaveBeenCalledTimes(1);
		expect(startSpy).toHaveBeenCalledTimes(2);
		expect(f.root.querySelector(".rail-company-name")?.textContent).toBe(profileB.profileName);

		location.hash = `#/c/${profileA.profileId}/chat/${session.sessionId}`;
		await draw();
		expect(f.root.querySelector(".thread-skeleton")).toBeNull();
		expect(resumeSpy).toHaveBeenCalledTimes(1);
		expect(startSpy).toHaveBeenCalledTimes(2);
		expect(f.root.querySelector(".rail-company-name")?.textContent).toBe(profileA.profileName);

		const stopsBeforeSignOut = stopSpy.mock.calls.length;
		f.auth(null);
		await draw();
		expect(stopSpy.mock.calls.length - stopsBeforeSignOut).toBeGreaterThanOrEqual(2);
	});

	it("keeps the app-card MutationObserver disconnected when a company has no legacy apps", async () => {
		const observeSpy = vi.spyOn(MutationObserver.prototype, "observe");
		const f = mounted(`#/c/${profileA.profileId}/chat/${session.sessionId}`);
		await draw();
		await draw();
		const mainEl = f.root.querySelector<HTMLElement>("main")!;
		const mainObserved = observeSpy.mock.calls.some(([target]) => target === mainEl);
		expect(mainObserved).toBe(false);
	});

	it("revives Co-Founder rail figures and refreshes conversation messages after an A -> B -> A warm switch", async () => {
		const disposeFigure = vi.fn();
		const mountFigure = stubFigureMotion(disposeFigure);
		try {
			const cofounder: HostedStaffAgent = { ...staff, templateId: "co-founder", displayName: "Co-Founder" };
			const f = mounted(`#/c/${profileA.profileId}/chat/${session.sessionId}`);
			vi.mocked(f.api.listProfiles).mockResolvedValue([profileA, profileB]);
			vi.mocked(f.api.listStaff).mockResolvedValue([cofounder]);
			vi.mocked(f.api.readSessionEventsTail).mockResolvedValue([event(1, "First message")]);
			let extraMessage = false;
			vi.mocked(f.api.readSessionEvents).mockImplementation(async () =>
				extraMessage ? [event(2, "Message while away")] : [],
			);
			await draw();
			await draw();
			const cofounderFigure = f.root.querySelector<HTMLElement>(".cofounder-home .figure");
			expect(cofounderFigure).not.toBeNull();
			expect(cofounderFigure?.dataset.figureDisposed).toBeUndefined();
			expect(f.root.textContent).toContain("First message");
			const mountsAfterFirst = mountFigure.mock.calls.length;

			location.hash = `#/c/${profileB.profileId}/team`;
			await draw();
			await draw();
			expect(cofounderFigure?.dataset.figureDisposed).toBe("true");
			expect(disposeFigure).toHaveBeenCalled();

			extraMessage = true;
			location.hash = `#/c/${profileA.profileId}/chat/${session.sessionId}`;
			await draw();
			await draw();
			const restoredFigure = f.root.querySelector<HTMLElement>(".cofounder-home .figure");
			expect(restoredFigure).toBe(cofounderFigure);
			expect(restoredFigure?.dataset.figureDisposed).toBeUndefined();
			expect(mountFigure.mock.calls.length).toBeGreaterThan(mountsAfterFirst);
			expect(f.root.textContent).toContain("Message while away");
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("recovers thread and surface loading after an A -> B -> A warm switch interrupts an in-flight thread load", async () => {
		const site = surfaceSummary({
			id: id(801),
			slug: "website",
			title: "Website",
			archetype: "live_build",
			siteSlug: null,
			liveUrl: null,
		});
		vi.spyOn(CloudSurfacesClient.prototype, "isSurfacesEnabled").mockResolvedValue(true);
		vi.spyOn(CloudSurfacesClient.prototype, "listSurfaces").mockResolvedValue([site]);
		vi.spyOn(CloudSurfacesClient.prototype, "getSurfaceWorkspace").mockResolvedValue(
			surfaceWorkspace([], { surface: site }),
		);
		vi.spyOn(CloudSurfacesClient.prototype, "listAutomations").mockResolvedValue([]);
		vi.spyOn(CloudSurfacesClient.prototype, "getMigrationChecklist").mockRejectedValue(
			new CloudRpcError("qorpera_surface_migration_checklist", { code: "PGRST202", message: "missing" }, 404),
		);
		vi.spyOn(CloudSurfacesClient.prototype, "unseenSurfaceNotes").mockResolvedValue([]);

		const f = mounted(`#/c/${profileA.profileId}/chat/${session.sessionId}`);
		vi.mocked(f.api.listProfiles).mockResolvedValue([profileA, profileB]);
		let tailAttempt = 0;
		vi.mocked(f.api.readSessionEventsTail).mockImplementation((_id, _before, _limit, signal) => {
			tailAttempt += 1;
			if (tailAttempt === 1) {
				return new Promise((_resolve, reject) => {
					signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), {
						once: true,
					});
				});
			}
			return Promise.resolve([event(1, "Recovered after warm switch")]);
		});

		await draw();
		await draw();
		expect(tailAttempt).toBe(1);
		expect(f.root.querySelector(".skeleton-messages")).not.toBeNull();

		location.hash = `#/c/${profileB.profileId}/team`;
		await draw();
		await draw();
		expect(f.root.querySelector(".rail-company-name")?.textContent).toBe(profileB.profileName);

		location.hash = `#/c/${profileA.profileId}/chat/${session.sessionId}`;
		await draw();
		await draw();
		expect(f.root.querySelector(".skeleton-messages")).toBeNull();
		expect(f.root.textContent).toContain("Recovered after warm switch");

		location.hash = `#/c/${profileA.profileId}/s/website`;
		await draw();
		await draw();
		expect(f.root.querySelector(".surface-page")).not.toBeNull();
	});

	it("replaces stale thread DOM with a page skeleton when navigating to a surface while SurfacesStore is loading", async () => {
		const enabled = deferred<boolean>();
		const site = surfaceSummary({
			id: id(802),
			slug: "website",
			title: "Website",
			archetype: "live_build",
			siteSlug: null,
			liveUrl: null,
		});
		vi.spyOn(CloudSurfacesClient.prototype, "isSurfacesEnabled").mockReturnValue(enabled.promise);
		vi.spyOn(CloudSurfacesClient.prototype, "listSurfaces").mockResolvedValue([site]);
		vi.spyOn(CloudSurfacesClient.prototype, "getSurfaceWorkspace").mockResolvedValue(
			surfaceWorkspace([], { surface: site }),
		);
		vi.spyOn(CloudSurfacesClient.prototype, "listAutomations").mockResolvedValue([]);
		vi.spyOn(CloudSurfacesClient.prototype, "getMigrationChecklist").mockRejectedValue(
			new CloudRpcError("qorpera_surface_migration_checklist", { code: "PGRST202", message: "missing" }, 404),
		);
		vi.spyOn(CloudSurfacesClient.prototype, "unseenSurfaceNotes").mockResolvedValue([]);

		const f = mounted(`#/c/${profileA.profileId}/chat/${session.sessionId}`);
		await draw();
		await draw();
		expect(f.root.querySelector("main .thread")).not.toBeNull();

		location.hash = `#/c/${profileA.profileId}/s/website`;
		await draw();
		expect(f.root.querySelector("main .thread")).toBeNull();
		expect(f.root.querySelector("main .skeleton-page")).not.toBeNull();

		enabled.resolve(true);
		await draw();
		await draw();
		expect(f.root.querySelector("main .surface-page")).not.toBeNull();
	});

	it("transitions main to a warm surface when switching from another company thread even if reviving one rail figure throws, and skips detached legacy rows", async () => {
		const disposeFigure = vi.fn();
		const mountFigure = stubFigureMotion(disposeFigure);
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			const webApp = surfaceSummary({
				id: id(821),
				slug: "web-app",
				title: "Web App",
				archetype: "live_build",
				siteSlug: null,
				liveUrl: null,
				activeSessionCount: 2,
			});
			const website = surfaceSummary({
				id: id(822),
				slug: "website",
				title: "Website",
				archetype: "live_build",
				siteSlug: null,
				liveUrl: null,
				activeSessionCount: 1,
			});
			const webAppSessions = [
				surfaceSession(["staged"], { id: id(831), surfaceId: webApp.id, title: "Fix nav" }),
				surfaceSession(["staged"], { id: id(832), surfaceId: webApp.id, title: "Polish hero" }),
			];
			const websiteSessions = [
				surfaceSession(["staged"], { id: id(833), surfaceId: website.id, title: "Update footer" }),
			];
			vi.spyOn(CloudSurfacesClient.prototype, "isSurfacesEnabled").mockResolvedValue(true);
			vi.spyOn(CloudSurfacesClient.prototype, "listSurfaces").mockResolvedValue([webApp, website]);
			vi.spyOn(CloudSurfacesClient.prototype, "getSurfaceWorkspace").mockImplementation(async (surfaceId: string) =>
				surfaceId === webApp.id
					? surfaceWorkspace(webAppSessions, { surface: webApp })
					: surfaceWorkspace(websiteSessions, { surface: website }),
			);
			vi.spyOn(CloudSurfacesClient.prototype, "listAutomations").mockResolvedValue([]);
			vi.spyOn(CloudSurfacesClient.prototype, "getMigrationChecklist").mockRejectedValue(
				new CloudRpcError("qorpera_surface_migration_checklist", { code: "PGRST202", message: "missing" }, 404),
			);
			vi.spyOn(CloudSurfacesClient.prototype, "unseenSurfaceNotes").mockResolvedValue([]);

			const cofounderA: HostedStaffAgent = {
				...staff,
				id: id(841),
				templateId: "co-founder",
				displayName: "Co-Founder",
			};
			const workerA: HostedStaffAgent = { ...staff, id: id(842), displayName: "Designer", role: "Design" };
			const sessionB = {
				...session,
				sessionId: id(851),
				profileId: profileB.profileId,
				environmentId: profileB.environmentId,
			};
			const f = mounted(`#/c/${profileA.profileId}/s/web-app`);
			vi.mocked(f.api.listProfiles).mockResolvedValue([profileA, profileB]);
			vi.mocked(f.api.listStaff).mockImplementation(async (envId) =>
				envId === profileA.environmentId ? [cofounderA, workerA] : [{ ...staff, templateId: "co-founder" }],
			);
			vi.mocked(f.api.listSessions).mockImplementation(async (envId) =>
				envId === profileB.environmentId ? [sessionB] : [session],
			);
			vi.mocked(f.api.readSessionEventsTail).mockResolvedValue([event(1, "Brooks thread message")]);

			await draw();
			await draw();
			expect(f.root.querySelector("main .surface-page")).not.toBeNull();
			expect(f.root.querySelector('.rail-surface[data-surface-slug="web-app"]')?.classList.contains("active")).toBe(
				true,
			);
			expect(f.root.querySelectorAll(".rail .rail-row-agent")).toHaveLength(0);
			const railCrewBefore = [...f.root.querySelectorAll<HTMLElement>(".rail-surface .figure")];
			expect(railCrewBefore.length).toBeGreaterThanOrEqual(3);

			location.hash = `#/c/${profileB.profileId}/chat/${sessionB.sessionId}`;
			await draw();
			await draw();
			expect(f.root.querySelector("main .thread")).not.toBeNull();
			expect(f.root.textContent).toContain("Brooks thread message");
			expect(railCrewBefore.every((el) => el.dataset.figureDisposed === "true")).toBe(true);

			let injectedFailure = false;
			mountFigure.mockImplementation((_host, _figureId, _color, _artworkArg, options) => {
				if (!injectedFailure && options?.identity === `surface-session:${webAppSessions[0]!.id}`) {
					injectedFailure = true;
					throw new DOMException(
						"The image argument is a canvas element with a width or height of 0.",
						"InvalidStateError",
					);
				}
				return { dispose: disposeFigure, play: () => {} };
			});

			location.hash = `#/c/${profileA.profileId}/s/web-app`;
			await draw();
			await draw();
			expect(injectedFailure).toBe(true);
			expect(errorSpy).toHaveBeenCalledWith("figure revive failed:", expect.any(DOMException));
			expect(f.root.querySelector("main .thread")).toBeNull();
			expect(f.root.querySelector("main .surface-page")).not.toBeNull();
			expect(f.root.querySelectorAll(".rail [data-figure-disposed]")).toHaveLength(0);
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("keeps Website and Web App loading cleanly when switching back and forth rapidly between warm previews", async () => {
		const website = surfaceSummary({
			id: id(811),
			slug: "website",
			title: "Website",
			archetype: "live_build",
			siteSlug: "stifteren",
			liveUrl: "https://stifteren.qorpera.site",
			pendingChangeCount: 1,
		});
		const webApp = surfaceSummary({
			id: id(812),
			slug: "web-app",
			title: "Web App",
			archetype: "live_build",
			siteSlug: "stifteren-web-app",
			liveUrl: "https://stifteren-web-app.qorpera.site",
			pendingChangeCount: 1,
		});
		let mintCount = 0;
		const mintPreviewPass = vi.fn(async (previewId: string) => {
			mintCount += 1;
			const slug = previewId === PREVIEW_IDS[0] ? "stifteren" : "stifteren-web-app";
			return {
				previewId,
				doorActionUrl: `https://${slug}--p0.qorpera.site/__qorpera/member`,
				memberPass: `${VALID_PASS.slice(0, -1)}${mintCount}`,
			};
		});
		const wsFor = (surface: typeof website, previewId: string) =>
			surfaceWorkspace([surfaceSession(["staged"], { surfaceId: surface.id })], {
				surface,
				previewState: {
					surfaceId: surface.id,
					mode: "single",
					primary: previewFrame({
						previewId,
						doorActionUrl: `https://${surface.siteSlug}--p0.qorpera.site/__qorpera/member`,
						memberPass: null,
					}),
					compareFrames: [],
				},
			});
		vi.spyOn(CloudSurfacesClient.prototype, "isSurfacesEnabled").mockResolvedValue(true);
		vi.spyOn(CloudSurfacesClient.prototype, "listSurfaces").mockResolvedValue([website, webApp]);
		vi.spyOn(CloudSurfacesClient.prototype, "getSurfaceWorkspace").mockImplementation(async (surfaceId: string) =>
			surfaceId === webApp.id ? wsFor(webApp, PREVIEW_IDS[1]) : wsFor(website, PREVIEW_IDS[0]),
		);
		vi.spyOn(CloudSurfacesClient.prototype, "mintPreviewPass").mockImplementation(mintPreviewPass);
		vi.spyOn(CloudSurfacesClient.prototype, "listAutomations").mockResolvedValue([]);
		vi.spyOn(CloudSurfacesClient.prototype, "getMigrationChecklist").mockRejectedValue(
			new CloudRpcError("qorpera_surface_migration_checklist", { code: "PGRST202", message: "missing" }, 404),
		);
		vi.spyOn(CloudSurfacesClient.prototype, "unseenSurfaceNotes").mockResolvedValue([]);

		const f = mounted(`#/c/${profileA.profileId}/s/web-app`);
		vi.mocked(f.cloud.rpc).mockImplementation(async (name: string) => {
			if (name === "qorpera_list_company_sites") return [];
			if (name === "qorpera_company_site_access") return { schema: "qorpera.company-site-access/v1", sites: [] };
			throw new Error(`Unexpected RPC: ${name}`);
		});
		const completeDoor = (iframe: HTMLIFrameElement) => {
			const posted: unknown[] = [];
			vi.spyOn(iframe.contentWindow!, "postMessage").mockImplementation(((message: unknown) => {
				posted.push(message);
			}) as never);
			const ready = new MessageEvent("message", { data: { type: SITE_DOOR_READY }, origin: location.origin });
			Object.defineProperty(ready, "source", { value: iframe.contentWindow });
			window.dispatchEvent(ready);
			const shown = new MessageEvent("message", { data: { type: SITE_DOOR_SHOWN }, origin: location.origin });
			Object.defineProperty(shown, "source", { value: iframe.contentWindow });
			window.dispatchEvent(shown);
			return posted;
		};

		await draw();
		await draw();
		await draw();
		const firstAppFrame = f.root.querySelector<HTMLIFrameElement>("main iframe.surface-frame.is-staging")!;
		expect(firstAppFrame).not.toBeNull();
		expect(completeDoor(firstAppFrame)[0]).toMatchObject({ type: SITE_DOOR_PASS });
		expect(f.root.querySelector("main iframe.surface-frame.is-shown")).toBe(firstAppFrame);

		location.hash = `#/c/${profileA.profileId}/s/website`;
		await draw();
		await draw();
		const firstSiteFrame = f.root.querySelector<HTMLIFrameElement>("main iframe.surface-frame.is-staging")!;
		expect(firstSiteFrame).not.toBeNull();
		expect(firstSiteFrame.title).toBe("Preview of Website");
		const ready = new MessageEvent("message", { data: { type: SITE_DOOR_READY }, origin: location.origin });
		Object.defineProperty(ready, "source", { value: firstSiteFrame.contentWindow });
		vi.spyOn(firstSiteFrame.contentWindow!, "postMessage").mockImplementation(() => {});
		window.dispatchEvent(ready);

		location.hash = `#/c/${profileA.profileId}/s/web-app`;
		await draw();
		location.hash = `#/c/${profileA.profileId}/s/website`;
		await draw();
		location.hash = `#/c/${profileA.profileId}/s/web-app`;
		await draw();
		await draw();
		await draw();

		expect(f.root.querySelector("main iframe.surface-frame.is-shown")).toBeNull();
		const recoveredAppFrame = f.root.querySelector<HTMLIFrameElement>("main iframe.surface-frame.is-staging")!;
		expect(recoveredAppFrame).not.toBeNull();
		expect(recoveredAppFrame).not.toBe(firstAppFrame);
		expect(completeDoor(recoveredAppFrame)[0]).toMatchObject({ type: SITE_DOOR_PASS });
		expect(f.root.querySelector("main iframe.surface-frame.is-shown")).toBe(recoveredAppFrame);

		location.hash = `#/c/${profileA.profileId}/s/website`;
		await draw();
		await draw();
		await draw();
		expect(f.root.querySelector("main iframe.surface-frame.is-shown")).toBeNull();
		const recoveredSiteFrame = f.root.querySelector<HTMLIFrameElement>("main iframe.surface-frame.is-staging")!;
		expect(recoveredSiteFrame).not.toBeNull();
		expect(recoveredSiteFrame).not.toBe(firstSiteFrame);
		expect(completeDoor(recoveredSiteFrame)[0]).toMatchObject({ type: SITE_DOOR_PASS });
		expect(f.root.querySelector("main iframe.surface-frame.is-shown")).toBe(recoveredSiteFrame);
	});

	it("reloads live SiteView surfaces cleanly when switching back and forth rapidly between warm live_build surfaces", async () => {
		const website = surfaceSummary({
			id: id(821),
			slug: "website",
			title: "Website",
			archetype: "live_build",
			siteSlug: "stifteren",
			liveUrl: "https://stifteren.qorpera.site",
			activeSessionCount: 0,
			pendingChangeCount: 0,
		});
		const webApp = surfaceSummary({
			id: id(822),
			slug: "web-app",
			title: "Web App",
			archetype: "live_build",
			siteSlug: "stifteren-web-app",
			liveUrl: "https://stifteren-web-app.qorpera.site",
			activeSessionCount: 0,
			pendingChangeCount: 0,
		});
		const siteRow = (siteId: string, slug: string, title: string) => ({
			schema: "qorpera.company-site/v1",
			id: siteId,
			slug,
			title,
			kind: "files",
			url: `https://${slug}.qorpera.site/`,
			state: "live",
			source: `product/${slug}`,
			files: 4,
			bytes: 512,
			publishedAt: "2026-11-26T10:00:00Z",
			publishedBy: null,
			createdAt: "2026-11-26T09:00:00Z",
			passwordChangedAt: "2026-11-26T09:00:00Z",
			machine: null,
			port: null,
		});
		const websiteSiteId = id(831);
		const webAppSiteId = id(832);
		vi.spyOn(CloudSurfacesClient.prototype, "isSurfacesEnabled").mockResolvedValue(true);
		vi.spyOn(CloudSurfacesClient.prototype, "listSurfaces").mockResolvedValue([website, webApp]);
		vi.spyOn(CloudSurfacesClient.prototype, "getSurfaceWorkspace").mockImplementation(async (surfaceId: string) =>
			surfaceWorkspace([], { surface: surfaceId === webApp.id ? webApp : website }),
		);
		vi.spyOn(CloudSurfacesClient.prototype, "listAutomations").mockResolvedValue([]);
		vi.spyOn(CloudSurfacesClient.prototype, "getMigrationChecklist").mockRejectedValue(
			new CloudRpcError("qorpera_surface_migration_checklist", { code: "PGRST202", message: "missing" }, 404),
		);
		vi.spyOn(CloudSurfacesClient.prototype, "unseenSurfaceNotes").mockResolvedValue([]);

		let passSeq = 0;
		const f = mounted(`#/c/${profileA.profileId}/s/web-app`);
		vi.mocked(f.cloud.rpc).mockImplementation(async (name: string, args?: Record<string, unknown>) => {
			if (name === "qorpera_list_company_sites") {
				return [
					siteRow(websiteSiteId, "stifteren", "Website"),
					siteRow(webAppSiteId, "stifteren-web-app", "Web App"),
				];
			}
			if (name === "qorpera_company_site_access") return { schema: "qorpera.company-site-access/v1", sites: [] };
			if (name === "qorpera_company_site_hosting") {
				return {
					schema: "qorpera.company-site-hosting/v1",
					hostsDomain: "qorpera.site",
					hostsEnabled: true,
					publicEnabled: true,
					domainsEnabled: true,
					sites: [],
				};
			}
			if (name === "qorpera_site_member_pass") {
				passSeq += 1;
				const slug = args?.p_site === webAppSiteId ? "stifteren-web-app" : "stifteren";
				return {
					schema: "qorpera.site-member-pass/v1",
					state: "open",
					host: `${slug}.qorpera.site`,
					pass: `${VALID_PASS.slice(0, -1)}${passSeq}`,
					expiresAt: "2026-11-27T10:01:00Z",
					action: `https://${slug}.qorpera.site/__qorpera/member`,
				};
			}
			throw new Error(`Unexpected RPC: ${name}`);
		});
		const completeSiteDoor = () => {
			const iframe = f.root.querySelector<HTMLIFrameElement>("main iframe.site-frame")!;
			expect(iframe).not.toBeNull();
			const posted: unknown[] = [];
			vi.spyOn(iframe.contentWindow!, "postMessage").mockImplementation(((message: unknown) => {
				posted.push(message);
			}) as never);
			const ready = new MessageEvent("message", { data: { type: SITE_DOOR_READY }, origin: location.origin });
			Object.defineProperty(ready, "source", { value: iframe.contentWindow });
			window.dispatchEvent(ready);
			const shown = new MessageEvent("message", { data: { type: SITE_DOOR_SHOWN }, origin: location.origin });
			Object.defineProperty(shown, "source", { value: iframe.contentWindow });
			window.dispatchEvent(shown);
			return posted;
		};

		await draw();
		await draw();
		await draw();
		expect(completeSiteDoor()[0]).toMatchObject({ type: SITE_DOOR_PASS });
		expect(f.root.querySelector("main .site-glass")?.classList.contains("is-shown")).toBe(true);

		location.hash = `#/c/${profileA.profileId}/s/website`;
		await draw();
		location.hash = `#/c/${profileA.profileId}/s/web-app`;
		await draw();
		location.hash = `#/c/${profileA.profileId}/s/website`;
		await draw();
		await draw();
		await draw();

		expect(f.root.querySelector("main .site-glass")?.classList.contains("is-shown")).toBe(false);
		expect(completeSiteDoor()[0]).toMatchObject({ type: SITE_DOOR_PASS });
		expect(f.root.querySelector("main .site-glass")?.classList.contains("is-shown")).toBe(true);

		location.hash = `#/c/${profileA.profileId}/s/web-app`;
		await draw();
		await draw();
		await draw();

		expect(f.root.querySelector("main .site-glass")?.classList.contains("is-shown")).toBe(false);
		expect(completeSiteDoor()[0]).toMatchObject({ type: SITE_DOOR_PASS });
		expect(f.root.querySelector("main .site-glass")?.classList.contains("is-shown")).toBe(true);
	});

	it("keeps the target company alive when switching back to the oldest warm company across 4 companies and leaves the company selector working", async () => {
		const profileC: HostedProfile = {
			...profileA,
			profileId: id(901),
			environmentId: id(902),
			profileName: "Company C",
		};
		const profileD: HostedProfile = {
			...profileA,
			profileId: id(903),
			environmentId: id(904),
			profileName: "Dekura",
		};
		const siteA = surfaceSummary({
			id: id(911),
			slug: "website",
			title: "Company A Website",
			archetype: "live_build",
			siteSlug: "company-a",
			liveUrl: null,
			activeSessionCount: 1,
		});
		const moneyA = surfaceSummary({
			id: id(912),
			slug: "money",
			title: "Company A Money",
			archetype: "live_build",
			siteSlug: "company-a-money",
			liveUrl: null,
			activeSessionCount: 1,
		});
		const siteB = surfaceSummary({
			id: id(913),
			slug: "website",
			title: "Company B Website",
			archetype: "live_build",
			siteSlug: "company-b",
			liveUrl: null,
		});
		const siteC = surfaceSummary({
			id: id(914),
			slug: "website",
			title: "Company C Website",
			archetype: "live_build",
			siteSlug: "company-c",
			liveUrl: null,
		});
		const siteD = surfaceSummary({
			id: id(915),
			slug: "website",
			title: "Dekura Website",
			archetype: "live_build",
			siteSlug: "dekura",
			liveUrl: null,
			activeSessionCount: 1,
		});
		const dekuraSession = surfaceSession(["staged"], {
			id: id(921),
			surfaceId: siteD.id,
			title: "Dekura Website Directions",
		});
		const moneyASession = surfaceSession(["staged"], {
			id: id(922),
			surfaceId: moneyA.id,
			title: "Company A Money Review",
		});
		const siteASession = surfaceSession(["staged"], {
			id: id(923),
			surfaceId: siteA.id,
			title: "Company A Site Update",
		});

		vi.spyOn(CloudSurfacesClient.prototype, "isSurfacesEnabled").mockResolvedValue(true);
		vi.spyOn(CloudSurfacesClient.prototype, "listSurfaces").mockImplementation(async (companyId: string) => {
			if (companyId === profileA.profileId) return [siteA, moneyA];
			if (companyId === profileB.profileId) return [siteB];
			if (companyId === profileC.profileId) return [siteC];
			if (companyId === profileD.profileId) return [siteD];
			return [];
		});
		vi.spyOn(CloudSurfacesClient.prototype, "getSurfaceWorkspace").mockImplementation(async (surfaceId: string) => {
			if (surfaceId === siteA.id) return surfaceWorkspace([siteASession], { surface: siteA });
			if (surfaceId === moneyA.id) return surfaceWorkspace([moneyASession], { surface: moneyA });
			if (surfaceId === siteD.id) return surfaceWorkspace([dekuraSession], { surface: siteD });
			if (surfaceId === siteB.id) return surfaceWorkspace([], { surface: siteB });
			return surfaceWorkspace([], { surface: siteC });
		});
		vi.spyOn(CloudSurfacesClient.prototype, "listAutomations").mockResolvedValue([]);
		vi.spyOn(CloudSurfacesClient.prototype, "getMigrationChecklist").mockRejectedValue(
			new CloudRpcError("qorpera_surface_migration_checklist", { code: "PGRST202", message: "missing" }, 404),
		);
		vi.spyOn(CloudSurfacesClient.prototype, "unseenSurfaceNotes").mockResolvedValue([]);

		const f = mounted(`#/c/${profileA.profileId}/s/website`);
		vi.mocked(f.api.listProfiles).mockResolvedValue([profileA, profileB, profileC, profileD]);
		vi.mocked(f.cloud.rpc).mockImplementation(async (name: string) => {
			if (name === "qorpera_list_company_sites") return [];
			if (name === "qorpera_company_site_access") return { schema: "qorpera.company-site-access/v1", sites: [] };
			throw new Error(`Unexpected RPC: ${name}`);
		});

		for (const nextHash of [
			undefined,
			`#/c/${profileB.profileId}/s/website`,
			`#/c/${profileC.profileId}/s/website`,
			`#/c/${profileD.profileId}/s/website`,
		]) {
			if (nextHash) location.hash = nextHash;
			await draw();
			await draw();
			await draw();
		}
		expect(f.root.querySelector(".rail-company-name")?.textContent).toBe("Dekura");
		expect(f.root.querySelector("main")?.textContent).toContain("Dekura Website Directions");

		location.hash = `#/c/${profileA.profileId}/s/website`;
		await draw();
		await draw();
		await draw();

		expect(f.root.querySelector(".rail-company-name")?.textContent).toBe(profileA.profileName);
		expect(f.root.querySelector("main")?.textContent).toContain("Company A Site Update");
		expect(f.root.querySelector("main")?.textContent).not.toContain("Dekura Website Directions");

		const moneyLink = f.root.querySelector<HTMLAnchorElement>('.rail-surface[data-surface-slug="money"]')!;
		expect(moneyLink).not.toBeNull();
		moneyLink.click();
		await draw();
		await draw();
		await draw();

		expect(location.hash).toBe(`#/c/${profileA.profileId}/s/money`);
		expect(f.root.querySelector('.rail-surface[data-surface-slug="money"]')?.classList.contains("active")).toBe(true);
		expect(f.root.querySelector("main")?.textContent).toContain("Company A Money Review");
		expect(f.root.querySelector("main")?.textContent).not.toContain("Dekura Website Directions");

		const companyButton = f.root.querySelector<HTMLButtonElement>(".rail-company")!;
		companyButton.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
		companyButton.click();
		const menu = document.querySelector<HTMLElement>('.context-menu[role="menu"]');
		expect(menu).not.toBeNull();
		expect(menu?.textContent).toContain("Dekura");
		expect(menu?.textContent).toContain("Company B");
		expect(menu?.textContent).toContain("Company C");
	});

	it("restarts an in-flight SurfacesStore load when rapidly switching away from and back to a warm company", async () => {
		const firstEnabled = deferred<boolean>();
		let enabledAttempt = 0;
		const siteA = surfaceSummary({
			id: id(931),
			slug: "website",
			title: "Website",
			archetype: "live_build",
			siteSlug: null,
			liveUrl: null,
		});
		vi.spyOn(CloudSurfacesClient.prototype, "isSurfacesEnabled").mockImplementation(() => {
			enabledAttempt += 1;
			if (enabledAttempt === 1) return firstEnabled.promise;
			return Promise.resolve(true);
		});
		vi.spyOn(CloudSurfacesClient.prototype, "listSurfaces").mockResolvedValue([siteA]);
		vi.spyOn(CloudSurfacesClient.prototype, "getSurfaceWorkspace").mockResolvedValue(
			surfaceWorkspace([], { surface: siteA }),
		);
		vi.spyOn(CloudSurfacesClient.prototype, "listAutomations").mockResolvedValue([]);
		vi.spyOn(CloudSurfacesClient.prototype, "getMigrationChecklist").mockRejectedValue(
			new CloudRpcError("qorpera_surface_migration_checklist", { code: "PGRST202", message: "missing" }, 404),
		);
		vi.spyOn(CloudSurfacesClient.prototype, "unseenSurfaceNotes").mockResolvedValue([]);

		const f = mounted(`#/c/${profileA.profileId}/s/website`);
		vi.mocked(f.api.listProfiles).mockResolvedValue([profileA, profileB]);
		await draw();
		await draw();
		expect(enabledAttempt).toBe(1);

		location.hash = `#/c/${profileB.profileId}/team`;
		await draw();
		await draw();

		location.hash = `#/c/${profileA.profileId}/s/website`;
		await draw();
		firstEnabled.reject(new DOMException("Aborted", "AbortError"));
		await draw();
		await draw();

		expect(enabledAttempt).toBeGreaterThanOrEqual(2);
		expect(f.root.querySelector("main .surface-page")).not.toBeNull();
		expect(f.root.querySelector('.rail-surface[data-surface-slug="website"]')).not.toBeNull();
	});

	it("filters company database names for app linking", () => {
		expect(linkedCompanyDatabaseNames(undefined)).toBeUndefined();
		expect(linkedCompanyDatabaseNames(null)).toBeUndefined();
		expect(
			linkedCompanyDatabaseNames({
				databases: [
					{ database: "studio" },
					{ database: "qorpera" },
					{ database: "pg_catalog" },
					{ database: "qorpera_internal" },
					{ database: "orders_v2" },
				],
			}),
		).toEqual(["studio", "orders_v2"]);
	});
});
