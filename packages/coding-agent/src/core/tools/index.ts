export {
	ASSESS_ARTIFACT_SOURCE_TOOL_NAME,
	type AssessArtifactSourceToolInput,
	createAssessArtifactSourceTool,
	createAssessArtifactSourceToolDefinition,
} from "./assess-artifact-source.ts";
export {
	type BashOperations,
	type BashSpawnContext,
	type BashSpawnHook,
	type BashToolDetails,
	type BashToolInput,
	type BashToolOptions,
	createBashTool,
	createBashToolDefinition,
	createLocalBashOperations,
} from "./bash.ts";
export {
	type CompanyToolDetails,
	type CompanyToolInput,
	type CompanyToolOptions,
	createCompanyTool,
	createCompanyToolDefinition,
} from "./company-tool.ts";
export {
	COMPLETE_SETUP_TOOL_NAME,
	type CompleteSetupToolInput,
	createCompleteSetupTool,
	createCompleteSetupToolDefinition,
} from "./complete-setup.ts";
export {
	COMPUTER_TOOL_NAME,
	type ComputerToolDetails,
	type ComputerToolInput,
	createComputerTool,
	createComputerToolDefinition,
} from "./computer.ts";
export {
	createEditTool,
	createEditToolDefinition,
	type EditOperations,
	type EditToolDetails,
	type EditToolInput,
	type EditToolOptions,
} from "./edit.ts";
export { withFileMutationQueue } from "./file-mutation-queue.ts";
export {
	createFindTool,
	createFindToolDefinition,
	type FindOperations,
	type FindToolDetails,
	type FindToolInput,
	type FindToolOptions,
} from "./find.ts";
export {
	createFinishTriggerBuildTool,
	createFinishTriggerBuildToolDefinition,
	createFinishTriggerCheckTool,
	createFinishTriggerCheckToolDefinition,
	FINISH_TRIGGER_BUILD_TOOL_NAME,
	FINISH_TRIGGER_CHECK_TOOL_NAME,
	type FinishTriggerBuildToolInput,
	type FinishTriggerCheckToolInput,
} from "./finish-trigger-work.ts";
export {
	createGrepTool,
	createGrepToolDefinition,
	type GrepOperations,
	type GrepToolDetails,
	type GrepToolInput,
	type GrepToolOptions,
} from "./grep.ts";
export {
	createHttpRequestTool,
	createHttpRequestToolDefinition,
	type HttpRequestToolDetails,
	type HttpRequestToolInput,
} from "./http-request.ts";
export {
	createLsTool,
	createLsToolDefinition,
	type LsOperations,
	type LsToolDetails,
	type LsToolInput,
	type LsToolOptions,
} from "./ls.ts";
export {
	createManageRoutineTool,
	createManageRoutineToolDefinition,
	MANAGE_ROUTINE_TOOL_NAME,
	type ManageRoutineToolInput,
} from "./manage-routine.ts";
export {
	createMcpTool,
	createMcpToolDefinition,
	MCP_CONFIG_PATH,
	MCP_TOOL_NAME,
	type McpToolDetails,
	type McpToolInput,
} from "./mcp.ts";
export {
	createReadTool,
	createReadToolDefinition,
	type ReadOperations,
	type ReadToolDetails,
	type ReadToolInput,
	type ReadToolOptions,
} from "./read.ts";
export {
	createRecordArtifactObservationTool,
	createRecordArtifactObservationToolDefinition,
	RECORD_ARTIFACT_OBSERVATION_TOOL_NAME,
	type RecordArtifactObservationToolInput,
} from "./record-artifact-observation.ts";
export {
	createReportArtifactSourceIssueTool,
	createReportArtifactSourceIssueToolDefinition,
	REPORT_ARTIFACT_SOURCE_ISSUE_TOOL_NAME,
	type ReportArtifactSourceIssueToolInput,
} from "./report-artifact-source-issue.ts";
export {
	createRequestConnectionTool,
	createRequestConnectionToolDefinition,
	REQUEST_CONNECTION_TOOL_NAME,
	type RequestConnectionToolInput,
} from "./request-connection.ts";
export {
	createRunConnectorTool,
	createRunConnectorToolDefinition,
	RUN_CONNECTOR_TOOL_NAME,
	type RunConnectorToolDetails,
	type RunConnectorToolInput,
} from "./run-connector.ts";
export {
	createSendAgentMessageTool,
	createSendAgentMessageToolDefinition,
	SEND_AGENT_MESSAGE_TOOL_NAME,
	type SendAgentMessageToolInput,
} from "./send-agent-message.ts";
export {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	type TruncationOptions,
	type TruncationResult,
	truncateHead,
	truncateLine,
	truncateTail,
} from "./truncate.ts";
export {
	createWriteTool,
	createWriteToolDefinition,
	type WriteOperations,
	type WriteToolInput,
	type WriteToolOptions,
} from "./write.ts";

