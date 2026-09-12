import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	attachCloudProfile,
	forgetProfileAttachment,
	profileAttachmentsPath,
	profileIdentityKey,
	readProfileAttachment,
	requireProfileAttachment,
} from "../src/profile-identity.ts";

const temporaryRoots: string[] = [];

function temporaryRoot(): string {
	const root = join(tmpdir(), `qorpera-profile-identity-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	temporaryRoots.push(root);
	return root;
}

const legacyLocalProfileId = "a17381c2-3508-4573-b351-a5394adbd1f4";
const cloudProfileId = "9ec79fc8-a1a7-4eb6-a764-4bc704d4103f";
const environmentId = "73dc6943-b71c-4ba4-a38d-78da0861e0dc";

afterEach(() => {
	for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("profile identity", () => {
	it("attaches a checkout folder to a cloud profile without making the account part of its identity", () => {
		const userData = temporaryRoot();
		const company = join(temporaryRoot(), "company");
		const attachment = attachCloudProfile(userData, company, { profileId: cloudProfileId, environmentId });
		expect(attachment).toMatchObject({ profileType: "cloud", profileId: cloudProfileId, environmentId });
		expect(attachment).not.toHaveProperty("userId");
		expect(readProfileAttachment(userData, company)).toEqual(attachment);
		expect(requireProfileAttachment(userData, company)).toEqual(attachment);
		expect(profileAttachmentsPath(userData).startsWith(company)).toBe(false);
		expect(existsSync(profileAttachmentsPath(userData))).toBe(true);
	});

	it("never classifies an unseen company folder as a company", () => {
		const userData = temporaryRoot();
		const company = join(temporaryRoot(), "company");
		expect(readProfileAttachment(userData, company)).toBeUndefined();
		expect(() => requireProfileAttachment(userData, company)).toThrow("not attached to a cloud profile");
		expect(existsSync(profileAttachmentsPath(userData))).toBe(false);
	});

	it("namespaces profile identity by profile type", () => {
		expect(profileIdentityKey({ profileType: "cloud", profileId: cloudProfileId, environmentId })).toBe(
			`cloud:${cloudProfileId}`,
		);
	});

	it("ignores retired local-profile records and drops them at the next write", () => {
		const userData = temporaryRoot();
		const legacyCompany = join(temporaryRoot(), "legacy");
		const company = join(temporaryRoot(), "company");
		const startedAt = "2026-08-17T10:00:00.000Z";
		mkdirSync(userData, { recursive: true });
		writeFileSync(
			profileAttachmentsPath(userData),
			JSON.stringify({
				schema: "qorpera.profile-attachments/v1",
				attachments: {
					[legacyCompany]: {
						profileType: "local",
						profileId: legacyLocalProfileId,
						attachedAt: startedAt,
						promotion: { phase: "failed" },
					},
					[company]: { profileType: "cloud", profileId: cloudProfileId, environmentId, attachedAt: startedAt },
				},
			}),
			"utf-8",
		);
		expect(readProfileAttachment(userData, legacyCompany)).toBeUndefined();
		expect(readProfileAttachment(userData, company)).toMatchObject({
			profileType: "cloud",
			profileId: cloudProfileId,
		});
		expect(readProfileAttachment(userData, company)).not.toHaveProperty("promotion");

		attachCloudProfile(userData, join(temporaryRoot(), "other"), { profileId: cloudProfileId, environmentId });
		const stored = JSON.parse(readFileSync(profileAttachmentsPath(userData), "utf-8")) as {
			schema: string;
			attachments: Record<string, unknown>;
		};
		expect(stored.schema).toBe("qorpera.profile-attachments/v2");
		expect(JSON.stringify(stored.attachments)).not.toContain('"local"');
		expect(JSON.stringify(stored.attachments)).not.toContain(legacyLocalProfileId);
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
	// writer used to parse as empty and silently detach a cloud company.
	it("reports an unreadable attachment store instead of treating it as empty", () => {
		const userData = temporaryRoot();
		const company = join(temporaryRoot(), "company");
		attachCloudProfile(userData, company, { profileId: cloudProfileId, environmentId });
		const path = profileAttachmentsPath(userData);
		const torn = readFileSync(path, "utf-8").slice(0, 25);
		writeFileSync(path, torn, "utf-8");
		expect(() => requireProfileAttachment(userData, company)).toThrow("corrupt");
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
		expect(() => attachCloudProfile(userData, company, { profileId: cloudProfileId, environmentId })).toThrow(
			"unrecognized schema",
		);
	});

	it("keeps a cloud attachment intact under a concurrent mutator's lock", () => {
		const userData = temporaryRoot();
		const company = join(temporaryRoot(), "company");
		attachCloudProfile(userData, company, { profileId: cloudProfileId, environmentId });
		const lockDir = `${profileAttachmentsPath(userData)}.lock`;
		mkdirSync(lockDir);
		try {
			const other = join(temporaryRoot(), "other");
			expect(() => attachCloudProfile(userData, other, { profileId: cloudProfileId, environmentId })).toThrow(
				"locked by another process",
			);
			expect(readProfileAttachment(userData, company)).toMatchObject({
				profileType: "cloud",
				profileId: cloudProfileId,
			});
			rmSync(lockDir, { recursive: true, force: true });
			expect(attachCloudProfile(userData, other, { profileId: cloudProfileId, environmentId }).profileType).toBe(
				"cloud",
			);
			expect(readProfileAttachment(userData, company)).toMatchObject({ profileType: "cloud" });
		} finally {
			rmSync(lockDir, { recursive: true, force: true });
		}
	});
});
