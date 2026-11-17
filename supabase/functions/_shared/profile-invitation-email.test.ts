import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	buildProfileInvitationEmail,
	deliverProfileInvitationBatch,
	InvitationEmailSendError,
	invitationIdempotencyKey,
	parseProfileInvitationDeliveryJobs,
	SHOWN_NAME_LENGTH,
	shownName,
	type InvitationDeliveryStore,
	type InvitationEmailProvider,
	type ProfileInvitationDeliveryJob,
} from "./profile-invitation-email.ts";

const invitationId = "a8450f9d-c912-43ea-81f6-62c7247d752a";
const profileId = "9ec79fc8-a1a7-4eb6-a764-4bc704d4103f";
const leaseId = "73dc6943-b71c-4ba4-a38d-78da0861e0dc";

function claimedRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		invitation_id: invitationId,
		profile_id: profileId,
		profile_name: "Qorpera",
		recipient_email: "friend@example.com",
		role: "contributor",
		invited_by_display_name: "Jonas",
		expires_at: "2026-08-30T12:00:00.000Z",
		attempt_count: 1,
		lease_id: leaseId,
		...overrides,
	};
}

function graphemeCount(value: string): number {
	return [...new Intl.Segmenter("en", { granularity: "grapheme" }).segment(value)].length;
}

function job(overrides: Partial<ProfileInvitationDeliveryJob> = {}): ProfileInvitationDeliveryJob {
	return {
		invitationId,
		profileId,
		profileName: "Qorpera",
		recipientEmail: "friend@example.com",
		role: "contributor",
		invitedByDisplayName: "Jonas",
		expiresAt: "2026-08-30T12:00:00.000Z",
		attemptCount: 1,
		leaseId,
		...overrides,
	};
}

