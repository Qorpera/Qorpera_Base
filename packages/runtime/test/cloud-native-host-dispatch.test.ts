import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import {
	isNativeHostPublishableKey,
	NATIVE_HOST_CALLS,
	NATIVE_HOST_IDENTITY_CALLS,
	NativeHostDispatch,
} from "@qorpera/runtime/cloud-native-host-dispatch";
import { HttpNativeProviderComputerBridge } from "@qorpera/runtime/cloud-native-provider";
import { NativeProviderHost } from "@qorpera/runtime/cloud-native-provider-host";
import { HttpNativeProviderHostService } from "@qorpera/runtime/cloud-native-provider-service";
import type { CloudRunnerNativeAuthority } from "@qorpera/runtime/cloud-runner-broker";
import { afterEach, expect, it, vi } from "vitest";
import { nativeToolAuthorityFixture } from "./fixtures/native-tool-authority-fixture.ts";

afterEach(() => {
	vi.restoreAllMocks();
});

const ORIGIN = "https://project.supabase.example";
const SERVICE_KEY = `eyJhbGciOiJIUzI1NiJ9.${Buffer.from('{"role":"service_role"}').toString("base64url")}.c2lnbmF0dXJl`;
const PUBLISHABLE_KEY = "sb_publishable_g2TestKey0123456789";
const JOB_ID = "7e2a0000-0000-4000-8000-000000000001";
const TOKEN_A = "A".repeat(43);
const TOKEN_B = "B".repeat(43);
const IDENTITY_ID = "7e2a0000-0000-4000-8000-0000000000c1";
const IDENTITY_TOKEN = "I".repeat(43);
const SLOT_TOKEN = "S".repeat(43);
const NEXT_SLOT_TOKEN = "N".repeat(43);

function dispatchFixture() {
	const sent: { url: string; init: RequestInit | undefined }[] = [];
	const fetcher = vi.fn<typeof fetch>(async (input, init) => {
		sent.push({ url: String(input instanceof Request ? input.url : input), init });
		return new Response('{"ok":true}', { status: 200, headers: { "content-type": "application/json" } });
	});
	const dispatch = new NativeHostDispatch({
		supabaseUrl: ORIGIN,
		serviceKey: SERVICE_KEY,
		identity: { computeIdentityId: IDENTITY_ID, credential: IDENTITY_TOKEN, publishableKey: PUBLISHABLE_KEY },
		fetch: fetcher,
	});
	return { dispatch, fetcher, sent };
}

function rpc(body: string, extra: Omit<RequestInit, "body"> = {}): RequestInit & { body: string } {
	return {
		method: "POST",
		redirect: "error",
		headers: { apikey: SERVICE_KEY, authorization: `Bearer ${SERVICE_KEY}`, "content-type": "application/json" },
		body,
		...extra,
	};
}

it("lists exactly the calls the host makes inside a job, with the long budget for the lease validator only", () => {
	const read = (name: string) =>
		readFileSync(new URL(`../../../supabase/migrations/${name}`, import.meta.url), "utf8");
	const migration = read("20260928409985_runtime_native_host_call.sql");
	// Each migration that adds calls inserts them in one statement.
	const rowsOf = (text: string) => {
		const insert = text.slice(text.indexOf("insert into public.qorpera_native_host_calls(name, scope) values"));
		return [...insert.slice(0, insert.indexOf(";\n")).matchAll(/\('(qorpera_[a-z0-9_]+)', '([a-z]+)'\)/g)];
	};
	const rows = [
		...rowsOf(migration),
		...rowsOf(read("20260928429982_runtime_company_mail_find_and_tags.sql")),
		...rowsOf(read("20260928429984_runtime_company_mail_attachments.sql")),
		...rowsOf(read("20260928439965_runtime_company_account_tool.sql")),
		...rowsOf(read("20260928439970_folder_run_view_open.sql")),
		// The worker tools on folder-v2 (F2-5b-2), a coding session's archive (C3b) and agents' hooks and mailboxes (E3a),
		// found by name: a release re-slots the file.
		...["_folder_state_worker_files.sql", "_folder_coding_archive.sql", "_folder_agent_manage_hook.sql"].flatMap(
			(suffix) =>
				rowsOf(
					read(
						readdirSync(new URL("../../../supabase/migrations/", import.meta.url)).find((name) =>
							name.endsWith(suffix),
						) ?? `missing${suffix}`,
					),
				),
		),
	];
	const long = new Set(
		[...migration.matchAll(/set budget = 'long' where name = '(qorpera_[a-z0-9_]+)'/g)].map((m) => m[1]),
	);
	const expected = new Map(
		rows
			.filter(([, , scope]) => scope !== "identity")
			.map(([, name]) => [name, long.has(name) ? "long" : "standard"]),
	);
	expect(rows).toHaveLength(92);
	expect(new Map(NATIVE_HOST_CALLS)).toEqual(expected);
	expect([...NATIVE_HOST_CALLS].filter(([, budget]) => budget === "long")).toEqual([
		["qorpera_validate_native_provider_execution_lease", "long"],
	]);
});

