// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mountApplication } from "../src/app/application.ts";
import { FoundingController } from "../src/app/founding.ts";
import { parseRoute, routeHash } from "../src/app/router.ts";
import { FoundingView } from "../src/app/views/founding.ts";
import { HubController, renderHub } from "../src/app/views/hub.ts";
import { CloudRpcError } from "../src/cloud/client.ts";
import { CompanyFoundingApi, parseCompanyFounding } from "../src/cloud/company-founding.ts";
import { setLanguagePreference } from "../src/ui/preferences.ts";
import { deferred, fixture, id, settle, userA, userB, visibleText } from "./fixtures.ts";

const table = id(900);
const me = userA.id;
const bo = userB.id;

type Wire = Record<string, unknown>;

function wire(overrides: Wire = {}): Wire {
	return {
		schema: "qorpera.company-founding/v1",
		profileId: table,
		companyName: "Nordlys Kaffe",
		vision: "Specialty coffee.",
		phase: "open",
		revision: 4,
		createdByUserId: me,
		seats: [
			{
				userId: me,
				displayName: "Anna",
				state: "joined",
				role: "Online shop.",
				invitedByUserId: me,
				ready: false,
				modelLoginReady: false,
				creator: true,
			},
			{
				userId: bo,
				displayName: "Bo",
				state: "joined",
				role: "Wholesale.",
				invitedByUserId: me,
				ready: true,
				modelLoginReady: true,
				creator: false,
			},
		],
		waitingFor: [me],
		me: { userId: me, state: "joined", canEdit: true, canManage: true, canStart: false },
		start: null,
		...overrides,
	};
}

function mine(changes: Wire, value = wire()): Wire {
	const seats = (value.seats as Wire[]).map((seat) => (seat.userId === me ? { ...seat, ...changes } : seat));
	return { ...value, seats };
}

const stale = (name: string) => new CloudRpcError(name, { message: "The table changed", code: "PT412" }, 412);

describe("founding table wire shape", () => {
	it("reads a table and refuses one that contradicts itself", () => {
		const parsed = parseCompanyFounding(wire());
		expect(parsed.seats.map((seat) => seat.displayName)).toEqual(["Anna", "Bo"]);
		expect(parsed.waitingFor).toEqual([me]);
		expect(() => parseCompanyFounding(wire({ phase: "started" }))).toThrow();
		const seats = wire().seats as unknown[];
		expect(() => parseCompanyFounding(wire({ seats: [seats[0], seats[0]] }))).toThrow();
		expect(() => parseCompanyFounding(wire({ schema: "qorpera.company-founding/v2" }))).toThrow();
	});

	it("sends each call with the table's id and the revision it was made on", async () => {
		const { cloud } = fixture();
		const rpc = vi.mocked(cloud.rpc).mockResolvedValue(wire());
		const api = new CompanyFoundingApi(cloud);
		await api.open(id(1), "  Nordlys Kaffe ");
		expect(rpc).toHaveBeenLastCalledWith("qorpera_open_company_founding", {
			p_client_creation_id: id(1),
			p_company_name: "Nordlys Kaffe",
		});
		await api.setReady(table, 4, true);
		expect(rpc).toHaveBeenLastCalledWith("qorpera_set_founder_ready", {
			p_profile_id: table,
			p_expected_revision: 4,
			p_ready: true,
		});
		await api.start(table, 4, id(2));
		expect(rpc).toHaveBeenLastCalledWith("qorpera_start_company_founding", {
			p_profile_id: table,
			p_expected_revision: 4,
			p_client_start_id: id(2),
		});
		rpc.mockResolvedValueOnce({ state: "declined", profileId: table });
		await expect(api.respond(table, false)).resolves.toBeNull();
		rpc.mockResolvedValueOnce(wire({ profileId: id(901) }));
		await expect(api.read(table)).rejects.toThrow();
	});
});

