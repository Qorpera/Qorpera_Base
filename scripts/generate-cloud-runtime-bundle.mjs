import { createHash } from "node:crypto";
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { CLOUD_RUNTIME_MODEL_POLICY } from "../packages/runtime/src/cloud-runtime-policy.ts";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const generatedSource = "packages/runtime/src/cloud-runtime-bundle.generated.ts";
const activation = "supabase/migrations/20260928186500_runtime_bundle_activation_v144.sql";
const activationVersion = 144;
const previousActivationVersion = 143;
const previousActivationSha256 = "e1a5a3e3f9d1397c989f6568cc8bf8efafb96af4df957c99157f7bbc6ab8d4dd";
const manifestPath = "deploy/first-node/native-codex/runtime-bundle-manifest.json";
const sha = (text) => createHash("sha256").update(text).digest("hex");

// The packager consumes this same list: process/worker entrypoints which are
// launched by filename must not disappear from the import-graph provenance.
export const CLOUD_RUNTIME_ENTRY_POINTS = Object.freeze({
	"company-lock-heartbeat": "packages/company/src/company-lock-heartbeat.ts",
	"qorpera-ephemeral-runner": "packages/runtime/src/cloud-runner-service-main.ts",
	"qorpera-native-provider-host": "packages/runtime/src/cloud-native-provider-service-main.ts",
	"qorpera-identity-recovery-restore": "packages/runtime/src/cloud-identity-recovery-restore-main.ts",
	"qorpera-native-isolation-child": "packages/runtime/src/cloud-native-isolation-child.ts",
	"qorpera-sandbox-probe": "packages/runtime/src/cloud-runner-container-main.ts",
	"qorpera-lxd-runner-bootstrap": "packages/runtime/src/lxd-runner-bootstrap-main.ts",
	"qorpera-lxd-native-login-bootstrap": "packages/runtime/src/lxd-native-login-bootstrap-main.ts",
});

/** PostgreSQL jsonb::text for this generated ASCII-key/string/integer manifest.
 * SQL's existing bundle checksum constraint and the parity test verify these bytes.
 * This is not a general JSON canonicalization or a model-controlled serializer. */
export function runtimeManifestText(value) {
	if (Array.isArray(value)) return `[${value.map(runtimeManifestText).join(", ")}]`;
	if (value === null || typeof value !== "object") {
		if (typeof value === "number" && !Number.isSafeInteger(value)) throw new Error("Noninteger bundle value");
		return JSON.stringify(value);
	}
	const keys = Object.keys(value).sort((a, b) => Buffer.byteLength(a) - Buffer.byteLength(b) || Buffer.compare(Buffer.from(a), Buffer.from(b)));
	if (keys.some((key) => !/^[\x20-\x7e]+$/.test(key))) throw new Error("Non-ASCII manifest key");
	return `{${keys.map((key) => `${JSON.stringify(key)}: ${runtimeManifestText(value[key])}`).join(", ")}}`;
}

