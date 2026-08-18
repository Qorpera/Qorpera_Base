import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentTool } from "@qorpera/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@qorpera/pi-ai";
import { readScheduledJobs } from "@qorpera/pi-coding-agent/company-connections";
import {
	activateStaffAgent,
	assessCompanyArtifactSource,
	createStaffAgent,
	createStarterCompanyArtifact,
	readCompanyArtifacts,
	readStaffAgents,
	recordCompanyArtifactObservation,
	transitionCompanyArtifactConnection,
} from "@qorpera/pi-coding-agent/company-staff";
import { describe, expect, it } from "vitest";
import {
	handleCompanyOperationBrokerFrame,
	setCompanyOperationBrokerWriter,
} from "../../coding-agent/src/core/company-operation-broker-client.ts";
import {
	type AssessArtifactSourceToolInput,
	createAssessArtifactSourceTool,
} from "../../coding-agent/src/core/tools/assess-artifact-source.ts";
import {
	type CompleteSetupToolInput,
	createCompleteSetupTool,
} from "../../coding-agent/src/core/tools/complete-setup.ts";
import {
	createManageRoutineTool,
	type ManageRoutineToolInput,
} from "../../coding-agent/src/core/tools/manage-routine.ts";
import { createReadTool } from "../../coding-agent/src/core/tools/read.ts";
import {
	createRecordArtifactObservationTool,
	type RecordArtifactObservationToolInput,
} from "../../coding-agent/src/core/tools/record-artifact-observation.ts";
import {
	createRequestConnectionTool,
	type RequestConnectionToolInput,
} from "../../coding-agent/src/core/tools/request-connection.ts";
import {
	createHarness,
	getAssistantTexts,
	getMessageText,
	getUserTexts,
	type Harness,
} from "../../coding-agent/test/suite/harness.ts";
import { createConnectionRequest, readConnectionRequests } from "../src/connection-requests.ts";
import { applyStaffRoutineOperation } from "../src/staff-routines.ts";
import { listStaffTemplates, type StaffTemplate, type StaffTemplateId } from "../src/staff-templates.ts";

const OBSERVED_AT = "2026-08-16T12:00:00.000Z";
const SOURCE_FILE = "files/conception-source.json";
const SOURCE_REF = `file:${SOURCE_FILE}`;

const PROVIDER_SUGGESTIONS: Readonly<Record<StaffTemplateId, readonly [string, string, ...string[]]>> = Object.freeze({
	"financial-officer": ["Google Sheets", "Xero", "Nordea Open Banking"],
	"marketing-lead": ["Google Analytics", "HubSpot", "Meta Ads"],
	"product-manager": ["Linear", "Jira", "Productboard"],
	"software-developer": ["GitHub", "Sentry", "Linear"],
	"product-designer": ["Figma", "Dovetail", "Google Drive"],
	"legal-expert": ["Google Drive", "DocuSign", "Microsoft SharePoint"],
	"operations-specialist": ["Asana", "Slack", "Google Calendar"],
	"research-lead": ["Google Drive", "Notion", "Zotero"],
	"costumer-relationist": ["Gmail", "Zendesk", "Intercom"],
	"outreaching-conversationalist": ["HubSpot", "Apollo.io", "Gmail"],
});

interface ConceptionContext {
	root: string;
	userData: string;
	agentId: string;
	artifactId: string;
	dataNeedId: string;
	metricIds: string[];
}

interface ConceptionFixture extends ConceptionContext {
	harness: Harness;
	restoreAgentDirectory(): void;
}

function initializeCompany(root: string): void {
	mkdirSync(join(root, ".qorpera"), { recursive: true });
	mkdirSync(join(root, "agents"), { recursive: true });
	mkdirSync(join(root, "files"), { recursive: true });
	writeFileSync(
		join(root, ".qorpera", "company.json"),
		`${JSON.stringify({
			schema: "qorpera.company/v1",
			id: randomUUID(),
			name: "Conception test company",
			createdAt: OBSERVED_AT,
		})}\n`,
		"utf-8",
	);
	writeFileSync(join(root, ".qorpera", "staff.json"), `${JSON.stringify({ version: 1, agents: {} })}\n`, "utf-8");
}

