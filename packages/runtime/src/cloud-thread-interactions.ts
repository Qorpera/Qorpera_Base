import { createHash } from "node:crypto";

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
const FIELD_ID_PATTERN = /^[a-z][a-z0-9_]{0,31}$/;
const HOST_PATTERN = /^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?)+$/;
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/;
const CONTROL_PATTERN = /[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]/;

export const CLOUD_ASK_MEMBER_INSTRUCTIONS =
	"ask_member puts one typed card in this conversation for the member to answer: a question with options, a secret they enter into the company vault, a form the host fills into the page on your computer, a takeover of your computer for a sign-in or code, a draft message they send or discard, or a credential sign-in the computer performs from the vault. " +
	"Calling it ends this turn like a final send (text is the sentence shown above the card), so finish every Company File change and coworker message first. " +
	"The answer arrives as the input of your next wake as qorpera.interaction-answer/v1 with an outcome and, for a question or form, the chosen values; a secret answer never contains the value, use the vault name. " +
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
				closedKeys(payload, ["name", "label", "purpose", "kind"]) &&
				typeof payload.name === "string" &&
				NAME_PATTERN.test(payload.name) &&
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

/** The closed request data, exactly as the kernel validates it. */
export function parseCloudInteractionRequestData(value: unknown): CloudInteractionRequestData {
	const data = record(value);
	const payload = data ? record(data.payload) : undefined;
	if (
		!data ||
		!payload ||
		data.schema !== CLOUD_INTERACTION_SCHEMA ||
		!closedKeys(data, ["schema", "surface", "title", "body", "expiresAt", "payload"]) ||
		typeof data.surface !== "string" ||
		!(CLOUD_INTERACTION_SURFACES as readonly string[]).includes(data.surface) ||
		!text(data.title, 1, 200) ||
		!optionalText(data, "body", 0, 2000) ||
		("expiresAt" in data &&
			(typeof data.expiresAt !== "string" ||
				!TIMESTAMP_PATTERN.test(data.expiresAt) ||
				!Number.isFinite(Date.parse(data.expiresAt)))) ||
		!payloadValid(data.surface as CloudInteractionSurface, payload)
	) {
		throw new Error("Invalid interaction request");
	}
	return {
		schema: CLOUD_INTERACTION_SCHEMA,
		surface: data.surface as CloudInteractionSurface,
		title: data.title as string,
		...(typeof data.body === "string" ? { body: data.body } : {}),
		...(typeof data.expiresAt === "string" ? { expiresAt: data.expiresAt } : {}),
		payload: structuredClone(payload),
	};
}

/** Tool arguments: the idempotency key, the sentence above the card, and the card. */
export function parseCloudAskMemberInput(value: unknown): CloudAskMemberInput {
	const input = record(value);
	if (
		!input ||
		!closedKeys(input, ["idempotencyKey", "text", "schema", "surface", "title", "body", "expiresAt", "payload"]) ||
		("schema" in input && input.schema !== CLOUD_INTERACTION_SCHEMA) ||
		typeof input.idempotencyKey !== "string" ||
		!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input.idempotencyKey) ||
		!text(input.text, 1, 4096) ||
		!(input.text as string).trim()
	) {
		throw new Error("Invalid ask_member arguments");
	}
	const { idempotencyKey, text: sentence, ...card } = input;
	return {
		idempotencyKey,
		text: sentence as string,
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
