import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

export const COMPANY_CONNECTOR_SCHEMA = "qorpera.connector/v1" as const;

export type CompanyConnectorOperationAccess = "read" | "write";

export interface CompanyConnectorDestination {
	readonly host: string;
	readonly note?: string;
}

export interface CompanyConnectorOperation {
	readonly id: string;
	readonly label: string;
	readonly description: string;
	readonly access: CompanyConnectorOperationAccess;
}

export interface CompanyConnectorOAuthAuthorization {
	readonly method?: "get" | "post";
	readonly usePkce?: boolean;
	readonly scopeSeparator?: "space" | "comma";
	readonly parameters?: Readonly<Record<string, string>>;
	readonly headers?: Readonly<Record<string, string>>;
}

export type CompanyConnectorOAuthClientAuthentication =
	| { readonly kind: "body" }
	| {
			readonly kind: "headers";
			readonly clientIdHeader: string;
			readonly clientSecretHeader: string;
	  };

export type CompanyConnectorAuthentication =
	| { readonly kind: "none" }
	| {
			readonly kind: "api-key";
			readonly secretName: string;
			readonly label: string;
	  }
	| {
			readonly kind: "oauth2";
			readonly secretName: string;
			readonly label: string;
			readonly authorizationUrl: string;
			readonly tokenUrl: string;
			readonly registrationUrl?: string;
			readonly clientId: string;
			readonly scopes: readonly string[];
			readonly clientSecretLabel?: string;
			/** Machine-provisioned OAuth client credential. It can also be bound
			 * to resource requests when the provider requires it on every call. */
			readonly clientSecretName?: string;
			readonly authorization?: CompanyConnectorOAuthAuthorization;
			readonly clientAuthentication?: CompanyConnectorOAuthClientAuthentication;
			readonly tokenHeaders?: Readonly<Record<string, string>>;
	  };

export interface CompanyConnectorImplementation {
	readonly kind: "agent-playbook" | "company-tool";
	readonly entry: string;
}

export interface CompanyConnectorManifest {
	readonly schema: typeof COMPANY_CONNECTOR_SCHEMA;
	readonly id: string;
	readonly displayName: string;
	readonly purpose: string;
	readonly ownerAgentId: string;
	readonly environment?: "production" | "sandbox";
	readonly operations: readonly CompanyConnectorOperation[];
	readonly destinations: readonly CompanyConnectorDestination[];
	readonly authentication: CompanyConnectorAuthentication;
	readonly implementation: CompanyConnectorImplementation;
	readonly createdAt: string;
	readonly updatedAt: string;
}

export interface CompanyConnectorManifestRecord extends CompanyConnectorManifest {
	readonly relativePath: string;
}

export interface CompanyConnectorRequestShape {
	readonly staffAgentId: string;
	readonly displayName: string;
	readonly destinations: readonly { readonly host: string }[];
	readonly secretNames: readonly string[];
	readonly recipeId?: string;
}

const CONNECTOR_ID_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/;
const OPERATION_ID_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,127}$/;
const SECRET_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const STAFF_AGENT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;
const HTTP_HEADER_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9a-z-]+$/i;
const OAUTH_PARAMETER_NAME_PATTERN = /^[a-z][a-z0-9_.-]{0,63}$/;
const RESERVED_OAUTH_PARAMETERS = new Set([
	"client_id",
	"code_challenge",
	"code_challenge_method",
	"redirect_uri",
	"response_type",
	"scope",
	"state",
]);
const FORBIDDEN_CLIENT_AUTH_HEADERS = new Set(["authorization", "content-type", "cookie", "host"]);
const FORBIDDEN_TEMPLATE_HEADERS = new Set([
	"authorization",
	"connection",
	"content-length",
	"cookie",
	"host",
	"proxy-authorization",
	"transfer-encoding",
]);
const OAUTH_HEADER_TEMPLATE_NAMES = new Set(["body_sha256_digest", "http_date", "url_host"]);
const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_IMPLEMENTATION_BYTES = 1024 * 1024;

