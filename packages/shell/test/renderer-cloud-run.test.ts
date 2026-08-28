import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { createSourceFile, isFunctionDeclaration, ScriptKind, ScriptTarget } from "typescript";
import { describe, expect, it, vi } from "vitest";

const renderer = readFileSync(new URL("../userland/renderer.js", import.meta.url), "utf8");
const source = createSourceFile("renderer.js", renderer, ScriptTarget.ESNext, true, ScriptKind.JS);
const names = ["currentCloudSessionRunState", "applyCloudSessionRunState", "stopAgent", "sendRpc"];
// Run the actual production handlers with a minimal DOM/IPC boundary. This
// avoids duplicating their state machine or starting any model/browser runtime.
const handlers = source.statements.filter(
	(node) => isFunctionDeclaration(node) && names.includes(node.name?.text ?? ""),
);
if (handlers.length !== names.length) throw new Error("Cloud Stop handler fixture is incomplete");

function harness() {
	const stop = { hidden: true, disabled: false };
	const status = { textContent: "" };
	const rpc = vi.fn(async (_frame: Record<string, unknown>, _trail: string) => ({ ok: true, status: "cancelled" }));
	const context = createContext({
		currentRoomId: null,
		currentStaffId: "staff-a",
		currentSession: "session-a.jsonl",
		cloudSessionRunState: {
			staffAgentId: "staff-a",
			trailFile: "session-a.jsonl",
			healthy: true,
			run: { runId: "run-a", status: "leased", canCancel: true },
		},
		pendingStopRunId: null,
		runtimeReconnecting: false,
		agentExited: false,
		agentWorking: false,
		$: (id: string) => (id === "stopBtn" ? stop : status),
		canUseProfile: () => true,
		window: { qorpera: { rpcSend: rpc } },
		showToast: vi.fn(),
		applyCurrentSessionRuntime: vi.fn(),
		syncThreadActivityFromCloud: vi.fn(),
	});
	runInContext(handlers.map((node) => node.getText(source)).join("\n"), context);
	return { context, rpc, stop, status, run: (expression: string): unknown => runInContext(expression, context) };
}

describe("renderer cloud Stop", () => {
	it("shows Stop and working state from the cloud run without a local provider process", () => {
		const { run, stop, status, context } = harness();
		expect(run("applyCloudSessionRunState()")).toBe(true);
		expect(stop).toEqual({ hidden: false, disabled: false });
		expect(status.textContent).toBe("working…");
		expect(context.agentWorking).toBe(true);
	});

	it("sends the displayed run id and trail, and never edits the composer or transcript", async () => {
		const { run, rpc, context } = harness();
		await run("stopAgent()");
		expect(rpc).toHaveBeenCalledExactlyOnceWith({ type: "abort", runId: "run-a" }, "session-a.jsonl");
		expect(context.cloudSessionRunState.run).toBeNull();
		expect(context.showToast).toHaveBeenCalledWith("Agent stopped.");
	});

	it.each([
		"cloudSessionRunState.healthy = false",
		"cloudSessionRunState.run.canCancel = false",
		"canUseProfile = () => false",
	])("does not send when disabled: %s", async (change) => {
		const { run, rpc, stop } = harness();
		run(change);
		run("applyCloudSessionRunState()");
		expect(stop.hidden || stop.disabled).toBe(true);
		await run("stopAgent()");
		expect(rpc).not.toHaveBeenCalled();
	});

	it("does not attach another thread's run or a staff run to a room", () => {
		const { run } = harness();
		run("currentSession = 'session-b.jsonl'");
		expect(run("applyCloudSessionRunState()")).toBe(false);
		run("currentSession = 'session-a.jsonl'; currentRoomId = 'room-a'");
		expect(run("applyCloudSessionRunState()")).toBe(false);
	});

	it("deduplicates clicks and does not clear a newer run when an older Stop returns", async () => {
		const { run, rpc, context, stop } = harness();
		let finish: ((result: { ok: boolean; status: string }) => void) | undefined;
		rpc.mockImplementation(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		);
		const pending = run("stopAgent()");
		expect(stop.disabled).toBe(true);
		await run("stopAgent()");
		expect(rpc).toHaveBeenCalledTimes(1);
		run(
			"cloudSessionRunState = { ...cloudSessionRunState, run: { runId: 'run-b', status: 'leased', canCancel: true } }",
		);
		finish?.({ ok: true, status: "cancelled" });
		await pending;
		expect(context.cloudSessionRunState.run.runId).toBe("run-b");
		expect(context.pendingStopRunId).toBeNull();
	});

	it("leaves the run visible and gives feedback when the cloud cannot confirm Stop", async () => {
		const { run, rpc, context } = harness();
		rpc.mockRejectedValue(new Error("Could not confirm that the cloud run stopped."));
		await run("stopAgent()");
		expect(context.cloudSessionRunState.run.runId).toBe("run-a");
		expect(context.showToast).toHaveBeenCalledWith("Could not confirm that the cloud run stopped.");
		expect(context.pendingStopRunId).toBeNull();
	});

	it("treats an already-completed run as finished, not as a new cancellation", async () => {
		const { run, rpc, context } = harness();
		rpc.mockResolvedValue({ ok: true, status: "completed" });
		await run("stopAgent()");
		expect(context.showToast).toHaveBeenCalledWith("This run has already finished.");
		expect(rpc).toHaveBeenCalledTimes(1);
	});
});
