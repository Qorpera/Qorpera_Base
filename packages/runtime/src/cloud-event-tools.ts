import { parseCloudCompanyPath } from "@qorpera/cloud-client/company-path-schema";
import type { JsonValue } from "@qorpera/contracts";
import type { CloudCompanyFolderClient, CloudCompanyFolderHookRequest } from "./cloud-company-folder-client.ts";
import type { CloudCompanyPathControl } from "./cloud-company-path-gateway.ts";
import {
	type CloudNativeToolBinding,
	type CloudNativeToolIdentity,
	cloudToolRequest,
	parseCloudNativeToolBinding,
} from "./cloud-native-tool-authority.ts";
import {
	CLOUD_TOOL_RESULT_RESERVE_BYTES,
	type CloudNativeTool,
	CloudToolArgumentRefusal,
	type CloudToolContext,
	CloudToolRefusal,
	cloudToolJsonText,
	MAX_CLOUD_TOOL_RESULT_BYTES,
} from "./cloud-native-tool-boundary.ts";
import type { CloudRuntimeToolOperation } from "./cloud-runtime-observability.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/** A plain address, lowercase, as the database checks it: no display name, a domain name with a top-level domain. */
const ADDRESS = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const MAIL_KEYS = new Set(["from", "to", "cc", "subject", "text", "inReplyTo", "attachments"]);
/** Company files on one email, as the database checks them. */
const MAIL_ATTACHMENTS = 10;
const MAIL_RECIPIENTS = 10;
const MAIL_SUBJECT_CHARACTERS = 200;
const MAIL_TEXT_CHARACTERS = 20_000;
const FIND_KEYS = new Set(["mailbox", "to", "from", "subject", "since", "before", "waitSeconds"]);
/** An instant with its offset, as the database reads it. */
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:?\d{2})$/;
const FIND_WAIT_SECONDS = 120;
/** How often a waiting find_mail looks again. */
const FIND_STEP_MS = 3000;
/** A hook's operation key, as company_write takes it. */
const OPERATION_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
/** Base64 as the database encodes a body, padded, without line breaks. */
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const HOOK_NAME = /^[a-z][a-z0-9-]{0,63}$/;
const MAILBOX_NAME = /^[a-z0-9]([a-z0-9_-]{0,37}[a-z0-9])?\.[a-z0-9][a-z0-9-]{0,22}[a-z0-9]$/;
/** The site a signed hook's secret may be typed into, as A1's account sites are (E3b). */
const HOST = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;
/** Where a Stripe hook's secret is read, and nowhere else (E3c). */
const STRIPE_SITE = "dashboard.stripe.com";
/** The keys of each kind of change, as the database checks them. */
const HOOK_REQUEST_KEYS = {
	hook: ["action", "kind", "name", "purpose", "proof", "site", "maxBodyBytes", "perMinute", "operationKey"],
	mailbox: ["action", "kind", "localPart", "purpose", "operationKey"],
	change: ["action", "hook", "operationKey"],
} as const;
/** The room a piece always leaves its body: headers that would take more are cut. */
const PIECE_BODY_FLOOR_BYTES = 1024;

/** The bytes a tool result carrying value takes in the fence: its JSON text is one string inside the fence's JSON,
 * with < > & U+2028 U+2029 escaped as six bytes. */
function fencedBytes(value: Record<string, unknown>): number {
	return Buffer.byteLength(JSON.stringify(cloudToolJsonText(value)).replace(/[<>&\u2028\u2029]/g, "\\u0000"));
}

/**
 * A read_event receipt cut to what one tool result shows whole. The fence cuts a result's tail and the keys are
 * sorted, so a piece too long for it would lose the end of its text while next survived, and reading on from next
 * would skip what was cut. The piece is cut here instead, at a character (text) or after a whole three bytes
 * (base64), and next points right after it. Headers come with the first piece only, so a sender's long headers
 * cannot shrink every piece; there, headers that would leave the body less than PIECE_BODY_FLOOR_BYTES are cut first,
 * every value to the same number of characters.
 */
