import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** A ratchet on local copies of wire checks (2026-09-29 stack audit, toolchain finding "helper
 * duplication"). The shared copies live in packages/contracts/src/wire-values.ts: `UUID_PATTERN`,
 * `isUuid`, `normalizeUuid`, `parseUuid`, `parseRecord`, `parseClosedRecord`, `parseSha256Hex`,
 * `parseBoundedText`, `parseInteger` and `parseTimestamp`. Per package this counts UUID regexes written out by hand and
 * local `record`/`uuid`/`sha256` helper definitions, and fails when any count rises above the
 * committed baseline, so new copies stop appearing while old ones move to the shared module as
 * their files are touched. After removing copies, lower the baseline with `--update`. */

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const BASELINE_PATH = join(root, "scripts", "wire-helpers-baseline.json");
const SOURCE = /\.(?:ts|tsx|mts|cts|mjs|cjs|js)$/;
const SKIPPED_DIRECTORIES = new Set(["node_modules", "dist", "public", "vendor", ".artifacts"]);
const SHARED_MODULE = ["packages", "contracts", "src", "wire-values.ts"].join(sep);

/** `[0-9a-f]{8}-` and its spellings (any order of the ranges, either case): the start of a UUID pattern. */
const UUID_PATTERN_START = /\[(?:0-9a-f|a-f0-9|0-9A-F|A-F0-9|0-9a-fA-F|0-9A-Fa-f|a-fA-F0-9|A-Fa-f0-9|a-f\\d|\\da-f)\]\{8\}-/g;
const HELPER_FUNCTION = /\bfunction\s+(record|uuid|sha256)\s*[<(]/g;
const HELPER_ARROW = /\b(?:const|let)\s+(record|uuid|sha256)\b(?::[^\n]*?)?\s=\s*(?:async\s*)?(?:\(|function\b|<|[A-Za-z_$][\w$]*\s*=>)/g;

export const METRICS = ["uuidPatterns", "recordHelpers", "uuidHelpers", "sha256Helpers"];

/** The counts one source text contributes. */
export function countSource(text) {
	const counts = { uuidPatterns: 0, recordHelpers: 0, uuidHelpers: 0, sha256Helpers: 0 };
	counts.uuidPatterns = (text.match(UUID_PATTERN_START) ?? []).length;
	for (const pattern of [HELPER_FUNCTION, HELPER_ARROW]) {
		for (const match of text.matchAll(pattern)) counts[`${match[1]}Helpers`]++;
	}
	return counts;
}

function* sources(directory) {
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		if (entry.isDirectory()) {
			if (!SKIPPED_DIRECTORIES.has(entry.name) && !entry.name.startsWith(".")) yield* sources(join(directory, entry.name));
		} else if (entry.isFile() && SOURCE.test(entry.name) && !entry.name.includes(".generated.")) {
			yield join(directory, entry.name);
		}
	}
}

/** Counts per package, and per file for the report. */
export function countRepository(repository = root) {
	const packages = {};
	const files = {};
	for (const name of readdirSync(join(repository, "packages")).sort()) {
		let directory;
		try {
			directory = join(repository, "packages", name);
			readdirSync(directory);
		} catch {
			continue;
		}
		const total = Object.fromEntries(METRICS.map((metric) => [metric, 0]));
		for (const file of sources(directory)) {
			const path = relative(repository, file);
			if (path === SHARED_MODULE) continue;
			const counts = countSource(readFileSync(file, "utf8"));
			if (METRICS.some((metric) => counts[metric] > 0)) files[path.split(sep).join("/")] = counts;
			for (const metric of METRICS) total[metric] += counts[metric];
		}
		packages[name] = total;
	}
	return { packages, files };
}

/** Every package and metric whose count is above the baseline (a package missing from it counts from 0). */
export function risen(current, baseline) {
	const rises = [];
	for (const [name, counts] of Object.entries(current)) {
		for (const metric of METRICS) {
			const allowed = baseline[name]?.[metric] ?? 0;
			if (counts[metric] > allowed) rises.push({ package: name, metric, count: counts[metric], allowed });
		}
	}
	return rises;
}

function main(argv) {
	const { packages, files } = countRepository();
	if (argv.includes("--update")) {
		writeFileSync(BASELINE_PATH, `${JSON.stringify(packages, null, "\t")}\n`);
		console.log(`Wrote ${relative(root, BASELINE_PATH)}`);
		return 0;
	}
	const baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
	const rises = risen(packages, baseline);
	if (rises.length === 0) {
		const lower = Object.entries(packages).filter(([name, counts]) =>
			METRICS.some((metric) => counts[metric] < (baseline[name]?.[metric] ?? 0)),
		);
		if (lower.length)
			console.log(
				`Wire helper copies went down in ${lower.map(([name]) => name).join(", ")}: lower the baseline with node scripts/check-wire-helpers.mjs --update`,
			);
		return 0;
	}
	console.error(
		"New local copies of wire checks. Import them from @qorpera/contracts (wire-values.ts) instead; `git diff` against the base branch shows which file added one. Files holding copies now:",
	);
	for (const rise of rises) {
		console.error(`  ${rise.package}: ${rise.metric} ${rise.count}, baseline ${rise.allowed}`);
		const holding = Object.entries(files).filter(
			([path, counts]) => path.startsWith(`packages/${rise.package}/`) && counts[rise.metric] > 0,
		);
		for (const [path, counts] of holding.slice(0, 40)) console.error(`    ${path}: ${counts[rise.metric]}`);
		if (holding.length > 40) console.error(`    ... and ${holding.length - 40} more files`);
	}
	return 1;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
	process.exitCode = main(process.argv.slice(2));
}
