/**
 * Founder connection request proposal.
 *
 * A new contract only emits a bounded, credential-free founder proposal. An
 * exact retry may resume a previously selected failed connector without
 * asking for the same choice again; it cannot broaden the selected scope.
 */

import type { AgentTool } from "@qorpera/pi-agent-core";
import { type Static, Type } from "typebox";
import { companyConnectorSecretNames, readCompanyConnectorManifests } from "../company-connectors.ts";
import { brokeredCompanyOperation } from "../company-operation-broker-client.ts";
import type { ToolDefinition } from "../extensions/types.ts";
import { COMPANY_CONNECTOR_RUNTIME_CONTRACT } from "./connector-runtime-contract.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

export const REQUEST_CONNECTION_TOOL_NAME = "request_connection";

const destinationSchema = Type.Object(
	{
		host: Type.String({
			minLength: 1,
			maxLength: 259,
			pattern: "^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?(?::[0-9]{1,5})?$",
			description:
				"Exact HTTPS destination host, optionally with a port; never a URL, wildcard, or secret reference",
		}),
		note: Type.Optional(
			Type.String({
				minLength: 1,
				maxLength: 240,
				description: "Short founder-facing explanation of why this destination is needed",
			}),
		),
	},
	{ additionalProperties: false },
);

const requestConnectionSchema = Type.Object(
	{
		displayName: Type.String({
			minLength: 1,
			maxLength: 120,
			description: "Founder-facing name of the service or capability",
		}),
		purpose: Type.String({
			minLength: 1,
			maxLength: 1_000,
			description:
				"What work this connection would enable; never include credentials, tokens, or authorization bodies",
		}),
		destinations: Type.Array(destinationSchema, {
			maxItems: 32,
			description: "Exact HTTPS destination hosts the work needs",
		}),
		secretNames: Type.Array(
			Type.String({
				minLength: 1,
				maxLength: 64,
				pattern: "^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$",
				description: "Opaque secret reference name only; never a secret value",
			}),
			{
				maxItems: 32,
				description: "Names the desktop host should bind for later secret://name references; never include values",
			},
		),
		providerSuggestions: Type.Optional(
			Type.Array(
				Type.String({
					minLength: 1,
					maxLength: 80,
					description: "Concrete provider or service name the founder can choose; never a category or credential",
				}),
				{
					minItems: 2,
					maxItems: 4,
					description:
						"Two to four likely providers when no exact recipe is installed; omit after a provider recipe exists",
				},
			),
		),
		recipeId: Type.Optional(
			Type.String({
				minLength: 1,
				maxLength: 128,
				pattern: "^[A-Za-z0-9](?:[A-Za-z0-9._:/-]{0,126}[A-Za-z0-9])?$",
				description: "Optional declarative connector recipe identifier; never an OAuth request or response body",
			}),
		),
		artifactId: Type.Optional(
			Type.String({
				minLength: 1,
				maxLength: 256,
				pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$",
				description: "Exact id of the artifact whose data need is blocked",
			}),
		),
		dataNeedId: Type.Optional(
			Type.String({
				minLength: 1,
				maxLength: 128,
				pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$",
				description: "Exact id of the blocked data need inside artifactId",
			}),
		),
	},
	{ additionalProperties: false },
);

export type RequestConnectionToolInput = Static<typeof requestConnectionSchema>;

const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;

function validText(value: string, maximumBytes: number): boolean {
	return (
		value.length > 0 &&
		value === value.trim() &&
		!CONTROL_CHARACTER_PATTERN.test(value) &&
		Buffer.byteLength(value, "utf-8") <= maximumBytes
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
	return Object.keys(value).every((key) => allowed.has(key));
}

function validDestinationHost(host: string): boolean {
	const match = host.match(/^([^:]+)(?::([0-9]{1,5}))?$/);
	if (!match?.[1] || host !== host.trim() || host.includes("://") || host.includes("/") || host.includes("@")) {
		return false;
	}
	const hostname = match[1];
	if (
		hostname.length > 253 ||
		hostname.split(".").some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))
	) {
		return false;
	}
	if (match[2] === undefined) return true;
	const port = Number(match[2]);
	return Number.isInteger(port) && port >= 1 && port <= 65_535;
}

