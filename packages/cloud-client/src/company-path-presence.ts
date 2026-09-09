import { parseCloudCompanyPath } from "./company-path-schema.ts";

export const COMPANY_PATH_PRESENCE_SCHEMA = "qorpera.company-path-presence/v1";
export const COMPANY_PATH_PRESENCE_TTL_MS = 30_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA = /^[a-f0-9]{64}$/;
export type CompanyPathActivity = "reading" | "writing";
export type CompanyPathExtent = "object" | "subtree";
export interface CompanyPresenceRoute {
	token: string;
	relation: "self" | "below";
	extent: CompanyPathExtent;
	activity: CompanyPathActivity;
}
export interface CompanyPathPresenceStatement {
	schema: typeof COMPANY_PATH_PRESENCE_SCHEMA;
	companyId: string;
	environmentId: string;
	clientId: string;
	sequence: number;
	issuedAt: number;
	expiresAt: number;
	routes: CompanyPresenceRoute[];
}
export interface CompanyPathPresenceWire extends CompanyPathPresenceStatement {
	signature: string;
}
export interface CompanyPresenceIdentity {
	schema: "qorpera.native-presence-identity/v1";
	companyId: string;
	environmentId: string;
	clientId: string;
	runId: string;
	staffAgentId: string;
	publicKey: string;
	expiresAt: number;
}
export interface CompanyPresencePathRoutes {
	path: string;
	routes: Array<{ path: string; token: string }>;
}
export type CompanyPathPresenceView = {
	schema: "qorpera.company-path-presence-view/v1";
	state: "available" | "partial" | "unavailable";
	observedAt: number;
	paths: Array<{
		path: string;
		participants: Array<{
			staffAgentId: string;
			runId: string;
			activity: CompanyPathActivity;
			overlap: "same_object" | "within_subtree" | "ancestor_subtree";
			expiresAt: number;
		}>;
	}>;
};
function closed(value: unknown, keys: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join() !== keys)
		throw new Error("INVALID_COMPANY_PRESENCE");
	return value as Record<string, unknown>;
}
export function presenceUuid(value: unknown): string {
	if (typeof value !== "string" || !UUID.test(value)) throw new Error("INVALID_COMPANY_PRESENCE_ID");
	return value;
}
function integer(value: unknown, minimum: number): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum)
		throw new Error("INVALID_COMPANY_PRESENCE_TIME");
	return value;
}
export function companyPresencePaths(value: unknown): string[] {
	if (!Array.isArray(value) || value.length < 1 || value.length > 8) throw new Error("INVALID_COMPANY_PRESENCE_PATHS");
	const result = value.map((item) => parseCloudCompanyPath(item, true));
	if (new Set(result).size !== result.length || result.some((path) => path !== "" && path.split("/").length > 16))
		throw new Error("INVALID_COMPANY_PRESENCE_PATHS");
	return result;
}
export function parseCompanyPresenceIdentity(value: unknown): CompanyPresenceIdentity {
	const row = closed(value, "clientId,companyId,environmentId,expiresAt,publicKey,runId,schema,staffAgentId");
	if (
		row.schema !== "qorpera.native-presence-identity/v1" ||
		typeof row.publicKey !== "string" ||
		!/^MCowBQYDK2VwAyEA[A-Za-z0-9+/]{43}=$/.test(row.publicKey)
	)
		throw new Error("INVALID_COMPANY_PRESENCE_IDENTITY");
	return {
		schema: row.schema,
		companyId: presenceUuid(row.companyId),
		environmentId: presenceUuid(row.environmentId),
		clientId: presenceUuid(row.clientId),
		runId: presenceUuid(row.runId),
		staffAgentId: presenceUuid(row.staffAgentId),
		publicKey: row.publicKey,
		expiresAt: integer(row.expiresAt, 1),
	};
}
export function parseCompanyPresenceRoutes(value: unknown, requested: readonly string[]): CompanyPresencePathRoutes[] {
	if (!Array.isArray(value) || value.length !== requested.length) throw new Error("INVALID_COMPANY_PRESENCE_SCOPE");
	return value.map((item, index) => {
		const row = closed(item, "path,routes");
		if (row.path !== requested[index] || !Array.isArray(row.routes) || row.routes.length > 17)
			throw new Error("INVALID_COMPANY_PRESENCE_SCOPE");
		const path = requested[index];
		const seen = new Set<string>();
		return {
			path,
			routes: row.routes.map((entry) => {
				const route = closed(entry, "path,token");
				const prefix = parseCloudCompanyPath(route.path, true);
				if (
					(prefix !== "" && prefix !== path && !path.startsWith(`${prefix}/`)) ||
					seen.has(prefix) ||
					typeof route.token !== "string" ||
					!SHA.test(route.token)
				)
					throw new Error("INVALID_COMPANY_PRESENCE_ROUTE");
				seen.add(prefix);
				return { path: prefix, token: route.token };
			}),
		};
	});
}
export function parseCompanyPathPresence(value: unknown): CompanyPathPresenceWire {
	const row = closed(value, "clientId,companyId,environmentId,expiresAt,issuedAt,routes,schema,sequence,signature");
	if (
		row.schema !== COMPANY_PATH_PRESENCE_SCHEMA ||
		typeof row.signature !== "string" ||
		!/^[A-Za-z0-9+/]{86}==$/.test(row.signature) ||
		!Array.isArray(row.routes) ||
		row.routes.length > 136
	)
		throw new Error("INVALID_COMPANY_PRESENCE_STATEMENT");
	const issuedAt = integer(row.issuedAt, 1);
	const expiresAt = integer(row.expiresAt, issuedAt + 1);
	if (expiresAt - issuedAt > COMPANY_PATH_PRESENCE_TTL_MS) throw new Error("INVALID_COMPANY_PRESENCE_LIFETIME");
	return {
		schema: row.schema,
		companyId: presenceUuid(row.companyId),
		environmentId: presenceUuid(row.environmentId),
		clientId: presenceUuid(row.clientId),
		sequence: integer(row.sequence, 1),
		issuedAt,
		expiresAt,
		signature: row.signature,
		routes: row.routes.map((value) => {
			const route = closed(value, "activity,extent,relation,token");
			if (
				typeof route.token !== "string" ||
				!SHA.test(route.token) ||
				(route.relation !== "self" && route.relation !== "below") ||
				(route.extent !== "object" && route.extent !== "subtree") ||
				(route.activity !== "reading" && route.activity !== "writing")
			)
				throw new Error("INVALID_COMPANY_PRESENCE_ROUTE");
			return { token: route.token, relation: route.relation, extent: route.extent, activity: route.activity };
		}),
	};
}
/** Canonical signed bytes exclude only the signature. Scope prevents replay across companies/environments. */
export function companyPresenceBytes(value: CompanyPathPresenceStatement): Uint8Array<ArrayBuffer> {
	return new TextEncoder().encode(
		JSON.stringify([
			value.schema,
			value.companyId,
			value.environmentId,
			value.clientId,
			value.sequence,
			value.issuedAt,
			value.expiresAt,
			value.routes.map((r) => [r.token, r.relation, r.extent, r.activity]),
		]),
	);
}
export function companyPresenceOverlap(
	route: CompanyPresenceRoute,
	prefix: string,
	requested: string,
): CompanyPathPresenceView["paths"][number]["participants"][number]["overlap"] | null {
	if (prefix === requested) return route.relation === "self" ? "same_object" : "within_subtree";
	return route.relation === "self" && route.extent === "subtree" ? "ancestor_subtree" : null;
}