it("lists exactly the calls the host makes between jobs, as the identity entry point allows them", () => {
	// By name, not slot: a release re-slots the file (v171: 20260930005000 → 20260928469140).
	const migrations = new URL("../../../supabase/migrations/", import.meta.url);
	const file = readdirSync(migrations).find((name) => name.endsWith("_runtime_native_identity_call.sql"));
	if (!file) throw new Error("The native identity call migration is missing");
	const migration = readFileSync(new URL(file, migrations), "utf8");
	const insert = migration.slice(
		migration.indexOf("insert into public.qorpera_native_identity_calls(name, scope, holder_kinds) values"),
	);
	const names = [
		...insert.slice(0, insert.indexOf(";\n")).matchAll(/\('(qorpera_[a-z0-9_]+)', '[a-z_]+', array\[/g),
	].map((match) => match[1]);
	expect(names).toHaveLength(8);
	expect([...NATIVE_HOST_IDENTITY_CALLS].sort()).toEqual(names.sort());
	for (const name of NATIVE_HOST_IDENTITY_CALLS) expect(NATIVE_HOST_CALLS.has(name)).toBe(false);
});

it("classifies every database call the host's clients can make: inside a job, between jobs, or never by the host", () => {
	const source = (file: string) => readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8");
	const clients = [
		"cloud-native-provider-service.ts",
		"cloud-company-path-control.ts",
		"cloud-coding-control.ts",
		"cloud-native-coding-runtime.ts",
		"cloud-company-computer-registry-http.ts",
	];
	// In the clients' closed lists but never called by the native host: the office VM's own registry calls, and the
	// wake checks only SQL completion makes. The dispatch refuses them.
	const neverByHost = new Set([
		"qorpera_ack_runtime_office_drain",
		"qorpera_ack_runtime_office_privacy",
		"qorpera_admit_runtime_office_viewer_input_window",
		"qorpera_assert_wake_completion",
		"qorpera_assert_wake_work_allowed",
		"qorpera_check_runtime_office_adoption",
		"qorpera_check_runtime_office_guest_binding",
		"qorpera_check_runtime_office_private_surface",
		"qorpera_check_runtime_office_shared_surface",
		"qorpera_check_runtime_office_start",
		"qorpera_check_runtime_office_startup",
		"qorpera_check_runtime_office_viewer",
		"qorpera_native_office_browser_grant",
		"qorpera_native_office_file_export",
		"qorpera_native_office_file_import",
		"qorpera_office_screen_browser_grant",
		"qorpera_record_runtime_screen_event",
		"qorpera_redeem_runtime_office_viewer",
		"qorpera_release_runtime_office_viewer",
		"qorpera_report_runtime_office_ready",
		"qorpera_report_runtime_office_shell_activity",
		"qorpera_reserve_runtime_office_start",
		"qorpera_retain_runtime_screen_observation",
		"qorpera_runtime_office_privacy_status",
		"qorpera_runtime_office_provider_status",
		"qorpera_runtime_office_screen_appearance",
		"qorpera_runtime_office_supervisor_status",
		"qorpera_runtime_wake_policy",
	]);
	const names = new Set(
		clients.flatMap((file) =>
			[...source(file).matchAll(/"(qorpera_[a-z0-9_]+)"/g)].map((match) => match[1] as string),
		),
	);
	expect(
		[...names].filter(
			(name) => !NATIVE_HOST_CALLS.has(name) && !NATIVE_HOST_IDENTITY_CALLS.has(name) && !neverByHost.has(name),
		),
	).toEqual([]);
	for (const name of neverByHost) {
		expect(NATIVE_HOST_CALLS.has(name)).toBe(false);
		expect(NATIVE_HOST_IDENTITY_CALLS.has(name)).toBe(false);
	}
	// Every between-job call is one the host's own code makes.
	const host = [
		"cloud-native-provider-service.ts",
		"cloud-identity-recovery-guest.ts",
		"cloud-native-provider-service-main.ts",
	]
		.map(source)
		.join("\n");
	// As a name in a client's list, or the last part of an RPC path.
	for (const name of NATIVE_HOST_IDENTITY_CALLS) expect(host).toMatch(new RegExp(`["/]${name}"`));
});

it("gives the dispatch to every database client the host builds, and to its service", () => {
	const main = readFileSync(new URL("../src/cloud-native-provider-service-main.ts", import.meta.url), "utf8");
	// Every client the host builds on the project's address: a new one must be added here, and get the dispatch.
	expect(
		[...main.matchAll(/new (\w+)\(\s*(?:\{\s*supabaseUrl:\s*)?baseUrl\b/g)].map((match) => match[1]).sort(),
	).toEqual([
		"HttpCloudCodingControl",
		"HttpCloudCompanyComputerRegistry",
		"HttpCloudCompanyPathControl",
		"NativeHostDispatch",
		"SupabaseNativeCredentialCapsuleStore",
		"SupabaseNativeProviderControlPlane",
	]);
	expect(main).toMatch(/new SupabaseNativeProviderControlPlane\(\s*baseUrl,\s*serviceKey,\s*dispatch\.fetch,/);
	expect(main).toMatch(/new HttpCloudCompanyPathControl\(\{[^}]*fetch: dispatch\.fetch[^}]*\}\)/);
	expect(main).toMatch(/new HttpCloudCodingControl\(\{[^}]*fetch: dispatch\.fetch[^}]*\}\)/);
	expect(main).toMatch(/new HttpCloudCompanyComputerRegistry\(\{[^}]*fetch: dispatch\.fetch[^}]*\}\)/);
	expect(main).toMatch(/new NativeHostDispatch\(\{ supabaseUrl: baseUrl, serviceKey, identity \}\)/);
	expect(main).not.toContain("QORPERA_NATIVE_HOST_DISPATCH");
	expect(main).toMatch(/environment\.QORPERA_NATIVE_PROVIDER_TRUSTED_SOURCE,\s*dispatch,\s*\)/);
});

