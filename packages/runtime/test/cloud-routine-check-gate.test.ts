import { describe, expect, it, vi } from "vitest";
import {
	evaluateCheckGateTransition,
	runRoutineCheckBeforeWake,
	validateRoutineProbeUrl,
} from "../src/cloud-routine-check-gate.ts";

describe("cloud-routine-check-gate", () => {
	it("wakes only on failure or state transition and stays silent when healthy", () => {
		expect(evaluateCheckGateTransition(null, true)).toEqual({
			previousHealthy: null,
			stateChanged: false,
			shouldWake: false,
			consecutiveFailures: 0,
		});
		expect(evaluateCheckGateTransition(true, true)).toEqual({
			previousHealthy: true,
			stateChanged: false,
			shouldWake: false,
			consecutiveFailures: 0,
		});
		expect(evaluateCheckGateTransition(true, false, 0)).toEqual({
			previousHealthy: true,
			stateChanged: true,
			shouldWake: true,
			consecutiveFailures: 1,
		});
		expect(evaluateCheckGateTransition(false, false, 1)).toEqual({
			previousHealthy: false,
			stateChanged: false,
			shouldWake: true,
			consecutiveFailures: 2,
		});
		expect(evaluateCheckGateTransition(false, true, 2)).toEqual({
			previousHealthy: false,
			stateChanged: true,
			shouldWake: true,
			consecutiveFailures: 0,
		});
	});

	it("blocks SSRF private/metadata URLs and non-HTTPS remote URLs", () => {
		expect(validateRoutineProbeUrl("https://app.example.com/health").href).toBe("https://app.example.com/health");
		expect(() => validateRoutineProbeUrl("http://app.example.com/health")).toThrow(/https/);
		expect(() => validateRoutineProbeUrl("https://169.254.169.254/latest/meta-data")).toThrow(/blocked/);
		expect(() => validateRoutineProbeUrl("https://10.0.0.5/health")).toThrow(/blocked/);
		expect(() => validateRoutineProbeUrl("https://192.168.1.1/health")).toThrow(/blocked/);
		expect(() => validateRoutineProbeUrl("https://metadata.google.internal/")).toThrow(/blocked/);
		expect(() => validateRoutineProbeUrl("http://127.0.0.1:3000/health", false)).toThrow(/https/);
		expect(validateRoutineProbeUrl("http://127.0.0.1:3000/health", true).href).toBe("http://127.0.0.1:3000/health");
	});

	it("runs http_probe and skips wake when healthy, then wakes on status mismatch and recovery", async () => {
		const fetchMock = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(new Response("ok", { status: 200 }))
			.mockResolvedValueOnce(new Response("err", { status: 503 }))
			.mockResolvedValueOnce(new Response("ok", { status: 200 }));
		const controller = new AbortController();
		const check = {
			kind: "http_probe" as const,
			url: "https://billing.example.com/health",
			expectStatus: 200,
			timeoutMs: 2000,
		};

		const first = await runRoutineCheckBeforeWake(check, { healthy: null }, { fetch: fetchMock }, controller.signal);
		expect(first.healthy).toBe(true);
		expect(first.shouldWake).toBe(false);
		expect(first.status).toBe(200);

		const second = await runRoutineCheckBeforeWake(check, { healthy: true }, { fetch: fetchMock }, controller.signal);
		expect(second.healthy).toBe(false);
		expect(second.stateChanged).toBe(true);
		expect(second.shouldWake).toBe(true);
		expect(second.status).toBe(503);
		expect(second.consecutiveFailures).toBe(1);

		const third = await runRoutineCheckBeforeWake(
			check,
			{ healthy: false, consecutiveFailures: 1 },
			{ fetch: fetchMock },
			controller.signal,
		);
		expect(third.healthy).toBe(true);
		expect(third.stateChanged).toBe(true);
		expect(third.shouldWake).toBe(true);
		expect(third.consecutiveFailures).toBe(0);
	});

	it("runs deterministic code_checks and delegates state recording when provided", async () => {
		const runCodeChecks = vi
			.fn()
			.mockResolvedValueOnce({ ok: false, summary: "unit test failed", detail: "1 failing" });
		const recordResult = vi.fn().mockResolvedValueOnce({
			previousHealthy: true,
			stateChanged: true,
			shouldWake: true,
			consecutiveFailures: 1,
		});
		const decision = await runRoutineCheckBeforeWake(
			{ kind: "code_checks", repo: "acme/web", timeoutMs: 30_000 },
			{ healthy: true },
			{ runCodeChecks, recordResult },
			new AbortController().signal,
		);
		expect(runCodeChecks).toHaveBeenCalledWith({ repo: "acme/web", timeoutMs: 30_000 }, expect.any(AbortSignal));
		expect(recordResult).toHaveBeenCalledWith(
			{ healthy: false, summary: "unit test failed", detail: "1 failing" },
			expect.any(AbortSignal),
		);
		expect(decision.shouldWake).toBe(true);
		expect(decision.healthy).toBe(false);
	});
});
