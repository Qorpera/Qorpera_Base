import { createHash } from "node:crypto";
import { isInterfaceName } from "@qorpera/cloud-client/interfaces";
import type { JsonValue } from "@qorpera/contracts";
import { CODING_VALUE_REPOSITORY, codingValueNameAllowed } from "./cloud-coding-value-names.ts";
import { CloudToolArgumentRefusal } from "./cloud-native-tool-boundary.ts";

/* Thread interactions (design: THREAD-WIDGETS-DESIGN-20260922.md): an agent asks
 * its member for something through a typed card in the thread. The card is an
 * `interaction_request` transcript event whose data is a closed
 * `qorpera.interaction/v1` object; the kernel validates the same shapes
 * (`qorpera_interaction_request_valid`), so what is refused here is refused
 * there too. The member's answer comes back as an ordinary input in the next
 * wake, as `qorpera.interaction-answer/v1`. Secrets never travel either way:
 * a secret card returns an outcome only, a form answer carries values for
 * non-secret fields only. Agents never author HTML or free forms. */

export const CLOUD_INTERACTION_SCHEMA = "qorpera.interaction/v1";
export const CLOUD_INTERACTION_ANSWER_SCHEMA = "qorpera.interaction-answer/v1";

export const CLOUD_INTERACTION_SURFACES = ["question", "secret", "form", "takeover", "draft", "credential"] as const;
export type CloudInteractionSurface = (typeof CLOUD_INTERACTION_SURFACES)[number];

/** Surfaces with an implemented member workflow. Stored events retain the full protocol. */
export const CLOUD_ASK_MEMBER_SURFACES = ["question", "secret", "takeover", "draft"] as const;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
/** Names in the cloud secret custody start with a letter. */
const VAULT_NAME_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;
const FIELD_ID_PATTERN = /^[a-z][a-z0-9_]{0,31}$/;
const HOST_PATTERN = /^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?)+$/;
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/;
// NUL too: PostgreSQL text cannot hold it, and the final send of a card's sentence refuses it.
const CONTROL_PATTERN = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;

type Schema = { [key: string]: JsonValue };
const chars = (minLength: number, maxLength: number, description?: string): Schema => ({
	type: "string",
	minLength,
	maxLength,
	...(description ? { description } : {}),
});
const matching = (pattern: RegExp, description?: string): Schema => ({
	type: "string",
	pattern: pattern.source,
	...(description ? { description } : {}),
});
const closedObject = (required: string[], properties: Schema, description?: string): Schema => ({
	type: "object",
	additionalProperties: false,
	required,
	properties,
	...(description ? { description } : {}),
});

/* The payload of each surface as the model is told it (ask_member's inputSchema).
 * payloadValid below stays the authority (it mirrors the kernel's validator); the
 * card-shape tests hold the two together: every key offered here is accepted
 * there, and each schema's minimal and maximal examples parse. */
