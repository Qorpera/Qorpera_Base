import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { RELEASE_OWNED_FILES } from "./check-release-train-derived-files.mjs";

const ACTIVATION_MIGRATION = /^supabase\/migrations\/\d{14}_runtime_bundle_activation(?:_v\d+)?\.sql$/;
const ANY_MIGRATION = /^supabase\/migrations\/(\d{14})_([a-z0-9_]+)\.sql$/;
const SQL_TEST = /^supabase\/tests\/(\d+)_[a-z0-9_]+\.test\.sql$/;
const QUIET_PATH = /(?:^|\/)(?:CHANGELOG\.md|[^/]+\.md)$|^docs-audit\/|^LICENSE$|^\.github\//;

const RELEASE_DERIVED_EXACT = new Set([
	...RELEASE_OWNED_FILES,
	"scripts/generate-cloud-runtime-bundle.mjs",
	"scripts/test-runtime-bundle-activation.mjs",
]);

const BASE_IMAGE_PATTERNS = [
	/^deploy\/lxd-runner-guest\//,
	/^deploy\/claude-box\//,
	/^deploy\/first-node\/native-codex\/(?:source\.json|0001-cloud-result-fence\.patch|linux-x64-artifact\.json)$/,
	/^deploy\/first-node\/native-claude\//,
	/^deploy\/ephemeral-runner\//,
	/^package-lock\.json$/,
];

const CLAUDE_BOX_PATTERNS = [
	/^deploy\/claude-box\//,
	/^deploy\/first-node\/native-claude\//,
	/^deploy\/lxd-runner-guest\//,
	/^packages\/runtime\/src\/cloud-claude-/,
];

const CODEX_HOME_PATTERNS = [
	/^packages\/runtime\/src\/cloud-(?:codex-home|home-channel)/,
	/^deploy\/coding-worker\/home-session-authority\.ts$/,
	/^deploy\/first-node\/native-codex\/(?:source\.json|0001-cloud-result-fence\.patch|linux-x64-artifact\.json)$/,
];

const RUNTIME_JS_PATTERNS = [
	/^packages\/runtime\/src\//,
	/^packages\/cloud-client\/src\//,
	/^packages\/contracts\/src\//,
	/^packages\/company\/src\//,
];

const WEB_DEPLOY_PATH = /^packages\/(?:web|member-web)\//;

const TEST_ONLY_PATTERN = (file) =>
	/^packages\/[^/]+\/test\//.test(file) ||
	/^scripts\/(?:prove-|.*\.test\.mjs$)/.test(file) ||
	SQL_TEST.test(file);

export function isReleaseDerivedPath(file) {
	return RELEASE_DERIVED_EXACT.has(file) || ACTIVATION_MIGRATION.test(file) || QUIET_PATH.test(file);
}

export function isReleaseDerivedOnly(files) {
	const unique = [...new Set(files)].filter(Boolean);
	return unique.length > 0 && unique.every((file) => isReleaseDerivedPath(file));
}

