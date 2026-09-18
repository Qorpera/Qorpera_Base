import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
	MEMBER_OBSERVATION_CAPACITY,
	MEMBER_OBSERVATION_RETENTION_MS,
	MEMBER_OBSERVATIONS_PATH,
	MemberCompanyObservations,
	type MemberObservationOperation,
	type MemberRequestObservationSpan,
	parseMemberObservationQuery,
} from "../src/member-observability.ts";

const companyId = "32100000-0000-4000-8000-000000000010";
const environmentId = "32100000-0000-4000-8000-000000000020";
const commandId = "32100000-0000-4000-8000-000000000030";
const actorUserId = "32100000-0000-4000-8000-000000000001";
const resourceId = "32100000-0000-4000-8000-000000000040";
const resourceVersion = "32100000-0000-4000-8000-000000000050";
const epoch = Date.parse("2026-08-31T10:00:00.000Z");

describe("bounded human request observations", () => {
	it("reports start/end and canonical IDs without conflating HTTP delivery, traffic or effects", () => {
		let monotonic = 1;
		const observer = new MemberCompanyObservations({ clock: () => epoch, monotonicClock: () => monotonic });
		const span = observer.start("object_read");
		expect(observer.snapshot({ limit: 1 }).observations[0]).toMatchObject({
			operation: "object_read",
			responseOutcome: "started",
			startedAt: "2026-08-31T10:00:00.000Z",
			endedAt: null,
			durationMs: null,
			actorUserId: null,
			companyId: null,
			resourceId: null,
			logicalObjectReadBytes: null,
			effectOutcome: "none",
		});
		span.update({
			companyId,
			environmentId,
			actorUserId,
			resourceId,
			resourceVersion,
			logicalObjectReadBytes: 97,
			responseBodyBytes: 97,
		});
		monotonic += 21.4;
		span.finish(200);
		const result = observer.snapshot({
			limit: 1,
			companyId,
			environmentId,
			actorUserId,
			resourceId,
			operation: "object_read",
			outcome: "succeeded",
		});
		expect(result.observations).toHaveLength(1);
		expect(result.observations[0]).toMatchObject({
			companyId,
			environmentId,
			actorUserId,
			resourceId,
			resourceVersion,
			durationMs: 21,
			httpStatus: 200,
			responseOutcome: "succeeded",
			logicalObjectReadBytes: 97,
		});
		expect(result).toMatchObject({
			retention: "bounded-process-memory-only",
			capacity: MEMBER_OBSERVATION_CAPACITY,
			retentionMs: MEMBER_OBSERVATION_RETENTION_MS,
			completeHistory: false,
			priorProcessObservationsAvailable: false,
			clientDeliveryConfirmed: false,
			byteSemantics: {
				logicalObjectReadBytes: "verified-immutable-object-payload-not-whole-file-or-nas-traffic",
				responseBodyBytes: "prepared-http-body-not-client-acknowledgement",
			},
		});
	});

	it("retains confirmed effects when result release fails, and keeps uncertain work separate", () => {
		const observer = new MemberCompanyObservations();
		const first = observer.start("command_submit");
		first.update({ commandId, companyId, environmentId });
		first.effect("applied");
		first.fail(403);
		first.effect("none");
		first.finish(403);
		first.finish(200);
		const second = observer.start("command_review");
		second.update({ commandId });
		second.effect("unconfirmed");
		second.fail(503);
		second.finish(503);
		const rows = observer.snapshot({ limit: 10, commandId }).observations;
		expect(rows.map((row) => [row.effectOutcome, row.responseOutcome, row.errorCategory])).toEqual([
			["unconfirmed", "failed", "dependency_unavailable"],
			["applied", "denied", "forbidden"],
		]);
	});

	it.each(["proposed", "replayed", "rejected"] as const)("keeps %s distinct from fresh application", (outcome) => {
		const observer = new MemberCompanyObservations();
		const span = observer.start("file_request");
		span.operation("command_review");
		span.effect(outcome);
		span.finish(200);
		expect(observer.snapshot({ limit: 1 }).observations[0]).toMatchObject({
			operation: "command_review",
			effectOutcome: outcome,
			responseOutcome: "succeeded",
		});
	});

	it("can observe a canonical effect after a disconnected response without claiming client delivery", () => {
		const observer = new MemberCompanyObservations();
		const span = observer.start("command_submit");
		span.finish(null, true);
		span.update({ commandId });
		span.effect("applied");
		expect(observer.snapshot({ limit: 1 }).observations[0]).toMatchObject({
			commandId,
			effectOutcome: "applied",
			responseOutcome: "aborted",
			errorCategory: "response_aborted",
			httpStatus: null,
		});
	});

	it("discloses evictions, newest-first pagination and process restart gaps", () => {
		let monotonic = 0;
		const observer = new MemberCompanyObservations({
			capacity: 2,
			retentionMs: 100,
			monotonicClock: () => monotonic,
		});
		const evicted = observer.start("object_read");
		monotonic = 1;
		observer.start("command_submit").update({ commandId });
		monotonic = 2;
		observer.start("command_review").update({ commandId });
		evicted.update({ actorUserId });
		evicted.finish(200);
		const result = observer.snapshot({ limit: 1 });
		expect(result).toMatchObject({ evicted: 1, retained: 2, matched: 2, more: true });
		expect(result.observations[0]?.operation).toBe("command_review");
		expect(observer.snapshot({ limit: 2, actorUserId }).observations).toEqual([]);
		monotonic = 102;
		expect(observer.snapshot({ limit: 2 })).toMatchObject({ evicted: 3, retained: 0, matched: 0, more: false });
		const restarted = new MemberCompanyObservations().snapshot({ limit: 1 });
		expect(restarted.instanceId).not.toBe(result.instanceId);
		expect(restarted).toMatchObject({
			retained: 0,
			priorProcessObservationsAvailable: false,
			completeHistory: false,
		});
	});

	it("does not invent fresh timestamps or zero durations when clocks fail", () => {
		let broken = false;
		const observer = new MemberCompanyObservations({
			clock: () => {
				throw new Error("PRIVATE_CLOCK");
			},
			monotonicClock: () => {
				if (broken) throw new Error("PRIVATE_CLOCK");
				return 0;
			},
		});
		const span = observer.start("object_read");
		broken = true;
		span.finish(200);
		observer.start("object_read");
		expect(observer.snapshot({ limit: 1 })).toMatchObject({
			processStartedAt: null,
			asOf: null,
			freshness: "unknown",
			dropped: 1,
			observations: [{ startedAt: null, endedAt: null, durationMs: null, responseOutcome: "succeeded" }],
		});
	});

	it("drops invalid or redirected identity metadata atomically and never records free text", () => {
		const observer = new MemberCompanyObservations();
		const span = observer.start("object_read");
		span.update({ actorUserId });
		span.update({ actorUserId: companyId, resourceId });
		span.update({ companyId, path: "PRIVATE_PATH", token: "PRIVATE_TOKEN" } as unknown as Parameters<
			MemberRequestObservationSpan["update"]
		>[0]);
		span.update({ resourceId: "PRIVATE_VALUE" });
		span.update({ logicalObjectReadBytes: -1 });
		span.update({ logicalObjectReadBytes: 8 * 1024 * 1024 + 1 });
		span.update(
			Object.defineProperty({}, "companyId", {
				enumerable: true,
				get: () => {
					throw new Error("PRIVATE_GETTER");
				},
			}),
		);
		span.operation("PRIVATE_OPERATION" as MemberObservationOperation);
		const result = observer.snapshot({ limit: 1 });
		expect(result).toMatchObject({
			dropped: 7,
			observations: [{ actorUserId, companyId: null, resourceId: null, logicalObjectReadBytes: null }],
		});
		expect(JSON.stringify(result)).not.toContain("PRIVATE_");
	});

	it.each([
		[401, "unauthorized"],
		[403, "forbidden"],
		[404, "not_found"],
		[400, "invalid_request"],
		[405, "invalid_request"],
		[413, "invalid_request"],
		[409, "conflict"],
		[412, "stale_version"],
		[503, "dependency_unavailable"],
		[undefined, "unknown"],
	] as const)("exports only fixed category for %s", (status, category) => {
		const observer = new MemberCompanyObservations();
		const span = observer.start("file_request");
		span.fail(status);
		span.finish(status ?? 503);
		expect(observer.snapshot({ limit: 1 }).observations[0]?.errorCategory).toBe(category);
	});

	it.each([{ capacity: 0 }, { capacity: 513 }, { capacity: 1.2 }, { retentionMs: 0 }, { retentionMs: 900001 }])(
		"rejects unbounded configuration %j",
		(options) => {
			expect(() => new MemberCompanyObservations(options)).toThrow("bounds");
		},
	);

	it("drops an invalid initial clock without preventing the caller's work", () => {
		const observer = new MemberCompanyObservations({ monotonicClock: () => Number.NaN });
		const span = observer.start("object_read");
		expect(() => {
			span.update({ actorUserId });
			span.effect("none");
			span.fail();
			span.finish(503);
		}).not.toThrow();
		expect(observer.snapshot({ limit: 1 })).toMatchObject({ retained: 0, dropped: 1, freshness: "unknown" });
	});
});

