export interface ParsedMailUnsubscribeMailto {
	readonly to: string;
	readonly subject?: string;
	readonly body?: string;
}

export interface ParsedMailUnsubscribe {
	readonly oneClickUrl?: string;
	readonly mailto?: ParsedMailUnsubscribeMailto;
	readonly webUrls?: readonly string[];
}

export interface NormalizedBlockedSender {
	readonly sender: string;
	readonly matchKind: "address" | "domain";
}

const MAX_URL_LENGTH = 2048;
const MAX_WEB_URLS = 5;
const MAX_ENTRIES = 16;
const EMAIL_PATTERN = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const DOMAIN_PATTERN = /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const ONE_CLICK_PATTERN = /(?:^|[;\s,])list-unsubscribe\s*=\s*one-click(?:$|[;\s,])/i;

function sanitizeSingleLine(value: string, maxLength: number): string | undefined {
	const cleaned = value
		.replace(/[\x00-\x1f\x7f]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	if (!cleaned) return undefined;
	return cleaned.slice(0, maxLength);
}

function sanitizeBody(value: string, maxLength: number): string | undefined {
	const cleaned = value.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]+/g, "").trim();
	if (!cleaned) return undefined;
	return cleaned.slice(0, maxLength);
}

function parseMailtoUri(raw: string): ParsedMailUnsubscribeMailto | null {
	const withoutScheme = raw.slice("mailto:".length);
	const queryIndex = withoutScheme.indexOf("?");
	const rawAddress = (queryIndex === -1 ? withoutScheme : withoutScheme.slice(0, queryIndex)).trim();
	let decodedAddress: string;
	try {
		decodedAddress = decodeURIComponent(rawAddress).trim().toLowerCase();
	} catch {
		return null;
	}
	if (!decodedAddress || decodedAddress.length > 254 || !EMAIL_PATTERN.test(decodedAddress)) return null;
	let subject: string | undefined;
	let body: string | undefined;
	if (queryIndex !== -1) {
		const params = new URLSearchParams(withoutScheme.slice(queryIndex + 1));
		for (const [key, value] of params.entries()) {
			const lower = key.toLowerCase();
			if (lower === "subject" && subject === undefined) subject = sanitizeSingleLine(value, 200);
			if (lower === "body" && body === undefined) body = sanitizeBody(value, 2000);
		}
	}
	return {
		to: decodedAddress,
		...(subject !== undefined ? { subject } : {}),
		...(body !== undefined ? { body } : {}),
	};
}

export function parseListUnsubscribeHeaders(
	listUnsubscribe: string | null | undefined,
	listUnsubscribePost?: string | null,
): ParsedMailUnsubscribe | null {
	if (typeof listUnsubscribe !== "string" || !listUnsubscribe.trim()) return null;
	const entries: string[] = [];
	const anglePattern = /<([^<>]+)>/g;
	for (const match of listUnsubscribe.matchAll(anglePattern)) {
		const candidate = (match[1] ?? "").replace(/[\r\n\t]+/g, "").trim();
		if (candidate) entries.push(candidate);
		if (entries.length >= MAX_ENTRIES) break;
	}
	if (entries.length === 0) return null;

	const webUrls: string[] = [];
	const seenWebUrls = new Set<string>();
	let firstOneClickCandidate: string | undefined;
	let mailto: ParsedMailUnsubscribeMailto | undefined;

	for (const entry of entries) {
		if (entry.length > MAX_URL_LENGTH || /[\x00-\x1f\x7f]/.test(entry)) continue;
		const lower = entry.toLowerCase();
		if (lower.startsWith("mailto:")) {
			if (!mailto) {
				const parsedMailto = parseMailtoUri(entry);
				if (parsedMailto) mailto = parsedMailto;
			}
			continue;
		}
		if (lower.startsWith("https://") || lower.startsWith("http://")) {
			let parsedUrl: URL;
			try {
				parsedUrl = new URL(entry);
			} catch {
				continue;
			}
			if ((parsedUrl.protocol !== "https:" && parsedUrl.protocol !== "http:") || !parsedUrl.hostname) continue;
			const href = parsedUrl.href;
			if (href.length > MAX_URL_LENGTH) continue;
			if (
				!firstOneClickCandidate &&
				parsedUrl.protocol === "https:" &&
				!parsedUrl.username &&
				!parsedUrl.password &&
				(parsedUrl.port === "" || parsedUrl.port === "443")
			) {
				firstOneClickCandidate = href;
			}
			if (!seenWebUrls.has(href) && webUrls.length < MAX_WEB_URLS) {
				seenWebUrls.add(href);
				webUrls.push(href);
			}
		}
	}

	const supportsOneClick =
		typeof listUnsubscribePost === "string" && ONE_CLICK_PATTERN.test(listUnsubscribePost.trim());
	const oneClickUrl = supportsOneClick ? firstOneClickCandidate : undefined;

	if (!oneClickUrl && !mailto && webUrls.length === 0) return null;
	return {
		...(oneClickUrl ? { oneClickUrl } : {}),
		...(mailto ? { mailto } : {}),
		...(webUrls.length > 0 ? { webUrls } : {}),
	};
}

export function normalizeBlockedSender(raw: string): NormalizedBlockedSender | null {
	if (typeof raw !== "string") return null;
	const trimmed = raw.trim();
	if (!trimmed || trimmed.length > 320 || /[\x00-\x1f\x7f]/.test(trimmed)) return null;
	const bracketed = trimmed.match(/<([^<>]+)>\s*$/);
	const candidate = (bracketed ? (bracketed[1] ?? "") : trimmed).trim().toLowerCase();
	if (!candidate || candidate.length > 254 || /[\s,;'"<>\\]/.test(candidate)) return null;
	if (EMAIL_PATTERN.test(candidate)) return { sender: candidate, matchKind: "address" };
	const domain = candidate.startsWith("@") ? candidate.slice(1) : candidate;
	if (domain.length <= 253 && DOMAIN_PATTERN.test(domain)) {
		return { sender: `@${domain}`, matchKind: "domain" };
	}
	return null;
}