import type { AgentTool } from "@qorpera/pi-agent-core";
import type { ToolDefinition } from "../extensions/types.ts";
import { createAssessArtifactSourceTool, createAssessArtifactSourceToolDefinition } from "./assess-artifact-source.ts";
import { type BashToolOptions, createBashTool, createBashToolDefinition } from "./bash.ts";
import { type CompanyToolOptions, createCompanyTool, createCompanyToolDefinition } from "./company-tool.ts";
import { createCompleteSetupTool, createCompleteSetupToolDefinition } from "./complete-setup.ts";
import { createComputerTool, createComputerToolDefinition } from "./computer.ts";
import { createEditTool, createEditToolDefinition, type EditToolOptions } from "./edit.ts";
import { createFindTool, createFindToolDefinition, type FindToolOptions } from "./find.ts";
import {
	createFinishTriggerBuildTool,
	createFinishTriggerBuildToolDefinition,
	createFinishTriggerCheckTool,
	createFinishTriggerCheckToolDefinition,
} from "./finish-trigger-work.ts";
import { createGrepTool, createGrepToolDefinition, type GrepToolOptions } from "./grep.ts";
import { createHttpRequestTool, createHttpRequestToolDefinition } from "./http-request.ts";
import { createLsTool, createLsToolDefinition, type LsToolOptions } from "./ls.ts";
import { createManageRoutineTool, createManageRoutineToolDefinition } from "./manage-routine.ts";
import { createMcpTool, createMcpToolDefinition } from "./mcp.ts";
import { createReadTool, createReadToolDefinition, type ReadToolOptions } from "./read.ts";
import {
	createRecordArtifactObservationTool,
	createRecordArtifactObservationToolDefinition,
} from "./record-artifact-observation.ts";
import {
	createReportArtifactSourceIssueTool,
	createReportArtifactSourceIssueToolDefinition,
} from "./report-artifact-source-issue.ts";
import { createRequestConnectionTool, createRequestConnectionToolDefinition } from "./request-connection.ts";
import { createRunConnectorTool, createRunConnectorToolDefinition } from "./run-connector.ts";
import { createSendAgentMessageTool, createSendAgentMessageToolDefinition } from "./send-agent-message.ts";
import { createWriteTool, createWriteToolDefinition, type WriteToolOptions } from "./write.ts";

export type Tool = AgentTool<any>;
export type ToolDef = ToolDefinition<any, any>;
export type ToolName =
	| "read"
	| "bash"
	| "edit"
	| "write"
	| "grep"
	| "find"
	| "ls"
	| "run_company_tool"
	| "use_computer"
	| "http_request"
	| "request_connection"
	| "run_connector"
	| "assess_artifact_source"
	| "record_artifact_observation"
	| "report_artifact_source_issue"
	| "manage_routine"
	| "complete_setup"
	| "send_agent_message"
	| "finish_trigger_build"
	| "finish_trigger_check"
	| "use_mcp_tool";
export const allToolNames: Set<ToolName> = new Set([
	"read",
	"bash",
	"edit",
	"write",
	"grep",
	"find",
	"ls",
	"run_company_tool",
	"use_computer",
	"http_request",
	"request_connection",
	"run_connector",
	"assess_artifact_source",
	"record_artifact_observation",
	"report_artifact_source_issue",
	"manage_routine",
	"complete_setup",
	"send_agent_message",
	"finish_trigger_build",
	"finish_trigger_check",
	"use_mcp_tool",
]);

