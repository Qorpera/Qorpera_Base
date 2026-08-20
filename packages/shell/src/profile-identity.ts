import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const PROFILE_ATTACHMENTS_FILE = "profile-attachments.json";
const LEGACY_PROFILE_ATTACHMENTS_SCHEMA = "qorpera.profile-attachments/v1";
const PROFILE_ATTACHMENTS_SCHEMA = "qorpera.profile-attachments/v2";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type ProfileType = "local" | "cloud";
export type ProfileIdentityKey = `${ProfileType}:${string}`;

export interface LocalProfileIdentity {
	profileType: "local";
	profileId: string;
}

export interface CloudProfileIdentity {
	profileType: "cloud";
	profileId: string;
	environmentId: string;
}

export type ProfileIdentity = LocalProfileIdentity | CloudProfileIdentity;

export const PROFILE_PROMOTION_PHASES = ["requested", "provisioning", "identity-ready", "complete", "failed"] as const;
export type ProfilePromotionPhase = (typeof PROFILE_PROMOTION_PHASES)[number];

export interface ProfilePromotion {
	promotionId: string;
	sourceProfileId: string;
	phase: ProfilePromotionPhase;
	startedAt: string;
	updatedAt: string;
	cloudProfileId?: string;
	environmentId?: string;
	lastError?: string;
}

export type ProfileAttachment = ProfileIdentity & {
	attachedAt: string;
	promotion?: ProfilePromotion;
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

function timestamp(value: unknown): value is string {
	return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function parsePromotion(value: unknown, sourceProfileId?: string): ProfilePromotion | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const promotion = value as Partial<ProfilePromotion>;
	if (
		typeof promotion.promotionId !== "string" ||
		!UUID_PATTERN.test(promotion.promotionId) ||
		typeof promotion.sourceProfileId !== "string" ||
		!UUID_PATTERN.test(promotion.sourceProfileId) ||
		(sourceProfileId !== undefined && promotion.sourceProfileId !== sourceProfileId) ||
		!PROFILE_PROMOTION_PHASES.some((candidate) => candidate === promotion.phase) ||
		!timestamp(promotion.startedAt) ||
		!timestamp(promotion.updatedAt) ||
		(promotion.cloudProfileId !== undefined && !UUID_PATTERN.test(promotion.cloudProfileId)) ||
		(promotion.environmentId !== undefined && !UUID_PATTERN.test(promotion.environmentId)) ||
		(promotion.lastError !== undefined && typeof promotion.lastError !== "string")
	) {
		return undefined;
	}
	if ((promotion.cloudProfileId === undefined) !== (promotion.environmentId === undefined)) return undefined;
	return {
		promotionId: promotion.promotionId,
		sourceProfileId: promotion.sourceProfileId,
		phase: promotion.phase!,
		startedAt: promotion.startedAt,
		updatedAt: promotion.updatedAt,
		...(promotion.cloudProfileId ? { cloudProfileId: promotion.cloudProfileId } : {}),
		...(promotion.environmentId ? { environmentId: promotion.environmentId } : {}),
		...(promotion.lastError ? { lastError: promotion.lastError } : {}),
	};
}

function parseAttachment(value: unknown): ProfileAttachment | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const attachment = value as Partial<ProfileAttachment> & { environmentId?: unknown; promotion?: unknown };
	if (
		(attachment.profileType !== "local" && attachment.profileType !== "cloud") ||
		typeof attachment.profileId !== "string" ||
		!UUID_PATTERN.test(attachment.profileId) ||
		typeof attachment.attachedAt !== "string" ||
		!Number.isFinite(Date.parse(attachment.attachedAt))
	) {
		return undefined;
	}
	const promotion = parsePromotion(
		attachment.promotion,
		attachment.profileType === "local" ? attachment.profileId : undefined,
	);
	if (attachment.profileType === "cloud") {
		if (typeof attachment.environmentId !== "string" || !UUID_PATTERN.test(attachment.environmentId)) {
			return undefined;
		}
		return {
			profileType: "cloud",
			profileId: attachment.profileId,
			environmentId: attachment.environmentId,
			attachedAt: attachment.attachedAt,
			...(promotion ? { promotion } : {}),
		};
	}
	return {
		profileType: "local",
		profileId: attachment.profileId,
		attachedAt: attachment.attachedAt,
		...(promotion ? { promotion } : {}),
	};
}

/** The attachment store is unreadable or unrecognizable. Callers must treat
 * this as "state unknown" — never as an empty store: rewriting defaults over
 * an unreadable file silently downgraded a cloud attachment to local once. */
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
 * then an atomic replace. Return false from mutate to skip the write. A cloud
 * attachment can only be replaced by a local one through data corruption or a
 * mis-read, never intentionally — refuse it at the commit boundary. */
function mutateAttachments(path: string, mutate: (attachments: ProfileAttachments) => boolean | undefined): void {
	const release = acquireStoreLock(path);
	try {
		const previous = readAttachments(path);
		const next: ProfileAttachments = { schema: PROFILE_ATTACHMENTS_SCHEMA, attachments: { ...previous.attachments } };
		if (mutate(next) === false) return;
		for (const [key, before] of Object.entries(previous.attachments)) {
			const after = next.attachments[key];
			if (before.profileType === "cloud" && after && after.profileType === "local") {
				throw new ProfileAttachmentStoreError(
					"Refusing to replace a cloud profile attachment with a local one; detach it explicitly first",
				);
			}
		}
		writeAttachments(path, next);
	} finally {
		release();
	}
}

