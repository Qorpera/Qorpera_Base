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
	`\\bcreate\\s+(?:or\\s+replace\\s+)?function\\s+(?:public\\.)?${NAME}\\s*` +
		"\\(\\s*p_run_id\\s+uuid\\s*,\\s*p_observation\\s+jsonb\\s*\\)",
	"i",
);
/** The quoted regprocedure a patch reads the live definition through. */
const SIGNATURE = new RegExp(`'(?:public\\.)?${NAME}\\s*\\(\\s*uuid\\s*,\\s*jsonb\\s*\\)'`, "i");
const QUOTED_SIGNATURE = /'(?:[a-z_][a-z0-9_]*\.)?[a-z_][a-z0-9_]*\s*\([^()']*\)'/gi;
/** Anything that can create or rewrite a function. */
const CHANGES_CODE = /\bpg_temp\.|\bcreate\s+(?:or\s+replace\s+)?function\b|\bexecute\b/i;
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

/**
 * Top-level statements with their comments removed; quoted text and
 * dollar-quoted bodies stay whole. Two spellings are not parsed: E'…\'…'
 * backslash escapes and nested block comments. Both throw here instead of
 * being split wrongly, so they fail the check rather than pass it.
 */
function statements(source, name) {
	const result = [];
	const skipTo = (index, text) => {
		const end = source.indexOf(text, index);
		if (end === -1) throw new Error(`unterminated ${text} in ${name}`);
		return end + text.length;
	};
	let statement = "";
	let start = 0;
	let index = 0;
	while (index < source.length) {
		const character = source[index];
		DOLLAR_TAG.lastIndex = index;
		const tag = character === "$" ? DOLLAR_TAG.exec(source)?.[0] : undefined;
		const block = source.startsWith("/*", index);
		if (block || source.startsWith("--", index)) {
			let end = source.length;
			if (block) end = skipTo(index + 2, "*/");
			else if (source.includes("\n", index)) end = skipTo(index, "\n");
			if (block && source.slice(index + 2, end).includes("/*")) throw new Error(`nested block comment in ${name}`);
			statement += `${source.slice(start, index)} `;
			start = index = end;
		} else if (character === "'" && /[Ee]/.test(source[index - 1] ?? "") && !/\w/.test(source[index - 2] ?? "")) {
			throw new Error(`E'' string in ${name}`);
		} else if (character === "'" || character === '"') index = skipTo(index + 1, character);
		else if (tag) index = skipTo(index + tag.length, tag);
		else if (character === ";") {
			result.push(statement + source.slice(start, index));
			statement = "";
			start = index += 1;
		} else index += 1;
	}
	statement += source.slice(start);
	if (statement.trim()) result.push(statement);
	return result;
}

/** The newest migration that fully defines the function, and every one after it that names it. */
async function readMigrations() {
	const names = (await readdir(migrationsRoot)).filter((name) => /^\d{14}_[a-z0-9_]+\.sql$/.test(name)).sort();
	const migrations = [];
	for (const name of names.toReversed()) {
		const source = await readFile(join(migrationsRoot, name), "utf8");
		if (!source.toLowerCase().includes(NAME)) continue;
		const migration = { name, statements: statements(source, name) };
		migrations.unshift(migration);
		if (migration.statements.some((statement) => DEFINITION.test(statement))) break;
	}
	return migrations;
}

/**
 * The function as the migrations leave it: the newest full definition, then
 * every later in-place patch ($old$ -> $new$ against pg_get_functiondef of the
 * quoted signature), applied in migration order with the same exactly-once
 * rule the SQL helpers enforce. Any other statement that names the function
 * and could create or rewrite code fails; grants, revokes, comments and
 * activation guards (position(... pg_get_functiondef(...))) pass.
 */