describe("strict operator query", () => {
	it("accepts only the exact route and closed bounded filters", () => {
		expect(parseMemberObservationQuery(MEMBER_OBSERVATIONS_PATH)).toEqual({ limit: 50 });
		expect(
			parseMemberObservationQuery(
				`${MEMBER_OBSERVATIONS_PATH}?limit=100&companyId=${companyId}&operation=command_submit&outcome=failed`,
			),
		).toEqual({ limit: 100, companyId, operation: "command_submit", outcome: "failed" });
	});
	it.each([
		"/",
		"/extra",
		"?",
		"?limit=0",
		"?limit=101",
		"?limit=01",
		"?limit=2&limit=1",
		"?limit=1&",
		"?&limit=1",
		"?limit=1&&outcome=failed",
		"?limit=1=2",
		"?offset=0",
		"?companyId=invalid",
		"?operation=execute",
		"?outcome=applied",
		"?path=secret",
		"?companyId=%31",
		"#fragment",
		`?limit=${"1".repeat(1100)}`,
	])("rejects noncanonical query %s", (suffix) => {
		expect(() => parseMemberObservationQuery(`${MEMBER_OBSERVATIONS_PATH}${suffix}`)).toThrow();
	});
});

it("the metadata forward migration leaves every 19950 authority check and the function identity/ACL intact", async () => {
	const baseline = await readFile(
		new URL("../../../supabase/migrations/20260828019950_company_path_preconditions.sql", import.meta.url),
		"utf8",
	);
	const forward = await readFile(
		new URL("../../../supabase/migrations/20260828019971_member_object_observation_identity.sql", import.meta.url),
		"utf8",
	);
	const signature = "create or replace function public.qorpera_authorize_member_company_path_object(";
	const expected = baseline
		.slice(baseline.indexOf(signature))
		.trim()
		.replace(
			"declare v_actor jsonb; v_entry public.qorpera_company_path_entries%rowtype;",
			"declare v_actor jsonb; v_resource public.qorpera_company_path_resources%rowtype;\n\tv_entry public.qorpera_company_path_entries%rowtype;",
		)
		.replace(
			"perform public.qorpera_company_path_require(v_actor,p_path,'read');",
			"v_resource := public.qorpera_company_path_require(v_actor,p_path,'read');",
		)
		.replace("qorpera.member-company-object/v1", "qorpera.member-company-object/v2")
		.replace(
			"'bytes',v_object.bytes,'backend',v_object.backend);",
			"'bytes',v_object.bytes,'backend',v_object.backend,'actorUserId',v_actor ->> 'userId',\n\t\t'resourceId',v_resource.id,'resourceVersion',v_resource.version);",
		);
	expect(forward.slice(forward.indexOf(signature)).trim()).toBe(expected);
	expect(forward.match(/create or replace function/g)).toHaveLength(1);
	expect(forward).not.toMatch(/\b(?:grant|revoke|alter|drop)\s+(?:all|execute|function|table)/i);
});
