import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	bundleNodeEntries,
	ESM_REQUIRE_BANNER,
	hashPackageFiles,
	parseOutArg,
	prepareOutputDir,
	REPOSITORY_ROOT,
	writeManifest,
} from "./package-service.mjs";

const output = await prepareOutputDir(
	parseOutArg(process.argv.slice(2), {
		usage: "Usage: node scripts/package-company-data-gateway.mjs --out <new-directory>",
	}),
	{ mode: 0o755 },
);
const file = "qorpera-company-data-gateway.mjs";
await bundleNodeEntries({
	entries: [["deploy/company-data/kit/gateway-main.mjs", file]],
	outputRoot: output,
	target: "node24.21",
	external: ["pg-native"],
	banner: ESM_REQUIRE_BANNER,
});
const artifacts = await hashPackageFiles([file], output);
await writeFile(join(output, `${file}.sha256`), `${artifacts[0].sha256}  ${file}\n`, { mode: 0o644, flag: "wx" });
const pg = JSON.parse(await readFile(join(REPOSITORY_ROOT, "node_modules/pg/package.json"), "utf8")).version;
await writeManifest(
	output,
	{ schema: "qorpera.company-data-gateway-package/v1", pg, artifacts },
	{ mode: 0o644, flag: "wx" },
);
console.log(output);
