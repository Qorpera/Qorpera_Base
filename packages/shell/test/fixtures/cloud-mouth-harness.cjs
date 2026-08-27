const assert = require("node:assert/strict");
const fs = require("node:fs/promises");

async function main() {
	const args = process.argv.slice(2);
	assert(!args.includes("--output-last-message"));
	const config = args.find((arg) => arg.startsWith("mcp_servers.qorpera="));
	assert(config?.includes("required=true"));
	assert(args.includes("--ephemeral"));
	assert(args.includes("--ignore-user-config"));
	assert(args.includes("model_reasoning_effort=low"));
	const urlMatch = /^mcp_servers\.qorpera=\{url=("(?:\\.|[^"])*")/.exec(config);
	assert(urlMatch);
	const url = JSON.parse(urlMatch[1]);
	assert(process.env.QORPERA_AGENT_SEND_TOKEN?.length === 43);
	let prompt = "";
	for await (const chunk of process.stdin) prompt += chunk.toString("utf8");
	assert(prompt.includes("digital company"));
	assert(prompt.includes("send_message"));
	let id = 0;
	async function rpc(method, params) {
		const response = await fetch(url, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				accept: "application/json, text/event-stream",
				authorization: `Bearer ${process.env.QORPERA_AGENT_SEND_TOKEN}`,
			},
			body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
		});
		assert.equal(response.status, 200);
		const value = await response.json();
		assert(!value.error && !value.result.isError);
		return value.result;
	}
	const initialization = await rpc("initialize", { protocolVersion: "2025-06-18" });
	assert.equal(initialization.protocolVersion, "2025-06-18");
	const { tools } = await rpc("tools/list");
	assert.equal(tools.length, 1);
	assert.equal(tools[0].name, "send_message");
	console.log(JSON.stringify({ type: "thread.started", thread_id: "cloud-mouth-probe" }));
	console.log(JSON.stringify({ type: "item.completed", item: { type: "reasoning", text: "PRIVATE_REASONING_SENTINEL" } }));
	console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "PRIVATE_ASSISTANT_SENTINEL" } }));
	console.error("PRIVATE_DIAGNOSTIC_SENTINEL");
	const progress = { name: "send_message", arguments: {
		idempotencyKey: "progress-1", text: "Checking the Company File.", phase: "progress",
	} };
	const first = await rpc("tools/call", progress);
	const replay = await rpc("tools/call", progress);
	assert.deepEqual(first.structuredContent, replay.structuredContent);
	await fs.writeFile("mouth-probe.txt", "The cloud agent changed this Company File.\n");
	await rpc("tools/call", { name: "send_message", arguments: {
		idempotencyKey: "final-1", text: "The Company File has been updated.", phase: "final",
	} });
	console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "PRIVATE_FINAL_SENTINEL" } }));
	console.log(JSON.stringify({ type: "turn.completed", usage: {} }));
}

main().catch(() => { process.stderr.write("probe failed\n"); process.exitCode = 1; });
