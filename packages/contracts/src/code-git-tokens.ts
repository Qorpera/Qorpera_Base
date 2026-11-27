import { parseRecord } from "./wire-values.ts";

export const CODE_GIT_TOKEN_SCOPES = ["read", "write"] as const;
export type CodeGitTokenScope = (typeof CODE_GIT_TOKEN_SCOPES)[number];

export interface CodeGitTokenSummary {
	readonly id: string;
	readonly userId: string;
	readonly label: string;
	readonly tokenPrefix: string;
	readonly scope: CodeGitTokenScope;
	readonly owner: string | null;
	readonly name: string | null;
	readonly createdAt: string;
	readonly expiresAt: string;
	readonly lastUsedAt: string | null;
	readonly revokedAt: string | null;
}

export interface CreatedCodeGitToken {
	readonly id: string;
	readonly token: string;
	readonly tokenPrefix: string;
	readonly label: string;
	readonly scope: CodeGitTokenScope;
	readonly owner: string | null;
	readonly name: string | null;
	readonly createdAt: string;
	readonly expiresAt: string;
}

export interface RevokedCodeGitToken {
	readonly id: string;
	readonly revokedAt: string;
}

function parseRequiredString(value: unknown, field: string): string {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new Error(`${field} must be a non-empty string`);
	}
	return value;
}

function parseOptionalString(value: unknown, field: string): string | null {
	if (value === undefined || value === null) return null;
	if (typeof value !== "string") {
		throw new Error(`${field} must be a string or null`);
	}
	return value;
}

function parseScope(value: unknown): CodeGitTokenScope {
	if (value === "read" || value === "write") return value;
	throw new Error("scope must be read or write");
}

export function parseCodeGitTokenSummary(value: unknown): CodeGitTokenSummary {
	const record = parseRecord(value, "CodeGitTokenSummary");
	return {
		id: parseRequiredString(record.id, "id"),
		userId: parseRequiredString(record.userId, "userId"),
		label: parseRequiredString(record.label, "label"),
		tokenPrefix: parseRequiredString(record.tokenPrefix, "tokenPrefix"),
		scope: parseScope(record.scope),
		owner: parseOptionalString(record.owner, "owner"),
		name: parseOptionalString(record.name, "name"),
		createdAt: parseRequiredString(record.createdAt, "createdAt"),
		expiresAt: parseRequiredString(record.expiresAt, "expiresAt"),
		lastUsedAt: parseOptionalString(record.lastUsedAt, "lastUsedAt"),
		revokedAt: parseOptionalString(record.revokedAt, "revokedAt"),
	};
}

export function parseCreatedCodeGitToken(value: unknown): CreatedCodeGitToken {
	const record = parseRecord(value, "CreatedCodeGitToken");
	return {
		id: parseRequiredString(record.id, "id"),
		token: parseRequiredString(record.token, "token"),
		tokenPrefix: parseRequiredString(record.tokenPrefix, "tokenPrefix"),
		label: parseRequiredString(record.label, "label"),
		scope: parseScope(record.scope),
		owner: parseOptionalString(record.owner, "owner"),
		name: parseOptionalString(record.name, "name"),
		createdAt: parseRequiredString(record.createdAt, "createdAt"),
		expiresAt: parseRequiredString(record.expiresAt, "expiresAt"),
	};
}

export function parseRevokedCodeGitToken(value: unknown): RevokedCodeGitToken {
	const record = parseRecord(value, "RevokedCodeGitToken");
	return {
		id: parseRequiredString(record.id, "id"),
		revokedAt: parseRequiredString(record.revokedAt, "revokedAt"),
	};
}
