// Release train guard (deploy/first-node/RUNTIME-RELEASE-TRAIN.md): only a
// release/runtime-vNNN branch may declare a runtime bundle version or change
// the files derived from it. CI runs this on every other pull request, against
// the pull request merge commit and its base parent:
//   node scripts/check-release-train-derived-files.mjs <base> <head>
// It reads the git repository in the current directory.
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const RELEASE_OWNED_FILES = Object.freeze([
	"packages/runtime/src/cloud-runtime-bundle.generated.ts",
	"deploy/first-node/native-codex/runtime-bundle-manifest.json",
	"deploy/first-node/native-codex/guest-package-manifest.json",
]);
const activationMigration = /^supabase\/migrations\/[^/]+_runtime_bundle_activation(?:_v\d+)?\.sql$/;
const generator = "scripts/generate-cloud-runtime-bundle.mjs";
const versionLine =
	/^\s*(?:export\s+)?(?:const|let|var)\s+(?:activation|activationVersion|previousActivationVersion|previousActivationSha256)\b.*$/gm;

/** Release-owned paths among `changed`; the generator counts only when its set
 * of bundle version lines (each trimmed) differs between the two texts. */
export function releaseTrainViolations(changed, generatorBefore, generatorAfter) {
	const violations = changed.filter((path) => RELEASE_OWNED_FILES.includes(path) || activationMigration.test(path));
	const lines = (text) => ((text ?? "").match(versionLine) ?? []).map((line) => line.trim()).join("\n");
	if (changed.includes(generator) && lines(generatorBefore) !== lines(generatorAfter)) {
		violations.push(`${generator} (bundle version lines)`);
	}
	return violations;
}

function git(args) {
	return execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

function fileAt(commit, path) {
	const listed = git(["ls-tree", "--name-only", commit, "--", path]).trim();
	return listed === path ? git(["show", `${commit}:${path}`]) : null;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const [base, head, ...rest] = process.argv.slice(2);
	if (!base || !head || rest.length > 0) throw new Error("Usage: check-release-train-derived-files.mjs <base> <head>");
	const [baseCommit, headCommit] = [base, head].map((ref) => git(["rev-parse", "--verify", `${ref}^{commit}`]).trim());
	const changed = git(["diff", "--name-only", "--no-renames", "-z", baseCommit, headCommit])
		.split("\0")
		.filter(Boolean);
	const violations = releaseTrainViolations(changed, fileAt(baseCommit, generator), fileAt(headCommit, generator));
	if (violations.length > 0) {
		console.error(
			[
				"Only a release/runtime-vNNN branch may declare a runtime bundle version or change its derived files.",
				"This pull request changes:",
				...violations.map((path) => `  ${path}`),
				"Drop these changes; the coordinator's release branch regenerates and pins them.",
				"See deploy/first-node/RUNTIME-RELEASE-TRAIN.md.",
			].join("\n"),
		);
		process.exitCode = 1;
	} else {
		console.log(`No release-owned runtime bundle files changed (${changed.length} files checked).`);
	}
}