export async function cloudRuntimeBundle(root = repository) {
	const files = new Map();
	const workspaces = new Map();
	for (const directory of await readdir(join(root, "packages"))) {
		const path = `packages/${directory}/package.json`;
		const metadata = await readFile(join(root, path), "utf8").catch((error) => {
			if (error.code === "ENOENT") return null;
			throw error;
		});
		if (metadata) workspaces.set(JSON.parse(metadata).name, `packages/${directory}`);
	}
	async function include(path) {
		if (path === generatedSource || path === activation || path === manifestPath || files.has(path)) return;
		if (path.startsWith("../") || path.includes("/.artifacts/")) throw new Error("Invalid bundle source");
		const bytes = await readFile(join(root, path));
		files.set(path, sha(bytes));
		if (!path.endsWith(".ts")) return;
		const parsed = ts.createSourceFile(path, bytes.toString("utf8"), ts.ScriptTarget.Latest, true);
		for (const statement of parsed.statements) {
			if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) continue;
			const name = statement.moduleSpecifier;
			if (name && ts.isStringLiteral(name) && name.text.startsWith(".")) {
				await include(relative(root, resolve(root, dirname(path), name.text)));
			} else if (name && ts.isStringLiteral(name)) {
				const parts = name.text.split("/");
				const workspace = workspaces.get(parts.slice(0, 2).join("/"));
				if (workspace) {
					await include(`${workspace}/package.json`);
					const source = `${workspace}/src/${parts.slice(2).join("/") || "index"}.ts`;
					if (!(await stat(join(root, source))).isFile()) throw new Error(`Workspace runtime source is unavailable: ${source}`);
					await include(source);
				}
			}
		}
	}
	for (const path of Object.values(CLOUD_RUNTIME_ENTRY_POINTS)) await include(path);
	for (const name of ["cloud-secret-broker-service-main.ts", "cloud-runtime-policy.ts"]) await include(`packages/runtime/src/${name}`);
	for (const name of (await readdir(join(root, "packages/runtime/src"))).filter((name) => /^(cloud-coding-|cloud-native-coding-).*\.ts$/.test(name)).sort()) await include(`packages/runtime/src/${name}`);
	for (const name of (await readdir(join(root, "packages/runner-orchestrator/src"))).filter((name) => /^coding-.*\.ts$/.test(name)).sort()) await include(`packages/runner-orchestrator/src/${name}`);
	for (const name of (await readdir(join(root, "deploy/coding-worker"))).filter((name) => /\.(service|timer|slice|json|ts)$/.test(name)).sort()) await include(`deploy/coding-worker/${name}`);
	for (const name of (await readdir(join(root, "scripts"))).filter((name) => /^package-coding-.*\.mjs$/.test(name)).sort()) await include(`scripts/${name}`);
	// Office adapters are injected at composition boundaries. Pin their sources
	// even before a deployed service entrypoint selects the concrete guest.
	for (const name of (await readdir(join(root, "packages/runtime/src"))).filter((name) => /^cloud-company-computer-.*\.ts$/.test(name)).sort()) {
		await include(`packages/runtime/src/${name}`);
	}
	for (const name of ["qorpera-screen-session", "qorpera-screen-xfce", "qorpera-browser-policy.json", "qorpera-office-browser-bwrap.apparmor", "qorpera-company-computer.service", "qorpera-company-computer-preparation.service", "qorpera-office-preparation.conf", "qorpera-office-runtime.conf", "qorpera-office-private.mount.in"]) await include(`deploy/lxd-company-computer-guest/${name}`);
	await include("packages/runner-orchestrator/src/lxd-office-image-installation-cli.ts");
	await include("packages/runner-orchestrator/src/lxd-office-fleet-cli.ts");
	await include("packages/runner-orchestrator/src/lxd-office-fleet-installation-cli.ts");
	await include("scripts/package-lxd-office-fleet.mjs");
	for (const name of ["office-code-package-control.ts", "office-code-package-measure.ts"]) await include(`deploy/lxd-company-computer-guest/${name}`);
	await include("packages/runner-orchestrator/src/lxd-office-code-package-loader.ts");
	await include("deploy/lxd-company-computer-guest/qorpera-screen-browser");
	for (const name of (await readdir(join(root, "deploy/lxd-company-computer-guest/backdrops"))).sort()) {
		if (!/^qorpera-screen-[a-z]+(?:-(?:[01][0-9]|2[0-3]))?\.png$/.test(name)) throw new Error("Invalid office wallpaper artifact");
		await include(`deploy/lxd-company-computer-guest/backdrops/${name}`);
	}
	for (const name of (await readdir(join(root, "supabase/migrations"))).filter((name) => name.endsWith(".sql")).sort()) {
		await include(`supabase/migrations/${name}`);
	}
	for (const name of (await readdir(join(root, "deploy/lxd-runner-guest"))).filter((name) => /\.(service|sh|json)$/.test(name)).sort()) {
		await include(`deploy/lxd-runner-guest/${name}`);
	}
	for (const path of [
		"deploy/first-node/native-codex/source.json", "deploy/first-node/native-codex/0001-cloud-result-fence.patch",
		"deploy/first-node/native-codex/linux-x64-artifact.json",
		"deploy/ephemeral-runner/image/run-job", "deploy/lxd-runner-guest/harness/package.json", "deploy/lxd-runner-guest/harness/package-lock.json",
		"scripts/native-company-artifact.mjs", "scripts/package-ephemeral-runner.mjs", "scripts/generate-cloud-runtime-bundle.mjs",
		"scripts/package-lxd-runner-guest.mjs", "scripts/package-company-computer.mjs",
		"scripts/package-office-code-package-control.mjs",
		"package-lock.json", "packages/runtime/package.json", "packages/cloud-client/package.json",
	]) await include(path);
	// The accepted native input is independent of the later compiled guest
	// package, whose host embeds this bundle. Reading that output here creates
	// a circular pin update when replacing the native executable.
	const native = JSON.parse(await readFile(join(root, "deploy/first-node/native-codex/linux-x64-artifact.json"), "utf8"));
	const source = JSON.parse(await readFile(join(root, "deploy/first-node/native-codex/source.json"), "utf8"));
	if (!native || native.schema !== "qorpera.native-codex-artifact/v1" || !native.artifact ||
		!Number.isSafeInteger(native.artifact.bytes) || native.artifact.bytes < 1 || native.artifact.bytes > 1024 ** 3 ||
		!/^[0-9a-f]{64}$/.test(native.artifact.sha256) || native.artifact.file !== "codex" ||
		native.artifact.target !== "x86_64-unknown-linux-gnu" || native.artifact.profile !== "release" ||
		runtimeManifestText(native.source) !== runtimeManifestText(source)
		|| files.get("deploy/first-node/native-codex/0001-cloud-result-fence.patch") !== source.patchSha256) {
		throw new Error("Native artifact pin differs from its reviewed source");
	}
	const modelPolicy = CLOUD_RUNTIME_MODEL_POLICY;
	const component = (paths) => {
		const selected = Object.fromEntries(paths.sort().map((path) => {
			if (!files.has(path)) throw new Error(`Missing bundle component ${path}`);
			return [path, files.get(path)];
		}));
		return sha(runtimeManifestText(selected));
	};
	const runtime = (names) => names.map((name) => `packages/runtime/src/${name}.ts`);
	const manifest = {
		schema: "qorpera.runtime-bundle/v2",
		modelPolicy,
		nativeBinarySha256: native.artifact.sha256,
		components: {
			kernel: component(runtime(["cloud-native-company-runtime", "cloud-native-run-tool-session"])),
			constitution: component(runtime(["cloud-runtime-constitution"])),
			toolCatalog: component([...runtime(["cloud-company-path-gateway", "cloud-company-formation", "cloud-secret-tools", "cloud-native-company-runtime", "cloud-wake-bus", "cloud-routine-tools", "cloud-worker-tools", "cloud-hiring-tools", "cloud-coding-command-tools", "cloud-native-coding-runtime", "cloud-memory-tools", "cloud-skill-tools", "cloud-sidebar-tools"]), "packages/cloud-client/src/cloud-skill-file.ts", "packages/cloud-client/src/cloud-agent-folder.ts"]),
			wakeAndSilence: component(runtime(["cloud-native-company-runtime", "cloud-agent-mouth", "cloud-wake-bus"])),
			contextComposer: component(runtime(["cloud-native-company-context", "cloud-runtime-hire-overlays", "cloud-company-formation", "cloud-company-path-gateway"])),
			providerBootstrap: component(runtime(["cloud-codex-tool-session", "cloud-native-company-context", "cloud-runtime-constitution", "cloud-runtime-hire-overlays", "cloud-company-formation", "cloud-native-provider-host", "lxd-runner-bootstrap-main"])),
			authorization: component([...files.keys()].filter((path) => path.startsWith("supabase/migrations/"))),
			inboundSafety: component(runtime(["cloud-native-result-fence", "cloud-native-tool-boundary"])),
			outboundSafety: component(runtime(["cloud-native-tool-operations", "cloud-secret-tools", "cloud-company-path-gateway"])),
			interactionSurfaces: component(runtime(["cloud-agent-mouth", "cloud-native-company-runtime"])),
			workerLifecycle: component([...runtime(["cloud-runner-worker", "cloud-native-provider-host", "cloud-worker-tools"]), ...[...files.keys()].filter((path) => path.startsWith("packages/runtime/src/cloud-coding-") || path.startsWith("packages/runner-orchestrator/src/coding-") || path.startsWith("packages/contracts/src/cloud-coding"))]),
			memoryAndSkills: component([...runtime(["cloud-codex-tool-session", "cloud-native-company-context", "cloud-memory-tools", "cloud-skill-tools", "cloud-company-path-gateway"]), "packages/cloud-client/src/cloud-skill-file.ts", "packages/cloud-client/src/cloud-agent-folder.ts"]),
		},
		implementation: Object.fromEntries([...files].sort(([a], [b]) => a.localeCompare(b, "en"))),
	};
	const text = runtimeManifestText(manifest);
	if (Buffer.byteLength(text) > 256 * 1024) throw new Error("Runtime manifest exceeds its SQL bound");
	return { manifest, text, sha256: sha(text), modelPolicySha256: sha(runtimeManifestText(modelPolicy)) };
}

