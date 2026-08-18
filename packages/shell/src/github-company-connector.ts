import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	COMPANY_CONNECTOR_SCHEMA,
	type CompanyConnectorManifestRecord,
	readCompanyConnectorManifests,
} from "@qorpera/pi-coding-agent/company-connectors";

export const BUILT_IN_GITHUB_CONNECTOR_ID = "qorpera.github";
export const GITHUB_CONNECTION_DESTINATIONS = [
	["api.github.com", "GitHub API"],
	["uploads.github.com", "GitHub release uploads"],
	["raw.githubusercontent.com", "GitHub raw content"],
] as const;

const GITHUB_OPERATION_ID = "api.get";
const STAFF_AGENT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const RELATIVE_PATHS = [
	`connectors/${BUILT_IN_GITHUB_CONNECTOR_ID}/manifest.json`,
	`connectors/${BUILT_IN_GITHUB_CONNECTOR_ID}/index.js`,
] as const;

const GITHUB_CONNECTOR_IMPLEMENTATION = String.raw`const { randomUUID } = require("node:crypto");
const { createInterface } = require("node:readline");

async function main() {
	const operationId = process.argv[2];
	let input;
	try {
		input = JSON.parse(process.argv[3] || "{}");
	} catch {
		throw new Error("GitHub connector input must be one JSON object");
	}
	if (operationId !== "api.get") throw new Error("Unsupported GitHub connector operation");
	if (
		!input ||
		typeof input !== "object" ||
		Array.isArray(input) ||
		typeof input.path !== "string" ||
		!input.path.startsWith("/") ||
		input.path.length > 4096 ||
		/[\u0000-\u001f\u007f]/u.test(input.path)
	) {
		throw new Error("api.get requires one bounded GitHub REST path beginning with /");
	}
	const url = new URL(input.path, "https://api.github.com");
	if (
		url.origin !== "https://api.github.com" ||
		url.username ||
		url.password ||
		url.hash
	) {
		throw new Error("GitHub REST path escaped api.github.com");
	}

	const requestId = randomUUID();
	process.stdout.write(JSON.stringify({
		type: "qorpera_program_http_request",
		requestId,
		method: "GET",
		url: url.toString(),
		headers: {
			accept: "application/vnd.github+json",
			authorization: "Bearer secret://github",
			"user-agent": "Qorpera-Company-Connector",
			"x-github-api-version": "2022-11-28"
		},
		timeoutMs: 30000
	}) + "\n");

	for await (const line of createInterface({ input: process.stdin })) {
		let frame;
		try {
			frame = JSON.parse(line);
		} catch {
			continue;
		}
		if (frame.type !== "qorpera_program_http_response" || frame.requestId !== requestId) continue;
		if (typeof frame.error === "string") throw new Error(frame.error);
		if (typeof frame.status !== "number" || frame.status < 200 || frame.status >= 300) {
			throw new Error("GitHub API request failed with status " + String(frame.status));
		}
		if (typeof frame.body !== "string") throw new Error("GitHub API response body is invalid");
		process.stdout.write(frame.body, () => process.exit(0));
		return;
	}
	throw new Error("GitHub API response was not received");
}

main().catch((error) => {
	process.stderr.write(String(error.message || error), () => process.exit(1));
});
`;

export interface InstalledBuiltInGitHubConnector {
	connector: CompanyConnectorManifestRecord;
	created: boolean;
	relativePaths: readonly string[];
}

interface NativeGitHubGrant {
	status: string;
	grantId?: string;
	recipeId?: string;
	displayName: string;
	destinations: readonly { readonly host: string }[];
	secretNames: readonly string[];
}

function isExpectedBuiltInConnector(connector: CompanyConnectorManifestRecord): boolean {
	return (
		connector.id === BUILT_IN_GITHUB_CONNECTOR_ID &&
		connector.displayName === "GitHub" &&
		connector.operations.length === 1 &&
		connector.operations[0]?.id === GITHUB_OPERATION_ID &&
		connector.operations[0].access === "read" &&
		connector.authentication.kind === "api-key" &&
		connector.authentication.secretName === "github" &&
		connector.implementation.kind === "company-tool" &&
		connector.implementation.entry === "index.js" &&
		JSON.stringify(connector.destinations.map((destination) => destination.host).sort()) ===
			JSON.stringify(GITHUB_CONNECTION_DESTINATIONS.map(([host]) => host).sort())
	);
}