describe("founding table", () => {
	let container: HTMLElement;
	let controller: FoundingController | undefined;
	beforeEach(() => {
		container = document.createElement("div");
		document.body.append(container);
	});
	afterEach(() => {
		controller?.dispose();
		controller = undefined;
		container.remove();
		vi.useRealTimers();
		location.hash = "";
	});

	function mount(rpc: (name: string, args: Record<string, unknown>) => unknown) {
		const f = fixture();
		const calls: { name: string; args: Record<string, unknown> }[] = [];
		vi.mocked(f.cloud.rpc).mockImplementation(async (name: string, args: Record<string, unknown> = {}) => {
			calls.push({ name, args });
			return rpc(name, args);
		});
		const seatChanges = vi.fn();
		controller = new FoundingController(f.api, me, table, { currentUserId: () => me, onSeatChanged: seatChanges });
		const view = new FoundingView(controller);
		container.append(view.el);
		controller.store.subscribe(() => view.update());
		view.update();
		const named = (name: string) => calls.filter((call) => call.name === name).map((call) => call.args);
		return { ...f, view, calls, named, seatChanges };
	}

	const buttonNamed = (label: string) =>
		[...container.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent === label);

	it("asks you to connect ChatGPT before Ready, and keeps Start off until everyone is ready", async () => {
		mount(() => wire());
		await settle();
		const text = visibleText(container);
		expect(text).toContain("Connect ChatGPT");
		expect(text).toContain("Invite Co-founder");
		expect(text).toContain("Waiting for you to be ready");
		expect(text).toContain("Everyone at the table becomes a founder of Nordlys Kaffe.");
		expect(container.querySelector<HTMLButtonElement>(".founding-start")?.disabled).toBe(true);
		// No payment step or billing text anywhere at the table.
		expect(text.toLowerCase()).not.toMatch(/billing|payment|plan|credit|computer hours|pays/);
	});

	it("keeps what you are typing, its caret and focus, across refreshes, and saves only when you leave it", async () => {
		const { named } = mount(() => wire());
		await settle();
		const field = container.querySelector<HTMLTextAreaElement>(".founding-role-mine")!;
		field.focus();
		field.value = "Online shop. And roasting in Aar";
		field.setSelectionRange(5, 5);
		await controller!.refresh();
		await settle();
		// The same field, untouched, with nothing saved.
		expect(container.querySelector(".founding-role-mine")).toBe(field);
		expect(document.activeElement).toBe(field);
		expect(field.value).toBe("Online shop. And roasting in Aar");
		expect(field.selectionStart).toBe(5);
		expect(named("qorpera_set_founder_role")).toEqual([]);
		field.value = "Online shop. And roasting in Aarhus.";
		field.blur();
		await settle();
		expect(named("qorpera_set_founder_role")).toEqual([
			{ p_profile_id: table, p_expected_revision: 4, p_role: "Online shop. And roasting in Aarhus." },
		]);
	});

	it("lets an untouched field follow another founder's change, and never saves it back", async () => {
		let server = wire();
		const { named } = mount(() => server);
		await settle();
		const name = container.querySelector<HTMLInputElement>("input.founding-name")!;
		name.focus();
		// Bo renames the company while Anna's cursor sits in the name, untouched.
		server = wire({ companyName: "Nordlys Roastery", revision: 5 });
		await controller!.refresh();
		await settle();
		expect(name.value).toBe("Nordlys Roastery");
		expect(document.activeElement).toBe(name);
		name.blur();
		await settle();
		expect(named("qorpera_update_company_founding")).toEqual([]);
	});

	it("keeps a space or new line you just typed across a refresh", async () => {
		const { named } = mount(() => wire());
		await settle();
		const name = container.querySelector<HTMLInputElement>("input.founding-name")!;
		name.focus();
		name.value = "Nordlys Kaffe ";
		await controller!.refresh();
		await settle();
		expect(name.value).toBe("Nordlys Kaffe ");
		name.value = "Nordlys Kaffe Roastery";
		name.blur();
		await settle();
		expect(named("qorpera_update_company_founding").map((args) => args.p_company_name)).toEqual([
			"Nordlys Kaffe Roastery",
		]);
	});

	it("never puts back old text for a space you typed while another founder changed the field", async () => {
		let server = wire();
		const { named } = mount(() => server);
		await settle();
		const name = container.querySelector<HTMLInputElement>("input.founding-name")!;
		name.focus();
		name.value = "Nordlys Kaffe ";
		name.setSelectionRange(name.value.length, name.value.length);
		server = wire({ companyName: "Nordlys Roastery", revision: 5 });
		await controller!.refresh();
		await settle();
		expect(name.value).toBe("Nordlys Roastery");
		// The caret was at the end, and stays at the end of the new name.
		expect(name.selectionStart).toBe("Nordlys Roastery".length);
		name.blur();
		await settle();
		expect(named("qorpera_update_company_founding")).toEqual([]);
	});

	it("keeps your role field and focus when someone joins or is invited while you type", async () => {
		let server = wire();
		const { named } = mount(() => server);
		await settle();
		const field = container.querySelector<HTMLTextAreaElement>(".founding-role-mine")!;
		field.focus();
		field.value = "Online shop. And roasting in Aar";
		server = wire({
			seats: [
				...(wire().seats as Wire[]),
				{
					userId: id(903),
					displayName: "Dag",
					state: "invited",
					role: "",
					invitedByUserId: bo,
					ready: false,
					modelLoginReady: false,
					creator: false,
				},
			],
		});
		await controller!.refresh();
		await settle();
		expect(container.querySelectorAll(".founding-seat:not(.founding-seat-invite)").length).toBe(3);
		expect(container.querySelector(".founding-role-mine")).toBe(field);
		expect(document.activeElement).toBe(field);
		expect(named("qorpera_set_founder_role")).toEqual([]);
	});

	it("asks for the Ready that was shown, so a double click does not undo it", async () => {
		let server = mine({ modelLoginReady: true });
		const { named } = mount((name, args) => {
			if (name === "qorpera_set_founder_ready") server = mine({ ready: args.p_ready, modelLoginReady: true });
			return server;
		});
		await settle();
		const ready = buttonNamed("Ready")!;
		ready.click();
		ready.click();
		await settle();
		expect(named("qorpera_set_founder_ready").map((args) => args.p_ready)).toEqual([true, true]);
		expect(ready.textContent).toBe("Ready ✓");
	});

	it("keeps the page (and so its scroll) and your focused button across refreshes", async () => {
		mount(() => mine({ modelLoginReady: true }));
		await settle();
		const page = container.querySelector(".founding-page");
		const ready = buttonNamed("Ready")!;
		ready.focus();
		await controller!.refresh();
		await settle();
		expect(container.querySelector(".founding-page")).toBe(page);
		expect(document.activeElement).toBe(ready);
	});

	it("keeps unsaved text and the error when a save fails, until your next action", async () => {
		mount((name) => {
			if (name === "qorpera_update_company_founding") throw new Error("Failed to fetch");
			return wire();
		});
		await settle();
		const vision = container.querySelector<HTMLTextAreaElement>(".founding-vision")!;
		vision.focus();
		vision.value = "Specialty coffee, roasted in Aarhus.";
		vision.blur();
		await settle();
		await controller!.refresh();
		await settle();
		expect(vision.value).toBe("Specialty coffee, roasted in Aarhus.");
		expect(visibleText(container)).toContain("Failed to fetch");
	});

	it("sends a description again on a table that moved, with the other founder's new name", async () => {
		let server = wire();
		const { named } = mount((name, args) => {
			if (name === "qorpera_update_company_founding") {
				if (args.p_expected_revision !== server.revision) throw stale(name);
				server = { ...server, companyName: args.p_company_name, vision: args.p_vision, revision: 6 };
			}
			return server;
		});
		await settle();
		// Bo renames the company; this tab has not seen it yet.
		server = { ...server, companyName: "Nordlys Roastery", revision: 5 };
		const vision = container.querySelector<HTMLTextAreaElement>(".founding-vision")!;
		vision.focus();
		vision.value = "Specialty coffee, roasted in Aarhus.";
		vision.blur();
		await settle();
		expect(
			named("qorpera_update_company_founding").map((args) => [args.p_expected_revision, args.p_company_name]),
		).toEqual([
			[4, "Nordlys Kaffe"],
			[5, "Nordlys Roastery"],
		]);
		expect(server.companyName).toBe("Nordlys Roastery");
		expect(controller!.store.get().error).toBeUndefined();
	});

	it("never lets a read that started before your edit put the older table back", async () => {
		const slow = deferred<Wire>();
		let reads = 0;
		mount((name) => {
			if (name === "qorpera_read_company_founding") return ++reads === 2 ? slow.promise : wire();
			if (name === "qorpera_update_company_founding") return wire({ companyName: "Nordlys Roastery", revision: 5 });
			return wire();
		});
		await settle();
		const reading = controller!.refresh();
		await controller!.rename("Nordlys Roastery");
		slow.resolve(wire());
		await reading;
		await settle();
		expect(controller!.store.get().table?.companyName).toBe("Nordlys Roastery");
		expect(controller!.store.get().table?.revision).toBe(5);
	});

	it("counts Ready after your own role save, and never on a table someone else changed", async () => {
		let server = mine({ modelLoginReady: true });
		const { named } = mount((name, args) => {
			if (name === "qorpera_set_founder_role")
				server = mine({ role: args.p_role, modelLoginReady: true }, wire({ revision: 5 }));
			if (name === "qorpera_set_founder_ready") {
				if (args.p_expected_revision !== server.revision) throw stale(name);
				server = mine({ ready: true, modelLoginReady: true }, { ...server });
			}
			return server;
		});
		await settle();
		// Type a role, then press Ready: the role saves as the field loses focus, and Ready follows.
		const field = container.querySelector<HTMLTextAreaElement>(".founding-role-mine")!;
		field.focus();
		field.value = "Roasting.";
		const ready = buttonNamed("Ready")!;
		field.blur();
		ready.click();
		await settle();
		expect(named("qorpera_set_founder_ready")).toEqual([
			{ p_profile_id: table, p_expected_revision: 5, p_ready: true },
		]);
		expect(buttonNamed("Ready ✓")).toBe(ready);

		// Someone else's change (revision 7) after the page showed revision 5: the server refuses.
		server = mine({ ready: false, modelLoginReady: true }, wire({ revision: 7 }));
		await controller!.setReady(5, false);
		await settle();
		expect(named("qorpera_set_founder_ready").at(-1)).toEqual({
			p_profile_id: table,
			p_expected_revision: 5,
			p_ready: false,
		});
		expect(controller!.store.get().error).toContain("The table changed");
	});

	it("stops asking once you have left, and tells the hub", async () => {
		vi.useFakeTimers();
		const { named, seatChanges } = mount((name) =>
			name === "qorpera_remove_company_founder" ? { state: "left", profileId: table } : wire(),
		);
		await vi.advanceTimersByTimeAsync(10);
		await vi.advanceTimersByTimeAsync(6000);
		expect(named("qorpera_read_company_founding").length).toBeGreaterThan(1);
		expect(await controller!.leave()).toBe(true);
		expect(controller!.store.get().gone).toBe("left");
		expect(seatChanges).toHaveBeenCalled();
		const reads = named("qorpera_read_company_founding").length;
		await vi.advanceTimersByTimeAsync(20000);
		expect(named("qorpera_read_company_founding").length).toBe(reads);
		expect(visibleText(container)).toContain("You left the table.");
	});

	it("stops asking once it is disposed", async () => {
		vi.useFakeTimers();
		const { named } = mount(() => wire());
		await vi.advanceTimersByTimeAsync(10);
		controller!.dispose();
		const reads = named("qorpera_read_company_founding").length;
		await vi.advanceTimersByTimeAsync(20000);
		expect(named("qorpera_read_company_founding").length).toBe(reads);
	});

	it("closes the ChatGPT panel, and stops it, once your account is connected", async () => {
		let connected = false;
		mount((name) => (name === "qorpera_read_company_founding" ? mine({ modelLoginReady: connected }) : wire()));
		await settle();
		buttonNamed("Connect ChatGPT")!.click();
		await settle();
		const panel = container.querySelector<HTMLElement>(".founding-connect")!;
		const body = panel.lastElementChild!;
		expect(panel.hidden).toBe(false);
		expect(body.childElementCount).toBe(1);
		connected = true;
		await controller!.refresh();
		await settle();
		expect(panel.hidden).toBe(true);
		expect(controller!.store.get().connectOpen).toBe(false);
		// The accounts panel was disposed, which takes its element off the page.
		expect(body.childElementCount).toBe(0);
	});

	it("shows an invitation with Join and Decline, and no Start", async () => {
		const { seatChanges } = mount((name) => {
			if (name === "qorpera_respond_company_founding") return { state: "declined", profileId: table };
			return wire({
				seats: [
					{ ...(wire().seats as Wire[])[1], userId: bo, displayName: "Bo", creator: true },
					{
						userId: me,
						displayName: "Anna",
						state: "invited",
						role: "",
						invitedByUserId: bo,
						ready: false,
						modelLoginReady: false,
						creator: false,
					},
				],
				createdByUserId: bo,
				me: { userId: me, state: "invited", canEdit: false, canManage: false, canStart: false },
			});
		});
		await settle();
		const text = visibleText(container);
		expect(text).toContain("Bo invited you to start Nordlys Kaffe together.");
		expect(text).toContain("Join the table");
		expect(container.querySelector<HTMLElement>(".founding-bar")?.hidden).toBe(true);
		expect(container.querySelector(".founding-role-mine")).toBeNull();
		buttonNamed("Decline")!.click();
		await settle();
		expect(controller!.store.get().gone).toBe("declined");
		expect(seatChanges).toHaveBeenCalled();
	});

	it("after Start, keeps the roles it last saw and opens the company once it is ready", async () => {
		let started = false;
		let ready = false;
		mount((name) => {
			if (name === "qorpera_start_company_founding") started = true;
			if (!started)
				return mine(
					{ ready: true, modelLoginReady: true },
					wire({
						waitingFor: [],
						me: { userId: me, state: "joined", canEdit: true, canManage: true, canStart: true },
					}),
				);
			return wire({
				phase: "started",
				vision: "",
				seats: (wire().seats as Wire[]).map((seat) => ({ ...seat, role: "", ready: false })),
				waitingFor: [],
				me: { userId: me, state: "joined", canEdit: false, canManage: false, canStart: false },
				start: { startedAt: "2026-09-28T18:00:00Z", startedByUserId: me, revision: 4, companyReady: ready },
			});
		});
		await settle();
		container.querySelector<HTMLButtonElement>(".founding-start")!.click();
		await settle();
		let text = visibleText(container);
		expect(text).toContain("Nordlys Kaffe is starting");
		expect(text).toContain("Anna and Bo own it now.");
		expect(text).toContain("Wholesale.");
		ready = true;
		await controller!.refresh();
		await settle();
		text = visibleText(container);
		expect(text).toContain("Open Nordlys Kaffe");
	});
});

