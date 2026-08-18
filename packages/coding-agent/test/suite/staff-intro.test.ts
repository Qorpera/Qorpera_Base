import { fauxAssistantMessage } from "@qorpera/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSessionRuntime } from "../../src/core/agent-session-runtime.ts";
import type { KernelIntentCapability } from "../../src/core/kernel-broker.ts";
import { runRpcMode } from "../../src/modes/rpc/rpc-mode.ts";
import { createHarness, getAssistantTexts, getMessageText, getUserTexts, type Harness } from "./harness.ts";

const rpcIo = vi.hoisted(() => ({
	outputLines: [] as string[],
	lineHandler: undefined as ((line: string) => void) | undefined,
}));

const kernelBroker = vi.hoisted(() => ({
	intent: undefined as KernelIntentCapability | undefined,
}));

vi.mock("../../src/core/kernel-broker.js", () => ({
	beginKernelBinding: vi.fn(),
	consumeKernelIntent: vi.fn(() => kernelBroker.intent),
	handleKernelBrokerResponse: vi.fn(() => false),
	isKernelBindingEstablished: vi.fn(() => true),
	requestKernelGateConsumption: vi.fn(async () => false),
	requestKernelGateTrust: vi.fn(async () => false),
	requestKernelMessageCreation: vi.fn(async () => false),
}));

vi.mock("../../src/core/output-guard.js", () => ({
	flushRawStdout: vi.fn(async () => {}),
	takeOverStdout: vi.fn(),
	waitForRawStdoutBackpressure: vi.fn(async () => {}),
	writeRawStdout: (line: string) => {
		rpcIo.outputLines.push(line);
	},
}));

vi.mock("../../src/modes/interactive/theme/theme.js", () => ({ theme: {} }));

vi.mock("../../src/modes/rpc/jsonl.js", () => ({
	attachJsonlLineReader: vi.fn((_stream: NodeJS.ReadableStream, onLine: (line: string) => void) => {
		rpcIo.lineHandler = onLine;
		return () => {
			rpcIo.lineHandler = undefined;
		};
	}),
	serializeJsonLine: (value: unknown) => `${JSON.stringify(value)}\n`,
}));

type NodeListener = Parameters<typeof process.on>[1];

interface ListenerSnapshot {
	stdinEnd: NodeListener[];
	signals: Map<NodeJS.Signals, NodeListener[]>;
}

function createKernelIntent(): KernelIntentCapability {
	return {
		nonce: "intro-nonce",
		sessionId: "staff-session",
		requestHash: "request-hash",
		attended: true,
		issuedAt: new Date().toISOString(),
		expiresAt: new Date(Date.now() + 60_000).toISOString(),
		budget: {
			maxCalls: 1,
			maxInputTokens: 1_000,
			maxOutputTokens: 1_000,
			maxCostUsd: 1,
		},
		signature: "signature",
	};
}

function takeListenerSnapshot(): ListenerSnapshot {
	const signals: NodeJS.Signals[] = process.platform === "win32" ? ["SIGTERM"] : ["SIGTERM", "SIGHUP"];
	return {
		stdinEnd: process.stdin.listeners("end") as NodeListener[],
		signals: new Map(signals.map((signal) => [signal, process.listeners(signal) as NodeListener[]])),
	};
}

function restoreListeners(snapshot: ListenerSnapshot): void {
	for (const listener of process.stdin.listeners("end") as NodeListener[]) {
		if (!snapshot.stdinEnd.includes(listener)) process.stdin.off("end", listener);
	}
	for (const [signal, previousListeners] of snapshot.signals) {
		for (const listener of process.listeners(signal) as NodeListener[]) {
			if (!previousListeners.includes(listener)) process.off(signal, listener);
		}
	}
}

function createRuntimeHost(harness: Harness): AgentSessionRuntime {
	return {
		session: harness.session,
		newSession: vi.fn(async () => ({ cancelled: true })),
		switchSession: vi.fn(async () => ({ cancelled: true })),
		fork: vi.fn(async () => ({ cancelled: true, selectedText: "" })),
		dispose: vi.fn(async () => {}),
		setRebindSession: vi.fn(),
	} as unknown as AgentSessionRuntime;
}