function fittedEventPiece(receipt: Record<string, unknown>): Record<string, unknown> {
	const budget = MAX_CLOUD_TOOL_RESULT_BYTES - CLOUD_TOOL_RESULT_RESERVE_BYTES;
	if (fencedBytes(receipt) <= budget) return receipt;
	const offset = receipt.offset as number;
	const characters = receipt.encoding === "utf8" ? [...(receipt.text as string)] : undefined;
	const data = receipt.encoding === "base64" ? (receipt.data as string) : undefined;
	// What the piece can be cut into: characters, or base64 quartets of three bytes each.
	const units = characters?.length ?? (data === undefined ? 0 : data.length / 4);
	const cut = (from: Record<string, unknown>, count: number): Record<string, unknown> =>
		count >= units
			? from
			: {
					...from,
					...(characters ? { text: characters.slice(0, count).join("") } : { data: data!.slice(0, count * 4) }),
					done: false,
					next: offset + (characters ? count : count * 3),
				};
	let fitted = receipt;
	const headers = Object.entries((receipt.headers ?? {}) as Record<string, string>).map(
		([name, value]) => [name, [...value]] as const,
	);
	const floor = units > 0 ? PIECE_BODY_FLOOR_BYTES : 0;
	if (headers.length > 0 && fencedBytes(cut(receipt, 0)) + floor > budget) {
		const shortened = (most: number) => ({
			...receipt,
			headers: Object.fromEntries(headers.map(([name, value]) => [name, value.slice(0, most).join("")])),
			headersCut: true,
		});
		let low = 0;
		let high = Math.max(0, ...headers.map(([, value]) => value.length));
		while (low < high) {
			const middle = Math.ceil((low + high) / 2);
			if (fencedBytes(cut(shortened(middle), 0)) + floor <= budget) low = middle;
			else high = middle - 1;
		}
		fitted = shortened(low);
		if (fencedBytes(fitted) <= budget) return fitted;
	}
	let low = 0;
	let high = units - 1;
	while (low < high) {
		const middle = Math.ceil((low + high) / 2);
		if (fencedBytes(cut(fitted, middle)) <= budget) low = middle;
		else high = middle - 1;
	}
	if (low < 1 || fencedBytes(cut(fitted, low)) > budget) throw new Error("Event piece exceeds its result");
	return cut(fitted, low);
}

/** A pause that the run's abort ends early. */
function pause(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal.aborted) return reject(signal.reason);
		const stop = (): void => {
			clearTimeout(timer);
			reject(signal.reason);
		};
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", stop);
			resolve();
		}, ms);
		signal.addEventListener("abort", stop, { once: true });
	});
}

export const CLOUD_LIST_HOOKS_TOOL_DESCRIPTION = [
	"List your company's hooks and mailboxes: where other services send events (a website form, a payment provider, a monitoring alert) and where email arrives. Each has its id, name, what it is for, its proof, its status and when it last received something.",
	"proof: address, anyone with the address may post; stripe, github or hmac-sha256, the sender signs; mail, a mailbox, which receives email at its address and at that address with a +tag (hello.acme+stripe@… reaches hello.acme@…), and sends with send_mail.",
	"A signed hook's signingSecret says whether the vault holds its secret (ready). A Stripe hook's also has the version the vault read off Stripe's page, when (capturedAt), and the last event refused under it (lastRefusal: when and why); events refused after a capture usually mean the endpoint's secret changed at Stripe.",
	"When an owner or admin started this run, each hook also has its address and path, and url, the full address a sending service posts to, once the platform has one; an address is never shared outside the company.",
	"A routine wakes on a hook's events with manage_routine, trigger kind event and the hook's id.",
].join("\n");

export const CLOUD_READ_EVENT_TOOL_DESCRIPTION = [
	"Read one event that arrived at one of your company's hooks, by its deliveryId from wake.payload.events.",
	"The answer has the hook, the event type, when it arrived, the content type, the kept headers (with the first piece, offset 0), and a piece of the body cut to fit one result: text (encoding utf8), up to 16,000 characters of plain text and fewer where characters need escaping, such as quotes and HTML, or about 23 KiB of base64 data for anything else. Headers too long to leave the body room are cut short, every value to the same length (headersCut). An email lists its attachments (filename, contentType, size) without their contents, which no tool can open yet.",
	"done says whether more follows: read on with offset set to next (characters for text, bytes for base64); total is the whole body's length in the same unit. bodyCleared means the body was deleted after 7 days.",
].join("\n");