function persistedRequestConnectionTool(
	root: string,
	getContext: () => ConceptionContext,
): ReturnType<typeof createRequestConnectionTool> {
	const tool = createRequestConnectionTool(root);
	return {
		...tool,
		async execute(toolCallId, input: RequestConnectionToolInput, signal, onUpdate) {
			const result = await tool.execute(toolCallId, input, signal, onUpdate);
			const { agentId, userData } = getContext();
			const request = createConnectionRequest(userData, root, {
				staffAgentId: agentId,
				sessionFile: "conception.jsonl",
				...input,
			});
			if (input.artifactId && input.dataNeedId) {
				transitionCompanyArtifactConnection(
					root,
					agentId,
					input.artifactId,
					input.dataNeedId,
					request.id,
					"suggested",
				);
			}
			return result;
		},
	};
}

function persistedArtifactObservationTool(
	root: string,
	getContext: () => ConceptionContext,
): ReturnType<typeof createRecordArtifactObservationTool> {
	const tool = createRecordArtifactObservationTool();
	return {
		...tool,
		async execute(toolCallId, input: RecordArtifactObservationToolInput, signal, onUpdate) {
			const result = await tool.execute(toolCallId, input, signal, onUpdate);
			const { agentId } = getContext();
			recordCompanyArtifactObservation(root, agentId, input.artifactId, {
				dataNeedId: input.dataNeedId,
				sourceRef: input.sourceRef,
				observedAt: input.observedAt,
				metrics: input.metrics,
			});
			return result;
		},
	};
}

function persistedArtifactSourceAssessmentTool(
	root: string,
	getContext: () => ConceptionContext,
): ReturnType<typeof createAssessArtifactSourceTool> {
	const tool = createAssessArtifactSourceTool();
	return {
		...tool,
		async execute(toolCallId, input: AssessArtifactSourceToolInput, signal, onUpdate) {
			const result = await tool.execute(toolCallId, input, signal, onUpdate);
			const { agentId } = getContext();
			const { artifactId, ...update } = input;
			assessCompanyArtifactSource(root, agentId, artifactId, update, "agent");
			return result;
		},
	};
}

function persistedRoutineTool(
	root: string,
	getContext: () => ConceptionContext,
): ReturnType<typeof createManageRoutineTool> {
	const tool = createManageRoutineTool();
	return {
		...tool,
		async execute(toolCallId, input: ManageRoutineToolInput, signal, onUpdate) {
			const result = await tool.execute(toolCallId, input, signal, onUpdate);
			const { agentId } = getContext();
			if (input.action === "upsert_event")
				throw new Error("event trigger builds are outside this conception fixture");
			if (input.action === "upsert_weekly") {
				const weekdays = input.weekdays;
				if (typeof weekdays === "string") {
					throw new Error("the conception fixture requires normalized weekly routine input");
				}
				applyStaffRoutineOperation(root, agentId, { ...input, weekdays });
				return result;
			}
			applyStaffRoutineOperation(root, agentId, input);
			return result;
		},
	};
}

function persistedCompleteSetupTool(
	root: string,
	getContext: () => ConceptionContext,
): ReturnType<typeof createCompleteSetupTool> {
	const tool = createCompleteSetupTool();
	return {
		...tool,
		async execute(toolCallId, input: CompleteSetupToolInput, signal, onUpdate) {
			const result = await tool.execute(toolCallId, input, signal, onUpdate);
			const { agentId } = getContext();
			activateStaffAgent(root, agentId);
			return result;
		},
	};
}

