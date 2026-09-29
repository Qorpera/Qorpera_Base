import { describe, expect, it } from "vitest";
import {
	isUuid,
	normalizeUuid,
	parseBoundedText,
	parseClosedRecord,
	parseInteger,
	parseRecord,
	parseSha256Hex,
	parseTimestamp,
	parseUuid,
	UUID_PATTERN,
	WireValueError,
} from "../src/index.ts";

const lower = "0f5d6a1e-7c1b-4a6e-9f10-2b3c4d5e6f70";

describe("wire values", () => {
	it("takes a UUID in either letter case only where it hands back the lower case the database prints", () => {
		expect(parseUuid(lower, "id")).toBe(lower);
		expect(parseUuid(lower.toUpperCase(), "id")).toBe(lower);
		expect(parseUuid("0F5d6A1e-7C1b-4A6e-9F10-2b3C4d5E6f70", "id")).toBe(lower);
		expect(normalizeUuid(lower)).toBe(lower);
		expect(normalizeUuid(lower.toUpperCase())).toBe(lower);
		expect(parseUuid("0f5d6a1e-7c1b-7a6e-9f10-2b3c4d5e6f70", "id")).toBe("0f5d6a1e-7c1b-7a6e-9f10-2b3c4d5e6f70");
	});

	it("never passes upper case through a check that returns the value unchanged", () => {
		expect(isUuid(lower)).toBe(true);
		expect(UUID_PATTERN.test(lower)).toBe(true);
		for (const value of [lower.toUpperCase(), "0F5d6A1e-7C1b-4A6e-9F10-2b3C4d5E6f70"]) {
			expect(isUuid(value)).toBe(false);
			expect(UUID_PATTERN.test(value)).toBe(false);
		}
		expect(UUID_PATTERN.flags).toBe("");
	});

	it.each([
		["no hyphens", "0f5d6a1e7c1b4a6e9f102b3c4d5e6f70"],
		["braces", `{${lower}}`],
		["a leading space", ` ${lower}`],
		["a trailing space", `${lower} `],
		["a trailing newline", `${lower}\n`],
		["version 0", "0f5d6a1e-7c1b-0a6e-9f10-2b3c4d5e6f70"],
		["version 9", "0f5d6a1e-7c1b-9a6e-9f10-2b3c4d5e6f70"],
		["an NCS variant", "0f5d6a1e-7c1b-4a6e-7f10-2b3c4d5e6f70"],
		["a Microsoft variant", "0f5d6a1e-7c1b-4a6e-cf10-2b3c4d5e6f70"],
		["the nil UUID", "00000000-0000-0000-0000-000000000000"],
		["the max UUID", "ffffffff-ffff-ffff-ffff-ffffffffffff"],
		["a non-hex letter", "0f5d6a1e-7c1b-4a6e-9f10-2b3c4d5e6f7g"],
		["a Cyrillic look-alike", "0f5d6а1e-7c1b-4a6e-9f10-2b3c4d5e6f70"],
		["a fullwidth digit", "０f5d6a1e-7c1b-4a6e-9f10-2b3c4d5e6f70"],
		["a number", 7],
		["null", null],
	])("refuses %s as a UUID", (_label, value) => {
		expect(isUuid(value)).toBe(false);
		expect(normalizeUuid(value)).toBeNull();
		expect(() => parseUuid(value, "Run id")).toThrow(new WireValueError("Run id"));
	});

	it("takes SHA-256 digests only as lower-case hex, the way they are compared", () => {
		const digest = "a".repeat(64);
		expect(parseSha256Hex(digest, "digest")).toBe(digest);
		for (const value of ["A".repeat(64), "a".repeat(63), "a".repeat(65), `${"a".repeat(63)}g`, 1])
			expect(() => parseSha256Hex(value, "digest")).toThrow(WireValueError);
	});

	it("checks plain and closed objects", () => {
		expect(parseRecord({ a: 1 }, "body")).toEqual({ a: 1 });
		for (const value of [null, [], "x", 1, undefined])
			expect(() => parseRecord(value, "body")).toThrow("body is invalid");
		expect(parseClosedRecord({ a: 1, b: 2 }, "body", ["a"], ["b"])).toEqual({ a: 1, b: 2 });
		expect(parseClosedRecord({ a: 1 }, "body", ["a"], ["b"])).toEqual({ a: 1 });
		expect(() => parseClosedRecord({ a: 1, c: 3 }, "body", ["a"], ["b"])).toThrow("body has an unknown field");
		expect(() => parseClosedRecord({ b: 2 }, "body", ["a"], ["b"])).toThrow("body is missing a");
		// An inherited key is not a field.
		expect(() => parseClosedRecord(Object.create({ a: 1 }), "body", ["a"])).toThrow("body is missing a");
	});

	it("bounds text and integers", () => {
		expect(parseBoundedText("hello", "name", 5)).toBe("hello");
		expect(parseBoundedText("  ", "note", 5, 0)).toBe("  ");
		for (const value of ["hello!", "   ", "a\0b", 5])
			expect(() => parseBoundedText(value, "name", 5)).toThrow(WireValueError);
		expect(parseInteger(3, "count", 0, 3)).toBe(3);
		for (const value of [4, -1, 1.5, "3", Number.MAX_SAFE_INTEGER + 1])
			expect(() => parseInteger(value, "count", 0, 3)).toThrow(WireValueError);
	});

	it("reads a time with an explicit offset, in ISO 8601 or PostgreSQL's text form", () => {
		const at = (value: string) => parseTimestamp(value, "at").date.toISOString();
		expect(at("2026-09-29T10:00:00Z")).toBe("2026-09-29T10:00:00.000Z");
		expect(at("2026-09-29T10:00:00+02:00")).toBe("2026-09-29T08:00:00.000Z");
		expect(at("2026-09-29T10:00:00.5-05:30")).toBe("2026-09-29T15:30:00.500Z");
		expect(at("2026-09-29 10:00:00+00")).toBe("2026-09-29T10:00:00.000Z");
		expect(at("2026-09-29 00:30:00.25+01")).toBe("2026-09-28T23:30:00.250Z");
		expect(at("2024-02-29t23:59:59.999z")).toBe("2024-02-29T23:59:59.999Z");
		expect(parseTimestamp("2026-09-29 10:00:00+00", "at").text).toBe("2026-09-29 10:00:00+00");
	});

	it.each([
		["a bare number", "1"],
		["a year", "2026"],
		["epoch milliseconds", "1790676000000"],
		["a date without a time", "2026-09-29"],
		["a time without an offset", "2026-09-29T10:00:00"],
		["a space-separated time without an offset", "2026-09-29 10:00:00.123456"],
		["words", "Sep 29 2026 10:00:00 GMT"],
		["a day the month lacks", "2026-02-30T10:00:00Z"],
		["hour 24", "2026-09-29T24:00:00Z"],
		["a leap second", "2026-12-31T23:59:60Z"],
		["an offset without its colon", "2026-09-29T10:00:00+0200"],
		["surrounding space", " 2026-09-29T10:00:00Z"],
		["an empty string", ""],
		["an over-long string", `2026-09-29T10:00:00.${"1".repeat(60)}Z`],
		["a number", 0],
	])("refuses %s as a time", (_label, value) => {
		expect(() => parseTimestamp(value, "at")).toThrow(new WireValueError("at"));
	});

	it("gives the same instant whatever the host's time zone", () => {
		const before = process.env.TZ;
		const seen = new Set<number>();
		try {
			for (const zone of ["UTC", "Europe/Copenhagen", "America/Los_Angeles", "Asia/Kolkata"]) {
				process.env.TZ = zone;
				seen.add(parseTimestamp("2026-09-29T10:00:00+02:00", "at").date.getTime());
				seen.add(parseTimestamp("2026-09-29 08:00:00+00", "at").date.getTime());
			}
		} finally {
			if (before === undefined) Reflect.deleteProperty(process.env, "TZ");
			else process.env.TZ = before;
		}
		expect([...seen]).toEqual([Date.UTC(2026, 8, 29, 8)]);
	});

	it("keeps PostgreSQL's microseconds, so a keyset cursor returns exactly the next page", () => {
		const parsed = parseTimestamp("2026-09-29T10:00:00.123456+00:00", "at");
		expect(parsed.text).toBe("2026-09-29T10:00:00.123456+00:00");
		expect(parsed.date.toISOString()).toBe("2026-09-29T10:00:00.123Z");
		// Proposals created in one transaction a microsecond apart, paged newest first on (created_at, id)
		// with the page's oldest created_at as the next cursor, as qorpera_list_company_proposals does.
		const micros = (text: string) => {
			const fraction = (/\.(\d+)/.exec(text)?.[1] ?? "").padEnd(6, "0").slice(0, 6);
			return BigInt(Date.parse(text.replace(/\.\d+/, ""))) * 1000n + BigInt(fraction);
		};
		const rows = ["123457", "123456", "123455"].map((fraction, index) => ({
			id: `0f5d6a1e-7c1b-4a6e-9f10-2b3c4d5e6f7${index}`,
			created_at: `2026-09-29T10:00:00.${fraction}+00:00`,
		}));
		const page = (after?: { createdAt: string; id: string }) =>
			rows
				.filter(
					(row) =>
						after === undefined ||
						micros(row.created_at) < micros(after.createdAt) ||
						(micros(row.created_at) === micros(after.createdAt) && row.id < after.id),
				)
				.slice(0, 2);
		const first = page();
		const last = first.at(-1);
		if (last === undefined) throw new Error("no first page");
		const cursor = parseTimestamp(last.created_at, "next_created_at");
		expect(page({ createdAt: cursor.text, id: last.id }).map((row) => row.id)).toEqual([rows[2]?.id]);
		// The millisecond instant alone would skip the third proposal.
		expect(page({ createdAt: cursor.date.toISOString(), id: last.id })).toEqual([]);
	});

	it("never puts the refused value in its message", () => {
		const secret = "sk-live-PRIVATE-value";
		for (const check of [
			() => parseUuid(secret, "Run id"),
			() => parseSha256Hex(secret, "digest"),
			() => parseBoundedText(secret, "name", 3),
			() => parseTimestamp(secret, "at"),
		]) {
			expect(check).toThrow(WireValueError);
			try {
				check();
			} catch (error) {
				expect((error as Error).message).not.toContain(secret);
			}
		}
	});
});
