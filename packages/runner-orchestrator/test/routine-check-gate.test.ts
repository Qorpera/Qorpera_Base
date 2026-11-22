import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { CloudRoutineScheduleReconciler, type CloudRunnerOrchestratorControlPlane } from "../src/orchestrator.ts";
import {
	evaluateCheckGateTransition,
	parseRoutineCheckBeforeWake,
	resolveAndValidateProbeAddress,
	runRoutineCheckBeforeWake,
	validateRoutineProbeUrl,
} from "../src/routine-check-gate.ts";

describe("routine-check-gate", () => {
	it("enforces HTTPS and blocks SSRF, metadata, private IP, and DNS-rebind targets", async () => {
		expect(validateRoutineProbeUrl("https://app.qorpera.site/health").hostname).toBe("app.qorpera.site");
		expect(() => validateRoutineProbeUrl("http://app.qorpera.site/health")).toThrow(/https/);
		expect(() => validateRoutineProbeUrl("https://169.254.169.254/latest/meta-data")).toThrow(/blocked/);
		expect(() => validateRoutineProbeUrl("https://10.0.0.1/health")).toThrow(/blocked/);
		expect(() => validateRoutineProbeUrl("https://127.0.0.1/health")).toThrow(/blocked/);
		expect(() => validateRoutineProbeUrl("https://metadata.google.internal/computeMetadata/v1")).toThrow(/blocked/);
		expect(() => validateRoutineProbeUrl("https://user:pass@app.qorpera.site/health")).toThrow(/credentials/);
		expect(validateRoutineProbeUrl("http://127.0.0.1:8080/health", true).port).toBe("8080");

		const nipIo = new URL("https://10.0.0.1.nip.io/health");
		await expect(
			resolveAndValidateProbeAddress(nipIo, {
				lookup: async () => [{ address: "10.0.0.1", family: 4 }],
			}),
		).rejects.toThrow(/blocked IP/);
		await expect(
			resolveAndValidateProbeAddress(new URL("https://rebind.example.com/health"), {
				lookup: async () => [
					{ address: "93.184.216.34", family: 4 },
					{ address: "169.254.169.254", family: 4 },
				],
			}),
		).rejects.toThrow(/blocked IP/);
		await expect(
			resolveAndValidateProbeAddress(new URL("https://v6.example.com/health"), {
				lookup: async () => [{ address: "::ffff:127.0.0.1", family: 6 }],
			}),
		).rejects.toThrow(/blocked IP/);
		await expect(
			resolveAndValidateProbeAddress(new URL("https://linklocal.example.com/health"), {
				lookup: async () => [{ address: "fe80::1", family: 6 }],
			}),
		).rejects.toThrow(/blocked IP/);
		expect(
			await resolveAndValidateProbeAddress(new URL("https://app.example.com/health"), {
				lookup: async () => [{ address: "93.184.216.34", family: 4 }],
			}),
		).toEqual({ address: "93.184.216.34", family: 4 });
	});

	it("parses strict checkBeforeWake configs and rejects plain http URLs", () => {
		expect(
			parseRoutineCheckBeforeWake({
				kind: "http_probe",
				url: "https://app.example.com/health",
				expectStatus: 200,
				timeoutMs: 3000,
			}),
		).toEqual({
			kind: "http_probe",
			url: "https://app.example.com/health",
			expectStatus: 200,
			timeoutMs: 3000,
		});
		expect(parseRoutineCheckBeforeWake({ kind: "http_probe", url: "http://app.example.com/health" })).toBeUndefined();
		expect(parseRoutineCheckBeforeWake({ kind: "code_checks", repo: "acme/app", timeoutMs: 30000 })).toEqual({
			kind: "code_checks",
			repo: "acme/app",
			timeoutMs: 30000,
		});
	});

	it("wakes only on failure or state transition across consecutive checks", () => {
		expect(evaluateCheckGateTransition(null, true, 0)).toEqual({
			previousHealthy: null,
			stateChanged: false,
			shouldWake: false,
			consecutiveFailures: 0,
		});
		expect(evaluateCheckGateTransition(true, true, 0)).toEqual({
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

	it("connects directly to the resolved IP without following redirects", async () => {
		let hits = 0;
		const server = createServer((_req, res) => {
			hits += 1;
			res.statusCode = hits === 1 ? 200 : 503;
			res.end("ok");
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
		try {
			const port = (server.address() as AddressInfo).port;
			const check = {
				kind: "http_probe" as const,
				url: `http://127.0.0.1:${port}/health`,
				expectStatus: 200,
				timeoutMs: 2000,
			};
			const first = await runRoutineCheckBeforeWake(
				check,
				{ healthy: null },
				{ allowLocalhost: true },
				new AbortController().signal,
			);
			expect(first.healthy).toBe(true);
			expect(first.shouldWake).toBe(false);
			const second = await runRoutineCheckBeforeWake(
				check,
				{ healthy: first.healthy },
				{ allowLocalhost: true },
				new AbortController().signal,
			);
			expect(second.healthy).toBe(false);
			expect(second.status).toBe(503);
			expect(second.shouldWake).toBe(true);
		} finally {
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
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
			{ kind: "code_checks", repo: "acme/app", timeoutMs: 30_000 },
			{ healthy: true },
			{ runCodeChecks, recordResult },
			new AbortController().signal,
		);
		expect(runCodeChecks).toHaveBeenCalledWith({ repo: "acme/app", timeoutMs: 30_000 }, expect.any(AbortSignal));
		expect(recordResult).toHaveBeenCalledWith(
			{ healthy: false, summary: "unit test failed", detail: "1 failing" },
			expect.any(AbortSignal),
		);
		expect(decision.shouldWake).toBe(true);
		expect(decision.stateChanged).toBe(true);
		expect(decision.consecutiveFailures).toBe(1);
	});

	it("skips wake enqueue in CloudRoutineScheduleReconciler when checkBeforeWake is healthy and enqueues on failure", async () => {
		let healthy = true;
		const routineId = randomUUID();
		const head = {
			routineId,
			companyId: randomUUID(),
			environmentId: randomUUID(),
			staffAgentId: randomUUID(),
			version: 1,
			effectiveAt: "2026-11-22T09:00:00.000Z",
			scheduleCursors: [
				{
					triggerId: "watchdog",
					lastScheduledFor: "2026-11-22T09:00:00.000Z",
					nextDueAt: "2026-11-22T09:05:00.000Z",
				},
			],
			triggers: [
				{
					id: "watchdog",
					kind: "schedule",
					intervalMinutes: 5,
					checkBeforeWake: {
						kind: "http_probe",
						url: "https://watchdog.qorpera.test/health",
						expectStatus: 200,
						timeoutMs: 2000,
					},
				},
			],
		};
		const enqueueRoutineWake = vi.fn(async () => ({ status: "created" as const, occurrenceId: randomUUID() }));
		const checkRoutineWake = vi.fn(async (input: { healthy: boolean }) => ({
			status: input.healthy ? ("skipped" as const) : ("wake_required" as const),
			healthy: input.healthy,
			previousHealthy: true,
			stateChanged: !input.healthy,
			shouldWake: !input.healthy,
			consecutiveFailures: input.healthy ? 0 : 1,
		}));
		const controlPlane = {
			listRoutineScheduleHeads: vi.fn(async () => ({ items: [head], hasMore: false })),
			enqueueRoutineWake,
			checkRoutineWake,
			advanceRoutineNextDue: vi.fn(async () => ({ status: "advanced" as const })),
		} as unknown as CloudRunnerOrchestratorControlPlane;

		const reconciler = new CloudRoutineScheduleReconciler({
			now: () => new Date("2026-11-22T09:05:00.000Z"),
			checkGate: {
				lookup: async () => [{ address: "93.184.216.34", family: 4 }],
				fetch: async () => new Response(healthy ? "ok" : "down", { status: healthy ? 200 : 503 }),
			},
		});
		await reconciler.reconcile(controlPlane);
		expect(checkRoutineWake).toHaveBeenCalledTimes(1);
		expect(enqueueRoutineWake).not.toHaveBeenCalled();

		healthy = false;
		await reconciler.reconcile(controlPlane);
		expect(checkRoutineWake).toHaveBeenCalledTimes(2);
		expect(enqueueRoutineWake).toHaveBeenCalledTimes(1);
		expect(enqueueRoutineWake).toHaveBeenCalledWith(
			expect.objectContaining({
				routineId,
				triggerId: "watchdog",
				payload: expect.objectContaining({
					checkBeforeWake: expect.objectContaining({
						healthy: false,
						status: 503,
						stateChanged: true,
						consecutiveFailures: 1,
					}),
				}),
			}),
		);
	});
});