export interface ToolsOptions {
	read?: ReadToolOptions;
	bash?: BashToolOptions;
	write?: WriteToolOptions;
	edit?: EditToolOptions;
	grep?: GrepToolOptions;
	find?: FindToolOptions;
	ls?: LsToolOptions;
	run_company_tool?: CompanyToolOptions;
}

export function createToolDefinition(toolName: ToolName, cwd: string, options?: ToolsOptions): ToolDef {
	switch (toolName) {
		case "read":
			return createReadToolDefinition(cwd, options?.read);
		case "bash":
			return createBashToolDefinition(cwd, options?.bash);
		case "edit":
			return createEditToolDefinition(cwd, options?.edit);
		case "write":
			return createWriteToolDefinition(cwd, options?.write);
		case "grep":
			return createGrepToolDefinition(cwd, options?.grep);
		case "find":
			return createFindToolDefinition(cwd, options?.find);
		case "ls":
			return createLsToolDefinition(cwd, options?.ls);
		case "run_company_tool":
			return createCompanyToolDefinition(cwd, options?.run_company_tool);
		case "use_computer":
			return createComputerToolDefinition();
		case "http_request":
			return createHttpRequestToolDefinition();
		case "request_connection":
			return createRequestConnectionToolDefinition(cwd);
		case "run_connector":
			return createRunConnectorToolDefinition(cwd);
		case "assess_artifact_source":
			return createAssessArtifactSourceToolDefinition();
		case "record_artifact_observation":
			return createRecordArtifactObservationToolDefinition();
		case "report_artifact_source_issue":
			return createReportArtifactSourceIssueToolDefinition();
		case "manage_routine":
			return createManageRoutineToolDefinition();
		case "complete_setup":
			return createCompleteSetupToolDefinition();
		case "send_agent_message":
			return createSendAgentMessageToolDefinition();
		case "finish_trigger_build":
			return createFinishTriggerBuildToolDefinition();
		case "finish_trigger_check":
			return createFinishTriggerCheckToolDefinition();
		case "use_mcp_tool":
			return createMcpToolDefinition(cwd);
		default:
			throw new Error(`Unknown tool name: ${toolName}`);
	}
}

export function createTool(toolName: ToolName, cwd: string, options?: ToolsOptions): Tool {
	switch (toolName) {
		case "read":
			return createReadTool(cwd, options?.read);
		case "bash":
			return createBashTool(cwd, options?.bash);
		case "edit":
			return createEditTool(cwd, options?.edit);
		case "write":
			return createWriteTool(cwd, options?.write);
		case "grep":
			return createGrepTool(cwd, options?.grep);
		case "find":
			return createFindTool(cwd, options?.find);
		case "ls":
			return createLsTool(cwd, options?.ls);
		case "run_company_tool":
			return createCompanyTool(cwd, options?.run_company_tool);
		case "use_computer":
			return createComputerTool();
		case "http_request":
			return createHttpRequestTool();
		case "request_connection":
			return createRequestConnectionTool(cwd);
		case "run_connector":
			return createRunConnectorTool(cwd);
		case "assess_artifact_source":
			return createAssessArtifactSourceTool();
		case "record_artifact_observation":
			return createRecordArtifactObservationTool();
		case "report_artifact_source_issue":
			return createReportArtifactSourceIssueTool();
		case "manage_routine":
			return createManageRoutineTool();
		case "complete_setup":
			return createCompleteSetupTool();
		case "send_agent_message":
			return createSendAgentMessageTool();
		case "finish_trigger_build":
			return createFinishTriggerBuildTool();
		case "finish_trigger_check":
			return createFinishTriggerCheckTool();
		case "use_mcp_tool":
			return createMcpTool(cwd);
		default:
			throw new Error(`Unknown tool name: ${toolName}`);
	}
}

