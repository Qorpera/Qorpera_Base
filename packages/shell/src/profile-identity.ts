import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const PROFILE_ATTACHMENTS_FILE = "profile-attachments.json";
const LEGACY_PROFILE_ATTACHMENTS_SCHEMA = "qorpera.profile-attachments/v1";
const PROFILE_ATTACHMENTS_SCHEMA = "qorpera.profile-attachments/v2";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Every company is a cloud profile. The desktop keeps only a machine
 * attachment: which checkout folder belongs to which hosted profile. */
export type ProfileType = "cloud";
export type ProfileIdentityKey = `${ProfileType}:${string}`;

export interface CloudProfileIdentity {
	profileType: "cloud";
	profileId: string;
	environmentId: string;
}

export type ProfileIdentity = CloudProfileIdentity;

export type ProfileAttachment = ProfileIdentity & {
	attachedAt: string;
};

export function profileIdentityKey(identity: ProfileIdentity): ProfileIdentityKey {
	return `${identity.profileType}:${identity.profileId}`;
}

interface ProfileAttachments {
	schema: typeof PROFILE_ATTACHMENTS_SCHEMA;
	attachments: Record<string, ProfileAttachment>;
}

export function profileAttachmentsPath(userData: string): string {
	return join(userData, PROFILE_ATTACHMENTS_FILE);
}

function rootKey(root: string): string {
	const normalized = resolve(root);
	return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function emptyAttachments(): ProfileAttachments {
	return { schema: PROFILE_ATTACHMENTS_SCHEMA, attachments: {} };
}

/** Only cloud attachments are recognized. Records written by the retired
 * local profile type are ignored on read and dropped at the next write. */
function parseAttachment(value: unknown): ProfileAttachment | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const attachment = value as Partial<ProfileAttachment> & { environmentId?: unknown };
	if (
		attachment.profileType !== "cloud" ||
		typeof attachment.profileId !== "string" ||
		!UUID_PATTERN.test(attachment.profileId) ||
		typeof attachment.environmentId !== "string" ||
		!UUID_PATTERN.test(attachment.environmentId) ||
		typeof attachment.attachedAt !== "string" ||
		!Number.isFinite(Date.parse(attachment.attachedAt))
	) {
		return undefined;
	}
	return {
		profileType: "cloud",
		profileId: attachment.profileId,
		environmentId: attachment.environmentId,
		attachedAt: attachment.attachedAt,
	};
}

/** The attachment store is unreadable or unrecognizable. Callers must treat
 * this as "state unknown" — never as an empty store: rewriting defaults over
 * an unreadable file once silently detached a cloud company. */
export class ProfileAttachmentStoreError extends Error {}

const READ_RETRY_ATTEMPTS = 4;
const READ_RETRY_DELAY_MS = 10;

function sleepSync(milliseconds: number): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

/** Reads the store file, riding out the brief window in which a concurrent
 * atomic replace (temp + rename) leaves the path missing or locked on
 * Windows. Only a persistent ENOENT means the store does not exist. */
function readAttachmentsRaw(path: string): string | undefined {
	for (let attempt = 0; ; attempt += 1) {
		try {
			return readFileSync(path, "utf-8");
		} catch (error) {
			if (attempt < READ_RETRY_ATTEMPTS) {
				sleepSync(READ_RETRY_DELAY_MS);
				continue;
			}
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			throw new ProfileAttachmentStoreError(`Profile attachments could not be read: ${(error as Error).message}`);
		}
	}
}

function readAttachments(path: string): ProfileAttachments {
	const raw = readAttachmentsRaw(path);
	if (raw === undefined) return emptyAttachments();
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch (error) {
		throw new ProfileAttachmentStoreError(`Profile attachments are corrupt: ${(error as Error).message}`);
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new ProfileAttachmentStoreError("Profile attachments are corrupt: not a JSON object");
	}
	const record = value as { schema?: unknown; attachments?: unknown };
	if (
		(record.schema !== PROFILE_ATTACHMENTS_SCHEMA && record.schema !== LEGACY_PROFILE_ATTACHMENTS_SCHEMA) ||
		!record.attachments ||
		typeof record.attachments !== "object" ||
		Array.isArray(record.attachments)
	) {
		throw new ProfileAttachmentStoreError("Profile attachments have an unrecognized schema");
	}
	const attachments: Record<string, ProfileAttachment> = {};
	for (const [root, candidate] of Object.entries(record.attachments)) {
		const attachment = parseAttachment(candidate);
		if (attachment) attachments[rootKey(root)] = attachment;
	}
	return { schema: PROFILE_ATTACHMENTS_SCHEMA, attachments };
}

