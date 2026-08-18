/** Execute one declared operation from a company-owned connector manifest. */

import type { AgentTool } from "@qorpera/pi-agent-core";
import { type Static, Type } from "typebox";
import { readCompanyConnectorManifests } from "../company-connectors.ts";
import { brokeredCompanyOperation } from "../company-operation-broker-client.ts";
import type { ToolDefinition } from "../extensions/types.ts";
import { createCompanyTool } from "./company-tool.ts";
import { COMPANY_CONNECTOR_RUNTIME_CONTRACT } from "./connector-runtime-contract.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

export const RUN_CONNECTOR_TOOL_NAME = "run_connector";

const runConnectorSchema = Type.Object(
	{
		connectorId: Type.String({
			minLength: 1,
			maxLength: 128,
			pattern: "^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$",
		}),
		operationId: Type.String({
			minLength: 1,
			maxLength: 128,
			pattern: "^[a-z0-9][a-z0-9._:-]{0,127}$",
		}),
		input: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
	},
	{ additionalProperties: false },
);

export type RunConnectorToolInput = Static<typeof runConnectorSchema>;

export interface RunConnectorToolDetails {
	connectorId: string;
	operationId: string;
	behaviorPath: string;
	contentHash: string;
	exitCode: number | null;
	durationMs: number;
}

export function createRunConnectorToolDefinition(
	cwd: string,
): ToolDefinition<typeof runConnectorSchema, RunConnectorToolDetails | undefined> {
	return {
		name: RUN_CONNECTOR_TOOL_NAME,
		label: "run connector",
		description: `Run one read or write operation declared by an installed company connector. Use only manifests listed in your company context. Missing destination or credential bindings fail without exposing secret values. Prefer this over bash for connector work because the exact connector code identity is recorded. ${COMPANY_CONNECTOR_RUNTIME_CONTRACT}`,
		promptSnippet: "Run a declared operation from an installed company connector",
		parameters: runConnectorSchema,
		async execute(toolCallId, input: RunConnectorToolInput, signal?: AbortSignal) {
			const connector = readCompanyConnectorManifests(cwd).find((candidate) => candidate.id === input.connectorId);
			if (!connector) throw new Error(`Unknown or invalid company connector: ${input.connectorId}`);
			const operation = connector.operations.find((candidate) => candidate.id === input.operationId);
			if (!operation) {
				throw new Error(`Connector ${connector.id} does not declare operation ${input.operationId}`);
			}
			if (connector.implementation.kind !== "company-tool") {
				throw new Error(
					`Connector ${connector.id} is an agent playbook, not an executable company tool; inspect ${connector.relativePath} and its implementation entry`,
				);
			}
			const result = await createCompanyTool(cwd, {
				authorizeProgramHttp: async (authorization) => {
					await brokeredCompanyOperation(
						"authorize_connector_http",
						{
							connectorId: connector.id,
							operationId: operation.id,
							...authorization,
						},
						signal,
					);
				},
			}).execute(
				toolCallId,
				{
					path: `connectors/${connector.id}/${connector.implementation.entry}`,
					args: [operation.id, JSON.stringify(input.input ?? {})],
				},
				signal,
			);
			if (
				!result.details ||
				result.details.exitCode !== 0 ||
				result.details.timedOut ||
				result.details.interrupted
			) {
				const output = result.content
					.flatMap((item) => (item.type === "text" ? [item.text] : []))
					.join("\n")
					.trim()
					.slice(0, 4_000);
				throw new Error(
					[
						`Connector ${connector.id} operation ${operation.id} failed.`,
						output,
						"Company connector programs receive neither direct network access nor credential environment variables; use the qorpera_program_http_request broker frames described by run_connector.",
					]
						.filter(Boolean)
						.join("\n"),
				);
			}
			return {
				content: result.content,
				details: {
					connectorId: connector.id,
					operationId: operation.id,
					behaviorPath: result.details.behaviorPath,
					contentHash: result.details.contentHash,
					exitCode: result.details.exitCode,
					durationMs: result.details.durationMs,
				},
			};
		},
	};
}

export function createRunConnectorTool(cwd: string): AgentTool<typeof runConnectorSchema> {
	return wrapToolDefinition(createRunConnectorToolDefinition(cwd));
}
