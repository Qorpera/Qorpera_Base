import { spawnSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { buildContainerName, expandTestFixture, POSTGRES_IMAGE, sortMigrationNames } from "./test-hosted-db.mjs";

/**
 * The folder core's load test (C1e, deploy/first-node/RUNTIME-COMPANY-FOLDER-CORE.md §9): one folder-v2 company
 * under 32-64 concurrent agent runs on a real disk, in a disposable PostgreSQL built like `npm run test:hosted-db`
 * (its data directory is a Docker volume, not tmpfs; fsync and synchronous commit stay on). Every call is one
 * transaction on a pooled connection with the PostgREST role's timeouts (statement_timeout and lock_timeout 8 s,
 * 20260913000100) and the service role's claims, as PostgREST runs it; --rtt is each call's round trip outside the
 * database. Beside the runs:
 * - each run, round after round: the context fence before a model request (qorpera_fence_native_context), a read, a
 *   listing; every 2nd round a write (the gateway's upload as the run, then a receipt, the commit and its completion,
 *   1 in 4 writing the bytes of an object GC is collecting); every 3rd round it releases what it read; every 5th it
 *   tries a restricted file (the leak probe); every 7th it makes a folder of 20 files and deletes the subtree; every
 *   11th it messages another load agent (a wake);
 * - a stopper: the stop's two phases (pause, then the drain, timed) and a resume, every --stop-every seconds;
 * - an ACL client: grants one agent read on load/restricted, then revokes it (both narrowing turns timed);
 * - the wake admitter (on folder-v2, admission is the admission row's count; a message's wake stays queued until C4's
 *   materializer), object GC (the sweep, the claim, the gateway lane's unlink begin and finish), and two writers
 *   of rows pointing at the company's profile row (rank 0's KEY SHARE);
 * - with --big (the default), the big run: its read set holds --big-paths released paths under load/big, and its context
 *   fence is timed every 2 s, and right after a re-grant of load/big (which re-resolves every path).
 *
 *   node scripts/load-folder-core.mjs [--runs 32] [--seconds 60] [--pool 48] [--rtt 50] [--stop-every 15]
 *     [--no-big | --big-paths 25000] [--probe-only] [--skip <migration file>]... [--check]
 *
 * --big-paths sets the big run's read set (500-25,000, a multiple of 500). --probe-only skips the load: it times the big
 * run alone, with PL/pgSQL function statistics on, and reports where the re-check after a re-grant spends its time.
 *
 * After the load, with nothing else running and no statement timeout, it times the big run's context fence with its
 * read set's stamps current, and after a re-grant of load/big both the fence and one read-set check (the runtime's
 * qorpera_assert_company_path_reads). Then it checks the folder: no entry without its parent folder, no file whose bytes GC removed. It reports
 * each kind's latency and failures, the wakes admitted, the stop's drain latency, GC outcomes, multixact SLRU use and
 * lock waits over a second (log_lock_waits), and every deadlock from the server log with who waited for whom.
 *
 * --check exits 1 on: any deadlock; any statement timeout or unexpected failure; an authority leak (a restricted read
 * that succeeded after the agent's revoke committed and before its next grant began); an entry without its parent; a
 * file whose bytes are gone; a run's tool call or context fence over the 4 s result fence (cloud-native-result-fence.ts);
 * the big run's context fence over its 3.5 s call budget (CLOUD_NATIVE_FENCE_CALL_TIMEOUT_MS).
 */
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const options = {
	skipped: new Set(),
	runs: 32,
	seconds: 60,
	pool: 48,
	rtt: 50,
	stopEvery: 15,
	big: true,
	bigPaths: 25_000,
	probeOnly: false,
	check: false,
};
{
	const args = process.argv.slice(2);
	const count = (value, name, min, max) => {
		const number = Number(value);
		if (!Number.isSafeInteger(number) || number < min || number > max) throw new Error(`${name} must be ${min}-${max}`);
		return number;
	};
	for (let index = 0; index < args.length; index += 1) {
		const [flag, value] = [args[index], args[index + 1]];
		if (flag === "--check") options.check = true;
		else if (flag === "--no-big") options.big = false;
		else if (flag === "--probe-only") options.probeOnly = true;
		else if (flag === "--big-paths" && value) {
			options.bigPaths = count(args[++index], flag, 500, 25_000);
			if (options.bigPaths % 500) throw new Error("--big-paths must be a multiple of 500");
		}
		else if (flag === "--skip" && value) options.skipped.add(args[++index]);
		else if (flag === "--runs" && value) options.runs = count(args[++index], flag, 2, 64);
		else if (flag === "--seconds" && value) options.seconds = count(args[++index], flag, 10, 900);
		else if (flag === "--pool" && value) options.pool = count(args[++index], flag, 4, 128);
		else if (flag === "--rtt" && value) options.rtt = count(args[++index], flag, 0, 1000);
		else if (flag === "--stop-every" && value) options.stopEvery = count(args[++index], flag, 5, 600);
		else throw new Error(`Unknown argument ${flag}; see the usage in ${fileURLToPath(import.meta.url)}`);
	}
}
const ENVIRONMENT = "64800000-0000-4000-8000-000000000020";
const COMPANY = "64800000-0000-4000-8000-000000000010";
const OWNER = "64800000-0000-4000-8000-000000000001";
const MEMBER = JSON.stringify({ kind: "member", userId: OWNER });
const SERVICE_CLAIMS = JSON.stringify({ role: "service_role" });
// The runtime's budgets: the result fence (cloud-native-result-fence.ts), the context fence's call
// (cloud-native-tool-authority.ts), the path gateway's RPCs and tool receipts.
const RESULT_FENCE_MS = 4000;
const FENCE_CALL_MS = 3500;
const PATH_DEADLINE = 3000;
const TOOL_DEADLINE = 5000;
const RUN_KINDS = new Set([
	"fence",
	"read",
	"list",
	"release",
	"write-upload",
	"write-upload-reused",
	"subtree-upload",
	"receipt-begin",
	"commit",
	"commit-retry",
	"receipt-complete",
	"subtree-make",
	"subtree-read",
	"subtree-delete",
	"restricted-read",
	"message",
]);
const database = "qorpera_test";
const password = "qorpera-load-only";
const containerName = buildContainerName(process.pid, randomBytes(4).toString("hex"));
for (const [signal, code] of [
	["SIGINT", 130],
	["SIGTERM", 143],
]) {
	process.on(signal, () => {
		spawnSync("docker", ["rm", "--force", "--volumes", containerName]);
		process.exit(code);
	});
}

function run(command, commandArgs, input) {
	const result = spawnSync(command, commandArgs, { input, encoding: "utf-8", maxBuffer: 256 * 1024 * 1024 });
	if (result.error) throw result.error;
	if (result.status !== 0)
		throw new Error(`${command} ${commandArgs.slice(0, 4).join(" ")} failed:\n${result.stderr.slice(-4000)}`);
	return result.stdout;
}
const psql = (sql) =>
	run(
		"docker",
		["exec", "-i", containerName, "psql", "-q", "-U", "postgres", "-d", database, "--no-psqlrc", "-v", "ON_ERROR_STOP=1", "-At"],
		sql,
	);
const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
const pick = (values) => values[Math.floor(Math.random() * values.length)];

/** A failed call's class: what the harness reports, and what --check refuses. */
function classify(error) {
	let code = error.code;
	let message = String(error.message);
	if (code === "PGRST") {
		try {
			const body = JSON.parse(message);
			code = body.code ?? code;
			message = `${body.code} ${body.message ?? ""}${body.details ? ` ${body.details}` : ""}`;
		} catch {}
	}
	if (code === "40P01") return { name: "deadlock", detail: message };
	if (code === "57014") return { name: "statement-timeout", detail: message };
	if (code === "55P03")
		return /lock timeout/.test(message) ? { name: "lock-timeout", detail: message } : { name: "nowait", detail: message };
	if (code === "QRC01") return { name: "busy", detail: message };
	if (code === "55000" && /paus|stop/i.test(message)) return { name: "paused", detail: message };
	if (code === "42501") return { name: "refused", detail: message };
	return { name: "other", detail: `${code ?? "?"} ${message.slice(0, 200)}` };
}
const CLASSES = ["deadlock", "statement-timeout", "lock-timeout", "nowait", "busy", "paused", "refused", "other"];
const UNEXPECTED = new Set(["deadlock", "statement-timeout", "other"]);

const stats = new Map();
function record(kind, sample) {
	if (!stats.has(kind)) stats.set(kind, []);
	stats.get(kind).push(sample);
}
function percentile(values, fraction) {
	if (!values.length) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1)];
}

