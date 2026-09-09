// @vitest-environment jsdom
import type { CompanyComputerAccessStatus } from "@qorpera/cloud-client/cloud-company-computer-access";
import type {
	MemberBrowserGrantStatus,
	MemberBrowserProfileCatalog,
} from "@qorpera/cloud-client/cloud-company-computer-browser-profiles";
import type { CompanyComputerPrivacyChallenge } from "@qorpera/cloud-client/cloud-company-computer-privacy";
import type { CloudCompanyComputerPrivacyStatus } from "@qorpera/cloud-client/cloud-company-computer-sign-in";
import type {
	CompanyComputerMemberStatus,
	CompanyComputerMemberView,
} from "@qorpera/cloud-client/cloud-company-computer-views";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ComputerAccessPanel } from "../src/app/views/computer-access.ts";
import { ComputerBrowserPanel } from "../src/app/views/computer-browser.ts";
import { WebCompanyComputer } from "../src/cloud/computer.ts";
import { ComputerViewHost } from "../src/ui/computer-view-host.ts";
import * as viewer from "../src/ui/computer-viewer.ts";
import { deferred, fixture, id, profileA, settle, staff, userA } from "./fixtures.ts";

const scope = {
	companyId: profileA.profileId,
	environmentId: profileA.environmentId,
	companyComputerId: id(30),
	logicalComputerId: id(31),
};
const binding = {
	...scope,
	computerGeneration: 1,
	screenId: id(32),
	screenGeneration: 1,
	screenOrdinal: 1,
	staffAgentId: staff.id,
};
const challenge: CompanyComputerPrivacyChallenge = {
	scope,
	computerGeneration: 1,
	challengeId: id(40),
	version: 1,
	state: "entering",
	memberId: userA.id,
	profileId: id(33),
	profileVersion: 1,
	screenId: binding.screenId,
	drains: [{ binding, drainId: id(41), epoch: 1, state: "draining" }],
};
const cleanup: (() => void)[] = [];
beforeEach(() => {
	vi.useFakeTimers();
});
afterEach(() => {
	for (const dispose of cleanup.splice(0)) dispose();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.useRealTimers();
	document.body.replaceChildren();
});
async function settled() {
	await settle();
	await settle();
	await settle();
}
function button(root: ParentNode, label: string): HTMLButtonElement {
	const value = [...root.querySelectorAll("button")].find((button) => button.textContent === label);
	if (!value) throw new Error(`Missing ${label}: ${root.textContent}`);
	return value;
}
function setup() {
	const f = fixture(),
		stop = new AbortController();
	f.cloud.config.officeViewerOrigin = "wss://viewer.example.invalid";
	const state: {
		privacy: CloudCompanyComputerPrivacyStatus;
		screens: CompanyComputerMemberStatus;
		profiles: MemberBrowserProfileCatalog;
		grant: MemberBrowserGrantStatus["grant"];
		access: CompanyComputerAccessStatus;
		fail?: string;
	} = {
		privacy: { scope, computerGeneration: 1, state: "shared", version: 0, challenge: null },
		screens: {
			scope,
			computerGeneration: 1,
			state: "active",
			privacyState: "shared",
			privacyVersion: 0,
			screens: [{ binding, epoch: 0, driver: "idle", drainPending: false, takeoverMemberId: null }],
			viewers: [],
		},
		profiles: {
			scope,
			memberId: userA.id,
			canUse: true,
			profiles: [
				{ profileId: id(33), label: "Work browser", version: 1, prepared: false, activeStaffAgentId: null },
			],
			nextAfter: null,
		},
		grant: null,
		access: { schema: "qorpera.office-access-status/v1", scope, staffAgentId: staff.id, grant: null },
	};
	const calls: { method: string; args: Record<string, unknown> }[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: string, init: RequestInit) => {
			const method = input.split("/").at(-1)!,
				args = JSON.parse(init.body as string) as Record<string, unknown>;
			calls.push({ method, args });
			if (state.fail === method) {
				state.fail = undefined;
				throw new Error("Response lost");
			}
			let result: unknown;
			switch (method) {
				case "qorpera_runtime_office_member_status":
					result = state.screens;
					break;
				case "qorpera_runtime_office_privacy_status":
					result = state.privacy;
					break;
				case "qorpera_member_browser_profiles":
					result = state.profiles;
					break;
				case "qorpera_member_browser_grant_status":
					result = {
						scope,
						memberId: userA.id,
						staffAgentId: args.p_staff_agent_id,
						profile: state.profiles.profiles[0],
						grant: state.grant,
					};
					break;
				case "qorpera_runtime_office_access_status":
					result = state.access;
					break;
				case "qorpera_configure_runtime_office_access":
					state.access.grant = {
						grantId: id(50),
						version: Number(args.p_expected_version) + 1,
						state: args.p_enabled ? "active" : "revoked",
						capabilities: args.p_capabilities as NonNullable<
							CompanyComputerAccessStatus["grant"]
						>["capabilities"],
					};
					result = state.access;
					break;
				case "qorpera_set_runtime_browser_grant":
					state.grant = {
						grantId: id(51),
						version: Number(args.p_expected_version) + 1,
						state: args.p_enabled ? "active" : "revoked",
						profileVersion: Number(args.p_profile_version),
						usable: args.p_enabled === true,
					};
					result = {
						profileId: args.p_profile_id,
						grantId: id(51),
						version: state.grant.version,
						state: state.grant.state,
						drains: [],
					};
					break;
				case "qorpera_request_runtime_office_privacy": {
					const next = {
						...challenge,
						state: args.p_private ? ("entering" as const) : ("leaving" as const),
						version: Number(args.p_expected_version) + 1,
					};
					state.privacy = { ...state.privacy, state: next.state, version: next.version, challenge: next };
					state.screens = { ...state.screens, privacyState: next.state, privacyVersion: next.version };
					result = next;
					break;
				}
				case "qorpera_check_runtime_office_private_access":
					result = { state: "authorized", version: state.privacy.version, validForMs: 5000 };
					break;
				case "qorpera_create_member_browser_profile":
					result = {
						profileId: args.p_profile_id,
						label: args.p_label,
						version: 1,
						prepared: false,
						activeStaffAgentId: null,
					};
					break;
				default:
					throw new Error(`Unexpected RPC ${method}`);
			}
			return Response.json(result);
		}),
	);
	const computer = new WebCompanyComputer(f.cloud, profileA, userA.id, stop.signal, () => {}),
		host = new ComputerViewHost(stop.signal);
	cleanup.push(() => stop.abort());
	const browser = () => {
		const panel = new ComputerBrowserPanel(computer, scope, staff, host, stop.signal);
		document.body.append(panel.el);
		cleanup.push(() => panel.dispose());
		return panel;
	};
	return { ...f, state, calls, computer, host, stop, browser };
}