export function companyConnectorSecretNames(connector: CompanyConnectorManifest): string[] {
	if (connector.authentication.kind === "none") return [];
	return [
		connector.authentication.secretName,
		...(connector.authentication.kind === "oauth2" && connector.authentication.clientSecretName
			? [connector.authentication.clientSecretName]
			: []),
	];
}

/** The kernel authorizes only the manifest snapshot installed in the company.
 * ownerAgentId records the connector's maintainer and provenance; it does not
 * make a company capability exclusive to that agent. A consuming agent still
 * cannot widen the recipe's hosts, secret references, or display identity. */
export function companyConnectorMatchesRequest(
	connector: CompanyConnectorManifest,
	request: CompanyConnectorRequestShape,
): boolean {
	if (request.recipeId !== `company:${connector.id}` || request.displayName !== connector.displayName) {
		return false;
	}
	const requestedHosts = request.destinations.map((destination) => destination.host.toLowerCase()).sort();
	const connectorHosts = connector.destinations.map((destination) => destination.host).sort();
	if (JSON.stringify(requestedHosts) !== JSON.stringify(connectorHosts)) return false;
	return (
		JSON.stringify(request.secretNames.map((name) => name.toLowerCase()).sort()) ===
		JSON.stringify(companyConnectorSecretNames(connector).sort())
	);
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
	return Object.keys(value).every((key) => allowed.has(key));
}

function text(value: unknown, label: string, maximumBytes: number): string {
	if (
		typeof value !== "string" ||
		!value ||
		value !== value.trim() ||
		CONTROL_CHARACTER_PATTERN.test(value) ||
		Buffer.byteLength(value, "utf-8") > maximumBytes
	) {
		throw new Error(`${label} is invalid`);
	}
	return value;
}

function timestamp(value: unknown, label: string): string {
	const parsed = text(value, label, 64);
	const time = Date.parse(parsed);
	if (!Number.isFinite(time) || new Date(time).toISOString() !== parsed) throw new Error(`${label} is invalid`);
	return parsed;
}

function destination(value: unknown, index: number): CompanyConnectorDestination {
	const record = recordValue(value);
	if (!record || !hasOnlyKeys(record, new Set(["host", "note"]))) {
		throw new Error(`destinations[${index}] is invalid`);
	}
	const host = text(record.host, `destinations[${index}].host`, 259).toLowerCase();
	if (host.includes("://") || host.includes("/") || host.includes("@")) {
		throw new Error(`destinations[${index}].host is invalid`);
	}
	const match = host.match(/^([^:]+)(?::([0-9]{1,5}))?$/);
	if (
		!match?.[1] ||
		match[1].length > 253 ||
		match[1].split(".").some((part) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(part))
	) {
		throw new Error(`destinations[${index}].host is invalid`);
	}
	if (match[2] !== undefined) {
		const port = Number(match[2]);
		if (!Number.isInteger(port) || port < 1 || port > 65_535) {
			throw new Error(`destinations[${index}].host is invalid`);
		}
	}
	return {
		host,
		...(record.note !== undefined ? { note: text(record.note, `destinations[${index}].note`, 240) } : {}),
	};
}

function operation(value: unknown, index: number): CompanyConnectorOperation {
	const record = recordValue(value);
	if (
		!record ||
		!hasOnlyKeys(record, new Set(["id", "label", "description", "access"])) ||
		typeof record.id !== "string" ||
		!OPERATION_ID_PATTERN.test(record.id) ||
		(record.access !== "read" && record.access !== "write")
	) {
		throw new Error(`operations[${index}] is invalid`);
	}
	return {
		id: record.id,
		label: text(record.label, `operations[${index}].label`, 120),
		description: text(record.description, `operations[${index}].description`, 500),
		access: record.access,
	};
}

function httpsEndpoint(value: unknown, label: string): string {
	const raw = text(value, label, 2_048);
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw new Error(`${label} is invalid`);
	}
	if (url.protocol !== "https:" || url.username || url.password || url.hash || url.search || url.toString() !== raw) {
		throw new Error(`${label} is invalid`);
	}
	return raw;
}

