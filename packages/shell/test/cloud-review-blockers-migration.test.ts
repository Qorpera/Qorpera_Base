import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migrationsDirectory = resolve(import.meta.dirname, "../../../supabase/migrations");
const hardeningMigration = resolve(migrationsDirectory, "20260817004000_review_blocker_hardening.sql");

describe("hosted cloud review blocker migrations", () => {
	it("assigns every migration one unique numeric version", async () => {
		const migrations = (await readdir(migrationsDirectory)).filter((name) => name.endsWith(".sql"));
		const versions = migrations.map((name) => name.slice(0, 14));
		expect(new Set(versions).size).toBe(versions.length);
		expect(migrations).toContain("20260816003500_profile_promotion_identity.sql");
		expect(migrations).not.toContain("20260816003000_profile_promotion_identity.sql");
	});

	it("enforces graph ownership and exact direct-object closure", async () => {
		const sql = await readFile(hardeningMigration, "utf-8");
		expect(sql).toContain("qorpera_object_root_creator");
		expect(sql).toContain("qorpera_object_graph_owner_guard");
		expect(sql).toContain("object reachability requires root-creator access");
		expect(sql).toContain("direct artifact reachability must contain exactly its root object");
		expect(sql).toContain("graph.closure_verified");
		expect(sql).toContain("manifest reachability closure is not server-verified");
	});

	it("clears abandoned attempt artifacts on requeue and lease recovery", async () => {
		const sql = await readFile(hardeningMigration, "utf-8");
		expect(sql).toContain("qorpera_clear_abandoned_runner_artifacts");
		expect(sql).toContain("new.attempt_count > old.attempt_count");
		expect(sql).toContain("new.status in ('queued', 'failed', 'cancelled')");
	});
});
