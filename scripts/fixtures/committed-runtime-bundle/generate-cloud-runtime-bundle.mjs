// Test and CI support only; production packaging never loads this module.
// Stands in for the generator inside scripts/package-ephemeral-runner.mjs when
// QORPERA_ENFORCE_RUNTIME_BUNDLE is not "1" (see ./register.mjs). The packager's
// check refuses derived files that lag their source; on a release-train feature
// branch they lag by design. Every other generator validation still runs, and
// the package records the committed bundle identity, which is exactly what the
// packaged native host embeds.
import { cloudRuntimeBundle } from "../../generate-cloud-runtime-bundle.mjs";
import { committedRuntimeBundle } from "../../runtime-bundle-release-train.mjs";

export * from "../../generate-cloud-runtime-bundle.mjs";

export async function generateCloudRuntimeBundle(check = false, root = undefined) {
	if (check !== true) throw new Error("Unenforced packaging never writes the derived runtime bundle files");
	await cloudRuntimeBundle(root);
	return committedRuntimeBundle(root);
}