let pool;
let end = 0;
const running = () => performance.now() < end;

/** One RPC as PostgREST runs it: one transaction on a pooled connection, request.path and claims set. */
async function call(kind, rpc, sql, params, deadlineMs, { rollback = false, expected = [] } = {}) {
	if (options.rtt) await sleep(options.rtt);
	const started = performance.now();
	const client = await pool.connect();
	const connected = performance.now();
	let value = null;
	let failure = null;
	let queried = connected;
	try {
		await client.query("begin");
		await client.query("select set_config('request.path', $1, true), set_config('request.jwt.claims', $2, true)", [
			`/rpc/${rpc}`,
			SERVICE_CLAIMS,
		]);
		queried = performance.now();
		value = (await client.query(sql, params)).rows[0]?.value ?? null;
		await client.query(rollback ? "rollback" : "commit");
	} catch (error) {
		failure = classify(error);
		await client.query("rollback").catch(() => undefined);
	} finally {
		client.release();
	}
	const ended = performance.now();
	const sample = {
		startedAt: started,
		endedAt: ended,
		totalMs: ended - started + options.rtt,
		queueMs: connected - started,
		queriedAt: queried,
		gaveUp: ended - started + options.rtt > deadlineMs,
		failure: failure && expected.includes(failure.name) ? { ...failure, expected: true } : failure,
	};
	record(kind, sample);
	return { value, failure, sample };
}

const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex");
const contextView = () =>
	JSON.stringify({
		schema: "qorpera.native-context-view/v1",
		requestId: randomUUID(),
		threadId: "t",
		turnId: null,
		purpose: "turn",
		outputs: [],
	});

function fence(kind, runRow, deadline = RESULT_FENCE_MS) {
	return call(
		kind,
		"qorpera_fence_native_context",
		"select public.qorpera_fence_native_context($1::uuid, $2::jsonb, $3::text[], $4::jsonb) as value",
		[ENVIRONMENT, runRow.binding, [], contextView()],
		deadline,
		{ expected: ["paused"] },
	);
}
const read = (kind, runRow, path, expected = ["paused"]) =>
	call(
		kind,
		"qorpera_folder_read",
		"select public.qorpera_folder_read($1::uuid, $2::jsonb, $3) as value",
		[ENVIRONMENT, runRow.actor, path],
		PATH_DEADLINE,
		{ expected },
	);
const commit = (kind, runRow, key, units, receipt = null) =>
	call(
		kind,
		"qorpera_folder_commit",
		"select public.qorpera_folder_commit($1::uuid, $2::jsonb, $3, $4::jsonb, null, $5::uuid) as value",
		[ENVIRONMENT, runRow.actor, key, JSON.stringify(units), receipt],
		PATH_DEADLINE,
		{ expected: ["paused", "busy"] },
	);
// The upload's kind says what it carried: new bytes, bytes the company has (reused), or a subtree's file.
const seal = (runRow, text, kind = "write-upload") =>
	call(
		kind,
		"qorpera_folder_seal_upload",
		"select loadfolder.seal($1::jsonb, $2) as value",
		[runRow.actor, text],
		PATH_DEADLINE,
		{ expected: ["paused", "busy"] },
	);

// Who held a grant on load/restricted when: per agent, its grants as [granted (committed), revokeBegan, revoked].
const grants = new Map();
// Receipts a run could not resolve within 30 s (a commit or a completion that kept failing).
let unresolved = 0;
const restrictedReads = [];
const wakes = { passes: 0, byStatus: {} };
const gcOutcomes = new Map();
const stops = [];

async function agentRun(runRow, others, gcTexts) {
	const reads = [];
	for (let round = 1; running(); round += 1) {
		await fence("fence", runRow);
		const got = await read("read", runRow, `load/shared/d${1 + Math.floor(Math.random() * 20)}/f${1 + Math.floor(Math.random() * 50)}.md`);
		if (got.value?.entry) reads.push(got.value.entry);
		await call(
			"list",
			"qorpera_folder_list",
			"select public.qorpera_folder_list($1::uuid, $2::jsonb, $3, null, 50, false) as value",
			[ENVIRONMENT, runRow.actor, `load/shared/d${1 + Math.floor(Math.random() * 20)}`],
			PATH_DEADLINE,
			{ expected: ["paused"] },
		);
		if (round % 3 === 0 && reads.length) {
			const entries = reads.splice(0).map((entry) => ({ path: entry.path, version: entry.version, authority: entry.authority }));
			await call(
				"release",
				"qorpera_folder_record_release",
				"select public.qorpera_folder_record_release($1::uuid, $2::jsonb, $3::uuid, $4::jsonb, $5) as value",
				[ENVIRONMENT, runRow.actor, randomUUID(), JSON.stringify(entries), "0".repeat(64)],
				PATH_DEADLINE,
				{ expected: ["paused", "busy"] },
			);
		}
		if (!running()) return;
		if (round % 2 === 0) await write(runRow, round, gcTexts);
		if (!running()) return;
		if (round % 5 === 0) {
			const sample = await read("restricted-read", runRow, `load/restricted/r${1 + Math.floor(Math.random() * 50)}.md`);
			// A read the actor may not make finds nothing (found: false), as for a path that is not there.
			restrictedReads.push({
				agent: runRow.agent,
				// The read's statement was sent at queriedAt, and ended by endedAt.
				began: sample.sample.queriedAt,
				endedAt: sample.sample.endedAt,
				ok: sample.value?.found === true,
			});
		}
		if (!running()) return;
		if (round % 7 === 0) await subtree(runRow, round);
		if (!running()) return;
		if (round % 11 === 0 && others.length)
			await call(
				"message",
				"qorpera_send_coworker_message",
				"select public.qorpera_send_coworker_message($1::jsonb, $2::uuid, $3, $4, true) as value",
				[runRow.binding, pick(others).agent, `load-${runRow.n}-${round}`, `Load message ${round}.`],
				TOOL_DEADLINE,
				{ expected: ["paused", "busy"] },
			);
		await sleep(Math.random() * 20);
	}
}

