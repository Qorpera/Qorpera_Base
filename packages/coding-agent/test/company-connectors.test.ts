import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	COMPANY_CONNECTOR_SCHEMA,
	companyConnectorMatchesRequest,
	companyConnectorSecretNames,
	readCompanyConnectorManifests,
} from "../src/core/company-connectors.ts";

const OWNER_AGENT_ID = "11111111-1111-4111-8111-111111111111";

describe("company connector manifests", () => {
	let root: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "qorpera-company-connectors-"));
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	function writeConnector(id: string, overrides: Record<string, unknown> = {}): void {
		const directory = join(root, "connectors", id);
		mkdirSync(directory, { recursive: true });
		writeFileSync(
			join(directory, "adapter.md"),
			"# Adapter\n\nUse http_request with the bound capability.\n",
			"utf-8",
		);
		writeFileSync(
			join(directory, "manifest.json"),
			`${JSON.stringify(
				{
					schema: COMPANY_CONNECTOR_SCHEMA,
					id,
					displayName: "Ledger API",
					purpose: "Read operating ledger balances.",
					ownerAgentId: OWNER_AGENT_ID,
					operations: [
						{
							id: "ledger.read",
							label: "Read ledger",
							description: "Read balances and transactions without modifying them.",
							access: "read",
						},
					],
					destinations: [{ host: "API.EXAMPLE.COM", note: "Ledger API" }],
					authentication: { kind: "api-key", secretName: "ledger_api", label: "Ledger API key" },
					implementation: { kind: "agent-playbook", entry: "adapter.md" },
					createdAt: "2026-08-16T00:00:00.000Z",
					updatedAt: "2026-08-16T00:00:00.000Z",
					...overrides,
				},
				null,
				2,
			)}\n`,
			"utf-8",
		);
	}

	it("reads a portable manifest without credentials", () => {
		writeConnector("ledger-api");
		expect(readCompanyConnectorManifests(root)).toEqual([
			expect.objectContaining({
				id: "ledger-api",
				destinations: [{ host: "api.example.com", note: "Ledger API" }],
				authentication: { kind: "api-key", secretName: "ledger_api", label: "Ledger API key" },
				relativePath: "connectors/ledger-api/manifest.json",
			}),
		]);
		expect(JSON.stringify(readCompanyConnectorManifests(root))).not.toContain("api-key-value");
	});

	it("accepts a Google Sheets PKCE recipe with no token values", () => {
		writeConnector("google-sheets", {
			displayName: "Google Sheets",
			authentication: {
				kind: "oauth2",
				secretName: "google_sheets",
				label: "Google Sheets account",
				authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
				tokenUrl: "https://oauth2.googleapis.com/token",
				clientId: "qorpera-desktop",
				scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
			},
		});
		expect(readCompanyConnectorManifests(root)[0]?.authentication).toMatchObject({
			kind: "oauth2",
			secretName: "google_sheets",
			scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
		});
	});

	it("accepts a Nordea sandbox POST consent recipe with header client authentication", () => {
		const requestHeaders = {
			Signature: "SKIP_SIGNATURE_VALIDATION_FOR_SANDBOX",
			"X-Nordea-Originating-Host": "$" + "{url_host}",
			"X-Nordea-Originating-Date": "$" + "{http_date}",
			Digest: "$" + "{body_sha256_digest}",
		};
		writeConnector("nordea-open-banking", {
			displayName: "Nordea Open Banking sandbox",
			environment: "sandbox",
			destinations: [{ host: "api.nordeaopenbanking.com", note: "Nordea sandbox" }],
			authentication: {
				kind: "oauth2",
				secretName: "NORDEA_ACCESS",
				label: "Nordea sandbox consent",
				authorizationUrl: "https://api.nordeaopenbanking.com/business/v5/authorize",
				tokenUrl: "https://api.nordeaopenbanking.com/business/v5/authorize/token",
				registrationUrl: "https://developer.nordeaopenbanking.com/",
				clientId: "sandbox-client-id",
				scopes: ["ACCOUNTS_BASIC", "ACCOUNTS_BALANCES", "ACCOUNTS_TRANSACTIONS"],
				clientSecretLabel: "Nordea sandbox client secret",
				clientSecretName: "NORDEA_CLIENT_SECRET",
				authorization: {
					method: "post",
					usePkce: false,
					scopeSeparator: "comma",
					parameters: { country: "DK", duration: "15552000" },
					headers: requestHeaders,
				},
				clientAuthentication: {
					kind: "headers",
					clientIdHeader: "X-IBM-Client-Id",
					clientSecretHeader: "X-IBM-Client-Secret",
				},
				tokenHeaders: requestHeaders,
			},
		});

		const connector = readCompanyConnectorManifests(root)[0]!;
		expect(connector).toMatchObject({
			environment: "sandbox",
			authentication: {
				kind: "oauth2",
				registrationUrl: "https://developer.nordeaopenbanking.com/",
				authorization: { method: "post", usePkce: false, scopeSeparator: "comma" },
				clientAuthentication: {
					kind: "headers",
					clientIdHeader: "X-IBM-Client-Id",
					clientSecretHeader: "X-IBM-Client-Secret",
				},
			},
		});
		expect(companyConnectorSecretNames(connector)).toEqual(["nordea_access", "nordea_client_secret"]);
	});

	it("fails closed on unsafe bank OAuth recipes", () => {
		const baseAuthentication = {
			kind: "oauth2",
			secretName: "nordea_access",
			label: "Nordea sandbox consent",
			authorizationUrl: "https://api.nordeaopenbanking.com/business/v5/authorize",
			tokenUrl: "https://api.nordeaopenbanking.com/business/v5/authorize/token",
			clientId: "sandbox-client-id",
			scopes: ["ACCOUNTS_BASIC"],
			clientSecretLabel: "Nordea client secret",
			clientSecretName: "nordea_client_secret",
		};
		writeConnector("get-header-auth", {
			authentication: {
				...baseAuthentication,
				clientAuthentication: {
					kind: "headers",
					clientIdHeader: "X-IBM-Client-Id",
					clientSecretHeader: "X-IBM-Client-Secret",
				},
			},
		});
		writeConnector("credential-template", {
			authentication: {
				...baseAuthentication,
				authorization: { method: "post", headers: { Signature: "secret://bank-key" } },
			},
		});
		writeConnector("reserved-parameter", {
			authentication: {
				...baseAuthentication,
				authorization: { method: "post", parameters: { redirect_uri: "https://attacker.example" } },
			},
		});
		writeConnector("production-bypass", {
			authentication: {
				...baseAuthentication,
				authorization: {
					method: "post",
					headers: { Signature: "SKIP_SIGNATURE_VALIDATION_FOR_SANDBOX" },
				},
			},
		});
		writeConnector("interactive-client-secret", {
			authentication: {
				kind: "oauth2",
				secretName: "oauth_access",
				label: "Provider account",
				authorizationUrl: "https://provider.example/authorize",
				tokenUrl: "https://provider.example/token",
				clientId: "client-id",
				scopes: [],
				clientSecretLabel: "OAuth client secret",
			},
		});

		expect(readCompanyConnectorManifests(root)).toEqual([]);
	});

	it("shares the exact company request surface across staff agents", () => {
		writeConnector("ledger-api");
		const connector = readCompanyConnectorManifests(root)[0]!;
		const request = {
			staffAgentId: OWNER_AGENT_ID,
			displayName: "Ledger API",
			destinations: [{ host: "API.EXAMPLE.COM" }],
			secretNames: ["LEDGER_API"],
			recipeId: "company:ledger-api",
		};
		expect(companyConnectorMatchesRequest(connector, request)).toBe(true);
		expect(
			companyConnectorMatchesRequest(connector, {
				...request,
				destinations: [...request.destinations, { host: "attacker.example.com" }],
			}),
		).toBe(false);
		expect(companyConnectorMatchesRequest(connector, { ...request, secretNames: ["other_secret"] })).toBe(false);
		expect(companyConnectorMatchesRequest(connector, { ...request, staffAgentId: crypto.randomUUID() })).toBe(true);
	});

	it("keeps incomplete, escaping, or credential-bearing proposals unavailable", () => {
		writeConnector("missing-entry", { implementation: { kind: "agent-playbook", entry: "missing.md" } });
		writeConnector("escape", { implementation: { kind: "agent-playbook", entry: "../outside.md" } });
		writeConnector("embedded-credential", {
			authentication: {
				kind: "oauth2",
				secretName: "unsafe",
				label: "Unsafe",
				authorizationUrl: "https://user:password@accounts.example.com/oauth/authorize",
				tokenUrl: "https://accounts.example.com/oauth/token",
				clientId: "client",
				scopes: [],
			},
		});
		expect(readCompanyConnectorManifests(root)).toEqual([]);
	});
});
