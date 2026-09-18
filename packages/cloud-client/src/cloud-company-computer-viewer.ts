import {
	assertCompanyComputerLease,
	assertCompanyComputerScreenBinding,
	COMPANY_COMPUTER_MAX_LEASE_MS,
	COMPANY_COMPUTER_UUID,
	type CompanyComputerScreenBinding,
	type CompanyComputerScreenLease,
} from "./cloud-company-computer-contract.ts";

export interface CompanyComputerViewerGrant {
	binding: CompanyComputerScreenBinding;
	viewerSessionId: string;
	memberId: string;
	mode: "watch" | "control";
	privacyVersion: number;
	screenEpoch: number;
	validForMs: number;
	/** Only an acknowledged member takeover/private handoff may mint control. */
	lease?: CompanyComputerScreenLease;
	privateSignIn?: { challengeId: string; profileId: string; profileVersion: number };
}

function exact(value: unknown, keys: string): void {
	if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join() !== keys) {
		throw new Error("INVALID_VIEWER_GRANT");
	}
}

export function assertCompanyComputerViewerGrant(
	grant: CompanyComputerViewerGrant,
	previous?: CompanyComputerViewerGrant,
): void {
	exact(
		grant,
		[
			"binding",
			"viewerSessionId",
			"memberId",
			"mode",
			"privacyVersion",
			"screenEpoch",
			"validForMs",
			...(grant.lease ? ["lease"] : []),
			...(grant.privateSignIn ? ["privateSignIn"] : []),
		]
			.sort()
			.join(),
	);
	exact(
		grant.binding,
		"companyComputerId,companyId,computerGeneration,environmentId,logicalComputerId,screenGeneration,screenId,screenOrdinal,staffAgentId",
	);
	assertCompanyComputerScreenBinding(grant.binding, previous?.binding ?? grant.binding);
	if (
		!COMPANY_COMPUTER_UUID.test(grant.viewerSessionId) ||
		!COMPANY_COMPUTER_UUID.test(grant.memberId) ||
		(grant.mode !== "watch" && grant.mode !== "control") ||
		!Number.isSafeInteger(grant.privacyVersion) ||
		grant.privacyVersion < 0 ||
		!Number.isSafeInteger(grant.screenEpoch) ||
		grant.screenEpoch < 0 ||
		!Number.isSafeInteger(grant.validForMs) ||
		grant.validForMs < 1 ||
		grant.validForMs > COMPANY_COMPUTER_MAX_LEASE_MS ||
		(previous &&
			(previous.viewerSessionId !== grant.viewerSessionId ||
				previous.memberId !== grant.memberId ||
				previous.mode !== grant.mode ||
				previous.privacyVersion !== grant.privacyVersion ||
				previous.screenEpoch !== grant.screenEpoch ||
				previous.privateSignIn?.challengeId !== grant.privateSignIn?.challengeId ||
				previous.privateSignIn?.profileId !== grant.privateSignIn?.profileId ||
				previous.privateSignIn?.profileVersion !== grant.privateSignIn?.profileVersion))
	) {
		throw new Error("INVALID_VIEWER_GRANT");
	}
	if (grant.mode === "control") {
		if (!grant.lease) throw new Error("MEMBER_TAKEOVER_REQUIRED");
		exact(grant.lease, "binding,driver,epoch,leaseId,validForMs");
		exact(grant.lease.driver, "kind,memberId,sessionId");
		exact(
			grant.lease.binding,
			"companyComputerId,companyId,computerGeneration,environmentId,logicalComputerId,screenGeneration,screenId,screenOrdinal,staffAgentId",
		);
		assertCompanyComputerLease(grant.lease, grant.binding, {
			kind: "member",
			memberId: grant.memberId,
			sessionId: grant.viewerSessionId,
		});
		if (
			grant.validForMs > grant.lease.validForMs ||
			grant.screenEpoch !== grant.lease.epoch ||
			(previous?.lease &&
				(previous.lease.epoch !== grant.lease.epoch || previous.lease.leaseId !== grant.lease.leaseId))
		) {
			throw new Error("VIEWER_LEASE_CHANGED");
		}
	} else if (grant.lease) throw new Error("WATCHER_CANNOT_HOLD_CONTROL");
	if (grant.privateSignIn) {
		exact(grant.privateSignIn, "challengeId,profileId,profileVersion");
		if (
			grant.mode !== "control" ||
			!COMPANY_COMPUTER_UUID.test(grant.privateSignIn.challengeId) ||
			!COMPANY_COMPUTER_UUID.test(grant.privateSignIn.profileId) ||
			!Number.isSafeInteger(grant.privateSignIn.profileVersion) ||
			grant.privateSignIn.profileVersion < 1 ||
			grant.privacyVersion < 1
		)
			throw new Error("INVALID_PRIVATE_VIEWER_GRANT");
	}
}

export function parseCompanyComputerViewerGrant(
	value: unknown,
	previous?: CompanyComputerViewerGrant,
): CompanyComputerViewerGrant {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("INVALID_VIEWER_GRANT");
	const grant = structuredClone(value) as CompanyComputerViewerGrant;
	assertCompanyComputerViewerGrant(grant, previous);
	return grant;
}