export function classifyReleaseDiff(files, options = {}) {
	const unique = [...new Set(files)].filter(Boolean).sort();
	const existingSet = options.existingFiles ? new Set(options.existingFiles) : null;
	const migrations = [];
	const activationMigrations = [];
	const sqlTests = [];
	let runtimeJsChanged = false;
	let baseImageChanged = false;
	let claudeBoxChanged = false;
	let codexHomeChanged = false;
	let sharedExecutionChanged = false;
	let vaultChanged = false;
	let executorChanged = false;
	let orchestratorChanged = false;
	let folderServiceChanged = false;
	let gatewayChanged = false;
	let nonSqlOperationalChanged = false;

	for (const file of unique) {
		if (ACTIVATION_MIGRATION.test(file)) {
			activationMigrations.push(file);
			continue;
		}
		if (ANY_MIGRATION.test(file)) {
			migrations.push(file);
			continue;
		}
		const sqlTestMatch = SQL_TEST.exec(file);
		if (sqlTestMatch) {
			if (!existingSet || existingSet.has(file)) {
				sqlTests.push(sqlTestMatch[1]);
			}
			continue;
		}
		if (QUIET_PATH.test(file) || WEB_DEPLOY_PATH.test(file)) {
			continue;
		}
		if (RELEASE_OWNED_FILES.includes(file)) {
			continue;
		}
		if (BASE_IMAGE_PATTERNS.some((pattern) => pattern.test(file))) {
			baseImageChanged = true;
		}
		if (CLAUDE_BOX_PATTERNS.some((pattern) => pattern.test(file))) {
			claudeBoxChanged = true;
		}
		if (CODEX_HOME_PATTERNS.some((pattern) => pattern.test(file))) {
			codexHomeChanged = true;
		}
		if (
			file !== "packages/runtime/src/cloud-runtime-bundle.generated.ts" &&
			RUNTIME_JS_PATTERNS.some((pattern) => pattern.test(file))
		) {
			runtimeJsChanged = true;
		}
		if (/^deploy\/shared-execution\//.test(file) || /^packages\/runner-orchestrator\/src\/shared-execution/.test(file)) {
			sharedExecutionChanged = true;
		}
		if (/^packages\/runtime\/src\/(?:cloud-secret-broker|cloud-model-login-vault|shared-vault)/.test(file)) {
			vaultChanged = true;
		}
		if (
			/^deploy\/coding-worker\//.test(file) ||
			/^packages\/runner-orchestrator\/src\/(?:coding-|code-|surface-)/.test(file)
		) {
			executorChanged = true;
		}
		if (/^packages\/runner-orchestrator\/src\//.test(file)) {
			orchestratorChanged = true;
		}
		if (
			/^crates\/qorpera-folder\//.test(file) ||
			/^deploy\/folder-service\//.test(file) ||
			/^packages\/object-gateway\/src\/folder-service\//.test(file)
		) {
			folderServiceChanged = true;
		}
		if (/^packages\/object-gateway\/src\//.test(file)) {
			gatewayChanged = true;
		}
		if (!TEST_ONLY_PATTERN(file) && !RELEASE_DERIVED_EXACT.has(file)) {
			nonSqlOperationalChanged = true;
		}
	}

	const anyRuntimeOperational =
		nonSqlOperationalChanged ||
		runtimeJsChanged ||
		baseImageChanged ||
		claudeBoxChanged ||
		codexHomeChanged ||
		sharedExecutionChanged ||
		vaultChanged ||
		executorChanged ||
		orchestratorChanged ||
		folderServiceChanged ||
		gatewayChanged;

	const sqlOnly = migrations.length > 0 && !anyRuntimeOperational;
	const noRelease = migrations.length === 0 && !anyRuntimeOperational;

	return {
		files: unique,
		migrations,
		activationMigrations,
		sqlTests: [...new Set(sqlTests)].sort(),
		sqlOnly,
		noRelease,
		runtimeJsChanged,
		baseImageChanged,
		claudeBoxChanged,
		codexHomeChanged,
		sharedExecutionChanged,
		vaultChanged,
		executorChanged,
		orchestratorChanged,
		folderServiceChanged,
		gatewayChanged,
	};
}

export function buildReleasePrepPlan(classification, options = {}) {
	const thinRuntimeEnabled = Boolean(options.thinRuntimeEnabled);
	const mode = classification.noRelease
		? "no-release"
		: classification.sqlOnly
			? "sql-only"
			: thinRuntimeEnabled && !classification.baseImageChanged
				? "thin-runtime"
				: "full-image";
	const needsRuntimeRelease = mode === "thin-runtime" || mode === "full-image";
	const needsBundleBump = needsRuntimeRelease;
	const needsBaseImageRebuild = mode === "full-image";
	const needsNodeRelease = needsRuntimeRelease;
	const runC4c = classification.claudeBoxChanged || classification.baseImageChanged;
	const provers = needsRuntimeRelease ? ["scripts/prove-home-channel.mjs", "scripts/prove-hire-team.mjs"] : [];
	const watchPolicy = {
		homeWatchMinutes: classification.codexHomeChanged ? 15 : 0,
		claudeWatchMinutes: classification.claudeBoxChanged ? 15 : 0,
		smokeMinutes: needsRuntimeRelease ? 2 : 0,
		pollSeconds: 30,
		earlyExitOnCompletedRuns: 1,
	};
	return {
		schema: "qorpera.release-prep-plan/v1",
		mode,
		needsBundleBump,
		needsNodeRelease,
		needsBaseImageRebuild,
		imageCompression: "zstd",
		runC4c,
		skipRedundantHomePath: true,
		provers,
		sqlTests: classification.sqlTests,
		migrations: classification.migrations,
		watchPolicy,
		changedComponents: {
			runtimeJs: classification.runtimeJsChanged,
			baseImage: classification.baseImageChanged,
			claudeBox: classification.claudeBoxChanged,
			codexHome: classification.codexHomeChanged,
			sharedExecution: classification.sharedExecutionChanged,
			vault: classification.vaultChanged,
			executor: classification.executorChanged,
			orchestrator: classification.orchestratorChanged,
			folderService: classification.folderServiceChanged,
			gateway: classification.gatewayChanged,
		},
	};
}

