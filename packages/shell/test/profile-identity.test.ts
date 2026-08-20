import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	attachCloudProfile,
	beginProfilePromotion,
	completeProfilePromotion,
	ensureProfileAttachment,
	failProfilePromotion,
	forgetProfileAttachment,
	profileAttachmentsPath,
	profileIdentityKey,
	readProfileAttachment,
	recordProfilePromotionCloudIdentity,
} from "../src/profile-identity.ts";

const temporaryRoots: string[] = [];

function temporaryRoot(): string {
	const root = join(tmpdir(), `qorpera-profile-identity-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	temporaryRoots.push(root);
	return root;
}

const localProfileId = "a17381c2-3508-4573-b351-a5394adbd1f4";
const cloudProfileId = "9ec79fc8-a1a7-4eb6-a764-4bc704d4103f";
const environmentId = "73dc6943-b71c-4ba4-a38d-78da0861e0dc";

afterEach(() => {
	for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("profile identity", () => {
	it("classifies an unseen company folder as one stable local profile", () => {
		const userData = temporaryRoot();
		const company = join(temporaryRoot(), "company");
		const identity = ensureProfileAttachment(userData, company, localProfileId);
		expect(identity).toMatchObject({ profileType: "local", profileId: localProfileId });
		expect(identity).not.toHaveProperty("offering");
		expect(ensureProfileAttachment(userData, company)).toEqual(identity);
		expect(readProfileAttachment(userData, company)).toEqual(identity);
		expect(profileAttachmentsPath(userData).startsWith(company)).toBe(false);
		expect(existsSync(profileAttachmentsPath(userData))).toBe(true);
	});

	it("namespaces profile identity by profile type", () => {
		expect(profileIdentityKey({ profileType: "local", profileId: localProfileId })).toBe(`local:${localProfileId}`);
		expect(profileIdentityKey({ profileType: "cloud", profileId: localProfileId, environmentId })).toBe(
			`cloud:${localProfileId}`,
		);
	});

	it("promotes a local profile to a cloud profile without making the account part of its identity", () => {
		const userData = temporaryRoot();
		const company = join(temporaryRoot(), "company");
		ensureProfileAttachment(userData, company, localProfileId);
		const attachment = attachCloudProfile(userData, company, {
			profileId: cloudProfileId,
			environmentId,
		});
		expect(attachment).toMatchObject({
			profileType: "cloud",
			profileId: cloudProfileId,
			environmentId,
		});
		expect(attachment).not.toHaveProperty("userId");
	});

	it("persists a resumable local-to-cloud promotion without changing identity early", () => {
		const userData = temporaryRoot();
		const company = join(temporaryRoot(), "company");
		ensureProfileAttachment(userData, company, localProfileId);
		const started = beginProfilePromotion(userData, company);
		expect(started).toMatchObject({ profileType: "local", promotion: { phase: "provisioning" } });
		expect(started).not.toHaveProperty("offering");
		expect(started.promotion).not.toHaveProperty("targetOffering");

		const provisioned = recordProfilePromotionCloudIdentity(userData, company, {
			profileId: cloudProfileId,
			environmentId,
		});
		expect(provisioned).toMatchObject({
			profileType: "local",
			profileId: localProfileId,
			promotion: { cloudProfileId, environmentId, phase: "provisioning" },
		});

		const attached = attachCloudProfile(userData, company, { profileId: cloudProfileId, environmentId });
		expect(attached).toMatchObject({
			profileType: "cloud",
			profileId: cloudProfileId,
			promotion: { sourceProfileId: localProfileId, phase: "identity-ready" },
		});
		expect(readProfileAttachment(userData, company)).toEqual(attached);
		expect(completeProfilePromotion(userData, company)).toMatchObject({ promotion: { phase: "complete" } });
	});

	it("keeps failed promotion state retryable with the same promotion identity", () => {
		const userData = temporaryRoot();
		const company = join(temporaryRoot(), "company");
		ensureProfileAttachment(userData, company, localProfileId);
		const started = beginProfilePromotion(userData, company);
		const failed = failProfilePromotion(userData, company, "network unavailable");
		expect(failed).toMatchObject({ promotion: { phase: "failed", lastError: "network unavailable" } });
		const retried = beginProfilePromotion(userData, company);
		expect(retried.promotion?.promotionId).toBe(started.promotion?.promotionId);
		expect(retried).toMatchObject({ promotion: { phase: "provisioning" } });
		expect(retried.promotion).not.toHaveProperty("lastError");
	});

	it("migrates legacy offering attachments without turning plans into profile identity", () => {
		const userData = temporaryRoot();
		const company = join(temporaryRoot(), "company");
		const startedAt = "2026-08-17T10:00:00.000Z";
		mkdirSync(userData, { recursive: true });
		writeFileSync(
			profileAttachmentsPath(userData),
			JSON.stringify({
				schema: "qorpera.profile-attachments/v1",
				attachments: {
					[company]: {
						profileType: "local",
						profileId: localProfileId,
						attachedAt: startedAt,
						offering: "hq",
						promotion: {
							promotionId: "c8502fc3-e605-4b5c-9207-a5f4ed0c2765",
							sourceProfileId: localProfileId,
							targetOffering: "hq",
							phase: "failed",
							startedAt,
							updatedAt: startedAt,
							lastError: "offline",
						},
					},
				},
			}),
			"utf-8",
		);

		const migrated = readProfileAttachment(userData, company);
		expect(migrated).toMatchObject({ profileType: "local", promotion: { phase: "failed" } });
		expect(migrated).not.toHaveProperty("offering");
		expect(migrated?.promotion).not.toHaveProperty("targetOffering");

		beginProfilePromotion(userData, company);
		const stored = JSON.parse(readFileSync(profileAttachmentsPath(userData), "utf-8")) as {
			schema: string;
			attachments: Record<string, unknown>;
		};
		expect(stored.schema).toBe("qorpera.profile-attachments/v2");
		expect(JSON.stringify(stored.attachments)).not.toContain("offering");
		expect(JSON.stringify(stored.attachments)).not.toContain("targetOffering");
	});

	it("attaches multiple machine folders to the same cloud profile", () => {
		const userData = temporaryRoot();
		const firstCheckout = join(temporaryRoot(), "first");
		const secondCheckout = join(temporaryRoot(), "second");
		const identity = { profileId: cloudProfileId, environmentId };
		expect(attachCloudProfile(userData, firstCheckout, identity)).toMatchObject({
			profileType: "cloud",
			...identity,
		});
		expect(attachCloudProfile(userData, secondCheckout, identity)).toMatchObject({
			profileType: "cloud",
			...identity,
		});
	});

	it("is idempotent but refuses implicit cloud-profile reassignment", () => {
		const userData = temporaryRoot();
		const company = join(temporaryRoot(), "company");
		const identity = { profileId: cloudProfileId, environmentId };
		const first = attachCloudProfile(userData, company, identity);
		expect(attachCloudProfile(userData, company, identity)).toEqual(first);
		expect(() =>
			attachCloudProfile(userData, company, {
				profileId: cloudProfileId,
				environmentId: "a8450f9d-c912-43ea-81f6-62c7247d752a",
			}),
		).toThrow("different cloud profile");
	});

	it("forgets only the machine attachment, not a user or hosted profile", () => {
		const userData = temporaryRoot();
		const company = join(temporaryRoot(), "company");
		attachCloudProfile(userData, company, { profileId: cloudProfileId, environmentId });
		forgetProfileAttachment(userData, company);
		expect(readProfileAttachment(userData, company)).toBeUndefined();
	});

	// Regression (2026-08-19): a store made briefly unreadable by a concurrent
	// writer used to parse as empty, so ensure re-classified a cloud-attached
	// company as a fresh local profile — silently disabling sync for it.
	it("refuses to reclassify a company while the attachment store is unreadable", () => {
		const userData = temporaryRoot();
		const company = join(temporaryRoot(), "company");
		attachCloudProfile(userData, company, { profileId: cloudProfileId, environmentId });
		const path = profileAttachmentsPath(userData);
		const torn = readFileSync(path, "utf-8").slice(0, 25);
		writeFileSync(path, torn, "utf-8");
		expect(() => ensureProfileAttachment(userData, company)).toThrow("corrupt");
		expect(() => readProfileAttachment(userData, company)).toThrow("corrupt");
		expect(readFileSync(path, "utf-8")).toBe(torn);
	});

	it("refuses to overwrite a store with an unrecognized schema", () => {
		const userData = temporaryRoot();
		const company = join(temporaryRoot(), "company");
		mkdirSync(userData, { recursive: true });
		writeFileSync(
			profileAttachmentsPath(userData),
			JSON.stringify({ schema: "qorpera.profile-attachments/v99", attachments: {} }),
			"utf-8",
		);
		expect(() => ensureProfileAttachment(userData, company)).toThrow("unrecognized schema");
	});

	it("keeps a cloud attachment intact under a concurrent mutator's lock", () => {
		const userData = temporaryRoot();
		const company = join(temporaryRoot(), "company");
		attachCloudProfile(userData, company, { profileId: cloudProfileId, environmentId });
		const lockDir = `${profileAttachmentsPath(userData)}.lock`;
		mkdirSync(lockDir);
		try {
			const other = join(temporaryRoot(), "other");
			expect(() => ensureProfileAttachment(userData, other)).toThrow("locked by another process");
			expect(readProfileAttachment(userData, company)).toMatchObject({
				profileType: "cloud",
				profileId: cloudProfileId,
			});
			rmSync(lockDir, { recursive: true, force: true });
			expect(ensureProfileAttachment(userData, other).profileType).toBe("local");
			expect(readProfileAttachment(userData, company)).toMatchObject({ profileType: "cloud" });
		} finally {
			rmSync(lockDir, { recursive: true, force: true });
		}
	});
});