function effectiveDefinition(migrations) {
	let definition = "";
	const applied = [];
	for (const { name, statements } of migrations) {
		for (const statement of statements) {
			if (!statement.toLowerCase().includes(NAME)) continue;
			if (DEFINITION.test(statement)) {
				definition = statement;
				applied.splice(0, applied.length, name);
				continue;
			}
			const pairs = SIGNATURE.test(statement) ? [...statement.matchAll(PATCH_PAIR)] : [];
			if (!pairs.length) {
				assert.doesNotMatch(
					statement.replace(/\b(?:grant|revoke)\s+execute\b/gi, ""),
					CHANGES_CODE,
					`unrecognised change to ${NAME} in ${name}`,
				);
				continue;
			}
			assert.equal(statement.match(QUOTED_SIGNATURE)?.length, 1, `a patch in ${name} must target ${NAME} alone`);
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

function assertVocabulary(migrations) {
	const { definition, sources } = effectiveDefinition(migrations);
	const operations = quotedList(definition, "p_observation ->> 'operation' not in");
	assert.deepEqual(new Set(operations), new Set(CLOUD_RUNTIME_OPERATIONS), `operations in ${sources}`);
	assert.equal(operations.length, CLOUD_RUNTIME_OPERATIONS.length, `duplicate operations in ${sources}`);
	const categories = quotedList(definition, "p_observation ->> 'errorCategory' not in");
	assert.deepEqual(new Set(categories), new Set(CLOUD_RUNTIME_ERROR_CATEGORIES), `error categories in ${sources}`);
	assert.equal(categories.length, CLOUD_RUNTIME_ERROR_CATEGORIES.length, `duplicate error categories in ${sources}`);
}

// The runtime validates the same closed vocabulary before publishing; a name
// on one side only means live rows are rejected and dropped without a trace.
test("the migrated SQL definition accepts exactly the TypeScript observation vocabulary", async () => {
	assertVocabulary(await readMigrations());
});

test("a later migration the check cannot see past fails it", async (t) => {
	const migrations = await readMigrations();
	const LATER = "20991231000000_later.sql";
	const withLater = (sql) => [...migrations, { name: LATER, statements: statements(sql, LATER) }];
	const base = migrations[0].statements.find((statement) => DEFINITION.test(statement));

	await t.test("a re-statement with a spaced signature is the new definition", () => {
		// Spaced signature, and one operation fewer than the TypeScript list.
		const spaced = base.replace("(p_run_id uuid,p_observation jsonb)", "( p_run_id uuid, p_observation jsonb )");
		const restated = spaced.replace("not in ('model_turn',", "not in (");
		assert.ok(spaced !== base && restated !== spaced);
		assert.throws(() => assertVocabulary(withLater(`${restated};`)), {
			message: /^operations in 20991231000000_later\.sql(\n|$)/,
		});
	});

	await t.test("a patch through a spaced signature is applied", () => {
		const patch = `select pg_temp.dynamic_patch('public.${NAME}(uuid, jsonb)'::regprocedure,
	$old$'manage_routine','decide_routine','report_work'$old$,
	$new$'manage_routine','report_work'$new$);`;
		assert.throws(() => assertVocabulary(withLater(patch)), {
			message: /^operations in \S+( \+ \S+)* \+ 20991231000000_later\.sql(\n|$)/,
		});
	});

	await t.test("a rewrite found through pg_proc.proname is refused", () => {
		const rewrite = `do $$
declare v_definition text;
begin
	select pg_get_functiondef(p.oid) into v_definition from pg_proc p where p.proname = '${NAME}';
	execute replace(v_definition, '''decide_routine'',', '');
end
$$;`;
		assert.throws(() => assertVocabulary(withLater(rewrite)), {
			message: /^unrecognised change to qorpera_record_runtime_observation in 20991231000000_later\.sql(\n|$)/,
		});
	});
});

test("the statement splitter throws on what it does not parse", () => {
	const parsed = statements("select 'a;b' /* c; */ -- d;\n;select $x$;$x$", "ok.sql");
	assert.deepEqual(
		parsed.map((statement) => statement.trim()),
		["select 'a;b'", "select $x$;$x$"],
	);
	assert.throws(() => statements("select E'it\\'s; drop';", "e.sql"), /^Error: E'' string in e\.sql$/);
	assert.throws(() => statements("/* a /* b */ c; */ select 1;", "nested.sql"), /^Error: nested block comment/);
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
