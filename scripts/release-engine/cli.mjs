import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { classifyReleaseDiff } from "../release-prep-plan.mjs";
import { runReleaseDriver, stepsForManifest } from "./driver.mjs";
import { createReleaseManifest, validateReleaseManifest } from "./manifest.mjs";
import { buildAnchorCheckSql } from "./sql-checks.mjs";
import { writeSqlOnlyPackets } from "./sql-only-packets.mjs";

const SUBCOMMAND_FLAGS = {
	init: {
		value: new Set([
			"from",
			"to",
			"prev-version",
			"prev-bundle",
			"prev-node-release",
			"base-commit",
			"release-commit",
			"pr",
			"out",
		]),
		boolean: new Set(["no-thin-runtime"]),
	},
	validate: {
		value: new Set(["manifest"]),
		boolean: new Set(),
	},
	plan: {
		value: new Set(["manifest"]),
		boolean: new Set(),
	},
	"anchor-sql": {
		value: new Set(["manifest"]),
		boolean: new Set(),
	},
	packets: {
		value: new Set(["manifest", "out", "repo"]),
		boolean: new Set(),
	},
	"dry-run": {
		value: new Set(["manifest", "from"]),
		boolean: new Set(),
	},
};

export function parseSubcommandFlags(action, argv) {
	if (typeof action !== "string" || !Object.hasOwn(SUBCOMMAND_FLAGS, action)) {
		throw new Error("Usage: node scripts/release-engine/cli.mjs <init|validate|plan|anchor-sql|packets|dry-run> [flags]");
	}
	const schema = SUBCOMMAND_FLAGS[action];
	const flags = {};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (!arg.startsWith("--") || arg.length <= 2) {
			throw new Error(`Unexpected argument: ${arg}`);
		}
		const key = arg.slice(2);
		if (schema.boolean.has(key)) {
			flags[key] = true;
			continue;
		}
		if (!schema.value.has(key)) {
			throw new Error(`Unknown flag for ${action}: --${key}`);
		}
		const next = argv[i + 1];
		if (next === undefined || next.length === 0 || next.startsWith("--")) {
			throw new Error(`Flag --${key} requires a value`);
		}
		flags[key] = next;
		i += 1;
	}
	return flags;
}

function parseNonNegativeInt(raw, flagName) {
	if (typeof raw !== "string" || !/^\d+$/.test(raw)) {
		throw new Error(`Flag --${flagName} must be a non-negative integer`);
	}
	return Number(raw);
}

function validateGitRef(ref, flagName) {
	if (typeof ref !== "string" || ref.length === 0 || ref.startsWith("-") || /[\s\0]/.test(ref) || ref.includes("..")) {
		throw new Error(`Invalid git ref for --${flagName}: ${ref}`);
	}
	return ref;
}

function resolveCommitSha(ref, flagName, cwd) {
	const safeRef = validateGitRef(ref, flagName);
	return execFileSync("git", ["rev-parse", "--verify", "--end-of-options", `${safeRef}^{commit}`], {
		cwd,
		encoding: "utf8",
	}).trim();
}

function readManifest(path) {
	if (typeof path !== "string" || path.length === 0) {
		throw new Error("Missing required flag: --manifest <file>");
	}
	return validateReleaseManifest(JSON.parse(readFileSync(path, "utf8")));
}

