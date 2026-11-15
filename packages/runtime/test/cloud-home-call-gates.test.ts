import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseCloudCompanyHome } from "@qorpera/runtime/cloud-codex-home";
import { HttpCloudCompanyPathControl } from "@qorpera/runtime/cloud-company-path-control";
import type { CloudCompanyPathRpc } from "@qorpera/runtime/cloud-company-path-gateway";
import { CloudControlRpcEnded, cloudControlEnded, cloudControlRetryable } from "@qorpera/runtime/cloud-control-errors";
import {
	NATIVE_HOST_CALLS,
	NATIVE_HOST_IDENTITY_CALLS,
	NativeHostCallUnknown,
	NativeHostDispatch,
} from "@qorpera/runtime/cloud-native-host-dispatch";
import { describe, expect, it } from "vitest";
import { CODING_CONTROL_METHODS, CodingExecutorHttpControl } from "../../../deploy/coding-worker/control.ts";
import { authorizeHomeSession } from "../../../deploy/coding-worker/home-session-authority.ts";
import { nativeToolAuthorityFixture } from "./fixtures/native-tool-authority-fixture.ts";

// The agent's home asks SQL two things from the run's host (20260930752000): whether the run has a home when it starts,
// and to close its session when it ends. On a real host neither reached SQL (found 14 Nov 2026 by reading): the path
// control's own list did not name them, the native host's entry point had no row for them, and the runtime took the
// refusal for "no home", so every run of a company with the home on would have run without it. The home's own tests
// gave the runtime a stand-in `{ call }`, and its real-machine proof stood SQL in. These tests drive the real clients
// with a stand-in only below `fetch`, and guard the whole class from the sources.

const ORIGIN = "https://project.supabase.example";
const PUBLISHABLE_KEY = "sb_publishable_homeGates0123456789";
const LEASE_TOKEN = "L".repeat(43);
const IDENTITY = { computeIdentityId: randomUUID(), credential: "I".repeat(43), publishableKey: PUBLISHABLE_KEY };

interface Sent {
	readonly url: string;
	readonly headers: Headers;
	readonly body: Record<string, unknown>;
}

/** The run's host as service main builds it: the path control on the publishable key, over the native host's dispatch,
 * a job begun; below `fetch`, what the database would answer. */
function hostOf(answer: (sent: Sent) => Response = () => Response.json(null)) {
	const sent: Sent[] = [];
	const dispatch = new NativeHostDispatch({
		supabaseUrl: ORIGIN,
		identity: IDENTITY,
		fetch: async (input, init) => {
			const request: Sent = {
				url: String(input),
				headers: new Headers(init?.headers),
				body: JSON.parse(String(init?.body)) as Record<string, unknown>,
			};
			sent.push(request);
			return answer(request);
		},
	});
	const { binding } = nativeToolAuthorityFixture();
	dispatch.begin(binding.jobId, { leaseToken: LEASE_TOKEN, publishableKey: PUBLISHABLE_KEY });
	const paths = new HttpCloudCompanyPathControl({
		supabaseUrl: ORIGIN,
		serviceRoleKey: PUBLISHABLE_KEY,
		fetch: dispatch.fetch,
	});
	return { sent, paths, binding };
}

