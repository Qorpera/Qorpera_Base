import { join } from "node:path";
import type { CompanyComputerBootIntentRequest } from "@qorpera/contracts";
import type { LxdOfficeCreationIdentity } from "./lxd-office-creation-journal.ts";
import { readRecord } from "./lxd-office-journal-files.ts";
import { readLxdOfficePowerOffEvidence } from "./lxd-office-power-off-evidence.ts";
import { readLxdOfficeResumeEvidence } from "./lxd-office-resume-evidence.ts";

/** Historical boot proof only. The complete sequence must still match the
 * current journal; an earlier prefix never authorizes a later VM effect. */
export async function readLxdOfficeBootVmEvidence(
	root: string,
	creation: LxdOfficeCreationIdentity,
	request: CompanyComputerBootIntentRequest,
	signal: AbortSignal,
) {
	const shutdown = await readLxdOfficePowerOffEvidence(root, creation, request, signal),
		resume = await readLxdOfficeResumeEvidence(
			creation,
			request,
			(name, limit = 65536) => readRecord(join(root, name), limit),
			signal,
		);
	if (
		resume.powerOffRequestSha256 !== shutdown.seedSha256 ||
		resume.observation.hostBootId !== shutdown.hostBootId ||
		shutdown.bootIds.includes(resume.observation.bootId) ||
		shutdown.commands.some((command) => command.commandId === resume.observation.startCommandId) ||
		shutdown.commands.length >= 128
	)
		throw new Error("boot VM predecessor differs");
	return {
		...resume,
		shutdown,
		commands: [...shutdown.commands, { commandId: resume.observation.startCommandId, action: "start" as const }],
	};
}