const PAYLOAD_SCHEMAS: Record<CloudInteractionSurface, Schema> = {
	question: closedObject(
		["options"],
		{
			options: {
				type: "array",
				minItems: 1,
				maxItems: 6,
				description:
					"The likely answers to what your work cannot go on without, each a specific one, never generic ones like Get started.",
				items: closedObject(["label"], {
					label: chars(1, 80, "A specific answer that resolves the pending decision."),
					value: chars(1, 200, "Returned as the answer; defaults to the label."),
					description: chars(0, 200),
					style: { type: "string", enum: ["default", "primary", "danger"] },
					preview: chars(
						1,
						512,
						"A picture of this option for a visual choice: the company file path of an image you made for it (an SVG sketch, a PNG), or app:<name> for an interface app that shows it. Options with pictures show as big boxes the member picks from.",
					),
				}),
			},
			multiSelect: { type: "boolean" },
			allowCustom: {
				type: "boolean",
				description: "A field for the member's own answer beside the options; set it for an open question.",
			},
			dismissOnMoveOn: { type: "boolean" },
		},
		"surface question: 1 to 6 likely answers; allowCustom adds a field for the member's own.",
	),
	secret: closedObject(
		["name", "label", "purpose"],
		{
			name: matching(VAULT_NAME_PATTERN, "The vault name the secret is saved under."),
			label: chars(1, 80),
			purpose: chars(1, 300),
			kind: { type: "string", enum: ["token", "password", "text"] },
			connectorId: matching(
				VAULT_NAME_PATTERN,
				"Default vault. environment for a coding value: an environment variable your coding sessions get.",
			),
			repository: matching(
				CODING_VALUE_REPOSITORY,
				"With connectorId environment only: the repository (owner/name, lower case) whose coding sessions get it.",
			),
		},
		"surface secret: the member saves a value into the company vault; you never see it. " +
			"A coding value is an environment variable only a person can give a coding session (a token for private packages, a build's API key): connectorId environment, the variable's name in lower case (npm_token for NPM_TOKEN) labelled with that name, what it is for in plain words as purpose, and repository; the member pastes it in the card and your next coding session in that repository gets it. Ask once, before you need it. A key you can make on npm, GitHub, Stripe or Resend needs no card: make it in your machine's browser and save it with save_coding_value.",
	),
	form: closedObject(
		["domain", "fields"],
		{
			domain: matching(HOST_PATTERN, "The site the form is for, e.g. app.example.com."),
			reason: { type: "string", enum: ["sign_in", "checkout", "profile", "other"] },
			submitAfterFill: { type: "boolean", description: "Only with exactly one field, and that field has a target." },
			fields: {
				type: "array",
				minItems: 1,
				maxItems: 8,
				items: closedObject(["id", "label", "type"], {
					id: matching(FIELD_ID_PATTERN),
					label: chars(1, 80),
					type: {
						type: "string",
						enum: ["text", "email", "tel", "password", "otp", "number", "date", "select", "textarea", "checkbox"],
					},
					required: { type: "boolean" },
					placeholder: chars(0, 80),
					options: {
						type: "array",
						minItems: 1,
						maxItems: 32,
						description: "Only, and always, for type select.",
						items: closedObject(["label", "value"], { label: chars(1, 80), value: chars(1, 200) }),
					},
					secret: { type: "boolean" },
					target: closedObject(
						["kind", "value"],
						{ kind: { type: "string", enum: ["ref", "selector", "label"] }, value: chars(1, 512) },
						"Required for a secret field (secret: true, password or otp), from your latest page snapshot.",
					),
					vaultName: matching(NAME_PATTERN, "Secret fields only."),
				}),
			},
		},
		"surface form: reserved for protected entry into observed fields on a real web page. Not supported by the current web client; use an available computer takeover instead.",
	),
	takeover: closedObject(
		["instruction"],
		{
			instruction: chars(1, 300),
			reason: { type: "string", enum: ["sign_in", "captcha", "payment", "other"] },
			domain: matching(HOST_PATTERN),
			idpDomain: matching(HOST_PATTERN),
		},
		"surface takeover: the member signs in or enters a code on your computer's screen, then presses I'm done.",
	),
	draft: closedObject(
		["platform", "connectorId", "from", "to", "body"],
		{
			platform: { type: "string", enum: ["email", "slack", "message"] },
			connectorId: chars(1, 128),
			from: chars(1, 320, "For Gmail, use email_address from gmail_get_profile; never guess the connected sender."),
			to: { type: "array", minItems: 1, maxItems: 32, items: chars(1, 320) },
			cc: { type: "array", maxItems: 32, items: chars(1, 320) },
			subject: chars(0, 500),
			body: chars(1, 65536, "The whole ask_member call must stay under 64 KiB."),
			replyTo: chars(1, 256, "For Gmail, the provider message id to reply to, not an address or draft id."),
			threadRef: chars(1, 256),
		},
		"surface draft: an editable message the member reviews, saves to Gmail, sends or discards. A card alone is not a saved Gmail draft.",
	),
	credential: closedObject(
		["name", "domain"],
		{ name: matching(NAME_PATTERN), domain: matching(HOST_PATTERN), purpose: chars(0, 300) },
		"surface credential: reserved for host-mediated sign-in from the vault. The current web client does not execute it; do not claim that raising this card signs in.",
	),
};