it("accepts only publishable keys", () => {
	const jwt = (role: string) =>
		`eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify({ role })).toString("base64url")}.c2lnbmF0dXJl`;
	expect(isNativeHostPublishableKey(PUBLISHABLE_KEY)).toBe(true);
	expect(isNativeHostPublishableKey(jwt("anon"))).toBe(true);
	expect(isNativeHostPublishableKey(jwt("service_role"))).toBe(false);
	expect(isNativeHostPublishableKey("sb_secret_g2TestKey0123456789")).toBe(false);
	expect(isNativeHostPublishableKey(undefined)).toBe(false);
});

it("sends a listed call through the entry point with the job's token and the publishable key, arguments as sent", async () => {
	const { dispatch, sent } = dispatchFixture();
	const release = dispatch.begin(JOB_ID, { leaseToken: TOKEN_A, publishableKey: PUBLISHABLE_KEY });
	const signal = new AbortController().signal;
	const args = '{"p_binding":{"jobId":"x"},"p_limit":9007199254740993}';
	await dispatch.fetch(`${ORIGIN}/rest/v1/rpc/qorpera_describe_native_tool_authority`, rpc(args, { signal }));
	await dispatch.fetch(new URL(`${ORIGIN}/rest/v1/rpc/qorpera_validate_native_provider_execution_lease`), rpc("{}"));
	release();
	expect(sent.map((call) => call.url)).toEqual([
		`${ORIGIN}/rest/v1/rpc/qorpera_native_host_call`,
		`${ORIGIN}/rest/v1/rpc/qorpera_native_host_call_long`,
	]);
	const first = sent[0]!.init!;
	expect(first.body).toBe(
		`{"p_job_id":"${JOB_ID}","p_job_lease_token":"${TOKEN_A}","p_name":"qorpera_describe_native_tool_authority","p_args":${args}}`,
	);
	const headers = new Headers(first.headers);
	expect(headers.get("apikey")).toBe(PUBLISHABLE_KEY);
	expect(headers.get("authorization")).toBeNull();
	expect(headers.get("content-type")).toBe("application/json");
	expect(first.signal).toBe(signal);
	expect(first.redirect).toBe("error");
	expect(JSON.parse(sent[1]!.init!.body as string)).toMatchObject({
		p_name: "qorpera_validate_native_provider_execution_lease",
	});
});