function readFlagValue(argv, index, flagName) {
	const value = argv[index + 1];
	if (typeof value !== "string" || value.length === 0 || value.startsWith("-")) {
		throw new Error(`Flag ${flagName} requires a non-flag value`);
	}
	return value;
}

export function parseCliArgs(argv) {
	const parsed = { from: null, to: "HEAD", thinRuntimeEnabled: false, json: false };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--from") {
			parsed.from = readFlagValue(argv, i, "--from");
			i += 1;
		} else if (arg === "--to") {
			parsed.to = readFlagValue(argv, i, "--to");
			i += 1;
		} else if (arg === "--thin-runtime") {
			parsed.thinRuntimeEnabled = true;
		} else if (arg === "--json") {
			parsed.json = true;
		} else {
			throw new Error("Usage: node scripts/release-prep-plan.mjs --from <ref> [--to <ref>] [--thin-runtime] [--json]");
		}
	}
	if (!parsed.from) {
		throw new Error("Missing --from <ref>");
	}
	return parsed;
}

function resolveCommit(ref, flagName) {
	if (/[\s\0]/.test(ref) || ref.includes("..")) {
		throw new Error(`Invalid git ref for ${flagName}: ${ref}`);
	}
	return execFileSync("git", ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`], {
		encoding: "utf8",
	}).trim();
}

function gitDiffNullSeparated(args) {
	return execFileSync("git", args, {
		encoding: "utf8",
		maxBuffer: 32 * 1024 * 1024,
	})
		.split("\0")
		.filter(Boolean);
}

function main(argv) {
	const args = parseCliArgs(argv);
	const fromCommit = resolveCommit(args.from, "--from");
	const toCommit = resolveCommit(args.to, "--to");
	const files = gitDiffNullSeparated(["diff", "--name-only", "--no-renames", "-z", "--end-of-options", fromCommit, toCommit, "--"]);
	const existingFiles = gitDiffNullSeparated([
		"diff",
		"--name-only",
		"--no-renames",
		"--diff-filter=d",
		"-z",
		"--end-of-options",
		fromCommit,
		toCommit,
		"--",
	]);
	const classification = classifyReleaseDiff(files, { existingFiles });
	const plan = buildReleasePrepPlan(classification, { thinRuntimeEnabled: args.thinRuntimeEnabled });
	if (args.json) {
		process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
		return;
	}
	const lines = [
		`mode=${plan.mode}`,
		`bundle_bump=${plan.needsBundleBump}`,
		`node_release=${plan.needsNodeRelease}`,
		`base_image_rebuild=${plan.needsBaseImageRebuild} (compression=${plan.imageCompression})`,
		`c4c=${plan.runC4c}`,
		`provers=${plan.provers.length ? plan.provers.join(",") : "none"}`,
		`migrations=${plan.migrations.length ? plan.migrations.join(",") : "none"}`,
		`watches=home:${plan.watchPolicy.homeWatchMinutes}m claude:${plan.watchPolicy.claudeWatchMinutes}m smoke:${plan.watchPolicy.smokeMinutes}m`,
	];
	process.stdout.write(`${lines.join("\n")}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main(process.argv.slice(2));
}
