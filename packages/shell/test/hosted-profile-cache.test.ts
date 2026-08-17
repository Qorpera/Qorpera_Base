import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { HostedProfile, HostedProfileTeam } from "../src/hosted-primary.ts";
import {
	cacheHostedProfiles,
	cacheHostedTeam,
	hostedProfileCachePath,
	loadHostedProfileCache,
	offlineHostedProfileTeam,
} from "../src/hosted-profile-cache.ts";

const accountId = "c98d600e-654a-40da-a07f-f1d54f93cc6c";
const profileId = "9ec79fc8-a1a7-4eb6-a764-4bc704d4103f";
const environmentId = "73dc6943-b71c-4ba4-a38d-78da0861e0dc";
const invitationId = "a8450f9d-c912-43ea-81f6-62c7247d752a";
const now = Date.parse("2026-08-16T00:00:00.000Z");

const profile: HostedProfile = {
	profileType: "cloud",
	profileId,
	environmentId,
	profileName: "Shared company",
	environmentName: "Shared company",
	role: "owner",
	contractVersion: 1,
	createdAt: "2026-08-15T00:00:00.000Z",
};

const team: HostedProfileTeam = {
	profileType: "cloud",
	profileId,
	role: "owner",
	capabilities: { read: true, write: true, authorize: true, manageMembers: true },
	members: [
		{
			userId: accountId,
			email: "owner@example.com",
			displayName: "Owner",
			role: "owner",
			joinedAt: "2026-08-15T00:00:00.000Z",
		},
	],
	invitations: [
		{
			id: invitationId,
			profileId,
			email: "friend@example.com",
			role: "contributor",
			invitedByUserId: accountId,
			createdAt: "2026-08-15T00:00:00.000Z",
			expiresAt: "2026-08-30T00:00:00.000Z",
			delivery: {
				status: "retrying",
				attemptCount: 2,
				nextAttemptAt: "2026-08-16T00:05:00.000Z",
				lastError: "Provider temporarily unavailable",
			},
		},
	],
};

describe("hosted profile cache", () => {
	let userData = "";

	afterEach(() => {
		if (userData && existsSync(userData)) rmSync(userData, { recursive: true, force: true });
	});

	it("round-trips validated account-bound profiles and teams", () => {
		userData = mkdtempSync(join(tmpdir(), "qorpera-hosted-cache-"));
		cacheHostedProfiles(userData, accountId, [profile], now);
		cacheHostedTeam(userData, accountId, team, now);
		expect(loadHostedProfileCache(userData, accountId, now)).toEqual({
			profiles: [profile],
			teams: { [profileId]: team },
		});
		expect(loadHostedProfileCache(userData, "11111111-1111-4111-8111-111111111111", now)).toEqual({
			profiles: [],
			teams: {},
		});
	});

	it("expires cached authority and ignores malformed files", () => {
		userData = mkdtempSync(join(tmpdir(), "qorpera-hosted-cache-"));
		cacheHostedProfiles(userData, accountId, [profile], now);
		cacheHostedTeam(userData, accountId, team, now);
		expect(loadHostedProfileCache(userData, accountId, now + 31 * 24 * 60 * 60 * 1_000)).toEqual({
			profiles: [],
			teams: {},
		});
		writeFileSync(hostedProfileCachePath(userData, accountId), "{}\n", "utf-8");
		expect(loadHostedProfileCache(userData, accountId, now)).toEqual({ profiles: [], teams: {} });
	});

	it("fails closed for authorization while retaining offline contribution", () => {
		expect(offlineHostedProfileTeam(team).capabilities).toEqual({
			read: true,
			write: true,
			authorize: false,
			manageMembers: false,
		});
		expect(
			offlineHostedProfileTeam({
				...team,
				role: "viewer",
				capabilities: { read: true, write: false, authorize: false, manageMembers: false },
			}).capabilities.write,
		).toBe(false);
	});
});