async function createFixture(template: StaffTemplate): Promise<ConceptionFixture> {
	const previousAgentDirectory = process.env.QORPERA_CODING_AGENT_DIR;
	let context: ConceptionContext | undefined;
	let toolNames: string[] = [];
	let harness: Harness;
	const getContext = (): ConceptionContext => {
		if (!context) throw new Error("Conception fixture was used before initialization");
		return context;
	};
	try {
		setCompanyOperationBrokerWriter((frame) => {
			const requestId = (frame as { requestId?: unknown }).requestId;
			if (typeof requestId !== "string") return;
			handleCompanyOperationBrokerFrame({
				type: "qorpera_company_operation_response",
				requestId,
				message: "Host operation persisted.",
			});
		});
		harness = await createHarness({
			systemPrompt: template.charter,
			toolFactory(root) {
				const tools: AgentTool[] = [
					createReadTool(root),
					persistedRequestConnectionTool(root, getContext),
					persistedArtifactSourceAssessmentTool(root, getContext),
					persistedArtifactObservationTool(root, getContext),
					persistedRoutineTool(root, getContext),
					persistedCompleteSetupTool(root, getContext),
				];
				toolNames = tools.map((tool) => tool.name);
				return tools;
			},
		});
		const root = harness.tempDir;
		initializeCompany(root);
		const userData = join(root, ".test-user-data");
		process.env.QORPERA_CODING_AGENT_DIR = join(userData, "agent-home");
		const agent = createStaffAgent(root, {
			displayName: template.name,
			role: template.role,
			charter: template.charter,
			templateId: template.id,
			appearance: { color: template.avatarColorToken, shape: template.avatarShapeToken },
		});
		const artifact = createStarterCompanyArtifact(root, agent.id, template.id, template.starterArtifact);
		context = {
			root,
			userData,
			agentId: agent.id,
			artifactId: artifact.id,
			dataNeedId: artifact.dataNeeds[0]!.id,
			metricIds: artifact.metrics.map((metric) => metric.id),
		};
	} catch (error) {
		setCompanyOperationBrokerWriter(undefined);
		if (previousAgentDirectory === undefined) delete process.env.QORPERA_CODING_AGENT_DIR;
		else process.env.QORPERA_CODING_AGENT_DIR = previousAgentDirectory;
		throw error;
	}
	if (!context) throw new Error("Conception fixture did not initialize");
	await harness.session.setActiveToolsByName(toolNames);
	return {
		...context,
		harness,
		restoreAgentDirectory() {
			setCompanyOperationBrokerWriter(undefined);
			if (previousAgentDirectory === undefined) delete process.env.QORPERA_CODING_AGENT_DIR;
			else process.env.QORPERA_CODING_AGENT_DIR = previousAgentDirectory;
		},
	};
}

function visibleAssistantText(harness: Harness): string {
	return getAssistantTexts(harness)
		.filter((text) => text.trim())
		.join("\n");
}

function toolExecutionNames(harness: Harness): string[] {
	return harness.eventsOfType("tool_execution_start").map((event) => event.toolName);
}

