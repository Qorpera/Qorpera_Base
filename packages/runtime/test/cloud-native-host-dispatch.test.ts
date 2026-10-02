import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import {
	isNativeHostPublishableKey,
	NATIVE_HOST_CALLS,
	NATIVE_HOST_DISPATCH_DEFAULT,
	NativeHostDispatch,
	nativeHostDispatchMode,
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

function dispatchFixture(mode: "off" | "on" = "on") {
	const sent: { url: string; init: RequestInit | undefined }[] = [];
	const fetcher = vi.fn<typeof fetch>(async (input, init) => {
		sent.push({ url: String(input instanceof Request ? input.url : input), init });
		return new Response('{"ok":true}', { status: 200, headers: { "content-type": "application/json" } });
	});
	const dispatch = new NativeHostDispatch({ supabaseUrl: ORIGIN, serviceKey: SERVICE_KEY, mode, fetch: fetcher });
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
	const migration = readFileSync(
		new URL("../../../supabase/migrations/20260929999500_runtime_native_host_call.sql", import.meta.url),
		"utf8",
	);
	const insert = migration.slice(
		migration.indexOf("insert into public.qorpera_native_host_calls(name, scope) values"),
	);
	const rows = [...insert.slice(0, insert.indexOf(";\n")).matchAll(/\('(qorpera_[a-z0-9_]+)', '([a-z]+)'\)/g)];
	const long = new Set(
		[...migration.matchAll(/set budget = 'long' where name = '(qorpera_[a-z0-9_]+)'/g)].map((m) => m[1]),
	);
	const expected = new Map(
		rows
			.filter(([, , scope]) => scope !== "identity")
			.map(([, name]) => [name, long.has(name) ? "long" : "standard"]),
	);
	expect(rows).toHaveLength(83);
	expect(new Map(NATIVE_HOST_CALLS)).toEqual(expected);
	expect([...NATIVE_HOST_CALLS].filter(([, budget]) => budget === "long")).toEqual([
		["qorpera_validate_native_provider_execution_lease", "long"],
	]);
});