describe("profile invitation email delivery", () => {
	it("validates claimed jobs and creates a recipient-bound invitation URL", () => {
		assert.deepEqual(parseProfileInvitationDeliveryJobs([claimedRow({ recipient_email: "Friend@Example.com" })]), {
			jobs: [job()],
			unusable: [],
			unreadable: 0,
		});
		assert.deepEqual(parseProfileInvitationDeliveryJobs([claimedRow({ role: "owner" })]), {
			jobs: [],
			unusable: [{ invitationId, leaseId, message: "Invalid invitation role" }],
			unreadable: 0,
		});
		assert.throws(() => parseProfileInvitationDeliveryJobs({}), /job list/);
	});

	it("keeps the other invitations of a claim when one cannot be used or read", () => {
		const other = "33333333-3333-4333-8333-333333333333";
		const claimed = parseProfileInvitationDeliveryJobs([
			claimedRow({ recipient_email: "not an address" }),
			{ profile_name: "No ids" },
			claimedRow({ invitation_id: other }),
		]);
		assert.deepEqual(
			claimed.jobs.map((current) => current.invitationId),
			[other],
		);
		assert.deepEqual(claimed.unusable, [{ invitationId, leaseId, message: "Invalid recipient email" }]);
		assert.equal(claimed.unreadable, 1);
	});

	it("shortens a long company name at a word end instead of refusing it", () => {
		const longName = `${"Lerhave Keramik og Design til Hjemme ".repeat(3)}🏡🇩🇰👨‍👩‍👧`;
		assert.ok([...longName].length <= 120);
		assert.ok(longName.length > 120);
		const [parsed] = parseProfileInvitationDeliveryJobs([claimedRow({ profile_name: longName })]).jobs;
		assert.ok(parsed);
		assert.ok(graphemeCount(parsed.profileName) <= SHOWN_NAME_LENGTH);
		assert.match(parsed.profileName, /\S…$/);
		assert.ok(longName.includes(`${parsed.profileName.slice(0, -1)} `));
		const email = buildProfileInvitationEmail(parsed, "https://qorpera.com/invitation");
		assert.match(email.subject, /^Jonas invited you to Lerhave Keramik .*… on Qorpera$/);
	});

	it("never splits a letter or an emoji when it shortens a name", () => {
		assert.equal(shownName("  Short   name \n "), "Short name");
		const family = "👨‍👩‍👧";
		assert.equal(shownName(family.repeat(SHOWN_NAME_LENGTH + 5)), `${family.repeat(SHOWN_NAME_LENGTH - 1)}…`);
		const shortened = shownName(`Café ${"🇩🇰".repeat(SHOWN_NAME_LENGTH)}`);
		assert.equal(graphemeCount(shortened), SHOWN_NAME_LENGTH);
		assert.match(shortened, /^Café 🇩🇰.*🇩🇰…$/u);
		assert.equal(shownName("a".repeat(200), 10), `${"a".repeat(9)}…`);
	});

	it("escapes profile content and refuses non-HTTPS invitation links", () => {
		const email = buildProfileInvitationEmail(
			job({ profileName: "Qorpera <Core>", invitedByDisplayName: 'Jonas "Founder"' }),
			"https://qorpera.com/invitation?source=email",
		);
		const invitationUrl = new URL(email.invitationUrl);
		assert.equal(invitationUrl.searchParams.has("invitation"), false);
		assert.equal(invitationUrl.hash, `#invitation=${invitationId}`);
		assert.match(email.html, /Qorpera &lt;Core&gt;/);
		assert.doesNotMatch(email.html, /<Core>/);
		assert.match(email.text, /sign in as friend@example\.com/i);
		assert.match(email.text, /before you choose whether to accept/i);
		assert.equal(invitationIdempotencyKey(invitationId), `qorpera-profile-invitation/${invitationId}`);
		assert.throws(() => buildProfileInvitationEmail(job(), "http://qorpera.com/invitation"), /HTTPS/);
	});

	it("records retryable and permanent failures without stopping the batch", async () => {
		const completed: string[] = [];
		const failures: Array<{ id: string; retryable: boolean }> = [];
		const unusableId = "44444444-4444-4444-8444-444444444444";
		const jobs = [
			job(),
			job({ invitationId: "11111111-1111-4111-8111-111111111111" }),
			job({ invitationId: "22222222-2222-4222-8222-222222222222" }),
		];
		const provider: InvitationEmailProvider = {
			send: async (current) => {
				if (current.invitationId.startsWith("1111")) throw new InvitationEmailSendError("rate limited", true);
				if (current.invitationId.startsWith("2222")) throw new InvitationEmailSendError("invalid sender", false);
				return { messageId: "provider-message" };
			},
		};
		const store: InvitationDeliveryStore = {
			complete: async (current) => {
				completed.push(current.invitationId);
			},
			fail: async (current, _message, retryable) => {
				failures.push({ id: current.invitationId, retryable });
			},
		};
		assert.deepEqual(
			await deliverProfileInvitationBatch(
				{
					jobs,
					unusable: [{ invitationId: unusableId, leaseId, message: "Invalid invitation role" }],
					unreadable: 1,
				},
				"https://qorpera.com/invitation",
				provider,
				store,
			),
			{ claimed: 5, delivered: 1, retrying: 1, failed: 2, completionPending: 0, unreadable: 1 },
		);
		assert.deepEqual(completed, [invitationId]);
		assert.deepEqual(failures, [
			{ id: unusableId, retryable: false },
			{ id: "11111111-1111-4111-8111-111111111111", retryable: true },
			{ id: "22222222-2222-4222-8222-222222222222", retryable: false },
		]);
	});

	it("leaves ambiguous delivery completion for idempotent lease recovery", async () => {
		let failed = false;
		const result = await deliverProfileInvitationBatch(
			{ jobs: [job()], unusable: [], unreadable: 0 },
			"https://qorpera.com/invitation",
			{ send: async () => ({ messageId: "provider-message" }) },
			{
				complete: async () => {
					throw new Error("database response lost");
				},
				fail: async () => {
					failed = true;
				},
			},
		);
		assert.deepEqual(result, {
			claimed: 1,
			delivered: 0,
			retrying: 0,
			failed: 0,
			completionPending: 1,
			unreadable: 0,
		});
		assert.equal(failed, false);
	});
});
