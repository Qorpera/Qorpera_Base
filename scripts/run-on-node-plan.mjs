/** What `node scripts/run-on-node.mjs changed` runs for a set of changed paths. It replaces the path
 * filters of the old GitHub workflows (root-typecheck, runtime-release-train, web-client, step2-lxd,
 * hosted-db), which no longer run, and runs at least what they ran for the same change:
 *
 * - every change that is not documentation: lint, both typechecks and the repository checks (root-typecheck
 *   ran on every PR);
 * - every change that is not web-only (runtime-release-train's exclusion list): all runtime and
 *   cloud-client tests, all script tests (packaging, pins, vocabulary) and the runtime bundle check;
 * - path-specific steps on top (web, member-web, object-gateway, runner-orchestrator, functions, deploy,
 *   hosted-db, and folder-core-load for migrations: one folder-v2 company under pooled load, the folder core's
 *   load test);
 * - shared configuration, `packages/contracts`, `packages/company` and any path no rule knows: every step.
 *
 * Release candidates still run the full `test` suite before a cut. */

import { CARGO_BUILD } from "./folder-program-artifact.mjs";
import { HOSTED_DB_SCRIPTS } from "./test-hosted-db.mjs";

/** The function tests the old workflows ran (web-client and step2-lxd), and the artifact GC worker's (its folder phase,
 * C1D §9.10); the others never ran in CI. */
const FUNCTION_TESTS = [
	"supabase/functions/native-provider-login/native-provider-login.test.ts",
	"supabase/functions/member-company-gateway/member-company-gateway.test.ts",
	"supabase/functions/computer-billing/computer-billing.test.ts",
	"supabase/functions/_shared/computer-hour-notices.test.ts",
	"supabase/functions/chatgpt-plan-callback/chatgpt-plan-callback.test.ts",
	"supabase/functions/company-file-verifier/object-loader.test.ts",
	"supabase/functions/company-file-verifier/company-file-verifier.test.ts",
	"supabase/functions/runner-orchestrator/runner-orchestrator.test.ts",
	"supabase/functions/event-intake/event-intake.test.ts",
	"supabase/functions/mail-intake/mail-intake.test.ts",
	"supabase/functions/mail-outbox/mail-outbox.test.ts",
	"supabase/functions/runner-control/runner-control.test.ts",
	"supabase/functions/artifact-gc-worker/artifact-gc-worker.test.ts",
];
const WEB_RELEASE_CONFIG = JSON.stringify({
	projectUrl: "https://project.example.invalid",
	publishableKey: "sb_publishable_fixture123",
	objectGatewayUrl: "https://objects.example.invalid",
	officeViewerOrigin: "wss://viewer.example.invalid:8443",
	nativeProviderLoginUrl: "https://project.example.invalid/functions/v1/native-provider-login/",
});
/** The Rust image the folder program's tests run in: the test machine has no Rust of its own. 1.95.0 is the
 * patched Codex builder's toolchain (deploy/first-node/native-codex/source.json). */
export const RUST_IMAGE =
	"rust:1.95.0-slim-bookworm@sha256:d7482085ff5b415f84dba5647ae71606650bdef00db7aeb69f4b3d170c3e4082";
/** Node for the folder program's run against the folder service: the same Debian release as RUST_IMAGE, so the
 * program built there runs here. */
export const NODE_IMAGE = "node:24.21.0-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6";
const FUSE = "--device /dev/fuse --cap-add SYS_ADMIN --security-opt apparmor=unconfined";
const vitest = (workspace, args = "") => `(cd packages/${workspace} && node ../../node_modules/vitest/dist/cli.js --run${args})`;
const regex = (path) => new RegExp(`^${path.replaceAll(".", "\\.")}$`);

/** Runs `second` beside `first` and fails when either fails. `second`'s output waits in a file and is printed after
 * `first`'s, under `label`. */
export const beside = (first, second, label) =>
	`out=$(mktemp) && { ( ${second} ) >"$out" 2>&1 & pid=$!; ${first}; a=$?; wait $pid; b=$?; echo "== ${label} (ran beside)"; cat "$out"; rm -f "$out"; [ $a = 0 ] && [ $b = 0 ]; }`;

/** Runner-orchestrator test files that spend nearly all their time waiting on real deadlines and timeouts, not on
 * CPU: about 250 s of the step's file time for about 8 s of CPU (15 Oct). They run as a second vitest beside the rest
 * of the package, which excludes them by these same names, so every test file runs once. A name that matches no file
 * fails the step, so a rename never drops tests. */
