import { describe, expect, it } from "vitest";
import {
	CODING_FOLDER_SECRET_MAX_BYTES,
	CODING_FOLDER_SECRET_VALUES_MAX,
	CodingFolderSecretKey,
} from "../src/coding-folder-secrets.ts";

// The key 0..31, as the folder service's vectors take it (object-gateway test/secret-scan.test.ts).
const KEY = Buffer.from(Array.from({ length: 32 }, (_, i) => i));

describe("a coding machine's secret values as keyed hashes (5j-5 (a))", () => {
	it("hashes each value as the folder service checks it: its pinned vectors", () => {
		const { set, omitted } = new CodingFolderSecretKey(KEY).set(["test-value-0001", "tëst-välue-ø2", "12345678"]);
		expect(set).toEqual({
			key: KEY.toString("base64url"),
			values: [
				{ length: 15, start: 629920, whole: "5X_nxV1CHyqs5ZYNTg0gzw" },
				{ length: 16, start: 509688, whole: "xBn2UbqRMZ5bn2atiZ2EMQ" },
				{ length: 8, start: 482076, whole: "2qRGAeL827FEO7IY3r5SvQ" },
			],
		});
		expect(omitted).toBe(0);
		expect(JSON.stringify(set)).not.toMatch(/test-value|välue|12345678/);
	});

	it("takes each value once, and the same set again under the same key", () => {
		const key = new CodingFolderSecretKey(KEY);
		const once = key.set(["test-value-0001"]).set;
		expect(key.set(["test-value-0001", "test-value-0001"]).set).toEqual(once);
		expect(key.set(["test-value-0001"]).set).toEqual(once);
	});

	it("counts the values the service could not take, which no save is checked for", () => {
		const key = new CodingFolderSecretKey(KEY);
		const longest = "x".repeat(CODING_FOLDER_SECRET_MAX_BYTES);
		const { set, omitted } = key.set(["short", longest, `${longest}y`]);
		expect(set.values.map((value) => value.length)).toEqual([CODING_FOLDER_SECRET_MAX_BYTES]);
		expect(omitted).toBe(2);
		const many = Array.from({ length: CODING_FOLDER_SECRET_VALUES_MAX + 3 }, (_, i) => `secret-value-${i}`);
		const most = key.set(many);
		expect(most.set.values).toHaveLength(CODING_FOLDER_SECRET_VALUES_MAX);
		expect(most.omitted).toBe(3);
		expect(key.set([]).set.values).toEqual([]);
	});

	it("makes a key of its own each time, of 32 bytes", () => {
		const one = new CodingFolderSecretKey().set(["test-value-0001"]).set;
		const two = new CodingFolderSecretKey().set(["test-value-0001"]).set;
		expect(Buffer.from(one.key, "base64url")).toHaveLength(32);
		expect(one.key).not.toBe(two.key);
		expect(one.values[0]?.whole).not.toBe(two.values[0]?.whole);
		expect(() => new CodingFolderSecretKey(Buffer.alloc(31))).toThrow("A folder secret key is 32 bytes");
	});
});
