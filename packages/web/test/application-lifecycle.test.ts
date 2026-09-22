// @vitest-environment jsdom
import { createHash, webcrypto } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mountApplication } from "../src/app/application.ts";
import { AuthController } from "../src/app/auth.ts";
import { CompanyController } from "../src/app/company.ts";
import { HubController } from "../src/app/views/hub.ts";
import { renderRail } from "../src/app/views/shell.ts";
import { CloudRpcError } from "../src/cloud/client.ts";
import type { HostedCompanyOrganization } from "../src/cloud/organization.ts";
import type { AgentThreadHandle } from "../src/cloud/parse.ts";
import type { HostedAccountEntitlement, HostedProfile } from "../src/cloud/types.ts";
import { deferred, fixture, id, profileA, profileB, session, settle, staff, team, userA, userB } from "./fixtures.ts";

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
		location.hash = `#/c/${profileA.profileId}/file/history`;
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
	it.each([true, false])("waits for organization loading before resolving home (seeded: %s)", async (seeded) => {
		const home = `#/c/${profileA.profileId}`;
		const f = mounted(home);
		const loading = deferred<HostedCompanyOrganization | undefined>();
		vi.mocked(f.api.getOrganization).mockReturnValue(loading.promise);
		await draw();
		expect(f.api.listStaff).toHaveBeenCalled();
		expect(location.hash).toBe(home);
		expect(f.root.querySelector("main")?.textContent).toContain("Opening company");
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
		expect(f.root.querySelector("main")?.textContent).toContain("Opening company");
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
		expect(f.root.querySelector("main")?.textContent).toContain("Opening company");
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
		expect(root.textContent).toContain("Appearance");
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
		expect(f.root.querySelector("main")?.textContent).toContain("Appearance");
	});

	it("initializes Company File once while its response is delayed", async () => {
		const f = mounted(`#/c/${profileA.profileId}/file/history`);
		const loading = deferred<Awaited<ReturnType<typeof f.api.getCompanyFile>>>();
		vi.mocked(f.api.getCompanyFile).mockReturnValue(loading.promise);
		await draw();
		await vi.advanceTimersByTimeAsync(180);
		expect(f.api.getCompanyFile).toHaveBeenCalledTimes(1);
	});

	it("toggles and closes company navigation without replacing the composer", async () => {
		const f = mounted(`#/c/${profileA.profileId}/chat/${session.sessionId}`);
		await draw();
		const composer = f.root.querySelector("textarea");
		f.root.querySelector<HTMLButtonElement>("main .mobile-navigation-toggle")!.click();
		await draw();
		expect(f.root.querySelector(".frame")?.classList.contains("navigation-open")).toBe(true);
		window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
		await draw();
		expect(f.root.querySelector(".frame")?.classList.contains("navigation-open")).toBe(false);
		expect(document.activeElement).toBe(f.root.querySelector("main .mobile-navigation-toggle"));
		expect(f.root.querySelector("textarea")).toBe(composer);
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
		await draw();
		f.root.querySelector<HTMLButtonElement>("main .mobile-navigation-toggle")!.click();
		await draw();
		expect(f.root.querySelector("main")?.inert).toBe(true);
		vi.mocked(f.api.getTeam).mockRejectedValue(
			new CloudRpcError("getTeam", { code: "42501", message: "Access revoked" }),
		);
		f.hints.get("qorpera_profile_access_state")!();
		await draw();
		expect(f.root.querySelector("main")?.textContent).toContain("Your access to this company was revoked");
		expect(f.root.querySelector("main")?.inert).toBe(false);
		expect(f.root.querySelector(".frame")?.classList.contains("navigation-open")).toBe(false);
		expect(f.root.querySelector(".topbar .account-trigger")).not.toBeNull();
		expect(f.root.querySelector(".account-company-name")).toBeNull();
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
		const create = vi.spyOn(f.api, "createCompany").mockRejectedValue(new Error("Response lost"));
		let hub = new HubController(f.api, userA.id);
		await hub.createCompany("One company");
		hub.dispose();
		hub = new HubController(f.api, userA.id);
		expect(hub.store.get().creationRetry?.name).toBe("One company");
		await hub.createCompany("One company");
		expect(create.mock.calls[0]?.[0]).toBe(create.mock.calls[1]?.[0]);
		expect(new HubController(f.api, userB.id).store.get().creationRetry).toBeUndefined();
		hub.dispose();
	});
});