export const CLOUD_SEND_MAIL_TOOL_DESCRIPTION = [
	`Send an email from one of your company's mailboxes, as yourself: from is the mailbox's address as list_hooks shows it, and recipients see your name and your company's. Plain text, to at most ${MAIL_RECIPIENTS} addresses in to and cc together; the platform adds a closing line saying an AI agent wrote and sent it.`,
	`- attachments: company files by their paths (at most ${MAIL_ATTACHMENTS}, together at most 28 MiB), sent as they are when you call; a file you made on a computer goes into the company folder first.`,
	"- inReplyTo: the deliveryId of an email that arrived; the reply joins its thread. Address it yourself (its replyTo, else its from) and write the subject (usually Re: and the original subject).",
	"An email marked automated (an auto-reply, a mailing list or bulk mail) is never answered, and your company's own mailboxes are never recipients: reach coworkers with send_coworker_message. Every email is reviewed before it is sent, like any action outside the company, and goes out within about a minute, within the company's hourly and daily limits on recipients; replies arrive at the mailbox like any email.",
	"The answer is the queued email, with mailId; the same call made again is the same email.",
].join("\n");

export const CLOUD_FIND_MAIL_TOOL_DESCRIPTION = [
	"Find email that arrived at your company's mailboxes in the last days, such as the confirmation a website sends when you sign the company up.",
	"Filters: mailbox (its address as list_hooks shows it); to, the address it was delivered to (a +tag address such as hello.acme+stripe@… reaches hello.acme@… and is found by its full address); from and subject, parts of them in any case; since, an instant with its offset (the last 24 hours by default, never more than 7 days back); before, an instant with its offset, to page back.",
	`waitSeconds (up to ${FIND_WAIT_SECONDS}) waits for a matching email to arrive before answering: give since as the moment you acted, so earlier mail does not count.`,
	"The answer lists up to 10 emails, newest first, each with its deliveryId, mailbox, deliveredTo, from, subject, the sender's authentication (spf, dkim and dmarc verdicts) and receivedAt. more says there may be others: pass nextBefore as before for the next older ones. Read one whole with read_event.",
].join("\n");

export const CLOUD_MANAGE_HOOK_TOOL_DESCRIPTION = [
	"Open a hook or a mailbox for your company, or pause, resume or remove one by its name (hook, as list_hooks shows it). Only a run that one of the company's owners or admins started changes hooks. Opening one is reviewed before it happens, like any action outside the company; a company has at most 50 hooks, mailboxes included, and at most 20 mailboxes.",
	"- create, kind hook: an address where another service posts events, such as a website form, a monitoring alert or a no-code automation. Anyone with the address may post to it: the answer has its address and path, and url, the full address the sending service posts to, once the platform has one. Give it only to that service; list_hooks shows it again.",
	"- create, kind mailbox: another address under a handle the company already owns, localPart <box>.<handle> such as sales.acme where the company's addresses end .acme@ (list_hooks shows them); a founder chooses the first address and its handle, never you. Email arrives at localPart@ the company's mail domain; its hook's name starts mail-. find_mail and read_event read what arrives, and send_mail sends from it.",
	"- pause: the hook refuses what is sent to it until resume. remove: it ends for good and frees a mailbox's address for any company to take, so a removal is reviewed first too.",
	"Signed hooks (proof github, hmac-sha256 or stripe) take only events signed with their secret. The vault makes the secret (Stripe makes a Stripe hook's) and keeps it: you never see it, and nobody can show it to you. No tool can type the secret into the sender's settings now, so a github or hmac-sha256 hook checks no event yet. A Stripe hook is opened per Stripe endpoint, test mode apart from live mode: add the endpoint at Stripe with the hook's url; the vault must then read its signing secret off the endpoint's page on dashboard.stripe.com, which no tool can do now, and until it has, the hook checks no event.",
	"The same call again with the same operationKey gives the same answer. A routine wakes on a hook's events with manage_routine, trigger kind event and the hook's id.",
].join("\n");

/** The fields a change to the company's hooks takes, each checked as the database checks it, so the model learns what to
 * fix before the change is reviewed. A GitHub or HMAC hook takes its site, github.com by default for GitHub (E3b); a
 * Stripe hook's is dashboard.stripe.com, named or not, where its secret is read (E3c). */
