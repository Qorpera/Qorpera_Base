import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";

const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;
const literal = (value) => `convert_from(decode('${Buffer.from(JSON.stringify(value)).toString("base64")}','base64'),'UTF8')::jsonb`;
const service = `set local role service_role; set local request.jwt.claims='{"role":"service_role"}';`;

/** Keep the second PUBLIC dispatch from fixture396 queued. Never manufacture a
 * worker, lease, storage volume or machine association by updating SQL rows. */
export function retainSecondCodingClaim(source) {
 const cancellation = `\tperform pg_temp.worker('{"action":"cancel","operationKey":"c3-cancel","todoKey":"composer-latency","workerKey":"fix-send-2"}');\n\tperform pg_temp.wake_assert((pg_temp.session_row('fix-send-2')).phase = 'cancelled','The second session leaves the queue');`;
 assert.equal(source.split(cancellation).length, 2, "Fixture second-claim cancellation changed");
 return source.replace(cancellation, "\t-- Physical acceptance retains the second public dispatch for concurrent claims.");
}

/** Uses real SQL admission and production controller/guard/LXD ports. The
 * bounded offline processes exercise two concurrent claimed sessions; they do
 * not pretend to be model execution, a repository checkout or NAS hot-plug. */
export async function admitSharedCodingClaim(options) {
 const { query, parseClaim, planMachine, firstClaim, binding, nas, hostMachineIdSha256, companyId, environmentId } = options;
 const rpc = async (sql) => JSON.parse(await query(`begin; ${service} ${sql}; commit;`));
 const second = parseClaim(await rpc("select public.qorpera_claim_coding_session('exec-test',300)"));
 assert.notEqual(second.workerId, firstClaim.workerId);
 const planned = await rpc(`select public.qorpera_plan_coding_machine('${second.workerId}','${second.leaseToken}','${hostMachineIdSha256}')`);
 const plan = planMachine(planned.binding);
 assert.deepEqual(plan.binding, binding, "Concurrent member sessions must plan the identical machine");
 const root = `${nas.rootPath}/workers/${companyId}/${environmentId}/${second.workerId}`;
 const storage = { schema: "qorpera.coding-storage/v1", volumeId: second.workerId, workerId: second.workerId, companyId, environmentId,
  writerGeneration: 1, machineIdSha256: hostMachineIdSha256, policy: nas, dataSource: `${root}/data`, custodySource: `${root}/guest-state`,
  dataTarget: "/workspace", custodyTarget: "/var/lib/qorpera-coding" };
 const admitted = await rpc(`select public.qorpera_authorize_coding_machine_run('${second.workerId}','${second.leaseToken}',${quote(plan.text)},${literal(storage)},'${hostMachineIdSha256}')`);
 assert.equal(admitted.schema, "qorpera.coding-machine-admission/v2"); assert.equal(admitted.fundingRequired, true);
 return { second, plan };
}

