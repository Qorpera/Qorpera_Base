import type { HostedMachine, MachineState } from "../../cloud/machines.ts";
import { h, icon, replace } from "../../ui/dom.ts";
import { phrase, t } from "../../ui/preferences.ts";

/**
 * The machines an agent started from this conversation, beside the agent in
 * the thread's header: one small card each, with its name and what it is
 * doing. A click opens Settings → Machines, where a member can stop, wake or
 * delete it. The thread reads them when the agent's run changes, and again
 * every few seconds only while one is starting, stopping or running a command.
 */

const STATE_TEXT: Record<MachineState, string> = {
	waiting: phrase("Waiting for room"),
	starting: phrase("Starting"),
	running: phrase("Running"),
	stopping: phrase("Stopping"),
	stopped: phrase("Asleep"),
	deleting: phrase("Deleting"),
	deleted: phrase("Deleted"),
};
const MOVING: readonly MachineState[] = ["waiting", "starting", "stopping", "deleting"];
const POLL_MS = 10000;

export class ThreadMachines {
	readonly el = h("div", { class: "thread-machines", role: "group", hidden: true });
	readonly #read: () => Promise<HostedMachine[]>;
	readonly #open: () => void;
	readonly #signal: AbortSignal;
	#machines: HostedMachine[] = [];
	#timer: ReturnType<typeof setTimeout> | undefined;
	#reading = false;
	#again = false;
	#drawn = "";

	constructor(read: () => Promise<HostedMachine[]>, open: () => void, signal: AbortSignal) {
		this.#read = read;
		this.#open = open;
		this.#signal = signal;
		this.el.setAttribute("aria-label", t("Machines"));
		signal.addEventListener("abort", () => clearTimeout(this.#timer), { once: true });
	}

	/** Reads the thread's machines now; a read already on its way is followed by one more. */
	refresh(): void {
		if (this.#signal.aborted) return;
		if (this.#reading) {
			this.#again = true;
			return;
		}
		clearTimeout(this.#timer);
		this.#timer = undefined;
		this.#reading = true;
		// Never inside the caller's render: a read that refuses at once is only a failed read.
		void Promise.resolve()
			.then(() => this.#read())
			.then(
				(machines) => {
					if (this.#signal.aborted) return;
					this.#machines = machines.filter((machine) => machine.state !== "deleted");
					this.#draw();
				},
				() => undefined,
			)
			.finally(() => {
				this.#reading = false;
				if (this.#signal.aborted) return;
				if (this.#again) {
					this.#again = false;
					this.refresh();
					return;
				}
				if (this.#machines.some((machine) => MOVING.includes(machine.state) || machine.commandsRunning > 0))
					this.#timer = setTimeout(() => this.refresh(), POLL_MS);
			});
	}

	#draw(): void {
		const key = JSON.stringify(
			this.#machines.map((machine) => [
				machine.machineId,
				machine.state,
				machine.queuePosition,
				machine.commandsRunning,
			]),
		);
		if (key === this.#drawn) return;
		this.#drawn = key;
		replace(
			this.el,
			...this.#machines.map((machine) => {
				const state =
					machine.state === "waiting" && machine.queuePosition !== null
						? t("Waiting for room, number {position} in line", { position: machine.queuePosition })
						: t(STATE_TEXT[machine.state]);
				const label = `${machine.name} · ${state}`;
				return h(
					"button",
					{
						type: "button",
						class: "thread-machine",
						title: label,
						"aria-label": t("{label}. Open the company's machines", { label }),
						dataset: { state: machine.state },
						onclick: () => this.#open(),
					},
					icon("machine"),
					h("span", { class: "thread-machine-name" }, machine.name),
				);
			}),
		);
		this.el.hidden = this.#machines.length === 0;
	}
}
