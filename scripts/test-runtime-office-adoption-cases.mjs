// Called inside the office delete disposition proof. A synthetic pre-existing
// prepared profile stands in for a previous guest sign-in. No physical copy occurs.
import { randomUUID } from "node:crypto";

// The synthetic pre-existing screen, member and member-owned browser grant that the later screen, stop and reset
// fixtures bind to. Folder-v2 refuses every adoption mapping (0A000, "Adopting a legacy computer's screens is not
// available on this company"), so a script on 924's folder-v2 base seeds these without the adoption checks (ported
// from snapshot-v1 in the legacy sweep).
export function seedOfficeAdoptionFixture({ scope, execute }) {
	const screenId = randomUUID(), profileId = randomUUID(), grantId = randomUUID(), memberId = randomUUID();
	const staffAgentId = "92400000-0000-4000-8000-000000000030";
	execute(`insert into auth.users(id) values('${memberId}');
		insert into public.qorpera_profile_members(profile_id,user_id,email,display_name,role) values('${scope.companyId}','${memberId}','fixture@example.test','Fixture','contributor');
		insert into public.qorpera_runtime_office_screens(office_id,id,ordinal,staff_agent_id)
		values('${scope.companyComputerId}','${screenId}',1,'${staffAgentId}');
		-- The company browser (2026-09-17 amendment) already gives this agent a company-owned profile and an active
		-- grant, and one agent drives one profile. The synthetic member-owned profile below stands in for it; the
		-- company grant is retired first.
		update public.qorpera_runtime_browser_grants g set state='revoked',version=g.version+1
		where g.office_id='${scope.companyComputerId}' and g.staff_agent_id='${staffAgentId}' and g.state='active'
			and exists(select 1 from public.qorpera_runtime_browser_profiles p where p.id=g.profile_id and p.company_owned);
		insert into public.qorpera_runtime_browser_profiles(id,office_id,owner_user_id,prepared,verified_version)
		values('${profileId}','${scope.companyComputerId}','${memberId}',true,1);
		insert into public.qorpera_runtime_browser_grants(id,profile_id,office_id,staff_agent_id,profile_version,owner_membership_version,state)
		values('${grantId}','${profileId}','${scope.companyComputerId}','${staffAgentId}',1,0,'active');`);
	return { screenId, profileId, grantId, memberId, staffAgentId };
}
