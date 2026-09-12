import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runtimeManifestText } from "../../../scripts/generate-cloud-runtime-bundle.mjs";

/** Source identity is measured from the checkout rather than provided as a build label. */
export function webSourceProvenance(repositoryRoot, release = false) {
 const git = args => execFileSync("git", args, { cwd: repositoryRoot, encoding: "utf8" }).trim();
 const sourceCommit = git(["rev-parse", "HEAD"]);
 if (!/^[0-9a-f]{40}$/.test(sourceCommit)) throw new Error("Invalid web source commit");
 const changes = git(["status", "--porcelain", "--untracked-files=normal", "--", ".", ":(exclude)AGENTS.md"]);
 if (release && changes) throw new Error("A web release requires a clean source checkout");
 const bytes = readFileSync(join(repositoryRoot, "deploy/first-node/native-codex/runtime-bundle-manifest.json"));
 const bundle = JSON.parse(bytes);
 const runtimeBundleSha256 = createHash("sha256").update(runtimeManifestText(bundle)).digest("hex");
 const generated = readFileSync(join(repositoryRoot, "packages/runtime/src/cloud-runtime-bundle.generated.ts"), "utf8");
 if (!generated.includes(`export const CLOUD_RUNTIME_BUNDLE_SHA256 = "${runtimeBundleSha256}";`)) throw new Error("Runtime bundle identity differs from its manifest");
 return { sourceCommit, sourceDirty: Boolean(changes), runtimeBundleSha256,
 runtimeManifestSha256: createHash("sha256").update(bytes).digest("hex") };
}