it("sends a between-job call through the identity entry point with the holder's credential, inside a job or not", async () => {
	const { dispatch, sent } = dispatchFixture();
	const signal = new AbortController().signal;
	const args = '{"p_compute_identity_id":"x","p_limit":9007199254740993}';
	await dispatch.fetch(
		`${ORIGIN}/rest/v1/rpc/qorpera_list_native_provider_account_refreshes`,
		rpc(args, { signal, redirect: "follow" }),
	);
	const release = dispatch.begin(JOB_ID, { leaseToken: TOKEN_A, publishableKey: PUBLISHABLE_KEY });
	await dispatch.fetch(`${ORIGIN}/rest/v1/rpc/qorpera_identity_recovery_runtime_state`, rpc("{}"));
	release();
	expect(sent.map((call) => call.url)).toEqual([
		`${ORIGIN}/rest/v1/rpc/qorpera_native_identity_call`,
		`${ORIGIN}/rest/v1/rpc/qorpera_native_identity_call`,
	]);
	const first = sent[0]!.init!;
	expect(first.body).toBe(
		`{"p_compute_identity_id":"${IDENTITY_ID}","p_credential":"${IDENTITY_TOKEN}","p_name":"qorpera_list_native_provider_account_refreshes","p_args":${args}}`,
	);
	const headers = new Headers(first.headers);
	expect(headers.get("apikey")).toBe(PUBLISHABLE_KEY);
	expect(headers.get("authorization")).toBeNull();
	expect(first.signal).toBe(signal);
	expect(first.redirect).toBe("error");
	// The job's token never rides on a between-job call.
	expect(JSON.parse(sent[1]!.init!.body as string)).toEqual({
		p_compute_identity_id: IDENTITY_ID,
		p_credential: IDENTITY_TOKEN,
		p_name: "qorpera_identity_recovery_runtime_state",
		p_args: {},
	});
	expect(JSON.stringify(sent)).not.toContain(SERVICE_KEY);
	expect(JSON.stringify(sent)).not.toContain(TOKEN_A);
});

it("keeps Storage and other origins as sent, and refuses any other call on the project's origin", async () => {
	const { dispatch, sent } = dispatchFixture();
	dispatch.begin(JOB_ID, { leaseToken: TOKEN_A, publishableKey: PUBLISHABLE_KEY });
	const storage = { method: "GET" };
	await dispatch.fetch(`${ORIGIN}/storage/v1/object/qorpera-native-compute-capsules/x.capsule`, storage);
	await dispatch.fetch("https://elsewhere.example/rest/v1/rpc/qorpera_describe_native_tool_authority", rpc("{}"));
	expect(sent.map((call) => call.url)).toEqual([
		`${ORIGIN}/storage/v1/object/qorpera-native-compute-capsules/x.capsule`,
		"https://elsewhere.example/rest/v1/rpc/qorpera_describe_native_tool_authority",
	]);
	expect(sent[0]!.init).toBe(storage);
	expect(JSON.stringify(sent)).not.toContain(TOKEN_A);
	expect(JSON.stringify(sent)).not.toContain(IDENTITY_TOKEN);
	for (const path of [
		"/rest/v1/rpc/qorpera_runtime_wake_policy",
		"/rest/v1/rpc/qorpera_runtime_office_supervisor_status",
		"/rest/v1/rpc/qorpera_native_identity_call",
		"/rest/v1/rpc/qorpera_native_host_call",
		"/rest/v1/rpc/qorpera_bind_native_identity_credential",
		"/rest/v1/qorpera_runner_jobs",
		"/rest/v1/rpc/QORPERA_DESCRIBE_NATIVE_TOOL_AUTHORITY",
		"/rest/v1/rpc/QORPERA_LIST_NATIVE_PROVIDER_ACCOUNT_REFRESHES",
		// Only Storage passes on the project's origin: no other service gets the key.
		"/graphql/v1",
		"/auth/v1/user",
		"/functions/v1/anything",
		"/realtime/v1/api/broadcast",
		"/%72est/v1/rpc/qorpera_describe_native_tool_authority",
		"/storage/v2/object/x",
	])
		await expect(dispatch.fetch(`${ORIGIN}${path}`, rpc("{}"))).rejects.toThrow("Not a native host call");
	const url = `${ORIGIN}/rest/v1/rpc/qorpera_identity_recovery_runtime_state`;
	await expect(dispatch.fetch(url, { method: "GET" })).rejects.toThrow("malformed");
	await expect(dispatch.fetch(`${url}?select=*`, rpc("{}"))).rejects.toThrow("malformed");
	await expect(dispatch.fetch(new Request(url, rpc("{}")))).rejects.toThrow("malformed");
	// The arguments are spliced in as sent, so they must be one JSON object: nothing can add a key of the entry point's.
	for (const body of [
		'{},"p_credential":"x"',
		'{"a":1},"p_name":"qorpera_complete_native_provider_login"',
		"[]",
		"null",
		"1",
		"not json",
	])
		for (const name of ["qorpera_identity_recovery_runtime_state", "qorpera_describe_native_tool_authority"])
			await expect(dispatch.fetch(`${ORIGIN}/rest/v1/rpc/${name}`, rpc(body))).rejects.toThrow("malformed");
	expect(sent).toHaveLength(2);
});