function requireUuid(value: string, label: string): void {
	if (!UUID_PATTERN.test(value)) throw new Error(`${label} must be a UUID`);
}

function saveAttachment(userData: string, root: string, attachment: ProfileAttachment): ProfileAttachment {
	mutateAttachments(profileAttachmentsPath(userData), (attachments) => {
		attachments.attachments[rootKey(root)] = attachment;
		return undefined;
	});
	return attachment;
}

export function readProfileAttachment(userData: string, root: string): ProfileAttachment | undefined {
	return readAttachments(profileAttachmentsPath(userData)).attachments[rootKey(root)];
}

/**
 * Classifies a previously unseen company folder as a local profile. Existing
 * cloud attachments remain cloud profiles when opened on this machine.
 */
export function ensureProfileAttachment(
	userData: string,
	root: string,
	localProfileId = randomUUID(),
): ProfileAttachment {
	requireUuid(localProfileId, "Local profile id");
	const path = profileAttachmentsPath(userData);
	const key = rootKey(root);
	const existing = readAttachments(path).attachments[key];
	if (existing) return existing;
	// Only an unseen root creates anything, and only under the store lock with
	// a re-read: ensure must never manufacture a local identity over a cloud
	// attachment it failed to see (the mistake that silently detached a cloud
	// company when a concurrent write made the store briefly unreadable).
	let attachment!: ProfileAttachment;
	mutateAttachments(path, (attachments) => {
		const current = attachments.attachments[key];
		if (current) {
			attachment = current;
			return false;
		}
		attachment = {
			profileType: "local",
			profileId: localProfileId,
			attachedAt: new Date().toISOString(),
		};
		attachments.attachments[key] = attachment;
		return undefined;
	});
	return attachment;
}

export function beginProfilePromotion(userData: string, root: string): ProfileAttachment {
	let attachment = ensureProfileAttachment(userData, root);
	if (!attachment.promotion && attachment.profileType === "cloud") return attachment;
	const now = new Date().toISOString();
	const currentPromotion =
		attachment.promotion ??
		({
			promotionId: randomUUID(),
			sourceProfileId: attachment.profileId,
			phase: "requested",
			startedAt: now,
			updatedAt: now,
		} satisfies ProfilePromotion);
	const promotion: ProfilePromotion = {
		...currentPromotion,
		phase: "provisioning",
		updatedAt: now,
	};
	delete promotion.lastError;
	attachment = { ...attachment, promotion };
	return saveAttachment(userData, root, attachment);
}

export function recordProfilePromotionCloudIdentity(
	userData: string,
	root: string,
	identity: Omit<CloudProfileIdentity, "profileType">,
): ProfileAttachment {
	requireUuid(identity.profileId, "Cloud profile id");
	requireUuid(identity.environmentId, "Cloud environment id");
	const attachment = ensureProfileAttachment(userData, root);
	if (!attachment.promotion) throw new Error("Profile promotion has not been prepared");
	if (
		attachment.promotion.cloudProfileId &&
		(attachment.promotion.cloudProfileId !== identity.profileId ||
			attachment.promotion.environmentId !== identity.environmentId)
	) {
		throw new Error("Profile promotion is already bound to a different cloud identity");
	}
	return saveAttachment(userData, root, {
		...attachment,
		promotion: {
			...attachment.promotion,
			cloudProfileId: identity.profileId,
			environmentId: identity.environmentId,
			updatedAt: new Date().toISOString(),
		},
	});
}

export function failProfilePromotion(userData: string, root: string, error: string): ProfileAttachment {
	const attachment = ensureProfileAttachment(userData, root);
	if (!attachment.promotion) throw new Error("Profile promotion has not been prepared");
	return saveAttachment(userData, root, {
		...attachment,
		promotion: {
			...attachment.promotion,
			phase: "failed",
			updatedAt: new Date().toISOString(),
			lastError: error.slice(0, 2048),
		},
	});
}

export function completeProfilePromotion(userData: string, root: string): ProfileAttachment {
	const attachment = ensureProfileAttachment(userData, root);
	if (attachment.profileType !== "cloud" || !attachment.promotion) {
		throw new Error("Cloud profile promotion is not ready to complete");
	}
	return saveAttachment(userData, root, {
		...attachment,
		promotion: {
			...attachment.promotion,
			phase: "complete",
			updatedAt: new Date().toISOString(),
		},
	});
}

/**
 * Explicitly enables sharing for a local profile or attaches a checkout to an
 * existing cloud profile. Account membership is verified by the hosted API;
 * it is not part of this machine attachment's identity.
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
		if (existing?.profileType === "cloud") {
			if (existing.profileId !== identity.profileId || existing.environmentId !== identity.environmentId) {
				throw new Error("Company folder is already attached to a different cloud profile");
			}
			if (
				!existing.promotion ||
				existing.promotion.phase === "identity-ready" ||
				existing.promotion.phase === "complete"
			) {
				attachment = existing;
				return false;
			}
			attachment = {
				...existing,
				promotion: {
					...existing.promotion,
					phase: "identity-ready",
					cloudProfileId: identity.profileId,
					environmentId: identity.environmentId,
					updatedAt: new Date().toISOString(),
				},
			};
			attachments.attachments[key] = attachment;
			return undefined;
		}
		attachment = {
			profileType: "cloud",
			...identity,
			attachedAt: new Date().toISOString(),
			...(existing?.promotion
				? {
						promotion: {
							...existing.promotion,
							phase: "identity-ready" as const,
							cloudProfileId: identity.profileId,
							environmentId: identity.environmentId,
							updatedAt: new Date().toISOString(),
						},
					}
				: {}),
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
