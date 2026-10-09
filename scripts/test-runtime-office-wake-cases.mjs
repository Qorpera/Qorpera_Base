import assert from "node:assert/strict";

// The runtime base (supabase/tests/924_folder_runtime_base.test.sql's
// pg_temp.base_start) claims its job, assignment and native provider lease with
// 120-second bounds. Drivers that consume the binding late (after activation,
// screen, lifecycle and stop phases with database restarts) must keep those
// bounds live through the real runner renewal RPCs; the native lease validator
// refuses any expired row and neither renewal accepts a row that has already
// lapsed, so renew at phase boundaries.
export function renewOfficeWakeBinding({ setup, service, execute }) {
 const b=setup.binding;
 const args=`'${b.runnerId}',repeat('2',64),'${b.jobId}',repeat('3',64)`;
 const renewed=JSON.parse(execute(`${service} select public.qorpera_renew_runner_job(${args}); select public.qorpera_renew_native_provider_connection_lease('${b.leaseId}',${args},900);`).split("\n").at(-1));
 assert.equal(renewed.lease_id,b.leaseId); assert.equal(renewed.status,"active");
 return renewed;
}
