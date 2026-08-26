import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const COMPANY_APPEARANCES_FILE = "company-appearances.json";
const COMPANY_APPEARANCES_SCHEMA = "qorpera.company-appearances/v2";
const USER_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const COMPANY_ICON_DATA_URL_PATTERN = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/;
const MAX_COMPANY_ICON_BYTES = 1024 * 1024;

export const COMPANY_ICON_IDS = ["agent-halo", "agent-bloom", "agent-folio", "agent-pebble", "anonymous"] as const;

type CompanyIconMediaType = "image/jpeg" | "image/png" | "image/webp";

export type CompanyIconId = (typeof COMPANY_ICON_IDS)[number] | `data:${CompanyIconMediaType};base64,${string}`;

export const DEFAULT_COMPANY_ICON_ID: CompanyIconId = "agent-halo";

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
	if (typeof value === "string" && COMPANY_ICON_IDS.includes(value as (typeof COMPANY_ICON_IDS)[number])) return true;
	if (typeof value !== "string" || value.length > Math.ceil((MAX_COMPANY_ICON_BYTES * 4) / 3) + 64) return false;
	const match = COMPANY_ICON_DATA_URL_PATTERN.exec(value);
	if (!match) return false;
	const bytes = Buffer.from(match[2]!, "base64");
	if (bytes.length === 0 || bytes.length > MAX_COMPANY_ICON_BYTES || bytes.toString("base64") !== match[2])
		return false;
	if (match[1] === "image/png") return bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"));
	if (match[1] === "image/jpeg") return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
	return bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP";
}

function parseAppearances(path: string): CompanyAppearances {
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return emptyAppearances();
		const value = parsed as Record<string, unknown>;
		const records = value.companies;
		if (
			value.schema !== COMPANY_APPEARANCES_SCHEMA ||
			!records ||
			typeof records !== "object" ||
			Array.isArray(records)
		) {
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
	return parseAppearances(companyAppearancesPath(userData));
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
