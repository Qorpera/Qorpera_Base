import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { startNativePostgres } from "./native-postgres.mjs";

const directory = dirname(fileURLToPath(import.meta.url));
const quote = (text) => `'${String(text).replaceAll("'", "''")}'`;
const claims = `set local request.jwt.claims='{"role":"service_role"}';`;

/** The query port must start an independent PostgreSQL connection per call.
 * Both native-postgres.mjs and the private Mac runner spawn a distinct psql.
 * Synthetic source/checkpoint fixtures test financial transaction ordering;
 * this evidence makes no claim of physical VM usage or a live Stripe payment. */
export async function exerciseAllowanceConcurrency(query) {
 assert.equal(await query("select count(*) from public.qorpera_computer_allowance_buckets;"), "0", "Fresh empty acceptance ledger required");
 const fixture = await readFile(join(directory, "../../supabase/tests/635_computer_allowance_ledger.test.sql"), "utf8");
 const marker = "-- CONCURRENCY_FIXTURE_READY: prefix up to here can be committed in a disposable DB.";
 assert(fixture.includes(marker));
 const token = randomBytes(6).toString("hex"), secret = randomBytes(48).toString("base64url");
 const schema = `allowance_concurrency_${token}`;
 const evidence = { schema: "qorpera.allowance-concurrency/v1", passed: false,
  provenance: "Separate real PostgreSQL backends; fixture635 companies, invoice proofs and admitted checkpoint data. No physical usage or live payment claimed.", cases: [] };
 await query(`create schema ${schema}; create table ${schema}.gates(id integer primary key,released boolean not null default false);
 create function ${schema}.attempt(sql text) returns jsonb language plpgsql as $$ declare result jsonb; begin
  execute sql into result; return jsonb_build_object('ok',true,'result',result);
  exception when others then return jsonb_build_object('ok',false,'sqlstate',sqlstate); end $$;`);
 const prepare = async (number) => {
  const prefix = `a635000${number}`, ledger = `conc${token}${number}ledger`, dedicated = `conc${token}${number}dedicated`;
  await query(fixture.slice(0, fixture.indexOf(marker)).replaceAll("63500000", prefix).replaceAll("ledger", ledger)
   .replaceAll("repeat('b',64)", `repeat('${number * 2 - 1}',64)`).replaceAll("repeat('c',64)", `repeat('${number * 2}',64)`)
   .replaceAll("'sub_dedicated'", `'sub_${dedicated}'`).replaceAll("'in_dedicated'", `'in_${dedicated}'`).replaceAll("'evt_dedicated'", `'evt_${dedicated}'`) + "commit;");
  return { user: `${prefix}-0000-4000-8000-000000000001`, company1: `${prefix}-0000-4000-8000-000000000010`, company2: `${prefix}-0000-4000-8000-000000000011`,
   allocation1: `${prefix}-0000-4000-8000-000000000030`, allocation2: `${prefix}-0000-4000-8000-000000000031`, epoch: `${prefix}-0000-4000-8000-000000000040`,
   reservation1: `${prefix}-0000-4000-8000-000000000050`, reservation2: `${prefix}-0000-4000-8000-000000000051`, instance1: String(number * 2 - 1).repeat(64), invoice: `in_${ledger}1`, subscription: `sub_${ledger}1`, customer: `cus_${ledger}1` };
 };
 const reserve = (f, company, amount) => `select public.qorpera_reserve_computer_allowance('${f[`reservation${company}`]}','${f[`company${company}`]}','${f.user}',null,'${f[`allocation${company}`]}','${f.epoch}',${amount},clock_timestamp()+interval '10 minutes')`;
 const fence = (f, number) => `select public.qorpera_computer_billing_rpc('qorpera_fence_computer_payment',jsonb_build_object(
  'p_event_id','evt_Concurrent${token}${number}','p_body_sha256',repeat('f',64),'p_proof',jsonb_build_object('invoiceId','${f.invoice}',
  'subscriptionId','${f.subscription}','customerId','${f.customer}','sourceId','re_Concurrent${token}${number}','reason','refund')),${quote(secret)})`;
 const snapshot = async (f) => JSON.parse(await query(`select jsonb_build_object('issuedUs',issued_us::text,'reservedUs',reserved_us::text,
  'debitedUs',debited_us::text,'fenced',payment_fenced,'reservations',(select count(*) from public.qorpera_computer_allowance_reservations where profile_id in ('${f.company1}','${f.company2}')))
  from public.qorpera_computer_allowance_buckets where invoice_id='${f.invoice}';`));
 const attempt = async (sql) => JSON.parse(await query(`begin; ${claims} select ${schema}.attempt(${quote(sql)}); commit;`));
 const race = async (number, firstSql, secondSql) => {
  const firstName = `conc_${token}_${number}_first`, secondName = `conc_${token}_${number}_second`;
  await query(`insert into ${schema}.gates(id) values(${number});`);
  const first = query(`begin; set local application_name='${firstName}'; set local statement_timeout='20s'; ${claims}
   select ${schema}.attempt(${quote(firstSql)}); select pg_advisory_xact_lock(7635,${number});
   do $$ begin while not (select released from ${schema}.gates where id=${number}) loop perform pg_sleep(0.03); end loop; end $$; commit;`)
   .then((output) => ({ output }), (error) => ({ error: String(error) }));
  let second, blocked;
  const waitFor = async (sql, accept, label) => {
   const deadline = Date.now() + 10000;
   while (Date.now() < deadline) { const value = JSON.parse(await query(sql)); if (accept(value)) return value; await delay(30); }
   throw new Error(`PostgreSQL contention not observed: ${label}`);
  };
  try {
   const holder = await waitFor(`select coalesce((select jsonb_build_object('pid',a.pid) from pg_stat_activity a join pg_locks l on l.pid=a.pid
    where a.application_name='${firstName}' and l.locktype='advisory' and l.classid=7635 and l.objid=${number} and l.granted),'null'::jsonb);`, Boolean, "first operation completed and transaction retained locks");
   second = query(`begin; set local application_name='${secondName}'; set local statement_timeout='20s'; ${claims} select ${schema}.attempt(${quote(secondSql)}); commit;`)
    .then((output) => ({ output }), (error) => ({ error: String(error) }));
   blocked = await waitFor(`select coalesce((select jsonb_build_object('waitingPid',pid,'blockingPids',pg_blocking_pids(pid),'waitType',wait_event_type,'waitEvent',wait_event)
    from pg_stat_activity where application_name='${secondName}'),'null'::jsonb);`, (value) => value?.waitType === "Lock" && value.blockingPids.includes(holder.pid), "second real operation blocked behind first backend");
   assert.notEqual(blocked.waitingPid, holder.pid);
   assert(["transactionid", "tuple"].includes(blocked.waitEvent), "Expected real financial row contention, not test gate contention");
  } finally {
   await query(`update ${schema}.gates set released=true where id=${number};`);
   await Promise.allSettled([first, second]);
  }
  const results = await Promise.all([first, second]);
  for (const result of results) assert(result && !result.error, result?.error);
  return { blocking: blocked, first: JSON.parse(results[0].output.split("\n")[0]), second: JSON.parse(results[1].output.split("\n")[0]) };
 };
 try {
  await query(`insert into public.qorpera_computer_billing_keys(key_sha256,label)
   values(encode(extensions.digest(convert_to(${quote(secret)},'UTF8'),'sha256'),'hex'),'Disposable allowance concurrency');`);
  const competing = await prepare(1), original = await snapshot(competing), amount = BigInt(original.issuedUs) * 3n / 4n;
  const competed = await race(1, reserve(competing, 1, amount), reserve(competing, 2, amount));
  assert.equal(competed.first.ok, true); assert.deepEqual(competed.second, { ok: false, sqlstate: "P0001" });
  const held = await snapshot(competing); assert.equal(held.reservedUs, amount.toString()); assert.equal(held.reservations, 1); assert.equal(held.debitedUs, "0");
  assert(BigInt(held.reservedUs) <= BigInt(held.issuedUs));
  assert.equal((await attempt(`select public.qorpera_settle_computer_allowance('${competing.reservation1}',0)`)).ok, true);
  assert.equal((await snapshot(competing)).reservedUs, "0");
  evidence.cases.push({ name: "two companies reserve 75 percent of one global bucket", ...competed, held, exactlyOneReservation: true });

  const holdFirst = await prepare(2);
  const reversal = await race(2, reserve(holdFirst, 1, 1000000), fence(holdFirst, 2));
  assert.equal(reversal.first.ok, true); assert.equal(reversal.second.ok, true);
  const fencedHold = await snapshot(holdFirst); assert.equal(fencedHold.fenced, true); assert.equal(fencedHold.reservedUs, "1000000");
  assert.deepEqual(await attempt(reserve(holdFirst, 2, 1)), { ok: false, sqlstate: "P0001" });
  await query(`begin; ${claims} select public.qorpera_record_computer_usage_checkpoint('${holdFirst.allocation1}','${holdFirst.instance1}','${holdFirst.epoch}',1,500,500,clock_timestamp()+interval '1 second',false,'coding_machine',repeat('e',64)); commit;`);
  const settlement = await attempt(`select public.qorpera_settle_computer_allowance('${holdFirst.reservation1}',1)`);
  assert.deepEqual(settlement, { ok: true, result: { debitedUs: "500000", releasedUs: "500000" } });
  assert.deepEqual(await attempt(`select public.qorpera_settle_computer_allowance('${holdFirst.reservation1}',1)`), settlement);
  // A fresh delayed paid webhook traverses the enrolled bridge and the actual
  // sync/funding kernels. A paid response must not undo an earlier reversal.
  await query(`begin; ${claims} do $$ declare claim jsonb; payload jsonb; proof jsonb; begin
   select payment_proof into strict proof from public.qorpera_computer_allowance_buckets where invoice_id='${holdFirst.invoice}';
   select jsonb_build_object('subscriptionId',provider_subscription_id,'customerId',provider_customer_id,'userId',user_id,
    'planKey',plan_key,'planVersion',plan_version,'status',status,'periodStart',period_start,'periodEnd',period_end)
    into strict payload from public.qorpera_computer_subscriptions where provider_subscription_id='${holdFirst.subscription}';
   claim:=public.qorpera_computer_billing_rpc('qorpera_begin_computer_billing_sync',jsonb_build_object('p_event_id','evt_DelayedPaid${token}',
    'p_subscription_id','${holdFirst.subscription}','p_event_created_at',clock_timestamp(),'p_body_sha256',repeat('a',64)),${quote(secret)});
   if claim->>'state'<>'claimed' then raise exception 'Delayed paid event not claimed'; end if;
   perform public.qorpera_computer_billing_rpc('qorpera_finish_computer_billing_sync',jsonb_build_object('p_event_id','evt_DelayedPaid${token}',
    'p_lease_token',claim->>'leaseToken','p_payload',payload,'p_paid_invoice',proof),${quote(secret)}); end $$; commit;`);
  const afterReplay = await snapshot(holdFirst); assert.equal(afterReplay.fenced, true); assert.equal(afterReplay.reservedUs, "0"); assert.equal(afterReplay.debitedUs, "500000");
  assert.equal(afterReplay.issuedUs, fencedHold.issuedUs);
  assert.equal(await query(`select count(*) from public.qorpera_computer_billing_inbox where event_id='evt_DelayedPaid${token}' and completed_at is not null;`), "1");
  assert.deepEqual(await attempt(reserve(holdFirst, 2, 1)), { ok: false, sqlstate: "P0001" });
  evidence.cases.push({ name: "hold commits before reversal; existing usage settles and delayed paid stays fenced", ...reversal, fencedHold, settlement, afterReplay });

  const fenceFirst = await prepare(3);
  const fenced = await race(3, fence(fenceFirst, 3), reserve(fenceFirst, 2, 1000000));
  assert.equal(fenced.first.ok, true); assert.deepEqual(fenced.second, { ok: false, sqlstate: "P0001" });
  const final = await snapshot(fenceFirst); assert.equal(final.fenced, true); assert.equal(final.reservedUs, "0"); assert.equal(final.reservations, 0);
  evidence.cases.push({ name: "reversal commits before competing reservation", ...fenced, final });
  evidence.finalLedger = JSON.parse(await query(`select jsonb_build_object('reservedUs',sum(reserved_us)::text,'debitedUs',sum(debited_us)::text,
   'withinIssued',bool_and(reserved_us+debited_us<=issued_us),'unsettledReservations',
   (select count(*) from public.qorpera_computer_allowance_reservations where settled_at is null)) from public.qorpera_computer_allowance_buckets;`));
  assert.deepEqual(evidence.finalLedger, { reservedUs: "0", debitedUs: "500000", withinIssued: true, unsettledReservations: 0 });
  evidence.passed = true; return evidence;
 } finally {
  await query(`drop schema ${schema} cascade;`);
 }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
 const args = process.argv.slice(2); assert.equal(args.length, 4); assert.equal(args[0], "--bin"); assert.equal(args[2], "--out");
 const out = resolve(args[3]); await mkdir(out, { recursive: true, mode: 0o700 });
 let cluster, result = { schema: "qorpera.allowance-concurrency/v1", passed: false };
 try {
  cluster = await startNativePostgres({ binDirectory: args[1] });
  result = { ...await exerciseAllowanceConcurrency(cluster.query), postgresVersion: cluster.postgresVersion, migrationCount: cluster.migrationCount };
 } catch (error) { result.error = String(error); process.exitCode = 1; }
 finally {
  try { await cluster?.close(); result.cleanup = true; }
  catch { result.cleanup = false; result.passed = false; result.error = "Owned PostgreSQL cleanup failed"; process.exitCode = 1; }
  await writeFile(join(out, "evidence.json"), `${JSON.stringify(result, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  console.log(JSON.stringify(result));
 }
}
