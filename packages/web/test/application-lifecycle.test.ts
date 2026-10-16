// @vitest-environment jsdom
import { createHash, webcrypto } from "node:crypto";
import { cloudFileBytesSha256 } from "@qorpera/cloud-client/cloud-file-bytes";
import { writeRoutineFile } from "@qorpera/cloud-client/company-state-files";
import { interfaceLibraryFiles } from "@qorpera/cloud-client/interface-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mountApplication } from "../src/app/application.ts";
import { AuthController } from "../src/app/auth.ts";
import { CompanyController } from "../src/app/company.ts";
import { HubController, renderHub } from "../src/app/views/hub.ts";
import { renderRail } from "../src/app/views/shell.ts";
import { CloudRpcError } from "../src/cloud/client.ts";
import { WebCompanyFiles } from "../src/cloud/company-files.ts";
import type { HostedCompanyOrganization } from "../src/cloud/organization.ts";
import type { AgentThreadHandle } from "../src/cloud/parse.ts";
import type { HostedAccountEntitlement, HostedProfile } from "../src/cloud/types.ts";
import {
	deferred,
	fixture,
	id,
	placeholderLabel,
	profileA,
	profileB,
	session,
	settle,
	staff,
	team,
	userA,
	userB,
	visibleText,
} from "./fixtures.ts";
import { folderFake } from "./folder-fake.ts";

