import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migrationPath = resolve(
	import.meta.dirname,
	"../../../supabase/migrations/20260817002000_runner_usage_observations.sql",
);

describe("runner usage migration", () => {
	it("keeps immutable execution facts separate from billing attribution", async () => {
		const sql = await readFile(migrationPath, "utf-8");
		expect(sql).toContain("create table public.qorpera_runner_usage_observations");
		expect(sql).toContain("job_id uuid not null unique");
		expect(sql).toContain("actor_user_id uuid not null");
		expect(sql).not.toContain("billing_account_id");
		expect(sql).toContain("alter table public.qorpera_runner_usage_observations enable row level security");
		expect(sql).toContain("revoke all on public.qorpera_runner_usage_observations from anon, authenticated");
	});

	it("records usage in the same transaction as idempotent v3 completion", async () => {
		const sql = await readFile(migrationPath, "utf-8");
		expect(sql).toContain("create function public.qorpera_complete_runner_job_v3");
		expect(sql).toContain("v_completed := public.qorpera_complete_runner_job_v2");
		expect(sql).toContain("runner usage replay differs from the stored observation");
		expect(sql).toContain(
			"grant execute on function public.qorpera_complete_runner_job_v3(uuid, text, uuid, text, uuid, uuid, jsonb) to service_role",
		);
		expect(sql).toContain(
			"grant execute on function public.qorpera_list_runner_usage(uuid, bigint, integer) to authenticated",
		);
	});
});