/** A tool's write as the runtime does it: the gateway stores the bytes, then a receipt, the commit, its completion. */
async function write(runRow, round, gcTexts) {
	const text = round % 8 === 0 ? pick(gcTexts) : `Run ${runRow.n}, change ${round}, ${randomUUID()}.\n`;
	const reused = round % 8 === 0;
	const sealed = await seal(runRow, text, reused ? "write-upload-reused" : "write-upload");
	if (sealed.failure || sealed.value?.state !== "sealed") return;
	const receipt = randomUUID();
	const input = sha256(`${runRow.n}:${round}`);
	const key = `load-${runRow.n}-w${round}`;
	const begun = await call(
		"receipt-begin",
		"qorpera_begin_native_tool_operation",
		"select public.qorpera_begin_native_tool_operation($1::jsonb, $2::uuid, $3, $4, $5, true) as value",
		[runRow.binding, receipt, key, input, "b".repeat(64)],
		TOOL_DEADLINE,
		{ expected: ["paused"] },
	);
	if (begun.failure) return;
	// A receipt that needs a revision completes only with its commit: a refused commit (a stop, a narrowing) is sent
	// again with the same operation key and receipt until it lands, as the runtime does.
	const units = [{ op: "write", path: `load/work/${runRow.handle}/w${round}.md`, file: sealed.value.file }];
	// A run never ends with its receipt unresolved: the retries outlast the load's clock, for at most 30 s.
	let committed = await commit("commit", runRow, key, units, receipt);
	for (let attempt = 0; committed.failure && attempt < 120; attempt += 1) {
		await sleep(250);
		committed = await commit("commit-retry", runRow, key, units, receipt);
	}
	if (!committed.value?.commitId) {
		unresolved += 1;
		return;
	}
	// The completion too, until it lands (a stop refuses it while it lasts).
	for (let attempt = 0; attempt < 120; attempt += 1) {
		const completed = await call(
			"receipt-complete",
			"qorpera_folder_complete_run_receipt",
			"select public.qorpera_folder_complete_run_receipt($1::jsonb, $2::uuid, $3, $4::jsonb, $5::uuid) as value",
			[runRow.binding, receipt, input, JSON.stringify({ ok: true }), committed.value.commitId],
			TOOL_DEADLINE,
			{ expected: ["paused"] },
		);
		if (!completed.failure) return;
		await sleep(250);
	}
	unresolved += 1;
}

/** A folder of 20 files, then its subtree deleted as the agent saw it. */
async function subtree(runRow, round) {
	const sealed = await seal(runRow, `Subtree file of run ${runRow.n}.\n`, "subtree-upload");
	if (sealed.failure || sealed.value?.state !== "sealed") return;
	const path = `load/work/${runRow.handle}/s${round}`;
	const contents = Array.from({ length: 20 }, (_, index) => ({ path: `f${index}.md`, kind: "file", file: sealed.value.file }));
	const made = await commit("subtree-make", runRow, `load-${runRow.n}-s${round}`, [{ op: "new_folder", path, contents }]);
	if (made.failure) return;
	const seen = await read("subtree-read", runRow, path);
	if (!seen.value?.entry) return;
	await commit("subtree-delete", runRow, `load-${runRow.n}-d${round}`, [
		{ op: "delete", path, expectedVersion: seen.value.entry.version, asOfSeq: seen.value.asOfSeq },
	]);
}

/** The stop's two phases and a resume: the pause commits first, then the drain waits out the effects in flight. */
async function stopper() {
	while (running()) {
		await sleep(options.stopEvery * 1000);
		if (!running()) return;
		const paused = await call(
			"stop-pause",
			"qorpera_folder_pause",
			"select public.qorpera_folder_pause($1::uuid, $2::uuid, 'load') as value",
			[COMPANY, OWNER],
			30_000,
		);
		if (paused.failure) continue;
		const drained = await call(
			"stop-drain",
			"qorpera_folder_pause_drain",
			"select public.qorpera_folder_pause_drain($1::uuid) as value",
			[COMPANY],
			30_000,
		);
		stops.push({ drainMs: drained.sample.totalMs, failed: Boolean(drained.failure) });
		await sleep(1000);
		await call("stop-resume", "qorpera_folder_resume", "select public.qorpera_folder_resume($1::uuid) as value", [COMPANY], 30_000);
	}
}

/** Narrowing under load: one agent at a time gets read on load/restricted, then loses it. */
async function aclClient(runs, restrictedId) {
	while (running()) {
		const target = pick(runs);
		const history = grants.get(target.agent) ?? [];
		grants.set(target.agent, history);
		const grantBegan = performance.now();
		const granted = await call(
			"acl-grant",
			"qorpera_folder_grant",
			"select public.qorpera_folder_grant($1::uuid, $2::jsonb, $3::uuid, 'staff_agent', $4::uuid, array['read']) as value",
			[ENVIRONMENT, MEMBER, restrictedId, target.agent],
			PATH_DEADLINE,
			{ expected: ["busy"] },
		);
		// A grant whose commit failed may still have committed? No: a failed call rolled back. Count only committed ones.
		if (granted.failure || !granted.value?.grantId) continue;
		const entry = { grantBegan, granted: granted.sample.endedAt, revokeBegan: Number.POSITIVE_INFINITY, revoked: Number.POSITIVE_INFINITY };
		history.push(entry);
		await sleep(300);
		for (let attempt = 0; attempt < 20; attempt += 1) {
			entry.revokeBegan = performance.now();
			const revoked = await call(
				"acl-revoke",
				"qorpera_folder_revoke",
				"select public.qorpera_folder_revoke($1::uuid, $2::jsonb, $3::uuid, $4::uuid) as value",
				[ENVIRONMENT, MEMBER, restrictedId, granted.value.grantId],
				PATH_DEADLINE,
				{ expected: ["busy"] },
			);
			if (!revoked.failure) {
				entry.revoked = revoked.sample.endedAt;
				break;
			}
			await sleep(100);
		}
		if (entry.revoked === Number.POSITIVE_INFINITY && !running()) entry.revoked = performance.now();
		await sleep(200);
	}
}

/** A restricted read leaks when it found the file although no grant of its agent could have been live while it ran:
 * its [statement began, ended] overlaps no [grant began, revoke committed] window. */
function leaks() {
	let count = 0;
	for (const probe of restrictedReads) {
		if (!probe.ok) continue;
		const history = grants.get(probe.agent) ?? [];
		if (!history.some((entry) => probe.endedAt >= entry.grantBegan && probe.began <= entry.revoked)) count += 1;
	}
	return count;
}
/** Grants whose revoke never landed (twenty tries): their window stays open, so they fail the check. */
const stuckGrants = () => [...grants.values()].flat().filter((entry) => entry.revoked === Number.POSITIVE_INFINITY).length;

