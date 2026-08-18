import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scaffoldCompany } from "../src/core/company.ts";
import {
	assessCompanyArtifactSource,
	createStarterCompanyArtifact,
	recordCompanyArtifactObservation,
	type StarterArtifactDefinition,
} from "../src/core/company-artifacts.ts";
import { COMPANY_CONNECTOR_SCHEMA } from "../src/core/company-connectors.ts";
import {
	handleCompanyOperationBrokerFrame,
	setCompanyOperationBrokerWriter,
} from "../src/core/company-operation-broker-client.ts";
import { handleHttpBrokerFrame, setHttpBrokerWriter } from "../src/core/http-broker-client.ts";
import { createRunConnectorToolDefinition } from "../src/core/tools/run-connector.ts";

const STAFF_ID = "11111111-1111-4111-8111-111111111111";
const FINANCIAL_HEALTH: StarterArtifactDefinition = {
	title: "Financial health",
	purpose: "Maintain a current, evidence-backed view of financial resilience.",
	metrics: [
		{
			id: "cash-balance",
			label: "Cash balance",
			description: "Verified cash currently available.",
			direction: "higher-is-better",
			unit: "DKK",
		},
		{
			id: "monthly-net-burn",
			label: "Monthly net burn",
			description: "Net cash consumed in a representative month.",
			direction: "lower-is-better",
			unit: "DKK/month",
		},
	],
	dataNeeds: [
		{
			id: "financial-ledger",
			label: "Financial ledger",
			purpose: "Calculate cash and burn from a ledger.",
			connectorHints: ["spreadsheet", "accounting"],
		},
		{
			id: "banking",
			label: "Banking records",
			purpose: "Verify current cash and movements.",
			connectorHints: ["banking"],
		},
	],
};

const CONNECTOR_PROGRAM = `import { createInterface } from "node:readline";
const [operation, encodedInput] = process.argv.slice(2);
const input = JSON.parse(encodedInput);
process.stdout.write(JSON.stringify({
	type: "qorpera_program_http_request",
	requestId: "connector-read",
	method: "GET",
	url: input.url,
	headers: { authorization: "Bearer secret://" + input.secretName }
}) + String.fromCharCode(10));
createInterface({ input: process.stdin }).on("line", (line) => {
	const response = JSON.parse(line);
	if (response.error) throw new Error(response.error);
	console.log("CONNECTOR_DATA " + JSON.stringify({ operation, source: input.url, data: JSON.parse(response.body) }));
	process.exit(0);
});
`;

