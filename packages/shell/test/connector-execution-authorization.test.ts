import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scaffoldCompany } from "@qorpera/pi-coding-agent/company";
import { COMPANY_CONNECTOR_SCHEMA } from "@qorpera/pi-coding-agent/company-connectors";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	beginConnectionRequest,
	completeConnectionRequest,
	createConnectionRequest,
	verifyConnectionRequest,
} from "../src/connection-requests.ts";
import { authorizeConnectorHttpExecution } from "../src/connector-execution-authorization.ts";
import {
	BUILT_IN_GITHUB_CONNECTOR_ID,
	ensureBuiltInGitHubConnector,
	GITHUB_CONNECTION_DESTINATIONS,
} from "../src/github-company-connector.ts";

const OWNER_AGENT_ID = "11111111-1111-4111-8111-111111111111";

describe("connector execution authorization", () => {
	let root: string;
	let userData: string;
	let implementationPath: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "qorpera-connector-execution-"));
		userData = mkdtempSync(join(tmpdir(), "qorpera-connector-execution-state-"));
		scaffoldCompany(root);
		const directory = join(root, "connectors", "ledger-api");
		mkdirSync(directory, { recursive: true });
		implementationPath = join(directory, "connector.mjs");
		writeFileSync(implementationPath, "console.log('ledger');\n", "utf-8");
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
					implementation: { kind: "company-tool", entry: "connector.mjs" },
					createdAt: "2026-08-16T00:00:00.000Z",
					updatedAt: "2026-08-16T00:00:00.000Z",
				},
				null,
				2,
			)}\n`,
			"utf-8",
		);
		const request = createConnectionRequest(userData, root, {
			staffAgentId: OWNER_AGENT_ID,
			sessionFile: "financial-officer.jsonl",
			displayName: "Ledger API",
			purpose: "Read operating ledger balances.",
			destinations: [{ host: "api.example.com", note: "Ledger API" }],
			secretNames: ["ledger_api"],
			recipeId: "company:ledger-api",
		});
		const identity = {
			id: request.id,
			staffAgentId: request.staffAgentId,
			sessionFile: request.sessionFile,
		};
		beginConnectionRequest(userData, root, identity);
		verifyConnectionRequest(userData, root, identity);
		completeConnectionRequest(userData, root, identity, "company:ledger-api");
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
		rmSync(userData, { recursive: true, force: true });
	});

	function authorization(overrides: Record<string, unknown> = {}): Record<string, unknown> {
		return {
			connectorId: "ledger-api",
			operationId: "ledger.read",
			behaviorPath: "connectors/ledger-api/connector.mjs",
			contentHash: createHash("sha256").update(readFileSync(implementationPath)).digest("hex"),
			request: {
				method: "GET",
				url: "https://api.example.com/ledger",
				headers: { authorization: "Bearer secret://ledger_api" },
			},
			...overrides,
		};
	}

	it("uses the completed connection as the exact connector execution grant", () => {
		expect(() => authorizeConnectorHttpExecution(userData, root, authorization())).not.toThrow();
	});

	it("maps the completed native GitHub sign-in to its materialized company connector", () => {
		const installed = ensureBuiltInGitHubConnector(root, OWNER_AGENT_ID);
		const request = createConnectionRequest(userData, root, {
			staffAgentId: OWNER_AGENT_ID,
			sessionFile: "software-developer.jsonl",
			displayName: "GitHub",
			purpose: "Read repository evidence.",
			destinations: GITHUB_CONNECTION_DESTINATIONS.map(([host, note]) => ({ host, note })),
			secretNames: ["github"],
			recipeId: "github",
		});
		const identity = {
			id: request.id,
			staffAgentId: request.staffAgentId,
			sessionFile: request.sessionFile,
		};
		beginConnectionRequest(userData, root, identity);
		verifyConnectionRequest(userData, root, identity);
		completeConnectionRequest(userData, root, identity, "github-native");
		const githubImplementationPath = join(
			root,
			"connectors",
			BUILT_IN_GITHUB_CONNECTOR_ID,
			installed.connector.implementation.entry,
		);

		expect(() =>
			authorizeConnectorHttpExecution(userData, root, {
				connectorId: BUILT_IN_GITHUB_CONNECTOR_ID,
				operationId: "api.get",
				behaviorPath: `connectors/${BUILT_IN_GITHUB_CONNECTOR_ID}/index.js`,
				contentHash: createHash("sha256").update(readFileSync(githubImplementationPath)).digest("hex"),
				request: {
					method: "GET",
					url: "https://api.github.com/repos/Qorpera/Qorpera_Base",
					headers: { authorization: "Bearer secret://github" },
				},
			}),
		).not.toThrow();
	});

	it("refuses destinations and credential references outside the connected manifest", () => {
		expect(() =>
			authorizeConnectorHttpExecution(
				userData,
				root,
				authorization({ request: { method: "GET", url: "https://other.example.com/ledger" } }),
			),
		).toThrow(/did not declare destination/);
		expect(() =>
			authorizeConnectorHttpExecution(
				userData,
				root,
				authorization({
					request: {
						method: "GET",
						url: "https://api.example.com/ledger",
						headers: { authorization: "Bearer secret://other_service" },
					},
				}),
			),
		).toThrow(/did not declare credential reference/);
	});

	it("refuses a claimed code identity that does not match the installed connector", () => {
		expect(() =>
			authorizeConnectorHttpExecution(userData, root, authorization({ contentHash: "0".repeat(64) })),
		).toThrow(/code identity does not match/);
	});
});
