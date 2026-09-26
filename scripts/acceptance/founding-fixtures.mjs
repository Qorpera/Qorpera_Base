import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

export function sqlUuid(value) {
	assert(typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value), "Expected acceptance UUID");
	return `'${value}'::uuid`;
}

/** Existing worker SQL constructs, stages, verifies and finalizes the canonical
 * bootstrap. Storage metadata stands for immutable object bytes, exactly as in
 * the isolated SQL acceptance; no founding/Ready/launch row is fabricated. */
export async function bootstrapCompanySql(profileId) {
	const source = await readFile(new URL("../../supabase/tests/310_company_organization_kernel.test.sql", import.meta.url), "utf8");
	const startMarker = "select set_config('qorpera_test.bootstrap_worker'";
	const endMarker = "\nreset role;\nselect pg_temp.org_claims('authenticated'";
	const start = source.indexOf(startMarker), end = source.indexOf(endMarker, start);
	assert(start > 0 && end > start, "Canonical bootstrap fixture markers changed");
	return `begin;
select set_config('request.jwt.claims','{"role":"service_role"}',true);
select set_config('qorpera_test.org_company',jsonb_build_object('profile_id',${sqlUuid(profileId)})::text,true);
set local role service_role;
${source.slice(start, end)}
reset role; commit;`;
}

/** The external model OAuth/sealed-object boundary is an explicit fixture. Each
 * founder still goes through the real member identity/login/sponsor RPCs, with
 * independent owner IDs. No model credential or paid provider is contacted. */
export function modelAccountsSql(profileId, userIds) {
	assert(Array.isArray(userIds) && userIds.length > 0 && userIds.length <= 4);
	return `begin;
do $$ declare v_user uuid; v_identity uuid; v_login jsonb; v_connection jsonb; begin
foreach v_user in array array[${userIds.map(sqlUuid).join(",")}] loop
 perform set_config('request.jwt.claims',jsonb_build_object('role','authenticated','sub',v_user,'email',(select email from auth.users where id=v_user))::text,true);
 v_identity := (public.qorpera_upsert_member_compute_identity(${sqlUuid(profileId)},extensions.gen_random_uuid(),
 'Own acceptance model','qorpera-member-linux','v1','["agent_turn"]','{}')->>'compute_identity_id')::uuid;
 v_login := public.qorpera_begin_native_provider_login(${sqlUuid(profileId)},extensions.gen_random_uuid(),extensions.gen_random_uuid(),
 v_identity,'openai','codex-cli',repeat('a',64),900);
 perform set_config('request.jwt.claims','{"role":"service_role"}',true);
 v_connection := public.qorpera_complete_native_provider_login((v_login->>'login_id')::uuid,repeat('a',64),extensions.gen_random_uuid(),
 'object://isolated-founding/'||v_user,repeat('b',64),'acceptance-account','personal-subscription','qorpera-native-provider-consent/v1',
 '{"monthly_microusd":1000000,"reservation_microusd":100000,"max_calls_per_run":32,"max_input_tokens_per_run":2000000,"max_output_tokens_per_run":500000,"max_concurrent_runs":1}');
 perform set_config('request.jwt.claims',jsonb_build_object('role','authenticated','sub',v_user)::text,true);
 perform public.qorpera_create_member_execution_sponsor(${sqlUuid(profileId)},extensions.gen_random_uuid(),(v_connection->>'connection_id')::uuid,1,false);
end loop; end $$; commit;`;
}

/** Canonical invoice reconciliation is the explicit Stripe boundary. There are
 * real per-member subscriptions and one global allowance bucket per invoice;
 * no complimentary grant or copied company-local balance is manufactured. */
export function computerPlansSql(userIds) {
	assert(Array.isArray(userIds) && userIds.length === 2);
	return `begin;
select set_config('request.jwt.claims','{"role":"service_role"}',true);
do $$ declare v_users uuid[]:=array[${userIds.map(sqlUuid).join(",")}]; i integer; payload jsonb; claim jsonb;
 t timestamptz:=statement_timestamp()-interval '1 day'; begin
for i in 1..2 loop
 perform public.qorpera_map_computer_billing_customer(v_users[i],'cus_foundingaccept'||i);
 payload:=jsonb_build_object('subscriptionId','sub_foundingaccept'||i,'customerId','cus_foundingaccept'||i,'userId',v_users[i],
  'planKey',case when i=1 then 'basis' else 'standard' end,'planVersion',1,'status','active','periodStart',t,'periodEnd',t+interval '1 month');
 claim:=public.qorpera_begin_computer_billing_sync('evt_foundingaccept'||i,'sub_foundingaccept'||i,t,repeat('a',64));
 perform public.qorpera_finish_computer_billing_sync('evt_foundingaccept'||i,(claim->>'leaseToken')::uuid,payload,
  jsonb_build_object('invoiceId','in_foundingaccept'||i,'subscriptionId','sub_foundingaccept'||i,'customerId','cus_foundingaccept'||i,
   'planKey',payload->>'planKey','planVersion',1,'periodStart',t,'periodEnd',t+interval '1 month',
   'amountPaid',case when i=1 then 18500 else 63000 end,'billingReason','subscription_cycle','status','paid','currency','dkk'));
end loop; end $$; commit;`;
}

export function runtimeEvidenceSql(profileId) {
	return `begin;
select set_config('request.jwt.claims','{"role":"service_role"}',true);
set local role service_role;
select public.qorpera_materialize_session_turn_requests(64);
reset role;
select jsonb_build_object(
 'phase',f.phase,'receipt',f.launch_receipt,
 'owners',(select jsonb_agg(user_id order by user_id) from public.qorpera_profile_members where profile_id=f.profile_id and role='owner'),
 'requestCount',(select count(*) from public.qorpera_session_turn_requests where profile_id=f.profile_id),
 'request',to_jsonb(q),'run',to_jsonb(r),
 'source',case when r.id is not null then public.qorpera_company_context_source(r,'input',q.input_id) end)
from public.qorpera_company_founding f
join public.qorpera_session_turn_requests q on q.id=(f.launch_receipt->>'turnRequestId')::uuid
left join public.qorpera_execution_runs r on r.id=q.run_id where f.profile_id=${sqlUuid(profileId)};
commit;`;
}
