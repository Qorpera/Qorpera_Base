/** What `node scripts/run-on-node.mjs changed` runs for a set of changed paths. It replaces the path
 * filters of the old GitHub workflows (hosted-db, web-client, root-typecheck, runtime-release-train,
 * step2-lxd), which no longer run. Each step names the paths that start it. A path no step claims and
 * that is not documentation runs the whole `npm test`, so an unmapped change is never left untested.
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
const PACKAGING_TESTS = [
	"scripts/generate-cloud-runtime-bundle.test.mjs",
	"scripts/package-ephemeral-runner.test.mjs",
	"scripts/package-cloud-secret-broker.test.mjs",
	"scripts/package-model-login-helper.test.mjs",
	"scripts/check-release-train-derived-files.test.mjs",
	"scripts/check-runtime-observation-vocabulary.test.mjs",
];
const DEPLOYMENT_TESTS = [
	"scripts/web-deployment.test.mjs",
	"supabase/functions/native-provider-login/native-provider-login.test.ts",
	"supabase/functions/member-company-gateway/member-company-gateway.test.ts",
	"supabase/functions/computer-billing/computer-billing.test.ts",
	"supabase/functions/_shared/computer-hour-notices.test.ts",
];
const vitest = (workspace, args = "") => `(cd packages/${workspace} && node ../../node_modules/vitest/dist/cli.js --run${args})`;

/** Paths that never need a test: prose, and the switched-off workflows. */
const QUIET = [/\.md$/, /^docs-audit\//, /^LICENSE$/, /^\.github\//];
/** Paths every package reads: the whole `npm test`. */
const WHOLE = [
	/^package(-lock)?\.json$/,
	/^packages\/[^/]+\/package\.json$/,
	/^vitest\.base\.ts$/,
	/^tsconfig[^/]*\.json$/,
	/^biome\.json$/,
	/^test\.sh$/,
	/^packages\/(contracts|company)\//,
];

/** Ordered steps. `build`: needs npm run build:web-sdk first (the script tests and the web import it). */
export const STEPS = [
	{
		name: "typecheck",
		why: "TypeScript outside packages/web (root tsgo, as root-typecheck.yml)",
		paths: [/^packages\/(?!web\/)[^/]+\/.*\.m?tsx?$/, /^scripts\/.*\.m?ts$/],
		commands: ["npx tsgo --noEmit"],
	},
	{
		name: "web",
		why: "the web client and what it consumes (web-client.yml)",
		paths: [/^packages\/web\//, /^packages\/member-web\/ui\//, /^packages\/cloud-client\//, /^supabase\/functions\//, /^scripts\/web-deployment/],
		build: true,
		commands: [
			"npm run typecheck --workspace packages/web",
			"npm test --workspace packages/web",
			`node --test ${DEPLOYMENT_TESTS.join(" ")}`,
			"npx biome check packages/web/src packages/web/test",
		],
	},
	{
		name: "member-web",
		why: "packages/member-web",
		paths: [/^packages\/member-web\//],
		commands: ["npm test --workspace packages/member-web"],
	},
	{
		name: "cloud-client",
		why: "packages/cloud-client",
		paths: [/^packages\/cloud-client\//],
		commands: [vitest("cloud-client")],
	},
	{
		name: "object-gateway",
		why: "packages/object-gateway",
		paths: [/^packages\/object-gateway\//],
		commands: [vitest("object-gateway")],
	},
	{
		name: "runner-orchestrator",
		why: "packages/runner-orchestrator",
		paths: [/^packages\/runner-orchestrator\//],
		commands: [vitest("runner-orchestrator")],
	},
	{
		name: "runtime",
		why: "packages/runtime (all tests, then the coding command supervisor)",
		paths: [/^packages\/runtime\//],
		commands: [
			vitest("runtime", " --exclude test/cloud-coding-command-guest.test.ts"),
			vitest("runtime", " test/cloud-coding-command-guest.test.ts"),
		],
	},
	{
		name: "packaging",
		why: "packaged runtime, guests and deploy files (runtime-release-train.yml)",
		paths: [
			/^packages\/(runtime|runner-orchestrator)\/src\//,
			/^deploy\//,
			/^scripts\/(package-|generate-cloud-runtime-bundle|runtime-bundle-release-train|check-release-train-derived-files|check-runtime-observation-vocabulary)/,
			/^scripts\/fixtures\/committed-runtime-bundle\//,
		],
		commands: ["npm run check:runtime-bundle:release-train", `node --test ${PACKAGING_TESTS.join(" ")}`],
	},
	{
		name: "deploy-shell",
		why: "deployment shell scripts parse (step2-lxd.yml)",
		paths: [/^deploy\/.*\.sh$/],
		commands: ['for script in $(find deploy -name "*.sh"); do bash -n "$script"; done'],
	},
	{
		name: "hosted-db",
		why: "migrations, SQL tests and their PostgreSQL scripts (hosted-db.yml)",
		paths: [
			/^supabase\/(?!functions\/)/,
			/^scripts\/test-hosted-db/,
			/^scripts\/fixtures\/(coding-turn-pre-continuity|email-draft-e2e)/,
			/^packages\/runtime\/src\/cloud-(secret|connector)-/,
			/^packages\/web\/src\/cloud\/email-drafts\.ts$/,
			...HOSTED_DB_SCRIPTS.map((script) => new RegExp(`^${script.replaceAll(".", "\\.")}$`)),
		],
		commands: [
			"node --test scripts/test-hosted-db.test.mjs",
			"npm run test:hosted-db",
			...HOSTED_DB_SCRIPTS.map((script) => `node ${script}`),
		],
	},
	{
		name: "scripts",
		why: "repository scripts and the deploy files their tests read",
		paths: [/^scripts\//, /^deploy\//],
		build: true,
		commands: ["node --test scripts/*.test.mjs"],
	},
];

/** `files`: repository-relative paths changed against the base (added, modified, deleted, untracked). */
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
		const matching = STEPS.filter((step) => step.paths.some((pattern) => pattern.test(file)));
		if (!matching.length) unmapped.push(file);
		for (const step of matching) steps.set(step.name, [...(steps.get(step.name) ?? []), file]);
	}
	if (whole.length || unmapped.length)
		return {
			full: true,
			reason: whole.length
				? `shared configuration or packages every package reads: ${sample(whole)}`
				: `no step covers: ${sample(unmapped)}`,
			steps: [],
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
	if (plan.full) return [`== changed (against ${base}): the whole npm test, because ${plan.reason}`];
	if (!plan.steps.length) return [`== changed (against ${base}): nothing to run (documentation only)`];
	return [
		`== changed (against ${base}): ${plan.steps.map((step) => step.name).join(", ")}`,
		...plan.steps.map((step) => `   ${step.name}: ${step.why}; ${sample(step.files)}`),
	];
}
