import { fauxAssistantMessage, fauxToolCall } from "@qorpera/pi-ai";
import { Check } from "typebox/value";
import { afterEach, describe, expect, it } from "vitest";
import { type Authority, type AuthorityConfig, classifyToolCall } from "../../src/core/authority.ts";
import { allToolNames, createToolDefinition } from "../../src/core/tools/index.ts";
import {
	createRequestConnectionTool,
	REQUEST_CONNECTION_TOOL_NAME,
	type RequestConnectionToolInput,
} from "../../src/index.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

const request: RequestConnectionToolInput = {
	displayName: "GitHub",
	purpose: "Review pull requests and prepare releases.",
	destinations: [{ host: "api.github.com", note: "GitHub API" }, { host: "uploads.github.com" }],
	secretNames: ["github_token"],
	recipeId: "github:oauth-v1",
};

describe("request_connection tool", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("is a bounded built-in proposal with no default authority effect", () => {
		const definition = createToolDefinition(REQUEST_CONNECTION_TOOL_NAME, process.cwd());
		expect(allToolNames.has(REQUEST_CONNECTION_TOOL_NAME)).toBe(true);
		expect(Check(definition.parameters, request)).toBe(true);
		expect(Check(definition.parameters, { ...request, secretValue: "must-not-enter-the-request" })).toBe(false);
		expect(Check(definition.parameters, { ...request, purpose: "x".repeat(1_001) })).toBe(false);
		expect(
			Check(definition.parameters, { ...request, destinations: Array(33).fill({ host: "api.example.com" }) }),
		).toBe(false);

		const authority: Authority = { root: process.cwd(), configPath: `${process.cwd()}/authority.toml` };
		const config: AuthorityConfig = {
			classes: {
				money: { mode: "gate" },
				identity: { mode: "gate" },
				irreversible: { mode: "gate" },
				authority: { mode: "gate" },
			},
			tools: {},
		};
		expect(classifyToolCall(authority, config, REQUEST_CONNECTION_TOOL_NAME, request, process.cwd())).toBeUndefined();
		expect(
			classifyToolCall(
				authority,
				{ ...config, tools: { [REQUEST_CONNECTION_TOOL_NAME]: "identity" } },
				REQUEST_CONNECTION_TOOL_NAME,
				request,
				process.cwd(),
			),
		).toBe("identity");
	});

	it("rejects semantic duplicates and extra credential fields on direct execution", async () => {
		const tool = createRequestConnectionTool();
		await expect(
			tool.execute("request-call-extra", { ...request, token: "raw-secret" } as RequestConnectionToolInput),
		).rejects.toThrow("bounded single-line");
		await expect(
			tool.execute("request-call-host", {
				...request,
				destinations: [{ host: "api.github.com" }, { host: "API.GITHUB.COM" }],
			}),
		).rejects.toThrow("unique exact HTTPS hosts");
		await expect(
			tool.execute("request-call-secret", { ...request, secretNames: ["github", "GITHUB"] }),
		).rejects.toThrow("unique reference names");
	});

	it("emits the exact standard lifecycle args and returns a neutral result", async () => {
		const harness = await createHarness({ initialActiveToolNames: [REQUEST_CONNECTION_TOOL_NAME] });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall(REQUEST_CONNECTION_TOOL_NAME, request, { id: "request-call-1" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("I will continue with work that does not need the connection."),
		]);

		await harness.session.prompt("Prepare the release and ask for anything you need.");

		expect(harness.eventsOfType("tool_execution_start")).toContainEqual({
			type: "tool_execution_start",
			toolCallId: "request-call-1",
			toolName: REQUEST_CONNECTION_TOOL_NAME,
			args: request,
		});
		const end = harness.eventsOfType("tool_execution_end").find((event) => event.toolCallId === "request-call-1");
		expect(end).toMatchObject({
			type: "tool_execution_end",
			toolCallId: "request-call-1",
			toolName: REQUEST_CONNECTION_TOOL_NAME,
			isError: false,
		});
		const resultText = harness.session.messages
			.filter((message) => message.role === "toolResult")
			.map(getMessageText)
			.join("\n");
		expect(resultText).toBe(
			"Connection request sent to the founder. No service was connected and no access was granted; continue with other work while waiting.",
		);
	});
});
