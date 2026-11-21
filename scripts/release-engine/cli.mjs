import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { classifyReleaseDiff } from "../release-prep-plan.mjs";
import { runReleaseDriver, stepsForManifest } from "./driver.mjs";
import { createReleaseManifest, validateReleaseManifest } from "./manifest.mjs";
import { buildAnchorCheckSql } from "./sql-checks.mjs";

function parseFlags(argv) {
	const flags = {};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (!arg.startsWith("--")) throw new Error(`Unexpected argument: ${arg}`);
		const key = arg.slice(2);
		const next = argv[i + 1];
		if (next !== undefined && !next.startsWith("--")) {
			flags[key] = next;
			i += 1;
		} else {
			flags[key] = true;
		}
	}
	return flags;
}

function readManifest(path) {
	return validateReleaseManifest(JSON.parse(readFileSync(path, "utf8")));
}

async function main(argv) {
	const [action, ...rest] = argv;
	const flags = parseFlags(rest);
	if (action === "init") {
		if (!flags.from || !flags["prev-version"] || !flags["prev-bundle"] || !flags["prev-node-release"]) {
			throw new Error(
				"Usage: init --from <ref> [--to <ref>] --prev-version <N> --prev-bundle <sha64> --prev-node-release <R> [--base-commit <sha40>] [--release-commit <sha40>] [--pr <N>] [--no-thin-runtime] [--out <file>]",
			);
		}
		const toRef = flags.to ?? "HEAD";
		const files = execFileSync("git", ["diff", "--name-only", "--no-renames", `${flags.from}..${toRef}`], {
			encoding: "utf8",
			maxBuffer: 32 * 1024 * 1024,
		})
			.split("\n")
			.filter(Boolean);
		const baseCommit =
			flags["base-commit"] ?? execFileSync("git", ["rev-parse", toRef], { encoding: "utf8" }).trim();
		const manifest = createReleaseManifest({
			previousVersion: Number(flags["prev-version"]),
			previousBundleSha256: String(flags["prev-bundle"]),
			baseCommit,
			releaseCommit: flags["release-commit"] ? String(flags["release-commit"]) : null,
			releasePrNumber: flags.pr ? Number(flags.pr) : null,
			previousNodeReleaseRevision: Number(flags["prev-node-release"]),
			classification: classifyReleaseDiff(files),
			thinRuntimeEnabled: !flags["no-thin-runtime"],
		});
		const text = `${JSON.stringify(manifest, null, 2)}\n`;
		if (flags.out) writeFileSync(flags.out, text, "utf8");
		else process.stdout.write(text);
		return;
	}
	if (action === "validate") {
		const manifest = readManifest(flags.manifest);
		process.stdout.write(`valid v${manifest.version} mode=${manifest.mode} armed=${manifest.armed}\n`);
		return;
	}
	if (action === "plan") {
		const manifest = readManifest(flags.manifest);
		const steps = stepsForManifest(manifest);
		process.stdout.write(`${JSON.stringify({ version: manifest.version, mode: manifest.mode, steps }, null, 2)}\n`);
		return;
	}
	if (action === "anchor-sql") {
		const manifest = readManifest(flags.manifest);
		const anchors = manifest.migrations.flatMap((migration) => migration.anchors);
		process.stdout.write(`${buildAnchorCheckSql(anchors)}\n`);
		return;
	}
	if (action === "dry-run") {
		const manifest = readManifest(flags.manifest);
		const result = await runReleaseDriver(
			manifest,
			{ dryRun: true, from: typeof flags.from === "string" ? flags.from : null },
			{ runPhase: async () => ({ exitCode: 0 }) },
		);
		process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
		if (!result.ok) process.exitCode = result.exitCode;
		return;
	}
	throw new Error("Usage: node scripts/release-engine/cli.mjs <init|validate|plan|anchor-sql|dry-run> [flags]");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main(process.argv.slice(2)).catch((error) => {
		process.stderr.write(`release-engine: ${error.message}\n`);
		process.exit(2);
	});
}
