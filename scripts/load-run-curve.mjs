import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The agent-run concurrency curve (perf sprint, 7 Nov 2026): scripts/load-folder-core.mjs at each size in --sizes, one
 * disposable PostgreSQL per size, then one table: every run call's p50, p95, p99 and max, the pool queue's p95, calls
 * a second, failures. Defaults model production: 4 CPUs for the database, PostgREST's default pool of 10 connections,
 * a real run's pace of about a round of 5 calls every 2 s, and 30 ms outside the database per call.
 *
 *   node scripts/load-run-curve.mjs [--sizes 1,5,20,50] [--seconds 40] [--pace 2000] [--pool 10] [--rtt 30] [--cpus 4]
 *     [--parallel 0] [--lock-log-ms 100] [--skip <migration file>]...
 *
 * Flat out (--pace 0) finds the throughput ceiling. Collapse here means: p95 over 1 s, or any failed call.
 */
const options = { sizes: "1,5,20,50", seconds: "40", pace: "2000", pool: "10", rtt: "30", cpus: "4", parallel: "0", lockLogMs: "100" };
const skipped = [];
const args = process.argv.slice(2);
for (let index = 0; index < args.length; index += 2) {
	const [flag, value] = [args[index], args[index + 1]];
	if (!value) throw new Error(`${flag} needs a value`);
	if (flag === "--skip") skipped.push(value);
	else {
		const name = flag.replace(/^--/, "").replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
		if (!(name in options)) throw new Error(`Unknown argument ${flag}`);
		options[name] = value;
	}
}
const script = join(dirname(fileURLToPath(import.meta.url)), "load-folder-core.mjs");
const rows = [];
for (const size of options.sizes.split(",")) {
	const child = spawnSync(
		process.execPath,
		[
			script,
			...["--plain", "--no-big", "--runs", size, "--seconds", options.seconds, "--pace", options.pace, "--pool", options.pool],
			...["--rtt", options.rtt, "--cpus", options.cpus, "--parallel", options.parallel, "--lock-log-ms", options.lockLogMs],
			...skipped.flatMap((name) => ["--skip", name]),
		],
		{ encoding: "utf-8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "inherit"] },
	);
	process.stdout.write(child.stdout);
	if (child.status !== 0) throw new Error(`The load at ${size} runs failed (exit ${child.status})`);
	const line = child.stdout.split("\n").find((each) => each.startsWith("== load-run-curve "));
	if (!line) throw new Error(`The load at ${size} runs printed no curve line`);
	rows.push(JSON.parse(line.slice("== load-run-curve ".length)));
}
const pad = (value, width) => String(value).padStart(width);
process.stdout.write(`\n${"runs".padStart(5)}${pad("calls/s", 9)}${pad("p50", 7)}${pad("p95", 7)}${pad("p99", 7)}${pad("max", 7)}${pad("queue95", 9)}${pad("failed", 8)}\n`);
for (const row of rows)
	process.stdout.write(
		`${pad(row.runs, 5)}${pad(row.callsPerSecond, 9)}${pad(row.p50, 7)}${pad(row.p95, 7)}${pad(row.p99, 7)}${pad(row.max, 7)}${pad(row.poolQueueP95, 9)}${pad(row.failed, 8)}\n`,
	);
process.stdout.write(`== load-run-curve-table ${JSON.stringify(rows.map(({ byKind, holders, ...row }) => row))}\n`);
