// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { MachinesView } from "../src/app/views/settings-machines.ts";
import { ThreadMachines } from "../src/app/views/thread-machines.ts";
import { CloudRpcError } from "../src/cloud/client.ts";
import { createWebMachines, parseMachine, parseMachines, parseSessionMachines } from "../src/cloud/machines.ts";
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
		view = new MachinesView(client, new AbortController().signal);
		document.body.append(view.el);
		await settle();
		const remove = () => [...view!.el.querySelectorAll("button")].find((button) => button.textContent === "Delete")!;
		const answer = (label: string) =>
			[...document.querySelectorAll<HTMLButtonElement>(".modal-actions button")]
				.find((button) => button.textContent === label)!
				.click();
		remove().click();
		await settle();
		expect(document.querySelector(".modal")?.textContent).toContain("Delete build-a and its disk?");
		answer("Cancel");
		await settle();
		expect(client.change).not.toHaveBeenCalled();
		remove().click();
		await settle();
		answer("Delete");
		await settle();
		expect(client.change).toHaveBeenCalledWith(id(71), "delete");
		client.list.mockRejectedValueOnce(new Error("offline"));
		view.dispose();
		view = new MachinesView(client, new AbortController().signal);
		await settle();
		expect(view.el.textContent).toContain("The company's machines could not be read.");
	});

	it("shows a refused change after the list is read again, until the member acts again", async () => {
		const client = {
			list: vi.fn(async () =>
				parseMachines({ schema: "qorpera.company-machines/v1", machines: [machine({ commandsRunning: 0 })] }),
			),
			change: vi.fn(async (): Promise<void> => {
				throw new Error("Company is unavailable");
			}),
		};
		view = new MachinesView(client, new AbortController().signal);
		document.body.append(view.el);
		await settle();
		const stop = () => [...view!.el.querySelectorAll("button")].find((button) => button.textContent === "Stop")!;
		stop().focus();
		stop().click();
		await settle();
		expect(client.change).toHaveBeenCalledWith(id(71), "stop");
		expect(view.el.querySelector("[role=alert]")?.textContent).toBe("build-a could not be changed. Try again.");
		// The keyboard stays on the button through the redraw.
		expect(document.activeElement?.textContent).toBe("Stop");
		client.change.mockResolvedValueOnce(undefined);
		stop().click();
		await settle();
		expect(view.el.querySelector("[role=alert]")).toBeNull();
	});

	it("reads again only while something moves or runs, never behind another tab, and not after dispose", async () => {
		vi.useFakeTimers();
		try {
			let machines = [machine({ state: "starting", commandsRunning: 0, commands: [] })];
			const client = {
				list: vi.fn(async () => parseMachines({ schema: "qorpera.company-machines/v1", machines })),
				change: vi.fn(async () => {}),
			};
			view = new MachinesView(client, new AbortController().signal);
			document.body.append(view.el);
			await vi.advanceTimersByTimeAsync(0);
			await vi.advanceTimersByTimeAsync(5000);
			expect(client.list).toHaveBeenCalledTimes(2);
			machines = [machine({ state: "stopped", commandsRunning: 0, commands: [] })];
			await vi.advanceTimersByTimeAsync(5000);
			await vi.advanceTimersByTimeAsync(120000);
			expect(client.list).toHaveBeenCalledTimes(3);
			// Shown again after another tab: read now; a running command is read again every 30 s.
			machines = [machine({ state: "running", commandsRunning: 1 })];
			view.shown();
			await vi.advanceTimersByTimeAsync(0);
			expect(client.list).toHaveBeenCalledTimes(4);
			await vi.advanceTimersByTimeAsync(30000);
			expect(client.list).toHaveBeenCalledTimes(5);
			view.el.remove();
			await vi.advanceTimersByTimeAsync(60000);
			expect(client.list).toHaveBeenCalledTimes(5);
			view.dispose();
			view.shown();
			await vi.advanceTimersByTimeAsync(60000);
			expect(client.list).toHaveBeenCalledTimes(5);
		} finally {
			vi.useRealTimers();
		}
	});

	it("shows a conversation's machines in its header, opens the list, and reads again only while one moves", async () => {
		vi.useFakeTimers();
		try {
			let machines = [
				machine({ state: "starting", commandsRunning: 0, commands: [] }),
				machine({ machineId: id(74), name: "gone", state: "deleted" }),
			];
			const read = vi.fn(async () =>
				parseSessionMachines({ schema: "qorpera.session-machines/v1", sessionId: id(40), machines }, id(40)),
			);
			const open = vi.fn();
			const card = new ThreadMachines(read, open, new AbortController().signal);
			expect(card.el.hidden).toBe(true);
			card.refresh();
			await vi.advanceTimersByTimeAsync(0);
			const chips = [...card.el.querySelectorAll<HTMLButtonElement>(".thread-machine")];
			expect(chips.map((chip) => chip.textContent)).toEqual(["build-a"]);
			expect(chips[0]?.title).toBe("build-a · Starting");
			chips[0]?.click();
			expect(open).toHaveBeenCalledTimes(1);
			machines = [machine({ state: "running", commandsRunning: 0, commands: [] })];
			await vi.advanceTimersByTimeAsync(10000);
			expect(read).toHaveBeenCalledTimes(2);
			expect(card.el.querySelector<HTMLButtonElement>(".thread-machine")?.dataset.state).toBe("running");
			// Nothing moving: no more reads until the agent's run changes.
			await vi.advanceTimersByTimeAsync(60000);
			expect(read).toHaveBeenCalledTimes(2);
			// Five machines: the newest three stand, then "+2".
			machines = [1, 2, 3, 4, 5].map((n) =>
				machine({ machineId: id(90 + n), name: `m${n}`, state: "running", commandsRunning: 0, commands: [] }),
			);
			card.refresh();
			await vi.advanceTimersByTimeAsync(0);
			expect([...card.el.querySelectorAll(".thread-machine")].map((chip) => chip.textContent)).toEqual([
				"m3",
				"m4",
				"m5",
				"+2",
			]);
		} finally {
			vi.useRealTimers();
		}
	});

	it("never reads another conversation's list, and stops asking a cloud without machines", async () => {
		expect(() =>
			parseSessionMachines({ schema: "qorpera.session-machines/v1", sessionId: id(41), machines: [] }, id(40)),
		).toThrow("Machines are invalid.");
		expect(() => parseMachine({ ...machine(), lifetime: "forever" })).toThrow("Machine lifetime is invalid.");
		const missing = new CloudRpcError("qorpera_list_session_machines", { code: "PGRST202", message: "missing" });
		const read = vi.fn(async () => {
			throw missing;
		});
		const card = new ThreadMachines(read, () => {}, new AbortController().signal);
		card.refresh();
		await settle();
		card.refresh();
		await settle();
		expect(read).toHaveBeenCalledTimes(1);
		const list = vi.fn(async () => {
			throw new CloudRpcError("qorpera_list_company_machines", { code: "PGRST202", message: "missing" });
		});
		view = new MachinesView({ list, change: vi.fn(async () => {}) }, new AbortController().signal);
		await settle();
		expect(view.el.textContent).toContain("Machines are not available on this cloud yet.");
		view.shown();
		await settle();
		expect(list).toHaveBeenCalledTimes(1);
	});

	it("drops a waiting focus return once the member moves on, and names a permission refusal", async () => {
		let refuse!: (error: Error) => void;
		const client = {
			list: vi.fn(async () =>
				parseMachines({ schema: "qorpera.company-machines/v1", machines: [machine({ commandsRunning: 0 })] }),
			),
			change: vi.fn(() => new Promise<void>((_resolve, reject) => (refuse = reject))),
		};
		const search = document.createElement("input");
		document.body.append(search);
		view = new MachinesView(client, new AbortController().signal);
		document.body.append(view.el);
		await settle();
		const stop = [...view.el.querySelectorAll("button")].find((button) => button.textContent === "Stop")!;
		stop.focus();
		stop.click();
		await settle();
		search.focus();
		refuse(
			new CloudRpcError("qorpera_member_manage_company_machine", {
				code: "42501",
				message: "Company is unavailable",
			}),
		);
		await settle();
		expect(document.activeElement).toBe(search);
		expect(view.el.querySelector("[role=alert]")?.textContent).toBe(
			"Only members who can change the company can stop, wake or delete its machines.",
		);
		search.blur();
		view.shown();
		await settle();
		expect(document.activeElement).toBe(document.body);
	});

	it("asks before stopping a machine whose commands still run", async () => {
		const client = {
			list: vi.fn(async () => parseMachines({ schema: "qorpera.company-machines/v1", machines: [machine()] })),
			change: vi.fn(async () => {}),
		};
		view = new MachinesView(client, new AbortController().signal);
		document.body.append(view.el);
		await settle();
		[...view.el.querySelectorAll("button")].find((button) => button.textContent === "Stop")!.click();
		await settle();
		expect(document.querySelector(".modal")?.textContent).toContain(
			"Stop build-a? Its running command stops with it.",
		);
		expect(client.change).not.toHaveBeenCalled();
		[...document.querySelectorAll<HTMLButtonElement>(".modal-actions button")]
			.find((button) => button.textContent === "Stop")!
			.click();
		await settle();
		expect(client.change).toHaveBeenCalledWith(id(71), "stop");
	});
});
