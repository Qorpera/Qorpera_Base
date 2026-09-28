// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { MachinesView } from "../src/app/views/settings-machines.ts";
import { createWebMachines, parseMachines } from "../src/cloud/machines.ts";
import { id, settle, timestamp } from "./fixtures.ts";

function machine(overrides: Record<string, unknown> = {}) {
	return {
		machineId: id(71),
		name: "build-a",
		purpose: "Run the SQL suite",
		state: "running",
		cpus: 4,
		memoryGiB: 8,
		diskGiB: 40,
		image: "standard",
		lifetime: "task",
		repository: null,
		startedBy: { staffAgentId: id(30), runId: id(40), name: "Nora" },
		sponsorUserId: id(1),
		node: "node-02",
		queuePosition: null,
		waitingFor: null,
		runningSince: timestamp,
		stoppedBy: null,
		commandsRunning: 1,
		lastError: null,
		createdAt: timestamp,
		updatedAt: timestamp,
		commands: [
			{
				commandId: id(81),
				command: "npm test",
				startedAt: timestamp,
				endedAt: timestamp,
				state: "failed",
				exitCode: 2,
			},
			{
				commandId: id(82),
				command: "npm run dev",
				startedAt: timestamp,
				endedAt: null,
				state: "running",
				exitCode: null,
			},
		],
		...overrides,
	};
}

let view: MachinesView | undefined;
afterEach(() => {
	view?.dispose();
	view = undefined;
	document.body.replaceChildren();
	vi.restoreAllMocks();
});

describe("company machines in settings", () => {
	it("reads the company's machines and changes one through the member RPC", async () => {
		const rpc = vi.fn(async (name: string) =>
			name === "qorpera_list_company_machines"
				? { schema: "qorpera.company-machines/v1", machines: [machine()] }
				: null,
		);
		const client = createWebMachines({ rpc } as never, id(10));
		expect(await client.list()).toMatchObject([{ name: "build-a", state: "running", cpus: 4, commandsRunning: 1 }]);
		await client.change(id(71), "stop");
		expect(rpc).toHaveBeenLastCalledWith("qorpera_member_manage_company_machine", {
			p_profile_id: id(10),
			p_machine_id: id(71),
			p_action: "stop",
		});
		expect(() => parseMachines({ schema: "other", machines: [] })).toThrow();
		expect(() =>
			parseMachines({ schema: "qorpera.company-machines/v1", machines: [machine({ state: "exploded" })] }),
		).toThrow();
	});

	it("shows every machine with its size, starter, place in line and last commands", async () => {
		const client = {
			list: vi.fn(async () =>
				parseMachines({
					schema: "qorpera.company-machines/v1",
					machines: [
						machine(),
						machine({
							machineId: id(72),
							name: "big",
							state: "waiting",
							queuePosition: 2,
							lifetime: "always-on",
							commands: [],
						}),
						machine({ machineId: id(73), name: "asleep", state: "stopped", commandsRunning: 0, commands: [] }),
					],
				}),
			),
			change: vi.fn(async () => {}),
		};
		view = new MachinesView(client, new AbortController().signal);
		document.body.append(view.el);
		await settle();
		const cards = [...view.el.querySelectorAll<HTMLElement>(".machine-card")];
		expect(cards.map((card) => card.querySelector("strong")?.textContent)).toEqual(["build-a", "big", "asleep"]);
		const [first, second, third] = cards as [HTMLElement, HTMLElement, HTMLElement];
		expect(first.textContent).toContain("4 CPUs, 8 GB memory, 40 GB disk");
		expect(first.textContent).toContain("Started by Nora");
		expect(first.querySelector("code")?.textContent).toBe("npm test");
		expect(first.textContent).toContain("failed (2)");
		expect(second.textContent).toContain("Waiting for room, number 2 in line");
		expect(second.textContent).toContain("Always on");
		// A sleeping machine is woken, not stopped.
		const wake = [...third.querySelectorAll("button")].find((button) => button.textContent === "Wake");
		wake?.click();
		await settle();
		expect(client.change).toHaveBeenCalledWith(id(73), "start");
	});

	it("asks before deleting, and says so when the list cannot be read", async () => {
		const client = {
			list: vi.fn(async () => parseMachines({ schema: "qorpera.company-machines/v1", machines: [machine()] })),
			change: vi.fn(async () => {}),
		};
		const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
		view = new MachinesView(client, new AbortController().signal);
		await settle();
		const remove = () => [...view!.el.querySelectorAll("button")].find((button) => button.textContent === "Delete")!;
		remove().click();
		await settle();
		expect(client.change).not.toHaveBeenCalled();
		remove().click();
		await settle();
		expect(confirm).toHaveBeenCalledTimes(2);
		expect(client.change).toHaveBeenCalledWith(id(71), "delete");
		client.list.mockRejectedValueOnce(new Error("offline"));
		view.dispose();
		view = new MachinesView(client, new AbortController().signal);
		await settle();
		expect(view.el.textContent).toContain("The company's machines could not be read.");
	});
});
