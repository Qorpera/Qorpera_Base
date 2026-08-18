import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@qorpera/pi-ai";
import { Check } from "typebox/value";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Authority, type AuthorityConfig, classifyToolCall } from "../../src/core/authority.ts";
import {
	handleCompanyOperationBrokerFrame,
	setCompanyOperationBrokerWriter,
} from "../../src/core/company-operation-broker-client.ts";
import { allToolNames, createToolDefinition } from "../../src/core/tools/index.ts";
import {
	createRequestConnectionTool,
	REQUEST_CONNECTION_TOOL_NAME,
	type RequestConnectionToolInput,
} from "../../src/index.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

const request: RequestConnectionToolInput = {
	displayName: "GitHub",
	purpose: "Review pull requests and prepare releases.",
	destinations: [{ host: "api.github.com", note: "GitHub API" }, { host: "uploads.github.com" }],
	secretNames: ["github_token"],
	recipeId: "github:oauth-v1",
	artifactId: "customer-health",
	dataNeedId: "support-inbox",
};

const suggestedRequest: RequestConnectionToolInput = {
	displayName: "Financial records",
	purpose: "Read balances and transactions for the financial health artifact.",
	destinations: [],
	secretNames: [],
	providerSuggestions: ["Google Sheets", "Nordea Open Banking", "Xero", "QuickBooks"],
	artifactId: "financial-health",
	dataNeedId: "financial-ledger",
};

