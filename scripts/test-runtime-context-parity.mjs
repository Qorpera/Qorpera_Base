// Real PostgreSQL admission and context -> production TypeScript parsers.
// No provider, credential, hosted database or substituted authority function.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseCloudNativeCompanyContext, composeCloudNativeCompanyPrompt } from "../packages/runtime/src/cloud-native-company-context.ts";
import { parseCloudWakeEnvelope } from "../packages/runtime/src/cloud-wake-bus.ts";
import { assertCloudRuntimeBundle } from "../packages/runtime/src/cloud-runtime-bundle.ts";
import { generateCloudRuntimeBundle } from "./generate-cloud-runtime-bundle.mjs";
import { POSTGRES_IMAGE, sortMigrationNames } from "./test-hosted-db.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const container = `qorpera-context-parity-${randomBytes(6).toString("hex")}`;
const psql = ["exec", "-i", container, "psql", "-X", "-qAt", "-U", "postgres", "-d", "qorpera_test", "-v", "ON_ERROR_STOP=1"];
function docker(args, input) {
	const result = spawnSync("docker", args, { input, encoding: "utf8", timeout: 60_000, maxBuffer: 8 * 1024 * 1024 });
	assert(!result.error && result.status === 0, result.stderr || "Disposable database command failed");
	return result.stdout.trim();
}
let started = false;
try {
	const bundle = await generateCloudRuntimeBundle(true);
	docker(["run", "-d", "--rm", "--name", container, "--label", "qorpera.test=runtime-context-parity",
		"-e", "POSTGRES_PASSWORD=qorpera-test-only", "-e", "POSTGRES_DB=qorpera_test", POSTGRES_IMAGE]);
	started = true;
	let consecutive = 0;
	for (let attempt = 0; attempt < 60 && consecutive < 2; attempt++) {
		const result = spawnSync("docker", ["exec", container, "pg_isready", "-h", "127.0.0.1", "-U", "postgres", "-d", "qorpera_test"], { timeout: 2000 });
		consecutive = result.status === 0 ? consecutive + 1 : 0;
		if (consecutive < 2) await new Promise((resolve) => setTimeout(resolve, 500));
	}
	assert.equal(consecutive, 2);
	docker(psql, readFileSync(join(root, "supabase/tests/bootstrap.sql"), "utf8"));
	const migrations = sortMigrationNames(readdirSync(join(root, "supabase/migrations")));
	for (const name of migrations) docker(psql, readFileSync(join(root, "supabase/migrations", name), "utf8"));
	const component = readFileSync(join(root, "supabase/tests/300_runtime_wake_bus.test.sql"), "utf8");
	assert.equal(component.split("-- END WAKE FIXTURE").length, 2);
	const fixture = component.split("-- END WAKE FIXTURE")[0];
	docker(psql, `${fixture}\n${readFileSync(join(root, "supabase/tests/fixtures/runtime-terminal-claim-cases.sql"), "utf8")}\nrollback;`);
	console.log("PASS: expired claim assignment, renewal and replay reject terminally without admitting work");
	docker(psql, `${fixture}\n${readFileSync(join(root, "supabase/tests/fixtures/runtime-file-closure-cases.sql"), "utf8")}\nrollback;`);
	console.log("PASS: closure order reverified; changed membership, byte lengths and manifest metadata rejected");
	const nativeIdentityMarker = "select pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');\nset local role authenticated;\nselect set_config('qorpera_test.wake_identity'";
	assert.equal(fixture.split(nativeIdentityMarker).length, 2);
	for (const audience of ["company", "member_private"]) {
		const setup = audience === "company" ? fixture : fixture.replace(nativeIdentityMarker, `
			update public.qorpera_shared_sessions set audience_kind='member_private',audience_user_id='30000000-0000-4000-8000-000000000001'
			where id='30000000-0000-4000-8000-000000000040';\n${nativeIdentityMarker}`);
		const rows = docker(psql, `${setup}\nset local role service_role;
			${audience === "member_private" ? `select pg_temp.wake_public_send(current_setting('qorpera_test.wake_binding')::jsonb,'progress','private-route-check'); select pg_temp.wake_error($deny$select public.qorpera_escalate_responsibility(current_setting('qorpera_test.wake_binding')::jsonb,'{}')$deny$,'42501','Private context requires its publication authority');` : ""}
			select jsonb_build_object('binding',current_setting('qorpera_test.wake_binding')::jsonb,
				'context',public.qorpera_describe_company_run_context(current_setting('qorpera_test.wake_binding')::jsonb),
				'wake',public.qorpera_read_native_wake(current_setting('qorpera_test.wake_binding')::jsonb));
			rollback;`).split("\n");
		const value = JSON.parse(rows.at(-1));
		const context = parseCloudNativeCompanyContext(value.context, value.binding);
		assertCloudRuntimeBundle(context.identity, bundle.manifest.nativeBinarySha256);
		const wake = parseCloudWakeEnvelope(value.wake, context.identity);
		assert.equal(wake.kind, "human");
		assert.equal(context.audience.kind, audience);
		assert.equal(context.currentInputs[0].kind, "current_human_request");
		const prompt = JSON.parse(composeCloudNativeCompanyPrompt(context, wake));
		assert.equal(prompt.delivery.initial, "required");
		assert.equal(prompt.delivery.requireFinalSend, true);
		console.log(`PASS: ${audience} human admission, real SQL context/wake, exact bundle and production prompt composition`);
	}
	const wakeContexts = readFileSync(join(root, "supabase/tests/fixtures/runtime-wake-contexts.sql"), "utf8");
	for (const kind of ["human", "first-run", "routine", "agent", "room"]) {
		const rows = docker(psql, `${fixture}\n${wakeContexts}\nselect pg_temp.wake_context_probe('${kind}'); rollback;`).split("\n");
		const value = JSON.parse(rows.at(-1));
		const context = parseCloudNativeCompanyContext(value.context, value.binding);
		assertCloudRuntimeBundle(context.identity, bundle.manifest.nativeBinarySha256);
		const wake = parseCloudWakeEnvelope(value.wake, context.identity);
		assert.equal(wake.kind, kind);
		assert.equal(context.agent.id, "30000000-0000-4000-8000-000000000031");
		const prompt = JSON.parse(composeCloudNativeCompanyPrompt(context, wake));
		assert.equal(prompt.wake.kind, kind);
		assert.equal(prompt.delivery.initial, ["human", "first-run"].includes(kind) ? "required" : kind === "room" ? "optional" : "forbidden");
		assert.equal(prompt.delivery.requireFinalSend, ["human", "first-run"].includes(kind));
		if (kind === "first-run") assert.equal(context.currentInputs[0].kind, "private_startup");
		console.log(`PASS: same agent, real ${kind} materializer -> native context -> bundle -> production prompt`);
	}
	const routing = readFileSync(join(root, "supabase/tests/fixtures/runtime-responsibility-escalations.sql"), "utf8");
	docker(psql, `${fixture}\n${routing}\nrollback;`);
	console.log("PASS: projected responsibility escalation, coalescing, native/member routing, receipt replay and revoked-context fences");
	assert.equal(routing.split("-- END RESPONSIBILITY ROUTING FIXTURE").length, 2);
	const persisted = docker(psql, `${fixture}\n${routing.split("-- END RESPONSIBILITY ROUTING FIXTURE")[0]}
		select jsonb_build_object('binding',current_setting('qorpera_test.wake_binding')::jsonb,'signal',pg_temp.escalation_signal('concurrent'));
		commit;`).split("\n");
	const concurrentInput = JSON.parse(persisted.at(-1));
	const sqlLiteral = (value) => `'${JSON.stringify(value).replaceAll("'", "''")}'::jsonb`;
	const concurrentCall = (key) => new Promise((resolve, reject) => {
		const child = spawn("docker", psql, { stdio: ["pipe", "pipe", "pipe"] });
		let stdout = "", stderr = "", bytes = 0;
		const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("Concurrent routing timed out")); }, 20_000);
		child.on("error", (error) => { clearTimeout(timer); reject(error); });
		child.stdout.on("data", (chunk) => { bytes += chunk.length; if (bytes > 256 * 1024) child.kill("SIGKILL"); else stdout += chunk; });
		child.stderr.on("data", (chunk) => { bytes += chunk.length; if (bytes > 256 * 1024) child.kill("SIGKILL"); else stderr += chunk; });
		child.on("close", (code) => { clearTimeout(timer); if (code !== 0) reject(new Error(stderr || "Concurrent routing failed"));
			else { try { resolve(JSON.parse(stdout.trim())); } catch (error) { reject(error); } } });
		child.stdin.end(`set request.jwt.claims='{"role":"service_role"}'; set role service_role;
			select public.qorpera_escalate_responsibility(${sqlLiteral(concurrentInput.binding)},${sqlLiteral({ ...concurrentInput.signal, operationKey: key })});`);
	});
	const completed = await Promise.allSettled([concurrentCall("concurrent-a"), concurrentCall("concurrent-b")]);
	for (const result of completed) assert.equal(result.status, "fulfilled", result.status === "rejected" ? String(result.reason) : "");
	const deliveries = completed.map((result) => result.value);
	assert.deepEqual(deliveries.map((item) => item.status).sort(), ["agent-queued", "coalesced"]);
	assert.equal(deliveries[0].escalationId, deliveries[1].escalationId);
	assert.equal(docker(psql, "select count(*) from public.qorpera_wake_occurrences where wake_kind='agent';"), "1");
	assert.equal(docker(psql, "select count(*) from public.qorpera_responsibility_escalation_signals;"), "2");
	assert.equal(docker(psql, "select count(*) from public.qorpera_run_operation_receipts where status in ('executing','ambiguous');"), "0");
	const replay = await concurrentCall("concurrent-a");
	assert.deepEqual(replay, deliveries[0]);
	console.log("PASS: concurrent responsibility signals produce one wake, retain both contributions, and replay the exact receipt");
	console.log(`PASS: context parity after ${migrations.length} migrations; no model invoked`);
} finally {
	if (started) docker(["rm", "-f", "-v", container]);
	console.log(`Removed disposable context-parity database: ${container}`);
}