export async function exerciseSharedCodingClaims(options) {
 const { query, controller, guard, client, firstClaim, binding, hostMachineIdSha256, payload, signal } = options;
 const allocation = binding.machineId;
 const rpc = async (sql) => JSON.parse(await query(`begin; ${service} ${sql}; commit;`));
 const original = await guard.latest(allocation, signal);
 assert(original?.phase === "running");
 const before = JSON.parse(await query(`select jsonb_build_object('permits',count(*),'reservedUs',
  (select coalesce(sum(reserved_us),0)::text from public.qorpera_computer_allowance_buckets))
  from public.qorpera_coding_computer_permits where allocation_id='${allocation}';`));
 assert.equal(before.permits, 1);
 const { second, plan } = await admitSharedCodingClaim(options), machineName = plan.request.name;
 await controller.ensure(second, binding, signal);
 const counts = async () => JSON.parse(await query(`select jsonb_build_object('leasedSessions',
  (select count(*) from public.qorpera_coding_sessions where vm_allocation_id='${allocation}' and lease_token is not null and lease_until>clock_timestamp()),
  'storageVolumes',(select count(*) from public.qorpera_coding_storage_volumes where worker_id in ('${firstClaim.workerId}','${second.workerId}')),
  'distinctGuestUids',(select count(distinct guest_uid) from public.qorpera_coding_storage_volumes where worker_id in ('${firstClaim.workerId}','${second.workerId}')),
  'permits',(select count(*) from public.qorpera_coding_computer_permits where allocation_id='${allocation}'),
  'streams',(select count(*) from public.qorpera_computer_usage_streams where allocation_id='${allocation}'),
  'reservedUs',(select coalesce(sum(reserved_us),0)::text from public.qorpera_computer_allowance_buckets));`));
 const concurrent = await counts();
 assert.deepEqual(concurrent, { leasedSessions: 2, storageVolumes: 2, distinctGuestUids: 2, permits: 1, streams: 1, reservedUs: before.reservedUs });
 assert.equal((await guard.latest(allocation, signal)).permit.permitId, original.permit.permitId);
 const custody = () => rpc(`select public.qorpera_authorize_coding_machine_custody('${allocation}','exec-test',${quote(plan.text)},'${hostMachineIdSha256}','stop')`);
 assert.equal((await custody()).reason, "MACHINE_IN_USE");
 const script = `/var/tmp/qorpera-usage-shared-${allocation}.py`;
 await client.pushInstanceFile("default", machineName, script, payload, 0o400, signal);
 const records = [firstClaim, second].map((claim, index) => ({ workerId: claim.workerId,
  marker: `/var/tmp/qorpera-usage-shared-${claim.workerId}.json`, duration: index === 0 ? 10 : 18, done: false }));
 const executions = records.map((record) => client.execInstance("default", machineName,
  ["/usr/bin/python3", script, record.marker, String(record.duration)], AbortSignal.any([signal, AbortSignal.timeout(45000)]))
  .then(() => { record.done = true; }, (error) => { record.error = error; record.done = true; }));
 let firstCompleted = false, oneRemaining;
 while (records.some((record) => !record.done)) {
  await delay(1000, undefined, { signal }); await controller.observe(allocation, signal);
  if (records[0].done && !firstCompleted) {
   if (records[0].error) throw records[0].error;
   assert.equal(records[1].done, false, "Second physical workload must still execute when first claim ends");
   const completed = await rpc(`select public.qorpera_complete_coding_turn('${firstClaim.workerId}','${firstClaim.leaseToken}',
    'failed','Acceptance ends the synthetic source claim after its offline workload; no model or repository task executed.')`);
   assert.equal(completed.phase, "failed");
   await controller.abandonClaim(firstClaim, binding, signal);
   oneRemaining = await counts(); assert.equal(oneRemaining.leasedSessions, 1); assert.equal(oneRemaining.permits, 1);
   assert.equal(oneRemaining.reservedUs, before.reservedUs);
   assert.equal((await custody()).reason, "MACHINE_IN_USE");
   assert.equal((await client.getInstance("default", machineName, signal)).status, "Running");
   assert.equal((await guard.latest(allocation, signal)).permit.permitId, original.permit.permitId);
   firstCompleted = true;
  }
 }
 await Promise.all(executions);
 assert(firstCompleted);
 for (const record of records) {
  if (record.error) throw record.error;
  record.completion = JSON.parse((await client.readInstanceFile("default", machineName, record.marker, 4096, signal)).content.toString("utf8"));
  assert.equal(record.completion.completed, true); assert(record.completion.cpuTimeMs > 0 && record.completion.hashIterations > 0);
  assert(record.completion.finishedGuestUptimeMs - record.completion.startedGuestUptimeMs >= record.duration * 1000);
 }
 const overlapMs = Math.min(...records.map((record) => record.completion.finishedGuestUptimeMs)) - Math.max(...records.map((record) => record.completion.startedGuestUptimeMs));
 assert(overlapMs >= 9000, "Need actual concurrent CPU/memory/disk execution in the same VM");
 await controller.observe(allocation, signal);
 assert.equal((await rpc(`select public.qorpera_complete_coding_turn('${second.workerId}','${second.leaseToken}',
  'failed','Acceptance ends the second synthetic source claim after its offline workload; no model or repository task executed.')`)).phase, "failed");
 await controller.abandonClaim(second, binding, signal);
 assert.equal((await counts()).leasedSessions, 0);
 assert.equal((await custody()).intent, "stop");
 const physical = await client.getInstance("default", machineName, signal);
 assert.equal(physical.status, "Running"); assert.equal(physical.config["volatile.uuid"], original.machine.physicalInstanceId);
 await client.execInstance("default", machineName, ["/bin/rm", "--", script, ...records.map((record) => record.marker)], signal);
 return { schema: "qorpera.shared-coding-usage/v1", concurrent, oneRemaining, overlapMs,
  onePhysicalVm: true, onePaidPermit: true, oneMeteringStream: true, firstClaimCompletionDidNotStopOther: true,
  workloadBoundary: "Two actual claimed/authorized SQL sessions and concurrent bounded LXD guest processes; no model, repository or NAS hot-plug claimed.",
  processes: records.map(({ workerId, duration, completion }) => ({ workerId, duration, completion })) };
}