function parseHookRequest(value: JsonValue): JsonValue {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new CloudToolArgumentRefusal("manage_hook takes an object with action and operationKey");
	const a = value as Record<string, unknown>;
	if (a.action !== "create" && a.action !== "pause" && a.action !== "resume" && a.action !== "remove")
		throw new CloudToolArgumentRefusal("action is create, pause, resume or remove");
	if (a.action === "create" && a.kind !== "hook" && a.kind !== "mailbox")
		throw new CloudToolArgumentRefusal("create takes kind hook or mailbox");
	const keys = a.action === "create" ? HOOK_REQUEST_KEYS[a.kind as "hook" | "mailbox"] : HOOK_REQUEST_KEYS.change;
	if (Object.keys(a).some((key) => !(keys as readonly string[]).includes(key)))
		throw new CloudToolArgumentRefusal(
			`${a.action === "create" ? `create with kind ${a.kind as string}` : (a.action as string)} takes only ${keys.join(", ")}`,
		);
	if (typeof a.operationKey !== "string" || !OPERATION_KEY.test(a.operationKey))
		throw new CloudToolArgumentRefusal(
			"operationKey is 1 to 192 letters, digits, dots, underscores, colons and hyphens, starting with a letter or digit",
		);
	const operationKey = a.operationKey;
	if (a.action !== "create") {
		if (typeof a.hook !== "string" || !HOOK_NAME.test(a.hook))
			throw new CloudToolArgumentRefusal("hook is the name of one of your company's hooks, as list_hooks shows it");
		return { action: a.action, hook: a.hook, operationKey };
	}
	// The database trims spaces only, and counts characters.
	const purpose = typeof a.purpose === "string" ? a.purpose.replace(/^ +| +$/g, "") : "";
	if (!purpose || [...purpose].length > 512 || /\p{Cc}/u.test(purpose))
		throw new CloudToolArgumentRefusal("purpose is one line of 1 to 512 characters saying what it is for");
	if (a.kind === "mailbox") {
		if (typeof a.localPart !== "string" || !MAILBOX_NAME.test(a.localPart))
			throw new CloudToolArgumentRefusal(
				"localPart is a box, a dot and a handle the company already owns, such as sales.acme: the box 1 to 39 lowercase letters, digits, hyphens and underscores, the handle 2 to 24 lowercase letters, digits and hyphens, each starting and ending with a letter or digit",
			);
		return { action: "create", kind: "mailbox", localPart: a.localPart, purpose, operationKey };
	}
	if (typeof a.name !== "string" || !HOOK_NAME.test(a.name) || a.name.startsWith("mail-"))
		throw new CloudToolArgumentRefusal(
			"name uses lowercase letters, digits and hyphens, starts with a letter, has at most 64 characters and does not start with mail-",
		);
	if (
		a.proof !== undefined &&
		a.proof !== "address" &&
		a.proof !== "github" &&
		a.proof !== "hmac-sha256" &&
		a.proof !== "stripe"
	)
		throw new CloudToolArgumentRefusal("proof is address, github, hmac-sha256 or stripe");
	const proof = a.proof === "github" || a.proof === "hmac-sha256" || a.proof === "stripe" ? a.proof : undefined;
	if (!proof && a.site !== undefined)
		throw new CloudToolArgumentRefusal("Only a signed hook names the site its secret is typed into");
	if (proof === "hmac-sha256" && a.site === undefined)
		throw new CloudToolArgumentRefusal("An HMAC hook names the site its secret is typed into");
	// As A1's account sites: a lowercase host name. A Stripe hook's secret is read on Stripe's dashboard, and only there.
	const site = !proof
		? undefined
		: a.site === undefined
			? proof === "stripe"
				? STRIPE_SITE
				: "github.com"
			: typeof a.site === "string"
				? a.site.trim().toLowerCase()
				: "";
	if (site !== undefined && (site.length > 253 || !HOST.test(site)))
		throw new CloudToolArgumentRefusal("A site is a host name such as github.com");
	if (proof === "stripe" && site !== STRIPE_SITE)
		throw new CloudToolArgumentRefusal("A Stripe hook's secret is taken from dashboard.stripe.com");
	const limit = (key: "maxBodyBytes" | "perMinute", least: number, most: number): number | undefined => {
		const field = a[key];
		if (field === undefined) return undefined;
		if (!Number.isSafeInteger(field) || (field as number) < least || (field as number) > most)
			throw new CloudToolArgumentRefusal(`${key} is a whole number from ${least} to ${most}`);
		return field as number;
	};
	const maxBodyBytes = limit("maxBodyBytes", 1024, 262144);
	const perMinute = limit("perMinute", 1, 120);
	// A limit left out takes the database's default. A signed hook names its proof and site; an address hook leaves its
	// proof out, as E3a's request does.
	const request: Record<string, string | number> = { action: "create", kind: "hook", name: a.name, purpose };
	if (proof && site) {
		request.proof = proof;
		request.site = site;
	}
	if (maxBodyBytes !== undefined) request.maxBodyBytes = maxBodyBytes;
	if (perMinute !== undefined) request.perMinute = perMinute;
	request.operationKey = operationKey;
	return request;
}

