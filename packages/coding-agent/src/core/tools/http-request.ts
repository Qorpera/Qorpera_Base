/**
 * Outbound HTTP through the kernel (Build 3 — generic connectivity).
 *
 * The child has no network; this tool submits the request over the kernel
 * pipe. Secrets are used by reference: put `secret://<name>` in the URL,
 * a header value, or the body, and the kernel substitutes the raw value
 * at the trusted boundary — the value never enters this process, the
 * model's context, or the trail. Destinations must be founder-bound
 * network capabilities; everything else is denied kernel-side.
 */

import type { AgentTool } from "@qorpera/pi-agent-core";
import { Text } from "@qorpera/pi-tui";
import { type Static, Type } from "typebox";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import { HTTP_TOOL_NAME } from "../authority.ts";
import type { ToolDefinition, ToolRenderResultOptions } from "../extensions/types.ts";
import { brokeredHttpRequest, isHttpBrokerAvailable } from "../http-broker-client.ts";
import { getTextOutput, str } from "./render-utils.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";
import { DEFAULT_MAX_BYTES, truncateHead } from "./truncate.ts";

const httpRequestSchema = Type.Object({
	method: Type.String({ description: "HTTP method: GET, POST, PUT, PATCH, DELETE, or HEAD" }),
	url: Type.String({
		description:
			"HTTPS URL. The destination host must be a founder-bound network capability. secret://<name> references are substituted by the kernel and never appear in your context.",
	}),
	headers: Type.Optional(
		Type.Record(Type.String(), Type.String(), {
			description: "Request headers; values may carry secret://<name> references",
		}),
	),
	body: Type.Optional(Type.String({ description: "Request body; may carry secret://<name> references" })),
	timeoutSeconds: Type.Optional(Type.Number({ description: "Seconds before the request is aborted (default 30)" })),
});

export type HttpRequestToolInput = Static<typeof httpRequestSchema>;

export interface HttpRequestToolDetails {
	status: number;
	bodyBytes: number;
	bodyTruncated?: boolean;
}

export function createHttpRequestToolDefinition(): ToolDefinition<
	typeof httpRequestSchema,
	HttpRequestToolDetails | undefined
> {
	return {
		name: HTTP_TOOL_NAME,
		label: "http request",
		description:
			"Make an outbound HTTPS request through the kernel. Destinations must be founder-bound network capabilities (the founder binds them with 'qorpera company destination add <host>'); use secret://<name> references for credentials — the kernel substitutes raw values at the trusted boundary, so they never enter your context or the trail. Responses come back inline (bounded); how you store provider data is yours to decide.",
		promptSnippet: "Outbound HTTPS via the kernel with secret:// references",
		parameters: httpRequestSchema,
		async execute(_toolCallId, { method, url, headers, body, timeoutSeconds }: HttpRequestToolInput, signal) {
			if (!isHttpBrokerAvailable()) {
				throw new Error("http_request requires the kernel broker (company sessions under the desktop kernel)");
			}
			const response = await brokeredHttpRequest(
				{
					method: method.toUpperCase(),
					url,
					...(headers ? { headers } : {}),
					...(body !== undefined ? { body } : {}),
					...(timeoutSeconds !== undefined ? { timeoutMs: Math.round(timeoutSeconds * 1000) } : {}),
				},
				signal,
			);
			const shown = truncateHead(response.body, { maxBytes: DEFAULT_MAX_BYTES });
			const header = `HTTP ${response.status} ${method.toUpperCase()} ${url} (${response.bodyBytes} bytes${response.bodyTruncated ? ", body truncated by kernel at 8MB" : ""})`;
			const details: HttpRequestToolDetails = {
				status: response.status,
				bodyBytes: response.bodyBytes,
				...(response.bodyTruncated ? { bodyTruncated: true } : {}),
			};
			return {
				content: [
					{
						type: "text",
						text: `${header}${shown.content ? `\n${shown.content}` : ""}${shown.truncated ? "\n[display truncated]" : ""}`,
					},
				],
				details,
			};
		},
		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(
				`${theme.fg("toolTitle", theme.bold("http"))} ${theme.fg("toolOutput", `${str(args?.method) ?? "?"} ${str(args?.url) ?? "?"}`)}`,
			);
			return text;
		},
		renderResult(result, options: ToolRenderResultOptions, theme: Theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			const output = getTextOutput(result as never, context.showImages).trim();
			const lines = output.split("\n");
			const maxLines = options.expanded ? lines.length : 15;
			const shown = lines.slice(0, maxLines).map((line) => theme.fg("toolOutput", line));
			const remaining = lines.length - maxLines;
			text.setText(
				`\n${shown.join("\n")}${remaining > 0 ? theme.fg("muted", `\n... (${remaining} more lines)`) : ""}`,
			);
			return text;
		},
	};
}

export function createHttpRequestTool(): AgentTool<typeof httpRequestSchema> {
	return wrapToolDefinition(createHttpRequestToolDefinition());
}