describe("connector to artifact vertical", () => {
	let root: string;
	let capturedRequests: Array<Record<string, unknown>>;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "qorpera-connector-artifact-"));
		scaffoldCompany(root);
		writeFileSync(join(root, "authority.toml"), `[tools]\nhttp_request = "none"\n`, "utf-8");
		capturedRequests = [];
	});

	afterEach(() => {
		setCompanyOperationBrokerWriter(undefined);
		setHttpBrokerWriter(undefined);
		rmSync(root, { recursive: true, force: true });
	});

	function installConnector(input: {
		id: string;
		displayName: string;
		host: string;
		secretName: string;
		operationId: string;
	}): void {
		const directory = join(root, "connectors", input.id);
		mkdirSync(directory, { recursive: true });
		writeFileSync(join(directory, "connector.mjs"), CONNECTOR_PROGRAM, "utf-8");
		const authentication =
			input.id === "nordea-open-banking"
				? {
						kind: "oauth2",
						secretName: input.secretName,
						label: input.displayName,
						authorizationUrl: "https://api.nordeaopenbanking.com/business/v5/authorize",
						tokenUrl: "https://api.nordeaopenbanking.com/business/v5/authorize/token",
						clientId: "sandbox-client-id",
						scopes: ["ACCOUNTS_BASIC", "ACCOUNTS_BALANCES"],
						clientSecretName: "nordea_client_secret",
						clientSecretLabel: "Nordea sandbox client secret",
						authorization: { method: "post", usePkce: false, scopeSeparator: "comma" },
						clientAuthentication: {
							kind: "headers",
							clientIdHeader: "X-IBM-Client-Id",
							clientSecretHeader: "X-IBM-Client-Secret",
						},
					}
				: {
						kind: "oauth2",
						secretName: input.secretName,
						label: input.displayName,
						authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
						tokenUrl: "https://oauth2.googleapis.com/token",
						clientId: "qorpera-desktop",
						scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
					};
		writeFileSync(
			join(directory, "manifest.json"),
			`${JSON.stringify(
				{
					schema: COMPANY_CONNECTOR_SCHEMA,
					id: input.id,
					displayName: input.displayName,
					purpose: "Read financial source data.",
					ownerAgentId: STAFF_ID,
					operations: [
						{
							id: input.operationId,
							label: "Read financial data",
							description: "Read source values without modifying them.",
							access: "read",
						},
					],
					destinations: [{ host: input.host }],
					authentication,
					implementation: { kind: "company-tool", entry: "connector.mjs" },
					createdAt: "2026-08-16T00:00:00.000Z",
					updatedAt: "2026-08-16T00:00:00.000Z",
				},
				null,
				2,
			)}\n`,
			"utf-8",
		);
	}

	async function executeRead(input: {
		connectorId: string;
		operationId: string;
		url: string;
		secretName: string;
		response: Record<string, unknown>;
	}): Promise<{ source: string; data: Record<string, number> }> {
		setCompanyOperationBrokerWriter((frame) => {
			const request = frame as Record<string, unknown>;
			handleCompanyOperationBrokerFrame({
				type: "qorpera_company_operation_response",
				requestId: request.requestId,
				message: "authorized",
			});
		});
		setHttpBrokerWriter((frame) => {
			const request = frame as Record<string, unknown>;
			capturedRequests.push(request);
			handleHttpBrokerFrame({
				type: "qorpera_http_response",
				requestId: request.requestId,
				status: 200,
				headers: { "content-type": "application/json" },
				body: JSON.stringify(input.response),
				bodyBytes: Buffer.byteLength(JSON.stringify(input.response)),
			});
		});
		const definition = createRunConnectorToolDefinition(root);
		const execute = definition.execute as unknown as (
			toolCallId: string,
			args: unknown,
		) => Promise<{ content: Array<{ type: string; text?: string }>; details?: { contentHash: string } }>;
		const result = await execute("vertical-read", {
			connectorId: input.connectorId,
			operationId: input.operationId,
			input: { url: input.url, secretName: input.secretName },
		});
		const line = result.content[0]?.text?.split("\n").find((candidate) => candidate.startsWith("CONNECTOR_DATA "));
		if (!line) throw new Error("connector did not return structured data");
		return JSON.parse(line.slice("CONNECTOR_DATA ".length)) as { source: string; data: Record<string, number> };
	}

	function markAuthoritative(input: {
		artifactId: string;
		dataNeedId: string;
		sourceRef: string;
		metricIds: string[];
		dataType: string;
	}): void {
		assessCompanyArtifactSource(
			root,
			STAFF_ID,
			input.artifactId,
			{
				dataNeedId: input.dataNeedId,
				sourceRef: input.sourceRef,
				dataType: input.dataType,
				decision: "authoritative",
				rationale: "The connector read returned the declared company account records for these measures.",
				metricIds: input.metricIds,
				evidence: [`${input.sourceRef}#connector-operation-verified`],
				assessedAt: "2026-07-31T11:00:00.000Z",
			},
			"agent",
			new Date("2026-07-31T11:00:00.000Z"),
		);
	}

	it("uses an executable Google Sheets connector before accepting ledger measures", async () => {
		installConnector({
			id: "google-sheets",
			displayName: "Google Sheets",
			host: "sheets.googleapis.com",
			secretName: "google_sheets",
			operationId: "sheets.values.read",
		});
		const artifact = createStarterCompanyArtifact(root, STAFF_ID, "financial-officer", FINANCIAL_HEALTH);
		const result = await executeRead({
			connectorId: "google-sheets",
			operationId: "sheets.values.read",
			url: "https://sheets.googleapis.com/v4/spreadsheets/ledger/values/Operating",
			secretName: "google_sheets",
			response: { cashBalance: 20000, monthlyNetBurn: 7500 },
		});
		markAuthoritative({
			artifactId: artifact.id,
			dataNeedId: "financial-ledger",
			sourceRef: result.source,
			metricIds: ["cash-balance", "monthly-net-burn"],
			dataType: "company cash balance and monthly net burn",
		});

		const measured = recordCompanyArtifactObservation(root, STAFF_ID, artifact.id, {
			dataNeedId: "financial-ledger",
			sourceRef: result.source,
			observedAt: "2026-08-16T12:00:00.000Z",
			metrics: [
				{ id: "cash-balance", value: result.data.cashBalance },
				{ id: "monthly-net-burn", value: result.data.monthlyNetBurn },
			],
		});

		expect(capturedRequests[0]).toMatchObject({
			url: "https://sheets.googleapis.com/v4/spreadsheets/ledger/values/Operating",
			headers: { authorization: "Bearer secret://google_sheets" },
		});
		expect(measured).toMatchObject({
			status: "partial",
			metrics: [
				{ id: "cash-balance", status: "measured", value: 20000 },
				{ id: "monthly-net-burn", status: "measured", value: 7500 },
			],
			dataNeeds: [
				{ id: "financial-ledger", status: "available" },
				{ id: "banking", status: "missing" },
			],
		});
	});

	it("uses the same company-owned execution path for a Nordea-shaped banking read", async () => {
		installConnector({
			id: "nordea-open-banking",
			displayName: "Nordea Open Banking",
			host: "api.nordeaopenbanking.com",
			secretName: "nordea_access",
			operationId: "accounts.balances.read",
		});
		const artifact = createStarterCompanyArtifact(root, STAFF_ID, "financial-officer", FINANCIAL_HEALTH);
		const result = await executeRead({
			connectorId: "nordea-open-banking",
			operationId: "accounts.balances.read",
			url: "https://api.nordeaopenbanking.com/business/v5/accounts/account-1/balances",
			secretName: "nordea_access",
			response: { bookedBalance: 18425.5 },
		});
		markAuthoritative({
			artifactId: artifact.id,
			dataNeedId: "banking",
			sourceRef: result.source,
			metricIds: ["cash-balance"],
			dataType: "booked company bank balance",
		});

		const measured = recordCompanyArtifactObservation(root, STAFF_ID, artifact.id, {
			dataNeedId: "banking",
			sourceRef: result.source,
			observedAt: "2026-08-16T12:00:00.000Z",
			metrics: [{ id: "cash-balance", value: result.data.bookedBalance }],
		});

		expect(capturedRequests[0]).toMatchObject({
			url: "https://api.nordeaopenbanking.com/business/v5/accounts/account-1/balances",
			headers: { authorization: "Bearer secret://nordea_access" },
		});
		expect(measured).toMatchObject({
			status: "partial",
			metrics: [
				{ id: "cash-balance", status: "measured", value: 18425.5 },
				{ id: "monthly-net-burn", status: "unknown" },
			],
			dataNeeds: [
				{ id: "financial-ledger", status: "missing" },
				{ id: "banking", status: "available" },
			],
		});
	});

	it("turns successive connector reads into an operating, auditable metric history", async () => {
		installConnector({
			id: "google-sheets",
			displayName: "Google Sheets",
			host: "sheets.googleapis.com",
			secretName: "google_sheets",
			operationId: "sheets.values.read",
		});
		installConnector({
			id: "nordea-open-banking",
			displayName: "Nordea Open Banking",
			host: "api.nordeaopenbanking.com",
			secretName: "nordea_access",
			operationId: "accounts.balances.read",
		});
		const artifact = createStarterCompanyArtifact(root, STAFF_ID, "financial-officer", FINANCIAL_HEALTH);
		const sheetUrl = "https://sheets.googleapis.com/v4/spreadsheets/ledger/values/Operating";
		const firstLedger = await executeRead({
			connectorId: "google-sheets",
			operationId: "sheets.values.read",
			url: sheetUrl,
			secretName: "google_sheets",
			response: { cashBalance: 20000, monthlyNetBurn: 7500 },
		});
		const ledgerSourceRef = `connector:google-sheets/sheets.values.read:${firstLedger.source}`;
		markAuthoritative({
			artifactId: artifact.id,
			dataNeedId: "financial-ledger",
			sourceRef: ledgerSourceRef,
			metricIds: ["cash-balance", "monthly-net-burn"],
			dataType: "company cash balance and monthly net burn",
		});
		recordCompanyArtifactObservation(root, STAFF_ID, artifact.id, {
			dataNeedId: "financial-ledger",
			sourceRef: ledgerSourceRef,
			observedAt: "2026-07-31T12:00:00.000Z",
			metrics: [
				{ id: "cash-balance", value: firstLedger.data.cashBalance, evidence: ["Operating!B2"] },
				{ id: "monthly-net-burn", value: firstLedger.data.monthlyNetBurn, evidence: ["Operating!B3"] },
			],
		});

		const secondLedger = await executeRead({
			connectorId: "google-sheets",
			operationId: "sheets.values.read",
			url: sheetUrl,
			secretName: "google_sheets",
			response: { cashBalance: 17500, monthlyNetBurn: 6200 },
		});
		const partial = recordCompanyArtifactObservation(root, STAFF_ID, artifact.id, {
			dataNeedId: "financial-ledger",
			sourceRef: `connector:google-sheets/sheets.values.read:${secondLedger.source}`,
			observedAt: "2026-08-15T12:00:00.000Z",
			metrics: [
				{ id: "cash-balance", value: secondLedger.data.cashBalance, evidence: ["Operating!B2"] },
				{ id: "monthly-net-burn", value: secondLedger.data.monthlyNetBurn, evidence: ["Operating!B3"] },
			],
		});
		expect(partial.status).toBe("partial");

		const bankUrl = "https://api.nordeaopenbanking.com/business/v5/accounts/account-1/balances";
		const banking = await executeRead({
			connectorId: "nordea-open-banking",
			operationId: "accounts.balances.read",
			url: bankUrl,
			secretName: "nordea_access",
			response: { bookedBalance: 18425.5 },
		});
		const bankingSourceRef = `connector:nordea-open-banking/accounts.balances.read:${banking.source}`;
		markAuthoritative({
			artifactId: artifact.id,
			dataNeedId: "banking",
			sourceRef: bankingSourceRef,
			metricIds: ["cash-balance"],
			dataType: "booked company bank balance",
		});
		const operating = recordCompanyArtifactObservation(root, STAFF_ID, artifact.id, {
			dataNeedId: "banking",
			sourceRef: bankingSourceRef,
			observedAt: "2026-08-16T12:00:00.000Z",
			metrics: [
				{
					id: "cash-balance",
					value: banking.data.bookedBalance,
					evidence: ["account:account-1/balances#bookedBalance"],
				},
			],
		});

		expect(operating.status).toBe("operating");
		expect(operating.dataNeeds).toMatchObject([
			{ id: "financial-ledger", status: "available" },
			{ id: "banking", status: "available" },
		]);
		expect(operating.metrics[0]).toMatchObject({
			id: "cash-balance",
			value: 18425.5,
			observedAt: "2026-08-16T12:00:00.000Z",
			observations: [
				{
					at: "2026-07-31T12:00:00.000Z",
					value: 20000,
					sourceRef: `connector:google-sheets/sheets.values.read:${sheetUrl}`,
					evidence: ["Operating!B2"],
				},
				{
					at: "2026-08-15T12:00:00.000Z",
					value: 17500,
					sourceRef: `connector:google-sheets/sheets.values.read:${sheetUrl}`,
					evidence: ["Operating!B2"],
				},
				{
					at: "2026-08-16T12:00:00.000Z",
					value: 18425.5,
					sourceRef: `connector:nordea-open-banking/accounts.balances.read:${bankUrl}`,
					evidence: ["account:account-1/balances#bookedBalance"],
				},
			],
		});
		expect(operating.metrics[1]).toMatchObject({
			id: "monthly-net-burn",
			value: 6200,
			observations: [
				{ at: "2026-07-31T12:00:00.000Z", value: 7500 },
				{ at: "2026-08-15T12:00:00.000Z", value: 6200 },
			],
		});
		expect(capturedRequests).toHaveLength(3);
	});
});
