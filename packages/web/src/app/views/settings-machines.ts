import { CloudRpcError } from "../../cloud/client.ts";
import type { HostedMachine, MachineState, WebMachines } from "../../cloud/machines.ts";
import { button, confirmDialog, fmtTime, h, notice, replace } from "../../ui/dom.ts";
import { phrase, t } from "../../ui/preferences.ts";
import { listSkeleton } from "../../ui/skeleton.ts";

/**
 * Settings → Machines: the virtual machines the company's agents started for
 * tests, builds and long jobs. A machine is the company's, so every member
 * sees all of them with what they are for, their size, their state and their
 * recent commands, and may stop, wake or delete any of them. The list is read
 * again while machines change state (and, slower, while commands run), only
 * while this tab is shown; nothing here starts a new machine.
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
/** States that change by themselves soon: the list is read again every few seconds while any is shown. */
const MOVING: readonly MachineState[] = ["waiting", "starting", "stopping", "deleting"];

export class MachinesView {
	readonly el = h("section", { class: "machines" });
	readonly #client: Pick<WebMachines, "list" | "change">;
	readonly #lifetime = new AbortController();
	#machines: HostedMachine[] | undefined;
	/** A failed read; the next good read clears it. */
	#error: string | undefined;
	/** A refused change; it stays until the member acts again. */
	#refused: string | undefined;
	#missing = false;
	readonly #working = new Set<string>();
	#timer: ReturnType<typeof setTimeout> | undefined;
	/** Every read carries the generation it started in; an older answer is dropped. */
	#generation = 0;
	#drawn = "";
	/** A keyboard's place while its button is disabled: it goes back once the button is usable. */
	#focusKey: string | undefined;

	constructor(client: Pick<WebMachines, "list" | "change">, signal: AbortSignal) {
		this.#client = client;
		if (signal.aborted) this.#lifetime.abort();
		else signal.addEventListener("abort", () => this.dispose(), { once: true, signal: this.#lifetime.signal });
		this.#draw();
		void this.#read();
	}

	/** Settings shows this tab again: read now (reading pauses while another tab is shown). */
	shown(): void {
		if (!this.#lifetime.signal.aborted && !this.#missing) void this.#read();
	}

	dispose(): void {
		this.#lifetime.abort();
		clearTimeout(this.#timer);
		this.el.replaceChildren();
		this.el.remove();
	}

	async #read(): Promise<void> {
		clearTimeout(this.#timer);
		this.#timer = undefined;
		const generation = ++this.#generation;
		try {
			const machines = await this.#client.list();
			if (this.#lifetime.signal.aborted || generation !== this.#generation) return;
			this.#machines = machines;
			this.#error = undefined;
		} catch (error) {
			if (this.#lifetime.signal.aborted || generation !== this.#generation) return;
			// Before the machines migration is on this cloud there is nothing to read.
			if (error instanceof CloudRpcError && error.missing) this.#missing = true;
			else this.#error = t("The company's machines could not be read.");
		}
		this.#draw();
		if (this.#missing) return;
		const moving = this.#machines?.some((machine) => MOVING.includes(machine.state));
		const commands = this.#machines?.some((machine) => machine.commandsRunning > 0);
		if (moving || commands)
			this.#timer = setTimeout(
				() => {
					// Hidden behind another Settings tab: wait until it is shown again.
					if (this.el.isConnected) void this.#read();
				},
				moving ? 5000 : 30000,
			);
	}

	async #change(machine: HostedMachine, action: "start" | "stop" | "delete"): Promise<void> {
		const confirmed =
			action === "delete"
				? await confirmDialog(
						t("Delete {name} and its disk? This cannot be undone.", { name: machine.name }),
						t("Delete"),
						true,
						undefined,
						this.#lifetime.signal,
					)
				: action === "stop" && machine.commandsRunning > 0
					? await confirmDialog(
							machine.commandsRunning === 1
								? t("Stop {name}? Its running command stops with it.", { name: machine.name })
								: t("Stop {name}? Its {count} running commands stop with it.", {
										name: machine.name,
										count: machine.commandsRunning,
									}),
							t("Stop"),
							false,
							undefined,
							this.#lifetime.signal,
						)
					: true;
		if (!confirmed || this.#lifetime.signal.aborted) return;
		this.#working.add(machine.machineId);
		this.#refused = undefined;
		this.#draw();
		let failed = false;
		try {
			await this.#client.change(machine.machineId, action);
		} catch {
			failed = true;
		} finally {
			this.#working.delete(machine.machineId);
		}
		if (this.#lifetime.signal.aborted) return;
		// Said after the read that follows, which would otherwise clear it.
		if (failed) this.#refused = t("{name} could not be changed. Try again.", { name: machine.name });
		await this.#read();
	}

	#draw(): void {
		if (this.#lifetime.signal.aborted) return;
		if (this.#missing) {
			replace(
				this.el,
				h("h1", null, t("Machines")),
				notice("neutral", t("Machines are not available on this cloud yet.")),
			);
			return;
		}
		const machines = this.#machines;
		const key = JSON.stringify([machines, this.#error, this.#refused, [...this.#working]]);
		if (key === this.#drawn) return;
		this.#drawn = key;
		// A keyboard on a button stays on it through a redraw, and returns to it when it is usable again.
		const focusKey =
			(this.el.contains(document.activeElement)
				? (document.activeElement as HTMLElement).dataset.focusKey
				: undefined) ?? this.#focusKey;
		replace(
			this.el,
			h("h1", null, t("Machines")),
			h(
				"section",
				{ class: "settings-group machines-list" },
				h(
					"p",
					{ class: "muted" },
					t(
						"Virtual machines your agents start for tests, builds and long jobs. They belong to the company: anyone here can stop, wake or delete them.",
					),
				),
				this.#refused ? notice("danger", this.#refused) : null,
				this.#error
					? h(
							"p",
							{ class: "muted", role: "status" },
							this.#error,
							" ",
							button(t("Try again"), () => void this.#read(), { small: true }),
						)
					: null,
				machines === undefined && !this.#error ? listSkeleton(t("Loading machines")) : null,
				machines?.length === 0 ? h("p", { class: "muted" }, t("No machines yet.")) : null,
				...(machines ?? []).map((machine) => this.#card(machine)),
			),
		);
		if (focusKey) {
			const target = [...this.el.querySelectorAll<HTMLButtonElement>("[data-focus-key]")].find(
				(item) => item.dataset.focusKey === focusKey,
			);
			this.#focusKey = target?.disabled ? focusKey : undefined;
			if (target && !target.disabled) target.focus();
		}
	}

	#card(machine: HostedMachine): HTMLElement {
		const busy = this.#working.has(machine.machineId);
		const action = (label: string, what: "start" | "stop" | "delete", aria: string, danger = false) => {
			const control = button(label, () => void this.#change(machine, what), {
				small: true,
				danger,
				disabled: busy,
			});
			control.setAttribute("aria-label", aria);
			control.dataset.focusKey = `${what}:${machine.machineId}`;
			return control;
		};
		const actions =
			machine.state === "deleted" || machine.state === "deleting"
				? []
				: [
						machine.state === "stopped" || machine.state === "stopping"
							? action(t("Wake"), "start", t("Wake {name}", { name: machine.name }))
							: action(t("Stop"), "stop", t("Stop {name}", { name: machine.name })),
						action(t("Delete"), "delete", t("Delete {name}", { name: machine.name }), true),
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
