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
const NAME = "qorpera_record_runtime_observation";
const DEFINITION = new RegExp(
	`\\bcreate\\s+(?:or\\s+replace\\s+)?function\\s+public\\.${NAME}\\(p_run_id uuid,p_observation jsonb\\)`,
	"i",
);
const REFERENCE = `'public.${NAME}(uuid,jsonb)'`;
const DOLLAR_TAG = /\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/y;
const PATCH_PAIR = /\$old\$([\s\S]*?)\$old\$\s*,\s*\$new\$([\s\S]*?)\$new\$/g;

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

/** Top-level statements; quoted text, dollar-quoted bodies and comments stay whole. */
function statements(source, name) {
	const result = [];
	const skipTo = (index, text) => {
		const end = source.indexOf(text, index);
		if (end === -1) throw new Error(`unterminated ${text} in ${name}`);
		return end + text.length;
	};
	let start = 0;
	let index = 0;
	while (index < source.length) {
		const character = source[index];
		DOLLAR_TAG.lastIndex = index;
		const tag = character === "$" ? DOLLAR_TAG.exec(source)?.[0] : undefined;
		if (source.startsWith("--", index)) index = source.includes("\n", index) ? skipTo(index, "\n") : source.length;
		else if (source.startsWith("/*", index)) index = skipTo(index + 2, "*/");
		else if (character === "'" || character === '"') index = skipTo(index + 1, character);
		else if (tag) index = skipTo(index + tag.length, tag);
		else if (character === ";") {
			result.push(source.slice(start, index));
			start = index += 1;
		} else index += 1;
	}
	if (source.slice(start).trim()) result.push(source.slice(start));
	return result;
}

/**
 * The function as the migrations leave it: the newest full definition, then
 * every later in-place patch ($old$ -> $new$ against pg_get_functiondef),
 * applied in migration order with the same exactly-once rule the SQL helpers
 * enforce. A statement that looks like a patch in any other shape fails.
 */
async function effectiveDefinition() {
	const names = (await readdir(migrationsRoot)).filter((name) => /^\d{14}_[a-z0-9_]+\.sql$/.test(name)).sort();
	// Only the newest defining migration and the ones after it can matter.
	const migrations = [];
	for (const name of names.toReversed()) {
		const source = await readFile(join(migrationsRoot, name), "utf8");
		if (source.includes(NAME)) migrations.unshift({ name, source });
		if (DEFINITION.test(source)) break;
	}
	let definition;
	const applied = [];
	for (const { name, source } of migrations) {
		for (const statement of statements(source, name)) {
			if (DEFINITION.test(statement)) {
				definition = statement;
				applied.length = 0;
				applied.push(name);
				continue;
			}
			if (!statement.includes(REFERENCE)) continue;
			const pairs = [...statement.matchAll(PATCH_PAIR)];
			if (!pairs.length) {
				assert.doesNotMatch(statement, /\bpg_temp\.|\bexecute\b/i, `unrecognised patch of ${NAME} in ${name}`);
				continue;
			}
			assert.equal(
				statement.match(/'public\.[a-z_]+\([^)]*\)'/g)?.length,
				1,
				`a patch in ${name} must target ${NAME} alone`,
			);
			assert.ok(definition, `${name} patches ${NAME} before any migration defines it`);
			for (const [, before, after] of pairs) {
				assert.equal(definition.split(before).length - 1, 1, `${name}: patch text must occur once: ${before}`);
				definition = definition.replace(before, () => after);
			}
			applied.push(name);
		}
	}
	assert.ok(definition, `no migration defines ${NAME}`);
	return { definition, sources: applied.join(" + ") };
}

// The runtime validates the same closed vocabulary before publishing; a name
// on one side only means live rows are rejected and dropped without a trace.
test("the migrated SQL definition accepts exactly the TypeScript observation vocabulary", async () => {
	const { definition, sources } = await effectiveDefinition();
	const operations = quotedList(definition, "p_observation ->> 'operation' not in");
	assert.deepEqual(new Set(operations), new Set(CLOUD_RUNTIME_OPERATIONS), `operations in ${sources}`);
	assert.equal(operations.length, CLOUD_RUNTIME_OPERATIONS.length, `duplicate operations in ${sources}`);
	const categories = quotedList(definition, "p_observation ->> 'errorCategory' not in");
	assert.deepEqual(new Set(categories), new Set(CLOUD_RUNTIME_ERROR_CATEGORIES), `error categories in ${sources}`);
	assert.equal(categories.length, CLOUD_RUNTIME_ERROR_CATEGORIES.length, `duplicate error categories in ${sources}`);
});

test("the SQL regression test exercises every operation", async () => {
	const source = await readFile(join(repositoryRoot, "supabase/tests/320_runtime_operational_observability.test.sql"), "utf8");
	const marker = "foreach v_operation in array array[";
	const start = source.indexOf(marker);
	assert.notEqual(start, -1);
	const list = source.slice(start + marker.length, source.indexOf("]", start));
	const exercised = [...list.matchAll(/'([a-z_]+)'/g)].map((match) => match[1]);
	assert.deepEqual(new Set(exercised), new Set(CLOUD_RUNTIME_OPERATIONS));
});
