import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const INTELLIGENCE_ACCOUNT_FILE = "intelligence-account.json";
const INTELLIGENCE_ACCOUNT_SCHEMA = "qorpera.intelligence-account/v1";

export interface IntelligenceAccountBinding {
	readonly accountUserId: string;
	readonly providerId: string;
}

export function intelligenceAccountBindingPath(userData: string): string {
	return join(userData, INTELLIGENCE_ACCOUNT_FILE);
}

export function intelligenceBindingMatches(
	binding: IntelligenceAccountBinding | undefined,
	accountUserId: string | undefined,
	providerId: string | undefined,
): boolean {
	return Boolean(
		binding &&
			accountUserId &&
			providerId &&
			binding.accountUserId === accountUserId &&
			binding.providerId === providerId,
	);
}

export function readIntelligenceAccountBinding(userData: string): IntelligenceAccountBinding | undefined {
	try {
		const value: unknown = JSON.parse(readFileSync(intelligenceAccountBindingPath(userData), "utf-8"));
		if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
		const record = value as Record<string, unknown>;
		if (
			record.schema !== INTELLIGENCE_ACCOUNT_SCHEMA ||
			typeof record.accountUserId !== "string" ||
			!record.accountUserId.trim() ||
			typeof record.providerId !== "string" ||
			!record.providerId.trim()
		) {
			return undefined;
		}
		return {
			accountUserId: record.accountUserId,
			providerId: record.providerId,
		};
	} catch {
		return undefined;
	}
}

export function writeIntelligenceAccountBinding(userData: string, binding: IntelligenceAccountBinding): boolean {
	if (!binding.accountUserId.trim() || !binding.providerId.trim()) return false;
	const path = intelligenceAccountBindingPath(userData);
	const temporary = `${path}.${randomUUID()}.tmp`;
	try {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(
			temporary,
			`${JSON.stringify(
				{
					schema: INTELLIGENCE_ACCOUNT_SCHEMA,
					accountUserId: binding.accountUserId,
					providerId: binding.providerId,
				},
				null,
				"\t",
			)}\n`,
			{ encoding: "utf-8", mode: 0o600 },
		);
		renameSync(temporary, path);
		return true;
	} catch {
		rmSync(temporary, { force: true });
		return false;
	}
}

export function clearIntelligenceAccountBinding(userData: string): boolean {
	try {
		rmSync(intelligenceAccountBindingPath(userData), { force: true });
		return true;
	} catch {
		return false;
	}
}
