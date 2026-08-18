import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scaffoldCompany } from "../../src/core/company.ts";
import { COMPANY_CONNECTOR_SCHEMA } from "../../src/core/company-connectors.ts";
import {
	handleCompanyOperationBrokerFrame,
	setCompanyOperationBrokerWriter,
} from "../../src/core/company-operation-broker-client.ts";
import { handleHttpBrokerFrame, setHttpBrokerWriter } from "../../src/core/http-broker-client.ts";
import { createRunConnectorToolDefinition } from "../../src/core/tools/run-connector.ts";

const OWNER_AGENT_ID = "11111111-1111-4111-8111-111111111111";

describe("run_connector", () => {
	let root: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "qorpera-run-connector-"));
		scaffoldCompany(root);
	});

	afterEach(() => {
		setCompanyOperationBrokerWriter(undefined);
		setHttpBrokerWriter(undefined);
		rmSync(root, { recursive: true, force: true });
	});

	function writeConnector(
		implementation: { kind: "company-tool" | "agent-playbook"; entry: string } = {
			kind: "company-tool",
			entry: "connector.mjs",
		},
	): void {
		const directory = join(root, "connectors", "ledger-api");
		mkdirSync(directory, { recursive: true });
		writeFileSync(
			join(directory, "manifest.json"),
			`${JSON.stringify(
				{
					schema: COMPANY_CONNECTOR_SCHEMA,
					id: "ledger-api",
					displayName: "Ledger API",
					purpose: "Read operating ledger balances.",
					ownerAgentId: OWNER_AGENT_ID,
					operations: [
						{
							id: "ledger.read",
							label: "Read ledger",
							description: "Read balances without modifying them.",
							access: "read",
						},
					],
					destinations: [{ host: "api.example.com", note: "Ledger API" }],
					authentication: { kind: "api-key", secretName: "ledger_api", label: "Ledger API key" },
					implementation,
					createdAt: "2026-08-16T00:00:00.000Z",
					updatedAt: "2026-08-16T00:00:00.000Z",
				},
				null,
				2,
			)}\n`,
			"utf-8",
		);
		writeFileSync(
			join(directory, implementation.entry),
			implementation.kind === "company-tool"
				? [
						"const [operation, encodedInput] = process.argv.slice(2);",
						"console.log(JSON.stringify({ operation, input: JSON.parse(encodedInput) }));",
						"",
					].join("\n")
				: "# Agent playbook\n",
			"utf-8",
		);
	}

	async function run(input: Record<string, unknown>) {
		const definition = createRunConnectorToolDefinition(root);
		const execute = definition.execute as unknown as (toolCallId: string, args: unknown) => Promise<unknown>;
		return (await execute("connector-call", input)) as {
			content: Array<{ type: string; text?: string }>;
			details?: {
				connectorId: string;
				operationId: string;
				behaviorPath: string;
				contentHash: string;
				exitCode: number | null;
			};
		};
	}

	it("executes the exact declared operation and records the connector implementation identity", async () => {
		writeConnector();
		const definition = createRunConnectorToolDefinition(root);
		expect(definition.description).toContain("qorpera_program_http_request");
		expect(definition.description).toContain("intentionally blocks direct network access");
		expect(definition.description).toContain("secret://<declared-name>");

		const result = await run({
			connectorId: "ledger-api",
			operationId: "ledger.read",
			input: { account: "operating" },
		});

		expect(result.content[0]?.text).toContain('"operation":"ledger.read"');
		expect(result.content[0]?.text).toContain('"account":"operating"');
		expect(result.details).toMatchObject({
			connectorId: "ledger-api",
			operationId: "ledger.read",
			behaviorPath: "connectors/ledger-api/connector.mjs",
			exitCode: 0,
		});
		expect(result.details?.contentHash).toMatch(/^[a-f0-9]{64}$/);
	});

	it("surfaces bounded connector process output when an operation fails", async () => {
		writeConnector();
		writeFileSync(
			join(root, "connectors", "ledger-api", "connector.mjs"),
			'process.stderr.write("provider rejected the query\\n"); process.exit(1);\n',
			"utf-8",
		);

		await expect(run({ connectorId: "ledger-api", operationId: "ledger.read" })).rejects.toThrow(
			/provider rejected the query[\s\S]*qorpera_program_http_request/,
		);
	});

	it("authorizes program HTTP through the connector grant lane before using the host HTTP broker", async () => {
		writeConnector();
		writeFileSync(
			join(root, "connectors", "ledger-api", "connector.mjs"),
			[
				'import { createInterface } from "node:readline";',
				'console.log(JSON.stringify({ type: "qorpera_program_http_request", requestId: "request-1", method: "GET", url: "https://api.example.com/ledger", headers: { authorization: "Bearer secret://ledger_api" } }));',
				'createInterface({ input: process.stdin }).on("line", (line) => {',
				"  const response = JSON.parse(line);",
				"  console.log(response.error ? response.error : response.body);",
				"  process.exit(response.error ? 1 : 0);",
				"});",
				"",
			].join("\n"),
			"utf-8",
		);
		const companyFrames: Array<Record<string, unknown>> = [];
		setCompanyOperationBrokerWriter((frame) => {
			const record = frame as Record<string, unknown>;
			companyFrames.push(record);
			handleCompanyOperationBrokerFrame({
				type: "qorpera_company_operation_response",
				requestId: record.requestId,
				message: "authorized",
			});
		});
		setHttpBrokerWriter((frame) => {
			const record = frame as Record<string, unknown>;
			handleHttpBrokerFrame({
				type: "qorpera_http_response",
				requestId: record.requestId,
				status: 200,
				headers: {},
				body: '{"balance":325000}',
				bodyBytes: 18,
			});
		});

		const result = await run({ connectorId: "ledger-api", operationId: "ledger.read" });

		expect(result.content[0]?.text).toContain('{"balance":325000}');
		expect(companyFrames).toHaveLength(1);
		expect(companyFrames[0]).toMatchObject({
			kind: "authorize_connector_http",
			input: {
				connectorId: "ledger-api",
				operationId: "ledger.read",
				behaviorPath: "connectors/ledger-api/connector.mjs",
				request: { method: "GET", url: "https://api.example.com/ledger" },
			},
		});
	});

	it("refuses operations the connector did not declare", async () => {
		writeConnector();

		await expect(run({ connectorId: "ledger-api", operationId: "ledger.write" })).rejects.toThrow(
			/does not declare operation ledger\.write/,
		);
	});

	it("does not execute agent playbooks as company programs", async () => {
		writeConnector({ kind: "agent-playbook", entry: "adapter.md" });

		await expect(run({ connectorId: "ledger-api", operationId: "ledger.read" })).rejects.toThrow(
			/agent playbook, not an executable company tool/,
		);
	});
});