/** The payload for the surface named beside it, one closed object per surface. */
const ASK_QUESTION_SCHEMA: Schema = (() => {
	const question = structuredClone(PAYLOAD_SCHEMAS.question) as Schema;
	const option = ((question.properties as Schema).options as Schema).items as Schema;
	(option.properties as Schema).label = chars(
		1,
		40,
		"A button of 1 to 3 words (at most 40 bytes), such as Approve or Change it.",
	);
	return question;
})();

export const CLOUD_INTERACTION_PAYLOAD_SCHEMA: Schema = {
	oneOf: CLOUD_INTERACTION_SURFACES.map((surface) => PAYLOAD_SCHEMAS[surface]),
};

/** Only advertise workflows the member can actually complete. A new question's buttons are offered at the length a
 * card takes (CLOUD_ASK_MEMBER_LABEL_MAX_BYTES, below): the kernel's own bound stays for stored cards. */
export const CLOUD_ASK_MEMBER_PAYLOAD_SCHEMA: Schema = {
	oneOf: CLOUD_ASK_MEMBER_SURFACES.map((surface) =>
		surface === "question" ? ASK_QUESTION_SCHEMA : PAYLOAD_SCHEMAS[surface],
	),
};

/** A schema as a short type sketch for a refusal: {options: [{label, value?}], multiSelect?}. */
function sketch(schema: Schema): string {
	if (Array.isArray(schema.enum)) return schema.enum.join("|");
	if (schema.type === "array") return `[${sketch(schema.items as Schema)}]`;
	if (schema.type !== "object") return "";
	const required = schema.required as string[];
	const fields = Object.entries(schema.properties as Schema).map(([key, child]) => {
		const inner = sketch(child as Schema);
		return `${key}${required.includes(key) ? "" : "?"}${inner ? `: ${inner}` : ""}`;
	});
	return `{${fields.join(", ")}}`;
}

/** Why a card was refused, in words a model can act on: never an argument value. */
function payloadRefusal(surface: CloudInteractionSurface): string {
	const extra =
		surface === "question"
			? " Each option is an object with a label, never a plain string."
			: surface === "form"
				? " Field ids are unique; a secret field (secret: true, type password or otp) needs a target; options only and always for type select; submitAfterFill only with exactly one field, which has a target."
				: "";
	return `the ${surface} payload must be ${sketch(PAYLOAD_SCHEMAS[surface])}.${extra} Text limits count UTF-8 bytes (æ, ø and å take 2, an emoji 4), control characters are refused, and ids, names and hosts must match their schema patterns.`;
}

