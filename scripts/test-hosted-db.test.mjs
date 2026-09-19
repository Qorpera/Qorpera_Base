import assert from "node:assert/strict";
import test from "node:test";
import {
	buildContainerName,
	expandTestFixture,
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

test("a test can run after another test's fixture section", () => {
	const files = {
		"300_base.test.sql": "begin;\nselect 1;\n-- END FIXTURE\nselect 2;\nrollback;\n",
		"370_next.test.sql": '-- @fixture 300_base.test.sql until "-- END FIXTURE"\nselect 3;\nrollback;\n',
		"380_self.test.sql": '-- @fixture 380_self.test.sql until "x"\n',
		"390_missing.test.sql": '-- @fixture 300_base.test.sql until "-- ABSENT"\n',
	};
	const read = (name) => files[name];
	assert.equal(expandTestFixture("300_base.test.sql", read), files["300_base.test.sql"]);
	assert.equal(expandTestFixture("370_next.test.sql", read), "begin;\nselect 1;\nselect 3;\nrollback;\n");
	files["fixtures/more.sql"] = "select 10;\n-- END MORE\nselect 11;\n";
	files["395_two.test.sql"] =
		'-- @fixture 300_base.test.sql until "-- END FIXTURE"\n-- @fixture fixtures/more.sql until "-- END MORE"\nselect 4;\n';
	assert.equal(expandTestFixture("395_two.test.sql", read), "begin;\nselect 1;\nselect 10;\nselect 4;\n");
	assert.throws(() => expandTestFixture("380_self.test.sql", read), /fixture is unavailable/);
	assert.throws(() => expandTestFixture("390_missing.test.sql", read), /fixture is unavailable/);
});
