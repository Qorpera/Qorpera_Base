import type { StaffAgent } from "@qorpera/company/company-staff";
import type { CloudMemberCompanyCommand, CloudMemberCompanyFileClient } from "./cloud-member-company-editor.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export interface CloudCompanyAgentDocument {
	schema: "qorpera.company-agent/v1";
	agentId: string;
	revision: number;
	displayName: string;
	role: string;
	hireOverlay: { charter: string; templateId: string | null };
	appearance: { color: string; shape: string; creature: string | null };
	modelPolicy: { provider: string | null; modelId: string | null };
	reasoningPolicy: { effort: "low" };
	grants: {
		department: string | null;
		projects: string[];
		rooms: string[];
		resources: Array<{
			resourceId: string;
			resourceVersion: string;
			permissions: ["read"] | ["read", "write"];
		}>;
	};
	startupInstructions: string;
	employmentStatus: "active" | "archived";
	lifecycleState: "setup" | "active";
	createdAt: string;
}

type CompanyAgentEditor = Pick<CloudMemberCompanyFileClient, "edit" | "read" | "review">;

function record(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid ${label}`);
	return value as Record<string, unknown>;
}

function exact(value: unknown, label: string, keys: readonly string[]): Record<string, unknown> {
	const input = record(value, label);
	if (Object.keys(input).length !== keys.length || keys.some((key) => !Object.hasOwn(input, key))) {
		throw new Error(`Invalid ${label}`);
	}
	return input;
}

function text(value: unknown, label: string, maximum: number): string {
	if (typeof value !== "string" || !value || value !== value.trim() || Buffer.byteLength(value, "utf8") > maximum) {
		throw new Error(`Invalid ${label}`);
	}
	return value;
}

function optionalText(value: unknown, label: string, maximum: number): string | null {
	return value === null ? null : text(value, label, maximum);
}

function uuidText(value: unknown, label: string): string {
	const result = text(value, label, 36);
	if (!UUID.test(result)) throw new Error(`Invalid ${label}`);
	return result;
}

function uuidArray(value: unknown, label: string, maximum: number): string[] {
	if (!Array.isArray(value) || value.length > maximum) throw new Error(`Invalid ${label}`);
	const result = value.map((item) => uuidText(item, label));
	if (new Set(result).size !== result.length) throw new Error(`Invalid ${label}`);
	return result;
}

export function cloudCompanyAgentPath(agentId: string): string {
	if (!UUID.test(agentId)) throw new Error("Invalid company agent identity");
	return `organization/agents/${agentId}.json`;
}

export function parseCloudCompanyAgentDocument(value: unknown): CloudCompanyAgentDocument {
	const input = exact(value, "company agent document", [
		"schema",
		"agentId",
		"revision",
		"displayName",
		"role",
		"hireOverlay",
		"appearance",
		"modelPolicy",
		"reasoningPolicy",
		"grants",
		"startupInstructions",
		"employmentStatus",
		"lifecycleState",
		"createdAt",
	]);
	if (
		input.schema !== "qorpera.company-agent/v1" ||
		typeof input.agentId !== "string" ||
		!UUID.test(input.agentId) ||
		!Number.isSafeInteger(input.revision) ||
		(input.revision as number) < 1 ||
		(input.employmentStatus !== "active" && input.employmentStatus !== "archived") ||
		(input.lifecycleState !== "setup" && input.lifecycleState !== "active") ||
		typeof input.createdAt !== "string" ||
		!Number.isFinite(Date.parse(input.createdAt))
	) {
		throw new Error("Invalid company agent document");
	}
	const hire = exact(input.hireOverlay, "company agent hire overlay", ["charter", "templateId"]);
	const appearance = exact(input.appearance, "company agent appearance", ["color", "shape", "creature"]);
	const model = exact(input.modelPolicy, "company agent model policy", ["provider", "modelId"]);
	const reasoning = exact(input.reasoningPolicy, "company agent reasoning policy", ["effort"]);
	const grants = exact(input.grants, "company agent grants", ["department", "projects", "rooms", "resources"]);
	const provider = optionalText(model.provider, "company agent model provider", 128);
	const modelId = optionalText(model.modelId, "company agent model id", 256);
	if ((provider === null) !== (modelId === null) || reasoning.effort !== "low") {
		throw new Error("Invalid company agent policy");
	}
	const department = grants.department === null ? null : uuidText(grants.department, "company agent department grant");
	const projects = uuidArray(grants.projects, "company agent project grants", 128);
	const rooms = uuidArray(grants.rooms, "company agent room grants", 128);
	if (!Array.isArray(grants.resources) || grants.resources.length > 256) {
		throw new Error("Invalid company agent resource grants");
	}
	const resources = grants.resources.map((value) => {
		const item = exact(value, "company agent resource grant", ["resourceId", "resourceVersion", "permissions"]);
		if (
			!Array.isArray(item.permissions) ||
			(item.permissions.length !== 1 && item.permissions.length !== 2) ||
			item.permissions[0] !== "read" ||
			(item.permissions.length === 2 && item.permissions[1] !== "write")
		) {
			throw new Error("Invalid company agent resource grant");
		}
		return {
			resourceId: uuidText(item.resourceId, "company agent resource grant identity"),
			resourceVersion: uuidText(item.resourceVersion, "company agent resource grant version"),
			permissions: item.permissions.length === 1 ? (["read"] as ["read"]) : (["read", "write"] as ["read", "write"]),
		};
	});
	if (new Set(resources.map((resource) => resource.resourceId)).size !== resources.length) {
		throw new Error("Invalid company agent resource grants");
	}
	return {
		schema: input.schema,
		agentId: input.agentId,
		revision: input.revision as number,
		displayName: text(input.displayName, "company agent display name", 160),
		role: text(input.role, "company agent role", 320),
		hireOverlay: {
			charter: text(hire.charter, "company agent charter", 32 * 1024),
			templateId: optionalText(hire.templateId, "company agent template", 256),
		},
		appearance: {
			color: text(appearance.color, "company agent color", 64),
			shape: text(appearance.shape, "company agent shape", 64),
			creature: optionalText(appearance.creature, "company agent creature", 64),
		},
		modelPolicy: { provider, modelId },
		reasoningPolicy: { effort: "low" },
		grants: {
			department,
			projects,
			rooms,
			resources,
		},
		startupInstructions: text(input.startupInstructions, "company agent startup instructions", 16 * 1024),
		employmentStatus: input.employmentStatus,
		lifecycleState: input.lifecycleState,
		createdAt: input.createdAt,
	};
}

export function cloudCompanyAgentDocument(
	agent: StaffAgent,
	revision: number,
	startupInstructions: string,
	grants: CloudCompanyAgentDocument["grants"] = {
		department: null,
		projects: [],
		rooms: [],
		resources: [],
	},
): CloudCompanyAgentDocument {
	return parseCloudCompanyAgentDocument({
		schema: "qorpera.company-agent/v1",
		agentId: agent.id,
		revision,
		displayName: agent.displayName,
		role: agent.role,
		hireOverlay: { charter: agent.charter, templateId: agent.templateId ?? null },
		appearance: {
			color: agent.appearance.color,
			shape: agent.appearance.shape,
			creature: agent.appearance.creature ?? null,
		},
		modelPolicy: agent.model
			? { provider: agent.model.provider, modelId: agent.model.modelId }
			: { provider: null, modelId: null },
		reasoningPolicy: { effort: "low" },
		grants,
		startupInstructions,
		employmentStatus: agent.employmentStatus,
		lifecycleState: agent.lifecycleState,
		createdAt: agent.createdAt,
	});
}

async function applied(
	editor: CompanyAgentEditor,
	command: CloudMemberCompanyCommand,
	signal: AbortSignal,
): Promise<CloudMemberCompanyCommand> {
	let result = command;
	if (result.state === "review_required") {
		const reviewed = await editor.review(result, "approve", signal);
		if (!("commandId" in reviewed)) throw new Error("Company agent review changed kind");
		result = reviewed;
	}
	if (result.state !== "applied" || !result.result) {
		throw new Error("Company agent lifecycle operation did not apply");
	}
	return result;
}

export async function writeCloudCompanyAgent(options: {
	editor: CompanyAgentEditor;
	agent: StaffAgent;
	startupInstructions?: string;
	operationKey: string;
	signal: AbortSignal;
}): Promise<CloudMemberCompanyCommand> {
	const path = cloudCompanyAgentPath(options.agent.id);
	const current = await options.editor.read(path, options.signal);
	let revision = 1;
	let startupInstructions = options.startupInstructions;
	let grants: CloudCompanyAgentDocument["grants"] = {
		department: null,
		projects: [],
		rooms: [],
		resources: [],
	};
	if (current.kind === "file") {
		const document = parseCloudCompanyAgentDocument(JSON.parse(current.text));
		if (document.agentId !== options.agent.id || document.createdAt !== options.agent.createdAt) {
			throw new Error("Company agent identity changed");
		}
		revision = document.revision + 1;
		startupInstructions ??= document.startupInstructions;
		grants = document.grants;
	} else if (current.kind !== "absent") {
		throw new Error("Company agent path is not a file");
	}
	if (!startupInstructions) throw new Error("Company agent startup instructions are required");
	const document = cloudCompanyAgentDocument(options.agent, revision, startupInstructions, grants);
	return applied(
		options.editor,
		await options.editor.edit(
			{
				operation: "write",
				operationKey: options.operationKey,
				path,
				expectedVersion: current.version,
				text: JSON.stringify(document),
			},
			options.signal,
		),
		options.signal,
	);
}

export async function deleteCloudCompanyAgent(options: {
	editor: CompanyAgentEditor;
	agentId: string;
	operationKey: string;
	signal: AbortSignal;
}): Promise<CloudMemberCompanyCommand> {
	const path = cloudCompanyAgentPath(options.agentId);
	const current = await options.editor.read(path, options.signal);
	if (current.kind === "absent") throw new Error("Company agent is already permanently deleted");
	if (
		current.kind !== "file" ||
		parseCloudCompanyAgentDocument(JSON.parse(current.text)).agentId !== options.agentId
	) {
		throw new Error("Company agent identity changed");
	}
	return applied(
		options.editor,
		await options.editor.edit(
			{
				operation: "delete",
				operationKey: options.operationKey,
				path,
				expectedVersion: current.version,
			},
			options.signal,
		),
		options.signal,
	);
}
