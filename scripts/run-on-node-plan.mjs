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
const vitest = (workspace, args = "") => `(cd packages/${workspace} && node ../../node_modules/vitest/dist/cli.js --run${args})`;
const regex = (path) => new RegExp(`^${path.replaceAll(".", "\\.")}$`);

/** Runs `second` beside `first` and fails when either fails. `second`'s output waits in a file and is printed after
 * `first`'s, under `label`. */
export const beside = (first, second, label) =>
	`out=$(mktemp) && { ( ${second} ) >"$out" 2>&1 & pid=$!; ${first}; a=$?; wait $pid; b=$?; echo "== ${label} (ran beside)"; cat "$out"; rm -f "$out"; [ $a = 0 ] && [ $b = 0 ]; }`;

/** The commands that run `waiting`, test files of packages/`workspace` that mostly wait, as a second vitest beside
 * the rest of the package. The rest excludes them by these same names (and `exclude` too), so every test file runs
 * once. A name that matches no file fails the step before anything runs, so a rename never drops tests. */
const besideTheRest = (workspace, waiting, exclude = []) => [
	`(cd packages/${workspace} && for file in ${waiting.join(" ")}; do [ -f "$file" ] || { echo "== ${workspace}: $file is missing"; exit 1; }; done)`,
	beside(
		vitest(workspace, [...exclude, ...waiting].map((file) => ` --exclude ${file}`).join("")),
		vitest(workspace, waiting.map((file) => ` ${file}`).join("")),
		`${workspace}: the files that mostly wait`,
	),
];

/** Runner-orchestrator test files that spend nearly all their time waiting on real deadlines and timeouts, not on
 * CPU: about 250 s of the step's file time for about 8 s of CPU (15 Oct). They run beside the rest (besideTheRest). */
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

/** Runtime test files that spend nearly all their time asleep on timers and child processes, not on CPU: about 127 s
 * of the step's 235 s of file time, 121 s of it asleep (15 Oct). They run beside the rest (besideTheRest). */
export const RUNTIME_WAITING = [
	"test/cloud-codex-tool-session.test.ts",
	"test/cloud-company-computer-control-output-linux.test.ts",
	"test/cloud-company-computer-linux-guest.test.ts",
	"test/cloud-company-computer-browser-egress.test.ts",
	"test/shared-vault-secrets.test.ts",
	"test/cloud-company-computer-shell.test.ts",
	"test/cloud-company-computer-desktop.test.ts",
	"test/cloud-company-computer-service.test.ts",
	"test/cloud-native-transport.test.ts",
];
/** The coding command supervisor's test, which runs on its own after the rest of the runtime package. */
const RUNTIME_GUEST = "test/cloud-coding-command-guest.test.ts";

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

/** Ordered steps. `build`: needs npm run build:web-sdk first (script tests and the web import it). `alone`: commands
 * that need the tree to themselves, run after `commands` one step at a time, but first in a side-by-side run
 * (planScript). `cores`: the step's mean busy cores at 2 vitest workers, its PostgreSQL containers included (node01,
 * 16 Oct), which a side-by-side run packs by (default 1). `seconds`: its median in pr-loop's full runs (15 Oct), so a side-by-side run starts the longest
 * first. */
