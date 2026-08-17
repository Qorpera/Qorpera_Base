import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	attachCloudProfile,
	beginProfilePromotion,
	completeProfilePromotion,
	configureProfileOffering,
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
		expect(identity).toMatchObject({ profileType: "local", profileId: localProfileId, offering: "free" });
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

	it("records the desired offering independently from the current profile identity", () => {
		const userData = temporaryRoot();
		const company = join(temporaryRoot(), "company");
		ensureProfileAttachment(userData, company, localProfileId);
		const requested = configureProfileOffering(userData, company, "hq");
		expect(requested).toMatchObject({
			profileType: "local",
			offering: "hq",
			promotion: {
				sourceProfileId: localProfileId,
				targetOffering: "hq",
				phase: "requested",
			},
		});
		expect(requested.promotion?.promotionId).toMatch(/^[0-9a-f-]{36}$/i);
	});

	it("persists a resumable local-to-cloud promotion without changing identity early", () => {
		const userData = temporaryRoot();
		const company = join(temporaryRoot(), "company");
		ensureProfileAttachment(userData, company, localProfileId);
		const started = beginProfilePromotion(userData, company, "cloud");
		expect(started).toMatchObject({ profileType: "local", promotion: { phase: "provisioning" } });

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
			offering: "cloud",
			promotion: { sourceProfileId: localProfileId, phase: "identity-ready" },
		});
		expect(readProfileAttachment(userData, company)).toEqual(attached);
		expect(completeProfilePromotion(userData, company)).toMatchObject({ promotion: { phase: "complete" } });
	});

	it("keeps failed promotion state retryable with the same promotion identity", () => {
		const userData = temporaryRoot();
		const company = join(temporaryRoot(), "company");
		ensureProfileAttachment(userData, company, localProfileId);
		const started = beginProfilePromotion(userData, company, "cloud");
		const failed = failProfilePromotion(userData, company, "network unavailable");
		expect(failed).toMatchObject({ promotion: { phase: "failed", lastError: "network unavailable" } });
		const retried = beginProfilePromotion(userData, company, "cloud");
		expect(retried.promotion?.promotionId).toBe(started.promotion?.promotionId);
		expect(retried).toMatchObject({ promotion: { phase: "provisioning" } });
		expect(retried.promotion).not.toHaveProperty("lastError");
	});

	it("permits only additive offering promotions", () => {
		const userData = temporaryRoot();
		const company = join(temporaryRoot(), "company");
		ensureProfileAttachment(userData, company, localProfileId);
		expect(configureProfileOffering(userData, company, "computer")).toMatchObject({ offering: "computer" });
		expect(() => configureProfileOffering(userData, company, "cloud")).toThrow("cannot move");
		expect(configureProfileOffering(userData, company, "hq")).toMatchObject({
			offering: "hq",
			promotion: { targetOffering: "hq", phase: "requested" },
		});
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
});
