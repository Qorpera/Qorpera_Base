import { createHash } from "node:crypto";
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { CLOUD_RUNTIME_MODEL_POLICY } from "../packages/runtime/src/cloud-runtime-policy.ts";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const generatedSource = "packages/runtime/src/cloud-runtime-bundle.generated.ts";
const activation = "supabase/migrations/20260924231000_runtime_bundle_activation_v102.sql";
const activationVersion = 102;
const previousActivationVersion = 101;
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
			toolCatalog: component(runtime(["cloud-company-path-gateway", "cloud-secret-tools", "cloud-native-company-runtime", "cloud-wake-bus", "cloud-routine-tools", "cloud-worker-tools", "cloud-hiring-tools", "cloud-coding-command-tools", "cloud-native-coding-runtime", "cloud-memory-tools", "cloud-sidebar-tools"])),
			wakeAndSilence: component(runtime(["cloud-native-company-runtime", "cloud-agent-mouth", "cloud-wake-bus"])),
			contextComposer: component(runtime(["cloud-native-company-context", "cloud-runtime-hire-overlays", "cloud-company-path-gateway"])),
			providerBootstrap: component(runtime(["cloud-codex-tool-session", "cloud-native-company-context", "cloud-runtime-constitution", "cloud-runtime-hire-overlays", "cloud-native-provider-host", "lxd-runner-bootstrap-main"])),
			authorization: component([...files.keys()].filter((path) => path.startsWith("supabase/migrations/"))),
			inboundSafety: component(runtime(["cloud-native-result-fence", "cloud-native-tool-boundary"])),
			outboundSafety: component(runtime(["cloud-native-tool-operations", "cloud-secret-tools", "cloud-company-path-gateway"])),
			interactionSurfaces: component(runtime(["cloud-agent-mouth", "cloud-native-company-runtime"])),
			workerLifecycle: component([...runtime(["cloud-runner-worker", "cloud-native-provider-host", "cloud-worker-tools"]), ...[...files.keys()].filter((path) => path.startsWith("packages/runtime/src/cloud-coding-") || path.startsWith("packages/runner-orchestrator/src/coding-") || path.startsWith("packages/contracts/src/cloud-coding"))]),
			memoryAndSkills: component(runtime(["cloud-codex-tool-session", "cloud-native-company-context", "cloud-memory-tools", "cloud-company-path-gateway"])),
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
		[activation, `-- Generated source-only activation; run the rollout gates before applying.\n-- After this migration is shipped, use a NEW activation migration for a new bundle.\n-- Historical v${previousActivationVersion} runs/inputs are not silently relabelled as v${activationVersion}.\n-- The model policy in this manifest needs the thread-effort kernel (20260924120000); refuse to activate without it.\ndo $$ begin if to_regprocedure('public.qorpera_set_session_model(uuid,text,bigint,text)') is null then\n\traise exception 'Activation requires migration 20260924120000_thread_model_effort'; end if; end $$;\n-- The coding executor in this manifest plans one machine per member (20260924220000); refuse to activate without it.\ndo $$ begin if to_regprocedure('public.qorpera_plan_coding_machine(uuid,uuid,text)') is null then\n\traise exception 'Activation requires migration 20260924220000_runtime_coding_member_machines'; end if; end $$;\n-- The Codex build in this manifest sends any number of tool outputs per model request (20260924230000); refuse to activate without it.\ndo $$ begin if coalesce(pg_get_functiondef('public.qorpera_record_native_context_view(uuid,jsonb,jsonb)'::regprocedure),'') not like '%pg_column_size(p_view) > 16777216%'\n\tor coalesce((select pg_get_constraintdef(oid) from pg_constraint where conname = 'qorpera_native_context_views_view_check'),'') not like '%16777216%' then\n\traise exception 'Activation requires migration 20260924230000_runtime_native_view_no_output_count'; end if; end $$;\ninsert into public.qorpera_runtime_bundles(bundle_key,version,manifest,sha256)\nvalues ('qorpera.cloud-runtime',${activationVersion},'${bundle.text.replaceAll("'", "''")}'::jsonb,'${bundle.sha256}');\nupdate public.qorpera_active_runtime_bundle set runtime_bundle_id = bundle.id,\n\truntime_bundle_sha256 = bundle.sha256,activated_at = statement_timestamp()\nfrom public.qorpera_runtime_bundles bundle\nwhere singleton and bundle.bundle_key = 'qorpera.cloud-runtime' and bundle.version = ${activationVersion};\n`],
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
