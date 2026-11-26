import { resolve } from "node:path";
import {
	bundleNodeEntries,
	copyPackageFiles,
	ESM_REQUIRE_BANNER,
	hashPackageFiles,
	loadDatabaseOwnCa,
	parseFlagMap,
	prepareOutputDir,
	writeDatabaseOwnCaFiles,
	writeManifest,
} from "./package-service.mjs";

const usage =
	"Usage: node scripts/package-agent-exit-rules.mjs --out <new-directory> [--database-ca <file> --database-ca-sha256 <sha256>]";
const options = parseFlagMap(process.argv.slice(2), {
	allowed: ["--out", "--database-ca", "--database-ca-sha256"],
	usage,
});
if (!options.has("--out")) throw new Error(usage);
const ownCa = await loadDatabaseOwnCa(options.get("--database-ca"), options.get("--database-ca-sha256"));
const output = await prepareOutputDir(resolve(options.get("--out")), { mode: 0o700 });

await bundleNodeEntries({
	entries: [["packages/runtime/src/agent-exit-rules-main.ts", "qorpera-agent-exit-rules.mjs"]],
	outputRoot: output,
	banner: ESM_REQUIRE_BANNER,
});
await copyPackageFiles(["deploy/agent-exit/qorpera-agent-exit-rules.service"], output);
const caFiles = await writeDatabaseOwnCaFiles(output, ownCa);
const files = ["qorpera-agent-exit-rules.mjs", "qorpera-agent-exit-rules.service", ...caFiles];
const artifacts = await hashPackageFiles(files, output);
await writeManifest(output, { schema: "qorpera.agent-exit-rules-package/v1", artifacts }, { mode: 0o600 });
console.log(output);