describe.each(listStaffTemplates())("$name conception", (template) => {
	it("uses existing company evidence, creates an agreed routine, and silently becomes active", async () => {
		const fixture = await createFixture(template);
		const { harness } = fixture;
		let providerSetupContext = "";
		writeFileSync(
			join(fixture.root, SOURCE_FILE),
			`${JSON.stringify({ source: "existing company evidence", role: template.id, verified: true })}\n`,
			"utf-8",
		);
		harness.setResponses([
			(context) => {
				providerSetupContext = context.messages
					.filter((message) => message.role === "user")
					.map((message) => getMessageText(message))
					.join("\n");
				return fauxAssistantMessage(fauxToolCall("read", { path: SOURCE_FILE }, { id: `read-${template.id}` }), {
					stopReason: "toolUse",
				});
			},
			fauxAssistantMessage(
				fauxToolCall(
					"assess_artifact_source",
					{
						artifactId: fixture.artifactId,
						dataNeedId: fixture.dataNeedId,
						sourceRef: SOURCE_REF,
						dataType: `${template.name} operating evidence`,
						decision: "authoritative",
						rationale: "The fixture is the canonical company record for the tested measures.",
						metricIds: fixture.metricIds,
						evidence: [SOURCE_REF],
						assessedAt: OBSERVED_AT,
					},
					{ id: `assess-${template.id}` },
				),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage(
				fauxToolCall(
					"record_artifact_observation",
					{
						artifactId: fixture.artifactId,
						dataNeedId: fixture.dataNeedId,
						sourceRef: SOURCE_REF,
						observedAt: OBSERVED_AT,
						metrics: fixture.metricIds.map((id, index) => ({
							id,
							value: `Verified ${template.id} measure ${index + 1}`,
							evidence: [SOURCE_REF],
						})),
					},
					{ id: `observe-${template.id}` },
				),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage(
				`I own ${template.description.toLowerCase()} through the ${template.starterArtifact.title} artifact. I found usable company evidence and measured its starting signals. Are these the right measures for this company?\n\nI can refresh them every Monday and report material changes. Should I make that my weekly routine?`,
			),
			fauxAssistantMessage(
				fauxToolCall(
					"manage_routine",
					{
						action: "upsert",
						routineKey: `${template.id}-weekly-review`,
						title: `${template.name} weekly review`,
						instructions: `Refresh ${template.starterArtifact.title} from company evidence and report material changes.`,
						intervalMinutes: 7 * 24 * 60,
					},
					{ id: `routine-${template.id}` },
				),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage(fauxToolCall("complete_setup", {}, { id: `complete-${template.id}` }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage(`The weekly ${template.starterArtifact.title.toLowerCase()} review is set.`),
		]);

		try {
			await harness.session.sendStaffIntro(template.setupPrompt);
			await harness.session.prompt("Yes. Make that the weekly routine you proposed.");

			expect(providerSetupContext).toBe(template.setupPrompt);
			expect(getUserTexts(harness)).toEqual(["Yes. Make that the weekly routine you proposed."]);
			expect(harness.session.messages[0]).toMatchObject({
				role: "custom",
				customType: "qorpera_staff_intro",
				display: false,
			});
			expect(toolExecutionNames(harness)).toEqual([
				"read",
				"assess_artifact_source",
				"record_artifact_observation",
				"manage_routine",
				"complete_setup",
			]);
			expect(toolExecutionNames(harness)).not.toContain("request_connection");
			const artifact = readCompanyArtifacts(fixture.root).find((candidate) => candidate.id === fixture.artifactId);
			expect(artifact?.dataNeeds.find((need) => need.id === fixture.dataNeedId)).toMatchObject({
				status: "available",
				sourceRefs: [SOURCE_REF],
			});
			expect(artifact?.metrics.every((metric) => metric.status === "measured")).toBe(true);
			expect(readScheduledJobs(fixture.root)).toMatchObject([
				{ staffAgentId: fixture.agentId, effort: "high", enabled: true },
			]);
			expect(readStaffAgents(fixture.root)).toMatchObject([
				{ id: fixture.agentId, lifecycleState: "active", employmentStatus: "active" },
			]);
			expect(visibleAssistantText(harness)).not.toMatch(/running that now|working on that now|files touched:/i);
			expect(harness.getPendingResponseCount()).toBe(0);
		} finally {
			fixture.restoreAgentDirectory();
			harness.cleanup();
		}
	});

	it("proposes one linked source choice and stays in setup when evidence is absent", async () => {
		const fixture = await createFixture(template);
		const suggestions = [...PROVIDER_SUGGESTIONS[template.id]];
		fixture.harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall(
					"request_connection",
					{
						displayName: template.starterArtifact.dataNeeds[0]!.label,
						purpose: `Make ${template.starterArtifact.title} useful for ${template.name}.`,
						destinations: [],
						secretNames: [],
						providerSuggestions: suggestions,
						artifactId: fixture.artifactId,
						dataNeedId: fixture.dataNeedId,
					},
					{ id: `request-${template.id}` },
				),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage(
				`I’m your ${template.name}. I’ll own ${template.description.toLowerCase()} through ${template.starterArtifact.title}. A live source will let me establish its first useful measures. Choose where I should look first below.`,
			),
		]);

		try {
			await fixture.harness.session.sendStaffIntro(template.setupPrompt);

			expect(toolExecutionNames(fixture.harness)).toEqual(["request_connection"]);
			expect(readConnectionRequests(fixture.userData, fixture.root)).toMatchObject([
				{
					staffAgentId: fixture.agentId,
					artifactId: fixture.artifactId,
					dataNeedId: fixture.dataNeedId,
					providerSuggestions: suggestions,
					status: "pending",
					phase: "suggested",
				},
			]);
			const artifact = readCompanyArtifacts(fixture.root).find((candidate) => candidate.id === fixture.artifactId);
			expect(artifact?.dataNeeds.find((need) => need.id === fixture.dataNeedId)).toMatchObject({
				status: "missing",
				connectionRequestId: expect.any(String),
			});
			expect(readScheduledJobs(fixture.root)).toEqual([]);
			expect(readStaffAgents(fixture.root)).toMatchObject([
				{ id: fixture.agentId, lifecycleState: "setup", employmentStatus: "active" },
			]);
			const visible = visibleAssistantText(fixture.harness);
			expect(visible).toContain("Choose where I should look first below.");
			expect(visible).not.toMatch(/access (?:was|has been) requested|approval is pending|waiting for access/i);
			expect(visible).not.toMatch(/running that now|working on that now|files touched:/i);
			expect(fixture.harness.getPendingResponseCount()).toBe(0);
		} finally {
			fixture.restoreAgentDirectory();
			fixture.harness.cleanup();
		}
	});
});
