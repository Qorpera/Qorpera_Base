import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const PROFILE_APPEARANCES_FILE = "profile-appearances.json";
const PROFILE_APPEARANCES_SCHEMA = "qorpera.profile-appearances/v1";
const USER_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export const PROFILE_ICON_IDS = ["hop-warm-titanium", "hop-blue-steel", "hop-mono-cloud"] as const;

export type ProfileIconId = (typeof PROFILE_ICON_IDS)[number];

export const DEFAULT_PROFILE_ICON_ID: ProfileIconId = "hop-warm-titanium";

interface ProfileAppearanceRecord {
	userId: string;
	iconId: ProfileIconId;
}

interface ProfileAppearances {
	schema: typeof PROFILE_APPEARANCES_SCHEMA;
	profiles: Record<string, ProfileAppearanceRecord>;
}

export function profileAppearancesPath(userData: string): string {
	return join(userData, PROFILE_APPEARANCES_FILE);
}

function profileKey(root: string): string {
	const normalized = resolve(root);
	return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function emptyAppearances(): ProfileAppearances {
	return { schema: PROFILE_APPEARANCES_SCHEMA, profiles: {} };
}

export function isProfileIconId(value: unknown): value is ProfileIconId {
	return typeof value === "string" && PROFILE_ICON_IDS.includes(value as ProfileIconId);
}

function readAppearances(path: string): ProfileAppearances {
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return emptyAppearances();
		const value = parsed as { schema?: unknown; profiles?: unknown };
		if (value.schema !== PROFILE_APPEARANCES_SCHEMA || !value.profiles || typeof value.profiles !== "object") {
			return emptyAppearances();
		}
		const profiles: Record<string, ProfileAppearanceRecord> = {};
		for (const [root, record] of Object.entries(value.profiles)) {
			if (!record || typeof record !== "object" || Array.isArray(record)) continue;
			const candidate = record as { userId?: unknown; iconId?: unknown };
			if (typeof candidate.userId !== "string" || !USER_ID_PATTERN.test(candidate.userId)) continue;
			if (!isProfileIconId(candidate.iconId)) continue;
			profiles[root] = { userId: candidate.userId, iconId: candidate.iconId };
		}
		return { schema: PROFILE_APPEARANCES_SCHEMA, profiles };
	} catch {
		return emptyAppearances();
	}
}

function writeAppearances(path: string, appearances: ProfileAppearances): void {
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

export function readProfileIcon(userData: string, userId: string, root: string): ProfileIconId {
	if (!USER_ID_PATTERN.test(userId)) return DEFAULT_PROFILE_ICON_ID;
	const record = readAppearances(profileAppearancesPath(userData)).profiles[profileKey(root)];
	return record?.userId === userId ? record.iconId : DEFAULT_PROFILE_ICON_ID;
}

export function writeProfileIcon(userData: string, userId: string, root: string, iconId: ProfileIconId): void {
	requireUserId(userId);
	if (!isProfileIconId(iconId)) throw new Error("invalid profile icon");
	const path = profileAppearancesPath(userData);
	const appearances = readAppearances(path);
	appearances.profiles[profileKey(root)] = { userId, iconId };
	writeAppearances(path, appearances);
}

export function forgetProfileIcon(userData: string, userId: string, root: string): void {
	if (!USER_ID_PATTERN.test(userId)) return;
	const path = profileAppearancesPath(userData);
	const appearances = readAppearances(path);
	const key = profileKey(root);
	if (appearances.profiles[key]?.userId !== userId) return;
	delete appearances.profiles[key];
	writeAppearances(path, appearances);
}
