import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
	CLOUD_RUNTIME_ERROR_CATEGORIES,
	CLOUD_RUNTIME_OPERATIONS,
} from "../packages/runtime/src/cloud-runtime-observability.ts";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const migrationsRoot = join(repositoryRoot, "supabase/migrations");
const FUNCTION = "function public.qorpera_record_runtime_observation(p_run_id uuid,p_observation jsonb)";

/** Quoted names inside the first parenthesised list that follows `marker`. */
function quotedList(source, marker) {
	const start = source.indexOf(marker);
	assert.notEqual(start, -1, `missing ${marker}`);
	const open = source.indexOf("(", start + marker.length);
	let depth = 0;
	for (let index = open; index < source.length; index += 1) {
		if (source[index] === "(") depth += 1;
		else if (source[index] === ")" && (depth -= 1) === 0) {
			return [...source.slice(open, index).matchAll(/'([a-z_]+)'/g)].map((match) => match[1]);
		}
	}
	throw new Error(`unterminated list after ${marker}`);
}

async function latestDefinition() {
	const names = (await readdir(migrationsRoot)).filter((name) => /^\d{14}_[a-z0-9_]+\.sql$/.test(name)).sort();
	let definition;
	for (const name of names) {
		const migration = await readFile(join(migrationsRoot, name), "utf8");
		const start = migration.indexOf(FUNCTION);
		if (start !== -1) {
			const end = migration.indexOf("$$;", start);
			assert(end > start, `Unrecognized observation definition in ${name}`);
			definition = { name, source: migration.slice(start, end + 3) };
		}
		if (!definition) continue;
		// Later migrations preserve ownership/ACLs by patching the live body.
		// Interpret only their literal, exactly-once replacements; the actual
		// PostgreSQL regression below remains the executable authority check.
		const patches = [];
		for (const match of migration.matchAll(/select pg_temp\.\w+\('public\.qorpera_record_runtime_observation\(uuid,jsonb\)'::regprocedure,\s*\$old\$([\s\S]*?)\$old\$,\s*\$new\$([\s\S]*?)\$new\$\);/g)) {
			patches.push([match.index, match[1], match[2]]);
		}
		for (const block of migration.matchAll(/do \$(\w+)\$([\s\S]*?)\$\1\$;/g)) {
			if (!block[2].includes("pg_get_functiondef('public.qorpera_record_runtime_observation(uuid,jsonb)'::regprocedure)")) continue;
			assert.match(block[2], /execute v_definition;/, `Unrecognized observation patch in ${name}`);
			for (const match of block[2].matchAll(/v_definition := pg_temp\.\w+\(v_definition,\s*\$old\$([\s\S]*?)\$old\$,\s*\$new\$([\s\S]*?)\$new\$\);/g)) {
				patches.push([block.index + match.index, match[1], match[2]]);
			}
		}
		for (const [, oldText, newText] of patches.sort((a, b) => a[0] - b[0])) {
			assert.equal(definition.source.split(oldText).length, 2, `Observation patch must match once in ${name}`);
			definition = { name, source: definition.source.replace(oldText, () => newText) };
		}
	}
	assert(definition, "no migration defines qorpera_record_runtime_observation");
	return definition;
}

// The runtime validates the same closed vocabulary before publishing; a name
// on one side only means live rows are rejected and dropped without a trace.
test("the newest SQL definition accepts exactly the TypeScript observation vocabulary", async () => {
	const { name, source } = await latestDefinition();
	const operations = quotedList(source, "p_observation ->> 'operation' not in");
	assert.deepEqual(new Set(operations), new Set(CLOUD_RUNTIME_OPERATIONS), `operations in ${name}`);
	assert.equal(operations.length, CLOUD_RUNTIME_OPERATIONS.length, `duplicate operations in ${name}`);
	const categories = quotedList(source, "p_observation ->> 'errorCategory' not in");
	assert.deepEqual(new Set(categories), new Set(CLOUD_RUNTIME_ERROR_CATEGORIES), `error categories in ${name}`);
});

test("the SQL regression test exercises every operation and error category", async () => {
	const source = await readFile(join(repositoryRoot, "supabase/tests/320_runtime_operational_observability.test.sql"), "utf8");
	for (const [variable, values] of [["v_operation", CLOUD_RUNTIME_OPERATIONS], ["v_category", CLOUD_RUNTIME_ERROR_CATEGORIES]]) {
		const marker = `foreach ${variable} in array array[`;
		const start = source.indexOf(marker);
		assert.notEqual(start, -1);
		const list = source.slice(start + marker.length, source.indexOf("]", start));
		const exercised = [...list.matchAll(/'([a-z_]+)'/g)].map((match) => match[1]);
		assert.deepEqual(new Set(exercised), new Set(values));
		assert.equal(exercised.length, values.length, `duplicate ${variable} fixture`);
	}
});