export const RUNNER_ORCHESTRATOR_WAITING = [
	"test/lxd-office-preparation-execution.test.ts",
	"test/lxd-office-preparation-transport.test.ts",
	"test/company-machine-host.test.ts",
	"test/lxd-login-gateway.test.ts",
	"test/lxd-office-inspection.test.ts",
	"test/orchestrator-wake.test.ts",
	"test/coding-executor-host.test.ts",
	"test/lxd-provider-concurrency.test.ts",
	"test/orchestrator.test.ts",
];

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
		why: "pinned dependencies, imports, cloud boundaries, wire helper copies, migration custom settings, connector catalog, runtime bundle",
		paths: ANY,
		commands: [
			"npm run check:pinned-deps",
			"npm run check:ts-imports",
			"npm run check:cloud-boundaries",
			"npm run check:wire-helpers",
			"npm run check:migration-settings",
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
			// The release build measures its source from git and refuses uncommitted changes. The run copy has
			// no .git, so the step commits it into a throwaway repository for the build and removes it after.
			// This checks bundling and the release configuration; the snapshot commit is never deployed.
			"git init -q && git add -A && git -c user.name=run-on-node -c user.email=run-on-node@invalid commit -qm snapshot",
			`QORPERA_WEB_CONFIG_JSON='${WEB_RELEASE_CONFIG}' npm run build:release --workspace packages/web; built=$?; rm -rf .git; exit $built`,
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
		name: "contracts",
		why: "packages/contracts (a change there runs every step)",
		paths: [/^packages\/contracts\//],
		commands: ["npm test --workspace packages/contracts"],
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
		why: "packages/runner-orchestrator and what its tests read: deploy files, runtime and cloud-client sources, runtime fixtures (step2-lxd.yml); the files that mostly wait run beside the rest",
		paths: [
			/^packages\/runner-orchestrator\//,
			/^deploy\//,
			/^packages\/runtime\/src\//,
			/^packages\/runtime\/test\/fixtures\//,
			/^packages\/cloud-client\/src\//,
		],
		commands: [
			`(cd packages/runner-orchestrator && for file in ${RUNNER_ORCHESTRATOR_WAITING.join(" ")}; do [ -f "$file" ] || { echo "== runner-orchestrator: $file is missing"; exit 1; }; done)`,
			beside(
				vitest("runner-orchestrator", RUNNER_ORCHESTRATOR_WAITING.map((file) => ` --exclude ${file}`).join("")),
				vitest("runner-orchestrator", RUNNER_ORCHESTRATOR_WAITING.map((file) => ` ${file}`).join("")),
				"runner-orchestrator: the files that mostly wait",
			),
		],
	},
	{
		name: "folder-program",
		why: "crates/qorpera-folder and the folder service: unit and FUSE tests in the pinned Rust image, then the built program against the service in Node (root and /dev/fuse in containers; vsock is proven live)",
		paths: [
			/^crates\/qorpera-folder\//,
			/^packages\/object-gateway\/(src\/folder-service\/|test\/folder-)/,
			/^deploy\/folder-service\/folder-program-linux-x64\.json$/,
			/^scripts\/folder-program-artifact\.mjs$/,
		],
		// Crates are cached in a named volume between runs; the built program passes between the two containers in
		// a volume of this run's own, removed at the end.
		commands: [
			`v=qorpera-folder-$(date +%s%N); docker volume create "$v" >/dev/null && docker run --rm ${FUSE} -e QORPERA_FOLDER_FUSE_TESTS=1 -e CARGO_TARGET_DIR=/tmp/target -v qorpera-cargo-registry:/usr/local/cargo/registry -v "$PWD/crates/qorpera-folder:/src:ro" -v "$v:/out" -w /src ${RUST_IMAGE} sh -c 'cargo test --locked && ${CARGO_BUILD} && cp /tmp/target/release/qorpera-folder /out/' && docker run --rm ${FUSE} -e QORPERA_FOLDER_MOUNT_BIN=/out/qorpera-folder -v "$v:/out:ro" -v "$PWD:/repo" -w /repo/packages/object-gateway ${NODE_IMAGE} sh -c 'node ../../scripts/folder-program-artifact.mjs --check /out/qorpera-folder && node ../../node_modules/vitest/dist/cli.js --run test/folder-mount-e2e.test.ts'; s=$?; docker volume rm "$v" >/dev/null; exit $s`,
		],
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
		// node --test runs its files side by side, the agent exit's root proof in a file of its own.
		commands: [
			"node --test deploy/node-tidy/qorpera-node-tidy.test.mjs deploy/node-parity/qorpera-node-parity.test.mjs deploy/node-agent/qorpera-node-agent.test.mjs deploy/guest-guard/qorpera-guest-guard.test.mjs deploy/agent-exit/qorpera-agent-exit.test.mjs deploy/agent-exit/qorpera-agent-exit-proof.test.mjs",
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
			/^scripts\/fixtures\/email-draft-e2e/,
			/^packages\/runtime\/src\/cloud-(secret|connector)-/,
			// The office delete-disposition script bundles the Company Computer's startup and screen publishers, and the
			// runtime files they import.
			/^packages\/runtime\/src\/cloud-(company-computer-(startup|screen-lifecycle|screen-outbox|registry-http)|native-tool-authority|control-errors|runtime-observability|runtime-policy)\.ts$/,
			/^packages\/runner-orchestrator\/src\/lxd-office-[a-z-]+-control\.ts$/,
			/^packages\/web\/src\/cloud\/email-drafts\.ts$/,
			// The folder service's parsers and tree, checked against the folder core's own answers. The folder core's
			// acceptance script (F3-3c) also runs its writes, staging and mounts on the real commit. Not server.ts or cli.ts.
			/^packages\/object-gateway\/src\/folder-service\/(core|view-tree|https-request|service|staging|mounts|machines|plan|pending|protocol|objects|search)\.ts$/,
			// The connection-file writer's script runs the gateway's writer and the shared state-file parser on SQL.
			// So does company creation's worker script (P14b). The folder core's acceptance script also runs the
			// gateway's handler, its folder service route and its Supabase authority (F3-3c), and member folder commits.
			/^packages\/object-gateway\/src\/(connection-files|company-folder-creation|platform-folder-writer|object-store|native-objects|dependency|service|supabase-authority|supabase-headers|folder-service-objects|folder-objects|member-folder-commits)\.ts$/,
			/^packages\/cloud-client\/src\/company-state-files\.ts$/,
			// The rolling update rehearsal runs this generator's packets.
			/^scripts\/runtime-roll\.mjs$/,
			// The agent exit's placement undo (test-agent-exit-placement-undo).
			/^deploy\/agent-exit\/undo-\d{14}\.sql$/,
			...HOSTED_DB_SCRIPTS.map(regex),
		],
		// Those two import the runtime's TypeScript, which imports built packages.
		build: true,
		// One PostgreSQL and one migration replay for the SQL tests and every script (scripts/test-hosted-db.mjs).
		commands: ["node --test scripts/test-hosted-db.test.mjs", "node scripts/test-hosted-db.mjs --scripts"],
	},
	{
		// v133 (2026-09-27): a lock change on a hot path ships only with a load test at realistic concurrency.
		// Any migration can change what one company's calls lock, so every migration runs it. Since C1c-3i
		// (folder-v2 only) it is the folder core's load test (C1e), short: 16 runs for 30 s and a run whose read set
		// holds 5,000 paths (about 2.5 min with its setup).
		name: "folder-core-load",
		why: "one folder-v2 company under pooled load with the production role timeouts on a real disk: its runs' fences, reads, writes, releases and subtree deletes, a stop, narrowing, wakes, GC and rank-0 writers; fails on a deadlock, a leak, a lost parent or bytes, an unexpected failure or a call over the result fence",
		paths: [
			/^supabase\/migrations\//,
			/^supabase\/tests\/648_folder_core_run_fence_concurrency\.test\.sql$/,
			/^scripts\/load-folder-core\./,
		],
		commands: ["node scripts/load-folder-core.mjs --runs 16 --seconds 30 --big-paths 5000 --check"],
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
	return /^(packages\/(runtime|cloud-client|object-gateway|runner-orchestrator)\/|crates\/qorpera-folder\/|scripts\/|deploy\/|supabase\/)/.test(
		file,
	);
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
		// The failed step names reach the run record (and the GitHub status) through the status file.
		'if [ -n "$failed" ]; then echo "== changed: failed:$failed"; echo "failed_steps=$(echo $failed | tr \' \' ,)" >>.run-on-node-status; exit 1; fi',
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