const ASK_MEMBER_WORDS = [
	"Raise one card for a member: question, secret, takeover or draft. The card is your final send, and text only introduces it: finish independent work first and nothing that depends on the answer, and in text do not answer the card's question, guess the choice or start on one.",
	"- question: an answer your work cannot go on without, never only in chat: the card shows members that work is stopped at them. Not for facts you can find or permission you have; ideas, offers and news stay in chat. Ask once, act on the chosen or custom answer, and follow up only for what is missing.",
	"- secret: the member saves a value into the company vault; you never see it. It fills no page and signs in nowhere.",
	"- takeover: for a sign-in or page entry on your desktop computer the member does it on the screen you both use, so never promise it is private; end your turn: their I'm done wakes you. Then look, since I'm done is not proof of a sign-in. With no desktop computer, say so.",
	"- draft: an email or message the member edits, then saves, sends or discards. Raise it directly, with no question before it. A card neither sends nor saves anything and asking for a draft never allows sending: report saved or sent only from a tool result or the card's outcome; a sent outcome is already sent.",
	"Form and credential cards are refused. Passwords, tokens and one-time codes never go in chat or in a question's answer, and a question's answer never bypasses an approval the platform requires.",
	"Say each thing once across title, body, text and chat. When the choice is visual (a look, a product, a layout), make a picture of each option first, an SVG sketch or an interface app, and set its preview: the card shows big pictures to pick from.",
	"The answer wakes you as qorpera.interaction-answer/v1, as the next input or as the request with the card it answers: an outcome, and a question's chosen values. A secret's answer holds only the vault secret's id, version and connectorId (default vault), never the value. A declined, dismissed or expired card is an answer: do not raise it again at once. In your own shared thread only the member you answer can answer the card.",
	"payload follows the closed schema of its surface; text limits count UTF-8 bytes.",
];
const ASK_MEMBER_GMAIL =
	"Gmail: for an email draft, call gmail_get_profile for the real sender, then raise draft with title New email and payload {platform: email, connectorId: gmail, from: email_address, to, subject, body, cc?}, the whole email in the card. A reply's replyTo is the original Gmail message id; threadRef alone is not enough. Asked to save in Gmail at once, use gmail_create_draft and report its draft_id instead of a card. Never invent the sender or infer a connection from the conversation.";

/** ask_member's description for a run with or without Gmail's tools (its connections, if any). */
export function cloudAskMemberInstructions(gmail: boolean): string {
	return [...ASK_MEMBER_WORDS, ...(gmail ? [ASK_MEMBER_GMAIL] : [])].join("\n");
}

/** Every part: the description of a run with Gmail's tools. */
export const CLOUD_ASK_MEMBER_INSTRUCTIONS = cloudAskMemberInstructions(true);

export interface CloudInteractionRequestData {
	schema: typeof CLOUD_INTERACTION_SCHEMA;
	surface: CloudInteractionSurface;
	title: string;
	body?: string;
	expiresAt?: string;
	payload: Record<string, unknown>;
}

export interface CloudAskMemberInput {
	idempotencyKey: string;
	text: string;
	data: CloudInteractionRequestData;
}

export interface CloudInteractionRequestInput {
	eventId: string;
	data: CloudInteractionRequestData;
}

export interface CloudInteractionRequestReceipt {
	sessionId: string;
	interactionId: string;
	sequence: number;
}

