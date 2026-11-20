import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migrationsDirectory = resolve(import.meta.dirname, "../../../supabase/migrations");

describe("hosted cloud review blocker migrations", () => {
	it("assigns every migration one unique numeric version", async () => {
		const migrations = (await readdir(migrationsDirectory)).filter((name) => name.endsWith(".sql"));
		const versions = migrations.map((name) => name.slice(0, 14));
		expect(new Set(versions).size).toBe(versions.length);
	});
});