async function wakeAdmitter() {
	while (running()) {
		const admitted = await call(
			"wake-admit",
			"qorpera_folder_admit_wakes",
			"select public.qorpera_folder_admit_wakes($1::uuid)::text as value",
			[COMPANY],
			10_000,
			{ expected: [] },
		);
		if (!admitted.failure) wakes.passes += 1;
		await sleep(1000);
	}
}

/** Object GC as the worker and the gateway lane run it: the sweep, the claim, then each object's unlink. */
async function gc() {
	while (running()) {
		await call("gc-sweep", "qorpera_folder_sweep_upload_intents", "select public.qorpera_folder_sweep_upload_intents(20) as value", [], 30_000);
		const lease = randomUUID();
		const claimed = await call(
			"gc-claim",
			"qorpera_folder_claim_object_gc",
			"select public.qorpera_folder_claim_object_gc(10, $1::uuid) as value",
			[lease],
			30_000,
			{ expected: ["lock-timeout"] },
		);
		for (const object of claimed.value?.objects ?? []) {
			const begun = await call(
				"gc-unlink-begin",
				"qorpera_folder_gc_unlink_begin",
				"select public.qorpera_folder_gc_unlink_begin($1::uuid, $2, $3::uuid) as value",
				[object.profileId, object.sha256, lease],
				30_000,
				{ expected: ["lock-timeout"] },
			);
			if (begun.failure) continue;
			// The gateway deletes the NAS file here.
			const finished = await call(
				"gc-unlink-finish",
				"qorpera_folder_gc_unlink_finish",
				"select public.qorpera_folder_gc_unlink_finish($1::uuid, $2, $3::uuid) as value",
				[object.profileId, object.sha256, lease],
				30_000,
				{ expected: ["lock-timeout"] },
			);
			const outcome = finished.failure ? `failed: ${finished.failure.name}` : String(finished.value);
			gcOutcomes.set(outcome, (gcOutcomes.get(outcome) ?? 0) + 1);
		}
		await sleep(1000);
	}
}

/** A write elsewhere that points at the company: a row with a foreign key to the profile row (KEY SHARE), held 10 ms. */
async function foreignKeyInsert() {
	while (running()) {
		await call(
			"fk-insert",
			"qorpera_member_notification",
			"with inserted as (insert into public.qorpera_member_notifications(profile_id,user_id,kind,subject,dedupe_key) values ($1::uuid, $2::uuid, 'provider_usage_limit', '{}', $3) returning 1) select pg_sleep(0.01) as value from inserted",
			[COMPANY, OWNER, randomUUID()],
			5000,
			{ rollback: true },
		);
		await sleep(Math.random() * 20);
	}
}

/** The big run: its context fence re-checks its released paths; a re-grant of load/big makes it re-resolve them. */
async function bigRun(runRow, bigId) {
	let round = 0;
	while (running()) {
		round += 1;
		if (round % 5 === 0) {
			const regranted = await call(
				"big-regrant",
				"qorpera_folder_grant",
				"select public.qorpera_folder_grant($1::uuid, $2::jsonb, $3::uuid, 'staff_agent', $4::uuid, array['read']) as value",
				[ENVIRONMENT, MEMBER, bigId, runRow.agent],
				PATH_DEADLINE,
				{ expected: ["busy"] },
			);
			if (!regranted.failure) await fence("big-fence-after-regrant", runRow, FENCE_CALL_MS);
		} else await fence("big-fence", runRow, FENCE_CALL_MS);
		await sleep(2000);
	}
}

/** PL/pgSQL function statistics (track_functions = pl), flushed from this backend first. */
async function functionTimes(client) {
	await client.query("select pg_stat_force_next_flush()");
	await client.query("select pg_stat_clear_snapshot()");
	const rows = (
		await client.query("select funcname, calls, total_time, self_time from pg_stat_user_functions where schemaname = 'public'")
	).rows;
	return Object.fromEntries(rows.map((row) => [row.funcname, { calls: Number(row.calls), total: row.total_time, self: row.self_time }]));
}

