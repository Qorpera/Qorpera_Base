import { writeCloudCompanyAgent } from "@qorpera/cloud-client/cloud-company-agent";
import type { StaffAgent } from "@qorpera/company/company-staff";
import type { WebCompanyFiles } from "./company-files.ts";
import type { HostedStaffAgent } from "./types.ts";

/** What a member can change about an agent from the browser. */
export interface WebCompanyAgentDraft {
	displayName: string;
	role: string;
	charter: string;
	figure: string;
	color: string;
}

/** An agent is a document in the Company File. Creating or changing one is a
 * governed File write the cloud projects onto the roster; the browser never
 * writes the roster itself. */
export interface WebCompanyAgents {
	create(draft: WebCompanyAgentDraft, signal: AbortSignal): Promise<string>;
	update(agent: HostedStaffAgent, draft: WebCompanyAgentDraft, signal: AbortSignal): Promise<void>;
}

const blankCharter = (name: string) =>
	[
		`You are ${name}, a durable agent working over this company's files.`,
		"Your role is intentionally unconfigured. Do not invent a specialty or claim ownership until a member defines what they want you around for.",
		"On the first turn, introduce yourself briefly and ask one direct question about the responsibility the member wants you to own. Then turn their answer into a durable working role and a concrete first outcome.",
		"Inspect available company context before asking for access. Request only the exact service needed inside the conversation, and never claim access or completion you cannot verify.",
	].join(" ");

const firstTurn = (name: string) =>
	`This is the private first turn for ${name}; never quote or mention it. Introduce yourself as a persistent coworker seeking a durable area of responsibility, not as an answer service. Ask what outcome, function or measure the member wants you to own, without inventing a specialty. Lead one decision at a time. After they answer, read the Company File context you need to begin, ask what else matters in that responsibility, and offer recurring work once you can start doing the job.`;

function staffAgent(agent: HostedStaffAgent, draft: WebCompanyAgentDraft): StaffAgent {
	return {
		id: agent.id,
		displayName: draft.displayName,
		role: draft.role,
		charter: draft.charter || agent.charter,
		...(agent.templateId ? { templateId: agent.templateId } : {}),
		...(agent.departmentId ? { departmentId: agent.departmentId } : {}),
		appearance: { color: draft.color, shape: agent.appearance.shape, creature: draft.figure },
		...(agent.model ? { model: agent.model } : {}),
		employmentStatus: agent.employmentStatus,
		lifecycleState: agent.lifecycleState,
		createdAt: agent.createdAt,
		updatedAt: agent.updatedAt,
	};
}

export function createWebCompanyAgents(files: WebCompanyFiles): WebCompanyAgents {
	const write = async (
		agent: StaffAgent,
		kind: "create" | "update",
		startup: string | undefined,
		signal: AbortSignal,
	) => {
		const lifetime = AbortSignal.any([files.signal, signal]);
		files.current();
		const editor = await files.files();
		lifetime.throwIfAborted();
		await writeCloudCompanyAgent({
			editor,
			agent,
			...(startup ? { startupInstructions: startup } : {}),
			operationKey: `staff-${kind}:${agent.id}:${crypto.randomUUID()}`,
			signal: lifetime,
		});
		files.current();
	};
	return {
		async create(draft, signal) {
			const now = new Date().toISOString();
			const id = crypto.randomUUID();
			await write(
				{
					id,
					displayName: draft.displayName,
					role: draft.role,
					charter: draft.charter || blankCharter(draft.displayName),
					appearance: { color: draft.color, shape: "round", creature: draft.figure },
					employmentStatus: "active",
					lifecycleState: "setup",
					createdAt: now,
					updatedAt: now,
				},
				"create",
				firstTurn(draft.displayName),
				signal,
			);
			return id;
		},
		async update(agent, draft, signal) {
			await write(staffAgent(agent, draft), "update", undefined, signal);
		},
	};
}
