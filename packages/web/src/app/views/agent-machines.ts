import type { MemberCompanyMachine } from "@qorpera/cloud-client/cloud-member-company-computer";
import { fmtTime, h } from "../../ui/dom.ts";
import { t } from "../../ui/preferences.ts";

/** Machines that are on, or on their way on or off, come first. */
const ACTIVE = new Set(["running", "starting", "waiting", "stopping"]);
/** The latest commands shown per machine. */
const SHOWN_COMMANDS = 3;

function stateText(machine: MemberCompanyMachine): string | undefined {
	switch (machine.state) {
		case "running":
			return machine.commandsRunning > 0 ? t("Working") : t("Running");
		case "starting":
			return t("Starting");
		case "waiting":
			return machine.waitingFor === "COMPUTER_HOURS_EXHAUSTED"
				? t("Waiting for computer hours")
				: t("Waiting for room");
		case "stopping":
			return t("Going to sleep");
		case "stopped":
			return t("Asleep");
		case "deleting":
			return t("Being deleted");
		default:
			return undefined;
	}
}

/** The agent's own machines, as the panel lists them: deleted ones left out, active ones first. */
export function agentMachines(machines: MemberCompanyMachine[], agentId: string): MemberCompanyMachine[] {
	const own = machines.filter((machine) => machine.startedByStaffAgentId === agentId && machine.state !== "deleted");
	return [
		...own.filter((machine) => ACTIVE.has(machine.state)),
		...own.filter((machine) => !ACTIVE.has(machine.state)),
	];
}

/**
 * The machines an agent started for its jobs. They have a shell and no screen,
 * so the panel shows what each one is for, whether it is on, and its latest
 * commands instead of a desktop.
 */
export function machineList(machines: MemberCompanyMachine[], name: string): HTMLElement {
	return h(
		"section",
		{ class: "computer-machines", "aria-label": t("{name}'s machines", { name }) },
		h("h3", { class: "computer-machines-title" }, t("Machines")),
		h(
			"ul",
			{ class: "computer-machine-list" },
			machines.map((machine) => {
				const state = stateText(machine);
				const commands = machine.commands.slice(0, SHOWN_COMMANDS);
				return h(
					"li",
					{ class: "computer-machine", dataset: { state: machine.state } },
					h(
						"div",
						{ class: "computer-machine-head" },
						h("span", { class: "computer-machine-dot", "aria-hidden": "true" }),
						h("strong", { class: "computer-machine-name" }, machine.name),
						state && h("span", { class: "computer-machine-state" }, state),
					),
					machine.purpose && h("p", { class: "computer-machine-purpose" }, machine.purpose),
					commands.length > 0 &&
						h(
							"ol",
							{ class: "computer-machine-commands", "aria-label": t("Latest commands") },
							commands.map((command) =>
								h(
									"li",
									{
										dataset: { state: command.state },
										title:
											command.state === "running"
												? t("Running")
												: command.exitCode !== null && command.exitCode !== 0
													? t("Ended with code {code}", { code: String(command.exitCode) })
													: undefined,
									},
									h("code", null, command.command.replace(/\s+/g, " ").trim()),
									h("time", { datetime: command.startedAt }, fmtTime(command.startedAt)),
								),
							),
						),
				);
			}),
		),
	);
}
