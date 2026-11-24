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
	"Usage: node scripts/package-cloud-secret-broker.mjs --out <new-directory> [--database-ca <file> --database-ca-sha256 <sha256>]";
const options = parseFlagMap(process.argv.slice(2), {
	allowed: ["--out", "--database-ca", "--database-ca-sha256"],
	usage,
});
if (!options.has("--out")) throw new Error(usage);
const ownCa = await loadDatabaseOwnCa(options.get("--database-ca"), options.get("--database-ca-sha256"));
const output = await prepareOutputDir(resolve(options.get("--out")), { mode: 0o700 });

await bundleNodeEntries({
	entries: [["packages/runtime/src/cloud-secret-broker-service-main.ts", "qorpera-cloud-secret-broker-service.mjs"]],
	outputRoot: output,
	banner: ESM_REQUIRE_BANNER,
});
const copied = [
	"deploy/cloud-secret-broker/qorpera-cloud-secret-broker.service",
	"deploy/cloud-secret-broker/qorpera-shared-vault.service",
	"deploy/cloud-secret-broker/shared-vault-secrets.py",
	"deploy/cloud-secret-broker/supabase-prod-ca-2021.crt",
];
await copyPackageFiles(copied, output);
const caFiles = await writeDatabaseOwnCaFiles(output, ownCa, [
	"# A drop-in for qorpera-cloud-secret-broker.service and qorpera-shared-vault.service: our own database CA and",
	"# its sha256 pin, with database-own-ca.crt and database-own-ca.sha256 beside the Supabase CA.",
	"[Service]",
	"LoadCredential=qorpera-cloud-secret-database-own-ca:/etc/qorpera-secret-broker/database-own-ca.crt",
	"LoadCredential=qorpera-cloud-secret-database-own-ca-sha256:/etc/qorpera-secret-broker/database-own-ca.sha256",
]);
const files = [
	"qorpera-cloud-secret-broker-service.mjs",
	"qorpera-cloud-secret-broker.service",
	"qorpera-shared-vault.service",
	"shared-vault-secrets.py",
	"supabase-prod-ca-2021.crt",
	...caFiles,
];
const artifacts = await hashPackageFiles(files, output);
await writeManifest(output, { schema: "qorpera.cloud-secret-broker-package/v1", artifacts }, { mode: 0o600 });
console.log(output);
