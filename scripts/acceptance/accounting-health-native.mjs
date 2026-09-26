import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { accountingHealth } from "../computer-accounting-health.mjs";
import { startNativePostgres } from "./native-postgres.mjs";

/** A disposable DB only. Legacy fixture custody deliberately creates a held
 * reservation without a prestart; the monitor must identify it, never repair it.
 * The test's trusted actor then uses actual settlement to close that fixture. */
export async function runAccountingHealthAcceptance(
	cluster,
	{ psqlPath, out },
) {
	const fixture = await readFile(
		new URL(
			"../../supabase/tests/635_computer_allowance_ledger.test.sql",
			import.meta.url,
		),
		"utf8",
	);
	const marker = "-- CONCURRENCY_FIXTURE_READY:";
	assert(fixture.includes(marker));
	await cluster.query(fixture.slice(0, fixture.indexOf(marker)) + "\ncommit;");
	await cluster.query(
		await readFile(
			new URL(
				"../../deploy/computer-accounting/install-monitor-role.sql",
				import.meta.url,
			),
			"utf8",
		),
	);
	const serviceFile = join(out, "service.conf"),
		configFile = join(out, "config.json"),
		reportPath = join(out, "health.json");
	await writeFile(
		serviceFile,
		`[qorpera-accounting-health]\nhost=${cluster.socketDirectory}\nport=${cluster.port ?? 5432}\ndbname=${cluster.database}\nuser=${cluster.username ?? "postgres"}\n`,
		{ mode: 0o600, flag: "wx" },
	);
	await writeFile(
		configFile,
		JSON.stringify({ psqlPath, serviceFile, reportPath }),
		{ mode: 0o600, flag: "wx" },
	);
	assert.equal(
		(await accountingHealth(configFile)).healthy,
		true,
		"Clean ledger did not pass",
	);
	await cluster.query(`begin;set local request.jwt.claims='{"role":"service_role"}';
 select public.qorpera_reserve_computer_allowance('66700000-0000-4000-8000-000000000001','63500000-0000-4000-8000-000000000010',
 '63500000-0000-4000-8000-000000000001',null,'63500000-0000-4000-8000-000000000030','63500000-0000-4000-8000-000000000040',1000000,clock_timestamp()+interval '10 minutes');
 commit;`);
	const original = await cluster.query(
		"select deadline from public.qorpera_computer_allowance_reservations where id='66700000-0000-4000-8000-000000000001';",
	);
	assert(/^\d{4}-\d\d-\d\d [0-9:.+ -]+$/.test(original));
	// Age only this isolated fixture to exercise a stranded hold immediately.
	await cluster.query(
		"update public.qorpera_computer_allowance_reservations set deadline=clock_timestamp()-interval '2 minutes' where id='66700000-0000-4000-8000-000000000001';",
	);
	const stranded = await accountingHealth(configFile);
	assert.equal(stranded.healthy, false);
	assert(
		stranded.findings.some((f) => f.code === "reservation_expired_unsettled"),
	);
	assert(
		stranded.findings.some((f) => f.code === "hold_missing_prestart_custody"),
	);
	assert.equal(
		await cluster.query(
			"select sum(reserved_us) from public.qorpera_computer_allowance_buckets;",
		),
		"1000000",
		"Monitor mutated hold",
	);
	const failedCli = spawnSync(
		process.execPath,
		[
			fileURLToPath(
				new URL("../computer-accounting-health.mjs", import.meta.url),
			),
			"--config",
			configFile,
		],
		{ encoding: "utf8", timeout: 30000 },
	);
	assert.equal(
		failedCli.status,
		1,
		"Actionable finding did not fail the scheduled CLI",
	);
	assert.equal(JSON.parse(failedCli.stdout).healthy, false);
	await cluster.query(`begin;set local request.jwt.claims='{"role":"service_role"}';
 do $$ declare c jsonb; begin
 c:=public.qorpera_begin_computer_billing_sync('evt_healthrefund','sub_ledger1',clock_timestamp(),repeat('a',64));
 perform public.qorpera_apply_computer_invoice_funding('evt_healthrefund',(c->>'leaseToken')::uuid,
 jsonb_build_object('schema','qorpera.invoice-funding/v1','invoiceId','in_ledger1','subscriptionId','sub_ledger1','customerId','cus_ledger1',
 'currency','dkk','basisMinor',18500,'reversedMinor',18500,'held',false,'evidence','{}',
 'evidenceSha256',encode(extensions.digest('{}','sha256'),'hex')),true);end $$;commit;`);
	const refunded = await accountingHealth(configFile);
	assert.equal(
		refunded.informational.fundingShortfallBuckets,
		1,
		"Existing refund shortfall was not distinguished",
	);
	assert(
		!refunded.findings.some((f) => f.code === "bucket_conservation_mismatch"),
		"Legitimate refund invalidated issued conservation",
	);
	// Restore the fixture's genuine deadline, then its trusted runtime actor
	// settles the existing proven zero checkpoint; the checker performs neither.
	await cluster.query(`begin;set local request.jwt.claims='{"role":"service_role"}';
 update public.qorpera_computer_allowance_reservations set deadline='${original}'::timestamptz where id='66700000-0000-4000-8000-000000000001';
 select public.qorpera_settle_computer_allowance('66700000-0000-4000-8000-000000000001',0);commit;`);
	const resolved = await accountingHealth(configFile);
	assert.equal(resolved.healthy, true);
	const resolvedCli = spawnSync(
		process.execPath,
		[
			fileURLToPath(
				new URL("../computer-accounting-health.mjs", import.meta.url),
			),
			"--config",
			configFile,
		],
		{ encoding: "utf8", timeout: 30000 },
	);
	assert.equal(
		resolvedCli.status,
		0,
		"Resolved finding did not clear the scheduled CLI",
	);
	assert.equal(
		await cluster.query(
			"select sum(reserved_us) from public.qorpera_computer_allowance_buckets;",
		),
		"0",
	);
	assert.equal(
		await cluster.query(
			"select has_table_privilege('qorpera_accounting_monitor','public.qorpera_computer_allowance_buckets','UPDATE') or has_table_privilege('qorpera_accounting_monitor','public.qorpera_computer_billing_keys','SELECT');",
		),
		"f",
	);
	const evidence = {
		schema: "qorpera.accounting-health-acceptance/v1",
		passed: true,
		checks: [
			"Clean ledger passes under restricted monitor role",
			"Stranded expired legacy hold reports reconciliation and missing prestart custody",
			"Read-only monitor preserves every held microsecond",
			"Canonical refund leaves existing hold above funded cap without a false conservation alarm",
			"Actual trusted settlement resolves finding; exact issued conservation preserved",
			"Scheduled CLI exits1 for incident and0 after resolution",
			"Monitor role cannot mutate balances or read billing key table",
		],
		boundaries:
			"Actual disposable PostgreSQL and production psql checker; controlled ledger fixture, no physical stop inference or live alarms.",
	};
	await writeFile(
		join(out, "evidence.json"),
		JSON.stringify(evidence, null, 2) + "\n",
		{ mode: 0o600, flag: "wx" },
	);
	return evidence;
}
if (
	process.argv[1] &&
	pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
	let cluster;
	try {
		assert(
			process.argv.length === 6 &&
				process.argv[2] === "--bin" &&
				process.argv[4] === "--out",
			"Require --bin and --out",
		);
		const binDirectory = process.argv[3],
			out = process.argv[5];
		assert(isAbsolute(out) && resolve(out) === out);
		await mkdir(out, { mode: 0o700 });
		cluster = await startNativePostgres({ binDirectory });
		await runAccountingHealthAcceptance(cluster, {
			psqlPath: join(binDirectory, "psql"),
			out,
		});
	} catch {
		process.stderr.write(
			"Accounting health acceptance failed; no live database was used.\n",
		);
		process.exitCode = 1;
	} finally {
		await cluster?.close();
	}
}
