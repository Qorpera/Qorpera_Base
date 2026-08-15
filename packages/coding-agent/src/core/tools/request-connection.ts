/**
 * Founder connection request proposal.
 *
 * This tool has no outward effect and grants no capability. It emits a
 * bounded, credential-free proposal through the ordinary tool lifecycle so
 * the desktop kernel can associate it with the attached staff session and
 * ask the founder to connect the missing service.
 */

import type { AgentTool } from "@qorpera/pi-agent-core";
import { type Static, Type } from "typebox";
import type { ToolDefinition } from "../extensions/types.ts";
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
				description: "Names the kernel should bind for later secret://name references; never include values",
			},
		),
		recipeId: Type.Optional(
			Type.String({
				minLength: 1,
				maxLength: 128,
				pattern: "^[A-Za-z0-9](?:[A-Za-z0-9._:/-]{0,126}[A-Za-z0-9])?$",
				description: "Optional declarative connector recipe identifier; never an OAuth request or response body",
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
		!hasOnlyKeys(input, new Set(["displayName", "purpose", "destinations", "secretNames", "recipeId"])) ||
		typeof input.displayName !== "string" ||
		typeof input.purpose !== "string" ||
		!Array.isArray(input.destinations) ||
		input.destinations.length > 32 ||
		!Array.isArray(input.secretNames) ||
		input.secretNames.length > 32 ||
		(input.recipeId !== undefined &&
			(typeof input.recipeId !== "string" ||
				!/^[a-z0-9](?:[a-z0-9._:/-]{0,126}[a-z0-9])?$/i.test(input.recipeId))) ||
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
}

export function createRequestConnectionToolDefinition(): ToolDefinition<typeof requestConnectionSchema, undefined> {
	return {
		name: REQUEST_CONNECTION_TOOL_NAME,
		label: "request connection",
		description:
			"Ask the founder to connect a missing service or external capability. Provide only its purpose, exact destination hosts, and opaque secret reference names. Never include credential values, API keys, tokens, authorization codes, cookies, OAuth request/response bodies, or secret:// references. This sends a request only: it does not connect the service or grant access. Continue with other useful work while waiting.",
		promptSnippet: "Request a missing connection from the founder without sharing credentials",
		parameters: requestConnectionSchema,
		async execute(_toolCallId, input: RequestConnectionToolInput) {
			assertRequestInput(input);
			return {
				content: [
					{
						type: "text",
						text: "Connection request sent to the founder. No service was connected and no access was granted; continue with other work while waiting.",
					},
				],
				details: undefined,
			};
		},
	};
}

export function createRequestConnectionTool(): AgentTool<typeof requestConnectionSchema> {
	return wrapToolDefinition(createRequestConnectionToolDefinition());
}
