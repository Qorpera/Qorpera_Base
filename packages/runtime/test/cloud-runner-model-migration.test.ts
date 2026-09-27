import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migrationPath = resolve(
	import.meta.dirname,
	"../../../supabase/migrations/20260817003000_runner_model_gateway.sql",
);
const edgePath = resolve(import.meta.dirname, "../../../supabase/functions/runner-broker/index.ts");
const gatewayPath = resolve(import.meta.dirname, "../../../supabase/functions/runner-broker/runner-broker.ts");

describe("runner model gateway migration", () => {
	it("requires explicit authorization and keeps actor, authorizer, and billing separate", async () => {
		const sql = await readFile(migrationPath, "utf-8");
		expect(sql).toContain("public.qorpera_can_authorize_profile(v_job.profile_id)");
		expect(sql).toContain("actor_user_id uuid not null");
		expect(sql).toContain("authorized_by_user_id uuid not null");
		expect(sql).not.toContain("billing_account_id");
		expect(sql).toContain("revoke all on public.qorpera_runner_model_requests from anon, authenticated");
	});

	it("binds reservations to a live job lease and stores one immutable usage observation", async () => {
		const sql = await readFile(migrationPath, "utf-8");
		expect(sql).toContain("v_job := public.qorpera_runner_broker_locked_job");
		expect(sql).toContain("unique (job_id, client_request_id)");
		expect(sql).toContain("request_id uuid not null unique");
		expect(sql).toContain("runner model request id is already bound to other work");
		expect(sql).toContain("runner model result replay differs");
		expect(sql).toContain("jsonb_build_object('state', 'reserved', 'replay', true)");
		expect(sql).toContain("set runner_id = p_runner_id");
		expect(sql).toContain("grant execute on function public.qorpera_runner_broker_reserve_model_request");
		expect(sql).toContain("grant execute on function public.qorpera_runner_broker_finalize_model_request");
		expect(sql).toContain("create function public.qorpera_complete_runner_job_v4");
		expect(sql).toContain("runner job has an active model request");
		expect(sql).toContain("return public.qorpera_complete_runner_job_v3");
	});

	it("keeps runner authority out of the controlled gateway and requires provider-call idempotency", async () => {
		const edge = await readFile(edgePath, "utf-8");
		const gateway = await readFile(gatewayPath, "utf-8");
		const projectionStart = edge.indexOf("const requestProjection");
		const projectionEnd = edge.indexOf("const encodedProjection");
		expect(projectionStart).toBeGreaterThan(0);
		expect(projectionEnd).toBeGreaterThan(projectionStart);
		const projection = edge.slice(projectionStart, projectionEnd);
		expect(gateway).toContain('"idempotency-key": options.request.requestId');
		expect(gateway).toContain(["authorization: `Bearer $", "{options.token}`"].join(""));
		expect(gateway).toContain('redirect: "error"');
		expect(projection).not.toContain("sessionToken");
		expect(projection).not.toContain("leaseToken");
	});
});
