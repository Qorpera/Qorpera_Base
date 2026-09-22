import {
	cloudInteractionEventId,
	parseCloudAskMemberInput,
	parseCloudInteractionRequestData,
} from "@qorpera/runtime/cloud-thread-interactions";
import { describe, expect, it } from "vitest";

const RUN = "33333333-3333-4333-8333-333333333333";

describe("thread interaction requests", () => {
	it("accepts a secret card that names its connector and refuses names outside the custody pattern", () => {
		const secret = {
			schema: "qorpera.interaction/v1",
			surface: "secret",
			title: "Connect Linear",
			payload: { name: "api-key", label: "Linear API key", purpose: "Filing issues.", connectorId: "linear" },
		};
		expect(parseCloudInteractionRequestData(secret).payload).toEqual(secret.payload);
		expect(() =>
			parseCloudInteractionRequestData({ ...secret, payload: { ...secret.payload, name: "1bad" } }),
		).toThrow(/Invalid interaction request/);
		expect(() =>
			parseCloudInteractionRequestData({ ...secret, payload: { ...secret.payload, connectorId: "Slack!" } }),
		).toThrow(/Invalid interaction request/);
		expect(() =>
			parseCloudInteractionRequestData({ ...secret, payload: { ...secret.payload, value: "xoxb-secret" } }),
		).toThrow(/Invalid interaction request/);
	});

	it("keeps the same card id for a retried ask", () => {
		const input = parseCloudAskMemberInput({
			idempotencyKey: "slack",
			text: "I need a token.",
			surface: "secret",
			title: "Connect Slack",
			payload: { name: "bot-token", label: "Slack bot token", purpose: "Posting.", connectorId: "slack" },
		});
		expect(input.data.surface).toBe("secret");
		expect(cloudInteractionEventId(RUN, "slack")).toBe(cloudInteractionEventId(RUN, "slack"));
		expect(cloudInteractionEventId(RUN, "slack")).not.toBe(cloudInteractionEventId(RUN, "slack-2"));
		expect(cloudInteractionEventId(RUN, "slack")).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/,
		);
	});
});
