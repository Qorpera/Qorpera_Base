/** What `node scripts/run-on-node.mjs changed` runs for a set of changed paths. It replaces the path
 * filters of the old GitHub workflows (root-typecheck, runtime-release-train, web-client, step2-lxd,
 * hosted-db), which no longer run, and runs at least what they ran for the same change:
 *
 * - every change that is not documentation: lint, both typechecks and the repository checks (root-typecheck
 *   ran on every PR);
 * - every change that is not web-only (runtime-release-train's exclusion list): all runtime and
 *   cloud-client tests, all script tests (packaging, pins, vocabulary) and the runtime bundle check;
 * - path-specific steps on top (web, member-web, object-gateway, runner-orchestrator, functions, deploy,
 *   hosted-db);
 * - shared configuration, `packages/contracts`, `packages/company` and any path no rule knows: every step.
 *
 * Release candidates still run the full `test` suite before a cut. */

const HOSTED_DB_SCRIPTS = [
	"scripts/test-runtime-bundle-activation.mjs",
	"scripts/test-email-draft-e2e.mjs",
	"scripts/test-runtime-node-capacity.mjs",
	"scripts/test-runtime-office-delete-disposition.mjs",
	"scripts/test-runtime-office-current-provider-activation.mjs",
	"scripts/test-coding-turn-backfill.mjs",
	"scripts/test-runtime-room-history.mjs",
];
/** The function tests the old workflows ran (web-client and step2-lxd); the others never ran in CI. */
const FUNCTION_TESTS = [
	"supabase/functions/native-provider-login/native-provider-login.test.ts",
	"supabase/functions/member-company-gateway/member-company-gateway.test.ts",
	"supabase/functions/computer-billing/computer-billing.test.ts",
	"supabase/functions/_shared/computer-hour-notices.test.ts",
	"supabase/functions/company-file-verifier/object-loader.test.ts",
	"supabase/functions/company-file-verifier/company-file-verifier.test.ts",
	"supabase/functions/runner-orchestrator/runner-orchestrator.test.ts",
];
const WEB_RELEASE_CONFIG = JSON.stringify({
	projectUrl: "https://project.example.invalid",
	publishableKey: "sb_publishable_fixture123",
	objectGatewayUrl: "https://objects.example.invalid",
	officeViewerOrigin: "wss://viewer.example.invalid:8443",
	nativeProviderLoginUrl: "https://project.example.invalid/functions/v1/native-provider-login/",
});
const vitest = (workspace, args = "") => `(cd packages/${workspace} && node ../../node_modules/vitest/dist/cli.js --run${args})`;
const regex = (path) => new RegExp(`^${path.replaceAll(".", "\\.")}$`);