function writeAttachments(path: string, attachments: ProfileAttachments): void {
	const temporary = `${path}.${randomUUID()}.tmp`;
	try {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(temporary, `${JSON.stringify(attachments, null, "\t")}\n`, {
			encoding: "utf-8",
			mode: 0o600,
		});
		renameSync(temporary, path);
	} catch (error) {
		rmSync(temporary, { force: true });
		throw error;
	}
}

const LOCK_WAIT_MS = 2000;
const LOCK_POLL_MS = 25;
const LOCK_STALE_MS = 10_000;

/** Serializes read-modify-write across processes: a second app instance (or a
 * smoke boot) mutating the same store must not interleave with ours. mkdir is
 * the atomic acquire; a lock older than LOCK_STALE_MS is a crashed holder. */
function acquireStoreLock(path: string): () => void {
	const lockDir = `${path}.lock`;
	mkdirSync(dirname(path), { recursive: true });
	const deadline = Date.now() + LOCK_WAIT_MS;
	for (;;) {
		try {
			mkdirSync(lockDir);
			return () => {
				try {
					rmdirSync(lockDir);
				} catch {
					// Releasing a stale-collected lock is fine; never throw on release.
				}
			};
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
				throw new ProfileAttachmentStoreError(
					`Profile attachment lock could not be acquired: ${(error as Error).message}`,
				);
			}
		}
		try {
			if (Date.now() - statSync(lockDir).mtimeMs > LOCK_STALE_MS) {
				rmdirSync(lockDir);
				continue;
			}
		} catch {
			continue; // The holder released between our attempts; retry immediately.
		}
		if (Date.now() >= deadline) {
			throw new ProfileAttachmentStoreError("Profile attachments are locked by another process");
		}
		sleepSync(LOCK_POLL_MS);
	}
}

/** Every mutation goes through here: fresh read under the cross-process lock,
 * then an atomic replace. Return false from mutate to skip the write. */
function mutateAttachments(path: string, mutate: (attachments: ProfileAttachments) => boolean | undefined): void {
	const release = acquireStoreLock(path);
	try {
		const previous = readAttachments(path);
		const next: ProfileAttachments = { schema: PROFILE_ATTACHMENTS_SCHEMA, attachments: { ...previous.attachments } };
		if (mutate(next) === false) return;
		writeAttachments(path, next);
	} finally {
		release();
	}
}

function requireUuid(value: string, label: string): void {
	if (!UUID_PATTERN.test(value)) throw new Error(`${label} must be a UUID`);
}

export function readProfileAttachment(userData: string, root: string): ProfileAttachment | undefined {
	return readAttachments(profileAttachmentsPath(userData)).attachments[rootKey(root)];
}

/** A company folder is only usable through its cloud profile attachment; a
 * folder this machine has never attached is not a company. */
export function requireProfileAttachment(userData: string, root: string): ProfileAttachment {
	const attachment = readProfileAttachment(userData, root);
	if (!attachment) throw new Error(`Company folder is not attached to a cloud profile: ${root}`);
	return attachment;
}

/**
 * Attaches a checkout folder to a hosted cloud profile. Account membership is
 * verified by the hosted API; it is not part of this machine attachment.
 */
export function attachCloudProfile(
	userData: string,
	root: string,
	identity: Omit<CloudProfileIdentity, "profileType">,
): ProfileAttachment {
	requireUuid(identity.profileId, "Cloud profile id");
	requireUuid(identity.environmentId, "Cloud environment id");
	const path = profileAttachmentsPath(userData);
	const key = rootKey(root);
	let attachment!: ProfileAttachment;
	mutateAttachments(path, (attachments) => {
		const existing = attachments.attachments[key];
		if (existing) {
			if (existing.profileId !== identity.profileId || existing.environmentId !== identity.environmentId) {
				throw new Error("Company folder is already attached to a different cloud profile");
			}
			attachment = existing;
			return false;
		}
		attachment = {
			profileType: "cloud",
			...identity,
			attachedAt: new Date().toISOString(),
		};
		attachments.attachments[key] = attachment;
		return undefined;
	});
	return attachment;
}

/** Removes only this machine's checkout attachment; it never deletes a profile. */
export function forgetProfileAttachment(userData: string, root: string): void {
	const key = rootKey(root);
	mutateAttachments(profileAttachmentsPath(userData), (attachments) => {
		if (!attachments.attachments[key]) return false;
		delete attachments.attachments[key];
		return undefined;
	});
}
