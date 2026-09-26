import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { lstat, readFile, writeFile, rename, unlink } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";

const codes = new Set([
	"permit_window_missing",
	"permit_expired_open",
	"bound_identity_missing",
	"bound_observation_unconfirmed",
	"permit_generation_chain_invalid",
	"reservation_expired_unsettled",
	"closed_permit_unsettled",
	"prior_generation_unsettled",
	"hold_missing_prestart_custody",
	"held_meter_shape_unknown",
	"reservation_holds_mismatch",
	"bucket_conservation_mismatch",
	"billing_command_reconciliation_required",
]);
const uuid =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const guardUnits = new Set([
	"qorpera-paid-computer-guard.service",
	"qorpera-native-computer-guard.service",
	"qorpera-office-computer-guard.service",
]);
function absolute(path) {
	assert(
		typeof path === "string" &&
			isAbsolute(path) &&
			resolve(path) === path &&
			path !== "/" &&
			!/[\x00-\x1f\x7f]/.test(path),
		"Canonical absolute path required",
	);
	return path;
}
async function privateFile(path) {
	absolute(path);
	const stat = await lstat(path);
	assert(
		stat.isFile() &&
			!stat.isSymbolicLink() &&
			stat.uid === process.getuid?.() &&
			(stat.mode & 0o077) === 0 &&
			stat.size <= 16384,
		"Private operator-owned regular file required",
	);
	return readFile(path, "utf8");
}
export function healthOptions(value) {
	assert(
		value && typeof value === "object" && !Array.isArray(value),
		"Health configuration required",
	);
	assert(
		Object.keys(value).every((k) =>
			[
				"psqlPath",
				"serviceFile",
				"reportPath",
				"guardUnits",
				"systemctlPath",
				"graceSeconds",
				"sampleSeconds",
			].includes(k),
		),
		"Unknown health option",
	);
	const config = {
		...value,
		graceSeconds: value.graceSeconds ?? 60,
		sampleSeconds: value.sampleSeconds ?? 60,
		guardUnits: value.guardUnits ?? [],
	};
	for (const field of ["psqlPath", "serviceFile", "reportPath"])
		absolute(config[field]);
	for (const field of ["graceSeconds", "sampleSeconds"])
		assert(
			Number.isSafeInteger(config[field]) &&
				config[field] >= 30 &&
				config[field] <= 300,
			"Health time budget must be 30–300 seconds",
		);
	assert(
		Array.isArray(config.guardUnits) &&
			config.guardUnits.length <= 8 &&
			new Set(config.guardUnits).size === config.guardUnits.length &&
			config.guardUnits.every((unit) => guardUnits.has(unit)),
		"Explicit Qorpera guard units required",
	);
	if (config.guardUnits.length) absolute(config.systemctlPath);
	else
		assert(config.systemctlPath === undefined, "Unused systemctl path refused");
	return config;
}
export function healthReport(value, guards) {
	assert(
		value &&
			Object.keys(value).sort().join(",") ===
				"activePermitCount,findings,informational,observedAt,schema" &&
			value.schema === "qorpera.computer-accounting-health/v1" &&
			typeof value.observedAt === "string" &&
			Number.isFinite(Date.parse(value.observedAt)),
		"Health snapshot identity missing",
	);
	assert(
		Number.isSafeInteger(value.activePermitCount) &&
			value.activePermitCount >= 0 &&
			Array.isArray(value.findings) &&
			value.findings.length <= codes.size,
		"Invalid health snapshot",
	);
	const seen = new Set();
	for (const finding of value.findings) {
		assert(
			finding &&
				Object.keys(finding).sort().join(",") === "code,count,ids" &&
				codes.has(finding.code) &&
				!seen.has(finding.code) &&
				Number.isSafeInteger(finding.count) &&
				finding.count > 0 &&
				Array.isArray(finding.ids) &&
				finding.ids.length <= 20 &&
				finding.ids.every((id) => typeof id === "string" && uuid.test(id)),
			"Invalid health finding",
		);
		seen.add(finding.code);
	}
	assert(
		value.informational &&
			Object.keys(value.informational).join(",") ===
				"fundingShortfallBuckets" &&
			Number.isSafeInteger(value.informational.fundingShortfallBuckets) &&
			value.informational.fundingShortfallBuckets >= 0,
		"Invalid funding summary",
	);
	assert(
		Array.isArray(guards) &&
			guards.every(
				(g) =>
					g &&
					Object.keys(g).sort().join(",") === "state,unit" &&
					guardUnits.has(g.unit) &&
					["running", "unavailable"].includes(g.state),
			),
		"Invalid guard probe",
	);
	const custodyUnverified = value.activePermitCount > 0 && guards.length === 0;
	return {
		...value,
		guards,
		custodyUnverified,
		healthy:
			value.findings.length === 0 &&
			!custodyUnverified &&
			guards.every((g) => g.state === "running"),
		boundaries: {
			physicalState:
				"No direct physical observations; stale samples and unavailable guards do not prove stop.",
			mutation:
				"Read only; never settles, releases holds, reconstructs usage or changes rollout.",
		},
	};
}
async function executable(path) {
	const stat = await lstat(absolute(path));
	assert(
		stat.isFile() &&
			!stat.isSymbolicLink() &&
			(stat.mode & 0o022) === 0 &&
			(stat.uid === 0 || stat.uid === process.getuid?.()),
		"Unsafe operator executable",
	);
}
async function run(path, args, env, input) {
	return new Promise((resolveRun, reject) => {
		const child = spawn(path, args, { env, stdio: ["pipe", "pipe", "pipe"] });
		let output = "",
			bytes = 0,
			error;
		const timer = setTimeout(() => {
			error = new Error("Health probe timed out");
			child.kill("SIGKILL");
		}, 20000);
		child.on("error", () => {
			error = new Error("Health probe unavailable");
		});
		for (const [stream, keep] of [
			[child.stdout, true],
			[child.stderr, false],
		])
			stream.on("data", (chunk) => {
				bytes += chunk.length;
				if (bytes > 1048576) {
					error = new Error("Health probe output exceeded limit");
					child.kill("SIGKILL");
				} else if (keep) output += chunk.toString();
			});
		child.stdin.on("error", () => {});
		child.once("close", (code) => {
			clearTimeout(timer);
			if (error || code !== 0)
				reject(error ?? new Error("Health probe refused"));
			else resolveRun(output.trim());
		});
		child.stdin.end(input);
	});
}
async function save(path, value) {
	const parent = await lstat(dirname(path));
	assert(
		parent.isDirectory() &&
			!parent.isSymbolicLink() &&
			parent.uid === process.getuid?.() &&
			(parent.mode & 0o077) === 0,
		"Private report directory required",
	);
	const temporary = `${path}.${randomUUID()}.tmp`;
	try {
		await writeFile(temporary, JSON.stringify(value, null, 2) + "\n", {
			mode: 0o600,
			flag: "wx",
		});
		await rename(temporary, path);
	} finally {
		await unlink(temporary).catch(() => {});
	}
}
export async function accountingHealth(configPath) {
	const config = healthOptions(JSON.parse(await privateFile(configPath)));
	await privateFile(config.serviceFile);
	await executable(config.psqlPath);
	if (config.guardUnits.length) await executable(config.systemctlPath);
	const env = {
		PATH: "/usr/bin:/bin",
		HOME: dirname(config.serviceFile),
		LANG: "C",
		LC_ALL: "C",
		TZ: "UTC",
		PGSERVICEFILE: config.serviceFile,
		PGCONNECT_TIMEOUT: "10",
	};
	// A fixed role and row_security=off refuse partial RLS visibility. This role
	// has only explicitly provisioned reads and no member/runtime credentials.
	const sql = `begin isolation level repeatable read read only;set local statement_timeout='15s';set local lock_timeout='5s';set local role qorpera_accounting_monitor;set local row_security=off;\n${await readFile(new URL("./computer-accounting-health.sql", import.meta.url), "utf8")}\ncommit;`;
	const snapshot = JSON.parse(
		await run(
			config.psqlPath,
			[
				"-X",
				"--no-password",
				"--quiet",
				"--tuples-only",
				"--no-align",
				"--set",
				"ON_ERROR_STOP=1",
				"--set",
				`grace_seconds=${config.graceSeconds}`,
				"--set",
				`sample_seconds=${config.sampleSeconds}`,
				"--dbname",
				"service=qorpera-accounting-health",
			],
			env,
			sql,
		),
	);
	const guards = await Promise.all(
		config.guardUnits.map(async (unit) => {
			let state = "unavailable";
			try {
				const text = await run(
					config.systemctlPath,
					["show", unit, "--property=ActiveState", "--property=SubState"],
					{ PATH: "/usr/bin:/bin", LANG: "C" },
					undefined,
				);
				const fields = Object.fromEntries(
					text.split("\n").map((line) => line.split("=")),
				);
				if (fields.ActiveState === "active" && fields.SubState === "running")
					state = "running";
			} catch {}
			return { unit, state };
		}),
	);
	const report = healthReport(snapshot, guards);
	await save(config.reportPath, report);
	return report;
}
if (
	process.argv[1] &&
	pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
	try {
		assert(
			process.argv.length === 4 && process.argv[2] === "--config",
			"Use --config <private absolute JSON>",
		);
		const report = await accountingHealth(process.argv[3]);
		console.log(JSON.stringify(report));
		process.exitCode = report.healthy ? 0 : 1;
	} catch {
		console.error(
			JSON.stringify({
				schema: "qorpera.computer-accounting-health/v1",
				healthy: false,
				error: "accounting_probe_unavailable",
			}),
		);
		process.exitCode = 2;
	}
}
