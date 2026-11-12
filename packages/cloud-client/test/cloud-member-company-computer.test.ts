import { describe, expect, it, vi } from "vitest";
import { CloudMemberCompanyComputerClient } from "../src/cloud-member-company-computer.ts";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const scope = { companyId: id(1), environmentId: id(2), companyComputerId: id(3), logicalComputerId: id(4) };
function fixture() {
	const data = {
		companyId: id(1),
		environmentId: id(2),
		canManage: true,
		scope,
		staff: [{ staffAgentId: id(5), name: "<img src=x>" }],
		nextAfter: null as string | null,
	};
	const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
		expect(new Headers(init?.headers).get("authorization")).toBe("Bearer fixture-token");
		expect(new Headers(init?.headers).get("apikey")).toBe("public");
		expect(new Request(url, init).cache).toBe("no-store");
		expect(init?.redirect).toBe("error");
		return Response.json(data);
	});
	const accessToken = vi.fn(async () => "fixture-token");
	const options = {
		companyId: id(1),
		environmentId: id(2),
		supabaseUrl: "https://control.test",
		publishableKey: "public",
		fetch,
		accessToken,
	};
	return { data, fetch, accessToken, options, client: new CloudMemberCompanyComputerClient(options) };
}
describe("member Company Computer transport", () => {
	it("discovers only member metadata and copies configuration", async () => {
		const f = fixture();
		f.options.environmentId = id(9);
		expect(await f.client.catalog(new AbortController().signal)).toEqual(f.data);
		expect(f.fetch.mock.calls[0][0]).toBe("https://control.test/rest/v1/rpc/qorpera_member_office_catalog");
		expect(JSON.parse(f.fetch.mock.calls[0][1]!.body as string)).toEqual({ p_environment_id: id(2), p_after: null });
	});
	it.each(["company", "environment", "scope", "duplicate", "size", "cursor", "name"])(
		"refuses a malformed %s response",
		async (mode) => {
			const f = fixture();
			if (mode === "company") f.data.companyId = id(9);
			if (mode === "environment") f.data.environmentId = id(9);
			if (mode === "scope") f.data.scope = { ...scope, environmentId: id(9) };
			if (mode === "duplicate") f.data.staff.push(f.data.staff[0]);
			if (mode === "size") f.data.staff = Array(51).fill(f.data.staff[0]);
			if (mode === "cursor") f.data.nextAfter = id(5);
			if (mode === "name") f.data.staff[0].name = "x".repeat(161);
			await expect(f.client.catalog(new AbortController().signal)).rejects.toThrow();
		},
	);
	it("finds the computer that shows an agent's screen, and falls back on an older backend", async () => {
		const f = fixture(),
			signal = new AbortController().signal;
		const placed = {
			companyId: id(1),
			environmentId: id(2),
			staffAgentId: id(5),
			canManage: false,
			computers: 2,
			placement: "starting",
			computer: { scope: { ...scope, companyComputerId: id(7) }, number: 2, waiting: "room" },
		};
		f.fetch.mockResolvedValueOnce(Response.json(placed));
		expect(await f.client.agentComputer(id(5), signal)).toEqual({
			canManage: false,
			computers: 2,
			placement: "starting",
			computer: placed.computer,
		});
		expect(f.fetch.mock.calls[0][0]).toBe("https://control.test/rest/v1/rpc/qorpera_member_agent_office");
		expect(JSON.parse(f.fetch.mock.calls[0][1]!.body as string)).toEqual({
			p_environment_id: id(2),
			p_staff_agent_id: id(5),
		});
		// A company out of computer hours: the computer waits for hours (20260928309720).
		f.fetch.mockResolvedValueOnce(Response.json({ ...placed, computer: { ...placed.computer, waiting: "hours" } }));
		expect((await f.client.agentComputer(id(5), signal))?.computer?.waiting).toBe("hours");
		f.fetch.mockResolvedValueOnce(Response.json({ ...placed, placement: "new", computer: null }));
		expect((await f.client.agentComputer(id(5), signal))?.computer).toBeNull();
		f.fetch.mockResolvedValueOnce(Response.json({ code: "PGRST202" }, { status: 404 }));
		expect(await f.client.agentComputer(id(5), signal)).toBeUndefined();
		// Any other 404 is not "an older backend".
		f.fetch.mockResolvedValueOnce(new Response("not found", { status: 404 }));
		await expect(f.client.agentComputer(id(5), signal)).rejects.toThrow();
		f.fetch.mockResolvedValueOnce(Response.json({ ...placed, placement: "denied", computer: null }));
		expect((await f.client.agentComputer(id(5), signal))?.placement).toBe("denied");
		f.fetch.mockResolvedValueOnce(new Response(null, { status: 500 }));
		await expect(f.client.agentComputer(id(5), signal)).rejects.toThrow();
		for (const bad of [
			{ ...placed, staffAgentId: id(6) },
			{ ...placed, placement: "elsewhere" },
			{ ...placed, computer: { ...placed.computer, number: 0 } },
			{ ...placed, computer: { ...placed.computer, waiting: "later" } },
			{ ...placed, computer: { ...placed.computer, scope: { ...scope, companyId: id(9) } } },
			{ ...placed, extra: true },
		]) {
			f.fetch.mockResolvedValueOnce(Response.json(bad));
			await expect(f.client.agentComputer(id(5), signal)).rejects.toThrow();
		}
		await expect(f.client.agentComputer("not-an-id", signal)).rejects.toThrow();
	});
	it("pages exact ordered staff without granting access", async () => {
		const f = fixture();
		f.data.staff = Array.from({ length: 50 }, (_, n) => ({ staffAgentId: id(n + 10), name: `Agent ${n}` }));
		f.data.nextAfter = id(59);
		expect((await f.client.catalog(new AbortController().signal, id(5))).nextAfter).toBe(id(59));
		f.data.staff = [];
		f.data.nextAfter = null;
		expect((await f.client.catalog(new AbortController().signal, id(59))).staff).toEqual([]);
	});
	it("uses existing start and access contracts without automatic mutation retries", async () => {
		const f = fixture(),
			signal = new AbortController().signal;
		f.fetch.mockResolvedValueOnce(
			Response.json({ scope, computerGeneration: 1, officeState: "provisioning", intent: null }),
		);
		expect((await f.client.start(scope).status(signal)).officeState).toBe("provisioning");
		f.fetch.mockResolvedValueOnce(new Response(null, { status: 503 }));
		await expect(f.client.start(scope).request(1, id(8), signal)).rejects.toThrow("REFRESH_STATUS");
		expect(f.fetch).toHaveBeenCalledTimes(2);
		f.fetch.mockResolvedValueOnce(
			Response.json({
				schema: "qorpera.office-access-status/v1",
				scope,
				staffAgentId: id(5),
				grant: { grantId: id(6), version: 1, state: "active", capabilities: ["desktop", "shell"] },
			}),
		);
		await f.client
			.access(scope, id(5))
			.configure({ expectedVersion: 0, enabled: true, capabilities: ["desktop", "shell"] }, signal);
		expect(JSON.parse(f.fetch.mock.calls[2][1]!.body as string)).toEqual({
			p_scope: scope,
			p_staff_agent_id: id(5),
			p_expected_version: 0,
			p_enabled: true,
			p_capabilities: ["desktop", "shell"],
		});
	});
	it("refuses scope substitution and untrusted viewer URLs before I/O", () => {
		const f = fixture();
		expect(() => f.client.start({ ...scope, companyId: id(9) })).toThrow();
		expect(() => f.client.access({ ...scope, environmentId: id(9) }, id(5))).toThrow();
		expect(() => f.client.views(scope, id(7), `ws://localhost/office/${id(3)}/view`)).toThrow();
		expect(f.accessToken).not.toHaveBeenCalled();
	});
	it("observes cancellation and rejects member token failures without network I/O", async () => {
		const f = fixture(),
			controller = new AbortController();
		controller.abort();
		await expect(f.client.catalog(controller.signal)).rejects.toThrow();
		expect(f.fetch).not.toHaveBeenCalled();
		f.accessToken.mockResolvedValue("invalid token");
		await expect(f.client.catalog(new AbortController().signal)).rejects.toThrow();
		expect(f.fetch).not.toHaveBeenCalled();
	});
	it("lists an agent's machines for the computer window, ignoring fields it does not know (20260930712000)", async () => {
		const f = fixture(),
			signal = new AbortController().signal;
		const machine = {
			machineId: id(20),
			name: "concept-desktop",
			purpose: "Walks through the concepts app.",
			state: "running",
			lifetime: "task",
			desktopCapable: true,
			startedByAgent: true,
			screenUsedAt: "2026-11-10T14:25:45Z",
			screenAgentName: "Product Lead",
			waitingFor: null,
			addedLater: { control: null },
		};
		const reply = (machines: unknown[], extra: Record<string, unknown> = {}) =>
			f.fetch.mockResolvedValueOnce(
				Response.json({
					schema: "qorpera.agent-machines/v1",
					profileId: id(1),
					staffAgentId: id(5),
					canWake: false,
					machines,
					canTakeOver: true,
					...extra,
				}),
			);
		reply([
			machine,
			{
				...machine,
				machineId: id(21),
				state: "waiting",
				waitingFor: "hours",
				screenUsedAt: null,
				screenAgentName: null,
				// The caller's own hand-back epoch for it (review r5).
				epoch: 7,
			},
		]);
		const { addedLater: _ignored, ...listed } = machine;
		const known = { ...listed, control: null, epoch: 0, others: [] };
		expect(await f.client.agentMachines(id(5), signal)).toEqual({
			canWake: false,
			canTakeOver: true,
			machines: [
				known,
				{
					...known,
					machineId: id(21),
					state: "waiting",
					waitingFor: "hours",
					screenUsedAt: null,
					screenAgentName: null,
					epoch: 7,
				},
			],
		});
		expect(f.fetch.mock.calls[0][0]).toBe("https://control.test/rest/v1/rpc/qorpera_list_agent_machines");
		expect(JSON.parse(f.fetch.mock.calls[0][1]!.body as string)).toEqual({
			p_profile_id: id(1),
			p_staff_agent_id: id(5),
		});
		for (const [machines, extra] of [
			[[{ ...machine, machineId: "x" }], {}],
			[[{ ...machine, name: "" }], {}],
			[[{ ...machine, state: "deleted" }], {}],
			[[{ ...machine, lifetime: "forever" }], {}],
			[[{ ...machine, desktopCapable: "yes" }], {}],
			[[{ ...machine, waitingFor: "NODE_CAPACITY_EXHAUSTED" }], {}],
			[[machine, machine], {}],
			[Array.from({ length: 21 }, (_, n) => ({ ...machine, machineId: id(100 + n) })), {}],
			[[], { staffAgentId: id(6) }],
			[[], { profileId: id(9) }],
			[[], { schema: "qorpera.agent-machines/v2" }],
			[[], { canWake: "yes" }],
			[[], { canTakeOver: "yes" }],
			[[{ ...machine, control: { mine: "yes", name: "Ada", until: "2026-11-10T19:00:00Z" } }], {}],
			[[{ ...machine, control: { mine: false, name: "", until: "2026-11-10T19:00:00Z" } }], {}],
			[[{ ...machine, control: { mine: false, name: "Ada" } }], {}],
			[[{ ...machine, control: "Ada" }], {}],
			// The epoch a hold was taken under is the caller's own hold's alone, and a whole number from 0 (review r5).
			[[{ ...machine, control: { mine: false, name: "Ada", until: "2026-11-10T19:00:00Z", epoch: 3 } }], {}],
			[[{ ...machine, control: { mine: true, name: "Ada", until: "2026-11-10T19:00:00Z", epoch: -1 } }], {}],
			[[{ ...machine, control: { mine: true, name: "Ada", until: "2026-11-10T19:00:00Z", epoch: "3" } }], {}],
			// So are its seat and the press that seated it (F26), a whole number from 0 and a uuid.
			[[{ ...machine, control: { mine: false, name: "Ada", until: "2026-11-10T19:00:00Z", seat: 3 } }], {}],
			[[{ ...machine, control: { mine: true, name: "Ada", until: "2026-11-10T19:00:00Z", seat: -1 } }], {}],
			[[{ ...machine, control: { mine: true, name: "Ada", until: "2026-11-10T19:00:00Z", seat: 2.5 } }], {}],
			[[{ ...machine, control: { mine: false, name: "Ada", until: "2026-11-10T19:00:00Z", press: id(30) } }], {}],
			[[{ ...machine, control: { mine: true, name: "Ada", until: "2026-11-10T19:00:00Z", press: "tab-1" } }], {}],
			[[{ ...machine, epoch: 1.5 }], {}],
			[[{ ...machine, epoch: -1 }], {}],
			// The other members using the shared desktop (20260930734000): names, at most 50.
			[[{ ...machine, others: "Ada" }], {}],
			[[{ ...machine, others: [""] }], {}],
			[[{ ...machine, others: [7] }], {}],
			[[{ ...machine, others: Array.from({ length: 51 }, () => "Ada") }], {}],
		] as const) {
			reply([...machines], extra);
			await expect(f.client.agentMachines(id(5), signal), JSON.stringify(extra)).rejects.toThrow();
		}
		await expect(f.client.agentMachines("agent", signal)).rejects.toThrow();
	});
	it("reads who holds a desktop, and a database before take-over as no one and no take-over (20260930713000)", async () => {
		const f = fixture(),
			signal = new AbortController().signal;
		const machine = {
			machineId: id(20),
			name: "concept-desktop",
			purpose: "Walks through the concepts app.",
			state: "running",
			lifetime: "task",
			desktopCapable: true,
			startedByAgent: true,
			screenUsedAt: null,
			screenAgentName: null,
			waitingFor: null,
		};
		const control = { mine: false, name: "Ada Lovelace", until: "2026-11-10T19:05:00.123+00:00" };
		// The caller's own hold says the epoch it was taken under (review r5), its seat and the press that seated it (F26).
		const own = {
			mine: true,
			name: "Owner",
			until: "2026-11-10T19:05:00.123+00:00",
			epoch: 4,
			seat: 9,
			press: id(30),
		};
		f.fetch.mockResolvedValueOnce(
			Response.json({
				schema: "qorpera.agent-machines/v1",
				profileId: id(1),
				staffAgentId: id(5),
				canWake: true,
				canTakeOver: false,
				machines: [
					{ ...machine, control },
					{ ...machine, machineId: id(21), control: own, epoch: 4 },
				],
			}),
		);
		expect(await f.client.agentMachines(id(5), signal)).toEqual({
			canWake: true,
			canTakeOver: false,
			machines: [
				{ ...machine, control: { ...control, epoch: null, seat: null, press: null }, epoch: 0, others: [] },
				{ ...machine, machineId: id(21), control: own, epoch: 4, others: [] },
			],
		});
		f.fetch.mockResolvedValueOnce(
			Response.json({
				schema: "qorpera.agent-machines/v1",
				profileId: id(1),
				staffAgentId: id(5),
				canWake: true,
				machines: [machine],
			}),
		);
		expect(await f.client.agentMachines(id(5), signal)).toEqual({
			canWake: true,
			canTakeOver: false,
			machines: [{ ...machine, control: null, epoch: 0, others: [] }],
		});
		// Who else uses the shared desktop (20260930734000), by name.
		f.fetch.mockResolvedValueOnce(
			Response.json({
				schema: "qorpera.agent-machines/v1",
				profileId: id(1),
				staffAgentId: id(5),
				canWake: true,
				canTakeOver: true,
				machines: [{ ...machine, others: ["Ada Lovelace", "Bo"] }],
			}),
		);
		expect((await f.client.agentMachines(id(5), signal)).machines[0]?.others).toEqual(["Ada Lovelace", "Bo"]);
	});
	it("takes a desktop over, keeps it and hands it back as the member (20260930713000)", async () => {
		const f = fixture(),
			signal = new AbortController().signal;
		const answer = (value: Record<string, unknown>) =>
			f.fetch.mockResolvedValueOnce(Response.json({ schema: "qorpera.member-machine-desktop/v1", ...value }));
		const press = "0f1e2d3c-4b5a-4987-8a6b-5c4d3e2f1a00";
		answer({ state: "ok", until: "2026-11-10T19:05:00+00:00", seat: 12 });
		expect(await f.client.takeDesktop(id(20), 3, press, signal)).toEqual({
			state: "ok",
			until: "2026-11-10T19:05:00+00:00",
			seat: 12,
		});
		expect(f.fetch.mock.calls[0][0]).toBe("https://control.test/rest/v1/rpc/qorpera_member_take_machine_desktop");
		expect(JSON.parse(f.fetch.mock.calls[0][1]!.body as string)).toEqual({
			p_profile_id: id(1),
			p_machine_id: id(20),
			p_epoch: 3,
			p_press: press,
		});
		answer({ state: "refused", reason: "DESKTOP_MEMBER_IN_CONTROL", memberName: "Ada" });
		expect(await f.client.takeDesktop(id(20), 3, press, signal)).toEqual({
			state: "refused",
			reason: "DESKTOP_MEMBER_IN_CONTROL",
			memberName: "Ada",
			epoch: null,
		});
		answer({ state: "refused", reason: "MACHINE_NOT_RUNNING" });
		expect(await f.client.takeDesktop(id(20), 3, press, signal)).toEqual({
			state: "refused",
			reason: "MACHINE_NOT_RUNNING",
			memberName: null,
			epoch: null,
		});
		// Sent at an epoch a hand-back moved on (review r5): refused with the current one.
		answer({ state: "refused", reason: "TAKE_CALLED_OFF", epoch: 4 });
		expect(await f.client.takeDesktop(id(20), 3, press, signal)).toEqual({
			state: "refused",
			reason: "TAKE_CALLED_OFF",
			memberName: null,
			epoch: 4,
		});
		for (const bad of [
			{ state: "refused", reason: "SOMETHING" },
			{ state: "refused", reason: "TAKE_CALLED_OFF" },
			{ state: "refused", reason: "MACHINE_NOT_RUNNING", epoch: 4 },
			{ state: "ok" },
			{ state: "ok", until: 5, seat: 12 },
			// A take-over's answer names its seat (F26).
			{ state: "ok", until: "2026-11-10T19:05:00+00:00" },
			{ state: "ok", until: "2026-11-10T19:05:00+00:00", seat: -1 },
		]) {
			answer(bad);
			await expect(f.client.takeDesktop(id(20), 3, press, signal), JSON.stringify(bad)).rejects.toThrow();
		}
		answer({ state: "ok", until: "2026-11-10T19:06:00+00:00" });
		expect(await f.client.keepDesktop(id(20), 3, 12, signal)).toBe("2026-11-10T19:06:00+00:00");
		expect(JSON.parse(f.fetch.mock.calls.at(-1)![1]!.body as string)).toEqual({
			p_profile_id: id(1),
			p_machine_id: id(20),
			p_epoch: 3,
			p_seat: 12,
		});
		answer({ state: "ended" });
		expect(await f.client.keepDesktop(id(20), 3, 12, signal)).toBeNull();
		expect(f.fetch.mock.calls.at(-1)![0]).toBe(
			"https://control.test/rest/v1/rpc/qorpera_member_keep_machine_desktop",
		);
		answer({ state: "ok", handedBack: true, epoch: 4, holding: false, seat: null });
		expect(await f.client.handBackDesktop(id(20), "closed", 3, 12, signal)).toEqual({
			handedBack: true,
			epoch: 4,
			holding: false,
			seat: null,
		});
		expect(f.fetch.mock.calls.at(-1)![0]).toBe(
			"https://control.test/rest/v1/rpc/qorpera_member_hand_back_machine_desktop",
		);
		expect(JSON.parse(f.fetch.mock.calls.at(-1)![1]!.body as string)).toEqual({
			p_profile_id: id(1),
			p_machine_id: id(20),
			p_reason: "closed",
			p_epoch: 3,
			p_seat: 12,
		});
		// VOID (no seat: F27, F28) at an older epoch: nothing changed, and the member holds it now (another tab of theirs,
		// at the newer one), in its seat.
		answer({ state: "ok", handedBack: false, epoch: 6, holding: true, seat: 15 });
		expect(await f.client.handBackDesktop(id(20), "handed_back", 3, null, signal)).toEqual({
			handedBack: false,
			epoch: 6,
			holding: true,
			seat: 15,
		});
		expect(JSON.parse(f.fetch.mock.calls.at(-1)![1]!.body as string)).toEqual({
			p_profile_id: id(1),
			p_machine_id: id(20),
			p_reason: "handed_back",
			p_epoch: 3,
			p_seat: null,
		});
		for (const bad of [
			{ state: "ok", handedBack: false, holding: false, seat: null },
			{ state: "ok", handedBack: false, epoch: -1, holding: false, seat: null },
			{ state: "ok", handedBack: false, epoch: 6, seat: null },
			// The seat comes exactly when the member holds the machine (F26).
			{ state: "ok", handedBack: false, epoch: 6, holding: true, seat: null },
			{ state: "ok", handedBack: false, epoch: 6, holding: false, seat: 15 },
			{ state: "ok", handedBack: false, epoch: 6, holding: false },
		]) {
			answer(bad);
			await expect(
				f.client.handBackDesktop(id(20), "handed_back", 3, 12, signal),
				JSON.stringify(bad),
			).rejects.toThrow();
		}
		f.fetch.mockResolvedValueOnce(Response.json({ schema: "qorpera.member-machine-screen/v1", state: "ok" }));
		await expect(f.client.handBackDesktop(id(20), "handed_back", 3, 12, signal)).rejects.toThrow();
		const calls = f.fetch.mock.calls.length;
		await expect(f.client.takeDesktop("machine", 3, press, signal)).rejects.toThrow();
		await expect(f.client.takeDesktop(id(20), -1, press, signal)).rejects.toThrow();
		await expect(f.client.takeDesktop(id(20), 3, "tab-1", signal)).rejects.toThrow();
		await expect(f.client.keepDesktop(id(20), 1.5, 12, signal)).rejects.toThrow();
		await expect(f.client.keepDesktop(id(20), 3, -1, signal)).rejects.toThrow();
		await expect(f.client.handBackDesktop(id(20), "closed", Number.NaN, 12, signal)).rejects.toThrow();
		await expect(f.client.handBackDesktop(id(20), "closed", 3, -1, signal)).rejects.toThrow();
		await expect(f.client.handBackDesktop(id(20), "closed", 3, 1.5, signal)).rejects.toThrow();
		// None of those reached the network.
		expect(f.fetch.mock.calls.length).toBe(calls);
	});
	it("wakes a sleeping machine through the members' machine start", async () => {
		const f = fixture(),
			signal = new AbortController().signal;
		f.fetch.mockResolvedValueOnce(Response.json({ machineId: id(20), state: "waiting", node: null }));
		await f.client.wakeMachine(id(20), signal);
		expect(f.fetch.mock.calls[0][0]).toBe("https://control.test/rest/v1/rpc/qorpera_member_manage_company_machine");
		expect(JSON.parse(f.fetch.mock.calls[0][1]!.body as string)).toEqual({
			p_profile_id: id(1),
			p_machine_id: id(20),
			p_action: "start",
		});
		f.fetch.mockResolvedValueOnce(Response.json({ machineId: id(21) }));
		await expect(f.client.wakeMachine(id(20), signal)).rejects.toThrow();
		f.fetch.mockResolvedValueOnce(new Response("{}", { status: 403 }));
		await expect(f.client.wakeMachine(id(20), signal)).rejects.toThrow();
	});
	it("starts a computer for an agent through the members' start (20260930730000), and reads only the closed answers", async () => {
		const f = fixture(),
			signal = new AbortController().signal;
		const answer = (value: unknown) => f.fetch.mockResolvedValueOnce(Response.json(value));
		const schema = "qorpera.member-agent-computer/v1";
		answer({ schema, state: "started", machine: { machineId: id(20), name: "bob-desktop", state: "waiting" } });
		expect(await f.client.startAgentComputer(id(30), signal)).toEqual({
			kind: "started",
			machineId: id(20),
			name: "bob-desktop",
			state: "waiting",
		});
		expect(f.fetch.mock.calls[0][0]).toBe("https://control.test/rest/v1/rpc/qorpera_member_start_agent_computer");
		expect(JSON.parse(f.fetch.mock.calls[0][1]!.body as string)).toEqual({
			p_profile_id: id(1),
			p_staff_agent_id: id(30),
		});
		answer({ schema, state: "existing", machine: { machineId: id(21), name: "shared-desk", state: "stopped" } });
		expect(await f.client.startAgentComputer(id(30), signal)).toMatchObject({ kind: "existing", machineId: id(21) });
		for (const reason of ["AGENT_UNAVAILABLE", "START_TOO_SOON", "MACHINE_TOO_LARGE", "MACHINES_UNAVAILABLE"]) {
			answer({ schema, state: "refused", reason });
			expect(await f.client.startAgentComputer(id(30), signal)).toEqual({ kind: "refused", reason });
		}
		// Anything else is no answer: an unknown reason, a field more, a machine that is no machine, another schema.
		for (const wrong of [
			{ schema, state: "refused", reason: "SOMETHING_ELSE" },
			{ schema, state: "refused", reason: "START_TOO_SOON", extra: 1 },
			{ schema, state: "started", machine: { machineId: "m", name: "bob-desktop", state: "waiting" } },
			{ schema, state: "started", machine: { machineId: id(20), name: "Bob Desktop", state: "waiting" } },
			{ schema, state: "made", machine: { machineId: id(20), name: "bob-desktop", state: "waiting" } },
			{
				schema: "qorpera.machine-start/v1",
				state: "started",
				machine: { machineId: id(20), name: "b", state: "waiting" },
			},
		]) {
			answer(wrong);
			await expect(f.client.startAgentComputer(id(30), signal)).rejects.toThrow();
		}
		const calls = f.fetch.mock.calls.length;
		await expect(f.client.startAgentComputer("agent", signal)).rejects.toThrow();
		expect(f.fetch.mock.calls.length).toBe(calls);
	});
});