describe("the home's two calls from the run's host", () => {
	it("asks for the run's home through the path control and the native host's entry point, as SQL needs it", async () => {
		const machineId = randomUUID();
		const host = hostOf(() =>
			Response.json({ schema: "qorpera.company-home/v1", available: true, machineId, machine: "home-a" }),
		);
		// Exactly as the runtime asks it when a run starts (cloud-native-company-runtime.ts).
		const answer = await host.paths.call(
			"qorpera_company_home_available",
			{ p_binding: host.binding },
			AbortSignal.timeout(5_000),
		);
		expect(parseCloudCompanyHome(answer)).toEqual({ machineId, machine: "home-a" });
		expect(host.sent).toHaveLength(1);
		const [sent] = host.sent;
		// The standard entry point (8 s), which the map names: never the long one, never the RPC by its own path.
		expect(NATIVE_HOST_CALLS.get("qorpera_company_home_available")).toBe("standard");
		expect(sent?.url).toBe(`${ORIGIN}/rest/v1/rpc/qorpera_native_host_call`);
		expect(sent?.headers.get("apikey")).toBe(PUBLISHABLE_KEY);
		expect(sent?.body).toEqual({
			p_job_id: host.binding.jobId,
			p_job_lease_token: LEASE_TOKEN,
			p_name: "qorpera_company_home_available",
			// The entry point holds p_binding to the job's own job and run (scope `binding`).
			p_args: { p_binding: host.binding },
		});
	});

	it("closes the run's session through the same entry point when the run ends", async () => {
		const sessionId = randomUUID();
		const host = hostOf(() =>
			Response.json({
				schema: "qorpera.home-session-authority/v1",
				state: "closed",
				sessionId,
				closeReason: "ended",
			}),
		);
		// Exactly as the runtime's endSession closes it.
		await host.paths.call(
			"qorpera_close_home_session",
			{ p_binding: host.binding, p_session_id: sessionId, p_reason: "ended" },
			AbortSignal.timeout(5_000),
		);
		expect(NATIVE_HOST_CALLS.get("qorpera_close_home_session")).toBe("standard");
		expect(host.sent.map(({ url, body }) => [url, body])).toEqual([
			[
				`${ORIGIN}/rest/v1/rpc/qorpera_native_host_call`,
				{
					p_job_id: host.binding.jobId,
					p_job_lease_token: LEASE_TOKEN,
					p_name: "qorpera_close_home_session",
					p_args: { p_binding: host.binding, p_session_id: sessionId, p_reason: "ended" },
				},
			],
		]);
	});

	it("says a call the native host's lists do not name as that, never as a lost answer", async () => {
		const host = hostOf();
		// A name the path control lists and the dispatch does not (the wake's completion check is SQL's own).
		const error = await host.paths
			.call("qorpera_assert_wake_completion", { p_binding: host.binding }, AbortSignal.timeout(5_000))
			.catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(NativeHostCallUnknown);
		expect(host.sent).toEqual([]);
	});

	it("keeps the SQLSTATE of an answer whose statement ended, where only the home's ask reads it", async () => {
		const answers: Record<string, Response> = {
			XX000: Response.json({ code: "XX000", message: "internal", details: null, hint: null }, { status: 500 }),
			"42883": Response.json({ code: "42883", message: "missing", details: null, hint: null }, { status: 404 }),
			"57014": Response.json({ code: "57014", message: "timeout", details: null, hint: null }, { status: 500 }),
		};
		for (const [code, response] of Object.entries(answers)) {
			const host = hostOf(() => response);
			const error = await host.paths
				.call("qorpera_company_home_available", { p_binding: host.binding }, AbortSignal.timeout(5_000))
				.catch((caught: unknown) => caught);
			expect(error).toBeInstanceOf(CloudControlRpcEnded);
			expect((error as CloudControlRpcEnded).sqlstate).toBe(code);
			// What every other caller asks again by is unchanged: an ended answer is still lost, late and ended, and
			// carries no `code`.
			expect(cloudControlRetryable(error)).toBe(true);
			expect(cloudControlEnded(error)).toBe(true);
			expect((error as { code?: unknown }).code).toBeUndefined();
		}
		expect(new CloudControlRpcEnded().sqlstate).toBeUndefined();
	});

	it("lets the executor's control ask SQL for a home session, as the ingress asks it", async () => {
		const { binding } = nativeToolAuthorityFixture();
		const sessionId = randomUUID();
		const machineId = randomUUID();
		const sent: { url: string; body: unknown }[] = [];
		const control = new CodingExecutorHttpControl({
			supabaseUrl: ORIGIN,
			serviceRoleKey: "synthetic-executor-key",
			fetch: async (input, init) => {
				sent.push({ url: String(input), body: JSON.parse(String(init?.body)) });
				return Response.json({
					schema: "qorpera.home-session-authority/v1",
					state: "authorized",
					sessionId,
					machineId,
					machine: "home-a",
					placementId: randomUUID(),
					bootId: randomUUID(),
					runId: binding.runId,
					executorOwner: "mx-1",
					providerId: "machine-1",
				});
			},
		});
		const authority = await authorizeHomeSession(
			control,
			{ binding, machineId, sessionId },
			AbortSignal.timeout(5_000),
		);
		expect(authority).toMatchObject({ state: "authorized", sessionId, machineId, runId: binding.runId });
		expect(sent).toEqual([
			{
				url: `${ORIGIN}/rest/v1/rpc/qorpera_authorize_home_session`,
				body: { p_binding: binding, p_scope: { machineId }, p_session_id: sessionId },
			},
		]);
	});
});

const runtimeSource = fileURLToPath(new URL("../src/", import.meta.url));
const executorSource = fileURLToPath(new URL("../../../deploy/coding-worker/", import.meta.url));

function sourcesOf(directory: string): string[] {
	return readdirSync(directory).flatMap((name) => {
		const path = join(directory, name);
		if (statSync(path).isDirectory()) return sourcesOf(path);
		return name.endsWith(".ts") && !name.endsWith(".test.ts") ? [path] : [];
	});
}

/** Every name a source passes as the first argument of a call matching `receiver` (read from the files, so a new call
 * is never forgotten here). */
function namesCalled(files: readonly string[], receiver: RegExp): Set<string> {
	const names = new Set<string>();
	for (const file of files)
		for (const match of readFileSync(file, "utf8").matchAll(receiver)) names.add(match[1] as string);
	return names;
}

