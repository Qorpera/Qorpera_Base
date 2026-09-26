// Release train (deploy/first-node/RUNTIME-RELEASE-TRAIN.md): feature branches do
// not regenerate the derived runtime bundle files or re-pin the guest package;
// one release/runtime-vNNN branch per live cut does. CI sets
// QORPERA_ENFORCE_RUNTIME_BUNDLE=1 only on those release branches. Any other
// value skips only the comparison between the committed derived files and their
// source. Every other bundle validation still runs.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { generateCloudRuntimeBundle, runtimeManifestText } from "./generate-cloud-runtime-bundle.mjs";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sha = (text) => createHash("sha256").update(text).digest("hex");

export const RUNTIME_BUNDLE_ENFORCEMENT = "QORPERA_ENFORCE_RUNTIME_BUNDLE";
export const RUNTIME_BUNDLE_NOT_ENFORCED =
	"runtime bundle freshness is enforced only on release/runtime-* branches (QORPERA_ENFORCE_RUNTIME_BUNDLE=1)";

export function runtimeBundleEnforced(environment = process.env) {
	return environment[RUNTIME_BUNDLE_ENFORCEMENT] === "1";
}

/** The bundle identity the committed derived files declare: the last release cut.
 * The packaged native host embeds exactly these pins. The two committed files
 * must agree with each other; whether they match the source is not checked. */
export async function committedRuntimeBundle(root = repository) {
	const manifest = JSON.parse(
		await readFile(join(root, "deploy/first-node/native-codex/runtime-bundle-manifest.json"), "utf8"),
	);
	const text = runtimeManifestText(manifest);
	const bundle = {
		manifest,
		text,
		sha256: sha(text),
		modelPolicySha256: sha(runtimeManifestText(manifest.modelPolicy)),
	};
	const generated = await readFile(join(root, "packages/runtime/src/cloud-runtime-bundle.generated.ts"), "utf8");
	for (const [name, value] of [
		["CLOUD_RUNTIME_BUNDLE_SHA256", bundle.sha256],
		["CLOUD_RUNTIME_MODEL_POLICY_SHA256", bundle.modelPolicySha256],
		["CLOUD_RUNTIME_NATIVE_BINARY_SHA256", manifest.nativeBinarySha256],
	]) {
		if (!generated.includes(`export const ${name} = "${value}";\n`)) {
			throw new Error(`Committed runtime bundle differs from its manifest: ${name}`);
		}
	}
	return bundle;
}

/** Runs the generator's check. When not enforced, only its staleness refusal is
 * downgraded to a report; any other generator error still throws. */
export async function checkRuntimeBundle({ enforced = runtimeBundleEnforced(), root = repository } = {}) {
	try {
		return { fresh: true, bundle: await generateCloudRuntimeBundle(true, root) };
	} catch (error) {
		if (enforced || !(error instanceof Error) || !error.message.startsWith("Runtime bundle is stale: ")) throw error;
		return { fresh: false, stale: error.message, committed: await committedRuntimeBundle(root) };
	}
}

const committedPackaging = pathToFileURL(
	join(repository, "scripts/fixtures/committed-runtime-bundle/register.mjs"),
).href;

/** Environment for spawning scripts/package-ephemeral-runner.mjs (directly or via
 * package-lxd-runner-guest.mjs) from tests. When not enforced, the packager's
 * freshness gate is swapped for the committed bundle identity, so packaging
 * contracts still run on a branch whose derived files lag their source. */
export function runtimeBundlePackagingEnvironment(environment = process.env) {
	if (runtimeBundleEnforced(environment)) return environment;
	return {
		...environment,
		NODE_OPTIONS: [environment.NODE_OPTIONS, `--import=${committedPackaging}`].filter(Boolean).join(" "),
	};
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	if (process.argv.length > 2) throw new Error("Usage: runtime-bundle-release-train.mjs");
	const result = await checkRuntimeBundle();
	if (result.fresh) console.log(`Runtime bundle ${result.bundle.sha256}: verified`);
	else {
		console.log(
			`Runtime bundle ${result.committed.sha256}: not verified against source (${result.stale}); ${RUNTIME_BUNDLE_NOT_ENFORCED}`,
		);
	}
}