describe("staff computer permissions", () => {
	it("uses observed versions and selected capabilities, independently of browser consent", async () => {
		const f = setup(),
			panel = new ComputerAccessPanel(f.computer.client.access(scope, staff.id), staff.displayName, f.stop.signal);
		cleanup.push(() => panel.dispose());
		await settled();
		expect(button(panel.el, "Save computer permissions").disabled).toBe(true);
		const desktop = panel.el.querySelector<HTMLInputElement>('[aria-label="Allow desktop interaction"]')!;
		desktop.checked = true;
		desktop.dispatchEvent(new Event("change"));
		button(panel.el, "Save computer permissions").click();
		await settled();
		expect(f.calls.filter((call) => call.method === "qorpera_configure_runtime_office_access")).toEqual([
			{
				method: "qorpera_configure_runtime_office_access",
				args: {
					p_scope: scope,
					p_staff_agent_id: staff.id,
					p_expected_version: 0,
					p_enabled: true,
					p_capabilities: ["desktop"],
				},
			},
		]);
		button(panel.el, "Revoke computer access").click();
		await settled();
		expect(
			f.calls.filter((call) => call.method === "qorpera_configure_runtime_office_access")[1]?.args,
		).toMatchObject({ p_expected_version: 1, p_enabled: false, p_capabilities: ["desktop"] });
		expect(f.calls.some((call) => call.method.includes("browser"))).toBe(false);
	});
	it("requires a refresh after a lost permission response and never replays it", async () => {
		const f = setup();
		f.state.access.grant = { grantId: id(50), version: 7, state: "active", capabilities: ["shell"] };
		const panel = new ComputerAccessPanel(
			f.computer.client.access(scope, staff.id),
			staff.displayName,
			f.stop.signal,
		);
		cleanup.push(() => panel.dispose());
		await settled();
		f.state.fail = "qorpera_configure_runtime_office_access";
		const revoke = button(panel.el, "Revoke computer access");
		revoke.click();
		revoke.click();
		await settled();
		expect(panel.el.textContent).toContain("Refresh before");
		button(panel.el, "Refresh permissions").click();
		await settled();
		expect(f.calls.filter((call) => call.method === "qorpera_configure_runtime_office_access")).toHaveLength(1);
	});
});

