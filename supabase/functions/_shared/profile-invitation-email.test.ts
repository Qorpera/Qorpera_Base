import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	buildProfileInvitationEmail,
	deliverProfileInvitationBatch,
	InvitationEmailSendError,
	invitationIdempotencyKey,
	parseProfileInvitationDeliveryJobs,
	type InvitationDeliveryStore,
	type InvitationEmailProvider,
	type ProfileInvitationDeliveryJob,
} from "./profile-invitation-email.ts";

const invitationId = "a8450f9d-c912-43ea-81f6-62c7247d752a";
const profileId = "9ec79fc8-a1a7-4eb6-a764-4bc704d4103f";
const leaseId = "73dc6943-b71c-4ba4-a38d-78da0861e0dc";

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
		assert.deepEqual(
			parseProfileInvitationDeliveryJobs([
				{
					invitation_id: invitationId,
					profile_id: profileId,
					profile_name: "Qorpera",
					recipient_email: "Friend@Example.com",
					role: "contributor",
					invited_by_display_name: "Jonas",
					expires_at: "2026-08-30T12:00:00.000Z",
					attempt_count: 1,
					lease_id: leaseId,
				},
			]),
			[job()],
		);
		assert.throws(
			() =>
				parseProfileInvitationDeliveryJobs([
					{
						invitation_id: invitationId,
						profile_id: profileId,
						profile_name: "Qorpera",
						recipient_email: "friend@example.com",
						role: "owner",
						invited_by_display_name: "Jonas",
						expires_at: "2026-08-30T12:00:00.000Z",
						attempt_count: 1,
						lease_id: leaseId,
					},
				]),
			/role/,
		);
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
			await deliverProfileInvitationBatch(jobs, "https://qorpera.com/invitation", provider, store),
			{ claimed: 3, delivered: 1, retrying: 1, failed: 1, completionPending: 0 },
		);
		assert.deepEqual(completed, [invitationId]);
		assert.deepEqual(failures, [
			{ id: "11111111-1111-4111-8111-111111111111", retryable: true },
			{ id: "22222222-2222-4222-8222-222222222222", retryable: false },
		]);
	});

	it("leaves ambiguous delivery completion for idempotent lease recovery", async () => {
		let failed = false;
		const result = await deliverProfileInvitationBatch(
			[job()],
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
		assert.deepEqual(result, { claimed: 1, delivered: 0, retrying: 0, failed: 0, completionPending: 1 });
		assert.equal(failed, false);
	});
});