function parseOutputLines(): Array<Record<string, unknown>> {
	return rpcIo.outputLines
		.flatMap((line) => line.split("\n"))
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("staff intro", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
		kernelBroker.intent = undefined;
		rpcIo.outputLines = [];
		rpcIo.lineHandler = undefined;
	});

	it("persists hidden intro context and the first assistant response without a user message", async () => {
		const harness = await createHarness();
		const intent = createKernelIntent();
		let providerUserText = "";
		let activeIntentAtIntroStart: KernelIntentCapability | undefined;
		harness.setResponses([
			(context) => {
				providerUserText = context.messages
					.filter((message) => message.role === "user")
					.map((message) => getMessageText(message))
					.join("\n");
				return fauxAssistantMessage("Hello. I am ready to take ownership of operations.");
			},
		]);
		harness.session.subscribe((event) => {
			if (event.type === "message_start" && event.message.role === "custom") {
				activeIntentAtIntroStart = (harness.session as unknown as { _activeKernelIntent?: KernelIntentCapability })
					._activeKernelIntent;
			}
		});

		try {
			await harness.session.withKernelIntent(intent, () =>
				harness.session.sendStaffIntro("  Introduce yourself to the founder.  "),
			);

			expect(activeIntentAtIntroStart).toBe(intent);
			expect(providerUserText).toBe("Introduce yourself to the founder.");
			expect(getUserTexts(harness)).toEqual([]);
			expect(getAssistantTexts(harness)).toEqual(["Hello. I am ready to take ownership of operations."]);
			expect(harness.session.messages[0]).toMatchObject({
				role: "custom",
				customType: "qorpera_staff_intro",
				content: "Introduce yourself to the founder.",
				display: false,
				details: { source: "kernel" },
			});

			const entries = harness.sessionManager.getEntries();
			expect(entries.map((entry) => entry.type)).toEqual(["custom_message", "message"]);
			expect(entries[0]).toMatchObject({
				type: "custom_message",
				customType: "qorpera_staff_intro",
				display: false,
			});
			expect(entries[1]).toMatchObject({ type: "message", message: { role: "assistant" } });
		} finally {
			harness.cleanup();
		}
	});

	it("accepts staff_intro only through a host-bound RPC command", async () => {
		const listenerSnapshot = takeListenerSnapshot();
		const harness = await createHarness();
		harness.setResponses([fauxAssistantMessage("I have arrived.")]);
		vi.stubEnv("QORPERA_KERNEL_REQUIRED", "1");
		kernelBroker.intent = createKernelIntent();

		try {
			void runRpcMode(createRuntimeHost(harness));
			await vi.waitFor(() => expect(rpcIo.lineHandler).toBeDefined());
			rpcIo.lineHandler?.(JSON.stringify({ id: "intro", type: "staff_intro", message: "Introduce yourself." }));

			await vi.waitFor(() => {
				expect(parseOutputLines()).toContainEqual({
					id: "intro",
					type: "response",
					command: "staff_intro",
					success: true,
				});
				expect(getAssistantTexts(harness)).toEqual(["I have arrived."]);
			});
			expect(getUserTexts(harness)).toEqual([]);
			expect(harness.session.messages[0]).toMatchObject({ role: "custom", display: false });
		} finally {
			harness.cleanup();
			restoreListeners(listenerSnapshot);
		}
	});

	it("rejects staff_intro from an ordinary RPC client", async () => {
		const listenerSnapshot = takeListenerSnapshot();
		const harness = await createHarness();
		vi.stubEnv("QORPERA_KERNEL_REQUIRED", "0");
		kernelBroker.intent = createKernelIntent();

		try {
			void runRpcMode(createRuntimeHost(harness));
			await vi.waitFor(() => expect(rpcIo.lineHandler).toBeDefined());
			rpcIo.lineHandler?.(JSON.stringify({ id: "intro", type: "staff_intro", message: "Introduce yourself." }));

			await vi.waitFor(() => {
				expect(parseOutputLines()).toContainEqual({
					id: "intro",
					type: "response",
					command: "staff_intro",
					success: false,
					error: "staff_intro is only available to a host-bound agent run",
				});
			});
			expect(harness.session.messages).toEqual([]);
		} finally {
			harness.cleanup();
			restoreListeners(listenerSnapshot);
		}
	});
});