/** Paths that never need a test: prose, and the switched-off workflows. */
const QUIET = [/\.md$/, /^docs-audit\//, /^LICENSE$/, /^\.github\//];
/** Paths every package reads: every step. */
const WHOLE = [
	/^package(-lock)?\.json$/,
	/^packages\/[^/]+\/package\.json$/,
	/^vitest\.base\.ts$/,
	/^tsconfig[^/]*\.json$/,
	/^biome\.json$/,
	/^test\.sh$/,
	/^packages\/(contracts|company)\//,
];
/** runtime-release-train.yml's exclusion: web client files that no runtime or cloud-client test reads. */
const WEB_ONLY = (file) =>
	(/^packages\/web\//.test(file) &&
		!/^packages\/web\/(src\/cloud\/|tsconfig\.json$|public\/assets\/avatars\/)/.test(file)) ||
	(/^packages\/member-web\//.test(file) && !/^packages\/member-web\/ui\//.test(file));
const ANY = [/./];
/** Starts on any path that is not web-only. */
const NOT_WEB_ONLY = Symbol("not web-only");

/** Ordered steps. `build`: needs npm run build:web-sdk first (script tests and the web import it). */
export const STEPS = [
	{
		name: "lint",
		why: "biome over the repository (npm run check)",
		paths: ANY,
		commands: ["npx biome check --error-on-warnings ."],
	},
	{
		name: "typecheck",
		why: "root and member-web tsgo (root-typecheck.yml ran on every PR)",
		paths: ANY,
		commands: ["npx tsgo --noEmit", "npx tsgo -p packages/member-web/tsconfig.json"],
	},
	{
		name: "checks",
		why: "pinned dependencies, imports, cloud boundaries, connector catalog, runtime bundle",
		paths: ANY,
		commands: [
			"npm run check:pinned-deps",
			"npm run check:ts-imports",
			"npm run check:cloud-boundaries",
			"npm run check:connector-catalog",
			"npm run check:runtime-bundle:release-train",
		],
	},
	{
		name: "web",
		why: "the web client and what it consumes (web-client.yml)",
		paths: [
			/^packages\/web\//,
			/^packages\/member-web\/ui\//,
			/^packages\/cloud-client\//,
			/^supabase\/functions\//,
			/^scripts\/web-deployment/,
		],
		build: true,
		commands: [
			"npm run typecheck --workspace packages/web",
			"npm test --workspace packages/web",
			`node --test ${FUNCTION_TESTS.slice(0, 4).join(" ")} scripts/web-deployment.test.mjs`,
			`QORPERA_WEB_CONFIG_JSON='${WEB_RELEASE_CONFIG}' npm run build:release --workspace packages/web`,
		],
	},
	{
		name: "member-web",
		why: "packages/member-web",
		paths: [/^packages\/member-web\//],
		commands: ["npm test --workspace packages/member-web"],
	},
	{
		name: "company",
		why: "packages/company",
		paths: [/^packages\/company\//],
		commands: ["npm test --workspace packages/company"],
	},
	{
		name: "cloud-client",
		why: "every change that is not web-only (runtime-release-train.yml)",
		paths: NOT_WEB_ONLY,
		commands: [vitest("cloud-client")],
	},
	{
		name: "runtime",
		why: "every change that is not web-only (runtime-release-train.yml): all tests, then the coding command supervisor",
		paths: NOT_WEB_ONLY,
		commands: [
			vitest("runtime", " --exclude test/cloud-coding-command-guest.test.ts"),
			vitest("runtime", " test/cloud-coding-command-guest.test.ts"),
		],
	},
	{
		name: "scripts",
		why: "every change that is not web-only: all script tests, packaging and pins included (runtime-release-train.yml, step2-lxd.yml)",
		paths: NOT_WEB_ONLY,
		build: true,
		commands: ["node --test scripts/*.test.mjs"],
	},
	{
		name: "object-gateway",
		why: "packages/object-gateway",
		paths: [/^packages\/object-gateway\//],
		commands: [vitest("object-gateway")],
	},
	{
		name: "runner-orchestrator",
		why: "packages/runner-orchestrator and the deploy files its tests import (step2-lxd.yml)",
		paths: [
			/^packages\/runner-orchestrator\//,
			/^deploy\/(first-node|lxd-runner-guest|lxd-company-computer-guest|shared-execution)\//,
		],
		commands: [vitest("runner-orchestrator")],
	},
	{
		name: "functions",
		why: "Supabase functions (web-client.yml, step2-lxd.yml)",
		paths: [/^supabase\/functions\//],
		commands: [`node --test ${FUNCTION_TESTS.join(" ")}`],
	},
	{
		name: "deploy-node",
		why: "node agent, parity and tidy-up (step2-lxd.yml)",
		paths: [/^deploy\//, /^packages\/runner-orchestrator\/src\//],
		commands: [
			"node --test deploy/node-tidy/qorpera-node-tidy.test.mjs deploy/node-parity/qorpera-node-parity.test.mjs deploy/node-agent/qorpera-node-agent.test.mjs",
			"python3 -m unittest discover -s deploy/node-agent -p 'test_*.py'",
		],
	},
	{
		name: "deploy-shell",
		why: "every deployment shell script parses (step2-lxd.yml)",
		paths: [/^deploy\/.*\.sh$/],
		// xargs fails when any bash -n fails; a for loop would report only the last script.
		commands: ["find deploy -name '*.sh' -print0 | xargs -0 -n1 bash -n"],
	},
	{
		name: "hosted-db",
		why: "migrations, SQL tests and the PostgreSQL scripts with their inputs (hosted-db.yml)",
		paths: [
			/^supabase\/(?!functions\/)/,
			/^scripts\/test-hosted-db/,
			/^scripts\/test-runtime-[a-z-]+-cases\.mjs$/,
			/^scripts\/fixtures\/(coding-turn-pre-continuity|email-draft-e2e)/,
			/^packages\/runtime\/src\/cloud-(secret|connector)-/,
			/^packages\/runtime\/test\/fixtures\/coding-turn-/,
			/^packages\/runner-orchestrator\/src\/lxd-office-[a-z-]+-control\.ts$/,
			/^packages\/web\/src\/cloud\/email-drafts\.ts$/,
			...HOSTED_DB_SCRIPTS.map(regex),
		],
		commands: [
			"node --test scripts/test-hosted-db.test.mjs",
			"npm run test:hosted-db",
			...HOSTED_DB_SCRIPTS.map((script) => `node ${script}`),
		],
	},
];

/** A step starts for a file when one of its patterns matches, or, for NOT_WEB_ONLY steps, when the file is
 * not web-only. The ANY steps start for every file that is not documentation. */
function starts(step, file) {
	if (step.paths === NOT_WEB_ONLY) return !WEB_ONLY(file);
	return step.paths.some((pattern) => pattern.test(file));
}

/** `files`: repository-relative paths changed against the base (both sides of a move, deletions and
 * untracked files included). */
export function planChanged(files) {
	const steps = new Map();
	const whole = [];
	const unmapped = [];
	for (const file of [...new Set(files)].sort()) {
		if (QUIET.some((pattern) => pattern.test(file))) continue;
		if (WHOLE.some((pattern) => pattern.test(file))) {
			whole.push(file);
			continue;
		}
		const matching = STEPS.filter((step) => starts(step, file));
		// Known: a path-specific step claims it, or it lies in an area the baseline covers (a runtime test).
		if (!matching.some((step) => step.paths !== ANY && step.paths !== NOT_WEB_ONLY) && !knownRoot(file))
			unmapped.push(file);
		for (const step of matching) steps.set(step.name, [...(steps.get(step.name) ?? []), file]);
	}
	if (whole.length || unmapped.length)
		return {
			full: true,
			reason: whole.length
				? `shared configuration or packages every package reads: ${sample(whole)}`
				: `no rule knows: ${sample(unmapped)}`,
			steps: STEPS.map((step) => ({ name: step.name, why: step.why, files: [], commands: step.commands })),
			build: true,
		};
	const chosen = STEPS.filter((step) => steps.has(step.name)).map((step) => ({
		name: step.name,
		why: step.why,
		files: steps.get(step.name),
		commands: step.commands,
	}));
	return { full: false, reason: null, steps: chosen, build: STEPS.some((step) => step.build && steps.has(step.name)) };
}

/** Top-level areas the rules cover (their files may start only the baseline, like a runtime test). */
function knownRoot(file) {
	return /^(packages\/(runtime|cloud-client|object-gateway|runner-orchestrator)\/|scripts\/|deploy\/|supabase\/)/.test(file);
}

function sample(files) {
	return files.length > 3 ? `${files.slice(0, 3).join(", ")} and ${files.length - 3} more` : files.join(", ");
}

/** Every step runs, even after another failed; the exit code is 1 if any failed. */
export function planScript(steps) {
	return [
		"set -u",
		"failed=''",
		...steps.flatMap((step) => [
			`echo "== changed: ${step.name}"`,
			"started=$(date +%s)",
			// && and not set -e: errexit is ignored inside an if condition, so a failed first command would pass.
			`if ( ${step.commands.join(" && ")} ); then echo "== changed: ${step.name} passed in $(( $(date +%s) - started )) s"; else echo "== changed: ${step.name} FAILED after $(( $(date +%s) - started )) s"; failed="$failed ${step.name}"; fi`,
		]),
		'if [ -n "$failed" ]; then echo "== changed: failed:$failed"; exit 1; fi',
		'echo "== changed: all steps passed"',
	].join("\n");
}

export function describePlan(plan, base) {
	if (plan.full) return [`== changed (against ${base}): every step, because ${plan.reason}`];
	if (!plan.steps.length) return [`== changed (against ${base}): nothing to run (documentation only)`];
	return [
		`== changed (against ${base}): ${plan.steps.map((step) => step.name).join(", ")}`,
		...plan.steps.map((step) => `   ${step.name}: ${step.why}; ${sample(step.files)}`),
	];
}
