/** A Playwright-style control surface for the agent's Qorpera computer. */

import type { AgentTool } from "@qorpera/pi-agent-core";
import { type Static, Type } from "typebox";
import { brokeredComputerAction, type ComputerAction, isComputerBrokerAvailable } from "../computer-broker-client.ts";
import type { ToolDefinition } from "../extensions/types.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

export const COMPUTER_TOOL_NAME = "use_computer";

const computerSchema = Type.Object(
	{
		action: Type.Union(
			[
				Type.Literal("open"),
				Type.Literal("snapshot"),
				Type.Literal("click"),
				Type.Literal("fill"),
				Type.Literal("press"),
				Type.Literal("screenshot"),
				Type.Literal("read_public_value"),
				Type.Literal("store_secret"),
				Type.Literal("handoff"),
			],
			{
				description:
					"Open a connector setup URL in Chrome, inspect the current page, click an element ref, fill a non-sensitive public field, press a navigation key, capture the viewport, read a generated public client identifier, store a provider-generated secret directly in the company vault, or hand Chrome to the founder at a verified sign-in boundary",
			},
		),
		url: Type.Optional(
			Type.String({
				description: "For open only: an HTTPS URL under an owned connector's registration origin",
			}),
		),
		ref: Type.Optional(
			Type.String({
				description:
					"For click, fill, read_public_value, or store_secret: a q<N> element ref from the latest snapshot",
			}),
		),
		text: Type.Optional(
			Type.String({
				maxLength: 16_384,
				description: "For fill only: non-sensitive public setup text; never private or authentication data",
			}),
		),
		key: Type.Optional(
			Type.String({
				description: "For press only: Tab, Enter, Escape, ArrowUp, ArrowDown, ArrowLeft, or ArrowRight",
			}),
		),
		secretName: Type.Optional(
			Type.String({
				pattern: "^[a-z0-9][a-z0-9_-]{0,63}$",
				description:
					"For store_secret only: the exact opaque clientSecretName declared by the active connector manifest",
			}),
		),
	},
	{ additionalProperties: false },
);

export type ComputerToolInput = Static<typeof computerSchema>;

export interface ComputerToolDetails {
	url: string;
	title: string;
	handoffReady: boolean;
}

function assertActionInput(input: ComputerToolInput): void {
	const action = input.action as ComputerAction;
	if (action === "open" && !input.url) throw new Error("use_computer open requires url");
	if (action === "click" && !input.ref) throw new Error("use_computer click requires ref");
	if (action === "fill" && (!input.ref || input.text === undefined))
		throw new Error("use_computer fill requires ref and text");
	if (action === "read_public_value" && !input.ref) throw new Error("use_computer read_public_value requires ref");
	if (action === "store_secret" && (!input.ref || !input.secretName))
		throw new Error("use_computer store_secret requires ref and secretName");
	if (action === "press" && !input.key) throw new Error("use_computer press requires key");
	if (action !== "open" && input.url !== undefined) throw new Error("use_computer url is only valid for open");
	if (
		action !== "click" &&
		action !== "fill" &&
		action !== "read_public_value" &&
		action !== "store_secret" &&
		input.ref !== undefined
	)
		throw new Error("use_computer ref is only valid for click, fill, read_public_value, or store_secret");
	if (action !== "fill" && input.text !== undefined) throw new Error("use_computer text is only valid for fill");
	if (action !== "press" && input.key !== undefined) throw new Error("use_computer key is only valid for press");
	if (action !== "store_secret" && input.secretName !== undefined)
		throw new Error("use_computer secretName is only valid for store_secret");
}

export function createComputerToolDefinition(): ToolDefinition<typeof computerSchema, ComputerToolDetails> {
	return {
		name: COMPUTER_TOOL_NAME,
		label: "computer",
		description:
			"Control the agent's visible Qorpera-managed Google Chrome profile through Playwright controls. Use it for connector setup only after the selected connection request has been durably attached to the installed manifest: create the company connector, then call request_connection with recipeId company:<connector-id> and its exact destinations and secret names before calling open. Never open provider registration while the selected request is still recipe-less or preparing. Open the manifest registrationUrl, inspect after every navigation, handle all public navigation and non-sensitive public forms yourself, and dismiss cookie/privacy prompts without accepting optional tracking when possible. Never enter credentials, passwords, passkeys, recovery codes, MFA/OTP values, financial identifiers, or other private data. Call handoff only when an unobstructed sign-in, identity-verification, MFA, consent, or equivalent user-only boundary is ready; handoff is rejected on landing pages, marketing pages, and forms still covered by public setup dialogs. Handoff keeps the managed profile open for the founder. After the founder completes that protected step, its completion authorizes the remaining setup within the exact selected connector scope: snapshot the same profile and continue without requesting another approval. Create a dedicated OAuth client for the selected connector; never add a secret to an unrelated existing provider client. If the provider generates a public client ID, call read_public_value first and wait for its result, then update the connector manifest's clientId. Only after that manifest update succeeds may you call store_secret in a later tool step with the hidden field ref and the manifest's exact clientSecretName. Never issue read_public_value and store_secret concurrently. The desktop host stores the secret without exposing the value to you, chat, company files, or the trail. Never ask the founder to copy or store a generated secret.",
		promptSnippet: "Visible Qorpera-managed Google Chrome with Playwright controls",
		parameters: computerSchema,
		async execute(_toolCallId, input: ComputerToolInput, signal) {
			if (!isComputerBrokerAvailable()) throw new Error("use_computer requires the Qorpera desktop host");
			assertActionInput(input);
			const response = await brokeredComputerAction(input, signal);
			const publicValueNotice = response.publicValue ? `\nPublic value: ${response.publicValue}` : "";
			const handoffNotice =
				input.action === "handoff"
					? "\n\nPrivate handoff is active in the visible Qorpera-managed Chrome profile. Do not inspect or act on the protected page. Tell the founder to finish there. After they say it is complete, call snapshot on the same profile and continue only if the protected boundary has cleared. Do not claim authentication completed before then."
					: "";
			const content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: "image/png" }> =
				[
					{
						type: "text",
						text: `${response.title}\n${response.url}\nHandoff ready: ${response.handoffReady ? "yes" : "no"}${publicValueNotice}${handoffNotice}\n\n${response.snapshot}`,
					},
				];
			if (response.screenshotBase64) {
				content.push({ type: "image", data: response.screenshotBase64, mimeType: "image/png" });
			}
			return {
				content,
				details: { url: response.url, title: response.title, handoffReady: response.handoffReady },
			};
		},
	};
}

export function createComputerTool(): AgentTool<typeof computerSchema> {
	return wrapToolDefinition(createComputerToolDefinition());
}