/**
 * Names the path control lists that no runtime source sends, so no entry point of the native host's names them. Each
 * must stay unsent and unlisted in NATIVE_HOST_CALLS: the guard fails the day one is sent or listed (take it out here).
 * The three wake checks are in the list because the runtime hands its path control to the wake bus as its control
 * (`wakeControl` in cloud-native-company-runtime.ts), so CloudWakeRpc's names must be ones the path control takes; the
 * bus itself sends only `qorpera_read_native_wake`, `qorpera_send_coworker_message` and
 * `qorpera_assert_company_path_reads`, and SQL asks the three itself (the folder's reads ask
 * `qorpera_assert_wake_work_allowed`, a governed completion asks `qorpera_assert_wake_completion`, both over
 * `qorpera_runtime_wake_policy`'s rules; RUNTIME-STEP-3-WAKE-BUS.md). Listed since 29d29554d (9 Sep 2026).
 */
const UNSENT_BY_THE_RUNTIME: readonly string[] = [
	"qorpera_assert_wake_completion",
	"qorpera_assert_wake_work_allowed",
	"qorpera_runtime_wake_policy",
];

/**
 * Gaps the guard knows of, each named and dated with its reason. Each must still be a gap: the guard fails the day one
 * is closed (take it out here) and the day another joins.
 * - qorpera_native_light_ask_answer (14 Nov 2026): master's light ask (20260930761000) calls it through the run's path
 *   control, which does not list it, so a real host never stores the answer. Its lead fixes it in its own lane.
 */
const KNOWN_GAPS: readonly string[] = ["qorpera_native_light_ask_answer: not in the path control's list"];

describe("every name the runtime's path control takes reaches SQL on a real host", () => {
	it("is in the path control's list when a source sends it, and every name the list takes has an entry point", async () => {
		const files = sourcesOf(runtimeSource);
		// `this.#paths.call("…"` and `paths.call("…"`: the run's own calls, as the runtime's sources make them. Calls through
		// the same control under other names (`control.call(`, `this.#control.call(`, the wake bus) and names built at run
		// time are covered below, by every name the type allows.
		const called = namesCalled(files, /(?:#|\b)paths\.call\(\s*"(qorpera_[a-z0-9_]+)"/g);
		expect(called).toContain("qorpera_company_home_available");
		expect(called).toContain("qorpera_close_home_session");
		expect(called).toContain("qorpera_describe_company_run_context");
		// Every name a path control call may take (TypeScript holds every caller of the interface, and the path control's
		// own list, to it).
		const gateway = readFileSync(join(runtimeSource, "cloud-company-path-gateway.ts"), "utf8");
		const union = gateway.slice(gateway.indexOf("export type CloudCompanyPathRpc ="));
		const typed = new Set(
			[...union.slice(0, union.indexOf(";\n")).matchAll(/"(qorpera_[a-z0-9_]+)"/g)].map((m) => m[1] as string),
		);
		expect(typed.size).toBeGreaterThan(80);
		for (const name of called) expect(typed, name).toContain(name);
		// Any call of any receiver in the runtime's sources, for the names no source may send.
		const sentAnyhow = namesCalled(files, /\.call\(\s*"(qorpera_[a-z0-9_]+)"/g);

		const gaps: string[] = [];
		for (const name of [...typed].sort()) {
			// The path control itself: does it send the name at all?
			const host = hostOf();
			// The path control refuses a name it does not list before it returns a promise.
			const error = await Promise.resolve()
				.then(() =>
					host.paths.call(name as CloudCompanyPathRpc, { p_binding: host.binding }, AbortSignal.timeout(5_000)),
				)
				.then(
					() => undefined,
					(caught: unknown) => caught,
				);
			if (error instanceof Error && error.message === "Unknown Company File control operation") {
				gaps.push(`${name}: not in the path control's list`);
				continue;
			}
			const listed = NATIVE_HOST_CALLS.has(name) || NATIVE_HOST_IDENTITY_CALLS.has(name);
			if (UNSENT_BY_THE_RUNTIME.includes(name)) {
				if (sentAnyhow.has(name)) gaps.push(`${name}: sent by a runtime source, so it needs an entry point`);
				if (listed) gaps.push(`${name}: has an entry point now, so it is no longer an exception`);
				continue;
			}
			// Every other name the list takes reaches SQL through an entry point of the native host's.
			const reached = host.sent.some(
				({ url, body }) =>
					body.p_name === name &&
					(url === `${ORIGIN}/rest/v1/rpc/qorpera_native_host_call` ||
						url === `${ORIGIN}/rest/v1/rpc/qorpera_native_host_call_long` ||
						url === `${ORIGIN}/rest/v1/rpc/qorpera_native_identity_call`),
			);
			if (!listed || !reached) gaps.push(`${name}: no entry point of the native host's`);
		}
		expect(gaps).toEqual(KNOWN_GAPS);
	});

	it("lets every call the executor's sources make through the executor's own control", () => {
		// The executor's own sources (its test helpers in test/ are not the executor).
		const files = readdirSync(executorSource)
			.filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
			.map((name) => join(executorSource, name));
		const called = namesCalled(files, /\.call\(\s*"(qorpera_[a-z0-9_]+)"/g);
		expect(called).toContain("qorpera_authorize_home_session");
		expect([...called].filter((name) => !CODING_CONTROL_METHODS.has(name))).toEqual([]);
	});
});
