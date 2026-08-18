import assert from "node:assert/strict";
import test from "node:test";
import {
	buildContainerName,
	POSTGRES_IMAGE,
	sortMigrationNames,
} from "./test-hosted-db.mjs";

test("sorts hosted migrations and rejects duplicate versions", () => {
	assert.deepEqual(
		sortMigrationNames([
			"README.md",
			"20260817001000_second.sql",
			"20260816001000_first.sql",
		]),
		["20260816001000_first.sql", "20260817001000_second.sql"],
	);
	assert.throws(
		() => sortMigrationNames(["20260816001000_first.sql", "20260816001000_second.sql"]),
		/Duplicate migration version 20260816001000/,
	);
});

test("uses an exact temporary container identity and digest-pinned image", () => {
	assert.equal(buildContainerName(42, "0123abcd"), "qorpera-hosted-db-42-0123abcd");
	assert.match(POSTGRES_IMAGE, /^docker\.io\/library\/postgres:[^@]+@sha256:[0-9a-f]{64}$/);
	assert.throws(() => buildContainerName(42, "../escape"), /Invalid hosted database container identity/);
});
