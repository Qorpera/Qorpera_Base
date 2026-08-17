import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
	cloudPromotionOffering,
	isProfileOffering,
	type ProfileOffering,
	profileOfferingCanPromote,
	profileOfferingDefinition,
} from "./profile-offering.ts";

const PROFILE_ATTACHMENTS_FILE = "profile-attachments.json";
const PROFILE_ATTACHMENTS_SCHEMA = "qorpera.profile-attachments/v1";
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
	targetOffering: "cloud" | "hq";
	phase: ProfilePromotionPhase;
	startedAt: string;
	updatedAt: string;
	cloudProfileId?: string;
	environmentId?: string;
	lastError?: string;
}

export type ProfileAttachment = ProfileIdentity & {
	attachedAt: string;
	offering: ProfileOffering;
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
		(promotion.targetOffering !== "cloud" && promotion.targetOffering !== "hq") ||
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
		targetOffering: promotion.targetOffering,
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
	const offering = isProfileOffering(attachment.offering)
		? attachment.offering
		: attachment.profileType === "cloud"
			? "cloud"
			: "free";
	const promotion = parsePromotion(
		attachment.promotion,
		attachment.profileType === "local" ? attachment.profileId : undefined,
	);
	if (attachment.profileType === "cloud") {
		if (typeof attachment.environmentId !== "string" || !UUID_PATTERN.test(attachment.environmentId)) {
			return undefined;
		}
		if (!profileOfferingDefinition(offering).sharedSubstrate) return undefined;
		return {
			profileType: "cloud",
			profileId: attachment.profileId,
			environmentId: attachment.environmentId,
			attachedAt: attachment.attachedAt,
			offering,
			...(promotion ? { promotion } : {}),
		};
	}
	return {
		profileType: "local",
		profileId: attachment.profileId,
		attachedAt: attachment.attachedAt,
		offering,
		...(promotion ? { promotion } : {}),
	};
}

function readAttachments(path: string): ProfileAttachments {
	try {
		const value: unknown = JSON.parse(readFileSync(path, "utf-8"));
		if (!value || typeof value !== "object" || Array.isArray(value)) return emptyAttachments();
		const record = value as { schema?: unknown; attachments?: unknown };
		if (
			record.schema !== PROFILE_ATTACHMENTS_SCHEMA ||
			!record.attachments ||
			typeof record.attachments !== "object" ||
			Array.isArray(record.attachments)
		) {
			return emptyAttachments();
		}
		const attachments: Record<string, ProfileAttachment> = {};
		for (const [root, candidate] of Object.entries(record.attachments)) {
			const attachment = parseAttachment(candidate);
			if (attachment) attachments[rootKey(root)] = attachment;
		}
		return { schema: PROFILE_ATTACHMENTS_SCHEMA, attachments };
	} catch {
		return emptyAttachments();
	}
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

function requireUuid(value: string, label: string): void {
	if (!UUID_PATTERN.test(value)) throw new Error(`${label} must be a UUID`);
}

function saveAttachment(userData: string, root: string, attachment: ProfileAttachment): ProfileAttachment {
	const path = profileAttachmentsPath(userData);
	const attachments = readAttachments(path);
	attachments.attachments[rootKey(root)] = attachment;
	writeAttachments(path, attachments);
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
	const attachments = readAttachments(path);
	const key = rootKey(root);
	const existing = attachments.attachments[key];
	if (existing) return existing;
	const attachment: ProfileAttachment = {
		profileType: "local",
		profileId: localProfileId,
		attachedAt: new Date().toISOString(),
		offering: "free",
	};
	attachments.attachments[key] = attachment;
	writeAttachments(path, attachments);
	return attachment;
}

export function configureProfileOffering(userData: string, root: string, offering: ProfileOffering): ProfileAttachment {
	const existing = ensureProfileAttachment(userData, root);
	if (existing.offering === offering) return existing;
	if (!profileOfferingCanPromote(existing.offering, offering)) {
		throw new Error(`Profile offering cannot move from ${existing.offering} to ${offering}`);
	}
	if (existing.profileType === "cloud" && !profileOfferingDefinition(offering).sharedSubstrate) {
		throw new Error("A cloud profile cannot be changed back to a local-only offering");
	}
	const now = new Date().toISOString();
	let promotion = existing.promotion;
	if (existing.profileType === "local" && profileOfferingDefinition(offering).sharedSubstrate) {
		const targetOffering = cloudPromotionOffering(offering);
		promotion = promotion
			? { ...promotion, targetOffering, updatedAt: now }
			: {
					promotionId: randomUUID(),
					sourceProfileId: existing.profileId,
					targetOffering,
					phase: "requested",
					startedAt: now,
					updatedAt: now,
				};
	}
	return saveAttachment(userData, root, {
		...existing,
		offering,
		...(promotion ? { promotion } : {}),
	});
}

export function beginProfilePromotion(
	userData: string,
	root: string,
	targetOffering: "cloud" | "hq",
): ProfileAttachment {
	let attachment = configureProfileOffering(userData, root, targetOffering);
	if (!attachment.promotion) {
		if (attachment.profileType === "cloud") return attachment;
		throw new Error("Profile promotion could not be prepared");
	}
	const promotion: ProfilePromotion = {
		...attachment.promotion,
		targetOffering,
		phase: "provisioning",
		updatedAt: new Date().toISOString(),
	};
	delete promotion.lastError;
	attachment = { ...attachment, offering: targetOffering, promotion };
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
	const attachments = readAttachments(path);
	const key = rootKey(root);
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
			return existing;
		}
		const attachment: ProfileAttachment = {
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
		writeAttachments(path, attachments);
		return attachment;
	}
	const offering = existing
		? (existing.promotion?.targetOffering ?? cloudPromotionOffering(existing.offering))
		: "cloud";
	const attachment: ProfileAttachment = {
		profileType: "cloud",
		...identity,
		attachedAt: new Date().toISOString(),
		offering,
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
	writeAttachments(path, attachments);
	return attachment;
}

/** Removes only this machine's checkout attachment; it never deletes a profile. */
export function forgetProfileAttachment(userData: string, root: string): void {
	const path = profileAttachmentsPath(userData);
	const attachments = readAttachments(path);
	const key = rootKey(root);
	if (!attachments.attachments[key]) return;
	delete attachments.attachments[key];
	writeAttachments(path, attachments);
}