/** Each deadlock the server logged: which call waited for which, and the row the cancelled one waited for, counted. */
function serverLog() {
	const log = spawnSync("docker", ["logs", containerName], { encoding: "utf-8", maxBuffer: 512 * 1024 * 1024 });
	return `${log.stdout}${log.stderr}`.split("\n");
}
function deadlockCycles(lines) {
	const name = (query) =>
		/public\.(qorpera_[a-z0-9_]+)\s*\(/.exec(query)?.[1] ??
		/(loadfolder\.[a-z_]+)\s*\(/.exec(query)?.[1] ??
		/^(?:with \S+ as \()?(insert into \S+|delete from \S+)/.exec(query.trim())?.[1] ??
		query.trim().slice(0, 40);
	const counts = new Map();
	for (let index = 0; index < lines.length; index += 1) {
		if (!lines[index].includes("ERROR:  deadlock detected")) continue;
		const names = new Map();
		const waits = [];
		let waited = "";
		for (let next = index + 1; next < lines.length && next < index + 60; next += 1) {
			const line = lines[next];
			if (line.includes("ERROR:  ")) break;
			const process = /Process (\d+): (.*)$/.exec(line);
			if (process) names.set(process[1], name(process[2]));
			const wait = /Process (\d+) waits for (\S+) on (transaction|tuple|relation)[^;]*; blocked by process (\d+)/.exec(line);
			if (wait) waits.push(wait);
			const context = /while ([a-z ]+) tuple \(\d+,\d+\) (?:in|of) (?:relation|index) "([^"]+)"/.exec(line);
			if (context && !waited) waited = `${context[1]} ${context[2]}`;
		}
		const cycle = waits
			.map(([, waiter, mode, object, holder]) => `${names.get(waiter)} waits (${mode} on a ${object}) for ${names.get(holder)}`)
			.sort()
			.join("; ");
		const key = `${cycle}${waited ? ` [the cancelled call was ${waited}]` : ""}`;
		counts.set(key, (counts.get(key) ?? 0) + 1);
	}
	return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}
/** Lock waits the server logged (log_lock_waits: each wait past deadlock_timeout, 1 s), by the waiting statement. */
function lockWaits(lines) {
	const counts = new Map();
	for (let index = 0; index < lines.length; index += 1) {
		if (!/LOG: {2}process \d+ still waiting for/.test(lines[index])) continue;
		const mode = /still waiting for (\S+) on (\S+)/.exec(lines[index]);
		let statement = "";
		for (let next = index + 1; next < lines.length && next < index + 6; next += 1) {
			const found = /STATEMENT: {2}(.*)$/.exec(lines[next]);
			if (found) {
				statement = /public\.(qorpera_[a-z0-9_]+)\s*\(/.exec(found[1])?.[1] ?? found[1].trim().slice(0, 40);
				break;
			}
		}
		const key = `${statement || "?"} waits for ${mode?.[1] ?? "?"} on a ${mode?.[2] ?? "?"}`;
		counts.set(key, (counts.get(key) ?? 0) + 1);
	}
	return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

/** Where each statement the 8 s statement timeout cancelled was: the PL/pgSQL frames of its CONTEXT, innermost first. */
function statementTimeouts(lines) {
	const counts = new Map();
	for (let index = 0; index < lines.length; index += 1) {
		if (!lines[index].includes("ERROR:  canceling statement due to statement timeout")) continue;
		let context = "";
		for (let next = index + 1; next < lines.length && next < index + 12; next += 1) {
			if (/ERROR: {2}|LOG: {2}/.test(lines[next])) break;
			if (/CONTEXT: {2}/.test(lines[next]) || (context && /^\t/.test(lines[next]))) context += ` ${lines[next].trim()}`;
		}
		const frames = [...context.matchAll(/PL\/pgSQL function (?:public\.|loadfolder\.)?([a-z0-9_]+)\([^)]*\) line (\d+)/g)]
			.map(([, fn, line]) => `${fn}:${line}`)
			.join(" < ");
		const key = frames || context.trim().slice(0, 120) || "(no context)";
		counts.set(key, (counts.get(key) ?? 0) + 1);
	}
	return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

/** Statements over 1 s that auto_explain logged, nested ones included: by text (whitespace folded), with the longest. */
function slowPlans(lines) {
	const counts = new Map();
	for (let index = 0; index < lines.length; index += 1) {
		const found = /LOG: {2}duration: ([0-9.]+) ms {2}plan:/.exec(lines[index]);
		if (!found) continue;
		let text = "";
		const plan = [];
		for (let next = index + 1; next < lines.length && next < index + 80; next += 1) {
			if (!/^\t/.test(lines[next])) break;
			const query = /Query Text: (.*)$/.exec(lines[next]);
			if (query && !text) text = query[1].replace(/\s+/g, " ").trim().slice(0, 160);
			else if (text && /->|Scan|Join|Loop|Filter|Cond|SubPlan|InitPlan|Sort|Aggregate|LockRows/.test(lines[next])) plan.push(lines[next].replace(/^\t/, ""));
		}
		const entry = counts.get(text) ?? { count: 0, maxMs: 0, plan: [] };
		entry.count += 1;
		if (Number(found[1]) > entry.maxMs) {
			entry.maxMs = Math.round(Number(found[1]));
			entry.plan = plan.slice(0, 40);
		}
		counts.set(text, entry);
	}
	return [...counts.entries()].sort((a, b) => b[1].count - a[1].count);
}

/** Statements running over 2 s, sampled every 500 ms on a connection of its own: by call and what each waited on (a lock,
 * an I/O or LWLock wait, or none: CPU), with the longest seen. A wait the server's log_lock_waits does not report (I/O,
 * LWLocks, a busy CPU) shows here. */
const slowStatements = new Map();
async function sampler(port) {
	// Diagnostics never fail the run: a sampler that cannot connect or loses its connection stops and says so.
	const client = new pg.Client({ host: "127.0.0.1", port, user: "postgres", password, database });
	client.on("error", (error) => process.stdout.write(`sampler connection lost: ${error.message}\n`));
	try {
		await client.connect();
		while (running()) {
			const { rows } = await client.query(`select query, wait_event_type, wait_event,
					cardinality(pg_blocking_pids(pid)) > 0 as blocked,
					extract(epoch from clock_timestamp() - query_start) * 1000 as ms
				from pg_stat_activity where state = 'active' and pid <> pg_backend_pid() and backend_type = 'client backend'
					and clock_timestamp() - query_start > interval '2 seconds'`);
			for (const row of rows) {
				const call = /public\.(qorpera_[a-z0-9_]+)\s*\(/.exec(row.query)?.[1] ?? /(loadfolder\.[a-z_]+)\s*\(/.exec(row.query)?.[1] ?? row.query.trim().slice(0, 40);
				const key = `${call} ${row.blocked ? "blocked on " : ""}${row.wait_event_type ? `${row.wait_event_type}:${row.wait_event}` : "running (CPU)"}`;
				const entry = slowStatements.get(key) ?? { samples: 0, maxMs: 0 };
				entry.samples += 1;
				entry.maxMs = Math.max(entry.maxMs, Math.round(Number(row.ms)));
				slowStatements.set(key, entry);
			}
			await sleep(500);
		}
	} catch (error) {
		process.stdout.write(`sampler stopped: ${error.message}\n`);
	} finally {
		await client.end().catch(() => undefined);
	}
}

const slru = () =>
	JSON.parse(
		psql(
			"select coalesce(json_object_agg(name, json_build_object('zeroed', blks_zeroed, 'written', blks_written, 'read', blks_read)), '{}') from pg_stat_slru where name ilike 'multixact%';",
		),
	);

function report(seconds) {
	const pad = (value, width) => String(value).padStart(width);
	const lines = [
		`${"kind".padEnd(24)}${pad("calls", 7)}${pad("ok/s", 7)}${pad("p50", 7)}${pad("p95", 7)}${pad("p99", 7)}${pad("max", 7)}${pad("queue95", 8)}${pad("gave-up", 8)}  failures`,
	];
	const summary = {};
	for (const [kind, samples] of [...stats.entries()].sort(([a], [b]) => a.localeCompare(b))) {
		const ok = samples.filter((sample) => !sample.failure).length;
		const failures = Object.fromEntries(
			CLASSES.map((name) => [name, samples.filter((sample) => sample.failure?.name === name).length]).filter(([, count]) => count),
		);
		const totals = samples.map((sample) => sample.totalMs);
		summary[kind] = {
			calls: samples.length,
			okPerSecond: Number((ok / seconds).toFixed(1)),
			p50: Math.round(percentile(totals, 0.5)),
			p95: Math.round(percentile(totals, 0.95)),
			p99: Math.round(percentile(totals, 0.99)),
			max: Math.round(Math.max(...totals)),
			queueP95: Math.round(percentile(samples.map((sample) => sample.queueMs), 0.95)),
			gaveUp: samples.filter((sample) => sample.gaveUp).length,
			failures,
		};
		const row = summary[kind];
		lines.push(
			`${kind.padEnd(24)}${pad(row.calls, 7)}${pad(row.okPerSecond, 7)}${pad(row.p50, 7)}${pad(row.p95, 7)}${pad(row.p99, 7)}${pad(row.max, 7)}${pad(row.queueP95, 8)}${pad(row.gaveUp, 8)}  ${Object.entries(
				failures,
			)
				.map(([name, count]) => `${name} ${count}`)
				.join(", ")}`,
		);
	}
	const details = new Map();
	for (const [kind, samples] of stats)
		for (const sample of samples)
			if (sample.failure) {
				const key = `${kind}: ${sample.failure.name}: ${sample.failure.detail}`;
				details.set(key, (details.get(key) ?? 0) + 1);
			}
	for (const [key, count] of [...details.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30)) lines.push(`  ${count} x ${key}`);
	return { lines, summary };
}

try {
	run("docker", ["info", "--format", "{{.ServerVersion}}"]);
	// A real disk: the data directory is an anonymous Docker volume (removed with the container), fsync on.
	run("docker", [
		"run",
		"--detach",
		"--rm",
		"--name",
		containerName,
		"--publish",
		"127.0.0.1::5432",
		"--shm-size",
		"512m",
		"--volume",
		"/var/lib/postgresql/data",
		"--env",
		`POSTGRES_PASSWORD=${password}`,
		"--env",
		`POSTGRES_DB=${database}`,
		POSTGRES_IMAGE,
		"-c",
		"max_connections=300",
		"-c",
		"shared_buffers=512MB",
		"-c",
		"log_lock_waits=on",
		"-c",
		"deadlock_timeout=1s",
		// Where the time goes: PL/pgSQL functions' totals, and every statement over 1 s, nested ones too, with its text.
		"-c",
		"track_functions=pl",
		"-c",
		"shared_preload_libraries=auto_explain",
		"-c",
		"auto_explain.log_min_duration=1000",
		"-c",
		"auto_explain.log_nested_statements=on",
	]);
	for (let ready = 0, attempt = 0; ready < 2; attempt += 1) {
		if (attempt > 120) throw new Error("Disposable PostgreSQL did not become ready within 60 seconds");
		ready =
			spawnSync("docker", ["exec", containerName, "pg_isready", "-U", "postgres", "-d", database]).status === 0
				? ready + 1
				: 0;
		spawnSync("sleep", ["0.5"]);
	}
	const disk = run("docker", ["exec", containerName, "sh", "-c", "df -PT /var/lib/postgresql/data | tail -1"]).trim();
	if (/tmpfs/.test(disk)) throw new Error(`The data directory is on tmpfs, not a real disk: ${disk}`);
	psql(readFileSync(join(repositoryRoot, "supabase", "tests", "bootstrap.sql"), "utf-8"));
	const migrations = sortMigrationNames(readdirSync(join(repositoryRoot, "supabase", "migrations")));
	for (const name of options.skipped) if (!migrations.includes(name)) throw new Error(`No migration ${name} to skip`);
	for (const migration of migrations.filter((name) => !options.skipped.has(name)))
		psql(readFileSync(join(repositoryRoot, "supabase", "migrations", migration), "utf-8"));
	const testsRoot = join(repositoryRoot, "supabase", "tests");
	const fixture = expandTestFixture("load-folder-core.sql", (name) =>
		name === "load-folder-core.sql"
			? '-- @fixture 648_folder_core_run_fence_concurrency.test.sql until "-- A. Two tool calls of one run"\n'
			: readFileSync(join(testsRoot, name), "utf-8"),
	);
	const setupStarted = performance.now();
	psql(
		`select set_config('loadfolder.runs', '${options.runs}', false), set_config('loadfolder.big', '${options.big || options.probeOnly}', false), set_config('loadfolder.big_paths', '${options.bigPaths}', false) \\g /dev/null\n${fixture}${readFileSync(join(repositoryRoot, "scripts", "load-folder-core.sql"), "utf-8")}`,
	);
	const setupSeconds = (performance.now() - setupStarted) / 1000;
	const runs = JSON.parse(psql("select coalesce(json_agg(json_build_object('n', n, 'agent', agent, 'handle', handle, 'actor', actor::text, 'binding', binding::text, 'big', big) order by n), '[]') from loadfolder.runs;"));
	const gcTexts = JSON.parse(psql("select coalesce(json_agg(text order by n), '[]') from loadfolder.gc_texts;"));
	const resource = (path) =>
		psql(`select id from public.qorpera_company_path_resources where environment_id = '${ENVIRONMENT}' and path = '${path}';`).trim();
	const restrictedId = resource("load/restricted");
	const bigId = resource("load/big");
	const port = /:(\d+)\s*$/.exec(run("docker", ["port", containerName, "5432/tcp"]).trim().split("\n")[0])?.[1];
	if (!port) throw new Error("The disposable PostgreSQL has no published port");
	const slruBefore = slru();
	const loadBegan = psql("select clock_timestamp();").trim();
	const deadlocksBefore = Number(psql(`select deadlocks from pg_stat_database where datname = '${database}';`).trim());

	pool = new pg.Pool({ host: "127.0.0.1", port: Number(port), user: "postgres", password, database, max: options.pool });
	// PostgREST's role settings, as the live `authenticator` has them (20260913000100).
	pool.on("connect", (client) => {
		client.query("set statement_timeout = '8s'; set lock_timeout = '8s'").catch(() => undefined);
	});
	const statsClient = new pg.Client({ host: "127.0.0.1", port: Number(port), user: "postgres", password, database });
	await statsClient.connect();
	const functionsBeforeLoad = await functionTimes(statsClient);
	end = performance.now() + (options.probeOnly ? 0 : options.seconds * 1000);
	const started = performance.now();
	const bigRow = runs.find((row) => row.big);
	const loadRuns = runs.filter((row) => !row.big);
	await Promise.all([
		...loadRuns.map((row) => agentRun(row, loadRuns.filter((other) => other.n !== row.n), gcTexts)),
		...(bigRow ? [bigRun(bigRow, bigId)] : []),
		stopper(),
		aclClient(loadRuns, restrictedId),
		wakeAdmitter(),
		gc(),
		foreignKeyInsert(),
		foreignKeyInsert(),
		sampler(Number(port)),
	]);
	const seconds = (performance.now() - started) / 1000;
	await pool.end();
	pool = undefined;
	// The pool's connections flushed their statistics as they closed.
	const loadFunctions = Object.entries(await functionTimes(statsClient))
		.map(([name, value]) => ({
			name,
			calls: value.calls - (functionsBeforeLoad[name]?.calls ?? 0),
			selfMs: Math.round(value.self - (functionsBeforeLoad[name]?.self ?? 0)),
			totalMs: Math.round(value.total - (functionsBeforeLoad[name]?.total ?? 0)),
		}))
		.filter((row) => row.calls > 0)
		.sort((a, b) => b.selfMs - a.selfMs)
		.slice(0, 12);
	await statsClient.end();

	// The big run alone: no load, no statement timeout. Each probe is one transaction.
	const quiet = {};
	if (bigRow) {
		const client = new pg.Client({ host: "127.0.0.1", port: Number(port), user: "postgres", password, database });
		await client.connect();
		const timed = async (sql, params) => {
			const began = performance.now();
			await client.query("begin");
			await client.query("select set_config('request.jwt.claims', $1, true)", [SERVICE_CLAIMS]);
			await client.query(sql, params);
			await client.query("commit");
			return Math.round(performance.now() - began);
		};
		const fenceSql = "select public.qorpera_fence_native_context($1::uuid, $2::jsonb, $3::text[], $4::jsonb)";
		const regrant = () =>
			timed("select public.qorpera_folder_grant($1::uuid, $2::jsonb, $3::uuid, 'staff_agent', $4::uuid, array['read'])", [
				ENVIRONMENT,
				MEMBER,
				bigId,
				bigRow.agent,
			]);
		await timed(fenceSql, [ENVIRONMENT, bigRow.binding, [], contextView()]);
		quiet.fenceStampedMs = await timed(fenceSql, [ENVIRONMENT, bigRow.binding, [], contextView()]);
		await regrant();
		quiet.fenceAfterRegrantMs = await timed(fenceSql, [ENVIRONMENT, bigRow.binding, [], contextView()]);
		await regrant();
		const functionsBefore = options.probeOnly ? await functionTimes(client) : null;
		quiet.readSetCheckAfterRegrantMs = await timed(
			"select public.qorpera_assert_company_path_reads($1::uuid, $2::jsonb, $3::text[])",
			[ENVIRONMENT, bigRow.binding, []],
		);
		if (functionsBefore) {
			const after = await functionTimes(client);
			quiet.functions = Object.entries(after)
				.map(([name, value]) => ({
					name,
					calls: value.calls - (functionsBefore[name]?.calls ?? 0),
					selfMs: Math.round(value.self - (functionsBefore[name]?.self ?? 0)),
					totalMs: Math.round(value.total - (functionsBefore[name]?.total ?? 0)),
				}))
				.filter((row) => row.calls > 0)
				.sort((a, b) => b.selfMs - a.selfMs)
				.slice(0, 15);
		}
		quiet.readSetCheckStampedMs = await timed("select public.qorpera_assert_company_path_reads($1::uuid, $2::jsonb, $3::text[])", [
			ENVIRONMENT,
			bigRow.binding,
			[],
		]);
		quiet.readSetPaths = Number(
			(
				await client.query(
					"select count(distinct x ->> 'path') as n from public.qorpera_folder_run_read_records rec, jsonb_array_elements(rec.reads) x where rec.run_id = $1::uuid",
					[JSON.parse(bigRow.binding).runId],
				)
			).rows[0].n,
		);
		// A release of up to 10,000 reads (the runtime's cap) with current receipts, then one whose receipts a re-grant
		// made stale (each path is re-resolved).
		const releaseSize = Math.min(10_000, options.bigPaths);
		const entries = async () =>
			(
				await client.query(
					`select jsonb_agg(jsonb_build_object('path', e ->> 'path', 'version', e ->> 'version', 'authority', e -> 'authority')) as reads
					from (select public.qorpera_folder_read($1::uuid, $2::jsonb, 'load/big/b' || (1 + (n - 1) / 500) || '/f' || (1 + (n - 1) % 500) || '.md') -> 'entry' as e
						from generate_series(1, $3::integer) n) x`,
					[ENVIRONMENT, bigRow.actor, releaseSize],
				)
			).rows[0].reads;
		await client.query("select set_config('request.jwt.claims', $1, false)", [SERVICE_CLAIMS]);
		const release = (reads) =>
			timed("select public.qorpera_folder_record_release($1::uuid, $2::jsonb, $3::uuid, $4::jsonb, $5)", [
				ENVIRONMENT,
				bigRow.actor,
				randomUUID(),
				JSON.stringify(reads),
				"0".repeat(64),
			]);
		quiet.releasePaths = releaseSize;
		quiet.releaseCurrentMs = await release(await entries());
		const staleReads = await entries();
		await regrant();
		quiet.releaseStaleMs = await release(staleReads);
		await client.end();
	}

	// The folder after the load: every entry's parent folder is there, and every file's bytes (its manifest and chunks).
	const [missingParents, lostBytes, entries] = psql(`
		select (select count(*) from public.qorpera_folder_entries e where e.environment_id = '${ENVIRONMENT}' and e.kind <> 'claim'
				and public.qorpera_folder_parent_path(e.path) is not null
				and not exists (select 1 from public.qorpera_folder_entries p where p.environment_id = e.environment_id and p.kind = 'folder'
					and p.key_text = public.qorpera_folder_key(public.qorpera_folder_parent_path(e.path)))),
			(select count(*) from public.qorpera_folder_entries e where e.environment_id = '${ENVIRONMENT}' and e.kind = 'file'
				and (not exists (select 1 from public.qorpera_profile_objects o where o.profile_id = '${COMPANY}' and o.sha256 = e.manifest_sha256)
					or exists (select 1 from public.qorpera_folder_file_chunks c where c.profile_id = '${COMPANY}' and c.manifest_sha256 = e.manifest_sha256
						and not exists (select 1 from public.qorpera_profile_objects o where o.profile_id = '${COMPANY}' and o.sha256 = c.chunk_sha256)))),
			(select count(*) from public.qorpera_folder_entries e where e.environment_id = '${ENVIRONMENT}' and e.kind <> 'claim');`)
		.trim()
		.split("|")
		.map(Number);
	wakes.byStatus = JSON.parse(
		psql(`select coalesce(json_object_agg(status, n), '{}') from (select status, count(*) n from public.qorpera_wake_occurrences
			where profile_id = '${COMPANY}' and created_at >= '${loadBegan}' group by status) x;`),
	);
	// The objects the most paths name (entries and path versions), for reading the upload's presence check.
	const referenced = psql(`select count(*) || ' paths name ' || left(x.manifest_sha256, 12) || coalesce(' (' || min(x.path) || ' …)', '')
		from (select manifest_sha256, path from public.qorpera_folder_entries where environment_id = '${ENVIRONMENT}' and kind = 'file'
			union all select manifest_sha256, path from public.qorpera_folder_path_versions where environment_id = '${ENVIRONMENT}'
				and manifest_sha256 is not null) x
		group by x.manifest_sha256 order by count(*) desc limit 4;`)
		.trim()
		.split("\n")
		.filter(Boolean);
	const slruAfter = slru();
	const deadlocksAfter = Number(psql(`select deadlocks from pg_stat_database where datname = '${database}';`).trim());
	const multixact = Object.fromEntries(
		Object.entries(slruAfter).map(([name, after]) => [
			name,
			Object.fromEntries(Object.entries(after).map(([key, value]) => [key, value - (slruBefore[name]?.[key] ?? 0)])),
		]),
	);
	const lines = serverLog();
	const cycles = deadlockCycles(lines);
	const waits = lockWaits(lines);
	const timeouts = statementTimeouts(lines);
	const plans = slowPlans(lines);
	const { lines: table, summary } = report(seconds);
	const leaked = leaks();
	const drains = stops.map((stop) => stop.drainMs);
	const all = [...stats.entries()].flatMap(([kind, samples]) => samples.map((sample) => ({ kind, ...sample })));
	// Unexpected: a failure no call listed as expected. A deadlock, a statement timeout or another failure is never
	// excused; only GC, whose functions wait at most 2 s for a lock and skip, lists a lock wait that ran out.
	const unexpected = all.filter((sample) => sample.failure && (!sample.failure.expected || UNEXPECTED.has(sample.failure.name))).length;
	const slowTools = all.filter((sample) => RUN_KINDS.has(sample.kind) && sample.totalMs > RESULT_FENCE_MS).length;
	const slowBig = all.filter((sample) => sample.kind.startsWith("big-fence") && sample.totalMs > FENCE_CALL_MS).length;
	const stuck = stuckGrants();
	const bigFailed = all.filter((sample) => sample.kind.startsWith("big-fence") && sample.failure && sample.failure.name !== "paused").length;

	process.stdout.write(
		`Folder core load ${seconds.toFixed(0)} s on one company: ${loadRuns.length} runs${bigRow ? ` + the big run (${options.bigPaths} released paths)` : ""}${options.probeOnly ? " (probe only: no load)" : ""}, stop every ${options.stopEvery} s, ACL, wakes, GC, 2 foreign-key writers; pool ${options.pool}, round trip ${options.rtt} ms, statement_timeout 8s, lock_timeout 8s; real disk (${disk.split(/\s+/)[1]}); setup ${setupSeconds.toFixed(0)} s${options.skipped.size ? `; without ${[...options.skipped].join(", ")}` : ""}\n`,
	);
	process.stdout.write(`${table.join("\n")}\n`);
	process.stdout.write(
		`stops: ${stops.length}, drain p50 ${Math.round(percentile(drains, 0.5))} ms, max ${Math.round(Math.max(0, ...drains))} ms; wakes made during the load by status ${JSON.stringify(wakes.byStatus)} (${wakes.passes} admission passes); GC ${JSON.stringify(Object.fromEntries(gcOutcomes))}\n`,
	);
	process.stdout.write(
		`folder: ${entries} entries, ${missingParents} without their parent, ${lostBytes} files whose bytes are gone; restricted reads ${restrictedReads.length} (${restrictedReads.filter((probe) => probe.ok).length} allowed), leaks ${leaked}\n`,
	);
	if (bigRow)
		process.stdout.write(
			`the big run alone (${quiet.readSetPaths} paths in its read set): context fence ${quiet.fenceStampedMs} ms stamped, ${quiet.fenceAfterRegrantMs} ms after a re-grant; one read-set check ${quiet.readSetCheckStampedMs} ms stamped, ${quiet.readSetCheckAfterRegrantMs} ms after a re-grant; a release of ${quiet.releasePaths} reads ${quiet.releaseCurrentMs} ms with current receipts, ${quiet.releaseStaleMs} ms with stale ones\n`,
		);
	if (quiet.functions) {
		process.stdout.write("where the re-check after a re-grant spends its time (PL/pgSQL functions by self time):\n");
		for (const row of quiet.functions)
			process.stdout.write(`  ${row.name}: ${row.calls} calls, self ${row.selfMs} ms, total ${row.totalMs} ms\n`);
	}
	process.stdout.write(`multixact SLRU (deltas): ${JSON.stringify(multixact)}; deadlocks (pg_stat_database) ${deadlocksAfter - deadlocksBefore}\n`);
	if (waits.length) process.stdout.write("lock waits over 1 s (log_lock_waits), by the waiting call:\n");
	for (const [key, count] of waits.slice(0, 15)) process.stdout.write(`  ${count} x ${key}\n`);
	if (slowStatements.size) process.stdout.write("statements over 2 s (sampled every 0.5 s), by call and what they waited on:\n");
	for (const [key, entry] of [...slowStatements.entries()].sort((a, b) => b[1].samples - a[1].samples).slice(0, 15))
		process.stdout.write(`  ${entry.samples} samples, up to ${entry.maxMs} ms: ${key}\n`);
	if (plans.length) process.stdout.write("statements over 1 s, nested ones too (auto_explain), by text:\n");
	for (const [text, entry] of plans.slice(0, 12)) {
		process.stdout.write(`  ${entry.count} x, up to ${entry.maxMs} ms: ${text}\n`);
		// The plan of the slowest, for the load's own calls (not the fixture's setup).
		if (/qorpera_profile_objects|upload_intent|object_readable|path_versions/.test(entry.plan.join(" ")) || /^select coalesce\(jsonb_agg\(p\.sha256/.test(text))
			for (const line of entry.plan) process.stdout.write(`      ${line}\n`);
	}
	process.stdout.write(`the objects most paths name: ${referenced.join("; ")}\n`);
	process.stdout.write("PL/pgSQL functions by self time over the load:\n");
	for (const row of loadFunctions)
		process.stdout.write(`  ${row.name}: ${row.calls} calls, self ${row.selfMs} ms, total ${row.totalMs} ms\n`);
	if (timeouts.length) process.stdout.write("statement timeouts from the server log, by where they were (PL/pgSQL frames, innermost first):\n");
	for (const [key, count] of timeouts.slice(0, 12)) process.stdout.write(`  ${count} x ${key}\n`);
	if (cycles.length) process.stdout.write("deadlocks from the server log (who waited for whom, and the row the cancelled call waited for):\n");
	for (const [key, count] of cycles.slice(0, 12)) process.stdout.write(`  ${count} x ${key}\n`);
	const result = {
		seconds: Number(seconds.toFixed(1)),
		setupSeconds: Number(setupSeconds.toFixed(1)),
		options: { runs: loadRuns.length, big: Boolean(bigRow), pool: options.pool, rtt: options.rtt, stopEvery: options.stopEvery },
		deadlocks: deadlocksAfter - deadlocksBefore,
		unexpected,
		leaks: leaked,
		missingParents,
		lostBytes,
		slowTools,
		slowBig,
		bigFailed,
		unresolved,
		quiet,
		stops: { count: stops.length, drainP50: Math.round(percentile(drains, 0.5)), drainMax: Math.round(Math.max(0, ...drains)) },
		wakes,
		gc: Object.fromEntries(gcOutcomes),
		multixact,
		lockWaits: waits.reduce((total, [, count]) => total + count, 0),
		slowStatements: Object.fromEntries(slowStatements),
		statementTimeouts: Object.fromEntries(timeouts),
		slowPlans: Object.fromEntries(plans.slice(0, 20).map(([text, entry]) => [text, { count: entry.count, maxMs: entry.maxMs }])),
		loadFunctions,
		summary,
	};
	process.stdout.write(`== load-folder-core ${JSON.stringify(result)}\n`);
	const problems = [
		result.deadlocks || cycles.length ? `${Math.max(result.deadlocks, cycles.length)} deadlocks` : "",
		unexpected ? `${unexpected} calls failed unexpectedly or ran into the statement timeout` : "",
		leaked ? `${leaked} restricted reads leaked` : "",
		missingParents ? `${missingParents} entries without their parent` : "",
		lostBytes ? `${lostBytes} files whose bytes are gone` : "",
		slowTools ? `${slowTools} run calls over the 4 s result fence` : "",
		stuck ? `${stuck} revokes never landed` : "",
		unresolved ? `${unresolved} receipts left unresolved` : "",
		slowBig ? `${slowBig} big-run context fences over the 3.5 s call budget` : "",
		bigFailed ? `${bigFailed} big-run context fences failed` : "",
		bigRow && quiet.fenceAfterRegrantMs > FENCE_CALL_MS
			? `the big run's context fence after a re-grant took ${quiet.fenceAfterRegrantMs} ms alone (budget ${FENCE_CALL_MS} ms)`
			: "",
		// C1e's target for the re-resolution itself (the coordinator's, 3 Oct): under 1 s at 25,000 paths.
		bigRow && quiet.readSetCheckAfterRegrantMs > 1000
			? `one read-set check after a re-grant took ${quiet.readSetCheckAfterRegrantMs} ms alone (target 1,000 ms)`
			: "",
		bigRow && quiet.releaseStaleMs > PATH_DEADLINE
			? `a release of ${quiet.releasePaths} stale reads took ${quiet.releaseStaleMs} ms alone (deadline ${PATH_DEADLINE} ms)`
			: "",
	].filter(Boolean);
	if (options.check && problems.length) {
		process.stdout.write(`Check failed: ${problems.join("; ")}\n`);
		process.exitCode = 1;
	}
} finally {
	await pool?.end();
	spawnSync("docker", ["rm", "--force", "--volumes", containerName]);
}