/** Materialize Qorpera's built-in GitHub transport into the company itself.
 * The credential remains in the host vault; the portable company receives
 * only the audited manifest and executable operation. */
export function ensureBuiltInGitHubConnector(root: string, ownerAgentId: string): InstalledBuiltInGitHubConnector {
	if (!STAFF_AGENT_ID_PATTERN.test(ownerAgentId)) throw new Error("GitHub connector owner is invalid");
	const existing = readCompanyConnectorManifests(root).find(
		(connector) => connector.id === BUILT_IN_GITHUB_CONNECTOR_ID,
	);
	if (existing) {
		if (!isExpectedBuiltInConnector(existing)) {
			throw new Error("The reserved built-in GitHub connector id contains a different connector");
		}
		return { connector: existing, created: false, relativePaths: RELATIVE_PATHS };
	}

	const connectorsDirectory = join(root, "connectors");
	mkdirSync(connectorsDirectory, { recursive: true });
	const connectorDirectory = join(connectorsDirectory, BUILT_IN_GITHUB_CONNECTOR_ID);
	if (existsSync(connectorDirectory)) {
		throw new Error("The reserved built-in GitHub connector directory is incomplete or invalid");
	}
	const stagingDirectory = join(connectorsDirectory, `.${BUILT_IN_GITHUB_CONNECTOR_ID}-${randomUUID()}`);
	const timestamp = new Date().toISOString();
	try {
		mkdirSync(stagingDirectory);
		writeFileSync(join(stagingDirectory, "index.js"), GITHUB_CONNECTOR_IMPLEMENTATION, {
			encoding: "utf-8",
			flag: "wx",
		});
		writeFileSync(
			join(stagingDirectory, "manifest.json"),
			`${JSON.stringify(
				{
					schema: COMPANY_CONNECTOR_SCHEMA,
					id: BUILT_IN_GITHUB_CONNECTOR_ID,
					displayName: "GitHub",
					purpose:
						"Read GitHub repository metadata and source evidence through a company-portable connector operation.",
					ownerAgentId,
					operations: [
						{
							id: GITHUB_OPERATION_ID,
							label: "Read GitHub REST resource",
							description:
								"Read one GitHub REST API path using the founder-connected company account without exposing its credential.",
							access: "read",
						},
					],
					destinations: GITHUB_CONNECTION_DESTINATIONS.map(([host, note]) => ({ host, note })),
					authentication: { kind: "api-key", secretName: "github", label: "GitHub access token" },
					implementation: { kind: "company-tool", entry: "index.js" },
					createdAt: timestamp,
					updatedAt: timestamp,
				},
				null,
				2,
			)}\n`,
			{ encoding: "utf-8", flag: "wx" },
		);
		renameSync(stagingDirectory, connectorDirectory);
	} catch (error) {
		rmSync(stagingDirectory, { recursive: true, force: true });
		throw error;
	}

	const installed = readCompanyConnectorManifests(root).find(
		(connector) => connector.id === BUILT_IN_GITHUB_CONNECTOR_ID,
	);
	if (!installed || !isExpectedBuiltInConnector(installed)) {
		throw new Error("The built-in GitHub connector did not install as a valid company connector");
	}
	return { connector: installed, created: true, relativePaths: RELATIVE_PATHS };
}

export function builtInGitHubNativeGrantMatches(
	connector: CompanyConnectorManifestRecord,
	request: NativeGitHubGrant,
): boolean {
	const expectedHosts = GITHUB_CONNECTION_DESTINATIONS.map(([host]) => host).sort();
	return (
		isExpectedBuiltInConnector(connector) &&
		request.status === "connected" &&
		request.grantId === "github-native" &&
		request.recipeId === "github" &&
		request.displayName === "GitHub" &&
		request.secretNames.length === 1 &&
		request.secretNames[0]?.toLowerCase() === "github" &&
		JSON.stringify(request.destinations.map((destination) => destination.host.toLowerCase()).sort()) ===
			JSON.stringify(expectedHosts)
	);
}