it("checks the holder's identity credential once, and an execution host's run replaces it with its machine's", async () => {
	const identity = { computeIdentityId: IDENTITY_ID, credential: IDENTITY_TOKEN, publishableKey: PUBLISHABLE_KEY };
	const build = (patch: Partial<typeof identity>) =>
		new NativeHostDispatch({ supabaseUrl: ORIGIN, serviceKey: SERVICE_KEY, identity: { ...identity, ...patch } });
	for (const patch of [
		{ computeIdentityId: "not-a-uuid" },
		{ credential: "short" },
		{ credential: `${IDENTITY_TOKEN}=` },
		{ publishableKey: SERVICE_KEY },
		{ publishableKey: "sb_secret_g2TestKey0123456789" },
	])
		expect(() => build(patch)).toThrow("identity credential is invalid");
	const { dispatch, sent } = dispatchFixture();
	const call = () => dispatch.fetch(`${ORIGIN}/rest/v1/rpc/qorpera_compute_identity_login_in_vault`, rpc("{}"));
	expect(() =>
		dispatch.begin(JOB_ID, { leaseToken: TOKEN_A, publishableKey: PUBLISHABLE_KEY, identityCredential: "short" }),
	).toThrow("identity credential is invalid");
	await call();
	const release = dispatch.begin(JOB_ID, {
		leaseToken: TOKEN_A,
		publishableKey: PUBLISHABLE_KEY,
		identityCredential: SLOT_TOKEN,
	});
	await call();
	release();
	// The next run's machine brings its own; until then the released run's credential stays, and no longer works.
	await call();
	expect(() =>
		dispatch.begin(JOB_ID, {
			leaseToken: TOKEN_B,
			publishableKey: PUBLISHABLE_KEY,
			identityCredential: NEXT_SLOT_TOKEN,
		}),
	).not.toThrow();
	await call();
	expect(
		sent.map((entry) => (JSON.parse(entry.init!.body as string) as { p_credential: string }).p_credential),
	).toEqual([IDENTITY_TOKEN, SLOT_TOKEN, SLOT_TOKEN, NEXT_SLOT_TOKEN]);
});

