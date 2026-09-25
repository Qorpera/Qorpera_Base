// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mountApplication } from "../src/app/application.ts";
import { FoundingController } from "../src/app/founding.ts";
import { parseRoute } from "../src/app/router.ts";
import { renderFounding } from "../src/app/views/founding.ts";
import { HubController } from "../src/app/views/hub.ts";
import { type CompanyFounding, CompanyFoundingApi, parseCompanyFounding } from "../src/cloud/company-founding.ts";
import { deferred, fixture, id, profileA, profileB, settle, userA, userB } from "./fixtures.ts";

const disposals: (() => void)[] = [];
beforeEach(() => {
	vi.useFakeTimers();
	sessionStorage.clear();
	history.replaceState(null, "", "/#/");
});
afterEach(() => {
	for (const dispose of disposals.splice(0)) dispose();
	document.body.replaceChildren();
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

function founding(): CompanyFounding {
	return {
		schema: "qorpera.company-founding/v1",
		profileId: profileA.profileId,
		environmentId: profileA.environmentId,
		companyName: "Shared company",
		description: "Build a coffee company",
		phase: "open",
		revision: 2,
		bootstrapState: "completed",
		computerUsageOwnerUserId: userA.id,
		seats: [userA, userB].map((user) => ({
			userId: user.id,
			displayName: String(user.user_metadata.full_name),
			email: user.email!,
			state: "joined",
			roleDescription: "",
			readyRevision: null,
			modelAccountReady: true,
			computerPoolEnabled: false,
		})),
		computerUsage: { canStart: true },
		launch: null,
		canManage: true,
	};
}

function setup(userId = userA.id) {
	const f = fixture();
	const data = founding();
	vi.mocked(f.cloud.rpc).mockResolvedValue(data);
	vi.mocked(f.api.readCompanyFounding).mockImplementation((profileId) =>
		new CompanyFoundingApi(f.cloud).read(profileId),
	);
	const controller = new FoundingController(f.api, profileA.profileId, userId, () => {});
	disposals.push(() => controller.dispose());
	return { ...f, data, controller };
}

describe("company founding wire authority", () => {
	it("rejects another company's response, malformed Ready flags and duplicate seats", async () => {
		const f = setup();
		const api = new CompanyFoundingApi(f.cloud);
		vi.mocked(f.cloud.rpc).mockResolvedValue({ ...f.data, profileId: profileB.profileId });
		await expect(api.read(profileA.profileId)).rejects.toThrow("identity");
		expect(() =>
			parseCompanyFounding({ ...f.data, seats: [{ ...f.data.seats[0], modelAccountReady: "true" }] }),
		).toThrow();
		expect(() => parseCompanyFounding({ ...f.data, seats: [f.data.seats[0], f.data.seats[0]] })).toThrow("duplicate");
	});
	it("retains legacy launched companies without a synthetic launch receipt", () => {
		expect(
			parseCompanyFounding({ ...founding(), phase: "launched", revision: 0, seats: [], launch: null }).phase,
		).toBe("launched");
	});
	it("accepts a decline receipt without requiring membership to read the company", async () => {
		const f = setup();
		vi.mocked(f.cloud.rpc).mockResolvedValue({ state: "declined", profileId: profileA.profileId });
		await expect(new CompanyFoundingApi(f.cloud).respond(profileA.profileId, false)).resolves.toBeUndefined();
	});
});

describe("shared founding lifecycle", () => {
	it("accepts Computer Usage responsibility for the current member and refreshes the invalidated Ready revision", async () => {
		const f = setup(userB.id);
		await f.controller.refresh();
		vi.mocked(f.cloud.rpc).mockImplementation(async (method) =>
			method === "qorpera_accept_computer_usage_ownership"
				? { profile_id: profileA.profileId, computer_usage_owner_user_id: userB.id }
				: { ...f.data, revision: 3, computerUsageOwnerUserId: userB.id },
		);
		await f.controller.acceptComputerUsageOwnership();
		expect(f.cloud.rpc).toHaveBeenCalledWith("qorpera_accept_computer_usage_ownership", {
			p_profile_id: profileA.profileId,
			p_expected_owner_user_id: userA.id,
		});
		expect(f.controller.store.get().data).toMatchObject({ revision: 3, computerUsageOwnerUserId: userB.id });
	});
	it("leaves a prospective seat without trying to read a company membership it no longer holds", async () => {
		const f = setup(userB.id);
		await f.controller.refresh();
		vi.mocked(f.cloud.rpc).mockClear().mockResolvedValue({ state: "left", profileId: profileA.profileId });
		await f.controller.leave();
		expect(f.cloud.rpc).toHaveBeenCalledExactlyOnceWith("qorpera_remove_company_founder", {
			p_profile_id: profileA.profileId,
			p_expected_revision: 2,
			p_user_id: userB.id,
		});
		expect(f.controller.store.get().left).toBe(true);
	});
	it("does not let an older read undo an accepted roster or description change", async () => {
		const f = setup();
		await f.controller.refresh();
		const oldRead = deferred<unknown>();
		vi.mocked(f.cloud.rpc).mockImplementation(async (method) =>
			method === "qorpera_read_company_founding"
				? oldRead.promise
				: { ...f.data, revision: 3, description: "Updated vision" },
		);
		const reading = f.controller.refresh();
		await f.controller.update(f.data.companyName, "Updated vision");
		oldRead.resolve(f.data);
		await reading;
		expect(f.controller.store.get().data).toMatchObject({ revision: 3, description: "Updated vision" });
	});
	it("records the member's computer contribution separately before Ready, with no provider account mutation", async () => {
		const f = setup();
		await f.controller.refresh();
		vi.mocked(f.cloud.rpc).mockClear();
		await f.controller.ready(true, "Build the product", false);
		expect(vi.mocked(f.cloud.rpc).mock.calls).toEqual([
			["qorpera_set_company_computer_pool", { p_profile_id: profileA.profileId, p_enabled: false }],
			[
				"qorpera_set_founder_ready",
				{
					p_profile_id: profileA.profileId,
					p_expected_revision: 2,
					p_ready: true,
					p_role_description: "Build the product",
				},
			],
		]);
	});
	it("two founders converge through the shared read, and a roster revision invalidates the displayed readiness", async () => {
		const f = setup();
		let server = f.data;
		vi.mocked(f.cloud.rpc).mockImplementation(async (method, args) => {
			if (method === "qorpera_set_founder_ready")
				server = {
					...server,
					seats: server.seats.map((seat) =>
						seat.userId === userA.id ? { ...seat, readyRevision: args?.p_expected_revision as number } : seat,
					),
				};
			return structuredClone(server);
		});
		const other = new FoundingController(f.api, profileA.profileId, userB.id, () => {});
		disposals.push(() => other.dispose());
		await Promise.all([f.controller.refresh(), other.refresh()]);
		await f.controller.ready(true, "", true);
		await other.refresh();
		expect(other.store.get().data?.seats[0]?.readyRevision).toBe(2);
		server = { ...server, revision: 3 };
		await other.refresh();
		const container = document.createElement("div");
		renderFounding(other, container, { connectModel() {}, addFriend() {}, openUsage() {}, openCompany() {} });
		expect(container.querySelectorAll(".badge")[0]?.textContent).toBe("Not ready");
		expect(
			[...container.querySelectorAll("button")].find((button) => button.textContent === "Start company")?.disabled,
		).toBe(true);
	});
	it("replays the same launch id and revision after an ambiguous response and reload", async () => {
		const f = setup();
		vi.mocked(f.cloud.rpc).mockImplementation(async (method) => {
			if (method === "qorpera_launch_company_founding") throw new Error("Response lost");
			return f.data;
		});
		await f.controller.refresh();
		await f.controller.launch();
		f.controller.dispose();
		const resumed = new FoundingController(f.api, profileA.profileId, userA.id, () => {});
		disposals.push(() => resumed.dispose());
		await resumed.refresh();
		await resumed.launch();
		const attempts = vi
			.mocked(f.cloud.rpc)
			.mock.calls.filter(([method]) => method === "qorpera_launch_company_founding");
		expect(attempts).toHaveLength(2);
		expect(attempts[0]?.[1]).toEqual(attempts[1]?.[1]);
		expect(resumed.store.get().launchPending).toBe(true);
	});
	it("recovers a committed launch through readback instead of queueing another kickoff", async () => {
		const f = setup();
		await f.controller.refresh();
		vi.mocked(f.cloud.rpc).mockImplementation(async (method) => {
			if (method === "qorpera_launch_company_founding") throw new Error("Response lost");
			return {
				...f.data,
				phase: "launched",
				launch: {
					receiptId: id(51),
					revision: 2,
					launchedByUserId: userA.id,
					launchedAt: "2026-09-25T12:00:00Z",
					kickoffInputId: id(52),
					turnRequestId: id(53),
				},
			};
		});
		await f.controller.launch();
		expect(f.controller.store.get()).toMatchObject({
			data: { phase: "launched" },
			launchPending: false,
			error: undefined,
		});
		expect(
			vi.mocked(f.cloud.rpc).mock.calls.filter(([method]) => method === "qorpera_launch_company_founding"),
		).toHaveLength(1);
	});
	it("never sends Ready after the company lifetime ends during contribution consent", async () => {
		const f = setup();
		await f.controller.refresh();
		const saving = deferred<unknown>();
		vi.mocked(f.cloud.rpc).mockImplementation(async () => saving.promise);
		const ready = f.controller.ready(true, "", true);
		f.controller.dispose();
		saving.resolve(null);
		await ready;
		expect(vi.mocked(f.cloud.rpc).mock.calls.some(([method]) => method === "qorpera_set_founder_ready")).toBe(false);
	});
	it("refreshes open founding on focus and stops polling after disposal", async () => {
		const f = setup();
		await f.controller.refresh();
		vi.mocked(f.cloud.rpc).mockClear();
		window.dispatchEvent(new Event("focus"));
		await settle();
		expect(f.cloud.rpc).toHaveBeenCalledOnce();
		f.controller.dispose();
		await vi.advanceTimersByTimeAsync(10000);
		expect(f.cloud.rpc).toHaveBeenCalledOnce();
	});
});

describe("founding entrance and own setup", () => {
	it("lets a joined co-founder start without company-management permission", async () => {
		const f = setup(userB.id);
		const data = { ...f.data, canManage: false, seats: f.data.seats.map((seat) => ({ ...seat, readyRevision: 2 })) };
		vi.mocked(f.cloud.rpc).mockResolvedValue(data);
		await f.controller.refresh();
		const container = document.createElement("div");
		renderFounding(f.controller, container, { connectModel() {}, addFriend() {}, openUsage() {}, openCompany() {} });
		const start = [...container.querySelectorAll("button")].find((button) => button.textContent === "Start company");
		expect(start?.disabled).toBe(false);
		expect(container.textContent).not.toContain("Save company details");
		expect(container.textContent).not.toContain("Invite co-founder");
		start?.click();
		await settle();
		expect(f.cloud.rpc).toHaveBeenCalledWith(
			"qorpera_launch_company_founding",
			expect.objectContaining({ p_profile_id: profileA.profileId, p_expected_revision: 2 }),
		);
	});
	it("explains unavailable checkout without telling founders to buy an unavailable plan", async () => {
		const f = setup();
		vi.mocked(f.cloud.rpc).mockResolvedValue({
			...f.data,
			computerUsage: { canStart: false, checkoutAvailable: false },
		});
		await f.controller.refresh();
		const container = document.createElement("div");
		const actions = { connectModel() {}, addFriend() {}, openUsage() {}, openCompany() {} };
		renderFounding(f.controller, container, actions);
		expect(container.textContent).toContain("Subscription checkout is not available yet.");
		expect(container.textContent).not.toContain("Add an eligible computer subscription");
		f.controller.store.set({ data: { ...f.data, computerUsage: { canStart: false, checkoutAvailable: true } } });
		renderFounding(f.controller, container, actions);
		expect(container.textContent).toContain("Add an eligible computer subscription");
	});
	it("holds an existing company URL at setup until its authoritative founding state is read", async () => {
		const f = fixture();
		vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
		vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("No network in this fixture")));
		history.replaceState(null, "", `/#/c/${profileA.profileId}`);
		const read = deferred<CompanyFounding>();
		vi.mocked(f.api.readCompanyFounding).mockReturnValue(read.promise);
		const thread = vi.spyOn(f.api, "agentThread");
		const root = document.createElement("div");
		document.body.append(root);
		disposals.push(mountApplication(root, f.cloud, f.api));
		await settle();
		await vi.advanceTimersByTimeAsync(60);
		expect(root.textContent).toContain("Opening company setup");
		expect(thread).not.toHaveBeenCalled();
		read.resolve(founding());
		await settle();
		await vi.advanceTimersByTimeAsync(100);
		expect(parseRoute(location.hash)).toEqual({
			name: "company",
			profileId: profileA.profileId,
			section: "founding",
		});
		expect(root.textContent).toContain("Computer Usage owner");
		expect(thread).not.toHaveBeenCalled();
	});
	it("creates through the held founding RPC and opens the lobby", async () => {
		const f = setup();
		const hub = new HubController(f.api, userA.id);
		disposals.push(() => hub.dispose());
		vi.mocked(f.cloud.rpc).mockImplementation(async (method) => {
			if (method === "qorpera_list_company_founding_invitations") return [];
			return {
				profile_id: profileA.profileId,
				environment_id: profileA.environmentId,
				profile_name: profileA.profileName,
				environment_name: profileA.environmentName,
				role: "owner",
				contract_version: 2,
				created_at: profileA.createdAt,
				bootstrap_state: "completed",
			};
		});
		await hub.createCompany("Shared company");
		expect(f.cloud.rpc).toHaveBeenCalledWith(
			"qorpera_begin_company_founding",
			expect.objectContaining({ p_company_name: "Shared company", p_contract_version: 2 }),
		);
		expect(parseRoute(location.hash)).toEqual({
			name: "company",
			profileId: profileA.profileId,
			section: "founding",
		});
	});
	it("requires the member's own model account while allowing Ready without contributing computer usage", async () => {
		const f = setup();
		await f.controller.refresh();
		const container = document.createElement("div");
		const actions = { connectModel: vi.fn(), addFriend() {}, openUsage() {}, openCompany() {} };
		renderFounding(f.controller, container, actions);
		expect(container.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked).toBe(false);
		expect(
			[...container.querySelectorAll("button")].find((button) => button.textContent === "I'm Ready")?.disabled,
		).toBe(false);
		f.controller.store.set({
			data: { ...f.data, seats: f.data.seats.map((seat) => ({ ...seat, modelAccountReady: false })) },
		});
		renderFounding(f.controller, container, actions);
		expect(
			[...container.querySelectorAll("button")].find((button) => button.textContent === "I'm Ready")?.disabled,
		).toBe(true);
		[...container.querySelectorAll("button")].find((button) => button.textContent === "Connect ChatGPT")?.click();
		expect(actions.connectModel).toHaveBeenCalledOnce();
		expect(container.textContent).toContain("Computer Usage owner");
	});
});
