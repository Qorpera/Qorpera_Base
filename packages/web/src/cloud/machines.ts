import type { Cloud } from "./client.ts";

/**
 * Company machines (runtime 2026-09-28): virtual machines agents start for
 * tests, builds and long jobs. A machine belongs to the company, so every
 * member sees every machine and may stop, wake or delete it
 * (qorpera_list_company_machines, qorpera_member_manage_company_machine).
 */

export type MachineState = "waiting" | "starting" | "running" | "stopping" | "stopped" | "deleting" | "deleted";
const STATES: readonly MachineState[] = [
	"waiting",
	"starting",
	"running",
	"stopping",
	"stopped",
	"deleting",
	"deleted",
];

export interface HostedMachineCommand {
	commandId: string;
	command: string;
	state: "running" | "succeeded" | "failed" | "cancelled" | "lost";
	exitCode: number | null;
	startedAt: string;
	endedAt: string | null;
}

export interface HostedMachine {
	machineId: string;
	name: string;
	purpose: string;
	state: MachineState;
	cpus: number;
	memoryGiB: number;
	diskGiB: number;
	lifetime: "task" | "always-on";
	startedBy: { staffAgentId: string; name: string | null };
	queuePosition: number | null;
	commandsRunning: number;
	repository: string | null;
	createdAt: string;
	commands: HostedMachineCommand[];
}

export interface WebMachines {
	list(): Promise<HostedMachine[]>;
	/** The machines started from one conversation (its thread card). */
	session(sessionId: string): Promise<HostedMachine[]>;
	change(machineId: string, action: "start" | "stop" | "delete"): Promise<void>;
}

function object(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} is invalid.`);
	return value as Record<string, unknown>;
}
function text(value: unknown, label: string): string {
	if (typeof value !== "string") throw new Error(`${label} is invalid.`);
	return value;
}
function count(value: unknown, label: string): number {
	if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`${label} is invalid.`);
	return value as number;
}

function parseCommand(value: unknown): HostedMachineCommand {
	const command = object(value, "Command");
	const state = text(command.state, "Command state");
	if (!["running", "succeeded", "failed", "cancelled", "lost"].includes(state))
		throw new Error("Command state is invalid.");
	return {
		commandId: text(command.commandId, "Command id"),
		command: text(command.command, "Command"),
		state: state as HostedMachineCommand["state"],
		exitCode: typeof command.exitCode === "number" ? command.exitCode : null,
		startedAt: text(command.startedAt, "Command time"),
		endedAt: typeof command.endedAt === "string" ? command.endedAt : null,
	};
}

export function parseMachine(value: unknown): HostedMachine {
	const machine = object(value, "Machine");
	const state = text(machine.state, "Machine state") as MachineState;
	if (!STATES.includes(state)) throw new Error("Machine state is invalid.");
	const startedBy = object(machine.startedBy, "Machine starter");
	if (machine.lifetime !== "task" && machine.lifetime !== "always-on") throw new Error("Machine lifetime is invalid.");
	const repository = machine.repository ? object(machine.repository, "Machine repository") : null;
	return {
		machineId: text(machine.machineId, "Machine id"),
		name: text(machine.name, "Machine name"),
		purpose: text(machine.purpose, "Machine purpose"),
		state,
		cpus: count(machine.cpus, "Machine size"),
		memoryGiB: count(machine.memoryGiB, "Machine size"),
		diskGiB: count(machine.diskGiB, "Machine size"),
		lifetime: machine.lifetime,
		startedBy: {
			staffAgentId: text(startedBy.staffAgentId, "Machine starter"),
			name: typeof startedBy.name === "string" ? startedBy.name : null,
		},
		queuePosition: typeof machine.queuePosition === "number" ? machine.queuePosition : null,
		commandsRunning: count(machine.commandsRunning ?? 0, "Machine commands"),
		repository: repository && typeof repository.title === "string" ? repository.title : null,
		createdAt: text(machine.createdAt, "Machine time"),
		commands: Array.isArray(machine.commands) ? machine.commands.map(parseCommand) : [],
	};
}

export function parseMachines(value: unknown): HostedMachine[] {
	const body = object(value, "Machines");
	if (body.schema !== "qorpera.company-machines/v1" || !Array.isArray(body.machines))
		throw new Error("Machines are invalid.");
	return body.machines.map(parseMachine);
}

export function parseSessionMachines(value: unknown, sessionId: string): HostedMachine[] {
	const body = object(value, "Machines");
	if (body.schema !== "qorpera.session-machines/v1" || body.sessionId !== sessionId || !Array.isArray(body.machines))
		throw new Error("Machines are invalid.");
	return body.machines.map(parseMachine);
}

export function createWebMachines(cloud: Pick<Cloud, "rpc">, profileId: string): WebMachines {
	return {
		list: async () => parseMachines(await cloud.rpc("qorpera_list_company_machines", { p_profile_id: profileId })),
		session: async (sessionId) =>
			parseSessionMachines(await cloud.rpc("qorpera_list_session_machines", { p_session_id: sessionId }), sessionId),
		change: async (machineId, action) => {
			await cloud.rpc("qorpera_member_manage_company_machine", {
				p_profile_id: profileId,
				p_machine_id: machineId,
				p_action: action,
			});
		},
	};
}
