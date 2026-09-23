#!/usr/bin/env node
// Renders the governed connector catalog rows (Runtime Step 7) from the
// TypeScript definitions into the migration that ships them, and with --check
// refuses any drift between the two. A shipped migration is never edited for a
// changed operation: bump the operation version in the catalog and point
// CATALOG_MIGRATION at a new migration file instead.
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const CATALOG_MIGRATION = "supabase/migrations/20260922090000_cloud_connector_catalog.sql";
const BEGIN = "-- BEGIN GENERATED CONNECTOR CATALOG (scripts/generate-cloud-connector-catalog.mjs)";
const END = "-- END GENERATED CONNECTOR CATALOG";

function literal(value) {
	return `'${String(value).replace(/'/g, "''")}'`;
}

/** Renders the insert statement. Deterministic: catalog order, stable JSON. */
export async function renderCatalogSql() {
	const catalog = await import("../packages/runtime/src/cloud-connector-catalog.ts");
	const { parseCloudConnectorInputSchema } = await import("../packages/runtime/src/cloud-secret-tools.ts");
	const rows = catalog.cloudConnectorCatalogRows();
	const values = rows.map((row) => {
		// The runtime parses every schema from SQL with this exact parser; refuse
		// a definition it would reject before it reaches a migration.
		const schema = parseCloudConnectorInputSchema(row.inputSchema);
		return [
			literal(row.connectorId),
			literal(row.operationId),
			String(row.version),
			literal(row.toolName),
			literal(row.description),
			`${literal(JSON.stringify(schema))}::jsonb`,
			literal(row.destinationOrigin),
			literal(row.credentialName),
			literal(row.adapterSha256),
		].join(",");
	});
	return [
		BEGIN,
		`-- Catalog version ${catalog.CLOUD_CONNECTOR_CATALOG_VERSION}: ${rows.length} operations.`,
		"insert into public.qorpera_cloud_connector_operations",
		"\t(connector_id,operation_id,version,tool_name,description,input_schema,destination_origin,credential_name,adapter_sha256)",
		"values",
		values.map((value, index) => `\t(${value})${index === values.length - 1 ? ";" : ","}`).join("\n"),
		END,
	].join("\n");
}

export function spliceCatalog(migration, rendered) {
	const begin = migration.indexOf(BEGIN);
	const end = migration.indexOf(END);
	if (begin < 0 || end < begin) throw new Error(`${CATALOG_MIGRATION} has no generated catalog block`);
	return `${migration.slice(0, begin)}${rendered}${migration.slice(end + END.length)}`;
}

async function main(args) {
	const path = join(root, CATALOG_MIGRATION);
	const current = await readFile(path, "utf8");
	const next = spliceCatalog(current, await renderCatalogSql());
	if (args.includes("--check")) {
		if (next !== current) {
			console.error(`${CATALOG_MIGRATION} differs from packages/runtime/src/cloud-connector-catalog.ts; run npm run generate:connector-catalog`);
			process.exitCode = 1;
		}
		return;
	}
	if (next !== current) await writeFile(path, next);
	console.log(CATALOG_MIGRATION);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main(process.argv.slice(2)).catch((error) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	});
}
