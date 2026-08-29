import type { MemberRecoveryReceipt, MemberRecoveryReview } from "../../src/cloud-member-identity-recovery.ts";

export const recoveryCompany = "29900000-0000-4000-8000-000000000010";
export const recoveryIdentity = "29900000-0000-4000-8000-000000000020";
export const recoveryTarget = "29900000-0000-4000-8000-000000000030";
export const recoveryOwner = "29900000-0000-4000-8000-000000000001";
export const recoveryMember = "29900000-0000-4000-8000-000000000002";

export function memberRecoveryReview(): MemberRecoveryReview {
	return {
		schema: "qorpera.member-identity-recovery-review/v1",
		reviewSha256: "a".repeat(64),
		review: {
			companyId: recoveryCompany,
			viewerUserId: recoveryOwner,
			identity: {
				computeIdentityId: recoveryIdentity,
				displayName: "Member identity",
				ownershipKind: "member",
				ownerUserId: recoveryMember,
				status: "active",
				epoch: 0,
				blocked: false,
			},
			target: {
				targetId: recoveryTarget,
				nodeId: "29900000-0000-4000-8000-000000000040",
				authorityId: "29900000-0000-4000-8000-000000000050",
				status: "active",
				expiresAt: "2099-01-01T00:00:00.000Z",
				imageSha256: "1".repeat(64),
				guestManifestSha256: "2".repeat(64),
				recipientKeySha256: "3".repeat(64),
			},
			backup: {
				revision: 1,
				objectSha256: "b".repeat(64),
				objectBytes: 1024,
				authorityId: "29900000-0000-4000-8000-000000000050",
				policySha256: "c".repeat(64),
			},
			recovery: null,
			canRequest: true,
			canConsent: false,
			canCancel: false,
		},
	};
}

export function memberRecoveryReceipt(): MemberRecoveryReceipt {
	return {
		recoveryId: "29900000-0000-4000-8000-000000000060",
		companyId: recoveryCompany,
		computeIdentityId: recoveryIdentity,
		targetId: recoveryTarget,
		backupRevision: 1,
		storageSource: "nas",
		status: "awaiting_member",
		epoch: null,
		notBefore: null,
		expiresAt: "2099-01-01T00:00:00.000Z",
		receiptId: null,
	};
}