export function createCodingToolDefinitions(cwd: string, options?: ToolsOptions): ToolDef[] {
	return [
		createReadToolDefinition(cwd, options?.read),
		createBashToolDefinition(cwd, options?.bash),
		createEditToolDefinition(cwd, options?.edit),
		createWriteToolDefinition(cwd, options?.write),
	];
}

export function createReadOnlyToolDefinitions(cwd: string, options?: ToolsOptions): ToolDef[] {
	return [
		createReadToolDefinition(cwd, options?.read),
		createGrepToolDefinition(cwd, options?.grep),
		createFindToolDefinition(cwd, options?.find),
		createLsToolDefinition(cwd, options?.ls),
	];
}

export function createAllToolDefinitions(cwd: string, options?: ToolsOptions): Record<ToolName, ToolDef> {
	return {
		read: createReadToolDefinition(cwd, options?.read),
		bash: createBashToolDefinition(cwd, options?.bash),
		edit: createEditToolDefinition(cwd, options?.edit),
		write: createWriteToolDefinition(cwd, options?.write),
		grep: createGrepToolDefinition(cwd, options?.grep),
		find: createFindToolDefinition(cwd, options?.find),
		ls: createLsToolDefinition(cwd, options?.ls),
		run_company_tool: createCompanyToolDefinition(cwd, options?.run_company_tool),
		use_computer: createComputerToolDefinition(),
		http_request: createHttpRequestToolDefinition(),
		request_connection: createRequestConnectionToolDefinition(cwd),
		run_connector: createRunConnectorToolDefinition(cwd),
		assess_artifact_source: createAssessArtifactSourceToolDefinition(),
		record_artifact_observation: createRecordArtifactObservationToolDefinition(),
		report_artifact_source_issue: createReportArtifactSourceIssueToolDefinition(),
		manage_routine: createManageRoutineToolDefinition(),
		complete_setup: createCompleteSetupToolDefinition(),
		send_agent_message: createSendAgentMessageToolDefinition(),
		finish_trigger_build: createFinishTriggerBuildToolDefinition(),
		finish_trigger_check: createFinishTriggerCheckToolDefinition(),
		use_mcp_tool: createMcpToolDefinition(cwd),
	};
}

export function createCodingTools(cwd: string, options?: ToolsOptions): Tool[] {
	return [
		createReadTool(cwd, options?.read),
		createBashTool(cwd, options?.bash),
		createEditTool(cwd, options?.edit),
		createWriteTool(cwd, options?.write),
	];
}

export function createReadOnlyTools(cwd: string, options?: ToolsOptions): Tool[] {
	return [
		createReadTool(cwd, options?.read),
		createGrepTool(cwd, options?.grep),
		createFindTool(cwd, options?.find),
		createLsTool(cwd, options?.ls),
	];
}

export function createAllTools(cwd: string, options?: ToolsOptions): Record<ToolName, Tool> {
	return {
		read: createReadTool(cwd, options?.read),
		bash: createBashTool(cwd, options?.bash),
		edit: createEditTool(cwd, options?.edit),
		write: createWriteTool(cwd, options?.write),
		grep: createGrepTool(cwd, options?.grep),
		find: createFindTool(cwd, options?.find),
		ls: createLsTool(cwd, options?.ls),
		run_company_tool: createCompanyTool(cwd, options?.run_company_tool),
		use_computer: createComputerTool(),
		http_request: createHttpRequestTool(),
		request_connection: createRequestConnectionTool(cwd),
		run_connector: createRunConnectorTool(cwd),
		assess_artifact_source: createAssessArtifactSourceTool(),
		record_artifact_observation: createRecordArtifactObservationTool(),
		report_artifact_source_issue: createReportArtifactSourceIssueTool(),
		manage_routine: createManageRoutineTool(),
		complete_setup: createCompleteSetupTool(),
		send_agent_message: createSendAgentMessageTool(),
		finish_trigger_build: createFinishTriggerBuildTool(),
		finish_trigger_check: createFinishTriggerCheckTool(),
		use_mcp_tool: createMcpTool(cwd),
	};
}
