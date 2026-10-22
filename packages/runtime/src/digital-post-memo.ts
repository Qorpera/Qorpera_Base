import { createHash } from "node:crypto";

/**
 * Danish Digital Post letters (MeMo, "Meddelelsesmodel", versions 1.1 and 1.2) as the company vault fetches them for a
 * company's Digital Post connection. A letter arrives as one XML document whose files (the main document, attachments
 * and technical documents) are carried inside it as base64. This module reads that document strictly and reduces it
 * to the letter the platform keeps: who sent it, its title and flags, its documents with their bytes, and the main
 * document's text where a text or HTML version exists.
 *
 * The XML reader takes only what MeMo uses: elements, attributes, namespaces, text, CDATA, comments and processing
 * instructions. A document type declaration, an entity other than the five predefined ones and character
 * references, or anything malformed refuses the whole letter (`DigitalPostLetterInvalid`): such a letter is never
 * receipted, so Digital Post keeps it and, after seven days, puts it in the company's mailbox on Virk.
 *
 * Spec: Digital Post "MeMo" (https://www.digitaliser.dk/digital-post/vejledninger/memo) and the Technical Integration
 * guide, section 10.2. Nothing here logs a letter's content; error messages are fixed phrases.
 */

export const MEMO_NAMESPACE = "https://DigitalPost.dk/MeMo-1";

/** The most XML a letter may be: larger letters stay at Digital Post (and reach Virk after seven days). */
export const DIGITAL_POST_LETTER_MAX_BYTES = 32 * 1024 * 1024;
const MAX_DEPTH = 64;
const MAX_ELEMENTS = 50_000;
const MAX_FILES = 100;
const MAX_ACTIONS = 100;
const MAX_FIELD_CHARACTERS = 2000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
// MeMo's own names are ASCII; a name outside this set refuses the letter.
const NAME = /^[A-Za-z_][A-Za-z0-9._-]*(?::[A-Za-z_][A-Za-z0-9._-]*)?$/;
// Characters XML 1.0 never allows (C0 controls other than tab, newline and carriage return; lone surrogates are
// already refused by the strict UTF-8 decoder).
const FORBIDDEN_CHARACTER = /[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/;

/** The letter could not be read; the message is a fixed phrase. */
export class DigitalPostLetterInvalid extends Error {
	constructor(message: string) {
		super(message);
		this.name = "DigitalPostLetterInvalid";
	}
}

export interface DigitalPostFile {
	/** The file's media type as the sender gave it, lowercase (`application/pdf`, `text/html`, ...). */
	readonly encodingFormat: string;
	/** The sender's file name, as given (the folder writer makes it safe). */
	readonly filename: string;
	readonly language: string | null;
	readonly bytes: Uint8Array;
}

/** A link the sender offers with a document: a self-service page, a payment, a meeting, a form. */
export interface DigitalPostAction {
	readonly label: string;
	/** `SELVBETJENING`, `BETALING`, `AFTALE`, `INFORMATION`, `UNDERSKRIV`, `BEKRAEFT`, `FORHAANDSVISNING`, ... */
	readonly actionCode: string;
	readonly startDateTime: string | null;
	readonly endDateTime: string | null;
	readonly url: string | null;
}

export type DigitalPostDocumentRole = "main" | "additional" | "technical";

export interface DigitalPostDocument {
	readonly role: DigitalPostDocumentRole;
	readonly label: string | null;
	readonly files: readonly DigitalPostFile[];
	readonly actions: readonly DigitalPostAction[];
}

export interface DigitalPostParty {
	readonly id: string;
	/** `CVR`, `CPR` or another id type the sender names. */
	readonly idType: string;
	readonly name: string | null;
}

export interface DigitalPostLetter {
	/** The sender's id for the letter, lowercase. Digital Post may deliver it more than once. */
	readonly messageUuid: string;
	readonly memoVersion: string | null;
	readonly messageId: string | null;
	readonly messageCode: string | null;
	readonly title: string;
	/** The short notice a mailbox shows before the letter is opened. */
	readonly notification: string | null;
	/** Whether the sender accepts a reply in Digital Post, and by when. */
	readonly reply: boolean;
	readonly replyBy: string | null;
	/** Mandatory post (`obligatorisk`) and post with legal effect (`retsvirkning`, e.g. a decision with a deadline). */
	readonly mandatory: boolean;
	readonly legalNotification: boolean;
	readonly postType: string | null;
	readonly sender: DigitalPostParty & { readonly contactPoint: string | null };
	readonly recipient: DigitalPostParty;
	readonly caseId: string | null;
	/** When the sender made the letter. */
	readonly created: string;
	readonly documents: readonly DigitalPostDocument[];
	/** Every element of the letter as JSON, each file's content replaced by its size and SHA-256: once a letter is
	 * receipted, Digital Post deletes it, so nothing of it may be lost in the reduction above. */
	readonly record: MemoRecord;
}

/** An element as JSON: `@name` attributes, child elements by name (an array when repeated), and `#text` (or the
 * element is just its text, exactly as written). Names outside the MeMo namespace carry the prefix MeMo's own examples
 * use. */
export type MemoRecord = string | { readonly [key: string]: MemoRecord | readonly MemoRecord[] };

interface XmlElement {
	readonly namespace: string | null;
	readonly name: string;
	readonly attributes: ReadonlyMap<string, string>;
	readonly children: XmlElement[];
	text: string;
}

const PREDEFINED: Readonly<Record<string, string>> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };

