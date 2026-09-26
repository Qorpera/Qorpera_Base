/** Immutable VM command grammar. The original boot is create/start; each
 * continuation is stop/start or the governed reset stop/delete/create/start.
 * This only checks shape. Callers must derive every ID from protected history
 * and separately compare every dispatch/settlement in the operation journal. */
export interface LxdOfficeVmLineageCommand {
	commandId: string;
	action: "create" | "start" | "stop" | "delete";
}
/** Supplied only after the immutable external-stop bridge has been checked. */
export interface LxdOfficeOutageVmOrigin {
	kind: "outage";
	startCommandId: string;
	metadataRoot: string;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export function assertLxdOfficeVmLineageCommands(
	commands: readonly LxdOfficeVmLineageCommand[],
	running = false,
	origin?: Pick<LxdOfficeOutageVmOrigin, "kind" | "startCommandId">,
): void {
	if (
		commands.length < (origin ? 1 : 2) ||
		commands.length > 128 ||
		new Set(commands.map((item) => item.commandId)).size !== commands.length
	)
		throw new Error("OFFICE_VM_LINEAGE_UNCONFIRMED");
	if (
		origin &&
		(origin.kind !== "outage" ||
			!UUID.test(origin.startCommandId) ||
			commands[0]?.commandId !== origin.startCommandId ||
			commands[0]?.action !== "start")
	)
		throw new Error("OFFICE_VM_LINEAGE_UNCONFIRMED");
	let state: "absent" | "stopped" | "running" = origin ? "stopped" : "absent";
	for (const [index, command] of commands.entries()) {
		if (!UUID.test(command.commandId) || Object.keys(command).sort().join() !== "action,commandId")
			throw new Error("OFFICE_VM_LINEAGE_UNCONFIRMED");
		if (command.action === "create" && state === "absent") state = "stopped";
		else if (command.action === "start" && state === "stopped") state = "running";
		else if (command.action === "stop" && state === "running") state = "stopped";
		else if (
			command.action === "delete" &&
			state === "stopped" &&
			index > (origin ? 1 : 2) &&
			commands[index - 1].action === "stop"
		)
			state = "absent";
		else throw new Error("OFFICE_VM_LINEAGE_UNCONFIRMED");
	}
	if (running && state !== "running") throw new Error("OFFICE_VM_LINEAGE_UNCONFIRMED");
}
