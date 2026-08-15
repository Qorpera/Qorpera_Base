import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const PROFILE_OWNERS_FILE = "profile-owners.json";
const PROFILE_OWNERS_SCHEMA = "qorpera.profile-owners/v1";
const USER_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

interface ProfileOwners {
	schema: typeof PROFILE_OWNERS_SCHEMA;
	profiles: Record<string, string>;
}

export function profileOwnersPath(userData: string): string {
	return join(userData, PROFILE_OWNERS_FILE);
}

function profileKey(root: string): string {
	const normalized = resolve(root);
	return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function emptyOwners(): ProfileOwners {
	return { schema: PROFILE_OWNERS_SCHEMA, profiles: {} };
}

function readOwners(path: string): ProfileOwners {
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return emptyOwners();
		const value = parsed as { schema?: unknown; profiles?: unknown };
		if (value.schema !== PROFILE_OWNERS_SCHEMA || !value.profiles || typeof value.profiles !== "object") {
			return emptyOwners();
		}
		const profiles: Record<string, string> = {};
		for (const [root, userId] of Object.entries(value.profiles)) {
			if (typeof userId === "string" && USER_ID_PATTERN.test(userId)) profiles[root] = userId;
		}
		return { schema: PROFILE_OWNERS_SCHEMA, profiles };
	} catch {
		return emptyOwners();
	}
}

function writeOwners(path: string, owners: ProfileOwners): void {
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

export function claimUnownedProfiles(userData: string, userId: string, roots: readonly string[]): void {
	requireUserId(userId);
	const path = profileOwnersPath(userData);
	const owners = readOwners(path);
	let changed = false;
	for (const root of roots) {
		const key = profileKey(root);
		if (owners.profiles[key]) continue;
		owners.profiles[key] = userId;
		changed = true;
	}
	if (changed) writeOwners(path, owners);
}

export function claimProfile(userData: string, userId: string, root: string): void {
	requireUserId(userId);
	const path = profileOwnersPath(userData);
	const owners = readOwners(path);
	const key = profileKey(root);
	const existing = owners.profiles[key];
	if (existing && existing !== userId) throw new Error("profile belongs to another Qorpera account");
	if (existing === userId) return;
	owners.profiles[key] = userId;
	writeOwners(path, owners);
}

export function profileOwnedBy(userData: string, userId: string, root: string): boolean {
	if (!USER_ID_PATTERN.test(userId)) return false;
	return readOwners(profileOwnersPath(userData)).profiles[profileKey(root)] === userId;
}

export function forgetProfile(userData: string, userId: string, root: string): void {
	if (!USER_ID_PATTERN.test(userId)) return;
	const path = profileOwnersPath(userData);
	const owners = readOwners(path);
	const key = profileKey(root);
	if (owners.profiles[key] !== userId) return;
	delete owners.profiles[key];
	writeOwners(path, owners);
}
