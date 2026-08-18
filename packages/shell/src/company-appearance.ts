import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const COMPANY_APPEARANCES_FILE = "company-appearances.json";
const COMPANY_APPEARANCES_SCHEMA = "qorpera.company-appearances/v1";
const LEGACY_PROFILE_APPEARANCES_FILE = "profile-appearances.json";
const LEGACY_PROFILE_APPEARANCES_SCHEMA = "qorpera.profile-appearances/v1";
const USER_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export const COMPANY_ICON_IDS = ["hop-warm-titanium", "hop-blue-steel", "hop-mono-cloud"] as const;

export type CompanyIconId = (typeof COMPANY_ICON_IDS)[number];

export const DEFAULT_COMPANY_ICON_ID: CompanyIconId = "hop-warm-titanium";

interface CompanyAppearanceRecord {
	userId: string;
	iconId: CompanyIconId;
}

interface CompanyAppearances {
	schema: typeof COMPANY_APPEARANCES_SCHEMA;
	companies: Record<string, CompanyAppearanceRecord>;
}

export function companyAppearancesPath(userData: string): string {
	return join(userData, COMPANY_APPEARANCES_FILE);
}

function companyKey(root: string): string {
	const normalized = resolve(root);
	return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function emptyAppearances(): CompanyAppearances {
	return { schema: COMPANY_APPEARANCES_SCHEMA, companies: {} };
}

export function isCompanyIconId(value: unknown): value is CompanyIconId {
	return typeof value === "string" && COMPANY_ICON_IDS.includes(value as CompanyIconId);
}

function parseAppearances(path: string, schema: string, recordsKey: "companies" | "profiles"): CompanyAppearances {
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return emptyAppearances();
		const value = parsed as Record<string, unknown>;
		const records = value[recordsKey];
		if (value.schema !== schema || !records || typeof records !== "object" || Array.isArray(records)) {
			return emptyAppearances();
		}
		const companies: Record<string, CompanyAppearanceRecord> = {};
		for (const [root, record] of Object.entries(records)) {
			if (!record || typeof record !== "object" || Array.isArray(record)) continue;
			const candidate = record as { userId?: unknown; iconId?: unknown };
			if (typeof candidate.userId !== "string" || !USER_ID_PATTERN.test(candidate.userId)) continue;
			if (!isCompanyIconId(candidate.iconId)) continue;
			companies[root] = { userId: candidate.userId, iconId: candidate.iconId };
		}
		return { schema: COMPANY_APPEARANCES_SCHEMA, companies };
	} catch {
		return emptyAppearances();
	}
}

function readAppearances(userData: string): CompanyAppearances {
	const path = companyAppearancesPath(userData);
	if (existsSync(path)) return parseAppearances(path, COMPANY_APPEARANCES_SCHEMA, "companies");
	const legacyPath = join(userData, LEGACY_PROFILE_APPEARANCES_FILE);
	return existsSync(legacyPath)
		? parseAppearances(legacyPath, LEGACY_PROFILE_APPEARANCES_SCHEMA, "profiles")
		: emptyAppearances();
}

function writeAppearances(path: string, appearances: CompanyAppearances): void {
	const temporary = `${path}.${randomUUID()}.tmp`;
	try {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(temporary, `${JSON.stringify(appearances, null, "\t")}\n`, { encoding: "utf-8", mode: 0o600 });
		renameSync(temporary, path);
	} catch (error) {
		rmSync(temporary, { force: true });
		throw error;
	}
}

function requireUserId(userId: string): void {
	if (!USER_ID_PATTERN.test(userId)) throw new Error("invalid Qorpera account id");
}

export function readCompanyIcon(userData: string, userId: string, root: string): CompanyIconId {
	if (!USER_ID_PATTERN.test(userId)) return DEFAULT_COMPANY_ICON_ID;
	const record = readAppearances(userData).companies[companyKey(root)];
	return record?.userId === userId ? record.iconId : DEFAULT_COMPANY_ICON_ID;
}

export function writeCompanyIcon(userData: string, userId: string, root: string, iconId: CompanyIconId): void {
	requireUserId(userId);
	if (!isCompanyIconId(iconId)) throw new Error("invalid company icon");
	const appearances = readAppearances(userData);
	appearances.companies[companyKey(root)] = { userId, iconId };
	writeAppearances(companyAppearancesPath(userData), appearances);
}

export function forgetCompanyIcon(userData: string, userId: string, root: string): void {
	if (!USER_ID_PATTERN.test(userId)) return;
	const appearances = readAppearances(userData);
	const key = companyKey(root);
	if (appearances.companies[key]?.userId !== userId) return;
	delete appearances.companies[key];
	writeAppearances(companyAppearancesPath(userData), appearances);
}
