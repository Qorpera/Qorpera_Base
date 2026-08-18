import { Check } from "typebox/value";
import { afterEach, describe, expect, it } from "vitest";
import {
	handleComputerBrokerFrame,
	setComputerBrokerIntent,
	setComputerBrokerWriter,
} from "../../src/core/computer-broker-client.ts";
import {
	allToolNames,
	COMPUTER_TOOL_NAME,
	createComputerTool,
	createToolDefinition,
} from "../../src/core/tools/index.ts";

describe("use_computer tool", () => {
	afterEach(() => {
		setComputerBrokerWriter(undefined);
		setComputerBrokerIntent(undefined);
	});

	it("is a staff-capable built-in with bounded Playwright-style actions", () => {
		const definition = createToolDefinition(COMPUTER_TOOL_NAME, process.cwd());
		expect(allToolNames.has(COMPUTER_TOOL_NAME)).toBe(true);
		expect(definition.description).toContain("Never issue read_public_value and store_secret concurrently");
		expect(Check(definition.parameters, { action: "open", url: "https://example.com/setup" })).toBe(true);
		expect(Check(definition.parameters, { action: "click", ref: "q12" })).toBe(true);
		expect(Check(definition.parameters, { action: "fill", ref: "q1", text: "Public company name" })).toBe(true);
		expect(Check(definition.parameters, { action: "read_public_value", ref: "q10" })).toBe(true);
		expect(
			Check(definition.parameters, {
				action: "store_secret",
				ref: "q11",
				secretName: "google_sheets_client_secret",
			}),
		).toBe(true);
		expect(Check(definition.parameters, { action: "handoff" })).toBe(true);
		expect(Check(definition.parameters, { action: "fill", ref: "q1" })).toBe(true);
	});

	it("round-trips a generated public client ID through the kernel broker", async () => {
		setComputerBrokerWriter((request) => {
			const frame = request as { requestId: string };
			handleComputerBrokerFrame({
				type: "qorpera_computer_response",
				requestId: frame.requestId,
				url: "https://console.example.com/oauth/client",
				title: "OAuth client created",
				snapshot: '[q10] button "Read generated public client ID"',
				handoffReady: false,
				publicValue: "public-client-id.apps.provider.example",
			});
		});

		const result = await createComputerTool().execute("computer-call", {
			action: "read_public_value",
			ref: "q10",
		});
		const text = result.content.find((item) => item.type === "text")?.text;
		expect(text).toContain("Public value: public-client-id.apps.provider.example");
	});

	it("round-trips snapshots and screenshots through the kernel broker", async () => {
		setComputerBrokerWriter((request) => {
			const frame = request as { requestId: string };
			handleComputerBrokerFrame({
				type: "qorpera_computer_response",
				requestId: frame.requestId,
				url: "https://example.com/login",
				title: "Sign in",
				snapshot: '[q1] input:email "Email"\n[q2] input:password "Password"',
				handoffReady: true,
				screenshotBase64: "iVBORw0KGgo=",
			});
		});
		const result = await createComputerTool().execute("computer-call", { action: "screenshot" });
		expect(result.details).toEqual({
			url: "https://example.com/login",
			title: "Sign in",
			handoffReady: true,
		});
		expect(result.content).toEqual([
			expect.objectContaining({ type: "text", text: expect.stringContaining("Handoff ready: yes") }),
			{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
		]);
	});

	it("marks the managed profile as private until the founder finishes handoff", async () => {
		setComputerBrokerWriter((request) => {
			const frame = request as { requestId: string };
			handleComputerBrokerFrame({
				type: "qorpera_computer_response",
				requestId: frame.requestId,
				url: "https://accounts.example.com/login",
				title: "Sign in",
				snapshot: '[q1] input:email "Email"',
				handoffReady: true,
			});
		});

		const result = await createComputerTool().execute("computer-call", { action: "handoff" });
		const text = result.content.find((item) => item.type === "text")?.text;
		expect(text).toContain("Private handoff is active in the visible Qorpera-managed Chrome profile");
		expect(text).toContain("call snapshot on the same profile");
		expect(text).toContain("Do not claim authentication completed before then");
	});

	it("rejects action parameters that do not belong to the selected operation", async () => {
		setComputerBrokerWriter(() => {});
		await expect(createComputerTool().execute("computer-call", { action: "fill", ref: "q1" })).rejects.toThrow(
			"fill requires ref and text",
		);
		await expect(
			createComputerTool().execute("computer-call", { action: "handoff", url: "https://example.com" }),
		).rejects.toThrow("url is only valid for open");
		await expect(
			createComputerTool().execute("computer-call", { action: "store_secret", ref: "q11" }),
		).rejects.toThrow("store_secret requires ref and secretName");
		await expect(createComputerTool().execute("computer-call", { action: "read_public_value" })).rejects.toThrow(
			"read_public_value requires ref",
		);
	});
});
