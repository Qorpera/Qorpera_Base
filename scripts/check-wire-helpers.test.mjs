import assert from "node:assert/strict";
import { test } from "node:test";
import { countRepository, countSource, risen } from "./check-wire-helpers.mjs";

test("counts hand-written UUID patterns in every spelling and local wire helpers", () => {
	const text = [
		"const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;",
		"const ANY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;",
		"const MIXED = /^[0-9a-fA-F]{8}-/; const OTHER = /[a-f0-9]{8}-/; const TEXT = new RegExp('^[0-9a-f]{8}-');",
		"function record(value, label) {}",
		"export function uuid<T>(value: unknown): string {}",
		"async function sha256(bytes) {}",
		"const record = (value: unknown): Record<string, unknown> => value;",
		"const uuid: (value: unknown) => string = (value) => String(value);",
		"export const sha256 = function (value) {};",
		// Not definitions: calls, methods, other names, a hash of a value.
		"record(value, 'x'); this.uuid(); function recordValue() {} function parseUuid() {} const sha = sha256(x);",
		"class A { record(value) {} }",
	].join("\n");
	assert.deepEqual(countSource(text), { uuidPatterns: 5, recordHelpers: 2, uuidHelpers: 2, sha256Helpers: 2 });
});

test("a rise above the baseline fails; equal or lower passes; a new package counts from zero", () => {
	const baseline = { runtime: { uuidPatterns: 3, recordHelpers: 2, uuidHelpers: 1, sha256Helpers: 0 } };
	assert.deepEqual(risen({ runtime: { uuidPatterns: 3, recordHelpers: 1, uuidHelpers: 0, sha256Helpers: 0 } }, baseline), []);
	assert.deepEqual(risen({ runtime: { uuidPatterns: 4, recordHelpers: 2, uuidHelpers: 1, sha256Helpers: 0 } }, baseline), [
		{ package: "runtime", metric: "uuidPatterns", count: 4, allowed: 3 },
	]);
	assert.deepEqual(risen({ fresh: { uuidPatterns: 0, recordHelpers: 1, uuidHelpers: 0, sha256Helpers: 0 } }, baseline), [
		{ package: "fresh", metric: "recordHelpers", count: 1, allowed: 0 },
	]);
});

test("the shared module itself is not a copy", () => {
	const { files } = countRepository();
	assert.equal(files["packages/contracts/src/wire-values.ts"], undefined);
	assert.ok(Object.keys(files).every((path) => !path.includes("/node_modules/") && !path.includes(".generated.")));
});