describe("hub with founding tables", () => {
	afterEach(() => {
		location.hash = "";
	});

	it("opens a table for a new company and lists invitations to tables", async () => {
		const { api, cloud } = fixture();
		vi.mocked(api.companyFoundingAvailable).mockResolvedValue(true);
		vi.mocked(api.listCompanyFoundings).mockResolvedValue([
			{
				profileId: id(902),
				companyName: "Havn",
				phase: "open",
				myState: "invited",
				invitedByDisplayName: "Bo",
				joined: 1,
			},
		]);
		vi.mocked(cloud.rpc).mockImplementation(async (name: string) => {
			if (name === "qorpera_open_company_founding") return wire();
			throw new Error(`Unexpected RPC ${name}`);
		});
		const hub = new HubController(api, me);
		await hub.refresh();
		const container = document.createElement("div");
		renderHub(hub, container);
		expect(visibleText(container)).toContain("Bo invited you to start it together");
		expect(visibleText(container)).toContain("Opens a table for you and your co-founders");
		await hub.createCompany("Nordlys Kaffe");
		expect(cloud.rpc).toHaveBeenCalledWith(
			"qorpera_open_company_founding",
			expect.objectContaining({ p_company_name: "Nordlys Kaffe" }),
		);
		expect(location.hash).toBe(`#/found/${table}`);
		hub.dispose();
	});

	it("keeps today's form when the cloud has no founding lobby", async () => {
		const { api } = fixture();
		const missing = (name: string) => new CloudRpcError(name, { message: "missing", code: "PGRST202" }, 404);
		vi.mocked(api.companyFoundingAvailable).mockRejectedValue(missing("qorpera_company_founding_available"));
		vi.mocked(api.listCompanyFoundings).mockRejectedValue(missing("qorpera_list_company_foundings"));
		const hub = new HubController(api, me);
		await hub.refresh();
		expect(hub.store.get()).toMatchObject({ foundingAvailable: false, tables: [], loaded: true });
		hub.store.set({ composing: true });
		const container = document.createElement("div");
		renderHub(hub, container);
		expect(visibleText(container)).toContain("Create");
		expect(visibleText(container)).not.toContain("Open a table");
		hub.dispose();
	});

	it("never creates a company at once while it does not know whether tables are on", async () => {
		const { api, cloud } = fixture();
		vi.mocked(api.companyFoundingAvailable).mockRejectedValue(new Error("Failed to fetch"));
		vi.mocked(api.listCompanyFoundings).mockRejectedValue(new Error("Failed to fetch"));
		const create = vi.spyOn(api, "createCompany");
		const hub = new HubController(api, me);
		await hub.refresh();
		expect(hub.store.get().foundingAvailable).toBeUndefined();
		await hub.createCompany("Nordlys Kaffe");
		expect(create).not.toHaveBeenCalled();
		expect(cloud.rpc).not.toHaveBeenCalled();
		expect(hub.store.get().error).toContain("Failed to fetch");
		// Once the cloud answers that tables are on, the same button opens a table.
		vi.mocked(api.companyFoundingAvailable).mockResolvedValue(true);
		vi.mocked(cloud.rpc).mockResolvedValue(wire());
		await hub.createCompany("Nordlys Kaffe");
		expect(cloud.rpc).toHaveBeenCalledWith("qorpera_open_company_founding", expect.anything());
		expect(create).not.toHaveBeenCalled();
		hub.dispose();
	});
});