function invalid(message = "the letter's XML is malformed"): never {
	throw new DigitalPostLetterInvalid(message);
}

function decodeXmlText(value: string): string {
	if (!value.includes("&")) return value;
	return value.replace(/&([^;&\s]{1,16});|&/g, (_match, reference: string | undefined) => {
		if (reference === undefined) invalid();
		if (Object.hasOwn(PREDEFINED, reference)) return PREDEFINED[reference] as string;
		const code = /^#x[0-9a-fA-F]{1,6}$/.test(reference)
			? Number.parseInt(reference.slice(2), 16)
			: /^#[0-9]{1,7}$/.test(reference)
				? Number.parseInt(reference.slice(1), 10)
				: Number.NaN;
		if (!Number.isInteger(code) || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) invalid();
		const character = String.fromCodePoint(code);
		if (FORBIDDEN_CHARACTER.test(character)) invalid();
		return character;
	});
}

/** Reads a whole XML document into elements with resolved namespaces. */
function readXml(source: string): XmlElement {
	if (FORBIDDEN_CHARACTER.test(source)) invalid();
	let at = source.charCodeAt(0) === 0xfeff ? 1 : 0;
	let root: XmlElement | null = null;
	let elements = 0;
	const stack: { element: XmlElement; qualified: string; scope: ReadonlyMap<string, string> }[] = [];
	const skipMarkup = (): boolean => {
		if (source.startsWith("<!--", at)) {
			const end = source.indexOf("-->", at + 4);
			if (end < 0 || source.slice(at + 4, end).includes("--")) invalid();
			at = end + 3;
			return true;
		}
		if (source.startsWith("<?", at)) {
			const end = source.indexOf("?>", at + 2);
			if (end < 0) invalid();
			const target = /^<\?([A-Za-z_][A-Za-z0-9._-]*)/.exec(source.slice(at, at + 64))?.[1];
			if (!target) invalid();
			if (target.toLowerCase() === "xml") {
				// Only the declaration at the very start, and only UTF-8.
				if (at > 1 || (at === 1 && source.charCodeAt(0) !== 0xfeff)) invalid();
				const encoding = /\sencoding\s*=\s*["']([^"']*)["']/.exec(source.slice(at, end))?.[1];
				if (encoding !== undefined && !/^utf-?8$/i.test(encoding)) invalid("the letter's XML is not UTF-8");
			}
			at = end + 2;
			return true;
		}
		if (source.startsWith("<!", at) && !source.startsWith("<![CDATA[", at))
			invalid("the letter's XML declares a document type");
		return false;
	};
	while (at < source.length) {
		const open = stack.at(-1);
		if (source.charCodeAt(at) !== 0x3c) {
			const next = source.indexOf("<", at);
			const end = next < 0 ? source.length : next;
			const text = source.slice(at, end);
			if (open) open.element.text += decodeXmlText(text);
			else if (text.trim() !== "") invalid();
			at = end;
			continue;
		}
		if (skipMarkup()) continue;
		if (source.startsWith("<![CDATA[", at)) {
			if (!open) invalid();
			const end = source.indexOf("]]>", at + 9);
			if (end < 0) invalid();
			open.element.text += source.slice(at + 9, end);
			at = end + 3;
			continue;
		}
		if (source.startsWith("</", at)) {
			const end = source.indexOf(">", at + 2);
			if (end < 0 || !open) invalid();
			if (source.slice(at + 2, end).trim() !== open.qualified) invalid();
			stack.pop();
			at = end + 1;
			continue;
		}
		// A start tag: its name, then attributes up to `>` or `/>`.
		const nameMatch = /^<([^\s/>]+)/.exec(source.slice(at, at + 260));
		const qualified = nameMatch?.[1];
		if (!qualified || !NAME.test(qualified)) invalid();
		if (root && !open) invalid("the letter's XML has more than one root");
		at += qualified.length + 1;
		const raw = new Map<string, string>();
		let selfClosing = false;
		for (;;) {
			const spaces = /^\s*/.exec(source.slice(at, at + 4096))?.[0].length ?? 0;
			at += spaces;
			if (source.startsWith("/>", at)) {
				selfClosing = true;
				at += 2;
				break;
			}
			if (source.charCodeAt(at) === 0x3e) {
				at += 1;
				break;
			}
			if (spaces === 0) invalid();
			const attribute = /^([^\s=/>]+)\s*=\s*(["'])/.exec(source.slice(at, at + 300));
			const attributeName = attribute?.[1];
			const quote = attribute?.[2];
			if (!attribute || !attributeName || !quote || !NAME.test(attributeName)) invalid();
			const valueStart = at + attribute[0].length;
			const valueEnd = source.indexOf(quote, valueStart);
			if (valueEnd < 0) invalid();
			const value = source.slice(valueStart, valueEnd);
			if (value.includes("<") || raw.has(attributeName)) invalid();
			raw.set(attributeName, decodeXmlText(value));
			at = valueEnd + 1;
		}
		const scope = new Map(open?.scope ?? []);
		for (const [key, value] of raw) {
			if (key === "xmlns") scope.set("", value);
			else if (key.startsWith("xmlns:")) scope.set(key.slice(6), value);
		}
		const colon = qualified.indexOf(":");
		const prefix = colon < 0 ? "" : qualified.slice(0, colon);
		const namespace = scope.get(prefix);
		if (prefix !== "" && namespace === undefined) invalid();
		const attributes = new Map<string, string>();
		for (const [key, value] of raw) if (key !== "xmlns" && !key.startsWith("xmlns:")) attributes.set(key, value);
		const element: XmlElement = {
			namespace: namespace || null,
			name: colon < 0 ? qualified : qualified.slice(colon + 1),
			attributes,
			children: [],
			text: "",
		};
		elements += 1;
		if (elements > MAX_ELEMENTS || stack.length >= MAX_DEPTH) invalid("the letter's XML is too large");
		if (open) open.element.children.push(element);
		else root = element;
		if (!selfClosing) stack.push({ element, qualified, scope });
	}
	if (!root || stack.length > 0) invalid();
	return root;
}

const NAMESPACE_PREFIXES: Readonly<Record<string, string>> = {
	[MEMO_NAMESPACE]: "",
	"https://data.gov.dk/model/core/": "grd:",
	"https://www.gs1.dk/gs1-standarder/identifikation/gln-global-location-number/": "gln:",
	"https://www.dst.dk/da/TilSalg/Forskningsservice/Dokumentation/hoejkvalitetsvariable/elevregister-2/udd#": "udd:",
	"http://www.form-online.dk/": "form:",
	"http://kle-online.dk/": "kle:",
	"https://motorregister.skat.dk/": "dmv:",
	"https://services.nsi.dk/en/Services/SOR": "sor:",
};

function recordName(element: XmlElement): string {
	if (element.namespace === null) return element.name;
	return `${NAMESPACE_PREFIXES[element.namespace] ?? `{${element.namespace}}`}${element.name}`;
}

function memoRecord(element: XmlElement, digest: (bytes: Uint8Array) => string): MemoRecord {
	const isContent =
		element.namespace === MEMO_NAMESPACE && element.name === "content" && element.children.length === 0;
	if (isContent) {
		const bytes = base64Bytes(element.text);
		return { bytes: String(bytes.byteLength), sha256: digest(bytes) };
	}
	// Text is kept exactly as written (ReplyData, for one, must go back to its sender unchanged); only the layout
	// whitespace between child elements is left out.
	const text = element.text;
	if (element.children.length === 0 && element.attributes.size === 0) return text;
	const record: Record<string, MemoRecord | MemoRecord[]> = {};
	for (const [name, value] of element.attributes) record[`@${name}`] = value;
	for (const child of element.children) {
		const name = recordName(child);
		const value = memoRecord(child, digest);
		const existing = record[name];
		if (existing === undefined) record[name] = value;
		else if (Array.isArray(existing)) existing.push(value);
		else record[name] = [existing as MemoRecord, value];
	}
	if (element.children.length === 0 ? text !== "" : text.trim() !== "") record["#text"] = text;
	return record;
}

function memoChildren(element: XmlElement, name: string): XmlElement[] {
	return element.children.filter((child) => child.namespace === MEMO_NAMESPACE && child.name === name);
}

/** The first child of that name. Digital Post validates every letter against the MeMo schema before it delivers it,
 * so only the parts the platform depends on are checked again here; the rest is read leniently. */
function memoChild(element: XmlElement | null, name: string): XmlElement | null {
	return element?.children.find((child) => child.namespace === MEMO_NAMESPACE && child.name === name) ?? null;
}

/** An element's text, trimmed, cut to `MAX_FIELD_CHARACTERS`; null when the element is absent, empty or not text. */
function field(element: XmlElement | null, name: string): string | null {
	const found = memoChild(element, name);
	if (!found || found.children.length > 0) return null;
	const text = found.text.trim();
	if (text === "") return null;
	return [...text].length > MAX_FIELD_CHARACTERS ? [...text].slice(0, MAX_FIELD_CHARACTERS).join("") : text;
}

function requiredField(element: XmlElement, name: string): string {
	return field(element, name) ?? invalid(`the letter has no ${name}`);
}

function flag(element: XmlElement, name: string): boolean {
	const value = field(element, name);
	if (value === null || value === "false" || value === "0") return false;
	if (value === "true" || value === "1") return true;
	return invalid(`the letter's ${name} is not true or false`);
}

function base64Bytes(text: string): Uint8Array {
	const compact = text.replace(/\s+/g, "");
	if (compact.length % 4 !== 0 || !BASE64.test(compact)) invalid("a file in the letter is not base64");
	return Buffer.from(compact, "base64");
}

function readParty(element: XmlElement | null, idName: string, what: string): DigitalPostParty {
	if (!element) return invalid(`the letter has no ${what}`);
	return {
		id: requiredField(element, idName),
		idType: field(element, "idType") ?? "",
		name: field(element, "label"),
	};
}

function readDocument(element: XmlElement, role: DigitalPostDocumentRole): DigitalPostDocument {
	const files = memoChildren(element, "File").map((file) => {
		const content = memoChild(file, "content");
		if (!content || content.children.length > 0) invalid("a file in the letter has no content");
		return {
			encodingFormat: requiredField(file, "encodingFormat").toLowerCase(),
			filename: requiredField(file, "filename"),
			language: field(file, "language"),
			bytes: base64Bytes(content.text),
		};
	});
	if (files.length === 0) invalid("a document in the letter has no file");
	const actions = memoChildren(element, "Action").map((action) => ({
		label: field(action, "label") ?? "",
		actionCode: field(action, "actionCode") ?? "",
		startDateTime: field(action, "startDateTime"),
		endDateTime: field(action, "endDateTime"),
		url: field(memoChild(action, "EntryPoint"), "url"),
	}));
	return { role, label: field(element, "label"), files, actions };
}

/** Reads one letter as Digital Post delivers it (`GET /memos/{id}`). */
export function readDigitalPostLetter(bytes: Uint8Array): DigitalPostLetter {
	if (bytes.byteLength > DIGITAL_POST_LETTER_MAX_BYTES) invalid("the letter is too large");
	let source: string;
	try {
		source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
	} catch {
		return invalid("the letter's XML is not UTF-8");
	}
	const message = readXml(source);
	if (message.namespace !== MEMO_NAMESPACE || message.name !== "Message") invalid("the document is not a MeMo letter");
	if (memoChildren(message, "MessageHeader").length !== 1 || memoChildren(message, "MessageBody").length !== 1)
		invalid("the letter must have one MessageHeader and one MessageBody");
	const header = memoChild(message, "MessageHeader") as XmlElement;
	const body = memoChild(message, "MessageBody") as XmlElement;
	if (memoChildren(header, "messageUUID").length !== 1) invalid("the letter must have one messageUUID");
	const messageUuid = requiredField(header, "messageUUID").toLowerCase();
	if (!UUID.test(messageUuid)) invalid("the letter's messageUUID is not a UUID");
	const sender = memoChild(header, "Sender");
	const contactPoint = sender ? memoChild(sender, "ContactPoint") : null;
	const mains = memoChildren(body, "MainDocument");
	if (mains.length !== 1) invalid("the letter must have one MainDocument");
	const documents = [
		...mains.map((element) => readDocument(element, "main")),
		...memoChildren(body, "AdditionalDocument").map((element) => readDocument(element, "additional")),
		...memoChildren(body, "TechnicalDocument").map((element) => readDocument(element, "technical")),
	];
	if (documents.reduce((count, document) => count + document.files.length, 0) > MAX_FILES)
		invalid("the letter has too many files");
	if (documents.reduce((count, document) => count + document.actions.length, 0) > MAX_ACTIONS)
		invalid("the letter has too many actions");
	const messageCode = field(header, "messageCode");
	return {
		messageUuid,
		memoVersion: message.attributes.get("memoVersion") ?? null,
		messageId: field(header, "messageID"),
		messageCode,
		title: field(header, "label") ?? messageCode ?? "Digital Post",
		notification: field(header, "notification"),
		reply: flag(header, "reply"),
		replyBy: field(header, "replyByDateTime"),
		mandatory: flag(header, "mandatory"),
		legalNotification: flag(header, "legalNotification"),
		postType: field(header, "postType"),
		sender: { ...readParty(sender, "senderID", "Sender"), contactPoint: field(contactPoint, "label") },
		recipient: readParty(memoChild(header, "Recipient"), "recipientID", "Recipient"),
		caseId: field(memoChild(memoChild(header, "ContentData"), "CaseID"), "caseID"),
		created: requiredField(body, "createdDateTime"),
		documents,
		record: { [recordName(message)]: memoRecord(message, sha256Hex) },
	};
}

export function sha256Hex(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

const HTML_ENTITIES: Readonly<Record<string, string>> = {
	nbsp: " ",
	amp: "&",
	lt: "<",
	gt: ">",
	quot: '"',
	apos: "'",
	aelig: "æ",
	AElig: "Æ",
	oslash: "ø",
	Oslash: "Ø",
	aring: "å",
	Aring: "Å",
	auml: "ä",
	Auml: "Ä",
	ouml: "ö",
	Ouml: "Ö",
	uuml: "ü",
	Uuml: "Ü",
	eacute: "é",
	Eacute: "É",
	egrave: "è",
	szlig: "ß",
	euro: "€",
	copy: "©",
	reg: "®",
	sect: "§",
	para: "¶",
	deg: "°",
	ndash: "–",
	mdash: "—",
	hellip: "…",
	laquo: "«",
	raquo: "»",
	lsquo: "‘",
	rsquo: "’",
	ldquo: "“",
	rdquo: "”",
	bull: "•",
	middot: "·",
	times: "×",
	shy: "",
};

function decodeHtmlEntities(value: string): string {
	return value.replace(/&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|[A-Za-z]{2,8});/g, (match, reference: string) => {
		if (reference.startsWith("#")) {
			const code =
				reference[1] === "x" ? Number.parseInt(reference.slice(2), 16) : Number.parseInt(reference.slice(1), 10);
			if (!Number.isInteger(code) || code < 0x20 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff))
				return match;
			return String.fromCodePoint(code);
		}
		return HTML_ENTITIES[reference] ?? match;
	});
}

/** An HTML document's readable text: scripts and styles dropped, blocks on their own lines, entities decoded. */
export function htmlLetterText(html: string): string {
	const text = html
		.replace(/<!--[\s\S]*?-->/g, "")
		.replace(/<(script|style|head|title)\b[\s\S]*?<\/\1\s*>/gi, "")
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(/<li\b[^>]*>/gi, "\n- ")
		.replace(/<\/(td|th)\s*>/gi, "\t")
		.replace(
			/<\/?(p|div|section|article|header|footer|ul|ol|li|tr|table|h[1-6]|blockquote|pre|address)\b[^>]*>/gi,
			"\n",
		)
		.replace(/<[^>]*>/g, "");
	return decodeHtmlEntities(text)
		.replace(/\r\n?/g, "\n")
		.split("\n")
		.map((line) => line.replace(/[ \t ]+/g, " ").trim())
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

function plainText(bytes: Uint8Array): string {
	let text: string;
	try {
		text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		// Older senders write Windows-1252; it decodes any byte.
		text = new TextDecoder("windows-1252").decode(bytes);
	}
	return text.replace(/\r\n?/g, "\n").replace(/^﻿/, "").trim();
}

/** The main document's text, from its plain-text version or else its HTML version. A letter whose main document is
 * only a PDF has no text here (`source` names the file that holds it). */
export function digitalPostLetterText(letter: DigitalPostLetter): {
	text: string | null;
	source: DigitalPostFile | null;
} {
	const main = letter.documents.find((document) => document.role === "main");
	const files = main?.files ?? [];
	const plain = files.find((file) => file.encodingFormat === "text/plain");
	if (plain) return { text: plainText(plain.bytes), source: plain };
	const html = files.find((file) => file.encodingFormat === "text/html");
	if (html) return { text: htmlLetterText(plainText(html.bytes)), source: html };
	return { text: null, source: files[0] ?? null };
}