it("never sends a listed call outside a job or without its token, and holds one job's token at a time", async () => {
	const { dispatch, fetcher } = dispatchFixture();
	const call = () => dispatch.fetch(`${ORIGIN}/rest/v1/rpc/qorpera_describe_native_tool_authority`, rpc("{}"));
	await expect(call()).rejects.toThrow("outside a job");
	expect(() => dispatch.begin(JOB_ID, undefined)).toThrow("lease token");
	expect(() => dispatch.begin(JOB_ID, { leaseToken: "short", publishableKey: PUBLISHABLE_KEY })).toThrow(
		"lease token",
	);
	expect(() => dispatch.begin(JOB_ID, { leaseToken: TOKEN_A, publishableKey: SERVICE_KEY })).toThrow("publishable");
	const releaseA = dispatch.begin(JOB_ID, { leaseToken: TOKEN_A, publishableKey: PUBLISHABLE_KEY });
	expect(() => dispatch.begin(JOB_ID, { leaseToken: TOKEN_B, publishableKey: PUBLISHABLE_KEY })).toThrow(
		"another job",
	);
	releaseA();
	const releaseB = dispatch.begin(JOB_ID, { leaseToken: TOKEN_B, publishableKey: PUBLISHABLE_KEY });
	releaseA();
	await call();
	expect(fetcher.mock.calls.at(-1)?.[1]?.body).toContain(TOKEN_B);
	releaseB();
	await expect(call()).rejects.toThrow("outside a job");
	// A malformed call is refused as malformed, in a job or not.
	await expect(
		dispatch.fetch(`${ORIGIN}/rest/v1/rpc/qorpera_describe_native_tool_authority`, { method: "GET" }),
	).rejects.toThrow("malformed");
	dispatch.begin(JOB_ID, { leaseToken: TOKEN_A, publishableKey: PUBLISHABLE_KEY });
	const url = `${ORIGIN}/rest/v1/rpc/qorpera_describe_native_tool_authority`;
	await expect(dispatch.fetch(url, { method: "GET" })).rejects.toThrow("malformed");
	await expect(dispatch.fetch(`${url}?select=*`, rpc("{}"))).rejects.toThrow("malformed");
	await expect(dispatch.fetch(url, { method: "POST", body: new Uint8Array(2) })).rejects.toThrow("malformed");
	expect(fetcher).toHaveBeenCalledOnce();
});

function authorityFixture() {
	const {
		binding,
		authority: { identity },
	} = nativeToolAuthorityFixture();
	const authority: CloudRunnerNativeAuthority = {
		...binding,
		providerConnectionId: identity.providerConnectionId,
		providerConnectionVersion: identity.providerConnectionVersion,
		computeIdentityOwnershipKind: "member",
		computeIdentityOwnerUserId: identity.sponsorUserId!,
		credentialOwnershipKind: "member",
		credentialOwnerUserId: identity.sponsorUserId!,
		encryptedCapsuleReference: `native-capsule/${binding.credentialCapsuleId}`,
		attestationPolicySha256: "a".repeat(64),
		authenticationMode: "native_subscription",
		expiresAt: new Date(Date.now() + 60_000).toISOString(),
	};
	return { binding, authority };
}

it("the runner sends the job's lease token and the publishable key with a company execution", async () => {
	const { binding, authority } = authorityFixture();
	const bodies: unknown[] = [];
	const fetcher = vi.fn<typeof fetch>(async (_input, init) => {
		bodies.push(JSON.parse(String(init?.body)));
		return new Response("{}", { status: 422 });
	});
	const job = { jobId: binding.jobId, attemptCount: 1 };
	const withKey = new HttpNativeProviderComputerBridge("https://native.example/", "a".repeat(43), fetcher, {
		publishableKey: PUBLISHABLE_KEY,
	});
	await (await withKey.startCompany(authority, { ...job, leaseToken: TOKEN_A })).result.catch(() => {});
	await (await withKey.startCompany(authority, job)).result.catch(() => {});
	const withoutKey = new HttpNativeProviderComputerBridge("https://native.example/", "a".repeat(43), fetcher, {
		publishableKey: "not-a-publishable-key",
	});
	await (await withoutKey.startCompany(authority, { ...job, leaseToken: TOKEN_A })).result.catch(() => {});
	await expect(withKey.startCompany(authority, { ...job, leaseToken: "short" })).rejects.toThrow("unsupported");
	expect(bodies[0]).toMatchObject({
		job: { job_id: binding.jobId, attempt_count: 1, lease_token: TOKEN_A },
		native_host: { publishable_key: PUBLISHABLE_KEY },
	});
	for (const body of bodies.slice(1)) {
		expect(body).not.toHaveProperty("native_host");
		expect(JSON.stringify(body)).not.toContain(TOKEN_A);
	}
});