describe("request_connection tool", () => {
	const harnesses: Harness[] = [];
	const roots: string[] = [];

	beforeEach(() => {
		setCompanyOperationBrokerWriter((frame) => {
			const requestId = (frame as { requestId?: unknown }).requestId;
			if (typeof requestId !== "string") return;
			handleCompanyOperationBrokerFrame({
				type: "qorpera_company_operation_response",
				requestId,
				message: "Source choice proposal persisted.",
			});
		});
	});

	afterEach(() => {
		setCompanyOperationBrokerWriter(undefined);
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
		while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
	});

	it("is a bounded built-in proposal and exact-retry operation with no default authority effect", () => {
		const definition = createToolDefinition(REQUEST_CONNECTION_TOOL_NAME, process.cwd());
		expect(allToolNames.has(REQUEST_CONNECTION_TOOL_NAME)).toBe(true);
		expect(definition.description).toContain("already-ready read connection");
		expect(definition.description).toContain("ready company mailbox");
		expect(definition.description).toContain("ask one brief ordinary-language question");
		expect(definition.description).toContain("Gmail or Outlook Email proposal");
		expect(definition.description).toContain("never link mail to the data need unless email itself");
		expect(definition.description).toContain("reuses that durable selection");
		expect(definition.description).toContain("any scope change remains a new proposal");
		expect(definition.description).toContain("qorpera_program_http_request");
		expect(definition.description).toContain("intentionally blocks direct network access");
		expect(definition.promptSnippet).toContain("uncertainty never justifies guessed providers");
		expect(definition.promptSnippet).toContain("unlinked read-only mail discovery choice");
		expect(Check(definition.parameters, request)).toBe(true);
		expect(Check(definition.parameters, suggestedRequest)).toBe(true);
		expect(Check(definition.parameters, { ...suggestedRequest, providerSuggestions: ["Google Sheets"] })).toBe(false);
		expect(Check(definition.parameters, { ...request, secretValue: "must-not-enter-the-request" })).toBe(false);
		expect(Check(definition.parameters, { ...request, purpose: "x".repeat(1_001) })).toBe(false);
		const incomplete = { ...request };
		delete incomplete.dataNeedId;
		expect(Check(definition.parameters, incomplete)).toBe(true);
		expect(
			Check(definition.parameters, { ...request, destinations: Array(33).fill({ host: "api.example.com" }) }),
		).toBe(false);

		const authority: Authority = { root: process.cwd(), configPath: `${process.cwd()}/authority.toml` };
		const config: AuthorityConfig = {
			classes: {
				money: { mode: "gate" },
				identity: { mode: "gate" },
				irreversible: { mode: "gate" },
				authority: { mode: "gate" },
			},
			tools: {},
		};
		expect(classifyToolCall(authority, config, REQUEST_CONNECTION_TOOL_NAME, request, process.cwd())).toBeUndefined();
		expect(
			classifyToolCall(
				authority,
				{ ...config, tools: { [REQUEST_CONNECTION_TOOL_NAME]: "identity" } },
				REQUEST_CONNECTION_TOOL_NAME,
				request,
				process.cwd(),
			),
		).toBe("identity");
	});

	it("rejects semantic duplicates and extra credential fields on direct execution", async () => {
		const tool = createRequestConnectionTool();
		await expect(
			tool.execute("request-call-extra", { ...request, token: "raw-secret" } as RequestConnectionToolInput),
		).rejects.toThrow("bounded single-line");
		await expect(
			tool.execute("request-call-host", {
				...request,
				destinations: [{ host: "api.github.com" }, { host: "API.GITHUB.COM" }],
			}),
		).rejects.toThrow("unique exact HTTPS hosts");
		await expect(
			tool.execute("request-call-secret", { ...request, secretNames: ["github", "GITHUB"] }),
		).rejects.toThrow("unique reference names");
		await expect(
			tool.execute("request-call-artifact", {
				...request,
				dataNeedId: undefined,
			}),
		).rejects.toThrow("bounded single-line");
		await expect(
			tool.execute("request-call-suggestions", {
				...suggestedRequest,
				providerSuggestions: ["Google Sheets", "google sheets"],
			}),
		).rejects.toThrow("concrete unique service names");
		await expect(
			tool.execute("request-call-recipe-suggestions", {
				...request,
				providerSuggestions: ["Google Sheets", "Nordea Open Banking"],
			}),
		).rejects.toThrow("bounded single-line");
	});

	it("rejects a company recipe until its manifest is valid and exactly matched", async () => {
		const root = mkdtempSync(join(tmpdir(), "qorpera-request-connection-"));
		roots.push(root);
		const connectorDirectory = join(root, "connectors", "google-sheets");
		mkdirSync(connectorDirectory, { recursive: true });
		writeFileSync(join(connectorDirectory, "index.js"), "export async function run() { return {}; }\n", "utf-8");
		const manifest = {
			schema: "qorpera.connector/v1",
			id: "google-sheets",
			displayName: "Google Sheets Read-Only",
			purpose: "Read private spreadsheet values.",
			ownerAgentId: "11111111-1111-4111-8111-111111111111",
			operations: [
				{
					id: "read-values",
					label: "Read values",
					description: "Read private spreadsheet values.",
					access: "read",
				},
			],
			destinations: [
				{ host: "accounts.google.com" },
				{ host: "oauth2.googleapis.com" },
				{ host: "sheets.googleapis.com" },
			],
			authentication: {
				kind: "oauth2",
				secretName: "google_sheets_oauth",
				label: "Google Sheets account",
				authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
				tokenUrl: "https://oauth2.googleapis.com/token",
				clientId: "desktop-client-id",
				scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
				clientSecretLabel: "Google OAuth client secret",
				clientSecretName: "google_sheets_client_secret",
				clientAuthentication: { kind: "body" },
			},
			implementation: { kind: "company-tool", entry: "index.js" },
			createdAt: "2026-08-16T17:00:00.000Z",
			updatedAt: "2026-08-16T17:00:00.000Z",
		};
		writeFileSync(join(connectorDirectory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf-8");
		const companyRequest: RequestConnectionToolInput = {
			displayName: manifest.displayName,
			purpose: manifest.purpose,
			destinations: manifest.destinations,
			secretNames: ["google_sheets_oauth", "google_sheets_client_secret"],
			recipeId: "company:google-sheets",
		};
		const tool = createRequestConnectionTool(root);
		await expect(tool.execute("valid-company-recipe", companyRequest)).resolves.toMatchObject({
			content: [{ type: "text", text: "Source choice proposal persisted." }],
		});

		writeFileSync(
			join(connectorDirectory, "manifest.json"),
			`${JSON.stringify(
				{
					...manifest,
					authentication: { ...manifest.authentication, clientAuthentication: "body" },
				},
				null,
				2,
			)}\n`,
			"utf-8",
		);
		await expect(tool.execute("invalid-company-recipe", companyRequest)).rejects.toThrow(
			"missing, invalid, or does not exactly match",
		);
	});

	it("emits the exact standard lifecycle args and returns a neutral result", async () => {
		const harness = await createHarness({ initialActiveToolNames: [REQUEST_CONNECTION_TOOL_NAME] });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall(REQUEST_CONNECTION_TOOL_NAME, request, { id: "request-call-1" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("I will continue with work that does not need the connection."),
		]);

		await harness.session.prompt("Prepare the release and ask for anything you need.");

		expect(harness.eventsOfType("tool_execution_start")).toContainEqual({
			type: "tool_execution_start",
			toolCallId: "request-call-1",
			toolName: REQUEST_CONNECTION_TOOL_NAME,
			args: request,
		});
		const end = harness.eventsOfType("tool_execution_end").find((event) => event.toolCallId === "request-call-1");
		expect(end).toMatchObject({
			type: "tool_execution_end",
			toolCallId: "request-call-1",
			toolName: REQUEST_CONNECTION_TOOL_NAME,
			isError: false,
		});
		const resultText = harness.session.messages
			.filter((message) => message.role === "toolResult")
			.map(getMessageText)
			.join("\n");
		expect(resultText).toBe("Source choice proposal persisted.");
	});
});
