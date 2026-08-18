import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	companyConnectorMatchesRequest,
	companyConnectorSecretNames,
	readCompanyConnectorManifests,
} from "@qorpera/pi-coding-agent/company-connectors";
import { readConnectionRequests } from "./connection-requests.ts";
import { builtInGitHubNativeGrantMatches } from "./github-company-connector.ts";

interface ConnectorHttpRequest {
	method: string;
	url: string;
	headers?: Record<string, string>;
	body?: string;
	timeoutMs?: number;
	saveTo?: string;
	sendFile?: string;
}

interface ConnectorHttpAuthorization {
	connectorId: string;
	operationId: string;
	behaviorPath: string;
	contentHash: string;
	request: ConnectorHttpRequest;
}

const CONNECTOR_ID_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/;
const OPERATION_ID_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,127}$/;
const CONTENT_HASH_PATTERN = /^[a-f0-9]{64}$/;
const SECRET_REFERENCE_PATTERN = /secret:\/\/([a-z0-9][a-z0-9_-]{0,63})/gi;
const ALLOWED_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"]);

function recordValue(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
	return Object.keys(value).every((key) => allowed.includes(key));
}

function parsedHeaders(value: unknown): Record<string, string> | undefined {
	if (value === undefined) return {};
	const record = recordValue(value);
	if (!record || Object.keys(record).length > 64) return undefined;
	const headers: Record<string, string> = {};
	for (const [name, headerValue] of Object.entries(record)) {
		if (!name || typeof headerValue !== "string") return undefined;
		headers[name] = headerValue;
	}
	return headers;
}

function parsedAuthorization(value: unknown): ConnectorHttpAuthorization | undefined {
	const record = recordValue(value);
	if (
		!record ||
		!exactKeys(record, ["connectorId", "operationId", "behaviorPath", "contentHash", "request"]) ||
		typeof record.connectorId !== "string" ||
		!CONNECTOR_ID_PATTERN.test(record.connectorId) ||
		typeof record.operationId !== "string" ||
		!OPERATION_ID_PATTERN.test(record.operationId) ||
		typeof record.behaviorPath !== "string" ||
		typeof record.contentHash !== "string" ||
		!CONTENT_HASH_PATTERN.test(record.contentHash)
	) {
		return undefined;
	}
	const request = recordValue(record.request);
	if (
		!request ||
		!exactKeys(request, ["method", "url", "headers", "body", "timeoutMs", "saveTo", "sendFile"]) ||
		typeof request.method !== "string" ||
		!ALLOWED_METHODS.has(request.method.toUpperCase()) ||
		typeof request.url !== "string" ||
		Buffer.byteLength(request.url, "utf-8") > 8 * 1024 ||
		(request.body !== undefined && typeof request.body !== "string") ||
		(request.timeoutMs !== undefined &&
			(typeof request.timeoutMs !== "number" || !Number.isFinite(request.timeoutMs) || request.timeoutMs < 1)) ||
		(request.saveTo !== undefined && typeof request.saveTo !== "string") ||
		(request.sendFile !== undefined && typeof request.sendFile !== "string")
	) {
		return undefined;
	}
	const headers = parsedHeaders(request.headers);
	if (!headers) return undefined;
	return {
		connectorId: record.connectorId,
		operationId: record.operationId,
		behaviorPath: record.behaviorPath,
		contentHash: record.contentHash,
		request: {
			method: request.method.toUpperCase(),
			url: request.url,
			...(request.headers !== undefined ? { headers } : {}),
			...(request.body !== undefined ? { body: request.body as string } : {}),
			...(request.timeoutMs !== undefined ? { timeoutMs: request.timeoutMs as number } : {}),
			...(request.saveTo !== undefined ? { saveTo: request.saveTo as string } : {}),
			...(request.sendFile !== undefined ? { sendFile: request.sendFile as string } : {}),
		},
	};
}

function secretReferenceNames(...values: Array<string | undefined>): string[] {
	const names = new Set<string>();
	for (const value of values) {
		if (!value) continue;
		for (const match of value.matchAll(SECRET_REFERENCE_PATTERN)) names.add(match[1].toLowerCase());
	}
	return [...names];
}

/**
 * A completed connector sign-in is the founder grant. This check narrows that
 * durable grant to the current manifest's exact program, declared operation,
 * destination hosts, and credential references for the active causal turn.
 */
export function authorizeConnectorHttpExecution(userData: string, root: string, value: unknown): void {
	const authorization = parsedAuthorization(value);
	if (!authorization) throw new Error("connector HTTP authorization is invalid");
	const connector = readCompanyConnectorManifests(root).find(
		(candidate) => candidate.id === authorization.connectorId,
	);
	if (!connector || connector.implementation.kind !== "company-tool") {
		throw new Error("connector HTTP authorization references an unavailable executable connector");
	}
	if (!connector.operations.some((operation) => operation.id === authorization.operationId)) {
		throw new Error("connector HTTP authorization references an undeclared operation");
	}
	const granted = readConnectionRequests(userData, root).some(
		(request) =>
			(request.status === "connected" &&
				request.grantId === `company:${connector.id}` &&
				companyConnectorMatchesRequest(connector, request)) ||
			builtInGitHubNativeGrantMatches(connector, request),
	);
	if (!granted) throw new Error(`connector ${connector.id} is not connected`);

	const behaviorPath = `connectors/${connector.id}/${connector.implementation.entry}`;
	const implementationPath = join(root, ...behaviorPath.split("/"));
	const contentHash = createHash("sha256").update(readFileSync(implementationPath)).digest("hex");
	if (authorization.behaviorPath !== behaviorPath || authorization.contentHash !== contentHash) {
		throw new Error("connector HTTP authorization code identity does not match the installed connector");
	}

	let destination: URL;
	try {
		destination = new URL(authorization.request.url);
	} catch {
		throw new Error("connector HTTP authorization destination is invalid");
	}
	if (
		destination.protocol !== "https:" ||
		destination.username ||
		destination.password ||
		!connector.destinations.some((candidate) => candidate.host === destination.host.toLowerCase())
	) {
		throw new Error(`connector ${connector.id} did not declare destination ${destination.host || "(invalid)"}`);
	}

	const allowedSecrets = new Set(companyConnectorSecretNames(connector));
	const referencedSecrets = secretReferenceNames(
		authorization.request.url,
		authorization.request.body,
		...Object.values(authorization.request.headers ?? {}),
	);
	const undeclaredSecret = referencedSecrets.find((name) => !allowedSecrets.has(name));
	if (undeclaredSecret) {
		throw new Error(`connector ${connector.id} did not declare credential reference ${undeclaredSecret}`);
	}
}