function oauthHeaders(value: unknown, label: string): Readonly<Record<string, string>> {
	const record = recordValue(value);
	if (!record || Object.keys(record).length > 16) throw new Error(`${label} is invalid`);
	const headers: Record<string, string> = {};
	for (const [name, headerValue] of Object.entries(record)) {
		if (!HTTP_HEADER_NAME_PATTERN.test(name) || FORBIDDEN_TEMPLATE_HEADERS.has(name.toLowerCase())) {
			throw new Error(`${label} is invalid`);
		}
		const template = text(headerValue, `${label}.${name}`, 1_024);
		if (
			template.toLowerCase().includes("secret://") ||
			template.replace(/\$\{[^}]+\}/g, "").includes("${") ||
			![...template.matchAll(/\$\{([^}]+)\}/g)].every((match) => OAUTH_HEADER_TEMPLATE_NAMES.has(match[1]))
		) {
			throw new Error(`${label} is invalid`);
		}
		headers[name] = template;
	}
	return headers;
}

function authentication(value: unknown): CompanyConnectorAuthentication {
	const record = recordValue(value);
	if (!record || typeof record.kind !== "string") throw new Error("authentication is invalid");
	if (record.kind === "none") {
		if (!hasOnlyKeys(record, new Set(["kind"]))) throw new Error("authentication is invalid");
		return { kind: "none" };
	}
	if (record.kind === "api-key") {
		if (
			!hasOnlyKeys(record, new Set(["kind", "secretName", "label"])) ||
			typeof record.secretName !== "string" ||
			!SECRET_NAME_PATTERN.test(record.secretName)
		) {
			throw new Error("authentication is invalid");
		}
		return {
			kind: "api-key",
			secretName: record.secretName.toLowerCase(),
			label: text(record.label, "authentication.label", 120),
		};
	}
	if (record.kind !== "oauth2") throw new Error("authentication is invalid");
	if (
		!hasOnlyKeys(
			record,
			new Set([
				"kind",
				"secretName",
				"label",
				"authorizationUrl",
				"tokenUrl",
				"registrationUrl",
				"clientId",
				"scopes",
				"clientSecretLabel",
				"clientSecretName",
				"authorization",
				"clientAuthentication",
				"tokenHeaders",
			]),
		) ||
		typeof record.secretName !== "string" ||
		!SECRET_NAME_PATTERN.test(record.secretName) ||
		!Array.isArray(record.scopes) ||
		record.scopes.length > 32
	) {
		throw new Error("authentication is invalid");
	}
	const scopes = record.scopes.map((scope, index) => text(scope, `authentication.scopes[${index}]`, 160));
	if (new Set(scopes).size !== scopes.length) throw new Error("authentication.scopes must be unique");
	const clientSecretLabel =
		record.clientSecretLabel === undefined
			? undefined
			: text(record.clientSecretLabel, "authentication.clientSecretLabel", 120);
	const clientSecretName =
		record.clientSecretName === undefined
			? undefined
			: typeof record.clientSecretName === "string" && SECRET_NAME_PATTERN.test(record.clientSecretName)
				? record.clientSecretName.toLowerCase()
				: undefined;
	if (
		(record.clientSecretName !== undefined && clientSecretName === undefined) ||
		(clientSecretName && !clientSecretLabel) ||
		(clientSecretLabel && !clientSecretName)
	) {
		throw new Error("authentication OAuth client credential is invalid");
	}
	let authorization: CompanyConnectorOAuthAuthorization | undefined;
	if (record.authorization !== undefined) {
		const authorizationRecord = recordValue(record.authorization);
		if (
			!authorizationRecord ||
			!hasOnlyKeys(authorizationRecord, new Set(["method", "usePkce", "scopeSeparator", "parameters", "headers"])) ||
			(authorizationRecord.method !== undefined &&
				authorizationRecord.method !== "get" &&
				authorizationRecord.method !== "post") ||
			(authorizationRecord.usePkce !== undefined && typeof authorizationRecord.usePkce !== "boolean") ||
			(authorizationRecord.scopeSeparator !== undefined &&
				authorizationRecord.scopeSeparator !== "space" &&
				authorizationRecord.scopeSeparator !== "comma")
		) {
			throw new Error("authentication.authorization is invalid");
		}
		let parameters: Record<string, string> | undefined;
		if (authorizationRecord.parameters !== undefined) {
			const parameterRecord = recordValue(authorizationRecord.parameters);
			if (!parameterRecord || Object.keys(parameterRecord).length > 16) {
				throw new Error("authentication.authorization.parameters is invalid");
			}
			parameters = {};
			for (const [name, parameterValue] of Object.entries(parameterRecord)) {
				if (!OAUTH_PARAMETER_NAME_PATTERN.test(name) || RESERVED_OAUTH_PARAMETERS.has(name)) {
					throw new Error("authentication.authorization.parameters is invalid");
				}
				parameters[name] = text(parameterValue, `authentication.authorization.parameters.${name}`, 512);
			}
		}
		const headers =
			authorizationRecord.headers === undefined
				? undefined
				: oauthHeaders(authorizationRecord.headers, "authentication.authorization.headers");
		authorization = {
			...(authorizationRecord.method !== undefined ? { method: authorizationRecord.method } : {}),
			...(authorizationRecord.usePkce !== undefined ? { usePkce: authorizationRecord.usePkce } : {}),
			...(authorizationRecord.scopeSeparator !== undefined
				? { scopeSeparator: authorizationRecord.scopeSeparator }
				: {}),
			...(parameters !== undefined ? { parameters } : {}),
			...(headers !== undefined ? { headers } : {}),
		};
	}
	const tokenHeaders =
		record.tokenHeaders === undefined ? undefined : oauthHeaders(record.tokenHeaders, "authentication.tokenHeaders");
	let clientAuthentication: CompanyConnectorOAuthClientAuthentication | undefined;
	if (record.clientAuthentication !== undefined) {
		const clientAuthenticationRecord = recordValue(record.clientAuthentication);
		if (!clientAuthenticationRecord || typeof clientAuthenticationRecord.kind !== "string") {
			throw new Error("authentication.clientAuthentication is invalid");
		}
		if (clientAuthenticationRecord.kind === "body") {
			if (!hasOnlyKeys(clientAuthenticationRecord, new Set(["kind"]))) {
				throw new Error("authentication.clientAuthentication is invalid");
			}
			clientAuthentication = { kind: "body" };
		} else if (clientAuthenticationRecord.kind === "headers") {
			if (
				!hasOnlyKeys(clientAuthenticationRecord, new Set(["kind", "clientIdHeader", "clientSecretHeader"])) ||
				typeof clientAuthenticationRecord.clientIdHeader !== "string" ||
				typeof clientAuthenticationRecord.clientSecretHeader !== "string" ||
				!HTTP_HEADER_NAME_PATTERN.test(clientAuthenticationRecord.clientIdHeader) ||
				!HTTP_HEADER_NAME_PATTERN.test(clientAuthenticationRecord.clientSecretHeader) ||
				FORBIDDEN_CLIENT_AUTH_HEADERS.has(clientAuthenticationRecord.clientIdHeader.toLowerCase()) ||
				FORBIDDEN_CLIENT_AUTH_HEADERS.has(clientAuthenticationRecord.clientSecretHeader.toLowerCase()) ||
				clientAuthenticationRecord.clientIdHeader.toLowerCase() ===
					clientAuthenticationRecord.clientSecretHeader.toLowerCase() ||
				!clientSecretLabel ||
				!clientSecretName ||
				authorization?.method !== "post"
			) {
				throw new Error("authentication.clientAuthentication is invalid");
			}
			clientAuthentication = {
				kind: "headers",
				clientIdHeader: clientAuthenticationRecord.clientIdHeader,
				clientSecretHeader: clientAuthenticationRecord.clientSecretHeader,
			};
		} else {
			throw new Error("authentication.clientAuthentication is invalid");
		}
	}
	if (clientAuthentication?.kind === "headers") {
		const clientHeaders = new Set([
			clientAuthentication.clientIdHeader.toLowerCase(),
			clientAuthentication.clientSecretHeader.toLowerCase(),
		]);
		if (
			Object.keys(authorization?.headers ?? {}).some((name) => clientHeaders.has(name.toLowerCase())) ||
			Object.keys(tokenHeaders ?? {}).some((name) => clientHeaders.has(name.toLowerCase()))
		) {
			throw new Error("authentication client headers cannot be overridden");
		}
	}
	return {
		kind: "oauth2",
		secretName: record.secretName.toLowerCase(),
		label: text(record.label, "authentication.label", 120),
		authorizationUrl: httpsEndpoint(record.authorizationUrl, "authentication.authorizationUrl"),
		tokenUrl: httpsEndpoint(record.tokenUrl, "authentication.tokenUrl"),
		...(record.registrationUrl !== undefined
			? { registrationUrl: httpsEndpoint(record.registrationUrl, "authentication.registrationUrl") }
			: {}),
		clientId: text(record.clientId, "authentication.clientId", 512),
		scopes,
		...(clientSecretLabel !== undefined ? { clientSecretLabel } : {}),
		...(clientSecretName !== undefined ? { clientSecretName } : {}),
		...(authorization !== undefined ? { authorization } : {}),
		...(clientAuthentication !== undefined ? { clientAuthentication } : {}),
		...(tokenHeaders !== undefined ? { tokenHeaders } : {}),
	};
}