async function hostServiceFixture(outcome: "succeed" | "fail" | "wait" = "succeed") {
	const { binding, authority } = authorityFixture();
	const host = new NativeProviderHost({
		masterKey: randomBytes(32).toString("base64url"),
		computeIdentityId: binding.computeIdentityId,
		controlPlane: {
			validateExecution: async () => {},
			sendMessage: async () => {
				throw new Error("No send");
			},
			describeLogin: async () => {
				throw new Error("No login");
			},
			completeLogin: async () => {},
		},
		capsules: {
			get: async () => {
				throw new Error("No credentials");
			},
			put: async () => {},
		},
		harness: {
			beginLogin: async () => {
				throw new Error("No login");
			},
			execute: async () => {
				throw new Error("No model");
			},
		},
	});
	const { dispatch, sent } = dispatchFixture();
	const call = (name: string) => dispatch.fetch(`${ORIGIN}/rest/v1/rpc/${name}`, rpc("{}"));
	// Each execution makes a listed call through the dispatch, as the runtime's clients do; a stopped one makes its
	// cleanup call (presence forget) as it unwinds.
	const execute = vi.spyOn(host, "execute").mockImplementation(async (_request, signal) => {
		await call("qorpera_describe_native_tool_authority");
		if (outcome === "fail") throw new Error("Synthetic execution ended");
		if (outcome === "wait")
			await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
		if (outcome === "wait") {
			await call("qorpera_native_presence_forget");
			throw new Error("Synthetic execution stopped");
		}
		return {} as never;
	});
	const log = vi.spyOn(console, "error").mockImplementation(() => {});
	const bridgeToken = "a".repeat(43);
	const service = new HttpNativeProviderHostService(host, bridgeToken, "127.0.0.1", 0, undefined, dispatch);
	const url = `http://127.0.0.1:${await service.start()}/`;
	return { binding, authority, dispatch, sent, execute, log, service, url, bridgeToken, call };
}

/** A company execution's body as the runner's bridge builds it. */
async function executionBody(
	authority: CloudRunnerNativeAuthority,
	job: { jobId: string; attemptCount: number },
	identityCredential?: string,
) {
	let body: Record<string, unknown> = {};
	const capture = new HttpNativeProviderComputerBridge(
		"https://native.example/",
		"a".repeat(43),
		async (_input, init) => {
			body = JSON.parse(String(init?.body)) as Record<string, unknown>;
			return new Response("{}", { status: 422 });
		},
		{ publishableKey: PUBLISHABLE_KEY, ...(identityCredential ? { identityCredential } : {}) },
	);
	await (await capture.startCompany(authority, { ...job, leaseToken: TOKEN_A })).result.catch(() => {});
	return body;
}

it("a warm host holds each job's token for that execution only, and drops it when the execution succeeds", async () => {
	const f = await hostServiceFixture();
	try {
		const bridge = new HttpNativeProviderComputerBridge(f.url, f.bridgeToken, fetch, {
			publishableKey: PUBLISHABLE_KEY,
		});
		const job = { jobId: f.binding.jobId, attemptCount: 1 };
		await (await bridge.startCompany(f.authority, { ...job, leaseToken: TOKEN_A })).result.catch(() => {});
		await expect(f.call("qorpera_describe_native_tool_authority")).rejects.toThrow("outside a job");
		await (await bridge.startCompany(f.authority, { ...job, attemptCount: 2, leaseToken: TOKEN_B })).result.catch(
			() => {},
		);
		const sent = f.sent.map((call) => JSON.parse(call.init!.body as string) as Record<string, unknown>);
		expect(sent.map((body) => [body.p_job_id, body.p_job_lease_token])).toEqual([
			[f.binding.jobId, TOKEN_A],
			[f.binding.jobId, TOKEN_B],
		]);
		expect(f.execute).toHaveBeenCalledTimes(2);
		expect(JSON.stringify(f.execute.mock.calls)).not.toContain(TOKEN_A);
	} finally {
		await f.service.close();
	}
});

it("a host stopping keeps the job's token until its execution has cleaned up, then drops it", async () => {
	const f = await hostServiceFixture("wait");
	const bridge = new HttpNativeProviderComputerBridge(f.url, f.bridgeToken, fetch, {
		publishableKey: PUBLISHABLE_KEY,
	});
	const process = await bridge.startCompany(f.authority, {
		jobId: f.binding.jobId,
		attemptCount: 1,
		leaseToken: TOKEN_A,
	});
	const ended = process.result.catch(() => {});
	await vi.waitFor(() => expect(f.sent).toHaveLength(1));
	await f.service.close();
	await ended;
	await vi.waitFor(() => expect(f.sent).toHaveLength(2));
	expect(JSON.parse(f.sent[1]!.init!.body as string)).toMatchObject({
		p_name: "qorpera_native_presence_forget",
		p_job_lease_token: TOKEN_A,
	});
	await vi.waitFor(() => expect(f.call("qorpera_describe_native_tool_authority")).rejects.toThrow("outside a job"));
});