export const STEPS = [
	{
		name: "lint",
		why: "biome over the repository (npm run check)",
		paths: ANY,
		// Reads every file: a file another step is writing could fail it.
		commands: [],
		alone: ["npx biome check --error-on-warnings ."],
	},
	{
		name: "typecheck",
		why: "root and member-web tsgo (root-typecheck.yml ran on every PR)",
		paths: ANY,
		commands: [],
		alone: ["npx tsgo --noEmit", "npx tsgo -p packages/member-web/tsconfig.json"],
	},
	{
		name: "checks",
		why: "pinned dependencies, imports, cloud boundaries, wire helper copies, migration custom settings, connector catalog, runtime bundle",
		paths: ANY,
		commands: [],
		alone: [
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
		seconds: 61,
		paths: [
			/^packages\/web\//,
			/^packages\/member-web\/ui\//,
			/^packages\/cloud-client\//,
			/^supabase\/functions\//,
			/^scripts\/web-deployment/,
		],
		build: true,
		cores: 2,
		commands: [
			"npm run typecheck --workspace packages/web",
			"npm test --workspace packages/web",
			`node --test ${FUNCTION_TESTS.slice(0, 4).join(" ")} scripts/web-deployment.test.mjs`,
		],
		// The release build measures its source from git and refuses uncommitted changes. The run copy has
		// no .git, so the step commits it into a throwaway repository for the build and removes it after.
		// This checks bundling and the release configuration; the snapshot commit is never deployed. A file
		// another step writes meanwhile would dirty the tree, and the build rewrites the built packages other
		// steps import: alone.
		alone: [
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
		why: "every change that is not web-only (runtime-release-train.yml): all tests, then the coding command supervisor; the files that mostly wait run beside the rest",
		seconds: 154,
		paths: NOT_WEB_ONLY,
		commands: [...besideTheRest("runtime", RUNTIME_WAITING, [RUNTIME_GUEST]), vitest("runtime", ` ${RUNTIME_GUEST}`)],
	},
	{
		name: "scripts",
		why: "every change that is not web-only: all script tests, packaging and pins included (runtime-release-train.yml, step2-lxd.yml)",
		seconds: 31,
		paths: NOT_WEB_ONLY,
		build: true,
		commands: ["node --test scripts/*.test.mjs"],
	},
	{
		name: "object-gateway",
		why: "packages/object-gateway",
		seconds: 30,
		paths: [/^packages\/object-gateway\//],
		cores: 0.4,
		commands: [vitest("object-gateway")],
	},
	{
		name: "runner-orchestrator",
		why: "packages/runner-orchestrator and what its tests read: deploy files, runtime and cloud-client sources, runtime fixtures (step2-lxd.yml); the files that mostly wait run beside the rest",
		seconds: 588,
		paths: [
			/^packages\/runner-orchestrator\//,
			/^deploy\//,
			/^packages\/runtime\/src\//,
			/^packages\/runtime\/test\/fixtures\//,
			/^packages\/cloud-client\/src\//,
		],
		// Mostly waits on its tests' deadlines: 1.16 cores over 602 s as one vitest. Since the files that mostly wait
		// run beside the rest, the same CPU (689 s) takes about 400 s (402 s in pr-loop's one run so far): about 1.7.
		cores: 1.7,
		commands: besideTheRest("runner-orchestrator", RUNNER_ORCHESTRATOR_WAITING),
	},
	{
		name: "folder-program",
		why: "crates/qorpera-folder and the folder service: unit and FUSE tests in the pinned Rust image and, beside them, the release build, its check against the build record and the built program against the service in Node (root and /dev/fuse in containers; vsock is proven live)",
		seconds: 89,
		paths: [
			/^crates\/qorpera-folder\//,
			/^packages\/object-gateway\/(src\/folder-service\/|test\/folder-)/,
			/^deploy\/folder-service\/folder-program-linux-x64\.json$/,
			/^scripts\/folder-program-(artifact|step)\.mjs$/,
		],
		// Compiled crates stay in a volume of the runner user's own between runs (scripts/folder-program-step.mjs). Its
		// containers' CPU, read from their cgroups (node02, 16 Oct): 90 CPU seconds over 98 s with the crates emptied,
		// 32 over 80 s with them kept.
		cores: 1,
		commands: ["node scripts/folder-program-step.mjs"],
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
		seconds: 135,
		paths: [/^deploy\//, /^packages\/runner-orchestrator\/src\//],
		// Mostly waits: 14 CPU seconds over 139 s.
		cores: 0.25,
		commands: [
			"node --test deploy/node-tidy/qorpera-node-tidy.test.mjs deploy/node-parity/qorpera-node-parity.test.mjs deploy/node-agent/qorpera-node-agent.test.mjs deploy/guest-guard/qorpera-guest-guard.test.mjs deploy/agent-exit/qorpera-agent-exit.test.mjs",
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
		seconds: 240,
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
		cores: 2.6,
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
		seconds: 121,
		paths: [
			/^supabase\/migrations\//,
			/^supabase\/tests\/648_folder_core_run_fence_concurrency\.test\.sql$/,
			/^scripts\/load-folder-core\./,
		],
		cores: 1.6,
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
			steps: STEPS.map((step) => ({ ...planned(step), files: [] })),
			build: true,
		};
	const chosen = STEPS.filter((step) => steps.has(step.name)).map((step) => ({
		...planned(step),
		files: steps.get(step.name),
	}));
	return { full: false, reason: null, steps: chosen, build: STEPS.some((step) => step.build && steps.has(step.name)) };
}

/** What planScript needs of a step. */
function planned(step) {
	return {
		name: step.name,
		why: step.why,
		commands: step.commands,
		alone: step.alone ?? [],
		cores: step.cores ?? 1,
		seconds: step.seconds ?? 0,
	};
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

/** Every step runs, even after another failed; the exit code is 1 if any failed. Without `cores`, one step at a time in
 * plan order, each running its `alone` commands after its others.
 *
 * With `cores`, side by side: first every step's `alone` commands, one step at a time with nothing else running; then
 * the rest of every step, the longest (`seconds`) first, each starting once the running steps' `cores` leave room for
 * it within `cores` (one always runs). A step runs its rest even when its `alone` part failed, and passes only if both
 * passed. Its output is printed whole when it ends, with its own time. A step whose rest ends without a result (its
 * worker killed, or the result not written) fails. */
export function planScript(steps, { cores = null } = {}) {
	const fail = [
		// The failed step names reach the run record (and the GitHub status) through the status file.
		'if [ -n "$failed" ]; then echo "== changed: failed:$failed"; echo "failed_steps=$(echo $failed | tr \' \' ,)" >>.run-on-node-status; exit 1; fi',
		'echo "== changed: all steps passed"',
	];
	if (!cores)
		return [
			"set -u",
			"failed=''",
			...steps.flatMap((step) => [
				`echo "== changed: ${step.name}"`,
				"started=$(date +%s)",
				// && and not set -e: errexit is ignored inside an if condition, so a failed first command would pass.
				`if ( ${[...step.commands, ...(step.alone ?? [])].join(" && ")} ); then echo "== changed: ${step.name} passed in $(( $(date +%s) - started )) s"; else echo "== changed: ${step.name} FAILED after $(( $(date +%s) - started )) s"; failed="$failed ${step.name}"; fi`,
			]),
			...fail,
		].join("\n");
	const indexed = steps.map((step, i) => ({ step, i }));
	const rest = indexed
		.filter(({ step }) => step.commands.length)
		.sort((a, b) => (b.step.seconds ?? 0) - (a.step.seconds ?? 0) || a.i - b.i)
		.map(({ i }) => i);
	return [
		"set -u",
		"failed=''",
		'out=$(mktemp -d); trap \'rm -rf "$out"\' EXIT',
		`names=(${steps.map((step) => step.name).join(" ")})`,
		// Hundredths of a core; each step's exit code and seconds so far.
		`need=(${steps.map((step) => Math.round((step.cores ?? 1) * 100)).join(" ")})`,
		`code=(${steps.map(() => 0).join(" ")})`,
		`seconds=(${steps.map(() => 0).join(" ")})`,
		// Each part is a subshell, so a command's own exit ends only its part.
		...indexed.flatMap(({ step, i }) => [
			...(step.alone?.length ? [`alone_${i}() ( ${step.alone.join(" && ")} )`] : []),
			...(step.commands.length ? [`rest_${i}() ( ${step.commands.join(" && ")} )`] : []),
		]),
		'report() { echo "== changed: ${names[$1]}"; cat "$out/$1.log"; if [ "${code[$1]}" = 0 ]; then echo "== changed: ${names[$1]} passed in ${seconds[$1]} s"; else echo "== changed: ${names[$1]} FAILED after ${seconds[$1]} s"; failed="$failed ${names[$1]}"; fi; }',
		...indexed
			.filter(({ step }) => step.alone?.length)
			.map(
				({ step, i }) =>
					`started=$(date +%s); alone_${i} >"$out/${i}.log" 2>&1; code[${i}]=$?; seconds[${i}]=$(( $(date +%s) - started ))${step.commands.length ? "" : `; report ${i}`}`,
			),
		// The rest's end (exit code, seconds) appears in one rename, so the loop never reads half of it.
		'start() { ( s=$(date +%s); "rest_$1" >>"$out/$1.log" 2>&1; c=$?; echo "$c $(( $(date +%s) - s ))" >"$out/$1.end.tmp" && mv "$out/$1.end.tmp" "$out/$1.end" ) & pid[$1]=$!; began[$1]=$(date +%s); }',
		// A worker is alive while /proc shows it running (not a zombie) as this shell's child, so its pid handed out
		// again to another process does not count.
		'alive() { local _pid _comm state parent; { read -r _pid _comm state parent _ <"/proc/$1/stat"; } 2>/dev/null && [ "$state" != Z ] && [ "$parent" = "$BASHPID" ]; }',
		// The runner user's tasks count against its 512-task limit (run-on-node.mjs RUNNERS): the run reports its peak.
		`pending="${rest.join(" ")}"; running=""; used=0; tick=0; tasks=0; least=""`,
		'while [ -n "${pending// }${running// }" ]; do',
		'\tleft=""',
		"\tfor i in $pending; do",
		`\t\tif [ -z "\${running// }" ] || [ $(( used + need[i] )) -le ${Math.round(cores * 100)} ]; then start "$i"; running="$running $i"; used=$(( used + need[i] )); else left="$left $i"; fi`,
		"\tdone",
		'\tpending=$left; sleep 1; tick=$(( tick + 1 ))',
		"\tif [ $(( tick % 5 )) = 1 ]; then",
		'\t\tn=$(ps -L -u "$(id -u)" --no-headers 2>/dev/null | wc -l); [ "$n" -gt "$tasks" ] && tasks=$n',
		"\t\tm=$(awk '/^MemAvailable:/ { print int($2 / 1024) }' /proc/meminfo); [ -z \"$least\" ] || [ \"$m\" -lt \"$least\" ] && least=$m",
		"\tfi",
		'\tstill=""',
		"\tfor i in $running; do",
		// A worker with a result ends right after its rename, so wait returns at once; reaped, it has written all it ever
		// will. One killed, or one that could not write its result, fails its step with its exit code and frees its cores.
		'\t\tif [ -e "$out/$i.end" ] || ! alive "${pid[i]}"; then',
		'\t\t\twait "${pid[i]}"; w=$?; c=""; s=""; [ -e "$out/$i.end" ] && read -r c s <"$out/$i.end"',
		'\t\t\tif [[ $c =~ ^[0-9]+$ && $s =~ ^[0-9]+$ ]]; then seconds[i]=$(( seconds[i] + s )); [ "${code[i]}" = 0 ] && code[i]=$c;',
		'\t\t\telse echo "== changed: ${names[i]}: its worker ended (exit $w) without a result" >>"$out/$i.log"; seconds[i]=$(( seconds[i] + $(date +%s) - began[i] )); code[i]=1; fi',
		'\t\t\treport "$i"; used=$(( used - need[i] ))',
		'\t\telse still="$still $i"; fi',
		"\tdone",
		"\trunning=$still",
		"done",
		"wait",
		`echo "== changed: side by side within ${cores} cores: at most $tasks tasks of the runner user, at least \${least:-?} MiB available"`,
		...fail,
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
