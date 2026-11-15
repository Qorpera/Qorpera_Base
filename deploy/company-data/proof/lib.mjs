import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";

const require = createRequire(new URL("../../../packages/runtime/package.json", import.meta.url));
/** node-postgres, as packages/runtime pins it. */
export const pg = require("pg");

export const admin = (database = "postgres") =>
	new pg.Client({
		host: process.env.PGHOST,
		port: Number(process.env.PGPORT),
		user: process.env.PGUSER,
		password: process.env.PGPASSWORD,
		database,
	});

export async function withAdmin(database, work) {
	const client = admin(database);
	await client.connect();
	try {
		return await work(client);
	} finally {
		await client.end();
	}
}

export const connection = (database, user, password) => ({
	host: process.env.PGHOST,
	port: Number(process.env.PGPORT),
	user,
	password,
	database,
});

export function percentiles(samples) {
	const sorted = [...samples].sort((a, b) => a - b);
	const at = (p) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
	const round = (value) => Math.round(value * 100) / 100;
	return {
		n: sorted.length,
		p50: round(at(50)),
		p95: round(at(95)),
		p99: round(at(99)),
		max: round(sorted[sorted.length - 1]),
	};
}

export const now = () => performance.now();
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const results = [];
export function check(name, ok, detail = "") {
	results.push({ name, ok });
	console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}
export function note(text) {
	console.log(`      ${text}`);
}
export function finish() {
	const failed = results.filter((result) => !result.ok).length;
	console.log(`== ${results.length - failed} of ${results.length} checks passed`);
	process.exitCode = failed ? 1 : 0;
}

/** An error's SQLSTATE and message, or "no error". */
export async function outcome(work) {
	try {
		await work();
		return { ok: true, code: null, message: "no error" };
	} catch (error) {
		return { ok: false, code: error.code ?? null, message: String(error.message ?? error) };
	}
}