it("refuses an execution without a valid credential with a fixed code and never logs a token", async () => {
	const f = await hostServiceFixture("wait");
	const post = (body: unknown) =>
		fetch(`${f.url}execute`, {
			method: "POST",
			headers: { authorization: `Bearer ${f.bridgeToken}` },
			body: JSON.stringify(body),
		});
	try {
		const valid = await executionBody(f.authority, { jobId: f.binding.jobId, attemptCount: 1 });
		const job = valid.job as Record<string, unknown>;
		for (const body of [
			{ ...valid, native_host: { publishable_key: SERVICE_KEY } },
			{ ...valid, native_host: { publishable_key: PUBLISHABLE_KEY, extra: true } },
			{ ...valid, native_host: { publishable_key: PUBLISHABLE_KEY, identity_credential: "short" } },
			{ ...valid, native_host: { publishable_key: PUBLISHABLE_KEY, identity_credential: 7 } },
			{ ...valid, job: { ...job, lease_token: "short" } },
			{ ...valid, job: { job_id: job.job_id, attempt_count: 1 }, native_host: undefined },
		]) {
			const refused = await post(body);
			expect(refused.status).toBe(422);
			expect(await refused.json()).toEqual({ error: "request rejected", code: "NATIVE_HOST_CREDENTIAL" });
		}
		expect(f.execute).not.toHaveBeenCalled();
		// A second execution while one still holds the host is refused as busy.
		const first = await post(valid);
		await vi.waitFor(() => expect(f.execute).toHaveBeenCalledOnce());
		const second = await post({
			...valid,
			authority: {
				...(valid.authority as Record<string, unknown>),
				lease_id: "7e2a0000-0000-4000-8000-0000000000aa",
			},
		});
		expect(await second.json()).toEqual({ error: "request rejected", code: "NATIVE_HOST_BUSY" });
		expect(f.execute).toHaveBeenCalledOnce();
		const logged = f.log.mock.calls.flat().join("\n");
		expect(logged).toContain("Native provider request rejected");
		expect(logged).not.toContain(TOKEN_A);
		expect(logged).not.toContain(f.bridgeToken);
		await f.service.close();
		await first.text().catch(() => "");
	} finally {
		await f.service.close();
	}
});

it("an execution host's run brings its machine's identity credential, and the host's between-job calls use it", async () => {
	const f = await hostServiceFixture("wait");
	try {
		expect(
			() =>
				new HttpNativeProviderComputerBridge(f.url, f.bridgeToken, fetch, {
					publishableKey: PUBLISHABLE_KEY,
					identityCredential: "short",
				}),
		).toThrow("identity credential is invalid");
		const bridge = new HttpNativeProviderComputerBridge(f.url, f.bridgeToken, fetch, {
			publishableKey: PUBLISHABLE_KEY,
			identityCredential: SLOT_TOKEN,
		});
		const process = await bridge.startCompany(f.authority, {
			jobId: f.binding.jobId,
			attemptCount: 1,
			leaseToken: TOKEN_A,
		});
		const ended = process.result.catch(() => {});
		await vi.waitFor(() => expect(f.sent).toHaveLength(1));
		await f.dispatch.fetch(`${ORIGIN}/rest/v1/rpc/qorpera_list_native_provider_account_refreshes`, rpc("{}"));
		expect(JSON.parse(f.sent[1]!.init!.body as string)).toMatchObject({
			p_compute_identity_id: IDENTITY_ID,
			p_credential: SLOT_TOKEN,
		});
		const body = await executionBody(f.authority, { jobId: f.binding.jobId, attemptCount: 2 }, SLOT_TOKEN);
		expect(body.native_host).toEqual({ publishable_key: PUBLISHABLE_KEY, identity_credential: SLOT_TOKEN });
		await f.service.close();
		await ended;
	} finally {
		await f.service.close();
	}
});
