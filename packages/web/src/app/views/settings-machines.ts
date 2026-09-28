import type { HostedMachine, MachineState, WebMachines } from "../../cloud/machines.ts";
import { button, fmtTime, h, replace } from "../../ui/dom.ts";
import { phrase, t } from "../../ui/preferences.ts";
import { listSkeleton } from "../../ui/skeleton.ts";

/**
 * Settings → Machines: the virtual machines the company's agents started for
 * tests, builds and long jobs. A machine is the company's, so every member
 * sees all of them with what they are for, their size, their state and their
 * recent commands, and may stop, wake or delete any of them. The list is read
 * again while machines change state; nothing here starts a new machine.
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
const COMMAND_TEXT: Record<HostedMachine["commands"][number]["state"], string> = {
	running: phrase("running"),
	succeeded: phrase("done"),
	failed: phrase("failed"),
	cancelled: phrase("stopped"),
	lost: phrase("stopped with the machine"),
};
/** States that change by themselves soon: the list is read again while any is shown. */
const MOVING: readonly MachineState[] = ["waiting", "starting", "stopping", "deleting"];

export class MachinesView {
	readonly el = h("section", { class: "settings-group machines" });
	readonly #client: Pick<WebMachines, "list" | "change">;
	readonly #lifetime = new AbortController();
	#machines: HostedMachine[] | undefined;
	#error: string | undefined;
	#working: string | undefined;
	#timer: ReturnType<typeof setTimeout> | undefined;

	constructor(client: Pick<WebMachines, "list" | "change">, signal: AbortSignal) {
		this.#client = client;
		if (signal.aborted) this.#lifetime.abort();
		else signal.addEventListener("abort", () => this.dispose(), { once: true, signal: this.#lifetime.signal });
		this.#draw();
		void this.#read();
	}

	dispose(): void {
		this.#lifetime.abort();
		clearTimeout(this.#timer);
		this.el.replaceChildren();
		this.el.remove();
	}

	async #read(): Promise<void> {
		clearTimeout(this.#timer);
		try {
			const machines = await this.#client.list();
			if (this.#lifetime.signal.aborted) return;
			this.#machines = machines;
			this.#error = undefined;
		} catch {
			if (this.#lifetime.signal.aborted) return;
			this.#error = t("The company's machines could not be read.");
		}
		this.#draw();
		const moving = this.#machines?.some((machine) => MOVING.includes(machine.state) || machine.commandsRunning > 0);
		this.#timer = setTimeout(() => void this.#read(), moving ? 5000 : 30000);
	}

	async #change(machine: HostedMachine, action: "start" | "stop" | "delete"): Promise<void> {
		if (
			action === "delete" &&
			!confirm(t("Delete {name} and its disk? This cannot be undone.", { name: machine.name }))
		)
			return;
		this.#working = machine.machineId;
		this.#draw();
		try {
			await this.#client.change(machine.machineId, action);
		} catch {
			if (!this.#lifetime.signal.aborted)
				this.#error = t("{name} could not be changed. Try again.", { name: machine.name });
		} finally {
			this.#working = undefined;
		}
		await this.#read();
	}

	#draw(): void {
		if (this.#lifetime.signal.aborted) return;
		const machines = this.#machines;
		replace(
			this.el,
			h("h2", null, t("Machines")),
			h(
				"p",
				{ class: "settings-hint" },
				t(
					"Virtual machines your agents start for tests, builds and long jobs. They belong to the company: anyone here can stop, wake or delete them.",
				),
			),
			this.#error ? h("p", { class: "settings-error", role: "alert" }, this.#error) : null,
			machines === undefined && !this.#error ? listSkeleton(t("Loading machines")) : null,
			machines?.length === 0 ? h("p", { class: "settings-hint" }, t("No machines yet.")) : null,
			...(machines ?? []).map((machine) => this.#card(machine)),
		);
	}

	#card(machine: HostedMachine): HTMLElement {
		const busy = this.#working === machine.machineId;
		const actions =
			machine.state === "deleted" || machine.state === "deleting"
				? []
				: [
						machine.state === "stopped" || machine.state === "stopping"
							? button(t("Wake"), () => void this.#change(machine, "start"), { small: true, disabled: busy })
							: button(t("Stop"), () => void this.#change(machine, "stop"), { small: true, disabled: busy }),
						button(t("Delete"), () => void this.#change(machine, "delete"), {
							small: true,
							danger: true,
							disabled: busy,
						}),
					];
		const state =
			machine.state === "waiting" && machine.queuePosition !== null
				? t("Waiting for room, number {position} in line", { position: machine.queuePosition })
				: t(STATE_TEXT[machine.state]);
		return h(
			"article",
			{ class: "settings-card machine-card", "data-machine": machine.machineId },
			h(
				"div",
				{ class: "settings-copy" },
				h("strong", null, machine.name),
				h("small", null, machine.purpose),
				h(
					"small",
					{ class: "machine-facts" },
					[
						state,
						machine.cpus === 1
							? t("1 CPU, {memory} GB memory, {disk} GB disk", {
									memory: machine.memoryGiB,
									disk: machine.diskGiB,
								})
							: t("{cpus} CPUs, {memory} GB memory, {disk} GB disk", {
									cpus: machine.cpus,
									memory: machine.memoryGiB,
									disk: machine.diskGiB,
								}),
						machine.lifetime === "always-on" ? t("Always on") : null,
						machine.startedBy.name ? t("Started by {name}", { name: machine.startedBy.name }) : null,
						machine.repository ? t("Code from {session}", { session: machine.repository }) : null,
					]
						.filter(Boolean)
						.join(" · "),
				),
				machine.commands.length
					? h(
							"ul",
							{ class: "machine-commands" },
							...machine.commands
								.slice(0, 5)
								.map((command) =>
									h(
										"li",
										null,
										h("code", null, command.command),
										h(
											"small",
											null,
											` ${fmtTime(command.startedAt)} · ${t(COMMAND_TEXT[command.state])}${
												command.state === "failed" && command.exitCode !== null
													? ` (${command.exitCode})`
													: ""
											}`,
										),
									),
								),
						)
					: null,
			),
			h("div", { class: "machine-actions" }, ...actions),
		);
	}
}
