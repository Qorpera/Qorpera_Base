import type { CompanyPathPresenceView } from "./company-path-presence.ts";

export interface MemberCompanyPresenceReply {
	companyId: string;
	environmentId: string;
	view: CompanyPathPresenceView;
	/** Verified newest statements, including ones no longer overlapping a path. */
	confirmed: { clientId: string; sequence: number }[];
}
