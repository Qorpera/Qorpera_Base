import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// The GC runbook's read-only statements (deploy/first-node/gc/*.sql) run in production by hand; SQL test 917 runs a
// copy of each on a fixture. This keeps the copies equal to the files: every statement of each file appears in 917,
// verbatim, after `create temp table <name> as`.
const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const read = (path) => readFileSync(join(root, path), "utf8");

/** A file's statements: each blank-line block, without the comment lines that open it. */
function statements(source) {
	return source
		.split(/\n\s*\n/)
		.map((block) => {
			const lines = block.split("\n");
			while (lines.length && lines[0].startsWith("--")) lines.shift();
			return lines.join("\n").trim();
		})
		.filter(Boolean);
}

test("SQL test 917 runs every statement of the GC runbook's checks, verbatim", () => {
	const copies = read("supabase/tests/917_gc_runbook_checks.test.sql");
	for (const [path, count] of [
		["deploy/first-node/gc/artifact-gc-dry-run.sql", 5],
		["deploy/first-node/gc/folder-gc-checks.sql", 6],
	]) {
		const found = statements(read(path));
		assert.equal(found.length, count, `${path} holds ${count} statements`);
		for (const [index, statement] of found.entries()) {
			assert.ok(statement.endsWith(";"), `${path} statement ${index + 1} ends with a semicolon`);
			assert.ok(copies.includes(` as\n${statement}\n`), `${path} statement ${index + 1} is run by 917 as written`);
		}
	}
});