/** The cloud derives the company from the run; the model names only the event. A folder-v2 run's agent also changes the
 * company's hooks through its folder client (E3a). */
export function cloudEventTools(
	binding: CloudNativeToolBinding,
	identity: CloudNativeToolIdentity,
	control: CloudCompanyPathControl,
	folder?: CloudCompanyFolderClient,
): readonly CloudNativeTool[] {
	const admitted = parseCloudNativeToolBinding(binding),
		expected = Object.freeze({ ...identity });
	if (
		Object.entries(admitted).some(
			([key, value]) => key !== "credentialCapsuleId" && expected[key as keyof CloudNativeToolIdentity] !== value,
		) ||
		(folder && folder.actor.runId !== admitted.runId.toLowerCase())
	)
		throw new Error("Event binding differs");
	const assertContext = (context: CloudToolContext) => {
		if (
			context.runId !== expected.runId ||
			context.companyId !== expected.companyId ||
			!context.identity ||
			Object.entries(expected).some(
				([key, value]) => context.identity![key as keyof CloudNativeToolIdentity] !== value,
			)
		)
			throw new Error("Event tool identity differs");
		context.signal.throwIfAborted();
	};
	const listHooks: CloudNativeTool = {
		name: "list_hooks" satisfies CloudRuntimeToolOperation,
		source: "runtime",
		description: CLOUD_LIST_HOOKS_TOOL_DESCRIPTION,
		inputSchema: { type: "object", additionalProperties: false, properties: {} },
		parseArguments(value) {
			if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length > 0)
				throw new Error("Invalid hook request");
			return {};
		},
		async execute(_value, context) {
			assertContext(context);
			const result = await cloudToolRequest(
				(requestSignal) => control.call("qorpera_list_agent_event_hooks", { p_binding: admitted }, requestSignal),
				context.signal,
			);
			const r = result as Record<string, unknown> | null;
			if (
				!r ||
				typeof r !== "object" ||
				r.schema !== "qorpera.agent-event-hooks/v1" ||
				r.runId !== admitted.runId ||
				!Array.isArray(r.hooks)
			)
				throw new Error("Hook list differs");
			return { kind: "text", value: cloudToolJsonText(r) };
		},
	};
	const readEvent: CloudNativeTool = {
		name: "read_event" satisfies CloudRuntimeToolOperation,
		source: "runtime",
		description: CLOUD_READ_EVENT_TOOL_DESCRIPTION,
		inputSchema: {
			type: "object",
			additionalProperties: false,
			required: ["deliveryId"],
			properties: {
				deliveryId: { type: "string", pattern: UUID.source },
				offset: { type: "integer", minimum: 0, maximum: 1048576 },
			},
		},
		parseArguments(value) {
			if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid event request");
			const a = value as Record<string, unknown>;
			if (
				Object.keys(a).some((key) => key !== "deliveryId" && key !== "offset") ||
				typeof a.deliveryId !== "string" ||
				!UUID.test(a.deliveryId) ||
				(a.offset !== undefined &&
					(!Number.isSafeInteger(a.offset) || (a.offset as number) < 0 || (a.offset as number) > 1048576))
			)
				throw new Error("Invalid event request");
			const request: Record<string, string | number> = { deliveryId: a.deliveryId.toLowerCase() };
			if (a.offset !== undefined) request.offset = a.offset as number;
			return request;
		},
		async execute(value, context) {
			assertContext(context);
			const request = value as { deliveryId: string; offset?: number };
			const result = await cloudToolRequest(
				(requestSignal) =>
					control.call("qorpera_read_agent_event", { p_binding: admitted, p_request: request }, requestSignal),
				context.signal,
			);
			const r = result as Record<string, unknown> | null;
			const offset = request.offset ?? 0;
			// The piece in the unit next counts: characters of text, bytes of base64 data.
			const shown =
				r?.encoding === "utf8" && typeof r.text === "string"
					? [...r.text].length
					: r?.encoding === "base64" && typeof r.data === "string" && BASE64.test(r.data)
						? Buffer.byteLength(r.data, "base64")
						: undefined;
			if (
				!r ||
				typeof r !== "object" ||
				r.schema !== "qorpera.agent-event/v1" ||
				r.runId !== admitted.runId ||
				r.deliveryId !== request.deliveryId ||
				!r.headers ||
				typeof r.headers !== "object" ||
				Array.isArray(r.headers) ||
				Object.values(r.headers).some((value) => typeof value !== "string") ||
				typeof r.done !== "boolean" ||
				r.done !== (r.next === undefined) ||
				(r.encoding === undefined
					? r.bodyCleared !== true
					: shown === undefined ||
						r.offset !== offset ||
						// The next piece starts right after this one: nothing between them goes unread.
						(r.next !== undefined && (shown === 0 || r.next !== offset + shown)))
			)
				throw new Error("Event receipt differs");
			// The headers belong to the event: they come with its first piece, and the rest leave them out.
			const { headers: _headers, ...rest } = r;
			return { kind: "text", value: cloudToolJsonText(fittedEventPiece(offset === 0 ? r : rest)) };
		},
	};
	const sendMail: CloudNativeTool = {
		name: "send_mail" satisfies CloudRuntimeToolOperation,
		source: "runtime",
		description: CLOUD_SEND_MAIL_TOOL_DESCRIPTION,
		inputSchema: {
			type: "object",
			additionalProperties: false,
			required: ["from", "to", "subject", "text"],
			properties: {
				from: { type: "string", maxLength: 320 },
				to: { type: "array", minItems: 1, maxItems: MAIL_RECIPIENTS, items: { type: "string", maxLength: 254 } },
				cc: { type: "array", maxItems: MAIL_RECIPIENTS - 1, items: { type: "string", maxLength: 254 } },
				subject: { type: "string", minLength: 1, maxLength: MAIL_SUBJECT_CHARACTERS },
				text: { type: "string", minLength: 1, maxLength: MAIL_TEXT_CHARACTERS },
				inReplyTo: { type: "string", pattern: UUID.source },
				attachments: {
					type: "array",
					maxItems: MAIL_ATTACHMENTS,
					uniqueItems: true,
					items: { type: "string", minLength: 1, maxLength: 4096 },
				},
			},
		},
		parseArguments(value) {
			if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid mail request");
			const a = value as Record<string, unknown>;
			const addresses = (items: unknown, most: number): string[] => {
				if (!Array.isArray(items) || items.length > most) throw new Error("Invalid mail request");
				return items.map((item) => {
					const address = typeof item === "string" ? item.trim().toLowerCase() : "";
					if (address.length > 254 || !ADDRESS.test(address)) throw new Error("Invalid mail request");
					return address;
				});
			};
			if (
				Object.keys(a).some((key) => !MAIL_KEYS.has(key)) ||
				typeof a.from !== "string" ||
				!a.from.trim() ||
				a.from.length > 320 ||
				typeof a.subject !== "string" ||
				!a.subject.trim() ||
				[...a.subject].length > MAIL_SUBJECT_CHARACTERS ||
				/\p{Cc}/u.test(a.subject) ||
				typeof a.text !== "string" ||
				!a.text.trim() ||
				[...a.text].length > MAIL_TEXT_CHARACTERS ||
				(a.inReplyTo !== undefined && (typeof a.inReplyTo !== "string" || !UUID.test(a.inReplyTo)))
			)
				throw new Error("Invalid mail request");
			// Each address once; one already in to is not copied again in cc.
			const to = [...new Set(addresses(a.to, MAIL_RECIPIENTS))];
			const cc = [...new Set(a.cc === undefined ? [] : addresses(a.cc, MAIL_RECIPIENTS - 1))].filter(
				(address) => !to.includes(address),
			);
			if (to.length === 0 || to.length + cc.length > MAIL_RECIPIENTS) throw new Error("Invalid mail request");
			// Company paths, each once.
			const attachments =
				a.attachments === undefined
					? []
					: Array.isArray(a.attachments) && a.attachments.length <= MAIL_ATTACHMENTS
						? a.attachments.map((path) => parseCloudCompanyPath(path))
						: null;
			if (!attachments || new Set(attachments).size !== attachments.length) throw new Error("Invalid mail request");
			const request: Record<string, string | string[]> = {
				from: a.from.trim().toLowerCase(),
				to,
				subject: a.subject.trim(),
				text: a.text,
			};
			if (cc.length) request.cc = cc;
			if (a.inReplyTo !== undefined) request.inReplyTo = (a.inReplyTo as string).toLowerCase();
			if (attachments.length) request.attachments = attachments;
			return request;
		},
		async execute(value, context) {
			assertContext(context);
			// The call's id makes a repeated request the same email.
			const result = await cloudToolRequest(
				(requestSignal) =>
					control.call(
						"qorpera_send_agent_mail",
						{ p_binding: admitted, p_call_id: context.callId, p_request: value },
						requestSignal,
					),
				context.signal,
			);
			const r = result as Record<string, unknown> | null;
			if (
				!r ||
				typeof r !== "object" ||
				r.schema !== "qorpera.agent-mail/v1" ||
				r.runId !== admitted.runId ||
				typeof r.mailId !== "string" ||
				!UUID.test(r.mailId) ||
				typeof r.status !== "string"
			)
				throw new Error("Mail receipt differs");
			return { kind: "text", value: cloudToolJsonText(r) };
		},
	};
	const findMail: CloudNativeTool = {
		name: "find_mail" satisfies CloudRuntimeToolOperation,
		source: "runtime",
		description: CLOUD_FIND_MAIL_TOOL_DESCRIPTION,
		inputSchema: {
			type: "object",
			additionalProperties: false,
			properties: {
				mailbox: { type: "string", minLength: 3, maxLength: 320 },
				to: { type: "string", minLength: 3, maxLength: 320 },
				from: { type: "string", minLength: 1, maxLength: 320 },
				subject: { type: "string", minLength: 1, maxLength: MAIL_SUBJECT_CHARACTERS },
				since: { type: "string", format: "date-time" },
				before: { type: "string", format: "date-time" },
				waitSeconds: { type: "integer", minimum: 0, maximum: FIND_WAIT_SECONDS },
			},
		},
		parseArguments(value) {
			if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid mail search");
			const a = value as Record<string, unknown>;
			const text = (key: string, least: number, most: number): string | undefined => {
				const field = a[key];
				if (field === undefined) return undefined;
				if (typeof field !== "string" || /\p{Cc}/u.test(field)) throw new Error("Invalid mail search");
				const trimmed = key === "from" || key === "subject" ? field : field.trim().toLowerCase();
				if ([...trimmed].length < least || [...trimmed].length > most) throw new Error("Invalid mail search");
				return trimmed;
			};
			if (Object.keys(a).some((key) => !FIND_KEYS.has(key))) throw new Error("Invalid mail search");
			const request: Record<string, string> = {};
			for (const [key, least, most] of [
				["mailbox", 3, 320],
				["to", 3, 320],
				["from", 1, 320],
				["subject", 1, MAIL_SUBJECT_CHARACTERS],
			] as const) {
				const field = text(key, least, most);
				if (field !== undefined) request[key] = field;
			}
			for (const key of ["since", "before"] as const) {
				const instant = a[key];
				if (instant === undefined) continue;
				if (typeof instant !== "string" || !INSTANT.test(instant) || Number.isNaN(Date.parse(instant)))
					throw new Error("Invalid mail search");
				request[key] = instant;
			}
			const waitSeconds = a.waitSeconds === undefined ? 0 : a.waitSeconds;
			if (
				!Number.isSafeInteger(waitSeconds) ||
				(waitSeconds as number) < 0 ||
				(waitSeconds as number) > FIND_WAIT_SECONDS
			)
				throw new Error("Invalid mail search");
			return { request, waitSeconds: waitSeconds as number };
		},
		async execute(value, context) {
			assertContext(context);
			const { request, waitSeconds } = value as { request: Record<string, string>; waitSeconds: number };
			// With waitSeconds, look again every few seconds until a match arrives or the time is up.
			const deadline = Date.now() + waitSeconds * 1000;
			for (;;) {
				const result = await cloudToolRequest(
					(requestSignal) =>
						control.call("qorpera_find_agent_mail", { p_binding: admitted, p_request: request }, requestSignal),
					context.signal,
				);
				const r = result as Record<string, unknown> | null;
				if (
					!r ||
					typeof r !== "object" ||
					r.schema !== "qorpera.agent-mail-search/v1" ||
					r.runId !== admitted.runId ||
					!Array.isArray(r.mails) ||
					r.mails.length > 10 ||
					typeof r.more !== "boolean"
				)
					throw new Error("Mail search differs");
				const left = deadline - Date.now();
				if (r.mails.length > 0 || left <= 0) return { kind: "text", value: cloudToolJsonText(r) };
				await pause(Math.min(FIND_STEP_MS, left), context.signal);
				assertContext(context);
			}
		},
	};
	const manageHook: CloudNativeTool | undefined = folder && {
		name: "manage_hook" satisfies CloudRuntimeToolOperation,
		source: "runtime",
		description: CLOUD_MANAGE_HOOK_TOOL_DESCRIPTION,
		inputSchema: {
			type: "object",
			additionalProperties: false,
			required: ["action", "operationKey"],
			properties: {
				action: { type: "string", enum: ["create", "pause", "resume", "remove"] },
				kind: { type: "string", enum: ["hook", "mailbox"] },
				name: {
					type: "string",
					pattern: HOOK_NAME.source,
					description:
						"A new hook's name: lowercase letters, digits and hyphens, from a letter, at most 64, not starting mail-.",
				},
				localPart: {
					type: "string",
					pattern: MAILBOX_NAME.source,
					maxLength: 64,
					description:
						"<box>.<handle>, at most 64 characters, such as sales.acme: a box of lowercase letters, digits, hyphens and underscores, a dot, and a handle the company already owns.",
				},
				purpose: {
					type: "string",
					minLength: 1,
					maxLength: 512,
					description: "One line on what it is for, at most 512 characters.",
				},
				proof: {
					type: "string",
					enum: ["address", "github", "hmac-sha256", "stripe"],
					description:
						"address unless the sender signs: github for GitHub's webhooks, hmac-sha256 for one that signs as Standard Webhooks do (a whsec_ secret, as Svix's), stripe for Stripe's.",
				},
				site: {
					type: "string",
					maxLength: 253,
					description:
						"The host where the secret may be typed into the sender's settings, and nowhere else: github.com unless named for github, required for hmac-sha256, dashboard.stripe.com for stripe. The answer names it as secretSite.",
				},
				maxBodyBytes: {
					type: "integer",
					minimum: 1024,
					maximum: 262144,
					description: "1024 to 262144, 65536 by default.",
				},
				perMinute: { type: "integer", minimum: 1, maximum: 120, description: "1 to 120, 60 by default." },
				hook: { type: "string", pattern: HOOK_NAME.source },
				operationKey: { type: "string", pattern: OPERATION_KEY.source },
			},
		},
		parseArguments: parseHookRequest,
		async execute(value, context) {
			assertContext(context);
			const answer = await folder.manageHook(value as CloudCompanyFolderHookRequest, context.signal);
			// SQL refused it and changed nothing: the model reads why.
			if ("refused" in answer) throw new CloudToolRefusal(answer.refused);
			return {
				kind: "text",
				value: cloudToolJsonText({ schema: "qorpera.agent-hook-receipt/v1", runId: admitted.runId, ...answer }),
			};
		},
	};
	return [listHooks, readEvent, sendMail, findMail, ...(manageHook ? [manageHook] : [])];
}