function portableEntry(value: unknown): string {
	const entry = text(value, "implementation.entry", 240);
	if (
		isAbsolute(entry) ||
		entry.includes("\\") ||
		entry.split("/").some((segment) => !segment || segment === "." || segment === "..")
	) {
		throw new Error("implementation.entry is invalid");
	}
	return entry;
}

function manifest(value: unknown, connectorId: string): CompanyConnectorManifest {
	const record = recordValue(value);
	if (
		!record ||
		!hasOnlyKeys(
			record,
			new Set([
				"schema",
				"id",
				"displayName",
				"purpose",
				"ownerAgentId",
				"environment",
				"operations",
				"destinations",
				"authentication",
				"implementation",
				"createdAt",
				"updatedAt",
			]),
		) ||
		record.schema !== COMPANY_CONNECTOR_SCHEMA ||
		record.id !== connectorId ||
		typeof record.id !== "string" ||
		!CONNECTOR_ID_PATTERN.test(record.id) ||
		typeof record.ownerAgentId !== "string" ||
		!STAFF_AGENT_ID_PATTERN.test(record.ownerAgentId) ||
		!Array.isArray(record.operations) ||
		record.operations.length < 1 ||
		record.operations.length > 64 ||
		!Array.isArray(record.destinations) ||
		record.destinations.length < 1 ||
		record.destinations.length > 32
	) {
		throw new Error("connector manifest is invalid");
	}
	const operations = record.operations.map(operation);
	if (new Set(operations.map((entry) => entry.id)).size !== operations.length) {
		throw new Error("connector operation ids must be unique");
	}
	const destinations = record.destinations.map(destination);
	if (new Set(destinations.map((entry) => entry.host)).size !== destinations.length) {
		throw new Error("connector destinations must be unique");
	}
	const implementationValue = recordValue(record.implementation);
	if (
		!implementationValue ||
		!hasOnlyKeys(implementationValue, new Set(["kind", "entry"])) ||
		(implementationValue.kind !== "agent-playbook" && implementationValue.kind !== "company-tool")
	) {
		throw new Error("implementation is invalid");
	}
	const createdAt = timestamp(record.createdAt, "createdAt");
	const updatedAt = timestamp(record.updatedAt, "updatedAt");
	if (Date.parse(updatedAt) < Date.parse(createdAt)) throw new Error("updatedAt predates createdAt");
	if (record.environment !== undefined && record.environment !== "production" && record.environment !== "sandbox") {
		throw new Error("environment is invalid");
	}
	const connectorAuthentication = authentication(record.authentication);
	const signatureTemplates =
		connectorAuthentication.kind === "oauth2" &&
		[
			...Object.entries(connectorAuthentication.authorization?.headers ?? {}),
			...Object.entries(connectorAuthentication.tokenHeaders ?? {}),
		]
			.filter(([name]) => name.toLowerCase() === "signature")
			.map(([, value]) => value);
	if (
		signatureTemplates &&
		signatureTemplates.length > 0 &&
		(record.environment !== "sandbox" ||
			signatureTemplates.some((value) => value !== "SKIP_SIGNATURE_VALIDATION_FOR_SANDBOX"))
	) {
		throw new Error("dynamic OAuth signatures require a host signer; only the sandbox bypass is supported");
	}
	return {
		schema: COMPANY_CONNECTOR_SCHEMA,
		id: record.id,
		displayName: text(record.displayName, "displayName", 120),
		purpose: text(record.purpose, "purpose", 1_000),
		ownerAgentId: record.ownerAgentId,
		...(record.environment !== undefined ? { environment: record.environment } : {}),
		operations,
		destinations,
		authentication: connectorAuthentication,
		implementation: {
			kind: implementationValue.kind,
			entry: portableEntry(implementationValue.entry),
		},
		createdAt,
		updatedAt,
	};
}

