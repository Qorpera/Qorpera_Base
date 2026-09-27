import {
	CompanyComputerActionNotStartedError,
	type CompanyComputerOperations,
	type CompanyComputerToolContent,
} from "@qorpera/cloud-client/cloud-company-computer-contract";
import type { JsonValue } from "@qorpera/contracts";
import { CloudCompanyComputerEffectControl } from "@qorpera/runtime/cloud-company-computer-effect-control";
import {
	type CompanyComputerGuestEffectCheck,
	CompanyComputerGuestEndpoint,
} from "@qorpera/runtime/cloud-company-computer-endpoint";
import {
	CompanyComputerActionFailedError,
	CompanyComputerScreenActionGate,
	CompanyComputerScreenAdmissionRefusedError,
	type CompanyComputerScreenLeaseControl,
} from "@qorpera/runtime/cloud-company-computer-leases";
import { CompanyComputerRegistryUnansweredError } from "@qorpera/runtime/cloud-company-computer-registry-http";
import {
	createCompanyComputerTools,
	parseCompanyComputerAction,
	parseCompanyComputerToolArguments,
} from "@qorpera/runtime/cloud-company-computer-tools";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	computerBinding,
	computerDeferred,
	computerEffect,
	computerId,
	computerLease,
	computerOperation,
	computerRun,
	computerScope,
} from "./fixtures/company-computer.ts";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const close of cleanup.splice(0)) await close();
});

function toolHarness(capabilities: readonly ("browser" | "desktop" | "shell")[] = ["browser", "desktop", "shell"]) {
	const run = computerRun();
	const order: string[] = [];
	const screens: CompanyComputerScreenLeaseControl = {
		acquire: vi.fn(async () => computerLease()),
		check: vi.fn(async (lease: ReturnType<typeof computerLease>) => structuredClone(lease)),
		renew: vi.fn(async (lease: ReturnType<typeof computerLease>) => structuredClone(lease)),
		release: vi.fn(async () => {
			order.push("released");
		}),
	};
	const effects: CompanyComputerGuestEffectCheck = {
		assertAuthorized: vi.fn(async () => undefined),
		begin: vi.fn(async () => new AbortController().signal),
		finish: vi.fn(async () => undefined),
	};
	const automation = {
		perform: vi.fn(
			async (): Promise<CompanyComputerToolContent> => ({ kind: "json", value: { page: "untrusted page content" } }),
		),
		stopBrowser: vi.fn(async (): Promise<void> => undefined),
	};
	const gate = new CompanyComputerScreenActionGate();
	const prepareScreen = vi.fn(async (): Promise<void> => undefined);
	const endpoint = new CompanyComputerGuestEndpoint({
		binding: computerBinding(),
		capabilities,
		resourceTarget: {},
		gate,
		effects,
		automation,
		assertScreenAdmitted: vi.fn(async () => undefined),
		prepareScreen,
	});
	// Test double only; real native ledger/transport coverage lives in the integration fixtures.
	const completed = new Map<string, CompanyComputerToolContent>();
	const operations: CompanyComputerOperations = {
		execute: vi.fn(async (options: Parameters<CompanyComputerOperations["execute"]>[0]) => {
			const { operation, authorize, perform, signal } = options;
			await authorize(operation, run.identity, signal);
			const existing = completed.get(operation.logicalOperationKey);
			if (existing) return existing;
			const output = await perform(operation, computerEffect(signal));
			await authorize(operation, run.identity, signal);
			order.push("receipt-completed");
			completed.set(operation.logicalOperationKey, output.content);
			return output.content;
		}),
	};
	const session = createCompanyComputerTools({ run, scope: computerScope(), screens, endpoint, operations });
	cleanup.push(session.close);
	const call = (name: string, action: JsonValue, operationKey = "test:1") => {
		const tool = session.tools.find((entry) => entry.name === name);
		if (!tool) throw new Error("NO_TEST_TOOL");
		return tool.execute(
			{ operationKey, action },
			{ companyId: run.identity.companyId, runId: run.identity.runId, signal: run.signal },
		);
	};
	return { session, call, run, order, screens, effects, automation, endpoint, operations, gate, prepareScreen };
}