it("reads the switch strictly, off by default", () => {
	expect(NATIVE_HOST_DISPATCH_DEFAULT).toBe("off");
	expect(nativeHostDispatchMode(undefined)).toBe("off");
	expect(nativeHostDispatchMode("on")).toBe("on");
	expect(() => nativeHostDispatchMode("yes")).toThrow("QORPERA_NATIVE_HOST_DISPATCH");
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

it("leaves everything else on the service key: unlisted calls, the identity calls, storage and other origins", async () => {
	const { dispatch, sent } = dispatchFixture();
	dispatch.begin(JOB_ID, { leaseToken: TOKEN_A, publishableKey: PUBLISHABLE_KEY });
	const unlisted = rpc('{"p_compute_identity_id":"x"}');
	await dispatch.fetch(`${ORIGIN}/rest/v1/rpc/qorpera_list_native_provider_account_refreshes`, unlisted);
	await dispatch.fetch(`${ORIGIN}/storage/v1/object/qorpera-native-compute-capsules/x.capsule`, { method: "GET" });
	await dispatch.fetch("https://elsewhere.example/rest/v1/rpc/qorpera_describe_native_tool_authority", rpc("{}"));
	expect(sent.map((call) => call.url)).toEqual([
		`${ORIGIN}/rest/v1/rpc/qorpera_list_native_provider_account_refreshes`,
		`${ORIGIN}/storage/v1/object/qorpera-native-compute-capsules/x.capsule`,
		"https://elsewhere.example/rest/v1/rpc/qorpera_describe_native_tool_authority",
	]);
	expect(sent[0]!.init).toBe(unlisted);
	expect(JSON.stringify(sent)).not.toContain(TOKEN_A);
});

it("with the switch off, sends every call as before and holds nothing", async () => {
	const { dispatch, sent } = dispatchFixture("off");
	const release = dispatch.begin(JOB_ID, undefined);
	const init = rpc("{}");
	await dispatch.fetch(`${ORIGIN}/rest/v1/rpc/qorpera_describe_native_tool_authority`, init);
	release();
	expect(sent).toEqual([{ url: `${ORIGIN}/rest/v1/rpc/qorpera_describe_native_tool_authority`, init }]);
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
	dispatch.begin(JOB_ID, { leaseToken: TOKEN_A, publishableKey: PUBLISHABLE_KEY });
	dispatch.close();
	await expect(call()).rejects.toThrow("outside a job");
	await expect(
		dispatch.fetch(`${ORIGIN}/rest/v1/rpc/qorpera_describe_native_tool_authority`, { method: "GET" }),
	).rejects.toThrow("outside a job");
	dispatch.begin(JOB_ID, { leaseToken: TOKEN_A, publishableKey: PUBLISHABLE_KEY });
	await expect(
		dispatch.fetch(`${ORIGIN}/rest/v1/rpc/qorpera_describe_native_tool_authority`, { method: "GET" }),
	).rejects.toThrow("malformed");
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

async function hostServiceFixture(mode: "off" | "on") {
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
	const { dispatch, sent } = dispatchFixture(mode);
	// Each execution makes one listed call through the dispatch, as the runtime's clients do.
	const execute = vi.spyOn(host, "execute").mockImplementation(async () => {
		await dispatch.fetch(`${ORIGIN}/rest/v1/rpc/qorpera_describe_native_tool_authority`, rpc("{}"));
		throw new Error("Synthetic execution ended");
	});
	const log = vi.spyOn(console, "error").mockImplementation(() => {});
	const bridgeToken = "a".repeat(43);
	const service = new HttpNativeProviderHostService(host, bridgeToken, "127.0.0.1", 0, undefined, dispatch);
	const url = `http://127.0.0.1:${await service.start()}/`;
	return { binding, authority, dispatch, sent, execute, log, service, url, bridgeToken };
}

it("a warm host holds each job's token for that execution only", async () => {
	const f = await hostServiceFixture("on");
	try {
		const bridge = new HttpNativeProviderComputerBridge(f.url, f.bridgeToken, fetch, {
			publishableKey: PUBLISHABLE_KEY,
		});
		const job = { jobId: f.binding.jobId, attemptCount: 1 };
		await (await bridge.startCompany(f.authority, { ...job, leaseToken: TOKEN_A })).result.catch(() => {});
		await expect(
			f.dispatch.fetch(`${ORIGIN}/rest/v1/rpc/qorpera_describe_native_tool_authority`, rpc("{}")),
		).rejects.toThrow("outside a job");
		await (await bridge.startCompany(f.authority, { ...job, attemptCount: 2, leaseToken: TOKEN_B })).result.catch(
			() => {},
		);
		expect(f.sent.map((call) => JSON.parse(call.init!.body as string).p_job_lease_token)).toEqual([TOKEN_A, TOKEN_B]);
		expect(f.execute).toHaveBeenCalledTimes(2);
		expect(JSON.stringify(f.execute.mock.calls)).not.toContain(TOKEN_A);
	} finally {
		await f.service.close();
	}
});

it("with the switch on, refuses an execution without a valid credential and never logs a token", async () => {
	const f = await hostServiceFixture("on");
	try {
		const bridge = new HttpNativeProviderComputerBridge(f.url, f.bridgeToken);
		await expect(
			(await bridge.startCompany(f.authority, { jobId: f.binding.jobId, attemptCount: 1 })).result,
		).rejects.toThrow();
		const forged = await fetch(`${f.url}execute`, {
			method: "POST",
			headers: { authorization: `Bearer ${f.bridgeToken}` },
			body: JSON.stringify({
				schema: "qorpera.native-company-execution/v1",
				authority: {},
				job: { job_id: f.binding.jobId, attempt_count: 1, lease_token: TOKEN_A },
				native_host: { publishable_key: SERVICE_KEY },
			}),
		});
		expect(forged.status).toBe(422);
		await forged.arrayBuffer();
		expect(f.execute).not.toHaveBeenCalled();
		const logged = f.log.mock.calls.flat().join("\n");
		expect(logged).toContain("Native provider request rejected");
		expect(logged).not.toContain(TOKEN_A);
		expect(logged).not.toContain(f.bridgeToken);
	} finally {
		await f.service.close();
	}
});

it("with the switch off, runs an execution with or without the credential", async () => {
	const f = await hostServiceFixture("off");
	try {
		const bridge = new HttpNativeProviderComputerBridge(f.url, f.bridgeToken, fetch, {
			publishableKey: PUBLISHABLE_KEY,
		});
		await (await bridge.startCompany(f.authority, { jobId: f.binding.jobId, attemptCount: 1 })).result.catch(
			() => {},
		);
		await (
			await bridge.startCompany(f.authority, { jobId: f.binding.jobId, attemptCount: 2, leaseToken: TOKEN_A })
		).result.catch(() => {});
		expect(f.sent.map((call) => call.url)).toEqual([
			`${ORIGIN}/rest/v1/rpc/qorpera_describe_native_tool_authority`,
			`${ORIGIN}/rest/v1/rpc/qorpera_describe_native_tool_authority`,
		]);
		expect(JSON.stringify(f.sent)).not.toContain(TOKEN_A);
	} finally {
		await f.service.close();
	}
});