describe("private browser preparation and consent", () => {
	it("rejects browser metadata for another member before exposing it", async () => {
		const f = setup();
		f.state.profiles.memberId = id(99);
		f.state.profiles.profiles[0]!.label = "Another member's private browser";
		const panel = f.browser();
		await settled();
		expect(panel.el.textContent).toContain("could not be confirmed");
		expect(panel.el.textContent).not.toContain("Another member's private browser");
		expect(f.calls.some((call) => call.method === "qorpera_member_browser_grant_status")).toBe(false);
	});
	it("does not submit consent from controls whose selected profile changed", async () => {
		const f = setup();
		f.state.profiles.profiles[0]!.prepared = true;
		const panel = f.browser();
		await settled();
		panel.el.querySelector<HTMLSelectElement>('[aria-label="Your browser profile"]')!.value = "";
		button(panel.el, "Allow browser access").click();
		await settled();
		expect(f.calls.some((call) => call.method === "qorpera_set_runtime_browser_grant")).toBe(false);
		expect(panel.el.textContent).toContain("Refresh before");
	});
	it("lets the owner revoke consent from a previously assigned agent", async () => {
		const f = setup();
		f.state.profiles.profiles[0]!.prepared = true;
		f.state.profiles.profiles[0]!.activeStaffAgentId = id(70);
		f.state.grant = { grantId: id(51), version: 4, state: "active", profileVersion: 1, usable: true };
		const panel = f.browser();
		await settled();
		expect(panel.el.querySelector<HTMLSelectElement>('[aria-label="Agent browser consent"]')!.value).toBe(id(70));
		button(panel.el, "Revoke browser access").click();
		await settled();
		expect(f.calls.find((call) => call.method === "qorpera_set_runtime_browser_grant")?.args).toMatchObject({
			p_staff_agent_id: id(70),
			p_expected_version: 4,
			p_enabled: false,
		});
	});
	it("does not grant browser access until preparation finishes and the member explicitly allows it", async () => {
		const f = setup(),
			panel = f.browser();
		await settled();
		expect(button(panel.el, "Allow browser access").disabled).toBe(true);
		expect(panel.el.querySelector('input[type="password"]')).toBeNull();
		f.state.profiles.profiles[0]!.prepared = true;
		button(panel.el, "Refresh browsers").click();
		await settled();
		expect(f.calls.some((call) => call.method === "qorpera_set_runtime_browser_grant")).toBe(false);
		button(panel.el, "Allow browser access").click();
		await settled();
		expect(f.calls.find((call) => call.method === "qorpera_set_runtime_browser_grant")?.args).toMatchObject({
			p_profile_id: id(33),
			p_profile_version: 1,
			p_staff_agent_id: staff.id,
			p_expected_version: 0,
			p_enabled: true,
		});
		expect(f.calls.some((call) => call.method === "qorpera_configure_runtime_office_access")).toBe(false);
	});
	it("waits for physical privacy acknowledgement and rechecks ownership before private input", async () => {
		const f = setup(),
			views = f.computer.views(scope),
			connection = {
				connectionId: id(60),
				binding,
				mode: "control" as const,
				close: vi.fn(async () => {}),
				channel: {
					readyState: 1,
					protocol: "",
					binaryType: "arraybuffer",
					onopen: null,
					onclose: null,
					onerror: null,
					onmessage: null,
					send() {},
					close() {},
				},
			};
		const connectPrivate = vi.spyOn(views, "connectPrivate").mockResolvedValue(connection),
			connectScreen = vi.spyOn(views, "connectScreen");
		vi.spyOn(f.computer, "views").mockReturnValue(views);
		const open = vi.spyOn(viewer, "openComputerViewer").mockReturnValue({ close: vi.fn(async () => {}) });
		const panel = f.browser();
		await settled();
		button(panel.el, "Sign in privately on screen 1").click();
		await settled();
		expect(panel.el.textContent).toContain("Wait for the computer to confirm privacy");
		expect(open).not.toHaveBeenCalled();
		expect(
			[...panel.el.querySelectorAll("button")].some((button) => button.textContent === "Open your private browser"),
		).toBe(false);
		f.state.privacy.state = "private";
		f.state.screens.privacyState = "private";
		await vi.advanceTimersByTimeAsync(1500);
		await settled();
		button(panel.el, "Open your private browser").click();
		await settled();
		const options = open.mock.calls[0]![0];
		expect(options.privateSignIn).toBe(true);
		expect(options.canControl).toBe(false);
		await options.requestConnection({ binding, mode: "control", signal: new AbortController().signal });
		expect(f.calls.some((call) => call.method === "qorpera_check_runtime_office_private_access")).toBe(true);
		expect(connectPrivate).toHaveBeenCalledWith(expect.objectContaining({ challenge }));
		expect(connectScreen).not.toHaveBeenCalled();
		await f.host.close();
		expect(f.state.privacy.state).toBe("private");
		expect(f.calls.filter((call) => call.method === "qorpera_request_runtime_office_privacy")).toHaveLength(1);
		button(panel.el, "Finish private sign-in").click();
		await settled();
		await vi.waitFor(() => expect(button(panel.el, "Allow browser access").disabled).toBe(true));
		expect(f.calls.filter((call) => call.method === "qorpera_request_runtime_office_privacy")[1]?.args).toMatchObject(
			{ p_private: false, p_expected_version: 1 },
		);
		expect(button(panel.el, "Allow browser access").disabled).toBe(true);
	});
	it("does not replay ambiguous privacy intent or make a grant after disposal", async () => {
		const f = setup(),
			panel = f.browser();
		await settled();
		f.state.fail = "qorpera_request_runtime_office_privacy";
		button(panel.el, "Sign in privately on screen 1").click();
		await settled();
		button(panel.el, "Refresh browsers").click();
		await settled();
		expect(f.calls.filter((call) => call.method === "qorpera_request_runtime_office_privacy")).toHaveLength(1);
		panel.dispose();
		await vi.advanceTimersByTimeAsync(5000);
		expect(f.calls.some((call) => call.method === "qorpera_set_runtime_browser_grant")).toBe(false);
	});
	it("retains a failed profile registration ID for an explicit retry", async () => {
		const f = setup(),
			panel = f.browser();
		await settled();
		panel.el.querySelector<HTMLInputElement>('[aria-label="New browser profile name"]')!.value = "Another browser";
		f.state.fail = "qorpera_create_member_browser_profile";
		button(panel.el, "Create browser profile").click();
		await settled();
		button(panel.el, "Refresh browsers").click();
		await settled();
		button(panel.el, "Retry creation of Another browser").click();
		await settled();
		const requests = f.calls.filter((call) => call.method === "qorpera_create_member_browser_profile");
		expect(requests).toHaveLength(2);
		expect(requests[0]?.args).toEqual(requests[1]?.args);
	});
});

