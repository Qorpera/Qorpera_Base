// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type Cloud,
	CloudRpcError,
	connectionLost,
	createCloud,
	DATABASE_ANSWER_MS,
	describeError,
} from "../src/cloud/client.ts";

const clouds: Cloud[] = [];

afterEach(async () => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
	for (const cloud of clouds.splice(0)) await cloud.supabase.auth.dispose();
});

function silentCloud(): { cloud: Cloud; asked: string[] } {
	const asked: string[] = [];
	vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) => {
		asked.push(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
		return new Promise<Response>((_, reject) => {
			init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
		});
	});
	const cloud = createCloud({
		projectUrl: "https://silent.example.invalid",
		publishableKey: "sb_publishable_fixture123",
		objectGatewayUrl: "https://objects.example.invalid",
	});
	clouds.push(cloud);
	return { cloud, asked };
}

describe("a cloud that never answers", () => {
	it("gives up on a database call after twenty seconds, as a lost connection", async () => {
		vi.useFakeTimers();
		const { cloud, asked } = silentCloud();
		let outcome: unknown;
		void cloud.rpc("qorpera_list_hosted_profiles").then(
			() => {
				outcome = "answered";
			},
			(error: unknown) => {
				outcome = error;
			},
		);
		await vi.advanceTimersByTimeAsync(DATABASE_ANSWER_MS - 1);
		expect(asked).toEqual(["https://silent.example.invalid/rest/v1/rpc/qorpera_list_hosted_profiles"]);
		expect(outcome).toBeUndefined();
		await vi.advanceTimersByTimeAsync(1);
		expect(outcome).toBeInstanceOf(CloudRpcError);
		expect(connectionLost(outcome)).toBe(true);
		expect(describeError(outcome)).toBe("Qorpera can't be reached right now. Check your connection and try again.");
	});

	it("leaves calls outside the database alone, as they may rightly take long", async () => {
		vi.useFakeTimers();
		const { cloud, asked } = silentCloud();
		let settled = false;
		void cloud.supabase.functions.invoke("member-company-gateway/v1/slow").finally(() => {
			settled = true;
		});
		await vi.advanceTimersByTimeAsync(3 * DATABASE_ANSWER_MS);
		expect(asked.some((url) => url.includes("/functions/v1/member-company-gateway/v1/slow"))).toBe(true);
		expect(settled).toBe(false);
	});

	it("keeps a call the app itself cancels a cancel, never a lost connection", async () => {
		const { cloud } = silentCloud();
		const stop = new AbortController();
		const call = cloud.supabase.rpc("qorpera_list_hosted_profiles").abortSignal(stop.signal);
		stop.abort();
		const { error } = await call;
		expect(error).not.toBeNull();
		expect(connectionLost(new CloudRpcError("qorpera_list_hosted_profiles", error!, 0))).toBe(false);
	});
});
