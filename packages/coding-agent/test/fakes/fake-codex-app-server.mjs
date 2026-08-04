/**
 * Hermetic stand-in for `codex app-server` (Qorpera Base slice 4 tests).
 *
 * Speaks the v2 subset the engine adapter targets: initialize → thread/start
 * → turn/start → item/started|completed → approval requests → turn/completed.
 * Scenario comes from QORPERA_FAKE_SCENARIO (a JSON file):
 *   { "commands": ["rm -rf x", ...], "reasoning": "…", "final": "…" }
 * Every approval decision received is appended to QORPERA_FAKE_OUT (JSONL)
 * so tests can assert what the engine answered.
 */
import { appendFileSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";

const scenario = JSON.parse(readFileSync(process.env.QORPERA_FAKE_SCENARIO, "utf-8"));
const outPath = process.env.QORPERA_FAKE_OUT;

let nextServerId = 1000;
const pendingServerRequests = new Map();

function send(message) {
	process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
}

function notify(method, params) {
	send({ method, params });
}

function serverRequest(method, params) {
	const id = nextServerId++;
	return new Promise((resolve) => {
		pendingServerRequests.set(id, resolve);
		send({ id, method, params });
	});
}

function record(entry) {
	if (outPath) appendFileSync(outPath, `${JSON.stringify(entry)}\n`);
}

const THREAD_ID = "thread-fake-1";
const TURN_ID = "turn-fake-1";

async function runTurn() {
	notify("turn/started", { threadId: THREAD_ID, turn: { id: TURN_ID } });

	if (scenario.reasoning) {
		notify("item/completed", {
			threadId: THREAD_ID,
			turnId: TURN_ID,
			completedAtMs: Date.now(),
			item: { type: "reasoning", id: "r1", summary: [scenario.reasoning], content: [] },
		});
	}

	const decisions = [];
	for (const [index, command] of (scenario.commands ?? []).entries()) {
		const itemId = `cmd-${index}`;
		notify("item/started", {
			threadId: THREAD_ID,
			turnId: TURN_ID,
			startedAtMs: Date.now(),
			item: { type: "commandExecution", id: itemId, command, cwd: process.cwd(), status: "inProgress", commandActions: [] },
		});
		const response = await serverRequest("item/commandExecution/requestApproval", {
			threadId: THREAD_ID,
			turnId: TURN_ID,
			itemId,
			startedAtMs: Date.now(),
			command,
		});
		const decision = response?.decision ?? "decline";
		decisions.push(decision);
		record({ kind: "commandApproval", command, decision });
		notify("item/completed", {
			threadId: THREAD_ID,
			turnId: TURN_ID,
			completedAtMs: Date.now(),
			item: {
				type: "commandExecution",
				id: itemId,
				command,
				cwd: process.cwd(),
				status: decision === "accept" ? "completed" : "declined",
				commandActions: [],
				aggregatedOutput: decision === "accept" ? "ok\n" : null,
				exitCode: decision === "accept" ? 0 : null,
			},
		});
	}

	notify("item/completed", {
		threadId: THREAD_ID,
		turnId: TURN_ID,
		completedAtMs: Date.now(),
		item: { type: "agentMessage", id: "m1", text: `${scenario.final ?? "done"} [decisions: ${decisions.join(",")}]` },
	});
	notify("turn/completed", {
		threadId: THREAD_ID,
		turn: { id: TURN_ID, usage: { inputTokens: 11, cachedInputTokens: 3, outputTokens: 7 } },
	});
}

const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
	const trimmed = line.trim();
	if (!trimmed) return;
	let message;
	try {
		message = JSON.parse(trimmed);
	} catch {
		return;
	}
	// Response to one of OUR requests (approval round-trip).
	if (message.id !== undefined && message.method === undefined) {
		const resolve = pendingServerRequests.get(message.id);
		if (resolve) {
			pendingServerRequests.delete(message.id);
			resolve(message.result);
		}
		return;
	}
	switch (message.method) {
		case "initialize":
			record({ kind: "initialize", clientInfo: message.params?.clientInfo });
			send({ id: message.id, result: { serverInfo: { name: "fake-codex", version: "0.0.1" } } });
			break;
		case "initialized":
			break;
		case "thread/start":
			record({ kind: "threadStart", params: message.params });
			send({
				id: message.id,
				result: {
					thread: { id: THREAD_ID },
					model: "gpt-5.3-codex",
					modelProvider: "openai",
					cwd: message.params?.cwd,
				},
			});
			break;
		case "turn/start":
			send({ id: message.id, result: { turn: { id: TURN_ID } } });
			void runTurn();
			break;
		default:
			if (message.id !== undefined) {
				send({ id: message.id, error: { code: -32601, message: `fake does not implement ${message.method}` } });
			}
	}
});