describe("founding table in the app", () => {
	let dispose: (() => void) | undefined;
	afterEach(() => {
		dispose?.();
		dispose = undefined;
		setLanguagePreference("system");
		document.body.replaceChildren();
		vi.useRealTimers();
		vi.unstubAllGlobals();
		history.replaceState(null, "", "/#/");
	});

	it("draws the table again in a new language", async () => {
		vi.useFakeTimers();
		vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
		history.replaceState(null, "", `/#/found/${table}`);
		const f = fixture();
		vi.mocked(f.cloud.rpc).mockImplementation(async (name: string) => {
			if (name === "qorpera_read_company_founding") return wire();
			throw new CloudRpcError(name, { message: "missing", code: "PGRST202" }, 404);
		});
		const root = document.createElement("div");
		document.body.append(root);
		dispose = mountApplication(root, f.cloud, f.api);
		await settle();
		await vi.advanceTimersByTimeAsync(60);
		expect(visibleText(root)).toContain("Invite Co-founder");
		// A role typed and not saved yet comes along to the rebuilt page.
		const role = root.querySelector<HTMLTextAreaElement>(".founding-role-mine")!;
		role.focus();
		role.value = "Roasting, still typing";
		setLanguagePreference("da");
		window.dispatchEvent(new Event("qorpera-language-change"));
		await settle();
		await vi.advanceTimersByTimeAsync(60);
		expect(visibleText(root)).toContain("Inviter medstifter");
		expect(visibleText(root)).not.toContain("Invite Co-founder");
		expect(root.querySelector<HTMLTextAreaElement>(".founding-role-mine")?.value).toBe("Roasting, still typing");
	});
});

describe("founding route", () => {
	it("round-trips a table link", () => {
		expect(parseRoute(`#/found/${table}`)).toEqual({ name: "found", profileId: table });
		expect(routeHash({ name: "found", profileId: table })).toBe(`#/found/${table}`);
		expect(parseRoute("#/found/not-a-table")).toEqual({ name: "hub" });
	});
});