let dispose: (() => void) | undefined;
beforeEach(() => {
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
	it("keeps a new compose send authorized when an older compose finishes loading its transcript", async () => {
		const f = mounted(`#/c/${profileA.profileId}/new`);
		vi.mocked(f.api.listSessions).mockResolvedValue([{ ...session, staffAgentId: staff.id }]);
		const send = executionTransport();
		const events = deferred<Awaited<ReturnType<typeof f.api.readSessionEvents>>>();
		vi.mocked(f.api.readSessionEvents).mockReturnValueOnce(events.promise);
		await draw();
		const submit = (text: string) => {
			f.root.querySelector<HTMLElement>(`[data-choice="${staff.id}"]`)!.click();
			const input = f.root.querySelector("textarea")!;
			input.value = text;
			input.dispatchEvent(new Event("input"));
			f.root.querySelector<HTMLButtonElement>('[aria-label="Send message"]')!.click();
		};
		submit("First accepted message");
		await draw();
		await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
		await draw();
		expect(f.api.readSessionEvents).toHaveBeenCalledTimes(1);
		expect(location.hash).toBe(`#/c/${profileA.profileId}/new`);

		// Leave the accepted send waiting for its transcript and start another
		// compose for the same session, so session identity cannot distinguish them.
		location.hash = `#/c/${profileA.profileId}/file`;
		await draw();
		location.hash = `#/c/${profileA.profileId}/new`;
		await draw();
		const original = await f.cloud.supabase.auth.getSession();
		const token = deferred<typeof original>();
		vi.mocked(f.cloud.supabase.auth.getSession).mockResolvedValueOnce(original).mockReturnValueOnce(token.promise);
		submit("Second message");
		await draw();
		expect(send).toHaveBeenCalledTimes(1);
		events.resolve([]);
		await draw();
		expect(location.hash).toBe(`#/c/${profileA.profileId}/new`);
		token.resolve(original);
		await draw();
		await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
		await draw();
		expect(location.hash).toBe(`#/c/${profileA.profileId}/chat/${session.sessionId}`);
		expect(f.root.querySelector("textarea")!.value).toBe("");
		expect(f.root.textContent).toContain("Second message");
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
		// A click first checks the account again, then writes. Token reads are
		// held back only once that check has read the accounts, so it is the
		// write that waits on the token when the change happens. The usage
		// refresh also reads the accounts; it is over before the click.
		const calls = (method: string) =>
			vi.mocked(fetch).mock.calls.filter(([input]) => String(input).endsWith(`/${method}`)).length;
		const accountReads = () => calls("qorpera_list_member_native_execution_connections");
		const selections = calls("qorpera_select_member_session_account");
		const checked = accountReads() + 1;
		const getSession = vi.mocked(f.cloud.supabase.auth.getSession);
		const current = getSession.getMockImplementation()!;
		const original = await getSession();
		const token = deferred<typeof original>();
		let holding = true;
		let held = 0;
		getSession.mockImplementation(() => {
			if (!holding || accountReads() < checked) return current();
			held++;
			return token.promise;
		});
		button.click();
		for (let turn = 0; turn < 10 && !held; turn++) await settle();
		expect(held).toBe(1);
		expect(calls("qorpera_select_member_session_account")).toBe(selections + 1);
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

	it("loads entitlement and friends afresh for the new account", async () => {
		const { api, auth, root } = mounted("#/account");
		await draw();
		expect(root.textContent).toContain("Account A private plan");
		const entitlement: HostedAccountEntitlement = {
			planKey: "Account B plan",
			billingMode: "fixture",
			featureSet: "fixture",
			storageAllocation: "fixture",
			source: "fixture",
		};
		vi.mocked(api.getAccountEntitlement).mockResolvedValue(entitlement);
		vi.mocked(api.listProfiles).mockResolvedValue([profileB]);
		auth(userB);
		await draw();
		expect(root.textContent).toContain("Account B plan");
		expect(root.textContent).not.toContain("Account A private plan");
		expect(api.listFriends).not.toHaveBeenCalled();
		const openFriends = () => {
			root.querySelector<HTMLButtonElement>(".account-trigger")!.click();
			root.querySelector<HTMLButtonElement>('[data-account-action="friends"]')!.click();
		};
		openFriends();
		await draw();
		expect(api.listFriends).toHaveBeenCalledTimes(1);
		expect(root.querySelector("#settings-tab-friends")?.getAttribute("aria-selected")).toBe("true");
		auth(userA);
		await draw();
		expect(root.querySelector(".settings-overlay")).toBeNull();
		openFriends();
		await draw();
		expect(api.listFriends).toHaveBeenCalledTimes(2);
	});

	it("opens the account page back from Stripe, thanks the member once and reads the plan again", async () => {
		history.replaceState(null, "", "/#/account?checkout=done");
		const f = fixture();
		const offers = vi.spyOn(f.api, "listComputerHourOffers").mockResolvedValue([]);
		const plan = vi.spyOn(f.api, "getMyComputerPlan").mockResolvedValue({ mode: "dry_run", plan: null, hours: null });
		const root = document.createElement("div");
		document.body.append(root);
		dispose = mountApplication(root, f.cloud, f.api);
		await draw();
		// The return is read and removed before routing: the account page, not the hub.
		expect(location.hash).toBe("#/account");
		expect(root.textContent).toContain("Account A private plan");
		const thanks = "Thank you. Your hours are added as soon as Stripe confirms the payment.";
		expect(root.querySelector(".notice-ok")?.textContent).toBe(thanks);
		expect(offers).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(5000);
		await draw();
		expect(plan).toHaveBeenCalledTimes(2);
		// Leaving the page takes the notice with it; the next visit reads afresh.
		location.hash = "#/";
		await draw();
		location.hash = "#/account";
		await draw();
		expect(root.textContent).toContain("Account A private plan");
		expect(root.textContent).not.toContain(thanks);
		// Once on arrival, once in the refresh, once on the new visit.
		expect(offers).toHaveBeenCalledTimes(3);
	});

	it("keeps a return from Stripe for the member who paid, not the next one", async () => {
		const thanks = "Thank you. Your hours are added as soon as Stripe confirms the payment.";
		const { api, auth, root } = mounted("#/?checkout=done");
		vi.spyOn(api, "listComputerHourOffers").mockResolvedValue([]);
		vi.spyOn(api, "getMyComputerPlan").mockResolvedValue({ mode: "dry_run", plan: null, hours: null });
		await draw();
		expect(location.hash).toBe("#/");
		vi.mocked(api.listProfiles).mockResolvedValue([profileB]);
		auth(userB);
		await draw();
		location.hash = "#/account";
		await draw();
		expect(root.textContent).toContain("Plan & usage");
		expect(root.textContent).not.toContain(thanks);
	});

	it.each(["#/friends", "#/invitations"])("sends the retired %s page to the company hub", async (hash) => {
		const f = mounted(hash);
		await draw();
		expect(f.root.querySelector(".company-card[href]")?.textContent).toContain(profileA.profileName);
		expect(f.root.querySelector(".settings-overlay")).toBeNull();
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

	it("toggles and closes company navigation without replacing the composer", async () => {
		const f = mounted(`#/c/${profileA.profileId}/chat/${session.sessionId}`);
		await draw();
		const composer = f.root.querySelector("textarea");
		f.root.querySelector<HTMLButtonElement>("main .mobile-navigation-toggle")!.click();
		await draw();
		expect(f.root.querySelector(".frame")?.classList.contains("navigation-open")).toBe(true);
		// The drawer opens on its chosen tab, never on the folded search field.
		expect(document.activeElement).toBe(f.root.querySelector(".rail [role='tab'][aria-selected='true']"));
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

	it("reopens the drawer on the search field while a query keeps it open over the tabs", async () => {
		const f = mounted(`#/c/${profileA.profileId}/chat/${session.sessionId}`);
		await draw();
		const toggle = () => f.root.querySelector<HTMLButtonElement>("main .mobile-navigation-toggle")!;
		toggle().click();
		await draw();
		f.root.querySelector<HTMLButtonElement>(".rail .rail-search-toggle")!.click();
		const input = f.root.querySelector<HTMLInputElement>(".rail .rail-search input")!;
		input.value = "Fixture";
		input.dispatchEvent(new Event("input"));
		await draw();
		// The tabs are inert under the open field, so the drawer comes back to the field.
		window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
		await draw();
		expect(f.root.querySelector(".frame")?.classList.contains("navigation-open")).toBe(false);
		toggle().click();
		await draw();
		expect(document.activeElement).toBe(input);
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
		expect(f.root.querySelector('.account-popover a[href$="/team"]')).toBeNull();
		f.root.querySelector<HTMLButtonElement>('[data-account-action="settings"]')!.click();
		f.root.querySelector<HTMLButtonElement>("#settings-tab-company")!.click();
		await draw();
		expect(f.root.querySelector(".settings-dialog")?.textContent).toContain("Delete company");
		f.root.querySelector<HTMLButtonElement>(".settings-close")!.click();
		f.root.querySelector<HTMLButtonElement>(".rail .account-trigger")!.click();
		f.root.querySelector<HTMLButtonElement>('.account-popover [data-account-action="friends"]')!.click();
		await draw();
		expect(f.api.listFriends).toHaveBeenCalledTimes(2);
		expect(f.root.querySelector("#settings-tab-friends")?.getAttribute("aria-selected")).toBe("true");
		expect(location.hash).toBe(`#/c/${profileA.profileId}/chat/${session.sessionId}`);
		f.root.querySelector<HTMLButtonElement>(".settings-close")!.click();
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
		f.root.querySelector<HTMLButtonElement>(".thread-computer:not([hidden])")!.click();
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

	it("opens the company's folder as the Company File, and draws it again when the member's role changes", async () => {
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
		vi.spyOn(WebCompanyFiles.prototype, "folderHints").mockReturnValue({ close: async () => {} } as never);
		const f = mounted(`#/c/${profileA.profileId}/file`);
		await draw();
		const page = f.root.querySelector("main .folder-page");
		expect(page?.querySelector(".files-row .files-name")?.textContent).toBe("notes");
		vi.mocked(f.api.getTeam).mockResolvedValue({
			...team,
			role: "viewer",
			capabilities: { ...team.capabilities, write: false, authorize: false },
		});
		f.hints.get("qorpera_profile_access_state")!();
		await draw();
		await draw();
		const again = f.root.querySelector("main .folder-page");
		expect(again?.querySelector(".files-row .files-name")?.textContent).toBe("notes");
		expect(again).not.toBe(page);
		expect(page?.isConnected).toBe(false);
		expect(list).toHaveBeenCalledTimes(2);
		expect(f.api.getCompanyFile).not.toHaveBeenCalled();
	});

	it("reads the offers again each time the company's folder changes, and stops once the member signs out", async () => {
		const fake = folderFake({ seed: [] });
		let next = 500;
		for (const [path, text] of Object.entries(interfaceLibraryFiles(() => id(++next)))) fake.put(path, text);
		const hints: ((seq: number) => void)[] = [];
		vi.spyOn(WebCompanyFiles.prototype, "folder").mockReturnValue(fake.folder as never);
		vi.spyOn(WebCompanyFiles.prototype, "folderHints").mockImplementation((onHint) => {
			hints.push(onHint);
			return { close: async () => {} } as never;
		});
		const f = mounted(`#/c/${profileA.profileId}`);
		await draw();
		// The fixture's cloud answers no RPC, so each read fails and the reader keeps what it had; the calls are counted.
		const reads = () =>
			vi.mocked(f.cloud.rpc).mock.calls.filter(([name]) => name === "qorpera_member_interface_offers").length;
		const opened = reads();
		expect(opened).toBeGreaterThan(0);
		expect(hints).toHaveLength(1);
		fake.put("interfaces/order.md", fake.text("interfaces/order.md")!);
		hints[0]!(fake.seq);
		await vi.advanceTimersByTimeAsync(1000);
		await draw();
		expect(reads()).toBeGreaterThan(opened);
		const changed = reads();
		f.auth(null);
		await draw();
		fake.put("interfaces/order.md", fake.text("interfaces/order.md")!);
		hints[0]!(fake.seq);
		await vi.advanceTimersByTimeAsync(120_000);
		await draw();
		expect(reads()).toBe(changed);
	});

	it("says why the Company File cannot open when membership could not be read", async () => {
		const f = mounted(`#/c/${profileA.profileId}/file`);
		vi.mocked(f.api.getTeam).mockRejectedValue(new Error("Membership unavailable"));
		await draw();
		const main = f.root.querySelector("main")!;
		expect(main.querySelector(".skeleton")).toBeNull();
		expect(main.textContent).toContain("Membership unavailable");
		vi.mocked(f.api.getTeam).mockResolvedValue(team);
		const calls = vi.mocked(f.api.getTeam).mock.calls.length;
		[...main.querySelectorAll("button")].find((button) => button.textContent === "Retry company")!.click();
		await draw();
		expect(vi.mocked(f.api.getTeam).mock.calls.length).toBe(calls + 1);
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

	it("keeps rail searches bound to the current company and current route", () => {
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
		};
		renderRail(rail, a, { ...context, route: { name: "company", profileId: profileA.profileId, section: "file" } });
		renderRail(rail, b, { ...context, route: { name: "company", profileId: profileB.profileId, section: "file" } });
		renderRail(rail, b, { ...context, route: { name: "company", profileId: profileB.profileId, section: "team" } });
		const search = rail.querySelector("input")!;
		search.value = "Fixture";
		search.dispatchEvent(new Event("input"));
		expect(rail.querySelector(".account-trigger")?.textContent).toContain("Account A");
		expect(rail.textContent).not.toContain("Company A PRIVATE");
		expect(rail.querySelector('a[href$="/team"]')).toBeNull();
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

	it("goes back to the page the sign-in began on and finishes it in My connections", async () => {
		const { confirm, signals } = returned();
		await draw();
		await draw();
		expect(location.hash).toBe(chat);
		expect(sessionStorage.getItem("qorpera.chatgpt-plan-sign-in.v1")).toBeNull();
		expect(settingsOpen()).toBe(true);
		expect(document.querySelector("#settings-tab-my-connections")?.getAttribute("aria-selected")).toBe("true");
		expect(status()).toBe("Finishing your ChatGPT sign-in…");
		await vi.advanceTimersByTimeAsync(3500);
		await draw();
		expect(confirm).toHaveBeenCalledOnce();
		expect(signals.map((signal) => signal.aborted)).toEqual([false]);
		expect(status()).toBe("Your ChatGPT plan is connected.");
	});

	it("finishes it while Settings is closed, and My connections shows the outcome when it opens", async () => {
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
		document.querySelector<HTMLButtonElement>("#settings-tab-my-connections")!.click();
		await draw();
		expect(status()).toBe("Your ChatGPT plan is connected.");
		expect(confirm).toHaveBeenCalledOnce();
	});

	it("from the company list, goes to the company and opens My connections once home has moved on", async () => {
		const { signals } = returned(userA.id, `#/c/${profileA.profileId}`);
		await draw();
		await draw();
		expect(location.hash).toBe(chat);
		expect(settingsOpen()).toBe(true);
		expect(document.querySelector("#settings-tab-my-connections")?.getAttribute("aria-selected")).toBe("true");
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
	const routinePath = "agents/nora/routines/morning-brief.md";
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
					agents: [{ staffAgentId: staff.id, file: "agents/nora/agent.md" }],
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

	it("asks the signed-in member about their own routine, and an owner's Turn on starts it", async () => {
		const f = planApp();
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