export async function generateCloudRuntimeBundle(check = false, root = repository) {
	const bundle = await cloudRuntimeBundle(root);
	const outputs = new Map([
		[manifestPath, `${JSON.stringify(bundle.manifest, null, 2)}\n`],
		[generatedSource, `// Generated by scripts/generate-cloud-runtime-bundle.mjs. Do not edit.\nexport const CLOUD_RUNTIME_BUNDLE_SHA256 = "${bundle.sha256}";\nexport const CLOUD_RUNTIME_MODEL_POLICY_SHA256 = "${bundle.modelPolicySha256}";\nexport const CLOUD_RUNTIME_NATIVE_BINARY_SHA256 = "${bundle.manifest.nativeBinarySha256}";\n`],
		[activation, `-- Generated source-only activation; run the rollout gates before applying.\n-- After this migration is shipped, use a NEW activation migration for a new bundle.\n-- Historical v${previousActivationVersion} runs/inputs are not silently relabelled as v${activationVersion}.\n-- The model policy in this manifest needs the thread-effort kernel (20260924120000); refuse to activate without it.\ndo $$ begin if to_regprocedure('public.qorpera_set_session_model(uuid,text,bigint,text)') is null then\n\traise exception 'Activation requires migration 20260924120000_thread_model_effort'; end if; end $$;\n-- The coding executor in this manifest plans one machine per member (20260924220000); refuse to activate without it.\ndo $$ begin if to_regprocedure('public.qorpera_plan_coding_machine(uuid,uuid,text)') is null then\n\traise exception 'Activation requires migration 20260924220000_runtime_coding_member_machines'; end if; end $$;\n-- The Codex build in this manifest sends any number of tool outputs per model request (20260924230000); refuse to activate without it.\ndo $$ declare v_definition text := coalesce(pg_get_functiondef(to_regprocedure('public.qorpera_record_native_context_view(uuid,jsonb,jsonb)')),'');\nbegin if v_definition not like '%pg_column_size(p_view) > 16777216%'\n\tor v_definition like '%jsonb_array_length(p_view -> ''outputs'') > 128%'\n\tor coalesce((select pg_get_constraintdef(oid) from pg_constraint where conrelid = 'public.qorpera_native_context_views'::regclass\n\t\tand conname = 'qorpera_native_context_views_view_check'),'') not like '%16777216%' then\n\traise exception 'Activation requires migration 20260924230000_runtime_native_view_no_output_count'; end if; end $$;\n-- The runtime in this manifest pages todo and worker listings and counts open work (20260925112000); refuse to activate without it.\ndo $$ begin if to_regprocedure('public.qorpera_describe_agent_open_work(jsonb)') is null\n\tor to_regprocedure('public.qorpera_agent_todo_page(public.qorpera_execution_runs,jsonb)') is null\n\tor to_regprocedure('public.qorpera_agent_worker_page(public.qorpera_execution_runs,jsonb)') is null\n\tor to_regprocedure('public.qorpera_agent_worker_listing(public.qorpera_runtime_workers,text,boolean)') is null then\n\traise exception 'Activation requires migration 20260925112000_runtime_todo_worker_pages'; end if; end $$;\n-- The coding runtime in this manifest reads each turn's own history (20260925113000); refuse to activate without it.\ndo $$ begin if to_regprocedure('public.qorpera_read_coding_turn_context(jsonb)') is null then\n\traise exception 'Activation requires migration 20260925113000_runtime_coding_turn_continuity'; end if; end $$;\n-- Email draft cards require the member action kernel and the Gmail draft catalog.\ndo $$ begin if to_regprocedure('public.qorpera_get_email_draft(uuid,uuid)') is null\n\tor not exists (select 1 from public.qorpera_cloud_connector_operations where connector_id = 'gmail' and operation_id = 'create_draft' and status = 'active') then\n\traise exception 'Activation requires Gmail draft catalog and member email draft migrations'; end if; end $$;\n-- Fleet command routing and office selection must be installed before this bundle.\ndo $$ begin if to_regprocedure('public.qorpera_route_coding_command(jsonb,jsonb,text,uuid,text)') is null\n\tor to_regprocedure('public.qorpera_place_runtime_office_fleet(jsonb,bigint)') is null then\n\traise exception 'Activation requires coding and office fleet migrations'; end if; end $$;\n-- The auto-review step in this manifest reads rules and records verdicts through the rules kernel (20260926130000); refuse to activate without it.\ndo $$ begin if to_regprocedure('public.qorpera_begin_action_review(jsonb,jsonb)') is null\n\tor to_regprocedure('public.qorpera_await_action_review(jsonb,uuid,boolean,boolean)') is null\n\tor to_regprocedure('public.qorpera_add_agent_review_rule(jsonb,jsonb)') is null then\n\traise exception 'Activation requires migration 20260926130000_runtime_auto_review_rules'; end if; end $$;\n-- The kernel in this manifest locks a coding session's rows in one order (20260925117000): every patched function must carry it; refuse to activate without it.\ndo $$ declare v_missing text; begin\n\tselect string_agg(expected.target, ', ') into v_missing from (values\n\t\t('public.qorpera_lock_coding_worker(uuid)', 'for update;'),\n\t\t('public.qorpera_coding_session_owner_row(uuid)', 'and species = ''coding'';'),\n\t\t('public.qorpera_answer_coding_session(uuid,text,uuid)', 'v_worker := public.qorpera_lock_coding_worker(v_worker.id);'),\n\t\t('public.qorpera_delegate_coding_session(uuid,uuid)', 'where id = v_worker.id for update;'),\n\t\t('public.qorpera_complete_coding_turn(uuid,uuid,text,text,text,jsonb,jsonb,jsonb,text,integer,jsonb)', 'v_worker := public.qorpera_lock_coding_worker(p_worker_id);'),\n\t\t('public.qorpera_begin_coding_turn(uuid,uuid,jsonb)', 'v_worker := public.qorpera_lock_coding_worker(p_worker_id);'),\n\t\t('public.qorpera_authorize_coding_machine_run(uuid,uuid,text,jsonb,text)', 'where id = p_worker_id for update;'),\n\t\t('public.qorpera_authorize_coding_machine_custody(uuid,text,text,text,text,uuid,uuid)', 'where worker_id = p_worker_id for update; end if;')) expected(target, marker)\n\twhere position(expected.marker in coalesce(pg_get_functiondef(to_regprocedure(expected.target)), '')) = 0;\n\tif v_missing is not null then\n\t\traise exception 'Activation requires migration 20260925117000_runtime_coding_lock_order (%)', v_missing; end if; end $$;\n-- The runtime in this manifest decides dynamic routines (20260926131000); refuse to activate without it.\ndo $$ begin if to_regprocedure('public.qorpera_decide_agent_routine(jsonb,jsonb)') is null then\n\traise exception 'Activation requires migration 20260926131000_runtime_dynamic_routines'; end if; end $$;\n-- A member's save keeps the routine's schedule position (20260926132000); refuse to activate without it.\ndo $$ begin if position('and public.qorpera_routine_occurrence_count(new.routine_id) >= v_routine.max_occurrences then' in coalesce(pg_get_functiondef(to_regprocedure('public.qorpera_routine_occurrence_lifecycle()')),'')) = 0 then\n\traise exception 'Activation requires migration 20260926132000_runtime_member_routine_cursor'; end if; end $$;\n-- An agent's changed timing restarts the routine schedule (20260926133000); refuse to activate without it.\ndo $$ begin if position('cross join lateral public.qorpera_routine_version_schedule_position(v_routine.id, v_routine.current_version,' in coalesce(pg_get_functiondef(to_regprocedure('public.qorpera_manage_agent_routine(jsonb,jsonb)')),'')) = 0 then\n\traise exception 'Activation requires migration 20260926133000_runtime_agent_routine_cursor'; end if; end $$;\n-- The coding runtime in this manifest reads fitted turn context (20260926162500); refuse to activate without it.\ndo $$ begin if position('(count(*) filter (where not (sized.running <= 49152 or sized.sequence = v_sequence - 1)))::integer' in coalesce(pg_get_functiondef(to_regprocedure('public.qorpera_read_coding_turn_context(jsonb)')),'')) = 0 then\n\traise exception 'Activation requires migration 20260926162500_runtime_coding_turn_review_fixes'; end if; end $$;\n-- A member's Stop reaches room and wake runs in the conversation (20260926183100); refuse to activate without it.\ndo $$ begin if position('run.source_kind in (''session_turn'',''room_delivery'',''wake'')' in coalesce(pg_get_functiondef(to_regprocedure('public.qorpera_cancel_session_run_profile_scope(uuid,uuid)')),'')) = 0 then\n\traise exception 'Activation requires migration 20260926183100_member_stop_thread_wake_runs'; end if; end $$;\n-- A run a member stopped is no failure in the activity list (20260926192436); refuse to activate without it.\ndo $$ begin if position('when job.cancelled_by_user_id is not null then 0' in coalesce(pg_get_functiondef(to_regprocedure('public.qorpera_list_staff_execution_activity(uuid)')),'')) = 0 then\n\traise exception 'Activation requires migration 20260926192436_member_stop_settled_activity'; end if; end $$;\n-- The runtime in this manifest reports a missing parent folder as parent_missing (20260926203300); refuse to activate without it.\ndo $$ begin if position('''parent_missing''' in coalesce(pg_get_functiondef(to_regprocedure('public.qorpera_record_runtime_observation(uuid,jsonb)')),'')) = 0\n\tor to_regprocedure('public.qorpera_check_company_path_mutation(uuid,jsonb,jsonb)') is null then\n\traise exception 'Activation requires migration 20260926203300_company_file_missing_parent'; end if; end $$;\n-- Approval cards carry the call as an object (20260926210000); refuse to activate without it.\ndo $$ begin if to_regprocedure('public.qorpera_action_review_call(text)') is null then\n\traise exception 'Activation requires migration 20260926210000_runtime_auto_review_fixes'; end if; end $$;\n-- Every coding machine call takes the company fence first (20260925123000); refuse to activate without each patch.\ndo $$ begin if position('qorpera_lock_profile_gc_fence(worker.profile_id) from public.qorpera_runtime_workers worker where worker.id = p_worker_id' in coalesce(pg_get_functiondef(to_regprocedure('public.qorpera_authorize_coding_machine_run(uuid,uuid,text,jsonb,text)')),'')) = 0\n\tor position('qorpera_lock_profile_gc_fence(worker.profile_id) from public.qorpera_runtime_workers worker where worker.id = p_worker_id' in coalesce(pg_get_functiondef(to_regprocedure('public.qorpera_plan_coding_machine(uuid,uuid,text)')),'')) = 0\n\tor position('qorpera_lock_profile_gc_fence(machine.profile_id) from public.qorpera_coding_machines machine where machine.id = p_machine_id' in coalesce(pg_get_functiondef(to_regprocedure('public.qorpera_suspend_coding_machine(uuid,text,text,text)')),'')) = 0\n\tor position('qorpera_lock_profile_gc_fence(machine.profile_id) from public.qorpera_coding_machines machine where machine.id = p_machine_id' in coalesce(pg_get_functiondef(to_regprocedure('public.qorpera_release_coding_machine(uuid,text,text,text)')),'')) = 0\n\tor position('where authority.id = p_broker_authority_id) for key share;' in coalesce(pg_get_functiondef(to_regprocedure('public.qorpera_authorize_coding_repository_credential(uuid,text,uuid,uuid,text,jsonb)')),'')) = 0 then\n\traise exception 'Activation requires migration 20260925123000_runtime_coding_machine_lock_order'; end if; end $$;\n-- The orchestrator shipped with this cut raises a routine's first slot (20260927020000); refuse to activate without it.\ndo $$ begin if to_regprocedure('public.qorpera_advance_routine_next_due(uuid,bigint,text,timestamptz,timestamptz)') is null\n\tor position('and (cursor.last_scheduled_for is null' in coalesce(pg_get_functiondef(to_regprocedure('public.qorpera_routine_next_run_at(uuid)')),'')) = 0 then\n\traise exception 'Activation requires migration 20260927020000_runtime_routine_first_slot'; end if; end $$;\n-- Member Company File writers and NAS replica copies take the company fence first (20260927150000); the\n-- substrate helper, runner paths and legacy lane do not; refuse otherwise.\ndo $$ declare v_wrong text; begin\n\tselect string_agg(target, ', ') into v_wrong from (values\n\t\t('public.qorpera_prepare_company_file_revision(uuid,uuid,uuid,text,integer,integer,integer,bigint)', true),\n\t\t('public.qorpera_publish_company_file_revision(uuid,uuid,uuid)', true),\n\t\t('public.qorpera_prepare_company_file_proposal(uuid,uuid,uuid,text,integer,integer,integer,bigint)', true),\n\t\t('public.qorpera_submit_company_proposal(uuid,uuid,uuid,text,uuid,uuid,uuid,bigint,text,text,text,uuid[])', true),\n\t\t('public.qorpera_rebase_company_proposal(uuid,uuid,uuid,uuid)', true),\n\t\t('public.qorpera_enforce_company_storage_quota()', true),\n\t\t('public.qorpera_ensure_current_company_substrate(uuid,uuid,uuid,uuid,uuid)', false),\n\t\t('public.qorpera_runner_prepare_company_revision(uuid,text,uuid,text,uuid,uuid,text,integer,integer,integer,bigint)', false),\n\t\t('public.qorpera_complete_runner_job_before_path_runtime(uuid,text,uuid,text,uuid,uuid,uuid,jsonb)', false),\n\t\t('public.qorpera_claim_wake_v2(uuid,text,uuid,integer,uuid,uuid,bigint)', false),\n\t\t('public.qorpera_enqueue_execution_run(uuid,uuid,uuid,text,uuid,uuid,uuid,bigint,uuid,bigint,text,text,jsonb,text,text,uuid[],uuid)', false)) expected(target, fenced)\n\twhere (position('qorpera_lock_profile_gc_fence' in coalesce(pg_get_functiondef(to_regprocedure(target)), '')) > 0) <> fenced\n\t\tor (target = 'public.qorpera_enforce_company_storage_quota()'\n\t\t\tand position('if new.user_metadata -> ''qorpera_nas_replica'' = ''true''::jsonb and auth.role() = ''service_role'' then' in pg_get_functiondef(to_regprocedure(target))) = 0)\n\t\tor (target = 'public.qorpera_rebase_company_proposal(uuid,uuid,uuid,uuid)'\n\t\t\tand position('order by job.id for update of job nowait;' in pg_get_functiondef(to_regprocedure(target))) = 0);\n\tif v_wrong is not null then\n\t\traise exception 'Activation requires migration 20260927150000_company_file_writer_fence (%)', v_wrong; end if; end $$;\n-- A closed computer panel takes its wake back (20260927110000); refuse to activate without it.\ndo $$ begin if to_regprocedure('public.qorpera_withdraw_runtime_office_wake(jsonb,bigint,uuid)') is null\n\tor position('qorpera_runtime_office_wake_withdrawn(c)' in coalesce(pg_get_functiondef(to_regprocedure('public.qorpera_reconcile_runtime_office_idle(jsonb,bigint,uuid,text,integer)')),'')) = 0 then\n\traise exception 'Activation requires migration 20260927110000_runtime_office_wake_withdrawal'; end if; end $$;\n-- The model policy in this manifest declares thread fast mode (20260927161500); refuse to activate without it.\ndo $$ begin if to_regprocedure('public.qorpera_set_session_service_tier(uuid,text,bigint)') is null then\n\traise exception 'Activation requires migration 20260927161500_thread_fast_mode'; end if; end $$;\n-- A formation moves from goals_ratified to responsibility_map (20260927185000); refuse to activate without it.\ndo $$ begin if position('when ''goals_ratified'' then v_document ->> ''state'' = ''responsibility_map''' in coalesce(pg_get_functiondef(to_regprocedure('public.qorpera_project_organization_document(jsonb,jsonb,text,uuid,uuid)')),'')) = 0 then\n\traise exception 'Activation requires migration 20260927185000_company_formation_responsibility_map_stage'; end if; end $$;\n-- The node observer and login gateway in this release attach and report a shared execution host's identity devices (20260927190000); refuse to activate without it.\ndo $$ begin if coalesce(pg_get_functiondef(to_regprocedure('public.qorpera_runtime_node_inventory_context(uuid)')),'') not like '%acceptedIdentities%'\n\tor coalesce(pg_get_functiondef(to_regprocedure('public.qorpera_observe_runtime_node_inventory(jsonb,text,jsonb)')),'') not like '%Node inventory reports identity devices its policy does not declare%'\n\tor coalesce(pg_get_functiondef(to_regprocedure('public.qorpera_enroll_runtime_node_inventory(jsonb)')),'') not like '%identityVolumes%' then\n\traise exception 'Activation requires migration 20260927190000_runtime_exec_host_identity_devices'; end if; end $$;\n-- The runtime in this manifest observes read_skill, search_skills and update_skill (20260928032000); refuse to activate without it.\ndo $$ begin if position('''read_skill'',''search_skills'',''update_skill''' in coalesce(pg_get_functiondef(to_regprocedure('public.qorpera_record_runtime_observation(uuid,jsonb)')),'')) = 0 then\n\traise exception 'Activation requires migration 20260928032000_runtime_agent_skills'; end if; end $$;\n-- The node observer in this release reads a declared build space (20260928180500); refuse to activate without it.\ndo $$ begin if position('BUILD_SPACE_EXCEEDED' in coalesce(pg_get_functiondef(to_regprocedure('public.qorpera_observe_runtime_node_inventory(jsonb,text,jsonb)')),'')) = 0 then\n\traise exception 'Activation requires migration 20260928180500_runtime_node_build_space'; end if; end $$;\n-- Orchestrators of a switched-off node claim nothing new (20260928180700); refuse to activate without it.\ndo $$ begin if position('qorpera_runtime_orchestrator_nodes(v_adapter)' in coalesce(pg_get_functiondef(to_regprocedure('public.qorpera_claim_runner_job_for_orchestrator(uuid,uuid,integer)')),'')) = 0 then\n\traise exception 'Activation requires migration 20260928180700_runtime_node_serving_switch'; end if; end $$;\n-- A run is claimed only by an orchestrator that declared its bundle (20260928182000); refuse to activate without it.\ndo $$ begin if position('declared.runtime_bundle_sha256' in coalesce(pg_get_functiondef(to_regprocedure('public.qorpera_claim_runner_job_for_orchestrator(uuid,uuid,integer)')),'')) = 0 then\n\traise exception 'Activation requires migration 20260928182000_runtime_orchestrator_runtime_bundle'; end if; end $$;\n-- Runs follow the placement: fast hosts claim first, overflow after (20260928183000); refuse to activate without it.\ndo $$ begin if position('qorpera_runtime_claim_turn(p_orchestrator_id, job, run)' in coalesce(pg_get_functiondef(to_regprocedure('public.qorpera_claim_runner_job_for_orchestrator(uuid,uuid,integer)')),'')) = 0 then\n\traise exception 'Activation requires migration 20260928183000_runtime_runs_follow_placement'; end if; end $$;\n-- The node observer lists the fast host by its role and pins its image to a node release (20260928186000); refuse to activate without it.\ndo $$ begin if position('''INSTANCE_IMAGE_NOT_RELEASED''' in coalesce(pg_get_functiondef(to_regprocedure('public.qorpera_observe_runtime_node_inventory(jsonb,text,jsonb)')),'')) = 0 then\n\traise exception 'Activation requires migration 20260928186000_runtime_node_exec_host_role'; end if; end $$;\n-- Keep the predecessor check, insertion and pointer update in one atomic statement.\n-- A stale deployment must never replace a newer active runtime.\ndo $$ begin\n\tperform 1 from public.qorpera_active_runtime_bundle where singleton for update;\n\tif not found or not exists (\n\t\tselect 1 from public.qorpera_active_runtime_bundle a\n\t\tjoin public.qorpera_runtime_bundles b on b.id=a.runtime_bundle_id and b.sha256=a.runtime_bundle_sha256\n\t\twhere a.singleton and b.bundle_key='qorpera.cloud-runtime' and b.version=${previousActivationVersion}\n\t\tand b.sha256='${previousActivationSha256}'\n\t) then raise exception 'Activation requires exact active runtime v${previousActivationVersion}' using errcode='55000'; end if;\ninsert into public.qorpera_runtime_bundles(bundle_key,version,manifest,sha256)\nvalues ('qorpera.cloud-runtime',${activationVersion},'${bundle.text.replaceAll("'", "''")}'::jsonb,'${bundle.sha256}');\nupdate public.qorpera_active_runtime_bundle set runtime_bundle_id = bundle.id,\n\truntime_bundle_sha256 = bundle.sha256,activated_at = statement_timestamp()\nfrom public.qorpera_runtime_bundles bundle\nwhere singleton and bundle.bundle_key = 'qorpera.cloud-runtime' and bundle.version = ${activationVersion};\nend $$;\n`],
	]);
	for (const [path, text] of outputs) {
		if (check) {
			if (await readFile(join(root, path), "utf8").catch(() => null) !== text) throw new Error(`Runtime bundle is stale: ${path}`);
		} else await writeFile(join(root, path), text);
	}
	return bundle;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	if (process.argv.slice(2).some((arg) => arg !== "--check")) throw new Error("Usage: generate-cloud-runtime-bundle.mjs [--check]");
	const bundle = await generateCloudRuntimeBundle(process.argv.includes("--check"));
	console.log(`Runtime bundle ${bundle.sha256}: ${process.argv.includes("--check") ? "verified" : "generated"}`);
}
