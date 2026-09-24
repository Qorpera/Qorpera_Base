import { createHash } from "node:crypto";
import type { JsonValue } from "@qorpera/contracts";
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

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
/** Names in the cloud secret custody start with a letter. */
const VAULT_NAME_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;
const FIELD_ID_PATTERN = /^[a-z][a-z0-9_]{0,31}$/;
const HOST_PATTERN = /^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?)+$/;
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/;
const CONTROL_PATTERN = /[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]/;

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
				items: closedObject(["label"], {
					label: chars(1, 80),
					value: chars(1, 200, "Returned as the answer; defaults to the label."),
					description: chars(0, 200),
					style: { type: "string", enum: ["default", "primary", "danger"] },
				}),
			},
			multiSelect: { type: "boolean" },
			allowCustom: { type: "boolean", description: "Lets the member type their own answer." },
			dismissOnMoveOn: { type: "boolean" },
		},
		"surface question: the member picks from 1-6 options.",
	),
	secret: closedObject(
		["name", "label", "purpose"],
		{
			name: matching(VAULT_NAME_PATTERN, "The vault name the secret is saved under."),
			label: chars(1, 80),
			purpose: chars(1, 300),
			kind: { type: "string", enum: ["token", "password", "text"] },
			connectorId: matching(VAULT_NAME_PATTERN, "Default vault."),
		},
		"surface secret: the member saves a value into the company vault; you never see it.",
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
		"surface form: the host fills these fields into the page on your computer.",
	),
	takeover: closedObject(
		["instruction"],
		{
			instruction: chars(1, 300),
			reason: { type: "string", enum: ["sign_in", "captcha", "payment", "other"] },
			domain: matching(HOST_PATTERN),
			idpDomain: matching(HOST_PATTERN),
		},
		"surface takeover: the member drives your computer for a sign-in or code, then hands it back.",
	),
	draft: closedObject(
		["platform", "connectorId", "from", "to", "body"],
		{
			platform: { type: "string", enum: ["email", "slack", "message"] },
			connectorId: chars(1, 128),
			from: chars(1, 320),
			to: { type: "array", minItems: 1, maxItems: 32, items: chars(1, 320) },
			cc: { type: "array", maxItems: 32, items: chars(1, 320) },
			subject: chars(0, 500),
			body: chars(1, 65536, "The whole ask_member call must stay under 64 KiB."),
			replyTo: chars(1, 256),
			threadRef: chars(1, 256),
		},
		"surface draft: a message the member sends or discards.",
	),
	credential: closedObject(
		["name", "domain"],
		{ name: matching(NAME_PATTERN), domain: matching(HOST_PATTERN), purpose: chars(0, 300) },
		"surface credential: the computer signs in from the vault; the member does not answer it.",
	),
};

/** The payload for the surface named beside it, one closed object per surface. */
export const CLOUD_ASK_MEMBER_PAYLOAD_SCHEMA: Schema = {
	oneOf: CLOUD_INTERACTION_SURFACES.map((surface) => PAYLOAD_SCHEMAS[surface]),
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

export const CLOUD_ASK_MEMBER_INSTRUCTIONS =
	"ask_member puts one typed card in this conversation for the member to answer: a question with options, a secret they enter into the company vault, a form the host fills into the page on your computer, a takeover of your computer for a sign-in or code, a draft message they send or discard, or a credential sign-in the computer performs from the vault. " +
	"Calling it ends this turn like a final send (text is the sentence shown above the card), so finish every Company File change and coworker message first. " +
	"payload is the closed object its schema gives for the surface you name; for a question it is {options: [{label, value?, description?, style?}], multiSelect?, allowCustom?}, where each option is an object, never a plain string. Text limits count UTF-8 bytes. A refused card says what to fix: fix it and call again. " +
	"In your own shared thread, only the member you are answering can answer the card. " +
	"The answer wakes you again in this conversation as qorpera.interaction-answer/v1: an input of your next wake, or in your own thread the newest thread entry, which wake.payload.inputIds names. It carries an outcome and, for a question or form, the chosen values; a secret answer never contains the value, only the vault secret's id and version under the connector you named (connectorId, default vault), for a connector operation to use. " +
	"Never ask the member to paste a password, token or code into ordinary chat; raise a secret card, a form or a takeover instead. A declined, dismissed or expired card is the answer: do not raise the same card again at once. " +
	"Form fields that are secret (password, otp, or secret: true) need a target from your latest page snapshot; the host fills them and you click the site's own submit afterwards. Reuse the same idempotencyKey and arguments when retrying.";

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
					closedKeys(option, ["label", "value", "description", "style"]) &&
					text(option.label, 1, 80) &&
					optionalText(option, "value", 1, 200) &&
					optionalText(option, "description", 0, 200) &&
					optionalEnum(option, "style", ["default", "primary", "danger"])
				);
			});
		}
		case "secret":
			return (
				closedKeys(payload, ["name", "label", "purpose", "kind", "connectorId"]) &&
				typeof payload.name === "string" &&
				VAULT_NAME_PATTERN.test(payload.name) &&
				(!("connectorId" in payload) ||
					(typeof payload.connectorId === "string" && VAULT_NAME_PATTERN.test(payload.connectorId))) &&
				text(payload.label, 1, 80) &&
				text(payload.purpose, 1, 300) &&
				optionalEnum(payload, "kind", ["token", "password", "text"])
			);
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
