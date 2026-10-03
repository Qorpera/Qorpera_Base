import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { ServiceHttpFetch } from "../src/http-transport.ts";
import { EXECUTION_HOST_CALLS, executionHostFetch } from "../src/shared-execution-host-call.ts";
import {
	supabaseSharedExecutionIdentityAuthority,
	supabaseSharedExecutionLoginCustody,
} from "../src/shared-execution-identity.ts";

const supabaseUrl = "https://project.supabase.test";
const credential = randomBytes(32).toString("base64url");
const host = { hostId: "qorpera-exec-test", credential, publishableKey: "sb_publishable_test" };
const runId = "30000000-0000-4000-8000-000000000001";
const computeIdentityId = "30000000-0000-4000-8000-000000000011";

interface Sent {
	url: string;
	init: RequestInit | undefined;
}

function recording(answer: () => Response = () => Response.json(null)): { fetch: ServiceHttpFetch; sent: Sent[] } {
	const sent: Sent[] = [];
	return {
		sent,
		fetch: async (input, init) => {
			sent.push({ url: String(input), init });
			return answer();
		},
	};
}

describe("execution host calls (G2-3e)", () => {
	it("sends each listed call through the entry point of its budget with the publishable key and the host's credential", async () => {
		const { fetch, sent } = recording();
		const hostFetch = executionHostFetch(supabaseUrl, host, fetch);
		for (const [name] of EXECUTION_HOST_CALLS)
			await hostFetch(`${supabaseUrl}/rest/v1/rpc/${name}`, {
				method: "POST",
				redirect: "error",
				headers: { apikey: "service-key", authorization: "Bearer service-key", "content-type": "application/json" },
				body: JSON.stringify({ p_allocation_id: runId }),
			});
		expect(sent.map((call) => call.url)).toEqual(
			[...EXECUTION_HOST_CALLS].map(
				([, budget]) =>
					`${supabaseUrl}/rest/v1/rpc/${budget === "long" ? "qorpera_execution_host_call_long" : "qorpera_execution_host_call"}`,
			),
		);
		expect(EXECUTION_HOST_CALLS.get("qorpera_release_runtime_machine")).toBe("long");
		for (const [index, [name]] of [...EXECUTION_HOST_CALLS].entries()) {
			const call = sent[index] as Sent;
			expect(JSON.parse(String(call.init?.body))).toEqual({
				p_host_id: host.hostId,
				p_credential: credential,
				p_name: name,
				p_args: { p_allocation_id: runId },
			});
			// The service key never leaves with a call of the service's own.
			expect(call.init?.headers).toEqual({ apikey: host.publishableKey, "content-type": "application/json" });
			expect(call.init?.redirect).toBe("error");
		}
	});

	it("never follows a redirect with the credential, whatever the caller asked", async () => {
		const { fetch, sent } = recording();
		await executionHostFetch(supabaseUrl, host, fetch)(`${supabaseUrl}/rest/v1/rpc/qorpera_runtime_ended_runners`, {
			method: "POST",
			redirect: "follow",
			body: "{}",
		});
		expect(sent[0]?.init?.redirect).toBe("error");
	});

	it("refuses any other database request and passes requests to other origins through", async () => {
		const { fetch, sent } = recording();
		const hostFetch = executionHostFetch(supabaseUrl, host, fetch);
		const post = { method: "POST", body: "{}" };
		await expect(hostFetch(`${supabaseUrl}/rest/v1/rpc/qorpera_native_host_call`, post)).rejects.toThrow(
			"Not an execution host call",
		);
		await expect(hostFetch(`${supabaseUrl}/rest/v1/qorpera_runners`, post)).rejects.toThrow(
			"Not an execution host call",
		);
		await expect(hostFetch(`${supabaseUrl}/storage/v1/object/x`, post)).rejects.toThrow("Not an execution host call");
		await expect(
			hostFetch(`${supabaseUrl}/rest/v1/rpc/qorpera_runtime_ended_runners`, { method: "GET" }),
		).rejects.toThrow("Execution host call is malformed");
		await expect(
			hostFetch(`${supabaseUrl}/rest/v1/rpc/qorpera_runtime_ended_runners?select=*`, post),
		).rejects.toThrow("Execution host call is malformed");
		for (const body of ["[]", "null", '{"p_runner_ids":[]},"p_credential":"x"', "not json"])
			await expect(
				hostFetch(`${supabaseUrl}/rest/v1/rpc/qorpera_runtime_ended_runners`, { method: "POST", body }),
			).rejects.toThrow("Execution host call is malformed");
		expect(sent).toEqual([]);
		await hostFetch("http://127.0.0.1:20001/v1/assignment", { method: "POST", body: "{}" });
		expect(sent.map((call) => call.url)).toEqual(["http://127.0.0.1:20001/v1/assignment"]);
	});

	it("needs a valid host id, credential and publishable key", () => {
		const { fetch } = recording();
		expect(() => executionHostFetch(supabaseUrl, { ...host, hostId: "Exec Host" }, fetch)).toThrow(
			"Execution host id is invalid",
		);
		expect(() => executionHostFetch(supabaseUrl, { ...host, credential: "short" }, fetch)).toThrow(
			"Execution host credential is invalid",
		);
		expect(() => executionHostFetch(supabaseUrl, { ...host, publishableKey: "" }, fetch)).toThrow(
			"Execution host calls need the project's publishable key",
		);
	});

	it("names the run an identity is read for, through the host's fetch", async () => {
		const sent: Sent[] = [];
		const hostFetch = executionHostFetch(supabaseUrl, host, async (input, init) => {
			sent.push({ url: String(input), init });
			return Response.json(false);
		});
		const signal = new AbortController().signal;
		expect(await supabaseSharedExecutionLoginCustody(supabaseUrl, hostFetch)(computeIdentityId, signal, runId)).toBe(
			false,
		);
		expect(sent.map((call) => call.url)).toEqual([`${supabaseUrl}/rest/v1/rpc/qorpera_execution_host_call`]);
		expect(JSON.parse(String(sent[0]?.init?.body))).toEqual({
			p_host_id: host.hostId,
			p_credential: credential,
			p_name: "qorpera_compute_identity_login_in_vault",
			p_args: { p_compute_identity_id: computeIdentityId, p_run_id: runId },
		});
		const authority = supabaseSharedExecutionIdentityAuthority(supabaseUrl, hostFetch);
		await expect(authority(computeIdentityId, signal, "not-a-run")).rejects.toThrow("Run id is invalid");
		await expect(authority("not-an-identity", signal, runId)).rejects.toThrow("Compute Identity id is invalid");
		expect(sent).toHaveLength(1);
	});
});