describe("viewer presentation races", () => {
	it("cancels an opening viewer before attachment and refuses parallel opens", async () => {
		const f = setup(),
			open = vi.spyOn(viewer, "openComputerViewer").mockReturnValue({ close: vi.fn(async () => {}) });
		const options = {
			binding,
			title: "Computer",
			canControl: false,
			requestConnection: vi.fn<viewer.ComputerViewerOptions["requestConnection"]>(),
		};
		const pending = f.host.open(options);
		const second = f.host.open(options);
		await f.host.close();
		await expect(pending).rejects.toThrow("Viewer closed");
		await expect(second).rejects.toThrow("already opening");
		expect(open).not.toHaveBeenCalled();
	});
	it("releases a late connection after the viewer closes", async () => {
		const f = setup(),
			pending = deferred<CompanyComputerMemberView>(),
			open = vi.spyOn(viewer, "openComputerViewer").mockReturnValue({ close: vi.fn(async () => {}) });
		await f.host.open({ binding, title: "Computer", canControl: false, requestConnection: () => pending.promise });
		const request = open.mock.calls[0]![0].requestConnection({
			binding,
			mode: "watch",
			signal: new AbortController().signal,
		});
		await f.host.close();
		const close = vi.fn(async () => {});
		pending.resolve({
			connectionId: id(60),
			binding,
			mode: "watch",
			close,
			channel: {
				readyState: 1,
				protocol: "",
				binaryType: "arraybuffer",
				onopen: null,
				onclose: null,
				onerror: null,
				onmessage: null,
				send() {},
				close() {},
			},
		});
		await expect(request).rejects.toThrow("Viewer closed");
		expect(close).toHaveBeenCalledOnce();
	});
});