function physicalFile(path: string, maximumBytes: number): boolean {
	try {
		const entry = lstatSync(path);
		return entry.isFile() && !entry.isSymbolicLink() && entry.nlink === 1 && entry.size <= maximumBytes;
	} catch {
		return false;
	}
}

function manifestRecord(root: string, directory: string, connectorId: string): CompanyConnectorManifestRecord {
	const path = join(directory, "manifest.json");
	if (!physicalFile(path, MAX_MANIFEST_BYTES)) throw new Error("connector manifest is not a physical file");
	const parsed = manifest(JSON.parse(readFileSync(path, "utf-8")) as unknown, connectorId);
	const implementationPath = resolve(directory, parsed.implementation.entry);
	const directoryRelative = relative(directory, implementationPath);
	if (!directoryRelative || directoryRelative.startsWith("..") || isAbsolute(directoryRelative)) {
		throw new Error("connector implementation escaped its directory");
	}
	if (!physicalFile(implementationPath, MAX_IMPLEMENTATION_BYTES)) {
		throw new Error("connector implementation is not a physical file");
	}
	if (realpathSync(implementationPath) !== implementationPath) {
		throw new Error("connector implementation is not canonical");
	}
	return { ...parsed, relativePath: relative(root, path).replaceAll("\\", "/") };
}

