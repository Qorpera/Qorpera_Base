import {
	cloudCompanyAgentDocument,
	createCloudCompanyAgent,
	deleteCloudCompanyAgent,
	writeCloudCompanyAgent,
} from "@qorpera/cloud-client/cloud-company-agent";
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

export interface WebCompanyAgentCreation extends WebCompanyAgentDraft {
	id: string;
	createdAt: string;
}

/** An agent is a document in the Company File. Creating or changing one is a
 * governed File write the cloud projects onto the roster; the browser never
 * writes the roster itself. */
export interface WebCompanyAgents {
	create(draft: WebCompanyAgentCreation, signal: AbortSignal): Promise<string>;
	update(agent: HostedStaffAgent, draft: WebCompanyAgentDraft, signal: AbortSignal): Promise<number>;
	/** Deleting the agent's document removes the agent for good (owner or admin; never the Co-Founder). */
	delete(agent: HostedStaffAgent, signal: AbortSignal): Promise<void>;
}

// The description is the agent's responsibilities in plain prose (founder decision 2026-09-20) and the
// reference it works from. It carries no name, because a rename must not leave a stale one behind, and no
// platform behavior: how an agent without responsibilities behaves belongs to the runtime's hire overlay.
const blankCharter =
	"No responsibilities have been written for this agent yet. Replace this text with what the agent is responsible for, in plain words.";

const firstTurn = "No first assignment was given. Start from your responsibilities.";

function creationAgent(draft: WebCompanyAgentCreation): StaffAgent {
	return {
		id: draft.id,
		displayName: draft.displayName,
		role: draft.role,
		charter: draft.charter || blankCharter,
		appearance: { color: draft.color, shape: "round", creature: draft.figure },
		employmentStatus: "active",
		lifecycleState: "setup",
		createdAt: draft.createdAt,
		updatedAt: draft.createdAt,
	};
}

/** Validate before the view retains an attempt and locks its editable fields. */
export function prepareWebCompanyAgentCreation<T extends WebCompanyAgentDraft>(draft: T): T & WebCompanyAgentCreation {
	const creation = { ...draft, id: crypto.randomUUID(), createdAt: new Date().toISOString() };
	const document = cloudCompanyAgentDocument(creationAgent(creation), 1, firstTurn);
	// The governed text editor limits the complete JSON file, including escapes.
	if (new TextEncoder().encode(JSON.stringify(document)).length > 32 * 1024)
		throw new Error("Company agent document exceeds the text file limit");
	return creation;
}

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
	return {
		async create(draft, signal) {
			const lifetime = AbortSignal.any([files.signal, signal]);
			files.current();
			const editor = await files.files();
			lifetime.throwIfAborted();
			await createCloudCompanyAgent({
				editor,
				agent: creationAgent(draft),
				startupInstructions: firstTurn,
				operationKey: `staff-create:${draft.id}`,
				signal: lifetime,
			});
			files.current();
			return draft.id;
		},
		async update(agent, draft, signal) {
			const lifetime = AbortSignal.any([files.signal, signal]);
			files.current();
			const editor = await files.files();
			lifetime.throwIfAborted();
			const applied = await writeCloudCompanyAgent({
				editor,
				agent: staffAgent(agent, draft),
				operationKey: `staff-update:${agent.id}:${crypto.randomUUID()}`,
				signal: lifetime,
			});
			files.current();
			return applied.agentRevision;
		},
		async delete(agent, signal) {
			const lifetime = AbortSignal.any([files.signal, signal]);
			files.current();
			const editor = await files.files();
			lifetime.throwIfAborted();
			await deleteCloudCompanyAgent({
				editor,
				agentId: agent.id,
				operationKey: `staff-delete:${agent.id}:${crypto.randomUUID()}`,
				signal: lifetime,
			});
			files.current();
		},
	};
}