function record(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function text(value: unknown, min: number, max: number): value is string {
	return (
		typeof value === "string" &&
		Buffer.byteLength(value) >= min &&
		Buffer.byteLength(value) <= max &&
		!CONTROL_PATTERN.test(value)
	);
}

function optionalText(container: Record<string, unknown>, key: string, min: number, max: number): boolean {
	return !(key in container) || text(container[key], min, max);
}

function optionalBoolean(container: Record<string, unknown>, key: string): boolean {
	return !(key in container) || typeof container[key] === "boolean";
}

function optionalEnum(container: Record<string, unknown>, key: string, values: readonly string[]): boolean {
	return !(key in container) || (typeof container[key] === "string" && values.includes(container[key] as string));
}

function optionalHost(container: Record<string, unknown>, key: string): boolean {
	return !(key in container) || (typeof container[key] === "string" && HOST_PATTERN.test(container[key] as string));
}

function closedKeys(container: Record<string, unknown>, keys: readonly string[]): boolean {
	return Object.keys(container).every((key) => keys.includes(key));
}

function payloadValid(surface: CloudInteractionSurface, payload: Record<string, unknown>): boolean {
	switch (surface) {
		case "question": {
			if (
				!closedKeys(payload, ["options", "multiSelect", "allowCustom", "dismissOnMoveOn"]) ||
				!Array.isArray(payload.options) ||
				payload.options.length < 1 ||
				payload.options.length > 6 ||
				!optionalBoolean(payload, "multiSelect") ||
				!optionalBoolean(payload, "allowCustom") ||
				!optionalBoolean(payload, "dismissOnMoveOn")
			)
				return false;
			return payload.options.every((candidate) => {
				const option = record(candidate);
				return (
					option !== undefined &&
					closedKeys(option, ["label", "value", "description", "style", "preview"]) &&
					text(option.label, 1, 80) &&
					optionalText(option, "value", 1, 200) &&
					optionalText(option, "description", 0, 200) &&
					optionalEnum(option, "style", ["default", "primary", "danger"]) &&
					optionalText(option, "preview", 1, 512)
				);
			});
		}
		case "secret": {
			const coding = payload.connectorId === "environment";
			return (
				closedKeys(payload, ["name", "label", "purpose", "kind", "connectorId", "repository"]) &&
				typeof payload.name === "string" &&
				VAULT_NAME_PATTERN.test(payload.name) &&
				(!("connectorId" in payload) ||
					(typeof payload.connectorId === "string" && VAULT_NAME_PATTERN.test(payload.connectorId))) &&
				// A coding value (20260930693000): a name the capture takes, and the repository only beside it.
				(!coding || codingValueNameAllowed(payload.name)) &&
				(!("repository" in payload) ||
					(coding &&
						typeof payload.repository === "string" &&
						CODING_VALUE_REPOSITORY.test(payload.repository))) &&
				text(payload.label, 1, 80) &&
				text(payload.purpose, 1, 300) &&
				optionalEnum(payload, "kind", ["token", "password", "text"])
			);
		}
		case "form": {
			if (
				!closedKeys(payload, ["domain", "reason", "submitAfterFill", "fields"]) ||
				typeof payload.domain !== "string" ||
				!HOST_PATTERN.test(payload.domain) ||
				!optionalEnum(payload, "reason", ["sign_in", "checkout", "profile", "other"]) ||
				!optionalBoolean(payload, "submitAfterFill") ||
				!Array.isArray(payload.fields) ||
				payload.fields.length < 1 ||
				payload.fields.length > 8
			)
				return false;
			const ids = new Set<string>();
			let targets = 0;
			for (const candidate of payload.fields) {
				const field = record(candidate);
				if (!field) return false;
				const secret =
					field.secret === true || (typeof field.type === "string" && ["password", "otp"].includes(field.type));
				const target = record(field.target);
				if (
					!closedKeys(field, [
						"id",
						"label",
						"type",
						"required",
						"placeholder",
						"options",
						"secret",
						"target",
						"vaultName",
					]) ||
					typeof field.id !== "string" ||
					!FIELD_ID_PATTERN.test(field.id) ||
					ids.has(field.id) ||
					!text(field.label, 1, 80) ||
					typeof field.type !== "string" ||
					![
						"text",
						"email",
						"tel",
						"password",
						"otp",
						"number",
						"date",
						"select",
						"textarea",
						"checkbox",
					].includes(field.type) ||
					!optionalBoolean(field, "required") ||
					!optionalBoolean(field, "secret") ||
					!optionalText(field, "placeholder", 0, 80) ||
					"options" in field !== (field.type === "select") ||
					("options" in field &&
						(!Array.isArray(field.options) ||
							field.options.length < 1 ||
							field.options.length > 32 ||
							!field.options.every((choice) => {
								const option = record(choice);
								return (
									option !== undefined &&
									closedKeys(option, ["label", "value"]) &&
									text(option.label, 1, 80) &&
									text(option.value, 1, 200)
								);
							}))) ||
					("target" in field &&
						(!target ||
							!closedKeys(target, ["kind", "value"]) ||
							typeof target.kind !== "string" ||
							!["ref", "selector", "label"].includes(target.kind) ||
							!text(target.value, 1, 512))) ||
					(secret && !("target" in field)) ||
					("vaultName" in field &&
						(!secret || typeof field.vaultName !== "string" || !NAME_PATTERN.test(field.vaultName)))
				)
					return false;
				ids.add(field.id);
				if ("target" in field) targets += 1;
			}
			return !(payload.submitAfterFill === true && (payload.fields.length !== 1 || targets !== 1));
		}
		case "takeover":
			return (
				closedKeys(payload, ["instruction", "reason", "domain", "idpDomain"]) &&
				text(payload.instruction, 1, 300) &&
				optionalEnum(payload, "reason", ["sign_in", "captcha", "payment", "other"]) &&
				optionalHost(payload, "domain") &&
				optionalHost(payload, "idpDomain")
			);
		case "draft": {
			const recipients = (value: unknown, min: number): boolean =>
				Array.isArray(value) &&
				value.length >= min &&
				value.length <= 32 &&
				value.every((recipient) => text(recipient, 1, 320));
			return (
				closedKeys(payload, [
					"platform",
					"connectorId",
					"from",
					"to",
					"cc",
					"subject",
					"body",
					"replyTo",
					"threadRef",
				]) &&
				typeof payload.platform === "string" &&
				["email", "slack", "message"].includes(payload.platform) &&
				text(payload.connectorId, 1, 128) &&
				text(payload.from, 1, 320) &&
				recipients(payload.to, 1) &&
				(!("cc" in payload) || recipients(payload.cc, 0)) &&
				optionalText(payload, "subject", 0, 500) &&
				text(payload.body, 1, 65536) &&
				optionalText(payload, "replyTo", 1, 256) &&
				optionalText(payload, "threadRef", 1, 256)
			);
		}
		case "credential":
			return (
				closedKeys(payload, ["name", "domain", "purpose"]) &&
				typeof payload.name === "string" &&
				NAME_PATTERN.test(payload.name) &&
				typeof payload.domain === "string" &&
				HOST_PATTERN.test(payload.domain) &&
				optionalText(payload, "purpose", 0, 300)
			);
	}
}

/** The first thing wrong with a card, or undefined when the kernel will take it. */
function interactionRequestIssue(data: Record<string, unknown>): string | undefined {
	const unknown = Object.keys(data).find(
		(key) => !["schema", "surface", "title", "body", "expiresAt", "payload"].includes(key),
	);
	if (unknown !== undefined)
		return "unknown argument; a card has only surface, title, body, expiresAt and payload besides idempotencyKey and text";
	if (data.schema !== CLOUD_INTERACTION_SCHEMA) return `schema must be ${CLOUD_INTERACTION_SCHEMA}`;
	if (typeof data.surface !== "string" || !(CLOUD_INTERACTION_SURFACES as readonly string[]).includes(data.surface))
		return `surface must be one of ${CLOUD_INTERACTION_SURFACES.join(", ")}`;
	if (!text(data.title, 1, 200)) return "title must be 1 to 200 UTF-8 bytes";
	if (!optionalText(data, "body", 0, 2000)) return "body must be at most 2000 UTF-8 bytes";
	if (
		"expiresAt" in data &&
		(typeof data.expiresAt !== "string" ||
			!TIMESTAMP_PATTERN.test(data.expiresAt) ||
			!Number.isFinite(Date.parse(data.expiresAt)))
	)
		return "expiresAt must be a UTC time such as 2026-09-25T12:00:00Z";
	const surface = data.surface as CloudInteractionSurface;
	const payload = record(data.payload);
	return payload && payloadValid(surface, payload) ? undefined : payloadRefusal(surface);
}

/** A new card's body and buttons as a member reads them in a few seconds (Jonas, 5 November 2026: "approval cards are
 * completely unreadable"): the kernel's limits stay those above, so cards already in a thread still read. */
export const CLOUD_ASK_MEMBER_BODY_MAX_BYTES = 600;
export const CLOUD_ASK_MEMBER_BODY_MAX_LINES = 5;
export const CLOUD_ASK_MEMBER_LABEL_MAX_BYTES = 40;
/** One line of a body: a short sentence or a bullet, its link included. */
export const CLOUD_ASK_MEMBER_LINE_MAX_BYTES = 280;

/** ask_member's input, as the company runtime offers it. */
export const CLOUD_ASK_MEMBER_INPUT_SCHEMA: Schema = {
	type: "object",
	properties: {
		idempotencyKey: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$" },
		text: { type: "string", minLength: 1, maxLength: 4096, description: "A sentence that introduces the card." },
		surface: { type: "string", enum: [...CLOUD_ASK_MEMBER_SURFACES] },
		title: { type: "string", minLength: 1, maxLength: 200, description: "The question in plain words." },
		body: {
			type: "string",
			maxLength: CLOUD_ASK_MEMBER_BODY_MAX_BYTES,
			description: `At most ${CLOUD_ASK_MEMBER_BODY_MAX_LINES} short lines of at most ${CLOUD_ASK_MEMBER_LINE_MAX_BYTES} bytes, ${CLOUD_ASK_MEMBER_BODY_MAX_BYTES} in all: what is stopped until they answer, what is being chosen, the one or two things that matter, and a link to the full draft or file. Not what an answer does not allow, what is unchecked, or how approval works.`,
		},
		expiresAt: { type: "string", description: "A UTC time, such as 2026-09-25T12:00:00Z." },
		payload: CLOUD_ASK_MEMBER_PAYLOAD_SCHEMA,
	},
	required: ["idempotencyKey", "text", "surface", "title", "payload"],
	additionalProperties: false,
};

function cardReadabilityIssue(card: Record<string, unknown>): string | undefined {
	if (typeof card.body === "string") {
		const lines = card.body.split("\n").filter((line) => line.trim());
		if (
			Buffer.byteLength(card.body) > CLOUD_ASK_MEMBER_BODY_MAX_BYTES ||
			lines.length > CLOUD_ASK_MEMBER_BODY_MAX_LINES ||
			lines.some((line) => Buffer.byteLength(line) > CLOUD_ASK_MEMBER_LINE_MAX_BYTES)
		)
			return `body must be at most ${CLOUD_ASK_MEMBER_BODY_MAX_LINES} short lines of at most ${CLOUD_ASK_MEMBER_LINE_MAX_BYTES} UTF-8 bytes each, ${CLOUD_ASK_MEMBER_BODY_MAX_BYTES} in all: say what is being chosen and the one or two things that matter, and link the full draft or file, such as [Read the draft](folder:path/to/file.md)`;
	}
	const options = card.surface === "question" ? record(card.payload)?.options : undefined;
	if (
		Array.isArray(options) &&
		options.some(
			(option) => Buffer.byteLength(String(record(option)?.label ?? "")) > CLOUD_ASK_MEMBER_LABEL_MAX_BYTES,
		)
	)
		return `an option's label is a button: 1 to 3 words, at most ${CLOUD_ASK_MEMBER_LABEL_MAX_BYTES} UTF-8 bytes; say anything more in the body`;
	if (
		Array.isArray(options) &&
		options.some((option) => {
			const preview = record(option)?.preview;
			return typeof preview === "string" && !optionPreviewValid(preview);
		})
	)
		return "an option's preview is the company file path of an image you made for it (.svg, .png, .jpg, .gif or .webp), such as sketches/colour-duo.svg, or app:<name> for an interface app";
	return undefined;
}

const PREVIEW_IMAGE = /\.(?:png|jpe?g|gif|webp|svg)$/i;

/** An option's picture: an interface app, or an image's path in the company's folder (relative, no way up or out). */
export function optionPreviewValid(preview: string): boolean {
	if (preview.startsWith("app:")) return isInterfaceName(preview.slice(4));
	return (
		PREVIEW_IMAGE.test(preview) &&
		!/^[a-z][a-z0-9+.-]*:/i.test(preview) &&
		!preview.startsWith("/") &&
		!preview.split("/").some((part) => part === ".." || part === "." || part === "") &&
		!/[\0-\x1f\x7f\\]/.test(preview)
	);
}

/** The closed request data, exactly as the kernel validates it. */
export function parseCloudInteractionRequestData(value: unknown): CloudInteractionRequestData {
	const data = record(value);
	const issue = data ? interactionRequestIssue(data) : "the card must be an object";
	if (!data || issue) throw new Error(`Invalid interaction request: ${issue}`);
	return {
		schema: CLOUD_INTERACTION_SCHEMA,
		surface: data.surface as CloudInteractionSurface,
		title: data.title as string,
		...(typeof data.body === "string" ? { body: data.body } : {}),
		...(typeof data.expiresAt === "string" ? { expiresAt: data.expiresAt } : {}),
		payload: structuredClone(data.payload as Record<string, unknown>),
	};
}

/** Tool arguments: the idempotency key, the sentence above the card, and the card. */
export function parseCloudAskMemberInput(value: unknown): CloudAskMemberInput {
	const input = record(value);
	if (!input) throw new CloudToolArgumentRefusal("the arguments must be an object");
	const { idempotencyKey, text: sentence, ...card } = input;
	if (typeof idempotencyKey !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(idempotencyKey))
		throw new CloudToolArgumentRefusal(
			"idempotencyKey must be 1 to 128 letters, digits or ._:- starting alphanumeric",
		);
	if (!text(sentence, 1, 4096) || !sentence.trim())
		throw new CloudToolArgumentRefusal("text must be the sentence shown above the card, 1 to 4096 UTF-8 bytes");
	const issue = interactionRequestIssue({ schema: CLOUD_INTERACTION_SCHEMA, ...card });
	if (issue) throw new CloudToolArgumentRefusal(issue);
	const unreadable = cardReadabilityIssue(card);
	if (unreadable) throw new CloudToolArgumentRefusal(unreadable);
	if (card.surface === "form" || card.surface === "credential")
		throw new CloudToolArgumentRefusal(
			"Form entry and vault sign-in cards are unavailable. No card was created and no page was filled or signed in. Use takeover only if a member-controllable computer is available; otherwise explain the limitation in chat. Use a secret card only to save a reusable secret to the vault.",
		);
	return {
		idempotencyKey,
		text: sentence,
		data: parseCloudInteractionRequestData({ schema: CLOUD_INTERACTION_SCHEMA, ...card }),
	};
}

/** One card per (run, idempotency key): a retry replays the same event id, and the
 * kernel treats a replay with identical content as the earlier append. */
export function cloudInteractionEventId(runId: string, idempotencyKey: string): string {
	if (!UUID_PATTERN.test(runId)) throw new Error("Invalid run id");
	const digest = createHash("sha256").update(`qorpera.interaction:${runId}:${idempotencyKey}`).digest("hex");
	return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

/** The idempotency key of the final send that carries a card's sentence. It always fits the
 * send's 128-character key, so every key ask_member accepts can finish its turn and a retry
 * replays the same send. A key with no room for ":final" is replaced by its digest. */
export function cloudAskMemberFinalKey(idempotencyKey: string): string {
	const suffixed = `${idempotencyKey}:final`;
	return suffixed.length <= 128 ? suffixed : `ask-final.${createHash("sha256").update(idempotencyKey).digest("hex")}`;
}

export function parseCloudInteractionRequestReceipt(value: unknown, eventId: string): CloudInteractionRequestReceipt {
	const receipt = record(value);
	if (
		!receipt ||
		typeof receipt.session_id !== "string" ||
		!UUID_PATTERN.test(receipt.session_id) ||
		receipt.event_id !== eventId ||
		receipt.event_type !== "interaction_request" ||
		!Number.isSafeInteger(receipt.sequence) ||
		(receipt.sequence as number) < 1
	) {
		throw new Error("Invalid interaction request receipt");
	}
	return { sessionId: receipt.session_id, interactionId: eventId, sequence: receipt.sequence as number };
}
