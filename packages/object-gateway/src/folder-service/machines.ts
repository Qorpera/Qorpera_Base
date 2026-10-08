import { isUuid } from "@qorpera/contracts";
import type { BridgeInfo } from "./protocol.ts";

/** A machine on this node, as LXD names it: its project, its name, and `volatile.uuid` (its physical id, which a
 * rebuild or a recreated instance changes). The node's bridge asks LXD which machine has a connection's CID
 * (crates/qorpera-folder/src/lxd.rs) and names it in its first frame; this service never talks to LXD. */
export interface MachineRef {
	readonly project: string;
	readonly name: string;
	readonly physicalId: string;
}

const NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;

export function parseMachineRef(value: unknown): MachineRef {
	const m = value as Record<string, unknown>;
	if (
		!m ||
		typeof m !== "object" ||
		Object.keys(m).length !== 3 ||
		typeof m.project !== "string" ||
		!NAME.test(m.project) ||
		typeof m.name !== "string" ||
		!NAME.test(m.name) ||
		typeof m.physicalId !== "string" ||
		!isUuid(m.physicalId)
	)
		throw new Error("Machine reference must be {project, name, physicalId}");
	return { project: m.project, name: m.name, physicalId: m.physicalId };
}

/** An LXD project's name, as a machine reference has it. */
export function parseMachineProject(value: unknown): string {
	if (typeof value !== "string" || !NAME.test(value)) throw new Error("A machine project is an LXD project's name");
	return value;
}

/** Whether the bridge found exactly this machine behind the connection. */
export function isMachine(bridge: BridgeInfo, machine: MachineRef): boolean {
	return (
		bridge.lookup === "found" &&
		bridge.machine?.project === machine.project &&
		bridge.machine.name === machine.name &&
		bridge.machine.physicalId === machine.physicalId
	);
}