describe("model-facing cloud computer tools (adapter tests, not native cloud acceptance)", () => {
	it("describes shared company sign-ins and keeps personal accounts and credential capture out of computer tools", () => {
		const harness = toolHarness();
		for (const tool of harness.session.tools) {
			expect(tool.description).toContain("Company website sign-ins are shared across agents");
			expect(tool.description).toContain("an assigned screen is not a private browser");
			expect(tool.description).toContain("Never sign personal accounts into the Company Computer");
			expect(tool.description).toContain("supported, authorized connector granted to the company");
			expect(tool.description).toContain("use a supported typed handoff");
			expect(tool.description).toContain("never request passwords or enter credential values through these tools");
			expect(tool.description).toContain("If the required connector or handoff is unavailable, report the blocker");
			expect(tool.description).toContain(
				"Model-provider subscription credentials never belong on the Company Computer",
			);
		}
	});

	it("keeps authorization free of physical launch and prepares only after receipt admission", async () => {
		const harness = toolHarness();
		const order: string[] = [];
		vi.mocked(harness.effects.begin).mockImplementation(async () => {
			order.push("receipt");
			return new AbortController().signal;
		});
		harness.prepareScreen.mockImplementation(async () => {
			order.push("ready");
		});
		harness.automation.perform.mockImplementation(async () => {
			order.push("execute");
			return { kind: "text", value: "done" };
		});
		await harness.endpoint.authorize(
			computerOperation(),
			computerRun().identity,
			computerLease(),
			computerRun().signal,
		);
		expect(order).toEqual([]);
		await harness.endpoint.perform(computerOperation(), computerLease(), computerEffect());
		expect(order).toEqual(["receipt", "ready", "execute"]);
	});

	it("does not report an open screen before the actual display becomes ready", async () => {
		const harness = toolHarness();
		const ready = computerDeferred<void>();
		harness.prepareScreen.mockReturnValue(ready.promise);
		let returned = false;
		const result = harness.call("computer_screen", { kind: "screen", action: "open" }).then((value) => {
			returned = true;
			return value;
		});
		await vi.waitFor(() => expect(harness.prepareScreen).toHaveBeenCalledOnce());
		expect(returned).toBe(false);
		expect(harness.effects.finish).not.toHaveBeenCalled();
		ready.resolve();
		await result;
		expect(returned).toBe(true);
		expect(harness.effects.finish).toHaveBeenCalledOnce();
		expect(harness.automation.perform).not.toHaveBeenCalled();
	});

	it("does not launch while releasing a screen or after denied receipt admission", async () => {
		const harness = toolHarness();
		const close = {
			...computerOperation(),
			tool: "computer_screen",
			arguments: { kind: "screen", action: "release" },
		};
		await harness.endpoint.perform(close, computerLease(), computerEffect());
		expect(harness.prepareScreen).not.toHaveBeenCalled();
		vi.mocked(harness.effects.begin).mockRejectedValue(new Error("RECEIPT_DENIED"));
		await expect(harness.endpoint.perform(computerOperation(), computerLease(), computerEffect())).rejects.toThrow(
			"RECEIPT_DENIED",
		);
		expect(harness.prepareScreen).not.toHaveBeenCalled();
	});

	it("retains occupancy after failed display preparation and never dispatches the tool", async () => {
		const harness = toolHarness();
		harness.prepareScreen.mockRejectedValue(new Error("DISPLAY_START_FAILED"));
		await expect(harness.endpoint.perform(computerOperation(), computerLease(), computerEffect())).rejects.toThrow(
			"DISPLAY_START_FAILED",
		);
		expect(harness.automation.perform).not.toHaveBeenCalled();
		expect(harness.effects.finish).not.toHaveBeenCalled();
	});

	it("does not dispatch after cancelled preparation resolves late", async () => {
		const harness = toolHarness();
		const ready = computerDeferred<void>();
		harness.prepareScreen.mockReturnValue(ready.promise);
		const stop = new AbortController();
		const result = harness.endpoint
			.perform(computerOperation(), computerLease(), computerEffect(stop.signal))
			.catch((error: unknown) => error);
		await vi.waitFor(() => expect(harness.prepareScreen).toHaveBeenCalledOnce());
		stop.abort();
		ready.resolve();
		expect(await result).toBeInstanceOf(Error);
		expect(harness.automation.perform).not.toHaveBeenCalled();
		expect(harness.effects.finish).not.toHaveBeenCalled();
		await harness.gate.fence(computerBinding(), 2, new AbortController().signal);
	});
	it.each(["SCREEN_OCCUPIED", "SCREEN_CAPACITY_EXHAUSTED"] as const)(
		"recovers from a confirmed %s only on a fresh explicit screen open",
		async (reason) => {
			const harness = toolHarness();
			const refusal = new CompanyComputerScreenAdmissionRefusedError(reason);
			vi.mocked(harness.screens.acquire).mockRejectedValueOnce(refusal);
			await expect(harness.call("computer_screen", { kind: "screen", action: "open" })).rejects.toBe(refusal);
			await expect(
				harness.call("computer_browser", { kind: "browser", action: "snapshot" }, "after-refusal:1"),
			).rejects.toBe(refusal);
			expect(harness.screens.acquire).toHaveBeenCalledOnce();
			expect(harness.operations.execute).not.toHaveBeenCalled();
			expect(harness.automation.perform).not.toHaveBeenCalled();

			// No operation was admitted for this key. The explicit retry obtains new authority.
			await harness.call("computer_screen", { kind: "screen", action: "open" });
			await harness.call("computer_browser", { kind: "browser", action: "snapshot" }, "after-refusal:1");
			expect(harness.screens.acquire).toHaveBeenCalledTimes(2);
			expect(harness.screens.acquire).toHaveBeenNthCalledWith(2, computerScope(), expect.any(AbortSignal));
			expect(harness.operations.execute).toHaveBeenCalledTimes(2);
			expect(harness.automation.perform).toHaveBeenCalledOnce();
		},
	);

	it("shares the pending admission when explicit recovery calls arrive concurrently", async () => {
		const harness = toolHarness();
		vi.mocked(harness.screens.acquire).mockRejectedValueOnce(
			new CompanyComputerScreenAdmissionRefusedError("SCREEN_OCCUPIED"),
		);
		await expect(harness.call("computer_screen", { kind: "screen", action: "open" })).rejects.toThrow(
			"SCREEN_OCCUPIED",
		);
		const admitting = computerDeferred<void>();
		const admitted = computerDeferred<ReturnType<typeof computerLease>>();
		vi.mocked(harness.screens.acquire).mockImplementationOnce(() => {
			admitting.resolve();
			return admitted.promise;
		});
		// Admission concurrency only; the production operation ledger is an independent prerequisite.
		vi.mocked(harness.operations.execute).mockResolvedValue({ kind: "json", value: { opened: true } });
		const first = harness.call("computer_screen", { kind: "screen", action: "open" }, "reopen:1");
		const second = harness.call("computer_screen", { kind: "screen", action: "open" }, "reopen:2");
		await admitting.promise;
		admitted.resolve(computerLease());
		await Promise.all([first, second]);
		expect(harness.screens.acquire).toHaveBeenCalledTimes(2);
	});

	it.each(["SCREEN_OCCUPIED", "SCREEN_CAPACITY_EXHAUSTED", "COMPUTER_REQUEST_STOPPED", "ACCESS_REVOKED"])(
		"does not retry an unclassified acquisition failure: %s",
		async (message) => {
			const harness = toolHarness();
			const failure = new Error(message);
			vi.mocked(harness.screens.acquire).mockRejectedValueOnce(failure);
			await expect(harness.call("computer_screen", { kind: "screen", action: "open" })).rejects.toBe(failure);
			await expect(harness.call("computer_screen", { kind: "screen", action: "open" })).rejects.toBe(failure);
			expect(harness.screens.acquire).toHaveBeenCalledOnce();
			expect(harness.operations.execute).not.toHaveBeenCalled();
		},
	);

	it("does not reacquire after a post-claim check fails, even with a refusal-shaped error", async () => {
		const harness = toolHarness();
		vi.mocked(harness.screens.check).mockRejectedValueOnce(
			new CompanyComputerScreenAdmissionRefusedError("SCREEN_OCCUPIED"),
		);
		await expect(harness.call("computer_screen", { kind: "screen", action: "open" })).rejects.toThrow(
			"SCREEN_LEASE_UNAVAILABLE",
		);
		await expect(harness.call("computer_screen", { kind: "screen", action: "open" })).rejects.toThrow(
			"SCREEN_LEASE_UNAVAILABLE",
		);
		expect(harness.screens.acquire).toHaveBeenCalledOnce();
		expect(harness.screens.release).toHaveBeenCalledOnce();
		expect(harness.operations.execute).not.toHaveBeenCalled();
	});

	it("keeps an established revoked lease terminal instead of admitting another driver", async () => {
		const harness = toolHarness();
		await harness.call("computer_screen", { kind: "screen", action: "open" });
		vi.mocked(harness.screens.check).mockRejectedValueOnce(new Error("ACCESS_REVOKED"));
		await expect(
			harness.call("computer_browser", { kind: "browser", action: "snapshot" }, "after-revocation:1"),
		).rejects.toThrow("SCREEN_LEASE_UNAVAILABLE");
		await expect(harness.call("computer_screen", { kind: "screen", action: "open" }, "reopen:1")).rejects.toThrow();
		expect(harness.screens.acquire).toHaveBeenCalledOnce();
		expect(harness.automation.perform).not.toHaveBeenCalled();
	});

	it("checks current run authority before retrying a refused admission", async () => {
		const harness = toolHarness();
		vi.mocked(harness.screens.acquire).mockRejectedValueOnce(
			new CompanyComputerScreenAdmissionRefusedError("SCREEN_OCCUPIED"),
		);
		await expect(harness.call("computer_screen", { kind: "screen", action: "open" })).rejects.toThrow(
			"SCREEN_OCCUPIED",
		);
		harness.run.assertActive = vi.fn(async () => {
			throw new Error("RUN_REVOKED");
		});
		await expect(harness.call("computer_screen", { kind: "screen", action: "open" })).rejects.toThrow("RUN_REVOKED");
		expect(harness.screens.acquire).toHaveBeenCalledOnce();
	});

	it("does not start recovery if cleanup closes the session during the run check", async () => {
		const harness = toolHarness();
		vi.mocked(harness.screens.acquire).mockRejectedValueOnce(
			new CompanyComputerScreenAdmissionRefusedError("SCREEN_OCCUPIED"),
		);
		await expect(harness.call("computer_screen", { kind: "screen", action: "open" })).rejects.toThrow(
			"SCREEN_OCCUPIED",
		);
		const checking = computerDeferred<void>();
		const checked = computerDeferred<void>();
		harness.run.assertActive = vi.fn(async () => {
			checking.resolve();
			await checked.promise;
		});
		const reopening = harness
			.call("computer_screen", { kind: "screen", action: "open" })
			.catch((error: unknown) => error);
		await checking.promise;
		await harness.session.close();
		checked.resolve();
		expect(await reopening).toMatchObject({ message: "COMPUTER_SESSION_CLOSED" });
		expect(harness.screens.acquire).toHaveBeenCalledOnce();
	});

	it("binds dispatch to the authorized run/screen and passes the existing receipt unchanged", async () => {
		const harness = toolHarness();
		await harness.call("computer_browser", { kind: "browser", action: "navigate", url: "https://example.com/" });
		const options = vi.mocked(harness.operations.execute).mock.calls[0][0];
		expect(options.operation).toMatchObject({
			tool: "computer_browser",
			logicalOperationKey: "test:1",
			target: { realm: "company_computer", binding: computerBinding(), resources: {} },
		});
		expect(harness.automation.perform).toHaveBeenCalledWith(
			{ kind: "browser", action: "navigate", url: "https://example.com/" },
			computerLease(),
			expect.objectContaining({
				receiptId: computerId(10),
				idempotencyKey: "a".repeat(64),
				identity: harness.run.identity,
			}),
			options.operation,
		);
		await harness.call("computer_browser", { kind: "browser", action: "navigate", url: "https://example.com/" });
		expect(harness.automation.perform).toHaveBeenCalledOnce();
		expect(harness.operations.execute).toHaveBeenCalledTimes(2);
	});

	it("exposes only capabilities supplied by the cloud endpoint", async () => {
		const harness = toolHarness(["browser"]);
		expect(harness.session.tools.map((tool) => tool.name)).toEqual([
			"computer_screen",
			"computer_browser",
			"computer_screenshot",
		]);
		await expect(harness.call("computer_screenshot", { kind: "screenshot", surface: "desktop" })).rejects.toThrow(
			"COMPUTER_TOOL_UNAVAILABLE",
		);
		expect(harness.screens.acquire).not.toHaveBeenCalled();
	});

	it.each<JsonValue>([
		{ kind: "browser", action: "list_tabs" },
		{ kind: "browser", action: "list_tabs", afterTabId: computerId(90) },
		{ kind: "browser", action: "select_tab", tabId: computerId(90) },
	])("routes tab discovery/selection through the existing exact operation and receipt", async (action) => {
		const harness = toolHarness(["browser"]);
		await harness.call("computer_browser", action);
		expect(vi.mocked(harness.operations.execute).mock.calls[0][0].operation).toMatchObject({
			tool: "computer_browser",
			toolVersion: "qorpera.company-computer-tools/v2",
			arguments: action,
			target: { realm: "company_computer", binding: computerBinding(), resources: {} },
		});
		expect(harness.automation.perform).toHaveBeenCalledWith(
			action,
			computerLease(),
			expect.objectContaining({
				receiptId: computerId(10),
				idempotencyKey: "a".repeat(64),
				identity: harness.run.identity,
			}),
			vi.mocked(harness.operations.execute).mock.calls[0][0].operation,
		);
	});

	it.each([
		{ operationKey: "x", action: { kind: "browser", action: "snapshot", host: "127.0.0.1" } },
		{ operationKey: "x", companyId: computerId(99), action: { kind: "browser", action: "snapshot" } },
		{ operationKey: "x", action: { kind: "desktop", action: "type", text: "x", display: ":2" } },
		{ operationKey: "x", action: { kind: "shell", command: "pwd", timeoutMs: 20_000 } },
		{ operationKey: "x", action: { kind: "browser", action: "select_tab", tabId: "chrome-target-1" } },
		{
			operationKey: "x",
			action: { kind: "browser", action: "select_tab", tabId: computerId(90), screenId: computerId(99) },
		},
		{ operationKey: "x", action: { kind: "browser", action: "list_tabs", afterTabId: null } },
		{ operationKey: "x", action: { kind: "browser", action: "list_tabs", afterTabId: "1" } },
		{ operationKey: "x", action: { kind: "browser", action: "list_tabs", profileId: computerId(99) } },
		{ operationKey: " ", action: { kind: "screen", action: "open" } },
	])("rejects model-supplied targeting or malformed operations", (arguments_) => {
		expect(() => parseCompanyComputerToolArguments(arguments_)).toThrow();
	});

	it.each(["file:///etc/passwd", "http://example.com", "https://user:password@example.com", "javascript:alert(1)"])(
		"rejects navigation outside the declared URL contract: %s",
		(url) => {
			expect(() => parseCompanyComputerAction({ kind: "browser", action: "navigate", url })).toThrow();
		},
	);

	it("bounds input and validates coordinates before cloud acquisition", async () => {
		const harness = toolHarness();
		await expect(
			harness.call("computer_desktop", { kind: "desktop", action: "move", x: 1920, y: 0 }),
		).rejects.toThrow("INVALID_SCREEN_COORDINATES");
		await expect(
			harness.call("computer_desktop", { kind: "desktop", action: "type", text: "x".repeat(16_385) }),
		).rejects.toThrow("INVALID_COMPUTER_ARGUMENTS");
		expect(harness.screens.acquire).not.toHaveBeenCalled();
	});

	it("releases occupancy only after the operation's final check, leaving the desktop's persistent state intact", async () => {
		const harness = toolHarness();
		await expect(harness.call("computer_screen", { kind: "screen", action: "release" })).resolves.toEqual({
			kind: "json",
			value: { screenId: computerId(6), status: "release_requested" },
		});
		expect(harness.order).toEqual(["receipt-completed", "released"]);
		expect(harness.automation.perform).not.toHaveBeenCalled();
		await expect(harness.call("computer_screen", { kind: "screen", action: "open" }, "test:2")).rejects.toThrow(
			"COMPUTER_RUN_MISMATCH",
		);
		expect(harness.screens.acquire).toHaveBeenCalledOnce();
	});

	it("refuses foreign runtime caller identity before acquiring a resource", async () => {
		const harness = toolHarness();
		await expect(
			harness.session.tools[0].execute(
				{ operationKey: "x", action: { kind: "screen", action: "open" } },
				{ companyId: computerId(99), runId: computerId(7), signal: harness.run.signal },
			),
		).rejects.toThrow("COMPUTER_RUN_MISMATCH");
		expect(harness.screens.acquire).not.toHaveBeenCalled();
	});

	it("does not return automation output after the injected effect boundary revokes access", async () => {
		const harness = toolHarness();
		let receipts = 0;
		harness.effects.assertAuthorized = vi.fn(
			async ({ receipt }: Parameters<CompanyComputerGuestEffectCheck["assertAuthorized"]>[0]) => {
				if (receipt && ++receipts === 2) throw new Error("ACCESS_REVOKED");
			},
		);
		await expect(harness.call("computer_browser", { kind: "browser", action: "snapshot" })).rejects.toThrow(
			"ACCESS_REVOKED",
		);
		expect(harness.order).toEqual([]);
		expect(harness.automation.perform).toHaveBeenCalledOnce();
		expect(harness.automation.stopBrowser).toHaveBeenCalledOnce();
	});
});