function assertRequestInput(input: unknown): asserts input is RequestConnectionToolInput {
	if (
		!isRecord(input) ||
		!hasOnlyKeys(
			input,
			new Set([
				"displayName",
				"purpose",
				"destinations",
				"secretNames",
				"providerSuggestions",
				"recipeId",
				"artifactId",
				"dataNeedId",
			]),
		) ||
		typeof input.displayName !== "string" ||
		typeof input.purpose !== "string" ||
		!Array.isArray(input.destinations) ||
		input.destinations.length > 32 ||
		!Array.isArray(input.secretNames) ||
		input.secretNames.length > 32 ||
		(input.providerSuggestions !== undefined &&
			(!Array.isArray(input.providerSuggestions) ||
				input.providerSuggestions.length < 2 ||
				input.providerSuggestions.length > 4)) ||
		(input.recipeId !== undefined && input.providerSuggestions !== undefined) ||
		(input.recipeId !== undefined &&
			(typeof input.recipeId !== "string" ||
				!/^[a-z0-9](?:[a-z0-9._:/-]{0,126}[a-z0-9])?$/i.test(input.recipeId))) ||
		(input.artifactId !== undefined &&
			(typeof input.artifactId !== "string" || !/^[a-z0-9][a-z0-9._:-]{0,255}$/i.test(input.artifactId))) ||
		(input.dataNeedId !== undefined &&
			(typeof input.dataNeedId !== "string" || !/^[a-z0-9][a-z0-9._:-]{0,127}$/i.test(input.dataNeedId))) ||
		(input.artifactId === undefined) !== (input.dataNeedId === undefined) ||
		!validText(input.displayName, 120) ||
		!validText(input.purpose, 1_000) ||
		input.purpose.toLowerCase().includes("secret://")
	) {
		throw new Error("request_connection requires bounded single-line displayName and purpose text");
	}
	const destinations = new Set<string>();
	for (const value of input.destinations) {
		if (
			!isRecord(value) ||
			!hasOnlyKeys(value, new Set(["host", "note"])) ||
			typeof value.host !== "string" ||
			(value.note !== undefined && typeof value.note !== "string")
		) {
			throw new Error("request_connection destinations must be unique exact HTTPS hosts");
		}
		const destination = value as { host: string; note?: string };
		const normalized = destination.host.toLowerCase();
		if (
			!validDestinationHost(destination.host) ||
			(destination.note !== undefined &&
				(!validText(destination.note, 240) || destination.note.toLowerCase().includes("secret://"))) ||
			destinations.has(normalized)
		) {
			throw new Error("request_connection destinations must be unique exact HTTPS hosts");
		}
		destinations.add(normalized);
	}
	const secretNames = new Set<string>();
	for (const value of input.secretNames) {
		if (typeof value !== "string") {
			throw new Error("request_connection secretNames must be unique reference names, never values");
		}
		const name = value;
		const normalized = name.toLowerCase();
		if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(name) || name !== name.trim() || secretNames.has(normalized)) {
			throw new Error("request_connection secretNames must be unique reference names, never values");
		}
		secretNames.add(normalized);
	}
	const providerSuggestions = new Set<string>();
	for (const value of input.providerSuggestions ?? []) {
		if (typeof value !== "string") {
			throw new Error("request_connection providerSuggestions must be concrete unique service names");
		}
		const normalized = value.toLowerCase();
		if (!validText(value, 80) || value.toLowerCase().includes("secret://") || providerSuggestions.has(normalized)) {
			throw new Error("request_connection providerSuggestions must be concrete unique service names");
		}
		providerSuggestions.add(normalized);
	}
}

function assertInstalledCompanyRecipe(cwd: string, input: RequestConnectionToolInput): void {
	if (!input.recipeId?.startsWith("company:")) return;
	const connectorId = input.recipeId.slice("company:".length);
	const connector = readCompanyConnectorManifests(cwd).find((candidate) => candidate.id === connectorId);
	const requestedHosts = input.destinations.map((destination) => destination.host.toLowerCase()).sort();
	const requestedSecretNames = input.secretNames.map((name) => name.toLowerCase()).sort();
	if (
		!connector ||
		connector.displayName !== input.displayName ||
		JSON.stringify(connector.destinations.map((destination) => destination.host).sort()) !==
			JSON.stringify(requestedHosts) ||
		JSON.stringify(companyConnectorSecretNames(connector).sort()) !== JSON.stringify(requestedSecretNames)
	) {
		throw new Error(
			`company connector recipe ${input.recipeId} is missing, invalid, or does not exactly match this request`,
		);
	}
}

