import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { hostedDatabase, MIGRATIONS, migrationNames } from "./test-hosted-db-cluster.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const databaseName = "qorpera_test";
const historyMigration = "20260913000400_runtime_room_history.sql";

async function main() {
	const migrations = migrationNames();
	if (!migrations.includes(historyMigration)) {
		throw new Error(`${historyMigration} is not in the migration chain`);
	}
	// Every migration before the history upgrade, each in its own session.
	const database = await hostedDatabase(databaseName, { before: historyMigration });
	try {
		// Then, in one session: the wake fixture, the upgrade fixture, the remaining migrations and the cases.
		const fixture = readFileSync(join(repositoryRoot, "supabase/tests/fixtures/runtime-room-history-seed.sql"), "utf8");
		const upgrade = readFileSync(join(repositoryRoot, "supabase/tests/fixtures/runtime-room-history-upgrade.sql"), "utf8");
		const cases = readFileSync(join(repositoryRoot, "supabase/tests/fixtures/runtime-room-history-cases.sql"), "utf8");
		const remaining = migrations.filter(name => name >= historyMigration).map(name => readFileSync(join(MIGRATIONS, name), "utf8")).join("\n");
		database.cluster.psql(databaseName, fixture + upgrade + "\n" + remaining + "\n" + cases + "\nrollback;\n");
		process.stdout.write(`Room history checks passed (${migrations.length} migrations; room admission, audience, immutable speaker, replay and historical upgrade)\n`);
	} finally {
		database.close();
	}
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
	await main();
}
