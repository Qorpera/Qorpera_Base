import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const COMPANY_OWNERS_FILE = "company-owners.json";
const COMPANY_OWNERS_SCHEMA = "qorpera.company-owners/v1";
const LEGACY_PROFILE_OWNERS_FILE = "profile-owners.json";
const LEGACY_PROFILE_OWNERS_SCHEMA = "qorpera.profile-owners/v1";
const USER_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

interface CompanyOwners {
	schema: typeof COMPANY_OWNERS_SCHEMA;
	companies: Record<string, string>;
}

export function companyOwnersPath(userData: string): string {
	return join(userData, COMPANY_OWNERS_FILE);
}

function companyKey(root: string): string {
	const normalized = resolve(root);
	return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function emptyOwners(): CompanyOwners {
	return { schema: COMPANY_OWNERS_SCHEMA, companies: {} };
}

function parseOwners(path: string, schema: string, recordsKey: "companies" | "profiles"): CompanyOwners {
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return emptyOwners();
		const value = parsed as Record<string, unknown>;
		const records = value[recordsKey];
		if (value.schema !== schema || !records || typeof records !== "object" || Array.isArray(records)) {
			return emptyOwners();
		}
		const companies: Record<string, string> = {};
		for (const [root, userId] of Object.entries(records)) {
			if (typeof userId === "string" && USER_ID_PATTERN.test(userId)) companies[root] = userId;
		}
		return { schema: COMPANY_OWNERS_SCHEMA, companies };
	} catch {
		return emptyOwners();
	}
}

function readOwners(userData: string): CompanyOwners {
	const path = companyOwnersPath(userData);
	if (existsSync(path)) return parseOwners(path, COMPANY_OWNERS_SCHEMA, "companies");
	const legacyPath = join(userData, LEGACY_PROFILE_OWNERS_FILE);
	return existsSync(legacyPath) ? parseOwners(legacyPath, LEGACY_PROFILE_OWNERS_SCHEMA, "profiles") : emptyOwners();
}

function writeOwners(path: string, owners: CompanyOwners): void {
	const temporary = `${path}.${randomUUID()}.tmp`;
	try {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(temporary, `${JSON.stringify(owners, null, "\t")}\n`, { encoding: "utf-8", mode: 0o600 });
		renameSync(temporary, path);
	} catch (error) {
		rmSync(temporary, { force: true });
		throw error;
	}
}

function requireUserId(userId: string): void {
	if (!USER_ID_PATTERN.test(userId)) throw new Error("invalid Qorpera account id");
}

export function claimUnownedCompanies(userData: string, userId: string, roots: readonly string[]): void {
	requireUserId(userId);
	const path = companyOwnersPath(userData);
	const owners = readOwners(userData);
	let changed = false;
	for (const root of roots) {
		const key = companyKey(root);
		if (owners.companies[key]) continue;
		owners.companies[key] = userId;
		changed = true;
	}
	if (changed) writeOwners(path, owners);
}

export function claimCompany(userData: string, userId: string, root: string): void {
	requireUserId(userId);
	const path = companyOwnersPath(userData);
	const owners = readOwners(userData);
	const key = companyKey(root);
	const existing = owners.companies[key];
	if (existing && existing !== userId) throw new Error("company belongs to another Qorpera account");
	if (existing === userId) {
		if (!existsSync(path)) writeOwners(path, owners);
		return;
	}
	owners.companies[key] = userId;
	writeOwners(path, owners);
}

export function companyOwnedBy(userData: string, userId: string, root: string): boolean {
	if (!USER_ID_PATTERN.test(userId)) return false;
	return readOwners(userData).companies[companyKey(root)] === userId;
}

export function forgetCompany(userData: string, userId: string, root: string): void {
	if (!USER_ID_PATTERN.test(userId)) return;
	const path = companyOwnersPath(userData);
	const owners = readOwners(userData);
	const key = companyKey(root);
	if (owners.companies[key] !== userId) return;
	delete owners.companies[key];
	writeOwners(path, owners);
}