describe("guest dispatch adapter", () => {
	it("rechecks authority before preserving a browser after a recoverable targeting error", async () => {
		const harness = toolHarness();
		harness.automation.perform.mockRejectedValue(
			new CompanyComputerActionNotStartedError("BROWSER_TARGET_AMBIGUOUS"),
		);
		let checks = 0;
		harness.effects.assertAuthorized = vi.fn(async () => {
			if (++checks === 2) throw new Error("ACCESS_REVOKED");
		});
		await expect(harness.endpoint.perform(computerOperation(), computerLease(), computerEffect())).rejects.toThrow(
			"ACCESS_REVOKED",
		);
		expect(harness.effects.assertAuthorized).toHaveBeenCalledTimes(2);
		expect(harness.automation.stopBrowser).toHaveBeenCalledOnce();
	});

	it("never treats an authority error as a recoverable automation preflight rejection", async () => {
		const harness = toolHarness();
		harness.effects.assertAuthorized = vi.fn(async () => {
			throw new CompanyComputerActionNotStartedError("BROWSER_TARGET_AMBIGUOUS");
		});
		await expect(harness.endpoint.perform(computerOperation(), computerLease(), computerEffect())).rejects.toThrow(
			"BROWSER_TARGET_AMBIGUOUS",
		);
		expect(harness.automation.perform).not.toHaveBeenCalled();
		expect(harness.automation.stopBrowser).toHaveBeenCalledOnce();
	});

	it("retains occupancy while final-check failure drains browser control", async () => {
		const harness = toolHarness();
		const draining = computerDeferred<void>();
		const stopped = computerDeferred<void>();
		let checks = 0;
		harness.effects.assertAuthorized = vi.fn(async () => {
			if (++checks === 2) throw new Error("ACCESS_REVOKED");
		});
		harness.automation.stopBrowser.mockImplementation(() => {
			draining.resolve();
			return stopped.promise;
		});
		const result = harness.endpoint
			.perform(computerOperation(), computerLease(), computerEffect())
			.catch((error: unknown) => error);
		await draining.promise;
		let acknowledged = false;
		const fence = harness.gate.fence(computerBinding(), 2, new AbortController().signal).then(() => {
			acknowledged = true;
		});
		await Promise.resolve();
		expect(acknowledged).toBe(false);
		stopped.resolve();
		expect(await result).toBeInstanceOf(Error);
		await fence;
		expect(acknowledged).toBe(true);
		expect(harness.automation.stopBrowser).toHaveBeenCalledOnce();
	});

	it("starts browser shutdown immediately when cancellation arrives during the final check", async () => {
		const harness = toolHarness();
		const checking = computerDeferred<void>();
		const checked = computerDeferred<void>();
		const draining = computerDeferred<void>();
		const stopped = computerDeferred<void>();
		const stop = new AbortController();
		let checks = 0;
		harness.effects.assertAuthorized = vi.fn(async () => {
			if (++checks === 2) {
				checking.resolve();
				await checked.promise;
			}
		});
		harness.automation.stopBrowser.mockImplementation(() => {
			draining.resolve();
			return stopped.promise;
		});
		const result = harness.endpoint
			.perform(computerOperation(), computerLease(), computerEffect(stop.signal))
			.catch((error: unknown) => error);
		await checking.promise;
		stop.abort();
		await draining.promise;
		expect(await result).toBeInstanceOf(Error);
		let acknowledged = false;
		const fence = harness.gate.fence(computerBinding(), 2, new AbortController().signal).then(() => {
			acknowledged = true;
		});
		checked.resolve();
		await Promise.resolve();
		expect(acknowledged).toBe(false);
		stopped.resolve();
		await fence;
		expect(harness.automation.stopBrowser).toHaveBeenCalledOnce();
	});

	it("quarantines a failed browser drain after final authorization rejects", async () => {
		const harness = toolHarness();
		let checks = 0;
		harness.effects.assertAuthorized = vi.fn(async () => {
			if (++checks === 2) throw new Error("ACCESS_REVOKED");
		});
		harness.automation.stopBrowser.mockRejectedValue(new Error("PROCESS_NOT_REAPED"));
		await expect(harness.endpoint.perform(computerOperation(), computerLease(), computerEffect())).rejects.toThrow(
			"COMPUTER_ACTION_NOT_DRAINED",
		);
		await expect(
			harness.endpoint.perform(computerOperation(), { ...computerLease(), epoch: 2 }, computerEffect()),
		).rejects.toThrow("SCREEN_ACTION_STILL_RUNNING");
	});

	it("keeps the browser and drains the resource when the action's own page work fails and ends", async () => {
		const harness = toolHarness();
		harness.automation.perform.mockRejectedValueOnce(
			new CompanyComputerActionFailedError(new Error("page.goto: Timeout 10000ms exceeded")),
		);
		await expect(harness.endpoint.perform(computerOperation(), computerLease(), computerEffect())).rejects.toThrow(
			"page.goto: Timeout 10000ms exceeded",
		);
		expect(harness.automation.stopBrowser).not.toHaveBeenCalled();
		// Drained like a success, so releasing the screen later does not drain the desktop.
		expect(harness.effects.finish).toHaveBeenCalledOnce();
		// Nothing of it runs: the slot is free for the next action at once.
		await harness.endpoint.perform(computerOperation(), computerLease(), computerEffect());
		expect(harness.automation.perform).toHaveBeenCalledTimes(2);
		expect(harness.effects.finish).toHaveBeenCalledTimes(2);
	});

	it("with the real effect control, drains a settled failure only after the gate let go, so nothing stops", async () => {
		const actions: string[] = [];
		let unanswered = false;
		const registry = {
			call: vi.fn(async (_method: string, args: Record<string, unknown>) => {
				actions.push(String(args.p_action));
				if (args.p_action === "check" && unanswered)
					throw new CompanyComputerRegistryUnansweredError(new Error("request timed out"));
				if (args.p_action === "begin" || args.p_action === "check")
					return { state: "admitted", resourceLeaseId: computerId(90), validForMs: 30000 };
				if (args.p_action === "finish") return { state: "drained" };
				return { state: "authorized" };
			}),
		};
		const run = computerRun();
		// The real control aborts the signal `begin` returned when it finishes.
		const effects = new CloudCompanyComputerEffectControl({
			run: { ...run, binding: { fixture: true } } as never,
			scope: computerScope(),
			control: registry,
		});
		const automation = {
			perform: vi.fn(async (): Promise<CompanyComputerToolContent> => {
				throw new CompanyComputerActionFailedError(new Error("page.goto: Timeout 10000ms exceeded"));
			}),
			stopBrowser: vi.fn(async (): Promise<void> => undefined),
		};
		const endpoint = new CompanyComputerGuestEndpoint({
			binding: computerBinding(),
			capabilities: ["browser", "desktop", "shell"],
			resourceTarget: {},
			effects,
			gate: new CompanyComputerScreenActionGate(),
			automation,
			assertScreenAdmitted: async () => undefined,
			prepareScreen: async () => undefined,
		});
		await expect(endpoint.perform(computerOperation(), computerLease(), computerEffect())).rejects.toThrow(
			"page.goto: Timeout 10000ms exceeded",
		);
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(actions).toEqual(["begin", "check", "check", "finish"]);
		expect(automation.stopBrowser).not.toHaveBeenCalled();
		// An authority check before the work that gets no answer stops nothing either.
		actions.length = 0;
		unanswered = true;
		const next = { ...computerEffect(), receiptId: computerId(91) };
		await expect(endpoint.perform(computerOperation(), computerLease(), next)).rejects.toThrow(
			"OFFICE_REGISTRY_UNCONFIRMED",
		);
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(actions).toEqual(["begin", "check", "finish"]);
		expect(automation.stopBrowser).not.toHaveBeenCalled();
		expect(automation.perform).toHaveBeenCalledOnce();
	});

	it("stops nothing and drains when the recheck after a typed failure, or the final check, gets no answer", async () => {
		const harness = toolHarness();
		const unanswered = new CompanyComputerRegistryUnansweredError(new Error("request timed out"));
		let checks = 0;
		harness.effects.assertAuthorized = vi.fn(async () => {
			if (++checks === 2) throw unanswered;
		});
		harness.automation.perform.mockRejectedValueOnce(new CompanyComputerActionFailedError(new Error("PAGE_FAILED")));
		await expect(harness.endpoint.perform(computerOperation(), computerLease(), computerEffect())).rejects.toBe(
			unanswered,
		);
		expect(harness.automation.stopBrowser).not.toHaveBeenCalled();
		expect(harness.effects.finish).toHaveBeenCalledOnce();
		// The work succeeded, but its final authority check got no answer.
		checks = 2;
		harness.effects.assertAuthorized = vi.fn(async () => {
			if (++checks === 4) throw unanswered;
		});
		await expect(harness.endpoint.perform(computerOperation(), computerLease(), computerEffect())).rejects.toBe(
			unanswered,
		);
		expect(harness.automation.perform).toHaveBeenCalledTimes(2);
		expect(harness.automation.stopBrowser).not.toHaveBeenCalled();
		expect(harness.effects.finish).toHaveBeenCalledTimes(2);
	});

	it("drains a settled failure again before release when its first drain got no answer", async () => {
		const harness = toolHarness();
		harness.automation.perform.mockRejectedValueOnce(new CompanyComputerActionFailedError(new Error("PAGE_FAILED")));
		vi.mocked(harness.effects.finish).mockRejectedValueOnce(
			new CompanyComputerRegistryUnansweredError(new Error("request timed out")),
		);
		await expect(harness.endpoint.perform(computerOperation(), computerLease(), computerEffect())).rejects.toThrow(
			"PAGE_FAILED",
		);
		expect(harness.effects.finish).toHaveBeenCalledOnce();
		await harness.endpoint.drainSettled(new AbortController().signal);
		expect(harness.effects.finish).toHaveBeenCalledTimes(2);
		expect(vi.mocked(harness.effects.finish).mock.calls[1][0]).toEqual(
			vi.mocked(harness.effects.finish).mock.calls[0][0],
		);
		// Confirmed once: nothing is left to drain.
		await harness.endpoint.drainSettled(new AbortController().signal);
		expect(harness.effects.finish).toHaveBeenCalledTimes(2);
		// A successful action whose drain got no answer is reported as before and retried too.
		vi.mocked(harness.effects.finish).mockRejectedValueOnce(
			new CompanyComputerRegistryUnansweredError(new Error("request timed out")),
		);
		await expect(harness.endpoint.perform(computerOperation(), computerLease(), computerEffect())).rejects.toThrow(
			"OFFICE_REGISTRY_UNCONFIRMED",
		);
		await harness.endpoint.drainSettled(new AbortController().signal);
		expect(harness.effects.finish).toHaveBeenCalledTimes(4);
	});

	it("still stops the browser and keeps the resource when authority is refused before the work", async () => {
		const harness = toolHarness();
		harness.effects.assertAuthorized = vi.fn(async () => {
			throw new Error("ACCESS_REVOKED");
		});
		await expect(harness.endpoint.perform(computerOperation(), computerLease(), computerEffect())).rejects.toThrow(
			"ACCESS_REVOKED",
		);
		expect(harness.automation.stopBrowser).toHaveBeenCalledOnce();
		expect(harness.effects.finish).not.toHaveBeenCalled();
	});

	it("still stops the browser and keeps the resource when authority is gone after a typed failure", async () => {
		const harness = toolHarness();
		let checks = 0;
		harness.effects.assertAuthorized = vi.fn(async () => {
			if (++checks === 2) throw new Error("ACCESS_REVOKED");
		});
		harness.automation.perform.mockRejectedValueOnce(new CompanyComputerActionFailedError(new Error("PAGE_FAILED")));
		await expect(harness.endpoint.perform(computerOperation(), computerLease(), computerEffect())).rejects.toThrow(
			"ACCESS_REVOKED",
		);
		expect(harness.automation.stopBrowser).toHaveBeenCalledOnce();
		expect(harness.effects.finish).not.toHaveBeenCalled();
	});

	it("drains the resource of an action refused before it ran", async () => {
		const harness = toolHarness();
		const running = computerDeferred<CompanyComputerToolContent>();
		harness.automation.perform.mockReturnValueOnce(running.promise);
		const first = harness.endpoint.perform(computerOperation(), computerLease(), computerEffect());
		await vi.waitFor(() => expect(harness.automation.perform).toHaveBeenCalledOnce());
		await expect(harness.endpoint.perform(computerOperation(), computerLease(), computerEffect())).rejects.toThrow(
			"SCREEN_ACTION_STILL_RUNNING",
		);
		expect(harness.effects.finish).toHaveBeenCalledOnce();
		running.resolve({ kind: "json", value: { page: "done" } });
		await first;
		expect(harness.effects.finish).toHaveBeenCalledTimes(2);
	});

	it("retains the physical-slot quarantine when browser shutdown fails", async () => {
		const harness = toolHarness();
		harness.automation.perform.mockRejectedValue(new Error("PAGE_FAILED"));
		harness.automation.stopBrowser.mockRejectedValue(new Error("PROCESS_NOT_REAPED"));
		await expect(harness.endpoint.perform(computerOperation(), computerLease(), computerEffect())).rejects.toThrow(
			"COMPUTER_ACTION_NOT_DRAINED",
		);
		await expect(
			harness.endpoint.perform(computerOperation(), { ...computerLease(), epoch: 2 }, computerEffect()),
		).rejects.toThrow("SCREEN_ACTION_STILL_RUNNING");
		expect(harness.automation.perform).toHaveBeenCalledOnce();
	});

	it("rejects changed operation targets, unsupported capabilities and forged effect receipts", async () => {
		const harness = toolHarness(["browser"]);
		for (const operation of [
			{ ...computerOperation(), target: { ...computerOperation().target, host: "member-device" } },
			{
				...computerOperation(),
				target: {
					realm: "company_computer",
					binding: { ...computerBinding(), screenId: computerId(99) },
					resources: {},
				},
			},
			{ ...computerOperation(), toolVersion: "legacy" },
			{
				...computerOperation(),
				tool: "computer_shell",
				arguments: { kind: "shell", command: "pwd", timeoutMs: 1000 },
			},
		])
			await expect(harness.endpoint.perform(operation, computerLease(), computerEffect())).rejects.toThrow(
				"COMPUTER_OPERATION_MISMATCH",
			);
		await expect(
			harness.endpoint.perform(computerOperation(), computerLease(), { ...computerEffect(), receiptId: "forged" }),
		).rejects.toThrow("COMPUTER_EFFECT_RECEIPT_REQUIRED");
		expect(harness.automation.perform).not.toHaveBeenCalled();
	});

	it("waits for the browser cancellation channel to drain before acknowledging takeover", async () => {
		const stop = new AbortController();
		const started = computerDeferred<void>();
		const drained = computerDeferred<void>();
		const gate = new CompanyComputerScreenActionGate();
		const endpoint = new CompanyComputerGuestEndpoint({
			binding: computerBinding(),
			capabilities: ["browser"],
			resourceTarget: {},
			gate,
			effects: {
				assertAuthorized: async () => undefined,
				begin: async () => new AbortController().signal,
				finish: async () => undefined,
			},
			assertScreenAdmitted: async () => undefined,
			prepareScreen: async () => undefined,
			automation: {
				perform: async (_action, _lease, context) => {
					started.resolve();
					await new Promise<void>((resolve) =>
						context.signal.addEventListener("abort", () => resolve(), { once: true }),
					);
					context.signal.throwIfAborted();
					return { kind: "text", value: "not released" };
				},
				stopBrowser: () => drained.promise,
			},
		});
		const result = endpoint
			.perform(computerOperation(), computerLease(), computerEffect(stop.signal))
			.catch((error: unknown) => error);
		await started.promise;
		stop.abort();
		expect(await result).toBeInstanceOf(Error);
		let acknowledged = false;
		const fence = gate.fence(computerBinding(), 2, new AbortController().signal).then(() => {
			acknowledged = true;
		});
		await Promise.resolve();
		expect(acknowledged).toBe(false);
		drained.resolve();
		await fence;
		expect(acknowledged).toBe(true);
	});
});