export async function runCli(argv, io = {}) {
	const stdout = io.stdout ?? process.stdout;
	const cwd = io.cwd ?? process.cwd();
	const [action, ...rest] = argv;
	const flags = parseSubcommandFlags(action, rest);
	if (action === "init") {
		if (!flags.from || !flags["prev-version"] || !flags["prev-bundle"] || !flags["prev-node-release"]) {
			throw new Error(
				"Usage: init --from <ref> [--to <ref>] --prev-version <N> --prev-bundle <sha64> --prev-node-release <R> [--base-commit <sha40>] [--release-commit <sha40>] [--pr <N>] [--no-thin-runtime] [--out <file>]",
			);
		}
		const fromSha = resolveCommitSha(flags.from, "from", cwd);
		const toSha = resolveCommitSha(flags.to ?? "HEAD", "to", cwd);
		const files = execFileSync(
			"git",
			["diff", "--name-only", "--no-renames", "-z", "--end-of-options", fromSha, toSha, "--"],
			{
				cwd,
				encoding: "utf8",
				maxBuffer: 32 * 1024 * 1024,
			},
		)
			.split("\0")
			.filter(Boolean);
		const existingFiles = execFileSync(
			"git",
			["diff", "--name-only", "--no-renames", "--diff-filter=d", "-z", "--end-of-options", fromSha, toSha, "--"],
			{
				cwd,
				encoding: "utf8",
				maxBuffer: 32 * 1024 * 1024,
			},
		)
			.split("\0")
			.filter(Boolean);
		const baseCommit = flags["base-commit"] ?? toSha;
		const manifest = createReleaseManifest({
			previousVersion: parseNonNegativeInt(flags["prev-version"], "prev-version"),
			previousBundleSha256: flags["prev-bundle"],
			baseCommit,
			releaseCommit: flags["release-commit"] ?? null,
			releasePrNumber: flags.pr !== undefined ? parseNonNegativeInt(flags.pr, "pr") : null,
			previousNodeReleaseRevision: parseNonNegativeInt(flags["prev-node-release"], "prev-node-release"),
			classification: classifyReleaseDiff(files, { existingFiles }),
			thinRuntimeEnabled: !flags["no-thin-runtime"],
		});
		const text = `${JSON.stringify(manifest, null, 2)}\n`;
		if (flags.out) writeFileSync(flags.out, text, "utf8");
		else stdout.write(text);
		return 0;
	}
	if (action === "validate") {
		const manifest = readManifest(flags.manifest);
		stdout.write(`valid v${manifest.version} mode=${manifest.mode} armed=${manifest.armed}\n`);
		return 0;
	}
	if (action === "plan") {
		const manifest = readManifest(flags.manifest);
		const steps = stepsForManifest(manifest);
		stdout.write(`${JSON.stringify({ version: manifest.version, mode: manifest.mode, steps }, null, 2)}\n`);
		return 0;
	}
	if (action === "anchor-sql") {
		const manifest = readManifest(flags.manifest);
		const anchors = manifest.migrations.flatMap((migration) => migration.anchors);
		stdout.write(`${buildAnchorCheckSql(anchors)}\n`);
		return 0;
	}
	if (action === "packets") {
		const manifest = readManifest(flags.manifest);
		if (!flags.out) {
			throw new Error("Usage: packets --manifest <file> --out <new-dir> [--repo <dir>]");
		}
		if (manifest.mode !== "sql-only") {
			throw new Error("packets subcommand writes sql-only packets; use scripts/runtime-roll.mjs packets for runtime cuts");
		}
		const repoDir = flags.repo ? resolve(cwd, flags.repo) : cwd;
		const migrationsByFile = new Map();
		for (const migration of manifest.migrations) {
			const sql = execFileSync("git", ["-C", repoDir, "show", "--end-of-options", `${manifest.baseCommit}:${migration.file}`], {
				encoding: "utf8",
				maxBuffer: 64 * 1024 * 1024,
			});
			migrationsByFile.set(migration.file, sql);
		}
		const outDir = resolve(cwd, flags.out);
		const packetManifest = writeSqlOnlyPackets(outDir, manifest, migrationsByFile);
		stdout.write(`${JSON.stringify({ out: outDir, order: packetManifest.order, dryRunOnly: packetManifest.dryRunOnly }, null, 2)}\n`);
		return 0;
	}
	if (action === "dry-run") {
		const manifest = readManifest(flags.manifest);
		const result = await runReleaseDriver(
			manifest,
			{ dryRun: true, from: flags.from ?? null },
			{ runPhase: async () => ({ exitCode: 0 }) },
		);
		stdout.write(`${JSON.stringify(result, null, 2)}\n`);
		return result.ok ? 0 : result.exitCode;
	}
	throw new Error("Usage: node scripts/release-engine/cli.mjs <init|validate|plan|anchor-sql|packets|dry-run> [flags]");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	runCli(process.argv.slice(2))
		.then((exitCode) => {
			if (exitCode !== 0) process.exitCode = exitCode;
		})
		.catch((error) => {
			process.stderr.write(`release-engine: ${error.message}\n`);
			process.exit(2);
		});
}