export function createRequestConnectionToolDefinition(
	cwd?: string,
): ToolDefinition<typeof requestConnectionSchema, undefined> {
	return {
		name: REQUEST_CONNECTION_TOOL_NAME,
		label: "choose source",
		description: `Propose a source choice only after discovery cannot satisfy the work. First inspect company files, owned artifact source references, installed connector manifests, and every already-ready read connection plausibly related to the missing datatype. Follow concrete service and account names found there. If a ready company mailbox exists, use narrow searches for relevant account, deployment, incident, billing, integration, customer, or work notices to identify the actual system; treat mail as discovery context, not automatically as authoritative metric evidence. A service mention is a lead, never a measurement. If the operating system still cannot be inferred, ask one brief ordinary-language question about where the work runs before showing a form instead of guessing conventional providers. When an owned artifact data need is blocked and the intended evidence source is known, include its exact artifactId and dataNeedId. If read-only company mail would materially improve discovery and no mailbox is ready, a separate Gmail or Outlook Email proposal may omit artifactId and dataNeedId; never link mail to the data need unless email itself is the intended evidence source. If concrete providers are genuinely likely but no recipe is installed, omit recipeId, pass empty destinations and secretNames, and include providerSuggestions with two to four concrete services so the app can render a clean choice form; never use broad categories, bundles, or repeat the same question in ordinary chat. A new proposal does not request provider access, open authorization, or grant a capability. After the founder chooses, use existing support first. If support is missing, install connectors/<id>/manifest.json plus its referenced implementation file. The qorpera.connector/v1 manifest requires id, displayName, purpose, ownerAgentId, operations [{id,label,description,access}], destinations [{host,note?}], authentication, implementation {kind,entry}, createdAt, and updatedAt. ${COMPANY_CONNECTOR_RUNTIME_CONTRACT} OAuth authentication uses {kind:'oauth2',secretName,label,authorizationUrl,tokenUrl,clientId,scopes} plus optional registrationUrl, clientSecretLabel/clientSecretName, authorization, clientAuthentication, and tokenHeaders. clientAuthentication is exactly {kind:'body'} or {kind:'headers',clientIdHeader,clientSecretHeader}, never a string. registrationUrl is the public starting page, not the founder handoff: use use_computer to navigate from there through every non-sensitive setup step, and stop only at an unobstructed sign-in, identity, MFA, consent, or equivalent secure user-only boundary. Then call this tool again with recipeId company:<id> and omit providerSuggestions. If that exact installed recipe, purpose, destinations, secret names, artifact need, and agent conversation previously failed after founder selection, this call reuses that durable selection and resumes setup or authorization without rendering the same choice again; any scope change remains a new proposal. A company recipe is rejected unless its installed manifest is valid and displayName, destination hosts, and secretNames exactly match; OAuth secretNames are authentication.secretName plus clientSecretName when present. Provide only the connection purpose, exact destination hosts, opaque secret reference names, and public provider labels. Never include credential values, API keys, tokens, authorization codes, cookies, OAuth request/response bodies, or secret:// references.`,
		promptSnippet:
			"Discover existing sources first; uncertainty never justifies guessed providers—ask one plain question or offer only an unlinked read-only mail discovery choice",
		parameters: requestConnectionSchema,
		async execute(_toolCallId, input: RequestConnectionToolInput) {
			assertRequestInput(input);
			if (cwd) assertInstalledCompanyRecipe(cwd, input);
			const result = await brokeredCompanyOperation("request_connection", input);
			return {
				content: [
					{
						type: "text",
						text: result.message,
					},
				],
				details: undefined,
			};
		},
	};
}

export function createRequestConnectionTool(cwd?: string): AgentTool<typeof requestConnectionSchema> {
	return wrapToolDefinition(createRequestConnectionToolDefinition(cwd));
}