/** Read installable, credential-free connector manifests from ordinary
 * company files. Invalid or half-written proposals stay invisible until the
 * agent completes them. */
export function readCompanyConnectorManifests(root: string): readonly CompanyConnectorManifestRecord[] {
	const canonicalRoot = realpathSync(resolve(root));
	const directory = join(canonicalRoot, "connectors");
	if (!existsSync(directory)) return Object.freeze([]);
	try {
		const entry = lstatSync(directory);
		if (!entry.isDirectory() || entry.isSymbolicLink() || realpathSync(directory) !== directory) {
			return Object.freeze([]);
		}
	} catch {
		return Object.freeze([]);
	}
	const records: CompanyConnectorManifestRecord[] = [];
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		if (!entry.isDirectory() || entry.isSymbolicLink() || !CONNECTOR_ID_PATTERN.test(entry.name)) continue;
		const connectorDirectory = join(directory, entry.name);
		try {
			if (realpathSync(connectorDirectory) !== connectorDirectory) continue;
			records.push(manifestRecord(canonicalRoot, connectorDirectory, entry.name));
		} catch {
			// An agent may still be creating this proposal. Other connectors remain usable.
		}
	}
	records.sort((left, right) => left.displayName.localeCompare(right.displayName) || left.id.localeCompare(right.id));
	return Object.freeze(records);
}
